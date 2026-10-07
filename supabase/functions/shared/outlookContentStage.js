// THE CONTENT STAGE: the real ports for one conversation's summary, bound to the
// transport, the provider and the database.
//
// outlookContentPass.js is pure and knows nothing about Graph, Anthropic or
// PostgREST. This module is the adapter that gives it:
//
//   readHandles    list_outlook_round_message_handles, keyset-paged
//   decryptHandle  the connection's AES-GCM key, already bound by the caller
//   fetchMessage   ONE bounded Graph read per message, merged into the shape the
//                  pass expects: the body projection AND the envelope from the
//                  same response
//   callModel      callDraftModel, at its own timeout and retry policy
//
// It also owns the ROUTING WRITE, because the write and the summary have to agree:
// an interaction draft goes to upsert_outlook_interaction_candidate with the note,
// and a proposal for someone not yet tracked goes to upsert_new_contact_candidate
// with the draft travelling inside it, so one acceptance can create both records.
//
// ── WHY ONE CONVERSATION AT A TIME ───────────────────────────────────────────
// Reading every handle of a finished round up front would be 60 round trips for a
// 200-conversation round, almost all of them for conversations the invocation will
// never reach: each summary costs up to six Graph reads and a model call. So the
// handles are read lazily, immediately before the conversation is summarized, and
// an invocation that runs out of budget has spent nothing on the rest.
//
// ── WHAT NEVER HAPPENS HERE ──────────────────────────────────────────────────
//   * No raw body is returned, stored, logged or interpolated into an error. The
//     fetch merges the body into the pass's input and the pass drops it; nothing
//     in this module's return value can carry one.
//   * No message id is logged. It exists in memory between decryption and the
//     request URL, and nowhere else.
//   * No address reaches Anthropic. assertRequestMinimization runs inside the pass
//     against the self and counterparty addresses this module supplies.
//   * No write happens for a deferral. A terminal deferral writes the
//     metadata-only candidate it would have written anyway and REPORTS the reason;
//     a retryable one writes nothing and leaves the conversation unprocessed.

import {
  buildMessageContentRequest, executeGraphRequest, readMessageContent, isUsableGraphId,
} from './outlookGraphTransport.js'
import {
  callDraftModel, MINIMIZATION_CATEGORIES, DRAFT_FAILURE_CODES,
  DRAFT_BAD_REQUEST_CATEGORIES,
} from './outlookDraftContract.js'
import { summarizeConversation, summarizePassResult, MAX_FETCH_PER_CONVERSATION } from './outlookContentPass.js'
import { contentPermissions } from './outlookContentConsent.js'
import { RECOVERY_OUTCOME_CODES } from './outlookConversationRecovery.js'

/**
 * Handle-read pages, bounded. The RPC caps a page at 20 and a conversation retains
 * at most 6, so one call is always enough in practice; the bound exists so a
 * malformed cursor cannot loop.
 */
export const MAX_HANDLE_PAGES = 3

/**
 * The ONLY two write RPCs this stage may name.
 *
 * planContentWrite returns a name rather than calling it, and the run dispatches on
 * that name - so the run's source does not contain either literal. This frozen list
 * is therefore the allowlist a reviewer and a test can actually check, and the run
 * asserts membership before dispatching.
 */
export const CONTENT_WRITE_RPCS = Object.freeze([
  'upsert_outlook_interaction_candidate',
  'upsert_new_contact_candidate',
])

/** The only RPC this stage READS with. */
export const CONTENT_READ_RPC = 'list_outlook_round_message_handles'

