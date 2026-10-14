// Paste-email capture: the browser-side decisions, pure and injectable.
//
// The server (ai-paste-email) returns the addresses it found, a date decision, an optional
// contact-field proposal and an optional note draft. Everything here decides what the REVIEWER
// sees and what is saved - and nothing is saved without the reviewer pressing Save.
//
// RULES (owner-approved scope)
//   * ATTRIBUTION IS NEVER ASSUMED. Capture started from a contact's page uses that contact.
//     Otherwise the reviewer must choose the person. Funnl's login address is NOT treated as
//     the user's mailbox identity, and a found address only produces a SUGGESTION to choose.
//   * The AI proposes one record PER PERSON in the thread. Its fields reach the form only when
//     the reviewer chooses "new contact" AND picks which person that is; they are never
//     written onto an existing contact, and an address is never matched to a record.
//   * A date is prefilled only when the server classed it 'clear'; anything else stays blank
//     and required.
//   * Saving is idempotent: a contact created by an earlier attempt is remembered and reused,
//     so a retry never creates a second one, and a submission in flight blocks another.

export const MAX_NOTE_CHARS = 10_000
/** Mirrors MAX_PASTE_CHARS in supabase/functions/shared/pasteEmail.js. */
export const MAX_PASTE_CHARS = 12_000
export const PASTE_FUNCTION = 'ai-paste-email'

/**
 * Call the Edge Function. Returns the server's JSON or a controlled error code. Never logs.
 * @param {{functions:{invoke:Function}}} client
 */
export async function requestPasteDraft (client, text) {
  let res
  try {
    res = await client.functions.invoke(PASTE_FUNCTION, { body: { text } })
  } catch {
    return { ok: false, code: 'network' }
  }
  if (res?.error) {
    let code = 'unexpected'
    try {
      const body = await res.error.context?.json?.()
      if (body && typeof body.code === 'string') code = body.code
    } catch { /* not JSON */ }
    return { ok: false, code }
  }
  if (!res?.data || res.data.code !== 'ok') return { ok: false, code: 'unexpected' }
  return { ok: true, data: res.data }
}

/** What each server code means to the person pasting. No server text is ever shown. */
export function messageForPasteCode (code) {
  switch (code) {
    case 'pro_required': return 'Paste an email is a Pro feature.'
    case 'too_long':
    case 'request_too_large':
      return 'That is too long to process. Paste just the part of the email you want to record.'
    case 'bad_type': return 'Funnl could not read that text. Paste it again and retry.'
    case 'empty': return 'Paste an email first.'
    case 'minimization_refused':
      return 'Funnl could not send this safely: something in it still looks like an email address or an access token after Funnl removed the addresses it recognised. Remove it from the text and try again.'
    case 'entitlement_unavailable': return 'Funnl could not check your Pro access just now. Please try again.'
    case 'drafting_failed': return 'Funnl could not draft anything from this email. Try again, or log it by hand.'
    case 'not_authenticated': return 'Your session has ended. Sign in again, then retry.'
    case 'network': return 'Could not reach Funnl. Check your connection and try again.'
    default: return 'Something went wrong. Please try again.'
  }
}

/**
 * Who could this be? Each found address with the contacts whose email equals it (case-
 * insensitively). A suggestion list only: nothing is selected from it automatically.
 * @param {Array<{address:string,inHeader:boolean}>} addresses
 * @param {Array<{id:string,name:string,email?:string|null}>} contacts
 */
export function matchAddressesToContacts (addresses, contacts) {
  const byEmail = new Map()
  for (const c of Array.isArray(contacts) ? contacts : []) {
    const e = typeof c?.email === 'string' ? c.email.trim().toLowerCase() : ''
    if (!e) continue
    if (!byEmail.has(e)) byEmail.set(e, [])
    byEmail.get(e).push({ id: c.id, name: c.name })
  }
  return (Array.isArray(addresses) ? addresses : []).map((a) => ({
    address: a.address,
    inHeader: a.inHeader === true,
    matches: byEmail.get(String(a.address).toLowerCase()) ?? [],
  }))
}

