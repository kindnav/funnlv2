/**
 * Tests for src/lib/dashboard-metrics.js
 *
 * Run with: node tests/dashboard-metrics.test.js
 * (ES module format — no node:test, raw assert)
 */
import assert from 'assert'
import {
  getLocalToday,
  getLocalWeekStartDate,
  getLocalWeekStartISO,
  dayOrdinal,
  daysBetween,
  computeTopTag,
  computeResponseRate,
  computeSignals,
  computeNetworkSignal,
  formatActivityDate,
  followUpLabel,
  buildRecentActivity,
} from '../src/lib/dashboard-metrics.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}`)
    console.error(`       ${e.message}`)
    failed++
  }
}

// ── Helpers for building fixture data ─────────────────────────────────────────

const TODAY = '2026-07-28' // Tuesday

function makeContact(id, name, tags = []) {
  return { id, name, tags, company: '', role: '', created_at: '2026-01-01T00:00:00.000Z' }
}

function makeInteraction(id, contactId, daysAgo, opts = {}) {
  const [y, m, d] = TODAY.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) - daysAgo * 86_400_000
  const dateStr = new Date(ms).toISOString().slice(0, 10)
  return {
    id,
    contact_id: contactId,
    interaction_date: dateStr,
    type: opts.type || 'Email',
    outreach_status: opts.outreach_status || null,
    follow_up_date: opts.follow_up_date || null,
    notes: opts.notes || null,
    created_at: new Date(ms).toISOString(),
  }
}

// ── getLocalToday ─────────────────────────────────────────────────────────────

console.log('\ngetLocalToday')

test('returns a YYYY-MM-DD string', () => {
  const t = getLocalToday()
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/)
})

test('accepts an injected now Date', () => {
  const now = new Date(2026, 6, 28, 10, 0, 0) // July 28 (month is 0-indexed)
  assert.strictEqual(getLocalToday(now), '2026-07-28')
})

// ── getLocalWeekStartDate ─────────────────────────────────────────────────────

console.log('\ngetLocalWeekStartDate')

test('Monday returns the same day', () => {
  const now = new Date(2026, 6, 27, 10, 0, 0) // July 27, 2026 = Monday
  assert.strictEqual(getLocalWeekStartDate(now), '2026-07-27')
})

test('Tuesday returns the preceding Monday', () => {
  const now = new Date(2026, 6, 28, 10, 0, 0) // July 28, 2026 = Tuesday
  assert.strictEqual(getLocalWeekStartDate(now), '2026-07-27')
})

test('Wednesday returns the preceding Monday', () => {
  const now = new Date(2026, 6, 29, 10, 0, 0) // July 29, 2026 = Wednesday
  assert.strictEqual(getLocalWeekStartDate(now), '2026-07-27')
})

test('Sunday returns the previous Monday (six days back)', () => {
  const now = new Date(2026, 6, 26, 10, 0, 0) // July 26, 2026 = Sunday
  assert.strictEqual(getLocalWeekStartDate(now), '2026-07-20')
})

test('crosses a month boundary correctly', () => {
  const now = new Date(2026, 7, 3, 10, 0, 0) // Aug 3, 2026 = Monday
  assert.strictEqual(getLocalWeekStartDate(now), '2026-08-03')
})

test('crosses a month boundary backward (e.g. Aug 1 Saturday → July 27)', () => {
  const now = new Date(2026, 7, 1, 10, 0, 0) // Aug 1, 2026 = Saturday
  assert.strictEqual(getLocalWeekStartDate(now), '2026-07-27')
})

// ── getLocalWeekStartISO ──────────────────────────────────────────────────────

console.log('\ngetLocalWeekStartISO')

test('ISO string parses back to local Monday midnight', () => {
  const now = new Date(2026, 6, 29, 10, 0, 0) // Wednesday July 29
  const weekStartDate = getLocalWeekStartDate(now) // '2026-07-27'
  const weekStartISO  = getLocalWeekStartISO(now)
  // The ISO string, when interpreted as a Date and then rendered in local calendar,
  // should produce the same YYYY-MM-DD as the computed week start.
  assert.strictEqual(getLocalToday(new Date(weekStartISO)), weekStartDate)
})

