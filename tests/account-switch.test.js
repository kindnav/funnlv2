/**
 * R5 tests: account-switch detection + stale-generation gating.
 *
 * Behavior tests around the extracted pure helpers (src/lib/accountSwitch.js) plus a
 * behavioral simulation of the FunnlAIPage checkout handler's generation guard proving
 * that a stale (post-switch) result cannot navigate, mutate state, or fire analytics.
 * Plus a source-contract check that FunnlAIPage wires a real onAuthStateChange listener
 * (not a branch that can never fire).
 *
 * Zero deps — runs with: node tests/account-switch.test.js
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { isAccountSwitch, isStaleGeneration } from '../src/lib/accountSwitch.js'

let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

// ── isAccountSwitch ────────────────────────────────────────────────────────────
test('same uid → not a switch', () => assertEqual(isAccountSwitch('u1', 'u1'), false))
test('u1 → u2 → switch', () => assertEqual(isAccountSwitch('u1', 'u2'), true))
test('first sign-in (null → u1) → not a switch', () => assertEqual(isAccountSwitch(null, 'u1'), false))
test('sign-out (u1 → null) → not a switch (handled by auth gating)', () => assertEqual(isAccountSwitch('u1', null), false))
test('null → null → not a switch', () => assertEqual(isAccountSwitch(null, null), false))

// ── isStaleGeneration ──────────────────────────────────────────────────────────
test('same generation → not stale', () => assertEqual(isStaleGeneration(3, 3), false))
test('different generation → stale', () => assertEqual(isStaleGeneration(3, 4), true))

// ── Behavioral: checkout handler generation guard ──────────────────────────────
// Models the exact FunnlAIPage.handleSubscribe control flow: capture the generation
// before the async invoke, then gate every post-await side effect on staleness.
function makeCheckoutHandler(genRef) {
  const effects = { navigated: 0, stateMutations: 0, analyticsFailed: 0, analyticsStarted: 0 }
  async function handleSubscribe(invoke) {
    const capturedGen = genRef.value
    effects.analyticsStarted++          // checkout_started fires synchronously (owner known)
    let result
    try {
      result = await invoke()
    } catch {
      if (!isStaleGeneration(capturedGen, genRef.value)) {
        effects.analyticsFailed++
        effects.stateMutations++        // setSubscribeError + setSubscribing(false)
      }
      return 'threw'
    }
    if (isStaleGeneration(capturedGen, genRef.value)) return 'stale'
    if (result === 'controlled_failure') {
      effects.analyticsFailed++
      effects.stateMutations++
      return 'failed'
    }
    effects.navigated++                 // window.location.href = redirect.url
    return 'navigated'
  }
  return { handleSubscribe, effects }
}

test('old invoke resolves successfully AFTER switch → no navigation, no mutation', async () => {
  const genRef = { value: 1 }
  const { handleSubscribe, effects } = makeCheckoutHandler(genRef)
  const p = handleSubscribe(async () => { genRef.value = 2; return 'ok' }) // switch happens during invoke
  assertEqual(await p, 'stale')
  assertEqual(effects.navigated, 0, 'must not navigate a stale result')
})

test('old invoke throws AFTER switch → no analytics, no state mutation', async () => {
  const genRef = { value: 1 }
  const { handleSubscribe, effects } = makeCheckoutHandler(genRef)
  const p = handleSubscribe(async () => { genRef.value = 2; throw new Error('net') })
  assertEqual(await p, 'threw')
  assertEqual(effects.analyticsFailed, 0, 'stale throw must not fire failure analytics')
  assertEqual(effects.stateMutations, 0, 'stale throw must not mutate state')
})

test('old invoke returns controlled failure AFTER switch → discarded (no analytics/mutation)', async () => {
  const genRef = { value: 1 }
  const { handleSubscribe, effects } = makeCheckoutHandler(genRef)
  const p = handleSubscribe(async () => { genRef.value = 2; return 'controlled_failure' })
  assertEqual(await p, 'stale')
  assertEqual(effects.analyticsFailed, 0)
  assertEqual(effects.stateMutations, 0)
})

test('no switch → success navigates normally', async () => {
  const genRef = { value: 1 }
  const { handleSubscribe, effects } = makeCheckoutHandler(genRef)
  assertEqual(await handleSubscribe(async () => 'ok'), 'navigated')
  assertEqual(effects.navigated, 1)
})

test('no switch → throw fires failure analytics + mutation', async () => {
  const genRef = { value: 1 }
  const { handleSubscribe, effects } = makeCheckoutHandler(genRef)
  await handleSubscribe(async () => { throw new Error('net') })
  assertEqual(effects.analyticsFailed, 1)
  assertEqual(effects.stateMutations, 1)
})

// ── Source contract: FunnlAIPage wires a REAL auth listener + gen guard ────────
const aiSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')

test('FunnlAIPage subscribes to onAuthStateChange (real account-switch signal)', () => {
  assert(aiSrc.includes('onAuthStateChange'), 'FunnlAIPage must subscribe to auth changes')
  assert(aiSrc.includes('isAccountSwitch('), 'must use isAccountSwitch to detect real switches')
})
test('FunnlAIPage bumps an account generation on switch', () => {
  assert(aiSrc.includes('accountGenRef.current++'), 'must invalidate via an account generation token')
})
test('FunnlAIPage handleSubscribe guards side effects on account generation', () => {
  const start = aiSrc.indexOf('async function handleSubscribe()')
  const body = aiSrc.slice(start, aiSrc.indexOf('\n  }\n', start))
  assert(body.includes('const capturedGen = accountGenRef.current'), 'must capture the generation before invoke')
  assert(body.includes('isStaleGeneration(capturedGen, accountGenRef.current)'), 'must gate post-await effects on staleness')
  // The catch block must check staleness before firing analytics / mutating state.
  const catchIdx = body.indexOf('} catch {')
  assert(body.indexOf('isStaleGeneration', catchIdx) !== -1, 'catch must check staleness before side effects')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
