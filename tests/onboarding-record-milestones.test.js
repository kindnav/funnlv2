/**
 * onboarding-record-milestones.test.js
 *
 * Runtime integration tests for runMilestoneRecorder (milestoneRecorder.js).
 *
 * Verifies the coordinator's full control flow using injectable dependencies
 * (no React, no DOM, no Supabase). All DB writes, analytics callbacks, and
 * completion callbacks are replaced with tracked mock functions.
 *
 * Coverage:
 *   - All three milestones claimed fresh in one run
 *   - Each of the three steps as the "final" step (each completing the set)
 *   - DB error on each step → coordinator aborts, no subsequent writes or analytics
 *   - Race loser on individual step (claimed=false) → no step event, completion skipped
 *   - All steps already set → no writes attempted
 *   - ms=null treated as all-null
 *   - Failed completion mutation → onCompletionClaimed not called, setJustCompleted not triggered
 *   - effectiveMs pattern: race loser does not trigger spurious completion
 *   - Analytics exact schemas: step values, invocation counts
 *   - onCompletionClaimed fires only when completion write is claimed=true
 *
 * Run with: node tests/onboarding-record-milestones.test.js
 */
import assert from 'assert'
import { runMilestoneRecorder } from '../src/lib/milestoneRecorder.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✓  ${name}`)
        passed++
      }).catch(e => {
        console.log(`  ✗  ${name}`)
        console.log(`       ${e.message}`)
        failed++
      })
    }
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

const NOW = '2026-08-04T12:00:00.000Z'

function makeOk(claimed = true)  { return async () => ({ ok: true, claimed }) }
function makeErr()               { return async () => ({ ok: false }) }
function makeRaceLose()          { return makeOk(false) }

// Build a conditionalUpdate function that returns different results per column.
// colMap: { 'activation_five_contacts_at': { ok, claimed }, ... }
function makePerColUpdate(colMap) {
  return async (col) => {
    const spec = colMap[col]
    if (!spec) return { ok: true, claimed: false }
    return spec
  }
}

// Build a step-tracking onStepClaimed callback.
function makeStepTracker() {
  const claims = []
  return {
    callback: (step, effMs) => claims.push({ step, effMs: { ...effMs } }),
    claims,
  }
}

// Build a completion-tracking onCompletionClaimed callback.
function makeCompletionTracker() {
  let callCount = 0
  let lastArg = null
  return {
    callback: (nowArg) => { callCount++; lastArg = nowArg },
    get callCount() { return callCount },
    get lastArg()   { return lastArg },
  }
}

// Full ms with all set — "everything already done"
const fullMs = { fiveContacts: 'prev-ts', firstInteraction: 'prev-ts', firstFollowup: 'prev-ts', completed: 'prev-ts' }
// ms with all nulls
const nullMs = { fiveContacts: null, firstInteraction: null, firstFollowup: null, completed: null }

// ── All three fresh claims in one run ─────────────────────────────────────────

console.log('\nAll three milestones claimed fresh')

const allFreshTests = []

allFreshTests.push(test('all three steps call onStepClaimed when claimed', async () => {
  const stepTracker = makeStepTracker()
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(stepTracker.claims.length, 3, 'should have 3 step claims')
}))

allFreshTests.push(test('step order: five_contacts → first_interaction → first_followup', async () => {
  const stepTracker = makeStepTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: () => {},
  })
  assert.strictEqual(stepTracker.claims[0].step, 'five_contacts')
  assert.strictEqual(stepTracker.claims[1].step, 'first_interaction')
  assert.strictEqual(stepTracker.claims[2].step, 'first_followup')
}))

allFreshTests.push(test('onCompletionClaimed fires exactly once when all three claimed', async () => {
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 1, 'completion must fire exactly once')
}))

allFreshTests.push(test('onCompletionClaimed receives the now timestamp', async () => {
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.lastArg, NOW)
}))

