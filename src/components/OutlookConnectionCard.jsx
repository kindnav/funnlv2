import { useMemo, useState } from 'react'
import { SUPABASE_ANON_KEY, getSessionBearerToken } from '../lib/supabase'
import { track } from '../lib/analytics'
import { resolveOauthStartUrl, canStartOauthFrom } from '../lib/oauthStartEndpoint'
import {
  OUTLOOK_DISCLOSURE_PARAGRAPHS,
  OUTLOOK_DISCLOSURE_VERSION,
  verifyDisclosureIntegrity,
} from '../lib/outlookDisclosure'
import {
  buildConsentRequest,
  classifyStartResponse,
  messageForOutcome,
} from '../lib/outlookConnection'

// Settings → "Connect Outlook". DORMANT: SettingsPage mounts this only when
// VITE_OUTLOOK_CONNECTION_ENABLED is exactly 'true', which it is nowhere.
//
// This card starts an OAuth connection and nothing else. It does not sync a
// mailbox, create a contact, or log an interaction. The suggestions this would
// eventually feed are review-before-save by design, and none of that is built.
//
// THE CONSENT RULE THIS CARD ENFORCES
// The exact paragraphs rendered below are the ones the version identifies, and
// the version is only sent because they were rendered. The acknowledgement box
// starts UNCHECKED and is never pre-ticked; pressing Connect is not by itself
// consent. If the text ever drifts from its fingerprint the control disables
// itself rather than sending a version for text nobody saw.

export default function OutlookConnectionCard() {
  const [acknowledged, setAcknowledged] = useState(false)   // never defaults true
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  // Recomputed at render: the version is only trustworthy while the displayed
  // text still matches it.
  const integrityOk = useMemo(() => verifyDisclosureIntegrity(), [])
  const originOk = useMemo(
    () => canStartOauthFrom(typeof window === 'undefined' ? '' : window.location.origin),
    [],
  )

  const request = buildConsentRequest({
    acknowledged,
    originOk,
    connecting,
    pageOrigin: typeof window === 'undefined' ? '' : window.location.origin,
  })
  const canConnect = request.ok

  async function handleConnect() {
    setError('')
    const built = buildConsentRequest({
      acknowledged,
      originOk,
      connecting,
      pageOrigin: window.location.origin,
    })
    if (!built.ok) {
      setError(messageForOutcome(built.reason))
      return
    }

    setConnecting(true)
    try {
      const endpoint = resolveOauthStartUrl(window.location.origin, 'outlook')
      if (!endpoint.ok) {
        setError(messageForOutcome('non_canonical_origin'))
        setConnecting(false)
        return
      }
      const bearer = await getSessionBearerToken()
      if (!bearer) {
        setError(messageForOutcome('signed_out'))
        setConnecting(false)
        return
      }
      const res = await fetch(endpoint.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(built.body),
      })
      const data = await res.json().catch(() => null)
      const outcome = classifyStartResponse(res.status, data)

      if (outcome.kind === 'redirect') {
        track('outlook_connect_started', { provider: 'outlook' })
        window.location.assign(outcome.url)
        return
      }
      if (outcome.kind === 'stale_version') {
        // The acknowledgement was for text that is no longer current, so it is
        // withdrawn rather than carried over to a version the user has not read.
        setAcknowledged(false)
      }
      setError(messageForOutcome(outcome.kind))
      setConnecting(false)
    } catch {
      setError(messageForOutcome('error'))
      setConnecting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-line-2 bg-card p-6">
      <h3 className="font-display text-lg text-hi">Connect Outlook</h3>
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
    </div>
  )
}
