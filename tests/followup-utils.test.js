/**
 * followup-utils.test.js
 *
 * Comprehensive tests for src/lib/followUpUtils.js
 * Zero-dependency Node.js — run with: node tests/followup-utils.test.js
 */
import assert from 'assert'

import {
  getLocalToday,
  localDateOffset,
  sevenDaysAgo,
  completedLocalDate,
  daysWaiting,
  classifyInteraction,
  deduplicateAwaitingResponse,
  sortOverdue,
  sortToday,
  sortUpcoming,
  sortAwaitingResponse,
  sortRecentlyCompleted,
  groupAndSortFollowUps,
  waitingCount,
  waitingCopy,
  completionPayload,
  undoPayload,
  clearCompletionFields,
  snoozePayload,
  isBadgeEligible,
  dueLabelStr,
  waitingLabelStr,
  completionLabel,
  completionMethodLabel,
} from '../src/lib/followUpUtils.js'

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

// ── Helpers for building test rows ────────────────────────────────────────────

function row(overrides) {
  return {
    id: 'id-1',
    contact_id: 'c-1',
    type: 'Email',
    interaction_date: '2026-07-01',
    notes: null,
    follow_up_date: null,
    outreach_status: null,
    follow_up_completed_at: null,
    follow_up_previous_date: null,
    follow_up_completion_method: null,
    contacts: { id: 'c-1', name: 'Alice', company: 'Acme', role: null },
    ...overrides,
  }
}

// ── localDateOffset ───────────────────────────────────────────────────────────

console.log('\nlocalDateOffset\n')

test('adds positive days', () => {
  assert.strictEqual(localDateOffset('2026-07-29', 1), '2026-07-30')
})

test('month boundary forward', () => {
  assert.strictEqual(localDateOffset('2026-07-31', 1), '2026-08-01')
})

test('year boundary forward', () => {
  assert.strictEqual(localDateOffset('2026-12-31', 1), '2027-01-01')
})

test('zero offset returns same date', () => {
  assert.strictEqual(localDateOffset('2026-07-29', 0), '2026-07-29')
})

test('subtracts negative days', () => {
  assert.strictEqual(localDateOffset('2026-07-29', -1), '2026-07-28')
})

test('month boundary backward', () => {
  assert.strictEqual(localDateOffset('2026-08-01', -1), '2026-07-31')
})

test('year boundary backward', () => {
  assert.strictEqual(localDateOffset('2027-01-01', -1), '2026-12-31')
})

test('leap day: 2028-02-29 exists', () => {
  assert.strictEqual(localDateOffset('2028-02-28', 1), '2028-02-29')
})

// ── sevenDaysAgo ──────────────────────────────────────────────────────────────

console.log('\nsevenDaysAgo\n')

test('returns exactly 7 days before today', () => {
  assert.strictEqual(sevenDaysAgo('2026-07-29'), '2026-07-23')
})

test('crosses month boundary', () => {
  assert.strictEqual(sevenDaysAgo('2026-08-05'), '2026-07-30')
})

test('crosses year boundary', () => {
  assert.strictEqual(sevenDaysAgo('2027-01-05'), '2026-12-30')
})

// ── daysWaiting ───────────────────────────────────────────────────────────────

console.log('\ndaysWaiting\n')

test('same date → 0', () => {
  assert.strictEqual(daysWaiting('2026-07-29', '2026-07-29'), 0)
})

test('1 day in past → 1', () => {
  assert.strictEqual(daysWaiting('2026-07-28', '2026-07-29'), 1)
})

test('7 days in past → 7', () => {
  assert.strictEqual(daysWaiting('2026-07-22', '2026-07-29'), 7)
})

test('null dateStr → 0', () => {
  assert.strictEqual(daysWaiting(null, '2026-07-29'), 0)
})

test('null today → 0', () => {
  assert.strictEqual(daysWaiting('2026-07-29', null), 0)
})

test('1 day in future → negative', () => {
  assert.strictEqual(daysWaiting('2026-07-30', '2026-07-29'), -1)
})

