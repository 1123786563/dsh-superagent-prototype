import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { parseDocument, stringify } from 'yaml'

const own = (value, key) => Object.hasOwn(value, key)
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const expression = value => typeof value === 'string' && value.includes('${{')
const fail = message => { throw new Error(`Unsupported act workflow: ${message}`) }
const identifier = /^[A-Za-z_][A-Za-z0-9_-]*$/
const healthFlags = new Set(['--health-cmd', '--health-interval', '--health-timeout', '--health-retries', '--health-start-period', '--health-start-interval'])

function fixedImage(image, context) {
  if (typeof image !== 'string' || expression(image) || /\s/.test(image)
      || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]*|@sha256:[a-fA-F0-9]{64})$/.test(image)
      || /:latest$/.test(image)) fail(`${context} requires a fixed image tag or sha256 digest`)
}

// Do not interpret arbitrary Docker options: even quoted --volume/--privileged
// inside a health command is a command argument, not a Docker flag.
function optionWords(value) {
  if (value == null || value === '') return []
  if (typeof value !== 'string' || expression(value)) fail('service options must be static health options')
  const words = []; let word = '', quote = '', started = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '\\' && quote !== "'") {
      if (++index === value.length) fail('unterminated service option escape')
      word += value[index]; started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") { quote = char; started = true }
    else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false }
    } else { word += char; started = true }
  }
  if (quote) fail('unterminated service option quote')
  if (started) words.push(word)
  return words
}

function safeHealthOptions(value) {
  const words = optionWords(value)
  for (let index = 0; index < words.length; index++) {
    const [flag, ...inline] = words[index].split('=')
    if (!healthFlags.has(flag)) fail(`service option ${flag} is not an allowed health option`)
    const argument = inline.length ? inline.join('=') : words[++index]
    if (!argument || argument.startsWith('--')) fail(`missing value for service option ${flag}`)
    if (flag !== '--health-cmd' && !/^[0-9]+(?:ns|us|ms|s|m|h)?$/.test(argument)) fail(`invalid value for service option ${flag}`)
  }
}

function expandMatrices(strategy) {
  if (strategy === undefined) return [{}]
  if (!mapping(strategy) || Object.keys(strategy).some(key => !['matrix', 'fail-fast', 'max-parallel'].includes(key))) fail('unsupported strategy')
  if (own(strategy, 'fail-fast') && typeof strategy['fail-fast'] !== 'boolean') fail('dynamic strategy fail-fast')
  if (own(strategy, 'max-parallel') && (!Number.isSafeInteger(strategy['max-parallel']) || strategy['max-parallel'] < 1)) fail('dynamic strategy max-parallel')
  const matrix = strategy.matrix
  if (matrix === undefined) return [{}]
  if (!mapping(matrix) || !Object.keys(matrix).length) fail('matrix must contain static array axes')
  let result = [{}]
  for (const [axis, values] of Object.entries(matrix)) {
    if (!identifier.test(axis) || ['include', 'exclude', '__proto__', 'constructor', 'prototype'].includes(axis)) fail(`unsupported matrix axis ${axis}`)
    if (!Array.isArray(values) || !values.length || values.some(value => !['string', 'number', 'boolean'].includes(typeof value)
        || expression(value) || (typeof value === 'number' && !Number.isFinite(value)))) fail(`matrix axis ${axis} must be a nonempty static scalar array`)
    if (new Set(values.map(value => JSON.stringify(value))).size !== values.length) fail(`duplicate values in matrix axis ${axis}`)
    if (result.length * values.length > 256) fail('matrix exceeds 256 combinations')
    result = result.flatMap(row => values.map(value => ({ ...row, [axis]: value })))
  }
  return result
}

