// Tests for the versioned HMAC-SHA256 email fingerprint. Synthetic key + fields only.
// Run: node tests/email-fingerprint.test.js

import assert from 'assert'
import {
  FINGERPRINT_VERSION, FINGERPRINT_HEX_LEN, lengthPrefixedField, fingerprintInput, computeEmailFingerprint,
  computeFingerprintSet, MAX_KEYRING_KEYS,
} from '../supabase/functions/shared/emailFingerprint.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

// Synthetic, non-secret injected keys (NOT real secrets).
const KEY_A = new Uint8Array(32).fill(7)
const KEY_B = new Uint8Array(32).fill(9)
const base = { provider: 'gmail', accountNamespace: 'conn1', contactId: 'c1', conversationKey: 't1', firstMessageKey: 'm1' }

console.log('\ncanonical input')
await test('length-prefixed field encodes utf8 byte length', () => {
  assert.strictEqual(lengthPrefixedField('abc'), '3:abc')
  assert.strictEqual(lengthPrefixedField(''), '0:')
  assert.throws(() => lengthPrefixedField(5), /invalid_fingerprint_field_type/)
})
await test('fingerprintInput commits version + keyVersion + all fields; rejects missing', () => {
  const s = fingerprintInput(base, 1)
  assert.ok(s.includes(`:${FINGERPRINT_VERSION}`))
  assert.throws(() => fingerprintInput({ ...base, contactId: '' }, 1), /invalid_fingerprint_field:contactId/)
  assert.throws(() => fingerprintInput(base, 0), /invalid_key_version/)
})

console.log('\nformat + determinism')
await test('output is exactly 64 lowercase hex', async () => {
  const fp = await computeEmailFingerprint(base, { keyBytes: KEY_A, keyVersion: 1 })
  assert.strictEqual(fp.length, FINGERPRINT_HEX_LEN)
  assert.ok(/^[0-9a-f]{64}$/.test(fp))
})
await test('deterministic for identical inputs+key', async () => {
  const a = await computeEmailFingerprint(base, { keyBytes: KEY_A, keyVersion: 1 })
  const b = await computeEmailFingerprint({ ...base }, { keyBytes: KEY_A, keyVersion: 1 })
  assert.strictEqual(a, b)
})

console.log('\nisolation: each field independently changes the fingerprint')
await test('contact / account / provider / conversation / firstMessageKey isolation', async () => {
  const ref = await computeEmailFingerprint(base, { keyBytes: KEY_A, keyVersion: 1 })
  for (const [k, v] of Object.entries({ provider: 'outlook', accountNamespace: 'conn2', contactId: 'c2', conversationKey: 't2', firstMessageKey: 'm2' })) {
    const fp = await computeEmailFingerprint({ ...base, [k]: v }, { keyBytes: KEY_A, keyVersion: 1 })
    assert.notStrictEqual(fp, ref, `changing ${k} must change the fingerprint`)
  }
})

console.log('\nkey / version rotation')
await test('changed key -> different fingerprint (rotation does not preserve value)', async () => {
  const a = await computeEmailFingerprint(base, { keyBytes: KEY_A, keyVersion: 1 })
  const b = await computeEmailFingerprint(base, { keyBytes: KEY_B, keyVersion: 1 })
  assert.notStrictEqual(a, b)
})
await test('changed keyVersion -> different fingerprint (bound into MAC)', async () => {
  const a = await computeEmailFingerprint(base, { keyBytes: KEY_A, keyVersion: 1 })
  const b = await computeEmailFingerprint(base, { keyBytes: KEY_A, keyVersion: 2 })
  assert.notStrictEqual(a, b)
})

console.log('\nfield-boundary collision resistance')
await test('moving characters across a field boundary changes the fingerprint', async () => {
  // ('ab','c') vs ('a','bc') would collide under naive concatenation; length-prefix prevents it.
  const x = await computeEmailFingerprint({ ...base, conversationKey: 'ab', firstMessageKey: 'c' }, { keyBytes: KEY_A, keyVersion: 1 })
  const y = await computeEmailFingerprint({ ...base, conversationKey: 'a', firstMessageKey: 'bc' }, { keyBytes: KEY_A, keyVersion: 1 })
  assert.notStrictEqual(x, y)
})

console.log('\nvalidation / fail-closed')
await test('bad key bytes / subtle rejected', async () => {
  await assert.rejects(() => computeEmailFingerprint(base, { keyBytes: new Uint8Array(0), keyVersion: 1 }), /invalid_hmac_key/)
  await assert.rejects(() => computeEmailFingerprint(base, { keyBytes: 'nope', keyVersion: 1 }), /invalid_hmac_key/)
})

console.log('\nkey-ring dedup (rotation without duplicate candidates)')
await test('write = current-key fingerprint; lookups cover current + accepted prior keys', async () => {
  const set = await computeFingerprintSet(base, {
    current: { keyBytes: KEY_B, keyVersion: 2 },
    accepted: [{ keyBytes: KEY_A, keyVersion: 1 }],
  })
  const cur = await computeEmailFingerprint(base, { keyBytes: KEY_B, keyVersion: 2 })
  const prior = await computeEmailFingerprint(base, { keyBytes: KEY_A, keyVersion: 1 })
  assert.strictEqual(set.writeFingerprint, cur)
  assert.strictEqual(set.writeKeyVersion, 2)
  assert.strictEqual(set.lookupFingerprints.length, 2)
  assert.deepStrictEqual(set.lookupFingerprints, [
    { keyVersion: 2, fingerprint: cur },
    { keyVersion: 1, fingerprint: prior },
  ])
  // The pre-rotation fingerprint is discoverable via the lookup set, so no duplicate is inserted.
  assert.ok(set.lookupFingerprints.some((l) => l.fingerprint === prior))
})
await test('single current key -> one lookup equal to the write fingerprint', async () => {
  const set = await computeFingerprintSet(base, { current: { keyBytes: KEY_A, keyVersion: 1 } })
  assert.strictEqual(set.lookupFingerprints.length, 1)
  assert.strictEqual(set.lookupFingerprints[0].fingerprint, set.writeFingerprint)
})
await test('duplicate key version across the ring is rejected', async () => {
  await assert.rejects(() => computeFingerprintSet(base, {
    current: { keyBytes: KEY_B, keyVersion: 1 },
    accepted: [{ keyBytes: KEY_A, keyVersion: 1 }],
  }), /duplicate_key_version/)
})
await test('unbounded key ring is rejected', async () => {
  const accepted = Array.from({ length: MAX_KEYRING_KEYS }, (_, i) => ({ keyBytes: KEY_A, keyVersion: i + 2 }))
  await assert.rejects(() => computeFingerprintSet(base, { current: { keyBytes: KEY_B, keyVersion: 1 }, accepted }), /keyring_too_large/)
})
await test('invalid ring entries fail closed', async () => {
  await assert.rejects(() => computeFingerprintSet(base, {}), /invalid_keyring_current/)
  await assert.rejects(() => computeFingerprintSet(base, { current: { keyBytes: new Uint8Array(0), keyVersion: 1 } }), /invalid_hmac_key/)
  await assert.rejects(() => computeFingerprintSet(base, { current: { keyBytes: KEY_A, keyVersion: 0 } }), /invalid_key_version/)
  await assert.rejects(() => computeFingerprintSet(base, { current: { keyBytes: KEY_A, keyVersion: 1 }, accepted: 'nope' }), /invalid_keyring_accepted/)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
