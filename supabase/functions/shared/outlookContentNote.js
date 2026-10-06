// THE EVIDENCE-GROUNDED DRAFT: a bounded interaction note, an optional follow-up
// line, and the refuse/defer decision for mail that must not be guessed about.
//
// WHAT "EVIDENCE-GROUNDED" MEANS HERE, EXACTLY. Every word of a note this module
// produces is derived from one of four things:
//   * the COUNTED shape of the exchange (how many messages, how many each way),
//   * the sanitized SUBJECT of the thread,
//   * the LOCAL DATE of the last message, already resolved by the caller,
//   * which side sent last.
// Nothing is inferred from body prose, and no company, role, seniority or intent
// is ever asserted. The body IS read - that is what this slice adds - but it is
// read to DECIDE (is this a real human exchange, is there usable text, is there a
// signature) and then discarded. See "WHY READ THE BODY AT ALL" below.
//
// WHY NOT THE MODEL YET. supabase/functions/shared/outlookDraftContract.js
// already carries a full Anthropic request builder, strict output validator and
// injected transport, and it is the intended home of a richer summary. It is
// deliberately NOT wired here: doing so would put an API key into Production and
// send a fragment of a real person's mail to a third party under a 30-day
// retention window, which is a separate disclosure obligation on top of the
// content-reading one. This slice earns the content consent first. The schema
// already anticipates both: extraction_status is 'deterministic' here and
// 'ai_extracted' later, so the later change adds a branch rather than a rewrite.
//
// WHY READ THE BODY AT ALL, if the note is built from counted facts? Because the
// decisions below cannot be made from an envelope:
//   * AUTOMATED AND BULK MAIL. A newsletter, a notification or a no-reply sender
//     can look exactly like a two-sided human exchange at the envelope level once
//     somebody has replied to it. emailAutomation.js reads the headers; the body
//     is what shows there is no human prose at all.
//   * NOTHING TO SUMMARIZE. An exchange whose bodies sanitize to nothing usable
//     has no note worth proposing, and proposing an empty one is what the pilot
//     already produced.
//   * A SIGNATURE BLOCK, which is the only evidence this codebase accepts for a
//     name beyond provider metadata (see NAME_EVIDENCE in outlookDraftContract).
// The raw body is never returned, never stored and never logged by this module.
//
// BOUNDS. The note must satisfy BOTH interaction_candidates.proposed_notes
// (<= 200 chars) and new_contact_candidates.ncc_summary_bounds (1..200, no
// control characters, no `https?:` or `www.`). The follow-up must satisfy
// ncc_follow_up_bounds (1..160, same character rules). Those database CHECKs are
// the authority; the constants below mirror them and the tests assert they match.

import { isBulkOrList, isNonHuman } from './emailAutomation.js'

/** Mirrors ncc_summary_bounds / interaction_candidates_proposed_notes_check. */
export const MAX_NOTE_CHARS = 200
/** Mirrors ncc_follow_up_bounds. */
export const MAX_FOLLOW_UP_CHARS = 160
/** Mirrors ncc_subject_bounds and the sanitizer's own subject ceiling. */
export const MAX_SUBJECT_CHARS = 160
/** Below this many sanitized body characters across the episode there is nothing to say. */
export const MIN_EPISODE_CONTENT_CHARS = 40

/** The only extraction statuses this slice writes. 'ai_extracted' comes later. */
export const EXTRACTION_STATUS = Object.freeze(['deterministic', 'ai_failed'])

/**
 * Every outcome this module can reach. REFUSE codes mean "never propose this";
 * DEFER codes mean "not now, ask again when more is known".
 */
export const CONTENT_REFUSALS = Object.freeze([
  'automated_sender',        // no-reply / non-human sender
  'bulk_or_list_mail',       // List-Unsubscribe, bulk precedence, newsletter
  'no_usable_content',       // bodies sanitized to nothing worth summarizing
  'subject_unusable',        // no subject survived sanitizing, so the note has no anchor
])
export const CONTENT_DEFERRALS = Object.freeze([
  'content_unread',          // a body fetch failed or was skipped; the view is partial
  'episode_truncated',       // more messages than the episode cap: the view is partial
  'ambiguous_counterparty',  // more than one external person in the exchange
])

