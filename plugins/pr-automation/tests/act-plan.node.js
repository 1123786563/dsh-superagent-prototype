import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { parse, stringify } from 'yaml'
import { buildActPlan } from '../act-plan.js'

const pinned = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
const base = () => ({ name: 'CI', on: { push: {}, pull_request: {} }, permissions: { contents: 'write' },
  env: { COMMON: 'yes' }, defaults: { run: { shell: 'bash' } },
  jobs: { test: { 'runs-on': 'ubuntu-latest', if: "github.event_name == 'pull_request'", permissions: 'write-all',
    steps: [{ uses: pinned, with: { 'persist-credentials': false } },
      { id: 'check', name: 'Original check', run: 'echo original', if: '${{ success() }}', env: { KEEP: 'yes' } }] },
  publish: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'echo never' }] } } })
const compile = (workflow = base(), options = {}) => buildActPlan({ workflowText: stringify(workflow),
  workflowPath: '.github/workflows/ci.yml', jobId: 'test', witnessToken: 'test_witness_token_123456', ...options })
const outputJob = plan => parse(plan.workflowText).jobs.test
const changeJob = patch => { const workflow = base(); Object.assign(workflow.jobs.test, patch); return workflow }

// A successful compile preserves the trusted workflow's execution semantics:
// source steps and conditions survive, and no unrelated job is runnable.
test('selects one job, preserves source steps and if, and strips publish permissions', () => {
  const workflow = base(), plan = compile(workflow), output = parse(plan.workflowText)
  assert.deepEqual(Object.keys(output.jobs), ['test'])
  assert.deepEqual(output.on, { pull_request: {} })
  assert.deepEqual(output.permissions, { contents: 'read' })
  assert.deepEqual(output.jobs.test.permissions, { contents: 'read' })
  assert.equal(output.jobs.test.if, workflow.jobs.test.if)
  assert.deepEqual(output.env, workflow.env)
  assert.deepEqual(output.defaults, workflow.defaults)
  assert.deepEqual(output.jobs.test.steps.slice(0, 2), [
    { ...workflow.jobs.test.steps[0], id: 'dsh_act_step_1' }, workflow.jobs.test.steps[1],
  ])
  assert.deepEqual(plan.expectedStepIds, ['dsh_act_step_1', 'check'])
  assert.deepEqual(plan.matrices, [{}])
  assert.equal(plan.selectedMatrix, null)
  assert.equal(plan.workflowDigest, createHash('sha256').update(stringify(workflow)).digest('hex'))
  assert.equal(plan.jobId, 'test')
})

test('requires an explicit existing job and safe repository workflow path', () => {
  for (const jobId of [undefined, '', 'missing', '*', '../test']) assert.throws(() => compile(base(), { jobId }), /job/)
  for (const workflowPath of ['/tmp/ci.yml', '.github/workflows/../ci.yml', '.github/workflows/ci.json', '.github\\workflows\\ci.yml']) {
    assert.throws(() => compile(base(), { workflowPath }), /workflowPath/)
  }
})

test('rejects duplicate keys, invalid documents, malformed jobs and empty steps', () => {
  for (const workflowText of ['jobs: [', 'jobs: {}\njobs: {}', 'null', 'jobs: {test: null}', 'jobs: {test: 1}',
    'jobs: {test: {runs-on: ubuntu-latest, steps: [&step {run: echo a}, *step]}}']) {
    assert.throws(() => compile(base(), { workflowText }), /workflow|YAML/)
  }
  for (const steps of [[], null, {}, [{ run: 'a', uses: pinned }], [{ name: 'empty' }], [{ run: 42 }]]) {
    assert.throws(() => compile(changeJob({ steps })), /steps|step/)
  }
})