// ── classifyInteraction ───────────────────────────────────────────────────────

console.log('\nclassifyInteraction\n')

const TODAY = '2026-07-29'
const SEVEN = sevenDaysAgo(TODAY) // '2026-07-23'

test('yesterday → overdue', () => {
  const r = row({ follow_up_date: '2026-07-28' })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'overdue')
})

test('today → due_today', () => {
  const r = row({ follow_up_date: TODAY })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'due_today')
})

test('tomorrow → upcoming', () => {
  const r = row({ follow_up_date: '2026-07-30' })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'upcoming')
})

test('null date → other (not awaiting)', () => {
  const r = row({ follow_up_date: null })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'other')
})

test('null date + awaiting_response → awaiting_no_date', () => {
  const r = row({ outreach_status: 'awaiting_response' })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'awaiting_no_date')
})

test('awaiting_response WITH date → date group (not awaiting)', () => {
  const r = row({ outreach_status: 'awaiting_response', follow_up_date: '2026-07-30' })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'upcoming')
})

test('completed within 7 days → recently_completed', () => {
  const r = row({ follow_up_completed_at: '2026-07-23T12:00:00Z', follow_up_completion_method: 'mark_done' })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'recently_completed')
})

test('completed on sevenDaysAgo boundary → recently_completed (inclusive)', () => {
  // sevenDaysAgo('2026-07-29') === '2026-07-23' (today + 6 past days = 7 calendar dates)
  // Use noon UTC so the local date is 2026-07-23 in every timezone from UTC-11 to UTC+11
  const r = row({ follow_up_completed_at: '2026-07-23T12:00:00.000Z', follow_up_completion_method: 'mark_done' })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'recently_completed')
})

test('completed 8 days ago → other (excluded)', () => {
  const r = row({ follow_up_completed_at: '2026-07-21T12:00:00Z', follow_up_completion_method: 'mark_done' })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'other')
})

test('completed row with active follow_up_date → completion takes priority (recently_completed)', () => {
  // Invariant: cannot simultaneously have both. But if it did, completion wins.
  const r = row({
    follow_up_completed_at: '2026-07-28T12:00:00Z',
    follow_up_date: '2026-07-28',
    follow_up_completion_method: 'mark_done',
  })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'recently_completed')
})

test('responded status + null date → other', () => {
  const r = row({ outreach_status: 'responded' })
  assert.strictEqual(classifyInteraction(r, TODAY, SEVEN), 'other')
})

test('month boundary: 2026-06-30 vs 2026-07-01 today → overdue', () => {
  const r = row({ follow_up_date: '2026-06-30' })
  assert.strictEqual(classifyInteraction(r, '2026-07-01', sevenDaysAgo('2026-07-01')), 'overdue')
})

test('year boundary: 2026-12-31 due, today 2027-01-01 → overdue', () => {
  const r = row({ follow_up_date: '2026-12-31' })
  assert.strictEqual(classifyInteraction(r, '2027-01-01', sevenDaysAgo('2027-01-01')), 'overdue')
})

// ── deduplicateAwaitingResponse ───────────────────────────────────────────────

console.log('\ndeduplicateAwaitingResponse\n')

test('different contacts remain separate', () => {
  const items = [
    row({ id: 'a1', contact_id: 'c1', interaction_date: '2026-07-01', contacts: { name: 'Alice' } }),
    row({ id: 'b1', contact_id: 'c2', interaction_date: '2026-07-01', contacts: { name: 'Bob' } }),
  ]
  const result = deduplicateAwaitingResponse(items)
  assert.strictEqual(result.length, 2)
})

test('same contact → keeps most recent interaction date', () => {
  const items = [
    row({ id: 'a1', contact_id: 'c1', interaction_date: '2026-07-01' }),
    row({ id: 'a2', contact_id: 'c1', interaction_date: '2026-07-15' }),
  ]
  const result = deduplicateAwaitingResponse(items)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, 'a2')
})