allFreshTests.push(test('effectiveMs.fiveContacts set to now after step1 claim', async () => {
  const stepTracker = makeStepTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: () => {},
  })
  const step1Claim = stepTracker.claims.find(c => c.step === 'five_contacts')
  assert.strictEqual(step1Claim.effMs.fiveContacts, NOW)
}))

allFreshTests.push(test('effectiveMs.completed still null during individual step claims', async () => {
  const stepTracker = makeStepTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: () => {},
  })
  for (const claim of stepTracker.claims) {
    assert.strictEqual(claim.effMs.completed, null,
      `effMs.completed must be null during step '${claim.step}' claim`)
  }
}))

// ── ms=null treated as all-null ───────────────────────────────────────────────

console.log('\nms=null treated as all-null')

allFreshTests.push(test('ms=null: all three steps attempted when criteria met', async () => {
  const cols = []
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: null, now: NOW,
    conditionalUpdate: async (col) => { cols.push(col); return { ok: true, claimed: true } },
    onStepClaimed: () => {},
    onCompletionClaimed: () => {},
  })
  assert.ok(cols.includes('activation_five_contacts_at'))
  assert.ok(cols.includes('activation_first_interaction_at'))
  assert.ok(cols.includes('activation_first_followup_at'))
  assert.ok(cols.includes('activation_completed_at'))
}))

allFreshTests.push(test('ms=null: onCompletionClaimed fires when all claimed', async () => {
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: null, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 1)
}))

// ── No writes when all already set ────────────────────────────────────────────

console.log('\nNo writes when all milestones already set')

allFreshTests.push(test('all timestamps set → zero conditionalUpdate calls', async () => {
  let callCount = 0
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: fullMs, now: NOW,
    conditionalUpdate: async () => { callCount++; return { ok: true, claimed: false } },
    onStepClaimed: () => {},
    onCompletionClaimed: () => {},
  })
  assert.strictEqual(callCount, 0, 'no DB writes when all timestamps set')
}))

allFreshTests.push(test('all timestamps set → zero step claims and zero completion calls', async () => {
  const stepTracker = makeStepTracker()
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: fullMs, now: NOW,
    conditionalUpdate: makeOk(false),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(stepTracker.claims.length, 0)
  assert.strictEqual(completionTracker.callCount, 0)
}))

// ── DB error on step1 → abort ─────────────────────────────────────────────────

console.log('\nDB error on step1 → abort, no subsequent writes or analytics')

allFreshTests.push(test('DB error on step1: no step2 or step3 writes', async () => {
  const cols = []
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      cols.push(col)
      if (col === 'activation_five_contacts_at') return { ok: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: () => {},
  })
  assert.strictEqual(cols.length, 1, 'only step1 should have been attempted')
  assert.strictEqual(cols[0], 'activation_five_contacts_at')
}))

allFreshTests.push(test('DB error on step1: onStepClaimed not called', async () => {
  const stepTracker = makeStepTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      if (col === 'activation_five_contacts_at') return { ok: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: () => {},
  })
  assert.strictEqual(stepTracker.claims.length, 0)
}))

allFreshTests.push(test('DB error on step1: onCompletionClaimed not called', async () => {
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      if (col === 'activation_five_contacts_at') return { ok: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 0)
}))

// ── DB error on step2 → abort ─────────────────────────────────────────────────

console.log('\nDB error on step2 → abort')

allFreshTests.push(test('DB error on step2: step3 not attempted, completion not called', async () => {
  const cols = []
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      cols.push(col)
      if (col === 'activation_first_interaction_at') return { ok: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.ok(!cols.includes('activation_first_followup_at'), 'step3 must not be attempted after step2 error')
  assert.ok(!cols.includes('activation_completed_at'), 'completion must not be attempted after step2 error')
  assert.strictEqual(completionTracker.callCount, 0)
}))

// ── DB error on step3 → abort ─────────────────────────────────────────────────

console.log('\nDB error on step3 → abort')

allFreshTests.push(test('DB error on step3: completion not attempted', async () => {
  const cols = []
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      cols.push(col)
      if (col === 'activation_first_followup_at') return { ok: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: () => {},
  })
  assert.ok(!cols.includes('activation_completed_at'), 'completion must not be attempted after step3 error')
}))

