/**
 * ai-history-runtime.test.js
 *
 * Tests for pure history-management helpers in src/lib/ai-history.js:
 * HISTORY_VERSION, validateHistorySession, parseStoredHistory, isArchivable,
 * isDuplicateSession, capHistory, revalidateHistorySession.
 *
 * Zero-dependency Node.js — run with: node tests/ai-history-runtime.test.js
 */
import assert from 'assert'
import {
  HISTORY_VERSION,
  MAX_HISTORY_SESSIONS,
  validateHistorySession,
  parseStoredHistory,
  isArchivable,
  isDuplicateSession,
  capHistory,
  revalidateHistorySession,
  validateContactRefs,
  extractContactRefs,
  INITIAL_MESSAGE,
} from '../src/lib/ai-history.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

const VALID_SESSION = {
  v: HISTORY_VERSION,
  id: 'sess-001',
  title: 'Test conversation',
  createdAt: '2026-07-30T10:00:00Z',
  messages: [{ role: 'user', content: 'Hello' }],
}

// ── HISTORY_VERSION ────────────────────────────────────────────────────────────

console.log('\nHISTORY_VERSION\n')

test('HISTORY_VERSION is 1', () => {
  assert.strictEqual(HISTORY_VERSION, 1)
})

// ── validateHistorySession ─────────────────────────────────────────────────────

console.log('\nvalidateHistorySession\n')

test('returns true for valid session', () => {
  assert.strictEqual(validateHistorySession(VALID_SESSION), true)
})

test('returns true for session without v field (backward compat)', () => {
  const { v, ...noV } = VALID_SESSION
  assert.strictEqual(validateHistorySession(noV), true)
})

test('returns false for null', () => {
  assert.strictEqual(validateHistorySession(null), false)
})

test('returns false for non-object', () => {
  assert.strictEqual(validateHistorySession('string'), false)
  assert.strictEqual(validateHistorySession(42), false)
})

test('returns false for array', () => {
  assert.strictEqual(validateHistorySession([VALID_SESSION]), false)
})

test('returns false when id is missing', () => {
  const { id, ...noId } = VALID_SESSION
  assert.strictEqual(validateHistorySession(noId), false)
})

test('returns false when id is empty string', () => {
  assert.strictEqual(validateHistorySession({ ...VALID_SESSION, id: '' }), false)
  assert.strictEqual(validateHistorySession({ ...VALID_SESSION, id: '   ' }), false)
})

test('returns false when title is missing', () => {
  const { title, ...noTitle } = VALID_SESSION
  assert.strictEqual(validateHistorySession(noTitle), false)
})

test('returns false when createdAt is missing', () => {
  const { createdAt, ...noDate } = VALID_SESSION
  assert.strictEqual(validateHistorySession(noDate), false)
})

test('returns false when messages is not an array', () => {
  assert.strictEqual(validateHistorySession({ ...VALID_SESSION, messages: null }), false)
  assert.strictEqual(validateHistorySession({ ...VALID_SESSION, messages: {} }), false)
})

test('returns true when messages is empty array', () => {
  assert.strictEqual(validateHistorySession({ ...VALID_SESSION, messages: [] }), true)
})

// ── parseStoredHistory ─────────────────────────────────────────────────────────

console.log('\nparseStoredHistory\n')

test('returns [] for null', () => {
  assert.deepStrictEqual(parseStoredHistory(null), [])
})

test('returns [] for empty string', () => {
  assert.deepStrictEqual(parseStoredHistory(''), [])
})

test('returns [] for whitespace-only string', () => {
  assert.deepStrictEqual(parseStoredHistory('   '), [])
})

test('returns [] for invalid JSON', () => {
  assert.deepStrictEqual(parseStoredHistory('{not valid json'), [])
})

test('returns [] for non-array JSON', () => {
  assert.deepStrictEqual(parseStoredHistory('{"id":"x"}'), [])
  assert.deepStrictEqual(parseStoredHistory('"string"'), [])
  assert.deepStrictEqual(parseStoredHistory('42'), [])
})

test('returns valid sessions from JSON', () => {
  const raw = JSON.stringify([VALID_SESSION])
  assert.strictEqual(parseStoredHistory(raw).length, 1)
  assert.strictEqual(parseStoredHistory(raw)[0].id, 'sess-001')
})