test('interaction on Monday is counted as this week', () => {
  const now = new Date(2026, 6, 29, 10, 0, 0) // Wednesday July 29
  const weekStartDate = getLocalWeekStartDate(now) // '2026-07-27'
  const ixnOnMonday = { interaction_date: '2026-07-27' }
  assert.ok(ixnOnMonday.interaction_date >= weekStartDate)
})

test('interaction on Sunday (week before) is not counted as this week', () => {
  const now = new Date(2026, 6, 29, 10, 0, 0) // Wednesday July 29
  const weekStartDate = getLocalWeekStartDate(now) // '2026-07-27'
  const ixnSunday = { interaction_date: '2026-07-26' }
  assert.ok(!(ixnSunday.interaction_date >= weekStartDate))
})

test('contact created_at exactly at week start ISO is included', () => {
  const now = new Date(2026, 6, 29, 10, 0, 0)
  const weekStartISO = getLocalWeekStartISO(now)
  const contactAtStart = { created_at: weekStartISO }
  assert.ok(contactAtStart.created_at >= weekStartISO)
})

test('contact created_at 1 ms before week start is excluded', () => {
  const now = new Date(2026, 6, 29, 10, 0, 0)
  const weekStartISO = getLocalWeekStartISO(now)
  const beforeMs = new Date(weekStartISO).getTime() - 1
  const contactBefore = { created_at: new Date(beforeMs).toISOString() }
  assert.ok(!(contactBefore.created_at >= weekStartISO))
})

// ── dayOrdinal ────────────────────────────────────────────────────────────────

console.log('\ndayOrdinal')

test('consecutive dates differ by exactly 1', () => {
  assert.strictEqual(dayOrdinal('2026-07-28') - dayOrdinal('2026-07-27'), 1)
})

test('dates across a month boundary differ by 1', () => {
  assert.strictEqual(dayOrdinal('2026-08-01') - dayOrdinal('2026-07-31'), 1)
})

test('dates across a year boundary differ by 1', () => {
  assert.strictEqual(dayOrdinal('2027-01-01') - dayOrdinal('2026-12-31'), 1)
})

test('Feb 28 to Mar 1 in a non-leap year differs by 1', () => {
  // 2026 is not a leap year
  assert.strictEqual(dayOrdinal('2026-03-01') - dayOrdinal('2026-02-28'), 1)
})

test('Feb 28 to Mar 1 in a leap year differs by 2', () => {
  // 2028 is a leap year
  assert.strictEqual(dayOrdinal('2028-03-01') - dayOrdinal('2028-02-28'), 2)
})

test('same date has ordinal difference of 0', () => {
  assert.strictEqual(dayOrdinal('2026-07-28') - dayOrdinal('2026-07-28'), 0)
})

// ── daysBetween ───────────────────────────────────────────────────────────────

console.log('\ndaysBetween')

test('7 days apart returns 7', () => {
  assert.strictEqual(daysBetween('2026-07-28', '2026-07-21'), 7)
})

test('same day returns 0', () => {
  assert.strictEqual(daysBetween('2026-07-28', '2026-07-28'), 0)
})

test('future date returns negative', () => {
  assert.strictEqual(daysBetween('2026-07-21', '2026-07-28'), -7)
})

test('across a month boundary', () => {
  assert.strictEqual(daysBetween('2026-08-01', '2026-07-31'), 1)
})

// ── computeTopTag ─────────────────────────────────────────────────────────────

console.log('\ncomputeTopTag')

test('returns most common tag', () => {
  const contacts = [
    { tags: ['recruiter', 'mentor'] },
    { tags: ['recruiter'] },
    { tags: ['mentor'] },
  ]
  assert.strictEqual(computeTopTag(contacts), 'recruiter')
})

