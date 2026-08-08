/**
 * settings-helpers.test.js — Unit tests for src/lib/settingsHelpers.js
 *
 * Pure-function tests, no React or Supabase deps.
 * Run with: node tests/settings-helpers.test.js
 */
import assert from 'assert'
import {
  DISPLAY_NAME_MAX_LENGTH,
  DELETE_ALL_PHRASE,
  DELETE_ACCOUNT_PHRASE,
  normalizeDisplayName,
  validateDisplayName,
  isDeleteAllConfirmEligible,
  isDeleteAccountConfirmEligible,
  formatJoined,
  formatTrialEnd,
  summarizeContactCount,
} from '../src/lib/settingsHelpers.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

console.log('\nConstants')

test('DISPLAY_NAME_MAX_LENGTH is a positive number', () => {
  assert.strictEqual(typeof DISPLAY_NAME_MAX_LENGTH, 'number')
  assert.ok(DISPLAY_NAME_MAX_LENGTH > 0)
})
test('DISPLAY_NAME_MAX_LENGTH is 80', () => {
  assert.strictEqual(DISPLAY_NAME_MAX_LENGTH, 80)
})
test('DELETE_ALL_PHRASE is the exact phrase', () => {
  assert.strictEqual(DELETE_ALL_PHRASE, 'delete all contacts')
})
test('DELETE_ACCOUNT_PHRASE is the exact phrase', () => {
  assert.strictEqual(DELETE_ACCOUNT_PHRASE, 'delete my account')
})

// ── normalizeDisplayName ──────────────────────────────────────────────────────

console.log('\nnormalizeDisplayName')

test('returns empty string for null', () => {
  assert.strictEqual(normalizeDisplayName(null), '')
})
test('returns empty string for undefined', () => {
  assert.strictEqual(normalizeDisplayName(undefined), '')
})
test('returns empty string for empty string', () => {
  assert.strictEqual(normalizeDisplayName(''), '')
})
test('trims leading and trailing whitespace', () => {
  assert.strictEqual(normalizeDisplayName('  spaces  '), 'spaces')
})
test('trims only surrounding whitespace, preserves internal', () => {
  assert.strictEqual(normalizeDisplayName('  John Smith  '), 'John Smith')
})
test('returns a string type always', () => {
  assert.strictEqual(typeof normalizeDisplayName(42), 'string')
})
test('converts non-string to string before trimming', () => {
  assert.strictEqual(normalizeDisplayName(42), '42')
})
test('whitespace-only string normalizes to empty string', () => {
  assert.strictEqual(normalizeDisplayName('   '), '')
})

// ── validateDisplayName ───────────────────────────────────────────────────────

console.log('\nvalidateDisplayName')

test('empty string → valid: false, code: empty', () => {
  const r = validateDisplayName('')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'empty')
})
test('whitespace-only → valid: false, code: empty', () => {
  const r = validateDisplayName('   ')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'empty')
})
test('null → valid: false, code: empty', () => {
  const r = validateDisplayName(null)
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'empty')
})
test('undefined → valid: false, code: empty', () => {
  const r = validateDisplayName(undefined)
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'empty')
})
test('valid simple name → valid: true, code: ok', () => {
  const r = validateDisplayName('John Smith')
  assert.strictEqual(r.valid, true)
  assert.strictEqual(r.code, 'ok')
})
test('valid name with unicode accents → valid: true', () => {
  const r = validateDisplayName('Navdeep Kïndra')
  assert.strictEqual(r.valid, true)
})
test('exactly max length → valid: true', () => {
  const r = validateDisplayName('A'.repeat(DISPLAY_NAME_MAX_LENGTH))
  assert.strictEqual(r.valid, true)
})
test('one over max length → valid: false, code: too_long', () => {
  const r = validateDisplayName('A'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'too_long')
})
test('way over max length → valid: false, code: too_long', () => {
  const r = validateDisplayName('A'.repeat(200))
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'too_long')
})
test('name with newline → valid: false, code: invalid_chars', () => {
  const r = validateDisplayName('John\nSmith')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'invalid_chars')
})
test('name with carriage return → valid: false, code: invalid_chars', () => {
  const r = validateDisplayName('John\rSmith')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'invalid_chars')
})
test('name with tab → valid: false, code: invalid_chars', () => {
  const r = validateDisplayName('John\tSmith')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'invalid_chars')
})
test('name with null byte → valid: false, code: invalid_chars', () => {
  const r = validateDisplayName('John\x00Smith')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'invalid_chars')
})
test('error result always has a non-empty message', () => {
  const codes = ['empty', 'too_long', 'invalid_chars']
  const inputs = ['', 'A'.repeat(81), 'A\nB']
  inputs.forEach(input => {
    const r = validateDisplayName(input)
    assert.ok(typeof r.message === 'string' && r.message.length > 0, `message missing for input: ${JSON.stringify(input)}`)
  })
})
test('ok result has empty message', () => {
  const r = validateDisplayName('Valid Name')
  assert.strictEqual(r.message, '')
})
test('normalizes before length check — padded name at exact max still valid', () => {
  const padded = '  ' + 'A'.repeat(DISPLAY_NAME_MAX_LENGTH) + '  '
  // After trim, exactly DISPLAY_NAME_MAX_LENGTH chars — should be valid
  const r = validateDisplayName(padded)
  assert.strictEqual(r.valid, true)
})

// ── isDeleteAllConfirmEligible ────────────────────────────────────────────────

console.log('\nisDeleteAllConfirmEligible')

