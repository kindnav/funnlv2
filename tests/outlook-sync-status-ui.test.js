// THE SETTINGS SYNC STATUS and THE SUGGESTIONS BADGE/REFRESH, as pure functions.
//
// Both modules are deliberately free of React and Supabase so their decisions can be proven
// here against the exact shapes the database RPC and the signature queries return. The
// browser harness (tests/local/outlook-pilot-browser.mjs, sections 7-10) then shows the same
// decisions rendered by the real bundle against the real PostgREST.
//
// REPRODUCED BEFORE THIS REVISION, and pinned here: "Up to date" while mail was signalled or a
// round was paused; automatic-check claims before any schedule was active; a refreshed
// proposal with an unchanged count going unnoticed; a whole-list reload on any change.
//
// Run with: node tests/outlook-sync-status-ui.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  describeSyncStatus, describeListening, describeAutomation, formatRelativePast, formatRelativeFuture, SYNC_TONES,
} from '../src/lib/outlookSyncStatus.js'
import {
  decideRefresh, badgeLabel, countPendingSuggestions, fetchPendingSignature, indexSignature, diffPendingSignature,
  mergeQueueRows, compareQueueRows, cardKey, nextSignatureCheckpoint, busyExcept,
  SUGGESTIONS_REFRESH_INTERVAL_MS, NEW_SUGGESTIONS_MESSAGE,
  UPDATED_SUGGESTIONS_MESSAGE, HELD_UPDATES_MESSAGE, SUGGESTIONS_CHANGED_EVENT,
} from '../src/lib/pendingSuggestions.js'
import { CANDIDATE_SELECT } from '../src/lib/calendarReview.js'
import { NCC_SELECT } from '../src/lib/newContactReview.js'

let passed = 0
let failed = 0
async function test (name, fn) {
  try { await fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name); console.error('       ' + (e && e.message ? e.message : String(e))); failed += 1
  }
}
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

const NOW = Date.parse('2026-10-08T12:00:00Z')
const iso = (deltaMs) => new Date(NOW + deltaMs).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const base = (over = {}) => ({
  result: 'connected', status: 'active', needs_reauth: false, activity: 'idle',
  last_success_at: iso(-7 * MIN), last_attempt_at: iso(-7 * MIN), last_run_complete: true, initial_import_done: true,
  last_error_code: null, next_retry_at: null, wake_pending: false, last_wake_at: null, pending_suggestions: 0,
  schedule_active: true,
  subscription: { status: 'active', expires_at: iso(2 * 24 * HOUR), last_notification_at: iso(-7 * MIN), last_error_code: null },
  server_now: iso(0), ...over,
})

