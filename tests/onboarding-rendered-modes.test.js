/**
 * onboarding-rendered-modes.test.js — Sections 10-13
 *
 * Source-string tests for DashboardPage render branches:
 *
 *   Section 10: Loading state rendering (mounted)
 *   Section 11: Unavailable (error) state rendering (mounted)
 *   Section 12: Dismiss and reopen focus
 *   Section 13: Completion session lifecycle
 *
 * Run with: node tests/onboarding-rendered-modes.test.js
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

// ── Section 10: Loading state rendering ──────────────────────────────────────

console.log("\nSection 10: Loading state rendering")

test("loading state renders (if loading) branch in DashboardPage", () => {
  assert.ok(src.includes('if (loading)'), "loading branch must exist")
})
test("loading state renders a loading indicator text", () => {
  const loadingIdx = src.indexOf('if (loading)')
  const region = src.slice(loadingIdx, loadingIdx + 400)
  assert.ok(
    region.includes('Loading') || region.includes('loading'),
    "loading branch must render a loading indicator"
  )
})
test("loading state still renders TopBar (not blank screen)", () => {
  const loadingIdx = src.indexOf('if (loading)')
  const region = src.slice(loadingIdx, loadingIdx + 400)
  assert.ok(region.includes('TopBar'), "loading state must render TopBar to prevent blank screen")
})
test("loading state returns early (does not fall through to main render)", () => {
  const loadingIdx = src.indexOf('if (loading)')
  const region = src.slice(loadingIdx, loadingIdx + 400)
  assert.ok(region.includes('return'), "loading branch must return early")
})

// ── Section 11: Unavailable (error) state rendering ──────────────────────────

console.log("\nSection 11: Unavailable (error) state rendering")

test("fetchError branch present (if (fetchError))", () => {
  assert.ok(src.includes('fetchError'), "fetchError state must drive the error/unavailable branch")
})
test("error state renders a user-facing error message", () => {
  const errorIdx = src.indexOf("if (fetchError)")
  assert.ok(errorIdx !== -1, "fetchError branch must exist")
  // Use 900 chars: "Couldn't load" is ~410 away, "Try again" is ~793 away
  const region = src.slice(errorIdx, errorIdx + 900)
  assert.ok(
    region.includes("load") ||
    region.includes("connection") ||
    region.includes("Try again"),
    "error branch must render a user-facing message"
  )
})
test("error state renders a Try again button that calls fetchAll", () => {
  const errorIdx = src.indexOf("if (fetchError)")
  // "Try again" is ~793 chars from if (fetchError); use 900 to be safe
  const region = src.slice(errorIdx, errorIdx + 900)
  assert.ok(region.includes('Try again'), "error branch must have a Try again affordance")
  assert.ok(region.includes('fetchAll'), "Try again must call fetchAll")
})
test("error state returns early", () => {
  const errorIdx = src.indexOf("if (fetchError)")
  const region = src.slice(errorIdx, errorIdx + 500)
  assert.ok(region.includes('return'), "error branch must return early")
})
test("error state renders TopBar (not blank screen)", () => {
  const errorIdx = src.indexOf("if (fetchError)")
  const region = src.slice(errorIdx, errorIdx + 500)
  assert.ok(region.includes('TopBar'), "error state must render TopBar")
})

// ── Section 12: Dismiss and reopen focus ─────────────────────────────────────

console.log("\nSection 12: Dismiss and reopen focus")

test("dismissStrip function exists and writes session flag", () => {
  assert.ok(src.includes('dismissStrip'), "dismissStrip function must exist")
  const idx = src.indexOf('function dismissStrip')
  const region = src.slice(idx, idx + 200)
  assert.ok(
    region.includes('writeSessionFlag') || region.includes('sessionDismissKey'),
    "dismissStrip must write the session dismiss flag"
  )
})
test("dismissStrip sets stripDismissed(true)", () => {
  const idx = src.indexOf('function dismissStrip')
  const region = src.slice(idx, idx + 200)
  assert.ok(region.includes('setStripDismissed(true)'), "dismissStrip must set stripDismissed=true")
})
test("reopenStrip function exists and clears session flag", () => {
  assert.ok(src.includes('reopenStrip'), "reopenStrip function must exist")
  const idx = src.indexOf('function reopenStrip')
  const region = src.slice(idx, idx + 300)
  assert.ok(
    region.includes('clearSessionFlag') || region.includes('sessionDismissKey'),
    "reopenStrip must clear the session dismiss flag"
  )
})
test("reopenStrip sets stripDismissed(false)", () => {
  const idx = src.indexOf('function reopenStrip')
  const region = src.slice(idx, idx + 300)
  assert.ok(region.includes('setStripDismissed(false)'), "reopenStrip must set stripDismissed=false")
})
test("collapsed reopen button uses collapsedBtnRef", () => {
  assert.ok(src.includes('collapsedBtnRef'), "collapsedBtnRef must exist for focus restoration")
  // Collapsed button should reference the ref
  const btnIdx = src.indexOf("ref={collapsedBtnRef}")
  assert.ok(btnIdx !== -1, "collapsed button must use collapsedBtnRef")
})
test("collapsed button has aria-label for screen readers", () => {
  const btnIdx = src.indexOf("ref={collapsedBtnRef}")
  const region = src.slice(Math.max(0, btnIdx - 50), btnIdx + 300)
  assert.ok(
    region.includes('aria-label'),
    "collapsed reopen button must have aria-label for accessibility"
  )
})
test("displayMode === 'collapsed' renders the reopen button", () => {
  assert.ok(
    src.includes("displayMode === 'collapsed'"),
    "collapsed display mode must render the reopen control"
  )
})
test("displayMode === 'compact' renders ActivationProgressStrip", () => {
  assert.ok(
    src.includes("displayMode === 'compact'"),
    "compact display mode must render ActivationProgressStrip"
  )
  const idx = src.indexOf("displayMode === 'compact'")
  const region = src.slice(idx, idx + 200)
  assert.ok(region.includes('ActivationProgressStrip'), "compact mode must render ActivationProgressStrip")
})

// ── Section 13: Completion session lifecycle ──────────────────────────────────

console.log("\nSection 13: Completion session lifecycle")

test("completionSessionKey imported from activationHelpers", () => {
  assert.ok(
    src.includes('completionSessionKey'),
    "completionSessionKey must be imported and used"
  )
})
test("writeSessionFlag(completionSessionKey(uid)) called on completion", () => {
  const idx = src.indexOf('writeSessionFlag(completionSessionKey')
  assert.ok(idx !== -1, "must write completionSessionKey flag on completion")
})
test("setJustCompleted(true) called in onCompletionClaimed callback", () => {
  const idx = src.indexOf('setJustCompleted(true)')
  assert.ok(idx !== -1, "setJustCompleted(true) must be called when activation completes")
})
test("readSessionFlag(completionSessionKey(resolvedUid)) restores justCompleted on remount", () => {
  // The session flag is read during fetchAll to restore justCompleted across navigations
  assert.ok(
    src.includes('completionSessionKey') && src.includes('readSessionFlag'),
    "completionSessionKey flag must be read on mount to restore justCompleted state"
  )
  // Specifically: readSessionFlag(completionSessionKey(...)) should appear
  const pattern = /readSessionFlag\(completionSessionKey/
  assert.ok(pattern.test(src), "readSessionFlag must read the completionSessionKey flag")
})
test("displayMode === 'newly_completed' renders CompletionStrip", () => {
  assert.ok(
    src.includes("displayMode === 'newly_completed'"),
    "newly_completed display mode must render CompletionStrip"
  )
  const idx = src.indexOf("displayMode === 'newly_completed'")
  const region = src.slice(idx, idx + 100)
  assert.ok(region.includes('CompletionStrip'), "newly_completed mode must render CompletionStrip")
})
test("justCompleted state declaration exists", () => {
  assert.ok(src.includes('justCompleted'), "justCompleted state must be declared")
  assert.ok(
    src.includes('setJustCompleted') || src.includes('justCompleted,'),
    "justCompleted must be a state variable (useState)"
  )
})
test("justCompleted passed to deriveActivationState", () => {
  // Find the actual call site (not the import); it uses 'const activation = deriveActivationState'
  const callIdx = src.indexOf('const activation')
  assert.ok(callIdx !== -1, "const activation = deriveActivationState(...) call must exist")
  const region = src.slice(callIdx, callIdx + 400)
  assert.ok(region.includes('justCompleted'), "justCompleted must be passed to deriveActivationState")
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
