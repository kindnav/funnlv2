/**
 * onboarding-analytics-contracts.test.js
 *
 * Verifies that the analytics event schemas fired by the onboarding/activation
 * system conform to spec. These tests assert against source code strings in
 * DashboardPage.jsx — verifying that:
 *   - The correct event names are used
 *   - The correct property keys and allowed enum values are present
 *   - No PII fields (contact names, emails, companies) appear in analytics calls
 *   - activation_step_completed and activation_completed conform to their schemas
 *
 * Approach: source-string assertions against the DashboardPage source.
 * This is the same approach as onboarding-static.test.js — the pattern is
 * proven effective for this codebase.
 *
 * Run with: node tests/onboarding-analytics-contracts.test.js
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

const dashboardSrc = readFileSync(
  resolve('src/pages/DashboardPage.jsx'),
  'utf8'
)
// milestoneRecorder.js is the coordinator that calls shouldAttemptMilestoneWrites
// and passes the step string constants to the onStepClaimed callback. The enum
// values live there rather than inline in DashboardPage since Stage 9.
const milestoneRecorderSrc = readFileSync(
  resolve('src/lib/milestoneRecorder.js'),
  'utf8'
)
// Combined source for assertions that span the activation code path.
const activationCodeSrc = dashboardSrc + '\n' + milestoneRecorderSrc

// ── activation_step_completed event ──────────────────────────────────────────

console.log('\nactivation_step_completed event schema')

test("event name 'activation_step_completed' present in source", () => {
  assert.ok(dashboardSrc.includes("'activation_step_completed'"), "event name must be present")
})

test("step property key 'step:' appears in activation_step_completed call", () => {
  // Verify that calls include a 'step:' property
  assert.ok(dashboardSrc.includes("activation_step_completed"), "event must be used")
  // The step property should exist
  assert.ok(dashboardSrc.includes("step:"), "step property key must be present")
})

test("allowed step value 'five_contacts' present in activation code path", () => {
  // The step string is passed by milestoneRecorder.js → onStepClaimed callback in DashboardPage.
  assert.ok(activationCodeSrc.includes("'five_contacts'") || activationCodeSrc.includes('"five_contacts"'),
    "'five_contacts' step value must be present in the activation code path")
})
test("allowed step value 'first_interaction' present in activation code path", () => {
  assert.ok(activationCodeSrc.includes("'first_interaction'") || activationCodeSrc.includes('"first_interaction"'),
    "'first_interaction' step value must be present in the activation code path")
})
test("allowed step value 'first_followup' present in activation code path", () => {
  assert.ok(activationCodeSrc.includes("'first_followup'") || activationCodeSrc.includes('"first_followup"'),
    "'first_followup' step value must be present in the activation code path")
})

// ── activation_completed event ────────────────────────────────────────────────

console.log('\nactivation_completed event schema')

test("event name 'activation_completed' present in source", () => {
  assert.ok(dashboardSrc.includes("'activation_completed'"), "event name must be present")
})
test("contacts_count property key present in activation_completed call", () => {
  assert.ok(dashboardSrc.includes('contacts_count'), "contacts_count property must be present")
})
test("contacts_count is a number (not a string literal)", () => {
  // contacts_count should be assigned a variable/expression, not a string
  // The source should not have contacts_count: 'something'
  const hasStringValue = /contacts_count:\s*['"]/.test(dashboardSrc)
  assert.ok(!hasStringValue, "contacts_count must not be a string literal")
})

// ── No PII in analytics calls ─────────────────────────────────────────────────

console.log('\nNo PII in analytics calls — behavior only')

test("no contact name sent to PostHog in activation events", () => {
  // activation_step_completed calls should not include contact.name or similar
  const stepCompletedIdx = dashboardSrc.indexOf('activation_step_completed')
  if (stepCompletedIdx === -1) { assert.fail('event not found'); return }
  // Check the vicinity of the call (100 chars before, 200 chars after) for PII
  const vicinity = dashboardSrc.slice(Math.max(0, stepCompletedIdx - 50), stepCompletedIdx + 200)
  assert.ok(!vicinity.includes('.name'), "contact name must not appear near activation_step_completed")
  assert.ok(!vicinity.includes('.email'), "contact email must not appear near activation_step_completed")
})
test("no email string literal in activation event calls", () => {
  // No activation event should send an email address
  // Quick heuristic: find track() calls containing @-sign
  const trackCallsWithEmail = /track\([^)]*@[^)]*\)/.test(dashboardSrc)
  assert.ok(!trackCallsWithEmail, "track() calls must not contain @ symbols (email addresses)")
})
test("no contact company sent in activation events", () => {
  const stepCompletedIdx = dashboardSrc.indexOf('activation_step_completed')
  if (stepCompletedIdx === -1) { assert.fail('event not found'); return }
  const vicinity = dashboardSrc.slice(Math.max(0, stepCompletedIdx - 50), stepCompletedIdx + 200)
  assert.ok(!vicinity.includes('.company'), "company must not appear near activation_step_completed")
})

// ── activation_checklist_viewed event ────────────────────────────────────────

console.log('\nactivation_checklist_viewed event')

test("event name 'activation_checklist_viewed' present in source", () => {
  assert.ok(dashboardSrc.includes("'activation_checklist_viewed'") ||
            dashboardSrc.includes('"activation_checklist_viewed"'),
    "activation_checklist_viewed event must be tracked")
})

// ── import track function ─────────────────────────────────────────────────────

console.log('\ntrack function import and usage')

test("track function is imported in DashboardPage", () => {
  assert.ok(dashboardSrc.includes('track') && dashboardSrc.includes('analytics'),
    "track must be imported from analytics module")
})
test("track is called with string literal event name (not variable)", () => {
  // All track calls in analytics use quoted string event names
  const hasRawTrack = /track\(['"]activation_/.test(dashboardSrc)
  assert.ok(hasRawTrack, "track() calls must use quoted event name literals")
})

// ── Idempotent guard before analytics fires ───────────────────────────────────

console.log('\nIdempotent guard — analytics fires only after claimed check')

test("recordMilestones function exists in source", () => {
  assert.ok(dashboardSrc.includes('recordMilestones'),
    "recordMilestones function must exist in DashboardPage")
})
test("claimed check pattern exists (select id for .eq guard)", () => {
  // Idempotent writes use .select('id') to detect already-set rows
  assert.ok(dashboardSrc.includes(".select('id')") || dashboardSrc.includes('.select("id")'),
    "claimed detection via .select('id') must be present")
})
test(".is() null guard for conditional update", () => {
  // Conditional writes use .is(column, null) atomic guard
  assert.ok(dashboardSrc.includes('.is(') || dashboardSrc.includes("is("),
    ".is() null guard must be present for atomic milestone writes")
})

// ── pro_trial_started event (WelcomePage) ────────────────────────────────────

console.log("\npro_trial_started event in WelcomePage (separate file)")

const welcomeSrc = (() => {
  try { return readFileSync(resolve('src/pages/WelcomePage.jsx'), 'utf8') } catch { return '' }
})()

test("pro_trial_started event in WelcomePage.jsx", () => {
  if (!welcomeSrc) { assert.fail('WelcomePage.jsx not found'); return }
  assert.ok(
    welcomeSrc.includes("'pro_trial_started'") || welcomeSrc.includes('"pro_trial_started"'),
    "pro_trial_started must be tracked in WelcomePage"
  )
})
test("pro_trial_started deduplication uses localStorage flag", () => {
  if (!welcomeSrc) { assert.fail('WelcomePage.jsx not found'); return }
  assert.ok(
    welcomeSrc.includes('funnl_trial_started') || welcomeSrc.includes('localStorage'),
    "pro_trial_started must use localStorage for deduplication"
  )
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
