/**
 * followup-log-result.test.js
 *
 * Verifies the Log Result two-phase mutation contract:
 *   Phase 1 — INSERT the new interaction row
 *   Phase 2 — UPDATE the source interaction to mark it complete
 *
 * Key invariants:
 *   - INSERT happens before source UPDATE
 *   - INSERT failure prevents source UPDATE (no orphan completion)
 *   - follow_up_date cleared on source (null)
 *   - success fires followup_completed and dispatches event
 *   - INSERT failure fires no analytics, keeps source open
 *
 * Zero-dependency Node.js — run with: node tests/followup-log-result.test.js
 */
import assert from 'assert'
import { completionPayload } from '../src/lib/followUpUtils.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`)
    failed++
  }
}

async function atest(name, fn) {
  try {
    await fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`)
    failed++
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSourceInteraction(overrides = {}) {
  return {
    id: 'src-1',
    contact_id: 'contact-1',
    follow_up_date: '2026-07-25',
    follow_up_previous_date: null,
    follow_up_completed_at: null,
    follow_up_completion_method: null,
    ...overrides,
  }
}

function makeNewInteractionData(overrides = {}) {
  return {
    type: 'Email',
    interaction_date: '2026-07-29',
    notes: 'Sent follow-up email',
    follow_up_date: null,
    ...overrides,
  }
}

// Simulate the Log Result two-phase handler (matching the expected ContactDetailPage pattern)
async function simulateLogResult(srcInteraction, newInteractionData, deps = {}) {
  const { client, track, dispatch } = deps
  const order = []

  // Phase 1: Insert new interaction
  const insertResult = await client.insert(newInteractionData)
  order.push('insert')
  if (insertResult.error || !insertResult.data?.id) {
    return { ok: false, phase: 'insert', order, errorMessage: insertResult.error?.message || 'Insert failed' }
  }

  // Phase 2: Complete the source interaction
  const completePayload = completionPayload()
  const updateResult = await client.update(completePayload, srcInteraction.id)
  order.push('update')
  if (updateResult.error || !updateResult.data?.id) {
    // Partial failure: new interaction saved, source not completed
    return { ok: false, phase: 'update', order, errorMessage: updateResult.error?.message || 'Completion update failed', partialSuccess: true }
  }

  // Only after both succeed: analytics + event
  track('followup_completed')
  dispatch()
  return { ok: true, order }
}

function makeTestClient({ insertData = { id: 'new-1' }, insertError = null, updateData = { id: 'src-1' }, updateError = null } = {}) {
  const calls = []
  const insertPayloads = []
  const updatePayloads = []
  const updateIds = []

  return {
    client: {
      insert: async (payload) => {
        insertPayloads.push(payload)
        calls.push('insert')
        return { data: insertError ? null : insertData, error: insertError }
      },
      update: async (payload, id) => {
        updatePayloads.push(payload)
        updateIds.push(id)
        calls.push('update')
        return { data: updateError ? null : updateData, error: updateError }
      },
    },
    getCalls: () => calls,
    getInsertPayloads: () => insertPayloads,
    getUpdatePayloads: () => updatePayloads,
    getUpdateIds: () => updateIds,
  }
}

// ── completionPayload contract ─────────────────────────────────────────────────

console.log('\ncompletionPayload contract\n')

test('clears active follow_up_date (sets to null)', () => {
  const p = completionPayload()
  assert.strictEqual(p.follow_up_date, null)
})

test('only sends follow_up_date (no unconfirmed columns)', () => {
  assert.deepStrictEqual(Object.keys(completionPayload()), ['follow_up_date'])
})

// ── Two-phase ordering ────────────────────────────────────────────────────────

console.log('\nTwo-phase log result ordering\n')

await atest('INSERT happens before source UPDATE', async () => {
  const { client, getCalls } = makeTestClient()
  const tracked = []
  const dispatched = []
  await simulateLogResult(
    makeSourceInteraction(),
    makeNewInteractionData(),
    { client, track: (ev) => tracked.push(ev), dispatch: () => dispatched.push(1) }
  )
  const calls = getCalls()
  const insertIdx = calls.indexOf('insert')
  const updateIdx = calls.indexOf('update')
  assert.ok(insertIdx !== -1, 'insert must be called')
  assert.ok(updateIdx !== -1, 'update must be called')
  assert.ok(insertIdx < updateIdx, 'insert must happen before update')
})

await atest('INSERT failure prevents source UPDATE', async () => {
  const { client, getCalls } = makeTestClient({ insertData: null, insertError: { message: 'DB insert failed' } })
  await simulateLogResult(
    makeSourceInteraction(),
    makeNewInteractionData(),
    { client, track: () => {}, dispatch: () => {} }
  )
  const calls = getCalls()
  assert.ok(!calls.includes('update'), 'update must NOT be called when insert fails')
})

await atest('INSERT failure fires no analytics', async () => {
  const { client } = makeTestClient({ insertData: null, insertError: { message: 'DB insert failed' } })
  const tracked = []
  await simulateLogResult(makeSourceInteraction(), makeNewInteractionData(), { client, track: (ev) => tracked.push(ev), dispatch: () => {} })
  assert.strictEqual(tracked.length, 0, 'no analytics must fire on insert failure')
})

await atest('INSERT failure dispatches no event', async () => {
  const { client } = makeTestClient({ insertData: null, insertError: { message: 'DB insert failed' } })
  const dispatched = []
  await simulateLogResult(makeSourceInteraction(), makeNewInteractionData(), { client, track: () => {}, dispatch: () => dispatched.push(1) })
  assert.strictEqual(dispatched.length, 0)
})

await atest('successful INSERT retained if source completion fails', async () => {
  const { client, getCalls } = makeTestClient({ updateData: null, updateError: { message: 'completion failed' } })
  const result = await simulateLogResult(makeSourceInteraction(), makeNewInteractionData(), { client, track: () => {}, dispatch: () => {} })
  // The insert succeeded even though the update failed
  assert.ok(getCalls().includes('insert'), 'insert must have been called')
  assert.ok(getCalls().includes('update'), 'update must have been attempted')
  assert.strictEqual(result.phase, 'update', 'failure is in the update phase, not insert')
  assert.strictEqual(result.partialSuccess, true, 'partial success flag indicates new interaction was saved')
})

// ── Completion payload shape ──────────────────────────────────────────────────

console.log('\nCompletion payload only sends confirmed columns\n')

await atest('completion payload only contains follow_up_date', async () => {
  const { client, getUpdatePayloads } = makeTestClient()
  await simulateLogResult(
    makeSourceInteraction({ follow_up_date: '2026-07-15' }),
    makeNewInteractionData({ follow_up_date: '2026-08-10' }),
    { client, track: () => {}, dispatch: () => {} }
  )
  const payload = getUpdatePayloads()[0]
  assert.deepStrictEqual(Object.keys(payload), ['follow_up_date'])
  assert.strictEqual(payload.follow_up_date, null)
})

await atest('completion payload targets source interaction ID', async () => {
  const { client, getUpdateIds } = makeTestClient()
  await simulateLogResult(
    makeSourceInteraction({ id: 'source-interaction-id' }),
    makeNewInteractionData(),
    { client, track: () => {}, dispatch: () => {} }
  )
  assert.strictEqual(getUpdateIds()[0], 'source-interaction-id')
})

// ── Success outcome ───────────────────────────────────────────────────────────

console.log('\nLog result success outcome\n')

await atest('success fires followup_completed', async () => {
  const { client } = makeTestClient()
  const tracked = []
  await simulateLogResult(makeSourceInteraction(), makeNewInteractionData(), { client, track: (ev) => tracked.push(ev), dispatch: () => {} })
  assert.ok(tracked.includes('followup_completed'))
})

await atest('success dispatches funnl:followups-changed', async () => {
  const { client } = makeTestClient()
  const dispatched = []
  await simulateLogResult(makeSourceInteraction(), makeNewInteractionData(), { client, track: () => {}, dispatch: () => dispatched.push(1) })
  assert.strictEqual(dispatched.length, 1)
})

await atest('success returns ok: true', async () => {
  const { client } = makeTestClient()
  const result = await simulateLogResult(makeSourceInteraction(), makeNewInteractionData(), { client, track: () => {}, dispatch: () => {} })
  assert.strictEqual(result.ok, true)
})

// ── Partial failure outcome ───────────────────────────────────────────────────

console.log('\nLog result partial failure (insert ok, completion fails)\n')

await atest('partial failure fires no followup_completed', async () => {
  const { client } = makeTestClient({ updateData: null, updateError: { message: 'completion failed' } })
  const tracked = []
  await simulateLogResult(makeSourceInteraction(), makeNewInteractionData(), { client, track: (ev) => tracked.push(ev), dispatch: () => {} })
  assert.ok(!tracked.includes('followup_completed'))
})

await atest('partial failure dispatches no event', async () => {
  const { client } = makeTestClient({ updateData: null, updateError: { message: 'completion failed' } })
  const dispatched = []
  await simulateLogResult(makeSourceInteraction(), makeNewInteractionData(), { client, track: () => {}, dispatch: () => dispatched.push(1) })
  assert.strictEqual(dispatched.length, 0)
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
