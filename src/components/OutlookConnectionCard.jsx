import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SUPABASE_ANON_KEY, getSessionBearerToken, supabase } from '../lib/supabase'
import { track } from '../lib/analytics'
import { canStartOauthFrom } from '../lib/oauthStartEndpoint'
import {
  OUTLOOK_DISCLOSURE_PARAGRAPHS,
  OUTLOOK_DISCLOSURE_VERSION,
  verifyDisclosureIntegrity,
} from '../lib/outlookDisclosure'
import {
  buildConsentRequest,
  messageForOutcome,
  readOutlookCallbackResult,
  startOutlookConsent,
} from '../lib/outlookConnection'
import {
  DISCONNECT_CONFIRM_LABEL,
  DISCONNECT_CONSEQUENCES,
  loadOutlookStatus,
  runOutlookDisconnect,
} from '../lib/outlookDisconnect'

// Settings → Outlook. DORMANT: SettingsPage mounts this only when
// VITE_OUTLOOK_CONNECTION_ENABLED is exactly 'true', which it is nowhere.
//
// Two states, decided by the database rather than by local state:
//   NOT CONNECTED  the disclosure, an unchecked acknowledgement, and Connect.
//   CONNECTED      which mailbox is connected, and a disconnect path.
//
// This card starts and ends an OAuth connection and nothing else. It does not
// sync a mailbox, create a contact, or log an interaction. The suggestions this
// would eventually feed are review-before-save by design, and none of that is
// built.
//
// THE CONSENT RULE THIS CARD ENFORCES
// The exact paragraphs rendered below are the ones the version identifies, and
// the version is only sent because they were rendered. The acknowledgement box
// starts UNCHECKED and is never pre-ticked; pressing Connect is not by itself
// consent. If the text ever drifts from its fingerprint the control disables
// itself rather than sending a version for text nobody saw.
//
// THE DISCONNECT RULE THIS CARD ENFORCES
// Disconnect is two steps, and the first step only opens a panel that states
// the consequences. Those consequences are not a paraphrase: they are the
// verified behaviour of the applied RPC (see src/lib/outlookDisconnect.js).
// Nothing here uses a service-role key - the RPC runs as the signed-in user and
// derives the account from auth.uid().

// One label per verified effect. 'In flight' and 'At Microsoft' are the two
// limits: the RPC cannot stop a request already holding a token, and it does not
// withdraw the grant at Microsoft.
// 'Invalidated', not 'Emptied': the retained suggestion row still carries its contact,
// proposed date and episode fingerprint after a disconnect, so it is not empty. The
// effect was renamed in src/lib/outlookDisconnect.js and this map was left behind -
// which rendered a BLANK label for that consequence, since EFFECT_LABEL['invalidated']
// was undefined.
const EFFECT_LABEL = {
  deleted: 'Deleted',
  invalidated: 'Invalidated',
  kept: 'Kept',
  in_flight: 'In flight',
  upstream: 'At Microsoft',
}