console.log('')
console.log('1. the sync status is derived from persisted state, never from a timer')
await test('not connected / unauthorized / nothing -> no block at all', () => {
  assert.strictEqual(describeSyncStatus(null, NOW), null)
  assert.strictEqual(describeSyncStatus({ result: 'not_connected' }, NOW), null)
  assert.strictEqual(describeSyncStatus({ result: 'unauthorized' }, NOW), null)
})
await test('idle, complete, nothing signalled -> "Up to date" with the last success and the listener renewal', () => {
  const v = describeSyncStatus(base(), NOW)
  assert.strictEqual(v.tone, 'ok')
  assert.strictEqual(v.headline, 'Up to date')
  assert.strictEqual(v.detail, 'Last successful sync 7 minutes ago.')
  assert.strictEqual(v.listening.text, 'Listening for new mail (renews in 2 days).')
  assert.strictEqual(v.reconnect, false)
})
await test('PENDING MAIL is never "Up to date": a recorded signal reads "A check is due"', () => {
  const v = describeSyncStatus(base({ wake_pending: true }), NOW)
  assert.strictEqual(v.headline, 'A check is due')
  assert.strictEqual(v.tone, 'info')
  assert.ok(v.detail.startsWith('New mail was signalled and has not been checked yet.'), v.detail)
  assert.ok(v.detail.includes('next automatic check'), 'with the schedule on, it says who picks it up')
  assert.strictEqual(v.queued, true)
})
await test('an INCOMPLETE last round is never "Up to date" either', () => {
  const v = describeSyncStatus(base({ last_run_complete: false }), NOW)
  assert.strictEqual(v.headline, 'A check is due')
  assert.ok(v.detail.startsWith('The last check paused before finishing the mailbox.'), v.detail)
  const off = describeSyncStatus(base({ last_run_complete: false, schedule_active: false }), NOW)
  assert.ok(!off.detail.includes('automatic check'), 'no automatic-check claim while the schedule is off: ' + off.detail)
})
await test('a live lease -> "Checking your mailbox now" (info), still with the last success', () => {
  const v = describeSyncStatus(base({ activity: 'running', wake_pending: true }), NOW)
  assert.strictEqual(v.tone, 'info')
  assert.strictEqual(v.headline, 'Checking your mailbox now')
  assert.strictEqual(v.detail, 'Last successful sync 7 minutes ago.')
  assert.strictEqual(describeSyncStatus(base({ activity: 'running', last_success_at: null }), NOW).detail, 'This is the first check.')
})
await test('a scheduled retry -> warn with when and the code; a bare error -> warn, and "scheduled" only when the schedule is on', () => {
  const v = describeSyncStatus(base({ activity: 'retry_scheduled', next_retry_at: iso(20 * MIN), last_error_code: 'graph_failed' }), NOW)
  assert.strictEqual(v.tone, 'warn')
  assert.strictEqual(v.headline, 'The last check did not finish')
  assert.strictEqual(v.detail, 'Funnl will try again in 20 minutes (graph_failed). Last successful sync 7 minutes ago.')
  const on = describeSyncStatus(base({ activity: 'error', last_error_code: 'token_refresh_failed' }), NOW)
  assert.ok(on.detail.includes('The next scheduled check will try again.'), on.detail)
  const off = describeSyncStatus(base({ activity: 'error', last_error_code: 'token_refresh_failed', schedule_active: false }), NOW)
  assert.ok(off.detail.includes('The next check will try again.') && !off.detail.includes('scheduled'), off.detail)
})
await test('needs_reauth or a non-active status -> error with the reconnect instruction, whatever else the row says', () => {
  for (const over of [{ needs_reauth: true }, { status: 'needs_reauth' }, { status: 'revoked', activity: 'running' }]) {
    const v = describeSyncStatus(base(over), NOW)
    assert.strictEqual(v.tone, 'error', JSON.stringify(over))
    assert.strictEqual(v.headline, 'Needs your permission again')
    assert.strictEqual(v.reconnect, true)
  }
})
await test('never synced: the first-check promise depends on the schedule flag', () => {
  const on = describeSyncStatus(base({ activity: 'never_synced', last_success_at: null, subscription: null }), NOW)
  assert.strictEqual(on.headline, 'Not synced yet')
  assert.strictEqual(on.detail, 'The first check runs automatically within a few minutes.')
  const off = describeSyncStatus(base({ activity: 'never_synced', last_success_at: null, subscription: null, schedule_active: false }), NOW)
  assert.strictEqual(off.detail, 'The first check has not run.')
  assert.strictEqual(off.listening.text, 'Not yet listening for new mail.', 'no "every 15 minutes" claim while the schedule is off')
  assert.strictEqual(on.listening.text, 'Not yet listening for new mail. Scheduled checks continue about every 15 minutes.')
})
await test('the automation line states the activation state, never a wish', () => {
  assert.deepStrictEqual(describeAutomation(true), { text: 'Automatic checks are on: about every 15 minutes, and within minutes of new mail.', on: true })
  assert.deepStrictEqual(describeAutomation(false), { text: 'Automatic checks are not switched on yet. Checks run only when started by Funnl.', on: false })
  assert.deepStrictEqual(describeAutomation(undefined).on, false, 'absent means off')
  assert.strictEqual(describeSyncStatus(base({ schedule_active: false }), NOW).automation.on, false)
})
await test('the listener line follows the subscription record: reauthorize, removed, failed, expired', () => {
  assert.strictEqual(describeListening({ status: 'reauthorize', expires_at: iso(HOUR) }, NOW).tone, 'warn')
  assert.ok(describeListening({ status: 'removed', expires_at: iso(HOUR) }, NOW).text.includes('removed'))
  const failedOff = describeListening({ status: 'failed', expires_at: null, last_error_code: 'bad_request' }, NOW, false)
  assert.ok(failedOff.text.includes('(bad_request)') && !failedOff.text.includes('15 minutes'), failedOff.text)
  assert.ok(describeListening({ status: 'active', expires_at: iso(-1) }, NOW).text.includes('expired'))
  assert.ok(SYNC_TONES.includes('muted'))
})
await test('relative times are coarse and never negative; the server clock is what they are measured against', () => {
  assert.strictEqual(formatRelativePast(iso(-10_000), NOW), 'just now')
  assert.strictEqual(formatRelativePast(iso(-MIN), NOW), '1 minute ago')
  assert.strictEqual(formatRelativePast(iso(-3 * HOUR), NOW), '3 hours ago')
  assert.strictEqual(formatRelativePast(iso(+HOUR), NOW), 'just now', 'a future stamp (clock skew) is not negative')
  assert.strictEqual(formatRelativeFuture(iso(30_000), NOW), 'in under a minute')
  assert.strictEqual(formatRelativeFuture(iso(-MIN), NOW), '', 'the past is not "in"')
  assert.strictEqual(describeSyncStatus(base({ server_now: iso(3 * HOUR) }), undefined).detail, 'Last successful sync 3 hours ago.')
})

