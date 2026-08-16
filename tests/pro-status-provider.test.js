/**
 * P1/P3 tests: the REAL Pro-status request-sequencing controller.
 *
 * Imports and exercises the production createProStatusController() (src/lib/proStatusController.js)
 * — the same object ProStatusProvider owns — through a small driver that mirrors ONLY the
 * provider's wiring (fetch → canApply → apply), never the controller's business logic.
 * Access assertions go through the real hasProAccess().
 *
 * Zero deps — runs with: node tests/pro-status-provider.test.js
 */
import { createProStatusController } from '../src/lib/proStatusController.js'
import { hasProAccess } from '../src/lib/pro-ui-status.js'

let passed = 0, failed = 0
const RUN = []
function test(name, fn) { RUN.push({ name, fn }) }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const SUBSCRIBED = { can_use_pro: true,  permanent_pro: false, subscription_active: true,  subscription_status: 'active' }
const NON_PRO    = { can_use_pro: false, permanent_pro: false, subscription_active: false, subscription_status: 'none' }

// Deferred fetch so tests control resolution ordering precisely.
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// Driver = the exact provider wiring around the REAL controller. It records applied state.
function makeDriver() {
  const ctl = createProStatusController()
  let status = null
  const fetches = []                       // FIFO of deferreds, one per status request
  const nextFetch = () => { const d = deferred(); fetches.push(d); return d.promise }

  function onAuth(newUid) {
    const { action, token, uid } = ctl.onAuth(newUid)
    if (action === 'ignore') return
    status = null
    if (action === 'clear') return
    nextFetch().then(s => { if (ctl.canApply(token, uid)) status = (s ?? 'error') })
  }
  async function refresh() {
    const { token, uid } = ctl.beginRefresh()
    const s = await nextFetch()
    const norm = s ?? 'error'
    if (!ctl.canApply(token, uid)) return 'error'
    status = norm
    return norm
  }
  const resolveFetch = (value) => fetches.shift().resolve(value)
  return { ctl, onAuth, refresh, resolveFetch, get status() { return status } }
}
const tick = () => new Promise(r => setTimeout(r, 0))

// ── Controller units ───────────────────────────────────────────────────────────
test('every request mints a newer token (requestSeq advances)', () => {
  const c = createProStatusController()
  c.onAuth('A')
  const r1 = c.beginRefresh().token
  const r2 = c.beginRefresh().token
  assert(r2 > r1, 'refresh tokens must be monotonically increasing')
})
test('canApply true only for the newest token + unchanged uid + active', () => {
  const c = createProStatusController()
  const a = c.onAuth('A')                 // token for the fetch
  assert(c.canApply(a.token, 'A'))
  const r = c.beginRefresh()              // newer token supersedes the auth-fetch
  assert(!c.canApply(a.token, 'A'), 'older token must be stale')
  assert(c.canApply(r.token, 'A'))
})
test('accountGeneration bumps on switch/sign-out but NOT on refresh', () => {
  const c = createProStatusController()
  c.onAuth('A'); const g1 = c.accountGeneration
  c.beginRefresh(); assertEqual(c.accountGeneration, g1, 'refresh must not bump accountGeneration')
  c.onAuth('B');   assert(c.accountGeneration > g1, 'switch must bump accountGeneration')
  c.onAuth(null);  assert(c.accountGeneration > g1 + 1, 'sign-out must bump accountGeneration')
})
test('same-uid onAuth is ignore (no counter change)', () => {
  const c = createProStatusController()
  c.onAuth('A'); const seq = c.requestSeq, gen = c.accountGeneration
  const r = c.onAuth('A')
  assertEqual(r.action, 'ignore')
  assertEqual(c.requestSeq, seq); assertEqual(c.accountGeneration, gen)
})
test('deactivate discards everything', () => {
  const c = createProStatusController()
  const a = c.onAuth('A')
  c.deactivate()
  assert(!c.canApply(a.token, 'A'))
})

// ── P1 core race: same-account overlapping refreshes → newest wins ─────────────
test('1. older same-UID refresh finishing AFTER a newer refresh is discarded', async () => {
  const d = makeDriver()
  d.onAuth('A'); d.resolveFetch(NON_PRO); await tick()   // initial: non-Pro
  const older = d.refresh()                               // older refresh (fetch #1 pending)
  const newer = d.refresh()                               // newer refresh (fetch #2 pending)
  d.resolveFetch(SUBSCRIBED)                              // resolve OLDER's fetch (FIFO) → wait
  // The newer refresh resolves with Pro; the older (already superseded) must be discarded.
  d.resolveFetch(SUBSCRIBED)
  assertEqual(await older, 'error', 'older same-uid refresh must return stale sentinel')
  assertEqual(await newer, SUBSCRIBED, 'newer refresh returns the fresh status')
  assertEqual(hasProAccess(d.status), true, 'a stale older refresh must not re-lock a paying user')
})

