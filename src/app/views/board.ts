/** Read-only board projection: filter the complete ticket snapshot before grouping and paging each column. */
import type { Ticket } from '../../core/index.ts'
import type { Localized } from '../../sources/kind.ts'
import { BOARD_COLUMNS, type BoardColumnId, type BoardQuery } from '../board.ts'
import { page, snapshot, type ViewHost } from './records.ts'
import { ticketRow } from './tickets.ts'

export type TicketRow = ReturnType<typeof ticketRow>
export interface BoardView {
  columns: { id: BoardColumnId; total: number; items: TicketRow[]; next_offset: number | null }[]
  total: number
  sources: { id: string; title: Localized }[]
  repository?: string
}

export function board(host: ViewHost, query: BoardQuery = {}): BoardView {
  const view = snapshot(host)
  const tickets = view.store.tickets.list()
  const sourceIds = new Set(host.sources.instances().map(instance => instance.id))
  const grouped = new Map<BoardColumnId, TicketRow[]>(BOARD_COLUMNS.map(id => [id, []]))
  const term = query.q?.trim().toLowerCase() ?? ''
  const source = query.source?.trim() ?? ''
  const order = query.order ?? 'updated'
  const timestamp = (ticket: Ticket) => order === 'updated' ? ticket.updatedAt : ticket.createdAt
  tickets.sort((a, b) => (order === 'oldest' ? timestamp(a).localeCompare(timestamp(b))
    : timestamp(b).localeCompare(timestamp(a))) || a.id.localeCompare(b.id))
  for (const ticket of tickets) {
    const row = ticketRow(view, ticket)
    const associated = [ticket.mandate.actor.source, ...row.threads.map(thread => thread.source)]
    for (const id of associated) sourceIds.add(id)
    if (source && !associated.includes(source)) continue
    if (term && ![row.id, row.title, ...row.threads.flatMap(thread => [thread.key, thread.title, thread.url ?? '',
      JSON.stringify(thread.facts)])].some(text => text.toLowerCase().includes(term))) continue
    const column = row.stage === 'working' && row.action === 'queued' ? 'queued' : row.stage
    grouped.get(column)!.push(row)
  }
  const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 20)))
  const offset = Math.max(0, Math.trunc(query.offset ?? 0))
  const columns = BOARD_COLUMNS.map(id => ({ id, ...page(grouped.get(id)!, query.column === id ? offset : 0, limit) }))
  const sources = [...sourceIds].sort().map(id => ({ id, title: host.sources.kind(id)?.title ?? { zh: id, en: id } }))
  return { columns, total: columns.reduce((sum, column) => sum + column.total, 0), sources }
}
