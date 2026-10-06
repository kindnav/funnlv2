// THE CONTENT-PROCESSING CONSENT GATE.
//
// WHY THIS MODULE EXISTS, stated plainly. The disclosure the live pilot account
// actually agreed to covers ENVELOPES ONLY: who a message was between, when, and
// which folder - no message body is read. Reading bodies to prepare a note is a
// materially different thing to have consented to, so it may not begin on the
// strength of the old agreement. That is not a policy preference; the stored
// consent record names a specific version, and this is what checks it.
//
// WHERE THE DECISION IS MADE. Server side, from microsoft_connections
// .consent_policy_version - the version copied out of the OAuth state at
// finalization, which is the version whose exact paragraphs were rendered to the
// account before it pressed Connect. A build-time flag could not do this job: it
// lives in the browser and says nothing about what any particular account agreed
// to.
//
// FAIL CLOSED, AND CURRENTLY CLOSED FOR EVERYONE. REQUIRED_CONTENT_CONSENT_VERSION
// is deliberately null: the content disclosure has been DRAFTED for owner review
// (docs/outlook-content-disclosure-draft.md) and NOT approved or published. While
// it is null no connection can satisfy the gate, so the import keeps its
// envelope-only behaviour and not one body is fetched. Approving the wording means
// publishing those paragraphs, deriving their version the way
// src/lib/outlookDisclosure.js already does, setting it here, and collecting fresh
// consent - a reconnect - from the account. Until all four of those happen this
// returns `content_consent_not_configured`.
//
// WHAT THIS IS NOT. It is not an entitlement check, a feature flag, or a
// substitute for either. OUTLOOK_INTEGRATION_ENABLED and the pilot gate still
// decide whether the run happens at all; this decides only whether a run that is
// already permitted may read message content.

/** Codes this gate can return. Controlled, and safe to log. */
export const CONTENT_CONSENT_CODES = Object.freeze([
  'content_consent_not_configured',  // no approved content disclosure exists yet
  'content_consent_missing',         // the connection records no version at all
  'content_consent_stale',           // the recorded version predates the content one
])

/**
 * The disclosure version an account must have consented to before ANY message
 * body may be read.
 *
 * null = no approved content disclosure exists. Keep it null until the owner
 * approves the drafted wording; setting it to a guess would be asserting that
 * somebody agreed to text that was never shown to them.
 */
export const REQUIRED_CONTENT_CONSENT_VERSION = null

/** The shape a disclosure version has: the derived `ol-disc-<32 hex>` form. */
const VERSION_RE = /^ol-disc-[0-9a-f]{32}$/

/** Is this a well-formed disclosure version at all? */
export function isDisclosureVersion (v) {
  return typeof v === 'string' && VERSION_RE.test(v.trim())
}

/**
 * May this connection's message CONTENT be read?
 *
 * EXACT equality against the required version, and nothing looser. No prefix
 * match, no ordering comparison, no "at least as new as": versions are content
 * digests, so they carry no order, and a digest that merely looks similar is a
 * different document. An account consented to one specific set of paragraphs or
 * it did not.
 *
 * @param {string|null|undefined} storedVersion  microsoft_connections.consent_policy_version
 * @param {string|null} [requiredVersion]        injected only so a test can supply
 *                                               an approved version; production
 *                                               passes nothing and gets the
 *                                               module constant.
 * @returns {{allowed: true} | {allowed: false, reason: string}}
 */
export function contentProcessingAllowed (
  storedVersion, requiredVersion = REQUIRED_CONTENT_CONSENT_VERSION,
) {
  // No approved content disclosure: nobody can have consented to it.
  if (!isDisclosureVersion(requiredVersion)) {
    return { allowed: false, reason: 'content_consent_not_configured' }
  }
  if (!isDisclosureVersion(storedVersion)) {
    return { allowed: false, reason: 'content_consent_missing' }
  }
  if (storedVersion.trim() !== requiredVersion.trim()) {
    return { allowed: false, reason: 'content_consent_stale' }
  }
  return { allowed: true }
}

/**
 * The one shape of this decision that may be logged: the controlled reason, and
 * booleans. Never the version strings themselves - a disclosure version is not
 * secret, but a per-connection log line pairing one with a run is a record of
 * which account is being processed, and the run's other logs deliberately avoid
 * that.
 */
export function summarizeContentConsent (decision) {
  const allowed = decision?.allowed === true
  return {
    content_allowed: allowed,
    reason: allowed ? null
      : (CONTENT_CONSENT_CODES.includes(decision?.reason) ? decision.reason : 'content_consent_stale'),
  }
}
