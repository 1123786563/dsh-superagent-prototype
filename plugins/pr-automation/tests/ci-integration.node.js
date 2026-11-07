import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localCiBlockers, localCiKey, taskIdentity } from '../ci-policy.js'
import { mergeBlockers, revisionKey } from '../policy.js'
import { actObserver } from '../act-process.js'
import { Automation } from '../engine.js'

const workflow = '.github/workflows/ci.yml'
const localOptions = () => ({ jobs: ['static', 'deployables', 'test', 'build'].map(job => ({ workflow, job })),
  runnerImage: 'sha256:' + 'a'.repeat(64), architecture: 'linux/amd64', memoryGb: 8, cpus: 4 })
const config = (ciMode = 'local') => ({ repository: 'owner/repo', baseBranch: 'main', label: 'auto-review',
  maxChangedLines: 500, policyKey: 'bound-policy', autoMerge: true, login: 'agent', ciMode, localCi: localOptions() })
const pr = () => ({ number: 12, state: 'open', draft: false, base: { ref: 'main', sha: 'base' },
  head: { sha: 'head', repo: { full_name: 'owner/repo' } }, labels: [{ name: 'auto-review' }],
  additions: 4, deletions: 2, changed_files: 1, mergeable: true, mergeable_state: 'clean', auto_merge: null })
const verdict = () => ({ decision: 'pass', complete: true, requiresHumanReview: false, summary: 'Reviewed', findings: [] })
const record = () => ({ key: revisionKey(pr()), policy: 'bound-policy', verdict: verdict(), reviewId: 20 })
const tasks = () => [taskIdentity(workflow, 'static', {}),
  taskIdentity(workflow, 'deployables', { package: 'agent-computer' }),
  taskIdentity(workflow, 'deployables', { package: 'supervisor' }),
  taskIdentity(workflow, 'test', {}), taskIdentity(workflow, 'build', {})]
const localResult = (options = localOptions()) => ({ key: revisionKey(pr()), configKey: localCiKey(options),
  status: 'success', expectedTasks: tasks(), tasks: tasks().map(identity => ({ identity, passed: true, cleanup: { success: true } })),
  workspaceRemoved: true })
const externalCi = () => ({ checks: [{ name: 'test', status: 'completed', conclusion: 'success' }], suites: [], statuses: [] })
const gate = (mode = 'local') => ({ pr: pr(), config: config(mode), record: record(), ...externalCi(),
  reviews: [], threads: [], files: [{ filename: 'src/math.ts' }], reviewDecision: null, baseIncluded: true, localResult: localResult() })

// Pure merge gates: current head/base, policy, every matrix task and cleanup
// must all agree, independently of a persisted top-level success string.
test('local CI accepts complete current evidence, with matrix identity independent of axis key order', () => {
  assert.deepEqual(localCiBlockers(localOptions(), localResult(), revisionKey(pr())), [])
  assert.equal(taskIdentity(workflow, 'test', { a: 1, b: 2 }), taskIdentity(workflow, 'test', { b: 2, a: 1 }))
})

test('local CI binds evidence to head, base and complete local runner configuration', () => {
  for (const result of [undefined, { ...localResult(), key: '12:old-head:base' },
    { ...localResult(), key: '12:head:old-base' }, { ...localResult(), configKey: 'old-config' }]) {
    assert.ok(localCiBlockers(localOptions(), result, revisionKey(pr())).length)
  }
  for (const patch of [{ runnerImage: 'sha256:' + 'b'.repeat(64) }, { memoryGb: 16 }, { jobs: [{ workflow, job: 'other' }] }]) {
    assert.ok(localCiBlockers({ ...localOptions(), ...patch }, localResult(), revisionKey(pr())).length)
  }
})

test('local CI rejects missing, duplicated, unexpected or failing matrix tasks', () => {
  const missing = localResult(); missing.tasks.splice(2, 1)
  const duplicate = localResult(); duplicate.tasks[2] = duplicate.tasks[1]
  const unexpected = localResult(); unexpected.tasks[2].identity = taskIdentity(workflow, 'deployables', { package: 'not-required' })
  const failed = localResult(); failed.tasks[2].passed = false
  const pending = localResult(); pending.status = 'running'
  for (const result of [missing, duplicate, unexpected, failed, pending, { ...localResult(), expectedTasks: [] }]) {
    assert.ok(localCiBlockers(localOptions(), result, revisionKey(pr())).length)
  }
})