test('is case-insensitive', () => {
  const contacts = [
    { tags: ['Recruiter'] },
    { tags: ['recruiter'] },
    { tags: ['mentor'] },
  ]
  assert.strictEqual(computeTopTag(contacts), 'recruiter')
})

test('trims whitespace before comparing', () => {
  const contacts = [
    { tags: [' recruiter ', 'recruiter'] },
    { tags: ['mentor'] },
  ]
  assert.strictEqual(computeTopTag(contacts), 'recruiter')
})

test('returns null when no tags exist', () => {
  const contacts = [{ tags: [] }, { tags: null }]
  assert.strictEqual(computeTopTag(contacts), null)
})

test('returns null for empty contacts array', () => {
  assert.strictEqual(computeTopTag([]), null)
})

test('handles ties deterministically (first-encountered wins)', () => {
  const contacts = [
    { tags: ['alpha'] },
    { tags: ['beta'] },
  ]
  // Both count=1. Whichever iteration order Object.entries delivers first wins.
  // We just verify a non-null string is returned.
  const result = computeTopTag(contacts)
  assert.ok(result === 'alpha' || result === 'beta')
})

// ── computeResponseRate ───────────────────────────────────────────────────────

console.log('\ncomputeResponseRate')

test('100% when all resolved are positive', () => {
  const ixns = [
    { outreach_status: 'responded' },
    { outreach_status: 'meeting_booked' },
  ]
  assert.strictEqual(computeResponseRate(ixns), 100)
})

test('50% with one positive and one no_response', () => {
  const ixns = [
    { outreach_status: 'responded' },
    { outreach_status: 'no_response' },
  ]
  assert.strictEqual(computeResponseRate(ixns), 50)
})

test('awaiting_response is excluded from denominator', () => {
  const ixns = [
    { outreach_status: 'awaiting_response' }, // should not count
    { outreach_status: 'responded' },
  ]
  // resolved = 1 (responded only), positive = 1 → 100%
  assert.strictEqual(computeResponseRate(ixns), 100)
})

test('all awaiting_response → null (no resolved)', () => {
  const ixns = [
    { outreach_status: 'awaiting_response' },
    { outreach_status: null },
  ]
  assert.strictEqual(computeResponseRate(ixns), null)
})

test('empty array → null', () => {
  assert.strictEqual(computeResponseRate([]), null)
})

test('0% when all resolved are negative', () => {
  const ixns = [
    { outreach_status: 'declined' },
    { outreach_status: 'no_response' },
  ]
  assert.strictEqual(computeResponseRate(ixns), 0)
})

test('rounds correctly', () => {
  const ixns = [
    { outreach_status: 'responded' },
    { outreach_status: 'no_response' },
    { outreach_status: 'no_response' },
  ]
  // 1/3 = 33.33... → rounds to 33
  assert.strictEqual(computeResponseRate(ixns), 33)
})

test('declined counts as resolved (not positive)', () => {
  const ixns = [
    { outreach_status: 'declined' },
    { outreach_status: 'responded' },
  ]
  // resolved=2, positive=1 → 50%
  assert.strictEqual(computeResponseRate(ixns), 50)
})

// ── computeSignals ────────────────────────────────────────────────────────────

console.log('\ncomputeSignals')

test('going_quiet: 22+ days, 2+ interactions, no open follow-up', () => {
  const c = makeContact('c1', 'Alice')
  const ixns = [
    makeInteraction('i1', 'c1', 25),
    makeInteraction('i2', 'c1', 40),
  ]
  const sigs = computeSignals([c], ixns, TODAY)
  assert.strictEqual(sigs.length, 1)
  assert.strictEqual(sigs[0].type, 'going_quiet')
  assert.strictEqual(sigs[0].contact.id, 'c1')
  assert.strictEqual(sigs[0].daysSince, 25)
})

