import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BOARD_COLUMNS } from '../src/app/board.ts'
import { Store } from '../src/app/store.ts'
import { board } from '../src/app/views/board.ts'
import { ticketRow } from '../src/app/views/tickets.ts'
import { snapshot } from '../src/app/views/records.ts'
import type { Assignment, ReportState, Ticket, TicketOutcome } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'

let directory: string
let store: Store
let sources: SourceRegistry
const at = '2026-01-01T00:00:00Z'
const links = () => ({ url: '', label: { zh: '', en: '' } })
const host = () => ({ store, sources, links })
const assignment = (state?: ReportState): Assignment => ({ id: 'a', state: 'running', createdAt: at, startedAt: at,
  ...state ? { report: { state, summary: `Report ${state}`, at } } : {} })
function save(id: string, overrides: Partial<Ticket> = {}) {
  const ticket: Ticket = { id, title: id, decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
    origin: { triggerId: 'e', triggerIds: ['e'] }, assignments: [], inputs: [], ...overrides }
  store.tickets.save(ticket)
  return ticket
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-board-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  sources = new SourceRegistry(() => store.settings())
  sources.register(githubKind)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('groups every stage and person action once, preserving ended outcomes and the existing row projection', () => {
  save('queued')
  save('pending', { assignments: [{ id: 'a', state: 'pending', createdAt: at }] })
  save('running', { assignments: [assignment()] })
  save('progress', { assignments: [assignment('progress')] })
  save('answered', { assignments: [assignment('failed')], inputs: [{ id: 'i', kind: 'trigger', triggerId: 'e',
    at: '2026-01-02T00:00:00Z', human: true }] })
  save('answer', { attention: { id: 'q', question: 'Which design?' } })
  save('delivery', { delivery: { error: 'Offline', at } })
  for (const state of ['ready', 'blocked', 'failed'] as const) save(state, { assignments: [assignment(state)] })
  save('waiting', { assignments: [assignment('waiting')] })
  save('turn-ended', { assignments: [{ id: 'a', state: 'ended', createdAt: at }] })
  const outcomes: TicketOutcome[] = ['completed', 'merged', 'closed', 'dropped', 'stopped']
  for (const outcome of outcomes) save(outcome, { ended: { at, by: 'executor', outcome }, attention: { id: 'q', question: '?' },
    assignments: [assignment('failed')] })
  const reads = vi.spyOn(store.tickets, 'list')
  const result = board(host())
  expect(reads).toHaveBeenCalledOnce()
  expect(result.columns.map(column => [column.id, column.total])).toEqual([
    ['queued', 2], ['working', 3], ['person', 5], ['idle', 2], ['ended', 5],
  ])
  expect(result.total).toBe(17)
  expect(result.columns.flatMap(column => column.items).map(row => row.id).sort())
    .toEqual(store.tickets.list().map(ticket => ticket.id).sort())
  const person = result.columns.find(column => column.id === 'person')!
  expect(person.items.map(row => row.stage === 'person' ? row.action : undefined).sort()).toEqual(['answer', 'blocked', 'delivery', 'failed', 'review'])
  expect(person.items.find(row => row.id === 'failed')?.note).toEqual({ text: 'Report failed', error: true })
  expect(result.columns.find(column => column.id === 'ended')!.items.map(row => row.ended!.outcome).sort()).toEqual([...outcomes].sort())
  expect(person.items.find(row => row.id === 'answer')).toEqual(ticketRow(snapshot(host()), store.tickets.get('answer')!))
})

it('filters the full set before paging and keeps all source choices even under combined filters', () => {
  for (let i = 0; i < 25; i++) save(`a${i.toString().padStart(2, '0')}`)
  const target = save('z-target', { title: 'Fix rendering' })
  store.threads.save({ key: 'chat:topic', ref: { source: 'chat', id: 'topic' }, createdAt: at, subscriptions: [target.id],
    pending: [], correlated: [], meta: { label: 'Screen reader', url: 'https://example.com/issues/42', facts: { number: 42 } } })
  save('removed-source', { mandate: { ...target.mandate, actor: { source: 'removed', id: 'a' } } })
  for (const q of ['rendering', 'Z-TARGET', ' SCREEN READER ', 'issues/42', '42']) {
    const result = board(host(), { q, source: 'chat', limit: 1 })
    expect(result.total).toBe(1)
    expect(result.columns[0]).toMatchObject({ total: 1, items: [{ id: target.id }], next_offset: null })
    expect(result.sources).toEqual([
      { id: 'chat', title: { zh: 'chat', en: 'chat' } }, { id: 'github', title: githubKind.title },
      { id: 'removed', title: { zh: 'removed', en: 'removed' } },
    ])
  }
  expect(board(host(), { source: 'removed' }).total).toBe(1)
  expect(board(host(), { source: 'unknown' }).total).toBe(0)
  expect(board(host(), { q: 'nonexistent' }).columns.map(column => column.total)).toEqual([0, 0, 0, 0, 0])
})

it('pages each column independently with accurate counts, default limit, cap, and empty pages', () => {
  for (let i = 0; i < 105; i++) save(`q${i.toString().padStart(3, '0')}`)
  for (let i = 0; i < 3; i++) save(`w${i}`, { assignments: [assignment()] })
  const initial = board(host(), { offset: 80 })
  expect(initial.columns.map(column => column.id)).toEqual(BOARD_COLUMNS)
  expect(initial.columns[0]).toMatchObject({ total: 105, next_offset: 20 })
  expect(initial.columns[0]!.items).toHaveLength(20)
  expect(initial.columns[0]!.items[0]!.id).toBe('q000')
  const next = board(host(), { column: 'queued', offset: 100, limit: 2 })
  expect(next.total).toBe(108)
  expect(next.columns[0]).toMatchObject({ total: 105, items: [{ id: 'q100' }, { id: 'q101' }], next_offset: 102 })
  expect(next.columns[1]).toMatchObject({ total: 3, items: [{ id: 'w0' }, { id: 'w1' }], next_offset: 2 })
  expect(board(host(), { limit: 1000 }).columns[0]!.items).toHaveLength(100)
  expect(board(host(), { column: 'queued', offset: 104 }).columns[0]).toMatchObject({ total: 105,
    items: [{ id: 'q104' }], next_offset: null })
  expect(board(host(), { column: 'queued', offset: 999 }).columns[0]).toMatchObject({ total: 105, items: [], next_offset: null })
})

it('sorts by updated descending by default, created descending, or created ascending, with stable id ties', () => {
  save('b', { createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' })
  save('a', { createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' })
  save('c', { createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
  const ids = (query: Parameters<typeof board>[1]) => board(host(), query).columns[0]!.items.map(row => row.id)
  expect(ids({})).toEqual(['a', 'b', 'c'])
  expect(ids({ order: 'updated' })).toEqual(['a', 'b', 'c'])
  expect(ids({ order: 'created' })).toEqual(['c', 'a', 'b'])
  expect(ids({ order: 'oldest' })).toEqual(['a', 'b', 'c'])
})
