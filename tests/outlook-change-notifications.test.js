// THE NOTIFICATION ENDPOINT - what Microsoft Graph POSTs, and what Funnl does with it.
//
// What is executed: the REAL handler (supabase/functions/outlook-notifications/handler.js)
// over real Request objects, with ONE injected database port that records every call, and
// an injected kick. Microsoft's behaviour is SIMULATED by the payloads below, shaped exactly
// as change-notifications-delivery-webhooks and change-notifications-lifecycle-events
// document them; this is not live-provider evidence.
//
// THE ACKNOWLEDGEMENT CONTRACT PROVEN HERE (see the handler's header): 202 only when every
// item reached a definitive database answer; 503 - which Microsoft retries - when the batch
// could not be durably recorded (port failure, unknown shape, or the ingress budget ran out).
// Reproduced before the fix: the first revision answered 202 on an rpc_error, and the test
// of that revision asserted it.
//
// NO REAL IDENTIFIER, ADDRESS, BODY OR SECRET APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-change-notifications.test.js

import assert from 'node:assert'
import { webcrypto } from 'node:crypto'
import {
  readValidationToken, parseNotificationBatch, coalesceNotifications, hashClientState,
  summarizeNotificationOutcomes, NOTIFICATION_KINDS, NOTIFICATION_OUTCOMES, MAX_NOTIFICATIONS_PER_REQUEST,
} from '../supabase/functions/shared/outlookChangeNotifications.js'
import {
  handleOutlookNotifications, makeWorkerKick, readBatchResults, NOTIFICATION_RPC, INGRESS_BUDGET_MS,
  DEFINITIVE_OUTCOMES, flagEnabled,
} from '../supabase/functions/outlook-notifications/handler.js'

let passed = 0
let failed = 0
async function test (name, fn) {
  try { await fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name); console.error('       ' + (e && e.message ? e.message : String(e))); failed += 1
  }
}

const subtle = webcrypto.subtle
const URL_BASE = 'https://project.supabase.test/functions/v1/outlook-notifications'
const SUB = '7f105c7d-2dc5-4530-97cd-4e7ae6534c07'
const SUB2 = '0a1b2c3d-0000-4000-8000-000000000002'
const STATE = 'fixture-client-state-not-a-secret'
const tick = () => new Promise((r) => setTimeout(r, 0))

const change = (over = {}) => ({
  id: 'lsgTZMr9KwAAA', subscriptionId: SUB, subscriptionExpirationDateTime: '2026-10-11T22:11:09.952Z',
  clientState: STATE, changeType: 'created', resource: 'users/{id}/messages/{long_id}',
  tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
  resourceData: { '@odata.type': '#Microsoft.Graph.Message', '@odata.id': 'Users/{id}/Messages/{long_id}', id: 'AAMk-fixture' },
  ...over,
})
const lifecycle = (event, over = {}) => ({
  subscriptionId: SUB, subscriptionExpirationDateTime: '2026-10-11T22:11:09.952Z', tenantId: 't', clientState: STATE,
  lifecycleEvent: event, ...over,
})

function post (body, url = URL_BASE) {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

/**
 * The database port: `answer` is a per-call result code for every item, a list of codes,
 * a function, an Error to throw, or a port-level error object. Every call is recorded.
 */
function makeRpc (answer) {
  const calls = []
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args })
      const a = typeof answer === 'function' ? answer(args, calls.length) : answer
      if (a instanceof Error) throw a
      if (a && typeof a === 'object' && a.error) return a
      const items = Array.isArray(args?.p_items) ? args.p_items : []
      const codes = Array.isArray(a) ? a : items.map(() => a)
      return { data: { results: codes.map((result) => ({ result })) }, error: null }
    },
  }
}
const ENV = { integrationEnabled: 'true' }

