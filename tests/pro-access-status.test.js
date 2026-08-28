// Zero-dependency Node.js tests for the getProAccessStatus wrapper.
// Uses _getProAccessStatusWith(client) for dependency injection — no real Supabase needed.
//
// Run with: node tests/pro-access-status.test.js
//
// _getProAccessStatusWith lives in: src/lib/pro-access-status.js

import { strict as assert } from 'assert'
import { test } from 'node:test'
// Import from the impl file — the pure zero-dependency module. The full
// pro-access-status.js imports from ./supabase (uses import.meta.env) which
// cannot load in plain Node.js. _getProAccessStatusWith is re-exported from
// pro-access-status.js in production code, so this tests the real logic.
import { _getProAccessStatusWith } from '../src/lib/pro-access-status-impl.js'

// ── Stub helpers ──────────────────────────────────────────────────────────────

// Client whose rpc() resolves with a structured { data, error } result.
function makeRpcClient(data, error = null) {
  return {
    rpc(_name) {
      return Promise.resolve({ data, error })
    },
  }
}

// Client whose rpc() rejects (throws a network error or SDK exception).
function makeThrowingRpcClient(message = 'network failure') {
  return {
    rpc(_name) {
      return Promise.reject(new Error(message))
    },
  }
}

// Minimal valid status object with the two required boolean fields.
const VALID_STATUS = {
  permanent_pro:  false,
  trial_eligible: false,
  trial_active:   false,
  trial_expired:  false,
  days_remaining: 0,
  ends_at:        null,
  server_now:     '2026-07-27T12:00:00.000Z',
  can_use_pro:    false,
}

// ── Happy-path: valid response ─────────────────────────────────────────────────

await test('returns the data object when shape is valid (non-Pro)', async () => {
  const client = makeRpcClient(VALID_STATUS)
  const result = await _getProAccessStatusWith(client)
  assert.deepStrictEqual(result, VALID_STATUS)
})

await test('returns the data object when shape is valid (permanent Pro)', async () => {
  const status = { ...VALID_STATUS, permanent_pro: true, can_use_pro: true }
  const client = makeRpcClient(status)
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result.permanent_pro, true)
  assert.strictEqual(result.can_use_pro, true)
})

await test('passes through all extra fields — no field stripping', async () => {
  const status = { ...VALID_STATUS, trial_active: true, can_use_pro: true, days_remaining: 5 }
  const client = makeRpcClient(status)
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result.trial_active, true)
  assert.strictEqual(result.days_remaining, 5)
})

// ── Structured RPC errors (error field present) ───────────────────────────────

await test('returns null when RPC returns a structured error', async () => {
  const client = makeRpcClient(null, { code: 'PGRST301', message: 'auth error' })
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
})

await test('returns null when RPC returns a structured error with no code', async () => {
  const client = makeRpcClient(null, { message: 'some error' })
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
})

// ── Malformed response shapes ─────────────────────────────────────────────────

await test('returns null when data is null (no RPC error, just null data)', async () => {
  const client = makeRpcClient(null)
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
})

await test('returns null when can_use_pro is missing', async () => {
  const { can_use_pro: _omitted, ...noCan } = VALID_STATUS
  const client = makeRpcClient(noCan)
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
})

await test('returns null when can_use_pro is wrong type (string)', async () => {
  const client = makeRpcClient({ ...VALID_STATUS, can_use_pro: 'yes' })
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
})

await test('returns null when permanent_pro is missing', async () => {
  const { permanent_pro: _omitted, ...noPerm } = VALID_STATUS
  const client = makeRpcClient(noPerm)
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
})

await test('returns null when permanent_pro is wrong type (number 0)', async () => {
  const client = makeRpcClient({ ...VALID_STATUS, permanent_pro: 0 })
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
})

// ── Never throws — all failure paths resolve to null ──────────────────────────

await test('never throws when rpc() rejects — resolves to null', async () => {
  const client = makeThrowingRpcClient('network failure')
  // Must not reject — the function's never-throws contract must hold.
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
})

// ── PGRST303 transient-JWT refresh + retry (Preview console-error fix) ─────────
// PGRST303 = validly-signed but temporally-invalid JWT (expired / iat-future /
// nbf-future). Root cause: a stale access token reaches PostgREST at app mount.
// The fix refreshes the session and retries ONCE — resolving it, not suppressing.

// Client whose rpc() returns queued results in order, counting calls, and whose
// auth.refreshSession() returns a configurable result while counting calls.
function makeRefreshClient(rpcResults, refreshResult = { error: null }) {
  const state = { rpcCalls: 0, refreshCalls: 0 }
  const client = {
    rpc() {
      const r = rpcResults[Math.min(state.rpcCalls, rpcResults.length - 1)]
      state.rpcCalls++
      return Promise.resolve(r)
    },
    auth: {
      refreshSession() {
        state.refreshCalls++
        return Promise.resolve(refreshResult)
      },
    },
  }
  return { client, state }
}

for (const code of ['PGRST303', 'PGRST301']) {
  await test(`${code}: refreshes session and retries once, returning fresh data`, async () => {
    const { client, state } = makeRefreshClient([
      { data: null, error: { code, message: 'jwt temporal' } },
      { data: { ...VALID_STATUS, can_use_pro: true, permanent_pro: true }, error: null },
    ])
    const result = await _getProAccessStatusWith(client)
    assert.strictEqual(result.can_use_pro, true)
    assert.strictEqual(state.refreshCalls, 1)   // refreshed exactly once
    assert.strictEqual(state.rpcCalls, 2)       // initial + one retry
  })
}

await test('PGRST303: retry runs at most once (still failing → null)', async () => {
  const { client, state } = makeRefreshClient([
    { data: null, error: { code: 'PGRST303', message: 'expired' } },
    { data: null, error: { code: 'PGRST303', message: 'expired' } },
  ])
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
  assert.strictEqual(state.refreshCalls, 1)
  assert.strictEqual(state.rpcCalls, 2)         // never more than initial + one retry
})

await test('PGRST303: when refreshSession fails, does not retry and returns null', async () => {
  const { client, state } = makeRefreshClient(
    [{ data: null, error: { code: 'PGRST303', message: 'expired' } }],
    { error: { message: 'no refresh token' } },
  )
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
  assert.strictEqual(state.refreshCalls, 1)
  assert.strictEqual(state.rpcCalls, 1)         // no retry after a failed refresh
})

await test('non-refreshable error (42501) never triggers a session refresh', async () => {
  const { client, state } = makeRefreshClient([
    { data: null, error: { code: '42501', message: 'permission denied' } },
  ])
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
  assert.strictEqual(state.refreshCalls, 0)     // permission errors are not transient
  assert.strictEqual(state.rpcCalls, 1)
})

await test('success on first call never triggers a refresh', async () => {
  const { client, state } = makeRefreshClient([{ data: VALID_STATUS, error: null }])
  const result = await _getProAccessStatusWith(client)
  assert.deepStrictEqual(result, VALID_STATUS)
  assert.strictEqual(state.refreshCalls, 0)
  assert.strictEqual(state.rpcCalls, 1)
})

await test('PGRST303 without an auth.refreshSession client falls through to null (backward compatible)', async () => {
  const client = makeRpcClient(null, { code: 'PGRST303', message: 'expired' })
  const result = await _getProAccessStatusWith(client)
  assert.strictEqual(result, null)
})

console.log('All pro-access-status tests passed.')
