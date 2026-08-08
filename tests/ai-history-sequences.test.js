/**
 * ai-history-sequences.test.js
 *
 * Tests for history archive/load state sequences per Section 13:
 *   - Empty chat → New chat = no archive
 *   - Chat with messages → New chat = archived once
 *   - New chat twice = no duplicate entry
 *   - Load session A while in session B = B archived, A loaded
 *   - Loading the currently active session = no self-archive
 *   - History capped at MAX_HISTORY_SESSIONS (10)
 *   - Corrupted stored entry ignored
 *   - Loading session does not auto-submit an AI request
 *
 * Pure function tests for isArchivable, isDuplicateSession, capHistory, parseStoredHistory.
 * Static analysis of FunnlAIPage for structural guarantees.
 *
 * Zero-dependency Node.js — run with: node tests/ai-history-sequences.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  isArchivable, isDuplicateSession, capHistory, parseStoredHistory,
  MAX_HISTORY_SESSIONS, validateHistorySession, HISTORY_VERSION,
} from '../src/lib/ai-history.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dir, '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

function makeSession(id, title = 'Test') {
  return { v: HISTORY_VERSION, id, title, createdAt: new Date().toISOString(), messages: [{ role: 'user', content: 'hi' }] }
}

// ── isArchivable ──────────────────────────────────────────────────────────────

console.log('\nisArchivable — archive eligibility\n')

test('INITIAL_MESSAGE-only conversation is not archivable', () => {
  const msgs = [{ role: 'assistant', content: 'Welcome', localOnly: true }]
  assert.strictEqual(isArchivable(msgs), false)
})

test('empty array is not archivable', () => {
  assert.strictEqual(isArchivable([]), false)
})

test('null is not archivable', () => {
  assert.strictEqual(isArchivable(null), false)
})

test('conversation with one real user message is archivable', () => {
  const msgs = [
    { role: 'assistant', content: 'Welcome', localOnly: true },
    { role: 'user', content: 'Hello' },
  ]
  assert.strictEqual(isArchivable(msgs), true)
})

test('user message with error flag is not archivable (error never sent)', () => {
  const msgs = [
    { role: 'assistant', content: 'Welcome', localOnly: true },
    { role: 'user', content: 'failed msg', error: { code: 'provider_timeout' } },
  ]
  assert.strictEqual(isArchivable(msgs), false)
})

test('conversation with assistant reply is archivable (has prior user msg)', () => {
  const msgs = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello back' },
  ]
  assert.strictEqual(isArchivable(msgs), true)
})

// ── isDuplicateSession ────────────────────────────────────────────────────────

console.log('\nisDuplicateSession — deduplication\n')

test('returns false for empty sessions array', () => {
  assert.strictEqual(isDuplicateSession([], 'session-1'), false)
})

test('returns false when sessionId not in list', () => {
  const sessions = [makeSession('a'), makeSession('b')]
  assert.strictEqual(isDuplicateSession(sessions, 'c'), false)
})

test('returns true when sessionId is in list', () => {
  const sessions = [makeSession('a'), makeSession('b')]
  assert.strictEqual(isDuplicateSession(sessions, 'a'), true)
})

test('returns false for null sessions array', () => {
  assert.strictEqual(isDuplicateSession(null, 'x'), false)
})

test('returns false for non-string sessionId', () => {
  assert.strictEqual(isDuplicateSession([makeSession('a')], 42), false)
})

// ── capHistory ────────────────────────────────────────────────────────────────

console.log('\ncapHistory — MAX_HISTORY_SESSIONS cap\n')

test('MAX_HISTORY_SESSIONS is 10', () => {
  assert.strictEqual(MAX_HISTORY_SESSIONS, 10)
})

test('caps array to MAX_HISTORY_SESSIONS', () => {
  const sessions = Array.from({ length: 15 }, (_, i) => makeSession('s' + i))
  const result = capHistory(sessions)
  assert.strictEqual(result.length, 10)
})

test('keeps the first (newest) entries when capping', () => {
  const sessions = Array.from({ length: 12 }, (_, i) => makeSession('s' + i))
  const result = capHistory(sessions)
  assert.strictEqual(result[0].id, 's0')
  assert.strictEqual(result[9].id, 's9')
})

test('does not cap when below limit', () => {
  const sessions = [makeSession('a'), makeSession('b')]
  assert.strictEqual(capHistory(sessions).length, 2)
})

test('returns [] for null input', () => {
  assert.deepStrictEqual(capHistory(null), [])
})

test('respects custom max parameter', () => {
  const sessions = Array.from({ length: 8 }, (_, i) => makeSession('s' + i))
  assert.strictEqual(capHistory(sessions, 5).length, 5)
})

// ── parseStoredHistory ────────────────────────────────────────────────────────

console.log('\nparseStoredHistory — corrupted entry handling\n')

test('null raw returns []', () => {
  assert.deepStrictEqual(parseStoredHistory(null), [])
})

test('malformed JSON returns []', () => {
  assert.deepStrictEqual(parseStoredHistory('{bad json'), [])
})

test('JSON array of one corrupted session is filtered out', () => {
  const corrupted = JSON.stringify([{ not: 'a valid session' }])
  assert.deepStrictEqual(parseStoredHistory(corrupted), [])
})

test('mixed valid/corrupted: only valid sessions survive', () => {
  const data = [
    makeSession('valid'),
    { not: 'valid' },
    null,
  ]
  const result = parseStoredHistory(JSON.stringify(data))
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].id, 'valid')
})

test('session missing messages array is filtered out', () => {
  const bad = [{ id: 'x', title: 't', createdAt: 'c' }] // no messages
  assert.deepStrictEqual(parseStoredHistory(JSON.stringify(bad)), [])
})

test('valid sessions preserve their id and title', () => {
  const data = [makeSession('abc', 'My Session')]
  const result = parseStoredHistory(JSON.stringify(data))
  assert.strictEqual(result[0].id, 'abc')
  assert.strictEqual(result[0].title, 'My Session')
})

// ── archiveCurrentSession static assertions ────────────────────────────────────

console.log('\nFunnlAIPage.archiveCurrentSession — static assertions\n')

test('archiveCurrentSession checks isArchivable before archiving', () => {
  assert.ok(
    src.includes('isArchivable(currentMessages'),
    'archiveCurrentSession must call isArchivable before creating an archive entry'
  )
})

test('archiveCurrentSession uses currentSessionIdRef for stable ID', () => {
  assert.ok(
    src.includes('currentSessionIdRef.current'),
    'archiveCurrentSession must use a stable session ID ref to prevent duplicate entries'
  )
})

test('archived sessions are filtered by id to prevent duplicates before prepending', () => {
  // upsert semantics: dedup by id before prepending
  assert.ok(
    src.includes(".filter(s => s.id !== sessionId)") ||
    src.includes("s.id !== session"),
    'archiveCurrentSession must deduplicate by session ID'
  )
})

test('archived sessions are capped at MAX_HISTORY_SESSIONS', () => {
  assert.ok(
    src.includes(`.slice(0, MAX_HISTORY_SESSIONS)`) ||
    src.includes(`slice(0, MAX_HISTORY_SESSIONS)`),
    'archived history must be capped at MAX_HISTORY_SESSIONS'
  )
})

// ── loadSession — no auto-submit ──────────────────────────────────────────────

console.log('\nloadSession — no auto-submit\n')

test('loadSession does not call sendMessage or supabase.functions.invoke', () => {
  const loadBlock = src.match(/function loadSession[\s\S]*?^  \}/m)?.[0] ?? ''
  assert.ok(
    !loadBlock.includes('sendMessage(') && !loadBlock.includes('supabase.functions.invoke'),
    'loadSession must not trigger an AI request — only restore state'
  )
})

test('loadSession sets messages from the loaded session (no network call)', () => {
  assert.ok(
    src.includes('setMessages([INITIAL_MESSAGE, ...hydrated])') ||
    src.includes('setMessages([INITIAL_MESSAGE,'),
    'loadSession must restore messages directly from the stored session'
  )
})

test('loading a session does not clear the history rail', () => {
  const loadBlock = src.match(/function loadSession[\s\S]*?^  \}/m)?.[0] ?? ''
  assert.ok(
    !loadBlock.includes('setHistory([])'),
    'loadSession must not clear the history array'
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