console.log('')
console.log('1. the parser: only what the endpoint acts on, nothing about a message')
await test('a change notification yields subscription id, clientState and kind=change; resourceData is not read', () => {
  const r = parseNotificationBatch({ value: [change()] })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.items, [{ subscriptionId: SUB, clientState: STATE, kind: 'change' }])
  assert.strictEqual(r.dropped, 0)
})
await test('a notification about a SENT message is the same wake-up: the resource path is never read', () => {
  const r = parseNotificationBatch({ value: [change({ resource: 'Users/{id}/MailFolders/SentItems/Messages/{long_id}' })] })
  assert.deepStrictEqual(r.items, [{ subscriptionId: SUB, clientState: STATE, kind: 'change' }])
})
await test('lifecycle events are recognised by name; an unknown lifecycle event is dropped, counted', () => {
  const r = parseNotificationBatch({ value: [
    lifecycle('reauthorizationRequired'), lifecycle('subscriptionRemoved'), lifecycle('missed'), lifecycle('somethingElse'),
  ] })
  assert.deepStrictEqual(r.items.map((i) => i.kind), ['reauthorizationRequired', 'subscriptionRemoved', 'missed'])
  assert.strictEqual(r.dropped, 1)
  assert.deepStrictEqual([...NOTIFICATION_KINDS], ['change', 'reauthorizationRequired', 'subscriptionRemoved', 'missed'])
})
await test('malformed items are dropped: missing clientState, control characters, an over-long id, a non-object', () => {
  const r = parseNotificationBatch({ value: [
    change({ clientState: undefined }), change({ clientState: 'a' + String.fromCharCode(0) }),
    change({ subscriptionId: 'x'.repeat(129) }), 'not-an-object', change({ changeType: undefined, lifecycleEvent: undefined }),
  ] })
  assert.strictEqual(r.items.length, 0)
  assert.strictEqual(r.dropped, 5)
})
await test('a batch larger than the ceiling is cut and the excess counted; a non-collection is malformed', () => {
  const r = parseNotificationBatch({ value: Array.from({ length: MAX_NOTIFICATIONS_PER_REQUEST + 5 }, () => change()) })
  assert.strictEqual(r.items.length, MAX_NOTIFICATIONS_PER_REQUEST)
  assert.strictEqual(r.dropped, 5)
  assert.deepStrictEqual(parseNotificationBatch({ value: 'x' }), { ok: false, code: 'malformed' })
  assert.deepStrictEqual(parseNotificationBatch(null), { ok: false, code: 'malformed' })
})
await test('duplicates in one batch coalesce to one item per (subscription, kind, clientState)', () => {
  const r = parseNotificationBatch({ value: [change(), change(), change({ id: 'other' }), lifecycle('missed'), lifecycle('missed')] })
  assert.strictEqual(coalesceNotifications(r.items).length, 2)
})
await test('the validation token is read from the query string, URL-decoded, and bounded', () => {
  assert.strictEqual(readValidationToken(URL_BASE + '?validationToken=Validation%3A%20Testing%20client%20application'),
    'Validation: Testing client application')
  assert.strictEqual(readValidationToken(URL_BASE), null)
  assert.strictEqual(readValidationToken(URL_BASE + '?validationToken='), null)
  assert.strictEqual(readValidationToken(URL_BASE + '?validationToken=' + 'a'.repeat(3000)), null)
})
await test('the clientState hash is SHA-256 hex, so the database never holds the value', async () => {
  const h = await hashClientState(STATE, subtle)
  assert.match(h, /^[0-9a-f]{64}$/)
  assert.notStrictEqual(h, STATE)
})
await test('outcome summaries count controlled codes only; the definitive set is the four a retry cannot change', () => {
  assert.deepStrictEqual(summarizeNotificationOutcomes(['accepted', 'accepted', 'unknown_subscription', 'weird']),
    { accepted: 2, unknown_subscription: 1, rpc_error: 1 })
  assert.deepStrictEqual([...DEFINITIVE_OUTCOMES], ['accepted', 'unknown_subscription', 'client_state_mismatch', 'connection_inactive'])
  assert.ok(NOTIFICATION_OUTCOMES.includes('rpc_error') && !DEFINITIVE_OUTCOMES.includes('rpc_error'))
  assert.strictEqual(readBatchResults({ results: [{ result: 'accepted' }, { result: 'unknown_subscription' }] }, 2).length, 2)
  assert.strictEqual(readBatchResults({ results: [{ result: 'accepted' }] }, 2), null, 'a short answer is not an answer')
  assert.strictEqual(readBatchResults({ results: [{ result: 'rpc_error' }] }, 1), null, 'rpc_error is never definitive')
  assert.strictEqual(readBatchResults(null, 1), null)
})

