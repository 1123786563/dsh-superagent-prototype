/** Same-origin settings for the independently running PR automation plugin. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Input, Switch } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { Hint, KeyValues, LoadState } from './widgets.tsx'

interface AutomationSettings {
  enabled: boolean
  autoMerge: boolean
  pollSeconds: number
  executionWindow: { enabled: boolean; timeZone: string; start: string; end: string }
}
interface AutomationView {
  revision: string
  value: AutomationSettings
  repository: string
  label: string
  status: {
    phase: string; lastError: string | null; lastPoll: string | null; nextPollAt: string | null
    execution?: { allowed: boolean; reason: string; localTime: string; timeZone: string }
  }
}
type Draft = Omit<AutomationSettings, 'pollSeconds'> & { pollSeconds: string }
const toDraft = (value: AutomationSettings): Draft => ({ ...value, pollSeconds: String(value.pollSeconds) })
const ENDPOINT = '/pr-automation/api/settings'
const HEADERS = { 'x-pr-automation-request': '1' }
const PHASES = ['starting', 'ready', 'paused', 'disabled', 'outside_window', 'error', 'unavailable'] as const
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
function validZone(value: string): boolean {
  if (!value.trim() || value !== value.trim() || /^[+-]/.test(value)) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}
/** Carries an HTTP status so stale revisions get a specific recovery message. */
class SettingsFailure extends Error {
  constructor(readonly status: number) { super(String(status)) }
}
async function request(body?: { revision: string; value: AutomationSettings }, signal?: AbortSignal): Promise<AutomationView> {
  const response = await fetch(ENDPOINT, { method: body ? 'PUT' : 'GET', credentials: 'same-origin',
    headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS,
    ...body ? { body: JSON.stringify(body) } : {}, ...signal ? { signal } : {} })
  if (!response.ok) throw new SettingsFailure(response.status)
  const value: AutomationView = await response.json()
  if (typeof value.revision !== 'string' || typeof value.value?.enabled !== 'boolean'
    || typeof value.value.autoMerge !== 'boolean' || typeof value.value.pollSeconds !== 'number'
    || typeof value.value.executionWindow?.enabled !== 'boolean' || typeof value.value.executionWindow.timeZone !== 'string'
    || typeof value.value.executionWindow.start !== 'string' || typeof value.value.executionWindow.end !== 'string'
    || typeof value.repository !== 'string' || typeof value.label !== 'string' || typeof value.status?.phase !== 'string') {
    throw new Error('Invalid settings response')
  }
  return value
}