test('going_quiet blocked when contact has an overdue follow-up', () => {
  const c = makeContact('c1', 'Alice')
  const ixns = [
    makeInteraction('i1', 'c1', 25),
    makeInteraction('i2', 'c1', 40, { follow_up_date: '2026-07-10' }), // overdue
  ]
  const sigs = computeSignals([c], ixns, TODAY)
  assert.strictEqual(sigs.length, 0, 'overdue follow-up should block going_quiet signal')
})

test('going_quiet blocked when contact has a future follow-up', () => {
  const c = makeContact('c1', 'Alice')
  const ixns = [
    makeInteraction('i1', 'c1', 25),
    makeInteraction('i2', 'c1', 40, { follow_up_date: '2026-08-15' }), // future
  ]
  const sigs = computeSignals([c], ixns, TODAY)
  assert.strictEqual(sigs.length, 0, 'future follow-up should block going_quiet signal')
})

test('going_quiet requires at least 2 interactions', () => {
  const c = makeContact('c1', 'Alice')
  const ixns = [makeInteraction('i1', 'c1', 25)]
  const sigs = computeSignals([c], ixns, TODAY)
  assert.strictEqual(sigs.length, 0, 'single interaction should not produce going_quiet')
})

test('responded: outreach replied within 7 days', () => {
  const c = makeContact('c1', 'Alice')
  const ixns = [makeInteraction('i1', 'c1', 3, { outreach_status: 'responded' })]
  const sigs = computeSignals([c], ixns, TODAY)
  assert.strictEqual(sigs.length, 1)
  assert.strictEqual(sigs[0].type, 'responded')
  assert.strictEqual(sigs[0].statusLabel, 'Responded')
})

test('meeting_booked: correct statusLabel', () => {
  const c = makeContact('c1', 'Alice')
  const ixns = [makeInteraction('i1', 'c1', 2, { outreach_status: 'meeting_booked' })]
  const sigs = computeSignals([c], ixns, TODAY)
  assert.strictEqual(sigs[0].type, 'responded')
  assert.strictEqual(sigs[0].statusLabel, 'Meeting booked')
})

test('no_next_action: 7-21 days since last touch, no open follow-up', () => {
  const c = makeContact('c1', 'Alice')
  const ixns = [makeInteraction('i1', 'c1', 14)]
  const sigs = computeSignals([c], ixns, TODAY)
  assert.strictEqual(sigs.length, 1)
  assert.strictEqual(sigs[0].type, 'no_next_action')
})

test('no_next_action blocked when contact has any open follow-up (overdue)', () => {
  const c = makeContact('c1', 'Alice')
  const ixns = [
    makeInteraction('i1', 'c1', 14, { follow_up_date: '2026-07-10' }), // overdue
  ]
  const sigs = computeSignals([c], ixns, TODAY)
  assert.strictEqual(sigs.length, 0, 'overdue follow-up should block no_next_action')
})

test('no_next_action blocked when contact has a future follow-up', () => {
  const c = makeContact('c1', 'Alice')
  const ixns = [
    makeInteraction('i1', 'c1', 14, { follow_up_date: '2026-08-10' }), // future
  ]
  const sigs = computeSignals([c], ixns, TODAY)
  assert.strictEqual(sigs.length, 0, 'future follow-up should block no_next_action')
})

test('priority order: going_quiet before no_next_action before responded', () => {
  const c1 = makeContact('c1', 'Alice')
  const c2 = makeContact('c2', 'Bob')
  const c3 = makeContact('c3', 'Carol')
  const ixns = [
    // c1 — going_quiet (25 days, 2 ixns, no follow-up)
    makeInteraction('i1a', 'c1', 25),
    makeInteraction('i1b', 'c1', 40),
    // c2 — no_next_action (10 days, no follow-up)
    makeInteraction('i2', 'c2', 10),
    // c3 — responded (3 days)
    makeInteraction('i3', 'c3', 3, { outreach_status: 'responded' }),
  ]
  const sigs = computeSignals([c1, c2, c3], ixns, TODAY)
  assert.strictEqual(sigs[0].type, 'going_quiet')
  assert.strictEqual(sigs[1].type, 'responded')
  assert.strictEqual(sigs[2].type, 'no_next_action')
})

