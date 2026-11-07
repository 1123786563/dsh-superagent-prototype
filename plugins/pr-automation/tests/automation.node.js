import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Automation } from '../engine.js'
import { eligible, mergeBlockers, parseVerdict, revisionKey, latestReviews } from '../policy.js'
import { reviewWithLlm } from '../reviewer.js'
import { Github } from '../github.js'
import { openStore, apply, Config } from '../index.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const config = { repository: 'owner/repo', baseBranch: 'main', label: 'auto-review', maxChangedLines: 500,
  policyKey: 'policy', autoMerge: true, login: 'agent' }
const pr = () => ({ number: 12, state: 'open', draft: false, base: { ref: 'main', sha: 'base' },
  head: { sha: 'head', repo: { full_name: 'owner/repo' } }, labels: [{ name: 'auto-review' }],
  additions: 4, deletions: 2, changed_files: 1, mergeable: true, mergeable_state: 'clean', auto_merge: null })
const verdict = () => ({ decision: 'pass', complete: true, requiresHumanReview: false, summary: '已审核，CI 由宿主另行检查。', findings: [] })
const record = () => ({ key: revisionKey(pr()), policy: 'policy', verdict: verdict(), reviewId: 20 })
const gate = () => ({ pr: pr(), config, record: record(), checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
  suites: [], statuses: [], reviews: [], threads: [], files: [{ filename: 'src/math.ts' }], reviewDecision: null, baseIncluded: true })

function harness(overrides = {}) {
  let merged = 0, published = 0, reviewed = 0, saved = 0
  const store = { data: { records: {} }, async save() { saved++ } }
  const github = {
    async pulls() { return [pr()] }, async pull() { return pr() },
    async snapshot() { return { context: { files: [] }, files: [{ filename: 'src/math.ts' }] } },
    async checks() { return { checks: gate().checks, statuses: [] } },
    async baseIncluded() { return true },
    async reviews() { return [] }, async discussions() { return { threads: [], reviewDecision: null } },
    async files() { return [{ filename: 'src/math.ts' }] },
    async publish() { published++; return 20 }, async merge(input) { merged++; return { merged: true, sha: 'merged-' + input.head.sha } },
    ...overrides,
  }
  const automation = new Automation({ config, github, store, signal: new AbortController().signal,
    available: async () => true, review: async () => { reviewed++; return { verdict: verdict() } } })
  return { automation, github, store, count: () => ({ merged, published, reviewed, saved }) }
}

