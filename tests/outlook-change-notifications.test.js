// THE NOTIFICATION ENDPOINT - what Microsoft Graph POSTs, and what Funnl does with it.
//
// What is executed: the REAL handler (supabase/functions/outlook-notifications/handler.js)
// over real Request objects, with ONE injected database port that records every call, and
// an injected kick. Microsoft's behaviour is SIMULATED by the payloads below, shaped exactly
// as change-notifications-delivery-webhooks and change-notifications-lifecycle-events
// document them; this is not live-provider evidence.
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
  handleOutlookNotifications, makeWorkerKick, NOTIFICATION_RPC, flagEnabled,
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
const STATE = 'fixture-client-state-not-a-secret'

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

/** The database port: scripted answers, every call recorded. */
function makeRpc (answer) {
  const calls = []
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args })
      const a = typeof answer === 'function' ? answer(args, calls.length) : answer
      if (a instanceof Error) throw a
      return a
    },
  }
}
const ok = (result) => ({ data: { result }, error: null })
const ENV = { integrationEnabled: 'true' }

console.log('')
console.log('1. the parser: only what the endpoint acts on, nothing about a message')
await test('a change notification yields subscription id, clientState and kind=change; resourceData is not read', () => {
  const r = parseNotificationBatch({ value: [change()] })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.items, [{ subscriptionId: SUB, clientState: STATE, kind: 'change' }])
  assert.strictEqual(r.dropped, 0)
  assert.ok(!Object.keys(r.items[0]).includes('resourceData') && !Object.keys(r.items[0]).includes('resource'))
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
  assert.deepStrictEqual(parseNotificationBatch([]), { ok: false, code: 'malformed' })
})
await test('duplicates in one batch coalesce to one database call per (subscription, kind, clientState)', () => {
  const r = parseNotificationBatch({ value: [change(), change(), change({ id: 'other' }), lifecycle('missed'), lifecycle('missed')] })
  assert.strictEqual(coalesceNotifications(r.items).length, 2)
})
await test('the validation token is read from the query string, URL-decoded, and bounded', () => {
  assert.strictEqual(readValidationToken(URL_BASE + '?validationToken=Validation%3A%20Testing%20client%20application'),
    'Validation: Testing client application')
  assert.strictEqual(readValidationToken(URL_BASE), null)
  assert.strictEqual(readValidationToken(URL_BASE + '?validationToken='), null)
  assert.strictEqual(readValidationToken(URL_BASE + '?validationToken=' + 'a'.repeat(3000)), null)
  assert.strictEqual(readValidationToken('not a url'), null)
})
await test('the clientState hash is SHA-256 hex, so the database never holds the value', async () => {
  const h = await hashClientState(STATE, subtle)
  assert.match(h, /^[0-9a-f]{64}$/)
  assert.notStrictEqual(h, STATE)
  await assert.rejects(() => hashClientState('x'.repeat(129), subtle), /invalid_client_state/)
})
await test('outcome summaries count controlled codes only', () => {
  assert.deepStrictEqual(summarizeNotificationOutcomes(['accepted', 'accepted', 'unknown_subscription', 'weird']),
    { accepted: 2, unknown_subscription: 1, rpc_error: 1 })
  assert.deepStrictEqual([...NOTIFICATION_OUTCOMES], ['accepted', 'unknown_subscription', 'client_state_mismatch', 'connection_inactive', 'rpc_error'])
})

