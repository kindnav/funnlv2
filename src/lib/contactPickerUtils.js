/**
 * contactPickerUtils — pure contact-picker helpers.
 *
 * No React imports, no Supabase imports — safe to use in Node.js test files.
 * Used by useContactPicker (hook) and any page-level handler that builds
 * navigation state after a contact is picked.
 */

/**
 * Filter contacts by query against name, company, and role.
 * Returns the first 20 matches in input order (or first 20 unfiltered when
 * query is blank / whitespace-only).
 */
export function filterContacts(contacts, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return contacts.slice(0, 20)
  return contacts
    .filter(c =>
      c.name?.toLowerCase().includes(q) ||
      c.company?.toLowerCase().includes(q) ||
      c.role?.toLowerCase().includes(q)
    )
    .slice(0, 20)
}

/**
 * Build the Router `state` object that ContactDetailPage uses to pre-open
 * either the interaction form or the follow-up form.
 *
 * mode: 'interaction' → { openInteractionForm: true }
 * mode: 'followup'    → { openFollowUpForm: true }
 * anything else       → null (caller should guard before navigating)
 */
export function buildPickerNavigationState(mode) {
  if (mode === 'interaction') return { openInteractionForm: true }
  if (mode === 'followup')    return { openFollowUpForm: true }
  return null
}
