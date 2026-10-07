// THE CONTENT PASS: selected handles -> bodies -> sanitized, minimized text ->
// validated draft -> a routing decision for one conversation.
//
// This is the stage that turns a qualifying two-sided exchange into something a
// person can actually review: a summary of what was discussed, an optional next
// step, and - when the counterparty is not yet tracked - a proposed contact to
// go with it.
//
// PURE + DI. Every port is injected and none has a default, so this module makes
// no request, holds no key and reads no environment variable. The deployed caller
// supplies the real ports; the tests supply fixtures.
//
// ── THE FOUR THINGS THAT MUST NOT GO WRONG ───────────────────────────────────
//
// 1. CONSENT IS CHECKED BEFORE A BODY IS FETCHED. Both gates, server side, from
//    the connection's own recorded consent version. `body` false means not one
//    message is read. `thirdParty` false means a body may be read inside Funnl
//    but nothing may be sent to Anthropic - so the pass DEFERS rather than
//    silently summarizing from less, because a summary is the whole point.
//
// 2. RAW BODIES ARE TRANSIENT. A fetched body is sanitized, used to build one
//    request, and dropped. It is never returned by this module, never put in a
//    result object, never interpolated into an error, and never logged. The only
//    text that survives is the model's validated summary and next step. The
//    `sanitized` text is deliberately NOT echoed back to the caller: there is
//    nothing for it to accidentally persist.
//
// 3. THE EMAIL ADDRESS COMES FROM THE PROVIDER ENVELOPE, NEVER THE MODEL. The
//    draft schema has no address field and validateDraftResponse rejects any key
//    that looks like one, but that is the second line of defence. The first is
//    that this module reads the counterparty address from the Graph envelope and
//    passes it to the write path itself; the model's output is never consulted
//    for it.
//
// 4. A MISSING OR UNUSABLE CONTEXT IS A STATED DEFERRAL, NEVER AN EMPTY NOTE.
//    Every failure path returns a controlled reason, and the caller writes
//    nothing for it. The accepted pilot interaction with a blank note is the
//    defect this rule exists to prevent.
//
// ── BUDGET AND CONTINUATION ──────────────────────────────────────────────────
// One conversation at a time, with the invocation budget checked BEFORE each
// fetch and before the model call. Running out is `budget_exhausted`, which is
// retryable: the handles are still stored, the round is untouched, and a later
// invocation redoes exactly this conversation. Nothing partial is written.

import { boundEpisodeContent, sanitizeMessageContent, sanitizeSubject } from './outlookContentSanitizer.js'
import { buildDraftRequest, assertRequestMinimization, validateDraftResponse } from './outlookDraftContract.js'
import { contentPermissions } from './outlookContentConsent.js'
// THE SAME CLASSIFIERS THE ENVELOPE PASS USES, not a second opinion. An earlier
// version of this file checked only hasListId / hasListUnsubscribe / precedence
// inline, which is a strict subset: it missed Auto-Submitted, X-Auto-Response-
// Suppress, no-reply senders, delivery failures, out-of-office replies and calendar
// notifications. Reusing bulkListReason and nonHumanReason means the content stage
// cannot drift from the screening the rest of the pipeline applies.
import { bulkListReason, nonHumanReason } from './emailAutomation.js'

/** At most this many bodies are fetched for one conversation. */
export const MAX_FETCH_PER_CONVERSATION = 6
/**
 * ADMISSION MARGINS, not worst cases, and the distinction matters.
 *
 * The transport's PAGE_WORST_MS is 140s - four attempts at a 20s timeout plus 60s of
 * summed backoff - which already exceeds the 120s invocation budget. That is why the
 * page loop admits on the OBSERVED slowest page against a floor rather than on the
 * worst case: an absolute worst-case margin would refuse every page forever.
 *
 * These follow the same rule. FETCH_ADMIT_MS is one attempt at the transport's own
 * REQUEST_TIMEOUT_MS plus slack: a body read that times out is a deferral, not
 * something worth four retries inside a bounded invocation. DRAFT_ADMIT_MS is
 * callDraftModel's DRAFT_TIMEOUT_MS (30s) plus its two retries' backoff, which is
 * the real ceiling on one draft call.
 */
export const FETCH_ADMIT_MS = 25_000
export const DRAFT_ADMIT_MS = 40_000

