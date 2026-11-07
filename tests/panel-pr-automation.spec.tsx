// @vitest-environment jsdom
/** PR automation uses an isolated same-origin API; these tests never contact GitHub. */
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { all, at, click, field, find, mount, settle, text, type, usePanel } from './fixtures/panel.tsx'

usePanel()
const endpoint = '/pr-automation/api/settings'
const initial = () => ({ revision: 'r1', repository: 'acme/widgets', label: 'agent-review',
  value: { enabled: true, autoMerge: false, pollSeconds: 60,
    executionWindow: { enabled: false, timeZone: 'Asia/Shanghai', start: '09:00', end: '22:00' } },
  status: { phase: 'ready', lastError: null as string | null, lastPoll: '2026-11-07T00:00:00Z', nextPollAt: null as string | null,
    execution: { allowed: false, reason: 'outside-window', localTime: '08:00', timeZone: 'Asia/Shanghai' } } })
let current: ReturnType<typeof initial>
let requests: { method: string; init: RequestInit | undefined }[]
let getStatus: number
let putStatus: number
let pendingGet: Promise<void> | undefined
beforeEach(() => {
  current = initial(); requests = []; getStatus = 200; putStatus = 200; pendingGet = undefined
  const fallback = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== endpoint) return fallback(url, init)
    const method = init?.method ?? 'GET'
    requests.push({ method, init })
    if (method === 'GET') await pendingGet
    const status = method === 'GET' ? getStatus : putStatus
    if (status !== 200) return new Response('{}', { status })
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body))
      expect(body.revision).toBe(current.revision)
      current = { ...current, revision: 'r2', value: body.value }
    }
    return Response.json(current)
  }))
  at({ page: 'settings', query: { group: 'pr-automation' } })
})
const poll = () => field<HTMLInputElement>(zh['prAutomation.poll'])
const start = () => field<HTMLInputElement>(zh['prAutomation.start'])
const zone = () => field<HTMLInputElement>(zh['prAutomation.zone'])

it('routes to the bilingual group and loads actual runtime status, repository and label', async () => {
  current.status.nextPollAt = '2026-11-07T00:01:00Z'
  await mount()
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.pr-automation'])
  for (const value of ['acme/widgets', 'agent-review', zh['prAutomation.phase.ready'], '08:00',
    '08:00:00', '08:01:00']) expect(text()).toContain(value)
  expect(text()).not.toContain('outside-window')
  expect(text()).not.toContain(current.status.lastPoll)
  expect(all('[role="switch"]')).toHaveLength(3)
  expect(poll().value).toBe('60')
  expect(start().type).toBe('time')
  expect(start().disabled).toBe(true)
  expect(zone().disabled).toBe(true)
  expect(all('.dt-savebar')).toHaveLength(0)
  expect(requests[0]?.init?.headers).toEqual({ 'x-pr-automation-request': '1' })
  expect(requests[0]?.init?.credentials).toBe('same-origin')
})

it('keeps controls editable with automation off, saves revision and value, and restores current settings', async () => {
  await mount()
  await click(zh['prAutomation.enabled'])
  expect(poll().disabled).toBe(false)
  await click(zh['prAutomation.autoMerge'])
  await type(poll(), '120')
  await click(zh['prAutomation.window'])
  expect(zone().disabled).toBe(false)
  await type(start(), '22:00')
  await type(field<HTMLInputElement>(zh['prAutomation.end']), '09:00')
  await click(zh.save)
  expect(current.value).toEqual({ enabled: false, autoMerge: true, pollSeconds: 120,
    executionWindow: { enabled: true, timeZone: 'Asia/Shanghai', start: '22:00', end: '09:00' } })
  expect(requests.find(item => item.method === 'PUT')?.init?.headers).toEqual({
    'x-pr-automation-request': '1', 'Content-Type': 'application/json' })
  expect(all('.dt-savebar')).toHaveLength(0)
  expect(document.querySelector('[role="status"]')?.textContent).toBe(zh.saved)
  await type(poll(), '300')
  current = { ...current, revision: 'external', value: { ...current.value, pollSeconds: 180 } }
  await click(zh['prAutomation.restore'])
  expect(poll().value).toBe('180')
  expect(all('.dt-savebar')).toHaveLength(0)
})

it('validates interval, IANA zone and HH:mm window including equal times, and allows an overnight window', async () => {
  await mount()
  for (const invalid of ['', '59', '3601', '60.5']) {
    await type(poll(), invalid)
    expect(text()).toContain(zh['prAutomation.invalidPoll'])
    expect((find(zh.save) as HTMLButtonElement).disabled).toBe(true)
  }
  await type(poll(), '3600')
  await click(zh['prAutomation.window'])
  await type(zone(), 'Mars/Olympus')
  expect(text()).toContain(zh['prAutomation.invalidZone'])
  await type(zone(), 'America/New_York')
  await type(start(), '')
  expect(text()).toContain(zh['prAutomation.invalidTime'])
  await type(start(), '22:00')
  expect(text()).toContain(zh['prAutomation.equalTime'])
  await type(field<HTMLInputElement>(zh['prAutomation.end']), '06:00')
  expect((find(zh.save) as HTMLButtonElement).disabled).toBe(false)
  expect(requests.filter(item => item.method === 'PUT')).toHaveLength(0)
})

