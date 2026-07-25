// Shared pure helpers for AI contact categorization.
// No Deno, Node.js, or browser APIs — safe in any ES module environment.
// Imported by:
//   - supabase/functions/ai-categorize-contacts/index.ts (Deno Edge Function)
//   - tests/ai-helpers.test.js (Node.js test runner)

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const MAX_CONTACTS = 20
export const ALLOWED_CONFIDENCE = new Set(['high', 'medium', 'low'])
export const ALLOWED_REL_TYPES = new Set(['Mentor', 'Collaborator', 'Referral path', 'Potential employer', 'Connector', 'Other'])

/**
 * Normalize a tag string: trim, lowercase.
 * Returns null for non-string, empty string after trim, or strings longer than 50 chars.
 */
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return null
  const t = raw.trim().toLowerCase()
  if (t.length === 0 || t.length > 50) return null
  return t
}

/**
 * Normalize an array of tags: trim, lowercase, dedup, cap at limit.
 * Invalid entries are silently skipped.
 */
export function normalizeTags(rawTags, limit) {
  const seen = new Set()
  const result = []
  for (const raw of rawTags) {
    const t = normalizeTag(raw)
    if (t && !seen.has(t)) {
      seen.add(t)
      result.push(t)
      if (result.length >= limit) break
    }
  }
  return result
}

/**
 * Sanitize and deduplicate Claude's output array.
 * - Returns null if parsed is not an array (triggers invalid_shape error in caller)
 * - Discards entries with unknown row_id, invalid confidence, no tags and no relType
 * - First VALID suggestion per row_id wins; later duplicates discarded
 * - Tags: strings only, trim, lowercase, dedup, max 5, max 50 chars each
 * - relType: must be one of the allowed values or null
 *
 * @param {unknown} parsed     - Raw parsed JSON from Claude (must be array)
 * @param {Set<string>} seenInputIds - Set of row_ids that were sent to Claude
 * @returns {Array|null}
 */
export function sanitizeOutput(parsed, seenInputIds) {
  if (!Array.isArray(parsed)) return null
  const usedOutputIds = new Set()
  return parsed.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return []
    const e = entry
    const rowId = typeof e.row_id === 'string' ? e.row_id : null
    if (!rowId || !seenInputIds.has(rowId)) return []
    if (usedOutputIds.has(rowId)) return []
    if (!ALLOWED_CONFIDENCE.has(e.confidence)) return []
    const confidence = e.confidence
    const tags = normalizeTags(Array.isArray(e.suggested_tags) ? e.suggested_tags : [], 5)
    const relType = typeof e.suggested_relationship_type === 'string' &&
      ALLOWED_REL_TYPES.has(e.suggested_relationship_type)
      ? e.suggested_relationship_type
      : null
    if (tags.length === 0 && !relType) return []
    // Mark ID used only after all validation passes — first VALID suggestion wins
    usedOutputIds.add(rowId)
    return [{ row_id: rowId, suggested_tags: tags, suggested_relationship_type: relType, confidence }]
  })
}
