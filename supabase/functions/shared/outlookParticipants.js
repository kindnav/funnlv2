// Outlook PR-B — deterministic participant analysis and episode qualification.
//
// Pure, cross-runtime. No I/O, no logging, no clock, no secrets. Every decision here is
// made from Microsoft ENVELOPE METADATA and the caller's own contact list — never from
// message content and never from a model. Content is only ever fetched for episodes
// this module has already qualified.
//
// Reuses the provider-neutral E1 primitives (emailAddress, emailAutomation,
// emailFingerprint). It deliberately imports NOTHING from the Gmail or Calendar
// adapters, so the two providers stay independently changeable.
//
// ── THE RULES, AND WHY ────────────────────────────────────────────────────────
// 1. Addresses are matched EXACTLY after trim+lowercase. Never by name, never by
//    domain, never fuzzily. A wrong match would attach a stranger's email to a real
//    person's record, which is worse than no suggestion at all.
// 2. The connected mailbox's own addresses and caller-supplied aliases are removed
//    from the counterparty set before anything else is decided.
// 3. CC-only presence never qualifies. Being copied on a thread is not a networking
//    interaction, and it is certainly not evidence to propose a new contact.
// 4. More than one direct (From/To) counterparty ⇒ ambiguous ⇒ DEFER. The product
//    never guesses which of several people a group thread was "really" with.
// 5. An episode must be TWO-SIDED: at least one message from the counterparty and at
//    least one from the user. A cold email that was never answered is not a
//    relationship, and a one-way blast must never create a contact suggestion.
// 6. Nothing here creates a contact or an interaction. Every output is a DRAFT that a
//    human must accept through the PR-A RPCs.
// 7. The proposed email address comes from provider metadata only. The applied
//    `accept_new_contact_candidate` RPC takes no email parameter at all, so the address
//    physically cannot be edited by the client at accept time.

import { normalizeEmail, parseAddressList, parseSingleAddress } from './emailAddress.js'
import { bulkListReason, nonHumanReason } from './emailAutomation.js'
import { computeFingerprintSet } from './emailFingerprint.js'

export const MAX_CONTACTS = 5000
export const MAX_ALIASES = 25
export const MAX_EPISODE_MESSAGES = 50

// Outcome kinds a single message can produce.
export const MESSAGE_OUTCOMES = Object.freeze(['eligible', 'excluded', 'deferred'])

// Controlled reason codes. Never contains an address, subject, or provider id.
export const EXCLUSION_CODES = Object.freeze([
  'bulk_or_list', 'non_human_message', 'no_counterparty', 'cc_only', 'self_only',
  'malformed_addresses', 'is_draft',
])
export const DEFER_CODES = Object.freeze([
  'ambiguous_counterparties', 'ambiguous_contact', 'automation_facts_incomplete',
])
export const EPISODE_CODES = Object.freeze([
  'known_contact_interaction', 'new_contact_suggestion',
  'not_two_sided', 'no_eligible_messages', 'ambiguous_counterparties',
  'ambiguous_contact', 'mixed_counterparties', 'automation_facts_incomplete',
])

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Normalize the connected mailbox's own identities (primary address + any aliases the
 * caller supplies from the connection record). Bounded and deduped.
 * @param {string} primaryEmail
 * @param {string[]} [aliases]
 * @returns {Set<string>}
 */
export function buildSelfIdentitySet(primaryEmail, aliases) {
  const set = new Set()
  const add = (e) => {
    const n = normalizeEmail(e)
    if (n.length > 0 && n.includes('@')) set.add(n)
  }
  add(primaryEmail)
  if (Array.isArray(aliases)) for (const a of aliases.slice(0, MAX_ALIASES)) add(a)
  return set
}

/**
 * Index the caller's contacts by normalized email. An address owned by two different
 * contacts of the same user is recorded as AMBIGUOUS and will defer rather than pick.
 * @param {Array<{id:string,user_id:string,email:string}>} contacts
 * @param {string} userId
 * @returns {Map<string, {contactId:string}|'ambiguous_contact'>}
 */