/**
 * The starting attribution state for the review step.
 *   preselected  capture began on this contact's page: use it.
 *   otherwise    the reviewer must confirm a person; nothing is preselected.
 * `warning` flags a preselected contact whose saved email is absent from the paste while the
 * paste does contain addresses - worth a second look, never a silent change.
 */
export function initialAttribution ({ preselectedContactId = null, addresses = [], contacts = [] }) {
  const candidates = matchAddressesToContacts(addresses, contacts)
  if (preselectedContactId) {
    const c = (contacts || []).find((x) => x.id === preselectedContactId)
    const email = typeof c?.email === 'string' ? c.email.trim().toLowerCase() : ''
    const warning = email && candidates.length > 0 && !candidates.some((x) => x.address === email)
      ? 'preselected_not_in_paste'
      : null
    return { person: { kind: 'existing', contactId: preselectedContactId }, requireConfirmation: false, candidates, warning }
  }
  return { person: null, requireConfirmation: true, candidates, warning: null }
}

/**
 * The date field's starting value and the note shown beside it.
 * @param {{status:string, kind?:string, value?:string, reason?:string}} date  server decision
 * @param {string} timeZone  the reviewer's IANA time zone
 */
export function resolveInteractionDate (date, timeZone) {
  if (date?.status === 'clear' && date.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(date.value)) {
    return { value: date.value, note: 'From the date written in the email. Check it.' }
  }
  if (date?.status === 'clear' && date.kind === 'instant' && typeof date.value === 'string') {
    const d = new Date(date.value)
    if (!Number.isNaN(d.getTime())) {
      try {
        const value = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { value, note: 'From the email\'s date header, in your time zone. Check it.' }
      } catch { /* invalid time zone: fall through to blank */ }
    }
  }
  const reason = date?.status === 'ambiguous' ? date.reason : null
  const note = {
    multiple_dates: 'This email has more than one date. Choose the date of the conversation you are logging.',
    quoted_history: 'This email includes earlier or forwarded messages, so its dates may not be this conversation\'s. Choose the date.',
    no_timezone: 'The email\'s date has no time zone, so the day could differ for you. Choose the date.',
    numeric_format: 'The email\'s date could be read more than one way. Choose the date.',
  }[reason] ?? 'Choose the date of this conversation.'
  return { value: '', note }
}

/** The people the server proposed, as choices. Order is the server's; nothing is preselected. */
export function personOptions (contact) {
  const people = Array.isArray(contact?.people) ? contact.people : []
  return people
    .map((p, index) => ({ index, name: typeof p?.fields?.name === 'string' ? p.fields.name : '' }))
    .filter((o) => o.name.length > 0)
}

const AI_KEYS = ['name', 'company', 'role', 'how_met', 'linkedin_url', 'relationship_note']

/**
 * The new-contact form after the reviewer picks a proposed person: that person's fields and
 * NOTHING from anyone else. A field the server left out stays blank for the reviewer. Passing
 * no person clears every AI field ("someone not listed"). The chosen email is kept: it is the
 * reviewer's own choice from the addresses found, never matched to a person by Funnl.
 */
export function applyPerson (draft, person) {
  const f = person?.fields ?? {}
  const next = { ...draft }
  for (const k of AI_KEYS) next[k] = typeof f[k] === 'string' ? f[k] : ''
  next.tags = Array.isArray(f.tags) ? [...f.tags] : []
  return next
}

/** Plain-language notes about a PARTIAL draft, so a missing half is never silent. */
export function draftNotices (data) {
  const out = []
  if (data?.note_code && data.note_code !== 'ok') {
    out.push(data.note_code === 'note_ignore' || data.note_code === 'note_defer'
      ? 'Funnl did not find a conversation to summarise, so the note is empty. Write it yourself, or go back and try again.'
      : 'Funnl could not draft the note from this email. Write it yourself, or go back and try again.')
  }
  if (data?.contact_code && data.contact_code !== 'ok') {
    out.push('Funnl could not identify anyone\u2019s details in this email. You can still choose a contact or fill in a new one yourself.')
  }
  return out
}

