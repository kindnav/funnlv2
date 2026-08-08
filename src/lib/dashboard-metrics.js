/**
 * Dashboard business logic — pure functions, no React/Supabase dependencies.
 * Safe to import in Node.js test files.
 *
 * "This week" = current local calendar week: Monday 00:00 local → now.
 * Date-only arithmetic uses UTC ordinals to avoid DST-shift errors.
 */

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Returns today as YYYY-MM-DD in the local calendar.
 * Accepts an optional `now` Date for testing.
 */
export function getLocalToday(now = new Date()) {
  return (
    `${now.getFullYear()}-` +
    `${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}`
  )
}

/**
 * Returns Monday of the current local week as YYYY-MM-DD.
 * Sunday (getDay()===0) → previous Monday (offset -6).
 * Monday (getDay()===1) → same day (offset 0).
 */
export function getLocalWeekStartDate(now = new Date()) {
  const offset = now.getDay() === 0 ? -6 : 1 - now.getDay()
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  return (
    `${monday.getFullYear()}-` +
    `${String(monday.getMonth() + 1).padStart(2, '0')}-` +
    `${String(monday.getDate()).padStart(2, '0')}`
  )
}

/**
 * Returns the ISO timestamp of local Monday 00:00 for the current week.
 * Use this to filter contacts.created_at (timestamptz returned as UTC ISO string).
 *
 * `new Date(y, m-1, d, 0, 0, 0, 0)` creates local midnight regardless of DST,
 * then toISOString() converts to UTC — giving the correct UTC reference point.
 */
export function getLocalWeekStartISO(now = new Date()) {
  const yyyyMmDd = getLocalWeekStartDate(now)
  const [y, m, d] = yyyyMmDd.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
}

/**
 * Converts a YYYY-MM-DD string to a UTC-based day ordinal (days since epoch).
 * Safe across DST boundaries — never parses date-only strings with new Date().
 * Date.UTC(y, m-1, d) gives stable UTC midnight regardless of local timezone.
 */
export function dayOrdinal(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
}

/**
 * Returns todayStr minus dateStr in whole days (positive when today is after dateStr).
 */
export function daysBetween(todayStr, dateStr) {
  return dayOrdinal(todayStr) - dayOrdinal(dateStr)
}

// ── Tag / outreach helpers ─────────────────────────────────────────────────────

/**
 * Returns the most common tag (case-insensitive, trimmed) across all contacts,
 * or null if no contacts have any tags.
 */
export function computeTopTag(contacts) {
  const counts = {}
  for (const c of contacts) {
    for (const tag of (c.tags || [])) {
      const t = tag.trim().toLowerCase()
      if (t) counts[t] = (counts[t] || 0) + 1
    }
  }
  let top = null, max = 0
  for (const [t, n] of Object.entries(counts)) {
    if (n > max) { top = t; max = n }
  }
  return top
}

/**
 * Response rate: positive / resolved.
 *
 *   positive = responded + meeting_booked
 *   resolved = responded + meeting_booked + no_response + declined
 *
 * awaiting_response is excluded from the denominator — it is pending, not resolved.
 * Returns null when there are no resolved interactions.
 */
export function computeResponseRate(interactions) {
  const positive = interactions.filter(i =>
    ['responded', 'meeting_booked'].includes(i.outreach_status)
  ).length
  const resolved = interactions.filter(i =>
    ['responded', 'meeting_booked', 'no_response', 'declined'].includes(i.outreach_status)
  ).length
  return resolved > 0 ? Math.round(positive / resolved * 100) : null
}

// ── Relationship signals ──────────────────────────────────────────────────────

/**
 * Computes relationship signals from the full contacts and interactions arrays.
 *
 * hasOpenFollowUp = any non-null follow_up_date for the contact (due, overdue, or future).
 * A contact that already has any follow-up set is being tracked in the follow-up
 * module and should not also appear as "going quiet" or "no next action".
 *
 * Signal types (by priority):
 *   going_quiet    — 22+ days since last touch, 2+ interactions, no open follow-up
 *   responded      — outreach replied/meeting booked within the last 7 days
 *   no_next_action — 7-21 days since last touch, no open follow-up
 *
 * Exactly one signal per contact (highest-priority applicable signal wins).
 * Returns up to 5 signals, sorted by priority.
 */
