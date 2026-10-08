// Pending suggestions: the count the navigation badge shows and the queue page polls.
//
// Two tables, one number. An interaction suggestion (`interaction_candidates`) and a
// proposed new person (`new_contact_candidates`) are both "something to review", and the
// Suggestions page lists both, so the badge and the refresh poll count both. Head requests
// only: no row, no candidate detail, no contact name ever travels for a count.
//
// THE REFRESH RULE, and why it is a poll. Proposals are written by a server process while
// Funnl may be closed - or open on this very page. The simplest supported way to notice
// them is to re-count the pending rows every REFRESH_INTERVAL_MS while the tab is visible,
// and once more when it becomes visible again. No realtime channel, no publication change,
// no RLS rework: the same two RLS-scoped head counts the badge already makes.

export const SUGGESTIONS_REFRESH_INTERVAL_MS = 30_000
export const SUGGESTIONS_CHANGED_EVENT = 'funnl:suggestions-changed'
export const NEW_SUGGESTIONS_MESSAGE = 'New suggestions arrived. The list has been refreshed.'

/**
 * Pending count across both queues for the signed-in user (RLS scopes the rows), or null
 * when either count failed - a failed count must never read as "nothing pending".
 * @param {object} client  a supabase-js client (injected so this stays testable)
 */
export async function countPendingSuggestions (client) {
  try {
    const [a, b] = await Promise.all([
      client.from('interaction_candidates').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      client.from('new_contact_candidates').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    ])
    if (a?.error || b?.error) return null
    const ca = typeof a?.count === 'number' ? a.count : 0
    const cb = typeof b?.count === 'number' ? b.count : 0
    return ca + cb
  } catch {
    return null
  }
}

/**
 * Pure: given the last count the page knew and a fresh one, what should it do?
 * @returns {{reload:boolean, announce:boolean}}
 */
export function decideRefresh (known, fresh) {
  if (typeof fresh !== 'number') return { reload: false, announce: false }
  if (typeof known !== 'number') return { reload: false, announce: false }   // first observation: learn only
  if (fresh === known) return { reload: false, announce: false }
  return { reload: true, announce: fresh > known }
}

/** The badge text: numbers up to 9, then "9+". */
export function badgeLabel (count) {
  if (!Number.isInteger(count) || count < 1) return null
  return count > 9 ? '9+' : String(count)
}