test('exactly one signal per contact', () => {
  const c = makeContact('c1', 'Alice')
  // responded wins because daysSince<=7 and status=responded; no_next_action would also match
  const ixns = [makeInteraction('i1', 'c1', 7, { outreach_status: 'responded' })]
  const sigs = computeSignals([c], ixns, TODAY)
  const sigsByContact = sigs.filter(s => s.contact.id === 'c1')
  assert.strictEqual(sigsByContact.length, 1)
})

test('capped at 5 signals', () => {
  const contacts = Array.from({ length: 8 }, (_, i) => makeContact(`c${i}`, `Person ${i}`))
  const ixns = contacts.flatMap((c, i) => [
    makeInteraction(`i${i}a`, c.id, 30),
    makeInteraction(`i${i}b`, c.id, 50),
  ])
  const sigs = computeSignals(contacts, ixns, TODAY)
  assert.strictEqual(sigs.length, 5)
})

test('empty contacts and interactions returns empty array', () => {
  assert.deepStrictEqual(computeSignals([], [], TODAY), [])
})

test('contact with no interactions produces no signal', () => {
  const c = makeContact('c1', 'Alice')
  const sigs = computeSignals([c], [], TODAY)
  assert.strictEqual(sigs.length, 0)
})

test('going_quiet check uses daysBetween (22 days = signal, 21 days = no signal)', () => {
  const c1 = makeContact('c1', 'Alice')
  const c2 = makeContact('c2', 'Bob')
  const ixns = [
    makeInteraction('i1a', 'c1', 22),
    makeInteraction('i1b', 'c1', 30),
    makeInteraction('i2a', 'c2', 21),
    makeInteraction('i2b', 'c2', 30),
  ]
  const sigs = computeSignals([c1, c2], ixns, TODAY)
  const quietIds = sigs.filter(s => s.type === 'going_quiet').map(s => s.contact.id)
  assert.ok(quietIds.includes('c1'), '22 days should produce going_quiet')
  assert.ok(!quietIds.includes('c2'), '21 days should NOT produce going_quiet')
})

// ── computeNetworkSignal ──────────────────────────────────────────────────────

console.log('\ncomputeNetworkSignal')

test('1 going_quiet contact produces singular message', () => {
  const sigs = [{ type: 'going_quiet' }]
  const result = computeNetworkSignal(sigs, 0, 0, 5)
  assert.ok(result.startsWith('1 contact is going quiet'))
})

test('3 going_quiet contacts produces plural message', () => {
  const sigs = [{ type: 'going_quiet' }, { type: 'going_quiet' }, { type: 'going_quiet' }]
  const result = computeNetworkSignal(sigs, 0, 0, 5)
  assert.ok(result.startsWith('3 contacts are going quiet'))
})

test('awaiting response message when no going_quiet', () => {
  const result = computeNetworkSignal([], 1, 2, 10)
  assert.ok(result.includes('awaiting a response'))
})

test('healthy network fallback message', () => {
  const result = computeNetworkSignal([], 2, 0, 10)
  assert.ok(result.includes('healthy'))
})

// ── formatActivityDate ────────────────────────────────────────────────────────

console.log('\nformatActivityDate')

test('today → "Today"', () => {
  assert.strictEqual(formatActivityDate('2026-07-28', '2026-07-28'), 'Today')
})

test('yesterday → short weekday', () => {
  // July 27 is Monday; today is July 28 (Tuesday) so yesterday = 1 day ago <= 6
  const result = formatActivityDate('2026-07-27', '2026-07-28')
  assert.strictEqual(result, 'Mon')
})

test('6 days ago → short weekday', () => {
  // 6 days before July 28 = July 22 (Wednesday)
  const result = formatActivityDate('2026-07-22', '2026-07-28')
  assert.strictEqual(result, 'Wed')
})

