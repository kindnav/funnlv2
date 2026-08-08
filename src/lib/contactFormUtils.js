// Pure functions for contact form validation and outreach state.
// No React/Supabase imports — safe to unit-test in plain Node.js.

// Normalizes a name for duplicate comparison: trim, collapse whitespace, lowercase.
export function normalizeName(name) {
  return (name || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

// Normalizes a company for duplicate comparison: trim, collapse whitespace, lowercase.
export function normalizeCompany(company) {
  return (company || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

// Returns the first contact from `contacts` that has the same normalized name AND
// normalized company as the given values, excluding a contact by `excludeId`.
// Returns null when no duplicate is found or when `name` normalizes to empty.
export function findDuplicate(contacts, name, company, excludeId) {
  const n = normalizeName(name)
  if (!n) return null
  const c = normalizeCompany(company)
  for (const contact of contacts) {
    if (excludeId && contact.id === excludeId) continue
    if (normalizeName(contact.name) === n && normalizeCompany(contact.company) === c) {
      return contact
    }
  }
  return null
}

// Derives the effective outreach_status value to persist, matching the outreach matrix.
// Email/Message: status is set only when trackOutreach is true.
// Call/Other: status is set directly (no checkbox gate).
// Coffee chat/Event: always null.
export function effectiveOutreachStatus(type, trackOutreach, outreachStatus) {
  if (type === 'Email' || type === 'Message') {
    return trackOutreach ? (outreachStatus || null) : null
  }
  if (type === 'Call' || type === 'Other') {
    return outreachStatus || null
  }
  return null
}
