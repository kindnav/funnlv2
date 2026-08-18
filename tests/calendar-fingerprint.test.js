// Tests for calendarFingerprint.js — stable per-(occurrence, contact) SHA-256 key.
// Pure Node.js (Web Crypto). Run: node tests/calendar-fingerprint.test.js

import assert from 'assert'
import {
  FINGERPRINT_VERSION,
  lengthPrefixedField,
  occurrenceToken,
  fingerprintInput,
  computeCandidateFingerprint,
} from '../supabase/functions/shared/calendarFingerprint.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

const base = {
  version: FINGERPRINT_VERSION,
  source: 'google_calendar',
  googleSub: 'sub-A',
  calendarId: 'primary',
  googleEventId: 'evt-1',
  occurrence: { kind: 'datetime', value: '2026-08-17T15:00:00.000Z' },
  contactId: 'contact-1',
}

// ── lengthPrefixedField ───────────────────────────────────────────────────────
console.log('\nlengthPrefixedField')

await test('prefixes by UTF-8 byte length', () => {
  assert.strictEqual(lengthPrefixedField('ab'), '2:ab')
  assert.strictEqual(lengthPrefixedField('é'), '2:é') // 2 UTF-8 bytes
})

// ── occurrenceToken ───────────────────────────────────────────────────────────
console.log('\noccurrenceToken')

await test('types the occurrence', () => {
  assert.strictEqual(occurrenceToken({ kind: 'datetime', value: '2026-08-17T15:00:00.000Z' }), 'datetime:2026-08-17T15:00:00.000Z')
  assert.strictEqual(occurrenceToken({ kind: 'date', value: '2026-08-17' }), 'date:2026-08-17')
})
await test('rejects invalid occurrence', () => {
  assert.throws(() => occurrenceToken(null))
  assert.throws(() => occurrenceToken({ kind: 'nope', value: 'x' }))
  assert.throws(() => occurrenceToken({ kind: 'date', value: '' }))
})

// ── fingerprintInput: boundary-collision resistance ───────────────────────────
console.log('\nfingerprintInput')

await test('field-boundary collision resistance', () => {
  // Moving a character across a field boundary must change the input string.
  const a = fingerprintInput({ ...base, googleEventId: 'ab', contactId: 'c' })
  const b = fingerprintInput({ ...base, googleEventId: 'a', contactId: 'bc' })
  assert.notStrictEqual(a, b)
})
await test('missing field throws (no silent empty component)', () => {
  assert.throws(() => fingerprintInput({ ...base, googleEventId: '' }))
  assert.throws(() => fingerprintInput({ ...base, contactId: undefined }))
})

// ── computeCandidateFingerprint: shape + separations ──────────────────────────
console.log('\ncomputeCandidateFingerprint')

await test('lowercase 64-char SHA-256 hex output', async () => {
  const fp = await computeCandidateFingerprint(base)
  assert.match(fp, /^[0-9a-f]{64}$/)
})
await test('deterministic for identical fields', async () => {
  assert.strictEqual(await computeCandidateFingerprint(base), await computeCandidateFingerprint({ ...base }))
})
await test('account A vs account B separation', async () => {
  const a = await computeCandidateFingerprint({ ...base, googleSub: 'sub-A' })
  const b = await computeCandidateFingerprint({ ...base, googleSub: 'sub-B' })
  assert.notStrictEqual(a, b)
})
await test('contact separation (group event → distinct fingerprints)', async () => {
  const c1 = await computeCandidateFingerprint({ ...base, contactId: 'contact-1' })
  const c2 = await computeCandidateFingerprint({ ...base, contactId: 'contact-2' })
  const c3 = await computeCandidateFingerprint({ ...base, contactId: 'contact-3' })
  assert.strictEqual(new Set([c1, c2, c3]).size, 3)
})
await test('date vs datetime separation for the same day', async () => {
  const dt = await computeCandidateFingerprint({ ...base, occurrence: { kind: 'datetime', value: '2026-08-17T00:00:00.000Z' } })
  const d = await computeCandidateFingerprint({ ...base, occurrence: { kind: 'date', value: '2026-08-17' } })
  assert.notStrictEqual(dt, d)
})
await test('recurring occurrence separation (different instances)', async () => {
  const o1 = await computeCandidateFingerprint({ ...base, occurrence: { kind: 'datetime', value: '2026-08-17T15:00:00.000Z' } })
  const o2 = await computeCandidateFingerprint({ ...base, occurrence: { kind: 'datetime', value: '2026-08-24T15:00:00.000Z' } })
  assert.notStrictEqual(o1, o2)
})
await test('rescheduled event stability (same original occurrence → same fp)', async () => {
  // A rescheduled recurring instance keeps its originalStartTime, so the caller
  // passes the SAME occurrence value → identical fingerprint → update in place.
  const before = await computeCandidateFingerprint(base)
  const after = await computeCandidateFingerprint({ ...base })
  assert.strictEqual(before, after)
})
await test('no raw provider id appears in the hash output', async () => {
  const fp = await computeCandidateFingerprint(base)
  assert.strictEqual(fp.includes('evt-1'), false)
  assert.strictEqual(fp.includes('sub-A'), false)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
