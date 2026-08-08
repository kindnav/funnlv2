/**
 * contactDirectoryUtils.js — pure directory utilities.
 * No React, no Supabase imports — safe to use in Node.js test files.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

export const SORT_OPTIONS = ['attention', 'active', 'added', 'az']
export const DEFAULT_SORT = 'attention'

// Contacts last interacted within this many days are "recently active" (no pending items)
export const ATTENTION_RECENT_DAYS = 14

// Category priority in needs-attention sort (index 0 = highest urgency)
export const CATEGORY_ORDER = [
  'overdue',
  'due_today',
  'awaiting_response',
  'no_next_action',    // contacts with nothing happening need attention more than actively-managed ones
  'recently_active',   // actively managed — lowest urgency
]

// Feature flag: contact-level AI insight. Deferred — do not show while false.
export const CONTACT_AI_ENABLED = false

// ── URL state ─────────────────────────────────────────────────────────────────

/** Parse ?sort= URL param; unknown values silently fall back to DEFAULT_SORT. */
export function parseSortParam(param) {
  return SORT_OPTIONS.includes(param) ? param : DEFAULT_SORT
}

// ── Date utilities ────────────────────────────────────────────────────────────

/** YYYY-MM-DD for today in the user's local timezone. */
export function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Days since dateStr, relative to today. Positive = past, negative = future.
 * Returns null when either argument is falsy. Both args must be YYYY-MM-DD.
 */
export function daysSince(dateStr, today) {
  if (!dateStr || !today) return null
  const [ty, tm, td] = today.split('-').map(Number)
  const [dy, dm, dd] = dateStr.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000)
}

// ── Snooze date helper ────────────────────────────────────────────────────────

/**
 * Return a YYYY-MM-DD target date for a snooze action.
 * @param {'tomorrow'|'three_days'|'one_week'|'custom'} option
 * @param {string} customDate  YYYY-MM-DD — only used when option === 'custom'
 * @param {string} today       YYYY-MM-DD — injected for testability
 * @returns {string|null}      null when option === 'custom' and customDate is falsy
 */
export function snoozeOptionToDate(option, customDate, today) {
  if (option === 'custom') return customDate || null
  const days = option === 'tomorrow' ? 1 : option === 'three_days' ? 3 : 7
  const [y, m, d] = today.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) + days * 86400000
  const r = new Date(ms)
  return `${r.getUTCFullYear()}-${String(r.getUTCMonth() + 1).padStart(2, '0')}-${String(r.getUTCDate()).padStart(2, '0')}`
}

// ── Pro gate helper (pure — no Supabase) ─────────────────────────────────────

/**
 * Whether to show contact-level AI. Requires both Pro access AND feature enabled.
 * While CONTACT_AI_ENABLED is false, this always returns false.
 */
export function shouldShowContactAI(canUsePro, featureEnabled) {
  return featureEnabled === true && canUsePro === true
}

// ── Status derivation ─────────────────────────────────────────────────────────

/**
 * Derive the attention category and key signals for one contact.
 *
 * @param {Array}  contactInteractions  Interactions for this contact only (any order).
 * @param {string} today                YYYY-MM-DD, injected for testability.
 * @returns {{ category, nextFollowUp, awaitingOutreach, lastInteraction, daysSinceLastContact }}
 *
 * Category semantics:
 *   overdue           — open follow_up_date < today
 *   due_today         — open follow_up_date === today
 *   recently_active   — open future follow-up, OR last interaction ≤ ATTENTION_RECENT_DAYS ago
 *   awaiting_response — outreach awaiting reply, no overdue/today follow_up
 *   no_next_action    — nothing pending; last interaction > ATTENTION_RECENT_DAYS ago (or none)
 */
export function deriveContactStatus(contactInteractions, today) {
  const sorted = [...(contactInteractions || [])].sort((a, b) =>
    (b.interaction_date || '').localeCompare(a.interaction_date || ''))

  // Earliest open follow-up (soonest follow_up_date first)
  const openFollowUps = sorted
    .filter(i => i.follow_up_date)
    .sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date))
  const nextFollowUp = openFollowUps[0] || null

  // Most recent awaiting_response outreach
  const awaitingOutreach = sorted.find(i => i.outreach_status === 'awaiting_response') || null

  const lastInteraction = sorted[0] || null

  let category
  if (nextFollowUp) {
    const cmp = nextFollowUp.follow_up_date.localeCompare(today)
    if (cmp < 0)       category = 'overdue'
    else if (cmp === 0) category = 'due_today'
    else               category = 'recently_active'  // future follow-up — actively being managed
  } else if (awaitingOutreach) {
    category = 'awaiting_response'
  } else if (!lastInteraction) {
    category = 'no_next_action'  // never interacted
  } else {
    const days = daysSince(lastInteraction.interaction_date, today)
    category = days !== null && days <= ATTENTION_RECENT_DAYS ? 'recently_active' : 'no_next_action'
  }

  return {
    category,
    nextFollowUp,
    awaitingOutreach,
    lastInteraction,
    daysSinceLastContact: lastInteraction
      ? daysSince(lastInteraction.interaction_date, today)
      : null,
  }
}

