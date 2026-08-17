// AES-256-GCM token crypto tests. Runs on Web Crypto (shim node:crypto for older
// Node). Run with: node tests/google-token-crypto.test.js
import assert from 'assert'
import { webcrypto } from 'node:crypto'
if (!globalThis.crypto) globalThis.crypto = webcrypto

import {
  importKeyFromBase64, encryptToken, decryptToken, bytesToBase64, base64ToBytes,
} from '../supabase/functions/shared/googleTokenCrypto.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

function randomKeyB64() {
  return bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)))
}

console.log('\ngoogleTokenCrypto')

await test('base64 round-trips arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 127, 128])
  const decoded = base64ToBytes(bytesToBase64(bytes))
  assert.deepStrictEqual(Array.from(decoded), Array.from(bytes))
})

await test('encrypt → decrypt round-trips a token', async () => {
  const key = await importKeyFromBase64(randomKeyB64())
  const plaintext = 'ya29.a0ARrdaM-fake-access-token-value'
  const { ciphertext, nonce } = await encryptToken(plaintext, key)
  assert.ok(ciphertext && nonce, 'ciphertext + nonce present')
  assert.ok(!ciphertext.includes(plaintext), 'ciphertext does not contain plaintext')
  const out = await decryptToken(ciphertext, nonce, key)
  assert.strictEqual(out, plaintext)
})

await test('each encryption uses a fresh nonce (ciphertext differs)', async () => {
  const key = await importKeyFromBase64(randomKeyB64())
  const a = await encryptToken('same', key)
  const b = await encryptToken('same', key)
  assert.notStrictEqual(a.nonce, b.nonce)
  assert.notStrictEqual(a.ciphertext, b.ciphertext)
})

await test('decrypt with the WRONG key throws', async () => {
  const key1 = await importKeyFromBase64(randomKeyB64())
  const key2 = await importKeyFromBase64(randomKeyB64())
  const { ciphertext, nonce } = await encryptToken('secret', key1)
  let threw = false
  try { await decryptToken(ciphertext, nonce, key2) } catch { threw = true }
  assert.ok(threw, 'wrong key must fail authentication')
})

await test('decrypt of TAMPERED ciphertext throws (GCM auth)', async () => {
  const key = await importKeyFromBase64(randomKeyB64())
  const { ciphertext, nonce } = await encryptToken('secret', key)
  // Flip one byte of the ciphertext.
  const bytes = base64ToBytes(ciphertext)
  bytes[0] ^= 0x01
  const tampered = bytesToBase64(bytes)
  let threw = false
  try { await decryptToken(tampered, nonce, key) } catch { threw = true }
  assert.ok(threw, 'tampered ciphertext must fail')
})

await test('importKeyFromBase64 rejects a non-32-byte key', async () => {
  let threw = false
  try { await importKeyFromBase64(bytesToBase64(new Uint8Array(16))) } catch (e) { threw = e.message === 'invalid_key_length' }
  assert.ok(threw, 'must throw invalid_key_length')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