export function indexContactsByEmail(contacts, userId) {
  const index = new Map()
  if (!Array.isArray(contacts)) return index
  for (const c of contacts.slice(0, MAX_CONTACTS)) {
    if (!isPlainObject(c)) continue
    if (c.user_id !== userId) continue
    const email = normalizeEmail(c.email)
    if (email.length === 0 || !email.includes('@')) continue
    if (typeof c.id !== 'string' || c.id.length === 0) continue
    const existing = index.get(email)
    if (existing === undefined) index.set(email, { contactId: c.id })
    else if (existing === 'ambiguous_contact') continue
    else if (existing.contactId !== c.id) index.set(email, 'ambiguous_contact')
  }
  return index
}

/**
 * Split one message's participants into the sets the rules operate on.
 * `direct` = From plus To (the people actually in the conversation).
 * `ccOnly` = addresses that appear ONLY in Cc.
 * @param {object} message  An E1 NormalizedMessage produced by outlookMessageNormalize.
 * @param {Set<string>} selfSet
 */
export function splitParticipants(message, selfSet) {
  const from = parseSingleAddress(message?.fromAddress)
  const to = parseAddressList(Array.isArray(message?.toAddresses) ? message.toAddresses.join(', ') : '')
  const cc = parseAddressList(Array.isArray(message?.ccAddresses) ? message.ccAddresses.join(', ') : '')

  const self = selfSet instanceof Set ? selfSet : new Set()
  const direct = new Set()
  if (from && !self.has(from)) direct.add(from)
  for (const a of to.addresses) if (!self.has(a)) direct.add(a)

  const ccOnly = new Set()
  for (const a of cc.addresses) if (!self.has(a) && !direct.has(a)) ccOnly.add(a)

  return {
    from,
    fromIsSelf: from !== null && self.has(from),
    direct: [...direct],
    ccOnly: [...ccOnly],
    hadMalformed: to.hadMalformed || cc.hadMalformed || (message?.fromAddress ? from === null : false),
  }
}

/**
 * Evaluate ONE message against every deterministic rule.
 *
 * @param {object} p
 * @param {object} p.message   E1 NormalizedMessage.
 * @param {object} [p.extra]   The `extra` record from normalizeGraphMessage (display
 *                             names + automationFactsComplete).
 * @param {Set<string>} p.selfSet
 * @param {Map} p.contactIndex
 * @returns {{outcome:'eligible', counterparty:string, contactId:string|null,
 *            direction:'inbound'|'outbound', displayName:string|null}
 *         |{outcome:'excluded', code:string}
 *         |{outcome:'deferred', code:string}}
 */