test('same contact, same date → keeps latest id (lexicographic)', () => {
  const items = [
    row({ id: 'uuid-aaa', contact_id: 'c1', interaction_date: '2026-07-15' }),
    row({ id: 'uuid-zzz', contact_id: 'c1', interaction_date: '2026-07-15' }),
  ]
  const result = deduplicateAwaitingResponse(items)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, 'uuid-zzz')
})

test('three contacts, two rows for one → two results', () => {
  const items = [
    row({ id: 'a1', contact_id: 'c1', interaction_date: '2026-07-01' }),
    row({ id: 'a2', contact_id: 'c1', interaction_date: '2026-07-10' }),
    row({ id: 'b1', contact_id: 'c2', interaction_date: '2026-07-01' }),
  ]
  const result = deduplicateAwaitingResponse(items)
  assert.strictEqual(result.length, 2)
  const ids = result.map(r => r.id).sort()
  assert(ids.includes('a2'))
  assert(ids.includes('b1'))
})

test('empty input → empty output', () => {
  assert.deepStrictEqual(deduplicateAwaitingResponse([]), [])
})

// ── Sorting ───────────────────────────────────────────────────────────────────

console.log('\nsortOverdue\n')

test('oldest date first', () => {
  const items = [
    row({ id: 'r2', follow_up_date: '2026-07-20', contacts: { name: 'Alice' } }),
    row({ id: 'r1', follow_up_date: '2026-07-10', contacts: { name: 'Alice' } }),
  ]
  const sorted = sortOverdue(items)
  assert.strictEqual(sorted[0].id, 'r1')
  assert.strictEqual(sorted[1].id, 'r2')
})

test('same date → name A-Z', () => {
  const items = [
    row({ id: 'r2', follow_up_date: '2026-07-10', contacts: { name: 'Zara' } }),
    row({ id: 'r1', follow_up_date: '2026-07-10', contacts: { name: 'Alice' } }),
  ]
  const sorted = sortOverdue(items)
  assert.strictEqual(sorted[0].contacts.name, 'Alice')
})

test('same date, same name → stable id sort', () => {
  const items = [
    row({ id: 'uuid-z', follow_up_date: '2026-07-10', contacts: { name: 'Alice' } }),
    row({ id: 'uuid-a', follow_up_date: '2026-07-10', contacts: { name: 'Alice' } }),
  ]
  const sorted = sortOverdue(items)
  assert.strictEqual(sorted[0].id, 'uuid-a')
})

console.log('\nsortUpcoming\n')

test('soonest date first', () => {
  const items = [
    row({ id: 'r2', follow_up_date: '2026-08-15', contacts: { name: 'Alice' } }),
    row({ id: 'r1', follow_up_date: '2026-08-01', contacts: { name: 'Alice' } }),
  ]
  const sorted = sortUpcoming(items)
  assert.strictEqual(sorted[0].id, 'r1')
})

console.log('\nsortAwaitingResponse\n')

test('longest waiting first (oldest interaction_date)', () => {
  const items = [
    row({ id: 'r2', interaction_date: '2026-07-25', contacts: { name: 'Alice' } }),
    row({ id: 'r1', interaction_date: '2026-07-15', contacts: { name: 'Alice' } }),
  ]
  const sorted = sortAwaitingResponse(items, TODAY)
  assert.strictEqual(sorted[0].id, 'r1')
})

test('same interaction_date → name A-Z', () => {
  const items = [
    row({ id: 'r2', interaction_date: '2026-07-15', contacts: { name: 'Zara' } }),
    row({ id: 'r1', interaction_date: '2026-07-15', contacts: { name: 'Alice' } }),
  ]
  const sorted = sortAwaitingResponse(items, TODAY)
  assert.strictEqual(sorted[0].contacts.name, 'Alice')
})

console.log('\nsortRecentlyCompleted\n')

