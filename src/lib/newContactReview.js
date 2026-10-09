// Reviewing a PROPOSED CONTACT and the interaction that comes with it.
//
// WHY A SEPARATE MODULE. `calendarReview.js` reviews an interaction against a contact
// that already exists. This reviews a person who does not exist in Funnl yet, so the
// review surface has to show two things at once - who they are, and what the exchange
// was - and one acceptance has to create both or neither.
//
// PURE. No React, no Supabase, no `import.meta.env`. Every function here is a plain
// value transform, so it can be unit-tested in Node and so the page cannot smuggle a
// policy decision into a component.
//
// ── WHAT THE USER MAY CHANGE, AND WHAT THEY MAY NOT ──────────────────────────
// Everything about the person is editable: a proposal is a draft, and the whole point
// of the review step is that a human corrects it. The EMAIL ADDRESS is the exception,
// and it is not editable here at all - `accept_new_contact_candidate` reads it from
// the stored candidate row and ignores any caller value, because that address came
// from the provider's envelope and is the one piece of the proposal that was not
// inferred. Showing it read-only is therefore honest rather than restrictive: the UI
// cannot change it, so it must not pretend to.

/**
 * Review-safe columns only. Mirrors the GRANT SELECT list on the table, minus the
 * lifecycle bookkeeping a reviewer has no use for.
 *
 * `user_id`, both fingerprints, `key_version` and `context_expires_at` are NOT
 * selectable by `authenticated` at all, so asking for one would fail the whole query.
 */
export const NCC_SELECT = [
  'id', 'source', 'status',
  'proposed_email', 'proposed_name', 'proposed_name_evidence', 'proposed_name_confidence',
  'draft_summary', 'draft_follow_up', 'proposed_interaction_date', 'proposed_type',
  'retained_subject', 'extraction_status', 'created_at', 'updated_at',
].join(', ')

/** The interaction types the DB CHECK accepts. */
export const NCC_INTERACTION_TYPES = Object.freeze([
  'Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other',
])

/** The relationship types the contact form offers, and the RPC accepts. */
export const RELATIONSHIP_TYPES = Object.freeze([
  'Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other',
])

/** Bounds, mirroring accept_new_contact_candidate exactly. */
export const NCC_BOUNDS = Object.freeze({
  name: 120,
  company: 120,
  role: 120,
  howMet: 120,
  linkedin: 255,
  relationshipNote: 500,
  // The INTERACTION note, which is `interaction_candidates.proposed_notes`-shaped and
  // therefore 200, not 500. A reviewer who pastes a long note gets told so here
  // rather than after a round trip.
  notes: 200,
  tags: 20,
  tag: 60,
})

// BUILT FROM CHAR CODES, NOT ESCAPES. Written as /[\u0000-\u001F\u007F]/ the
// escapes were materialized into RAW CONTROL BYTES in this file - the regex still
// worked, since a literal control byte in a character class matches itself, so every
// test passed while the file read as binary and showed up in no diff. Constructed
// this way there is no escape sequence for an editor to turn into a byte, and a
// byte-level scan of this file is part of the test suite.
const CONTROL_RE = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31)
       + String.fromCharCode(127) + ']')
const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_%.-]+\/?$/

const blankToNull = (v) => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length === 0 ? null : t
}

/**
 * Split a comma-separated tag input into the array the RPC takes.
 * Empty entries are dropped rather than sent as '' , which the RPC rejects.
 */
export function parseTags (raw) {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter((t) => t.length > 0)
  if (typeof raw !== 'string') return []
  return raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
}

/**
 * Validate the reviewed proposal before calling accept. Mirrors the server's checks
 * so the reviewer gets an immediate, controlled message instead of a round trip.
 *
 * @returns {{ok:true}|{ok:false, code:string}}
 */
