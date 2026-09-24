// Outlook PR-B — normalize a raw Microsoft Graph message envelope into the existing
// provider-neutral E1 contract, plus the small set of Outlook-only facts the drafts
// feature needs.
//
// Pure, cross-runtime. No imports except the E1 contract validator. No I/O, no logging,
// no secrets, no Gmail/Calendar coupling (the Gmail adapter's header normalizers are
// deliberately NOT imported — the two providers must stay independently changeable).
//
// PRIVACY INVARIANT: `normalizeGraphMessage` is fed DISCOVERY (delta) items only. It
// refuses any payload that carries `body`, `bodyPreview` or `uniqueBody` — if those
// ever appear here it means the discovery $select was widened by mistake, and that must
// fail closed rather than silently flow onward. Raw header VALUES never survive
// anywhere in this module: only allowlisted booleans and small enums (the E1
// AutomationFacts shape) are kept.
//
// HEADERS ARE NOT EXPECTED AT DISCOVERY. `internetMessageHeaders` is documented by
// Microsoft as a property you select on a message GET, so the discovery projection does
// not request it and this module does not require it. A discovery item therefore
// normalizes with `automationFactsComplete: false`, which is a first-class state
// meaning "automation could not be assessed" — never "no automation". The real facts
// arrive with the per-message content read and are merged in by `applyAutomationFacts`.

import { classifyNormalizedMessage } from './emailProviderContract.js'

export const MAX_RECIPIENTS_PER_MESSAGE = 200
export const MAX_DISPLAY_NAME_LEN = 120
export const MAX_SUBJECT_INPUT = 998
export const MAX_HEADERS = 200

// The automation state of a message that has only been DISCOVERED. `complete: false`
// is a first-class value meaning "could not be assessed" - never "no automation".
export const UNASSESSED_AUTOMATION = Object.freeze({
  facts: Object.freeze({
    autoSubmitted: null, precedence: null,
    hasListId: false, hasListUnsubscribe: false, hasAutoResponseSuppress: false,
  }),
  complete: false,
})

// Present on a stage-1 payload ⇒ the caller asked for more than the envelope.
export const CONTENT_KEYS = Object.freeze(['body', 'bodyPreview', 'uniqueBody'])

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const PROTO_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype'])

/** Graph emits RFC3339 with `Z`. E1 requires a UTC instant; normalize fractional secs. */
export function graphDateToIso(value) {
  if (typeof value !== 'string' || value.length < 19 || value.length > 40) return null
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return null
  if (t < 0 || t > 4102444800000) return null   // 1970..2100
  return new Date(t).toISOString()
}

/** Allowlisted Auto-Submitted → controlled enum. */
export function normalizeAutoSubmitted(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const v = value.trim().toLowerCase().split(';')[0].trim()
  if (v === 'no') return 'no'
  if (v === 'auto-generated') return 'auto-generated'
  if (v === 'auto-replied') return 'auto-replied'
  return 'other'
}

/** Allowlisted Precedence → controlled enum. */
export function normalizePrecedence(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const v = value.trim().toLowerCase()
  if (v === 'bulk' || v === 'list' || v === 'junk') return v
  return 'other'
}

/**
 * Reduce `internetMessageHeaders` to the E1 AutomationFacts shape. Resolution rule
 * (identical in spirit to the Gmail adapter, re-implemented here to keep the providers
 * decoupled): ANY automated occurrence wins, so an added `Auto-Submitted: no` or
 * `Precedence: normal` cannot mask a real automation header.
 *
 * `complete:false` means Graph did not return the header collection at all, so the
 * ABSENCE of automation evidence proves nothing. Callers must treat that
 * conservatively — see outlookParticipants.evaluateMessage.
 */
export function automationFactsFromHeaders(headers) {
  if (!Array.isArray(headers)) {
    return {
      facts: {
        autoSubmitted: null, precedence: null,
        hasListId: false, hasListUnsubscribe: false, hasAutoResponseSuppress: false,
      },
      complete: false,
    }
  }
  const capped = headers.slice(0, MAX_HEADERS)
  const valuesOf = (lower) => {
    const out = []
    for (const h of capped) {
      if (isPlainObject(h) && typeof h.name === 'string' && h.name.toLowerCase() === lower &&
          typeof h.value === 'string') out.push(h.value)
    }
    return out
  }
  const present = (lower) => valuesOf(lower).length > 0

  let autoSubmitted = null
  let sawNo = false
  for (const v of valuesOf('auto-submitted')) {
    const n = normalizeAutoSubmitted(v)
    if (n === null) continue
    if (n !== 'no') { autoSubmitted = n; break }
    sawNo = true
  }
  if (autoSubmitted === null && sawNo) autoSubmitted = 'no'

  let precedence = null
  let sawOther = false
  for (const v of valuesOf('precedence')) {
    const n = normalizePrecedence(v)
    if (n === null) continue
    if (n === 'bulk' || n === 'list' || n === 'junk') { precedence = n; break }
    sawOther = true
  }
  if (precedence === null && sawOther) precedence = 'other'

  return {
    facts: {
      autoSubmitted,
      precedence,
      hasListId: present('list-id'),
      hasListUnsubscribe: present('list-unsubscribe'),
      hasAutoResponseSuppress: present('x-auto-response-suppress'),
    },
    complete: true,
  }
}

