// Regression tests for settleQuery — the fix for the Preview console error
//   "TypeError: ...maybeSingle(...).catch is not a function".
// A Supabase query builder is a THENABLE (implements .then) with NO .catch/.finally.
// settleQuery must resolve it via Promise.resolve(...).then(onF, onR) and NEVER call
// .catch on the builder itself.
//
// Run: node tests/supabase-result.test.js

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { settleQuery } from '../src/lib/supabaseResult.js'

// A builder-like thenable: has .then only (no .catch, no .finally) — exactly like a
// Supabase query builder. Accessing/calling .catch on it throws.
function thenableResolving(value) {
  return { then(onFulfilled) { onFulfilled(value) } }
}
function thenableRejecting(err) {
  return { then(_onFulfilled, onRejected) { onRejected(err) } }
}

await test('documents the original bug: .catch on a builder thenable throws', () => {
  const builder = thenableResolving({ data: { id: 1 } })
  assert.strictEqual(typeof builder.catch, 'undefined')
  assert.throws(() => builder.catch(() => {}), TypeError) // "catch is not a function"
})

await test('resolves a builder result without ever calling .catch', async () => {
  const result = await settleQuery(thenableResolving({ data: { id: 1 }, error: null }))
  assert.deepStrictEqual(result, { data: { id: 1 }, error: null })
})

await test('converts a rejection to the default { data: null, error } fallback', async () => {
  const boom = new Error('network')
  const result = await settleQuery(thenableRejecting(boom))
  assert.strictEqual(result.data, null)
  assert.strictEqual(result.error, boom)
})

await test('uses a custom fallback on rejection (count query)', async () => {
  const result = await settleQuery(thenableRejecting(new Error('x')), { count: 0 })
  assert.deepStrictEqual(result, { count: 0 })
})

await test('never throws synchronously even though the builder has no .catch', async () => {
  // If settleQuery called builder.catch(), this would throw TypeError instead of resolving.
  await assert.doesNotReject(() => settleQuery(thenableRejecting(new Error('x')), { data: null }))
})

console.log('All supabase-result tests passed.')
