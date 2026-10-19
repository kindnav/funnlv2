/**
 * P5 tests: shared bounded-fetch helper (supabase/functions/shared/boundedFetch.js).
 * Exercises the REAL fetchWithTimeout with injected fetch/timer so timeouts, cleanup,
 * success-before-deadline, and external-abort are deterministic.
 *
 * Zero deps — runs with: node tests/bounded-fetch.test.js
 */
import { fetchWithTimeout, isTimeoutError, STRIPE_FETCH_TIMEOUT_MS } from '../supabase/functions/shared/boundedFetch.js'

let passed = 0, failed = 0
const RUN = []
function test(name, fn) { RUN.push({ name, fn }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// A fetch that never resolves on its own — it only rejects (AbortError) when its signal
// aborts. Models a stalled Stripe request.
function stalledFetch() {
  return (_url, init) => new Promise((_resolve, reject) => {
    const sig = init.signal
    const rej = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (sig.aborted) return rej()
    sig.addEventListener('abort', rej)
  })
}

// Timer stubs: `fire` controls whether the scheduled callback runs synchronously.
function makeTimers({ fire }) {
  const state = { set: 0, cleared: 0, lastId: 0 }
  const setTimeoutImpl = (fn) => { state.set++; if (fire) fn(); return ++state.lastId }
  const clearTimeoutImpl = () => { state.cleared++ }
  return { state, setTimeoutImpl, clearTimeoutImpl }
}

test('default timeout is ~20s', () => assertEqual(STRIPE_FETCH_TIMEOUT_MS, 20_000))

test('timeout aborts the request and throws a TimeoutError', async () => {
  const t = makeTimers({ fire: true })   // timer fires immediately → abort
  let threw = null
  try {
    await fetchWithTimeout('https://api.stripe.com/x', {}, {
      fetchImpl: stalledFetch(), setTimeoutImpl: t.setTimeoutImpl, clearTimeoutImpl: t.clearTimeoutImpl,
    })
  } catch (e) { threw = e }
  assert(threw, 'must throw on timeout')
  assert(isTimeoutError(threw), 'error must be a TimeoutError')
})

test('timer is cleared on timeout', async () => {
  const t = makeTimers({ fire: true })
  try { await fetchWithTimeout('u', {}, { fetchImpl: stalledFetch(), setTimeoutImpl: t.setTimeoutImpl, clearTimeoutImpl: t.clearTimeoutImpl }) } catch { /* expected */ }
  assertEqual(t.state.set, 1)
  assertEqual(t.state.cleared, 1, 'timer must be cleared even on timeout')
})

test('success before deadline returns the response and clears the timer', async () => {
  const t = makeTimers({ fire: false })  // timer never fires
  const resp = { ok: true, status: 200, json: async () => ({ id: 'x' }) }
  const okFetch = async () => resp
  const out = await fetchWithTimeout('u', {}, { fetchImpl: okFetch, setTimeoutImpl: t.setTimeoutImpl, clearTimeoutImpl: t.clearTimeoutImpl })
  assertEqual(out, resp)
  assertEqual(t.state.cleared, 1, 'timer must be cleared on success')
})

test('an already-aborted external signal aborts and does NOT surface as a timeout', async () => {
  const t = makeTimers({ fire: false })
  const ac = new AbortController(); ac.abort()
  let threw = null
  try {
    await fetchWithTimeout('u', {}, {
      signal: ac.signal, fetchImpl: stalledFetch(),
      setTimeoutImpl: t.setTimeoutImpl, clearTimeoutImpl: t.clearTimeoutImpl,
    })
  } catch (e) { threw = e }
  assert(threw, 'must throw when external signal already aborted')
  assert(!isTimeoutError(threw), 'external abort is not a timeout')
  assertEqual(t.state.cleared, 1, 'timer cleared even on external abort')
})

test('a later external abort cancels the request', async () => {
  const t = makeTimers({ fire: false })
  const ac = new AbortController()
  const p = fetchWithTimeout('u', {}, {
    signal: ac.signal, fetchImpl: stalledFetch(),
    setTimeoutImpl: t.setTimeoutImpl, clearTimeoutImpl: t.clearTimeoutImpl,
  })
  ac.abort()
  let threw = null
  try { await p } catch (e) { threw = e }
  assert(threw && !isTimeoutError(threw), 'external abort should reject, not as timeout')
})

test('isTimeoutError only matches TimeoutError', () => {
  assert(isTimeoutError(Object.assign(new Error('x'), { name: 'TimeoutError' })))
  assert(!isTimeoutError(new Error('x')))
  assert(!isTimeoutError(null))
  assert(!isTimeoutError(Object.assign(new Error('x'), { name: 'AbortError' })))
})

// ── Source contract: all three Stripe callers use the bounded helper ───────────
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const [label, path] of [
  ['create-checkout-session', 'supabase/functions/create-checkout-session/index.ts'],
  ['create-billing-portal-session', 'supabase/functions/create-billing-portal-session/index.ts'],
  ['stripe-webhook', 'supabase/functions/stripe-webhook/index.ts'],
]) {
  test(`${label} uses fetchWithTimeout (no unbounded Stripe fetch)`, () => {
    const src = readFileSync(join(ROOT, path), 'utf8')
    assert(src.includes('fetchWithTimeout('), `${label} must use fetchWithTimeout`)
    assert(!/await fetch\(`\$\{STRIPE_API\}/.test(src), `${label} must not call raw fetch on the Stripe API`)
  })
}

test('billing portal maps a fetch timeout/failure to a retryable 503 (no raw error logged)', () => {
  const src = readFileSync(join(ROOT, 'supabase/functions/create-billing-portal-session/index.ts'), 'utf8')
  // The fetchWithTimeout call is wrapped in try/catch that returns 503.
  const idx = src.indexOf('fetchWithTimeout(')
  const region = src.slice(idx, idx + 1100)
  assert(/status:\s*503/.test(region), 'timeout/network failure must return 503')
  assert(region.includes('isTimeoutError('), 'must classify timeout distinctly')
  // Must not log the raw error object / message / stack (only a boolean timeout flag is safe).
  for (const bad of ['String(err', 'err.message', 'err.stack', 'error: err', ', err)', ', err,']) {
    assert(!region.includes(bad), `must not log raw error content: "${bad}"`)
  }
})

test('webhook fetch timeout surfaces provider_timeout (retryable) distinctly from null', () => {
  const src = readFileSync(join(ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8')
  assert(src.includes("isTimeoutError(err) ? 'timeout' : null"),
    'webhook fetch must return a distinct timeout sentinel')
})

for (const { name, fn } of RUN) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
