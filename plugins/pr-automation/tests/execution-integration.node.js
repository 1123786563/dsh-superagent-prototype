import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Automation } from '../engine.js'
import { apply, Config } from '../index.js'
import { Github } from '../github.js'
import { LocalCi } from '../local-ci.js'
import { revisionKey } from '../policy.js'
import { localCiKey, taskIdentity } from '../ci-policy.js'

function fixture() {
  const config = { enabled: true, repository: 'owner/repo', baseBranch: 'main', label: 'auto-review',
    maxChangedLines: 500, policyKey: 'fixture', autoMerge: true, login: 'agent', ciMode: 'github',
    executionWindow: { enabled: true, timeZone: 'Asia/Shanghai', start: '09:00', end: '10:00' } }
  const pr = { number: 1, state: 'open', draft: false, base: { ref: 'main', sha: 'base' },
    head: { sha: 'head', repo: { full_name: 'owner/repo' } }, labels: [{ name: 'auto-review' }],
    additions: 1, deletions: 0, changed_files: 1, mergeable: true, mergeable_state: 'clean', auto_merge: null }
  const clock = { now: new Date('2026-11-07T01:59:00Z') }
  const calls = { listed: 0, reviewed: 0, published: 0, merged: 0, tested: 0 }
  const verdict = { decision: 'pass', complete: true, requiresHumanReview: false, summary: 'Reviewed', findings: [] }
  const github = { async pulls() { calls.listed++; return [pr] }, async pull() { return pr },
    async snapshot() { return { context: {}, files: [{ filename: 'src/math.ts' }] } },
    async checks() { return { checks: [{ status: 'completed', conclusion: 'success' }], statuses: [], suites: [] } },
    async reviews() { return [] }, async discussions() { return { threads: [], reviewDecision: null } },
    async files() { return [{ filename: 'src/math.ts' }] }, async baseIncluded() { return true },
    async publish() { calls.published++; return 20 }, async merge() { calls.merged++; return { merged: true, sha: 'merged' } } }
  const automation = new Automation({ config, github, store: { data: { records: {} }, async save() {} },
    signal: new AbortController().signal, available: async () => true, now: () => clock.now.toISOString(),
    review: async () => { calls.reviewed++; return { verdict } } })
  return { config, pr, clock, calls, github, automation, verdict }
}

test('total switch prevents even listing PRs, reviewing, testing and merging', async () => {
  const f = fixture(); f.config.enabled = false
  await f.automation.tick()
  assert.deepEqual(f.calls, { listed: 0, reviewed: 0, published: 0, merged: 0, tested: 0 })
  assert.equal(f.automation.status.phase, 'disabled')
})

test('outside the daily window does not start a round, and opening it permits processing', async () => {
  const f = fixture(); f.clock.now = new Date('2026-11-07T00:59:00Z')
  await f.automation.tick()
  assert.equal(f.calls.listed, 0); assert.equal(f.automation.status.phase, 'outside_window')
  f.clock.now = new Date('2026-11-07T01:00:00Z')
  await f.automation.tick()
  assert.equal(f.calls.reviewed, 1); assert.equal(f.calls.merged, 1)
})

test('slow availability reads crossing the window cannot start a round', async () => {
  const f = fixture()
  f.automation.available = async () => { f.clock.now = new Date('2026-11-07T02:00:00Z'); return true }
  await f.automation.tick()
  assert.equal(f.calls.listed, 0); assert.equal(f.calls.reviewed, 0); assert.equal(f.calls.merged, 0)
  assert.equal(f.automation.status.phase, 'outside_window')
})

test('window closing during model review prevents publishing and merging', async () => {
  const f = fixture()
  f.automation.review = async () => { f.calls.reviewed++; f.clock.now = new Date('2026-11-07T02:00:00Z'); return { verdict: f.verdict } }
  await f.automation.tick()
  assert.equal(f.calls.reviewed, 1); assert.equal(f.calls.published, 0); assert.equal(f.calls.merged, 0)
})

test('window closing during local CI prevents merging its successful result', async () => {
  const f = fixture(), workflow = '.github/workflows/ci.yml'
  f.config.ciMode = 'local'; f.config.localCi = { jobs: [{ workflow, job: 'test' }] }
  const identity = taskIdentity(workflow, 'test', {})
  f.automation.localCi = { async ensure() {
    f.calls.tested++; f.clock.now = new Date('2026-11-07T02:00:00Z')
    return { key: revisionKey(f.pr), configKey: localCiKey(f.config.localCi), status: 'success',
      expectedTasks: [identity], tasks: [{ identity, passed: true, cleanup: { success: true } }], workspaceRemoved: true }
  } }
  await f.automation.tick()
  assert.equal(f.calls.tested, 1); assert.equal(f.calls.merged, 0)
  assert.ok(f.automation.status.pulls[1].reasons.some(reason => reason.includes('允许执行')))
})

