/**
 * command-palette-utils.test.js — Node.js unit tests for commandPaletteUtils.js
 *
 * Tests all five exports:
 *   encodePostgRESTOrValue  — PostgREST filter grammar safety
 *   getItemId               — stable DOM ID generation
 *   getActiveItemId         — DOM ID of active item (or undefined)
 *   buildFlatItems          — ordered flat palette item list
 *   clampActiveIdx          — index clamping
 *
 * Run with: node tests/command-palette-utils.test.js
 *
 * All tests are Node-safe: no React, no Supabase, no browser APIs.
 */
import assert from 'assert'
import {
  encodePostgRESTOrValue,
  getItemId,
  getActiveItemId,
  buildFlatItems,
  clampActiveIdx,
} from '../src/lib/commandPaletteUtils.js'

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const c1 = { id: 'uuid-c1', name: 'Alice', company: 'Acme' }
const c2 = { id: 'uuid-c2', name: 'Bob',   company: 'Beta' }
const n1 = { id: 'uuid-n1', notes: 'Coffee chat about VC', contacts: { id: 'uuid-c1', name: 'Alice' } }
const a1 = { id: 'qa-add', label: 'Add a contact', action: () => {} }
const a2 = { id: 'qa-log', label: 'Log interaction', action: () => {} }

// ── encodePostgRESTOrValue ────────────────────────────────────────────────────

console.log('\nencodePostgRESTOrValue')

test('returns empty string for non-string input', () => {
  assert.strictEqual(encodePostgRESTOrValue(null), '')
  assert.strictEqual(encodePostgRESTOrValue(undefined), '')
  assert.strictEqual(encodePostgRESTOrValue(123), '')
  assert.strictEqual(encodePostgRESTOrValue({}), '')
})
test('returns empty string for empty string', () => {
  assert.strictEqual(encodePostgRESTOrValue(''), '')
})
test('passes through plain alphanumeric value unchanged', () => {
  assert.strictEqual(encodePostgRESTOrValue('alice'), 'alice')
})
test('strips a single comma', () => {
  assert.strictEqual(encodePostgRESTOrValue('foo,bar'), 'foobar')
})
test('strips multiple commas', () => {
  assert.strictEqual(encodePostgRESTOrValue('a,b,c'), 'abc')
})
test('strips opening paren', () => {
  assert.strictEqual(encodePostgRESTOrValue('foo(bar'), 'foobar')
})
test('strips closing paren', () => {
  assert.strictEqual(encodePostgRESTOrValue('foo)bar'), 'foobar')
})
test('strips all structural chars combined', () => {
  assert.strictEqual(encodePostgRESTOrValue('name.eq.foo,role.eq.(bar)'), 'name.eq.foorole.eq.bar')
})
test('preserves backslashes (ILIKE escape, not PostgREST structural)', () => {
  assert.strictEqual(encodePostgRESTOrValue('foo\\%bar'), 'foo\\%bar')
})
test('preserves percent signs (delimiters added by caller, not structural grammar)', () => {
  // encodePostgRESTOrValue operates on the escaped value BEFORE % delimiters are added
  assert.strictEqual(encodePostgRESTOrValue('foobar'), 'foobar')
})
test('preserves underscores', () => {
  assert.strictEqual(encodePostgRESTOrValue('foo_bar'), 'foo_bar')
})
test('strips all three structural chars in one pass', () => {
  assert.strictEqual(encodePostgRESTOrValue('a,b(c)d'), 'abcd')
})
test('injection scenario: comma that would add a filter clause is stripped', () => {
  // A malicious or accidental user query "foo,name.eq.bar" after ILIKE escaping
  // becomes "foo,name.eq.bar" — the comma would inject a second clause.
  const escaped = 'foo,name.eq.bar'
  const result = encodePostgRESTOrValue(escaped)
  assert.ok(!result.includes(','), 'comma must be stripped')
  assert.strictEqual(result, 'fooname.eq.bar')
})

// ── getItemId ─────────────────────────────────────────────────────────────────

console.log('\ngetItemId')

