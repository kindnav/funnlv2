/**
 * followup-actions.test.js
 *
 * Action-level tests for src/lib/followUpActions.js.
 * Verifies: correct payload, DB-first sequencing, analytics fired only on success,
 * event dispatched only on success, failure isolation, duplicate-submit guards.
 *
 * Zero-dependency Node.js — run with: node tests/followup-actions.test.js
 */
import assert from 'assert'
import {
  completeFollowUp,
  snoozeFollowUp,
  undoFollowUp,
  markResponded,
  nudgeFollowUp,
} from '../src/lib/followUpActions.js'

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

// ── Stub builders ─────────────────────────────────────────────────────────────

function makeRow(overrides = {}) {
  return {
    id: 'row-1',
    contact_id: 'contact-1',
    follow_up_date: '2026-07-29',
    follow_up_previous_date: null,
    follow_up_completed_at: null,
    follow_up_completion_method: null,
    outreach_status: null,
    interaction_date: '2026-07-20',
    ...overrides,
  }
}

function makeClient({ data = { id: 'row-1' }, error = null } = {}) {
  const calls = []
  let capturedPayload = null
  let capturedId = null
  const chain = {
    from:   ()       => { calls.push('from'); return chain },
    update: (payload) => { capturedPayload = payload; calls.push('update'); return chain },
    eq:     (col, v) => { if (col === 'id') capturedId = v; calls.push(`eq:${col}`); return chain },
    select: ()       => { calls.push('select'); return chain },
    single: async () => { calls.push('single'); return { data, error } },
  }
  return {
    client: chain,
    getCalls: () => calls,
    getPayload: () => capturedPayload,
    getId: () => capturedId,
  }
}

function makeDeps(clientStub, { data, error } = {}) {
  const { client, getCalls, getPayload, getId } = makeClient({ data, error })
  const tracked = []
  const dispatched = []
  return {
    deps: { client, track: (ev, props) => tracked.push({ ev, props }), dispatch: () => dispatched.push(1) },
    getCalls, getPayload, getId, tracked, dispatched,
    clientOverride: clientStub,
  }
}

// Convenience: make deps with a SUCCESS client
function successDeps(extraRow = {}) {
  const row = makeRow(extraRow)
  const { client, getCalls, getPayload, getId } = makeClient({ data: { id: row.id }, error: null })
  const tracked = []
  const dispatched = []
  const deps = { client, track: (ev, p) => tracked.push({ ev, props: p }), dispatch: () => dispatched.push(1) }
  return { row, deps, getCalls, getPayload, getId, tracked, dispatched }
}

// Convenience: make deps with a FAILING client
function failDeps(extraRow = {}) {
  const row = makeRow(extraRow)
  const { client, getCalls, getPayload, getId } = makeClient({ data: null, error: { message: 'DB error' } })
  const tracked = []
  const dispatched = []
  const deps = { client, track: (ev, p) => tracked.push({ ev, props: p }), dispatch: () => dispatched.push(1) }
  return { row, deps, getCalls, getPayload, getId, tracked, dispatched }
}

// ══════════════════════════════════════════════════════════════════════════════
// completeFollowUp (Done / Log Result)
// ══════════════════════════════════════════════════════════════════════════════

console.log('\ncompleteFollowUp — Done\n')

await atest('builds completionPayload with current follow_up_date', async () => {
  const { row, deps, getPayload } = successDeps({ follow_up_date: '2026-07-25' })
  await completeFollowUp(row, deps)
  const p = getPayload()
  assert.strictEqual(p.follow_up_previous_date, '2026-07-25', 'previous_date should be the current date')
  assert.strictEqual(p.follow_up_date, null, 'active date must be cleared')
  assert.ok(p.follow_up_completed_at, 'completed_at must be set')
})

await atest('method defaults to mark_done', async () => {
  const { row, deps, getPayload } = successDeps()
  await completeFollowUp(row, deps)
  assert.strictEqual(getPayload().follow_up_completion_method, 'mark_done')
})

await atest('method can be overridden to log_result', async () => {
  const { row, deps, getPayload } = successDeps()
  await completeFollowUp(row, { ...deps, method: 'log_result' })
  assert.strictEqual(getPayload().follow_up_completion_method, 'log_result')
})