/** What a stage result's `write` field can say. */
export const STAGE_WRITES = Object.freeze([
  'interaction_with_note',   // the known-contact candidate, carrying the summary
  'new_contact_proposal',    // the proposed contact, carrying the interaction draft
  'interaction_metadata',    // no content was available; the candidate as it is today
  'none',                    // nothing written, and the conversation is NOT processed
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * EVERY deferral code, classified EXACTLY ONCE as terminal or retryable.
 *
 * WHY A MAP AND NOT TWO LISTS. `minimization_failed` used to appear in both, and
 * planContentWrite tested the retryable list first - so a DETERMINISTIC privacy
 * refusal was treated as work worth retrying. The run stopped the finalisation loop
 * without passing the conversation, no cursor moved, and the next invocation re-read
 * the same mail and refused again for the same reason.
 *
 * OBSERVED on the pilot, on a RESUMED invocation: two bodies read, zero model calls,
 * zero candidates, no cursor, processed 0 of 2 - in about two seconds. Reproduced
 * through the real handler across three consecutive invocations, which is where the
 * "for ever" comes from; the live report is one invocation of it.
 *
 * The live report named `minimization_failed`, which at the time ALSO covered a request
 * that could not be built, so what the mail actually contained is not established by it.
 *
 * A map cannot express that overlap, because a key has one value. The two lists below
 * are DERIVED from it, so they cannot drift apart from each other or from this.
 *
 *   terminal   the same inputs would produce the same answer. Nothing is written, the
 *              reason is reported, and the conversation is PASSED so the round can
 *              finish. Deterministic refusal is not the same thing as lost work.
 *   retryable  another invocation could genuinely answer differently - a transient
 *              provider or database failure, a budget that ran out, or configuration
 *              that an operator can supply. The conversation is NOT passed, so the
 *              resume position preserves it.
 */
export const DEFERRAL_CLASS = Object.freeze({
  // ── terminal ──────────────────────────────────────────────────────────────
  content_consent_missing: 'terminal',      // the gate is closed; it will not open mid-round
  third_party_consent_missing: 'terminal',
  // The provider returned no header collection, so the exchange could not be
  // screened. Terminal for this round: the same fetch would answer the same way.
  automation_unverified: 'terminal',
  no_handles: 'terminal',                   // nothing was stored to fetch with
  no_usable_content: 'terminal',            // the bodies sanitized to nothing
  // THE PRIVACY GUARD REFUSED, and that refusal is a property of the MAIL, not of the
  // configuration: the forbidden value is somewhere in the material the request is
  // built from, so building it again produces the same request and the same refusal.
  // Terminal, therefore - and this is the correction. The guard itself is unchanged.
  //
  // WHICH value, and where, is not knowable from this code: the guard returns the
  // CATEGORY only. That is reported separately, in refusal_categories.
  minimization_failed: 'terminal',
  // THE REQUEST COULD NOT BE BUILT AT ALL - a bad mode, no allowed dates, or a payload
  // over MAX_REQUEST_CHARS. Distinct from the refusal above on purpose: both are
  // terminal, but one means "Funnl withheld a request that would have leaked" and the
  // other means "Funnl could not construct a request", and reporting the second as the
  // first made a construction bug look like a privacy event.
  request_build_failed: 'terminal',
  ambiguous_counterparty: 'terminal',       // more than one external person
  counterparty_unusable: 'terminal',
  model_output_invalid: 'terminal',         // the response failed the strict validator
  model_deferred: 'terminal',               // the model itself declined

  // ── retryable ─────────────────────────────────────────────────────────────
  budget_exhausted: 'retryable',
  fetch_failed: 'retryable',                // a transient Graph failure, or a moved message
  model_unavailable: 'retryable',            // the provider failed after its own retries
  handles_unreadable: 'retryable',           // the handle RPC itself failed
  // A CONFIGURATION fact, not a property of the mail: the key is absent. Configuring
  // it makes the same conversation summarizable, so the work is preserved for a retry
  // rather than settled - the difference between "come back" and "nothing to say".
  summary_key_absent: 'retryable',
})

/** Derived, so it cannot overlap RETRYABLE_DEFERRALS. */
export const TERMINAL_DEFERRALS = Object.freeze(
  Object.keys(DEFERRAL_CLASS).filter((c) => DEFERRAL_CLASS[c] === 'terminal'),
)

/** Derived, so it cannot overlap TERMINAL_DEFERRALS. */
export const RETRYABLE_DEFERRALS = Object.freeze(
  Object.keys(DEFERRAL_CLASS).filter((c) => DEFERRAL_CLASS[c] === 'retryable'),
)

/**
 * The two reasons a conversation is SETTLED WITHOUT A NOTE rather than deferred.
 *
 * Named rather than written inline because two separate functions now have to agree
 * on it: the stage summary that builds the report, and the run summary that re-checks
 * it before it reaches an HTTP response. A list in two places is a list that drifts.
 */
export const CONTENT_IGNORE_CODES = Object.freeze([
  'bulk_or_list_mail',   // the automation headers screened it out; no model call
  'model_ignored',       // the model read it and said there was nothing to record
])

/** Every deferral code the stage can report, terminal or retryable. */
export const CONTENT_DEFERRAL_CODES = Object.freeze(
  [...new Set([...TERMINAL_DEFERRALS, ...RETRYABLE_DEFERRALS])],
)

/**
 * The Graph folders a missing-header count can be keyed by.
 *
 * Direction is derived from the folder and not reported separately, because the two are
 * the same fact here: `inbox` is inbound and `sentitems` is outbound. Two integers, and
 * nothing else - never a header name, a value, a message id or an address.
 */
export const CONTENT_FOLDERS = Object.freeze(['inbox', 'sentitems'])

/** The integer counters a content report carries, in the names it carries them under. */
export const CONTENT_REPORT_COUNTS = Object.freeze([
  'attempted', 'notes_written', 'proposals_written',
  'metadata_only', 'bodies_read', 'model_calls',
  // CONVERSATION RECOVERY: how many one-sided threads the round asked Outlook about, how
  // many came back two-sided, and how many envelopes that took. Counts only.
  'recoveries_attempted', 'recoveries_two_sided', 'recovered_messages',
])

/**
 * The code-keyed maps a content report carries, beside the counters above.
 *
 * Named so the suites that pin the report's shape pin it against ONE list rather than
 * an inline disjunction that has to be edited in three places every time a diagnostic
 * is added. Every value in every one of these is an integer count, and every key comes
 * from an allowlist: a deferral code, an ignore code, a minimization category, a draft
 * failure code, an HTTP status, or a Graph folder.
 */
export const CONTENT_REPORT_MAPS = Object.freeze([
  'deferred', 'ignored', 'refusal_categories',
  'model_failures', 'model_http_status', 'missing_headers',
  'model_bad_request',
  // How each conversation recovery ended, by its controlled code.
  'recovery_outcomes',
])

/**
 * Read one conversation's stored handles.
 *
 * Returns the handles in the shape summarizeConversation takes. A `stale_run` or
 * `round_expired` answer is surfaced as its own code rather than as an empty list:
 * an empty list would be read as "this conversation has no content", which is a
 * different and much worse claim.
 */
export async function readConversationHandles (p) {
  const { rpc, connectionId, runId, roundId, cfp } = p || {}
  if (typeof rpc !== 'function') throw new Error('rpc_not_injected')
  const handles = []
  let cursor = null
  for (let page = 0; page < MAX_HANDLE_PAGES; page++) {
    let res
    try {
      res = await rpc(CONTENT_READ_RPC, {
        p_connection_id: connectionId,
        p_run_id: runId,
        p_round_id: roundId,
        p_cfps: [cfp],
        p_limit: 20,
        p_after_cfp: cursor?.cfp ?? null,
        p_after_sent_at: cursor?.sent_at ?? null,
        p_after_mfp: cursor?.mfp ?? null,
      })
    } catch {
      return { ok: false, code: 'rpc_threw', handles: [] }
    }
    if (res?.error) return { ok: false, code: 'rpc_error', handles: [] }
    const out = res?.data
    if (out?.result !== 'ok') {
      return { ok: false, code: typeof out?.result === 'string' ? out.result : 'unknown', handles: [] }
    }
    for (const h of Array.isArray(out.handles) ? out.handles : []) {
      if (!isPlainObject(h)) continue
      handles.push({
        mfp: typeof h.mfp === 'string' ? h.mfp : '',
        folder: h.folder === 'sentitems' ? 'sentitems' : 'inbox',
        sentAt: typeof h.sent_at === 'string' ? h.sent_at : '',
        midCt: typeof h.mid_ct === 'string' ? h.mid_ct : '',
        midNonce: typeof h.mid_nonce === 'string' ? h.mid_nonce : '',
        keyVersion: Number.isInteger(h.key_version) ? h.key_version : 1,
      })
    }
    cursor = isPlainObject(out.next_cursor) ? out.next_cursor : null
    if (cursor === null) break
  }
  return { ok: true, code: null, handles }
}

/**
 * ONE bounded Graph read, returning the shape the pass expects.
 *
 * CONTENT_SELECT already asks for the body, the unique body, the headers AND the
 * envelope in one request, so the body projection and the envelope come from the
 * same response - there is no second round trip, and no window in which the two
 * could disagree.
 */
export function makeMessageFetcher (p) {
  const { accessToken, deps, budgetAllows } = p || {}
  if (!isPlainObject(deps) || typeof deps.fetchImpl !== 'function') {
    throw new Error('fetch_not_injected')
  }
  const exec = typeof deps.executeGraphRequest === 'function'
    ? deps.executeGraphRequest
    : executeGraphRequest

  return async function fetchMessage (messageId) {
    // Shape-checked before it is put in a URL. The producer checked it too; this is
    // the boundary that actually builds the request.
    if (!isUsableGraphId(messageId)) return { ok: false, code: 'unusable_id' }
    let request
    try {
      request = buildMessageContentRequest({ messageId })
    } catch {
      return { ok: false, code: 'unusable_id' }
    }
    const res = await exec({
      request,
      accessToken,
      fetchImpl: deps.fetchImpl,
      sleepImpl: deps.sleepImpl,
      now: deps.now,
      // THE SAME INVOCATION BUDGET the pass checks before each fetch, handed to the
      // transport so its RETRIES are bounded by it too. The pass's own check admits
      // one body read; without this the transport could then spend four attempts and
      // two backoffs inside that single admission.
      budgetAllows,
    })
    if (!res?.ok) return { ok: false, code: typeof res?.code === 'string' ? res.code : 'transport_failure' }
    const content = readMessageContent(res.json, messageId)
    if (content.ok !== true) {
      return { ok: false, code: typeof content.code === 'string' ? content.code : 'malformed_response' }
    }
    const json = isPlainObject(res.json) ? res.json : {}
    const recipient = (node) => (isPlainObject(node?.emailAddress)
      ? { address: typeof node.emailAddress.address === 'string' ? node.emailAddress.address : '',
          name: typeof node.emailAddress.name === 'string' ? node.emailAddress.name : '' }
      : null)
    return {
      ok: true,
      message: {
        // from readMessageContent: the body projections and the automation facts.
        bodyContent: content.bodyContent,
        uniqueBodyContent: content.uniqueBodyContent,
        automation: content.automation,
        automationComplete: content.automationComplete,
        // from the SAME response: the envelope. readMessageContent deliberately
        // surfaces only the body and the controlled header facts, so these are read
        // here rather than widening that function's return.
        subject: typeof json.subject === 'string' ? json.subject : '',
        from: recipient(json.from) ?? recipient(json.sender),
        toRecipients: (Array.isArray(json.toRecipients) ? json.toRecipients : [])
          .map(recipient).filter((r) => r !== null),
      },
    }
  }
}

/**
 * Summarize ONE conversation with the real ports.
 *
 * @param {object} p
 * @param {object} p.conversation  { cfp, contactId, messageCount, lastLocalDate }
 * @param {Function} p.rpc
 * @param {string} p.connectionId @param {string} p.runId @param {string} p.roundId
 * @param {Function} p.decryptCursor  (ct, nonce) => plaintext
 * @param {string} p.accessToken
 * @param {string|null} p.apiKey
 * @param {string|null} p.consentVersion
 * @param {string[]} p.selfAddresses
 * @param {Function} p.budgetAllows  (marginMs) => boolean
 * @param {object} p.deps
 */
export async function summarizeOneConversation (p) {
  const {
    conversation, rpc, connectionId, runId, roundId, decryptCursor, accessToken,
    apiKey, consentVersion, selfAddresses, budgetAllows, deps, requiredConsent,
    requiresScreening,
  } = p || {}

  // ── the gates FIRST, before the handle read ──────────────────────────────
  // Not just before the body read: with the gate closed there is nothing to do with
  // a handle either, so this saves a round trip per conversation on every existing
  // connection - which is all of them.
  const perms = contentPermissions(consentVersion ?? null, requiredConsent ?? {})
  if (!perms.body) return { outcome: 'defer', reason: 'content_consent_missing', fetched: 0 }
  if (!perms.thirdParty) {
    return { outcome: 'defer', reason: 'third_party_consent_missing', fetched: 0 }
  }
  // An absent key is a CONFIGURATION fact, not a model failure, and reporting it as
  // `model_output_invalid` would send a reader looking for a prompt bug. The run
  // normally catches this once before the loop; this is the same decision at the
  // boundary, so the module is correct when called directly.
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { outcome: 'defer', reason: 'summary_key_absent', fetched: 0 }
  }

  const read = await readConversationHandles({
    rpc, connectionId, runId, roundId, cfp: conversation?.cfp,
  })
  if (read.ok !== true) {
    // NOT 'no_handles': the handles may well exist and simply could not be read.
    return { outcome: 'defer', reason: 'handles_unreadable', fetched: 0, code: read.code }
  }
  // RECOVERED HANDLES, when a one-sided conversation was completed from Outlook rather
  // than from the round's own pages (outlookConversationRecovery.js). They exist only in
  // memory for this invocation; the stored set stays the authority for any message both
  // hold. With more than the pass will fetch, the LATEST are kept - a summary is about the
  // most recent exchange - and handed over in chronological order, which is how the stored
  // set arrives. With no extras this is the unchanged read.
  const extra = Array.isArray(p?.extraHandles) ? p.extraHandles : []
  let handles = read.handles
  if (extra.length > 0) {
    const seen = new Set(read.handles.map((h) => h.mfp))
    const merged = read.handles.concat(extra.filter((h) => isPlainObject(h)
      && typeof h.mfp === 'string' && h.mfp.length > 0 && !seen.has(h.mfp)))
    merged.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))
    handles = merged.slice(0, MAX_FETCH_PER_CONVERSATION)
      .sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)))
  }

  return summarizeConversation({
    conversation,
    consentVersion: consentVersion ?? null,
    requiredConsent: requiredConsent ?? {},
    handles,
    decryptHandle: ({ ciphertext, nonce }) => decryptCursor(ciphertext, nonce),
    fetchMessage: makeMessageFetcher({ accessToken, deps, budgetAllows }),
    // STRAIGHT THROUGH, with no reshaping: the pass's port contract is this
    // function's own return shape, so there is nothing here to get wrong.
    //
    // The SAME budget function the pass uses is handed to the provider call, so its
    // retries are admitted against the real invocation deadline rather than a local
    // guess. Without it, a 429 at second 110 of a 120-second invocation would sleep
    // and then start a fresh 30-second attempt the platform was about to kill.
    callModel: ({ body }) => callDraftModel({
      body,
      apiKey,
      fetchImpl: deps?.fetchImpl,
      sleepImpl: deps?.sleepImpl,
      budgetAllows,
    }),
    apiKey,
    selfAddresses,
    budgetAllows,
    // Carried from the plan entry: an unknown person whose automation facts were
    // never read may only be proposed if THIS fetch screens clean.
    requiresScreening: requiresScreening === true,
  })
}

