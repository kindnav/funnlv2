/**
 * followUpUtils.js — pure follow-up utilities.
 *
 * No React, no Supabase — safe to unit-test in plain Node.js.
 *
 * Shared by FollowUpsPage and ContactDetailPage to guarantee identical
 * payload logic, grouping rules, and date semantics across both surfaces.
 */

// ── Local date helpers ────────────────────────────────────────────────────────

/**
 * Today's date as YYYY-MM-DD in the user's local timezone.
 * Uses local Date parts to avoid UTC-offset "wrong day" bugs.
 */
export function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Returns YYYY-MM-DD for `days` days after `today`.
 * Uses UTC arithmetic on the date parts to avoid DST drift.
 * Pass a negative value to go backwards.
 *
 * @param {string} today  YYYY-MM-DD
 * @param {number} days   integer offset (positive = future, negative = past)
 */
export function localDateOffset(today, days) {
  const [y, m, d] = today.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) + days * 86400000
  const r = new Date(ms)
  return `${r.getUTCFullYear()}-${String(r.getUTCMonth() + 1).padStart(2, '0')}-${String(r.getUTCDate()).padStart(2, '0')}`
}

/**
 * Returns the inclusive lower-bound YYYY-MM-DD for the recently-completed window.
 *
 * The window is exactly 7 local calendar dates: today + the 6 preceding days.
 * A completion from exactly 7 calendar days ago is EXCLUDED.
 *
 * Examples (today = 2026-07-30):
 *   included:  2026-07-30, 2026-07-29, …, 2026-07-24  (today through 6 days ago)
 *   excluded:  2026-07-23  (7 days ago) and earlier
 *
 * @param {string} today  YYYY-MM-DD
 */
export function sevenDaysAgo(today) {
  return localDateOffset(today, -6)
}

/**
 * Converts a UTC ISO timestamp (from a timestamptz column) to a local
 * YYYY-MM-DD date string. Uses the browser's local timezone.
 *
 * @param {string} utcTimestamp  ISO 8601 string, e.g. "2026-07-29T14:32:00Z"
 * @returns {string}  YYYY-MM-DD in local timezone
 */