test('newest completion first', () => {
  const items = [
    row({ id: 'r1', follow_up_completed_at: '2026-07-25T10:00:00Z' }),
    row({ id: 'r2', follow_up_completed_at: '2026-07-28T10:00:00Z' }),
  ]
  const sorted = sortRecentlyCompleted(items)
  assert.strictEqual(sorted[0].id, 'r2')
})

test('same timestamp → id desc tie-breaker', () => {
  const items = [
    row({ id: 'uuid-a', follow_up_completed_at: '2026-07-28T10:00:00Z' }),
    row({ id: 'uuid-z', follow_up_completed_at: '2026-07-28T10:00:00Z' }),
  ]
  const sorted = sortRecentlyCompleted(items)
  assert.strictEqual(sorted[0].id, 'uuid-z')
})

// ── groupAndSortFollowUps ─────────────────────────────────────────────────────

console.log('\ngroupAndSortFollowUps\n')

test('correctly partitions into all five groups', () => {
  const interactions = [
    row({ id: 'ov', follow_up_date: '2026-07-28' }),  // overdue
    row({ id: 'td', follow_up_date: TODAY }),          // today
    row({ id: 'up', follow_up_date: '2026-07-30' }),  // upcoming
    row({ id: 'aw', outreach_status: 'awaiting_response', contacts: { name: 'A' } }), // awaiting
    row({ id: 'cp', follow_up_completed_at: '2026-07-28T10:00:00Z', follow_up_completion_method: 'mark_done' }), // completed
  ]
  const g = groupAndSortFollowUps(interactions, TODAY)
  assert.strictEqual(g.overdue.length, 1)
  assert.strictEqual(g.today.length, 1)
  assert.strictEqual(g.upcoming.length, 1)
  assert.strictEqual(g.awaitingResponse.length, 1)
  assert.strictEqual(g.recentlyCompleted.length, 1)
})

test('null date rows with non-awaiting status excluded', () => {
  const interactions = [row({ outreach_status: 'responded' })]
  const g = groupAndSortFollowUps(interactions, TODAY)
  assert.strictEqual(g.overdue.length, 0)
  assert.strictEqual(g.today.length, 0)
  assert.strictEqual(g.upcoming.length, 0)
  assert.strictEqual(g.awaitingResponse.length, 0)
  assert.strictEqual(g.recentlyCompleted.length, 0)
})

test('awaiting WITH date goes into date group not awaiting', () => {
  const interactions = [
    row({ id: 'x', follow_up_date: '2026-07-30', outreach_status: 'awaiting_response' }),
  ]
  const g = groupAndSortFollowUps(interactions, TODAY)
  assert.strictEqual(g.upcoming.length, 1)
  assert.strictEqual(g.awaitingResponse.length, 0)
})

test('awaiting per-contact dedup applied', () => {
  const interactions = [
    row({ id: 'a1', contact_id: 'c1', interaction_date: '2026-07-01', outreach_status: 'awaiting_response', contacts: { name: 'A' } }),
    row({ id: 'a2', contact_id: 'c1', interaction_date: '2026-07-10', outreach_status: 'awaiting_response', contacts: { name: 'A' } }),
  ]
  const g = groupAndSortFollowUps(interactions, TODAY)
  assert.strictEqual(g.awaitingResponse.length, 1)
  assert.strictEqual(g.awaitingResponse[0].id, 'a2')
})

test('completed older than 7 days excluded from recentlyCompleted', () => {
  const interactions = [
    row({ id: 'old', follow_up_completed_at: '2026-07-15T12:00:00Z', follow_up_completion_method: 'mark_done' }),
  ]
  const g = groupAndSortFollowUps(interactions, TODAY)
  assert.strictEqual(g.recentlyCompleted.length, 0)
})

test('completed row does NOT appear in open date groups', () => {
  const interactions = [
    row({
      id: 'cp',
      follow_up_date: null, // already cleared
      follow_up_completed_at: '2026-07-28T12:00:00Z',
      follow_up_completion_method: 'mark_done',
    }),
  ]
  const g = groupAndSortFollowUps(interactions, TODAY)
  assert.strictEqual(g.overdue.length, 0)
  assert.strictEqual(g.today.length, 0)
  assert.strictEqual(g.upcoming.length, 0)
  assert.strictEqual(g.recentlyCompleted.length, 1)
})