/**
 * Turn a pass result plus the metadata entry into the ONE write to make.
 *
 * Pure: it decides the RPC name and arguments and nothing else, so the decision is
 * testable without a database.
 *
 * ── THE METADATA FALLBACK IS SCOPED TO THE ENVELOPE-CONSENT PILOT ───────────
 * `consentOpen` says whether THIS CONNECTION is on the content release - both gates
 * matching the required disclosure version. It is NOT the same question as whether
 * the content stage ran: a connection can be on the content release and still have
 * the stage off because no provider key is configured.
 *
 * That distinction is the whole correction. A connection on the ENVELOPE-ONLY
 * disclosure gets what it gets today: the metadata candidate with no note, because
 * reading the body was never authorized and a suggestion without context is still
 * better than no suggestion at all. A connection on the CONTENT RELEASE has been
 * told it will get a summary, so a failed summary must not quietly become the exact
 * empty-note experience the release was built to fix. It is reported instead, and
 * nothing is written.
 *
 * `write: 'none'` means the conversation must NOT be marked processed when
 * `retryable` is true, and MAY be when it is false.
 *
 * @param {object} entry   the plan entry
 * @param {object} pass    the content pass result
 * @param {{consentOpen?: boolean}} [opts]
 */
export function planContentWrite (entry, pass, opts = {}) {
  const consentOpen = opts.consentOpen === true
  const base = {
    p_connection_id: null, p_run_id: null,
    p_episode_fingerprint: entry?.episodeFingerprint ?? null,
    p_person_fingerprint: entry?.personFingerprint ?? null,
    p_key_version: entry?.keyVersion ?? null,
  }
  const reason = typeof pass?.reason === 'string' ? pass.reason : null

  if (pass?.outcome === 'interaction_draft') {
    return {
      write: 'interaction_with_note',
      rpc: CONTENT_WRITE_RPCS[0],
      args: {
        ...base,
        p_contact_id: entry.contactId,
        p_proposed_type: entry.proposedType,
        p_proposed_date: pass.interactionDate ?? entry.proposedDate,
        p_lookup_fingerprints: entry.episodeLookupFingerprints?.length
          ? entry.episodeLookupFingerprints : null,
        // THE WHOLE POINT: the note the accepted interaction was missing.
        p_proposed_notes: pass.summary,
        // THE NEXT STEP AND THE PROVENANCE, which this branch used to drop. REPRODUCED IN
        // PRODUCTION on 2026-10-07: the first live content run drafted a summary AND a
        // follow-up for an existing contact, and only the summary reached the row -
        // draft_follow_up, summary_evidence and extraction_status were all NULL on the
        // candidate the owner then accepted. The new-contact branch below has carried
        // these since the content release; the two paths now agree. Each is bounded by
        // the validator (follow_up <= 160, evidence from the pair) before it gets here,
        // and the RPC refuses rather than trims. Written ONLY on a successful draft: the
        // metadata-only branch further down still passes none of them, so a closed
        // consent gate leaves every draft column NULL exactly as before.
        p_draft_follow_up: pass.followUp ?? null,
        p_summary_evidence: pass.summaryEvidence ?? null,
        p_extraction_status: pass.extractionStatus ?? 'ai_extracted',
      },
      deferral: null,
    }
  }

  if (pass?.outcome === 'new_contact_suggestion') {
    return {
      write: 'new_contact_proposal',
      rpc: CONTENT_WRITE_RPCS[1],
      args: {
        ...base,
        // FROM THE PROVIDER ENVELOPE. The draft schema has no address field; this
        // value was never read from the model's output.
        p_proposed_email: pass.proposedEmail,
        p_proposed_date: pass.interactionDate ?? entry.proposedDate,
        p_proposed_name: pass.proposedName ?? null,
        p_name_evidence: pass.proposedName ? (pass.nameEvidence ?? null) : null,
        p_name_confidence: pass.proposedName ? (pass.nameConfidence ?? null) : null,
        // The interaction travels WITH the proposal, so accepting once creates both.
        p_draft_summary: pass.summary,
        p_draft_follow_up: pass.followUp ?? null,
        p_retained_subject: pass.retainedSubject ?? null,
        // THE HONEST PROVENANCE. This summary was written by Anthropic from the
        // message bodies, and the row says so - which is what lets the review surface
        // tell a reviewer where a sentence came from.
        p_extraction_status: pass.extractionStatus ?? 'ai_extracted',
        // company, role, how_met, linkedin_url and tags are deliberately absent:
        // the RPC accepts none of them, and storing an unreviewed company is how a
        // guess ends up looking authoritative on a contact card.
      },
      deferral: null,
    }
  }

  // The model judged there is nothing worth proposing. Settled, and NOT a write:
  // a newsletter or a bulk notification should not become a pending suggestion.
  if (pass?.outcome === 'ignore') {
    return { write: 'none', rpc: null, args: null, deferral: null, ignored: reason }
  }

  // A RETRYABLE deferral: write nothing, do not pass the conversation.
  //
  // KEYED ON THE MAP, not on which list happens to be tested first. The order used to
  // decide the answer for any code that was in both lists, and `minimization_failed`
  // was - so a deterministic privacy refusal came back retryable and stalled the round
  // for good. The classes are disjoint now, which makes the order irrelevant; reading
  // the map says so in the code rather than relying on it.
  if (DEFERRAL_CLASS[reason] === 'retryable') {
    return { write: 'none', rpc: null, args: null, deferral: reason, retryable: true }
  }

  // AN ENTRY WHOSE ELIGIBILITY THE CONTENT STAGE WAS SUPPOSED TO ESTABLISH.
  // It exists only because `automation_facts_incomplete` was treated as resolvable,
  // and the stage did not resolve it. There is no evidence this exchange was with a
  // person rather than a mailing list, so NOTHING is written - a metadata fallback
  // here would be a suggestion resting on a question nobody answered. Settled, not
  // retryable: the deferral that got here is already a terminal one.
  if (entry?.requiresContent === true) {
    return {
      write: 'none', rpc: null, args: null,
      deferral: reason ?? 'no_usable_content', retryable: false,
    }
  }

  // A TERMINAL deferral.
  //
  // ON THE CONTENT RELEASE: no write. The connection was told it would get a
  // summary of what was discussed; a noteless row is the original complaint, and
  // producing one here would make the release indistinguishable from not having it.
  // Reported, and settled - the conversation is not retried, because retrying would
  // read the same mail to the same end.
  if (consentOpen) {
    return {
      write: 'none', rpc: null, args: null,
      deferral: reason ?? 'no_usable_content', retryable: false,
    }
  }

  // ON THE ENVELOPE-ONLY DISCLOSURE: exactly today's behaviour. The candidate is
  // written with NO note - never a placeholder - and the reason is reported so the
  // absence is explained rather than silent. The RPC coalesces a null note against
  // whatever is already stored, so this cannot blank a note an earlier round wrote.
  if (typeof entry?.contactId === 'string' && entry.contactId.length > 0) {
    return {
      write: 'interaction_metadata',
      rpc: CONTENT_WRITE_RPCS[0],
      args: {
        ...base,
        p_contact_id: entry.contactId,
        p_proposed_type: entry.proposedType,
        p_proposed_date: entry.proposedDate,
        p_lookup_fingerprints: entry.episodeLookupFingerprints?.length
          ? entry.episodeLookupFingerprints : null,
        p_proposed_notes: null,
      },
      deferral: reason ?? 'no_usable_content',
    }
  }

  // An unknown person with no usable summary, on either disclosure. There is
  // nothing to propose: a contact card with a bare address and no reason for
  // existing is not a suggestion, so this is reported and skipped.
  return {
    write: 'none', rpc: null, args: null,
    deferral: reason ?? 'no_usable_content', retryable: false,
  }
}

