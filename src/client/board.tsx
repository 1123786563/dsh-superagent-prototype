/** Real Ticket board and list, with server-side filtering, complete column counts, and non-modal side details. */
import { useEffect, useRef, useState } from 'react'
import { BOARD_COLUMNS, type BoardColumnId, type BoardOrder } from '../app/board.ts'
import { usePoll, type Call, type TicketRow } from './api.ts'
import { Button, Icon, Input, type IconName } from './controls.tsx'
import { ticketMark } from './marks.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import type { BoardRouteQuery, Route } from './route.ts'
import { ThreadChip } from './rows.tsx'
import { TicketPage } from './ticket.tsx'
import { localized, readableMarkers } from './text.ts'
import { ConfirmButton, LoadState, SessionButton, StageMark, When } from './widgets.tsx'

type BoardView = Awaited<ReturnType<typeof readWindow>>
type Windows = Record<BoardColumnId, number>
const initialWindows = (): Windows => ({ queued: 20, working: 20, person: 20, idle: 20, ended: 20 })
const columnIcons: Record<BoardColumnId, IconName> = { queued: 'queue', working: 'running', person: 'ask', idle: 'clock', ended: 'decision' }
const columnOf = (ticket: TicketRow): BoardColumnId => ticket.stage === 'working' && ticket.action === 'queued' ? 'queued' : ticket.stage

/** Re-read each requested prefix on refresh instead of appending stale pages after Tickets move between columns. */
async function readWindow(call: Call, query: Pick<BoardRouteQuery, 'q' | 'source' | 'order'>, windows: Windows) {
  const limit = Math.min(100, Math.max(...Object.values(windows)))
  const view = await call('GET board', { query: { ...query, limit } })
  await Promise.all(view.columns.map(async column => {
    const wanted = windows[column.id]
    let next = column.next_offset
    while (next !== null && column.items.length < wanted) {
      const page = await call('GET board', { query: { ...query, column: column.id, offset: next, limit: Math.min(100, wanted - next) } })
      const more = page.columns.find(item => item.id === column.id)!
      column.items.push(...more.items)
      column.total = more.total
      next = more.next_offset
    }
    const seen = new Set<string>()
    column.items = column.items.filter(ticket => {
      if (columnOf(ticket) !== column.id || seen.has(ticket.id)) return false
      seen.add(ticket.id); return true
    }).slice(0, wanted)
    column.next_offset = column.items.length < column.total ? column.items.length : null
  }))
  return view
}

function ViewSwitch({ value, onChange }: { value: 'board' | 'list'; onChange: (value: 'board' | 'list') => void }) {
  const { t } = usePanel()
  return <div className="dt-board-view-switch" role="group" aria-label={t('board.views')}>
    {(['board', 'list'] as const).map(view => <button key={view} type="button" aria-pressed={value === view}
      aria-label={t(view === 'board' ? 'board.boardView' : 'board.listView')} title={t(view === 'board' ? 'board.boardView' : 'board.listView')}
      onClick={() => onChange(view)}><Icon name={view} size={16} /></button>)}
  </div>
}