// The same classes, and the same disable, as outlookContentSanitizer.js: matching
// control characters is the entire point here - they are exactly what the
// database CHECKs forbid, so they have to be found before a note is proposed.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g')
const URLISH_RE = /(https?:|www\.)/i

/** Strip what the database CHECKs forbid, then collapse whitespace. */
function clean (s) {
  if (typeof s !== 'string') return ''
  return s.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Cut to a ceiling on a word boundary where possible, so a note never ends
 * mid-word. Never returns a string containing a URL-ish fragment.
 */
export function boundText (s, max) {
  const t = clean(s)
  if (t.length === 0) return null
  if (URLISH_RE.test(t)) return null
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  const kept = sp > max * 0.6 ? cut.slice(0, sp) : cut
  return kept.length > 0 ? kept : null
}

/**
 * A subject safe to put in a note and to retain on the candidate.
 *
 * A subject can itself carry a URL (and plenty do), which the summary CHECK
 * forbids outright. Rather than refuse the whole exchange for that, the URL-ish
 * run is removed and what remains is used; if nothing usable remains the caller
 * gets null and refuses with `subject_unusable`.
 */
export function noteSafeSubject (raw) {
  let t = clean(raw)
  if (t.length === 0) return null
  // Drop any token that looks like a link, then re-collapse.
  t = t.split(' ').filter((w) => !URLISH_RE.test(w)).join(' ')
  t = clean(t).replace(/^(re|fw|fwd)\s*:\s*/i, '').trim()
  if (t.length === 0) return null
  return boundText(t, MAX_SUBJECT_CHARS)
}

/**
 * Should this exchange be refused or deferred before anything is proposed?
 *
 * Order matters. Automated and bulk mail are REFUSALS and are checked first:
 * they are a settled answer, and deferring them would re-read the same mail for
 * ever. Partial views are DEFERRALS, because more of the exchange may arrive.
 *
 * @param {object} p
 * @param {Array<object>} p.messages        provider envelopes, for the header checks
 * @param {number} p.externalParticipants   distinct external people in the episode
 * @param {boolean} p.episodeTruncated      the episode hit its message cap
 * @param {number} p.contentFetchesFailed   bodies the transport could not read
 * @param {number} p.sanitizedChars         total sanitized body characters kept
 * @param {string|null} p.subject           the sanitized thread subject
 */
export function classifyExchange (p) {
  const messages = Array.isArray(p?.messages) ? p.messages : []

  // REFUSALS first: settled, and never worth re-reading.
  //
  // The two header checks have DIFFERENT documented meanings in
  // emailAutomation.js, and conflating them would be wrong in opposite
  // directions:
  //   * isBulkOrList is an EPISODE hard-reject (List-Id, List-Unsubscribe,
  //     bulk/list/junk precedence). One such message condemns the thread, because
  //     a human replying to a newsletter does not make it an exchange.
  //   * isNonHuman means EXCLUDE THIS MESSAGE from human counts. A single
  //     out-of-office auto-reply inside a genuine thread must not condemn it, so
  //     this refuses only when there is no human message at all.
  for (const m of messages) {
    if (isBulkOrList(m)) return { decision: 'refuse', code: 'bulk_or_list_mail' }
  }
  if (messages.length > 0 && messages.every((m) => isNonHuman(m))) {
    return { decision: 'refuse', code: 'automated_sender' }
  }

  // DEFERRALS: the view is incomplete, so any proposal would rest on part of it.
  if (p?.episodeTruncated === true) {
    return { decision: 'defer', code: 'episode_truncated' }
  }
  if (Number.isInteger(p?.contentFetchesFailed) && p.contentFetchesFailed > 0) {
    return { decision: 'defer', code: 'content_unread' }
  }
  // More than one external person: which of them the proposal is ABOUT is a guess,
  // and guessing would attach an exchange to the wrong person.
  if (Number.isInteger(p?.externalParticipants) && p.externalParticipants > 1) {
    return { decision: 'defer', code: 'ambiguous_counterparty' }
  }

  // REFUSALS that need the body: there is simply nothing to summarize.
  const chars = Number.isInteger(p?.sanitizedChars) ? p.sanitizedChars : 0
  if (chars < MIN_EPISODE_CONTENT_CHARS) {
    return { decision: 'refuse', code: 'no_usable_content' }
  }
  if (noteSafeSubject(p?.subject) === null) {
    return { decision: 'refuse', code: 'subject_unusable' }
  }
  return { decision: 'propose', code: null }
}

/**
 * The note. Built from counted facts and the subject, never from body prose.
 *
 * Shape, with the parts that have evidence behind them:
 *   Email thread "<subject>". <N> messages, <N in> from them and <N out> from
 *   you. Last on <date>, <from them|from you>.
 *
 * Trimmed from the right as the ceiling requires, so the subject - the most
 * useful part - survives. Returns null when nothing within bounds can be built,
 * which the caller treats as `no_usable_content` rather than storing an empty
 * note (the defect the pilot actually produced).
 *
 * @param {object} p
 * @param {string} p.subject         sanitized thread subject
 * @param {number} p.inbound         messages from the counterparty
 * @param {number} p.outbound        messages from the account
 * @param {string} p.lastLocalDate   YYYY-MM-DD, already resolved in the user's zone
 * @param {'inbound'|'outbound'} p.lastDirection
 */
export function buildInteractionNote (p) {
  const subject = noteSafeSubject(p?.subject)
  if (subject === null) return null
  const inbound = Number.isInteger(p?.inbound) && p.inbound > 0 ? p.inbound : 0
  const outbound = Number.isInteger(p?.outbound) && p.outbound > 0 ? p.outbound : 0
  const total = inbound + outbound
  if (total === 0) return null
  const date = typeof p?.lastLocalDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.lastLocalDate)
    ? p.lastLocalDate : null

  const who = p?.lastDirection === 'outbound' ? 'from you'
    : p?.lastDirection === 'inbound' ? 'from them' : null

  // Most useful first, so truncation drops the least useful tail.
  const parts = [`Email thread "${subject}".`]
  parts.push(total === 1
    ? '1 message.'
    : `${total} messages, ${inbound} from them and ${outbound} from you.`)
  if (date !== null) parts.push(who ? `Last on ${date}, ${who}.` : `Last on ${date}.`)

  let note = clean(parts.join(' '))
  while (note.length > MAX_NOTE_CHARS && parts.length > 1) {
    parts.pop()
    note = clean(parts.join(' '))
  }
  // The subject alone can still exceed the ceiling; bound it rather than drop it.
  if (note.length > MAX_NOTE_CHARS) note = boundText(note, MAX_NOTE_CHARS) ?? ''
  return note.length > 0 ? note : null
}