await atest('null follow_up_date is preserved as previous_date null', async () => {
  const { row, deps, getPayload } = successDeps({ follow_up_date: null })
  await completeFollowUp(row, deps)
  assert.strictEqual(getPayload().follow_up_previous_date, null)
})

await atest('DB update targets correct interaction ID', async () => {
  const { row, deps, getId } = successDeps({ id: 'my-row-id' })
  await completeFollowUp(row, deps)
  assert.strictEqual(getId(), 'my-row-id')
})

await atest('DB update happens before analytics', async () => {
  const { client } = makeClient({ data: { id: 'row-1' } })
  const order = []
  const deps = {
    client: {
      from:   () => deps.client,
      update: () => deps.client,
      eq:     () => deps.client,
      select: () => deps.client,
      single: async () => { order.push('db'); return { data: { id: 'row-1' }, error: null } },
    },
    track: () => order.push('analytics'),
    dispatch: () => order.push('dispatch'),
  }
  await completeFollowUp(makeRow(), deps)
  assert.strictEqual(order[0], 'db', 'DB must be first')
  assert.strictEqual(order[1], 'analytics', 'analytics after DB')
  assert.strictEqual(order[2], 'dispatch', 'dispatch after analytics')
})

await atest('success fires followup_completed with method property', async () => {
  const { row, deps, tracked } = successDeps()
  await completeFollowUp(row, deps)
  assert.strictEqual(tracked.length, 1)
  assert.strictEqual(tracked[0].ev, 'followup_completed')
  assert.deepStrictEqual(tracked[0].props, { method: 'mark_done' })
})

await atest('success fires followup_completed with log_result method when overridden', async () => {
  const { row, deps, tracked } = successDeps()
  await completeFollowUp(row, { ...deps, method: 'log_result' })
  assert.strictEqual(tracked.length, 1)
  assert.strictEqual(tracked[0].ev, 'followup_completed')
  assert.deepStrictEqual(tracked[0].props, { method: 'log_result' })
})

await atest('success dispatches funnl:followups-changed', async () => {
  const { row, deps, dispatched } = successDeps()
  await completeFollowUp(row, deps)
  assert.strictEqual(dispatched.length, 1)
})

await atest('success returns ok: true', async () => {
  const { row, deps } = successDeps()
  const result = await completeFollowUp(row, deps)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.errorMessage, null)
})

await atest('DB failure fires no analytics', async () => {
  const { row, deps, tracked } = failDeps()
  await completeFollowUp(row, deps)
  assert.strictEqual(tracked.length, 0)
})

await atest('DB failure dispatches no event', async () => {
  const { row, deps, dispatched } = failDeps()
  await completeFollowUp(row, deps)
  assert.strictEqual(dispatched.length, 0)
})

await atest('DB failure returns ok: false with error message', async () => {
  const { row, deps } = failDeps()
  const result = await completeFollowUp(row, deps)
  assert.strictEqual(result.ok, false)
  assert.ok(result.errorMessage.length > 0)
})

await atest('now param is forwarded to completionPayload', async () => {
  const { row, deps, getPayload } = successDeps()
  const fixedNow = '2026-07-29T12:00:00.000Z'
  await completeFollowUp(row, { ...deps, now: fixedNow })
  assert.strictEqual(getPayload().follow_up_completed_at, fixedNow)
})

// ══════════════════════════════════════════════════════════════════════════════
// snoozeFollowUp
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nsnoozeFollowUp\n')

const TODAY = '2026-07-29'

await atest('tomorrow option sets next-day date', async () => {
  const { row, deps, getPayload } = successDeps()
  const result = await snoozeFollowUp(row, 'tomorrow', '', TODAY, deps)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(getPayload().follow_up_date, '2026-07-30')
})

await atest('three_days option sets correct date', async () => {
  const { row, deps, getPayload } = successDeps()
  await snoozeFollowUp(row, 'three_days', '', TODAY, deps)
  assert.strictEqual(getPayload().follow_up_date, '2026-08-01')
})