test('fully expands static matrix Cartesian products in source axis order', () => {
  const plan = compile(changeJob({ strategy: { 'fail-fast': false, matrix: { package: ['agent-computer', 'supervisor'], node: [22, 24], debug: [false, true] } } }))
  assert.equal(plan.matrices.length, 8)
  assert.deepEqual(plan.matrices[0], { package: 'agent-computer', node: 22, debug: false })
  assert.deepEqual(plan.matrices[7], { package: 'supervisor', node: 24, debug: true })
  assert.deepEqual(parse(plan.workflowText).jobs.test.strategy.matrix.package, ['agent-computer', 'supervisor'])
})

test('selects exactly one valid complete matrix combination while returning the full set', () => {
  const workflow = changeJob({ strategy: { 'fail-fast': false, matrix: { package: ['agent-computer', 'supervisor'], node: [22, 24] } } })
  const matrix = { node: 24, package: 'supervisor' }, plan = compile(workflow, { matrix })
  assert.deepEqual(plan.selectedMatrix, matrix)
  assert.equal(plan.matrices.length, 4)
  assert.deepEqual(outputJob(plan).strategy.matrix, { node: [24], package: ['supervisor'] })
  for (const invalid of [{}, { package: 'supervisor' }, { node: '24', package: 'supervisor' }, { ...matrix, extra: true }, null]) {
    assert.throws(() => compile(workflow, { matrix: invalid }), /selected matrix/)
  }
  assert.deepEqual(compile(base(), { matrix: {} }).selectedMatrix, {})
})

test('rejects dynamic or complex matrices and unsupported strategy fields', () => {
  const invalid = ['${{ fromJSON(inputs.matrix) }}', {}, { include: [{ package: 'a' }] }, { exclude: [] },
    { package: '${{ inputs.package }}' }, { package: [] }, { package: [{ name: 'a' }] },
    { package: ['${{ inputs.package }}'] }, { package: [null] }, { package: ['a', 'a'] }]
  for (const matrix of invalid) assert.throws(() => compile(changeJob({ strategy: { matrix } })), /matrix/)
  assert.throws(() => compile(changeJob({ strategy: { matrix: { a: Array.from({ length: 257 }, (_, index) => index) } } })), /256/)
  for (const strategy of ['${{ inputs.strategy }}', { 'fail-fast': '${{ false }}' }, { 'max-parallel': 0 }, { other: true }]) {
    assert.throws(() => compile(changeJob({ strategy })), /strategy/)
  }
})

test('rejects dependencies, reusable jobs, host runners, deployment environments and custom job containers', () => {
  for (const patch of [{ needs: [] }, { needs: 'build' }, { uses: 'owner/repo/workflow@main' },
    { 'runs-on': '${{ matrix.os }}' }, { 'runs-on': ['ubuntu-latest'] }, { 'runs-on': 'self-hosted' },
    { 'runs-on': 'macos-latest' }, { environment: 'production' }, { container: 'ubuntu:24.04' },
    { container: { image: 'ubuntu:24.04', volumes: ['/var/run/docker.sock:/var/run/docker.sock'] } },
    { container: { image: 'ubuntu:24.04', options: '--privileged' } }]) {
    assert.throws(() => compile(changeJob(patch)), /Unsupported act workflow/)
  }
})

test('rejects all job and step continue-on-error declarations', () => {
  for (const value of [true, false, '${{ inputs.ignore }}']) {
    assert.throws(() => compile(changeJob({ 'continue-on-error': value })), /continue-on-error/)
    assert.throws(() => compile(changeJob({ steps: [{ run: 'false', 'continue-on-error': value }] })), /continue-on-error/)
  }
})

test('requires pinned external actions; local actions still require runner recursive validation', () => {
  for (const uses of ['actions/checkout@v4', 'owner/repo@main', 'docker://alpine:3', './a/../../bad', '/tmp/action', 'owner/repo@' + '1'.repeat(39)]) {
    assert.throws(() => compile(changeJob({ steps: [{ uses }] })), /uses/)
  }
  for (const uses of [pinned, './.github/actions/check', 'owner/repo/sub/action@' + 'a'.repeat(40)]) {
    assert.equal(outputJob(compile(changeJob({ steps: [{ uses }] }))).steps[0].uses, uses)
  }
})

