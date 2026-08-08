/**
 * firmMetrics.js — Pure utilities for computing per-firm networking metrics.
 *
 * No React. No Supabase. No browser APIs.
 * Safe to import in Node.js test files.
 *
 * Run tests with: node tests/top-firm-metrics.test.js
 */

/**
 * Normalize a raw company string for matching / grouping.
 *
 * Conservative: trim, collapse repeated internal whitespace, lowercase, and
 * strip a single trailing period or comma.  No alias expansion — "GS" never
 * maps to "Goldman Sachs".
 *
 * Returns '' for blank / null / undefined input (caller should skip those).
 */
export function normalizeCompanyForMatch(raw) {
  if (!raw) return ''
  const s = String(raw).trim().replace(/\s+/g, ' ').replace(/[.,]+$/, '').trim()
  return s.toLowerCase()
}

/**
 * Build per-firm metrics from the current user's contacts and interactions.
 *
 * Returns an unsorted array of firm objects — call computeTopFirms for the
 * ranked, limited list.
 *
 * @param {Array} contacts     - contact rows; each needs { id, company }
 * @param {Array} interactions - interaction rows; each needs { contact_id, interaction_date }
 * @returns {Array} Array of { firm, contactsCount, spokenWithCount, interactionCount, lastTouch }
 */
export function computeFirmMetrics(contacts, interactions) {
  // Map: normalizedKey → accumulator
  const byKey = new Map()
  // Map: contactId → normalizedKey (built while iterating contacts)
  const contactToKey = new Map()

  for (const c of contacts) {
    const key = normalizeCompanyForMatch(c.company)
    if (!key) continue
    contactToKey.set(c.id, key)
    if (!byKey.has(key)) {
      byKey.set(key, {
        displayName: String(c.company).trim(),
        contactIds: new Set(),
        spokenWithIds: new Set(),
        interactionCount: 0,
        lastTouch: null,
      })
    }
    byKey.get(key).contactIds.add(c.id)
  }

  for (const ix of interactions) {
    const key = contactToKey.get(ix.contact_id)
    if (!key) continue
    const m = byKey.get(key)
    if (!m) continue
    m.spokenWithIds.add(ix.contact_id)
    m.interactionCount++
    if (ix.interaction_date) {
      if (!m.lastTouch || ix.interaction_date > m.lastTouch) {
        m.lastTouch = ix.interaction_date
      }
    }
  }

  return Array.from(byKey.values()).map(m => ({
    firm: m.displayName,
    contactsCount: m.contactIds.size,
    spokenWithCount: m.spokenWithIds.size,
    interactionCount: m.interactionCount,
    lastTouch: m.lastTouch,
  }))
}

/**
 * Return the top N firms ranked by networking activity.
 *
 * Ranking priority (deterministic):
 *   1. spokenWithCount DESC  — actual conversations are the primary signal
 *   2. contactsCount DESC    — breadth of relationships
 *   3. interactionCount DESC — total logged interactions
 *   4. lastTouch DESC        — recency (null sorts last)
 *   5. firm name ASC         — alphabetical tie-breaker
 *
 * @param {Array}  contacts     - contact rows
 * @param {Array}  interactions - interaction rows
 * @param {number} limit        - max firms to return (default 5)
 */
export function computeTopFirms(contacts, interactions, limit = 5) {
  return computeFirmMetrics(contacts, interactions)
    .sort((a, b) => {
      if (b.spokenWithCount !== a.spokenWithCount) return b.spokenWithCount - a.spokenWithCount
      if (b.contactsCount   !== a.contactsCount)   return b.contactsCount   - a.contactsCount
      if (b.interactionCount !== a.interactionCount) return b.interactionCount - a.interactionCount
      const aTouch = a.lastTouch || ''
      const bTouch = b.lastTouch || ''
      if (bTouch !== aTouch) return bTouch.localeCompare(aTouch)
      return a.firm.localeCompare(b.firm)
    })
    .slice(0, limit)
}
