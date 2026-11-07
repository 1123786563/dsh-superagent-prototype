import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import type { Ticket } from '../src/core/index.ts'
import { PullMergeError } from '../src/sources/github-pull.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('serves the board with normalized query defaults, column paging, and an optional configured repository', async () => {
  const tickets: Ticket[] = Array.from({ length: 105 }, (_, index) => ({ id: `t${index.toString().padStart(3, '0')}`,
    title: index === 104 ? 'Needle' : 'Task', decisionId: 'd', channels: [], assignments: [], inputs: [], undelivered: [],
    createdAt: '2026-01-01', updatedAt: '2026-01-01', origin: { triggerId: 'e', triggerIds: ['e'] },
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' } }))
  let configured = false
  const call = serve({ store: { settings: () => SettingsSchema.parse({}), tickets: { list: () => [...tickets] },
    read: { subscribedThreads: () => [] } }, sources: { instances: () => [{ id: 'github' }], kind: () => undefined },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }), configured: () => configured,
    deployment: { repository: 'org/repo' } })
  const initial = await call('GET', 'board?offset=80')
  expect(initial.status).toBe(200)
  expect(initial.body).not.toHaveProperty('repository')
  expect(initial.body).toMatchObject({ total: 105, columns: [{ id: 'queued', total: 105, next_offset: 20 },
    { id: 'working', total: 0 }, { id: 'person', total: 0 }, { id: 'idle', total: 0 }, { id: 'ended', total: 0 }] })
  expect((await call('GET', 'board?column=queued&offset=100&limit=2')).body).toMatchObject({ columns: [
    { items: [{ id: 't100' }, { id: 't101' }], next_offset: 102 }, {}, {}, {}, {},
  ] })
  expect((await call('GET', 'board?limit=1000')).body).toMatchObject({ columns: [{ next_offset: 100 }, {}, {}, {}, {}] })
  expect((await call('GET', 'board?limit=bad&offset=-1&order=bad&column=bad')).body).toEqual(initial.body)
  expect((await call('GET', 'board?limit=0')).body).toEqual(initial.body)
  expect((await call('GET', 'board?q=needle&source=github&limit=1')).body).toMatchObject({ total: 1,
    columns: [{ total: 1, items: [{ id: 't104' }], next_offset: null }, {}, {}, {}, {}] })
  configured = true
  expect((await call('GET', 'board')).body.repository).toBe('org/repo')
  expect(await call('GET', 'board', undefined, { 'x-orchestrator-request': undefined }))
    .toMatchObject({ status: 403 })
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('exposes ticket PR merge as a user route and serializes stale merge conflicts as 409', async () => {
  const mergeTicket = vi.fn(async (id: string) => {
    if (id === 'stale') throw new PullMergeError('PR #42 is no longer ready to merge')
    return { merged: true as const, number: 42 }
  })
  const call = serve({ store: { tickets: { get: (id: string) => id === 't1' || id === 'stale' ? {} as Ticket : undefined } }, mergeTicket })
  expect(await call('POST', 'tickets/t1/merge')).toEqual({ status: 200, body: { merged: true, number: 42 } })
  expect(mergeTicket).toHaveBeenCalledOnce()
  expect(mergeTicket).toHaveBeenCalledWith('t1')
  expect(await call('POST', 'tickets/stale/merge')).toEqual({ status: 409, body: { error: 'PR #42 is no longer ready to merge' } })
  expect(await call('POST', 'tickets/missing/merge')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