/** Counts and controlled codes only. Never a summary, address, subject or id. */
/**
 * Keys that are HTTP status codes, values that are counts.
 *
 * The allowlist is structural rather than enumerated: a key is kept only when it is a
 * three-digit integer in the range HTTP defines. That admits a status Anthropic has not
 * used yet without admitting a string.
 */
function numericKeys (o) {
  const out = Object.create(null)
  for (const [k, v] of Object.entries(isPlainObject(o) ? o : {})) {
    const n = Number(k)
    if (!Number.isInteger(n) || n < 100 || n > 599) continue
    if (!Number.isInteger(v)) continue
    out[String(n)] = v
  }
  return out
}

export function summarizeContentStage (counts) {
  const c = isPlainObject(counts) ? counts : {}
  const clean = (o, allowed) => {
    const out = Object.create(null)
    for (const [k, v] of Object.entries(isPlainObject(o) ? o : {})) {
      if (allowed.includes(k) && Number.isInteger(v)) out[k] = v
    }
    return out
  }
  return {
    attempted: Number.isInteger(c.attempted) ? c.attempted : 0,
    notes_written: Number.isInteger(c.notesWritten) ? c.notesWritten : 0,
    proposals_written: Number.isInteger(c.proposalsWritten) ? c.proposalsWritten : 0,
    metadata_only: Number.isInteger(c.metadataOnly) ? c.metadataOnly : 0,
    bodies_read: Number.isInteger(c.bodiesRead) ? c.bodiesRead : 0,
    model_calls: Number.isInteger(c.modelCalls) ? c.modelCalls : 0,
    // The explicit report of every deferral, which is what makes a missing note
    // explained rather than silent.
    deferred: clean(c.deferred, CONTENT_DEFERRAL_CODES),
    ignored: clean(c.ignored, CONTENT_IGNORE_CODES),
    // WHICH CATEGORY the privacy guard objected to, counted. These are the controlled
    // labels assertRequestMinimization returns - 'address', 'provider_id', 'token',
    // 'unserializable' - and never the offending value, which the guard does not
    // return and this never reads. It is the difference between "a request was
    // withheld" and "a request was withheld because an address was in it", which is
    // what an operator needs to tell a signature block from a leaking identifier.
    refusal_categories: clean(c.refusedCategories, MINIMIZATION_CATEGORIES),
    // WHY A MODEL CALL FAILED, by callDraftModel's own controlled code. The pass always
    // defers as `model_unavailable` - which keeps the retryability classification
    // unchanged - and that single reason was the entire diagnosis the live report
    // carried. An authentication refusal, a 400, a rate limit and a timeout are four
    // different problems with four different answers, and the code separates them.
    model_failures: clean(c.modelFailures, DRAFT_FAILURE_CODES),
    // The numeric status line, where the provider actually answered. A status is a
    // number, never a provider message or body. Absent for a transport failure or a
    // timeout, because no response existed to have one.
    model_http_status: numericKeys(c.modelStatuses),
    // WHICH SIDE of an exchange had no header collection, counted by folder. Recorded
    // on every outcome, including success: a conversation that succeeded with an absent
    // collection on one side is exactly the case the old screening rule got wrong.
    missing_headers: clean(c.missingHeaders, CONTENT_FOLDERS),
    // WHY a 400 was returned, as far as the error body could be classified. A 400 is
    // the one refusal whose cause is genuinely ambiguous - a rejected schema, an
    // unsupported parameter, an exhausted spend limit and an empty balance all arrive
    // as one status - so the category is what says which to go and fix. Controlled
    // strings only; the provider's message never reaches this map.
    model_bad_request: clean(c.badRequestCategories, DRAFT_BAD_REQUEST_CATEGORIES),
    // CONVERSATION RECOVERY. How many one-sided threads the round asked Outlook about,
    // how many came back two-sided, how many envelopes that took, and how each ended -
    // by its controlled code. `recovery_unsupported` is the one to look for after a live
    // run: it is the provider refusing the conversation filter itself.
    recoveries_attempted: Number.isInteger(c.recoveriesAttempted) ? c.recoveriesAttempted : 0,
    recoveries_two_sided: Number.isInteger(c.recoveriesTwoSided) ? c.recoveriesTwoSided : 0,
    recovered_messages: Number.isInteger(c.recoveredMessages) ? c.recoveredMessages : 0,
    recovery_outcomes: clean(c.recoveryOutcomes, RECOVERY_OUTCOME_CODES),
  }
}