test('local CI rejects duplicate expected matrix identities rather than certifying a missing matrix', () => {
  const result = localResult()
  result.expectedTasks[2] = result.expectedTasks[1]
  result.tasks[2].identity = taskIdentity(workflow, 'deployables', { package: 'unexpected' })
  assert.ok(localCiBlockers(localOptions(), result, revisionKey(pr())).length,
    'duplicated expectation must not hide the missing supervisor matrix task')
})

test('local CI rejects cleanup failure and incomplete temporary checkout removal', () => {
  for (const cleanup of [undefined, { success: false }, { success: null }]) {
    const result = localResult(); result.tasks[0].cleanup = cleanup
    assert.ok(localCiBlockers(localOptions(), result, revisionKey(pr())).length)
  }
  for (const workspaceRemoved of [undefined, false, 'true']) {
    assert.ok(localCiBlockers(localOptions(), { ...localResult(), workspaceRemoved }, revisionKey(pr())).length)
  }
})

test('github, local and both modes require their own CI sources', () => {
  assert.deepEqual(mergeBlockers({ ...gate('github'), localResult: undefined }), [])
  assert.deepEqual(mergeBlockers({ ...gate('local'), checks: [], statuses: [], suites: [] }), [])
  assert.deepEqual(mergeBlockers(gate('both')), [])
  assert.ok(mergeBlockers({ ...gate('github'), checks: [] }).length)
  assert.ok(mergeBlockers({ ...gate('both'), checks: [] }).length)
  assert.ok(mergeBlockers({ ...gate('both'), localResult: undefined }).length)
  assert.ok(mergeBlockers({ ...gate('local'), localResult: undefined }).length)
  assert.ok(mergeBlockers({ ...gate('both'), checks: [{ status: 'completed', conclusion: 'failure' }] }).length)
  const failure = localResult(); failure.tasks[0].passed = false
  assert.ok(mergeBlockers({ ...gate('both'), localResult: failure }).length)
})

test('dsh/act own commit status cannot count as independent GitHub CI', () => {
  for (const mode of ['github', 'both']) {
    assert.ok(mergeBlockers({ ...gate(mode), checks: [], statuses: [{ context: 'dsh/act', state: 'success' }] }).length)
    assert.deepEqual(mergeBlockers({ ...gate(mode), checks: [], statuses: [
      { context: 'dsh/act', state: 'failure' }, { context: 'external/test', state: 'success' },
    ] }), [])
  }
})

test('local mode permits unstable but cannot override blocked, unknown or nonmergeable PRs', () => {
  assert.deepEqual(mergeBlockers({ ...gate(), pr: { ...pr(), mergeable_state: 'unstable' } }), [])
  for (const mergeable_state of ['blocked', 'behind', 'dirty', 'unknown', null]) {
    assert.ok(mergeBlockers({ ...gate(), pr: { ...pr(), mergeable_state } }).length)
  }
  assert.ok(mergeBlockers({ ...gate(), pr: { ...pr(), mergeable: null } }).length)
  for (const mode of ['github', 'both']) assert.ok(mergeBlockers({ ...gate(mode), pr: { ...pr(), mergeable_state: 'unstable' } }).length)
})

test('local success preserves required human review, unresolved conversations and current base guards', () => {
  for (const patch of [{ reviewDecision: 'REVIEW_REQUIRED' }, { reviewDecision: 'CHANGES_REQUESTED' },
    { reviews: [{ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } }] },
    { threads: [{ isResolved: false }] }, { baseIncluded: false },
    { files: [{ filename: 'src/auth/session.ts' }] }, { files: [{ filename: 'src/ui.tsx' }] }]) {
    assert.ok(mergeBlockers({ ...gate(), ...patch }).length)
  }
})