console.log('')
console.log('2. the handler: the handshake, then notifications as wake-ups')
await test('dormant: 503 not_enabled before anything else, for a validation request too', async () => {
  const { rpc, calls } = makeRpc(ok('accepted'))
  for (const env of [{}, { integrationEnabled: 'TRUE' }, { integrationEnabled: '1' }, { integrationEnabled: null }]) {
    const res = await handleOutlookNotifications(post({ value: [change()] }, URL_BASE + '?validationToken=abc'), env, { rpc })
    assert.strictEqual(res.status, 503)
    assert.deepStrictEqual(await res.json(), { error: 'not_enabled' })
  }
  assert.strictEqual(calls.length, 0, 'no database call while dormant')
  assert.strictEqual(flagEnabled('true'), true)
})
await test('the validation handshake: 200 text/plain with the DECODED token, and no database call', async () => {
  const { rpc, calls } = makeRpc(ok('accepted'))
  const res = await handleOutlookNotifications(
    new Request(URL_BASE + '?validationToken=Validation%3A%20Testing%20client%20application', { method: 'POST' }), ENV, { rpc })
  assert.strictEqual(res.status, 200)
  assert.ok(res.headers.get('content-type').startsWith('text/plain'))
  assert.strictEqual(await res.text(), 'Validation: Testing client application')
  assert.strictEqual(calls.length, 0)
})
await test('a token that would be HTML is still only ever echoed as text/plain', async () => {
  const { rpc } = makeRpc(ok('accepted'))
  const res = await handleOutlookNotifications(new Request(URL_BASE + '?validationToken=%3Cb%3Ehi%3C%2Fb%3E', { method: 'POST' }), ENV, { rpc })
  assert.ok(res.headers.get('content-type').startsWith('text/plain'))
  assert.strictEqual(await res.text(), '<b>hi</b>')
})
await test('GET without a token is 405; an unreadable body is 400', async () => {
  const { rpc } = makeRpc(ok('accepted'))
  assert.strictEqual((await handleOutlookNotifications(new Request(URL_BASE, { method: 'GET' }), ENV, { rpc })).status, 405)
  assert.strictEqual((await handleOutlookNotifications(post('{not json'), ENV, { rpc })).status, 400)
  assert.strictEqual((await handleOutlookNotifications(post({ nope: 1 }), ENV, { rpc })).status, 400)
})
await test('an accepted change notification: ONE rpc with the id, the HASH (never the value) and kind=change; 202; kicked', async () => {
  const { rpc, calls } = makeRpc(ok('accepted'))
  let kicks = 0
  const waited = []
  const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, {
    rpc, subtle, kick: async () => { kicks += 1 }, waitUntil: (p) => waited.push(p),
  })
  assert.strictEqual(res.status, 202)
  const body = await res.json()
  assert.deepStrictEqual(body, { received: 1, dropped: 0, outcomes: { accepted: 1 }, kicked: true })
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].name, NOTIFICATION_RPC)
  assert.strictEqual(calls[0].args.p_subscription_id, SUB)
  assert.strictEqual(calls[0].args.p_kind, 'change')
  assert.strictEqual(calls[0].args.p_client_state_hash, await hashClientState(STATE, subtle))
  assert.ok(!JSON.stringify(calls[0].args).includes(STATE), 'the clientState value never reaches the database')
  assert.ok(!JSON.stringify(calls[0].args).includes('AAMk-fixture'), 'the message id never reaches the database')
  await Promise.all(waited)
  assert.strictEqual(kicks, 1, 'the worker was kicked once, after the answer')
  assert.strictEqual(waited.length, 1, 'and the kick was handed to waitUntil')
})
await test('Inbox and Sent Items changes in one POST are one wake-up: duplicates coalesce, the kick happens once', async () => {
  const { rpc, calls } = makeRpc(ok('accepted'))
  let kicks = 0
  const res = await handleOutlookNotifications(post({ value: [change(), change({ id: 'sent-1' }), change({ id: 'sent-2' })] }), ENV, {
    rpc, subtle, kick: async () => { kicks += 1 },
  })
  assert.strictEqual(res.status, 202)
  assert.strictEqual(calls.length, 1, 'three notifications, one database call')
  await new Promise((r) => setTimeout(r, 0))
  assert.strictEqual(kicks, 1)
})
await test('INVALID AUTHENTICATION: a wrong clientState is refused by the database, nothing is kicked, still 202 (no retry storm)', async () => {
  const { rpc, calls } = makeRpc(ok('client_state_mismatch'))
  let kicks = 0
  const res = await handleOutlookNotifications(post({ value: [change({ clientState: 'forged-value' })] }), ENV, {
    rpc, subtle, kick: async () => { kicks += 1 },
  })
  assert.strictEqual(res.status, 202)
  assert.deepStrictEqual((await res.json()).outcomes, { client_state_mismatch: 1 })
  assert.strictEqual(calls.length, 1)
  await new Promise((r) => setTimeout(r, 0))
  assert.strictEqual(kicks, 0, 'a refused notification never wakes the worker')
})
await test('an unknown subscription (disconnected mailbox) and an inactive connection: acknowledged, not kicked', async () => {
  for (const code of ['unknown_subscription', 'connection_inactive']) {
    const { rpc } = makeRpc(ok(code))
    let kicks = 0
    const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, { rpc, subtle, kick: async () => { kicks += 1 } })
    assert.strictEqual(res.status, 202)
    assert.deepStrictEqual((await res.json()).outcomes, { [code]: 1 })
    await new Promise((r) => setTimeout(r, 0))
    assert.strictEqual(kicks, 0, code)
  }
})
await test('a database failure is rpc_error, acknowledged (Microsoft would retry a 5xx for four hours against the same failure)', async () => {
  for (const answer of [{ data: null, error: { code: 'unreachable' } }, new Error('boom'), { data: { result: 'surprise' } }]) {
    const { rpc } = makeRpc(answer)
    const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, { rpc, subtle })
    assert.strictEqual(res.status, 202)
    assert.deepStrictEqual((await res.json()).outcomes, { rpc_error: 1 })
  }
})
await test('lifecycle notifications reach the database under their own kind and wake the worker', async () => {
  const { rpc, calls } = makeRpc(ok('accepted'))
  let kicks = 0
  const res = await handleOutlookNotifications(post({ value: [lifecycle('missed'), lifecycle('subscriptionRemoved'), lifecycle('reauthorizationRequired')] }), ENV, {
    rpc, subtle, kick: async () => { kicks += 1 },
  })
  assert.strictEqual(res.status, 202)
  assert.deepStrictEqual(calls.map((c) => c.args.p_kind), ['missed', 'subscriptionRemoved', 'reauthorizationRequired'])
  await new Promise((r) => setTimeout(r, 0))
  assert.strictEqual(kicks, 1)
})
await test('a batch with only malformed items: 202, dropped counted, no database call, no kick', async () => {
  const { rpc, calls } = makeRpc(ok('accepted'))
  let kicks = 0
  const res = await handleOutlookNotifications(post({ value: [{ hello: 'world' }] }), ENV, { rpc, subtle, kick: async () => { kicks += 1 } })
  assert.strictEqual(res.status, 202)
  assert.deepStrictEqual(await res.json(), { received: 0, dropped: 1, outcomes: {}, kicked: false })
  assert.strictEqual(calls.length, 0)
  assert.strictEqual(kicks, 0)
})
await test('a kick that throws never affects the answer', async () => {
  const { rpc } = makeRpc(ok('accepted'))
  const res = await handleOutlookNotifications(post({ value: [change()] }), ENV, { rpc, subtle, kick: async () => { throw new Error('down') } })
  assert.strictEqual(res.status, 202)
})