function formatConnectedAt (iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

export default function OutlookConnectionCard() {
  const [searchParams] = useSearchParams()
  const [acknowledged, setAcknowledged] = useState(false)   // never defaults true
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  const [status, setStatus] = useState('loading')           // loading | connected | not_connected | signed_out | error
  const [connection, setConnection] = useState(null)
  const [statusMessage, setStatusMessage] = useState('')

  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectMessage, setDisconnectMessage] = useState('')

  // Recomputed at render: the version is only trustworthy while the displayed
  // text still matches it.
  const integrityOk = useMemo(() => verifyDisclosureIntegrity(), [])
  const originOk = useMemo(
    () => canStartOauthFrom(typeof window === 'undefined' ? '' : window.location.origin),
    [],
  )

  const refreshStatus = useCallback(async () => {
    const result = await loadOutlookStatus({
      rpc: () => supabase.rpc('get_my_outlook_connection'),
    })
    setStatus(result.kind)
    setConnection(result.connection ?? null)
    setStatusMessage(result.message)
  }, [])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  // Shown only while the DATABASE says this account is not connected, so a
  // stale ?outlook=error cannot contradict a connection that exists.
  const callbackFailed =
    readOutlookCallbackResult(searchParams) === 'error' && status !== 'connected'

  const request = buildConsentRequest({
    acknowledged,
    originOk,
    connecting,
    pageOrigin: typeof window === 'undefined' ? '' : window.location.origin,
  })
  const canConnect = request.ok

  // The flow itself lives in startOutlookConsent so it can be driven directly
  // in tests with injected fetch / navigate. This wrapper only supplies the
  // browser's versions and applies the result to state.
  async function handleConnect() {
    setError('')
    setConnecting(true)
    const result = await startOutlookConsent({
      acknowledged,
      connecting: false,
      pageOrigin: window.location.origin,
      apikey: SUPABASE_ANON_KEY,
      getBearer: getSessionBearerToken,
      fetchImpl: (url, init) => fetch(url, init),
      navigate: (url) => window.location.assign(url),
      trackImpl: track,
    })
    if (result.navigated) return           // the page is leaving; keep the spinner
    if (result.clearAcknowledgement) setAcknowledged(false)
    setError(result.message)
    setConnecting(false)
  }

  // Step two. Only the button inside the open confirmation panel calls this.
  async function handleDisconnect() {
    setDisconnectMessage('')
    setDisconnecting(true)
    const result = await runOutlookDisconnect({
      confirmed: true,
      disconnecting: false,
      pageOrigin: window.location.origin,
      getBearer: getSessionBearerToken,
      rpc: () => supabase.rpc('disconnect_my_outlook'),
      trackImpl: track,
    })
    setDisconnecting(false)
    setDisconnectMessage(result.message)
    if (result.disconnected) {
      setConfirmingDisconnect(false)
      setAcknowledged(false)             // reconnecting requires a fresh tick
      await refreshStatus()
    }
  }

  return (
    <div className="rounded-2xl border border-line-2 bg-card p-6">
      <h3 className="font-display text-lg text-hi">Outlook</h3>

      {/* Outside every status branch on purpose: visible while the status is
          still loading, and in the signed_out branch too. */}
      {callbackFailed && (
        <p
          className="mt-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
          role="status"
          aria-live="polite"
        >
          {messageForOutcome('callback_failed')}
        </p>
      )}

      {status === 'loading' && (
        <p className="mt-2 text-sm text-muted">Checking your Outlook connection…</p>
      )}

      {(status === 'signed_out' || status === 'error') && (
        <p className="mt-2 text-sm text-danger" role="status" aria-live="polite">
          {statusMessage}
        </p>
      )}

      {/* ── CONNECTED ──────────────────────────────────────────────────── */}
      {status === 'connected' && connection && (
        <div className="mt-2">
          <p className="text-sm text-muted">
            Connected to{' '}
            <span className="font-mono text-hi">{connection.mailbox}</span>
            {formatConnectedAt(connection.connectedAt) &&
              ` since ${formatConnectedAt(connection.connectedAt)}`}.
          </p>
          <p className="mt-1 font-mono text-[11px] text-lower">
            Granted: {connection.scopes.join(', ') || 'none recorded'} · disclosure{' '}
            {connection.consentVersion || 'unknown'}
          </p>

          {connection.needsReauth && (
            <p className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              This connection needs your permission again before Funnl can read
              anything. Disconnect and reconnect to renew it.
            </p>
          )}

          {!confirmingDisconnect && (
            <button
              type="button"
              onClick={() => { setDisconnectMessage(''); setConfirmingDisconnect(true) }}
              className="mt-4 rounded-xl border border-line-3 bg-elevated px-4 py-2 text-sm font-semibold text-hi"
            >
              Disconnect Outlook
            </button>
          )}

          {/* Step two: the consequences, stated before anything happens. */}
          {confirmingDisconnect && (
            <div className="mt-4 rounded-xl border border-danger/40 bg-danger/5 p-4">
              <p className="text-sm font-semibold text-hi">
                Disconnect {connection.mailbox}?
              </p>
              <ul className="mt-3 space-y-2">
                {DISCONNECT_CONSEQUENCES.map((c) => (
                  <li key={c.text} className="text-sm leading-relaxed text-muted">
                    <span className="mr-2 font-mono text-[10px] uppercase tracking-wider text-lower">
                      {EFFECT_LABEL[c.effect]}
                    </span>
                    {c.text}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="rounded-xl bg-danger px-4 py-2 text-sm font-semibold text-base disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {disconnecting ? 'Disconnecting…' : DISCONNECT_CONFIRM_LABEL}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDisconnect(false)}
                  disabled={disconnecting}
                  className="rounded-xl border border-line-2 px-4 py-2 text-sm text-mid disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── NOT CONNECTED: the disclosure and the consent control ──────── */}
      {status === 'not_connected' && (
        <>
          <p className="mt-1 text-sm text-muted">
            Optional. Read the disclosure below before connecting.
          </p>

          {!integrityOk && (
            <p className="mt-4 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              {messageForOutcome('disclosure_integrity_failed')}
            </p>
          )}

          <div className="mt-4 space-y-3 rounded-xl border border-line-1 bg-elevated p-4">
            {OUTLOOK_DISCLOSURE_PARAGRAPHS.map((para) => (
              <p key={para} className="text-sm leading-relaxed text-muted">{para}</p>
            ))}
            <p className="pt-1 font-mono text-[11px] text-lower">
              Disclosure version {OUTLOOK_DISCLOSURE_VERSION}
            </p>
          </div>

          <label className="mt-4 flex items-start gap-3 text-sm text-mid">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              checked={acknowledged}
              disabled={!integrityOk || connecting}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              I have read the disclosure above and I want to connect my Outlook mailbox.
            </span>
          </label>

          {error && (
            <p className="mt-3 text-sm text-danger" role="status" aria-live="polite">{error}</p>
          )}

          <button
            type="button"
            onClick={handleConnect}
            disabled={!canConnect}
            className="mt-4 rounded-xl bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] px-4 py-2 text-sm font-semibold text-hi disabled:cursor-not-allowed disabled:opacity-40"
          >
            {connecting ? 'Starting…' : 'Connect Outlook'}
          </button>
        </>
      )}

      {disconnectMessage && (
        <p className="mt-3 text-sm text-mid" role="status" aria-live="polite">
          {disconnectMessage}
        </p>
      )}
    </div>
  )
}