test('only explicitly labeled non-draft same-repository PRs targeting main enter', () => {
  assert.equal(eligible(pr(), config), true)
  for (const change of [{ labels: [] }, { draft: true }, { state: 'closed' }, { base: { ref: 'release' } }, { head: { repo: { full_name: 'fork/repo' } } }]) {
    assert.equal(eligible({ ...pr(), ...change }, config), false)
  }
})
test('all gates must pass, with a real CI result', () => {
  assert.deepEqual(mergeBlockers(gate()), [])
  for (const change of [
    { checks: [] }, { checks: [{ status: 'completed', conclusion: 'skipped' }] },
    { checks: [{ status: 'completed', conclusion: 'neutral' }] }, { checks: [{ status: 'in_progress' }] },
    { statuses: [{ state: 'failure' }] }, { threads: [{ isResolved: false }] }, { reviewDecision: 'REVIEW_REQUIRED' },
    { suites: [{ status: 'queued', conclusion: null }] }, { baseIncluded: false },
    { reviews: [{ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } }] },
    { record: { ...record(), key: 'old-head' } }, { record: { ...record(), policy: 'old-policy' } },
    { record: { ...record(), reviewId: undefined } },
    { files: [{ filename: 'src/auth/check.ts' }] }, { files: [{ filename: '.github/workflows/ci.yml' }] },
    { files: [{ filename: 'package.json' }] }, { files: [{ filename: 'ui.tsx' }] },
    { files: [{ filename: 'src/normal.ts', previous_filename: 'src/auth/check.ts' }] },
    { pr: { ...pr(), additions: 499, deletions: 1 } }, { pr: { ...pr(), mergeable: null } },
    { pr: { ...pr(), mergeable_state: 'behind' } }, { pr: { ...pr(), auto_merge: {} } },
  ]) assert.ok(mergeBlockers({ ...gate(), ...change }).length > 0, JSON.stringify(change))
})
test('comments do not erase requests for changes, approvals and dismissals replace them', () => {
  const reviews = [{ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'A' } }, { id: 2, state: 'COMMENTED', user: { login: 'a' } }]
  assert.equal(latestReviews(reviews)[0].state, 'CHANGES_REQUESTED')
  assert.equal(latestReviews([...reviews, { id: 3, state: 'APPROVED', user: { login: 'a' } }])[0].state, 'APPROVED')
})
test('malformed or contradictory model results cannot approve', () => {
  assert.equal(parseVerdict(JSON.stringify(verdict())).decision, 'pass')
  for (const value of ['not json', '{}', JSON.stringify({ ...verdict(), complete: false }),
    JSON.stringify({ ...verdict(), requiresHumanReview: true }), JSON.stringify({ ...verdict(), findings: [{}] })]) assert.throws(() => parseVerdict(value))
})
test('merge success records and publishes the review before merge', async () => {
  const h = harness(); await h.automation.tick()
  assert.deepEqual(h.count(), { merged: 1, reviewed: 1, published: 1, saved: 3 })
  assert.equal(h.automation.status.pulls[12].state, 'merged')
})
test('REST list summaries are expanded before taking a review snapshot', async () => {
  const summary = pr(); delete summary.additions; delete summary.deletions; delete summary.changed_files; delete summary.mergeable
  const h = harness({ pulls: async () => [summary], snapshot: async detail => {
    assert.equal(detail.changed_files, 1); assert.equal(detail.additions, 4)
    return { context: { files: [] }, files: [{ filename: 'src/math.ts' }] }
  } })
  await h.automation.tick(); assert.equal(h.count().merged, 1)
})
test('waiting CI reuses the persisted review and merges once CI succeeds', async () => {
  const h = harness({ checks: async () => ({ checks: [{ status: 'in_progress' }], statuses: [] }) })
  await h.automation.tick()
  assert.equal(h.count().merged, 0)
  h.github.checks = async () => ({ checks: gate().checks, statuses: [] })
  await h.automation.tick()
  assert.equal(h.count().reviewed, 1); assert.equal(h.count().published, 1); assert.equal(h.count().merged, 1)
})
test('head or base movement while reviewing invalidates approval', async () => {
  for (const change of [{ head: { ...pr().head, sha: 'new' } }, { base: { ...pr().base, sha: 'new' } }]) {
    let reads = 0
    const h = harness({ pull: async () => ++reads === 1 ? pr() : ({ ...pr(), ...change }) }); await h.automation.tick()
    assert.equal(h.count().merged, 0); assert.equal(h.count().published, 0)
  }
})
test('head or base movement during gate reads cannot use old CI', async () => {
  const h = harness(); let reads = 0
  h.github.pull = async () => ++reads <= 2 ? pr() : { ...pr(), head: { ...pr().head, sha: 'new-head' } }
  await h.automation.tick(); assert.equal(h.count().merged, 0)
})
test('removing the label during gate reads cancels merge', async () => {
  const h = harness(); let reads = 0
  h.github.pull = async () => ++reads <= 2 ? pr() : { ...pr(), labels: [] }
  await h.automation.tick(); assert.equal(h.count().merged, 0)
})
test('pause after review publication cancels merge', async () => {
  const h = harness(); let calls = 0
  h.automation.available = async () => ++calls < 3
  await h.automation.tick(); assert.equal(h.count().merged, 0)
})
test('failed publication and unavailable discussions fail closed', async () => {
  for (const override of [{ publish: async () => { throw new Error('network') } }, { discussions: async () => { throw new Error('denied') } }]) {
    const h = harness(override); await h.automation.tick(); assert.equal(h.count().merged, 0)
    assert.equal(h.automation.status.pulls[12].state, 'error')
  }
})
test('manual verdict never reaches merge', async () => {
  const h = harness(); h.automation.review = async () => ({ verdict: { ...verdict(), decision: 'manual', requiresHumanReview: true } })
  await h.automation.tick(); assert.equal(h.count().merged, 0); assert.equal(h.count().published, 1)
})
test('overlapping ticks cannot double-review or double-merge', async () => {
  const h = harness(); await Promise.all([h.automation.tick(), h.automation.tick()])
  assert.equal(h.count().reviewed, 1); assert.equal(h.count().merged, 1)
})
test('truncated model outputs and findings outside the snapshot are rejected', async () => {
  const llm = { async *stream() { yield { type: 'text-delta', text: JSON.stringify(verdict()) }; yield { type: 'finish', reason: { kind: 'max-tokens' } } } }
  await assert.rejects(reviewWithLlm(llm, {}, { files: [] }), /未正常结束/)
  const bad = { ...verdict(), decision: 'changes_requested', findings: [{ severity: 'high', path: 'unread.ts', line: 1, message: 'Bug' }] }
  llm.stream = async function *() { yield { type: 'text-delta', text: JSON.stringify(bad) }; yield { type: 'finish', reason: { kind: 'stop' } } }
  await assert.rejects(reviewWithLlm(llm, {}, { files: [] }), /未指向/)
})
test('GitHub pagination reads all pages and keeps only latest status per context', async () => {
  const g = new Github(config); const pages = []
  g.api = async path => { pages.push(path); return /[?&]page=1(?:&|$)/.test(path) ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }] }
  assert.equal((await g.pages('endpoint')).length, 101); assert.equal(pages.length, 2)
  g.pages = async path => path.includes('/statuses') ? [{ context: 'ci', state: 'failure' }, { context: 'ci', state: 'success' }] : []
  assert.deepEqual((await g.checks('head')).statuses, [{ context: 'ci', state: 'failure' }])
})
test('queued CI suites block even when their previous runs still report success', async () => {
  const g = new Github(config)
  g.pages = async path => path.endsWith('/check-suites') ? [{ id: 1, head_sha: 'head', latest_check_runs_count: 1, status: 'queued', conclusion: null }]
    : path.includes('check-runs') ? [{ status: 'completed', conclusion: 'success' }] : []
  const ci = await g.checks('head')
  assert.ok(mergeBlockers({ ...gate(), ...ci }).some(reason => reason.includes('suite')))
})
test('truncated paginated results and suite run counts fail closed', async () => {
  const g = new Github(config)
  g.api = async () => ({ total_count: 1001, check_suites: [{ id: 1 }] })
  await assert.rejects(g.pages('suites', value => value.check_suites), /截断/)
  g.pages = async path => path.endsWith('/check-suites') ? [{ id: 1, head_sha: 'head', latest_check_runs_count: 2 }] : []
  await assert.rejects(g.checks('head'), /检查数量/)
})
test('pause during a round prevents starting another review', async () => {
  const h = harness(); let active = true
  h.github.pulls = async () => [pr(), { ...pr(), number: 13 }]
  h.automation.available = async () => active
  h.automation.review = async () => { active = false; return { verdict: verdict() } }
  await h.automation.tick()
  assert.equal(h.automation.status.phase, 'paused')
  assert.equal(h.automation.status.pulls[13], undefined)
})
test('CLI early exit and abort while writing a large body reject without uncaught EPIPE', async () => {
  const g = new Github({ cli: process.execPath })
  await assert.rejects(g.gh(['-e', 'process.exit(1)'], { body: '审'.repeat(500000) }), /gh/)
  const controller = new AbortController(); g.signal = controller.signal
  const run = g.gh(['-e', 'setTimeout(()=>{}, 10000)'], { body: '审'.repeat(500000) })
  controller.abort()
  await assert.rejects(run, /gh/)
})
async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pr-automation-test-'))
  t.after(async () => {
    const absolute = resolve(directory)
    if (!absolute.startsWith(resolve(tmpdir()) + '/') || !absolute.includes('/dsh-pr-automation-test-')) throw new Error('Unexpected cleanup target')
    await rm(absolute, { recursive: true, force: true })
  })
  return directory
}
test('durable records survive reopening; concurrent instances cannot acquire the lock', async t => {
  const root = await temporaryStore(t), directory = join(root, 'state')
  const store = await openStore(directory)
  try {
    await assert.rejects(openStore(directory), { code: 'ELOCKED' })
    store.data.records.example = record(); await store.save()
    assert.equal(JSON.parse(await readFile(join(directory, 'reviews.json'), 'utf8')).records.example.reviewId, 20)
  } finally { await store.close() }
  const restored = await openStore(directory)
  try { assert.equal(restored.data.records.example.reviewId, 20) } finally { await restored.close() }
})
test('startup failure after acquiring the store releases its lock on scope teardown', async t => {
  const root = await temporaryStore(t), directory = join(root, 'state'), cleanups = []
  const originalApi = Github.prototype.api
  Github.prototype.api = async () => ({ login: 'agent' })
  t.after(() => { Github.prototype.api = originalApi })
  const ctx = { effect(create) { cleanups.push(create()) },
    llm: { async resolveModelInfo() {} }, agentDefaultModel: { currentSelection() { return { provider: 'test', model: 'test' } } },
    webServer: { register() { throw new Error('Duplicate route') } } }
  await assert.rejects(apply(ctx, Config({ repository: 'owner/repo', stateDir: directory })), /Duplicate route/)
  for (const cleanup of cleanups.reverse()) await cleanup()
  const recovered = await openStore(directory); await recovered.close()
})
test('GitHub merge is bound to the reviewed SHA and never requests bypass', async () => {
  const g = new Github({ ...config, mergeMethod: 'merge' }); let actual
  g.api = async (...args) => { actual = args; return { merged: true } }
  await g.merge(pr())
  assert.deepEqual(actual, ['repos/owner/repo/pulls/12/merge', { sha: 'head', merge_method: 'merge' }, 'PUT'])
})