console.log('')
console.log('3. the kick: one bounded POST with the worker secret, nothing read back')
await test('the kick posts to the worker with the Bearer secret, no body, never follows a redirect, and swallows failure', async () => {
  const seen = []
  const kick = makeWorkerKick({
    workerUrl: 'https://project.supabase.test/functions/v1/outlook-import-worker',
    workerSecret: 's'.repeat(40),
    fetchImpl: async (url, init) => { seen.push({ url, init }); return { status: 200 } },
  })
  await kick()
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].url, 'https://project.supabase.test/functions/v1/outlook-import-worker')
  assert.strictEqual(seen[0].init.method, 'POST')
  assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer ' + 's'.repeat(40))
  assert.strictEqual(seen[0].init.body, undefined)
  assert.strictEqual(seen[0].init.redirect, 'error')
  const failing = makeWorkerKick({ workerUrl: 'https://x.test/w', workerSecret: 's'.repeat(40), fetchImpl: async () => { throw new Error('offline') } })
  await failing()   // resolves
})
await test('no kick exists without an https worker URL and a secret', () => {
  assert.strictEqual(makeWorkerKick({ workerUrl: 'http://insecure.test/w', workerSecret: 's'.repeat(40) }), null)
  assert.strictEqual(makeWorkerKick({ workerUrl: 'https://x.test/w', workerSecret: '' }), null)
  assert.strictEqual(makeWorkerKick({ workerUrl: '', workerSecret: 's' }), null)
})

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exit(1)
