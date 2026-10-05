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

// ── the single-account pilot, for PRESENTATION ONLY ────────────────────────
//
// VITE_OUTLOOK_CONNECTION_ENABLED is global: switching it on would show the Connect
// card to EVERY signed-in user, and every one of them except the designated account
// would be refused 403 `not_in_pilot` by outlook-oauth-start. That is safe but it is
// a dead end, so this hides the control instead of offering it and failing.
//
// IT IS NOT ACCESS CONTROL, and must never be described as any. A build-time flag
// lives in the browser, where a user can edit it; the authoritative gates are
// server-side - OUTLOOK_PILOT_USER_ID checked in outlook-oauth-start before a state
// is minted, and the same designation narrowing reserve_due_outlook_connection so a
// non-pilot connection is never even selected for import.
//
// IT IS A SEPARATE VARIABLE from the server's on purpose. The server's value must
// not be sourced from a VITE_ name, because everything VITE_ is compiled into a
// public bundle. The cost of two variables is that they can DIVERGE: a stale value
// here shows the card to somebody the server will refuse, or hides it from the real
// pilot. Neither is a security failure, both are confusing, so set them together.
//
// WHAT IT DISCLOSES: the bundle then contains one user id. That is not a credential
// - a signed-in user can already read their own id - but it does reveal WHICH
// account is piloting, to anyone who reads the bundle. Accepted deliberately for a
// one-account pilot; it is a reason to unset it when the pilot ends.

/**
 * Pure predicate: may THIS viewer see the Outlook controls?
 *
 * Fails closed in both directions. An absent or malformed designation shows the
 * control to nobody, so forgetting it cannot quietly expose Outlook to every user;
 * an absent viewer id (still loading, or signed out) also shows nothing.
 *
 * @param {unknown} rawPilotId  the build-time designation
 * @param {unknown} viewerId    the signed-in user's id
 */
export function outlookPilotViewer (rawPilotId, viewerId) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const designated = typeof rawPilotId === 'string' ? rawPilotId.trim().toLowerCase() : ''
  if (!uuid.test(designated)) return false
  const viewer = typeof viewerId === 'string' ? viewerId.trim().toLowerCase() : ''
  return viewer.length > 0 && viewer === designated
}

/** The build-time designation. Undefined outside Vite, so false everywhere in Node. */
export const OUTLOOK_PILOT_VIEWER_ID =
  import.meta.env?.VITE_OUTLOOK_PILOT_USER_ID ?? null

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
export function buildConsentRequest ({
  acknowledged, originOk, connecting, pageOrigin,
  // Injectable so the REFUSAL can be driven in a test. Production callers pass
  // nothing and get the real check over the shipped paragraphs.
  verifyIntegrity = verifyDisclosureIntegrity,
}) {
  const integrityOk = verifyIntegrity() === true
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

// ── The post-OAuth return to Settings ───────────────────────────────────────
//
// outlook-oauth-callback finishes with a 303 to /settings?outlook=connected or
// /settings?outlook=error (buildOutlookSettingsRedirect). Nothing read that
// parameter, so a refused connection returned to a Settings page that looked
// exactly like one that had never been attempted: the card simply showed the
// not-connected state again, with no indication that anything had failed. The
// first live pilot consent landed in precisely that silence.
//
// The parameter is the ONLY thing the callback tells the browser, and
// deliberately so: every failing path redirects to the same generic error so
// that an unbound request and a bound-but-refused one are byte-identical.
// There is therefore no provider detail here TO surface, and none must be
// invented - the reason lives in the Edge log alone.

/** The only two values the callback can produce. Anything else is ignored. */
export const OUTLOOK_CALLBACK_RESULTS = Object.freeze(['connected', 'error'])

/**
 * Read the callback result from a query string or a URLSearchParams-like value.
 *
 * CONTROLLED: only the two values above are recognised, so a hand-typed or
 * injected parameter cannot put arbitrary text on the page. Duplicates are
 * refused rather than resolved first-wins or last-wins, matching the callback's
 * own no-last-wins form parsing.
 *
 * @param {string|{getAll: (name: string) => string[]}} search
 * @returns {'connected'|'error'|null}
 */
export function readOutlookCallbackResult (search) {
  let params = null
  if (search && typeof search.getAll === 'function') {
    params = search
  } else if (typeof search === 'string' && search.length > 0) {
    try { params = new URLSearchParams(search) } catch { return null }
  }
  if (!params) return null
  let all
  try { all = params.getAll('outlook') } catch { return null }
  if (!Array.isArray(all) || all.length !== 1) return null
  return OUTLOOK_CALLBACK_RESULTS.includes(all[0]) ? all[0] : null
}

/** User-facing copy for each outcome. Never echoes a server message. */
export function messageForOutcome (kind) {
  switch (kind) {
    case 'callback_failed':
      // Short, visible, and generic ON PURPOSE. Every failing callback path
      // produces the same redirect, so there is no provider detail available
      // and none may be implied. "Nothing was connected" is accurate: the
      // error redirect is returned on every path that stops before
      // finalize_microsoft_connection stores a row, and on a non-'stored'
      // result.
      return 'Could not connect your Outlook account. Nothing was connected - please try again.'
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
  verifyIntegrity = verifyDisclosureIntegrity,
}) {
  const originOk = canStartOauthFrom(pageOrigin)
  const built = buildConsentRequest({ acknowledged, originOk, connecting, pageOrigin, verifyIntegrity })
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
