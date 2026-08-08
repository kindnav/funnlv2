// Pure functions for interaction form logic.
// No React / Supabase imports — safe to unit-test in plain Node.js.

/**
 * Returns true when the first-contact navigation flow should trigger.
 *
 * contactCountBefore: contact count from React state captured before the
 *   insert (i.e. the pre-insert snapshot — 0 when this is the first contact).
 * newId: the UUID returned by the insert, or null on failure.
 *
 * Logic: if count was 0 and we have a real ID, this is the first-ever contact
 * and we should navigate to its detail page with the interaction form open.
 */
export function isFirstContactNavigation(contactCountBefore, newId) {
  return contactCountBefore === 0 && Boolean(newId)
}

/**
 * Returns true when the AI Fill section should be rendered.
 *
 * proClass: string returned by classifyProStatus() — one of:
 *   'permanent' | 'trial' | 'expired' | 'non_pro' | 'unavailable'
 * isEditMode: true when editing an existing contact.
 *
 * Fails closed: loading (null proStatus) maps to 'unavailable' in
 * classifyProStatus, which returns false here. Any unrecognised value
 * also returns false.
 */
export function shouldShowAIFill(proClass, isEditMode) {
  if (isEditMode) return false
  return proClass === 'permanent' || proClass === 'trial'
}

/**
 * Returns the outreach fields to reset when the interaction type changes.
 *
 * Coffee chat and Event hide outreach controls entirely — switching to them
 * must clear any pending outreach state so stale values are never persisted.
 * Switching to or between Email, Message, Call, Other preserves existing state.
 *
 * Returns { trackOutreach: false, outreachStatus: '' } when a reset is needed,
 * null otherwise.
 *
 * @deprecated Use typeChangeFields(prevType, newType) in production code.
 * This function remains for backward-compatibility with existing tests.
 */
export function outreachResetOnTypeChange(newType) {
  if (newType === 'Coffee chat' || newType === 'Event') {
    return { trackOutreach: false, outreachStatus: '' }
  }
  return null
}

/**
 * Returns the outreach fields to reset when the interaction type changes.
 *
 * Any actual type change must clear trackOutreach and outreachStatus so
 * stale values from the previous type are never shown or persisted.
 * Returns null when the type did not change (same-type re-selection).
 *
 * prevType: the type currently rendered in the form.
 * newType:  the type the user just selected.
 *
 * Returns { trackOutreach: false, outreachStatus: '' } on change, null on no-op.
 */
export function typeChangeFields(prevType, newType) {
  if (prevType === newType) return null
  return { trackOutreach: false, outreachStatus: '' }
}

/**
 * Derives the initial trackOutreach checkbox state when the edit form opens.
 *
 * Email / Message interactions: the checkbox is checked when a saved
 *   outreach status exists (so the status select is visible on open).
 * All other types: the checkbox concept doesn't apply — always false.
 *
 * type: the interaction's current type string.
 * savedOutreachStatus: the value from the database (may be null / empty string).
 */
export function initEditTrackOutreach(type, savedOutreachStatus) {
  if (type === 'Email' || type === 'Message') {
    return Boolean(savedOutreachStatus)
  }
  return false
}

/**
 * Returns the contact-detail route string for the "View existing" action in
 * the duplicate warning. Returns null when contactId is falsy.
 *
 * contactId: the `id` field from the matched duplicate contact object.
 */
export function viewExistingRoute(contactId) {
  if (!contactId) return null
  return `/contacts/${contactId}`
}

/**
 * Returns true when a funnl:followups-changed event should be dispatched
 * after a successful interaction log or edit. The sidebar badge and follow-ups
 * page stay in sync only when this event is dispatched.
 *
 * followUpDate: the follow-up date string being saved (YYYY-MM-DD) or ''/null.
 * A new follow-up being SET increases the badge count.
 *
 * For interaction edits that may REMOVE a follow-up, the caller should pass
 * a truthy value whenever the edit could have changed the follow-up date
 * (e.g. always dispatch on any successful save — see handleSaveInteraction).
 */
export function shouldDispatchFollowupChange(followUpDate) {
  return Boolean(followUpDate)
}

/**
 * Returns true when the follow_up_date actually changed between the original
 * saved value and the value being committed in an interaction EDIT.
 *
 * Normalises: null, undefined, and '' all compare as equal (all mean "no date").
 * Leading/trailing whitespace is stripped before comparison.
 *
 * Use this to gate funnl:followups-changed dispatch in handleSaveInteraction
 * so the event only fires when the date was genuinely added, changed, or removed.
 */
export function followUpDateChanged(originalDate, newDate) {
  const norm = v => (v == null ? '' : String(v).trim())
  return norm(originalDate) !== norm(newDate)
}

/**
 * Returns true when a funnl:followups-changed event should be dispatched
 * after a successful interaction EDIT.
 *
 * Dispatch only when the follow_up_date was added, changed, or removed.
 * Identical dates (including null → null) must not trigger a dispatch.
 */
export function shouldDispatchFollowupChangeOnEdit(originalDate, newDate) {
  return followUpDateChanged(originalDate, newDate)
}

/**
 * Returns true when an outreach_status_changed analytics event should fire
 * after a successful interaction EDIT.
 *
 * Fires when the effective final status differs from the original saved status.
 * Normalises: null, undefined, and '' all compare as equal (all mean "no status").
 */
export function shouldFireOutreachChangeOnEdit(originalStatus, finalStatus) {
  const norm = v => (v == null ? '' : String(v).trim())
  return norm(originalStatus) !== norm(finalStatus)
}