console.log('')
console.log('2. the badge, the signature, and the merge that keeps review work')
await test('badge labels: nothing under 1, the number to 9, then 9+', () => {
  assert.strictEqual(badgeLabel(0), null)
  assert.strictEqual(badgeLabel(1), '1')
  assert.strictEqual(badgeLabel(9), '9')
  assert.strictEqual(badgeLabel(10), '9+')
  assert.deepStrictEqual(decideRefresh(2, 3), { reload: true, announce: true })
})
await test('the pending count sums BOTH queues with head requests, and a failure is null, never zero', async () => {
  const calls = []
  const client = { from: (table) => ({ select: (cols, opts) => ({ eq: async (col, val) => { calls.push({ table, cols, opts, col, val }); return table === 'interaction_candidates' ? { count: 2, error: null } : { count: 1, error: null } } }) }) }
  assert.strictEqual(await countPendingSuggestions(client), 3)
  assert.deepStrictEqual(calls.map((c) => c.table).sort(), ['interaction_candidates', 'new_contact_candidates'])
  const failing = { from: () => ({ select: () => ({ eq: async () => ({ count: null, error: { message: 'x' } }) }) }) }
  assert.strictEqual(await countPendingSuggestions(failing), null)
})
await test('the signature reads ids and updated_at only, from both queues, bounded; a failure is null', async () => {
  const calls = []
  const client = { from: (table) => ({ select: (cols) => ({ eq: (col, val) => ({ limit: async (n) => {
    calls.push({ table, cols, col, val, n })
    return table === 'interaction_candidates'
      ? { data: [{ id: 'i1', updated_at: 't1' }], error: null }
      : { data: [{ id: 'n1', updated_at: 't2' }], error: null }
  } }) }) }) }
  const rows = await fetchPendingSignature(client)
  assert.deepStrictEqual(rows, [{ id: 'i1', kind: 'interaction', updatedAt: 't1' }, { id: 'n1', kind: 'new_contact', updatedAt: 't2' }])
  for (const c of calls) { assert.strictEqual(c.cols, 'id, updated_at'); assert.strictEqual(c.col, 'status'); assert.strictEqual(c.val, 'pending'); assert.strictEqual(c.n, 500) }
  const failing = { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: 'x' } }) }) }) }) }
  assert.strictEqual(await fetchPendingSignature(failing), null)
})
await test('the diff sees arrivals, REFRESHED proposals (same id, newer updated_at) and resolutions; the first observation learns only', () => {
  const t0 = [{ id: 'a', kind: 'interaction', updatedAt: '1' }, { id: 'b', kind: 'new_contact', updatedAt: '1' }]
  assert.deepStrictEqual(diffPendingSignature(null, t0), { added: [], changed: [], removed: [] })
  const known = indexSignature(t0)
  const t1 = [{ id: 'a', kind: 'interaction', updatedAt: '2' }, { id: 'c', kind: 'interaction', updatedAt: '1' }]
  assert.deepStrictEqual(diffPendingSignature(known, t1), {
    added: [{ id: 'c', kind: 'interaction' }], changed: [{ id: 'a', kind: 'interaction' }], removed: [{ id: 'b', kind: 'new_contact' }],
  })
  assert.deepStrictEqual(diffPendingSignature(known, t0), { added: [], changed: [], removed: [] }, 'an unchanged signature is no change, whatever the count')
  assert.deepStrictEqual(diffPendingSignature(known, null), { added: [], changed: [], removed: [] })
})
await test('the merge inserts arrivals in queue order and never disturbs a BUSY card: its update is HELD', () => {
  const row = (id, date, updated = '1') => ({ id, proposed_interaction_date: date, updated_at: updated, proposed_notes: 'v' + updated })
  const list = [row('b', '2026-10-05'), row('a', '2026-10-01')]
  const r = mergeQueueRows({
    list,
    added: [row('c', '2026-10-07'), row('d', '2026-10-03')],
    changed: [row('a', '2026-10-01', '2'), row('b', '2026-10-05', '2')],
    removedIds: [],
    busy: new Set(['a']),
  })
  assert.deepStrictEqual(r.list.map((x) => x.id), ['c', 'b', 'd', 'a'], 'queue order: date DESC, id DESC')
  assert.strictEqual(r.list.find((x) => x.id === 'b').updated_at, '2', 'a free card takes the refreshed row')
  assert.strictEqual(r.list.find((x) => x.id === 'a').updated_at, '1', 'a busy card keeps what the reviewer is working on')
  assert.deepStrictEqual(r.held.map((h) => h.id), ['a'])
  assert.deepStrictEqual(r.applied, { added: 2, changed: 1, removed: 0 })
  const rm = mergeQueueRows({ list: r.list, removedIds: ['c', 'a'], busy: new Set(['a']) })
  assert.deepStrictEqual(rm.list.map((x) => x.id), ['b', 'd', 'a'], 'a resolution elsewhere removes a free card and holds a busy one')
  assert.deepStrictEqual(rm.held, [{ id: 'a', row: null }])
  assert.strictEqual(cardKey(row('a', 'x', '2')), 'a:2', 'a refreshed row remounts under a new key; an untouched one does not')
  assert.ok(compareQueueRows(row('x', '2026-10-02'), row('y', '2026-10-01')) < 0)
})
await test('the merge is PURE: inputs untouched, the same plan twice, and a released card takes its update while the others keep theirs', () => {
  const row = (id, date, updated = '1') => ({ id, proposed_interaction_date: date, updated_at: updated })
  const list = [row('b', '2026-10-05'), row('a', '2026-10-01')]
  const listCopy = JSON.parse(JSON.stringify(list))
  const busy = new Set(['a', 'b'])
  const change = { list, changed: [row('a', '2026-10-01', '2'), row('b', '2026-10-05', '2')], busy }
  const r1 = mergeQueueRows(change)
  const r2 = mergeQueueRows(change)
  assert.deepStrictEqual(list, listCopy, 'the input list is not mutated')
  assert.deepStrictEqual([...busy], ['a', 'b'], 'the busy set is not mutated')
  assert.deepStrictEqual(r1, r2, 'planning twice from the same inputs gives the same plan (safe to re-plan inside a pure updater)')
  assert.deepStrictEqual(r1.held.map((h) => h.id), ['a', 'b'])
  // The reviewer releases ONE card explicitly: only that card takes its update.
  const released = busyExcept(busy, 'a')
  assert.deepStrictEqual([...busy], ['a', 'b'], 'busyExcept never mutates its input')
  const r3 = mergeQueueRows({ ...change, busy: released })
  assert.strictEqual(r3.list.find((x) => x.id === 'a').updated_at, '2', 'the released card took the newer draft')
  assert.strictEqual(r3.list.find((x) => x.id === 'b').updated_at, '1', 'the other busy card kept its hold')
  assert.deepStrictEqual(r3.held.map((h) => h.id), ['b'])
})
await test('the signature CHECKPOINT advances only after the changed rows were fetched and applied or held', () => {
  const t0 = [{ id: 'a', kind: 'interaction', updatedAt: '1' }]
  const t1 = [{ id: 'a', kind: 'interaction', updatedAt: '1' }, { id: 'b', kind: 'interaction', updatedAt: '1' }]
  const known = indexSignature(t0)
  assert.deepStrictEqual(nextSignatureCheckpoint(null, t0, true), known, 'the first observation learns only')
  assert.strictEqual(nextSignatureCheckpoint(known, t1, false), known, 'a FAILED row fetch leaves the checkpoint where it was...')
  assert.deepStrictEqual(diffPendingSignature(nextSignatureCheckpoint(known, t1, false), t1).added.map((e) => e.id), ['b'], '...so the next poll sees the SAME arrival again and retries, with the signature unchanged')
  assert.deepStrictEqual(nextSignatureCheckpoint(known, t1, true), indexSignature(t1), 'an applied fetch advances it')
  assert.deepStrictEqual(diffPendingSignature(nextSignatureCheckpoint(known, t1, true), t1), { added: [], changed: [], removed: [] })
})
await test('the selects carry updated_at so refreshed proposals are detectable and re-keyable', () => {
  assert.ok(CANDIDATE_SELECT.includes('updated_at'))
  assert.ok(NCC_SELECT.includes('updated_at'))
  assert.strictEqual(SUGGESTIONS_REFRESH_INTERVAL_MS, 30_000)
  assert.ok(NEW_SUGGESTIONS_MESSAGE.length > 0 && UPDATED_SUGGESTIONS_MESSAGE.length > 0 && HELD_UPDATES_MESSAGE.includes('editing'))
  assert.strictEqual(SUGGESTIONS_CHANGED_EVENT, 'funnl:suggestions-changed')
})

