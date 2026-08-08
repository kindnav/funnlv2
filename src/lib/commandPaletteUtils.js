/**
 * commandPaletteUtils.js — Pure helpers for CommandPalette rendering and keyboard logic.
 *
 * No React, no Supabase imports — safe to test in plain Node.js.
 * Imports NAVIGATION_COMMANDS / filterNavigationCommands from searchUtils.js.
 *
 * Exports:
 *   MAX_SEARCH_QUERY_LENGTH — hard cap for search queries sent to the DB
 *   shouldIgnoreKey         — IME composition guard for keyboard handlers
 *   encodePostgRESTOrValue  — strip structural PostgREST filter grammar chars (kept for utility; no longer used by CommandPalette's separate-query approach)
 *   getItemId               — stable DOM ID for a flat-list item (content-based, not index)
 *   getActiveItemId         — DOM ID of the currently active item (or undefined)
 *   buildFlatItems          — ordered flat array of all selectable palette items
 *   clampActiveIdx          — clamp an active index to the valid range
 */

import { NAVIGATION_COMMANDS, filterNavigationCommands } from './searchUtils.js'

// ── Query length cap ──────────────────────────────────────────────────────────

/**
 * Maximum length of the normalised query string that will be sent to the
 * database or used for AI handoff / no-results prefill.
 *
 * Chosen to be safely below PostgREST's query-string URL limit (~8 KB) and
 * to prevent accidental large requests from clipboard pastes.  The input
 * field remains editable above this limit — the DB query is simply built
 * from the first MAX_SEARCH_QUERY_LENGTH characters of the normalised string.
 */
export const MAX_SEARCH_QUERY_LENGTH = 200

// ── IME composition guard ─────────────────────────────────────────────────────

/**
 * Return true when a keyboard event should be ignored because IME composition
 * is active (e.g. CJK character entry via Input Method Editors).
 *
 * Activation keys (Enter, ArrowUp, ArrowDown) must not fire during
 * composition; the IME consumes them to confirm or cycle candidates.
 * Escape retains its normal function (collapses the IME candidate list, then
 * closes the dialog on the next press).
 *
 * Accepts both React SyntheticEvents (which forward isComposing in React 17+)
 * and raw DOM KeyboardEvents.
 *
 * @param {KeyboardEvent|object} e — the keyboard event (native or synthetic)
 * @returns {boolean}
 */
export function shouldIgnoreKey(e) {
  if (!e) return false
  // React 17+ SyntheticEvent exposes isComposing directly.
  if (e.isComposing === true) return true
  // Fallback: read from the underlying native event (React <17, or raw DOM).
  if (e.nativeEvent && e.nativeEvent.isComposing === true) return true
  return false
}

// ── PostgREST filter safety ───────────────────────────────────────────────────

/**
 * Strip characters that are structural in PostgREST filter grammar from an
 * already-ILIKE-escaped value.
 *
 * NOTE: CommandPalette no longer calls .or() with interpolated user values.
 * It runs independent .ilike(field, pattern) calls per field so each value
 * is passed as a bound parameter, not embedded in a filter grammar string.
 * This function is retained as a utility for callers that still use .or().
 *
 * PostgREST parses .or() arguments as comma-separated clauses; parentheses are
 * used for nesting.  If user input — even after ILIKE escaping — contains
 * these characters, it can inject additional filter clauses or alter the parse
 * tree.
 *
 * @param {string} escaped — ILIKE-escaped value
 * @returns {string} value with , ( ) removed
 */
export function encodePostgRESTOrValue(escaped) {
  if (typeof escaped !== 'string') return ''
  return escaped.replace(/[,()]/g, '')
}

// ── Stable DOM IDs ────────────────────────────────────────────────────────────

/**
 * Return a stable, content-based DOM ID for a palette list item.
 *
 * IDs are based on the item's content (contact UUID, note UUID, command ID)
 * rather than its array index, so they remain stable when other items are
 * added or removed around them.  The combobox input's aria-activedescendant
 * attribute points to these IDs.
 */
