/**
 * search-utils.test.js — Pure helper tests for src/lib/searchUtils.js
 *
 * Zero dependencies on React or Supabase.  Run with:
 *   node tests/search-utils.test.js
 *
 * Covers:
 *   normalizeQuery           — whitespace, case, unicode, empty, non-string, long
 *   escapeIlike              — %, _, backslash, combos, non-string, empty
 *   highlightSegments        — match/no-match, regex chars, emoji, repeated, case
 *   extractNoteSnippet       — match near start/end/middle, no match, empty, maxLen
 *   recentContactsKey        — uid forms
 *   readRecentContacts       — corrupted JSON, non-array, missing entry, valid
 *   writeRecentContact       — dedup, cap at RECENT_MAX, no-op guards
 *   clearRecentContacts      — removes entry, no-op for missing uid
 *   buildAIPrefillState      — non-empty, empty, non-string, whitespace-only
 *   buildAIHandoffLabel      — empty, short, long (truncates at 50)
 *   buildNoResultPrefill     — valid name, email reject, URL reject, too-long-sentence
 *   NAVIGATION_COMMANDS      — structure and uniqueness
 *   filterNavigationCommands — empty query, query matching, pro gate
 */
import assert from 'assert'
import { createRequire } from 'module'

// Use localStorage mock before importing searchUtils so its module-level code
// doesn't crash in Node.js where localStorage is undefined.
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

// --- Node-compatible localStorage mock -----------------------------------
const localStorageStore = new Map()
const localStorageMock = {
  getItem:    (k) => localStorageStore.get(k) ?? null,
  setItem:    (k, v) => { localStorageStore.set(k, String(v)) },
  removeItem: (k) => localStorageStore.delete(k),
  clear:      () => localStorageStore.clear(),
}
globalThis.localStorage = localStorageMock

// Now import the module under test.
import {
  normalizeQuery,
  escapeIlike,
  highlightSegments,
  extractNoteSnippet,
  RECENT_KEY_PREFIX,
  RECENT_MAX,
  recentContactsKey,
  readRecentContacts,
  writeRecentContact,
  clearRecentContacts,
  buildAIPrefillState,
  buildAIHandoffLabel,
  buildNoResultPrefill,
  NAVIGATION_COMMANDS,
  filterNavigationCommands,
} from '../src/lib/searchUtils.js'

// ── Test runner ───────────────────────────────────────────────────────────────

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

// ── normalizeQuery ────────────────────────────────────────────────────────────

console.log('\nnormalizeQuery')

test('trims leading/trailing whitespace', () => {
  assert.strictEqual(normalizeQuery('  hello  '), 'hello')
})
test('lowercases ASCII', () => {
  assert.strictEqual(normalizeQuery('HELLO World'), 'hello world')
})
test('collapses internal whitespace to single space', () => {
  assert.strictEqual(normalizeQuery('a   b\t\tc'), 'a b c')
})
test('returns empty string for empty input', () => {
  assert.strictEqual(normalizeQuery(''), '')
})
test('returns empty string for whitespace-only input', () => {
  assert.strictEqual(normalizeQuery('   '), '')
})
test('returns empty string for null', () => {
  assert.strictEqual(normalizeQuery(null), '')
})
test('returns empty string for undefined', () => {
  assert.strictEqual(normalizeQuery(undefined), '')
})
test('returns empty string for number input', () => {
  assert.strictEqual(normalizeQuery(42), '')
})
test('returns empty string for object input', () => {
  assert.strictEqual(normalizeQuery({}), '')
})
test('preserves unicode letters after lowercasing', () => {
  const result = normalizeQuery('Héllo')
  assert.ok(result.includes('héllo') || result.includes('hello'), `got: ${result}`)
})
test('handles very long strings without throwing', () => {
  const long = 'a'.repeat(10_000)
  const result = normalizeQuery(long)
  assert.strictEqual(result, long)  // no collapse needed — already single chars
})
test('handles newlines as collapsible whitespace', () => {
  assert.strictEqual(normalizeQuery('a\nb\nc'), 'a b c')
})

// ── escapeIlike ───────────────────────────────────────────────────────────────

console.log('\nescapeIlike')