console.log('')
console.log('3. the wiring: gated navigation, a non-destructive poll, cards that report when they are busy')
await test('Sidebar and BottomNav mount the Suggestions entry under SUGGESTION_REVIEW_ENABLED, with the shared badge', () => {
  for (const src of [read('src/components/Sidebar.jsx'), read('src/components/BottomNav.jsx')]) {
    assert.ok(src.includes('usePendingSuggestionCount(SUGGESTION_REVIEW_ENABLED)'))
    assert.ok(src.includes('{SUGGESTION_REVIEW_ENABLED && ('))
    assert.ok(src.includes('to="/suggestions"'))
  }
  const hook = read('src/lib/usePendingSuggestionCount.js')
  assert.ok(hook.includes('setInterval(tick, SUGGESTIONS_REFRESH_INTERVAL_MS)'), 'the badge polls while another page is open')
  assert.ok(hook.includes("document.visibilityState === 'visible'"))
})
await test('the Suggestions page polls the SIGNATURE, merges card by card from a snapshot with pure updaters, holds updates to busy cards, and never calls loadInitial from the poll', () => {
  const page = read('src/pages/SuggestionsPage.jsx')
  assert.ok(page.includes('fetchPendingSignature(supabase)'))
  assert.ok(page.includes('diffPendingSignature(knownRef.current, fresh)'))
  assert.ok(page.includes('setBanner(HELD_UPDATES_MESSAGE)'))
  assert.ok(page.includes('key={cardKey(c)}'), 'cards are keyed by id and row version')
  assert.ok(page.includes('onBusyChange={onBusyChange}'))
  // The plan is computed OUTSIDE the state updater, from the list snapshot; the updater is pure
  // and re-plans from prev when the snapshot is stale. Nothing is assigned inside an updater.
  assert.ok(page.includes('const planned = mergeQueueRows({ list: snapshot, added, changed, removedIds, busy })'))
  assert.ok(page.includes('mergeQueueRows({ list: prev, added, changed, removedIds, busy }).list))'))
  assert.ok(!/setter\(\(prev\) => \{[^}]*=[^=>][^}]*\}\)/.test(page), 'no assignment inside a state updater')
  assert.ok(!page.includes('let heldOut'), 'the held list is not captured through an updater side effect')
  const pollStart = page.indexOf('const poll = async () => {')
  const pollEnd = page.indexOf('const timer = setInterval(poll, SUGGESTIONS_REFRESH_INTERVAL_MS)')
  assert.ok(pollStart > 0 && pollEnd > pollStart)
  const poll = page.slice(pollStart, pollEnd)
  assert.ok(!poll.includes('loadInitial('), 'the poll never reloads the list')
  // The checkpoint advances AFTER the rows were fetched and applied; a failed fetch keeps it.
  const fetchAt = poll.indexOf('await fetchRows(')
  const failAt = poll.indexOf('if (rows === null) { knownRef.current = nextSignatureCheckpoint(knownRef.current, fresh, false); return }')
  const advanceAt = poll.indexOf('knownRef.current = nextSignatureCheckpoint(knownRef.current, fresh, true)')
  assert.ok(fetchAt > 0 && failAt > fetchAt && advanceAt > failAt, 'fetch, then (keep on failure), then advance')
  assert.ok(poll.indexOf('applyMerge(itemsRef, setItems') < advanceAt && poll.indexOf('holdUpdates(') < advanceAt, 'applied or held BEFORE the checkpoint moves')
  assert.ok(!/supabase\.channel\(|postgres_changes/.test(page), 'no realtime channel')
  for (const card of [page, read('src/components/NewContactSuggestionCard.jsx')]) {
    assert.ok(card.includes("onBusyChange(candidate.id, busyNow)"), 'each card reports busy')
    assert.ok(card.includes('<PendingUpdateNotice pendingUpdate={pendingUpdate} busy={busy} onTake={() => onTakeUpdate?.(candidate.id)} />'), 'each card offers the waiting update as an explicit choice')
  }
  // A DIRTY existing-contact card stays protected after Done editing: dirty is part of busy.
  assert.ok(page.includes('const busyNow = editing || dirty || confirmDismiss || busy'), 'dirty keeps the hold after Done editing')
  assert.ok(page.includes('{!editing && notes && ('), 'the collapsed view shows the note that will be saved')
  const notice = read('src/components/PendingUpdateNotice.jsx')
  assert.ok(notice.includes("'Use newer draft'") && notice.includes("'Remove from list'"))
  assert.ok(page.includes('busyExcept(busyRef.current, id)'), 'taking the update releases only that card')
})
await test('the Settings card mounts the sync status on the CONNECTED branch only; the component shows the activation line from the RPC', () => {
  const card = read('src/components/OutlookConnectionCard.jsx')
  const idx = card.indexOf('<OutlookSyncStatus />')
  assert.ok(idx > card.indexOf("status === 'connected' && connection && (") && idx < card.indexOf("status === 'not_connected' && ("))
  const comp = read('src/components/OutlookSyncStatus.jsx')
  assert.ok(comp.includes("supabase.rpc('get_my_outlook_sync_status')"))
  assert.ok(comp.includes('data-testid="outlook-automation"'))
  assert.ok(!/service_role|SUPABASE_SERVICE/i.test(comp))
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exit(1)