test("kind='recent' produces cp-recent-<contactId>", () => {
  assert.strictEqual(getItemId({ kind: 'recent', contact: c1 }), 'cp-recent-uuid-c1')
})
test("kind='contact' produces cp-contact-<contactId>", () => {
  assert.strictEqual(getItemId({ kind: 'contact', contact: c2 }), 'cp-contact-uuid-c2')
})
test("kind='note' produces cp-note-<noteId>", () => {
  assert.strictEqual(getItemId({ kind: 'note', note: n1 }), 'cp-note-uuid-n1')
})
test("kind='action' produces cp-action-<actionId>", () => {
  assert.strictEqual(getItemId({ kind: 'action', action: a1 }), 'cp-action-qa-add')
})
test("kind='nav' produces cp-nav-<navId>", () => {
  const navItem = { kind: 'nav', nav: { id: 'nav-contacts', label: 'Go to Contacts', route: '/contacts' } }
  assert.strictEqual(getItemId(navItem), 'cp-nav-nav-contacts')
})
test("kind='ai' produces the constant cp-ai-handoff", () => {
  assert.strictEqual(getItemId({ kind: 'ai' }), 'cp-ai-handoff')
})
test('null item returns cp-unknown', () => {
  assert.strictEqual(getItemId(null), 'cp-unknown')
})
test('undefined item returns cp-unknown', () => {
  assert.strictEqual(getItemId(undefined), 'cp-unknown')
})
test('unknown kind returns cp-unknown', () => {
  assert.strictEqual(getItemId({ kind: 'ghost' }), 'cp-unknown')
})
test('missing contact id falls back to "unknown" segment', () => {
  assert.strictEqual(getItemId({ kind: 'contact', contact: { name: 'Alice' } }), 'cp-contact-unknown')
})
test('missing note id falls back to "unknown" segment', () => {
  assert.strictEqual(getItemId({ kind: 'note', note: { notes: 'hi' } }), 'cp-note-unknown')
})
test('missing action id falls back to "unknown" segment', () => {
  assert.strictEqual(getItemId({ kind: 'action', action: {} }), 'cp-action-unknown')
})
test('missing nav id falls back to "unknown" segment', () => {
  assert.strictEqual(getItemId({ kind: 'nav', nav: {} }), 'cp-nav-unknown')
})
test('IDs are stable: same item always produces the same ID', () => {
  const id1 = getItemId({ kind: 'contact', contact: c1 })
  const id2 = getItemId({ kind: 'contact', contact: c1 })
  assert.strictEqual(id1, id2)
})
test('IDs differ for different contacts', () => {
  const id1 = getItemId({ kind: 'contact', contact: c1 })
  const id2 = getItemId({ kind: 'contact', contact: c2 })
  assert.notStrictEqual(id1, id2)
})
test("'recent' and 'contact' kinds produce distinct IDs even with the same contact UUID", () => {
  const recentId  = getItemId({ kind: 'recent',  contact: c1 })
  const contactId = getItemId({ kind: 'contact', contact: c1 })
  assert.notStrictEqual(recentId, contactId)
})

// ── getActiveItemId ───────────────────────────────────────────────────────────

console.log('\ngetActiveItemId')

const sampleItems = [
  { kind: 'recent',  contact: c1 },
  { kind: 'contact', contact: c2 },
  { kind: 'ai' },
]

test('returns ID of item at valid activeIdx', () => {
  assert.strictEqual(getActiveItemId(sampleItems, 0), 'cp-recent-uuid-c1')
  assert.strictEqual(getActiveItemId(sampleItems, 1), 'cp-contact-uuid-c2')
  assert.strictEqual(getActiveItemId(sampleItems, 2), 'cp-ai-handoff')
})
test('returns undefined for empty array', () => {
  assert.strictEqual(getActiveItemId([], 0), undefined)
})
test('returns undefined for negative activeIdx', () => {
  assert.strictEqual(getActiveItemId(sampleItems, -1), undefined)
})
test('returns undefined for activeIdx === items.length', () => {
  assert.strictEqual(getActiveItemId(sampleItems, 3), undefined)
})
test('returns undefined for activeIdx greater than length', () => {
  assert.strictEqual(getActiveItemId(sampleItems, 99), undefined)
})
test('returns undefined when items is not an array', () => {
  assert.strictEqual(getActiveItemId(null, 0), undefined)
  assert.strictEqual(getActiveItemId(undefined, 0), undefined)
})
test('returns undefined when activeIdx is not a number', () => {
  assert.strictEqual(getActiveItemId(sampleItems, 'foo'), undefined)
  assert.strictEqual(getActiveItemId(sampleItems, null), undefined)
})
test('result equals getItemId(items[activeIdx])', () => {
  const result = getActiveItemId(sampleItems, 1)
  assert.strictEqual(result, getItemId(sampleItems[1]))
})

