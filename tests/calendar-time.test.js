// Tests for calendarTime.js — timed / all-day parsing, DST, completion.
// Pure Node.js (Date + Intl). Run: node tests/calendar-time.test.js

import assert from 'assert'
import {
  localDateInTimeZone,
  parseEventTiming,
  originalOccurrence,
  deriveInteractionDate,
  isCompleted,
} from '../supabase/functions/shared/calendarTime.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

// ── localDateInTimeZone (DST-aware) ───────────────────────────────────────────
console.log('\nlocalDateInTimeZone')

test('converts a UTC instant to the local calendar date', () => {
  // 2026-08-17T02:00Z is still 2026-08-16 in America/New_York (EDT, -4).
  assert.strictEqual(localDateInTimeZone(new Date('2026-08-17T02:00:00Z'), 'America/New_York'), '2026-08-16')
})
test('DST boundary: winter offset differs from summer', () => {
  // 2026-01-17T02:00Z is 2026-01-16 in New York (EST, -5).
  assert.strictEqual(localDateInTimeZone(new Date('2026-01-17T02:00:00Z'), 'America/New_York'), '2026-01-16')
})
test('invalid zone falls back to UTC', () => {
  assert.strictEqual(localDateInTimeZone(new Date('2026-08-17T02:00:00Z'), 'Not/AZone'), '2026-08-17')
})

// ── parseEventTiming ──────────────────────────────────────────────────────────
console.log('\nparseEventTiming')

test('valid timed event', () => {
  const r = parseEventTiming({ start: { dateTime: '2026-08-17T15:00:00Z' }, end: { dateTime: '2026-08-17T16:00:00Z' } })
  assert.strictEqual(r.ok, true); assert.strictEqual(r.kind, 'timed')
})
test('valid all-day event (exclusive end)', () => {
  const r = parseEventTiming({ start: { date: '2026-08-17' }, end: { date: '2026-08-18' } })
  assert.strictEqual(r.ok, true); assert.strictEqual(r.kind, 'allday')
  assert.strictEqual(r.startDate, '2026-08-17'); assert.strictEqual(r.endDate, '2026-08-18')
})
test('timezone carried from start then end', () => {
  const r = parseEventTiming({ start: { dateTime: '2026-08-17T15:00:00Z', timeZone: 'Europe/London' }, end: { dateTime: '2026-08-17T16:00:00Z' } })
  assert.strictEqual(r.timezone, 'Europe/London')
})
test('mixed timed + date fails closed', () => {
  const r = parseEventTiming({ start: { dateTime: '2026-08-17T15:00:00Z' }, end: { date: '2026-08-18' } })
  assert.strictEqual(r.ok, false)
})
test('missing end fails closed', () => {
  assert.strictEqual(parseEventTiming({ start: { dateTime: '2026-08-17T15:00:00Z' } }).ok, false)
})
test('timed end not after start fails closed', () => {
  assert.strictEqual(parseEventTiming({ start: { dateTime: '2026-08-17T16:00:00Z' }, end: { dateTime: '2026-08-17T15:00:00Z' } }).ok, false)
})
test('all-day end equal to start fails closed (must be exclusive-after)', () => {
  assert.strictEqual(parseEventTiming({ start: { date: '2026-08-17' }, end: { date: '2026-08-17' } }).ok, false)
})
test('malformed date fails closed', () => {
  assert.strictEqual(parseEventTiming({ start: { date: '2026-8-1' }, end: { date: '2026-08-18' } }).ok, false)
})
test('garbage datetime fails closed', () => {
  assert.strictEqual(parseEventTiming({ start: { dateTime: 'not-a-date' }, end: { dateTime: '2026-08-17T16:00:00Z' } }).ok, false)
})

// ── originalOccurrence ────────────────────────────────────────────────────────
console.log('\noriginalOccurrence')