export function evaluateMessage(p) {
  const { message, extra, selfSet, contactIndex } = p || {}
  if (!isPlainObject(message)) return { outcome: 'excluded', code: 'malformed_addresses' }

  // Structural bulk/list evidence disqualifies outright — newsletters and mailing
  // lists are never a 1:1 exchange.
  if (bulkListReason(message) !== null) return { outcome: 'excluded', code: 'bulk_or_list' }
  // Out-of-office, bounces, no-reply senders, calendar notifications.
  if (nonHumanReason(message) !== null) return { outcome: 'excluded', code: 'non_human_message' }

  const parts = splitParticipants(message, selfSet)
  if (parts.hadMalformed && parts.direct.length === 0) {
    return { outcome: 'excluded', code: 'malformed_addresses' }
  }
  if (parts.direct.length === 0) {
    // Everyone on From/To was the user; the only other people were Cc'd (or nobody).
    return { outcome: 'excluded', code: parts.ccOnly.length > 0 ? 'cc_only' : 'self_only' }
  }
  if (parts.direct.length > 1) {
    // A group thread. Never guess which participant the interaction was "with".
    return { outcome: 'deferred', code: 'ambiguous_counterparties' }
  }

  const counterparty = parts.direct[0]
  const match = contactIndex instanceof Map ? contactIndex.get(counterparty) : undefined
  if (match === 'ambiguous_contact') return { outcome: 'deferred', code: 'ambiguous_contact' }
  const contactId = match ? match.contactId : null

  // Automation headers are NOT part of the discovery projection, so a message that has
  // only been discovered always arrives here with incomplete facts; the real facts are
  // merged in by applyAutomationFacts after the per-message content read.
  //
  // FAIL CLOSED: the default when `extra` is absent or unreadable is INCOMPLETE. A
  // caller that forgets to thread the facts through must never thereby get an unknown
  // sender accepted as a new-contact suggestion.
  //
  // For a person the user already tracks, missing automation facts are tolerable — they
  // chose to track that exact address, and the envelope-based no-reply/bounce/system
  // and subject rules above have already run independently. For proposing a BRAND NEW
  // contact they are not: defer instead.
  const automationComplete = isPlainObject(extra) && extra.automationFactsComplete === true
  if (!automationComplete && contactId === null) {
    return { outcome: 'deferred', code: 'automation_facts_incomplete' }
  }

  const direction = parts.fromIsSelf || message.folderHint === 'sent' ? 'outbound' : 'inbound'
  const displayName = isPlainObject(extra) && isPlainObject(extra.displayNames)
    ? (extra.displayNames[counterparty] ?? null)
    : null

  return { outcome: 'eligible', counterparty, contactId, direction, displayName }
}

/**
 * Qualify a whole episode (the messages of one conversation, in one connection).
 *
 * Requires: at least one eligible message, a SINGLE counterparty across all of them,
 * and a genuine two-sided exchange (>=1 inbound and >=1 outbound).
 *
 * @param {object} p
 * @param {Array<{message:object, extra?:object}>} p.entries
 * @param {Set<string>} p.selfSet
 * @param {Map} p.contactIndex
 * @returns {{ok:true, kind:'known_contact_interaction'|'new_contact_suggestion',
 *            counterparty:string, contactId:string|null, displayName:string|null,
 *            conversationKey:string, firstMessageKey:string, lastTimestampIso:string,
 *            inbound:number, outbound:number, messageKeys:string[]}
 *         |{ok:false, code:string}}
 */
export function qualifyEpisode(p) {
  const { entries, selfSet, contactIndex } = p || {}
  const list = Array.isArray(entries) ? entries.slice(0, MAX_EPISODE_MESSAGES) : []
  if (list.length === 0) return { ok: false, code: 'no_eligible_messages' }

  const eligible = []
  let deferCode = null
  for (const e of list) {
    const res = evaluateMessage({
      message: e?.message, extra: e?.extra, selfSet, contactIndex,
    })
    if (res.outcome === 'eligible') { eligible.push({ ...res, entry: e }); continue }
    // A deferral anywhere in the conversation taints the whole episode: we must not
    // quietly summarize the subset we happened to understand.
    if (res.outcome === 'deferred' && deferCode === null) deferCode = res.code
  }
  if (deferCode !== null) return { ok: false, code: deferCode }
  if (eligible.length === 0) return { ok: false, code: 'no_eligible_messages' }

  const counterparties = new Set(eligible.map((e) => e.counterparty))
  if (counterparties.size > 1) return { ok: false, code: 'mixed_counterparties' }
  const counterparty = eligible[0].counterparty

  const contactIds = new Set(eligible.map((e) => e.contactId))
  if (contactIds.size > 1) return { ok: false, code: 'ambiguous_contact' }
  const contactId = eligible[0].contactId

  const inbound = eligible.filter((e) => e.direction === 'inbound').length
  const outbound = eligible.filter((e) => e.direction === 'outbound').length
  if (inbound === 0 || outbound === 0) return { ok: false, code: 'not_two_sided' }

  // Deterministic ordering: timestamp, then message key as the tie-break, so the
  // episode fingerprint is stable no matter what order pages arrived in.
  const ordered = eligible.slice().sort((a, b) => {
    const t = String(a.entry.message.timestampIso).localeCompare(String(b.entry.message.timestampIso))
    return t !== 0 ? t : String(a.entry.message.providerMessageKey).localeCompare(String(b.entry.message.providerMessageKey))
  })

  const displayName = ordered.map((e) => e.displayName).find((n) => typeof n === 'string' && n.length > 0) ?? null

  return {
    ok: true,
    kind: contactId ? 'known_contact_interaction' : 'new_contact_suggestion',
    counterparty,
    contactId,
    displayName,
    conversationKey: ordered[0].entry.message.providerConversationKey,
    firstMessageKey: ordered[0].entry.message.providerMessageKey,
    lastTimestampIso: ordered[ordered.length - 1].entry.message.timestampIso,
    inbound,
    outbound,
    messageKeys: ordered.map((e) => e.entry.message.providerMessageKey),
  }
}