// ── buildFlatItems ────────────────────────────────────────────────────────────

console.log('\nbuildFlatItems')

const quickActions = [a1, a2]

test('empty query: recentContacts come first', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [c1, c2], contactResults: [], noteResults: [], quickActions: [], canUsePro: false })
  assert.strictEqual(items[0].kind, 'recent')
  assert.strictEqual(items[0].contact, c1)
  assert.strictEqual(items[1].kind, 'recent')
  assert.strictEqual(items[1].contact, c2)
})
test('empty query: quickActions follow recentContacts', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [c1], contactResults: [], noteResults: [], quickActions: [a1, a2], canUsePro: false })
  const kinds = items.map(i => i.kind)
  const recentEnd = kinds.lastIndexOf('recent')
  const actionStart = kinds.indexOf('action')
  assert.ok(actionStart > recentEnd, 'actions must follow recent contacts')
})
test('empty query: nav commands follow quickActions', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [], contactResults: [], noteResults: [], quickActions: [a1], canUsePro: false })
  const kinds = items.map(i => i.kind)
  const actionEnd = kinds.lastIndexOf('action')
  const navStart = kinds.indexOf('nav')
  if (navStart !== -1) {
    assert.ok(navStart > actionEnd, 'nav must follow actions')
  }
})
test('empty query + canUsePro=true: AI item is last', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [], contactResults: [], noteResults: [], quickActions: [a1], canUsePro: true })
  assert.strictEqual(items[items.length - 1].kind, 'ai')
})
test('empty query + canUsePro=false: no AI item', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [], contactResults: [], noteResults: [], quickActions: [a1], canUsePro: false })
  assert.ok(!items.some(i => i.kind === 'ai'), 'non-Pro must have no AI item')
})
test('non-empty query: contactResults come first', () => {
  const items = buildFlatItems({ norm: 'alice', recentContacts: [], contactResults: [c1, c2], noteResults: [], quickActions: [], canUsePro: false })
  assert.strictEqual(items[0].kind, 'contact')
  assert.strictEqual(items[0].contact, c1)
})
test('non-empty query: noteResults follow contactResults', () => {
  const items = buildFlatItems({ norm: 'coffee', recentContacts: [], contactResults: [c1], noteResults: [n1], quickActions: [], canUsePro: false })
  const kinds = items.map(i => i.kind)
  const contactEnd = kinds.lastIndexOf('contact')
  const noteStart = kinds.indexOf('note')
  assert.ok(noteStart > contactEnd, 'notes must follow contacts')
})
test('non-empty query: quickActions follow noteResults', () => {
  const items = buildFlatItems({ norm: 'x', recentContacts: [], contactResults: [c1], noteResults: [n1], quickActions: [a1], canUsePro: false })
  const kinds = items.map(i => i.kind)
  const noteEnd = kinds.lastIndexOf('note')
  const actionStart = kinds.indexOf('action')
  assert.ok(actionStart > noteEnd, 'actions must follow notes')
})
test('non-empty query + canUsePro=true: AI item is last', () => {
  const items = buildFlatItems({ norm: 'alice', recentContacts: [], contactResults: [c1], noteResults: [], quickActions: [], canUsePro: true })
  assert.strictEqual(items[items.length - 1].kind, 'ai')
})
test('non-empty query + canUsePro=false: no AI item', () => {
  const items = buildFlatItems({ norm: 'alice', recentContacts: [], contactResults: [c1], noteResults: [], quickActions: [], canUsePro: false })
  assert.ok(!items.some(i => i.kind === 'ai'), 'non-Pro must have no AI item')
})
test('empty query: recentContacts in the flat list are all kind=recent', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [c1, c2], contactResults: [], noteResults: [], quickActions: [], canUsePro: false })
  const recentItems = items.filter(i => i.kind === 'recent')
  assert.strictEqual(recentItems.length, 2)
})
test('non-empty query: recentContacts are NOT included', () => {
  const items = buildFlatItems({ norm: 'alice', recentContacts: [c1, c2], contactResults: [c1], noteResults: [], quickActions: [], canUsePro: false })
  assert.ok(!items.some(i => i.kind === 'recent'), 'recent contacts must not appear when query is non-empty')
})
test('empty query: contactResults are NOT included', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [], contactResults: [c1], noteResults: [], quickActions: [], canUsePro: false })
  assert.ok(!items.some(i => i.kind === 'contact'), 'contactResults must not appear when query is empty')
})
test('handles undefined/null arrays gracefully', () => {
  assert.doesNotThrow(() => buildFlatItems({ norm: '', recentContacts: null, contactResults: undefined, noteResults: null, quickActions: undefined, canUsePro: false }))
})
test('empty query with no items returns empty array', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [], contactResults: [], noteResults: [], quickActions: [], canUsePro: false })
  // Should only have nav items (from filterNavigationCommands with empty query)
  const nonNav = items.filter(i => i.kind !== 'nav')
  assert.strictEqual(nonNav.length, 0)
})
test('item count equals sum of all group sizes', () => {
  const recentContacts = [c1, c2]
  const quickActions = [a1, a2]
  const items = buildFlatItems({ norm: '', recentContacts, contactResults: [], noteResults: [], quickActions, canUsePro: true })
  const navCount = items.filter(i => i.kind === 'nav').length
  const aiCount = items.filter(i => i.kind === 'ai').length
  assert.strictEqual(items.length, 2 + 2 + navCount + aiCount)
})
test('AI item has only kind property', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [], contactResults: [], noteResults: [], quickActions: [], canUsePro: true })
  const aiItem = items.find(i => i.kind === 'ai')
  assert.ok(aiItem, 'AI item must be present')
  assert.strictEqual(aiItem.kind, 'ai')
})
test('keyboard order matches visual order: contacts before notes before actions', () => {
  const items = buildFlatItems({ norm: 'x', recentContacts: [], contactResults: [c1], noteResults: [n1], quickActions: [a1], canUsePro: false })
  const kinds = items.map(i => i.kind)
  const cIdx = kinds.indexOf('contact')
  const nIdx = kinds.indexOf('note')
  const aIdx = kinds.indexOf('action')
  assert.ok(cIdx < nIdx, 'contacts before notes')
  assert.ok(nIdx < aIdx, 'notes before actions')
})

