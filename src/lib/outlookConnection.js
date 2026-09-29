// Pure logic for the Settings "Connect Outlook" flow.
//
// Everything that decides whether a consent request may be sent, and how a
// response is interpreted, lives here so it can be tested without a browser.
// The component is the thin part.
//
// DORMANT BY DEFAULT. VITE_OUTLOOK_CONNECTION_ENABLED must be exactly 'true'.
// Absent means off, matching the Calendar flag's fail-safe default, so an unset
// or mistyped value hides the UI rather than exposing it.
//
// This slice starts an OAuth connection and nothing else. It does not sync a
// mailbox, create a contact, or log an interaction. The product behaviour it
// leads to - suggesting contacts and interaction context from relevant mail -
// is explicitly review-before-save, and none of that exists yet.

import { resolveOauthStartUrl, canStartOauthFrom } from './oauthStartEndpoint.js'
import {
  OUTLOOK_DISCLOSURE_VERSION,
  OUTLOOK_DISCLOSURE_PARAGRAPHS,
  verifyDisclosureIntegrity,
} from './outlookDisclosure.js'

/** Pure predicate: the UI appears only when the flag is exactly 'true'. */
export function outlookConnectionEnabled (rawValue) {
  return rawValue === 'true'
}

// Computed once at module load. In non-Vite (Node test) contexts
// import.meta.env is undefined, so this is false — the fail-safe default.
export const OUTLOOK_CONNECTION_ENABLED = outlookConnectionEnabled(
  import.meta.env?.VITE_OUTLOOK_CONNECTION_ENABLED,
)

/**
 * May the Connect button be enabled?
 *
 * Every condition is required:
 *   acknowledged   the user ticked an UNCHECKED-by-default box. Consent is
 *                  never implied by pressing Connect alone.
 *   integrityOk    the displayed paragraphs still match the version being sent.
 *                  Otherwise the recorded evidence would name text nobody saw.
 *   originOk       the page is on the canonical origin, so the binding cookie
 *                  the callback needs can actually be set.
 *   not busy       no request already in flight.
 */
export function canRequestConsent ({ acknowledged, integrityOk, originOk, connecting }) {
  return acknowledged === true &&
    integrityOk === true &&
    originOk === true &&
    connecting !== true
}

/**
 * Build the start-request body, or refuse. Returns { ok, body } | { ok: false, reason }.
 * Refusing here means no request is made at all.
 */
export function buildConsentRequest ({ acknowledged, originOk, connecting, pageOrigin }) {
  const integrityOk = verifyDisclosureIntegrity()
  if (!integrityOk) return { ok: false, reason: 'disclosure_integrity_failed' }
  if (acknowledged !== true) return { ok: false, reason: 'not_acknowledged' }
  if (!canRequestConsent({ acknowledged, integrityOk, originOk, connecting })) {
    return { ok: false, reason: originOk === true ? 'busy' : 'non_canonical_origin' }
  }
  return {
    ok: true,
    body: {
      returnOrigin: pageOrigin,
      // Sent only because the matching text was rendered and acknowledged.
      consentPolicyVersion: OUTLOOK_DISCLOSURE_VERSION,
    },
  }
}

/**
 * Interpret the start response. The server's controlled error codes are mapped
 * to what the user should actually do.
 */
export function classifyStartResponse (status, body) {
  const error = body && typeof body === 'object' ? body.error : null
  if (status === 200 && body && typeof body.url === 'string' && body.url.length > 0) {
    return { kind: 'redirect', url: body.url }
  }
  if (status === 409 || error === 'consent_version_mismatch') {
    // The published disclosure moved on while this page was open. Sending the
    // stale version again cannot succeed; the page must be reloaded.
    return { kind: 'stale_version' }
  }
  if (status === 503 && error === 'outlook_not_enabled') return { kind: 'not_enabled' }
  if (status === 503 && error === 'config_missing') return { kind: 'not_configured' }
  if (status === 400 && error === 'consent_required') return { kind: 'consent_required' }
  if (status === 401) return { kind: 'signed_out' }
  return { kind: 'error' }
}

/** User-facing copy for each outcome. Never echoes a server message. */
export function messageForOutcome (kind) {
  switch (kind) {
    case 'stale_version':
      return 'The Outlook disclosure has been updated. Reload this page to read the current version before connecting.'
    case 'not_enabled':
    case 'not_configured':
      return 'Outlook connections are not available yet.'
    case 'consent_required':
      return 'Please confirm you have read the disclosure before connecting.'
    case 'signed_out':
      return 'Your session has expired. Sign in again and retry.'
    case 'non_canonical_origin':
      return 'Please continue at www.getfunnl.com to connect Outlook.'
    case 'disclosure_integrity_failed':
      return 'This disclosure could not be verified, so connecting is disabled. Please reload the page.'
    default:
      return 'Could not start the Outlook connection. Please try again.'
  }
}

/**
 * The whole start flow, as one injectable function.
 *
 * The component owns state and markup; this owns the decisions and the calls,
 * so the behaviour that matters can be driven directly in a test: that an
 * unacknowledged attempt performs NO request, that a stale 409 withdraws the
 * acknowledgement, and that a success navigates exactly once to the provider
 * URL and nowhere else.
 *
 * Returns { message, clearAcknowledgement, navigated } - never throws.
 *
 * @param {object} p
 * @param {boolean} p.acknowledged
 * @param {boolean} p.connecting
 * @param {string}  p.pageOrigin
 * @param {string}  p.apikey
 * @param {() => Promise<string|null>} p.getBearer
 * @param {typeof fetch} p.fetchImpl
 * @param {(url: string) => void} p.navigate
 * @param {(name: string, props?: object) => void} [p.trackImpl]
 */
export async function startOutlookConsent ({
  acknowledged, connecting, pageOrigin, apikey,
  getBearer, fetchImpl, navigate, trackImpl = () => {},
}) {
  const originOk = canStartOauthFrom(pageOrigin)
  const built = buildConsentRequest({ acknowledged, originOk, connecting, pageOrigin })
  if (!built.ok) {
    // No request is made at all - this is the refusal path.
    return { message: messageForOutcome(built.reason), clearAcknowledgement: false, navigated: false }
  }

  const endpoint = resolveOauthStartUrl(pageOrigin, 'outlook')
  if (!endpoint.ok) {
    return { message: messageForOutcome('non_canonical_origin'), clearAcknowledgement: false, navigated: false }
  }

  let bearer = null
  try {
    bearer = await getBearer()
  } catch {
    bearer = null
  }
  if (!bearer) {
    return { message: messageForOutcome('signed_out'), clearAcknowledgement: false, navigated: false }
  }

  let res
  try {
    res = await fetchImpl(endpoint.url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        apikey,
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(built.body),
    })
  } catch {
    return { message: messageForOutcome('error'), clearAcknowledgement: false, navigated: false }
  }

  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  const outcome = classifyStartResponse(res.status, data)

  if (outcome.kind === 'redirect') {
    trackImpl('outlook_connect_started', { provider: 'outlook' })
    navigate(outcome.url)
    return { message: '', clearAcknowledgement: false, navigated: true }
  }
  return {
    message: messageForOutcome(outcome.kind),
    // A stale version means the acknowledgement was for text no longer current.
    clearAcknowledgement: outcome.kind === 'stale_version',
    navigated: false,
  }
}

/** Number of paragraphs the card must render. Guards against partial display. */
export const DISCLOSURE_PARAGRAPH_COUNT = OUTLOOK_DISCLOSURE_PARAGRAPHS.length