test('prefers originalStartTime.dateTime (canonical UTC)', () => {
  const r = originalOccurrence({ originalStartTime: { dateTime: '2026-08-17T11:00:00-04:00' }, start: { dateTime: '2026-08-18T11:00:00-04:00' } })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.occurrence.kind, 'datetime')
  assert.strictEqual(r.occurrence.value, '2026-08-17T15:00:00.000Z') // -04:00 → UTC
})
test('falls back to start for single events', () => {
  const r = originalOccurrence({ start: { dateTime: '2026-08-17T15:00:00Z' } })
  assert.strictEqual(r.ok, true); assert.strictEqual(r.occurrence.value, '2026-08-17T15:00:00.000Z')
})
test('all-day original occurrence is a date', () => {
  const r = originalOccurrence({ originalStartTime: { date: '2026-08-17' } })
  assert.deepStrictEqual(r.occurrence, { kind: 'date', value: '2026-08-17' })
})
test('reschedule stability: same originalStartTime regardless of moved start', () => {
  const a = originalOccurrence({ originalStartTime: { dateTime: '2026-08-17T15:00:00Z' }, start: { dateTime: '2026-08-19T15:00:00Z' } })
  const b = originalOccurrence({ originalStartTime: { dateTime: '2026-08-17T15:00:00Z' }, start: { dateTime: '2026-08-20T09:00:00Z' } })
  assert.strictEqual(a.occurrence.value, b.occurrence.value)
})
test('missing occurrence fails closed', () => {
  assert.strictEqual(originalOccurrence({}).ok, false)
})

// ── deriveInteractionDate ─────────────────────────────────────────────────────
console.log('\nderiveInteractionDate')

test('timed → local date of start in event zone', () => {
  const timing = parseEventTiming({ start: { dateTime: '2026-08-17T02:00:00Z', timeZone: 'America/New_York' }, end: { dateTime: '2026-08-17T03:00:00Z' } })
  assert.strictEqual(deriveInteractionDate(timing, 'UTC'), '2026-08-16')
})
test('timed with no zone uses fallback zone', () => {
  const timing = parseEventTiming({ start: { dateTime: '2026-08-17T02:00:00Z' }, end: { dateTime: '2026-08-17T03:00:00Z' } })
  assert.strictEqual(deriveInteractionDate(timing, 'America/New_York'), '2026-08-16')
})
test('all-day → inclusive start date as-is', () => {
  const timing = parseEventTiming({ start: { date: '2026-08-17' }, end: { date: '2026-08-18' } })
  assert.strictEqual(deriveInteractionDate(timing, 'UTC'), '2026-08-17')
})

// ── isCompleted ───────────────────────────────────────────────────────────────
console.log('\nisCompleted')

test('timed: past end → completed', () => {
  const timing = parseEventTiming({ start: { dateTime: '2026-08-17T15:00:00Z' }, end: { dateTime: '2026-08-17T16:00:00Z' } })
  assert.strictEqual(isCompleted(timing, new Date('2026-08-17T17:00:00Z')), true)
})
test('timed: future end → not completed', () => {
  const timing = parseEventTiming({ start: { dateTime: '2026-08-17T15:00:00Z' }, end: { dateTime: '2026-08-17T16:00:00Z' } })
  assert.strictEqual(isCompleted(timing, new Date('2026-08-17T15:30:00Z')), false)
})
test('all-day: exclusive end on/before today → completed', () => {
  const timing = parseEventTiming({ start: { date: '2026-08-16' }, end: { date: '2026-08-17' } })
  // today = 2026-08-17 (UTC); exclusive end 2026-08-17 <= today → completed
  assert.strictEqual(isCompleted(timing, new Date('2026-08-17T12:00:00Z'), 'UTC'), true)
})
test('all-day: today before exclusive end → not completed', () => {
  const timing = parseEventTiming({ start: { date: '2026-08-17' }, end: { date: '2026-08-18' } })
  assert.strictEqual(isCompleted(timing, new Date('2026-08-17T12:00:00Z'), 'UTC'), false)
})
test('invalid now throws', () => {
  const timing = parseEventTiming({ start: { dateTime: '2026-08-17T15:00:00Z' }, end: { dateTime: '2026-08-17T16:00:00Z' } })
  assert.throws(() => isCompleted(timing, new Date('bad')))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
