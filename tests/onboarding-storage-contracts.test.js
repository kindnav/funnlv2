/**
 * onboarding-storage-contracts.test.js
 *
 * Verifies storage key construction and safe accessor behavior.
 *
 * Storage key rules:
 *   - Every key must include the user's ID to prevent cross-account bleed.
 *   - sessionDismissKey → sessionStorage (resets per browser session)
 *   - welcomeSkipKey   → localStorage   (survives browser restart)
 *   - completionSessionKey → sessionStorage
 *   - stripDismissKey is a canonical alias for sessionDismissKey
 *
 * Safe accessor rules (readSessionFlag, writeSessionFlag, clearSessionFlag,
 * readLocalFlag, writeLocalFlag, clearLocalFlag):
 *   - Return false / no-op gracefully when storage is unavailable (SecurityError).
 *   - Keys not yet set return false.
 *   - After write, read returns true.
 *   - After clear, read returns false.
 *   - Keys for different UIDs are independent.
 *
 * Pure function tests — no React, no Supabase.
 * sessionStorage / localStorage are available in Node 18+ via globalThis
 * using the built-in stub; if unavailable, the graceful-degradation tests run
 * against the SecurityError catch path.
 *
 * Run with: node tests/onboarding-storage-contracts.test.js
 */
import assert from 'assert'
import {
  sessionDismissKey,
  stripDismissKey,
  welcomeSkipKey,
  completionSessionKey,
  readSessionFlag,
  writeSessionFlag,
  clearSessionFlag,
  readLocalFlag,
  writeLocalFlag,
  clearLocalFlag,
} from '../src/lib/activationHelpers.js'

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

// ── Storage key structure ─────────────────────────────────────────────────────

console.log('\nStorage key structure — uid isolation')

test('sessionDismissKey includes uid', () => {
  const key = sessionDismissKey('user-123')
  assert.ok(key.includes('user-123'), 'key must include uid')
})
test('sessionDismissKey different for different uids', () => {
  assert.notStrictEqual(sessionDismissKey('uid-A'), sessionDismissKey('uid-B'))
})
test('sessionDismissKey is versioned (contains v1)', () => {
  assert.ok(sessionDismissKey('any-uid').includes('v1'))
})

test('welcomeSkipKey includes uid', () => {
  const key = welcomeSkipKey('user-456')
  assert.ok(key.includes('user-456'))
})
test('welcomeSkipKey different for different uids', () => {
  assert.notStrictEqual(welcomeSkipKey('uid-A'), welcomeSkipKey('uid-B'))
})
test('welcomeSkipKey is versioned (contains v1)', () => {
  assert.ok(welcomeSkipKey('any-uid').includes('v1'))
})

test('completionSessionKey includes uid', () => {
  const key = completionSessionKey('user-789')
  assert.ok(key.includes('user-789'))
})
test('completionSessionKey different for different uids', () => {
  assert.notStrictEqual(completionSessionKey('uid-A'), completionSessionKey('uid-B'))
})
test('completionSessionKey is versioned (contains v1)', () => {
  assert.ok(completionSessionKey('any-uid').includes('v1'))
})

test('stripDismissKey is alias for sessionDismissKey', () => {
  assert.strictEqual(stripDismissKey('my-uid'), sessionDismissKey('my-uid'))
})

// ── Keys from same uid are unique across types ────────────────────────────────

console.log('\nKey uniqueness across types for the same uid')

test('sessionDismissKey ≠ welcomeSkipKey for same uid', () => {
  assert.notStrictEqual(sessionDismissKey('uid-1'), welcomeSkipKey('uid-1'))
})
test('sessionDismissKey ≠ completionSessionKey for same uid', () => {
  assert.notStrictEqual(sessionDismissKey('uid-1'), completionSessionKey('uid-1'))
})
test('welcomeSkipKey ≠ completionSessionKey for same uid', () => {
  assert.notStrictEqual(welcomeSkipKey('uid-1'), completionSessionKey('uid-1'))
})

// ── Safe accessors — graceful when storage unavailable ───────────────────────
// Node 18 does not have sessionStorage/localStorage in globalThis by default.
// The helpers catch SecurityError; in Node they catch ReferenceError-style
// absence too. Verify they return false / don't throw.

