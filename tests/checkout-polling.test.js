/**
 * Tests for src/lib/checkoutPolling.js
 *
 * Zero dependencies — runs with: node tests/checkout-polling.test.js
 */

import {
  POLL_DELAYS_MS,
  getNextPollDelay,
  runCheckoutPolling,
} from '../src/lib/checkoutPolling.js'

// ── Minimal test runner ───────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✓ ${name}`)
        passed++
      }).catch(e => {
        console.error(`  ✗ ${name}`)
        console.error(`    ${e.message}`)
        failed++
      })
    }
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    failed++
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'Assertion failed')
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// Synchronous sleep stub that records invocations.
function makeDelayFn() {
  const calls = []
  const fn = (ms) => { calls.push(ms); return Promise.resolve() }
  fn.calls = calls
  return fn
}

// ── POLL_DELAYS_MS ────────────────────────────────────────────────────────────

console.log('\nPOLL_DELAYS_MS constant')

test('is an array of 4 numbers', () => {
  assert(Array.isArray(POLL_DELAYS_MS))
  assertEqual(POLL_DELAYS_MS.length, 4)
  for (const d of POLL_DELAYS_MS) assert(typeof d === 'number' && d > 0)
})
test('total delay is at least 20 000ms', () => {
  const total = POLL_DELAYS_MS.reduce((a, b) => a + b, 0)
  assert(total >= 20000, `Total delay ${total}ms is below 20 000ms spec target`)
})
test('delays are in ascending order', () => {
  for (let i = 1; i < POLL_DELAYS_MS.length; i++) {
    assert(POLL_DELAYS_MS[i] >= POLL_DELAYS_MS[i - 1],
      `Delay at index ${i} (${POLL_DELAYS_MS[i]}) is less than previous (${POLL_DELAYS_MS[i - 1]})`)
  }
})

// ── getNextPollDelay ──────────────────────────────────────────────────────────

console.log('\ngetNextPollDelay')

test('returns POLL_DELAYS_MS[0] for attempt 0', () => {
  assertEqual(getNextPollDelay(0), POLL_DELAYS_MS[0])
})
test('returns POLL_DELAYS_MS[1] for attempt 1', () => {
  assertEqual(getNextPollDelay(1), POLL_DELAYS_MS[1])
})
test('returns POLL_DELAYS_MS[last] for the last valid attempt', () => {
  const last = POLL_DELAYS_MS.length - 1
  assertEqual(getNextPollDelay(last), POLL_DELAYS_MS[last])
})
test('returns null for attempt equal to length (one past last)', () => {
  assertEqual(getNextPollDelay(POLL_DELAYS_MS.length), null)
})
test('returns null for a negative attempt number', () => {
  assertEqual(getNextPollDelay(-1), null)
})
test('returns null for attempt well beyond length', () => {
  assertEqual(getNextPollDelay(100), null)
})

// ── runCheckoutPolling — confirmed ────────────────────────────────────────────

console.log('\nrunCheckoutPolling — confirmed')

const polls = []

test('returns confirmed when hasAccessFn returns true after first refresh', async () => {
  const delay = makeDelayFn()
  let refreshCount = 0
  const result = await runCheckoutPolling({
    refreshFn:   async () => { refreshCount++ },
    hasAccessFn: () => refreshCount >= 1,  // true after first refresh
    signal:      new AbortController().signal,
    delayFn:     delay,
  })
  assertEqual(result, 'confirmed')
})

test('calls refreshFn once when confirmed on first attempt', async () => {
  const delay = makeDelayFn()
  let refreshCount = 0
  await runCheckoutPolling({
    refreshFn:   async () => { refreshCount++ },
    hasAccessFn: () => refreshCount >= 1,
    signal:      new AbortController().signal,
    delayFn:     delay,
  })
  assertEqual(refreshCount, 1)
})

test('uses the first staged delay on the first wait', async () => {
  const delay = makeDelayFn()
  let refreshCount = 0
  await runCheckoutPolling({
    refreshFn:   async () => { refreshCount++ },
    hasAccessFn: () => refreshCount >= 1,
    signal:      new AbortController().signal,
    delayFn:     delay,
  })
  assertEqual(delay.calls[0], POLL_DELAYS_MS[0])
})

