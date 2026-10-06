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
import { callDraftModel } from './outlookDraftContract.js'
import { summarizeConversation, summarizePassResult, MAX_FETCH_PER_CONVERSATION } from './outlookContentPass.js'
import { contentPermissions } from './outlookContentConsent.js'

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
 * Deferrals that are SETTLED for this round. The conversation gets the
 * metadata-only candidate it would have had anyway, the reason is reported, and
 * finalisation moves past it - retrying would read the same mail to the same end.
 */
export const TERMINAL_DEFERRALS = Object.freeze([
  'content_consent_missing',       // the gate is closed; it will not open mid-round
  'third_party_consent_missing',
  // The provider returned no header collection, so the exchange could not be
  // screened. Terminal for this round: the same fetch would answer the same way.
  'automation_unverified',
  'no_handles',                    // nothing was stored to fetch with
  'no_usable_content',             // the bodies sanitized to nothing
  'minimization_failed',           // the request would have carried something forbidden
  'ambiguous_counterparty',        // more than one external person
  'counterparty_unusable',
  'model_output_invalid',          // the response failed the strict validator
  'model_deferred',                // the model itself declined
])

/**
 * Deferrals worth another invocation. NOTHING is written and the write cursor does
 * not pass the conversation, so the next invocation redoes it from the start.
 */
export const RETRYABLE_DEFERRALS = Object.freeze([
  'budget_exhausted',
  'fetch_failed',          // a transient Graph failure, or a moved message
  'model_unavailable',     // the provider failed after its own retries
  'handles_unreadable',    // the handle RPC itself failed
  // A CONFIGURATION fact, not a property of the mail: the key is absent or the
  // request could not be built. Configuring the key makes the same conversation
  // summarizable, so the work is preserved for a retry rather than settled - which
  // is the whole difference between "come back" and "there was nothing to say".
  'summary_key_absent',
  'minimization_failed',
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

  return summarizeConversation({
    conversation,
    consentVersion: consentVersion ?? null,
    requiredConsent: requiredConsent ?? {},
    handles: read.handles,
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
  if (RETRYABLE_DEFERRALS.includes(reason)) {
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
    deferred: clean(c.deferred, [...TERMINAL_DEFERRALS, ...RETRYABLE_DEFERRALS]),
    ignored: clean(c.ignored, ['bulk_or_list_mail', 'model_ignored']),
  }
}

export { summarizePassResult, MAX_FETCH_PER_CONVERSATION }
