// THE SETTINGS SYNC STATUS and THE SUGGESTIONS BADGE/REFRESH, as pure functions.
//
// Both modules are deliberately free of React and Supabase so their decisions can be proven
// here against the exact shapes the database RPC and the head-count queries return. The
// browser harness (tests/local/outlook-pilot-browser.mjs, sections 7-9) then shows the same
// decisions rendered by the real bundle against the real PostgREST.
//
// Run with: node tests/outlook-sync-status-ui.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  describeSyncStatus, describeListening, formatRelativePast, formatRelativeFuture, SYNC_TONES,
} from '../src/lib/outlookSyncStatus.js'
import {
  decideRefresh, badgeLabel, countPendingSuggestions, SUGGESTIONS_REFRESH_INTERVAL_MS, NEW_SUGGESTIONS_MESSAGE,
  SUGGESTIONS_CHANGED_EVENT,
} from '../src/lib/pendingSuggestions.js'

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
await test('idle after a complete run -> "Up to date", last success as a relative time, listening with its renewal', () => {
  const v = describeSyncStatus(base(), NOW)
  assert.strictEqual(v.tone, 'ok')
  assert.strictEqual(v.headline, 'Up to date')
  assert.strictEqual(v.detail, 'Last successful sync 7 minutes ago.')
  assert.strictEqual(v.listening.tone, 'ok')
  assert.strictEqual(v.listening.text, 'Listening for new mail (renews in 2 days).')
  assert.strictEqual(v.reconnect, false)
})
await test('a pending wake-up is said: "New mail was signalled; a check is queued."', () => {
  const v = describeSyncStatus(base({ wake_pending: true }), NOW)
  assert.ok(v.detail.includes('New mail was signalled; a check is queued.'), v.detail)
  assert.strictEqual(v.queued, true)
})
await test('a live lease -> "Checking your mailbox now" (info), still with the last success', () => {
  const v = describeSyncStatus(base({ activity: 'running' }), NOW)
  assert.strictEqual(v.tone, 'info')
  assert.strictEqual(v.headline, 'Checking your mailbox now')
  assert.strictEqual(v.detail, 'Last successful sync 7 minutes ago.')
  const first = describeSyncStatus(base({ activity: 'running', last_success_at: null }), NOW)
  assert.strictEqual(first.detail, 'This is the first check.')
})
await test('a scheduled retry -> warn, with when and the recorded code; a bare error -> warn with the code', () => {
  const v = describeSyncStatus(base({ activity: 'retry_scheduled', next_retry_at: iso(20 * MIN), last_error_code: 'graph_failed' }), NOW)
  assert.strictEqual(v.tone, 'warn')
  assert.strictEqual(v.headline, 'The last check did not finish')
  assert.strictEqual(v.detail, 'Funnl will try again in 20 minutes (graph_failed). Last successful sync 7 minutes ago.')
  const e = describeSyncStatus(base({ activity: 'error', last_error_code: 'token_refresh_failed' }), NOW)
  assert.strictEqual(e.tone, 'warn')
  assert.ok(e.detail.startsWith('Reason: token_refresh_failed. '), e.detail)
})
await test('needs_reauth or a non-active status -> error with the reconnect instruction, whatever else the row says', () => {
  for (const over of [{ needs_reauth: true }, { status: 'needs_reauth' }, { status: 'revoked', activity: 'running' }]) {
    const v = describeSyncStatus(base(over), NOW)
    assert.strictEqual(v.tone, 'error', JSON.stringify(over))
    assert.strictEqual(v.headline, 'Needs your permission again')
    assert.strictEqual(v.reconnect, true)
  }
})
await test('never synced -> muted, and says whether the first check is queued', () => {
  const v = describeSyncStatus(base({ activity: 'never_synced', last_success_at: null, subscription: null }), NOW)
  assert.strictEqual(v.tone, 'muted')
  assert.strictEqual(v.headline, 'Not synced yet')
  assert.strictEqual(v.detail, 'The first check runs automatically within a few minutes.')
  assert.strictEqual(v.listening.text, 'Not yet listening for new mail. Checks still run about every 15 minutes.')
  const q = describeSyncStatus(base({ activity: 'never_synced', last_success_at: null, wake_pending: true }), NOW)
  assert.strictEqual(q.detail, 'New mail was signalled; the first check is queued.')
})
await test('the listener line follows the subscription record: reauthorize, removed, failed, expired', () => {
  assert.strictEqual(describeListening({ status: 'reauthorize', expires_at: iso(HOUR) }, NOW).tone, 'warn')
  assert.ok(describeListening({ status: 'removed', expires_at: iso(HOUR) }, NOW).text.includes('removed'))
  assert.ok(describeListening({ status: 'failed', expires_at: null, last_error_code: 'bad_request' }, NOW).text.includes('(bad_request)'))
  assert.ok(describeListening({ status: 'active', expires_at: iso(-1) }, NOW).text.includes('expired'))
  assert.ok(SYNC_TONES.includes('muted'))
})
await test('relative times are coarse and never negative; the server clock is what they are measured against', () => {
  assert.strictEqual(formatRelativePast(iso(-10_000), NOW), 'just now')
  assert.strictEqual(formatRelativePast(iso(-MIN), NOW), '1 minute ago')
  assert.strictEqual(formatRelativePast(iso(-3 * HOUR), NOW), '3 hours ago')
  assert.strictEqual(formatRelativePast(iso(-2 * 24 * HOUR), NOW), '2 days ago')
  assert.strictEqual(formatRelativePast(iso(+HOUR), NOW), 'just now', 'a future stamp (clock skew) is not negative')
  assert.strictEqual(formatRelativePast('garbage', NOW), '')
  assert.strictEqual(formatRelativeFuture(iso(30_000), NOW), 'in under a minute')
  assert.strictEqual(formatRelativeFuture(iso(-MIN), NOW), '', 'the past is not "in"')
})
await test('the status uses server_now by default, so a wrong device clock cannot make a stale sync look fresh', () => {
  const v = describeSyncStatus(base({ server_now: iso(3 * HOUR) }), undefined)
  assert.strictEqual(v.detail, 'Last successful sync 3 hours ago.')
})