// ── Race loser on individual step ─────────────────────────────────────────────

console.log('\nRace loser on individual step — claimed=false')

allFreshTests.push(test('race loser on step1 (claimed=false): onStepClaimed not called for step1', async () => {
  const stepTracker = makeStepTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makePerColUpdate({
      'activation_five_contacts_at':    { ok: true, claimed: false },
      'activation_first_interaction_at': { ok: true, claimed: true },
      'activation_first_followup_at':   { ok: true, claimed: true },
      'activation_completed_at':        { ok: true, claimed: true },
    }),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: () => {},
  })
  const step1Claims = stepTracker.claims.filter(c => c.step === 'five_contacts')
  assert.strictEqual(step1Claims.length, 0, 'step1 race loser must not fire onStepClaimed')
}))

allFreshTests.push(test('race loser on step1: completion skipped (effectiveMs.fiveContacts stays null)', async () => {
  const completionTracker = makeCompletionTracker()
  const cols = []
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      cols.push(col)
      if (col === 'activation_five_contacts_at') return { ok: true, claimed: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  // completion write should still be attempted (attempts.completion=true since ms.completed=null and
  // all three criteria are met), but allEffectivelyDone check inside coordinator returns false
  // because effectiveMs.fiveContacts is still null (race loser).
  assert.strictEqual(completionTracker.callCount, 0, 'completion must not fire when step1 was a race loser')
}))

allFreshTests.push(test('race loser on step2: completion skipped', async () => {
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      if (col === 'activation_first_interaction_at') return { ok: true, claimed: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 0)
}))

allFreshTests.push(test('race loser on step3: completion skipped', async () => {
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      if (col === 'activation_first_followup_at') return { ok: true, claimed: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 0)
}))

// ── Failed completion mutation → no side effects ──────────────────────────────

console.log('\nFailed completion mutation → no side effects')

allFreshTests.push(test('completion DB error (ok=false): onCompletionClaimed not called', async () => {
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      if (col === 'activation_completed_at') return { ok: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 0,
    'onCompletionClaimed must not fire when completion write returns ok=false')
}))

allFreshTests.push(test('completion claimed=false: onCompletionClaimed not called', async () => {
  const completionTracker = makeCompletionTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => {
      if (col === 'activation_completed_at') return { ok: true, claimed: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 0,
    'onCompletionClaimed must not fire when completion write races and is not claimed')
}))

// ── Three final-step paths: each step as the final one ────────────────────────

console.log('\nThree final-step paths — each step can be the last to complete the set')

// Scenario: steps 2 and 3 already set; step 1 (five_contacts) is the final step.
// After claiming step1, effectiveMs must make all three set → completion fires.
allFreshTests.push(test('five_contacts is the final step: completion fires after claiming it', async () => {
  const completionTracker = makeCompletionTracker()
  const msWithOnlyStep1Missing = {
    fiveContacts: null,
    firstInteraction: 'prev-ts',
    firstFollowup: 'prev-ts',
    completed: null,
  }
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: msWithOnlyStep1Missing, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 1,
    'completion must fire when five_contacts is the final claimed step')
}))

allFreshTests.push(test('five_contacts final: effectiveMs includes all three before completion', async () => {
  let effMsAtCompletion = null
  const msWithOnlyStep1Missing = {
    fiveContacts: null,
    firstInteraction: 'prev-ts',
    firstFollowup: 'prev-ts',
    completed: null,
  }
  // Spy on conditionalUpdate to capture effectiveMs at the completion call
  // (we verify via the allEffectivelyDone check indirectly through completion firing)
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: msWithOnlyStep1Missing, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: () => {},
    onCompletionClaimed: (nowArg) => { effMsAtCompletion = nowArg },
  })
  assert.strictEqual(effMsAtCompletion, NOW,
    'completion callback must receive now timestamp')
}))