function validateServices(job, proxies) {
  if (!Array.isArray(proxies)) fail('serviceProxies must be an array')
  const services = job.services ?? {}
  if (!mapping(services)) fail('services must be a mapping')
  const usedPorts = new Set(), usedServices = new Set()
  for (const proxy of proxies) {
    if (!mapping(proxy) || Object.keys(proxy).some(key => !['service', 'hostPort', 'containerPort'].includes(key))
        || typeof proxy.service !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(proxy.service)
        || !own(services, proxy.service)) fail('service proxy must name an existing service')
    for (const key of ['hostPort', 'containerPort']) {
      if (!Number.isInteger(proxy[key]) || proxy[key] < 1 || proxy[key] > 65535) fail(`service proxy ${key} must be a TCP port`)
    }
    if (usedPorts.has(proxy.hostPort)) fail('duplicate service proxy loopback port')
    if (usedServices.has(proxy.service)) fail('duplicate service proxy mapping')
    usedPorts.add(proxy.hostPort); usedServices.add(proxy.service)
  }
  for (const [name, service] of Object.entries(services)) {
    if (!usedServices.has(name)) fail(`service ${name} requires an explicit service proxy`)
    if (!mapping(service)) fail(`service ${name} must be a mapping`)
    for (const key of Object.keys(service)) {
      if (!['image', 'env', 'ports', 'options'].includes(key)) fail(`service ${name} ${key} is forbidden`)
    }
    fixedImage(service.image, `service ${name}`)
    safeHealthOptions(service.options)
    if (service.ports !== undefined) {
      const proxy = proxies.find(item => item.service === name)
      // Preserve the loopback endpoint used by workflow commands instead of
      // silently forwarding a different port after removing Docker publishing.
      if (!Array.isArray(service.ports) || service.ports.length !== 1) fail(`service proxy ${name} must match one static workflow port mapping`)
      const ports = String(service.ports[0]).match(/^(?:(?:127\.0\.0\.1|0\.0\.0\.0):)?([0-9]+):([0-9]+)(?:\/tcp)?$/)
      if (!ports || Number(ports[1]) !== proxy.hostPort || Number(ports[2]) !== proxy.containerPort) fail(`service proxy ${name} must match the workflow port mapping`)
    }
    // The trusted runner's private network provides service DNS; never bind
    // service ports to the machine running Docker.
    delete service.ports
  }
}

function proxyStep(proxies, id) {
  const daemon = `const net = require('node:net');
const proxies = ${JSON.stringify(proxies)};
let ready = 0;
for (const proxy of proxies) {
  const server = net.createServer(client => {
    const upstream = net.connect({host: proxy.service, port: proxy.containerPort});
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  server.on('error', error => { console.error(error); process.exit(1); });
  server.listen(proxy.hostPort, '127.0.0.1', () => {
    if (++ready === proxies.length) { process.send('ready'); process.disconnect(); }
  });
}`
  return {
    id, name: 'Start container-local service TCP proxies',
    shell: 'bash --noprofile --norc -e -o pipefail {0}', 'working-directory': '/tmp',
    env: { NODE_OPTIONS: '', NODE_PATH: '', BASH_ENV: '', ENV: '' },
    run: `node <<'DSH_ACT_PROXY_NODE'\nconst { spawn } = require('node:child_process');\nconst child = spawn(process.execPath, ['-e', ${JSON.stringify(daemon)}], { detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, RUNNER_TRACKING_ID: '' } });\nconst timer = setTimeout(() => { child.kill(); process.exit(1); }, 10000);\nchild.once('error', error => { console.error(error); process.exit(1); });\nchild.once('exit', () => process.exit(1));\nchild.once('message', message => { if (message === 'ready') { clearTimeout(timer); child.unref(); process.exit(0); } });\nDSH_ACT_PROXY_NODE\n`,
  }
}

/**
 * Compile ONLY a workflow obtained from the bound, trusted base revision.
 * This is a structural check, not a sandbox: run/action/local recursive action
 * code still requires the runner's private Docker daemon and denied host mounts.
 * A witness is completion evidence only; PR code can read its own container.
 */