/**
 * Build a directory entry from a contact and all loaded interactions.
 * Attaches _status (derived attention status) and _interactions (contact-scoped, date-desc).
 */
export function buildDirectoryEntry(contact, allInteractions, today) {
  const contactInteractions = (allInteractions || [])
    .filter(i => i.contact_id === contact.id)
    .sort((a, b) => (b.interaction_date || '').localeCompare(a.interaction_date || ''))

  return {
    ...contact,
    _status: deriveContactStatus(contactInteractions, today),
    _interactions: contactInteractions,
  }
}

// ── Sorting ───────────────────────────────────────────────────────────────────

function categoryRank(category) {
  const idx = CATEGORY_ORDER.indexOf(category)
  return idx === -1 ? CATEGORY_ORDER.length : idx
}

/**
 * Sort directory entries (with _status attached) by the given sort key.
 * Returns a new array; does not mutate the input.
 */
export function sortDirectoryEntries(entries, sort) {
  const copy = [...entries]

  if (sort === 'az') {
    return copy.sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
  }

  if (sort === 'added') {
    return copy.sort((a, b) =>
      (b.created_at || '').localeCompare(a.created_at || ''))
  }

  if (sort === 'active') {
    return copy.sort((a, b) => {
      const aDate = a._status?.lastInteraction?.interaction_date || ''
      const bDate = b._status?.lastInteraction?.interaction_date || ''
      if (bDate !== aDate) return bDate.localeCompare(aDate)
      return (b.created_at || '').localeCompare(a.created_at || '')
    })
  }

  // Default: needs-attention sort
  return copy.sort((a, b) => {
    const aRank = categoryRank(a._status?.category)
    const bRank = categoryRank(b._status?.category)
    if (aRank !== bRank) return aRank - bRank

    const cat = a._status?.category

    if (cat === 'overdue') {
      const af = a._status?.nextFollowUp?.follow_up_date || ''
      const bf = b._status?.nextFollowUp?.follow_up_date || ''
      if (af !== bf) return af.localeCompare(bf)  // most overdue first
    }

    if (cat === 'awaiting_response') {
      const aDate = a._status?.awaitingOutreach?.interaction_date || ''
      const bDate = b._status?.awaitingOutreach?.interaction_date || ''
      if (aDate !== bDate) return aDate.localeCompare(bDate)  // longest wait first
    }

    if (cat === 'recently_active') {
      const aDate = a._status?.lastInteraction?.interaction_date || ''
      const bDate = b._status?.lastInteraction?.interaction_date || ''
      if (bDate !== aDate) return bDate.localeCompare(aDate)  // most recent first
    }

    if (cat === 'no_next_action') {
      const aDate = a._status?.lastInteraction?.interaction_date || ''
      const bDate = b._status?.lastInteraction?.interaction_date || ''
      if (!aDate && !bDate) return (a.created_at || '').localeCompare(b.created_at || '')
      if (!aDate) return -1  // never interacted → most neglected → first
      if (!bDate) return 1
      return aDate.localeCompare(bDate)  // oldest last contact first
    }

    return (b.created_at || '').localeCompare(a.created_at || '')
  })
}

// ── Tag filtering ─────────────────────────────────────────────────────────────

/** Filter directory entries to those containing the given tag (case-insensitive, partial). */
export function filterByTag(entries, tag) {
  if (!tag) return entries
  const q = tag.toLowerCase()
  return entries.filter(c => c.tags?.some(t => t.toLowerCase().includes(q)))
}

// ── Directory search ──────────────────────────────────────────────────────────

/**
 * Full-text search across: name, company, role, tags, relationship_note,
 * and interaction notes (via _interactions attached by buildDirectoryEntry).
 *
 * IMPORTANT: Search text must never be sent to analytics — callers enforce this.
 */
export function searchDirectory(entries, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return entries
  return entries.filter(entry => {
    if (entry.name?.toLowerCase().includes(q))              return true
    if (entry.company?.toLowerCase().includes(q))           return true
    if (entry.role?.toLowerCase().includes(q))              return true
    if (entry.relationship_note?.toLowerCase().includes(q)) return true
    if (entry.tags?.some(t => t.toLowerCase().includes(q))) return true
    if (entry._interactions?.some(i => i.notes?.toLowerCase().includes(q))) return true
    return false
  })
}

// ── Tag counts ────────────────────────────────────────────────────────────────

/** Build { tagName: count } from a contacts array. Keys are lowercased. */
export function buildTagCounts(contacts) {
  const counts = {}
  for (const c of (contacts || [])) {
    for (const tag of (c.tags || [])) {
      const key = tag.toLowerCase()
      counts[key] = (counts[key] || 0) + 1
    }
  }
  return counts
}

// ── Low-history flag ──────────────────────────────────────────────────────────

/** True when a contact has fewer than 2 interactions total. */
export function isLowHistory(contactInteractions) {
  return (contactInteractions || []).length < 2
}
