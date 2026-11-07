/** User-only setup for Corsair links; secrets never enter client state after a save succeeds. */
import { useEffect, useState, type FormEvent } from 'react'
import { Button, Icon, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import type { CorsairConnectionView } from '../app/api.ts'

const DEFAULT_ENDPOINT = 'https://mcp.corsair.dev/mcp'

export function CorsairConnector() {
  const { call, notify, t } = usePanel()
  const [view, setView] = useState<CorsairConnectionView>()
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT)
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    call('GET corsair').then(value => {
      if (!live) return
      setView(value)
      if (value.endpoint) setEndpoint(value.endpoint)
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [call])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!apiKey.trim()) { notify(t('corsair.enterKey')); return }
    setBusy(true); setError('')
    try {
      const saved = await call('PUT corsair', { body: { endpoint, apiKey } })
      setView(saved)
      setApiKey('')
      notify(t('corsair.saved'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }

  const disconnect = async () => {
    setBusy(true); setError('')
    try { setView(await call('DELETE corsair')); setApiKey('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }

  return <section className="dt-corsair" aria-labelledby="dt-corsair-title">
    <div className="dt-corsair-head">
      <div className="dt-corsair-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none">
        <path d="M7 20c2.4-7.8 7.2-11.7 14.3-11.7 2.1 0 3.8.3 5.2.9M25 5.5l2.2 3.7-4.1 1.4M6 23.3c2 1.2 4.3 1.8 6.9 1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="7" cy="23" r="2" fill="currentColor" /></svg></div>
      <div><h3 id="dt-corsair-title">{t('corsair.title')}</h3><p>{t('corsair.intro')}</p></div>
      <span className={`dt-corsair-status ${view?.configured ? 'is-configured' : ''}`} role="status">
        <i aria-hidden="true" />{loading ? t('loading') : t(view?.configured ? 'corsair.status.connected' : 'corsair.status.disconnected')}
      </span>
    </div>

    <div className="dt-corsair-body">
      <div className="dt-corsair-setup">
        <h4>{t('corsair.github')}</h4>
        <p>{t('corsair.hubHint')}</p>
        <a className="dt-btn dt-btn-outline" href="https://hub.corsair.dev" target="_blank" rel="noreferrer">
          {t('corsair.openHub')} <Icon name="external" size={14} />
        </a>
        <p className="dt-corsair-check">{t('corsair.githubRead')}</p>
      </div>

      <form className="dt-corsair-form" onSubmit={save}>
        <label className="dt-field"><span>{t('corsair.endpoint')}</span>
          <Input type="url" value={endpoint} required autoComplete="url" spellCheck={false} onChange={event => setEndpoint(event.target.value)} />
          <small>{t('corsair.endpointHint')}</small>
        </label>
        <label className="dt-field"><span>{t('corsair.apiKey')}</span>
          <Input type="password" value={apiKey} required autoComplete="new-password" spellCheck={false} onChange={event => setApiKey(event.target.value)} />
          <small>{t('corsair.apiKeyHint')}</small>
        </label>
        {view?.configured && <p className="dt-corsair-current">{t('corsair.savedEndpoint', { endpoint: view.endpoint ?? '' })}</p>}
        {error && <p className="dt-error" role="alert">{error}</p>}
        <div className="dt-corsair-actions">
          <Button type="submit" variant="primary" disabled={busy || loading}>{t('corsair.save')}</Button>
          {view?.configured && <Button type="button" variant="ghost" disabled={busy} onClick={() => { void disconnect() }}>
            {t('corsair.disconnect')}
          </Button>}
        </div>
      </form>
    </div>
  </section>
}