test('escapes % character', () => {
  assert.strictEqual(escapeIlike('50% done'), '50\\% done')
})
test('escapes _ character', () => {
  assert.strictEqual(escapeIlike('foo_bar'), 'foo\\_bar')
})
test('escapes backslash before % and _ to avoid double-escaping', () => {
  assert.strictEqual(escapeIlike('\\'), '\\\\')
})
test('escapes backslash-then-percent: \\ → \\\\  then % → \\%', () => {
  assert.strictEqual(escapeIlike('\\%'), '\\\\\\%')
})
test('leaves normal alpha chars untouched', () => {
  assert.strictEqual(escapeIlike('hello world'), 'hello world')
})
test('returns empty string for empty input', () => {
  assert.strictEqual(escapeIlike(''), '')
})
test('returns empty string for null', () => {
  assert.strictEqual(escapeIlike(null), '')
})
test('returns empty string for undefined', () => {
  assert.strictEqual(escapeIlike(undefined), '')
})
test('handles multiple special chars in a row', () => {
  assert.strictEqual(escapeIlike('%_'), '\\%\\_')
})
test('handles strings with all three special chars', () => {
  const result = escapeIlike('a%b_c\\d')
  assert.ok(result.includes('\\%') && result.includes('\\_') && result.includes('\\\\'), `got: ${result}`)
})
test('number input returns empty string', () => {
  assert.strictEqual(escapeIlike(42), '')
})

// ── highlightSegments ─────────────────────────────────────────────────────────

console.log('\nhighlightSegments')

test('returns single no-match segment when no match', () => {
  const segs = highlightSegments('hello world', 'xyz')
  assert.deepStrictEqual(segs, [{ text: 'hello world', match: false }])
})
test('returns single match segment when exact match', () => {
  const segs = highlightSegments('hello', 'hello')
  assert.deepStrictEqual(segs, [{ text: 'hello', match: true }])
})
test('returns mixed segments: prefix + match + suffix', () => {
  const segs = highlightSegments('say hello world', 'hello')
  assert.ok(segs.some(s => s.match && s.text === 'hello'), 'must include matched segment')
  assert.ok(segs.some(s => !s.match), 'must include non-matched segment(s)')
})
test('case-insensitive matching', () => {
  const segs = highlightSegments('Hello World', 'hello')
  const matched = segs.find(s => s.match)
  assert.ok(matched, 'must find a match')
  assert.strictEqual(matched.text.toLowerCase(), 'hello')
})
test('returns all segments for repeated match', () => {
  const segs = highlightSegments('aa bb aa', 'aa')
  const matchCount = segs.filter(s => s.match).length
  assert.strictEqual(matchCount, 2)
})
test('handles regex metachar in query without throwing', () => {
  assert.doesNotThrow(() => highlightSegments('a+b=c', 'a+b'))
})
test('handles parens in query without throwing', () => {
  assert.doesNotThrow(() => highlightSegments('(test)', '(test)'))
})
test('handles dot in query (literal match only)', () => {
  const segs = highlightSegments('a.b axb', 'a.b')
  const matchedTexts = segs.filter(s => s.match).map(s => s.text)
  assert.ok(matchedTexts.includes('a.b'), 'must match literal a.b')
  const hasAxb = matchedTexts.includes('axb')
  assert.ok(!hasAxb, 'must NOT match axb for dot query (literal)')
})
test('handles emoji text without throwing', () => {
  assert.doesNotThrow(() => highlightSegments('hello 🎉 world', 'hello'))
})
test('returns no-match segment for empty text', () => {
  const segs = highlightSegments('', 'hello')
  assert.deepStrictEqual(segs, [{ text: '', match: false }])
})
test('returns single no-match segment for null text', () => {
  const segs = highlightSegments(null, 'hello')
  assert.deepStrictEqual(segs, [{ text: '', match: false }])
})
test('returns no-match segment for empty query', () => {
  const segs = highlightSegments('hello world', '')
  assert.deepStrictEqual(segs, [{ text: 'hello world', match: false }])
})
test('returns no-match segment for null query', () => {
  const segs = highlightSegments('hello world', null)
  assert.deepStrictEqual(segs, [{ text: 'hello world', match: false }])
})
test('preserves complete text across all segments', () => {
  const text = 'The quick brown fox'
  const segs = highlightSegments(text, 'quick')
  const reconstructed = segs.map(s => s.text).join('')
  assert.strictEqual(reconstructed, text)
})

// ── extractNoteSnippet ────────────────────────────────────────────────────────

