/**
 * onboarding-account-switch.test.js — Sections 8-9
 *
 * Section 8: Immediate account-switch reset via supabase.auth.onAuthStateChange
 *   - onAuthStateChange effect present
 *   - Increments fetchGenRef.current before clearing state
 *   - Clears all user-scoped state (milestones, displayName, justCompleted, etc.)
 *   - Unsubscribes on cleanup
 *
 * Section 9: Stale-fetch generation ref protection in fetchAll
 *   - fetchGenRef declared as useRef(0)
 *   - gen captured at start of fetchAll (++fetchGenRef.current)
 *   - Check after getSession() await
 *   - Check after Promise.all() await
 *   - quiet param guards loading/error state changes
 *   - quiet param guards account-switch reset
 *   - quiet param guards flag-reading
 *
 * Run with: node tests/onboarding-account-switch.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'

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

const src = readFileSync(resolve('src/pages/DashboardPage.jsx'), 'utf8')

// ── Section 8: onAuthStateChange immediate reset ──────────────────────────────

console.log("\nSection 8: Immediate account-switch reset (onAuthStateChange)")

test("supabase.auth.onAuthStateChange used in DashboardPage", () => {
  assert.ok(src.includes('onAuthStateChange'), "DashboardPage must use onAuthStateChange")
})
test("onAuthStateChange is inside a useEffect", () => {
  const idx = src.indexOf('onAuthStateChange')
  assert.ok(idx !== -1, "onAuthStateChange must be present")
  // useEffect should appear before onAuthStateChange call (within 200 chars)
  const regionBefore = src.slice(Math.max(0, idx - 200), idx)
  assert.ok(regionBefore.includes('useEffect'), "onAuthStateChange must be inside a useEffect")
})
test("onAuthStateChange handler checks prevUidRef.current !== newUid", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(
    (region.includes('prevUidRef.current') && region.includes('newUid')) ||
    region.includes('prevUidRef.current !== null'),
    "onAuthStateChange handler must check prevUidRef.current for uid change detection"
  )
})
test("onAuthStateChange increments fetchGenRef.current before clearing state", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(
    region.includes('fetchGenRef.current++') || region.includes('++fetchGenRef.current'),
    "onAuthStateChange must invalidate in-flight fetches via fetchGenRef.current++"
  )
  // Ensure it happens before state clears (not after)
  const genIdx = region.indexOf('fetchGenRef.current')
  const msIdx = region.indexOf('setMilestones(null)')
  assert.ok(genIdx < msIdx, "fetchGenRef.current must be incremented before setMilestones(null)")
})
test("onAuthStateChange clears setMilestones(null)", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes('setMilestones(null)'), "must clear milestones on account switch")
})
test("onAuthStateChange clears setDisplayName(null)", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes('setDisplayName(null)'), "must clear displayName on account switch")
})
test("onAuthStateChange clears setJustCompleted(false)", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes('setJustCompleted(false)'), "must clear justCompleted on account switch")
})
test("onAuthStateChange clears setStripDismissed(false)", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes('setStripDismissed(false)'), "must clear stripDismissed on account switch")
})
test("onAuthStateChange clears setWelcomeSkipped(false)", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes('setWelcomeSkipped(false)'), "must clear welcomeSkipped on account switch")
})
test("onAuthStateChange clears setContactCount(0)", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes('setContactCount(0)'), "must clear contactCount on account switch")
})
test("onAuthStateChange clears setInteractionCount(0)", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes('setInteractionCount(0)'), "must clear interactionCount on account switch")
})
test("onAuthStateChange clears setHasFollowUp(false)", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes('setHasFollowUp(false)'), "must clear hasFollowUp on account switch")
})
test("onAuthStateChange updates prevUidRef.current to newUid", () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(
    region.includes('prevUidRef.current = newUid') || region.includes('prevUidRef.current=newUid'),
    "onAuthStateChange must update prevUidRef.current to the new uid"
  )
})
test("onAuthStateChange useEffect returns subscription.unsubscribe()", () => {
  assert.ok(
    src.includes('subscription.unsubscribe'),
    "onAuthStateChange useEffect must clean up by calling subscription.unsubscribe()"
  )
})

// ── Section 9: Stale-fetch generation ref ────────────────────────────────────

console.log("\nSection 9: Stale-fetch generation ref in fetchAll")

test("fetchGenRef declared as useRef(0)", () => {
  assert.ok(
    src.includes('fetchGenRef') && src.includes('useRef(0)'),
    "fetchGenRef must be declared with useRef(0)"
  )
})
test("fetchGenRef comes before fetchAll in source order", () => {
  const refIdx = src.indexOf('fetchGenRef')
  const fetchAllIdx = src.indexOf('async function fetchAll')
  assert.ok(refIdx < fetchAllIdx, "fetchGenRef declaration must precede fetchAll definition")
})
test("fetchAll captures gen at its start (++fetchGenRef.current)", () => {
  const fetchAllIdx = src.indexOf('async function fetchAll')
  assert.ok(fetchAllIdx !== -1, "fetchAll must exist")
  // gen assignment must be within the first 100 chars of the function body
  const fnStart = src.slice(fetchAllIdx, fetchAllIdx + 200)
  assert.ok(
    fnStart.includes('++fetchGenRef.current'),
    "fetchAll must increment and capture fetchGenRef.current near its start"
  )
})
test("gen captured into a local const", () => {
  const fetchAllIdx = src.indexOf('async function fetchAll')
  const fnStart = src.slice(fetchAllIdx, fetchAllIdx + 200)
  assert.ok(
    fnStart.includes('const gen') || fnStart.includes('let gen'),
    "fetchAll must capture the generation into a local variable (const gen)"
  )
})
test("stale check after first async operation (getSession)", () => {
  // fetchGenRef.current !== gen guard must appear after the getSession await
  const getSessionIdx = src.indexOf('supabase.auth.getSession()')
  assert.ok(getSessionIdx !== -1, "getSession call must exist")
  const region = src.slice(getSessionIdx, getSessionIdx + 200)
  assert.ok(
    region.includes('fetchGenRef.current !== gen'),
    "stale check must appear shortly after getSession() to abort superseded fetches"
  )
})
test("stale check after Promise.all DB queries", () => {
  // fetchGenRef.current !== gen guard must appear after Promise.all
  const promiseAllIdx = src.indexOf('await Promise.all([')
  assert.ok(promiseAllIdx !== -1, "Promise.all must exist in fetchAll")
  // The Promise.all span is large (long query strings) — use 900 chars to be safe
  const region = src.slice(promiseAllIdx, promiseAllIdx + 900)
  assert.ok(
    region.includes('fetchGenRef.current !== gen'),
    "stale check must appear after Promise.all to abort superseded fetches"
  )
})
test("two generation guards present (at least)", () => {
  const guardCount = (src.match(/fetchGenRef\.current !== gen/g) || []).length
  assert.ok(guardCount >= 2, `At least 2 generation guards required; found ${guardCount}`)
})

// ── quiet mode guards ─────────────────────────────────────────────────────────

console.log("\nquiet mode guards in fetchAll")

test("setLoading(true) guarded by !quiet", () => {
  const fetchAllIdx = src.indexOf('async function fetchAll')
  const fnBody = src.slice(fetchAllIdx, fetchAllIdx + 4000)
  // setLoading(true) should only appear inside a !quiet block
  const loadingIdx = fnBody.indexOf('setLoading(true)')
  assert.ok(loadingIdx !== -1, "setLoading(true) must exist in fetchAll")
  // The preceding ~50 chars should have !quiet
  const vicinity = fnBody.slice(Math.max(0, loadingIdx - 60), loadingIdx)
  assert.ok(
    vicinity.includes('!quiet') || vicinity.includes('quiet'),
    "setLoading(true) must be guarded by !quiet check"
  )
})
test("setFetchError guarded by !quiet", () => {
  const fetchAllIdx = src.indexOf('async function fetchAll')
  const fnBody = src.slice(fetchAllIdx, fetchAllIdx + 4000)
  const errorIdx = fnBody.indexOf('setFetchError(')
  assert.ok(errorIdx !== -1, "setFetchError must exist in fetchAll")
  // Guard check within 60 chars before the call
  const vicinity = fnBody.slice(Math.max(0, errorIdx - 60), errorIdx)
  assert.ok(
    vicinity.includes('!quiet') || vicinity.includes('quiet'),
    "setFetchError must be guarded by !quiet"
  )
})
test("setLoading(false) guarded by !quiet", () => {
  const fetchAllIdx = src.indexOf('async function fetchAll')
  const fnBody = src.slice(fetchAllIdx, fetchAllIdx + 4000)
  const loadingFalseIdx = fnBody.indexOf('setLoading(false)')
  assert.ok(loadingFalseIdx !== -1, "setLoading(false) must exist in fetchAll")
  const vicinity = fnBody.slice(Math.max(0, loadingFalseIdx - 80), loadingFalseIdx + 30)
  assert.ok(
    vicinity.includes('!quiet') || vicinity.includes('quiet'),
    "setLoading(false) must be guarded by !quiet"
  )
})
test("account-switch reset block guarded by !quiet", () => {
  // Strategy: find the !quiet block that wraps account-switch logic.
  // There are multiple !quiet guards in fetchAll; we find the one containing
  // the account-switch comment/code by scanning all !quiet occurrences.
  const fetchAllIdx = src.indexOf('async function fetchAll')
  const fnBody = src.slice(fetchAllIdx, fetchAllIdx + 4000)
  const switchPattern = 'prevUidRef.current !== null && prevUidRef.current !== resolvedUid'
  const switchIdx = fnBody.indexOf(switchPattern)
  assert.ok(switchIdx !== -1, "account-switch detection must exist in fetchAll")
  // Find the nearest !quiet guard before the switch pattern
  const beforeSwitch = fnBody.slice(0, switchIdx)
  const lastQuietIdx = beforeSwitch.lastIndexOf('if (!quiet)')
  assert.ok(lastQuietIdx !== -1, "!quiet guard must exist before account-switch detection")
  // The !quiet block should contain the switch pattern (within 800 chars of its start)
  const block = fnBody.slice(lastQuietIdx, lastQuietIdx + 800)
  assert.ok(
    block.includes('prevUidRef.current !== null') || block.includes('Account-switch'),
    "account-switch detection must be inside a !quiet block"
  )
})
test("flag-reading block (readSessionFlag) guarded by !quiet", () => {
  // Same strategy: find the !quiet block that contains readSessionFlag.
  const fetchAllIdx = src.indexOf('async function fetchAll')
  const fnBody = src.slice(fetchAllIdx, fetchAllIdx + 4000)
  const flagIdx = fnBody.indexOf('readSessionFlag')
  assert.ok(flagIdx !== -1, "readSessionFlag must exist in fetchAll")
  // Find the nearest !quiet guard before readSessionFlag
  const beforeFlag = fnBody.slice(0, flagIdx)
  const lastQuietIdx = beforeFlag.lastIndexOf('if (!quiet)')
  assert.ok(lastQuietIdx !== -1, "!quiet guard must exist before readSessionFlag")
  // The block from !quiet should contain readSessionFlag (within 800 chars)
  const block = fnBody.slice(lastQuietIdx, lastQuietIdx + 800)
  assert.ok(
    block.includes('readSessionFlag'),
    "readSessionFlag must be inside a !quiet block to preserve flag state during quiet refreshes"
  )
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