// Scenario: steps 1 and 3 already set; step 2 (first_interaction) is the final step.
allFreshTests.push(test('first_interaction is the final step: completion fires after claiming it', async () => {
  const completionTracker = makeCompletionTracker()
  const msWithOnlyStep2Missing = {
    fiveContacts: 'prev-ts',
    firstInteraction: null,
    firstFollowup: 'prev-ts',
    completed: null,
  }
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: msWithOnlyStep2Missing, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 1,
    'completion must fire when first_interaction is the final claimed step')
}))

// Scenario: steps 1 and 2 already set; step 3 (first_followup) is the final step.
allFreshTests.push(test('first_followup is the final step: completion fires after claiming it', async () => {
  const completionTracker = makeCompletionTracker()
  const msWithOnlyStep3Missing = {
    fiveContacts: 'prev-ts',
    firstInteraction: 'prev-ts',
    firstFollowup: null,
    completed: null,
  }
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: msWithOnlyStep3Missing, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 1,
    'completion must fire when first_followup is the final claimed step')
}))

// ── Race loser on final step: completion must not fire ────────────────────────

console.log('\nRace loser on the final step — no spurious completion')

allFreshTests.push(test('final step (five_contacts) race loser: completion does not fire', async () => {
  const completionTracker = makeCompletionTracker()
  const msWithOnlyStep1Missing = {
    fiveContacts: null,
    firstInteraction: 'prev-ts',
    firstFollowup: 'prev-ts',
    completed: null,
  }
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: msWithOnlyStep1Missing, now: NOW,
    conditionalUpdate: async (col) => {
      if (col === 'activation_five_contacts_at') return { ok: true, claimed: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 0,
    'completion must not fire when the final step is a race loser')
}))

allFreshTests.push(test('final step (first_followup) race loser: completion does not fire', async () => {
  const completionTracker = makeCompletionTracker()
  const msWithOnlyStep3Missing = {
    fiveContacts: 'prev-ts',
    firstInteraction: 'prev-ts',
    firstFollowup: null,
    completed: null,
  }
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: msWithOnlyStep3Missing, now: NOW,
    conditionalUpdate: async (col) => {
      if (col === 'activation_first_followup_at') return { ok: true, claimed: false }
      return { ok: true, claimed: true }
    },
    onStepClaimed: () => {},
    onCompletionClaimed: completionTracker.callback,
  })
  assert.strictEqual(completionTracker.callCount, 0,
    'spurious completion must not fire when final step races')
}))

// ── Partial criteria: only some steps met ────────────────────────────────────

console.log('\nPartial criteria — only some steps met')

allFreshTests.push(test('only step1 met: only step1 write attempted', async () => {
  const cols = []
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 0, hasFollowUpBool: false,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => { cols.push(col); return { ok: true, claimed: true } },
    onStepClaimed: () => {},
    onCompletionClaimed: () => {},
  })
  assert.deepStrictEqual(cols, ['activation_five_contacts_at'])
}))

allFreshTests.push(test('steps 1+2 met, not step3: no completion write', async () => {
  const cols = []
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: false,
    ms: nullMs, now: NOW,
    conditionalUpdate: async (col) => { cols.push(col); return { ok: true, claimed: true } },
    onStepClaimed: () => {},
    onCompletionClaimed: () => {},
  })
  assert.ok(!cols.includes('activation_completed_at'), 'completion write must not fire without step3')
}))

allFreshTests.push(test('no steps met (contactCnt=0): no writes at all', async () => {
  let callCount = 0
  await runMilestoneRecorder({
    contactCnt: 0, interactionCnt: 0, hasFollowUpBool: false,
    ms: nullMs, now: NOW,
    conditionalUpdate: async () => { callCount++; return { ok: true, claimed: true } },
    onStepClaimed: () => {},
    onCompletionClaimed: () => {},
  })
  assert.strictEqual(callCount, 0, 'no writes when no criteria met')
}))

