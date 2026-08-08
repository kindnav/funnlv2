/**
 * contact-directory.test.js
 *
 * Pure-function tests for contactDirectoryUtils: parseSortParam, daysSince,
 * deriveContactStatus, buildDirectoryEntry, sortDirectoryEntries, filterByTag,
 * searchDirectory, buildTagCounts, isLowHistory, shouldShowContactAI.
 *
 * Run: node tests/contact-directory.test.js
 */
import assert from 'assert'
import {
  SORT_OPTIONS, DEFAULT_SORT, CATEGORY_ORDER, CONTACT_AI_ENABLED, ATTENTION_RECENT_DAYS,
  parseSortParam, daysSince, deriveContactStatus, buildDirectoryEntry,
  sortDirectoryEntries, filterByTag, searchDirectory, buildTagCounts,
  isLowHistory, shouldShowContactAI, snoozeOptionToDate,
} from '../src/lib/contactDirectoryUtils.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`)
    failed++
  }
}

// Fixed dates relative to TODAY = '2026-01-15'
const TODAY           = '2026-01-15'
const YESTERDAY       = '2026-01-14'
const TWO_DAYS_AGO    = '2026-01-13'
const WEEK_AGO        = '2026-01-08'
const THREE_WEEKS_AGO = '2025-12-25'
const TOMORROW        = '2026-01-16'
const NEXT_WEEK       = '2026-01-22'

// Offset a YYYY-MM-DD string by N calendar days (UTC-safe)
function dateOffset(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) + days * 86400000
  const r = new Date(ms)
  return `${r.getUTCFullYear()}-${String(r.getUTCMonth() + 1).padStart(2, '0')}-${String(r.getUTCDate()).padStart(2, '0')}`
}

// Build a minimal interaction object
function interaction(overrides = {}) {
  return {
    id: overrides.id || '1',
    contact_id: overrides.contact_id || 'c1',
    interaction_date: overrides.interaction_date || TODAY,
    type: overrides.type || 'Coffee chat',
    notes: overrides.notes || null,
    follow_up_date: overrides.follow_up_date || null,
    outreach_status: overrides.outreach_status || null,
  }
}

// Build a minimal directory entry with _status pre-attached (for sort tests)
function makeEntry(id, category, opts = {}) {
  return {
    id,
    name: opts.name || `Contact ${id}`,
    created_at: opts.created_at || '2025-01-01T00:00:00Z',
    tags: opts.tags || null,
    _status: {
      category,
      nextFollowUp:    opts.nextFollowUp    || null,
      awaitingOutreach: opts.awaitingOutreach || null,
      lastInteraction: opts.lastInteraction || null,
    },
    _interactions: opts._interactions || [],
  }
}

// ── parseSortParam ────────────────────────────────────────────────────────────

console.log('\nparseSortParam\n')

test('known value "attention" passes through', () => {
  assert.strictEqual(parseSortParam('attention'), 'attention')
})
test('known value "active" passes through', () => {
  assert.strictEqual(parseSortParam('active'), 'active')
})
test('known value "added" passes through', () => {
  assert.strictEqual(parseSortParam('added'), 'added')
})
test('known value "az" passes through', () => {
  assert.strictEqual(parseSortParam('az'), 'az')
})
test('unknown value falls back to DEFAULT_SORT', () => {
  assert.strictEqual(parseSortParam('random'), DEFAULT_SORT)
})
test('empty string falls back to DEFAULT_SORT', () => {
  assert.strictEqual(parseSortParam(''), DEFAULT_SORT)
})
test('undefined falls back to DEFAULT_SORT', () => {
  assert.strictEqual(parseSortParam(undefined), DEFAULT_SORT)
})
test('null falls back to DEFAULT_SORT', () => {
  assert.strictEqual(parseSortParam(null), DEFAULT_SORT)
})
test('DEFAULT_SORT is "attention"', () => {
  assert.strictEqual(DEFAULT_SORT, 'attention')
})
test('SORT_OPTIONS contains exactly 4 values', () => {
  assert.strictEqual(SORT_OPTIONS.length, 4)
})
test('all SORT_OPTIONS are strings', () => {
  assert.ok(SORT_OPTIONS.every(s => typeof s === 'string'))
})

