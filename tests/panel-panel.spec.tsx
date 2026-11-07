// @vitest-environment jsdom
// Panel search, glossary, route persistence, and host-down fallback.
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, at, click, find, type, text, field } from './fixtures/panel.tsx'
import { server, found } from './fixtures/panel-server.ts'

usePanel()
it('states why a filtered search result has no Thread instead of opening an empty one', async () => {
  server.search = { items: [found('e9', '2026-09-20T00:00:00Z', { source: 'github', actor: { source: 'github', id: 'someone' },
    preview: 'issue text', threads: ['github:7'],
    filtered: 'source_disabled' })], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'issue')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('被来源过滤：来源已停用')
  expect(all('.dt-search-results button').some(button => button.textContent === 'issue text')).toBe(false)
})

it('opens a search result older than the newest page around its Trigger', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z')], threads: [] }
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'message')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('找到 0 个工单、0 个线程、1 条触发')
  await click(all('.dt-search-results button').find(button => button.textContent === 'message e1')!)
  expect(server.requests.some(request => request.path.includes('around=e1'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e1')
})

it('explains what can be searched when nothing matches', async () => {
  await mount()
  await type(field<HTMLInputElement>(zh.searchLabel), 'nothing')
  await act(async () => { field<HTMLInputElement>(zh.searchLabel).closest('form')!.requestSubmit() }); await settle()
  expect(text()).toContain('没有找到。可以输入触发文字')
})

it('returns to the exact page after a remount of the main panel', async () => {
  await mount()
  await click('修复回归')
  await remount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it.each([false, true])('explains Issue closure on detail merge (retry=%s) and preserves icon-and-text actions', async retry => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, actions: { retry: false, stop: true, merge: 42, mergeIssue: 7,
    ...retry ? { mergeRetry: true as const } : {} } }
  const fallback = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const response = await fallback(url, init)
    if (!url.endsWith('/tickets/t1/merge')) return response
    const body = JSON.parse(await response.text())
    return Response.json({ ...body, closedIssue: 7 })
  })
  at({ page: 'execution', id: 't1' })
  await mount()
  const label = retry ? zh.mergePullRetry : zh.mergePull
  const button = find(label, '.dt-page-title button')
  expect(button.textContent).toBe(label)
  expect(button.querySelector('svg')).not.toBeNull()
  await click(button)
  const dialog = document.querySelector('.dt-modal-root')!
  for (const value of ['PR #42', 'Issue #7', 'acme/widgets', '修复回归']) expect(dialog.textContent).toContain(value)
  if (retry) expect(dialog.textContent).toContain('只补关 Issue，不会重复合并')
  expect(server.requests.some(request => request.path === 'tickets/t1/merge')).toBe(false)
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe('PR #42 已合并，Issue #7 已关闭')
  expect(server.requests.filter(request => request.path === 'tickets/t1/merge')).toHaveLength(1)
  expect(server.requests.filter(request => request.path === 'tickets/t1')).toHaveLength(2)
})

it('keeps the original merge confirmation without an Issue and reports only the returned merge result', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, actions: { retry: false, stop: true, merge: 42 } }
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(find(zh.mergePull, '.dt-page-title button'))
  expect(document.querySelector('.dt-modal-description')?.textContent).toBe(
    '将把 acme/widgets 的 PR #42（“修复回归”）立即合并到默认分支。此操作会改变 GitHub 仓库。')
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe('PR #42 已合并')
})

it('shows domain terms in the interface language only and lists both languages in the (?) glossary', async () => {
  await mount(en)
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['Board', 'Overview', 'Source', 'Trigger', 'Eval', 'Execution', 'Settings'])
  await click('Glossary')
  const dialog = document.querySelector('[role="dialog"]')!
  const row = [...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Ticket'))!
  expect([...row.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['Ticket', '工单', 'An authorized unit of work'])
  expect(dialog.textContent).toContain('Accept 接单')
  // Terms are grouped the way the tabs follow the flow, after the roles that act in it.
  expect([...dialog.querySelectorAll('th.dt-glossary-group')].map(cell => cell.textContent)).toEqual(['Roles', 'Source', 'Trigger', 'Eval',
    'Execution'])
  expect([...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Main Session'))!.textContent).toContain('prompts call it the orchestrator')
})

it('says dsh-superagent is not answering when its routes are gone, as while it restarts', async () => {
  server.down = true
  await mount()
  expect(text()).toContain(zh.hostNotRunning)
  expect(text()).not.toContain('404')
})

it('closes search results on Escape and on a click outside the search', async () => {
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  const submit = async () => { await type(search,
    'nothing'); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  await submit()
  expect(document.querySelector('.dt-search-results')).not.toBeNull()
  await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
  await submit()
  await act(async () => { document.querySelector('main')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
})

it('shows the answer to the latest search only', async () => {
  server.search = { items: [found('e1', '2026-09-20T00:00:00Z', { preview: 'old message' }), found('e2', '2026-09-21T00:00:00Z',
    { preview: 'new message' })], threads: [] }
  let release = () => {}
  server.searching = async query => { if (query === 'old') await new Promise<void>(resolve => { release = resolve }) }
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  for (const query of ['old', 'new']) { await type(search,
    query); await act(async () => { search.closest('form')!.requestSubmit() }); await settle() }
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
  await act(async () => { release() }); await settle()
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
})