test('keeps user IDs, allocates stable collision-free IDs and rejects duplicate IDs', () => {
  const workflow = changeJob({ steps: [{ id: 'dsh_act_step_2', run: 'true' }, { run: 'true' }, { id: 'dsh_act_witness', run: 'true' }] })
  const first = compile(workflow), second = compile(workflow)
  assert.deepEqual(first.expectedStepIds, ['dsh_act_step_2', 'dsh_act_step_2_', 'dsh_act_witness'])
  assert.deepEqual(first.expectedStepIds, second.expectedStepIds)
  assert.equal(first.witnessStepId, 'dsh_act_witness_')
  for (const steps of [[{ id: 'a', run: 'true' }, { id: 'a', run: 'true' }], [{ id: 'bad id', run: 'true' }]]) {
    assert.throws(() => compile(changeJob({ steps })), /IDs/)
  }
})

test('appends a success-only witness with caller token, never an unconditional success marker', () => {
  const plan = compile(), witness = outputJob(plan).steps.at(-1)
  assert.equal(witness.id, plan.witnessStepId)
  assert.equal(witness.if, '${{ success() }}')
  assert.equal(witness.env.DSH_ACT_WITNESS, plan.witnessMarker)
  assert.equal(plan.witnessMarker, 'DSH_ACT_WITNESS:test_witness_token_123456')
  assert.equal(witness.run, 'printf \'%s\\n\' "$DSH_ACT_WITNESS"\n')
  assert.equal(witness['working-directory'], '/tmp')
  assert.throws(() => compile(base(), { witnessToken: 'unsafe\n$(true)' }), /witnessToken/)
  assert.notEqual(compile(base(), { witnessToken: undefined }).witnessMarker, compile(base(), { witnessToken: undefined }).witnessMarker)
})

const serviceWorkflow = () => changeJob({ services: {
  postgres: { image: 'pgvector/pgvector:pg17', ports: ['127.0.0.1:5432:5432'],
    env: { POSTGRES_DB: 'test' }, options: '--health-cmd "pg_isready -U test" --health-interval 5s --health-retries=10' },
} })
const proxy = { service: 'postgres', hostPort: 5432, containerPort: 5432 }

test('removes published service ports and prepends trusted container-loopback forwarding', () => {
  const workflow = serviceWorkflow(), plan = compile(workflow, { serviceProxies: [proxy] }), job = outputJob(plan)
  assert.equal(job.services.postgres.ports, undefined)
  assert.equal(job.services.postgres.image, workflow.jobs.test.services.postgres.image)
  assert.deepEqual(job.services.postgres.env, workflow.jobs.test.services.postgres.env)
  assert.equal(job.services.postgres.options, workflow.jobs.test.services.postgres.options)
  assert.equal(job.steps[0].id, 'dsh_act_service_proxies')
  assert.match(job.steps[0].run, /127\.0\.0\.1/)
  assert.match(job.steps[0].run, /RUNNER_TRACKING_ID/)
  assert.deepEqual(plan.expectedStepIds, ['dsh_act_step_1', 'check'])
  assert.equal(job.steps[1].uses, pinned)
})

test('requires every service mapping and rejects duplicate or invalid ports and unknown services', () => {
  assert.throws(() => compile(serviceWorkflow()), /explicit service proxy/)
  for (const serviceProxies of [[{ ...proxy, service: 'missing' }], [proxy, proxy], [{ ...proxy, hostPort: 0 }],
    [{ ...proxy, containerPort: 65536 }], [{ ...proxy, hostPort: '5432' }], [{ ...proxy, option: true }]]) {
    assert.throws(() => compile(serviceWorkflow(), { serviceProxies }), /service proxy/)
  }
  const workflow = serviceWorkflow(); workflow.jobs.test.services.second = { image: 'postgres:17' }
  assert.throws(() => compile(workflow, { serviceProxies: [proxy, { ...proxy, service: 'second' }] }), /duplicate/)
})