// ── daysSince ─────────────────────────────────────────────────────────────────

console.log('\ndaysSince\n')

test('same date returns 0', () => {
  assert.strictEqual(daysSince(TODAY, TODAY), 0)
})
test('date 1 day in the past returns 1', () => {
  assert.strictEqual(daysSince(YESTERDAY, TODAY), 1)
})
test('date 7 days in the past returns 7', () => {
  assert.strictEqual(daysSince(WEEK_AGO, TODAY), 7)
})
test('future date (tomorrow) returns -1', () => {
  assert.strictEqual(daysSince(TOMORROW, TODAY), -1)
})
test('future date (next week) returns -7', () => {
  assert.strictEqual(daysSince(NEXT_WEEK, TODAY), -7)
})
test('null dateStr returns null', () => {
  assert.strictEqual(daysSince(null, TODAY), null)
})
test('null today returns null', () => {
  assert.strictEqual(daysSince(TODAY, null), null)
})
test('both null returns null', () => {
  assert.strictEqual(daysSince(null, null), null)
})
test('empty string dateStr returns null', () => {
  assert.strictEqual(daysSince('', TODAY), null)
})
test('empty string today returns null', () => {
  assert.strictEqual(daysSince(TODAY, ''), null)
})

// ── deriveContactStatus ───────────────────────────────────────────────────────

console.log('\nderiveContactStatus — basic categories\n')

test('empty interactions → no_next_action', () => {
  const s = deriveContactStatus([], TODAY)
  assert.strictEqual(s.category, 'no_next_action')
})

test('empty interactions → null nextFollowUp', () => {
  const s = deriveContactStatus([], TODAY)
  assert.strictEqual(s.nextFollowUp, null)
})

test('empty interactions → null lastInteraction', () => {
  const s = deriveContactStatus([], TODAY)
  assert.strictEqual(s.lastInteraction, null)
})

test('empty interactions → null daysSinceLastContact', () => {
  const s = deriveContactStatus([], TODAY)
  assert.strictEqual(s.daysSinceLastContact, null)
})

test('null interactions → no_next_action', () => {
  const s = deriveContactStatus(null, TODAY)
  assert.strictEqual(s.category, 'no_next_action')
})

test('recent interaction, no follow_up → recently_active', () => {
  const s = deriveContactStatus([interaction({ interaction_date: YESTERDAY })], TODAY)
  assert.strictEqual(s.category, 'recently_active')
})

test('old interaction, no follow_up → no_next_action', () => {
  const s = deriveContactStatus([interaction({ interaction_date: THREE_WEEKS_AGO })], TODAY)
  assert.strictEqual(s.category, 'no_next_action')
})

test('overdue follow_up → overdue', () => {
  const s = deriveContactStatus([interaction({ follow_up_date: YESTERDAY, interaction_date: WEEK_AGO })], TODAY)
  assert.strictEqual(s.category, 'overdue')
})

test('overdue → nextFollowUp set', () => {
  const s = deriveContactStatus([interaction({ follow_up_date: YESTERDAY, interaction_date: WEEK_AGO })], TODAY)
  assert.ok(s.nextFollowUp)
  assert.strictEqual(s.nextFollowUp.follow_up_date, YESTERDAY)
})

test('follow_up exactly today → due_today', () => {
  const s = deriveContactStatus([interaction({ follow_up_date: TODAY, interaction_date: WEEK_AGO })], TODAY)
  assert.strictEqual(s.category, 'due_today')
})

test('due_today is NOT overdue', () => {
  const s = deriveContactStatus([interaction({ follow_up_date: TODAY, interaction_date: WEEK_AGO })], TODAY)
  assert.notStrictEqual(s.category, 'overdue')
})