test('returns confirmed on the third refresh attempt', async () => {
  const delay = makeDelayFn()
  let refreshCount = 0
  const result = await runCheckoutPolling({
    refreshFn:   async () => { refreshCount++ },
    hasAccessFn: () => refreshCount >= 3,  // takes 3 tries
    signal:      new AbortController().signal,
    delayFn:     delay,
  })
  assertEqual(result, 'confirmed')
  assertEqual(refreshCount, 3)
})

test('uses staged delays in order when confirming on third attempt', async () => {
  const delay = makeDelayFn()
  let refreshCount = 0
  await runCheckoutPolling({
    refreshFn:   async () => { refreshCount++ },
    hasAccessFn: () => refreshCount >= 3,
    signal:      new AbortController().signal,
    delayFn:     delay,
  })
  assertEqual(delay.calls[0], POLL_DELAYS_MS[0])
  assertEqual(delay.calls[1], POLL_DELAYS_MS[1])
  assertEqual(delay.calls[2], POLL_DELAYS_MS[2])
})

// ── runCheckoutPolling — timeout ──────────────────────────────────────────────

console.log('\nrunCheckoutPolling — timeout')

test('returns timeout when hasAccessFn never returns true', async () => {
  const delay = makeDelayFn()
  let refreshCount = 0
  const result = await runCheckoutPolling({
    refreshFn:   async () => { refreshCount++ },
    hasAccessFn: () => false,
    signal:      new AbortController().signal,
    delayFn:     delay,
  })
  assertEqual(result, 'timeout')
})

test('calls refreshFn exactly POLL_DELAYS_MS.length times on timeout', async () => {
  const delay = makeDelayFn()
  let refreshCount = 0
  await runCheckoutPolling({
    refreshFn:   async () => { refreshCount++ },
    hasAccessFn: () => false,
    signal:      new AbortController().signal,
    delayFn:     delay,
  })
  assertEqual(refreshCount, POLL_DELAYS_MS.length)
})

test('uses all staged delays on timeout', async () => {
  const delay = makeDelayFn()
  await runCheckoutPolling({
    refreshFn:   async () => {},
    hasAccessFn: () => false,
    signal:      new AbortController().signal,
    delayFn:     delay,
  })
  assertEqual(delay.calls.length, POLL_DELAYS_MS.length)
  for (let i = 0; i < POLL_DELAYS_MS.length; i++) {
    assertEqual(delay.calls[i], POLL_DELAYS_MS[i])
  }
})

// ── runCheckoutPolling — aborted ──────────────────────────────────────────────

console.log('\nrunCheckoutPolling — aborted (signal already aborted)')

test('returns aborted immediately when signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const delay = makeDelayFn()
  let refreshCount = 0
  const result = await runCheckoutPolling({
    refreshFn:   async () => { refreshCount++ },
    hasAccessFn: () => false,
    signal:      controller.signal,
    delayFn:     delay,
  })
  assertEqual(result, 'aborted')
  assertEqual(refreshCount, 0, 'refreshFn must not be called when signal is already aborted')
  assertEqual(delay.calls.length, 0, 'delay must not be called when signal is already aborted')
})

test('returns aborted (signal aborted mid-loop in delay)', async () => {
  const controller = new AbortController()
  let delayCallCount = 0
  // Abort during the first delay
  const delayFn = async (ms) => {
    delayCallCount++
    controller.abort()
  }
  let refreshCount = 0
  const result = await runCheckoutPolling({
    refreshFn:   async () => { refreshCount++ },
    hasAccessFn: () => false,
    signal:      controller.signal,
    delayFn,
  })
  assertEqual(result, 'aborted')
  // The first delay ran (then abort was called), so refreshFn should not have run
  assertEqual(refreshCount, 0)
  assertEqual(delayCallCount, 1)
})

// ── Summary ───────────────────────────────────────────────────────────────────

// Wait for all async tests to settle
setTimeout(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}, 100)