it('retains draft and revision on 409 and only replaces them after explicit restore', async () => {
  await mount()
  await type(poll(), '120')
  putStatus = 409
  await click(zh.save)
  expect(text()).toContain(zh['prAutomation.conflict'])
  expect(poll().value).toBe('120')
  expect(current.value.pollSeconds).toBe(60)
  current = { ...current, revision: 'external', value: { ...current.value, pollSeconds: 300 } }
  await click(zh['prAutomation.restore'])
  expect(poll().value).toBe('300')
  putStatus = 200
  await type(poll(), '180')
  await click(zh.save)
  expect(current.value.pollSeconds).toBe(180)
})

it('shows loading and unavailable API with retry, and retains edits when saving or restoring fails', async () => {
  let release!: () => void
  pendingGet = new Promise<void>(resolve => { release = resolve })
  await mount()
  expect(text()).toContain(zh.loading)
  getStatus = 404
  await act(async () => { release() }); await settle()
  expect(text()).toContain(zh['prAutomation.unavailable'])
  getStatus = 200
  await click(zh.retry)
  await type(poll(), '120')
  putStatus = 503
  await click(zh.save)
  expect(text()).toContain(zh['prAutomation.unavailable'])
  expect(poll().value).toBe('120')
  getStatus = 503
  await click(zh['prAutomation.restore'])
  expect(poll().value).toBe('120')
  getStatus = 200; putStatus = 200
  await click(zh.save)
  expect(current.value.pollSeconds).toBe(120)
})

it('refreshes only status every 15 seconds, preserves draft and baseline revision, prevents overlap and aborts on unmount', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    await mount()
    await type(poll(), '120')
    current = { ...current, revision: 'external', value: { ...current.value, pollSeconds: 300 },
      status: { ...current.status, phase: 'outside_window', nextPollAt: '2026-11-08T00:00:00Z' } }
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(text()).toContain(zh['prAutomation.phase.outside_window'])
    expect(text()).toContain('08:00:00')
    expect(poll().value).toBe('120')
    await type(poll(), '60')
    expect(all('.dt-savebar')).toHaveLength(0) // The original saved value is still the dirty baseline.
    await type(poll(), '120')
    putStatus = 409
    await click(zh.save)
    const put = requests.find(item => item.method === 'PUT')!
    expect(JSON.parse(String(put.init?.body)).revision).toBe('r1')
    expect(text()).toContain(zh['prAutomation.conflict'])
    expect(poll().value).toBe('120')

    let release!: () => void
    pendingGet = new Promise<void>(resolve => { release = resolve })
    const before = requests.filter(item => item.method === 'GET').length
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    const refreshing = requests.at(-1)!
    expect(requests.filter(item => item.method === 'GET')).toHaveLength(before + 1)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(requests.filter(item => item.method === 'GET')).toHaveLength(before + 1)
    await click(find(zh['tab.overview'], '[role="tab"]'))
    expect(refreshing.init?.signal?.aborted).toBe(true)
    await act(async () => { release() }); await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(requests.filter(item => item.method === 'GET')).toHaveLength(before + 1)
  } finally { vi.useRealTimers() }
})

it('translates runtime phases and recovers from background refresh errors without replacing edits', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    await mount(en)
    await type(field<HTMLInputElement>(en['prAutomation.poll']), '120')
    for (const phase of ['starting', 'ready', 'paused', 'disabled', 'outside_window', 'error', 'unavailable'] as const) {
      current.status.phase = phase
      current.status.execution.reason = 'allowed'
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      const runtime = document.querySelector('section[aria-label="Current runtime"]')!
      expect(runtime.textContent).toContain(en[`prAutomation.phase.${phase}`])
      expect(runtime.textContent).not.toContain(' · allowed')
    }
    current.status.phase = 'future_phase'
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(text()).toContain(en['prAutomation.phase.unavailable'])
    expect(text()).not.toContain('future_phase')
    getStatus = 503
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(text()).toContain(en['prAutomation.refreshFailed'])
    getStatus = 200
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(text()).not.toContain(en['prAutomation.refreshFailed'])
    expect(field<HTMLInputElement>(en['prAutomation.poll']).value).toBe('120')
  } finally { vi.useRealTimers() }
})

it('labels every input and switch in English and displays runtime errors', async () => {
  current.status.lastError = 'Polling failed'
  await mount(en)
  expect(text()).toContain('PR automation')
  expect(text()).toContain('Polling failed')
  for (const label of ['prAutomation.poll', 'prAutomation.zone', 'prAutomation.start', 'prAutomation.end'] as const) {
    expect(field<HTMLInputElement>(en[label])).toBeTruthy()
  }
  for (const label of ['prAutomation.enabled', 'prAutomation.autoMerge', 'prAutomation.window'] as const) {
    expect(find(en[label], '[role="switch"]').getAttribute('aria-label')).toBe(en[label])
  }
})