test('future follow_up → recently_active (actively managed)', () => {
  const s = deriveContactStatus([interaction({ follow_up_date: NEXT_WEEK, interaction_date: WEEK_AGO })], TODAY)
  assert.strictEqual(s.category, 'recently_active')
})

test('awaiting_response with no follow_up → awaiting_response', () => {
  const s = deriveContactStatus([interaction({ outreach_status: 'awaiting_response', interaction_date: WEEK_AGO })], TODAY)
  assert.strictEqual(s.category, 'awaiting_response')
})

test('awaiting_response → awaitingOutreach is set', () => {
  const ix = interaction({ id: 'x', outreach_status: 'awaiting_response', interaction_date: WEEK_AGO })
  const s = deriveContactStatus([ix], TODAY)
  assert.strictEqual(s.awaitingOutreach.id, 'x')
})

test('contact with open follow_up is NOT no_next_action', () => {
  const s = deriveContactStatus([interaction({ follow_up_date: TODAY, interaction_date: THREE_WEEKS_AGO })], TODAY)
  assert.notStrictEqual(s.category, 'no_next_action')
})

console.log('\nderiveContactStatus — priority and edge cases\n')

test('overdue follow_up overrides awaiting_response status', () => {
  const s = deriveContactStatus([
    interaction({ follow_up_date: YESTERDAY, outreach_status: 'awaiting_response', interaction_date: WEEK_AGO }),
  ], TODAY)
  assert.strictEqual(s.category, 'overdue')
})

test('multiple follow_ups — picks earliest (most overdue) as nextFollowUp', () => {
  const s = deriveContactStatus([
    interaction({ id: '1', follow_up_date: TWO_DAYS_AGO, interaction_date: WEEK_AGO }),
    interaction({ id: '2', follow_up_date: YESTERDAY, interaction_date: WEEK_AGO }),
  ], TODAY)
  assert.strictEqual(s.nextFollowUp.id, '1')  // TWO_DAYS_AGO is more overdue
  assert.strictEqual(s.category, 'overdue')
})

test('multiple interactions — picks most recent as lastInteraction', () => {
  const s = deriveContactStatus([
    interaction({ id: '1', interaction_date: YESTERDAY }),
    interaction({ id: '2', interaction_date: THREE_WEEKS_AGO }),
  ], TODAY)
  assert.strictEqual(s.lastInteraction.id, '1')
})

test('daysSinceLastContact reflects most recent interaction', () => {
  const s = deriveContactStatus([
    interaction({ interaction_date: YESTERDAY }),
    interaction({ interaction_date: THREE_WEEKS_AGO }),
  ], TODAY)
  assert.strictEqual(s.daysSinceLastContact, 1)
})

test('non-awaiting outreach_status (e.g. responded) does not create awaiting_response category', () => {
  const s = deriveContactStatus([
    interaction({ outreach_status: 'responded', interaction_date: YESTERDAY }),
  ], TODAY)
  assert.notStrictEqual(s.category, 'awaiting_response')
})

test('boundary: exactly ATTENTION_RECENT_DAYS ago → recently_active', () => {
  const dateStr = dateOffset(TODAY, -ATTENTION_RECENT_DAYS)
  const s = deriveContactStatus([interaction({ interaction_date: dateStr })], TODAY)
  assert.strictEqual(s.category, 'recently_active')
})

test('boundary: ATTENTION_RECENT_DAYS + 1 ago → no_next_action', () => {
  const dateStr = dateOffset(TODAY, -(ATTENTION_RECENT_DAYS + 1))
  const s = deriveContactStatus([interaction({ interaction_date: dateStr })], TODAY)
  assert.strictEqual(s.category, 'no_next_action')
})