test('filters out invalid sessions', () => {
  const invalid = { id: '', title: 'Bad', createdAt: '2026-01-01', messages: [] }
  const raw = JSON.stringify([VALID_SESSION, invalid])
  const result = parseStoredHistory(raw)
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, 'sess-001')
})

test('filters out non-objects in array', () => {
  const raw = JSON.stringify([VALID_SESSION, null, 42, 'string'])
  assert.strictEqual(parseStoredHistory(raw).length, 1)
})

test('returns [] when all sessions are invalid', () => {
  const raw = JSON.stringify([{ bad: 'structure' }, null])
  assert.deepStrictEqual(parseStoredHistory(raw), [])
})

// ── isArchivable ───────────────────────────────────────────────────────────────

console.log('\nisArchivable\n')

test('returns false for non-array', () => {
  assert.strictEqual(isArchivable(null), false)
  assert.strictEqual(isArchivable(undefined), false)
  assert.strictEqual(isArchivable({}), false)
})

test('returns false for empty array', () => {
  assert.strictEqual(isArchivable([]), false)
})

test('returns false for only INITIAL_MESSAGE (localOnly)', () => {
  assert.strictEqual(isArchivable([INITIAL_MESSAGE]), false)
})

test('returns false for only assistant messages', () => {
  assert.strictEqual(isArchivable([{ role: 'assistant', content: 'Hello' }]), false)
})

test('returns false for user message with error', () => {
  assert.strictEqual(isArchivable([{ role: 'user', content: 'Hi', error: { code: 'internal_error' } }]), false)
})

test('returns false for user message with localOnly', () => {
  assert.strictEqual(isArchivable([{ role: 'user', content: 'Hi', localOnly: true }]), false)
})

test('returns true for one real user message', () => {
  assert.strictEqual(isArchivable([{ role: 'user', content: 'Real message' }]), true)
})

test('returns true when mixed with non-archivable messages', () => {
  assert.strictEqual(isArchivable([
    INITIAL_MESSAGE,
    { role: 'user', content: 'Real question' },
    { role: 'assistant', content: 'Answer' },
  ]), true)
})

// ── isDuplicateSession ─────────────────────────────────────────────────────────

console.log('\nisDuplicateSession\n')

test('returns false for empty sessions', () => {
  assert.strictEqual(isDuplicateSession([], 'sess-001'), false)
})

test('returns false for null sessions', () => {
  assert.strictEqual(isDuplicateSession(null, 'sess-001'), false)
})

test('returns false for non-string sessionId', () => {
  assert.strictEqual(isDuplicateSession([VALID_SESSION], null), false)
  assert.strictEqual(isDuplicateSession([VALID_SESSION], 42), false)
})

test('returns false when ID not in list', () => {
  assert.strictEqual(isDuplicateSession([VALID_SESSION], 'sess-999'), false)
})

test('returns true when ID is in list', () => {
  assert.strictEqual(isDuplicateSession([VALID_SESSION], 'sess-001'), true)
})

test('handles null entries in sessions array', () => {
  assert.strictEqual(isDuplicateSession([null, VALID_SESSION], 'sess-001'), true)
})

// ── capHistory ─────────────────────────────────────────────────────────────────

console.log('\ncapHistory\n')

test('returns [] for non-array', () => {
  assert.deepStrictEqual(capHistory(null), [])
  assert.deepStrictEqual(capHistory(undefined), [])
})

test('returns all sessions when under the limit', () => {
  const sessions = [VALID_SESSION, { ...VALID_SESSION, id: 'sess-002' }]
  assert.strictEqual(capHistory(sessions).length, 2)
})

test('defaults cap to MAX_HISTORY_SESSIONS', () => {
  const sessions = Array.from({ length: 15 }, (_, i) => ({ ...VALID_SESSION, id: 'sess-' + i }))
  assert.strictEqual(capHistory(sessions).length, MAX_HISTORY_SESSIONS)
})

test('respects custom max', () => {
  const sessions = Array.from({ length: 5 }, (_, i) => ({ ...VALID_SESSION, id: 'sess-' + i }))
  assert.strictEqual(capHistory(sessions, 3).length, 3)
})