test('empty input → all groups empty', () => {
  const g = groupAndSortFollowUps([], TODAY)
  assert.strictEqual(g.overdue.length, 0)
  assert.strictEqual(g.today.length, 0)
  assert.strictEqual(g.upcoming.length, 0)
  assert.strictEqual(g.awaitingResponse.length, 0)
  assert.strictEqual(g.recentlyCompleted.length, 0)
})

// ── waitingCount and waitingCopy ──────────────────────────────────────────────

console.log('\nwaitingCount and waitingCopy\n')

test('sum of overdue + today + awaiting', () => {
  assert.strictEqual(waitingCount([1, 2], [3], [4, 5, 6]), 6)
})

test('excludes upcoming and recently completed', () => {
  assert.strictEqual(waitingCount([], [], []), 0)
})

test('zero → null copy', () => {
  assert.strictEqual(waitingCopy(0), null)
})

test('one → singular copy', () => {
  assert.strictEqual(waitingCopy(1), '1 conversation is waiting on you.')
})

test('two → plural copy', () => {
  assert.strictEqual(waitingCopy(2), '2 conversations are waiting on you.')
})

test('ten → plural copy', () => {
  assert.strictEqual(waitingCopy(10), '10 conversations are waiting on you.')
})

// ── completionPayload ─────────────────────────────────────────────────────────

console.log('\ncompletionPayload\n')

test('preserves current date as previous_date', () => {
  const p = completionPayload('2026-07-28', 'mark_done', '2026-07-29T10:00:00Z')
  assert.strictEqual(p.follow_up_previous_date, '2026-07-28')
})

test('clears active follow_up_date', () => {
  const p = completionPayload('2026-07-28', 'mark_done', '2026-07-29T10:00:00Z')
  assert.strictEqual(p.follow_up_date, null)
})

test('sets completion timestamp', () => {
  const now = '2026-07-29T10:00:00Z'
  const p = completionPayload('2026-07-28', 'mark_done', now)
  assert.strictEqual(p.follow_up_completed_at, now)
})

test('method mark_done', () => {
  const p = completionPayload('2026-07-28', 'mark_done', '2026-07-29T10:00:00Z')
  assert.strictEqual(p.follow_up_completion_method, 'mark_done')
})

test('method log_result', () => {
  const p = completionPayload('2026-07-28', 'log_result', '2026-07-29T10:00:00Z')
  assert.strictEqual(p.follow_up_completion_method, 'log_result')
})

test('null currentFollowUpDate → previous_date is null', () => {
  const p = completionPayload(null, 'mark_done', '2026-07-29T10:00:00Z')
  assert.strictEqual(p.follow_up_previous_date, null)
})

// ── undoPayload ───────────────────────────────────────────────────────────────

console.log('\nundoPayload\n')

test('restores exact previous date', () => {
  const p = undoPayload('2026-07-28')
  assert.strictEqual(p.follow_up_date, '2026-07-28')
})

test('clears completed_at', () => {
  assert.strictEqual(undoPayload('2026-07-28').follow_up_completed_at, null)
})

test('clears previous_date', () => {
  assert.strictEqual(undoPayload('2026-07-28').follow_up_previous_date, null)
})

test('clears completion method', () => {
  assert.strictEqual(undoPayload('2026-07-28').follow_up_completion_method, null)
})

test('null previousDate → follow_up_date is null (safe guard)', () => {
  const p = undoPayload(null)
  assert.strictEqual(p.follow_up_date, null)
})

// ── snoozePayload ─────────────────────────────────────────────────────────────

console.log('\nsnoozePayload\n')

test('sets new date', () => {
  assert.strictEqual(snoozePayload('2026-08-01').follow_up_date, '2026-08-01')
})