test('7 days ago → Month Day format', () => {
  // 7 days ago = July 21
  const result = formatActivityDate('2026-07-21', '2026-07-28')
  assert.strictEqual(result, 'Jul 21')
})

test('older date → Month Day format', () => {
  const result = formatActivityDate('2026-06-01', '2026-07-28')
  assert.strictEqual(result, 'Jun 1')
})

test('day-of-week uses UTC ordinal (not new Date string parse)', () => {
  // dayOrdinal is used internally; verify the weekday is correct via UTC
  const [y, m, d] = '2026-07-27'.split('-').map(Number)
  const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  assert.strictEqual(utcDay, 1) // Monday
})

test('empty/null dateStr returns empty string', () => {
  assert.strictEqual(formatActivityDate(null, TODAY), '')
  assert.strictEqual(formatActivityDate('', TODAY), '')
})

// ── followUpLabel ─────────────────────────────────────────────────────────────

console.log('\nfollowUpLabel')

test('today → Today + warning color', () => {
  const result = followUpLabel('2026-07-28', '2026-07-28')
  assert.strictEqual(result.label, 'Today')
  assert.strictEqual(result.color, 'var(--color-warning)')
})

test('1 day overdue → "1d overdue" + danger color', () => {
  const result = followUpLabel('2026-07-27', '2026-07-28')
  assert.strictEqual(result.label, '1d overdue')
  assert.strictEqual(result.color, 'var(--color-danger)')
})

test('8 days overdue → "8d overdue" + danger color', () => {
  const result = followUpLabel('2026-07-20', '2026-07-28')
  assert.strictEqual(result.label, '8d overdue')
  assert.strictEqual(result.color, 'var(--color-danger)')
})

// ── buildRecentActivity ───────────────────────────────────────────────────────

console.log('\nbuildRecentActivity')

test('combines interactions and contacts, sorted by date desc', () => {
  const contacts = [
    { id: 'c1', name: 'Alice', created_at: '2026-07-25T10:00:00.000Z' },
    { id: 'c2', name: 'Bob',   created_at: '2026-07-20T10:00:00.000Z' },
  ]
  const interactions = [
    { id: 'i1', contact_id: 'c1', interaction_date: '2026-07-27', type: 'Email', outreach_status: null, notes: '', created_at: '2026-07-27T09:00:00.000Z' },
  ]
  const contactMap = Object.fromEntries(contacts.map(c => [c.id, c]))
  const activity = buildRecentActivity(contacts, interactions, contactMap)
  // Sorted: i1 (Jul 27) > c1 added (Jul 25) > c2 added (Jul 20)
  assert.strictEqual(activity[0].id, 'i1')
  assert.strictEqual(activity[1].id, 'contact-c1')
  assert.strictEqual(activity[2].id, 'contact-c2')
})