/**
 * Re-check an ALREADY-SUMMARIZED content report at the last boundary before it leaves
 * the worker.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A PASS-THROUGH. summarizeRun is documented as the
 * only shape of a run result that may be logged, and it earns that by naming every
 * field it emits rather than spreading whatever it was handed. The content report is
 * built by summarizeContentStage above and is already clean; this makes that an
 * enforced property of the response rather than a property of one call site, so a
 * future producer cannot widen what ships by widening what it puts in the result.
 *
 * READ IN snake_case, DELIBERATELY. summarizeContentStage has already renamed
 * `notesWritten` to `notes_written` and so on. Reading camelCase here - which is what
 * the run's own counters beside it do, because those arrive camelCase - would match
 * nothing and emit six zeroes. That failure is worse than the dropped field it
 * replaces: a missing key reads as "not reported", while `notes_written: 0` reads as
 * "the stage ran and wrote nothing", which is a different and false claim.
 *
 * @param {unknown} report the value produced by summarizeContentStage
 * @returns {object|null} null when the run never reached the content stage
 */
export function sanitizeContentReport (report) {
  if (!isPlainObject(report)) return null
  const counts = Object.create(null)
  for (const k of CONTENT_REPORT_COUNTS) {
    counts[k] = Number.isInteger(report[k]) ? report[k] : 0
  }
  const codes = (o, allowed) => {
    const out = Object.create(null)
    for (const [k, v] of Object.entries(isPlainObject(o) ? o : {})) {
      if (allowed.includes(k) && Number.isInteger(v)) out[k] = v
    }
    return out
  }
  return {
    ...counts,
    // Controlled codes only. A reason the stage did not produce is dropped rather
    // than forwarded, so an unexpected string - a provider message, say - cannot
    // reach a response body through this field.
    deferred: codes(report.deferred, CONTENT_DEFERRAL_CODES),
    ignored: codes(report.ignored, CONTENT_IGNORE_CODES),
    refusal_categories: codes(report.refusal_categories, MINIMIZATION_CATEGORIES),
    model_failures: codes(report.model_failures, DRAFT_FAILURE_CODES),
    model_http_status: numericKeys(report.model_http_status),
    missing_headers: codes(report.missing_headers, CONTENT_FOLDERS),
    model_bad_request: codes(report.model_bad_request, DRAFT_BAD_REQUEST_CATEGORIES),
    recovery_outcomes: codes(report.recovery_outcomes, RECOVERY_OUTCOME_CODES),
  }
}

export { summarizePassResult, MAX_FETCH_PER_CONVERSATION }