function normalizeUrl (url) {
  const t = (url ?? '').trim()
  if (!t) return null
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

/** The contacts row, in the same shape AddContactDrawer saves. */
export function buildContactPayload (draft) {
  const tags = Array.isArray(draft?.tags)
    ? draft.tags.map((t) => String(t).trim()).filter(Boolean)
    : String(draft?.tagsInput ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  return {
    name: String(draft?.name ?? '').trim(),
    company: draft?.company?.trim() || null,
    role: draft?.role?.trim() || null,
    how_met: draft?.how_met?.trim() || null,
    email: draft?.email?.trim() || null,
    linkedin_url: normalizeUrl(draft?.linkedin_url),
    tags: tags.length > 0 ? tags : null,
    relationship_type: null,
    relationship_note: draft?.relationship_note?.trim() || null,
  }
}

/** What stops a save, as reviewer-facing messages. Empty when the review is complete. */
export function reviewErrors ({ person, contactDraft, interaction }) {
  const errors = []
  if (!person) errors.push('Choose who this email is with.')
  if (person?.kind === 'new' && !String(contactDraft?.name ?? '').trim()) errors.push('Enter the new contact\'s name.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(interaction?.date ?? '')) errors.push('Choose the date of this conversation.')
  if (String(interaction?.notes ?? '').length > MAX_NOTE_CHARS) errors.push(`Keep the note under ${MAX_NOTE_CHARS.toLocaleString('en-US')} characters.`)
  return errors
}

/**
 * The save controller. One per review session.
 *   deps.insertContact(payload)     -> Promise<{id:string} | {error:any}>
 *   deps.insertInteraction(payload) -> Promise<{ok:true} | {error:any}>
 *
 * - A second save while one is in flight returns {status:'busy'} and touches nothing.
 * - A contact created by an earlier attempt is REUSED on retry; it is never created twice,
 *   and once it exists the interaction is always attached to it.
 * - The result says exactly what was saved: contactSaved / interactionSaved.
 */
export function createPasteSaver (deps) {
  const state = { inFlight: false, createdContactId: null, contactSaved: false, interactionSaved: false }

  async function save ({ person, contactDraft, interaction }) {
    if (state.inFlight) return { status: 'busy', ...snapshot() }
    if (state.interactionSaved) return { status: 'already_saved', ...snapshot() }
    const errors = reviewErrors({ person: state.createdContactId ? { kind: 'existing', contactId: state.createdContactId } : person, contactDraft, interaction })
    if (errors.length > 0) return { status: 'invalid', errors, ...snapshot() }

    state.inFlight = true
    try {
      let contactId = state.createdContactId ?? (person.kind === 'existing' ? person.contactId : null)
      if (!contactId) {
        const r = await deps.insertContact(buildContactPayload(contactDraft))
        if (!r || r.error || !r.id) return { status: 'contact_failed', ...snapshot() }
        state.createdContactId = r.id
        state.contactSaved = true
        contactId = r.id
      }
      const r2 = await deps.insertInteraction({
        contact_id: contactId,
        type: 'Email',
        interaction_date: interaction.date,
        notes: String(interaction.notes ?? '').trim() || null,
        follow_up_date: interaction.followUpDate || null,
      })
      if (!r2 || r2.error) return { status: 'interaction_failed', contactId, ...snapshot() }
      state.interactionSaved = true
      return { status: 'saved', contactId, ...snapshot() }
    } catch {
      return { status: state.contactSaved ? 'interaction_failed' : 'contact_failed', ...snapshot() }
    } finally {
      state.inFlight = false
    }
  }

  function snapshot () {
    return { contactSaved: state.contactSaved, interactionSaved: state.interactionSaved, createdContactId: state.createdContactId }
  }

  return { save, snapshot, isBusy: () => state.inFlight }
}

/** Plain-language status of a save attempt, naming what was and was not saved. */
export function messageForSave (r) {
  if (!r) return ''
  switch (r.status) {
    case 'saved': return r.contactSaved ? 'Saved: the new contact and the interaction.' : 'Saved: the interaction.'
    case 'interaction_failed':
      return r.contactSaved
        ? 'The new contact was saved, but the interaction was not. Save again to add the interaction to that contact; another contact will not be created.'
        : 'The interaction was not saved. Nothing was changed. Try again.'
    case 'contact_failed': return 'The contact was not saved, so the interaction was not saved either. Try again.'
    case 'busy': return 'Already saving…'
    case 'already_saved': return 'This email is already saved.'
    default: return ''
  }
}