console.log('')
console.log('2. the badge and the refresh decision')
await test('badge labels: nothing under 1, the number to 9, then 9+', () => {
  assert.strictEqual(badgeLabel(0), null)
  assert.strictEqual(badgeLabel(-1), null)
  assert.strictEqual(badgeLabel(1), '1')
  assert.strictEqual(badgeLabel(9), '9')
  assert.strictEqual(badgeLabel(10), '9+')
  assert.strictEqual(badgeLabel('3'), null)
})
await test('the first observation only learns; a changed count reloads; an increase announces; a failed count does nothing', () => {
  assert.deepStrictEqual(decideRefresh(null, 2), { reload: false, announce: false })
  assert.deepStrictEqual(decideRefresh(2, 2), { reload: false, announce: false })
  assert.deepStrictEqual(decideRefresh(2, 3), { reload: true, announce: true })
  assert.deepStrictEqual(decideRefresh(3, 1), { reload: true, announce: false })
  assert.deepStrictEqual(decideRefresh(3, null), { reload: false, announce: false })
})
await test('the pending count sums BOTH queues with head requests, and a failure is null, never zero', async () => {
  const calls = []
  const client = { from: (table) => ({ select: (cols, opts) => ({ eq: async (col, val) => { calls.push({ table, cols, opts, col, val }); return table === 'interaction_candidates' ? { count: 2, error: null } : { count: 1, error: null } } }) }) }
  assert.strictEqual(await countPendingSuggestions(client), 3)
  assert.deepStrictEqual(calls.map((c) => c.table).sort(), ['interaction_candidates', 'new_contact_candidates'])
  for (const c of calls) { assert.deepStrictEqual(c.opts, { count: 'exact', head: true }); assert.strictEqual(c.col, 'status'); assert.strictEqual(c.val, 'pending') }
  const failing = { from: () => ({ select: () => ({ eq: async () => ({ count: null, error: { message: 'x' } }) }) }) }
  assert.strictEqual(await countPendingSuggestions(failing), null)
  const throwing = { from: () => { throw new Error('offline') } }
  assert.strictEqual(await countPendingSuggestions(throwing), null)
})
await test('the refresh interval is bounded (30 s) and the page announces arrivals in plain words', () => {
  assert.strictEqual(SUGGESTIONS_REFRESH_INTERVAL_MS, 30_000)
  assert.strictEqual(NEW_SUGGESTIONS_MESSAGE, 'New suggestions arrived. The list has been refreshed.')
  assert.strictEqual(SUGGESTIONS_CHANGED_EVENT, 'funnl:suggestions-changed')
})

console.log('')
console.log('3. the navigation is gated with the route, and the page polls only while visible')
await test('Sidebar and BottomNav mount the Suggestions entry under SUGGESTION_REVIEW_ENABLED, with the shared badge', () => {
  const side = read('src/components/Sidebar.jsx')
  const bottom = read('src/components/BottomNav.jsx')
  for (const src of [side, bottom]) {
    assert.ok(src.includes("from '../lib/suggestionReview'"))
    assert.ok(src.includes('usePendingSuggestionCount(SUGGESTION_REVIEW_ENABLED)'))
    assert.ok(src.includes('{SUGGESTION_REVIEW_ENABLED && ('))
    assert.ok(src.includes('to="/suggestions"'))
    assert.ok(src.includes('badgeLabel(pendingSuggestions)'))
  }
  const app = read('src/App.jsx')
  assert.ok(app.includes('{SUGGESTION_REVIEW_ENABLED && (') && app.includes('path="/suggestions"'), 'the route keeps the same gate')
})
await test('the Suggestions page polls on the shared interval, only when visible, and tells the badge about every change', () => {
  const page = read('src/pages/SuggestionsPage.jsx')
  assert.ok(page.includes('setInterval(poll, SUGGESTIONS_REFRESH_INTERVAL_MS)'))
  assert.ok(page.includes("document.visibilityState !== 'visible') return"))
  assert.ok(page.includes("document.addEventListener('visibilitychange', poll)"))
  assert.ok(page.includes('decideRefresh(knownPendingRef.current, fresh)'))
  assert.ok(page.includes('new Event(SUGGESTIONS_CHANGED_EVENT)'))
  assert.ok(!/supabase\.channel\(|postgres_changes/.test(page), 'no realtime channel: the simplest supported approach is the head-count poll')
})
await test('the Settings card mounts the sync status on the CONNECTED branch only, and the component reads one authenticated RPC', () => {
  const card = read('src/components/OutlookConnectionCard.jsx')
  const idx = card.indexOf('<OutlookSyncStatus />')
  assert.ok(idx > 0)
  assert.ok(idx > card.indexOf("status === 'connected' && connection && ("), 'inside the connected branch')
  assert.ok(idx < card.indexOf("status === 'not_connected' && ("), 'and before the not-connected branch')
  const comp = read('src/components/OutlookSyncStatus.jsx')
  assert.ok(comp.includes("supabase.rpc('get_my_outlook_sync_status')"))
  assert.ok(!/service_role|SUPABASE_SERVICE/i.test(comp))
  assert.ok(comp.includes("Date.parse(answer?.server_now"), 'the server clock, not the device clock')
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exit(1)
