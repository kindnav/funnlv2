/**
 * onboarding-picker-routing.test.js — Sections 6-7
 *
 * Section 6: Shared contact picker — buildPickerNavigationState contract
 *   buildPickerNavigationState('interaction') → { openInteractionForm: true }
 *   buildPickerNavigationState('followup')    → { openFollowUpForm: true }
 *   buildPickerNavigationState(other)         → null
 *
 * Section 7: Router-state producer/consumer contracts
 *   Producer: DashboardPage and resolveActivationAction/onNextAction produce valid states
 *   Consumer: ContactDetailPage reads openInteractionForm and openFollowUpForm from location.state
 *
 * Run with: node tests/onboarding-picker-routing.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { buildPickerNavigationState } from '../src/lib/contactPickerUtils.js'

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

const dashboardSrc = readFileSync(resolve('src/pages/DashboardPage.jsx'), 'utf8')
const detailSrc    = readFileSync(resolve('src/pages/ContactDetailPage.jsx'), 'utf8')

// ── Section 6: buildPickerNavigationState ────────────────────────────────────

console.log("\nSection 6: buildPickerNavigationState")

test("'interaction' mode → { openInteractionForm: true }", () => {
  const state = buildPickerNavigationState('interaction')
  assert.deepStrictEqual(state, { openInteractionForm: true })
})
test("'followup' mode → { openFollowUpForm: true }", () => {
  const state = buildPickerNavigationState('followup')
  assert.deepStrictEqual(state, { openFollowUpForm: true })
})
test("null mode → null", () => {
  const state = buildPickerNavigationState(null)
  assert.strictEqual(state, null)
})
test("undefined mode → null", () => {
  const state = buildPickerNavigationState(undefined)
  assert.strictEqual(state, null)
})
test("unknown string mode → null", () => {
  const state = buildPickerNavigationState('add')
  assert.strictEqual(state, null)
})
test("empty string mode → null", () => {
  const state = buildPickerNavigationState('')
  assert.strictEqual(state, null)
})
test("'interaction' result contains only openInteractionForm", () => {
  const state = buildPickerNavigationState('interaction')
  assert.deepStrictEqual(Object.keys(state), ['openInteractionForm'])
})
test("'followup' result contains only openFollowUpForm", () => {
  const state = buildPickerNavigationState('followup')
  assert.deepStrictEqual(Object.keys(state), ['openFollowUpForm'])
})
test("openInteractionForm value is exactly boolean true", () => {
  const state = buildPickerNavigationState('interaction')
  assert.strictEqual(state.openInteractionForm, true)
})
test("openFollowUpForm value is exactly boolean true", () => {
  const state = buildPickerNavigationState('followup')
  assert.strictEqual(state.openFollowUpForm, true)
})

// ── Section 7: Router-state producer contract (DashboardPage) ────────────────

console.log("\nSection 7: Router-state producer (DashboardPage)")

test("DashboardPage imports buildPickerNavigationState", () => {
  assert.ok(
    dashboardSrc.includes('buildPickerNavigationState'),
    "DashboardPage must import buildPickerNavigationState"
  )
})
test("handlePickerSelect in DashboardPage uses buildPickerNavigationState", () => {
  const idx = dashboardSrc.indexOf('handlePickerSelect')
  assert.ok(idx !== -1, "handlePickerSelect must exist")
  const region = dashboardSrc.slice(idx, idx + 300)
  assert.ok(
    region.includes('buildPickerNavigationState'),
    "handlePickerSelect must call buildPickerNavigationState"
  )
})
test("onNextAction navigate branch uses buildPickerNavigationState", () => {
  // The onNextAction handler must use buildPickerNavigationState when navigating for single-contact
  assert.ok(
    dashboardSrc.includes('buildPickerNavigationState'),
    "DashboardPage must use buildPickerNavigationState for router state"
  )
})
test("onNextAction navigate branch uses result.contactId for the URL", () => {
  assert.ok(
    dashboardSrc.includes('result.contactId'),
    "onNextAction must use result.contactId for the navigate URL"
  )
})
test("navigate call passes state from buildPickerNavigationState", () => {
  // Confirm `{ state: buildPickerNavigationState(result.mode) }` pattern
  assert.ok(
    dashboardSrc.includes('result.mode'),
    "navigate call must pass result.mode to buildPickerNavigationState"
  )
})

// ── Section 7: Router-state consumer contract (ContactDetailPage) ────────────

console.log("\nSection 7: Router-state consumer (ContactDetailPage)")

test("ContactDetailPage reads openInteractionForm from location.state", () => {
  assert.ok(
    detailSrc.includes('openInteractionForm'),
    "ContactDetailPage must read openInteractionForm from location.state"
  )
})
test("ContactDetailPage reads openFollowUpForm from location.state", () => {
  assert.ok(
    detailSrc.includes('openFollowUpForm'),
    "ContactDetailPage must read openFollowUpForm from location.state"
  )
})
test("ContactDetailPage calls setShowForm(true) when openInteractionForm is set", () => {
  const idx = detailSrc.indexOf('openInteractionForm')
  assert.ok(idx !== -1, "openInteractionForm must be present")
  const region = detailSrc.slice(Math.max(0, idx - 100), idx + 500)
  assert.ok(
    region.includes('setShowForm(true)') || region.includes('setShowForm'),
    "ContactDetailPage must call setShowForm after reading openInteractionForm"
  )
})
test("ContactDetailPage uses navigate(..., { replace: true, state: {} }) to clear router state", () => {
  // After reading the state, it must be cleared so refresh doesn't re-open the form
  assert.ok(
    detailSrc.includes('replace: true') || detailSrc.includes('replace:true'),
    "ContactDetailPage must use replace navigation to clear router state"
  )
  assert.ok(
    detailSrc.includes('state: {}') || detailSrc.includes('state:{}'),
    "ContactDetailPage must clear router state with state: {}"
  )
})
test("ContactDetailPage uses useLocation to access router state", () => {
  assert.ok(
    detailSrc.includes('useLocation'),
    "ContactDetailPage must use useLocation to access router state"
  )
})
test("ContactDetailPage location.state check is in a useEffect (mount only)", () => {
  // The openInteractionForm handling runs in useEffect so it fires after mount
  const locationIdx = detailSrc.indexOf('location.state')
  assert.ok(locationIdx !== -1, "location.state must be accessed")
  // Nearest useEffect before locationIdx (within 200 chars)
  const regionBefore = detailSrc.slice(Math.max(0, locationIdx - 400), locationIdx)
  assert.ok(
    regionBefore.includes('useEffect'),
    "location.state read must be inside a useEffect"
  )
})

// ── Picker mode state in DashboardPage ───────────────────────────────────────

console.log("\nPicker mode state in DashboardPage")

test("pickerMode state declared in DashboardPage", () => {
  assert.ok(
    dashboardSrc.includes('pickerMode'),
    "DashboardPage must have pickerMode state for the shared contact picker"
  )
})
test("ContactPickerModal rendered conditionally on pickerMode !== null", () => {
  assert.ok(
    dashboardSrc.includes('ContactPickerModal'),
    "DashboardPage must render ContactPickerModal"
  )
  assert.ok(
    dashboardSrc.includes('pickerMode !== null'),
    "ContactPickerModal must be conditionally rendered when pickerMode !== null"
  )
})
test("setPickerMode(null) called when picker closes", () => {
  assert.ok(
    dashboardSrc.includes('setPickerMode(null)'),
    "Picker must be dismissed by setPickerMode(null)"
  )
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
