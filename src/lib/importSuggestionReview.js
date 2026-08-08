// Per-row AI suggestion review state management.
// No React, Supabase, or browser APIs — safe to unit-test in Node.js.
//
// State model:
//   Map<rowId, RowSuggestionState>
//
//   RowSuggestionState {
//     tags: TagItem[]
//     relType: RelTypeItem | null
//     customTags: string[]
//   }
//
//   TagItem {
//     id: string            — stable ID: `${rowId}:tag:${normalizedTag}` (deduped at init)
//     tag: string           — normalized lowercase tag
//     confidence: string    — 'high'|'medium'|'low'
//     state: SuggestionState
//     editedValue: string|null
//   }
//
//   RelTypeItem {
//     id: string            — stable ID: `${rowId}:reltype`
//     value: string
//     confidence: string
//     state: SuggestionState
//     editedValue: string|null
//   }
//
//   SuggestionState: 'pending'|'accepted'|'rejected'|'edited'
//
// Stable suggestion IDs:
//   Tags are identified by `${rowId}:tag:${normalizedTag}` — derived from the original
//   AI suggestion value, NOT from array position. Deduplication at initialization prevents
//   two tags from sharing the same ID. Operations (accept/reject/edit) find items by ID,
//   so reordering, filtering, or rebuilding the array after Back→Review navigation cannot
//   accidentally mutate the wrong suggestion.
//
// High-confidence suggestions start ACCEPTED (preselected, user can reject/edit).
// Medium/low suggestions start PENDING (user must accept).
// Only ACCEPTED and EDITED states enter the import payload.
// CSV relationship_type always wins over AI suggestions.
// State survives Map→Review→Map→Review navigation via stable _rowId keys.

export const SUGGESTION_STATES = Object.freeze({
  PENDING:  'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  EDITED:   'edited',
})

// Valid relationship type values from the contacts schema.
// Used for the relType Change dropdown — do not add or remove values.
export const RELATIONSHIP_TYPE_VALUES = [
  'Mentor',
  'Collaborator',
  'Referral path',
  'Potential employer',
  'Connector',
  'Other',
]

const { PENDING, ACCEPTED, REJECTED, EDITED } = SUGGESTION_STATES

// ── Stable ID helpers ─────────────────────────────────────────────────────────

function makeTagId(rowId, normalizedTag) {
  return `${rowId}:tag:${normalizedTag}`
}

function makeRelTypeId(rowId) {
  return `${rowId}:reltype`
}

// ── Initialize ────────────────────────────────────────────────────────────────

/**
 * Initialize suggestion review state from review rows.
 *
 * When existingState is provided, user decisions for known rowIds are preserved.
 * Only rowIds not found in existingState are initialized fresh from AI suggestions.
 * Tags are deduplicated by normalized value at initialization so that no two TagItems
 * share the same stable ID within a row.
 *
 * @param {Array<Object>} reviewRows - from buildReviewRows (must have _rowId + _suggestion)
 * @param {Map<string, object>} [existingState] - prior state to preserve user decisions
 * @returns {Map<string, RowSuggestionState>}
 */
export function initSuggestionReview(reviewRows, existingState) {
  if (!Array.isArray(reviewRows)) return new Map()
  const result = new Map()

  for (const row of reviewRows) {
    const rowId = row._rowId

    // Preserve existing user decisions for this rowId across navigation
    if (existingState instanceof Map && existingState.has(rowId)) {
      result.set(rowId, existingState.get(rowId))
      continue
    }

    const sug = row._suggestion
    if (!sug) {
      result.set(rowId, { tags: [], relType: null, customTags: [] })
      continue
    }

    const sugConf = typeof sug.confidence === 'string' ? sug.confidence : 'low'
    const initialTagState = sugConf === 'high' ? ACCEPTED : PENDING

    // Build TagItems with stable IDs; deduplicate by normalized value.
    const seenTagIds = new Set()
    const tagItems = Array.isArray(sug.suggested_tags)
      ? sug.suggested_tags
          .filter(t => typeof t === 'string' && t.trim())
          .reduce((acc, t) => {
            const normalized = t.trim().toLowerCase()
            const id = makeTagId(rowId, normalized)
            if (seenTagIds.has(id)) return acc  // deduplicate
            seenTagIds.add(id)
            acc.push({
              id,
              tag:         normalized,
              confidence:  sugConf,
              state:       initialTagState,
              editedValue: null,
            })
            return acc
          }, [])
      : []

    // Only suggest relType when CSV didn't already supply one
    const csvHasRelType = typeof row.relationship_type === 'string' && row.relationship_type.trim()
    let relType = null
    if (sug.suggested_relationship_type && !csvHasRelType) {
      relType = {
        id:          makeRelTypeId(rowId),
        value:       sug.suggested_relationship_type,
        confidence:  sugConf,
        state:       sugConf === 'high' ? ACCEPTED : PENDING,
        editedValue: null,
      }
    }

    result.set(rowId, { tags: tagItems, relType, customTags: [] })
  }
  return result
}

// ── Tag mutations (by stable suggestion ID, NOT by array position) ─────────────

/**
 * Accept a tag suggestion. Identified by stable suggestionId, not array index.
 * Works from any non-rejected state.
 */
export function acceptTagSuggestion(suggestionReview, rowId, suggestionId) {
  return updateRow(suggestionReview, rowId, s => ({
    ...s,
    tags: s.tags.map(t => t.id === suggestionId ? { ...t, state: ACCEPTED } : t),
  }))
}

/**
 * Reject a tag suggestion. Identified by stable suggestionId, not array index.
 * Works from any state.
 */