// Pull the bare addr-spec out of a Graph recipient object. Display names are kept
// SEPARATELY (never folded into the address string) so no display name can smuggle a
// second mailbox into an address list.
function recipientAddress(node) {
  if (!isPlainObject(node)) return null
  const ea = isPlainObject(node.emailAddress) ? node.emailAddress : null
  if (!ea) return null
  const addr = typeof ea.address === 'string' ? ea.address.trim() : ''
  return addr.length > 0 && addr.length <= 320 ? addr : null
}

function recipientDisplayName(node) {
  if (!isPlainObject(node)) return null
  const ea = isPlainObject(node.emailAddress) ? node.emailAddress : null
  if (!ea) return null
  const name = typeof ea.name === 'string' ? ea.name.trim() : ''
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_LEN) return null
  // A display name equal to the address carries no extra information.
  const addr = typeof ea.address === 'string' ? ea.address.trim().toLowerCase() : ''
  if (name.toLowerCase() === addr) return null
  return name
}

function addressList(nodes) {
  if (!Array.isArray(nodes)) return []
  const out = []
  for (const n of nodes.slice(0, MAX_RECIPIENTS_PER_MESSAGE)) {
    const a = recipientAddress(n)
    if (a) out.push(a)
  }
  return out
}

/**
 * Detect a delta `@removed` tombstone (message deleted/moved out of the folder).
 * @returns {{ removed:true, messageId:string|null, reason:string }|null}
 */
export function readRemoval(raw) {
  if (!isPlainObject(raw)) return null
  const rem = raw['@removed']
  if (!isPlainObject(rem)) return null
  const reason = typeof rem.reason === 'string' && rem.reason.length <= 40 ? rem.reason : 'unknown'
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 1024 ? raw.id : null
  return { removed: true, messageId: id, reason }
}

/**
 * Normalize ONE raw Graph message envelope.
 *
 * @param {unknown} raw            A single element of a delta page's `value` array.
 * @param {'inbox'|'sentitems'} folder  Which folder the run read it from.
 * @returns {{ok:true, message:object, extra:object} | {ok:false, code:string}}
 *
 * `message` is a strict E1 NormalizedMessage (metadata only — it carries no content
 * and is validated by classifyNormalizedMessage before it is returned).
 *
 * `extra` carries Outlook-only facts that E1 has no field for, and exactly three:
 *   * `displayNames`            per-address display names, used for a
 *                               `provider_metadata` name proposal;
 *   * `automationFactsComplete` whether automation headers have been ASSESSED (always
 *                               false at discovery — see applyAutomationFacts). It is
 *                               a boolean only: no raw header is ever carried here;
 *   * `folder`                  the discovery folder, 'inbox' or 'sentitems'.
 *
 * It carries neither draft state nor `internetMessageId`: a draft is rejected with
 * code `is_draft` before any successful result is returned, and `internetMessageId` is
 * selected by no projection and retained nowhere.
 */
