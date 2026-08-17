// AES-256-GCM token encryption for Google OAuth tokens and the PKCE verifier.
//
// Runs on the Web Crypto API, which is available both in Deno (Edge Functions)
// and in Node 20+ (globalThis.crypto) — so this module is directly unit-testable
// in the repo's plain-Node test runner with zero dependencies.
//
// The encryption key comes from the Edge secret GOOGLE_TOKEN_ENCRYPTION_KEY_V1:
// a base64-encoded 32-byte (256-bit) random key. Ciphertext and nonce (IV) are
// stored separately (as base64). A key_version column accompanies each stored
// row so the key can be rotated later without ambiguity.
//
// SECURITY: never log plaintext tokens, ciphertext, nonces, OAuth codes, PKCE
// verifiers, or state values. This module returns values; it never logs.

const ALGO = 'AES-GCM'
const IV_BYTES = 12          // 96-bit nonce, the AES-GCM standard
const KEY_BYTES = 32         // 256-bit key

// ── base64 <-> bytes (works in Deno + Node via global btoa/atob) ──────────────

export function bytesToBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function base64ToBytes(b64) {
  if (typeof b64 !== 'string') throw new Error('invalid_base64')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Imports a base64-encoded 32-byte key as a non-extractable AES-GCM CryptoKey.
 * Throws 'invalid_key_length' if the decoded key is not exactly 32 bytes.
 *
 * @param {string} b64Key — base64 of 32 random bytes (GOOGLE_TOKEN_ENCRYPTION_KEY_V1)
 * @param {SubtleCrypto} subtle
 * @returns {Promise<CryptoKey>}
 */
export async function importKeyFromBase64(b64Key, subtle = globalThis.crypto.subtle) {
  const raw = base64ToBytes(b64Key)
  if (raw.length !== KEY_BYTES) throw new Error('invalid_key_length')
  return subtle.importKey('raw', raw, { name: ALGO }, false, ['encrypt', 'decrypt'])
}

/**
 * Encrypts a UTF-8 plaintext with AES-256-GCM. Returns base64 ciphertext + nonce.
 * A fresh random 96-bit nonce is generated per call.
 *
 * @param {string} plaintext
 * @param {CryptoKey} key
 * @param {{ subtle?: SubtleCrypto, getRandomBytes?: (n:number)=>Uint8Array }} [deps]
 * @returns {Promise<{ ciphertext: string, nonce: string }>}
 */
export async function encryptToken(plaintext, key, deps = {}) {
  const subtle = deps.subtle ?? globalThis.crypto.subtle
  const getRandomBytes = deps.getRandomBytes ?? ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
  if (typeof plaintext !== 'string') throw new Error('invalid_plaintext')
  const iv = getRandomBytes(IV_BYTES)
  const data = new TextEncoder().encode(plaintext)
  const ctBuf = await subtle.encrypt({ name: ALGO, iv }, key, data)
  return {
    ciphertext: bytesToBase64(new Uint8Array(ctBuf)),
    nonce:      bytesToBase64(iv),
  }
}

/**
 * Decrypts base64 ciphertext + nonce back to the UTF-8 plaintext.
 * Throws if the key is wrong or the ciphertext/nonce was tampered with
 * (AES-GCM authentication failure surfaces as a thrown error).
 *
 * @param {string} ciphertextB64
 * @param {string} nonceB64
 * @param {CryptoKey} key
 * @param {{ subtle?: SubtleCrypto }} [deps]
 * @returns {Promise<string>}
 */
export async function decryptToken(ciphertextB64, nonceB64, key, deps = {}) {
  const subtle = deps.subtle ?? globalThis.crypto.subtle
  const ct = base64ToBytes(ciphertextB64)
  const iv = base64ToBytes(nonceB64)
  const ptBuf = await subtle.decrypt({ name: ALGO, iv }, key, ct)
  return new TextDecoder().decode(ptBuf)
}