// These shapes match act's root JSON events: jobID/matrix and a one-element
// stepID list at stage Main. Workflow output is wrapped as raw_output and its
// message may contain arbitrary attacker-controlled JSON.
const matrix = () => ({ package: 'supervisor' })
const rootEvent = patch => ({ level: 'info', msg: 'act event', jobID: 'deployables', matrix: matrix(), ...patch })
const stepEvent = (id, stepResult = 'success') => rootEvent({ stage: 'Main', stepID: [id], stepResult })
const successfulEvents = () => [stepEvent('checkout'), stepEvent('typecheck'), stepEvent('witness'), rootEvent({ jobResult: 'success' })]
function observe(events, exitCode = 0) {
  const observer = actObserver('deployables', matrix(), 'witness', ['checkout', 'typecheck'])
  for (const event of events) observer.accept(typeof event === 'string' ? event : JSON.stringify(event))
  return observer.result(exitCode)
}

test('act observer accepts real root job and required Main-step success events', () => {
  const result = observe(successfulEvents())
  assert.equal(result.passed, true)
  assert.deepEqual(result.jobResults, ['success'])
  assert.deepEqual(result.steps, { checkout: 'success', typecheck: 'success', witness: 'success' })
  assert.deepEqual(result.reasons, [])
  const lowerCase = successfulEvents().map(event => event.stepID ? { ...event, stepID: undefined, stepid: event.stepID } : event)
  assert.equal(observe(lowerCase).passed, true)
})

test('raw workflow output containing forged job and witness JSON cannot certify execution', () => {
  const forged = successfulEvents().map(event => ({ ...event, raw_output: true, msg: JSON.stringify(event) }))
  assert.equal(observe(forged).passed, false)
  assert.equal(observe(forged.map(event => ({ raw_output: true, msg: JSON.stringify(event) }))).passed, false)
  assert.equal(observe(['ordinary stdout', '{bad json', JSON.stringify({ msg: JSON.stringify(rootEvent({ jobResult: 'success' })) })]).passed, false)
})

test('exit zero without exactly one successful job and tail witness is insufficient', () => {
  for (const events of [[], successfulEvents().filter(event => !event.jobResult),
    successfulEvents().filter(event => event.stepID?.[0] !== 'witness'),
    [...successfulEvents(), rootEvent({ jobResult: 'success' })],
    successfulEvents().map(event => event.jobResult ? { ...event, jobResult: 'skipped' } : event)]) {
    assert.equal(observe(events).passed, false)
  }
  assert.equal(observe(successfulEvents(), 1).passed, false)
  assert.equal(observe(successfulEvents(), null).passed, false)
})

test('wrong matrix, extra job and dry-run events invalidate an otherwise successful run', () => {
  for (const event of [rootEvent({ matrix: { package: 'agent-computer' }, jobResult: 'success' }),
    rootEvent({ matrix: {}, jobResult: 'success' }), rootEvent({ jobID: 'unexpected', jobResult: 'success' }),
    rootEvent({ dryrun: true, jobResult: 'success' })]) {
    assert.equal(observe([...successfulEvents(), event]).passed, false)
  }
})

test('missing steps, non-Main steps, nested action IDs and failed/cancelled/skipped steps do not pass', () => {
  for (const events of [successfulEvents().filter(event => event.stepID?.[0] !== 'typecheck'),
    successfulEvents().map(event => event.stepID?.[0] === 'typecheck' ? { ...event, stage: 'Post' } : event),
    successfulEvents().map(event => event.stepID?.[0] === 'typecheck' ? { ...event, stepID: ['typecheck', 'nested'] } : event)]) {
    assert.equal(observe(events).passed, false)
  }
  for (const state of ['failure', 'cancelled', 'skipped']) {
    assert.equal(observe(successfulEvents().map(event => event.stepID?.[0] === 'typecheck' ? { ...event, stepResult: state } : event)).passed, false)
    assert.equal(observe([...successfulEvents(), stepEvent('extra', state)]).passed, false)
  }
})

test('a failed step cannot be erased by a later successful event with the same ID', () => {
  assert.equal(observe([stepEvent('typecheck', 'failure'), ...successfulEvents()]).passed, false)
})