test('forbids dangerous service Docker fields and arbitrary options, including quoted flags', () => {
  for (const patch of [{ volumes: ['/etc:/host'] }, { build: '.' }, { credentials: { username: 'x' } }, { privileged: true },
    { options: '--privileged' }, { options: '--volume=/etc:/host' }, { options: '-v /etc:/host' },
    { options: '--network host' }, { options: '--pid host' }, { options: '--device /dev/sda' },
    { options: '--health-cmd "true" "--privileged"' }, { options: '--health-cmd "unterminated' },
    { options: '--health-interval 5s --publish 1234:1234' }, { options: '--health-retries --privileged' },
    { options: '${{ inputs.options }}' }]) {
    const workflow = serviceWorkflow(); Object.assign(workflow.jobs.test.services.postgres, patch)
    assert.throws(() => compile(workflow, { serviceProxies: [proxy] }), /service|health/)
  }
  for (const image of ['postgres', 'postgres:latest', '${{ inputs.image }}', 'postgres:17 --privileged']) {
    const workflow = serviceWorkflow(); workflow.jobs.test.services.postgres.image = image
    assert.throws(() => compile(workflow, { serviceProxies: [proxy] }), /fixed image/)
  }
  const workflow = serviceWorkflow(); workflow.jobs.test.services.postgres.image = 'postgres@sha256:' + 'a'.repeat(64)
  assert.ok(compile(workflow, { serviceProxies: [proxy] }))
})

test('generated proxy daemon forwards real TCP bytes on container loopback', { timeout: 10000 }, async t => {
  const upstream = createServer(socket => socket.pipe(socket))
  t.after(() => upstream.close())
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const hostPort = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const workflow = changeJob({ services: { localhost: { image: 'postgres:17' } } })
  const plan = compile(workflow, { serviceProxies: [{ service: 'localhost', hostPort, containerPort: upstream.address().port }] })
  const source = outputJob(plan).steps[0].run
  const daemon = JSON.parse(source.match(/\['-e', (.*)\], \{ detached:/)[1])
  const child = spawn(process.execPath, ['-e', daemon], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  t.after(() => child.kill())
  const [message] = await once(child, 'message')
  assert.equal(message, 'ready')
  const client = connect({ host: '127.0.0.1', port: hostPort })
  t.after(() => client.destroy())
  await once(client, 'connect')
  client.write('proof of actual forwarding')
  const [bytes] = await once(client, 'data')
  assert.equal(bytes.toString(), 'proof of actual forwarding')
  client.destroy(); child.kill()
})

test('compiles discovered real CI jobs and deployables matrix without altering source steps', async t => {
  let workflowText
  try { workflowText = await readFile(new URL('../../../.artifacts/act-discovery-FAMmJp/ci.yml', import.meta.url), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') { t.skip('optional discovery fixture is not checked in'); return } throw error }
  const original = parse(workflowText)
  for (const jobId of ['static', 'deployables', 'test', 'build']) {
    const serviceProxies = jobId === 'test' ? [proxy, { service: 'enterprise-postgres', hostPort: 5434, containerPort: 5432 },
      { service: 'me-postgres', hostPort: 5433, containerPort: 5432 }] : []
    const plan = compile(base(), { workflowText, jobId, serviceProxies })
    const result = parse(plan.workflowText).jobs[jobId]
    const sourceSteps = result.steps.filter(step => plan.expectedStepIds.includes(step.id))
    assert.equal(sourceSteps.length, original.jobs[jobId].steps.length)
    for (const [index, step] of sourceSteps.entries()) {
      const { id, ...rest } = step
      assert.deepEqual(rest, original.jobs[jobId].steps[index])
    }
    assert.equal(result.if, original.jobs[jobId].if)
    if (jobId === 'deployables') assert.deepEqual(plan.matrices, [{ package: 'agent-computer' }, { package: 'supervisor' }])
  }
})