export function validateProposal (o = {}) {
  const name = blankToNull(o.name)
  if (name === null) return { ok: false, code: 'invalid_name' }
  if (name.length > NCC_BOUNDS.name || CONTROL_RE.test(name)) return { ok: false, code: 'invalid_name' }

  for (const [field, code, max] of [
    ['company', 'invalid_company', NCC_BOUNDS.company],
    ['role', 'invalid_role', NCC_BOUNDS.role],
    ['howMet', 'invalid_how_met', NCC_BOUNDS.howMet],
    ['relationshipNote', 'invalid_relationship_note', NCC_BOUNDS.relationshipNote],
  ]) {
    const v = blankToNull(o[field])
    if (v !== null && (v.length > max || CONTROL_RE.test(v))) return { ok: false, code }
  }

  const linkedin = blankToNull(o.linkedin)
  if (linkedin !== null
      && (linkedin.length > NCC_BOUNDS.linkedin || !LINKEDIN_RE.test(linkedin))) {
    return { ok: false, code: 'invalid_linkedin_url' }
  }

  const tags = parseTags(o.tags)
  if (tags.length > NCC_BOUNDS.tags
      || tags.some((t) => t.length > NCC_BOUNDS.tag || CONTROL_RE.test(t))) {
    return { ok: false, code: 'invalid_tags' }
  }

  const rel = blankToNull(o.relationshipType)
  if (rel !== null && !RELATIONSHIP_TYPES.includes(rel)) {
    return { ok: false, code: 'invalid_relationship_type' }
  }

  // The interaction is OPTIONAL: a reviewer may want the person without logging the
  // exchange. When it is included, its own fields are checked.
  if (o.createInteraction !== false) {
    if (!NCC_INTERACTION_TYPES.includes(o.interactionType)) return { ok: false, code: 'invalid_type' }
    if (typeof o.interactionDate !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(o.interactionDate)) {
      return { ok: false, code: 'invalid_date' }
    }
    const notes = blankToNull(o.interactionNotes)
    if (notes !== null && (notes.length > NCC_BOUNDS.notes || CONTROL_RE.test(notes))) {
      return { ok: false, code: 'invalid_notes' }
    }
    const follow = blankToNull(o.followUpDate)
    if (follow !== null && !/^\d{4}-\d{2}-\d{2}$/.test(follow)) {
      return { ok: false, code: 'invalid_follow_up_date' }
    }
  }
  return { ok: true }
}

/**
 * The exact RPC arguments for one reviewed proposal.
 *
 * Note what is NOT here: `p_proposed_email`. The address is read from the stored
 * candidate by the RPC, so this cannot send one even by mistake.
 */
export function acceptArgs (candidateId, o = {}) {
  const createInteraction = o.createInteraction !== false
  const tags = parseTags(o.tags)
  return {
    p_candidate_id: candidateId,
    p_name: blankToNull(o.name),
    p_company: blankToNull(o.company),
    p_role: blankToNull(o.role),
    p_how_met: blankToNull(o.howMet),
    p_linkedin_url: blankToNull(o.linkedin),
    p_tags: tags.length > 0 ? tags : null,
    p_relationship_type: blankToNull(o.relationshipType),
    p_relationship_note: blankToNull(o.relationshipNote),
    p_create_interaction: createInteraction,
    p_interaction_type: createInteraction ? o.interactionType : null,
    p_interaction_date: createInteraction ? o.interactionDate : null,
    p_interaction_notes: createInteraction ? blankToNull(o.interactionNotes) : null,
    p_follow_up_date: createInteraction ? blankToNull(o.followUpDate) : null,
  }
}

/**
 * Every result code accept_new_contact_candidate can return, mapped to what the
 * reviewer is told and whether the row leaves the queue.
 *
 * `duplicate_email` leaves the queue: the person IS already in Funnl, so the proposal
 * has been answered - just not by creating anything.
 */
const ACCEPT_OUTCOMES = Object.freeze({
  accepted: { removeFromQueue: true, message: 'Contact and interaction saved.' },
  already_accepted: { removeFromQueue: true, message: 'Already saved.' },
  duplicate_email: { removeFromQueue: true, message: 'You already have a contact with this email.' },
  dismissed: { removeFromQueue: true, message: 'This suggestion was dismissed.' },
  invalidated: { removeFromQueue: true, message: 'This suggestion is no longer available.' },
  expired: { removeFromQueue: true, message: 'This suggestion has expired.' },
  not_found: { removeFromQueue: true, message: 'This suggestion is no longer available.' },
  unauthenticated: { removeFromQueue: false, message: 'Please sign in again.' },
  conflict: { removeFromQueue: false, message: 'Something else was saving at the same time - try again.' },
  write_failed: { removeFromQueue: false, message: 'Could not save. Nothing was created - try again.' },
  invalid_name: { removeFromQueue: false, message: 'Enter a name (up to 120 characters).' },
  invalid_company: { removeFromQueue: false, message: 'Company is too long (up to 120 characters).' },
  invalid_role: { removeFromQueue: false, message: 'Role is too long (up to 120 characters).' },
  invalid_how_met: { removeFromQueue: false, message: 'How you met is too long (up to 120 characters).' },
  invalid_linkedin_url: { removeFromQueue: false, message: 'Enter a LinkedIn profile URL, or leave it blank.' },
  invalid_tags: { removeFromQueue: false, message: 'Up to 20 tags, each up to 60 characters.' },
  invalid_relationship_type: { removeFromQueue: false, message: 'Choose a relationship from the list.' },
  invalid_relationship_note: { removeFromQueue: false, message: 'That note is too long (up to 500 characters).' },
  invalid_type: { removeFromQueue: false, message: 'Choose an interaction type from the list.' },
  invalid_date: { removeFromQueue: false, message: 'Enter a valid interaction date.' },
  invalid_notes: { removeFromQueue: false, message: 'That note is too long (up to 200 characters).' },
  invalid_follow_up_date: { removeFromQueue: false, message: 'Enter a valid follow-up date, or leave it blank.' },
  invalid_email: { removeFromQueue: true, message: 'This suggestion is missing an email address.' },
})