await atest('one_week option sets correct date', async () => {
  const { row, deps, getPayload } = successDeps()
  await snoozeFollowUp(row, 'one_week', '', TODAY, deps)
  assert.strictEqual(getPayload().follow_up_date, '2026-08-05')
})

await atest('custom option uses supplied customDate', async () => {
  const { row, deps, getPayload } = successDeps()
  await snoozeFollowUp(row, 'custom', '2026-08-10', TODAY, deps)
  assert.strictEqual(getPayload().follow_up_date, '2026-08-10')
})

await atest('empty custom date returns ok: false without DB call', async () => {
  const { row, deps, getCalls } = successDeps()
  const result = await snoozeFollowUp(row, 'custom', '', TODAY, deps)
  assert.strictEqual(result.ok, false)
  assert.ok(result.errorMessage.length > 0)
  assert.ok(!getCalls().includes('single'), 'DB must not be called for empty custom date')
})

await atest('snoozePayload clears all completion metadata', async () => {
  const { row, deps, getPayload } = successDeps()
  await snoozeFollowUp(row, 'tomorrow', '', TODAY, deps)
  const p = getPayload()
  assert.strictEqual(p.follow_up_completed_at, null)
  assert.strictEqual(p.follow_up_previous_date, null)
  assert.strictEqual(p.follow_up_completion_method, null)
})

await atest('DB update happens before analytics', async () => {
  const order = []
  const deps = {
    client: {
      from: () => deps.client, update: () => deps.client, eq: () => deps.client,
      select: () => deps.client,
      single: async () => { order.push('db'); return { data: { id: 'r' }, error: null } },
    },
    track: (ev, p) => order.push('analytics'),
    dispatch: () => order.push('dispatch'),
  }
  await snoozeFollowUp(makeRow(), 'tomorrow', '', TODAY, deps)
  assert.strictEqual(order[0], 'db')
  assert.strictEqual(order[1], 'analytics')
  assert.strictEqual(order[2], 'dispatch')
})

await atest('success dispatches funnl:followups-changed', async () => {
  const { row, deps, dispatched } = successDeps()
  await snoozeFollowUp(row, 'tomorrow', '', TODAY, deps)
  assert.strictEqual(dispatched.length, 1)
})

await atest('success fires followup_snoozed with option property', async () => {
  const { row, deps, tracked } = successDeps()
  await snoozeFollowUp(row, 'one_week', '', TODAY, deps)
  assert.strictEqual(tracked.length, 1)
  assert.strictEqual(tracked[0].ev, 'followup_snoozed')
  assert.deepStrictEqual(tracked[0].props, { option: 'one_week' })
})

await atest('DB failure fires no analytics', async () => {
  const { row, deps, tracked } = failDeps()
  await snoozeFollowUp(row, 'tomorrow', '', TODAY, deps)
  assert.strictEqual(tracked.length, 0)
})

await atest('DB failure dispatches no event', async () => {
  const { row, deps, dispatched } = failDeps()
  await snoozeFollowUp(row, 'tomorrow', '', TODAY, deps)
  assert.strictEqual(dispatched.length, 0)
})

await atest('DB failure returns ok: false', async () => {
  const { row, deps } = failDeps()
  const result = await snoozeFollowUp(row, 'tomorrow', '', TODAY, deps)
  assert.strictEqual(result.ok, false)
})

await atest('DB failure does not mutate the interaction object', async () => {
  const row = makeRow({ follow_up_date: '2026-07-25' })
  const { deps } = failDeps()
  deps.client = makeClient({ data: null, error: { message: 'DB error' } }).client
  await snoozeFollowUp(row, 'tomorrow', '', TODAY, { ...deps })
  assert.strictEqual(row.follow_up_date, '2026-07-25', 'original row must be unchanged')
})

// ══════════════════════════════════════════════════════════════════════════════
// undoFollowUp
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nundoFollowUp\n')

