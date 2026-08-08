/**
 * onboarding-action-coordinator.test.js — Section 5
 *
 * Pure unit tests for resolveActivationAction from activationActionCoordinator.js.
 *
 * Tests every branch:
 *   action: 'add'       → always open_drawer
 *   action: 'log'       → zero contacts: open_drawer
 *                         one contact:   navigate (with contactId + mode:'interaction')
 *                         many contacts: open_picker (mode:'interaction')
 *   action: 'followup'  → zero contacts: open_drawer
 *                         one contact:   navigate (with contactId + mode:'followup')
 *                         many contacts: open_picker (mode:'followup')
 *   action: 'complete'  → noop
 *   action: null        → noop
 *   action: unknown     → noop
 *   contacts: null      → treated as empty array
 *
 * Run with: node tests/onboarding-action-coordinator.test.js
 */
import assert from 'assert'
import { resolveActivationAction } from '../src/lib/activationActionCoordinator.js'

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

// Fixture contacts
const ONE = [{ id: 'c1', name: 'Alice' }]
const TWO = [{ id: 'c1', name: 'Alice' }, { id: 'c2', name: 'Bob' }]
const FIVE = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: `Contact ${i}` }))

// ── action: 'add' ─────────────────────────────────────────────────────────────

console.log("\naction: 'add'")

test("'add' + zero contacts → open_drawer", () => {
  const r = resolveActivationAction('add', [])
  assert.strictEqual(r.type, 'open_drawer')
})
test("'add' + one contact → open_drawer (drawer for adding contacts)", () => {
  const r = resolveActivationAction('add', ONE)
  assert.strictEqual(r.type, 'open_drawer')
})
test("'add' + multiple contacts → open_drawer", () => {
  const r = resolveActivationAction('add', TWO)
  assert.strictEqual(r.type, 'open_drawer')
})
test("'add' result has no contactId", () => {
  const r = resolveActivationAction('add', ONE)
  assert.strictEqual(r.contactId, undefined)
})
test("'add' result has no mode", () => {
  const r = resolveActivationAction('add', ONE)
  assert.strictEqual(r.mode, undefined)
})

// ── action: 'log' ─────────────────────────────────────────────────────────────

console.log("\naction: 'log'")

test("'log' + zero contacts → open_drawer", () => {
  const r = resolveActivationAction('log', [])
  assert.strictEqual(r.type, 'open_drawer')
})
test("'log' + exactly one contact → navigate", () => {
  const r = resolveActivationAction('log', ONE)
  assert.strictEqual(r.type, 'navigate')
})
test("'log' + one contact → contactId is the contact's id", () => {
  const r = resolveActivationAction('log', ONE)
  assert.strictEqual(r.contactId, 'c1')
})
test("'log' + one contact → mode is 'interaction'", () => {
  const r = resolveActivationAction('log', ONE)
  assert.strictEqual(r.mode, 'interaction')
})
test("'log' + two contacts → open_picker", () => {
  const r = resolveActivationAction('log', TWO)
  assert.strictEqual(r.type, 'open_picker')
})
test("'log' + two contacts → mode is 'interaction'", () => {
  const r = resolveActivationAction('log', TWO)
  assert.strictEqual(r.mode, 'interaction')
})
test("'log' + two contacts → no contactId", () => {
  const r = resolveActivationAction('log', TWO)
  assert.strictEqual(r.contactId, undefined)
})
test("'log' + five contacts → open_picker", () => {
  const r = resolveActivationAction('log', FIVE)
  assert.strictEqual(r.type, 'open_picker')
})
test("'log' + five contacts → mode is 'interaction'", () => {
  const r = resolveActivationAction('log', FIVE)
  assert.strictEqual(r.mode, 'interaction')
})

// ── action: 'followup' ────────────────────────────────────────────────────────

console.log("\naction: 'followup'")

test("'followup' + zero contacts → open_drawer", () => {
  const r = resolveActivationAction('followup', [])
  assert.strictEqual(r.type, 'open_drawer')
})
test("'followup' + exactly one contact → navigate", () => {
  const r = resolveActivationAction('followup', ONE)
  assert.strictEqual(r.type, 'navigate')
})
test("'followup' + one contact → contactId is the contact's id", () => {
  const r = resolveActivationAction('followup', ONE)
  assert.strictEqual(r.contactId, 'c1')
})
test("'followup' + one contact → mode is 'followup'", () => {
  const r = resolveActivationAction('followup', ONE)
  assert.strictEqual(r.mode, 'followup')
})
test("'followup' + two contacts → open_picker", () => {
  const r = resolveActivationAction('followup', TWO)
  assert.strictEqual(r.type, 'open_picker')
})
test("'followup' + two contacts → mode is 'followup'", () => {
  const r = resolveActivationAction('followup', TWO)
  assert.strictEqual(r.mode, 'followup')
})
test("'followup' + two contacts → no contactId", () => {
  const r = resolveActivationAction('followup', TWO)
  assert.strictEqual(r.contactId, undefined)
})
test("'followup' + five contacts → open_picker", () => {
  const r = resolveActivationAction('followup', FIVE)
  assert.strictEqual(r.type, 'open_picker')
})

// ── action: 'complete' → noop ─────────────────────────────────────────────────

