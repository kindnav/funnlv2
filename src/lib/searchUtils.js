/**
 * searchUtils.js — Pure search helpers for CommandPalette.
 *
 * No React, no Supabase imports — safe to test in plain Node.js.
 *
 * Exports:
 *   normalizeQuery          — trim, collapse whitespace, lowercase
 *   escapeIlike             — escape %, _, \ for Postgres ILIKE patterns
 *   highlightSegments       — split text into {text, match} segments (no HTML)
 *   extractNoteSnippet      — truncated snippet centred on the first match
 *   recentContactsKey       — localStorage key (user-scoped, versioned)
 *   RECENT_MAX              — hard cap for stored IDs
 *   readRecentContacts      — read and validate stored IDs
 *   writeRecentContact      — push a contact ID to the front, dedup, cap
 *   clearRecentContacts     — remove the storage entry for a user
 *   buildAIPrefillState     — build router state for AI handoff { aiPrompt }
 *   buildNoResultPrefill    — derive a safe name string from a query
 *   buildAIHandoffLabel     — human-readable "Ask Funnl AI about X" label
 *   filterNavigationCommands — filter nav command list by query
 *   NAVIGATION_COMMANDS     — controlled list of navigation commands
 */

// ── Query normalization ───────────────────────────────────────────────────────

/**
 * Normalise a raw query string:
 *   • Coerce non-strings to ''
 *   • Trim leading/trailing whitespace
 *   • Collapse internal whitespace to single spaces
 *   • Lowercase
 *
 * Returns '' for empty/whitespace-only input.
 */