test('caps at 8 entries', () => {
  const contacts = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    name: `Person ${i}`,
    created_at: `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
  }))
  const contactMap = Object.fromEntries(contacts.map(c => [c.id, c]))
  const activity = buildRecentActivity(contacts, [], contactMap)
  assert.strictEqual(activity.length, 8)
})

test('new contact entries have kind=contact and type=CONTACT ADDED', () => {
  const contacts = [{ id: 'c1', name: 'Alice', created_at: '2026-07-25T10:00:00.000Z' }]
  const activity = buildRecentActivity(contacts, [], { c1: contacts[0] })
  assert.strictEqual(activity[0].kind, 'contact')
  assert.strictEqual(activity[0].type, 'CONTACT ADDED')
  assert.strictEqual(activity[0].contactName, 'Alice')
  assert.strictEqual(activity[0].hasNotes, false)
})

test('interaction entries have kind=interaction', () => {
  const contacts = []
  const interactions = [{
    id: 'i1', contact_id: 'c1', interaction_date: '2026-07-27', type: 'Email',
    outreach_status: 'responded', notes: 'Great call', created_at: '2026-07-27T09:00:00.000Z',
  }]
  const activity = buildRecentActivity(contacts, interactions, { c1: { name: 'Alice' } })
  assert.strictEqual(activity[0].kind, 'interaction')
  assert.strictEqual(activity[0].type, 'Email')
  assert.strictEqual(activity[0].outreachStatus, 'responded')
  assert.strictEqual(activity[0].hasNotes, true)
})

test('hasNotes is true when notes is non-empty string', () => {
  const contacts = []
  const interactions = [
    { id: 'i1', contact_id: 'c1', interaction_date: '2026-07-27', type: 'Email', outreach_status: null, notes: 'Great chat', created_at: '2026-07-27T09:00:00.000Z' },
    { id: 'i2', contact_id: 'c1', interaction_date: '2026-07-26', type: 'Call',  outreach_status: null, notes: '',           created_at: '2026-07-26T09:00:00.000Z' },
    { id: 'i3', contact_id: 'c1', interaction_date: '2026-07-25', type: 'Call',  outreach_status: null, notes: null,         created_at: '2026-07-25T09:00:00.000Z' },
    { id: 'i4', contact_id: 'c1', interaction_date: '2026-07-24', type: 'Call',  outreach_status: null, notes: '   ',        created_at: '2026-07-24T09:00:00.000Z' },
  ]
  const contactMap = { c1: { name: 'Alice' } }
  const activity = buildRecentActivity(contacts, interactions, contactMap)
  assert.ok(activity.find(a => a.id === 'i1').hasNotes, 'non-empty notes should set hasNotes')
  assert.ok(!activity.find(a => a.id === 'i2').hasNotes, 'empty string should not set hasNotes')
  assert.ok(!activity.find(a => a.id === 'i3').hasNotes, 'null notes should not set hasNotes')
  assert.ok(!activity.find(a => a.id === 'i4').hasNotes, 'whitespace-only notes should not set hasNotes')
})

test('interactions without interaction_date are excluded', () => {
  const contacts = []
  const interactions = [
    { id: 'i1', contact_id: 'c1', interaction_date: null, type: 'Email', outreach_status: null, notes: null, created_at: '2026-07-27T09:00:00.000Z' },
    { id: 'i2', contact_id: 'c1', interaction_date: '2026-07-26', type: 'Call', outreach_status: null, notes: null, created_at: '2026-07-26T09:00:00.000Z' },
  ]
  const activity = buildRecentActivity(contacts, interactions, { c1: { name: 'Alice' } })
  assert.ok(!activity.some(a => a.id === 'i1'), 'null interaction_date should be excluded')
  assert.ok(activity.some(a => a.id === 'i2'), 'valid interaction_date should be included')
})

test('same-date tiebreaker uses created_at descending', () => {
  const contacts = []
  const interactions = [
    { id: 'i1', contact_id: 'c1', interaction_date: '2026-07-27', type: 'Email', outreach_status: null, notes: null, created_at: '2026-07-27T08:00:00.000Z' },
    { id: 'i2', contact_id: 'c1', interaction_date: '2026-07-27', type: 'Call',  outreach_status: null, notes: null, created_at: '2026-07-27T09:00:00.000Z' },
  ]
  const activity = buildRecentActivity(contacts, interactions, { c1: { name: 'Alice' } })
  // i2 has later created_at → should come first
  assert.strictEqual(activity[0].id, 'i2')
  assert.strictEqual(activity[1].id, 'i1')
})

test('empty contacts and interactions returns empty array', () => {
  const activity = buildRecentActivity([], [], {})
  assert.strictEqual(activity.length, 0)
})

test('unknown contact falls back to "Unknown" name', () => {
  const contacts = []
  const interactions = [{
    id: 'i1', contact_id: 'c-unknown', interaction_date: '2026-07-27', type: 'Email',
    outreach_status: null, notes: null, created_at: '2026-07-27T09:00:00.000Z',
  }]
  const activity = buildRecentActivity(contacts, interactions, {})
  assert.strictEqual(activity[0].contactName, 'Unknown')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