test('exact phrase → true', () => {
  assert.strictEqual(isDeleteAllConfirmEligible('delete all contacts'), true)
})
test('DELETE_ALL_PHRASE constant → true', () => {
  assert.strictEqual(isDeleteAllConfirmEligible(DELETE_ALL_PHRASE), true)
})
test('capitalized phrase → false (case-sensitive)', () => {
  assert.strictEqual(isDeleteAllConfirmEligible('Delete all contacts'), false)
})
test('missing trailing s → false', () => {
  assert.strictEqual(isDeleteAllConfirmEligible('delete all contact'), false)
})
test('trailing space → false (no trim)', () => {
  assert.strictEqual(isDeleteAllConfirmEligible('delete all contacts '), false)
})
test('leading space → false (no trim)', () => {
  assert.strictEqual(isDeleteAllConfirmEligible(' delete all contacts'), false)
})
test('extra words → false', () => {
  assert.strictEqual(isDeleteAllConfirmEligible('delete all contacts now'), false)
})
test('empty string → false', () => {
  assert.strictEqual(isDeleteAllConfirmEligible(''), false)
})
test('null → false', () => {
  assert.strictEqual(isDeleteAllConfirmEligible(null), false)
})
test('undefined → false', () => {
  assert.strictEqual(isDeleteAllConfirmEligible(undefined), false)
})
test('number → false', () => {
  assert.strictEqual(isDeleteAllConfirmEligible(42), false)
})

// ── isDeleteAccountConfirmEligible ────────────────────────────────────────────

console.log('\nisDeleteAccountConfirmEligible')

test('exact phrase → true', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible('delete my account'), true)
})
test('DELETE_ACCOUNT_PHRASE constant → true', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible(DELETE_ACCOUNT_PHRASE), true)
})
test('trailing space → true (uses trim)', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible('delete my account '), true)
})
test('leading space → true (uses trim)', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible(' delete my account'), true)
})
test('both sides trimmed → true', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible('  delete my account  '), true)
})
test('capitalized phrase → false (case-sensitive)', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible('Delete my account'), false)
})
test('wrong phrase → false', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible('delete my accounts'), false)
})
test('empty string → false', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible(''), false)
})
test('null → false', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible(null), false)
})
test('undefined → false', () => {
  assert.strictEqual(isDeleteAccountConfirmEligible(undefined), false)
})

// ── formatJoined ─────────────────────────────────────────────────────────────

console.log('\nformatJoined')

test('null → "Unknown" (no visible em dash)', () => {
  assert.strictEqual(formatJoined(null), 'Unknown')
})
test('undefined → "Unknown"', () => {
  assert.strictEqual(formatJoined(undefined), 'Unknown')
})
test('empty string → "Unknown"', () => {
  assert.strictEqual(formatJoined(''), 'Unknown')
})
test('returns "Month Year" format for a valid timestamp', () => {
  const result = formatJoined('2026-03-15T00:00:00Z')
  assert.ok(result.includes('2026'), 'must include the year')
  assert.ok(result.includes('March'), 'must include the month name')
})
test('does not include "Joined" prefix in the return value', () => {
  const result = formatJoined('2026-03-15T00:00:00Z')
  assert.ok(!result.startsWith('Joined'), 'must not include Joined prefix — that is the label')
})
test('invalid date string → "Unknown"', () => {
  assert.strictEqual(formatJoined('not-a-date'), 'Unknown')
})

// ── formatTrialEnd ────────────────────────────────────────────────────────────

console.log('\nformatTrialEnd')

test('null → "Unknown" (no visible em dash)', () => {
  assert.strictEqual(formatTrialEnd(null), 'Unknown')
})
test('undefined → "Unknown"', () => {
  assert.strictEqual(formatTrialEnd(undefined), 'Unknown')
})
test('empty string → "Unknown"', () => {
  assert.strictEqual(formatTrialEnd(''), 'Unknown')
})
test('returns "Month D" format for a valid timestamp', () => {
  // Use noon UTC on the 15th — this stays August 15 in every timezone, avoiding
  // the UTC-midnight ambiguity that can shift August 2 00:00Z to August 1 locally.
  const result = formatTrialEnd('2026-08-15T12:00:00Z')
  assert.ok(typeof result === 'string' && result !== 'Unknown', 'must return a formatted date string')
  assert.ok(!result.includes('2026'), 'must NOT include the year')
  assert.ok(result.includes('August'), 'must include the month name')
})
test('invalid date string → "Unknown"', () => {
  assert.strictEqual(formatTrialEnd('not-a-date'), 'Unknown')
})

// ── summarizeContactCount ─────────────────────────────────────────────────────

console.log('\nsummarizeContactCount')

test('0 → "no contacts"', () => {
  assert.strictEqual(summarizeContactCount(0), 'no contacts')
})
test('1 → "1 contact" (singular)', () => {
  assert.strictEqual(summarizeContactCount(1), '1 contact')
})
test('2 → "2 contacts"', () => {
  assert.strictEqual(summarizeContactCount(2), '2 contacts')
})
test('34 → "34 contacts"', () => {
  assert.strictEqual(summarizeContactCount(34), '34 contacts')
})
test('-1 → "no contacts"', () => {
  assert.strictEqual(summarizeContactCount(-1), 'no contacts')
})
test('null → "no contacts"', () => {
  assert.strictEqual(summarizeContactCount(null), 'no contacts')
})
test('undefined → "no contacts"', () => {
  assert.strictEqual(summarizeContactCount(undefined), 'no contacts')
})
test('string "5" → "no contacts" (type check)', () => {
  assert.strictEqual(summarizeContactCount('5'), 'no contacts')
})
test('100 → "100 contacts"', () => {
  assert.strictEqual(summarizeContactCount(100), '100 contacts')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