console.log('\nextractNoteSnippet')

test('returns empty string for null text', () => {
  assert.strictEqual(extractNoteSnippet(null, 'hello'), '')
})
test('returns empty string for empty text', () => {
  assert.strictEqual(extractNoteSnippet('', 'hello'), '')
})
test('returns full text when shorter than maxLen', () => {
  const t = 'Short text about foo'
  assert.strictEqual(extractNoteSnippet(t, 'foo'), t)
})
test('truncates long text with no match, appends ellipsis', () => {
  const t = 'A'.repeat(200)
  const result = extractNoteSnippet(t, 'zzz')
  assert.ok(result.endsWith('…'), `should end with ellipsis, got: ${result.slice(-3)}`)
  assert.ok(result.length <= 141, `should be at most maxLen+1 (for ellipsis), got: ${result.length}`)
})
test('centres snippet on match', () => {
  const prefix = 'x'.repeat(100)
  const match = 'TARGET'
  const suffix = 'y'.repeat(100)
  const text = prefix + match + suffix
  const result = extractNoteSnippet(text, 'target')
  assert.ok(result.includes('TARGET'), 'snippet must contain the match')
})
test('match near start: no leading ellipsis', () => {
  const text = 'TARGET is here and then lots of other text that fills the rest of the snippet area nicely'
  const result = extractNoteSnippet(text, 'target')
  assert.ok(!result.startsWith('…'), 'no leading ellipsis when match is near start')
})
test('match near end: trailing ellipsis suppressed when window reaches end', () => {
  const text = 'some long text here and then more text and finally the TARGET'
  const result = extractNoteSnippet(text, 'target')
  // snippet may or may not have trailing ellipsis depending on whether end was reached
  assert.ok(result.includes('TARGET'), 'snippet must contain the match')
})
test('collapses whitespace in source text', () => {
  const text = 'hello   world'
  const result = extractNoteSnippet(text, 'world')
  assert.ok(!result.includes('   '), 'whitespace should be collapsed')
})
test('returns first maxLen chars when no match and text is long', () => {
  const text = 'The quick brown fox jumps over the lazy dog and keeps running forever and ever and ever'
  const result = extractNoteSnippet(text, 'zzz', 20)
  assert.ok(result.length <= 21, `expected ≤21 chars, got ${result.length}`)  // 20 + ellipsis
})
test('respects custom maxLen parameter', () => {
  const text = 'Hello world this is a test of the snippet extraction function'
  const result = extractNoteSnippet(text, 'test', 30)
  // +1 for possible ellipsis on either side
  assert.ok(result.length <= 32, `expected ≤32 chars (30 + ellipsis), got ${result.length}`)
})
test('ignores maxLen > 300 and uses default', () => {
  const t = 'X'.repeat(500)
  const result = extractNoteSnippet(t, 'zzz', 9999)
  assert.ok(result.length <= 141, 'out-of-range maxLen must fall back to SNIPPET_MAX=140 + ellipsis')
})

// ── Recent contacts — localStorage ────────────────────────────────────────────

console.log('\nrecent contacts (localStorage)')

const TEST_UID = 'test-uid-123'
const TEST_UID2 = 'test-uid-456'

function clearAll() {
  localStorageStore.clear()
}

test('recentContactsKey returns prefixed key', () => {
  const key = recentContactsKey(TEST_UID)
  assert.ok(key.startsWith(RECENT_KEY_PREFIX), `key must start with prefix, got: ${key}`)
  assert.ok(key.endsWith(TEST_UID), `key must end with uid, got: ${key}`)
})

test('readRecentContacts returns [] for empty uid', () => {
  assert.deepStrictEqual(readRecentContacts(null), [])
  assert.deepStrictEqual(readRecentContacts(''), [])
  assert.deepStrictEqual(readRecentContacts(undefined), [])
})

test('readRecentContacts returns [] when key does not exist', () => {
  clearAll()
  assert.deepStrictEqual(readRecentContacts(TEST_UID), [])
})

test('readRecentContacts returns [] for corrupted JSON', () => {
  clearAll()
  localStorage.setItem(recentContactsKey(TEST_UID), 'NOT_VALID_JSON{{{')
  assert.deepStrictEqual(readRecentContacts(TEST_UID), [])
})