test('preserves order (newest first)', () => {
  const sessions = [
    { ...VALID_SESSION, id: 'sess-new' },
    { ...VALID_SESSION, id: 'sess-old' },
  ]
  const capped = capHistory(sessions, 1)
  assert.strictEqual(capped[0].id, 'sess-new')
})

test('ignores invalid max and falls back to MAX_HISTORY_SESSIONS', () => {
  const sessions = Array.from({ length: 15 }, (_, i) => ({ ...VALID_SESSION, id: 'sess-' + i }))
  assert.strictEqual(capHistory(sessions, 0).length, MAX_HISTORY_SESSIONS)
  assert.strictEqual(capHistory(sessions, -1).length, MAX_HISTORY_SESSIONS)
})

// ── revalidateHistorySession ───────────────────────────────────────────────────

console.log('\nrevalidateHistorySession\n')

const ALLOWED_CONTACTS = [
  { id: '00000000-0000-0000-0000-000000000001', name: 'Alice Smith', company: 'Goldman', role: 'Analyst' },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Bob Jones',   company: 'Bain',    role: 'Consultant' },
]

test('returns session unchanged for invalid session', () => {
  const bad = { id: '' }
  assert.strictEqual(revalidateHistorySession(bad, ALLOWED_CONTACTS), bad)
})

test('returns session unchanged when no assistant messages', () => {
  const session = { ...VALID_SESSION, messages: [{ role: 'user', content: 'Hello' }] }
  const result = revalidateHistorySession(session, ALLOWED_CONTACTS)
  assert.ok(!result.messages[0]._validContactRefs, 'user messages should not have _validContactRefs')
})

test('adds _validContactRefs to assistant messages', () => {
  const md = '[Alice Smith](/contacts/00000000-0000-0000-0000-000000000001)'
  const session = {
    ...VALID_SESSION,
    messages: [{ role: 'assistant', content: md }],
  }
  const result = revalidateHistorySession(session, ALLOWED_CONTACTS)
  assert.ok(Array.isArray(result.messages[0]._validContactRefs))
  assert.strictEqual(result.messages[0]._validContactRefs.length, 1)
  assert.strictEqual(result.messages[0]._validContactRefs[0].name, 'Alice Smith')
})

test('excludes refs for deleted/unknown contacts', () => {
  const md = '[Unknown](/contacts/99999999-0000-0000-0000-000000000099)'
  const session = {
    ...VALID_SESSION,
    messages: [{ role: 'assistant', content: md }],
  }
  const result = revalidateHistorySession(session, ALLOWED_CONTACTS)
  assert.strictEqual(result.messages[0]._validContactRefs.length, 0)
})

test('does not mutate source session', () => {
  const session = {
    ...VALID_SESSION,
    messages: [{ role: 'assistant', content: '[Alice](/contacts/00000000-0000-0000-0000-000000000001)' }],
  }
  const original = JSON.stringify(session)
  revalidateHistorySession(session, ALLOWED_CONTACTS)
  assert.strictEqual(JSON.stringify(session), original)
})

test('handles empty allowedContacts (all refs drop)', () => {
  const md = '[Alice Smith](/contacts/00000000-0000-0000-0000-000000000001)'
  const session = { ...VALID_SESSION, messages: [{ role: 'assistant', content: md }] }
  const result = revalidateHistorySession(session, [])
  assert.strictEqual(result.messages[0]._validContactRefs.length, 0)
})

test('handles assistant message without content', () => {
  const session = { ...VALID_SESSION, messages: [{ role: 'assistant', content: null }] }
  const result = revalidateHistorySession(session, ALLOWED_CONTACTS)
  assert.ok(!result.messages[0]._validContactRefs)
})

test('mixed valid/invalid refs in one message', () => {
  const md = [
    '[Alice Smith](/contacts/00000000-0000-0000-0000-000000000001)',
    '[Ghost](/contacts/99999999-0000-0000-0000-000000000099)',
  ].join(' and ')
  const session = { ...VALID_SESSION, messages: [{ role: 'assistant', content: md }] }
  const result = revalidateHistorySession(session, ALLOWED_CONTACTS)
  assert.strictEqual(result.messages[0]._validContactRefs.length, 1)
  assert.strictEqual(result.messages[0]._validContactRefs[0].name, 'Alice Smith')
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