export function normalizeQuery(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

// ── ILIKE pattern escaping ────────────────────────────────────────────────────

/**
 * Escape characters that have special meaning in a PostgreSQL ILIKE pattern:
 *   \  →  \\   (must be first so we don't double-escape later replacements)
 *   %  →  \%
 *   _  →  \_
 *
 * Pass the result into an ilike() call wrapped in %…% for a safe
 * case-insensitive contains search.
 */
export function escapeIlike(str) {
  if (typeof str !== 'string') return ''
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// ── Match highlighting ────────────────────────────────────────────────────────

/**
 * Split `text` into an array of segments, each { text: string, match: boolean }.
 * Segments with match=true correspond to occurrences of `query` (case-insensitive).
 * Callers render matched segments with a <mark> or styled span — never HTML here.
 *
 * Edge cases:
 *   - empty/null text  → [{ text: '', match: false }]
 *   - empty/null query → [{ text, match: false }]
 *   - query contains regex chars → escaped before building RegExp
 *   - repeated occurrences → all matched
 *   - unicode text preserved
 */
export function highlightSegments(text, query) {
  if (typeof text !== 'string') return [{ text: '', match: false }]
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [{ text, match: false }]
  }
  const q = query.trim()
  // Escape all regex metacharacters in the query so user input cannot inject patterns.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escaped, 'gi')

  const segments = []
  let last = 0
  let m

  while ((m = re.exec(text)) !== null) {
    // Prevent infinite loops on zero-length matches (shouldn't happen for literal
    // queries, but guard defensively).
    if (m.index === last && m[0].length === 0) { re.lastIndex++; continue }
    if (m.index > last) segments.push({ text: text.slice(last, m.index), match: false })
    segments.push({ text: m[0], match: true })
    last = m.index + m[0].length
  }

  if (last < text.length) segments.push({ text: text.slice(last), match: false })
  return segments.length ? segments : [{ text, match: false }]
}

// ── Note snippet extraction ───────────────────────────────────────────────────

const SNIPPET_MAX = 140

/**
 * Return a display-ready snippet of `text` centred around the first match
 * of `query`.  The returned string is safe plain text — no HTML markup.
 *
 * Rules:
 *   - Collapses internal whitespace in the source text first.
 *   - If no match, returns the first `maxLen` chars (no ellipsis at start).
 *   - If match found, centres a window of `maxLen` chars on it.
 *   - Prepends/appends '…' where the snippet does not reach the text boundary.
 *   - Hard cap: maxLen must be ≤ 300.
 */
export function extractNoteSnippet(text, query, maxLen = SNIPPET_MAX) {
  if (!text || typeof text !== 'string') return ''
  const safe = maxLen > 0 && maxLen <= 300 ? maxLen : SNIPPET_MAX
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return ''

  if (!query || typeof query !== 'string' || !query.trim()) {
    return t.length > safe ? t.slice(0, safe) + '…' : t
  }

  const idx = t.toLowerCase().indexOf(query.trim().toLowerCase())
  if (idx === -1) {
    return t.length > safe ? t.slice(0, safe) + '…' : t
  }

  const half = Math.floor(safe / 2)
  const start = Math.max(0, idx - half)
  const end = Math.min(t.length, start + safe)
  const snippet = t.slice(start, end)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < t.length ? '…' : ''
  return prefix + snippet + suffix
}

// ── Recent contacts — localStorage, user-scoped, versioned ───────────────────

/**
 * Version-stamped key prefix.  Increment version string when the stored
 * format changes in a breaking way (all stored data is automatically
 * orphaned rather than parsed with a stale schema).
 */
export const RECENT_KEY_PREFIX = 'funnl_recent_v1_'

/** Maximum number of recent contact IDs stored per user. */
export const RECENT_MAX = 10

/** Return the localStorage key for a given authenticated user ID. */
export function recentContactsKey(uid) {
  return `${RECENT_KEY_PREFIX}${uid}`
}

/**
 * Read and validate recent contact IDs from localStorage.
 * Returns [] when:
 *   - uid is falsy
 *   - localStorage is unavailable
 *   - JSON parse fails
 *   - stored value is not an array
 *   - entries contain non-string or empty-string values (those are dropped)
 */
export function readRecentContacts(uid) {
  if (!uid) return []
  try {
    const raw = localStorage.getItem(recentContactsKey(uid))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(id => typeof id === 'string' && id.length > 0)
      .slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/**
 * Record a contact-ID as the most recently visited contact for the user.
 * Deduplicates (moves existing entry to front), then caps to RECENT_MAX.
 * No-ops when uid or contactId are falsy or localStorage is unavailable.
 */
export function writeRecentContact(uid, contactId) {
  if (!uid || !contactId) return
  try {
    const current = readRecentContacts(uid)
    const deduped = [contactId, ...current.filter(id => id !== contactId)]
    localStorage.setItem(
      recentContactsKey(uid),
      JSON.stringify(deduped.slice(0, RECENT_MAX))
    )
  } catch {
    // storage unavailable — silent no-op
  }
}

/** Remove the recent-contacts entry for a user (e.g. on account switch). */
export function clearRecentContacts(uid) {
  if (!uid) return
  try { localStorage.removeItem(recentContactsKey(uid)) } catch {}
}

// ── AI handoff ────────────────────────────────────────────────────────────────

/**
 * Build the React Router state object that FunnlAIPage reads as a prefill.
 * FunnlAIPage reads `location.state?.aiPrompt` (string, trimmed, type-checked).
 *
 * Returns null when the query is empty or not a string — caller should not
 * navigate when the result is null.
 */
export function buildAIPrefillState(query) {
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) return null
  return { aiPrompt: q }
}

/**
 * Build a human-readable label for the AI handoff row.
 * Truncates long queries to 50 chars with ellipsis.
 */
export function buildAIHandoffLabel(query) {
  const q = typeof query === 'string' ? query.trim() : ''
  if (!q) return 'Ask Funnl AI'
  const maxLen = 50
  const display = q.length > maxLen ? q.slice(0, maxLen) + '…' : q
  return `Ask Funnl AI about "${display}"`
}

// ── No-result contact prefill ─────────────────────────────────────────────────

/**
 * Decide whether the search query is safe to prefill as a contact name.
 *
 * Returns the safe prefill string, or null if the query should not be
 * auto-inserted as a name.
 *
 * Rejections:
 *   - empty or whitespace-only
 *   - longer than 100 chars
 *   - looks like an email (contains @)
 *   - looks like a URL (starts with http/www.)
 *   - more than 6 space-separated words (too long to be a person name)
 */
export function buildNoResultPrefill(query) {
  if (!query || typeof query !== 'string') return null
  const q = query.trim()
  if (!q || q.length > 100) return null
  if (q.includes('@')) return null
  if (q.startsWith('http') || q.startsWith('www.')) return null
  if (q.split(/\s+/).length > 6) return null
  return q
}

// ── Navigation commands ───────────────────────────────────────────────────────

/**
 * Controlled list of navigation commands.
 * id: stable command ID (string)
 * label: display label
 * route: exact application route
 * keywords: additional matching terms (lowercased for search)
 * requiresPro: when true, only shown for Pro-eligible users
 */
export const NAVIGATION_COMMANDS = [
  {
    id: 'nav-home',
    label: 'Go to Home',
    route: '/',
    keywords: ['dashboard', 'home', 'start'],
    requiresPro: false,
  },
  {
    id: 'nav-contacts',
    label: 'Go to Contacts',
    route: '/contacts',
    keywords: ['contacts', 'people', 'network', 'list'],
    requiresPro: false,
  },
  {
    id: 'nav-followups',
    label: 'Go to Follow-ups',
    route: '/followups',
    keywords: ['followups', 'follow-ups', 'reminders', 'due', 'overdue'],
    requiresPro: false,
  },
  {
    id: 'nav-ai',
    label: 'Open Funnl AI',
    route: '/ai',
    keywords: ['ai', 'chat', 'assistant', 'funnl ai'],
    requiresPro: true,
  },
  {
    id: 'nav-settings',
    label: 'Go to Settings',
    route: '/settings',
    keywords: ['settings', 'account', 'profile', 'name'],
    requiresPro: false,
  },
]

/**
 * Filter navigation commands by the normalised query.
 * With an empty query, returns only the non-Pro commands (default empty state).
 * With a non-empty query, returns all matching commands (Pro commands excluded
 * when canUsePro=false).
 *
 * Matching: label or any keyword contains the query.
 */
export function filterNavigationCommands(commands, query, canUsePro = false) {
  const q = normalizeQuery(query)
  const eligible = commands.filter(cmd => !cmd.requiresPro || canUsePro)
  if (!q) return eligible
  return eligible.filter(cmd =>
    cmd.label.toLowerCase().includes(q) ||
    cmd.keywords.some(k => k.includes(q))
  )
}
