// Tests for extractInvokeError — the frontend Supabase invocation error normalizer.
// Imports directly from the production module — no copied implementations.
//
// Run with: node tests/ai-chat-error.test.js

import assert from 'assert'
import { extractInvokeError } from '../src/lib/ai-chat-error.js'

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

// ── Structured Edge Function errors (FunctionsHttpError.context.error) ─────────
console.log('\nextractInvokeError — structured Edge Function errors')

test('extracts all fields from a structured FunctionsHttpError', () => {
  const fnError = { context: { error: { code: 'provider_timeout', message: 'Timed out', retryable: true, request_id: 'req-abc' } } }
  const r = extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'provider_timeout')
  assert.strictEqual(r.message, 'Timed out')
  assert.strictEqual(r.retryable, true)
  assert.strictEqual(r.request_id, 'req-abc')
})

test('retryable defaults to true when the field is absent', () => {
  const fnError = { context: { error: { code: 'internal_error', message: 'Error' } } }
  const r = extractInvokeError(fnError, null)
  assert.strictEqual(r.retryable, true)
})

test('retryable is false when explicitly set false', () => {
  const fnError = { context: { error: { code: 'pro_required', message: 'Pro only', retryable: false } } }
  const r = extractInvokeError(fnError, null)
  assert.strictEqual(r.retryable, false)
})

test('request_id is null when absent from the structured error', () => {
  const fnError = { context: { error: { code: 'internal_error', message: 'Err', retryable: true } } }
  const r = extractInvokeError(fnError, null)
  assert.strictEqual(r.request_id, null)
})

test('extracts error from data.error when fnError is null (HTTP 200 with error body)', () => {
  const data = { error: { code: 'empty_provider_response', message: 'No reply', retryable: true, request_id: 'req-xyz' } }
  const r = extractInvokeError(null, data)
  assert.strictEqual(r.code, 'empty_provider_response')
  assert.strictEqual(r.request_id, 'req-xyz')
})

// ── Legacy plain-string errors ─────────────────────────────────────────────────
console.log('\nextractInvokeError — legacy plain-string errors')

test('handles legacy plain-string error from fnError.context.error', () => {
  const fnError = { context: { error: 'Something went wrong' } }
  const r = extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'internal_error')
  assert.strictEqual(r.message, 'Something went wrong')
  assert.strictEqual(r.retryable, true)
  assert.strictEqual(r.request_id, null)
})

test('handles legacy plain-string error from data.error', () => {
  const r = extractInvokeError(null, { error: 'Old error format' })
  assert.strictEqual(r.code, 'internal_error')
  assert.strictEqual(r.message, 'Old error format')
})

// ── Generic / no-body errors ───────────────────────────────────────────────────
console.log('\nextractInvokeError — generic and network errors')

test('returns internal_error for FunctionsHttpError with no structured body', () => {
  const fnError = { message: 'Edge Function returned a non-2xx status code' }
  const r = extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'internal_error')
  assert.strictEqual(r.retryable, true)
  assert.strictEqual(r.request_id, null)
})

test('returns internal_error gracefully when context is not an object', () => {
  const fnError = { context: 'unexpected-string' }
  const r = extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'internal_error')
})

test('returns null when there is no error (success path)', () => {
  const r = extractInvokeError(null, { reply: 'Hello', request_id: 'req-1' })
  assert.strictEqual(r, null)
})

test('returns null when both fnError and data are null', () => {
  assert.strictEqual(extractInvokeError(null, null), null)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
