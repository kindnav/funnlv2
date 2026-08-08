/**
 * settingsHelpers.js - Pure helpers for the Settings page.
 *
 * No React or Supabase imports - safe to unit-test in Node.js.
 * Run with: node tests/settings-helpers.test.js
 */

/** Maximum character length accepted for display names. */
export const DISPLAY_NAME_MAX_LENGTH = 80

/** Exact phrase required to confirm "delete all contacts". */
export const DELETE_ALL_PHRASE = 'delete all contacts'

/** Exact phrase required to confirm "delete my account". */
export const DELETE_ACCOUNT_PHRASE = 'delete my account'

/**
 * Normalizes a raw display name value.
 * Converts to string and trims surrounding whitespace.
 * @param {*} value
 * @returns {string}
 */
export function normalizeDisplayName(value) {
  if (value == null) return ''
  return String(value).trim()
}

/**
 * Validates a display name before saving.
 * Normalizes first, then checks length and character constraints.
 *
 * @param {*} value - raw input (may be null/undefined/string)
 * @returns {{ valid: boolean, code: string, message: string }}
 *   Codes: 'ok' | 'empty' | 'too_long' | 'invalid_chars'
 */
export function validateDisplayName(value) {
  const normalized = normalizeDisplayName(value)
  if (!normalized) {
    return { valid: false, code: 'empty', message: 'Display name cannot be empty.' }
  }
  if (normalized.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      valid: false,
      code: 'too_long',
      message: `Must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`,
    }
  }
  // Reject ASCII control characters (U+0000–U+001F) and DEL (U+007F).
  // These include newlines, tabs, and null bytes - all invalid in a display name.
  if (/[\x00-\x1F\x7F]/.test(normalized)) {
    return { valid: false, code: 'invalid_chars', message: 'Contains invalid characters.' }
  }
  return { valid: true, code: 'ok', message: '' }
}

/**
 * Returns true only when input exactly matches the delete-all phrase.
 * Case-sensitive, no trim - the user must type it exactly.
 *
 * @param {*} input
 * @returns {boolean}
 */
export function isDeleteAllConfirmEligible(input) {
  return typeof input === 'string' && input === DELETE_ALL_PHRASE
}

/**
 * Returns true when input matches the delete-account phrase after trimming.
 * Trimming is applied so a trailing newline from hitting Enter doesn't block the button.
 * Case-sensitive - the user must type it in lower-case exactly.
 *
 * @param {*} input
 * @returns {boolean}
 */
export function isDeleteAccountConfirmEligible(input) {
  return typeof input === 'string' && input.trim() === DELETE_ACCOUNT_PHRASE
}

/**
 * Formats a signup timestamp into "Month Year".
 * Returns "-" for falsy or unparseable values.
 *
 * @param {string|null|undefined} ts - ISO 8601 timestamp
 * @returns {string}
 */
export function formatJoined(ts) {
  if (!ts) return 'Unknown'
  try {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return 'Unknown'
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  } catch {
    return 'Unknown'
  }
}

/**
 * Formats a trial end timestamp into "Month D".
 * Returns "-" for falsy or unparseable values.
 *
 * @param {string|null|undefined} endsAt - ISO 8601 timestamp
 * @returns {string}
 */
export function formatTrialEnd(endsAt) {
  if (!endsAt) return 'Unknown'
  try {
    const d = new Date(endsAt)
    if (isNaN(d.getTime())) return 'Unknown'
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  } catch {
    return 'Unknown'
  }
}

/**
 * Formats a contact count into a human-readable summary.
 *
 * @param {number|null|undefined} count
 * @returns {string}
 */
export function summarizeContactCount(count) {
  if (typeof count !== 'number' || isNaN(count) || count <= 0) return 'no contacts'
  if (count === 1) return '1 contact'
  return `${count} contacts`
}