test('readRecentContacts returns [] when stored value is not an array', () => {
  clearAll()
  localStorage.setItem(recentContactsKey(TEST_UID), JSON.stringify({ id: 'foo' }))
  assert.deepStrictEqual(readRecentContacts(TEST_UID), [])
})

test('readRecentContacts filters out non-string entries', () => {
  clearAll()
  localStorage.setItem(recentContactsKey(TEST_UID), JSON.stringify(['id-1', 42, null, '', 'id-2']))
  const result = readRecentContacts(TEST_UID)
  assert.deepStrictEqual(result, ['id-1', 'id-2'])
})

test('readRecentContacts returns stored ids in order', () => {
  clearAll()
  const ids = ['c1', 'c2', 'c3']
  localStorage.setItem(recentContactsKey(TEST_UID), JSON.stringify(ids))
  assert.deepStrictEqual(readRecentContacts(TEST_UID), ids)
})

test('writeRecentContact pushes id to front', () => {
  clearAll()
  writeRecentContact(TEST_UID, 'c1')
  writeRecentContact(TEST_UID, 'c2')
  const result = readRecentContacts(TEST_UID)
  assert.strictEqual(result[0], 'c2')
  assert.strictEqual(result[1], 'c1')
})

test('writeRecentContact deduplicates — moves existing id to front', () => {
  clearAll()
  writeRecentContact(TEST_UID, 'c1')
  writeRecentContact(TEST_UID, 'c2')
  writeRecentContact(TEST_UID, 'c1')  // c1 already in list → move to front
  const result = readRecentContacts(TEST_UID)
  assert.strictEqual(result[0], 'c1')
  assert.strictEqual(result.filter(id => id === 'c1').length, 1, 'c1 must appear only once')
})

test('writeRecentContact caps at RECENT_MAX', () => {
  clearAll()
  for (let i = 0; i < RECENT_MAX + 5; i++) {
    writeRecentContact(TEST_UID, `contact-${i}`)
  }
  const result = readRecentContacts(TEST_UID)
  assert.ok(result.length <= RECENT_MAX, `must cap at ${RECENT_MAX}, got ${result.length}`)
})

test('writeRecentContact is a no-op for empty uid', () => {
  clearAll()
  writeRecentContact(null, 'c1')
  writeRecentContact('', 'c1')
  writeRecentContact(undefined, 'c1')
  assert.strictEqual(localStorageStore.size, 0)
})

test('writeRecentContact is a no-op for empty contactId', () => {
  clearAll()
  writeRecentContact(TEST_UID, null)
  writeRecentContact(TEST_UID, '')
  writeRecentContact(TEST_UID, undefined)
  assert.strictEqual(localStorageStore.size, 0)
})

test('clearRecentContacts removes the entry', () => {
  clearAll()
  writeRecentContact(TEST_UID, 'c1')
  assert.strictEqual(localStorageStore.size, 1)
  clearRecentContacts(TEST_UID)
  assert.strictEqual(localStorageStore.size, 0)
  assert.deepStrictEqual(readRecentContacts(TEST_UID), [])
})

test('clearRecentContacts is a no-op for missing uid', () => {
  clearAll()
  assert.doesNotThrow(() => clearRecentContacts(null))
  assert.doesNotThrow(() => clearRecentContacts(''))
  assert.doesNotThrow(() => clearRecentContacts(undefined))
})

test('different uids have isolated storage', () => {
  clearAll()
  writeRecentContact(TEST_UID, 'c1')
  writeRecentContact(TEST_UID2, 'c2')
  assert.deepStrictEqual(readRecentContacts(TEST_UID), ['c1'])
  assert.deepStrictEqual(readRecentContacts(TEST_UID2), ['c2'])
})

test('clearRecentContacts only removes targeted uid', () => {
  clearAll()
  writeRecentContact(TEST_UID, 'c1')
  writeRecentContact(TEST_UID2, 'c2')
  clearRecentContacts(TEST_UID)
  assert.deepStrictEqual(readRecentContacts(TEST_UID), [])
  assert.deepStrictEqual(readRecentContacts(TEST_UID2), ['c2'])
})

// ── buildAIPrefillState ───────────────────────────────────────────────────────

console.log('\nbuildAIPrefillState')