export function completedLocalDate(utcTimestamp) {
  if (!utcTimestamp) return ''
  const d = new Date(utcTimestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Number of whole calendar days from `dateStr` until `today`.
 * Positive = past (the date was before today), negative = future, 0 = same day.
 * Returns 0 when either argument is falsy.
 *
 * @param {string} dateStr  YYYY-MM-DD
 * @param {string} today    YYYY-MM-DD
 */
export function daysWaiting(dateStr, today) {
  if (!dateStr || !today) return 0
  const [ty, tm, td] = today.split('-').map(Number)
  const [dy, dm, dd] = dateStr.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000)
}

// ── Row classification ────────────────────────────────────────────────────────

/**
 * Classify one interaction row for the follow-ups page.
 *
 * Priority order:
 *   1. Completion — if follow_up_completed_at is set:
 *      - today through 6 days ago (7 local calendar dates) → 'recently_completed'
 *      - 7+ days ago → 'other' (not shown)
 *   2. Active dated follow-up (follow_up_completed_at is null):
 *      - date < today → 'overdue'
 *      - date === today → 'due_today'
 *      - date > today → 'upcoming'
 *   3. Awaiting response without a date (and not completed):
 *      - outreach_status === 'awaiting_response' and no follow_up_date → 'awaiting_no_date'
 *   4. Everything else → 'other'
 *
 * @param {object} row
 * @param {string} today           YYYY-MM-DD
 * @param {string} sevenDaysAgoDate  YYYY-MM-DD — precomputed for performance
 */
export function classifyInteraction(row, today, sevenDaysAgoDate) {
  // 1. Completion takes priority over all other conditions
  if (row.follow_up_completed_at) {
    const localDate = completedLocalDate(row.follow_up_completed_at)
    return localDate >= sevenDaysAgoDate ? 'recently_completed' : 'other'
  }
  // 2. Active dated follow-up
  if (row.follow_up_date) {
    if (row.follow_up_date < today) return 'overdue'
    if (row.follow_up_date === today) return 'due_today'
    return 'upcoming'
  }
  // 3. Awaiting without date
  if (row.outreach_status === 'awaiting_response') return 'awaiting_no_date'
  return 'other'
}

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Deduplicate awaiting-response rows to one per contact.
 *
 * When one contact has multiple unresolved awaiting_response interactions,
 * keep only the most recent one (by interaction_date desc, then id desc as
 * a stable tie-breaker). Different contacts always remain separate.
 *
 * @param {Array} items  Awaiting-no-date interaction rows
 * @returns {Array}      One row per unique contact_id
 */
export function deduplicateAwaitingResponse(items) {
  const byContact = new Map()
  for (const item of items) {
    const cid = item.contact_id
    if (!byContact.has(cid)) {
      byContact.set(cid, item)
    } else {
      const existing = byContact.get(cid)
      const isNewer =
        item.interaction_date > existing.interaction_date ||
        (item.interaction_date === existing.interaction_date && item.id > existing.id)
      if (isNewer) byContact.set(cid, item)
    }
  }
  return [...byContact.values()]
}

// ── Sorting ───────────────────────────────────────────────────────────────────

/**
 * Sort overdue rows: oldest due date first → contact name A-Z → stable id.
 */
export function sortOverdue(items) {
  return [...items].sort((a, b) => {
    if (a.follow_up_date !== b.follow_up_date)
      return a.follow_up_date.localeCompare(b.follow_up_date)
    const na = (a.contacts?.name || '').toLowerCase()
    const nb = (b.contacts?.name || '').toLowerCase()
    if (na !== nb) return na.localeCompare(nb)
    return a.id.localeCompare(b.id)
  })
}

/**
 * Sort today rows: contact name A-Z → stable id.
 */
export function sortToday(items) {
  return [...items].sort((a, b) => {
    const na = (a.contacts?.name || '').toLowerCase()
    const nb = (b.contacts?.name || '').toLowerCase()
    if (na !== nb) return na.localeCompare(nb)
    return a.id.localeCompare(b.id)
  })
}

/**
 * Sort upcoming rows: soonest due date first → contact name A-Z → stable id.
 */
export function sortUpcoming(items) {
  return [...items].sort((a, b) => {
    if (a.follow_up_date !== b.follow_up_date)
      return a.follow_up_date.localeCompare(b.follow_up_date)
    const na = (a.contacts?.name || '').toLowerCase()
    const nb = (b.contacts?.name || '').toLowerCase()
    if (na !== nb) return na.localeCompare(nb)
    return a.id.localeCompare(b.id)
  })
}

/**
 * Sort awaiting-response rows: longest waiting first (oldest interaction_date)
 * → contact name A-Z → stable id ascending.
 *
 * @param {Array}  items
 * @param {string} today  YYYY-MM-DD — used for waiting-duration calculation
 */
export function sortAwaitingResponse(items, today) {
  return [...items].sort((a, b) => {
    const da = daysWaiting(a.interaction_date, today)
    const db = daysWaiting(b.interaction_date, today)
    if (da !== db) return db - da  // longest waiting = highest daysWaiting first
    const na = (a.contacts?.name || '').toLowerCase()
    const nb = (b.contacts?.name || '').toLowerCase()
    if (na !== nb) return na.localeCompare(nb)
    return a.id.localeCompare(b.id)
  })
}

/**
 * Sort recently-completed rows: newest completion first → id desc as tie-breaker.
 */
export function sortRecentlyCompleted(items) {
  return [...items].sort((a, b) => {
    if (a.follow_up_completed_at !== b.follow_up_completed_at)
      return b.follow_up_completed_at.localeCompare(a.follow_up_completed_at)
    return b.id.localeCompare(a.id)
  })
}

// ── Main grouping function ────────────────────────────────────────────────────

/**
 * Partition and sort a flat array of interaction rows into all five follow-up
 * groups.
 *
 * Callers pass the raw array returned by the Supabase query (which uses an OR
 * filter to include all candidates: dated follow-ups, awaiting_response rows,
 * and recently-completed rows).
 *
 * @param {Array}  interactions  Raw rows from Supabase
 * @param {string} today         YYYY-MM-DD — local date, injected for testability
 * @returns {{
 *   overdue: Array,
 *   today: Array,
 *   upcoming: Array,
 *   awaitingResponse: Array,
 *   recentlyCompleted: Array,
 * }}
 */
export function groupAndSortFollowUps(interactions, today) {
  const sevenAgo = sevenDaysAgo(today)
  const overdueRaw = []
  const todayRaw = []
  const upcomingRaw = []
  const awaitingRaw = []
  const completedRaw = []

  for (const row of interactions) {
    const cls = classifyInteraction(row, today, sevenAgo)
    if (cls === 'overdue')            overdueRaw.push(row)
    else if (cls === 'due_today')     todayRaw.push(row)
    else if (cls === 'upcoming')      upcomingRaw.push(row)
    else if (cls === 'awaiting_no_date') awaitingRaw.push(row)
    else if (cls === 'recently_completed') completedRaw.push(row)
    // 'other' is silently skipped
  }

  const awaitingDeduped = deduplicateAwaitingResponse(awaitingRaw)

  return {
    overdue:          sortOverdue(overdueRaw),
    today:            sortToday(todayRaw),
    upcoming:         sortUpcoming(upcomingRaw),
    awaitingResponse: sortAwaitingResponse(awaitingDeduped, today),
    recentlyCompleted: sortRecentlyCompleted(completedRaw),
  }
}

// ── Waiting count and summary copy ───────────────────────────────────────────

/**
 * The number of conversations actively waiting on the user.
 * Includes: overdue + today + awaiting-response.
 * Excludes: upcoming, recently completed.
 *
 * @param {Array} overdue
 * @param {Array} todayItems
 * @param {Array} awaitingResponse
 */
export function waitingCount(overdue, todayItems, awaitingResponse) {
  return overdue.length + todayItems.length + awaitingResponse.length
}

/**
 * Grammatically correct page-summary copy for the waiting count.
 * Returns null when count is 0 (caller suppresses the summary line).
 *
 * @param {number} count
 * @returns {string|null}
 */
export function waitingCopy(count) {
  if (count === 0) return null
  if (count === 1) return '1 conversation is waiting on you.'
  return `${count} conversations are waiting on you.`
}

// ── DB payload constructors ───────────────────────────────────────────────────

/**
 * Payload for completing a follow-up (Done or Log Result).
 *
 * Preserves the previous follow-up date for Undo, sets the completion
 * timestamp, records the method, and clears the active date.
 *
 * @param {string|null} currentFollowUpDate  Current follow_up_date (YYYY-MM-DD or null)
 * @param {'mark_done'|'log_result'} method
 * @param {string} nowISO  Current UTC timestamp as ISO string (new Date().toISOString())
 * @returns {object}
 */
export function completionPayload(currentFollowUpDate, method, nowISO) {
  return {
    follow_up_previous_date:    currentFollowUpDate || null,
    follow_up_completed_at:     nowISO,
    follow_up_completion_method: method,
    follow_up_date:             null,
  }
}

/**
 * Payload for undoing a completion.
 *
 * Restores the exact previous date; clears all completion metadata.
 *
 * @param {string|null} previousDate  follow_up_previous_date from the row
 * @returns {object}
 */
export function undoPayload(previousDate) {
  return {
    follow_up_date:             previousDate || null,
    follow_up_previous_date:    null,
    follow_up_completed_at:     null,
    follow_up_completion_method: null,
  }
}

/**
 * Payload fields that clear stale completion metadata.
 *
 * Merge these into any update that sets a new active follow_up_date
 * (Snooze, Nudge, new interaction with date, interaction edit with date).
 *
 * @returns {object}
 */
export function clearCompletionFields() {
  return {
    follow_up_completed_at:     null,
    follow_up_previous_date:    null,
    follow_up_completion_method: null,
  }
}

/**
 * Full payload for a snooze or nudge action (sets new date + clears stale metadata).
 *
 * @param {string} newDate  YYYY-MM-DD
 * @returns {object}
 */
export function snoozePayload(newDate) {
  return {
    follow_up_date: newDate,
    ...clearCompletionFields(),
  }
}

// ── Badge eligibility ─────────────────────────────────────────────────────────

/**
 * Whether a row should be counted in the sidebar/BottomNav due badge.
 *
 * Counts only open follow-ups that are due today or overdue.
 * Excludes: upcoming, awaiting-without-date, recently completed, null date.
 *
 * @param {object} row
 * @param {string} today  YYYY-MM-DD
 */
export function isBadgeEligible(row, today) {
  return (
    Boolean(row.follow_up_date) &&
    row.follow_up_date <= today &&
    !row.follow_up_completed_at
  )
}

// ── Status label helpers ──────────────────────────────────────────────────────

/**
 * Human-readable due-date label for an open dated follow-up.
 *
 * @param {string} dateStr  YYYY-MM-DD
 * @param {string} today    YYYY-MM-DD
 * @returns {string}
 */
export function dueLabelStr(dateStr, today) {
  if (!dateStr) return ''
  if (dateStr === today) return 'Due today'
  const [y, m, d] = dateStr.split('-').map(Number)
  const [ty, tm, td] = today.split('-').map(Number)
  const diffMs = Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)
  const days = Math.round(Math.abs(diffMs) / 86400000)
  if (dateStr < today) return days === 1 ? '1 day overdue' : `${days} days overdue`
  if (days === 1) return 'Tomorrow'
  if (days < 7) return `In ${days} days`
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Human-readable waiting label for an awaiting-response row.
 *
 * @param {string} interactionDate  YYYY-MM-DD
 * @param {string} today            YYYY-MM-DD
 * @returns {string}
 */
export function waitingLabelStr(interactionDate, today) {
  const days = daysWaiting(interactionDate, today)
  if (days <= 0) return 'Sent today'
  if (days === 1) return 'Waiting 1 day'
  return `Waiting ${days} days`
}

/**
 * Human-readable completion label for a recently-completed row.
 *
 * @param {string} utcTimestamp  follow_up_completed_at ISO string
 * @param {string} today         YYYY-MM-DD
 * @returns {string}
 */
export function completionLabel(utcTimestamp, today) {
  if (!utcTimestamp) return ''
  const localDate = completedLocalDate(utcTimestamp)
  if (localDate === today) return 'Today'
  if (localDate === localDateOffset(today, -1)) return 'Yesterday'
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Human-readable completion method label for the recently-completed row.
 *
 * @param {'mark_done'|'log_result'|null} method
 * @returns {string}
 */
export function completionMethodLabel(method) {
  if (method === 'mark_done') return 'Done'
  if (method === 'log_result') return 'Log Result'
  return ''
}