function TicketCard({ ticket, repository, selected, onOpen, onChanged, list = false }: {
  ticket: TicketRow; repository?: string; selected: boolean; onOpen: () => void; onChanged: () => Promise<unknown>; list?: boolean
}) {
  const { t, call } = usePanel()
  const mark = ticketMark(t, ticket)
  return <li className={`dt-board-ticket${list ? ' dt-board-ticket-list' : ''}`} data-selected={selected || undefined}>
    <div className="dt-board-ticket-meta"><span className="dt-board-ticket-id" title={ticket.id}>{ticket.id.slice(-8)}</span>
      <StageMark state={mark.dot} icon={mark.icon} label={mark.label} /></div>
    <button type="button" className="dt-board-ticket-open" onClick={onOpen} aria-haspopup="dialog" aria-expanded={selected}>
      {ticket.title}</button>
    {ticket.note && <p className="dt-board-ticket-note" data-error={ticket.note.error || undefined}>
      {readableMarkers(t, ticket.note.text)}</p>}
    <div className="dt-board-ticket-links">{ticket.threads.slice(0, 2).map(thread => <ThreadChip key={thread.key} thread={thread} />)}
      {ticket.threads.length > 2 && <span className="dt-board-ticket-extra">+{ticket.threads.length - 2}</span>}</div>
    <div className="dt-board-ticket-foot"><span><Icon name="clock" size={12} /><When at={ticket.updatedAt} /></span>
      {ticket.undelivered > 0 && <span title={t('ticketUndeliveredLabel')}><Icon name="inbox" size={13} />{ticket.undelivered}</span>}
      {(ticket.actions.retry || ticket.actions.merge || ticket.sessionId) && <div className="dt-board-ticket-actions">
        {ticket.actions.retry && <ConfirmButton iconOnly icon="refresh" label={t('retry')} title={t('retryTitle')}
          message={t('retryConfirm', { title: ticket.title })}
          onConfirm={async () => { await call('POST tickets/:id/retry', { id: ticket.id }); await onChanged() }} />}
        {ticket.actions.merge && <ConfirmButton iconOnly icon="pull" label={t('mergePull')} title={t('mergePullTitle')}
          message={t('mergePullConfirm', { number: ticket.actions.merge, repository: repository ?? t('board.repository'), title: ticket.title })}
          onConfirm={async () => { await call('POST tickets/:id/merge', { id: ticket.id }); await onChanged() }} />}
        {ticket.sessionId && <SessionButton iconOnly sessionId={ticket.sessionId} />}
      </div>}</div>
  </li>
}

function BoardColumn({ column, repository, collapsed, list, selected, onToggle, onOpen, onMore, onChanged, loading }: {
  column: BoardView['columns'][number]; repository?: string; collapsed: boolean; list: boolean; selected?: string; onToggle: () => void
  onOpen: (id: string) => void; onMore: () => void; onChanged: () => Promise<unknown>; loading: boolean
}) {
  const { t } = usePanel()
  const label = t(`board.${column.id}`)
  return <section className="dt-board-column" data-column={column.id} data-collapsed={collapsed || undefined} aria-label={label}>
    <header className="dt-board-column-head"><span className="dt-board-column-symbol"><Icon name={columnIcons[column.id]} size={16} /></span>
      <h3>{label}</h3><span className="dt-board-column-count">{column.total}</span>
      <button type="button" className="dt-board-column-toggle" aria-label={t(collapsed ? 'board.expand' : 'board.collapse', { column: label })}
        aria-expanded={!collapsed} onClick={onToggle}><Icon name={collapsed ? 'chevron-right' : 'fold'} size={14} /></button></header>
    {!collapsed && <div className="dt-board-column-body" id={`dt-board-${column.id}`}>
      {column.items.length ? <ul className="dt-board-tickets">{column.items.map(ticket => <TicketCard key={ticket.id}
        ticket={ticket} repository={repository} selected={selected === ticket.id} onOpen={() => onOpen(ticket.id)} onChanged={onChanged} list={list} />)}</ul>
        : <div className="dt-board-column-empty"><Icon name={columnIcons[column.id]} size={20} /><p>{t(`board.empty.${column.id}`)}</p></div>}
      {column.next_offset !== null && <Button className="dt-board-more" variant="outline" size="sm" disabled={loading} onClick={onMore}>
        {t('board.more', { shown: column.items.length, total: column.total })}</Button>}
    </div>}
  </section>
}

function TicketDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const { t, navigate } = usePanel()
  const close = useRef(onClose)
  close.current = onClose
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    closeButton.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.dt-modal-root')) { event.preventDefault(); close.current() }
    }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape); if (opener?.isConnected) opener.focus() }
  }, [])
  return <aside className="dt-board-drawer" role="dialog" aria-modal="false" aria-label={t('board.details')}>
    <header className="dt-board-drawer-head"><span><Icon name="review" size={15} />{t('board.details')}</span>
      <div><Button size="sm" icon={<Icon name="external" size={14} />} aria-label={t('board.fullDetails')}
        title={t('board.fullDetails')} onClick={() => navigate({ page: 'execution', id })} />
        <button ref={closeButton} type="button" className="dt-board-drawer-close" aria-label={t('close')} onClick={onClose}>
          <Icon name="close" size={16} /></button></div></header>
    <div className="dt-board-drawer-body"><TicketPage key={id} id={id} embedded onChanged={onChanged} /></div>
  </aside>
}

function EmptyBoard({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  const { t, navigate } = usePanel()
  return <div className="dt-board-empty" role="status"><span className="dt-board-empty-icon"><Icon name={filtered ? 'search' : 'board'} size={25} /></span>
    <h3>{t(filtered ? 'board.noMatches' : 'board.noTickets')}</h3><p>{t(filtered ? 'board.noMatchesHint' : 'board.noTicketsHint')}</p>
    <Button variant="outline" size="sm" onClick={filtered ? onClear : () => navigate({ page: 'source' })}>
      {t(filtered ? 'board.clear' : 'board.openSources')}</Button></div>
}

export function BoardPage({ route }: { route: Extract<Route, { page: 'board' }> }) {
  const { t, call, navigate } = usePanel()
  const { state, setup, reload: reloadState, restarts } = usePanelData()
  const query = route.query ?? {}
  const { q = '', source = '', order = 'updated', view = 'board' } = query
  const scope = JSON.stringify([q, source, order])
  const [search, setSearch] = useState(q)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const currentRoute = useRef(route)
  currentRoute.current = route
  const updateQuery = (patch: Partial<BoardRouteQuery>) => { const current = currentRoute.current
    navigate({ page: 'board', ...current.id ? { id: current.id } : {}, query: { ...current.query, ...patch } }, true) }
  useEffect(() => { setSearch(q) }, [q])
  useEffect(() => () => clearTimeout(searchTimer.current), [])
  const [windowState, setWindows] = useState({ scope, limits: initialWindows() })
  const limits = windowState.scope === scope ? windowState.limits : initialWindows()
  const windowKey = JSON.stringify(limits)
  const { data: result, error, reload } = usePoll(async () => ({ scope, windowKey,
    view: await readWindow(call, { q, source, order }, limits) }), [scope, windowKey, restarts])
  const data = result?.scope === scope ? result.view : undefined
  const loading = !data || result?.windowKey !== windowKey
  const refresh = useAction(async () => { await reload(); await reloadState() })
  const [columnVisibility, setVisibility] = useState<Partial<Record<BoardColumnId, boolean>>>({})
  const isCollapsed = (id: BoardColumnId) => columnVisibility[id] ?? (!!data?.total && data.columns.find(column => column.id === id)?.total === 0)
  const toggle = (id: BoardColumnId) => setVisibility(previous => ({ ...previous, [id]: !isCollapsed(id) }))
  const open = (id?: string) => navigate({ page: 'board', ...id ? { id } : {}, query }, true)
  const clear = () => { clearTimeout(searchTimer.current); setSearch(''); navigate({ page: 'board', query: { view } }, true) }
  const repository = data?.repository ?? setup?.accounts?.repository
  const columns = data?.columns ?? BOARD_COLUMNS.map(id => ({ id, total: 0, items: [], next_offset: null }))
  return <div className="dt-board-page">
    <div className="dt-board-title-row"><div><h2>{t('board.title')}<span className="dt-board-total">{data ? t('board.count', { count: data.total }) : t('loading')}</span></h2>
      <p>{t('board.subtitle')}</p></div><div className="dt-board-executor">
        <span className="dt-board-load" data-paused={state?.paused || undefined}><span />{setup?.problem ? t('executorWaitingSetup')
          : state?.paused ? t('processingPaused') : t('board.executor', { running: state?.load.running ?? 0, max: state?.load.maxWorkers ?? 0 })}</span>
        {state && <ConfirmButton variant="outline" icon={state.paused ? 'play' : 'pause'} label={t(state.paused ? 'resumeProcessing' : 'pauseProcessing')}
          title={t(state.paused ? 'resumeProcessing' : 'pauseProcessing')} message={t(state.paused ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
          onConfirm={async () => { await call('POST executor/pause', { body: { paused: !state.paused } }); await reloadState() }} />}
      </div></div>
    <div className="dt-board-toolbar">
      <form role="search" onSubmit={event => { event.preventDefault(); clearTimeout(searchTimer.current); updateQuery({ q: search.trim() }) }}>
        <Input icon={<Icon name="search" size={15} />} type="search" placeholder={t('board.search')} aria-label={t('board.searchLabel')}
          value={search} onChange={event => { const value = event.target.value; setSearch(value); clearTimeout(searchTimer.current)
            searchTimer.current = setTimeout(() => updateQuery({ q: value.trim() }), 250) }} /></form>
      <label className="dt-board-select"><Icon name="filter" size={14} /><select aria-label={t('board.source')} value={source}
        onChange={event => { clearTimeout(searchTimer.current); updateQuery({ q: search.trim(), source: event.target.value }) }}>
        <option value="">{t('board.allSources')}</option>{(data?.sources ?? result?.view.sources ?? []).map(item => <option key={item.id}
          value={item.id}>{localized(t, item.title)}</option>)}</select></label>
      <label className="dt-board-select dt-board-sort"><Icon name="queue" size={14} /><select aria-label={t('board.sort')} value={order}
        onChange={event => { clearTimeout(searchTimer.current); updateQuery({ q: search.trim(), order: event.target.value as BoardOrder }) }}>
        {(['updated', 'created', 'oldest'] as const).map(value => <option key={value} value={value}>{t(`board.${value}`)}</option>)}</select></label>
      {(q || source) && <Button size="sm" onClick={clear} icon={<Icon name="close" size={13} />}>{t('board.clear')}</Button>}
      <div className="dt-board-toolbar-end"><Button size="sm" aria-label={t('board.refresh')} title={t('board.refresh')}
        icon={<Icon name="refresh" size={15} />} disabled={refresh.busy || loading} onClick={() => { void refresh.run() }} />
        <ViewSwitch value={view} onChange={value => updateQuery({ view: value })} /></div>
    </div>
    {error && <div className="dt-board-error"><LoadState error={error} loading={false} /><Button variant="outline" size="sm"
      onClick={() => { void refresh.run() }}>{t('retry')}</Button></div>}
    <div className="dt-board-canvas" data-view={view} aria-busy={loading}>
      {!data && !error ? <div className="dt-board-loading" role="status">{t('loading')}</div> : null}
      {data?.total === 0 ? <EmptyBoard filtered={!!(q || source)} onClear={clear} /> : null}
      <div className="dt-board-columns" data-empty={data?.total === 0 || undefined}>
        {columns.map(column => <BoardColumn key={column.id} column={column} repository={repository} collapsed={isCollapsed(column.id)} list={view === 'list'}
          selected={route.id} loading={loading} onToggle={() => toggle(column.id)} onOpen={open} onChanged={reload}
          onMore={() => setWindows({ scope, limits: { ...limits, [column.id]: limits[column.id] + 20 } })} />)}
      </div>
    </div>
    <footer className="dt-board-footer"><span><Icon name="shield" size={12} />{t('board.auto')}</span>
      <span>{repository ?? t('board.repository')}</span></footer>
    {route.id && <TicketDrawer id={route.id} onClose={() => open()} onChanged={reload} />}
  </div>
}