export function PrAutomationSettings() {
  const { t, notify } = usePanel()
  const [view, setView] = useState<AutomationView>()
  const [draft, setDraft] = useState<Draft>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const failureText = (failure: unknown) => t(failure instanceof SettingsFailure && failure.status === 409
    ? 'prAutomation.conflict' : 'prAutomation.unavailable')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    request(undefined, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setView(value); setDraft(toDraft(value.value)); setSaved(false)
    }, failure => { if (!controller.signal.aborted) setError(failureText(failure)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
    // Locale changes should not discard an unsaved draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  const canRefresh = !!view && !loading && !busy
  useEffect(() => {
    if (!canRefresh) return
    let controller: AbortController | undefined
    let stopped = false
    const refresh = async () => {
      if (controller) return
      controller = new AbortController()
      try {
        const current = await request(undefined, controller.signal)
        if (stopped) return
        // Runtime polling must never advance the form's saved value or optimistic-lock revision.
        setView(previous => previous ? { ...previous, status: current.status } : previous)
        setRefreshFailed(false)
      } catch { if (!stopped) setRefreshFailed(true) }
      finally { controller = undefined }
    }
    const timer = setInterval(() => { void refresh() }, 15_000)
    return () => { stopped = true; clearInterval(timer); controller?.abort() }
  }, [canRefresh])

  if (!view || !draft) return <div className="dt-form">
    <LoadState loading={loading} error={error ? new Error(error) : undefined} />
    {!loading && error && <Button variant="outline" onClick={() => setAttempt(attempt + 1)}>{t('retry')}</Button>}
  </div>

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(view.value))
  const edit = (next: Partial<Draft>) => { setDraft({ ...draft, ...next }); setSaved(false); setError('') }
  const windowEdit = (next: Partial<Draft['executionWindow']>) => edit({ executionWindow: { ...draft.executionWindow, ...next } })
  const validation = !/^\d+$/.test(draft.pollSeconds) || !Number.isInteger(Number(draft.pollSeconds))
    || Number(draft.pollSeconds) < 60 || Number(draft.pollSeconds) > 3600 ? t('prAutomation.invalidPoll')
    : !validZone(draft.executionWindow.timeZone) ? t('prAutomation.invalidZone')
    : !validTime(draft.executionWindow.start) || !validTime(draft.executionWindow.end) ? t('prAutomation.invalidTime')
    : draft.executionWindow.enabled && draft.executionWindow.start === draft.executionWindow.end ? t('prAutomation.equalTime') : ''
  const restore = async () => {
    setBusy(true); setError(''); setSaved(false)
    try { const current = await request(); setView(current); setDraft(toDraft(current.value)) }
    catch (failure) { setError(failureText(failure)) }
    finally { setBusy(false) }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !dirty || validation) return
    setBusy(true); setError(''); setSaved(false)
    try {
      const current = await request({ revision: view.revision, value: { ...draft, pollSeconds: Number(draft.pollSeconds) } })
      setView(current); setDraft(toDraft(current.value)); setSaved(true); notify(t('saved'))
      form.current?.focus({ preventScroll: true })
    } catch (failure) { setError(failureText(failure)) }
    finally { setBusy(false) }
  }
  const switchRow = (label: string, checked: boolean, onChange: (value: boolean) => void) => <div className="dt-switch-row">
    <span>{label}</span><Switch label={label} checked={checked} onChange={onChange} />
  </div>
  const pollTime = (value: string | null) => {
    const stamp = value ? Date.parse(value) : NaN
    return Number.isFinite(stamp) ? new Intl.DateTimeFormat(t('lang'), { timeZone: view.value.executionWindow.timeZone,
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(stamp) : t('empty')
  }
  const status = view.status
  const phase = PHASES.find(value => value === status.phase) ?? 'unavailable'
  const executionRows: [string, string][] = status.execution ? [[t('prAutomation.windowStatus'),
    `${status.execution.allowed ? t('prAutomation.allowed') : t('prAutomation.waiting')} · ${status.execution.localTime} (${status.execution.timeZone})`]] : []
  return <div className="dt-form">
    <Hint>{t('prAutomation.intro')}</Hint>
    <section className="dt-block dt-form" aria-label={t('prAutomation.runtime')}>
      <h3 className="dt-card-title">{t('prAutomation.runtime')}</h3>
      <KeyValues rows={[
        [t('prAutomation.repository'), view.repository || t('empty')],
        [t('prAutomation.label'), view.label || t('empty')],
        [t('statusTitle'), t(`prAutomation.phase.${phase}`)],
        [t('prAutomation.lastPoll'), pollTime(status.lastPoll)],
        [t('prAutomation.nextPoll'), pollTime(status.nextPollAt)],
        ...executionRows,
      ]} />
      {status.lastError && <p className="dt-error" role="alert">{status.lastError}</p>}
      {refreshFailed && <p className="dt-error" role="alert">{t('prAutomation.refreshFailed')}</p>}
    </section>
    <form ref={form} className="dt-block dt-form" tabIndex={-1} onSubmit={event => { void save(event) }} noValidate>
      <Fields disabled={busy || loading}>
        {switchRow(t('prAutomation.enabled'), draft.enabled, enabled => edit({ enabled }))}
        {switchRow(t('prAutomation.autoMerge'), draft.autoMerge, autoMerge => edit({ autoMerge }))}
        <Hint>{t('prAutomation.autoMergeHint')}</Hint>
        <Field label={t('prAutomation.poll')} note={t('prAutomation.pollHint')}>
          <Input type="number" min={60} max={3600} step={1} required value={draft.pollSeconds}
            onChange={event => edit({ pollSeconds: event.target.value })} />
        </Field>
        {switchRow(t('prAutomation.window'), draft.executionWindow.enabled, enabled => windowEdit({ enabled }))}
        <Hint>{t('prAutomation.windowHint')}</Hint>
        <div className="dt-grid3">
          <Field label={t('prAutomation.zone')}><Input required spellCheck={false} placeholder="Asia/Shanghai"
            disabled={!draft.executionWindow.enabled} value={draft.executionWindow.timeZone}
            onChange={event => windowEdit({ timeZone: event.target.value })} /></Field>
          <Field label={t('prAutomation.start')}><Input type="time" step={60} required disabled={!draft.executionWindow.enabled}
            value={draft.executionWindow.start} onChange={event => windowEdit({ start: event.target.value })} /></Field>
          <Field label={t('prAutomation.end')}><Input type="time" step={60} required disabled={!draft.executionWindow.enabled}
            value={draft.executionWindow.end} onChange={event => windowEdit({ end: event.target.value })} /></Field>
        </div>
      </Fields>
      {saved && <p role="status" className="dt-hint">{t('saved')}</p>}
      {(dirty || error) && <div className="dt-savebar">
        <Hint>{t('prAutomation.unsaved')}</Hint>
        {(error || validation) && <p className="dt-error" role="alert">{error || validation}</p>}
        <Button variant="ghost" disabled={busy || loading} onClick={() => { void restore() }}>{t('prAutomation.restore')}</Button>
        <Button variant="primary" type="submit" disabled={busy || loading || !dirty || !!validation}>{busy ? t('loading') : t('save')}</Button>
      </div>}
    </form>
  </div>
}
