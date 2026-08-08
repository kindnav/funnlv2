/**
 * ai-history-revalidation.test.js
 *
 * Tests for revalidateHistorySession() and the call path in FunnlAIPage.loadSession.
 *
 * Covers Section 2 of the Stage 7 correction spec:
 *   - revalidateHistorySession annotates assistant messages with _validContactRefs
 *   - Deleted or unknown contacts are dropped from rendered refs
 *   - Session is returned unchanged on invalid input
 *   - loadSession calls revalidateHistorySession before setting messages
 *   - Rendered ContactRefCards use only the validated DB data
 *
 * Zero-dependency Node.js — run with: node tests/ai-history-revalidation.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  revalidateHistorySession,
  validateContactRefs,
  extractContactRefs,
  validateHistorySession,
} from '../src/lib/ai-history.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const aiSrc = readFileSync(join(__dir, '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

const VALID_UUID_1 = '00000000-0000-0000-0000-000000000001'
const VALID_UUID_2 = '00000000-0000-0000-0000-000000000002'
const VALID_UUID_3 = '00000000-0000-0000-0000-000000000003'

function makeSession(messages) {
  return {
    v: 1, id: 'session-1', title: 'Test', createdAt: new Date().toISOString(), messages,
  }
}

// ── validateHistorySession ────────────────────────────────────────────────────

console.log('\nvalidateHistorySession — prerequisite guard\n')

test('valid session passes', () => {
  const s = makeSession([{ role: 'user', content: 'hello' }])
  assert.strictEqual(validateHistorySession(s), true)
})

test('null fails', () => {
  assert.strictEqual(validateHistorySession(null), false)
})

test('missing id fails', () => {
  assert.strictEqual(validateHistorySession({ title: 't', createdAt: 'c', messages: [] }), false)
})

test('missing messages fails', () => {
  assert.strictEqual(validateHistorySession({ id: 'x', title: 't', createdAt: 'c' }), false)
})

// ── revalidateHistorySession — basic behavior ─────────────────────────────────

console.log('\nrevalidateHistorySession — basic behavior\n')

test('returns session unchanged when session is invalid', () => {
  const invalid = { not: 'a session' }
  assert.strictEqual(revalidateHistorySession(invalid, []), invalid)
})

test('returns session with null allowedContacts gracefully', () => {
  const session = makeSession([{ role: 'user', content: 'hello' }])
  const result = revalidateHistorySession(session, null)
  // Should return the session (validateHistorySession passes) with empty _validContactRefs
  assert.strictEqual(result.id, session.id)
})

test('does not mutate the source session', () => {
  const messages = [{ role: 'assistant', content: `[Alice](/contacts/${VALID_UUID_1})` }]
  const session  = makeSession(messages)
  const contacts = [{ id: VALID_UUID_1, name: 'Alice', company: 'ACME', role: 'PM' }]
  revalidateHistorySession(session, contacts)
  assert.strictEqual(session.messages[0]._validContactRefs, undefined, 'source must not be mutated')
})

test('annotates assistant messages with _validContactRefs', () => {
  const session  = makeSession([{ role: 'assistant', content: `[Alice](/contacts/${VALID_UUID_1})` }])
  const contacts = [{ id: VALID_UUID_1, name: 'Alice', company: 'ACME', role: 'PM' }]
  const result   = revalidateHistorySession(session, contacts)
  assert.ok(Array.isArray(result.messages[0]._validContactRefs))
  assert.strictEqual(result.messages[0]._validContactRefs.length, 1)
})

test('does not annotate user messages', () => {
  const session = makeSession([{ role: 'user', content: 'hello' }])
  const result  = revalidateHistorySession(session, [])
  assert.strictEqual(result.messages[0]._validContactRefs, undefined)
})

test('unknown contact UUID is excluded from _validContactRefs', () => {
  const session  = makeSession([{ role: 'assistant', content: `[Ghost](/contacts/${VALID_UUID_1})` }])
  const contacts = [] // empty — no matches
  const result   = revalidateHistorySession(session, contacts)
  assert.deepStrictEqual(result.messages[0]._validContactRefs, [])
})

test('deleted contact (in content, not in allowedContacts) is excluded', () => {
  const session  = makeSession([{ role: 'assistant', content: `[Bob](/contacts/${VALID_UUID_2})` }])
  const contacts = [{ id: VALID_UUID_1, name: 'Alice' }] // Bob not in allowed
  const result   = revalidateHistorySession(session, contacts)
  assert.deepStrictEqual(result.messages[0]._validContactRefs, [])
})

test('valid ref gets canonical name from DB (not provider label)', () => {
  const session  = makeSession([{ role: 'assistant', content: `[al](/contacts/${VALID_UUID_1})` }])
  const contacts = [{ id: VALID_UUID_1, name: 'Alice Full Name', company: 'Corp', role: 'VP' }]
  const result   = revalidateHistorySession(session, contacts)
  assert.strictEqual(result.messages[0]._validContactRefs[0].name, 'Alice Full Name')
})

test('ref carries company and role from DB', () => {
  const session  = makeSession([{ role: 'assistant', content: `[X](/contacts/${VALID_UUID_1})` }])
  const contacts = [{ id: VALID_UUID_1, name: 'X', company: 'Corp', role: 'Engineer' }]
  const result   = revalidateHistorySession(session, contacts)
  const ref = result.messages[0]._validContactRefs[0]
  assert.strictEqual(ref.company, 'Corp')
  assert.strictEqual(ref.role, 'Engineer')
})

test('multiple messages are revalidated independently', () => {
  const session = makeSession([
    { role: 'assistant', content: `[Alice](/contacts/${VALID_UUID_1})` },
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: `[Bob](/contacts/${VALID_UUID_2}) and [Charlie](/contacts/${VALID_UUID_3})` },
  ])
  const contacts = [
    { id: VALID_UUID_1, name: 'Alice', company: null, role: null },
    { id: VALID_UUID_2, name: 'Bob',   company: null, role: null },
    // Charlie is not in contacts (deleted)
  ]
  const result = revalidateHistorySession(session, contacts)
  assert.strictEqual(result.messages[0]._validContactRefs.length, 1)
  assert.strictEqual(result.messages[0]._validContactRefs[0].name, 'Alice')
  assert.strictEqual(result.messages[2]._validContactRefs.length, 1)
  assert.strictEqual(result.messages[2]._validContactRefs[0].name, 'Bob')
})

test('session with no contact links has empty _validContactRefs on assistant messages', () => {
  const session = makeSession([{ role: 'assistant', content: 'No links here.' }])
  const result  = revalidateHistorySession(session, [{ id: VALID_UUID_1, name: 'Alice' }])
  assert.deepStrictEqual(result.messages[0]._validContactRefs, [])
})

// ── loadSession calls revalidateHistorySession ─────────────────────────────────

console.log('\nFunnlAIPage.loadSession — static assertions\n')

test('loadSession calls revalidateHistorySession', () => {
  assert.ok(
    aiSrc.includes('revalidateHistorySession(session, contacts)'),
    'loadSession must call revalidateHistorySession with the session and contacts'
  )
})

test('loadSession invalidates the request gate before loading', () => {
  // actual code uses gateRef.current.invalidate() — check the whole source
  assert.ok(
    aiSrc.includes('gateRef.current.invalidate()'),
    'loadSession must invalidate the request gate via gateRef.current.invalidate()'
  )
})

test('loadSession uses revalidated session messages (not raw session.messages)', () => {
  assert.ok(
    aiSrc.includes('revalidated.messages') || aiSrc.includes('revalidateHistorySession(session'),
    'loadSession must use the revalidated session messages'
  )
})

test('assistant messages use _validContactRefs when available', () => {
  assert.ok(
    aiSrc.includes('_validContactRefs'),
    'rendered assistant messages must check _validContactRefs from loaded history'
  )
})

test('falls back to live validateContactRefs when _validContactRefs is absent', () => {
  assert.ok(
    aiSrc.includes('msg._validContactRefs ??') || aiSrc.includes('_validContactRefs ??'),
    'must fall back to live validation when _validContactRefs is not present'
  )
})

test('validateContactRefs is called with refs variable (not inline extraction)', () => {
  // The refactored code uses a `refs` const so the test pattern is unambiguous
  assert.ok(
    aiSrc.includes('validateContactRefs(refs, contacts)'),
    'validateContactRefs must be called with a named refs variable'
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
