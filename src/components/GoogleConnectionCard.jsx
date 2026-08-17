import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { track } from '../lib/analytics'
import {
  classifyGoogleConnection,
  parseGoogleReturnParam,
  hasCalendarScope,
  CALENDAR_CONNECTION_ENABLED,
} from '../lib/googleConnection'

// Inner content of the Settings "Connected accounts" card. Phase 0A: Google
// Calendar connect / disconnect only. No event fetching, no sync, no Gmail control.
// Tokens never touch the browser — connect redirects to a server-built Google URL;
// disconnect calls a server function that revokes + deletes local Google data.

export default function GoogleConnectionCard() {
  const location = useLocation()
  const navigate = useNavigate()

  const [loading, setLoading]           = useState(true)
  const [fetchError, setFetchError]     = useState(false)
  const [connection, setConnection]     = useState(null)   // { google_email, scopes, status }
  const [connecting, setConnecting]     = useState(false)
  const [connectError, setConnectError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState('')
  const [showDisconnectModal, setShowDisconnectModal] = useState(false)
  const [banner, setBanner]             = useState(null)   // 'connected' | 'error' | null

  // Strict-Mode safe: set true on (re)mount and false on cleanup, so a dev-mode
  // effect replay does not leave mountedRef stuck false and drop state updates.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  async function fetchConnection() {
    setLoading(true)
    setFetchError(false)
    try {
      const { data, error } = await supabase
        .from('google_connections')
        .select('google_email, scopes, status, connected_at')
        .maybeSingle()
      if (!mountedRef.current) return
      if (error) { setFetchError(true); setConnection(null) }
      else setConnection(data ?? null)
    } catch {
      if (mountedRef.current) { setFetchError(true); setConnection(null) }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  // On mount: surface the server-set ?google= banner (then clean the URL) and load
  // status. When the rollout flag is disabled this is a no-op — no banner, no fetch —
  // so a stray ?google= param never produces a misleading connected/error banner.
  useEffect(() => {
    if (!CALENDAR_CONNECTION_ENABLED) return
    const result = parseGoogleReturnParam(location.search)
    if (result) {
      setBanner(result)
      // Remove the query param so a refresh doesn't re-show the banner.
      navigate(location.pathname, { replace: true })
    }
    fetchConnection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleConnect() {
    // Defensive: never invoke the OAuth start function when the flag is disabled.
    if (!CALENDAR_CONNECTION_ENABLED) return
    if (connecting) return
    setConnecting(true)
    setConnectError('')
    try {
      const { data, error } = await supabase.functions.invoke('google-oauth-start', {
        body: { returnOrigin: window.location.origin },
      })
      if (error || !data?.url) {
        setConnectError('Could not start Google connection. Please try again.')
        setConnecting(false)
        return
      }
      track('google_connect_started', { provider: 'calendar' })
      // Redirect the browser to Google's consent screen.
      window.location.assign(data.url)
    } catch {
      setConnectError('Could not start Google connection. Please try again.')
      setConnecting(false)
    }
  }

  async function handleDisconnect() {
    // Defensive: never invoke the OAuth disconnect function when the flag is disabled.
    if (!CALENDAR_CONNECTION_ENABLED) return
    if (disconnecting) return
    setDisconnecting(true)
    setDisconnectError('')
    try {
      const { error } = await supabase.functions.invoke('google-oauth-disconnect')
      if (!mountedRef.current) return
      if (error) {
        setDisconnectError('Could not disconnect. Please try again.')
        setDisconnecting(false)
        return
      }
      track('google_disconnected', { provider: 'calendar' })
      setConnection(null)
      setShowDisconnectModal(false)
      setDisconnecting(false)
    } catch {
      if (mountedRef.current) {
        setDisconnectError('Could not disconnect. Please try again.')
        setDisconnecting(false)
      }
    }
  }

  // Defensive: render nothing when the rollout flag is disabled (Settings also
  // gates this card, so normally it is never mounted while disabled).
  if (!CALENDAR_CONNECTION_ENABLED) return null

  const state = classifyGoogleConnection({ loading, error: fetchError, connection })
  const emberBtn =
    'text-[12px] font-bold text-white px-4 py-[9px] rounded-[9px] disabled:opacity-40 hover:opacity-90 transition-opacity motion-reduce:transition-none'

  return (
    <div>
      {/* OAuth return banner (server-set result) */}
      {banner === 'connected' && (
        <p role="status" className="text-[11.5px] text-success mb-3">
          Google Calendar connected.
        </p>
      )}
      {banner === 'error' && (
        <p role="alert" className="text-[11.5px] text-danger mb-3">
          We couldn't complete the Google connection. Please try again.
        </p>
      )}

      {/* Google Calendar row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-hi">Google Calendar</p>
          {state === 'loading' && (
            <p className="text-[11px] text-low mt-1 animate-pulse motion-reduce:animate-none">Checking connection…</p>
          )}
          {state === 'error' && (
            <p className="text-[11px] text-danger mt-1">Couldn't load connection status.</p>
          )}
          {state === 'not_connected' && (
            <p className="text-[11px] text-low mt-1">
              Connect to let Funnl suggest interactions from your calendar. Read-only event access; nothing is synced until you connect.
            </p>
          )}
          {state === 'connected' && (
            <p className="text-[11px] text-low mt-1 truncate">
              Connected as <span className="text-mid">{connection.google_email}</span>
              {hasCalendarScope(connection.scopes) ? ' · Calendar read-only granted' : ' · Calendar access not granted'}
            </p>
          )}
          {state === 'needs_reauth' && (
            <p className="text-[11px] text-warning mt-1">
              Reconnection needed — your Google authorization is no longer active.
            </p>
          )}
        </div>

        <div className="flex-none">
          {/* Status failed to load → Retry only (NEVER offer Connect, which could
              start a second OAuth for an account we could not verify). Disabled
              while a fetch is in flight to prevent duplicate retries. */}
          {state === 'error' && (
            <button
              type="button"
              onClick={fetchConnection}
              disabled={loading}
              className="text-[11.5px] font-semibold text-accent hover:opacity-80 transition-opacity motion-reduce:transition-none disabled:opacity-40"
            >
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          )}
          {/* Start/replace OAuth only from a definitive not_connected/needs_reauth state. */}
          {state === 'not_connected' && (
            <button type="button" onClick={handleConnect} disabled={connecting} className={emberBtn} style={{ background: 'var(--color-ember)' }}>
              {connecting ? 'Connecting…' : 'Connect Google Calendar'}
            </button>
          )}
          {state === 'needs_reauth' && (
            <button type="button" onClick={handleConnect} disabled={connecting} className={emberBtn} style={{ background: 'var(--color-ember)' }}>
              {connecting ? 'Connecting…' : 'Reconnect'}
            </button>
          )}
          {state === 'connected' && (
            <button
              type="button"
              onClick={() => { setDisconnectError(''); setShowDisconnectModal(true) }}
              className="text-[11.5px] font-semibold text-danger hover:opacity-80 transition-opacity motion-reduce:transition-none"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {connectError && <p role="alert" className="text-[10.5px] text-danger mt-2">{connectError}</p>}

      {/* Gmail: planned, non-interactive copy only (no fake control) */}
      <div className="mt-4 pt-3 border-t border-line-1">
        <p className="text-[12.5px] font-semibold text-lower">Gmail</p>
        <p className="text-[11px] text-lower mt-1">Gmail integration is planned for a later release.</p>
      </div>

      {/* Disconnect confirmation modal */}
      {showDisconnectModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'var(--color-backdrop)' }}
          onClick={() => { if (!disconnecting) setShowDisconnectModal(false) }}
          role="dialog"
          aria-modal="true"
          aria-label="Disconnect Google Calendar"
        >
          <div
            className="bg-card border border-line-2 rounded-2xl p-5 max-w-[360px] w-full"
            onClick={e => e.stopPropagation()}
          >
            <p className="text-[14px] font-semibold text-hi mb-2">Disconnect Google Calendar?</p>
            <p className="text-[12px] text-muted mb-4">
              Funnl will stop any calendar syncing and remove the Google authorization stored for your account. Your existing contacts and interactions are not affected. You can reconnect anytime.
            </p>
            {disconnectError && <p role="alert" className="text-[11px] text-danger mb-3">{disconnectError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDisconnectModal(false)}
                disabled={disconnecting}
                className="text-[12px] font-semibold text-mid px-3 py-[8px] rounded-[9px] hover:bg-elevated transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="text-[12px] font-bold text-white px-4 py-[8px] rounded-[9px] disabled:opacity-40 hover:opacity-90 transition-opacity motion-reduce:transition-none"
                style={{ background: 'var(--color-danger)' }}
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