function harness(mode, { ensure, checks, discussion, pull, merge } = {}) {
  const options = config(mode), current = pr(), counters = { ensure: 0, checks: 0, merged: 0, published: 0, saved: 0 }
  const github = {
    async pulls() { return [current] }, async pull() { return pull ? pull(current) : current },
    async snapshot() { return { context: {}, files: [{ filename: 'src/math.ts' }] } },
    async publish() { counters.published++; return 20 },
    async checks() { counters.checks++; return checks ? checks() : externalCi() },
    async reviews() { return [] }, async discussions() { return discussion ?? { threads: [], reviewDecision: null } },
    async files() { return [{ filename: 'src/math.ts' }] }, async baseIncluded() { return true },
    async merge(value) { counters.merged++; return merge ? merge(value) : { merged: true, sha: 'merged' } },
  }
  const localCi = { async ensure(value) { counters.ensure++; return ensure ? ensure(value) : localResult(options.localCi) } }
  const store = { data: { records: {} }, async save() { counters.saved++ } }
  const automation = new Automation({ config: options, github, localCi, store, signal: new AbortController().signal,
    available: async () => true, review: async () => ({ verdict: verdict() }) })
  return { automation, counters, store, current }
}

test('Automation local mode runs local CI and merges without reading external GitHub checks', async () => {
  const h = harness('local', { checks: () => { throw new Error('must not request GitHub CI in local mode') } })
  await h.automation.tick()
  assert.equal(h.counters.ensure, 1)
  assert.equal(h.counters.checks, 0)
  assert.equal(h.counters.merged, 1)
  assert.equal(h.automation.status.pulls[12].state, 'merged')
})

test('Automation github mode reads external checks and never executes local CI', async () => {
  const h = harness('github', { ensure: () => { throw new Error('must not execute local CI in github mode') } })
  await h.automation.tick()
  assert.equal(h.counters.ensure, 0)
  assert.equal(h.counters.checks, 1)
  assert.equal(h.counters.merged, 1)
})

test('Automation both mode merges only after both CI sources succeed', async () => {
  const good = harness('both'); await good.automation.tick()
  assert.equal(good.counters.ensure, 1); assert.equal(good.counters.checks, 1); assert.equal(good.counters.merged, 1)
  for (const override of [{ ensure: () => ({ ...localResult(), status: 'failure' }) },
    { checks: () => ({ checks: [], suites: [], statuses: [{ context: 'dsh/act', state: 'success' }] }) },
    { checks: () => ({ checks: [{ status: 'completed', conclusion: 'failure' }], suites: [], statuses: [] }) }]) {
    const h = harness('both', override); await h.automation.tick()
    assert.equal(h.counters.merged, 0)
    assert.equal(h.automation.status.pulls[12].state, 'waiting')
  }
})

test('Automation keeps required-review and blocked mergeability gates after successful local CI', async () => {
  const review = harness('local', { discussion: { threads: [], reviewDecision: 'REVIEW_REQUIRED' } })
  await review.automation.tick()
  assert.equal(review.counters.ensure, 1); assert.equal(review.counters.merged, 0)
  assert.match(review.automation.status.pulls[12].reasons.join(' '), /REVIEW_REQUIRED/)
  const blocked = harness('local'); blocked.current.mergeable_state = 'blocked'
  await blocked.automation.tick()
  assert.equal(blocked.counters.merged, 0)
})

test('Automation allows local unstable evidence but preserves GitHub server-side merge rejection', async () => {
  const h = harness('local', { merge: () => ({ merged: false, message: 'Branch protection requires review' }) })
  h.current.mergeable_state = 'unstable'
  await h.automation.tick()
  assert.equal(h.counters.ensure, 1)
  assert.equal(h.counters.merged, 1)
  assert.equal(h.automation.status.pulls[12].state, 'error')
  assert.match(h.automation.status.pulls[12].error, /Branch protection/)
  assert.equal(Object.values(h.store.data.records)[0].mergedAt, undefined)
})

test('Automation rechecks head/base after local CI instead of merging stale evidence', async () => {
  for (const field of ['head', 'base']) {
    const h = harness('local', { ensure: value => {
      const result = localResult()
      value[field] = { ...value[field], sha: `changed-${field}` }
      return result
    } })
    await h.automation.tick()
    assert.equal(h.counters.ensure, 1)
    assert.equal(h.counters.merged, 0)
    assert.equal(h.automation.status.pulls[12].state, 'waiting')
  }
})