console.log('')
console.log('2. the handler: the handshake, then notifications as wake-ups')
await test('dormant: 503 not_enabled before anything else, for a validation request too', async () => {
  const { rpc, calls } = makeRpc('accepted')
  for (const env of [{}, { integrationEnabled: 'TRUE' }, { integrationEnabled: '1' }, { integrationEnabled: null }]) {
    const res = await handleOutlookNotifications(post({ value: [change()] }, URL_BASE + '?validationToken=abc'), env, { rpc })
    assert.strictEqual(res.status, 503)
    assert.deepStrictEqual(await res.json(), { error: 'not_enabled' })
  }
  assert.strictEqual(calls.length, 0, 'no database call while dormant')
  assert.strictEqual(flagEnabled('true'), true)
})
await test('the validation handshake: 200 text/plain with the DECODED token, and no database call', async () => {
  const { rpc, calls } = makeRpc('accepted')
  const res = await handleOutlookNotifications(
    new Request(URL_BASE + '?validationToken=Validation%3A%20Testing%20client%20application', { method: 'POST' }), ENV, { rpc })
  assert.strictEqual(res.status, 200)
  assert.ok(res.headers.get('content-type').startsWith('text/plain'))
  assert.strictEqual(await res.text(), 'Validation: Testing client application')
  assert.strictEqual(calls.length, 0)
})
await test('GET without a token is 405; an unreadable or non-collection body is 400 (Microsoft must not retry it)', async () => {
  const { rpc } = makeRpc('accepted')
  assert.strictEqual((await handleOutlookNotifications(new Request(URL_BASE, { method: 'GET' }), ENV, { rpc })).status, 405)
  assert.strictEqual((await handleOutlookNotifications(post('{not json'), ENV, { rpc })).status, 400)
  assert.strictEqual((await handleOutlookNotifications(post({ nope: 1 }), ENV, { rpc })).status, 400)
})
await test('an accepted change notification: ONE batch rpc with the id, the HASH (never the value) and kind=change; 202; kicked after persistence', async () => {
  const { rpc, calls } = makeRpc('accepted')
  let kicks = 0
  const waited = []
  const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, {
    rpc, subtle, kick: async () => { kicks += 1 }, waitUntil: (p) => waited.push(p),
  })
  assert.strictEqual(res.status, 202)
  assert.deepStrictEqual(await res.json(), { received: 1, dropped: 0, outcomes: { accepted: 1 }, kicked: true })
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].name, NOTIFICATION_RPC)
  assert.deepStrictEqual(calls[0].args.p_items, [{ subscription_id: SUB, client_state_hash: await hashClientState(STATE, subtle), kind: 'change' }])
  assert.ok(!JSON.stringify(calls[0].args).includes(STATE), 'the clientState value never reaches the database')
  assert.ok(!JSON.stringify(calls[0].args).includes('AAMk-fixture'), 'the message id never reaches the database')
  await Promise.all(waited)
  assert.strictEqual(kicks, 1, 'the worker was kicked once, after the answer')
})
await test('a dozen Inbox and Sent Items changes in one POST are ONE database round trip and one kick', async () => {
  const { rpc, calls } = makeRpc('accepted')
  let kicks = 0
  const value = Array.from({ length: 12 }, (_, i) => change({ id: 'n-' + i, resource: i % 2 ? 'Users/x/MailFolders/SentItems/Messages/m' + i : 'Users/x/Messages/m' + i }))
  const res = await handleOutlookNotifications(post({ value }), ENV, { rpc, subtle, kick: async () => { kicks += 1 } })
  assert.strictEqual(res.status, 202)
  assert.strictEqual(calls.length, 1, 'twelve notifications, one database call')
  assert.strictEqual(calls[0].args.p_items.length, 1, 'coalesced to one wake-up for the subscription')
  await tick()
  assert.strictEqual(kicks, 1)
})
await test('INVALID AUTHENTICATION: a wrong clientState is refused by the database - 202 (definitive), nothing kicked', async () => {
  const { rpc } = makeRpc('client_state_mismatch')
  let kicks = 0
  const res = await handleOutlookNotifications(post({ value: [change({ clientState: 'forged-value' })] }), ENV, { rpc, subtle, kick: async () => { kicks += 1 } })
  assert.strictEqual(res.status, 202)
  assert.deepStrictEqual((await res.json()).outcomes, { client_state_mismatch: 1 })
  await tick()
  assert.strictEqual(kicks, 0, 'a refused notification never wakes the worker')
})
await test('an unknown subscription (disconnected mailbox) and an inactive connection: 202, not kicked', async () => {
  for (const code of ['unknown_subscription', 'connection_inactive']) {
    const { rpc } = makeRpc(code)
    let kicks = 0
    const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, { rpc, subtle, kick: async () => { kicks += 1 } })
    assert.strictEqual(res.status, 202)
    assert.deepStrictEqual((await res.json()).outcomes, { [code]: 1 })
    await tick()
    assert.strictEqual(kicks, 0, code)
  }
})
await test('MIXED batch: accepted + refused items in one POST -> 202 with each counted, one kick for the accepted one', async () => {
  const { rpc, calls } = makeRpc(['accepted', 'unknown_subscription', 'client_state_mismatch'])
  let kicks = 0
  const res = await handleOutlookNotifications(post({ value: [
    change(), change({ subscriptionId: SUB2 }), change({ subscriptionId: SUB, clientState: 'another-state' }),
  ] }), ENV, { rpc, subtle, kick: async () => { kicks += 1 } })
  assert.strictEqual(res.status, 202)
  assert.deepStrictEqual((await res.json()).outcomes, { accepted: 1, unknown_subscription: 1, client_state_mismatch: 1 })
  assert.strictEqual(calls[0].args.p_items.length, 3)
  await tick()
  assert.strictEqual(kicks, 1)
})
await test('lifecycle notifications reach the database under their own kind and wake the worker', async () => {
  const { rpc, calls } = makeRpc('accepted')
  let kicks = 0
  const res = await handleOutlookNotifications(post({ value: [lifecycle('missed'), lifecycle('subscriptionRemoved'), lifecycle('reauthorizationRequired')] }), ENV, {
    rpc, subtle, kick: async () => { kicks += 1 },
  })
  assert.strictEqual(res.status, 202)
  assert.deepStrictEqual(calls[0].args.p_items.map((i) => i.kind), ['missed', 'subscriptionRemoved', 'reauthorizationRequired'])
  await tick()
  assert.strictEqual(kicks, 1)
})
await test('a batch with only malformed items: 202, dropped counted, no database call, no kick', async () => {
  const { rpc, calls } = makeRpc('accepted')
  let kicks = 0
  const res = await handleOutlookNotifications(post({ value: [{ hello: 'world' }] }), ENV, { rpc, subtle, kick: async () => { kicks += 1 } })
  assert.strictEqual(res.status, 202)
  assert.deepStrictEqual(await res.json(), { received: 0, dropped: 1, outcomes: {}, kicked: false })
  assert.strictEqual(calls.length, 0)
  assert.strictEqual(kicks, 0)
})
await test('a kick that throws never affects the answer', async () => {
  const { rpc } = makeRpc('accepted')
  const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, { rpc, subtle, kick: async () => { throw new Error('down') } })
  assert.strictEqual(res.status, 202)
})