test('future follow_up with old last interaction → recently_active (not no_next_action)', () => {
  const s = deriveContactStatus([
    interaction({ follow_up_date: NEXT_WEEK, interaction_date: THREE_WEEKS_AGO }),
  ], TODAY)
  assert.strictEqual(s.category, 'recently_active')
})

// ── buildDirectoryEntry ───────────────────────────────────────────────────────

console.log('\nbuildDirectoryEntry\n')

test('attaches _status to the entry', () => {
  const contact = { id: 'c1', name: 'Alice', created_at: '2025-01-01T00:00:00Z' }
  const entry = buildDirectoryEntry(contact, [], TODAY)
  assert.ok(entry._status)
  assert.strictEqual(entry._status.category, 'no_next_action')
})

test('attaches only the contact-scoped interactions (filters by contact_id)', () => {
  const contact = { id: 'c1', name: 'Alice', created_at: '2025-01-01T00:00:00Z' }
  const allIx = [
    interaction({ id: '1', contact_id: 'c1', interaction_date: YESTERDAY }),
    interaction({ id: '2', contact_id: 'c2', interaction_date: YESTERDAY }),
  ]
  const entry = buildDirectoryEntry(contact, allIx, TODAY)
  assert.strictEqual(entry._interactions.length, 1)
  assert.strictEqual(entry._interactions[0].id, '1')
})

test('_interactions are sorted date-desc', () => {
  const contact = { id: 'c1', name: 'Alice', created_at: '2025-01-01T00:00:00Z' }
  const allIx = [
    interaction({ id: 'a', contact_id: 'c1', interaction_date: THREE_WEEKS_AGO }),
    interaction({ id: 'b', contact_id: 'c1', interaction_date: YESTERDAY }),
  ]
  const entry = buildDirectoryEntry(contact, allIx, TODAY)
  assert.strictEqual(entry._interactions[0].id, 'b')
  assert.strictEqual(entry._interactions[1].id, 'a')
})

test('preserves all original contact fields', () => {
  const contact = { id: 'c1', name: 'Alice', company: 'Acme', role: 'Analyst', tags: ['recruiter'], created_at: '2025-01-01T00:00:00Z' }
  const entry = buildDirectoryEntry(contact, [], TODAY)
  assert.strictEqual(entry.name, 'Alice')
  assert.strictEqual(entry.company, 'Acme')
  assert.deepStrictEqual(entry.tags, ['recruiter'])
})

test('null allInteractions treated as empty', () => {
  const contact = { id: 'c1', name: 'Alice', created_at: '2025-01-01T00:00:00Z' }
  const entry = buildDirectoryEntry(contact, null, TODAY)
  assert.strictEqual(entry._interactions.length, 0)
  assert.strictEqual(entry._status.category, 'no_next_action')
})

// ── sortDirectoryEntries — attention ──────────────────────────────────────────

console.log('\nsortDirectoryEntries — attention sort\n')