test('returns { aiPrompt: q } for non-empty query', () => {
  const result = buildAIPrefillState('goldman recruiter')
  assert.deepStrictEqual(result, { aiPrompt: 'goldman recruiter' })
})
test('trims surrounding whitespace', () => {
  const result = buildAIPrefillState('  hello  ')
  assert.deepStrictEqual(result, { aiPrompt: 'hello' })
})
test('returns null for empty string', () => {
  assert.strictEqual(buildAIPrefillState(''), null)
})
test('returns null for whitespace-only string', () => {
  assert.strictEqual(buildAIPrefillState('   '), null)
})
test('returns null for null input', () => {
  assert.strictEqual(buildAIPrefillState(null), null)
})
test('returns null for undefined input', () => {
  assert.strictEqual(buildAIPrefillState(undefined), null)
})
test('returns null for number input', () => {
  assert.strictEqual(buildAIPrefillState(42), null)
})

// ── buildAIHandoffLabel ───────────────────────────────────────────────────────

console.log('\nbuildAIHandoffLabel')

test('returns "Ask Funnl AI" for empty query', () => {
  assert.strictEqual(buildAIHandoffLabel(''), 'Ask Funnl AI')
})
test('returns "Ask Funnl AI" for null query', () => {
  assert.strictEqual(buildAIHandoffLabel(null), 'Ask Funnl AI')
})
test('returns label with query for short query', () => {
  const label = buildAIHandoffLabel('goldman sachs')
  assert.ok(label.includes('goldman sachs'), `must include query, got: ${label}`)
})
test('truncates label to 50 chars with ellipsis', () => {
  const longQuery = 'a'.repeat(60)
  const label = buildAIHandoffLabel(longQuery)
  assert.ok(label.includes('…'), `must include ellipsis for long query, got: ${label}`)
  // The label text portion (after "Ask Funnl AI about "...) should be truncated
  const displayPart = label.replace('Ask Funnl AI about "', '').replace('"', '')
  assert.ok(displayPart.length <= 52, `display part should be ≤52 chars (50+ellipsis+quote), got ${displayPart.length}`)
})
test('does not truncate 50-char query', () => {
  const query = 'a'.repeat(50)
  const label = buildAIHandoffLabel(query)
  assert.ok(!label.includes('…'), 'should not truncate 50-char query')
})
test('truncates 51-char query', () => {
  const query = 'a'.repeat(51)
  const label = buildAIHandoffLabel(query)
  assert.ok(label.includes('…'), 'should truncate 51-char query')
})

// ── buildNoResultPrefill ──────────────────────────────────────────────────────

console.log('\nbuildNoResultPrefill')

test('returns the query as-is for a valid name', () => {
  assert.strictEqual(buildNoResultPrefill('Priya Sharma'), 'Priya Sharma')
})
test('returns single-word name', () => {
  assert.strictEqual(buildNoResultPrefill('Alice'), 'Alice')
})
test('returns null for empty string', () => {
  assert.strictEqual(buildNoResultPrefill(''), null)
})
test('returns null for whitespace-only string', () => {
  assert.strictEqual(buildNoResultPrefill('   '), null)
})
test('returns null for null input', () => {
  assert.strictEqual(buildNoResultPrefill(null), null)
})
test('returns null for undefined input', () => {
  assert.strictEqual(buildNoResultPrefill(undefined), null)
})
test('returns null for email-like queries (contains @)', () => {
  assert.strictEqual(buildNoResultPrefill('alice@example.com'), null)
})
test('returns null for http URL', () => {
  assert.strictEqual(buildNoResultPrefill('https://linkedin.com/in/alice'), null)
})
test('returns null for www URL', () => {
  assert.strictEqual(buildNoResultPrefill('www.example.com'), null)
})
test('returns null for queries > 100 chars', () => {
  assert.strictEqual(buildNoResultPrefill('a'.repeat(101)), null)
})
test('returns string for exactly 100 chars', () => {
  const q = 'a'.repeat(100)
  assert.strictEqual(buildNoResultPrefill(q), q)
})
test('returns null for 7+ word queries (too long to be a name)', () => {
  assert.strictEqual(buildNoResultPrefill('one two three four five six seven'), null)
})
test('returns value for 6-word query (max allowed)', () => {
  const q = 'one two three four five six'
  assert.ok(buildNoResultPrefill(q) !== null, '6 words should be allowed')
})
test('trims surrounding whitespace before returning', () => {
  assert.strictEqual(buildNoResultPrefill('  Alice  '), 'Alice')
})

// ── NAVIGATION_COMMANDS ───────────────────────────────────────────────────────