const DISMISS_OUTCOMES = Object.freeze({
  dismissed: { removeFromQueue: true, message: 'Suggestion dismissed.' },
  already_dismissed: { removeFromQueue: true, message: 'Suggestion dismissed.' },
  accepted: { removeFromQueue: true, message: 'Already saved.' },
  invalidated: { removeFromQueue: true, message: 'This suggestion is no longer available.' },
  not_found: { removeFromQueue: true, message: 'This suggestion is no longer available.' },
  unauthenticated: { removeFromQueue: false, message: 'Please sign in again.' },
})

const FALLBACK = Object.freeze({
  removeFromQueue: false,
  message: 'Something went wrong. Nothing was created - try again.',
})

/** Known code -> outcome. An unknown code NEVER removes the row from the queue. */
export function acceptOutcome (code) {
  return ACCEPT_OUTCOMES[code] ?? FALLBACK
}

export function dismissOutcome (code) {
  return DISMISS_OUTCOMES[code] ?? FALLBACK
}

/** Every accept code, exported so a test can prove the map is exhaustive. */
export const ACCEPT_CODES = Object.freeze(Object.keys(ACCEPT_OUTCOMES))
export const DISMISS_CODES = Object.freeze(Object.keys(DISMISS_OUTCOMES))

/**
 * The initial, UNEDITED review state for one candidate row.
 *
 * Only the two fields the write path actually stores are prefilled - the name and the
 * interaction. company, role, how_met, linkedin and tags start BLANK, because nothing
 * stored them: the content pass deliberately drops them rather than persist a value
 * nobody reviewed. A blank field the reviewer may fill is honest; a prefilled guess
 * that looks authoritative on a contact card is not.
 */
export function initialReviewState (row = {}) {
  return {
    name: typeof row.proposed_name === 'string' ? row.proposed_name : '',
    company: '',
    role: '',
    howMet: '',
    linkedin: '',
    tags: '',
    relationshipType: '',
    relationshipNote: '',
    createInteraction: true,
    interactionType: NCC_INTERACTION_TYPES.includes(row.proposed_type) ? row.proposed_type : 'Email',
    interactionDate: typeof row.proposed_interaction_date === 'string'
      ? row.proposed_interaction_date : '',
    interactionNotes: typeof row.draft_summary === 'string' ? row.draft_summary : '',
    followUpDate: '',
  }
}

/** True when the reviewer changed anything the write will carry. */
export function proposalEdited (row, state) {
  const initial = initialReviewState(row)
  for (const k of Object.keys(initial)) {
    if (String(state?.[k] ?? '') !== String(initial[k])) return true
  }
  return false
}

/**
 * How a name was arrived at, in words a reviewer can act on.
 *
 * `provider_metadata` is the display name Microsoft attached to the address - it was
 * not inferred from anything that was said, and saying so is the difference between
 * a reviewer trusting it and a reviewer checking it.
 */
export function evidenceLabel (evidence) {
  if (evidence === 'explicit_signature') return 'from their signature'
  if (evidence === 'explicit_body') return 'from the message'
  if (evidence === 'provider_metadata') return 'from the email account name'
  return null
}

/** Whether the shown summary came from the body or is absent. */
export function summaryPresent (row) {
  return typeof row?.draft_summary === 'string' && row.draft_summary.trim().length > 0
}