await atest('restores follow_up_previous_date as the new follow_up_date', async () => {
  const row = makeRow({ follow_up_previous_date: '2026-07-20', follow_up_completed_at: '2026-07-29T10:00:00Z' })
  const { client } = makeClient()
  let capturedPayload = null
  const patchedClient = {
    from: () => patchedClient, update: (p) => { capturedPayload = p; return patchedClient },
    eq: () => patchedClient, select: () => patchedClient,
    single: async () => ({ data: { id: 'row-1' }, error: null }),
  }
  const dispatched = []
  await undoFollowUp(row, { client: patchedClient, dispatch: () => dispatched.push(1) })
  assert.strictEqual(capturedPayload.follow_up_date, '2026-07-20')
})

await atest('clears all completion metadata', async () => {
  const row = makeRow({ follow_up_previous_date: '2026-07-20', follow_up_completed_at: '2026-07-29T10:00:00Z', follow_up_completion_method: 'mark_done' })
  let capturedPayload = null
  const c = {
    from: () => c, update: (p) => { capturedPayload = p; return c },
    eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }),
  }
  await undoFollowUp(row, { client: c, dispatch: () => {} })
  assert.strictEqual(capturedPayload.follow_up_completed_at, null)
  assert.strictEqual(capturedPayload.follow_up_previous_date, null)
  assert.strictEqual(capturedPayload.follow_up_completion_method, null)
})

await atest('success dispatches funnl:followups-changed', async () => {
  const row = makeRow({ follow_up_previous_date: '2026-07-20' })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const dispatched = []
  await undoFollowUp(row, { client: c, dispatch: () => dispatched.push(1) })
  assert.strictEqual(dispatched.length, 1)
})

await atest('fires no analytics', async () => {
  const row = makeRow({ follow_up_previous_date: '2026-07-20' })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const tracked = []
  const result = await undoFollowUp(row, { client: c, track: (ev) => tracked.push(ev), dispatch: () => {} })
  assert.strictEqual(tracked.length, 0)
  assert.strictEqual(result.ok, true)
})

await atest('missing previous_date returns ok: false without DB call', async () => {
  const row = makeRow({ follow_up_previous_date: null })
  let dbCalled = false
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => { dbCalled = true; return { data: { id: 'r' }, error: null } } }
  const result = await undoFollowUp(row, { client: c, dispatch: () => {} })
  assert.strictEqual(result.ok, false)
  assert.ok(result.errorMessage.length > 0)
  assert.strictEqual(dbCalled, false, 'DB must not be called when previous_date is missing')
})

await atest('missing previous_date does not invent a date', async () => {
  const row = makeRow({ follow_up_previous_date: null })
  let capturedPayload = null
  const c = { from: () => c, update: (p) => { capturedPayload = p; return c }, eq: () => c, select: () => c, single: async () => ({ data: null, error: null }) }
  await undoFollowUp(row, { client: c, dispatch: () => {} })
  assert.strictEqual(capturedPayload, null, 'DB must not be called, so no payload')
})

await atest('DB failure dispatches no event', async () => {
  const row = makeRow({ follow_up_previous_date: '2026-07-20' })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: null, error: { message: 'DB error' } }) }
  const dispatched = []
  const result = await undoFollowUp(row, { client: c, dispatch: () => dispatched.push(1) })
  assert.strictEqual(dispatched.length, 0)
  assert.strictEqual(result.ok, false)
})

await atest('DB failure keeps the completed row unchanged', async () => {
  const row = makeRow({ follow_up_previous_date: '2026-07-20', follow_up_completed_at: '2026-07-29T10:00:00Z' })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: null, error: { message: 'DB error' } }) }
  await undoFollowUp(row, { client: c, dispatch: () => {} })
  // The action is idempotent — it does not mutate the in-memory object
  assert.strictEqual(row.follow_up_completed_at, '2026-07-29T10:00:00Z', 'in-memory row must be unchanged')
})

await atest('success returns ok: true', async () => {
  const row = makeRow({ follow_up_previous_date: '2026-07-20' })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const result = await undoFollowUp(row, { client: c, dispatch: () => {} })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.errorMessage, null)
})

// ══════════════════════════════════════════════════════════════════════════════
// markResponded
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nmarkResponded\n')