console.log("\naction: 'complete' → noop")

test("'complete' + zero contacts → noop", () => {
  const r = resolveActivationAction('complete', [])
  assert.strictEqual(r.type, 'noop')
})
test("'complete' + many contacts → noop", () => {
  const r = resolveActivationAction('complete', FIVE)
  assert.strictEqual(r.type, 'noop')
})

// ── action: null / unknown ─────────────────────────────────────────────────────

console.log("\naction: null / unknown")

test("null action → noop", () => {
  const r = resolveActivationAction(null, [])
  assert.strictEqual(r.type, 'noop')
})
test("undefined action → noop", () => {
  const r = resolveActivationAction(undefined, [])
  assert.strictEqual(r.type, 'noop')
})
test("unknown string action → noop", () => {
  const r = resolveActivationAction('unknown', ONE)
  assert.strictEqual(r.type, 'noop')
})
test("empty string action → noop", () => {
  const r = resolveActivationAction('', [])
  assert.strictEqual(r.type, 'noop')
})

// ── contacts: null / undefined guard ──────────────────────────────────────────

console.log("\ncontacts: null / undefined guard")

test("'log' + null contacts → open_drawer (treated as empty)", () => {
  const r = resolveActivationAction('log', null)
  assert.strictEqual(r.type, 'open_drawer')
})
test("'log' + undefined contacts → open_drawer (treated as empty)", () => {
  const r = resolveActivationAction('log', undefined)
  assert.strictEqual(r.type, 'open_drawer')
})
test("'followup' + null contacts → open_drawer (treated as empty)", () => {
  const r = resolveActivationAction('followup', null)
  assert.strictEqual(r.type, 'open_drawer')
})
test("'add' + null contacts → open_drawer", () => {
  const r = resolveActivationAction('add', null)
  assert.strictEqual(r.type, 'open_drawer')
})

// ── DashboardPage imports resolveActivationAction ─────────────────────────────

console.log("\nDashboardPage source contract")

import { readFileSync } from 'fs'
import { resolve } from 'path'

const dashboardSrc = readFileSync(resolve('src/pages/DashboardPage.jsx'), 'utf8')

test("DashboardPage imports resolveActivationAction", () => {
  assert.ok(
    dashboardSrc.includes('resolveActivationAction'),
    "DashboardPage must import and use resolveActivationAction"
  )
})
test("DashboardPage imports from activationActionCoordinator", () => {
  assert.ok(
    dashboardSrc.includes('activationActionCoordinator'),
    "DashboardPage must import from activationActionCoordinator.js"
  )
})
test("onNextAction handler in DashboardPage uses resolveActivationAction result", () => {
  // The handler should call resolveActivationAction and branch on result.type
  assert.ok(
    dashboardSrc.includes('resolveActivationAction') && dashboardSrc.includes("result.type"),
    "onNextAction must use resolveActivationAction and branch on result.type"
  )
})
test("navigate result.type branch present in DashboardPage onNextAction", () => {
  // Single-contact direct-navigate path must be present
  assert.ok(
    dashboardSrc.includes("result.type === 'navigate'") ||
    dashboardSrc.includes('navigate') && dashboardSrc.includes('result.contactId'),
    "DashboardPage must handle the 'navigate' result type from resolveActivationAction"
  )
})

// ── result shape invariants ───────────────────────────────────────────────────

console.log("\nresult shape invariants")

test("all result objects have a 'type' property", () => {
  const actions = ['add', 'log', 'followup', 'complete', null, 'unknown']
  const contactSets = [[], ONE, TWO]
  for (const action of actions) {
    for (const contacts of contactSets) {
      const r = resolveActivationAction(action, contacts)
      assert.ok('type' in r, `result for (${action}, ${contacts.length || 0}) must have 'type'`)
    }
  }
})
test("type values are from the allowed set", () => {
  const allowed = new Set(['open_drawer', 'navigate', 'open_picker', 'noop'])
  const actions = ['add', 'log', 'followup', 'complete', null, 'unknown']
  const contactSets = [[], ONE, TWO]
  for (const action of actions) {
    for (const contacts of contactSets) {
      const r = resolveActivationAction(action, contacts)
      assert.ok(allowed.has(r.type), `type '${r.type}' must be in allowed set`)
    }
  }
})
test("navigate results always have both contactId and mode", () => {
  const navigateResults = [
    resolveActivationAction('log', ONE),
    resolveActivationAction('followup', ONE),
  ]
  for (const r of navigateResults) {
    assert.strictEqual(r.type, 'navigate')
    assert.ok(typeof r.contactId === 'string' && r.contactId.length > 0, "navigate must have contactId")
    assert.ok(typeof r.mode === 'string' && r.mode.length > 0, "navigate must have mode")
  }
})
test("open_picker results always have mode but no contactId", () => {
  const pickerResults = [
    resolveActivationAction('log', TWO),
    resolveActivationAction('followup', TWO),
  ]
  for (const r of pickerResults) {
    assert.strictEqual(r.type, 'open_picker')
    assert.ok(typeof r.mode === 'string', "open_picker must have mode")
    assert.strictEqual(r.contactId, undefined, "open_picker must not have contactId")
  }
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