/**
 * The optional follow-up line. Proposed for ONE situation only, because it is
 * the only one the counted evidence actually supports: THEY wrote last, so a
 * reply is outstanding. When the account wrote last, nothing is owed and
 * inventing a nudge would be a guess.
 *
 * Returns null when no follow-up is warranted. A null is not a failure.
 */
export function buildFollowUp (p) {
  if (p?.lastDirection !== 'inbound') return null
  const subject = noteSafeSubject(p?.subject)
  const base = subject === null
    ? 'Reply to their last message.'
    : `Reply to their last message on "${subject}".`
  return boundText(base, MAX_FOLLOW_UP_CHARS)
}

/**
 * The whole decision for one episode, as one call: refuse, defer, or a complete
 * draft ready to be written.
 *
 * Returns one of:
 *   { kind: 'refuse', code }
 *   { kind: 'defer',  code }
 *   { kind: 'draft',  note, followUp, retainedSubject, extractionStatus }
 *
 * NO RAW CONTENT IS RETURNED. The caller is handed a note, a follow-up and a
 * bounded subject; the sanitized text it passed in is not echoed back, so there
 * is nothing for it to accidentally persist.
 */
export function draftFromEpisode (p) {
  const verdict = classifyExchange(p)
  if (verdict.decision !== 'propose') {
    return { kind: verdict.decision, code: verdict.code }
  }
  const note = buildInteractionNote(p)
  if (note === null) return { kind: 'refuse', code: 'no_usable_content' }
  return {
    kind: 'draft',
    note,
    followUp: buildFollowUp(p),
    retainedSubject: noteSafeSubject(p?.subject),
    extractionStatus: 'deterministic',
  }
}