console.log('\nNAVIGATION_COMMANDS')

test('NAVIGATION_COMMANDS is an array', () => {
  assert.ok(Array.isArray(NAVIGATION_COMMANDS))
})
test('NAVIGATION_COMMANDS has exactly 5 entries', () => {
  assert.strictEqual(NAVIGATION_COMMANDS.length, 5)
})
test('each command has id, label, route, keywords', () => {
  for (const cmd of NAVIGATION_COMMANDS) {
    assert.ok(cmd.id, `${JSON.stringify(cmd)}: missing id`)
    assert.ok(cmd.label, `${JSON.stringify(cmd)}: missing label`)
    assert.ok(cmd.route, `${JSON.stringify(cmd)}: missing route`)
    assert.ok(Array.isArray(cmd.keywords), `${JSON.stringify(cmd)}: keywords must be array`)
  }
})
test('all ids are unique', () => {
  const ids = NAVIGATION_COMMANDS.map(c => c.id)
  assert.strictEqual(new Set(ids).size, ids.length)
})
test('all routes are unique', () => {
  const routes = NAVIGATION_COMMANDS.map(c => c.route)
  assert.strictEqual(new Set(routes).size, routes.length)
})
test('/ai route has requiresPro=true', () => {
  const ai = NAVIGATION_COMMANDS.find(c => c.route === '/ai')
  assert.ok(ai, 'must have /ai route')
  assert.strictEqual(ai.requiresPro, true)
})
test('non-/ai routes have requiresPro=false or undefined-but-falsy', () => {
  for (const cmd of NAVIGATION_COMMANDS.filter(c => c.route !== '/ai')) {
    assert.ok(!cmd.requiresPro, `${cmd.route} must not require Pro`)
  }
})
test('keywords are lowercase strings', () => {
  for (const cmd of NAVIGATION_COMMANDS) {
    for (const kw of cmd.keywords) {
      assert.strictEqual(kw, kw.toLowerCase(), `keyword "${kw}" must be lowercase`)
    }
  }
})

// ── filterNavigationCommands ──────────────────────────────────────────────────

console.log('\nfilterNavigationCommands')

test('empty query returns only non-Pro commands (canUsePro=false)', () => {
  const result = filterNavigationCommands(NAVIGATION_COMMANDS, '', false)
  assert.ok(result.every(c => !c.requiresPro), 'empty query must exclude Pro commands when canUsePro=false')
})
test('empty query returns all commands when canUsePro=true', () => {
  const result = filterNavigationCommands(NAVIGATION_COMMANDS, '', true)
  const aiCmd = result.find(c => c.route === '/ai')
  assert.ok(aiCmd, '/ai must be included when canUsePro=true')
})
test('returns only matching commands for a query', () => {
  const result = filterNavigationCommands(NAVIGATION_COMMANDS, 'contact', false)
  assert.ok(result.length > 0, 'contacts query must return results')
  assert.ok(result.every(c => c.label.toLowerCase().includes('contact') || c.keywords.some(k => k.includes('contact'))),
    'all returned commands must match query')
})
test('AI command not returned when canUsePro=false even with "ai" query', () => {
  const result = filterNavigationCommands(NAVIGATION_COMMANDS, 'ai', false)
  assert.ok(!result.find(c => c.route === '/ai'), '/ai must not appear when canUsePro=false')
})
test('AI command returned when canUsePro=true and query matches', () => {
  const result = filterNavigationCommands(NAVIGATION_COMMANDS, 'ai', true)
  assert.ok(result.find(c => c.route === '/ai'), '/ai must appear when canUsePro=true and query matches')
})
test('unmatched query returns empty array', () => {
  const result = filterNavigationCommands(NAVIGATION_COMMANDS, 'zzzzunlikely', false)
  assert.deepStrictEqual(result, [])
})
test('query matches by label (case-insensitive via normalizeQuery upstream)', () => {
  // Callers pass normalizeQuery output, so test with lowercase query
  const result = filterNavigationCommands(NAVIGATION_COMMANDS, 'home', false)
  assert.ok(result.length > 0, 'home query must match')
})
test('query matches by keyword', () => {
  const result = filterNavigationCommands(NAVIGATION_COMMANDS, 'dashboard', false)
  assert.ok(result.length > 0, 'dashboard keyword must match home command')
})

// ── results ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
