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
 * Split a raw tag input on commas, semicolons, pipes, carriage returns, and newlines.
 * Trims each segment and removes empty values.
 * Accepts either a string (splits it) or an array (splits each element).
 * Returns a flat array of non-empty trimmed strings. Normalization is NOT applied here.
 *
 * @param {string|string[]} input
 * @returns {string[]}
 */
export function splitTagsFromCsv(input) {
  if (Array.isArray(input)) {
    return input.flatMap(item =>
      typeof item === 'string' ? item.split(/[,;|\r\n]+/).map(s => s.trim()).filter(Boolean) : []
    )
  }
  if (typeof input === 'string') {
    return input.split(/[,;|\r\n]+/).map(s => s.trim()).filter(Boolean)
  }
  return []
}

/**
 * Merge tags from multiple sources with case-insensitive deduplication.
 * Priority order: CSV/existing first, then AI-suggested, then custom user-added.
 * No total count limit — all valid, unique tags are retained.
 * Invalid tags (non-string, empty after trim, longer than 50 chars) are silently dropped.
 * Each source may be a delimited string or an array; splitTagsFromCsv is applied to each.
 *
 * @param {string|string[]} csvTags      - Tags from the CSV file (string or array)
 * @param {string|string[]} existingTags - Existing contact tags (reserved for future use, pass [])
 * @param {string|string[]} aiTags       - Tags suggested by AI (high-confidence only)
 * @param {string|string[]} customTags   - Tags manually added by the user in the UI
 * @returns {string[]}
 */
export function mergeContactTags(csvTags = [], existingTags = [], aiTags = [], customTags = []) {
  const seen = new Set()
  const result = []
  const sources = [
    ...splitTagsFromCsv(csvTags),
    ...splitTagsFromCsv(existingTags),
    ...splitTagsFromCsv(aiTags),
    ...splitTagsFromCsv(customTags),
  ]
  for (const raw of sources) {
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
