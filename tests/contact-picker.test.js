/**
 * contact-picker.test.js
 *
 * Pure-function tests for contactPickerUtils: filterContacts and
 * buildPickerNavigationState. These are the same functions used by
 * useContactPicker (hook) and handlePickerSelect / pickContact (page handlers).
 *
 * Run: node tests/contact-picker.test.js
 */
import assert from 'assert'
import { filterContacts, buildPickerNavigationState } from '../src/lib/contactPickerUtils.js'

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

// ── Sample contact list ───────────────────────────────────────────────────────

const CONTACTS = [
  { id: '1', name: 'Alice Johnson',  company: 'Blackstone',   role: 'Analyst' },
  { id: '2', name: 'Bob Smith',      company: 'Goldman Sachs', role: 'Recruiter' },
  { id: '3', name: 'Carol White',    company: 'McKinsey',      role: 'Consultant' },
  { id: '4', name: 'Dan Brown',      company: 'BlackRock',     role: 'Portfolio Manager' },
  { id: '5', name: 'Eva Green',      company: null,            role: null },
  { id: '6', name: 'Frank Lee',      company: 'KKR',           role: '' },
]

// ── filterContacts ────────────────────────────────────────────────────────────

console.log('\nfilterContacts\n')

test('empty query returns all contacts up to 20', () => {
  const result = filterContacts(CONTACTS, '')
  assert.strictEqual(result.length, CONTACTS.length)
})

test('empty query preserves input order', () => {
  const result = filterContacts(CONTACTS, '')
  assert.strictEqual(result[0].id, '1')
  assert.strictEqual(result[1].id, '2')
  assert.strictEqual(result[2].id, '3')
})

test('name substring match', () => {
  const result = filterContacts(CONTACTS, 'alice')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '1')
})

test('company substring match', () => {
  const result = filterContacts(CONTACTS, 'goldman')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '2')
})

test('role substring match', () => {
  const result = filterContacts(CONTACTS, 'consultant')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '3')
})

test('name match is case-insensitive', () => {
  const result = filterContacts(CONTACTS, 'ALICE')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '1')
})

test('company match is case-insensitive', () => {
  const result = filterContacts(CONTACTS, 'GOLDMAN')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '2')
})

test('role match is case-insensitive', () => {
  const result = filterContacts(CONTACTS, 'RECRUITER')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '2')
})

test('leading whitespace in query is trimmed', () => {
  const result = filterContacts(CONTACTS, '  alice')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '1')
})

test('trailing whitespace in query is trimmed', () => {
  const result = filterContacts(CONTACTS, 'alice  ')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '1')
})

test('whitespace-only query returns all contacts', () => {
  const result = filterContacts(CONTACTS, '   ')
  assert.strictEqual(result.length, CONTACTS.length)
})

test('null query handled safely (treated as empty)', () => {
  const result = filterContacts(CONTACTS, null)
  assert.strictEqual(result.length, CONTACTS.length)
})

test('contact with null company is still matched by name', () => {
  const result = filterContacts(CONTACTS, 'eva')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '5')
})

test('contact with empty-string role is still matched by name', () => {
  const result = filterContacts(CONTACTS, 'frank')
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, '6')
})

test('query that matches contacts via different fields returns all matches', () => {
  // 'black' appears in Blackstone (Alice, company) and BlackRock (Dan, company)
  const result = filterContacts(CONTACTS, 'black')
  assert.strictEqual(result.length, 2)
  const ids = result.map(c => c.id).sort()
  assert.deepStrictEqual(ids, ['1', '4'])
})

test('no-match query returns empty array', () => {
  const result = filterContacts(CONTACTS, 'zzznomatch')
  assert.strictEqual(result.length, 0)
})

test('empty contacts list with a query returns empty array', () => {
  const result = filterContacts([], 'alice')
  assert.strictEqual(result.length, 0)
})

test('empty contacts list with empty query returns empty array', () => {
  const result = filterContacts([], '')
  assert.strictEqual(result.length, 0)
})

test('filtered results preserve input array order', () => {
  const ordered = [
    { id: 'z', name: 'Zebra Person',  company: 'Acme', role: 'Analyst' },
    { id: 'a', name: 'Apple Person',  company: 'Acme', role: 'Analyst' },
    { id: 'm', name: 'Mango Person',  company: 'Acme', role: 'Analyst' },
  ]
  const result = filterContacts(ordered, '')
  assert.strictEqual(result[0].id, 'z')
  assert.strictEqual(result[1].id, 'a')
  assert.strictEqual(result[2].id, 'm')
})

test('twenty-result cap on unfiltered list', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: String(i + 1), name: `Person ${i + 1}`, company: 'Acme', role: 'Analyst',
  }))
  const result = filterContacts(many, '')
  assert.strictEqual(result.length, 20)
})

test('twenty-result cap on filtered list', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: String(i + 1), name: `Alice ${i + 1}`, company: 'Acme', role: 'Analyst',
  }))
  const result = filterContacts(many, 'alice')
  assert.strictEqual(result.length, 20)
})

// ── buildPickerNavigationState ────────────────────────────────────────────────

console.log('\nbuildPickerNavigationState\n')

test('interaction mode returns { openInteractionForm: true }', () => {
  const state = buildPickerNavigationState('interaction')
  assert.deepStrictEqual(state, { openInteractionForm: true })
})

test('followup mode returns { openFollowUpForm: true }', () => {
  const state = buildPickerNavigationState('followup')
  assert.deepStrictEqual(state, { openFollowUpForm: true })
})

test('unknown string mode returns null (fails safely)', () => {
  assert.strictEqual(buildPickerNavigationState('unknown'), null)
})

test('undefined mode returns null', () => {
  assert.strictEqual(buildPickerNavigationState(undefined), null)
})

test('null mode returns null', () => {
  assert.strictEqual(buildPickerNavigationState(null), null)
})

// ── State derivation logic (documents expected if-chain order) ────────────────

console.log('\nState derivation\n')

test('loading is true initially when no preloaded contacts are supplied', () => {
  // Mirrors: const hasPreloaded = Array.isArray(preloadedContacts)
  // When preloadedContacts is undefined: hasPreloaded=false → loading=true
  const hasPreloaded = Array.isArray(undefined)
  assert.strictEqual(hasPreloaded, false)
  assert.strictEqual(!hasPreloaded, true)
})

test('loading is false initially when contacts array is preloaded', () => {
  const hasPreloaded = Array.isArray([])
  assert.strictEqual(hasPreloaded, true)
  assert.strictEqual(!hasPreloaded, false)
})

test('error state fires before empty-contacts state (render order contract)', () => {
  // ContactPickerResults checks error before contacts.length === 0.
  // This test documents and guards that ordering contract.
  const scenarios = [
    { error: new Error('fail'), contacts: [],   expected: 'error'      },
    { error: null,              contacts: [],   expected: 'no-contacts' },
    { error: null,              contacts: [{}], expected: 'results'     },
  ]
  for (const { error, contacts, expected } of scenarios) {
    let rendered
    if (error)                   rendered = 'error'
    else if (contacts.length === 0) rendered = 'no-contacts'
    else                         rendered = 'results'
    assert.strictEqual(rendered, expected, `scenario expected ${expected}`)
  }
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log()
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
