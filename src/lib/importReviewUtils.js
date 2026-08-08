// Pure helpers for the import review step.
// No React, Supabase, or browser APIs — safe to unit-test in Node.js.
// Imported by src/components/ImportContactsModal.jsx and tests/import-review-utils.test.js
// Also imported by tests/import-existing-duplicates.test.js

/**
 * Normalize a contact name for duplicate detection.
 * Lowercase, trim, collapse internal whitespace.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeNameForDedup(name) {
  if (typeof name !== 'string') return ''
  return name.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Normalize a company name for duplicate detection.
 * Lowercase, trim, collapse internal whitespace.
 *
 * @param {string} company
 * @returns {string}
 */
export function normalizeCompanyForDedup(company) {
  if (typeof company !== 'string') return ''
  return company.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Detect within-batch duplicates by normalized name.
 * The first occurrence of a name is canonical; all later occurrences are duplicates.
 * Rows with missing/empty names are not considered duplicates (handled separately).
 *
 * @param {Array<{_rowId: string, name?: string}>} contacts
 * @returns {Map<string, string>} duplicateRowId → canonicalRowId
 */
export function detectDuplicatesInBatch(contacts) {
  if (!Array.isArray(contacts)) return new Map()
  const seen = new Map() // normalizedName → first _rowId
  const duplicates = new Map() // duplicateRowId → canonicalRowId
  for (const c of contacts) {
    const norm = normalizeNameForDedup(c.name || '')
    if (!norm) continue // missing name — handled as _isMissingName, not a duplicate
    if (seen.has(norm)) {
      duplicates.set(c._rowId, seen.get(norm))
    } else {
      seen.set(norm, c._rowId)
    }
  }
  return duplicates
}

/**
 * Build annotated review rows from raw contacts + AI suggestions + duplicate map.
 * Each row receives:
 *   _isMissingName   — true if name is blank
 *   _isDuplicate     — true if a later row with same normalized name
 *   _duplicateOfName — name of the canonical row this duplicates
 *   _suggestion      — AI suggestion object or null
 *   _defaultSelected — true unless duplicate or missing name
 *
 * @param {Array<{_rowId: string, name?: string, [key: string]: any}>} contacts
 * @param {Object} suggestionsMap - _rowId → { suggested_tags, suggested_relationship_type, confidence }
 * @param {Map<string, string>} duplicatesMap - from detectDuplicatesInBatch
 * @returns {Array<Object>} annotated review rows
 */
export function buildReviewRows(contacts, suggestionsMap = {}, duplicatesMap = new Map()) {
  if (!Array.isArray(contacts)) return []
  const rowIdToName = new Map(contacts.map(c => [c._rowId, c.name || '']))
  return contacts.map(c => {
    const isMissingName = !c.name || !c.name.trim()
    const isDuplicate = duplicatesMap.has(c._rowId)
    const duplicateOfId = isDuplicate ? duplicatesMap.get(c._rowId) : null
    const duplicateOfName = duplicateOfId ? (rowIdToName.get(duplicateOfId) || '') : ''
    const suggestion = (suggestionsMap && suggestionsMap[c._rowId]) ?? null
    return {
      ...c,
      _isMissingName: isMissingName,
      _isDuplicate: isDuplicate,
      _duplicateOfName: duplicateOfName,
      _suggestion: suggestion,
      _defaultSelected: !isMissingName && !isDuplicate,
    }
  })
}

/**
 * Aggregate AI-suggested tags across review rows.
 * Only tags from the AI _suggestion field are counted (not CSV tags).
 * Tags from high-confidence suggestions are labeled HIGH; medium → MEDIUM; low → LOW.
 * If the same tag appears at multiple confidence levels, the highest level wins.
 * Results sorted by count descending, then alphabetically.
 *
 * @param {Array<Object>} reviewRows
 * @returns {Array<{tag: string, count: number, confidence: 'high'|'medium'|'low'}>}
 */
export function computeTagSummary(reviewRows) {
  if (!Array.isArray(reviewRows)) return []
  const tagMap = new Map() // tag → { high: 0, medium: 0, low: 0 }
  for (const row of reviewRows) {
    const sug = row._suggestion
    if (!sug || !Array.isArray(sug.suggested_tags)) continue
    const conf = typeof sug.confidence === 'string' ? sug.confidence : 'low'
    for (const tag of sug.suggested_tags) {
      if (typeof tag !== 'string' || !tag.trim()) continue
      const t = tag.trim().toLowerCase()
      if (!tagMap.has(t)) tagMap.set(t, { high: 0, medium: 0, low: 0 })
      const counts = tagMap.get(t)
      if (conf === 'high' || conf === 'medium' || conf === 'low') {
        counts[conf] = (counts[conf] || 0) + 1
      }
    }
  }
  return Array.from(tagMap.entries())
    .map(([tag, counts]) => {
      const total = counts.high + counts.medium + counts.low
      const confidence = counts.high > 0 ? 'high' : counts.medium > 0 ? 'medium' : 'low'
      return { tag, count: total, highCount: counts.high, mediumCount: counts.medium, lowCount: counts.low, confidence }
    })
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/**
 * Build the final DB insert payload from selected review rows.
 * - Only rows in selectedIds are included.
 * - Rows still missing a name are silently dropped (safety guard).
 * - High-confidence AI suggestions are applied: tags merged, relationship_type set if unset.
 * - All internal _* fields are stripped before returning.
 *
 * @param {Array<Object>} reviewRows - annotated review rows from buildReviewRows
 * @param {Set<string>} selectedIds - _rowId values to include
 * @param {string} userId
 * @returns {Array<Object>} contacts ready for Supabase insert
 */
export function buildImportPayload(reviewRows, selectedIds, userId) {
  if (!Array.isArray(reviewRows) || !(selectedIds instanceof Set) || typeof userId !== 'string') return []
  const result = []
  for (const row of reviewRows) {
    if (!selectedIds.has(row._rowId)) continue
    if (!row.name || !row.name.trim()) continue // safety: never import nameless
    // Strip all internal _* fields
    const contact = {}
    for (const [key, val] of Object.entries(row)) {
      if (!key.startsWith('_')) contact[key] = val
    }
    contact.user_id = userId
    // Apply high-confidence AI suggestions
    const sug = row._suggestion
    if (sug && sug.confidence === 'high') {
      const aiTags = Array.isArray(sug.suggested_tags) ? sug.suggested_tags : []
      if (aiTags.length > 0) {
        const existing = Array.isArray(contact.tags) ? contact.tags : []
        const seen = new Set(existing.map(t => (t || '').toLowerCase()))
        const merged = [...existing]
        for (const t of aiTags) {
          const norm = (t || '').trim().toLowerCase()
          if (norm && !seen.has(norm)) { merged.push(norm); seen.add(norm) }
        }
        if (merged.length > 0) contact.tags = merged
      }
      if (sug.suggested_relationship_type && !contact.relationship_type) {
        contact.relationship_type = sug.suggested_relationship_type
      }
    }
    result.push(contact)
  }
  return result
}

/**
 * Compute stats for the done screen.
 * Returns counts of duplicates deselected (not in selectedIds),
 * missing-name rows, and how many were actually imported.
 *
 * @param {Array<Object>} reviewRows - all review rows
 * @param {number} importedCount - actual count inserted successfully
 * @returns {{ importedCount: number, duplicatesSkipped: number, missingNameCount: number }}
 */
export function computeDoneStats(reviewRows, importedCount) {
  if (!Array.isArray(reviewRows)) return { importedCount: 0, duplicatesSkipped: 0, missingNameCount: 0 }
  let duplicatesSkipped = 0
  let missingNameCount = 0
  for (const row of reviewRows) {
    if (row._isDuplicate) duplicatesSkipped++
    if (row._isMissingName) missingNameCount++
  }
  return { importedCount: importedCount || 0, duplicatesSkipped, missingNameCount }
}

/**
 * Normalize an email address for duplicate detection.
 * Lowercase, trim. Does not validate format.
 *
 * @param {string} email
 * @returns {string}
 */
export function normalizeEmailForDedup(email) {
  if (typeof email !== 'string') return ''
  return email.toLowerCase().trim()
}

/**
 * Normalize a LinkedIn URL for duplicate detection.
 * Strips protocol, www prefix, and trailing slash so
 * "https://www.linkedin.com/in/foo/" and "linkedin.com/in/foo" match.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeLinkedinForDedup(url) {
  if (typeof url !== 'string') return ''
  let u = url.toLowerCase().trim()
  u = u.replace(/^https?:\/\//, '')
  u = u.replace(/^www\./, '')
  u = u.replace(/\/$/, '')
  return u
}

/**
 * Detect which incoming contacts already exist in the user's Funnl database.
 * Matching priority (first-match wins):
 *   1. email (exact normalized)
 *   2. linkedin_url (normalized)
 *   3. name + company (both must be non-empty, both must match)
 *
 * Name-alone matching was intentionally removed to prevent false positives on
 * common names. Both name AND company must be present and matching.
 *
 * existingContacts must include the 'company' field (fetch: 'id, name, company, email, linkedin_url').
 *
 * @param {Array<{_rowId: string, name?: string, company?: string, email?: string, linkedin_url?: string}>} incomingContacts
 * @param {Array<{id: string, name?: string, company?: string, email?: string, linkedin_url?: string}>} existingContacts
 * @returns {Map<string, {id: string, name: string}>} rowId → existing contact stub
 */
export function detectDatabaseDuplicates(incomingContacts, existingContacts) {
  if (!Array.isArray(incomingContacts) || !Array.isArray(existingContacts)) return new Map()
  if (existingContacts.length === 0) return new Map()

  const byEmail       = new Map()
  const byLinkedin    = new Map()
  const byNameCompany = new Map()

  for (const ec of existingContacts) {
    const stub    = { id: ec.id, name: ec.name || '' }
    const email   = normalizeEmailForDedup(ec.email || '')
    if (email) byEmail.set(email, stub)
    const linkedin = normalizeLinkedinForDedup(ec.linkedin_url || '')
    if (linkedin) byLinkedin.set(linkedin, stub)
    const nameNorm = normalizeNameForDedup(ec.name || '')
    const compNorm = normalizeCompanyForDedup(ec.company || '')
    if (nameNorm && compNorm) {
      byNameCompany.set(`${nameNorm}||${compNorm}`, stub)
    }
  }

  const result = new Map()
  for (const ic of incomingContacts) {
    const email = normalizeEmailForDedup(ic.email || '')
    if (email && byEmail.has(email)) {
      result.set(ic._rowId, byEmail.get(email))
      continue
    }
    const linkedin = normalizeLinkedinForDedup(ic.linkedin_url || '')
    if (linkedin && byLinkedin.has(linkedin)) {
      result.set(ic._rowId, byLinkedin.get(linkedin))
      continue
    }
    const nameNorm = normalizeNameForDedup(ic.name || '')
    const compNorm = normalizeCompanyForDedup(ic.company || '')
    if (nameNorm && compNorm) {
      const key = `${nameNorm}||${compNorm}`
      if (byNameCompany.has(key)) {
        result.set(ic._rowId, byNameCompany.get(key))
      }
    }
  }
  return result
}

/**
 * Build a human-readable stats line for the done screen.
 * e.g. "12 tagged recruiter · 8 alumni · 2 duplicates skipped · 1 row needs a name"
 *
 * @param {Array<{tag: string, count: number}>} tagSummary - top tags from computeTagSummary
 * @param {{ duplicatesSkipped: number, missingNameCount: number }} stats
 * @returns {string}
 */
export function buildDoneStatsLine(tagSummary, stats) {
  const parts = []
  const topTags = (tagSummary || []).slice(0, 2)
  for (const { tag, count } of topTags) {
    parts.push(`${count} tagged ${tag}`)
  }
  if (stats.duplicatesSkipped > 0) {
    parts.push(`${stats.duplicatesSkipped} ${stats.duplicatesSkipped === 1 ? 'duplicate' : 'duplicates'} skipped`)
  }
  if (stats.missingNameCount > 0) {
    parts.push(`${stats.missingNameCount} ${stats.missingNameCount === 1 ? 'row needs' : 'rows need'} a name`)
  }
  return parts.join(' · ')
}
