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
  'content_consent_not_configured',  // no required version is configured for this check
  'content_consent_missing',         // the connection records no version at all
  'content_consent_stale',           // the recorded version predates the content one
  // The third-party gate, which is SEPARATE on purpose - see below.
  'third_party_consent_not_configured',
  'third_party_consent_missing',
  'third_party_consent_stale',
])

/**
 * The disclosure version an account must have consented to before ANY message
 * body may be read.
 *
 * It stayed null until the owner approved the actual wording, because setting it
 * to a guess would have asserted that somebody agreed to text never shown to
 * them. It is now the version derived from the approved notice.
 */
// APPROVED AND SET. The owner approved the 23-paragraph notice and the Outlook
// policy wording, and approved selected message-body processing. This is the
// version derived from that exact text - see computeDisclosureVersion() in
// src/lib/outlookDisclosure.js, which recomputes it from the paragraph array.
//
// A connection must match this EXACTLY. It is a content digest, so there is no
// ordering and no near-enough: the envelope-only pilot recorded
// ol-disc-81fe8944fd2be59ac3c059c229b4d28e and must disconnect and reconnect,
// because the two documents say opposite things about body reading.
export const REQUIRED_CONTENT_CONSENT_VERSION = 'ol-disc-e3e2b1714b453c2904e3ed08cb232097'

/**
 * The disclosure version an account must have consented to before any part of a
 * message may be sent to a THIRD PARTY (Anthropic, via
 * shared/outlookDraftContract.js).
 *
 * WHY THIS IS A SEPARATE GATE AND NOT THE SAME ONE. Reading a body inside
 * Funnl's own infrastructure and handing a fragment of someone else's email to
 * another company are different things to agree to, and they have different
 * consequences: the second adds a named recipient and that recipient's own
 * retention window (Anthropic's standard commercial terms delete inputs and
 * outputs within 30 days, with a documented exception for content flagged by
 * automated Usage Policy enforcement - up to 2 years, and trust-and-safety
 * scores up to 7 years). An account must be able to have agreed to one and not
 * the other, so the two are checked independently and the caller must pass BOTH
 * to use the model path.
 *
 * Approved and set, for the same reason as above: the notice the owner approved
 * discloses the third-party send explicitly, so this gate has a version to name.
 */
// APPROVED AND SET, separately from the body gate even though both now carry the
// same value. They stay two constants because they answer two questions, and a
// later decision to stop sending anything to Anthropic while still reading
// bodies must remain expressible by changing one of them.
export const REQUIRED_THIRD_PARTY_CONSENT_VERSION = 'ol-disc-e3e2b1714b453c2904e3ed08cb232097'

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
 * May any part of this connection's message content be sent to the THIRD-PARTY
 * draft model?
 *
 * Checked independently of contentProcessingAllowed, and the caller must satisfy
 * BOTH: there is no path on which a body reaches Anthropic without the account
 * having agreed to both the reading and the sending.
 *
 * @returns {{allowed: true} | {allowed: false, reason: string}}
 */
export function thirdPartyProcessingAllowed (
  storedVersion, requiredVersion = REQUIRED_THIRD_PARTY_CONSENT_VERSION,
) {
  if (!isDisclosureVersion(requiredVersion)) {
    return { allowed: false, reason: 'third_party_consent_not_configured' }
  }
  if (!isDisclosureVersion(storedVersion)) {
    return { allowed: false, reason: 'third_party_consent_missing' }
  }
  if (storedVersion.trim() !== requiredVersion.trim()) {
    return { allowed: false, reason: 'third_party_consent_stale' }
  }
  return { allowed: true }
}

/**
 * The two gates together, which is the only form the run should use.
 *
 * FAIL CLOSED AND FAIL SEPARATELY. `body` false means fetch nothing at all.
 * `body` true with `thirdParty` false is a coherent state: the exchange may be
 * read inside Funnl, but no fragment of it may leave - so the model path is
 * skipped and the run must say so rather than quietly summarizing anyway.
 */
export function contentPermissions (storedVersion, required = {}) {
  const body = contentProcessingAllowed(storedVersion, 'content' in required
    ? required.content : REQUIRED_CONTENT_CONSENT_VERSION)
  const third = thirdPartyProcessingAllowed(storedVersion, 'thirdParty' in required
    ? required.thirdParty : REQUIRED_THIRD_PARTY_CONSENT_VERSION)
  return {
    body: body.allowed === true,
    bodyReason: body.allowed === true ? null : body.reason,
    thirdParty: third.allowed === true,
    thirdPartyReason: third.allowed === true ? null : third.reason,
  }
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

/** The logged form of the combined decision. Booleans and controlled codes only. */
export function summarizeContentPermissions (perms) {
  const ok = (v) => v === true
  return {
    body_allowed: ok(perms?.body),
    body_reason: ok(perms?.body) ? null
      : (CONTENT_CONSENT_CODES.includes(perms?.bodyReason)
          ? perms.bodyReason : 'content_consent_not_configured'),
    third_party_allowed: ok(perms?.thirdParty),
    third_party_reason: ok(perms?.thirdParty) ? null
      : (CONTENT_CONSENT_CODES.includes(perms?.thirdPartyReason)
          ? perms.thirdPartyReason : 'third_party_consent_not_configured'),
  }
}