export function getItemId(item) {
  if (!item) return 'cp-unknown'
  switch (item.kind) {
    case 'recent':  return `cp-recent-${item.contact?.id  || 'unknown'}`
    case 'contact': return `cp-contact-${item.contact?.id || 'unknown'}`
    case 'note':    return `cp-note-${item.note?.id        || 'unknown'}`
    case 'action':  return `cp-action-${item.action?.id   || 'unknown'}`
    case 'nav':     return `cp-nav-${item.nav?.id          || 'unknown'}`
    case 'ai':      return 'cp-ai-handoff'
    default:        return 'cp-unknown'
  }
}

/**
 * Return the DOM ID of the item at activeIdx in the items array.
 *
 * Returns undefined when items is empty or activeIdx is out of range, so
 * aria-activedescendant can be omitted (rather than pointing to nothing).
 */
export function getActiveItemId(items, activeIdx) {
  if (!Array.isArray(items) || items.length === 0) return undefined
  if (typeof activeIdx !== 'number' || activeIdx < 0 || activeIdx >= items.length) return undefined
  return getItemId(items[activeIdx])
}

// ── Flat item list ────────────────────────────────────────────────────────────

/**
 * Build the ordered flat list of all selectable palette items.
 *
 * This is the single source of truth for both visual order and keyboard
 * navigation order (ArrowUp / ArrowDown).  The render section must iterate
 * the same groups in the same order so that the activeIdx value matches the
 * visually highlighted row.
 *
 * Empty query:  recentContacts → quickActions → navCommands → AI (Pro only)
 * With query:   contactResults → noteResults  → quickActions → filtered navCommands → AI (Pro only)
 *
 * @param {object} params
 * @param {string}   params.norm           — normalizeQuery(query) result; '' = empty query
 * @param {Array}    params.recentContacts — hydrated recent contact objects
 * @param {Array}    params.contactResults — DB contact search results
 * @param {Array}    params.noteResults    — DB interaction notes search results
 * @param {Array}    params.quickActions   — quick action descriptor objects (id, label, action)
 * @param {boolean}  params.canUsePro      — whether the user can access Pro/AI features
 * @returns {Array}  flat array of { kind, contact|note|action|nav } items
 */
export function buildFlatItems({ norm, recentContacts, contactResults, noteResults, quickActions, canUsePro }) {
  const items = []

  if (!norm) {
    // Empty query: recent contacts + quick actions + nav commands + AI
    ;(recentContacts || []).forEach(c => items.push({ kind: 'recent',  contact: c }))
    ;(quickActions   || []).forEach(a => items.push({ kind: 'action',  action:  a }))
    filterNavigationCommands(NAVIGATION_COMMANDS, '', canUsePro).forEach(n =>
      items.push({ kind: 'nav', nav: n })
    )
    if (canUsePro) items.push({ kind: 'ai' })
  } else {
    // Non-empty query: contacts + notes + quick actions + filtered nav + AI
    ;(contactResults || []).forEach(c => items.push({ kind: 'contact', contact: c }))
    ;(noteResults    || []).forEach(n => items.push({ kind: 'note',    note:    n }))
    ;(quickActions   || []).forEach(a => items.push({ kind: 'action',  action:  a }))
    filterNavigationCommands(NAVIGATION_COMMANDS, norm, canUsePro).forEach(n =>
      items.push({ kind: 'nav', nav: n })
    )
    if (canUsePro) items.push({ kind: 'ai' })
  }

  return items
}

// ── Index clamping ────────────────────────────────────────────────────────────

/**
 * Clamp an active index to the valid range [0, items.length - 1].
 * Returns 0 when items is empty (safe no-op for keyboard handlers).
 */
export function clampActiveIdx(idx, items) {
  if (!Array.isArray(items) || items.length === 0) return 0
  return Math.max(0, Math.min(idx, items.length - 1))
}
