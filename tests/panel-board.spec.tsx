// @vitest-environment jsdom
// Work board integration through the panel and management API.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en } from '../src/client/locales.ts'
import { HOME, initialLocation } from '../src/client/route.ts'
import { all, at, click, field, find, mount, remount, settle, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server, ticketSummary } from './fixtures/panel-server.ts'

usePanel()
const column = (id: string) => document.querySelector<HTMLElement>(`[data-column="${id}"]`)!
const titles = (id: string) => [...column(id).querySelectorAll('.dt-board-ticket-open')].map(item => item.textContent)
const boardRequests = () => server.requests.filter(request => request.path.startsWith('board'))
async function board() { at({ page: 'board' }); await mount(en) }
async function search(value: string) {
  const input = field<HTMLInputElement>(en['board.searchLabel'])
  await type(input, value)
  await act(async () => { input.closest('form')!.requestSubmit() })
  await settle()
}

it('shows five complete column counts while paging cards, with the vertical workspace navigation', async () => {
  server.tickets.open = [ticketSummary({ id: 'queued', title: 'Waiting assignment' }, { stage: 'working', action: 'queued' }),
    ticketSummary({ id: 'person', title: 'Please review' }, { stage: 'person', action: 'review' }),
    ticketSummary({ id: 'idle', title: 'Waiting event' }, { stage: 'idle' }),
    ...Array.from({ length: 23 }, (_, index) => ticketSummary({ id: `work-${index}`, title: `Working ${index}` }))]
  await board()
  expect(all('.dt-board-column').map(item => [item.getAttribute('aria-label'), item.querySelector('.dt-board-column-count')?.textContent]))
    .toEqual([['Queued', '1'], ['In progress', '23'], ['Needs attention', '1'], ['Waiting for events', '1'], ['Ended', '1']])
  expect(document.querySelector('.dt-board-total')?.textContent).toBe('27 tickets')
  expect(titles('working')).toHaveLength(20)
  expect(titles('queued')).toEqual(['Waiting assignment'])
  expect(document.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe('vertical')
  await act(async () => { tab('Board').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await settle()
  expect(tab('Overview').getAttribute('aria-selected')).toBe('true')
})

it('queries the server for search, source and sort across the complete ticket set, and remembers list view', async () => {
  const github = ticketSummary().threads
  const feishu = [{ key: 'feishu:room', source: 'feishu', title: 'Needle discussion', facts: {} }]
  server.tickets.open = [
    ...Array.from({ length: 22 }, (_, index) => ticketSummary({ id: `noise-${index}`, title: `Other ${index}`, threads: github })),
    ticketSummary({ id: 'older', title: 'Earlier created', threads: feishu, createdAt: '2026-01-01', updatedAt: '2026-09-25' }),
    ticketSummary({ id: 'newer', title: 'Later created', threads: feishu, createdAt: '2026-08-01', updatedAt: '2026-09-24' }),
  ]
  await board()
  await search('NEEDLE')
  expect(titles('working')).toEqual(['Earlier created', 'Later created'])
  expect(document.querySelector('.dt-board-total')?.textContent).toBe('2 tickets')
  await type(field<HTMLSelectElement>(en['board.source']), 'feishu')
  await type(field<HTMLSelectElement>(en['board.sort']), 'created')
  expect(titles('working')).toEqual(['Later created', 'Earlier created'])
  const query = new URL(boardRequests().at(-1)!.path, 'http://fixture').searchParams
  expect(Object.fromEntries(query)).toMatchObject({ q: 'NEEDLE', source: 'feishu', order: 'created' })
  await type(field<HTMLSelectElement>(en['board.sort']), 'oldest')
  expect(titles('working')).toEqual(['Earlier created', 'Later created'])
  await click(en['board.listView'])
  expect(find(en['board.listView']).getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('.dt-board-canvas')?.getAttribute('data-view')).toBe('list')
  await remount(en)
  expect(field<HTMLInputElement>(en['board.searchLabel']).value).toBe('NEEDLE')
  expect(field<HTMLSelectElement>(en['board.source']).value).toBe('feishu')
  expect(find(en['board.listView']).getAttribute('aria-pressed')).toBe('true')
  await type(field<HTMLSelectElement>(en['board.source']), 'github')
  expect(text()).toContain(en['board.noMatches'])
  await click(en['board.clear'])
  expect(document.querySelector('.dt-board-total')?.textContent).toBe('25 tickets')
})

it('restores collapsed cards and opens non-modal details without removing the card, then closes with Escape', async () => {
  await board()
  await click('Collapse In progress')
  expect(column('working').querySelector('ul')).toBeNull()
  expect(column('working').querySelector('.dt-board-column-count')?.textContent).toBe('1')
  await click('Expand In progress')
  const card = find('修复回归', '.dt-board-ticket-open')
  card.focus()
  await click(card)
  const drawer = document.querySelector('[role="dialog"]')!
  expect(drawer.getAttribute('aria-modal')).toBe('false')
  expect(drawer.textContent).toContain('修复回归')
  expect(card.isConnected).toBe(true)
  expect(card.getAttribute('aria-expanded')).toBe('true')
  expect(server.requests.some(request => request.path === 'tickets/t1')).toBe(true)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(card.isConnected).toBe(true)
  expect(document.activeElement).toBe(card)
  expect(card.getAttribute('aria-expanded')).toBe('false')
})

it('retries only after confirmation and refreshes both the detail and the board column', async () => {
  const failed = ticketSummary({ actions: { retry: true, stop: true }, note: { text: 'Worker failed', error: true } },
    { stage: 'person', action: 'failed' })
  server.tickets.open = [failed]
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, stage: 'person', action: 'failed', actions: { retry: true, stop: true },
    note: { text: 'Worker failed', error: true } }
  await board()
  await click(find('修复回归', '.dt-board-ticket-open'))
  await click(all('.dt-board-drawer button').find(button => button.textContent === 'Retry')!)
  expect(server.requests.some(request => request.path === 'tickets/t1/retry')).toBe(false)
  expect(document.querySelector('.dt-modal-root')?.textContent).toContain('修复回归')
  const reads = boardRequests().length
  await click(en.confirm)
  expect(server.requests.filter(request => request.path === 'tickets/t1/retry')).toEqual([{ path: 'tickets/t1/retry', method: 'POST' }])
  expect(boardRequests().length).toBeGreaterThan(reads)
  expect(titles('person')).toEqual([])
  expect(titles('queued')).toEqual(['修复回归'])
  expect(document.querySelector('.dt-board-drawer')?.textContent).not.toContain('Worker failed')
  expect(all('.dt-board-drawer button').some(button => button.textContent === 'Retry')).toBe(false)
  expect(server.requests.filter(request => request.path === 'tickets/t1')).toHaveLength(2)
})

it('offers accessible card action icons without opening details, and confirms retry before refreshing the board', async () => {
  server.tickets.open = [ticketSummary({ actions: { retry: true, stop: true }, note: { text: 'Worker failed', error: true } },
    { stage: 'person', action: 'failed' }), ticketSummary({ id: 'no-session', title: 'Not started', sessionId: undefined },
    { stage: 'working', action: 'queued' })]
  await board()
  const actions = column('person').querySelector('.dt-board-ticket-actions')!
  const session = actions.querySelector<HTMLButtonElement>('button[aria-label="Open Session"]')!
  const retry = actions.querySelector<HTMLButtonElement>('button[aria-label="Retry"]')!
  expect(session.title).toBe('Open Session')
  expect(retry.title).toBe('Retry')
  expect(session.textContent).toBe('')
  expect(column('queued').querySelector('.dt-board-ticket-actions')).toBeNull()
  await click(session)
  expect(server.opened).toEqual(['worker-t1'])
  expect(document.querySelector('.dt-board-drawer')).toBeNull()
  await click(retry)
  expect(document.querySelector('.dt-board-drawer')).toBeNull()
  expect(document.querySelector('.dt-modal-root')?.textContent).toContain('修复回归')
  expect(server.requests.some(request => request.path === 'tickets/t1/retry')).toBe(false)
  await click(en.cancel)
  expect(server.requests.some(request => request.path === 'tickets/t1/retry')).toBe(false)
  await click(retry)
  await click(en.confirm)
  expect(server.requests.filter(request => request.path === 'tickets/t1/retry')).toHaveLength(1)
  expect(titles('person')).toEqual([])
  expect(titles('queued')).toContain('修复回归')
  expect(document.querySelector('.dt-board-drawer')).toBeNull()
  await click(en['board.listView'])
  expect(document.querySelector('.dt-board-ticket-list button[aria-label="Open Session"]')).not.toBeNull()
})

it('confirms a PR merge with its repository and number, then refreshes without opening the drawer', async () => {
  server.tickets.open = [ticketSummary({ id: 't1', title: '修复回归', actions: { retry: false, stop: true, merge: 42 } },
    { stage: 'working' })]
  await board()
  const merge = find('Merge pull request', '.dt-board-ticket-actions button')
  await click(merge)
  expect(server.requests.some(request => request.path === 'tickets/t1/merge')).toBe(false)
  const dialog = document.querySelector('.dt-modal-root')!
  expect(dialog.textContent).toContain('acme/widgets')
  expect(dialog.textContent).toContain('#42')
  expect(dialog.textContent).toContain('修复回归')
  await click(en.confirm)
  expect(server.requests.filter(request => request.path === 'tickets/t1/merge')).toEqual([{ path: 'tickets/t1/merge', method: 'POST' }])
  expect(boardRequests().length).toBeGreaterThan(1)
  expect(document.querySelector('.dt-board-drawer')).toBeNull()
})

it('reloads requested prefixes when tickets move columns, without duplicates or missing loaded cards', async () => {
  server.tickets.open = Array.from({ length: 45 }, (_, index) => ticketSummary({ id: `work-${String(index).padStart(2, '0')}`,
    title: `Task ${index}` }))
  await board()
  await click(column('working').querySelector<HTMLElement>('.dt-board-more')!)
  expect(titles('working')).toHaveLength(40)
  expect(new Set(titles('working')).size).toBe(40)
  const moved = server.tickets.open[0]!
  server.tickets.open[0] = { ...moved, stage: 'person', action: 'review' }
  await click(en['board.refresh'])
  expect(titles('person')).toEqual(['Task 0'])
  expect(titles('working')).toHaveLength(40)
  expect(titles('working')).not.toContain('Task 0')
  await click(column('working').querySelector<HTMLElement>('.dt-board-more')!)
  const cards = all('.dt-board-ticket-open').map(item => item.textContent)
  expect(cards).toHaveLength(46) // 45 open and one ended Ticket
  expect(new Set(cards).size).toBe(46)
  expect(column('working').querySelector('.dt-board-more')).toBeNull()
})

it('distinguishes an empty board from no matches and offers the corresponding recovery', async () => {
  server.tickets = { open: [], ended: [] }
  await board()
  expect(text()).toContain(en['board.noTickets'])
  expect(all('.dt-board-column')).toHaveLength(5)
  expect(document.querySelector('.dt-board-total')?.textContent).toBe('0 tickets')
  await click(en['board.openSources'])
  expect(tab('Source').getAttribute('aria-selected')).toBe('true')
})

it('retains legacy execution routes while the product home remains Board', async () => {
  expect(HOME).toEqual({ page: 'board' })
  expect(initialLocation().route).toEqual({ page: 'board' })
  at({ page: 'execution', id: 't1' })
  await mount(en)
  expect(tab('Execution').getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  expect(document.querySelector('.dt-board-drawer')).toBeNull()
  await remount(en)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})