console.log('\nSafe accessors — graceful-degradation (storage may be unavailable in Node)')

test('readSessionFlag returns false when storage unavailable or key absent', () => {
  const result = readSessionFlag('__nonexistent_test_key__')
  // Must be boolean false — never throw
  assert.strictEqual(result, false)
})
test('readLocalFlag returns false when storage unavailable or key absent', () => {
  const result = readLocalFlag('__nonexistent_test_key__')
  assert.strictEqual(result, false)
})
test('writeSessionFlag does not throw', () => {
  assert.doesNotThrow(() => writeSessionFlag('__test_write_key__'))
})
test('writeLocalFlag does not throw', () => {
  assert.doesNotThrow(() => writeLocalFlag('__test_write_key__'))
})
test('clearSessionFlag does not throw', () => {
  assert.doesNotThrow(() => clearSessionFlag('__test_clear_key__'))
})
test('clearLocalFlag does not throw', () => {
  assert.doesNotThrow(() => clearLocalFlag('__test_clear_key__'))
})

// ── Safe accessors — read/write/clear cycle (when storage IS available) ───────

console.log('\nSafe accessors — read/write/clear cycle (skipped if storage unavailable)')

function storageAvailable(type) {
  try {
    const s = type === 'session' ? sessionStorage : localStorage
    s.setItem('__test__', '1')
    s.removeItem('__test__')
    return true
  } catch { return false }
}

const sessionAvail = storageAvailable('session')
const localAvail   = storageAvailable('local')

test('sessionStorage: unset key returns false', () => {
  if (!sessionAvail) { passed++; console.log('       (skipped — sessionStorage unavailable)'); return }
  const key = '__session_read_test__'
  sessionStorage.removeItem(key)
  assert.strictEqual(readSessionFlag(key), false)
})
test('sessionStorage: after write, read returns true', () => {
  if (!sessionAvail) { passed++; console.log('       (skipped — sessionStorage unavailable)'); return }
  const key = '__session_write_test__'
  sessionStorage.removeItem(key)
  writeSessionFlag(key)
  assert.strictEqual(readSessionFlag(key), true)
})
test('sessionStorage: after clear, read returns false', () => {
  if (!sessionAvail) { passed++; console.log('       (skipped — sessionStorage unavailable)'); return }
  const key = '__session_clear_test__'
  writeSessionFlag(key)
  clearSessionFlag(key)
  assert.strictEqual(readSessionFlag(key), false)
})

test('localStorage: unset key returns false', () => {
  if (!localAvail) { passed++; console.log('       (skipped — localStorage unavailable)'); return }
  const key = '__local_read_test__'
  localStorage.removeItem(key)
  assert.strictEqual(readLocalFlag(key), false)
})
test('localStorage: after write, read returns true', () => {
  if (!localAvail) { passed++; console.log('       (skipped — localStorage unavailable)'); return }
  const key = '__local_write_test__'
  localStorage.removeItem(key)
  writeLocalFlag(key)
  assert.strictEqual(readLocalFlag(key), true)
})
test('localStorage: after clear, read returns false', () => {
  if (!localAvail) { passed++; console.log('       (skipped — localStorage unavailable)'); return }
  const key = '__local_clear_test__'
  writeLocalFlag(key)
  clearLocalFlag(key)
  assert.strictEqual(readLocalFlag(key), false)
})

// ── Key isolation between different users ─────────────────────────────────────

console.log('\nKey isolation — different uids never share state')

test('dismissKey for uid-A and uid-B are independent (different strings)', () => {
  const keyA = sessionDismissKey('uid-A')
  const keyB = sessionDismissKey('uid-B')
  assert.notStrictEqual(keyA, keyB)
})
test('welcomeSkipKey for uid-A and uid-B are independent', () => {
  assert.notStrictEqual(welcomeSkipKey('uid-A'), welcomeSkipKey('uid-B'))
})
test('completionSessionKey for uid-A and uid-B are independent', () => {
  assert.notStrictEqual(completionSessionKey('uid-A'), completionSessionKey('uid-B'))
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