test('2. older same-UID refresh finishing BEFORE a newer refresh: newer still wins', async () => {
  const d = makeDriver()
  d.onAuth('A'); d.resolveFetch(SUBSCRIBED); await tick()
  const older = d.refresh()
  d.resolveFetch(NON_PRO)                    // older resolves first (non-Pro) but it is NOT the newest
  const newer = d.refresh()                  // newer starts → older superseded
  assertEqual(await older, 'error', 'older refresh already superseded → stale')
  d.resolveFetch(SUBSCRIBED)
  assertEqual(await newer, SUBSCRIBED)
  assertEqual(hasProAccess(d.status), true)
})

test('3. UID switch during an outstanding refresh → discarded', async () => {
  const d = makeDriver()
  d.onAuth('A'); d.resolveFetch(SUBSCRIBED); await tick()
  const p = d.refresh()          // refresh for A pending
  d.onAuth('B')                  // switch to B (fetch for B pending)
  d.resolveFetch(SUBSCRIBED)     // resolves A's refresh → stale
  assertEqual(await p, 'error')
  assertEqual(d.status, null, 'B is still loading; A refresh must not apply')
})

test('4. sign-out during a refresh → discarded, status cleared', async () => {
  const d = makeDriver()
  d.onAuth('A'); d.resolveFetch(SUBSCRIBED); await tick()
  const p = d.refresh()
  d.onAuth(null)                 // sign-out clears + invalidates
  d.resolveFetch(SUBSCRIBED)
  assertEqual(await p, 'error')
  assertEqual(d.status, null)
  assertEqual(hasProAccess(d.status), false)
})

test('5. unmount (deactivate) during a refresh → discarded', async () => {
  const d = makeDriver()
  d.onAuth('A'); d.resolveFetch(NON_PRO); await tick()
  const p = d.refresh()
  d.ctl.deactivate()
  d.resolveFetch(SUBSCRIBED)
  assertEqual(await p, 'error', 'unmounted refresh must not apply or grant')
})

test('6. same-UID TOKEN_REFRESHED event keeps valid state', async () => {
  const d = makeDriver()
  d.onAuth('A'); d.resolveFetch(SUBSCRIBED); await tick()
  d.onAuth('A')                  // token refresh, same uid → ignore
  assertEqual(hasProAccess(d.status), true)
})

// ── Account switch semantics still hold ────────────────────────────────────────
test('subscribed A → non-Pro B: B never sees A\'s Pro', async () => {
  const d = makeDriver()
  d.onAuth('A'); d.resolveFetch(SUBSCRIBED); await tick()
  d.onAuth('B'); assertEqual(d.status, null)
  d.resolveFetch(NON_PRO); await tick()
  assertEqual(hasProAccess(d.status), false)
})
test('non-Pro A → subscribed B: B becomes Pro', async () => {
  const d = makeDriver()
  d.onAuth('A'); d.resolveFetch(NON_PRO); await tick()
  d.onAuth('B'); d.resolveFetch(SUBSCRIBED); await tick()
  assertEqual(hasProAccess(d.status), true)
})
test('provider error fails closed (unavailable)', async () => {
  const d = makeDriver()
  d.onAuth('A'); d.resolveFetch(null); await tick()
  assertEqual(d.status, 'error')
  assertEqual(hasProAccess(d.status), false)
})

// ── Source contract: provider wires the real controller + exposes auth identity ─
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'useProStatus.js'), 'utf8')
test('ProStatusProvider uses createProStatusController + exposes authUserId/accountGeneration', () => {
  assert(src.includes('createProStatusController('), 'must own a controller')
  assert(src.includes('ctl.beginRefresh('), 'refresh must mint a new token via beginRefresh')
  assert(src.includes('ctl.canApply('), 'must gate results via canApply')
  assert(src.includes('onAuthStateChange'), 'must subscribe to auth changes')
  assert(src.includes('export function useProAuthUserId'), 'must expose authUserId')
  assert(src.includes('export function useProAccountGeneration'), 'must expose accountGeneration')
})

for (const { name, fn } of RUN) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