test('overdue before due_today', () => {
  const entries = [
    makeEntry('b', 'due_today', { nextFollowUp: { follow_up_date: TODAY } }),
    makeEntry('a', 'overdue',   { nextFollowUp: { follow_up_date: YESTERDAY } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(sorted[0].id, 'a')
})

test('due_today before awaiting_response', () => {
  const entries = [
    makeEntry('b', 'awaiting_response', { awaitingOutreach: { interaction_date: WEEK_AGO } }),
    makeEntry('a', 'due_today', { nextFollowUp: { follow_up_date: TODAY } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(sorted[0].id, 'a')
})

test('awaiting_response before recently_active', () => {
  const entries = [
    makeEntry('b', 'recently_active', { lastInteraction: { interaction_date: YESTERDAY } }),
    makeEntry('a', 'awaiting_response', { awaitingOutreach: { interaction_date: WEEK_AGO } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(sorted[0].id, 'a')
})

test('no_next_action before recently_active', () => {
  const entries = [
    makeEntry('b', 'no_next_action'),
    makeEntry('a', 'recently_active', { lastInteraction: { interaction_date: YESTERDAY } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(sorted[0].id, 'b')  // no_next_action (index 3) ranks before recently_active (index 4)
})

test('full 5-category order verified', () => {
  const entries = [
    makeEntry('e', 'no_next_action'),
    makeEntry('d', 'recently_active', { lastInteraction: { interaction_date: YESTERDAY } }),
    makeEntry('c', 'awaiting_response', { awaitingOutreach: { interaction_date: WEEK_AGO } }),
    makeEntry('b', 'due_today', { nextFollowUp: { follow_up_date: TODAY } }),
    makeEntry('a', 'overdue', { nextFollowUp: { follow_up_date: YESTERDAY } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  // Order: overdue(0) → due_today(1) → awaiting_response(2) → no_next_action(3) → recently_active(4)
  assert.deepStrictEqual(sorted.map(e => e.id), ['a', 'b', 'c', 'e', 'd'])
})

test('within overdue: oldest follow_up_date first (most overdue first)', () => {
  const entries = [
    makeEntry('b', 'overdue', { nextFollowUp: { follow_up_date: YESTERDAY } }),
    makeEntry('a', 'overdue', { nextFollowUp: { follow_up_date: TWO_DAYS_AGO } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(sorted[0].id, 'a')  // TWO_DAYS_AGO is more overdue
})

test('within awaiting_response: oldest interaction first (longest wait first)', () => {
  const entries = [
    makeEntry('b', 'awaiting_response', { awaitingOutreach: { interaction_date: YESTERDAY } }),
    makeEntry('a', 'awaiting_response', { awaitingOutreach: { interaction_date: WEEK_AGO } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(sorted[0].id, 'a')  // WEEK_AGO = longer wait
})

test('within recently_active: most recent interaction first', () => {
  const entries = [
    makeEntry('b', 'recently_active', { lastInteraction: { interaction_date: TWO_DAYS_AGO } }),
    makeEntry('a', 'recently_active', { lastInteraction: { interaction_date: YESTERDAY } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(sorted[0].id, 'a')
})

test('within no_next_action: never-interacted before old-interaction (most neglected first)', () => {
  const entries = [
    makeEntry('b', 'no_next_action', { lastInteraction: { interaction_date: WEEK_AGO } }),
    makeEntry('a', 'no_next_action'),  // no lastInteraction
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(sorted[0].id, 'a')  // no interaction = most neglected
})

test('within no_next_action: older last interaction before more recent', () => {
  const entries = [
    makeEntry('b', 'no_next_action', { lastInteraction: { interaction_date: WEEK_AGO } }),
    makeEntry('a', 'no_next_action', { lastInteraction: { interaction_date: THREE_WEEKS_AGO } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(sorted[0].id, 'a')  // THREE_WEEKS_AGO is more neglected
})

test('does not mutate the input array', () => {
  const entries = [
    makeEntry('b', 'no_next_action'),
    makeEntry('a', 'overdue', { nextFollowUp: { follow_up_date: YESTERDAY } }),
  ]
  sortDirectoryEntries(entries, 'attention')
  assert.strictEqual(entries[0].id, 'b')
  assert.strictEqual(entries[1].id, 'a')
})

console.log('\nsortDirectoryEntries — active / added / az\n')

test('active: most recent interaction first', () => {
  const entries = [
    makeEntry('b', 'no_next_action', { lastInteraction: { interaction_date: WEEK_AGO } }),
    makeEntry('a', 'no_next_action', { lastInteraction: { interaction_date: YESTERDAY } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'active')
  assert.strictEqual(sorted[0].id, 'a')
})

test('active: contacts with no interactions sorted last', () => {
  const entries = [
    makeEntry('b', 'no_next_action'),  // no lastInteraction
    makeEntry('a', 'no_next_action', { lastInteraction: { interaction_date: THREE_WEEKS_AGO } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'active')
  assert.strictEqual(sorted[0].id, 'a')
})

test('added: newest created_at first', () => {
  const entries = [
    makeEntry('b', 'no_next_action', { created_at: '2025-01-01T00:00:00Z' }),
    makeEntry('a', 'no_next_action', { created_at: '2025-12-01T00:00:00Z' }),
  ]
  const sorted = sortDirectoryEntries(entries, 'added')
  assert.strictEqual(sorted[0].id, 'a')
})

test('az: alphabetical by name (case-insensitive)', () => {
  const entries = [
    makeEntry('c', 'no_next_action', { name: 'Zebra' }),
    makeEntry('a', 'no_next_action', { name: 'alice' }),
    makeEntry('b', 'no_next_action', { name: 'Bob' }),
  ]
  const sorted = sortDirectoryEntries(entries, 'az')
  assert.deepStrictEqual(sorted.map(e => e.name), ['alice', 'Bob', 'Zebra'])
})

test('az: empty name sorts after regular names', () => {
  const entries = [
    makeEntry('b', 'no_next_action', { name: 'Alice' }),
    makeEntry('a', 'no_next_action', { name: '' }),
  ]
  const sorted = sortDirectoryEntries(entries, 'az')
  assert.strictEqual(sorted[0].id, 'b')  // Alice before empty — localeCompare platform default
})

test('unknown sort falls back to attention sort', () => {
  const entries = [
    makeEntry('b', 'no_next_action'),
    makeEntry('a', 'overdue', { nextFollowUp: { follow_up_date: YESTERDAY } }),
  ]
  const sorted = sortDirectoryEntries(entries, 'unknown_sort_key')
  assert.strictEqual(sorted[0].id, 'a')
})

// ── filterByTag ───────────────────────────────────────────────────────────────

console.log('\nfilterByTag\n')

const TAG_ENTRIES = [
  { id: '1', tags: ['recruiter', 'target firm'] },
  { id: '2', tags: ['alumni'] },
  { id: '3', tags: ['recruiter'] },
  { id: '4', tags: null },
  { id: '5', tags: [] },
]

test('empty string tag returns all entries', () => {
  assert.strictEqual(filterByTag(TAG_ENTRIES, '').length, TAG_ENTRIES.length)
})

test('null tag returns all entries', () => {
  assert.strictEqual(filterByTag(TAG_ENTRIES, null).length, TAG_ENTRIES.length)
})

test('tag filter returns matching entries', () => {
  const ids = filterByTag(TAG_ENTRIES, 'recruiter').map(c => c.id).sort()
  assert.deepStrictEqual(ids, ['1', '3'])
})

test('tag filter is case-insensitive', () => {
  const r = filterByTag(TAG_ENTRIES, 'ALUMNI')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '2')
})

test('tag filter does partial match', () => {
  const r = filterByTag(TAG_ENTRIES, 'target')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '1')
})

test('entries with null tags are excluded from tag results', () => {
  const r = filterByTag(TAG_ENTRIES, 'recruiter')
  assert.ok(!r.find(c => c.id === '4'))
})

test('entries with empty tags array are excluded from tag results', () => {
  const r = filterByTag(TAG_ENTRIES, 'recruiter')
  assert.ok(!r.find(c => c.id === '5'))
})

test('no-match tag returns empty array', () => {
  assert.strictEqual(filterByTag(TAG_ENTRIES, 'zzznomatch').length, 0)
})

// ── searchDirectory ───────────────────────────────────────────────────────────

console.log('\nsearchDirectory\n')

const SEARCH_ENTRIES = [
  {
    id: '1', name: 'Alice Johnson', company: 'Goldman Sachs', role: 'Analyst',
    tags: ['recruiter'], relationship_note: 'Can intro me to the PE team',
    _interactions: [],
  },
  {
    id: '2', name: 'Bob Smith', company: 'McKinsey', role: 'Consultant',
    tags: ['alumni'], relationship_note: null,
    _interactions: [{ notes: 'Discussed blockchain opportunities' }],
  },
  {
    id: '3', name: 'Carol White', company: null, role: null,
    tags: null, relationship_note: null,
    _interactions: [],
  },
  {
    id: '4', name: 'Dan Brown', company: 'BlackRock', role: null,
    tags: ['target firm'], relationship_note: null,
    _interactions: [{ notes: null }],
  },
]

test('empty query returns all entries', () => {
  assert.strictEqual(searchDirectory(SEARCH_ENTRIES, '').length, SEARCH_ENTRIES.length)
})

test('null query returns all entries', () => {
  assert.strictEqual(searchDirectory(SEARCH_ENTRIES, null).length, SEARCH_ENTRIES.length)
})

test('whitespace-only query returns all entries', () => {
  assert.strictEqual(searchDirectory(SEARCH_ENTRIES, '   ').length, SEARCH_ENTRIES.length)
})

test('search by name', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'alice')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '1')
})

test('search by company', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'goldman')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '1')
})

test('search by role', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'consultant')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '2')
})

test('search by tag', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'alumni')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '2')
})

test('search by relationship_note', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'intro')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '1')
})

test('search by interaction notes (_interactions)', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'blockchain')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '2')
})

test('search is case-insensitive', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'GOLDMAN')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '1')
})

test('partial match works for company', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'black')  // matches BlackRock
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '4')
})

test('null interaction notes do not cause errors', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'nonexistent')
  assert.strictEqual(r.length, 0)
})

test('no-match returns empty array', () => {
  assert.strictEqual(searchDirectory(SEARCH_ENTRIES, 'zzznomatch').length, 0)
})

test('contact with null company still matches by name', () => {
  const r = searchDirectory(SEARCH_ENTRIES, 'carol')
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].id, '3')
})

// ── buildTagCounts ────────────────────────────────────────────────────────────

console.log('\nbuildTagCounts\n')

test('counts tags correctly', () => {
  const contacts = [
    { tags: ['recruiter', 'alumni'] },
    { tags: ['recruiter'] },
    { tags: ['alumni', 'mentor'] },
  ]
  const counts = buildTagCounts(contacts)
  assert.strictEqual(counts['recruiter'], 2)
  assert.strictEqual(counts['alumni'], 2)
  assert.strictEqual(counts['mentor'], 1)
})

test('keys are lowercased', () => {
  const counts = buildTagCounts([{ tags: ['Recruiter'] }])
  assert.strictEqual(counts['recruiter'], 1)
  assert.strictEqual(counts['Recruiter'], undefined)
})

test('contacts with null tags are skipped without error', () => {
  const counts = buildTagCounts([{ tags: null }, { tags: ['recruiter'] }])
  assert.strictEqual(counts['recruiter'], 1)
})

test('contacts with empty tags are skipped', () => {
  const counts = buildTagCounts([{ tags: [] }, { tags: ['alumni'] }])
  assert.strictEqual(counts['alumni'], 1)
  assert.strictEqual(Object.keys(counts).length, 1)
})

test('empty contacts array returns empty object', () => {
  assert.deepStrictEqual(buildTagCounts([]), {})
})

test('null contacts returns empty object', () => {
  assert.deepStrictEqual(buildTagCounts(null), {})
})

// ── isLowHistory ──────────────────────────────────────────────────────────────

console.log('\nisLowHistory\n')

test('0 interactions → true (low history)', () => {
  assert.strictEqual(isLowHistory([]), true)
})

test('1 interaction → true (low history)', () => {
  assert.strictEqual(isLowHistory([{}]), true)
})

test('2 interactions → false (not low history)', () => {
  assert.strictEqual(isLowHistory([{}, {}]), false)
})

test('3 interactions → false', () => {
  assert.strictEqual(isLowHistory([{}, {}, {}]), false)
})

test('null → true (treated as zero interactions)', () => {
  assert.strictEqual(isLowHistory(null), true)
})

// ── shouldShowContactAI ───────────────────────────────────────────────────────

console.log('\nshouldShowContactAI\n')

test('hidden when feature flag is false, even for Pro users', () => {
  assert.strictEqual(shouldShowContactAI(true, false), false)
})

test('hidden when not Pro, even if feature enabled', () => {
  assert.strictEqual(shouldShowContactAI(false, true), false)
})

test('shown when both Pro and feature enabled', () => {
  assert.strictEqual(shouldShowContactAI(true, true), true)
})

test('hidden when both false', () => {
  assert.strictEqual(shouldShowContactAI(false, false), false)
})

test('CONTACT_AI_ENABLED export is false (feature deferred)', () => {
  assert.strictEqual(CONTACT_AI_ENABLED, false)
})

test('contact AI always hidden in real app (CONTACT_AI_ENABLED is false)', () => {
  // Regardless of Pro status, the flag gates the feature
  assert.strictEqual(shouldShowContactAI(true,  CONTACT_AI_ENABLED), false)
  assert.strictEqual(shouldShowContactAI(false, CONTACT_AI_ENABLED), false)
})

// ── CATEGORY_ORDER ────────────────────────────────────────────────────────────

console.log('\nCATEGORY_ORDER constants\n')

test('has 5 categories', () => {
  assert.strictEqual(CATEGORY_ORDER.length, 5)
})

test('starts with overdue (highest urgency)', () => {
  assert.strictEqual(CATEGORY_ORDER[0], 'overdue')
})

test('ends with recently_active (lowest urgency)', () => {
  assert.strictEqual(CATEGORY_ORDER[CATEGORY_ORDER.length - 1], 'recently_active')
})

test('due_today is second', () => {
  assert.strictEqual(CATEGORY_ORDER[1], 'due_today')
})

test('awaiting_response is third', () => {
  assert.strictEqual(CATEGORY_ORDER[2], 'awaiting_response')
})

test('no_next_action comes before recently_active', () => {
  const noNextIdx  = CATEGORY_ORDER.indexOf('no_next_action')
  const recentIdx  = CATEGORY_ORDER.indexOf('recently_active')
  assert.ok(noNextIdx < recentIdx)
})

test('all categories are unique strings', () => {
  const unique = new Set(CATEGORY_ORDER)
  assert.strictEqual(unique.size, CATEGORY_ORDER.length)
})

// ── snoozeOptionToDate ────────────────────────────────────────────────────────

console.log('\nsnoozeOptionToDate\n')

test('tomorrow adds 1 day', () => {
  assert.strictEqual(snoozeOptionToDate('tomorrow', '', '2026-01-15'), '2026-01-16')
})

test('three_days adds 3 days', () => {
  assert.strictEqual(snoozeOptionToDate('three_days', '', '2026-01-15'), '2026-01-18')
})

test('one_week adds 7 days', () => {
  assert.strictEqual(snoozeOptionToDate('one_week', '', '2026-01-15'), '2026-01-22')
})

test('custom returns the provided date', () => {
  assert.strictEqual(snoozeOptionToDate('custom', '2026-02-01', '2026-01-15'), '2026-02-01')
})

test('custom with empty string returns null', () => {
  assert.strictEqual(snoozeOptionToDate('custom', '', '2026-01-15'), null)
})

test('preset date calculation crosses month boundary correctly', () => {
  assert.strictEqual(snoozeOptionToDate('one_week', '', '2026-01-28'), '2026-02-04')
})

test('preset date calculation crosses year boundary correctly', () => {
  assert.strictEqual(snoozeOptionToDate('three_days', '', '2025-12-30'), '2026-01-02')
})

test('analytics: preset option value is returned unchanged for followup_snoozed', () => {
  // snoozeOptionToDate returns a date, not the option — caller must track option separately
  const date = snoozeOptionToDate('tomorrow', '', '2026-01-15')
  assert.ok(date && date.match(/^\d{4}-\d{2}-\d{2}$/), 'returns YYYY-MM-DD')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log()
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
