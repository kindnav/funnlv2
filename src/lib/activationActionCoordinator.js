/**
 * activationActionCoordinator.js — pure, injectable action resolver.
 *
 * Decides what should happen when the user activates a compact next-action CTA.
 * Single source of truth for the add/log/followup dispatch logic. Tested in
 * plain Node.js; no React or router deps.
 *
 * Used by DashboardPage onNextAction handler.
 *
 * Result types:
 *   { type: 'open_drawer' }                         → open the Add Contact drawer
 *   { type: 'navigate', contactId, mode }           → navigate to contact detail with form state
 *   { type: 'open_picker', mode }                   → open the shared contact picker
 *   { type: 'noop' }                                → no action (e.g. 'complete')
 *
 * mode: 'interaction' | 'followup'
 */

/**
 * Resolve an activation action into a concrete UI instruction.
 *
 * @param {string|null} action   'add' | 'log' | 'followup' | 'complete' | null
 * @param {Array}       contacts Live contact array (used for length check only)
 * @returns {{ type: string, contactId?: string, mode?: string }}
 */
export function resolveActivationAction(action, contacts) {
  const safeContacts = Array.isArray(contacts) ? contacts : []

  if (action === 'add') return { type: 'open_drawer' }

  if (action === 'log') {
    if (safeContacts.length === 0) return { type: 'open_drawer' }
    if (safeContacts.length === 1) return { type: 'navigate', contactId: safeContacts[0].id, mode: 'interaction' }
    return { type: 'open_picker', mode: 'interaction' }
  }

  if (action === 'followup') {
    if (safeContacts.length === 0) return { type: 'open_drawer' }
    if (safeContacts.length === 1) return { type: 'navigate', contactId: safeContacts[0].id, mode: 'followup' }
    return { type: 'open_picker', mode: 'followup' }
  }

  // 'complete' or unknown → no-op
  return { type: 'noop' }
}