export function rejectTagSuggestion(suggestionReview, rowId, suggestionId) {
  return updateRow(suggestionReview, rowId, s => ({
    ...s,
    tags: s.tags.map(t => t.id === suggestionId ? { ...t, state: REJECTED } : t),
  }))
}

/**
 * Edit a tag suggestion value. Transitions to EDITED (or REJECTED if empty).
 * Identified by stable suggestionId, not array index.
 */
export function editTagSuggestion(suggestionReview, rowId, suggestionId, newValue) {
  const v = typeof newValue === 'string' ? newValue.trim().toLowerCase() : ''
  return updateRow(suggestionReview, rowId, s => ({
    ...s,
    tags: s.tags.map(t =>
      t.id === suggestionId
        ? { ...t, state: v ? EDITED : REJECTED, editedValue: v || null }
        : t
    ),
  }))
}

/**
 * Add a custom (user-typed) tag to a row. Deduplicates (normalized lowercase).
 */
export function addCustomTag(suggestionReview, rowId, tagValue) {
  const v = typeof tagValue === 'string' ? tagValue.trim().toLowerCase() : ''
  if (!v) return suggestionReview
  return updateRow(suggestionReview, rowId, s => ({
    ...s,
    customTags: s.customTags.includes(v) ? s.customTags : [...s.customTags, v],
  }))
}

/**
 * Remove a custom tag from a row.
 */
export function removeCustomTag(suggestionReview, rowId, tagValue) {
  return updateRow(suggestionReview, rowId, s => ({
    ...s,
    customTags: s.customTags.filter(t => t !== tagValue),
  }))
}

// ── RelType mutations ─────────────────────────────────────────────────────────

/**
 * Accept the relationship type suggestion.
 */
export function acceptRelTypeSuggestion(suggestionReview, rowId) {
  return updateRow(suggestionReview, rowId, s => ({
    ...s,
    relType: s.relType ? { ...s.relType, state: ACCEPTED } : null,
  }))
}

/**
 * Reject the relationship type suggestion.
 */
export function rejectRelTypeSuggestion(suggestionReview, rowId) {
  return updateRow(suggestionReview, rowId, s => ({
    ...s,
    relType: s.relType ? { ...s.relType, state: REJECTED } : null,
  }))
}

/**
 * Change the relationship type to a user-selected value from the schema enum.
 * Transitions to EDITED. Empty or invalid value transitions to REJECTED.
 * Validates against RELATIONSHIP_TYPE_VALUES.
 */
export function changeRelTypeSuggestion(suggestionReview, rowId, newValue) {
  const v = typeof newValue === 'string' ? newValue.trim() : ''
  const valid = RELATIONSHIP_TYPE_VALUES.includes(v)
  return updateRow(suggestionReview, rowId, s => ({
    ...s,
    relType: s.relType
      ? { ...s.relType, state: valid ? EDITED : REJECTED, editedValue: valid ? v : null }
      : null,
  }))
}

/**
 * Edit the relationship type suggestion value (free-form).
 * @deprecated Use changeRelTypeSuggestion for enum-validated changes.
 * Kept for backward compatibility.
 */
export function editRelTypeSuggestion(suggestionReview, rowId, newValue) {
  const v = typeof newValue === 'string' ? newValue.trim() : ''
  return updateRow(suggestionReview, rowId, s => ({
    ...s,
    relType: s.relType
      ? { ...s.relType, state: v ? EDITED : REJECTED, editedValue: v || null }
      : null,
  }))
}

// ── Derivation ────────────────────────────────────────────────────────────────

/**
 * Derive the final merged tags for a row.
 * CSV tags always come first; accepted/edited AI suggestions and custom tags appended.
 * Deduplicates using normalized lowercase comparison.
 *
 * @param {string[]} csvTags - tags from the CSV import (always included)
 * @param {object|null} rowState - entry from the suggestion review Map
 * @returns {string[]}
 */
export function getFinalTags(csvTags, rowState) {
  const seen   = new Set()
  const result = []

  function add(t) {
    const n = typeof t === 'string' ? t.trim().toLowerCase() : ''
    if (n && !seen.has(n)) { seen.add(n); result.push(n) }
  }

  ;(Array.isArray(csvTags) ? csvTags : []).forEach(add)

  if (rowState) {
    for (const item of (rowState.tags || [])) {
      if (item.state === ACCEPTED)              add(item.tag)
      else if (item.state === EDITED && item.editedValue) add(item.editedValue)
    }
    for (const t of (rowState.customTags || [])) add(t)
  }

  return result
}

/**
 * Derive the final relationship type for a row.
 * CSV value always wins; AI suggestion only applies when CSV had none.
 *
 * @param {string|undefined} csvRelType - relationship_type from the CSV row
 * @param {object|null} rowState - entry from the suggestion review Map
 * @returns {string|undefined}
 */
export function getFinalRelType(csvRelType, rowState) {
  if (csvRelType && typeof csvRelType === 'string' && csvRelType.trim()) {
    return csvRelType.trim()
  }
  if (!rowState?.relType) return undefined
  const { state, value, editedValue } = rowState.relType
  if (state === ACCEPTED) return value
  if (state === EDITED)   return editedValue || undefined
  return undefined
}

// ── Internal ──────────────────────────────────────────────────────────────────

function updateRow(suggestionReview, rowId, updater) {
  if (!(suggestionReview instanceof Map)) return suggestionReview
  const current = suggestionReview.get(rowId)
  if (!current) return suggestionReview
  const next = new Map(suggestionReview)
  next.set(rowId, updater(current))
  return next
}