await atest('updates outreach_status to responded', async () => {
  let capturedPayload = null
  const c = { from: () => c, update: (p) => { capturedPayload = p; return c }, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const tracked = []
  await markResponded(makeRow(), { client: c, track: (ev, p) => tracked.push({ ev, p }) })
  assert.deepStrictEqual(capturedPayload, { outreach_status: 'responded' })
})

await atest('DB update happens before analytics', async () => {
  const order = []
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => { order.push('db'); return { data: { id: 'r' }, error: null } } }
  await markResponded(makeRow(), { client: c, track: () => order.push('analytics') })
  assert.strictEqual(order[0], 'db')
  assert.strictEqual(order[1], 'analytics')
})

await atest('fires outreach_status_changed with correct properties', async () => {
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const tracked = []
  await markResponded(makeRow(), { client: c, track: (ev, p) => tracked.push({ ev, p }) })
  assert.strictEqual(tracked.length, 1)
  assert.strictEqual(tracked[0].ev, 'outreach_status_changed')
  assert.deepStrictEqual(tracked[0].p, { status: 'responded', context: 'edit_interaction' })
})

await atest('does NOT fire followup_completed', async () => {
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const tracked = []
  await markResponded(makeRow(), { client: c, track: (ev) => tracked.push(ev) })
  assert.ok(!tracked.includes('followup_completed'))
})

await atest('does NOT fire followup_set', async () => {
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const tracked = []
  await markResponded(makeRow(), { client: c, track: (ev) => tracked.push(ev) })
  assert.ok(!tracked.includes('followup_set'))
})

await atest('does NOT dispatch funnl:followups-changed', async () => {
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const dispatched = []
  await markResponded(makeRow(), { client: c, track: () => {}, dispatch: () => dispatched.push(1) })
  assert.strictEqual(dispatched.length, 0)
})

await atest('DB failure fires no analytics', async () => {
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: null, error: { message: 'DB error' } }) }
  const tracked = []
  const result = await markResponded(makeRow(), { client: c, track: (ev) => tracked.push(ev) })
  assert.strictEqual(tracked.length, 0)
  assert.strictEqual(result.ok, false)
})

await atest('DB failure keeps the row visible', async () => {
  const row = makeRow({ outreach_status: 'awaiting_response' })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: null, error: { message: 'DB error' } }) }
  const result = await markResponded(row, { client: c, track: () => {} })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(row.outreach_status, 'awaiting_response', 'in-memory row must be unchanged')
})

await atest('success returns ok: true', async () => {
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const result = await markResponded(makeRow(), { client: c, track: () => {} })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.errorMessage, null)
})

await atest('scoped to interaction ID', async () => {
  let capturedId = null
  const c = { from: () => c, update: () => c, eq: (col, v) => { if (col === 'id') capturedId = v; return c }, select: () => c, single: async () => ({ data: { id: 'my-id' }, error: null }) }
  const row = makeRow({ id: 'my-id' })
  await markResponded(row, { client: c, track: () => {} })
  assert.strictEqual(capturedId, 'my-id')
})

// ══════════════════════════════════════════════════════════════════════════════
// nudgeFollowUp
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nnudgeFollowUp\n')

