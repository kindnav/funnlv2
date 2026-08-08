/**
 * settingsLifecycle.js - Pure lifecycle helpers for the Settings page.
 *
 * No React or Supabase imports - safe to unit-test in Node.js.
 * Run with: node tests/settings-lifecycle.test.js
 */
import {
  validateDisplayName,
  normalizeDisplayName,
} from './settingsHelpers.js'

/**
 * Ordered theme values used by the radiogroup.
 * Index 0 = Light (Home key), last = System (End key).
 */
export const THEME_ORDER = ['light', 'dark', 'system']

/**
 * Checks whether an async operation is still current — the component is mounted
 * and the account generation has not advanced (no UID change since the op started).
 *
 * @param {boolean} mounted - mountedRef.current value at check time
 * @param {number}  capturedGen - generation captured at the start of the operation
 * @param {number}  currentGen  - accountGenRef.current at check time
 * @returns {boolean} true when the result should be applied; false to discard it
 */
export function isRequestCurrent(mounted, capturedGen, currentGen) {
  return mounted === true && capturedGen === currentGen
}

/**
 * Plans a display-name save operation without side effects.
 *
 * @param {*}      rawValue     - the current input value (may be any type)
 * @param {string} currentSaved - the last-persisted display name
 * @returns {{ action: 'error', code: string, message: string }
 *          |{ action: 'noop' }
 *          |{ action: 'save', normalized: string }}
 */
export function planDisplayNameSave(rawValue, currentSaved) {
  const result = validateDisplayName(rawValue)
  if (!result.valid) return { action: 'error', code: result.code, message: result.message }
  const normalized = normalizeDisplayName(rawValue)
  if (normalized === currentSaved) return { action: 'noop' }
  return { action: 'save', normalized }
}

/**
 * Classifies the response from the delete-account Edge Function.
 *
 * @param {Error|null}  invokeError - error object from supabase.functions.invoke
 * @param {object|null} data        - response data from the Edge Function
 * @returns {{ ok: true, code: 'success' }|{ ok: false, code: string }}
 */
export function classifyDeleteAccountResponse(invokeError, data) {
  if (invokeError) return { ok: false, code: 'network_error' }
  if (!data) return { ok: false, code: 'unknown' }
  if (data.success === true) return { ok: true, code: 'success' }
  const code = data.error?.code ?? 'unknown'
  return { ok: false, code }
}

/**
 * Returns true when a modal dialog can safely be closed (not blocked by an in-progress mutation).
 *
 * @param {boolean} isBusy - true when a deletion or save is in progress
 * @returns {boolean}
 */
export function canCloseDialog(isBusy) {
  return !isBusy
}

/**
 * Moves a theme radiogroup selection based on a keyboard event key.
 * Implements the W3C radio button group keyboard interaction pattern with wrapping.
 *
 * Handled keys:
 *   ArrowRight / ArrowDown - move to next (wraps)
 *   ArrowLeft  / ArrowUp   - move to previous (wraps)
 *   Home                   - move to first theme
 *   End                    - move to last theme
 *
 * @param {string[]} themes       - ordered theme values (e.g. ['light','dark','system'])
 * @param {string}   currentTheme - the currently-selected theme value
 * @param {string}   key          - e.key from the keyboard event
 * @returns {string|null} next theme value, or null when key does not trigger movement
 */
export function moveThemeRadio(themes, currentTheme, key) {
  const idx = themes.indexOf(currentTheme)
  if (idx === -1) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return themes[(idx + 1) % themes.length]
  if (key === 'ArrowLeft'  || key === 'ArrowUp')   return themes[(idx - 1 + themes.length) % themes.length]
  if (key === 'Home') return themes[0]
  if (key === 'End')  return themes[themes.length - 1]
  return null
}

/**
 * Returns the ordered browser event names to dispatch after a successful
 * "delete all contacts" operation.
 * contacts-changed notifies contact lists and the Settings count.
 * followups-changed clears the follow-up badge (cascade-deleted interactions).
 *
 * @returns {string[]} event name strings, in dispatch order
 */
export function getDeleteAllRefreshEvents() {
  return ['funnl:contacts-changed', 'funnl:followups-changed']
}

/**
 * Returns the browser event names to dispatch after a successful display-name save,
 * so consumers (e.g. the Sidebar avatar label) update without a full page reload.
 *
 * @returns {string[]}
 */
export function getProfileChangedRefreshEvents() {
  return ['funnl:profile-changed']
}
