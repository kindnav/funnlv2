// Tests for extractInvokeError — the frontend Supabase invocation error normalizer.
// Imports directly from the production module — no copied implementations.
//
// extractInvokeError is async: it may call await fnError.context.json() to parse
// the raw Response body carried inside FunctionsHttpError.
//
// Run with: node tests/ai-chat-error.test.js

import assert from 'assert'
import { FunctionsHttpError, FunctionsRelayError, FunctionsFetchError } from '@supabase/supabase-js'
import { extractInvokeError } from '../src/lib/ai-chat-error.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// Helper: creates a FunctionsHttpError wrapping a JSON response body.
// FunctionsHttpError(response) stores the raw Response — context.json() reads it.
function makeHttpError(body, status = 400) {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
  return new FunctionsHttpError(response)
}

// ── FunctionsHttpError — structured Edge Function responses ────────────────────
console.log('\nextractInvokeError — FunctionsHttpError with structured body')

await test('extracts all fields from a structured FunctionsHttpError', async () => {
  const fnError = makeHttpError({
    error: { code: 'provider_timeout', message: 'Timed out', retryable: true, request_id: 'req-abc' }
  }, 504)
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'provider_timeout')
  assert.strictEqual(r.message, 'Timed out')
  assert.strictEqual(r.retryable, true)
  assert.strictEqual(r.request_id, 'req-abc')
})

await test('retryable defaults to true when the field is absent', async () => {
  const fnError = makeHttpError({ error: { code: 'internal_error', message: 'Error' } }, 500)
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.retryable, true)
})

await test('retryable is false when explicitly set false', async () => {
  const fnError = makeHttpError({ error: { code: 'pro_required', message: 'Pro only', retryable: false } }, 403)
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.retryable, false)
})

await test('request_id is null when absent from the structured error', async () => {
  const fnError = makeHttpError({ error: { code: 'internal_error', message: 'Err', retryable: true } }, 500)
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.request_id, null)
})

await test('returns safe default when FunctionsHttpError body is not JSON', async () => {
  const response = new Response('Internal Server Error', { status: 500 })
  const fnError = new FunctionsHttpError(response)
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'internal_error')
  assert.strictEqual(r.retryable, true)
  assert.strictEqual(r.request_id, null)
})

await test('returns safe default when FunctionsHttpError body has no error key', async () => {
  const fnError = makeHttpError({ message: 'Unknown' }, 500)
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'internal_error')
})

// ── Error code allowlist normalization ─────────────────────────────────────────
console.log('\nextractInvokeError — error code allowlist normalization')

await test('known code provider_rate_limited passes through allowlist', async () => {
  const fnError = makeHttpError({ error: { code: 'provider_rate_limited', message: 'Busy', retryable: true } }, 429)
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'provider_rate_limited')
})

await test('unknown code is normalized to internal_error', async () => {
  const fnError = makeHttpError({ error: { code: 'made_up_error', message: 'What?', retryable: true } }, 500)
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'internal_error')
})

await test('all 11 known codes pass through the allowlist unchanged', async () => {
  const knownCodes = [
    'unauthorized', 'invalid_request', 'pro_required', 'internal_error',
    'network_data_failed', 'context_too_large', 'provider_rate_limited',
    'provider_timeout', 'provider_unavailable', 'provider_error', 'empty_provider_response',
  ]
  for (const code of knownCodes) {
    const fnError = makeHttpError({ error: { code, message: 'Test', retryable: true } }, 400)
    const r = await extractInvokeError(fnError, null)
    assert.strictEqual(r.code, code, `code '${code}' was not passed through`)
  }
})

// ── FunctionsRelayError and FunctionsFetchError (network failures) ─────────────
console.log('\nextractInvokeError — FunctionsRelayError and FunctionsFetchError')

await test('FunctionsRelayError returns retryable internal_error', async () => {
  const fnError = new FunctionsRelayError('relay failed')
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'internal_error')
  assert.strictEqual(r.retryable, true)
  assert.strictEqual(r.request_id, null)
})

await test('FunctionsFetchError returns retryable internal_error', async () => {
  const fnError = new FunctionsFetchError('fetch failed')
  const r = await extractInvokeError(fnError, null)
  assert.strictEqual(r.code, 'internal_error')
  assert.strictEqual(r.retryable, true)
})

// ── Structured error in data.error (HTTP 200 with error body) ─────────────────
console.log('\nextractInvokeError — structured error in data.error')

await test('extracts error from data.error when fnError is null', async () => {
  const data = { error: { code: 'empty_provider_response', message: 'No reply', retryable: true, request_id: 'req-xyz' } }
  const r = await extractInvokeError(null, data)
  assert.strictEqual(r.code, 'empty_provider_response')
  assert.strictEqual(r.request_id, 'req-xyz')
})

await test('normalizes unknown code from data.error allowlist', async () => {
  const data = { error: { code: 'mystery_code', message: 'Hmm', retryable: false } }
  const r = await extractInvokeError(null, data)
  assert.strictEqual(r.code, 'internal_error')
})

// ── Legacy plain-string errors ─────────────────────────────────────────────────
console.log('\nextractInvokeError — legacy plain-string errors')

await test('handles legacy plain-string error from data.error', async () => {
  const r = await extractInvokeError(null, { error: 'Old error format' })
  assert.strictEqual(r.code, 'internal_error')
  assert.strictEqual(r.message, 'Old error format')
  assert.strictEqual(r.retryable, true)
  assert.strictEqual(r.request_id, null)
})

// ── Success path (null return) ─────────────────────────────────────────────────
console.log('\nextractInvokeError — success path')

await test('returns null when there is no error (success path)', async () => {
  const r = await extractInvokeError(null, { reply: 'Hello', request_id: 'req-1' })
  assert.strictEqual(r, null)
})

await test('returns null when both fnError and data are null', async () => {
  const r = await extractInvokeError(null, null)
  assert.strictEqual(r, null)
})

// ── Backward compatibility: new frontend calling old Edge Function ─────────────
// The old Edge Function returned { reply, request_id } on success (no error field).
// extractInvokeError must return null for these shapes so the success path is taken.
console.log('\nextractInvokeError — backward compat: new frontend + old Edge Function')

await test('old Edge Function success shape { reply } without structured error field is treated as success', async () => {
  // Old Edge Function returns { reply: 'Here is your answer.' } — no error key
  const r = await extractInvokeError(null, { reply: 'Here is your answer.' })
  assert.strictEqual(r, null)
})

await test('old Edge Function success shape without request_id is treated as success', async () => {
  // Old Edge Function may have returned { reply: 'text' } without request_id — still no error
  const r = await extractInvokeError(null, { reply: 'text' })
  assert.strictEqual(r, null)
})

await test('old Edge Function empty reply {} without error field returns null (empty reply caught by caller, not here)', async () => {
  // Old Edge Function returned { reply: '' } when text block was absent.
  // extractInvokeError sees no error field → returns null.
  // FunnlAIPage's `if (!data?.reply)` guard is what catches the empty string.
  const r = await extractInvokeError(null, { reply: '' })
  assert.strictEqual(r, null)
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
