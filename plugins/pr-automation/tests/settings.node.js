import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { PrSettings, settingsHandler, validateSettings } from '../settings.js'

function fixture() {
  const entry = { options: { id: 'dsh-pr-automation', name: '@local/dsh-pr-automation', config: {
    repository: 'owner/repo', stateDir: '/fixture', cli: '/fixture/gh-agent', enabled: true, autoMerge: true, pollSeconds: 60,
    executionWindow: { enabled: false, timeZone: 'Asia/Shanghai', start: '09:00', end: '22:00' },
    provider: 'fixture', model: 'fixture', localCi: { sourceDirectory: '/source', runnerImage: 'immutable-image', jobs: [] },
  } } }
  let writes = 0
  const editor = { entries: () => [entry], async edit(current, change) {
    assert.equal(current, entry); const next = change(structuredClone(entry.options.config), {})
    entry.options.config = next; writes++
  } }
  const settings = new PrSettings({ editor, entryId: entry.options.id, status: async () => ({
    phase: entry.options.config.enabled ? 'ready' : 'disabled', lastPoll: null, lastError: null, nextPollAt: null,
  }) })
  return { settings, entry, editor, writes: () => writes }
}
async function request(f, method, body, headers = {}) {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}))])
  req.method = method
  req.headers = { host: '127.0.0.1:3200', 'x-pr-automation-request': '1',
    ...method === 'PUT' ? { origin: 'http://127.0.0.1:3200', 'content-type': 'application/json' } : {}, ...headers }
  let code, data, responseHeaders
  await settingsHandler({ settings: f.settings, origin: 'http://127.0.0.1:3200', logger: { error() {} } })(req,
    { writeHead(value, headers) { code = value; responseHeaders = headers }, end(value) { data = value } })
  return { code, data: data ? JSON.parse(data) : null, headers: responseHeaders }
}

test('GET returns only editable values, a version and runtime state', async () => {
  const f = fixture(), result = await request(f, 'GET')
  assert.equal(result.code, 200); assert.equal(result.data.repository, 'owner/repo')
  assert.equal(result.data.value.pollSeconds, 60); assert.equal(result.data.status.phase, 'ready')
  assert.match(result.data.revision, /^[a-f0-9]{64}$/)
  assert.equal(result.data.value.cli, undefined); assert.equal(result.data.value.localCi, undefined)
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(f.writes(), 0)
})

test('PUT persists settings, changes revision, and preserves all unrelated machine configuration', async () => {
  const f = fixture(), before = structuredClone(f.entry.options.config), loaded = await f.settings.read()
  const value = { ...loaded.value, enabled: false, pollSeconds: 300, executionWindow: {
    enabled: true, timeZone: 'Asia/Shanghai', start: '22:00', end: '06:00' } }
  const result = await request(f, 'PUT', { revision: loaded.revision, value })
  assert.equal(result.code, 200); assert.deepEqual(result.data.value, value)
  assert.notEqual(result.data.revision, loaded.revision); assert.equal(result.data.status.phase, 'disabled')
  for (const key of ['repository', 'stateDir', 'cli', 'provider', 'model', 'localCi']) assert.deepEqual(f.entry.options.config[key], before[key])
  assert.equal(f.writes(), 1)
  const reread = await f.settings.read(); assert.deepEqual(reread.value, value)
})

test('unrelated Loader expressions survive without being evaluated by the settings adapter', async () => {
  const f = fixture(), expression = { __jsExpr: 'process.env.GH_AGENT_PATH' }
  f.entry.options.config.cli = expression
  const loaded = await f.settings.read()
  const result = await request(f, 'PUT', { revision: loaded.revision, value: { ...loaded.value, pollSeconds: 120 } })
  assert.equal(result.code, 200); assert.deepEqual(f.entry.options.config.cli, expression)
  assert.equal(result.data.value.cli, undefined)
})