export function normalizeGraphMessage(raw, folder) {
  if (!isPlainObject(raw)) return { ok: false, code: 'not_object' }
  for (const k of PROTO_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) return { ok: false, code: 'prototype_pollution' }
  }
  // Stage-1 payloads must never carry content. Fail closed if they do.
  for (const k of CONTENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) return { ok: false, code: 'unexpected_content' }
  }
  if (folder !== 'inbox' && folder !== 'sentitems') return { ok: false, code: 'invalid_folder' }
  if (isPlainObject(raw['@removed'])) return { ok: false, code: 'removed_tombstone' }

  const id = raw.id
  const conversationId = raw.conversationId
  if (typeof id !== 'string' || id.length === 0 || id.length > 1024) return { ok: false, code: 'missing_ids' }
  if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 1024) {
    return { ok: false, code: 'missing_ids' }
  }
  // A draft has not been exchanged with anyone; it can never evidence an interaction.
  if (raw.isDraft === true) return { ok: false, code: 'is_draft' }

  const folderHint = folder === 'sentitems' ? 'sent' : 'inbox'
  const stamp = folderHint === 'sent'
    ? (graphDateToIso(raw.sentDateTime) || graphDateToIso(raw.receivedDateTime))
    : (graphDateToIso(raw.receivedDateTime) || graphDateToIso(raw.sentDateTime))
  if (!stamp) return { ok: false, code: 'bad_timestamp' }

  // `from` is authoritative for who sent it; `sender` is the submitting mailbox and is
  // used only as a fallback when `from` is absent.
  const fromAddress = recipientAddress(raw.from) || recipientAddress(raw.sender) || ''
  const toAddresses = addressList(raw.toRecipients)
  const ccAddresses = addressList(raw.ccRecipients)

  const subject = typeof raw.subject === 'string' ? raw.subject : ''
  if (subject.length > MAX_SUBJECT_INPUT || fromAddress.length > MAX_SUBJECT_INPUT) {
    return { ok: false, code: 'oversized_header' }
  }

  // Discovery NEVER assesses automation. The discovery projection does not request
  // `internetMessageHeaders`, so this stage always emits the empty, explicitly
  // UNASSESSED fact set. Reading headers opportunistically here would fork behaviour on
  // provider whim: present -> assessed, absent -> not, with no way to tell from a test.
  // The real facts are merged in by applyAutomationFacts after the per-message read.
  const automation = UNASSESSED_AUTOMATION

  const message = {
    provider: 'outlook',
    providerMessageKey: id,
    providerConversationKey: conversationId,
    timestampIso: stamp,
    fromAddress,
    toAddresses,
    ccAddresses,
    subject,                     // transient; sanitized/bounded before any storage
    automation: automation.facts,
    folderHint,
  }
  if (classifyNormalizedMessage(message) !== null) return { ok: false, code: 'contract_rejected' }

  // Display names, keyed by lowercased address. Provider metadata only — this is the
  // ONLY permitted source for a `provider_metadata` name proposal.
  const displayNames = Object.create(null)
  const collect = (node) => {
    const a = recipientAddress(node)
    const n = recipientDisplayName(node)
    if (a && n) displayNames[a.toLowerCase()] = n
  }
  collect(raw.from)
  collect(raw.sender)
  for (const n of (Array.isArray(raw.toRecipients) ? raw.toRecipients.slice(0, MAX_RECIPIENTS_PER_MESSAGE) : [])) collect(n)
  for (const n of (Array.isArray(raw.ccRecipients) ? raw.ccRecipients.slice(0, MAX_RECIPIENTS_PER_MESSAGE) : [])) collect(n)

  return {
    ok: true,
    message,
    extra: {
      displayNames,
      // False for every discovery item, because the discovery projection does not
      // request headers. `applyAutomationFacts` flips this once the per-message read
      // has actually returned the header collection.
      automationFactsComplete: automation.complete,
      folder,
    },
  }
}

/**
 * Merge the automation facts obtained from the PER-MESSAGE content read into a message
 * that was normalized from a discovery item, producing a new message/extra pair that
 * can be re-evaluated with complete information.
 *
 * Takes only the already-classified facts — never a raw header collection — so there is
 * no code path by which a header name/value could reach a caller of this function.
 *
 * Returns the pair unchanged when `complete` is false, so an unavailable or
 * inconclusive header collection keeps the conservative state rather than being
 * upgraded to "assessed".
 *
 * @param {object} message  E1 NormalizedMessage from normalizeGraphMessage.
 * @param {object} extra    The matching `extra` record.
 * @param {{facts:object, complete:boolean}} automation  From readMessageContent.
 * @returns {{ message:object, extra:object }}
 */
export function applyAutomationFacts(message, extra, automation) {
  if (!isPlainObject(message) || !isPlainObject(automation)) {
    return { message, extra }
  }
  const complete = automation.complete === true
  const facts = isPlainObject(automation.facts) ? automation.facts : null
  if (!complete || !facts) {
    return { message, extra: { ...(isPlainObject(extra) ? extra : {}), automationFactsComplete: false } }
  }
  return {
    message: {
      ...message,
      automation: {
        autoSubmitted: facts.autoSubmitted ?? null,
        precedence: facts.precedence ?? null,
        hasListId: facts.hasListId === true,
        hasListUnsubscribe: facts.hasListUnsubscribe === true,
        hasAutoResponseSuppress: facts.hasAutoResponseSuppress === true,
      },
    },
    extra: { ...(isPlainObject(extra) ? extra : {}), automationFactsComplete: true },
  }
}

/**
 * Normalize a whole delta page. Deduplicates by message id, records removals, and
 * counts discards by controlled code. A throwing getter (adversarial payload) is
 * caught and counted as `unreadable` — it never crashes the run and never becomes a
 * usable message.
 */
export function normalizeGraphPage(items, folder) {
  const list = Array.isArray(items) ? items : []
  const messages = []
  const extras = new Map()
  const removals = []
  const byDiscardCode = Object.create(null)
  const seen = new Set()
  let duplicates = 0
  let hadUnreadable = false

  for (const raw of list) {
    let removal = null
    try { removal = readRemoval(raw) } catch { removal = null }
    if (removal) { removals.push(removal); continue }

    let res
    try { res = normalizeGraphMessage(raw, folder) } catch {
      hadUnreadable = true
      byDiscardCode.unreadable = (byDiscardCode.unreadable || 0) + 1
      continue
    }
    if (!res.ok) {
      byDiscardCode[res.code] = (byDiscardCode[res.code] || 0) + 1
      continue
    }
    const key = res.message.providerMessageKey
    if (seen.has(key)) { duplicates += 1; continue }
    seen.add(key)
    messages.push(res.message)
    extras.set(key, res.extra)
  }

  return {
    messages,
    extras,
    removals,
    hadUnreadable,
    counts: { input: list.length, normalized: messages.length, duplicates, removed: removals.length },
    byDiscardCode,
  }
}