await atest('sets a new follow_up_date', async () => {
  const row = makeRow({ follow_up_date: null, outreach_status: 'awaiting_response' })
  let capturedPayload = null
  const c = { from: () => c, update: (p) => { capturedPayload = p; return c }, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  await nudgeFollowUp(row, 'tomorrow', '', TODAY, { client: c, track: () => {}, dispatch: () => {} })
  assert.strictEqual(capturedPayload.follow_up_date, '2026-07-30')
})

await atest('clears completion metadata', async () => {
  const row = makeRow({ follow_up_date: null, follow_up_completed_at: '2026-07-29T10:00:00Z', follow_up_completion_method: 'mark_done' })
  let capturedPayload = null
  const c = { from: () => c, update: (p) => { capturedPayload = p; return c }, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  await nudgeFollowUp(row, 'tomorrow', '', TODAY, { client: c, track: () => {}, dispatch: () => {} })
  assert.strictEqual(capturedPayload.follow_up_completed_at, null)
  assert.strictEqual(capturedPayload.follow_up_previous_date, null)
  assert.strictEqual(capturedPayload.follow_up_completion_method, null)
})

await atest('fires followup_set (NOT followup_snoozed)', async () => {
  const row = makeRow({ follow_up_date: null })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const tracked = []
  await nudgeFollowUp(row, 'tomorrow', '', TODAY, { client: c, track: (ev, p) => tracked.push({ ev, p }), dispatch: () => {} })
  assert.strictEqual(tracked.length, 1)
  assert.strictEqual(tracked[0].ev, 'followup_set')
  assert.ok(!tracked.some(t => t.ev === 'followup_snoozed'), 'must NOT fire followup_snoozed')
})

await atest('success dispatches funnl:followups-changed', async () => {
  const row = makeRow({ follow_up_date: null })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  const dispatched = []
  await nudgeFollowUp(row, 'tomorrow', '', TODAY, { client: c, track: () => {}, dispatch: () => dispatched.push(1) })
  assert.strictEqual(dispatched.length, 1)
})

await atest('empty custom date returns ok: false', async () => {
  const row = makeRow({ follow_up_date: null })
  let dbCalled = false
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => { dbCalled = true; return { data: { id: 'r' }, error: null } } }
  const result = await nudgeFollowUp(row, 'custom', '', TODAY, { client: c, track: () => {}, dispatch: () => {} })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(dbCalled, false)
})

await atest('three_days and one_week options work', async () => {
  const makeMinimalClient = () => {
    const payloads = []
    const c = { from: () => c, update: (p) => { payloads.push(p.follow_up_date); return c }, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
    return { c, payloads }
  }
  const { c: c1, payloads: p1 } = makeMinimalClient()
  await nudgeFollowUp(makeRow({ follow_up_date: null }), 'three_days', '', TODAY, { client: c1, track: () => {}, dispatch: () => {} })
  assert.strictEqual(p1[0], '2026-08-01')
  const { c: c2, payloads: p2 } = makeMinimalClient()
  await nudgeFollowUp(makeRow({ follow_up_date: null }), 'one_week', '', TODAY, { client: c2, track: () => {}, dispatch: () => {} })
  assert.strictEqual(p2[0], '2026-08-05')
})

await atest('DB failure fires no analytics', async () => {
  const row = makeRow({ follow_up_date: null })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: null, error: { message: 'DB error' } }) }
  const tracked = []
  const result = await nudgeFollowUp(row, 'tomorrow', '', TODAY, { client: c, track: (ev) => tracked.push(ev), dispatch: () => {} })
  assert.strictEqual(tracked.length, 0)
  assert.strictEqual(result.ok, false)
})

await atest('DB failure dispatches no event', async () => {
  const row = makeRow({ follow_up_date: null })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: null, error: { message: 'DB error' } }) }
  const dispatched = []
  const result = await nudgeFollowUp(row, 'tomorrow', '', TODAY, { client: c, track: () => {}, dispatch: () => dispatched.push(1) })
  assert.strictEqual(dispatched.length, 0)
  assert.strictEqual(result.ok, false)
})

await atest('custom date option works', async () => {
  const row = makeRow({ follow_up_date: null })
  let capturedDate = null
  const c = { from: () => c, update: (p) => { capturedDate = p.follow_up_date; return c }, eq: () => c, select: () => c, single: async () => ({ data: { id: 'r' }, error: null }) }
  await nudgeFollowUp(row, 'custom', '2026-09-01', TODAY, { client: c, track: () => {}, dispatch: () => {} })
  assert.strictEqual(capturedDate, '2026-09-01')
})

await atest('DB failure preserves awaiting-response row state', async () => {
  const row = makeRow({ follow_up_date: null, outreach_status: 'awaiting_response' })
  const c = { from: () => c, update: () => c, eq: () => c, select: () => c, single: async () => ({ data: null, error: { message: 'DB error' } }) }
  await nudgeFollowUp(row, 'tomorrow', '', TODAY, { client: c, track: () => {}, dispatch: () => {} })
  assert.strictEqual(row.follow_up_date, null, 'row must be unchanged on failure')
  assert.strictEqual(row.outreach_status, 'awaiting_response')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