console.log('')
console.log('3. DURABLE acknowledgement: a wake-up that was not recorded is NOT acknowledged')
await test('TRANSIENT FAILURE: the port errors -> 503 retryable, no kick; Microsoft redelivers -> 202, kicked', async () => {
  // REPRODUCED BEFORE THE FIX: this very request answered 202 { outcomes: { rpc_error: 1 } },
  // so Microsoft considered it delivered and the mailbox change was never checked.
  let n = 0
  const { rpc, calls } = makeRpc(() => (n++ === 0 ? { data: null, error: { code: 'unreachable' } } : 'accepted'))
  let kicks = 0
  const deps = { rpc, subtle, kick: async () => { kicks += 1 } }
  const first = await handleOutlookNotifications(post({ value: [change()] }), ENV, deps)
  assert.strictEqual(first.status, 503)
  const body = await first.json()
  assert.strictEqual(body.error, 'persistence_failed')
  assert.strictEqual(body.retryable, true)
  await tick()
  assert.strictEqual(kicks, 0, 'nothing is kicked for a wake-up that was not recorded')
  const second = await handleOutlookNotifications(post({ value: [change()] }), ENV, deps)   // the redelivery
  assert.strictEqual(second.status, 202)
  assert.deepStrictEqual((await second.json()).outcomes, { accepted: 1 })
  assert.strictEqual(calls.length, 2)
  await tick()
  assert.strictEqual(kicks, 1)
})
await test('a THROWING port, a port answering an unknown shape, or an unknown code: 503, never a false 202', async () => {
  for (const answer of [new Error('boom'), { data: { nonsense: true }, error: null }, ['surprise'], ['rpc_error']]) {
    const { rpc } = makeRpc(answer)
    let kicks = 0
    const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, { rpc, subtle, kick: async () => { kicks += 1 } })
    assert.strictEqual(res.status, 503, JSON.stringify(answer))
    assert.strictEqual((await res.json()).retryable, true)
    await tick()
    assert.strictEqual(kicks, 0)
  }
})
await test('a partial answer (fewer results than items) is a transient failure: the whole batch is redelivered, which is safe', async () => {
  const { rpc } = makeRpc(['accepted'])   // two items, one answer
  const res = await handleOutlookNotifications(post({ value: [change(), change({ subscriptionId: SUB2 })] }), ENV, { rpc, subtle })
  assert.strictEqual(res.status, 503)
})
await test('SLOW PERSISTENCE: the batch is raced against the ingress budget; past it the answer is 503 within the window', async () => {
  // A port that answers correctly, but only after 400 ms - longer than the 120 ms budget below.
  const rpc = () => new Promise((resolve) => setTimeout(() => resolve({ data: { results: [{ result: 'accepted' }] }, error: null }), 400))
  const t0 = Date.now()
  let kicks = 0
  const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, { rpc, subtle, ingressBudgetMs: 120, kick: async () => { kicks += 1 } })
  const elapsed = Date.now() - t0
  assert.strictEqual(res.status, 503)
  assert.strictEqual((await res.json()).stage, 'timeout')
  assert.ok(elapsed < 350, 'answered inside the budget, not after the slow call: ' + elapsed + ' ms')
  await new Promise((r) => setTimeout(r, 450))
  assert.strictEqual(kicks, 0, 'a late success does not kick: Microsoft will redeliver')
  assert.strictEqual(INGRESS_BUDGET_MS, 2500, 'the production budget sits under the 3-second window')
})
await test('a slow BODY is bounded by the same budget', async () => {
  const slowBody = new ReadableStream({ start () { /* never enqueues, never closes */ } })
  const req = new Request(URL_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: slowBody, duplex: 'half' })
  const { rpc, calls } = makeRpc('accepted')
  const t0 = Date.now()
  const res = await handleOutlookNotifications(req, ENV, { rpc, subtle, ingressBudgetMs: 100 })
  assert.strictEqual(res.status, 503)
  assert.strictEqual((await res.json()).stage, 'body')
  assert.ok(Date.now() - t0 < 300)
  assert.strictEqual(calls.length, 0)
})
await test('REPEATED DELIVERY of an accepted batch is safe: each is recorded and kicked; the database side coalesces (SQL proof)', async () => {
  const { rpc, calls } = makeRpc('accepted')
  let kicks = 0
  for (let i = 0; i < 3; i += 1) {
    const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, { rpc, subtle, kick: async () => { kicks += 1 } })
    assert.strictEqual(res.status, 202)
  }
  await tick()
  assert.strictEqual(calls.length, 3)
  assert.strictEqual(kicks, 3, 'each delivery kicks; the lease makes overlapping kicks answer none_due')
})

console.log('')
console.log('4. the kick: one bounded POST with the worker secret, nothing read back')
await test('the kick posts to the worker with the Bearer secret, no body, never follows a redirect, and swallows failure', async () => {
  const seen = []
  const kick = makeWorkerKick({
    workerUrl: 'https://project.supabase.test/functions/v1/outlook-import-worker',
    workerSecret: 's'.repeat(40),
    fetchImpl: async (url, init) => { seen.push({ url, init }); return { status: 200 } },
  })
  await kick()
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].init.method, 'POST')
  assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer ' + 's'.repeat(40))
  assert.strictEqual(seen[0].init.body, undefined)
  assert.strictEqual(seen[0].init.redirect, 'error')
  const failing = makeWorkerKick({ workerUrl: 'https://x.test/w', workerSecret: 's'.repeat(40), fetchImpl: async () => { throw new Error('offline') } })
  await failing()
})
await test('no kick exists without an https worker URL and a secret', () => {
  assert.strictEqual(makeWorkerKick({ workerUrl: 'http://insecure.test/w', workerSecret: 's'.repeat(40) }), null)
  assert.strictEqual(makeWorkerKick({ workerUrl: 'https://x.test/w', workerSecret: '' }), null)
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exit(1)