test('clears completion metadata', () => {
  const p = snoozePayload('2026-08-01')
  assert.strictEqual(p.follow_up_completed_at, null)
  assert.strictEqual(p.follow_up_previous_date, null)
  assert.strictEqual(p.follow_up_completion_method, null)
})

// ── isBadgeEligible ───────────────────────────────────────────────────────────

console.log('\nisBadgeEligible\n')

test('overdue open → eligible', () => {
  assert.strictEqual(isBadgeEligible(row({ follow_up_date: '2026-07-28' }), TODAY), true)
})

test('today open → eligible', () => {
  assert.strictEqual(isBadgeEligible(row({ follow_up_date: TODAY }), TODAY), true)
})

test('upcoming → NOT eligible', () => {
  assert.strictEqual(isBadgeEligible(row({ follow_up_date: '2026-07-30' }), TODAY), false)
})

test('null date → NOT eligible', () => {
  assert.strictEqual(isBadgeEligible(row({ follow_up_date: null }), TODAY), false)
})

test('completed (has completed_at) → NOT eligible', () => {
  const r = row({ follow_up_date: null, follow_up_completed_at: '2026-07-29T10:00:00Z' })
  assert.strictEqual(isBadgeEligible(r, TODAY), false)
})

test('awaiting without date → NOT eligible', () => {
  const r = row({ outreach_status: 'awaiting_response' })
  assert.strictEqual(isBadgeEligible(r, TODAY), false)
})

// ── dueLabelStr ───────────────────────────────────────────────────────────────

console.log('\ndueLabelStr\n')

test('today → Due today', () => {
  assert.strictEqual(dueLabelStr(TODAY, TODAY), 'Due today')
})

test('1 day overdue → 1 day overdue', () => {
  assert.strictEqual(dueLabelStr('2026-07-28', TODAY), '1 day overdue')
})

test('multiple days overdue', () => {
  assert.strictEqual(dueLabelStr('2026-07-22', TODAY), '7 days overdue')
})

test('tomorrow → Tomorrow', () => {
  assert.strictEqual(dueLabelStr('2026-07-30', TODAY), 'Tomorrow')
})

test('2 days upcoming → In 2 days', () => {
  assert.strictEqual(dueLabelStr('2026-07-31', TODAY), 'In 2 days')
})

test('empty dateStr → empty string', () => {
  assert.strictEqual(dueLabelStr('', TODAY), '')
})

test('null dateStr → empty string', () => {
  assert.strictEqual(dueLabelStr(null, TODAY), '')
})

// ── waitingLabelStr ───────────────────────────────────────────────────────────

console.log('\nwaitingLabelStr\n')

test('interaction date is today → Sent today', () => {
  assert.strictEqual(waitingLabelStr(TODAY, TODAY), 'Sent today')
})

test('1 day ago → Waiting 1 day', () => {
  assert.strictEqual(waitingLabelStr('2026-07-28', TODAY), 'Waiting 1 day')
})

test('7 days ago → Waiting 7 days', () => {
  assert.strictEqual(waitingLabelStr('2026-07-22', TODAY), 'Waiting 7 days')
})

// ── completionMethodLabel ─────────────────────────────────────────────────────

console.log('\ncompletionMethodLabel\n')

test('mark_done → Done', () => {
  assert.strictEqual(completionMethodLabel('mark_done'), 'Done')
})

test('log_result → Log Result', () => {
  assert.strictEqual(completionMethodLabel('log_result'), 'Log Result')
})

test('null → empty string', () => {
  assert.strictEqual(completionMethodLabel(null), '')
})

// ── clearCompletionFields ─────────────────────────────────────────────────────

console.log('\nclearCompletionFields\n')

test('returns all three null fields', () => {
  const f = clearCompletionFields()
  assert.strictEqual(f.follow_up_completed_at, null)
  assert.strictEqual(f.follow_up_previous_date, null)
  assert.strictEqual(f.follow_up_completion_method, null)
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
