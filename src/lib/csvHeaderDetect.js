// Pure CSV header-detection utilities.
// No React or Supabase dependencies — safe to import in Node test files.

// ─── Normalization ────────────────────────────────────────────────────────────
// Lowercase + separators → spaces + collapse whitespace + trim.
// 'first_name' / 'first-name' / 'First.Name' all become 'first name'.
export function normalizeHeader(h) {
  return (h || '')
    .toLowerCase()
    .replace(/[\s_\-./\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Deterministic alias map ──────────────────────────────────────────────────
// normalized header string → Funnl field key.
// Design principle: only confident, unambiguous aliases — a wrong auto-mapping
// is worse than leaving a column unassigned for one manual click.
export const HEADER_MAP = {
  // Name
  'name':            'name',
  'full name':       'name',
  'fullname':        'name',
  'contact name':    'name',
  'contactname':     'name',
  'person':          'name',
  'person name':     'name',
  'attendee':        'name',
  'attendee name':   'name',
  'contact person':  'name',
  'first name':      'name',
  'firstname':       'name',
  'fname':           'name',
  'given name':      'name',
  'last name':       'name',
  'lastname':        'name',
  'lname':           'name',
  'surname':         'name',
  'family name':     'name',
  'display name':    'name',   // Zoom / Teams / Google exports

  // Company
  'company':          'company',
  'company name':     'company',
  'companyname':      'company',
  'organization':     'company',
  'organisation':     'company',
  'employer':         'company',
  'employer name':    'company',
  'workplace':        'company',
  'current company':  'company',
  'current employer': 'company',
  'firm':             'company',

  // Role
  'role':             'role',
  'job title':        'role',
  'jobtitle':         'role',
  'title':            'role',   // Salesforce / HubSpot standard field
  'position':         'role',
  'job position':     'role',
  'job role':         'role',
  'current role':     'role',
  'current title':    'role',
  'current position': 'role',
  'occupation':       'role',
  'designation':      'role',

  // Email
  'email':               'email',
  'email address':       'email',
  'emailaddress':        'email',
  'e mail':              'email',
  'work email':          'email',
  'personal email':      'email',
  'professional email':  'email',
  'contact email':       'email',
  'email id':            'email',

  // LinkedIn URL — 'url' alone is too generic; confirmed by value-sniffing in the caller
  'linkedin':             'linkedin_url',
  'linkedin url':         'linkedin_url',
  'linkedin profile':     'linkedin_url',
  'linkedin profile url': 'linkedin_url',
  'linkedin page':        'linkedin_url',
  'linkedin link':        'linkedin_url',
  'li url':               'linkedin_url',
  'li profile':           'linkedin_url',
  'profile link':         'linkedin_url',

  // How met
  'how met':         'how_met',
  'howmet':          'how_met',
  'how we met':      'how_met',
  'where met':       'how_met',
  'where we met':    'how_met',
  'meeting context': 'how_met',
  'met through':     'how_met',
  'met at':          'how_met',
  'met via':         'how_met',
  'introduction':    'how_met',

  // Tags
  'tags':       'tags',
  'tag':        'tags',
  'labels':     'tags',
  'categories': 'tags',  // Outlook / Google Contacts
  'groups':     'tags',  // Google Contacts

  // Relationship type
  'relationship type': 'relationship_type',
  'contact type':      'relationship_type',
  'connection type':   'relationship_type',
  'relationship':      'relationship_type',

  // Relationship note / generic notes columns
  'relationship note':       'relationship_note',
  'why this person matters': 'relationship_note',
  'why they matter':         'relationship_note',
  'notes on relationship':   'relationship_note',
  'context':                 'relationship_note',
  'notes':                   'relationship_note',
  'note':                    'relationship_note',
  'comments':                'relationship_note',
  'comment':                 'relationship_note',
  'memo':                    'relationship_note',
  'additional notes':        'relationship_note',
  'general notes':           'relationship_note',
}

// ─── Supplemental aliases for scoring only ────────────────────────────────────
// Too ambiguous for deterministic field assignment, but they help confirm
// that a row is a valid contact header when scanning for preamble.
const SCORE_EXTRA = {
  'url':             'linkedin_url', // confirmed by value-sniffing; 'url' alone is too generic
  'link':            'linkedin_url',
  'profile url':     'linkedin_url',
  'connected on':    '_skip',  // LinkedIn-specific — not a Funnl field
  'date connected':  '_skip',
  'connection date': '_skip',
  'date added':      '_skip',
  'member since':    '_skip',  // LinkedIn
  'linkedin member since': '_skip',
  'phone':           '_skip',
  'phone number':    '_skip',
  'mobile':          '_skip',
  'twitter':         '_skip',
  'location':        '_skip',
  'city':            '_skip',
  'state':           '_skip',
  'country':         '_skip',
  'industry':        '_skip',
  'website':         '_skip',
}

const SCORE_MAP = { ...HEADER_MAP, ...SCORE_EXTRA }

// ─── Header-row scoring ───────────────────────────────────────────────────────
// Returns 0 if the row doesn't qualify as a contact header (no name field or
// fewer than 2 other recognized contact columns).
// Returns a positive score proportional to how many recognized columns are found.
export function scoreHeaderRow(cells) {
  let hasName = false
  let otherKnown = 0
  for (const cell of cells) {
    const norm = normalizeHeader(cell)
    if (!norm) continue
    const field = SCORE_MAP[norm]
    if (!field) continue
    if (field === 'name') hasName = true
    else otherKnown++
  }
  if (!hasName || otherKnown < 2) return 0
  return 1 + otherKnown
}

// ─── Header-row detection ─────────────────────────────────────────────────────
// Scans the first up-to-30 rows from a Papa.parse({ header: false }) result
// and returns the index of the best-scoring candidate header row.
// Returns -1 if no row qualifies (score < 3).
export function detectHeaderRow(rows) {
  let bestIdx = -1
  let bestScore = 0
  const maxScan = Math.min(rows.length, 30)
  for (let i = 0; i < maxScan; i++) {
    const row = rows[i]
    if (!Array.isArray(row) || row.length < 2) continue
    // Strip BOM from first cell before scoring
    const cells = row.map((c, idx) => idx === 0 ? (c || '').replace(/^﻿/, '') : (c || ''))
    const score = scoreHeaderRow(cells)
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  return bestScore >= 3 ? bestIdx : -1
}

// ─── LinkedIn export recognition ──────────────────────────────────────────────
// 'Connected On' is the strong unique signal: it appears in every LinkedIn
// Connections export and almost never in generic contact CSVs.
export function isLinkedInExport(row) {
  if (!Array.isArray(row) || row.length === 0) return false
  const cells = row.map(c => normalizeHeader((c || '').replace(/^﻿/, '')))
  const hasFirstName = cells.includes('first name') || cells.includes('firstname')
  const hasLastName  = cells.includes('last name')  || cells.includes('lastname')
  const hasConnected = cells.includes('connected on')
  return hasFirstName && hasLastName && hasConnected
}

// ─── Initial field assignment ─────────────────────────────────────────────────
// Iterates headers in file order so 'First Name' lands before 'Last Name'
// in the name array, producing "Jane Smith" not "Smith Jane" when joined.
export function buildInitialAssignment(headers) {
  const FIELD_KEYS = [
    'name', 'company', 'role', 'email', 'linkedin_url',
    'how_met', 'tags', 'relationship_type', 'relationship_note',
  ]
  const result = Object.fromEntries(FIELD_KEYS.map(k => [k, []]))
  const used = new Set()
  for (const header of headers) {
    const field = HEADER_MAP[normalizeHeader(header)]
    if (field && !used.has(header)) {
      result[field] = [...result[field], header]
      used.add(header)
    }
  }
  return result
}