// ── Fingerprint field builders ────────────────────────────────────────────────
// These reuse the EXISTING E1 keyed-HMAC helper unchanged (no new key, no new secret,
// no new algorithm) and only decide what goes into its five canonical, length-prefixed
// slots. Output is 64 lowercase hex chars, satisfying the applied CHECK constraints
// `ncc_episode_fp_shape` / `ncc_person_fp_shape` / `ocr_*_fp_shape` (^[0-9a-f]{64}$).
//
// DOMAIN SEPARATION: the `contactId` slot carries an explicit 'episode:' / 'person:'
// tag. Because every slot is length-prefixed, no value can forge a slot boundary, so
// a person fingerprint can never collide with an episode fingerprint.
export const PERSON_FP_SENTINEL = '-'

/**
 * Canonical fields for an EPISODE fingerprint (one conversation-episode per user).
 * @param {{connectionId:string, conversationKey:string, firstMessageKey:string, contactId?:string|null}} p
 */
export function buildEpisodeFingerprintFields(p) {
  if (!isPlainObject(p)) throw new Error('invalid_fingerprint_input')
  const { connectionId, conversationKey, firstMessageKey, contactId } = p
  for (const v of [connectionId, conversationKey, firstMessageKey]) {
    if (typeof v !== 'string' || v.length === 0) throw new Error('invalid_fingerprint_input')
  }
  return {
    provider: 'outlook',
    accountNamespace: connectionId,
    contactId: `episode:${typeof contactId === 'string' && contactId.length > 0 ? contactId : 'new-contact'}`,
    conversationKey,
    firstMessageKey,
  }
}

/**
 * Canonical fields for a PERSON fingerprint (one proposed person per connection).
 * Keyed on the normalized address so the same person is not proposed twice.
 * @param {{connectionId:string, email:string}} p
 */
export function buildPersonFingerprintFields(p) {
  if (!isPlainObject(p)) throw new Error('invalid_fingerprint_input')
  const email = normalizeEmail(p.email)
  if (typeof p.connectionId !== 'string' || p.connectionId.length === 0) throw new Error('invalid_fingerprint_input')
  if (email.length === 0 || !email.includes('@')) throw new Error('invalid_fingerprint_input')
  return {
    provider: 'outlook',
    accountNamespace: p.connectionId,
    contactId: `person:${email}`,
    conversationKey: PERSON_FP_SENTINEL,
    firstMessageKey: PERSON_FP_SENTINEL,
  }
}

/**
 * Compute both fingerprints for a qualified episode using the injected key ring.
 * No key material is created or read here; the caller supplies it.
 */
export async function computeEpisodeFingerprints(qualified, { connectionId, keyRing }) {
  const episode = await computeFingerprintSet(
    buildEpisodeFingerprintFields({
      connectionId,
      conversationKey: qualified.conversationKey,
      firstMessageKey: qualified.firstMessageKey,
      contactId: qualified.contactId,
    }), keyRing)
  const person = await computeFingerprintSet(
    buildPersonFingerprintFields({ connectionId, email: qualified.counterparty }), keyRing)
  return { episode, person }
}