// ── Analytics schema: exact event property values ─────────────────────────────

console.log('\nAnalytics schema — exact step enum values passed to onStepClaimed')

allFreshTests.push(test("onStepClaimed receives step='five_contacts' for step1", async () => {
  const stepTracker = makeStepTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 0, hasFollowUpBool: false,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: () => {},
  })
  assert.ok(stepTracker.claims.some(c => c.step === 'five_contacts'),
    "step1 must pass 'five_contacts' to onStepClaimed")
}))

allFreshTests.push(test("onStepClaimed receives step='first_interaction' for step2", async () => {
  const stepTracker = makeStepTracker()
  await runMilestoneRecorder({
    contactCnt: 0, interactionCnt: 1, hasFollowUpBool: false,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: () => {},
  })
  assert.ok(stepTracker.claims.some(c => c.step === 'first_interaction'),
    "step2 must pass 'first_interaction' to onStepClaimed")
}))

allFreshTests.push(test("onStepClaimed receives step='first_followup' for step3", async () => {
  const stepTracker = makeStepTracker()
  await runMilestoneRecorder({
    contactCnt: 0, interactionCnt: 0, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: () => {},
  })
  assert.ok(stepTracker.claims.some(c => c.step === 'first_followup'),
    "step3 must pass 'first_followup' to onStepClaimed")
}))

// ── Invocation count: exactly once per claimed step ───────────────────────────

console.log('\nInvocation counts — exactly once per claimed event')

allFreshTests.push(test('each step fires onStepClaimed exactly once', async () => {
  const stepTracker = makeStepTracker()
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: stepTracker.callback,
    onCompletionClaimed: () => {},
  })
  assert.strictEqual(stepTracker.claims.length, 3, 'exactly 3 step claims total')
  const steps = stepTracker.claims.map(c => c.step)
  const unique = new Set(steps)
  assert.strictEqual(unique.size, 3, 'each step fires exactly once')
}))

allFreshTests.push(test('onCompletionClaimed fires exactly once (not multiple times)', async () => {
  let completionCount = 0
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: nullMs, now: NOW,
    conditionalUpdate: makeOk(true),
    onStepClaimed: () => {},
    onCompletionClaimed: () => completionCount++,
  })
  assert.strictEqual(completionCount, 1, 'completion fires exactly once per full run')
}))

// ── Step already set: no write for that step ──────────────────────────────────

console.log('\nAlready-set individual steps — no redundant writes')

allFreshTests.push(test('step1 already set: activation_five_contacts_at not in write set', async () => {
  const cols = []
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: { ...nullMs, fiveContacts: 'prev-ts' }, now: NOW,
    conditionalUpdate: async (col) => { cols.push(col); return { ok: true, claimed: true } },
    onStepClaimed: () => {},
    onCompletionClaimed: () => {},
  })
  assert.ok(!cols.includes('activation_five_contacts_at'), 'step1 already set must not be re-written')
}))

allFreshTests.push(test('step2 already set: activation_first_interaction_at not in write set', async () => {
  const cols = []
  await runMilestoneRecorder({
    contactCnt: 5, interactionCnt: 1, hasFollowUpBool: true,
    ms: { ...nullMs, firstInteraction: 'prev-ts' }, now: NOW,
    conditionalUpdate: async (col) => { cols.push(col); return { ok: true, claimed: true } },
    onStepClaimed: () => {},
    onCompletionClaimed: () => {},
  })
  assert.ok(!cols.includes('activation_first_interaction_at'), 'step2 already set must not be re-written')
}))

// ── Wait for all async tests to resolve ──────────────────────────────────────

Promise.all(allFreshTests.filter(Boolean)).then(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
})
