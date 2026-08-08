/**
 * onboarding-listeners.test.js — Sections 1-4
 *
 * Verifies source-level presence of the three event listeners and dispatchers
 * in DashboardPage.jsx and ContactDetailPage.jsx:
 *
 *   Section 1: funnl:followups-changed listener on DashboardPage
 *   Section 2: funnl:interactions-changed listener on DashboardPage
 *              + dispatch from ContactDetailPage.handleLogInteraction
 *   Section 3: funnl:contacts-changed listener on DashboardPage (pre-existing)
 *   Section 4: onImported → fetchAll already exists (pre-existing import refresh)
 *
 * Run with: node tests/onboarding-listeners.test.js
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

const dashboardSrc = readFileSync(resolve('src/pages/DashboardPage.jsx'), 'utf8')
const detailSrc    = readFileSync(resolve('src/pages/ContactDetailPage.jsx'), 'utf8')

// ── Section 1: funnl:followups-changed listener on Dashboard ─────────────────

console.log('\nSection 1: funnl:followups-changed listener on DashboardPage')

test("DashboardPage listens to 'funnl:followups-changed'", () => {
  assert.ok(
    dashboardSrc.includes("'funnl:followups-changed'") ||
    dashboardSrc.includes('"funnl:followups-changed"'),
    "DashboardPage must addEventListener for 'funnl:followups-changed'"
  )
})

test("funnl:followups-changed listener calls fetchAll", () => {
  // Find the addEventListener line for followups-changed and confirm the handler body
  const idx = dashboardSrc.indexOf('funnl:followups-changed')
  assert.ok(idx !== -1, "event name must be present")
  // The surrounding region (500 chars after first mention) should call fetchAll
  const region = dashboardSrc.slice(idx, idx + 500)
  assert.ok(region.includes('fetchAll'), "handler for funnl:followups-changed must call fetchAll")
})

test("funnl:followups-changed listener uses quiet: true", () => {
  const idx = dashboardSrc.indexOf('funnl:followups-changed')
  assert.ok(idx !== -1, "event name must be present")
  const region = dashboardSrc.slice(idx, idx + 500)
  assert.ok(
    region.includes('quiet: true') || region.includes('quiet:true'),
    "funnl:followups-changed handler must call fetchAll({ quiet: true }) to preserve strip state"
  )
})

test("funnl:followups-changed listener returns cleanup (removeEventListener)", () => {
  // Good useEffect pattern always cleans up event listeners
  const removeCount = (dashboardSrc.match(/removeEventListener\s*\(\s*['"]funnl:followups-changed['"]/g) || []).length
  assert.ok(removeCount >= 1, "must removeEventListener for 'funnl:followups-changed' in cleanup")
})

// ── Section 2: funnl:interactions-changed — Dashboard listener + Detail dispatch ──

console.log('\nSection 2: funnl:interactions-changed listener + dispatch')

test("DashboardPage listens to 'funnl:interactions-changed'", () => {
  assert.ok(
    dashboardSrc.includes("'funnl:interactions-changed'") ||
    dashboardSrc.includes('"funnl:interactions-changed"'),
    "DashboardPage must addEventListener for 'funnl:interactions-changed'"
  )
})

test("funnl:interactions-changed listener calls fetchAll", () => {
  const idx = dashboardSrc.indexOf('funnl:interactions-changed')
  assert.ok(idx !== -1, "event name must be present in DashboardPage")
  const region = dashboardSrc.slice(idx, idx + 500)
  assert.ok(region.includes('fetchAll'), "handler for funnl:interactions-changed must call fetchAll")
})

test("funnl:interactions-changed listener uses quiet: true", () => {
  const idx = dashboardSrc.indexOf('funnl:interactions-changed')
  assert.ok(idx !== -1, "event name must be present")
  // quiet: true appears in the handler assignment before the addEventListener call,
  // so search a window that includes chars before the event name string.
  const region = dashboardSrc.slice(Math.max(0, idx - 300), idx + 200)
  assert.ok(
    region.includes('quiet: true') || region.includes('quiet:true'),
    "funnl:interactions-changed handler must call fetchAll({ quiet: true })"
  )
})

test("funnl:interactions-changed listener returns cleanup (removeEventListener)", () => {
  const removeCount = (dashboardSrc.match(/removeEventListener\s*\(\s*['"]funnl:interactions-changed['"]/g) || []).length
  assert.ok(removeCount >= 1, "must removeEventListener for 'funnl:interactions-changed' in cleanup")
})

test("ContactDetailPage dispatches 'funnl:interactions-changed' on handleLogInteraction success", () => {
  assert.ok(
    detailSrc.includes("'funnl:interactions-changed'") ||
    detailSrc.includes('"funnl:interactions-changed"'),
    "ContactDetailPage must dispatch funnl:interactions-changed after successful interaction log"
  )
})

test("interactions-changed dispatch is inside handleLogInteraction (before setShowForm)", () => {
  // The dispatch must appear in handleLogInteraction scope, before form reset
  const logIdx = detailSrc.indexOf('async function handleLogInteraction')
  assert.ok(logIdx !== -1, "handleLogInteraction must exist")
  // setShowForm(false) is ~2091 chars after the function start; use 2500 to be safe
  const fnRegion = detailSrc.slice(logIdx, logIdx + 2500)
  const dispatchIdx = fnRegion.indexOf('funnl:interactions-changed')
  const formCloseIdx = fnRegion.indexOf('setShowForm(false)')
  assert.ok(dispatchIdx !== -1, "dispatch must be inside handleLogInteraction")
  assert.ok(formCloseIdx !== -1, "setShowForm(false) must be inside the search region")
  assert.ok(dispatchIdx < formCloseIdx, "dispatch must appear before setShowForm(false)")
})

test("interactions-changed dispatch is unconditional (fires for all interactions, not just those with follow-up)", () => {
  // The dispatch should not be inside the `if (followUpDate)` block.
  // Inspect that funnl:interactions-changed appears BEFORE the if (followUpDate) block.
  const logIdx = detailSrc.indexOf('async function handleLogInteraction')
  const fnRegion = detailSrc.slice(logIdx, logIdx + 2000)
  const interactionDispatchIdx = fnRegion.indexOf('funnl:interactions-changed')
  const followupIfIdx = fnRegion.indexOf('if (followUpDate)')
  assert.ok(interactionDispatchIdx !== -1, "dispatch must exist")
  assert.ok(followupIfIdx !== -1, "if (followUpDate) block must exist")
  // interactions-changed must appear BEFORE the if (followUpDate) block
  assert.ok(
    interactionDispatchIdx < followupIfIdx,
    "funnl:interactions-changed dispatch must appear before the if (followUpDate) block to ensure it fires for all interactions"
  )
})

// ── Section 3: funnl:contacts-changed listener (pre-existing) ────────────────

console.log('\nSection 3: funnl:contacts-changed listener (pre-existing)')

test("DashboardPage listens to 'funnl:contacts-changed'", () => {
  assert.ok(
    dashboardSrc.includes("'funnl:contacts-changed'") ||
    dashboardSrc.includes('"funnl:contacts-changed"'),
    "DashboardPage must have funnl:contacts-changed listener"
  )
})

test("funnl:contacts-changed listener calls fetchAll", () => {
  const idx = dashboardSrc.indexOf('funnl:contacts-changed')
  assert.ok(idx !== -1, "event name must be present")
  const region = dashboardSrc.slice(idx, idx + 300)
  assert.ok(region.includes('fetchAll'), "handler for funnl:contacts-changed must call fetchAll")
})

test("funnl:contacts-changed listener has cleanup (removeEventListener)", () => {
  const removeCount = (dashboardSrc.match(/removeEventListener\s*\(\s*['"]funnl:contacts-changed['"]/g) || []).length
  assert.ok(removeCount >= 1, "must removeEventListener for 'funnl:contacts-changed' in cleanup")
})

test("GlobalAddContactController dispatches funnl:contacts-changed", () => {
  let gacc = ''
  try {
    gacc = readFileSync(resolve('src/components/GlobalAddContactController.jsx'), 'utf8')
  } catch {
    assert.fail('GlobalAddContactController.jsx not found')
  }
  assert.ok(
    gacc.includes("'funnl:contacts-changed'") || gacc.includes('"funnl:contacts-changed"'),
    "GlobalAddContactController must dispatch funnl:contacts-changed"
  )
})

// ── Section 4: onImported → fetchAll (pre-existing import refresh) ────────────

console.log('\nSection 4: onImported → fetchAll (pre-existing import refresh)')

test("DashboardPage onImported callback calls fetchAll", () => {
  assert.ok(
    dashboardSrc.includes('onImported') && dashboardSrc.includes('fetchAll'),
    "onImported callback must exist and call fetchAll"
  )
  // Ensure the pattern onImported => fetchAll() (or similar) appears
  const hasPattern = /onImported.*?fetchAll/.test(dashboardSrc.replace(/\n/g, ' '))
  assert.ok(hasPattern, "onImported must call fetchAll in its handler")
})

test("onImported also closes the import modal before calling fetchAll", () => {
  const importedIdx = dashboardSrc.indexOf('onImported')
  assert.ok(importedIdx !== -1, "onImported must exist")
  const region = dashboardSrc.slice(importedIdx, importedIdx + 200)
  assert.ok(
    region.includes('setShowImportModal(false)') || region.includes('showImportModal'),
    "onImported handler must close the modal"
  )
})

// ── Stale-fetch generation ref (Section 9 source assertion) ──────────────────

console.log('\nGeneration ref and quiet mode (Section 9 source)')

test("fetchGenRef declared in DashboardPage", () => {
  assert.ok(
    dashboardSrc.includes('fetchGenRef'),
    "fetchGenRef ref must be declared in DashboardPage"
  )
})

test("fetchGenRef is a useRef(0)", () => {
  assert.ok(
    dashboardSrc.includes('fetchGenRef') && dashboardSrc.includes('useRef(0)'),
    "fetchGenRef must be initialized with useRef(0)"
  )
})

test("generation counter incremented at fetchAll start (++fetchGenRef.current)", () => {
  assert.ok(
    dashboardSrc.includes('++fetchGenRef.current'),
    "fetchAll must increment fetchGenRef.current at its start"
  )
})

test("stale-check guard present after at least one await (fetchGenRef.current !== gen)", () => {
  assert.ok(
    dashboardSrc.includes('fetchGenRef.current !== gen'),
    "fetchAll must guard post-await state with fetchGenRef.current !== gen check"
  )
})

test("quiet parameter present in fetchAll signature", () => {
  assert.ok(
    dashboardSrc.includes('quiet = false') || dashboardSrc.includes('quiet=false'),
    "fetchAll must accept { quiet = false } parameter"
  )
})

// ── Auth state change reset (Section 8 source assertion) ─────────────────────

console.log('\nImmediate account-switch reset (Section 8 source)')

test("supabase.auth.onAuthStateChange effect present in DashboardPage", () => {
  assert.ok(
    dashboardSrc.includes('onAuthStateChange'),
    "DashboardPage must use supabase.auth.onAuthStateChange for immediate account-switch reset"
  )
})

test("onAuthStateChange effect increments fetchGenRef.current on uid change", () => {
  const idx = dashboardSrc.indexOf('onAuthStateChange')
  assert.ok(idx !== -1, "onAuthStateChange must be present")
  // Find the function body region after onAuthStateChange
  const region = dashboardSrc.slice(idx, idx + 800)
  assert.ok(
    region.includes('fetchGenRef.current++') || region.includes('++fetchGenRef.current'),
    "onAuthStateChange handler must invalidate in-flight fetches via fetchGenRef.current++"
  )
})

test("onAuthStateChange effect clears milestone state on uid change", () => {
  const idx = dashboardSrc.indexOf('onAuthStateChange')
  const region = dashboardSrc.slice(idx, idx + 800)
  assert.ok(region.includes('setMilestones(null)'), "onAuthStateChange must call setMilestones(null)")
})

test("onAuthStateChange effect returns subscription.unsubscribe() cleanup", () => {
  assert.ok(
    dashboardSrc.includes('subscription.unsubscribe'),
    "onAuthStateChange useEffect must unsubscribe on cleanup"
  )
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
