/**
 * C3 tests: account-aware shared Pro-status provider.
 *
 * Tests the extracted production helpers (proStatusTransition, shouldApplyProStatusResult)
 * and a behavioral harness that mirrors ProStatusProvider's async control flow using
 * THOSE SAME helpers — so a previous account's status can never leak or overwrite a new
 * account's state. Access assertions go through the real hasProAccess().
 *
 * Zero deps — runs with: node tests/pro-status-provider.test.js
 */
import { proStatusTransition, shouldApplyProStatusResult } from '../src/lib/proStatusGeneration.js'
import { hasProAccess } from '../src/lib/pro-ui-status.js'

let passed = 0, failed = 0
const RUN = []
function test(name, fn) { RUN.push({ name, fn }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const SUBSCRIBED = { can_use_pro: true,  permanent_pro: false, subscription_active: true,  subscription_status: 'active' }
const NON_PRO    = { can_use_pro: false, permanent_pro: false, subscription_active: false, subscription_status: 'none' }

// ── pure helpers ───────────────────────────────────────────────────────────────
test('transition: same uid → ignore (token refresh keeps state)', () => assertEqual(proStatusTransition('A', 'A'), 'ignore'))
test('transition: A → B → switch', () => assertEqual(proStatusTransition('A', 'B'), 'switch'))
test('transition: A → null → clear (sign-out)', () => assertEqual(proStatusTransition('A', null), 'clear'))
test('transition: null → A → switch (initial load)', () => assertEqual(proStatusTransition(null, 'A'), 'switch'))
test('transition: null → null → ignore', () => assertEqual(proStatusTransition(null, null), 'ignore'))

test('apply: same uid + gen → apply', () => assert(shouldApplyProStatusResult('A', 2, 'A', 2)))
test('apply: different gen → discard', () => assert(!shouldApplyProStatusResult('A', 1, 'A', 2)))
test('apply: different uid → discard', () => assert(!shouldApplyProStatusResult('A', 2, 'B', 2)))

// ── Behavioral harness mirroring ProStatusProvider (uses the real helpers) ──────
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function makeProvider() {
  let status = null, currentUid = null, gen = 0
  const fetches = []                       // queue of deferreds, one per fetch call
  function nextFetch() { const d = deferred(); fetches.push(d); return d.promise }

  function onAuth(newUid) {
    const action = proStatusTransition(currentUid, newUid)
    if (action === 'ignore') return
    currentUid = newUid
    const g = ++gen
    status = null                          // clear immediately (fail-closed)
    if (action === 'clear') return
    const capUid = newUid
    nextFetch().then(s => {
      if (shouldApplyProStatusResult(capUid, g, currentUid, gen)) status = (s ?? 'error')
    })
  }
  async function refresh() {
    const capUid = currentUid, capGen = gen
    const s = await nextFetch()
    const norm = s ?? 'error'
    if (!shouldApplyProStatusResult(capUid, capGen, currentUid, gen)) return 'error'
    status = norm
    return norm
  }
  // Resolve the Nth outstanding fetch (FIFO) with a value.
  function resolveFetch(value) { fetches.shift().resolve(value) }
  return { onAuth, refresh, resolveFetch, get status() { return status } }
}
const tick = () => new Promise(r => setTimeout(r, 0))

test('subscribed A → non-Pro B: B never sees A\'s Pro; B ends non-Pro', async () => {
  const p = makeProvider()
  p.onAuth('A'); p.resolveFetch(SUBSCRIBED); await tick()
  assertEqual(hasProAccess(p.status), true)
  p.onAuth('B')
  assertEqual(p.status, null, 'status must clear immediately on switch (no A leak)')
  p.resolveFetch(NON_PRO); await tick()
  assertEqual(hasProAccess(p.status), false, 'B must be non-Pro')
})

test('non-Pro A → subscribed B: B becomes Pro (not stuck locked)', async () => {
  const p = makeProvider()
  p.onAuth('A'); p.resolveFetch(NON_PRO); await tick()
  assertEqual(hasProAccess(p.status), false)
  p.onAuth('B'); assertEqual(p.status, null)
  p.resolveFetch(SUBSCRIBED); await tick()
  assertEqual(hasProAccess(p.status), true)
})

test('subscribed A → signed out: status cleared, no Pro', async () => {
  const p = makeProvider()
  p.onAuth('A'); p.resolveFetch(SUBSCRIBED); await tick()
  p.onAuth(null)
  assertEqual(p.status, null)
  assertEqual(hasProAccess(p.status), false)
})

test('slow A request resolves AFTER switch to B → discarded', async () => {
  const p = makeProvider()
  p.onAuth('A')                       // A fetch pending (not resolved)
  p.onAuth('B')                       // B fetch pending
  p.resolveFetch(SUBSCRIBED); await tick()   // this resolves A's fetch (FIFO) → stale
  assertEqual(p.status, null, 'stale A result must not apply')
  p.resolveFetch(NON_PRO); await tick()      // B's fetch
  assertEqual(hasProAccess(p.status), false)
})

test('slow B request resolves AFTER switching back to A → discarded', async () => {
  const p = makeProvider()
  p.onAuth('A'); p.resolveFetch(NON_PRO); await tick()  // A settled non-Pro
  p.onAuth('B')                                          // B fetch pending
  p.onAuth('A')                                          // back to A → A fetch pending
  p.resolveFetch(SUBSCRIBED); await tick()               // resolves B's fetch → stale
  assertEqual(p.status, null, 'stale B result must not apply after switching back to A')
})

test('refresh started for A resolves AFTER switch to B → discarded (returns error)', async () => {
  const p = makeProvider()
  p.onAuth('A'); p.resolveFetch(SUBSCRIBED); await tick()
  const refreshP = p.refresh()        // refresh for A, fetch pending
  p.onAuth('B')                       // switch → clears, B fetch pending
  p.resolveFetch(SUBSCRIBED)          // resolves refresh's fetch (FIFO) → stale
  assertEqual(await refreshP, 'error', 'stale refresh must fail closed and not overwrite state')
  assertEqual(p.status, null, 'B state (cleared) must be preserved')
})

test('same-user auth refresh does not discard valid state', async () => {
  const p = makeProvider()
  p.onAuth('A'); p.resolveFetch(SUBSCRIBED); await tick()
  p.onAuth('A')                       // token refresh, same uid → ignore
  assertEqual(hasProAccess(p.status), true, 'valid state kept on same-user event')
})

test('provider error leaves access fail-closed (unavailable)', async () => {
  const p = makeProvider()
  p.onAuth('A'); p.resolveFetch(null); await tick()  // RPC null → 'error'
  assertEqual(p.status, 'error')
  assertEqual(hasProAccess(p.status), false)
})

// ── Source contract: provider wires the real mechanism ─────────────────────────
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'useProStatus.js'), 'utf8')
test('ProStatusProvider subscribes to onAuthStateChange + uses the generation helpers', () => {
  assert(src.includes('onAuthStateChange'), 'must subscribe to auth changes')
  assert(src.includes('proStatusTransition('), 'must use proStatusTransition')
  assert(src.includes('shouldApplyProStatusResult('), 'must gate async results')
  assert(src.includes('subscription?.unsubscribe'), 'must unsubscribe on unmount')
})

for (const { name, fn } of RUN) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
