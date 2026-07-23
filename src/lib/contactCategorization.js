// Production helpers for contact tag management in the CSV import flow.
// Pure functions with no browser/Node/Deno APIs — safe to import in any environment.
// Imported by:
//   - src/components/ImportContactsModal.jsx (React component)
//   - tests/ai-helpers.test.js (Node.js test runner)

/**
 * Normalize a single tag string: trim, lowercase.
 * Returns null for non-string, empty string after trim, or strings longer than 50 chars.
 */
export function normalizeContactTag(raw) {
  if (typeof raw !== 'string') return null
  const t = raw.trim().toLowerCase()
  if (t.length === 0 || t.length > 50) return null
  return t
}

/**
 * Merge tags from multiple sources with case-insensitive deduplication.
 * Priority order: CSV/existing first, then AI-suggested, then custom user-added.
 * No total count limit — all valid, unique tags are retained.
 * Invalid tags (non-string, empty after trim, longer than 50 chars) are silently dropped.
 *
 * @param {string[]} csvTags      - Tags from the CSV file
 * @param {string[]} existingTags - Existing contact tags (reserved for future use, pass [])
 * @param {string[]} aiTags       - Tags suggested by AI and accepted by the user
 * @param {string[]} customTags   - Tags manually added by the user in the UI
 * @returns {string[]}
 */
export function mergeContactTags(csvTags = [], existingTags = [], aiTags = [], customTags = []) {
  const seen = new Set()
  const result = []
  for (const raw of [...csvTags, ...existingTags, ...aiTags, ...customTags]) {
    const t = normalizeContactTag(raw)
    if (t && !seen.has(t)) {
      seen.add(t)
      result.push(t)
    }
  }
  return result
}

/**
 * Split an array of contacts into batches of at most batchSize elements.
 * No contacts are omitted or duplicated. Order is preserved.
 *
 * @param {unknown[]} contacts
 * @param {number} batchSize
 * @returns {unknown[][]}
 */
export function splitContactBatches(contacts, batchSize) {
  const batches = []
  for (let i = 0; i < contacts.length; i += batchSize) {
    batches.push(contacts.slice(i, i + batchSize))
  }
  return batches
}
