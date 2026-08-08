/**
 * Pure helpers for GlobalAddContactController.
 * No React / Supabase imports — safe to test in plain Node.js.
 */

/**
 * Resolves the action to take after a successful contact add.
 *
 * id: UUID of the new contact, or null (caller should guard this case)
 * isFirstContact: true when this is the user's very first contact
 *
 * Returns an action descriptor:
 *
 *   { action: 'navigate-first', path, state }
 *     → navigate to /contacts/:id with openInteractionForm router state
 *
 *   { action: 'emit-changed' }
 *     → stay on the current route; caller dispatches funnl:contacts-changed
 *
 *   { action: 'noop' }
 *     → id was null (insert failed — caller should have prevented reaching here)
 */
export function resolveAddResult({ id, isFirstContact }) {
  if (!id) return { action: 'noop' }
  if (isFirstContact) {
    return {
      action: 'navigate-first',
      path: `/contacts/${id}`,
      state: { openInteractionForm: true },
    }
  }
  return { action: 'emit-changed' }
}

/**
 * Returns true when the global drawer should open for a given event.
 * Guard: if the drawer is already open, ignore the event to prevent stacking.
 *
 * currentlyOpen: boolean — the current open state at the time the event fires
 */
export function shouldOpenDrawer(currentlyOpen) {
  return !currentlyOpen
}