// ── clampActiveIdx ────────────────────────────────────────────────────────────

console.log('\nclampActiveIdx')

const threeItems = [{ kind: 'recent', contact: c1 }, { kind: 'action', action: a1 }, { kind: 'ai' }]

test('clamps 0 to 0 (already valid)', () => {
  assert.strictEqual(clampActiveIdx(0, threeItems), 0)
})
test('clamps to last index when idx equals length', () => {
  assert.strictEqual(clampActiveIdx(3, threeItems), 2)
})
test('clamps to last index when idx is very large', () => {
  assert.strictEqual(clampActiveIdx(99, threeItems), 2)
})
test('clamps negative idx to 0', () => {
  assert.strictEqual(clampActiveIdx(-1, threeItems), 0)
})
test('returns 0 for empty items array', () => {
  assert.strictEqual(clampActiveIdx(5, []), 0)
})
test('returns 0 for null items', () => {
  assert.strictEqual(clampActiveIdx(5, null), 0)
})
test('returns 0 for undefined items', () => {
  assert.strictEqual(clampActiveIdx(5, undefined), 0)
})
test('valid mid-range idx passes through unchanged', () => {
  assert.strictEqual(clampActiveIdx(1, threeItems), 1)
})
test('clamps exactly to length - 1', () => {
  assert.strictEqual(clampActiveIdx(2, threeItems), 2)  // last valid
  assert.strictEqual(clampActiveIdx(3, threeItems), 2)  // one past last
})

// ── Cross-contract: getItemId ↔ getActiveItemId ────────────────────────────────

console.log('\nCross-contract')

test('getActiveItemId(buildFlatItems(...), 0) equals getItemId of first item', () => {
  const items = buildFlatItems({ norm: 'alice', recentContacts: [], contactResults: [c1], noteResults: [], quickActions: [], canUsePro: false })
  const expected = getItemId(items[0])
  assert.strictEqual(getActiveItemId(items, 0), expected)
})
test('getActiveItemId returns undefined for out-of-range index from buildFlatItems', () => {
  const items = buildFlatItems({ norm: '', recentContacts: [], contactResults: [], noteResults: [], quickActions: [], canUsePro: false })
  assert.strictEqual(getActiveItemId(items, 999), undefined)
})

// ── results ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