/**
 * Every outcome this pass can produce. REFUSALS are settled; DEFERRALS mean "ask
 * again". The caller writes a suggestion only for `interaction_draft` and
 * `new_contact_suggestion`.
 */
export const PASS_OUTCOMES = Object.freeze([
  'interaction_draft',        // a known contact, with a summary
  'new_contact_suggestion',   // an unknown person, with a proposed contact AND the draft
  'ignore',                   // the model judged there is nothing worth proposing
  'defer',                    // ask again later
])

/**
 * Why an exchange was IGNORED - a settled answer, never retried. Separate from
 * DEFER_REASONS so the two cannot be confused in a log or a test.
 */
export const IGNORE_REASONS = Object.freeze([
  'bulk_or_list_mail',   // List-Id / List-Unsubscribe / bulk-list-junk precedence
  // Auto-Submitted, X-Auto-Response-Suppress, a no-reply sender, a delivery failure,
  // an out-of-office reply or a calendar notification - decided by the SAME
  // nonHumanReason the envelope pass uses, not by a local subset of it.
  'automated_message',
  'model_ignored',       // the model judged there is nothing worth proposing
])

export const DEFER_REASONS = Object.freeze([
  'content_consent_missing',       // the body gate is closed for this connection
  'third_party_consent_missing',   // the model gate is closed, so no summary is possible
  'no_handles',                    // nothing was stored to fetch with
  'fetch_failed',                  // a body could not be read (moved, deleted, 5xx)
  'no_usable_content',             // every body sanitized to nothing
  'budget_exhausted',              // the invocation ran out mid-conversation
  'model_unavailable',             // the provider failed after its own retries
  'model_output_invalid',          // the response did not satisfy the strict validator
  'minimization_failed',           // the request would have carried something forbidden
  // THE REQUEST COULD NOT BE BUILT. Separate from the refusal above: this one means
  // buildDraftRequest threw - a bad mode, no allowed dates, or a payload over
  // MAX_REQUEST_CHARS - and nothing was checked, let alone withheld. Reporting it as
  // `minimization_failed` made a construction bug read as a privacy event, and the
  // live report could not tell the two apart.
  'request_build_failed',
  'ambiguous_counterparty',        // more than one external person
  'counterparty_unusable',         // no usable envelope address for an unknown person
  // The provider did not return the header collection, so the exchange could not be
  // screened for automation. For an unknown person that is terminal: proposing a
  // contact on the strength of headers nobody saw is exactly the guess the envelope
  // pass refused to make, and reading the body does not answer the question.
  'automation_unverified',
  'model_deferred',                // the model itself asked to be asked again
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const deferral = (reason, extra = {}) => ({ outcome: 'defer', reason, ...extra })

/**
 * Direction of one message relative to the account.
 * Derived from the FOLDER the handle was stored under, which the envelope pass
 * already decided, rather than re-deriving it from addresses here.
 */
function directionFor (folder) {
  return folder === 'sentitems' ? 'outbound' : 'inbound'
}

/**
 * The counterparty's address and display name, taken from the Graph ENVELOPE of
 * the fetched messages. Never from the model.
 *
 * An inbound message's `from` is the counterparty; an outbound message's first
 * `toRecipients` entry is. More than one distinct external address across the
 * exchange is ambiguous and is deferred rather than guessed.
 */
export function counterpartyFromEnvelopes (messages, selfAddresses) {
  const self = new Set((Array.isArray(selfAddresses) ? selfAddresses : [])
    .filter((a) => typeof a === 'string').map((a) => a.trim().toLowerCase()))
  const seen = new Map()      // address -> display name
  for (const m of Array.isArray(messages) ? messages : []) {
    const candidates = []
    if (m?.direction === 'outbound') {
      for (const r of Array.isArray(m.toRecipients) ? m.toRecipients : []) candidates.push(r)
    } else {
      if (m?.from) candidates.push(m.from)
    }
    for (const c of candidates) {
      const addr = typeof c?.address === 'string' ? c.address.trim().toLowerCase() : ''
      if (addr.length === 0 || self.has(addr)) continue
      if (!seen.has(addr)) {
        seen.set(addr, typeof c?.name === 'string' ? c.name.trim() : '')
      }
    }
  }
  if (seen.size === 0) return { ok: false, reason: 'counterparty_unusable' }
  if (seen.size > 1) return { ok: false, reason: 'ambiguous_counterparty' }
  const [address, name] = [...seen.entries()][0]
  // Shape-checked the same way the write RPC will check it, so an unusable
  // address is caught here rather than at the database.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || address.length > 320) {
    return { ok: false, reason: 'counterparty_unusable' }
  }
  return { ok: true, address, displayName: name.length > 0 ? name : null }
}

/**
 * Summarize ONE conversation.
 *
 * @param {object} p
 * @param {object} p.conversation   { cfp, contactId, messageCount, lastLocalDate }
 * @param {string|null} p.consentVersion  the connection's recorded consent version
 * @param {object} [p.requiredConsent]    injected only by tests
 * @param {Array}  p.handles        [{ mfp, folder, sentAt, midCt, midNonce }]
 * @param {Function} p.decryptHandle async ({ciphertext, nonce}) => plaintext id
 * @param {Function} p.fetchMessage  async (messageId) => { ok:true, message } | { ok:false, code }
 *   `message` is the MERGE of two things the caller already has from one request:
 *     - readMessageContent(json, id) output: bodyContent, uniqueBodyContent,
 *       automation, automationComplete;
 *     - the ENVELOPE fields from the same response: from, toRecipients, subject.
 *   readMessageContent deliberately surfaces only the body and the automation
 *   facts, so the caller supplies the envelope alongside it. CONTENT_SELECT
 *   already requests all of them, so this is one request, not two.
 * @param {Function} p.callModel     async ({body, apiKey}) => EXACTLY what
 *   callDraftModel returns: { ok:true, parsed, stopReason } | { ok:false, code }.
 *   The port contract is that function's own shape deliberately, so no caller has to
 *   translate it. REPRODUCED: this used to read `called.value`, which callDraftModel
 *   never returns, and the unit fixtures happened to supply `value` - so every real
 *   call validated `undefined` and reported `model_output_invalid`. The local harness
 *   caught it; the seam is now gone rather than papered over.
 * @param {string}   p.apiKey
 * @param {string[]} p.selfAddresses
 * @param {Function} p.budgetAllows  (marginMs) => boolean
 * @param {boolean} [p.requiresScreening] TRUE when this conversation reached the
 *   content stage only because `automation_facts_incomplete` was treated as
 *   resolvable - i.e. an unknown counterparty whose headers had not been read. Such a
 *   conversation may be summarized ONLY if this fetch actually returns the header
 *   collection and it screens clean. FALSE for a contact the user already tracks,
 *   whose eligibility the envelope pass established without headers.
 */
export async function summarizeConversation (p) {
  // THE MODULE HELPER, NOT THE WRAPPER BELOW. This guard runs before the accumulators
  // exist, so calling `defer` here reached it inside its own temporal dead zone and
  // threw a ReferenceError instead of deferring - for null, undefined and [] alike.
  // The map is empty and explicit, because nothing has been read at this point.
  if (!isPlainObject(p)) return deferral('no_handles', { missingHeaders: {} })
  const conv = isPlainObject(p.conversation) ? p.conversation : {}
  const requiresScreening = p.requiresScreening === true
  // Controlled counts only: one integer per Graph folder, so an operator can see WHICH
  // side of the exchange lacked a header collection. No header name, no value, no id.
  const missingHeaders = Object.create(null)
  // EVERY deferral from this function reports those counts beside its reason. The live
  // pilot deferred one conversation on the model and settled another on screening in
  // the SAME invocation, and an operator reading either one wants to know whether a
  // header collection was missing - so the counts are not reserved for the screening
  // verdict. Empty when nothing was missing, and always present.
  const defer = (reason, extra = {}) =>
    deferral(reason, { ...extra, missingHeaders: { ...missingHeaders } })
  // SCREENING EVIDENCE, COUNTED ON BOTH SIDES OF THE LEDGER.
  //
  // `inboundSeen` is every inbound message this pass fetched; `inboundScreened` is how
  // many of them carried a complete header collection that screened clean. Requiring
  // only that SOME inbound message was screened was not enough: a conversation with one
  // clean inbound message and another inbound message with no collection passed the
  // gate, and the unscreened message's text went into the summary that was sent on. Two
  // counts and an equality is the check that cannot be satisfied by partial evidence.
  let inboundSeen = 0
  let inboundScreened = 0

  // ── 1. CONSENT, before anything is read ──────────────────────────────────
  const perms = contentPermissions(p.consentVersion, p.requiredConsent ?? {})
  if (!perms.body) {
    return defer('content_consent_missing', { consent: perms })
  }
  // A body may be read but nothing may leave. There is no local summary worth
  // writing - that was the rejected subject-and-counts note - so this defers
  // WITHOUT fetching anything, rather than reading mail it cannot use.
  if (!perms.thirdParty) {
    return defer('third_party_consent_missing', { consent: perms })
  }

  const handles = (Array.isArray(p.handles) ? p.handles : [])
    .filter((h) => isPlainObject(h) && typeof h.midCt === 'string' && h.midCt.length > 0)
    .slice(0, MAX_FETCH_PER_CONVERSATION)
  if (handles.length === 0) return defer('no_handles')

  // ── 2. fetch, sanitize, and drop the raw body immediately ────────────────
  const parts = []
  const envelopes = []
  let fetched = 0
  for (const h of handles) {
    if (typeof p.budgetAllows === 'function' && !p.budgetAllows(FETCH_ADMIT_MS)) {
      // Retryable: the handles are still stored and the round is untouched.
      return defer('budget_exhausted', { fetched })
    }
    let messageId
    try {
      messageId = await p.decryptHandle({ ciphertext: h.midCt, nonce: h.midNonce })
    } catch {
      return defer('fetch_failed', { fetched })
    }
    if (typeof messageId !== 'string' || messageId.length === 0) {
      return defer('fetch_failed', { fetched })
    }

    let got
    try {
      got = await p.fetchMessage(messageId)
    } catch {
      // The thrown value is deliberately not read: it can carry a URL, an
      // address or a provider message.
      return defer('fetch_failed', { fetched })
    }
    // A MOVED-TO-ARCHIVE or EXPORTED message is exactly this: the immutable id
    // no longer resolves. Deferring is the documented answer.
    if (!got || got.ok !== true || !isPlainObject(got.message)) {
      return defer('fetch_failed', { fetched })
    }
    fetched += 1

    const msg = got.message
    if (directionFor(h.folder) === 'inbound') inboundSeen += 1
    // readMessageContent already returns exactly the shape the sanitizer takes,
    // including BOTH projections: `uniqueBodyContent` is Graph's own "this
    // message without the quoted history below it", which is what a summary
    // should read, and the sanitizer prefers it when non-empty.
    const clean = sanitizeMessageContent({
      uniqueBodyContent: typeof msg.uniqueBodyContent === 'string' ? msg.uniqueBodyContent : '',
      bodyContent: typeof msg.bodyContent === 'string' ? msg.bodyContent : '',
    })
    // THE RAW BODY GOES OUT OF SCOPE HERE. `msg` is not retained, not pushed
    // into any result, and the only thing taken from it below is the envelope -
    // addresses and subject - which the draft request never carries either.
    if (clean.ok === true) {
      parts.push({
        timestampIso: typeof h.sentAt === 'string' ? h.sentAt : '',
        direction: directionFor(h.folder),
        sanitized: { text: clean.text, signature: clean.signature ?? null },
      })
    }
    // ── AUTOMATION SCREENING, from the headers the SAME fetch returned ────
    // CONTENT_SELECT asks for internetMessageHeaders alongside the body, so this is
    // the request that can answer the question the envelope pass could not.
    //
    // The shape the classifiers take. They read `automation`, `fromAddress` and
    // `subject` and nothing else, and they return controlled codes - never an
    // address, a subject or a header value.
    const screened = {
      automation: isPlainObject(msg.automation) ? msg.automation : {},
      fromAddress: typeof msg.from?.address === 'string' ? msg.from.address : '',
      subject: typeof msg.subject === 'string' ? msg.subject : '',
    }

    if (msg.automationComplete !== true) {
      // THE COLLECTION IS ABSENT, so THIS message has not been screened. An absent
      // header collection must never be read as "no automation found" - and it is not
      // read that way here: the message simply contributes no screening evidence.
      //
      // RECORDED, NOT RETURNED ON. This used to return automation_unverified
      // immediately, from inside the loop over EVERY selected message - including the
      // user's own outbound ones. Reproduced both ways round: with the outbound
      // message first the counterparty's reply was never even fetched, and with the
      // inbound first its clean headers were read and then discarded. Either way a
      // conversation whose counterparty had complete, clean headers came back
      // unscreenable.
      //
      // WHY AN OUTBOUND MESSAGE CANNOT ANSWER THIS QUESTION. The question is whether
      // the COUNTERPARTY is a person or a mailing list. Every signal the classifiers
      // read is set by the sending side: List-Id, List-Unsubscribe and Precedence
      // identify the list that sent a message, Auto-Submitted and
      // X-Auto-Response-Suppress identify an auto-generated one, and the remaining
      // rules screen the sender address and subject. On an outbound message the
      // sender is the mailbox owner, so its headers describe the user's own mail.
      //
      // Microsoft documents the collection as "message headers indicating the network
      // path taken by a message from the sender to the recipient" (message resource,
      // internetMessageHeaders, which also "Requires $select to retrieve"). That is
      // evidence about the sending side of that particular message. The documentation
      // does NOT say whether the collection is present on sent mail, so nothing here
      // assumes it is absent there - the counters below measure it instead.
      missingHeaders[h.folder] = (missingHeaders[h.folder] || 0) + 1
      // For a contact the user already tracks, the envelope pass accepted the
      // exchange on its own no-reply, bounce, system and subject rules, and chose
      // not to require headers. That decision is not revisited here.
    } else {
      // SCREENING IS UNCHANGED, and still runs in both directions: a complete
      // collection is screened wherever it came from, and a hit is still an immediate
      // ignore. Only the COMPLETENESS REQUIREMENT changed, not what a present
      // collection means.
      if (directionFor(h.folder) === 'inbound') inboundScreened += 1
      const bulk = bulkListReason(screened)
      if (bulk !== null) {
        return { outcome: 'ignore', reason: 'bulk_or_list_mail', fetched,
                 missingHeaders: { ...missingHeaders } }
      }
      const nonHuman = nonHumanReason(screened)
      if (nonHuman !== null) {
        return { outcome: 'ignore', reason: 'automated_message', fetched,
                 missingHeaders: { ...missingHeaders } }
      }
    }
    envelopes.push({
      direction: directionFor(h.folder),
      from: msg.from ?? null,
      toRecipients: Array.isArray(msg.toRecipients) ? msg.toRecipients : [],
      subject: typeof msg.subject === 'string' ? msg.subject : '',
    })
  }

  if (parts.length === 0) {
    return defer('no_usable_content', { fetched })
  }

  // -- THE SCREENING VERDICT, for the WHOLE conversation --------------------
  // FAILS CLOSED, and on the right evidence: EVERY inbound message this pass read must
  // have carried a complete header collection that screened clean. An inbound message
  // is one the COUNTERPARTY sent, and the counterparty is who the question is about.
  //
  // WHY EVERY ONE, and not merely one of them. The text of each inbound message goes
  // into the summary that is sent on, so an unscreened inbound message is unscreened
  // text in the request - and a mailing-list message sitting beside a clean personal
  // one is exactly the case the screening exists to catch. Reproduced in both inbound
  // orderings: with one clean and one collection-less inbound message the conversation
  // was proposed, and the unscreened text reached the model.
  //
  // Any collection that screened DIRTY already returned an `ignore` above, so reaching
  // here with inboundScreened === inboundSeen means every inbound message was screened
  // AND every one came back clean.
  //
  // `inboundSeen === 0` is tested separately and deliberately: an exchange with no
  // inbound message at all would otherwise satisfy 0 === 0 and pass a gate it has no
  // evidence for. Absent headers are never treated as clean.
  //
  // MISSING OUTBOUND HEADERS REMAIN ALLOWED. They say nothing about the counterparty,
  // for the reasons set out at the recording site above.
  if (requiresScreening && (inboundSeen === 0 || inboundScreened !== inboundSeen)) {
    return defer('automation_unverified', { fetched })
  }

  // ── 3. bound the episode, then build the MINIMIZED request ───────────────
  const bounded = boundEpisodeContent(parts)
  if (bounded.kept.length === 0) return defer('no_usable_content', { fetched })

  const subject = sanitizeSubject(envelopes.map((e) => e.subject).find((s) => s.length > 0) ?? '')
  const known = typeof conv.contactId === 'string' && conv.contactId.length > 0

  // The counterparty, from the ENVELOPE. Needed for an unknown person's proposal,
  // and needed either way to prove no address reaches the request.
  const party = counterpartyFromEnvelopes(envelopes, p.selfAddresses)
  if (!known && party.ok !== true) return defer(party.reason, { fetched })

  const lastLocalDate = typeof conv.lastLocalDate === 'string' ? conv.lastLocalDate : null
  const allowedDates = [...new Set(bounded.kept
    .map((k) => String(k.timestampIso).slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .concat(lastLocalDate ? [lastLocalDate] : []))]
  if (allowedDates.length === 0) return defer('no_usable_content', { fetched })

  const mode = known ? 'known_contact' : 'new_contact'
  let body
  try {
    body = buildDraftRequest({
      mode,
      // The provider's display name is allowed evidence for a NAME. It is not an
      // address and the validator keeps it out of any address field.
      displayName: known ? null : (party.ok ? party.displayName : null),
      subject,
      messages: bounded.kept.map((k) => ({
        direction: k.direction,
        dateIso: k.timestampIso,
        text: k.sanitized.text,
        signature: k.direction === 'inbound' ? k.sanitized.signature : null,
      })),
      allowedDates,
    })
  } catch {
    // CONSTRUCTION, not refusal. Nothing was sent and nothing was checked; the guard
    // below never ran. Deterministic for the same inputs, so terminal - but reported
    // as its own code so a bug here is never mistaken for a privacy event.
    return defer('request_build_failed', { fetched })
  }

  // RUNTIME MINIMIZATION, not just a test. Every address seen on the envelope,
  // and every provider id, must be absent from the serialized request.
  const forbiddenAddresses = [
    ...(Array.isArray(p.selfAddresses) ? p.selfAddresses : []),
    ...(party.ok ? [party.address] : []),
  ].filter((a) => typeof a === 'string' && a.length > 0)
  const min = assertRequestMinimization(body, { addresses: forbiddenAddresses })
  if (min.ok !== true) {
    // The categories found are controlled strings; the offending value is never
    // returned by assertRequestMinimization and is not read here either.
    return defer('minimization_failed', { fetched, categories: min.found })
  }

  // ── 4. the model, then the STRICT validator ──────────────────────────────
  if (typeof p.budgetAllows === 'function' && !p.budgetAllows(DRAFT_ADMIT_MS)) {
    return defer('budget_exhausted', { fetched })
  }
  let called
  try {
    called = await p.callModel({ body, apiKey: p.apiKey })
  } catch {
    // A LOCAL EXCEPTION, not a provider verdict. The thrown value is deliberately not
    // read - it can carry the request URL, the key or a response body - so it is
    // reported as one FIXED code and nothing else. Previously this was
    // indistinguishable from a provider failure, which meant a programming fault in
    // the call path read as "the model is down".
    return defer('model_unavailable', { fetched, code: 'model_call_threw' })
  }
  if (!called || called.ok !== true) {
    // THE CODE AND THE STATUS BOTH TRAVEL. callDraftModel already separated an
    // authentication refusal from a rate limit from a timeout; the deferral reason
    // stays `model_unavailable` so classification and retryability are unchanged, and
    // the specific code rides alongside it for the report.
    return defer('model_unavailable', {
      fetched,
      code: called?.code ?? null,
      status: Number.isInteger(called?.status) ? called.status : null,
      // THE 400 CATEGORY, and only for a 400. callDraftModel reads the error body
      // inside its own deadline and returns a fixed category; the provider's message
      // is never returned by it and is never read here either.
      category: typeof called?.category === 'string' ? called.category : null,
    })
  }

  const checked = validateDraftResponse(called.parsed, { mode, allowedDates })
  if (checked.ok !== true) {
    // A model that was fully talked into misbehaving still cannot produce a
    // stored value: the validator is independent of the schema it was asked for.
    return defer('model_output_invalid', { fetched, code: checked.code ?? null })
  }
  if (checked.kind === 'ignore') {
    return { outcome: 'ignore', reason: 'model_ignored', fetched,
             missingHeaders: { ...missingHeaders } }
  }
  if (checked.kind === 'defer') return defer('model_deferred', { fetched })

  // ── 5. the routing decision ──────────────────────────────────────────────
  // validateDraftResponse returns the known-contact shape under `draft` and the
  // new-contact shape under `suggestion`. Both carry summary / follow_up /
  // interaction_date; only the second carries the name triple.
  const draft = (known ? checked.draft : checked.suggestion) ?? {}
  const summary = typeof draft.summary === 'string' ? draft.summary : null
  // NEVER an empty note. If the validator let a blank summary through, this is
  // a deferral, not a suggestion - that blank note is the original complaint.
  if (summary === null || summary.trim().length === 0) {
    return defer('no_usable_content', { fetched })
  }

  const shared = {
    fetched,
    // CARRIED ON SUCCESS TOO. The live-shaped case - an absent collection on the user's
    // own outbound message, a complete clean one on the counterparty's reply - now
    // SUCCEEDS, and reporting the absence only on failures would hide exactly the fact
    // that explains why the old code deferred.
    missingHeaders: { ...missingHeaders },
    messagesSummarized: bounded.kept.length,
    messagesInExchange: Number.isInteger(conv.messageCount) ? conv.messageCount : bounded.kept.length,
    summary,
    // ON WHAT BASIS the summary was written, straight from the validated draft, which
    // already pairs it with the summary the same way the database constraint does.
    // Carried so the known-contact write can record it; it is one of two controlled
    // values and never text from the mail.
    summaryEvidence: typeof draft.summary_evidence === 'string' ? draft.summary_evidence : null,
    followUp: typeof draft.follow_up === 'string' && draft.follow_up.trim().length > 0
      ? draft.follow_up.trim() : null,
    interactionDate: typeof draft.interaction_date === 'string' ? draft.interaction_date : lastLocalDate,
    retainedSubject: subject,
    extractionStatus: 'ai_extracted',
  }

  if (known) {
    return { outcome: 'interaction_draft', contactId: conv.contactId, ...shared }
  }

  // AN UNKNOWN PERSON: the proposal carries the interaction draft WITH it, so one
  // acceptance creates both. The ADDRESS is the envelope's, never the model's -
  // the draft schema has no address field at all, and the validator rejects any
  // key that resembles one, but the first line of defence is that this value is
  // simply never read from the model's output.
  //
  // UNSUPPORTED FIELDS ARE LEFT BLANK, DELIBERATELY. The model may return
  // company, role, how_met, linkedin_url and tags with their own evidence
  // triples, and upsert_new_contact_candidate accepts NONE of them. Rather than
  // widen the write path to carry values nobody has reviewed the storage of,
  // they are dropped here and the reviewer fills them in if they want them. The
  // alternative - storing them unreviewed - is how an unsourced company ends up
  // looking authoritative on a contact card.
  return {
    outcome: 'new_contact_suggestion',
    proposedEmail: party.address,
    // Name only WITH its evidence, which is what the write RPC requires. A model
    // name without evidence falls back to the provider display name, whose
    // evidence is known.
    proposedName: typeof draft.name === 'string' && draft.name.trim().length > 0
      ? draft.name.trim() : (party.displayName ?? null),
    nameEvidence: typeof draft.name === 'string' && draft.name.trim().length > 0
      && typeof draft.name_evidence === 'string'
      ? draft.name_evidence : 'provider_metadata',
    nameConfidence: typeof draft.name === 'string' && draft.name.trim().length > 0
      && typeof draft.name_confidence === 'string'
      ? draft.name_confidence : 'high',
    ...shared,
  }
}

/**
 * The one shape of a pass result that may be logged: counts and controlled codes.
 * Never a summary, a subject, an address, a fingerprint or a message id.
 */
export function summarizePassResult (r) {
  const outcome = PASS_OUTCOMES.includes(r?.outcome) ? r.outcome : 'defer'
  return {
    outcome,
    reason: outcome === 'defer'
      ? (DEFER_REASONS.includes(r?.reason) ? r.reason : 'model_deferred')
      : (outcome === 'ignore'
          ? (IGNORE_REASONS.includes(r?.reason) ? r.reason : 'model_ignored')
          : null),
    fetched: Number.isInteger(r?.fetched) ? r.fetched : 0,
    summarized: Number.isInteger(r?.messagesSummarized) ? r.messagesSummarized : 0,
    of: Number.isInteger(r?.messagesInExchange) ? r.messagesInExchange : 0,
    has_follow_up: typeof r?.followUp === 'string' && r.followUp.length > 0,
    proposes_contact: outcome === 'new_contact_suggestion',
  }
}