for (const change of ['window', 'switch']) test(`${change} changing during the final PR read cannot merge`, async () => {
  const f = fixture(); let reads = 0
  f.github.pull = async () => {
    if (++reads === 3) {
      if (change === 'window') f.clock.now = new Date('2026-11-07T02:00:00Z')
      else f.config.enabled = false
    }
    return f.pr
  }
  await f.automation.tick()
  assert.equal(reads, 3); assert.equal(f.calls.published, 1); assert.equal(f.calls.merged, 0)
  assert.equal(f.automation.status.pulls[1].state, 'waiting')
})

test('review deduplication cannot publish after the total switch closes', async () => {
  const f = fixture(); f.config.executionWindow.enabled = false
  const github = new Github(f.config); let writes = 0
  github.reviews = async () => { f.config.enabled = false; return [] }
  github.api = async () => { writes++; return { id: 1 } }
  await assert.rejects(github.publish(f.pr, { key: 'key', policy: 'policy', verdict: f.verdict }, 'agent'), /已关闭|允许执行/)
  assert.equal(writes, 0)
  assert.throws(() => github.merge(f.pr), /已关闭|允许执行/)
  assert.equal(writes, 0)
})

test('local CI scope guard rechecks the total switch after slow PR reads', async () => {
  const f = fixture(); f.config.executionWindow.enabled = false; f.config.localCi = {}
  const ci = new LocalCi({ config: f.config, store: { data: {} }, signal: new AbortController().signal,
    available: async () => true, github: { async pull() { f.config.enabled = false; return f.pr } } })
  assert.equal(await ci.stillCurrent(f.pr), false)
})

test('local CI scope guard does not query GitHub when outside its daily window', async () => {
  const f = fixture(), clock = new Date(), current = clock.getUTCHours() * 60 + clock.getUTCMinutes()
  const time = offset => { const n = (current + offset) % 1440; return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` }
  f.config.executionWindow = { enabled: true, timeZone: 'UTC', start: time(60), end: time(120) }; f.config.localCi = {}
  let reads = 0
  const ci = new LocalCi({ config: f.config, store: { data: {} }, signal: new AbortController().signal,
    available: async () => true, github: { async pull() { reads++; return f.pr } } })
  assert.equal(await ci.stillCurrent(f.pr), false); assert.equal(reads, 0)
})

function context() {
  let handler
  const cleanups = []
  const ctx = { effect(create) { cleanups.push(create()) }, logger: { info() {}, error() {} },
    webServer: { getOrigin() { return 'http://127.0.0.1:3200' }, register(route) { handler = route.handler; return () => {} } } }
  return { ctx, async close() { for (const cleanup of cleanups.reverse()) await cleanup?.() },
    status() { let body, code; handler({ method: 'GET', headers: { host: '127.0.0.1:3200', 'x-pr-automation-request': '1' } },
      { writeHead(value) { code = value }, end(value) { body = value } }); assert.equal(code, 200); return JSON.parse(body) } }
}
async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-window-test-'))
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '/pr-window-test-')); await rm(directory, { recursive: true, force: true }) })
  return directory
}

test('disabled plugin exposes settings without GitHub, model, Docker, or state initialization', async t => {
  const directory = await temp(t), h = context(), stateDir = join(directory, 'state')
  await apply(h.ctx, Config({ enabled: false, repository: 'owner/repo', stateDir, ciMode: 'local', cli: '/must-not-run', pollSeconds: 300 }))
  t.after(h.close)
  const status = h.status()
  assert.equal(status.phase, 'disabled'); assert.equal(status.execution.allowed, false)
  assert.equal(status.pollSeconds, 300); assert.equal(status.nextPollAt, null)
  await assert.rejects(access(stateDir), { code: 'ENOENT' })
})

test('poll interval is reflected in status and the next non-overlapping round', async t => {
  const directory = await temp(t), h = context(), oldApi = Github.prototype.api, oldFetch = globalThis.fetch
  Github.prototype.api = async () => ({ login: 'agent' })
  globalThis.fetch = async url => ({ ok: true, async json() { return String(url).endsWith('/state')
    ? { paused: true, setup: {} } : { sources: [] } } })
  t.after(async () => { await h.close(); Github.prototype.api = oldApi; globalThis.fetch = oldFetch })
  h.ctx.llm = { async resolveModelInfo() {} }
  h.ctx.agentDefaultModel = { currentSelection() { return { provider: 'fixture', model: 'fixture' } } }
  await apply(h.ctx, Config({ repository: 'owner/repo', stateDir: join(directory, 'state'), pollSeconds: 120 }))
  await new Promise(resolve => setImmediate(resolve))
  const status = h.status(), remaining = Date.parse(status.nextPollAt) - Date.now()
  assert.equal(status.pollSeconds, 120); assert.equal(status.phase, 'paused')
  assert.ok(remaining > 115000 && remaining <= 120000, `unexpected next poll delay: ${remaining}`)
})

test('config validates polling bounds and defaults time controls without enabling a time restriction', () => {
  const base = { repository: 'owner/repo', stateDir: '/fixture' }, value = Config(base)
  assert.equal(value.enabled, true); assert.equal(value.pollSeconds, 60)
  assert.equal(value.executionWindow.enabled, false); assert.equal(value.executionWindow.timeZone, 'Asia/Shanghai')
  for (const pollSeconds of [0, 59, 3601, 100.5]) assert.throws(() => Config({ ...base, pollSeconds }))
})