test('stale versions return 409 without overwriting an external update', async () => {
  const f = fixture(), loaded = await f.settings.read()
  f.entry.options.config.pollSeconds = 120
  const result = await request(f, 'PUT', { revision: loaded.revision, value: { ...loaded.value, pollSeconds: 300 } })
  assert.equal(result.code, 409); assert.equal(f.entry.options.config.pollSeconds, 120); assert.equal(f.writes(), 0)
})

test('the serialized editor callback checks the current revision after entering its lock', async () => {
  const f = fixture(), loaded = await f.settings.read(), edit = f.editor.edit
  f.editor.edit = async (...args) => { f.entry.options.config.localCi.runnerImage = 'changed-elsewhere'; return edit(...args) }
  const result = await request(f, 'PUT', { revision: loaded.revision, value: loaded.value })
  assert.equal(result.code, 409); assert.equal(f.entry.options.config.localCi.runnerImage, 'changed-elsewhere')
  assert.equal(f.writes(), 0)
})

test('invalid switches, polling bounds, timezones and time ranges never invoke persistence', async () => {
  const f = fixture(), loaded = await f.settings.read(), value = loaded.value
  const invalid = [ { ...value, enabled: 'false' }, { ...value, autoMerge: null },
    ...[0, 59, 3601, 60.5, '60'].map(pollSeconds => ({ ...value, pollSeconds })),
    { ...value, executionWindow: { ...value.executionWindow, timeZone: 'Not/AZone' } },
    { ...value, executionWindow: { ...value.executionWindow, start: '24:00' } },
    { ...value, executionWindow: { ...value.executionWindow, enabled: true, start: '09:00', end: '09:00' } } ]
  for (const candidate of invalid) assert.equal((await request(f, 'PUT', { revision: loaded.revision, value: candidate })).code, 400)
  assert.equal(f.writes(), 0)
})

test('settings API cannot change repository, CLI, runner or arbitrary nested fields', async () => {
  const f = fixture(), loaded = await f.settings.read()
  for (const value of [{ ...loaded.value, repository: 'evil/repo' }, { ...loaded.value, cli: '/evil' },
    { ...loaded.value, localCi: {} }, { ...loaded.value, executionWindow: { ...loaded.value.executionWindow, unknown: true } }, {}]) {
    assert.equal((await request(f, 'PUT', { revision: loaded.revision, value })).code, 400)
  }
  assert.equal(f.writes(), 0)
})

test('mutations require an exact loopback Host, same origin, custom header and JSON', async () => {
  const f = fixture(), loaded = await f.settings.read(), body = { revision: loaded.revision, value: loaded.value }
  for (const headers of [{ origin: 'https://evil.example' }, { origin: undefined }, { host: 'evil.example:3200' },
    { 'x-pr-automation-request': undefined }, { host: 'localhost:3200' }]) {
    assert.equal((await request(f, 'PUT', body, headers)).code, 403)
  }
  assert.equal((await request(f, 'PUT', body, { 'content-type': 'text/plain' })).code, 415)
  assert.equal((await request(f, 'POST', body)).code, 405)
  assert.equal(f.writes(), 0)
})

test('malformed or oversized JSON and missing revisions produce explicit failures', async () => {
  const f = fixture()
  assert.equal((await request(f, 'PUT', '{')).code, 400)
  assert.equal((await request(f, 'PUT', ' '.repeat(16385))).code, 413)
  assert.equal((await request(f, 'PUT', {})).code, 400)
  assert.equal(f.writes(), 0)
})

test('missing plugin and persistence errors are surfaced without reporting a save', async () => {
  const f = fixture(), loaded = await f.settings.read()
  f.editor.edit = async () => { throw new Error('unavailable') }
  const failed = await request(f, 'PUT', { revision: loaded.revision, value: loaded.value })
  assert.equal(failed.code, 503); assert.equal(f.writes(), 0)
  f.editor.entries = () => []
  assert.equal((await request(f, 'GET')).code, 404)
})

test('validated form values are detached from caller-owned objects', async () => {
  const { value } = await fixture().settings.read(), copy = validateSettings(value)
  copy.executionWindow.start = '10:00'
  assert.equal(value.executionWindow.start, '09:00')
})