export function computeSignals(contacts, interactions, todayStr) {
  const contactMap = Object.fromEntries(contacts.map(c => [c.id, c]))
  const byContact = {}
  for (const i of interactions) {
    if (!byContact[i.contact_id]) byContact[i.contact_id] = []
    byContact[i.contact_id].push(i)
  }
  for (const id in byContact) {
    byContact[id].sort((a, b) => b.interaction_date.localeCompare(a.interaction_date))
  }

  const signals = []
  for (const [contactId, ixns] of Object.entries(byContact)) {
    const contact = contactMap[contactId]
    if (!contact) continue
    const latest = ixns[0]
    const daysSince = daysBetween(todayStr, latest.interaction_date)
    // Any non-null follow_up_date counts — due, overdue, and future all block the signal.
    const hasOpenFollowUp = ixns.some(i => i.follow_up_date != null)

    if (daysSince > 21 && ixns.length >= 2 && !hasOpenFollowUp) {
      signals.push({ type: 'going_quiet', contact, daysSince, href: `/contacts/${contactId}` })
    } else if (daysSince <= 7 && ['responded', 'meeting_booked'].includes(latest.outreach_status)) {
      signals.push({
        type: 'responded',
        contact,
        daysSince,
        statusLabel: latest.outreach_status === 'meeting_booked' ? 'Meeting booked' : 'Responded',
        href: `/contacts/${contactId}`,
      })
    } else if (daysSince >= 7 && daysSince <= 21 && !hasOpenFollowUp) {
      signals.push({ type: 'no_next_action', contact, daysSince, href: `/contacts/${contactId}` })
    }
  }

  const order = { going_quiet: 0, responded: 1, no_next_action: 2 }
  signals.sort((a, b) => order[a.type] - order[b.type])
  return signals.slice(0, 5)
}

// ── Network signal (all users, rule-based) ────────────────────────────────────

/**
 * Returns the NETWORK SIGNAL card text.
 *
 * This is entirely deterministic — not AI-generated. The true AI weekly insight
 * (which requires a cached or intentionally scheduled generation flow) is behind
 * AI_WEEKLY_INSIGHT_ENABLED = false in DashboardPage.jsx and is not shown.
 */
export function computeNetworkSignal(signals, interactionsThisWeek, awaitingCount, contactCount) {
  const quietCount = signals.filter(s => s.type === 'going_quiet').length
  if (quietCount === 1) return '1 contact is going quiet. Reach out before the momentum fades.'
  if (quietCount > 1) return `${quietCount} contacts are going quiet. Now is a good time to reconnect.`
  if (awaitingCount === 1) return '1 outreach is still awaiting a response. A short follow-up can help.'
  if (awaitingCount > 1) return `${awaitingCount} outreaches are awaiting a response. Consider following up.`
  if (interactionsThisWeek >= 3) return `Strong week. You logged ${interactionsThisWeek} conversations this week.`
  if (contactCount >= 10 && interactionsThisWeek === 0) return 'No conversations logged this week. Pick one contact and say hello.'
  return 'Your network is looking healthy. Keep logging conversations.'
}

// ── Activity feed ─────────────────────────────────────────────────────────────

/**
 * Formats a YYYY-MM-DD date string for the activity feed.
 * - Same as todayStr  → 'Today'
 * - Within last 6 days → short weekday ('Mon', 'Tue', …)
 * - Older              → 'Jul 5' style
 *
 * Day-of-week computed via Date.UTC() to avoid DST-affected getDay() results.
 */
export function formatActivityDate(dateStr, todayStr) {
  if (!dateStr) return ''
  if (dateStr === todayStr) return 'Today'
  const [y, m, d] = dateStr.split('-').map(Number)
  const daysAgo = daysBetween(todayStr, dateStr)
  if (daysAgo <= 6) {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    return dayNames[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  }
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${monthNames[m - 1]} ${d}`
}

/**
 * Returns the label and color for a follow-up date in the compact module.
 * Only called for dates where follow_up_date <= today (due or overdue).
 */
export function followUpLabel(dateStr, todayStr) {
  if (dateStr === todayStr) return { label: 'Today', color: 'var(--color-warning)' }
  const diff = daysBetween(todayStr, dateStr)
  if (diff === 1) return { label: '1d overdue', color: 'var(--color-danger)' }
  return { label: `${diff}d overdue`, color: 'var(--color-danger)' }
}

/**
 * Builds the combined recent activity array from contacts and interactions.
 *
 * Interactions: show type + outreach status.
 * New contacts: labeled 'CONTACT ADDED'. No import-source or AI-origin claims.
 *
 * Sorted descending by sortDate (interaction_date or created_at date part),
 * then by created_at as tiebreaker. Returns first 8 entries.
 */
export function buildRecentActivity(contacts, interactions, contactMap) {
  const entries = [
    ...interactions
      .filter(i => i.interaction_date)
      .map(i => ({
        kind: 'interaction',
        id: i.id,
        sortDate: i.interaction_date,
        sortCreatedAt: i.created_at || '',
        date: i.interaction_date,
        contactId: i.contact_id,
        contactName: contactMap[i.contact_id]?.name || 'Unknown',
        type: i.type,
        outreachStatus: i.outreach_status,
        hasNotes: !!i.notes?.trim(),
      })),
    ...contacts.map(c => ({
      kind: 'contact',
      id: `contact-${c.id}`,
      sortDate: (c.created_at || '').slice(0, 10),
      sortCreatedAt: c.created_at || '',
      date: (c.created_at || '').slice(0, 10),
      contactId: c.id,
      contactName: c.name,
      type: 'CONTACT ADDED',
      outreachStatus: null,
      hasNotes: false,
    })),
  ]
  entries.sort((a, b) => {
    const d = b.sortDate.localeCompare(a.sortDate)
    return d !== 0 ? d : b.sortCreatedAt.localeCompare(a.sortCreatedAt)
  })
  return entries.slice(0, 8)
}
