import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { stringify } from 'yaml'
import { LocalCi } from '../local-ci.js'
import { runActProcess } from '../act-process.js'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
const runnerImage = 'sha256:' + 'a'.repeat(64)
const workflowPath = '.github/workflows/ci.yml'
const workflowText = stringify({ name: 'Fixture CI', on: { pull_request: {} }, jobs: {
  test: { 'runs-on': 'ubuntu-latest', strategy: { matrix: { package: ['first', 'second'] } }, steps: [{ run: 'echo fixture' }] },
} })
const credentialNames = ['GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'NPM_TOKEN', 'DSH_API_KEY']
const exists = async path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })

async function fixture(t, { actVersion = 'act version 0.2.97-dsh2', symlinkActrc = false, runProcess } = {}) {
  const tempParent = await realpath(tmpdir())
  const root = await mkdtemp(join(tempParent, 'dsh-local-ci-test-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), tempParent)
    assert.match(basename(root), /^dsh-local-ci-test-/)
    assert.equal(await realpath(root), resolve(root))
    await rm(root, { recursive: true, force: true })
  })
  const source = join(root, 'source'), trace = join(root, 'trace.jsonl'), resources = join(root, 'resources.json')
  await mkdir(source)
  await writeFile(resources, JSON.stringify({ volumes: [] }))
  await writeFile(trace, '')
  const git = args => execute('git', args, { cwd: source, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  await git(['-c', 'init.defaultBranch=main', 'init', '-q'])
  await git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
  await writeFile(join(source, 'tracked.txt'), 'committed content')
  const externalActrc = join(root, 'outside-actrc')
  if (symlinkActrc) {
    await writeFile(externalActrc, '--privileged\n')
    await symlink(externalActrc, join(source, '.actrc'))
  } else await writeFile(join(source, '.actrc'), '--dryrun\n')
  await git(['add', 'tracked.txt', '.actrc'])
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  await writeFile(join(source, 'tracked.txt'), 'dirty source content must not leak')
  await writeFile(join(source, '.env.local'), 'DUMMY_UNTRACKED_FIXTURE=must-not-copy')

  const prelude = `const fs=require('node:fs'); const cp=require('node:child_process'); const path=require('node:path');
const trace=${JSON.stringify(trace)}, resourcePath=${JSON.stringify(resources)};
const args=process.argv.slice(2);
const credentials=Object.fromEntries(${JSON.stringify(credentialNames)}.filter(key=>Object.hasOwn(process.env,key)).map(key=>[key,process.env[key]]));
const log=value=>fs.appendFileSync(trace,JSON.stringify({...value,args,env:{HOME:process.env.HOME,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,DOCKER_HOST:process.env.DOCKER_HOST,credentials}})+'\\n');
`
  const gitScript = join(root, 'fake-git.cjs')
  await writeFile(gitScript, `#!${process.execPath}\n${prelude}
log({kind:'git'});
const child=cp.spawnSync('git',args,{env:process.env,encoding:'utf8'});
if(child.stdout)process.stdout.write(child.stdout);if(child.stderr)process.stderr.write(child.stderr);
process.exit(child.status??1);
`, { mode: 0o700 })
  const dockerScript = join(root, 'fake-docker.cjs')
  await writeFile(dockerScript, `#!${process.execPath}\n${prelude}
log({kind:'docker'});
let resources=JSON.parse(fs.readFileSync(resourcePath,'utf8'));
if(args[0]==='context'&&args[1]==='inspect')console.log('unix:///fixture/docker.sock');
else if(args[0]==='image'&&args[1]==='inspect')console.log(JSON.stringify([{Id:${JSON.stringify(runnerImage)}}]));
else if(args[0]==='ps'){}
else if(['volume','network'].includes(args[0])&&args[1]==='ls'){
 const filter=args[args.indexOf('--filter')+1].slice('name='.length);
 if(args[0]==='volume')console.log(resources.volumes.filter(name=>name.includes(filter)).join('\\n'));
}else if(args[0]==='volume'&&args[1]==='inspect')console.log(JSON.stringify([{Name:args[2]}]));
else if(args[0]==='volume'&&args[1]==='rm'){
 resources.volumes=resources.volumes.filter(name=>name!==args[2]);fs.writeFileSync(resourcePath,JSON.stringify(resources));
}else{console.error('Unexpected fake Docker call',JSON.stringify(args));process.exit(9)}
`, { mode: 0o700 })
  const actScript = join(root, 'fake-act.cjs')
  await writeFile(actScript, `#!${process.execPath}\n${prelude}
if(args[0]==='--version'){console.log(${JSON.stringify(actVersion)});process.exit(0)}
const option=key=>args[args.indexOf(key)+1];
const workspace=option('--directory'), cache=option('--action-cache-path');
const workflow=require(${JSON.stringify(require.resolve('yaml'))}).parse(fs.readFileSync(option('--workflows'),'utf8'));
const jobID=option('--job'),job=workflow.jobs[jobID];
const matrix=Object.fromEntries(Object.entries(job.strategy?.matrix??{}).map(([key,values])=>[key,values[0]]));
const toolcache=process.env.DSH_ACT_TOOLCACHE_VOLUME;
if(!toolcache){console.error('Missing isolated toolcache variable');process.exit(10)}
fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(path.join(cache,'cached-action'),'task-private action cache');
const resources=JSON.parse(fs.readFileSync(resourcePath,'utf8'));resources.volumes.push(toolcache);fs.writeFileSync(resourcePath,JSON.stringify(resources));
let hasActrc=true;try{fs.lstatSync(path.join(workspace,'.actrc'))}catch(error){if(error.code==='ENOENT')hasActrc=false;else throw error}
log({kind:'act',cache,toolcache,workspace,hasActrc,sha:cp.execFileSync('git',['-C',workspace,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),tracked:fs.readFileSync(path.join(workspace,'tracked.txt'),'utf8'),hasUntracked:fs.existsSync(path.join(workspace,'.env.local'))});
for(const step of job.steps)console.log(JSON.stringify({jobID,matrix,stage:'Main',stepID:[step.id],stepResult:'success'}));
console.error(JSON.stringify({jobID,matrix,jobResult:'success'}));
`, { mode: 0o700 })

  const config = { repository: 'owner/repo', baseBranch: 'main', label: 'auto-review', login: 'fixture-agent',
    stateDir: join(root, 'state'), cli: 'must-not-call-gh', localCi: { sourceDirectory: source, actCli: actScript,
      dockerCli: dockerScript, gitCli: gitScript, runnerImage, architecture: 'linux/amd64', timeoutSeconds: 60,
      cpus: 2, memoryGb: 4, publishStatus: false, jobs: [{ workflow: workflowPath, job: 'test' }] } }
  const pr = { number: 7, title: 'Fixture', state: 'open', draft: false, labels: [{ name: 'auto-review' }],
    head: { sha, ref: 'feature', repo: { full_name: 'owner/repo' } }, base: { sha, ref: 'main' }, additions: 1, deletions: 0, changed_files: 1 }
  const calls = { content: [], pull: [] }
  const github = { async pull(number, signal) { calls.pull.push({ number, signal }); return pr },
    async content(path, ref, signal) { calls.content.push({ path, ref, signal }); return workflowText } }
  const store = { data: {}, async save() {} }, controller = new AbortController()
  const runner = new LocalCi({ config, github, store, signal: controller.signal, available: async () => true, ...(runProcess ? { runProcess } : {}) })
  const logs = async () => (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { root, source, externalActrc, config, pr, github, calls, store, controller, runner, logs, resources }
}

test('real Git checkout plus fake act/Docker isolates each task toolcache and verifies root evidence', async t => {
  const f = await fixture(t)
  await f.runner.initialize()
  const result = await f.runner.ensure(f.pr)
  assert.equal(result.status, 'success', result.error ?? JSON.stringify(result.tasks.map(({ reasons, error, cleanup }) => ({ reasons, error, cleanup }))))
  assert.equal(result.tasks.length, 2)
  assert.equal(result.workspaceRemoved, true)
  assert.equal(await exists(join(result.directory, 'workspace')), false)
  assert.deepEqual(f.calls.content.map(({ path, ref }) => ({ path, ref })), [{ path: workflowPath, ref: f.pr.base.sha }])
  assert.ok(f.calls.content.every(call => call.signal instanceof AbortSignal))
  const logs = await f.logs(), runs = logs.filter(entry => entry.kind === 'act')
  assert.equal(runs.length, 2)
  assert.equal(new Set(runs.map(run => run.toolcache)).size, 2)
  for (const [index, run] of runs.entries()) {
    const label = run.args[run.args.indexOf('--container-options') + 1].match(/dsh\.pr-ci=([a-f0-9]{24})/)[1]
    assert.equal(run.toolcache, `dsh-ci-toolcache-${label}`)
    assert.ok(result.tasks[index].cleanup.volumes.includes(run.toolcache))
    assert.equal(run.sha, f.pr.head.sha)
    assert.equal(run.tracked, 'committed content')
    assert.equal(run.hasUntracked, false)
    assert.equal(run.hasActrc, false)
    assert.ok(isAbsolute(run.workspace))
    assert.ok(run.args.includes('--container-options-policy'))
    assert.equal(run.args[run.args.indexOf('--container-daemon-socket') + 1], '-')
    assert.equal(result.tasks[index].passed, true)
    assert.equal(result.tasks[index].actionCacheRemoved, true)
    assert.match(await readFile(result.tasks[index].logPath, 'utf8'), /"jobResult":"success"/)
  }
  assert.deepEqual(JSON.parse(await readFile(f.resources, 'utf8')).volumes, [])
})

test('per-task action caches have unique names and are removed after completion', async t => {
  const f = await fixture(t)
  await f.runner.initialize(); const result = await f.runner.ensure(f.pr)
  assert.equal(result.status, 'success')
  const runs = (await f.logs()).filter(entry => entry.kind === 'act')
  assert.equal(new Set(runs.map(run => run.cache)).size, 2)
  for (const run of runs) {
    assert.equal(dirname(run.cache), result.directory)
    assert.match(basename(run.cache), /^action-cache-[a-f0-9]{24}$/)
    assert.equal(await exists(run.cache), false, 'task-private downloaded action code must be cleaned')
  }
})

test('act and runtime Docker receive private HOME and no inherited credentials', async t => {
  const previous = Object.fromEntries(credentialNames.map(key => [key, process.env[key]]))
  for (const key of credentialNames) process.env[key] = 'fixture-only-host-credential'
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const f = await fixture(t)
  await f.runner.initialize(); const result = await f.runner.ensure(f.pr)
  assert.equal(result.status, 'success')
  const runs = (await f.logs()).filter(entry => entry.kind === 'act' || (entry.kind === 'docker' && !['context', 'image'].includes(entry.args[0])))
  assert.ok(runs.length > 2)
  for (const run of runs) {
    assert.equal(run.env.HOME, join(result.directory, 'home'))
    assert.equal(run.env.XDG_CONFIG_HOME, join(result.directory, 'home', '.config'))
    assert.equal(run.env.DOCKER_HOST, 'unix:///fixture/docker.sock')
    assert.deepEqual(run.env.credentials, {})
  }
})

test('prepareCheckout uses absolute workspace paths, removes symlink .actrc and preserves its target', async t => {
  const f = await fixture(t, { symlinkActrc: true })
  await f.runner.initialize()
  const workspace = join(f.runner.root, 'manual-workspace')
  await f.runner.prepareCheckout(f.pr, workspace, f.controller.signal)
  assert.equal(await exists(join(workspace, '.actrc')), false)
  assert.equal(await readFile(f.externalActrc, 'utf8'), '--privileged\n')
  assert.equal((await execute('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim(), f.pr.head.sha)
  // act archives regular files only: an empty refs directory disappears in the container,
  // and Git then rejects the checkout even when HEAD/config/objects were copied.
  assert.equal(await readFile(join(workspace, '.git', 'refs', 'heads', 'dsh-ci-head'), 'utf8'), f.pr.head.sha + '\n')
  const checkoutCalls = (await f.logs()).filter(entry => entry.kind === 'git' && entry.args.includes('core.hooksPath=/dev/null'))
  assert.ok(checkoutCalls.length >= 5)
  for (const call of checkoutCalls) assert.equal(call.args[call.args.indexOf('-C') + 1], workspace)
  await assert.rejects(f.runner.prepareCheckout(f.pr, join(f.root, 'outside-workspace'), f.controller.signal), /CI 状态目录之外/)
})

test('initialize rejects ordinary act builds and nonabsolute source directories', async t => {
  const f = await fixture(t, { actVersion: 'act version 0.2.97' })
  await assert.rejects(f.runner.initialize(), /0\.2\.97-dsh2/)
  f.config.localCi.sourceDirectory = 'relative/source'
  await assert.rejects(f.runner.initialize(), /绝对路径/)
})

test('error records back off, retry only after due time and increase the attempt count', async t => {
  const f = await fixture(t)
  await f.runner.initialize()
  const original = f.github.content; let reads = 0
  f.github.content = async (...args) => { reads++; if (reads <= 2) throw new Error('fixture transient workflow fetch failure'); return original(...args) }
  const before = Date.now(), first = await f.runner.ensure(f.pr)
  assert.equal(first.status, 'error'); assert.equal(first.attempt, 1)
  assert.ok(Date.parse(first.retryAt) >= before + 30000)
  assert.equal(await f.runner.ensure(f.pr), first)
  assert.equal(reads, 1)
  first.retryAt = new Date(0).toISOString()
  const beforeSecond = Date.now(), second = await f.runner.ensure(f.pr)
  assert.equal(second.status, 'error'); assert.equal(second.attempt, 2)
  assert.ok(Date.parse(second.retryAt) >= beforeSecond + 60000)
  second.retryAt = new Date(0).toISOString()
  const third = await f.runner.ensure(f.pr)
  assert.equal(third.status, 'success', third.error)
  assert.equal(third.attempt, 3)
  assert.equal(third.retryAt, undefined)
  const count = (await f.logs()).filter(entry => entry.kind === 'act').length
  assert.equal(await f.runner.ensure(f.pr), third)
  assert.equal((await f.logs()).filter(entry => entry.kind === 'act').length, count)
})

test('cancelled records have retry scheduling and can recover when availability returns', async t => {
  const f = await fixture(t)
  await f.runner.initialize()
  f.runner.available = async () => false
  const result = await f.runner.ensure(f.pr)
  assert.equal(result.status, 'cancelled')
  assert.ok(Date.parse(result.retryAt) > Date.now())
  f.runner.available = async () => true
  assert.equal(await f.runner.ensure(f.pr), result)
  result.retryAt = new Date(0).toISOString()
  const retry = await f.runner.ensure(f.pr)
  assert.equal(retry.status, 'success', retry.error)
  assert.equal(retry.attempt, 2)
})

test('busy runner rejects overlapping requests while the first real subprocess run is pending', async t => {
  let release, signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  t.after(() => release())
  let first = true
  const f = await fixture(t, { runProcess: async options => {
    if (first) { first = false; signalStarted(); await blocked }
    return runActProcess(options)
  } })
  await f.runner.initialize()
  const pending = f.runner.ensure(f.pr)
  await started
  assert.equal(f.runner.busy, true)
  await assert.rejects(f.runner.ensure(f.pr), /执行器正忙/)
  release()
  const result = await pending
  assert.equal(result.status, 'success', result.error)
  assert.equal(f.runner.busy, false)
})