export function buildActPlan({ workflowText, workflowPath, jobId, serviceProxies = [], matrix, witnessToken = randomBytes(24).toString('hex') }) {
  if (typeof workflowText !== 'string' || !workflowText.trim() || workflowText.length > 2_000_000) fail('workflowText must be a nonempty YAML document under 2 MB')
  if (typeof workflowPath !== 'string' || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflowPath)
      || posix.normalize(workflowPath) !== workflowPath || workflowPath.includes('\\')) fail('workflowPath must name a repository workflow')
  if (typeof jobId !== 'string' || !identifier.test(jobId)) fail('jobId must explicitly identify one job')
  if (typeof witnessToken !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(witnessToken)) fail('witnessToken must be 16–128 safe characters')
  let workflow
  try {
    const doc = parseDocument(workflowText, { uniqueKeys: true, merge: false })
    if (doc.errors.length) fail(`invalid YAML: ${doc.errors[0].message}`)
    // Aliased step objects would share identity while assigning unique IDs.
    // Refuse aliases rather than silently changing their execution semantics.
    workflow = doc.toJS({ maxAliasCount: 0 })
  } catch (error) { fail(`invalid YAML: ${error.message}`) }
  if (!mapping(workflow) || !mapping(workflow.jobs) || !own(workflow.jobs, jobId) || !mapping(workflow.jobs[jobId])) fail(`job ${jobId} does not exist`)
  const job = workflow.jobs[jobId]
  if (own(job, 'needs')) fail('jobs with needs dependencies are unsupported')
  if (own(job, 'uses')) fail('reusable workflow jobs are unsupported')
  if (typeof job['runs-on'] !== 'string' || !/^ubuntu-(?:latest|20\.04|22\.04|24\.04)$/.test(job['runs-on'])) fail('runs-on must be one fixed Ubuntu label')
  if (own(job, 'continue-on-error')) fail('job continue-on-error is unsupported')
  if (own(job, 'container')) fail('custom job container is unsupported')
  if (own(job, 'environment')) fail('deployment environment is unsupported')
  validateServices(job, serviceProxies)
  const matrices = expandMatrices(job.strategy)
  let selectedMatrix = null
  if (matrix !== undefined) {
    if (!mapping(matrix) || !matrices.some(row => Object.keys(row).length === Object.keys(matrix).length
        && Object.entries(row).every(([key, value]) => own(matrix, key) && matrix[key] === value))) fail('selected matrix must match one complete combination')
    selectedMatrix = { ...matrix }
    if (job.strategy?.matrix) job.strategy.matrix = Object.fromEntries(Object.entries(matrix).map(([key, value]) => [key, [value]]))
  }
  if (!Array.isArray(job.steps) || !job.steps.length) fail('job requires nonempty steps')
  const ids = new Set()
  for (const step of job.steps) {
    if (!mapping(step) || (typeof step.run === 'string') === (typeof step.uses === 'string')
        || (!step.run && !step.uses)) fail('each step requires exactly one run or uses string')
    if (own(step, 'continue-on-error')) fail('step continue-on-error is unsupported')
    if (step.uses) {
      const local = /^\.\/[A-Za-z0-9_.\/-]+$/.test(step.uses) && !step.uses.split('/').includes('..')
      const pinned = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[a-fA-F0-9]{40}$/.test(step.uses)
      if (!local && !pinned) fail('uses requires a commit-pinned external action or local action; docker actions are forbidden')
    }
    if (own(step, 'id')) {
      if (typeof step.id !== 'string' || !identifier.test(step.id) || ids.has(step.id)) fail('step IDs must be valid and unique')
      ids.add(step.id)
    }
  }
  const unusedId = initial => {
    let id = initial
    while (ids.has(id)) id += '_'
    ids.add(id); return id
  }
  for (const [index, step] of job.steps.entries()) {
    if (!own(step, 'id')) step.id = unusedId(`dsh_act_step_${index + 1}`)
  }
  const expectedStepIds = job.steps.map(step => step.id)
  if (serviceProxies.length) job.steps.unshift(proxyStep(serviceProxies, unusedId('dsh_act_service_proxies')))
  const witnessStepId = unusedId('dsh_act_witness')
  const witnessMarker = `DSH_ACT_WITNESS:${witnessToken}`
  job.steps.push({ id: witnessStepId, name: 'Witness successful job completion', if: '${{ success() }}',
    shell: 'bash --noprofile --norc -e -o pipefail {0}', 'working-directory': '/tmp',
    env: { DSH_ACT_WITNESS: witnessMarker, BASH_ENV: '', ENV: '' }, run: 'printf \'%s\\n\' "$DSH_ACT_WITNESS"\n' })
  // A private daemon and no credentials are enforced by the runner. In
  // addition, erase source workflow/job permissions rather than inheriting them.
  job.permissions = { contents: 'read' }
  const output = { name: workflow.name ?? 'Local CI', on: { pull_request: {} }, permissions: { contents: 'read' } }
  for (const key of ['env', 'defaults', 'run-name']) if (own(workflow, key)) output[key] = workflow[key]
  output.jobs = { [jobId]: job }
  return { workflowText: stringify(output, { lineWidth: 0 }), matrices,
    workflowDigest: createHash('sha256').update(workflowText).digest('hex'), jobId, expectedStepIds,
    witnessStepId, witnessMarker, selectedMatrix }
}
