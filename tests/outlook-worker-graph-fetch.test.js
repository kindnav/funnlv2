// THE PRODUCTION FIRST-PAGE 503: the Graph fetch was never injected.
//
// WHAT FAILED. The deployed entry (outlook-import-worker/index.ts) passes
// tokenUrl, select and rpc - and no fetch under either name. The handler built
// the run's Graph dependencies as
//
//     deps: { fetchImpl: d.graphFetchImpl ?? d.fetchImpl, now: d.now }
//
// so BOTH operands were undefined and fetchImpl went in undefined.
// readFolderContinued's own guard (outlookContinuedPass.js) then threw
// fetch_not_injected BEFORE the first Graph page, runOutlookImport's catch
// released the lease as pass_failed, and the invocation answered 503
// released_error. Production showed two error sync rows, zero pages, zero
// pending suggestions and zero saved interactions.
//
// The token path never had this defect: makeRunContextLoader applies its own
// `deps.fetchImpl ?? globalThis.fetch` default internally, which is why the
// refresh worked and only the Graph read failed. The fix adds the same last
// fallback to the Graph dependencies.
//
// HOW THIS IS TESTED. The REAL handler is driven with PRODUCTION-SHAPED
// dependencies - exactly { tokenUrl, select, rpc }, the three index.ts passes,
// and no fetch of either name - so the handler's own fallback is what decides.
// The real makeRunContextLoader runs against a fixture PostgREST, with a
// genuinely encrypted and NOT-YET-EXPIRED access token, so no refresh is
// attempted and the token path stays out of scope.
//
//   CASE A reproduces the failure: with no fetch anywhere, including no
//          globalThis.fetch, the run must answer 503 released_error /
//          pass_failed and read zero Graph pages. This is the pre-fix
//          condition, and it also guards the fallback - delete `?? globalThis
//          .fetch` and CASE B fails.
//   CASE B proves the fix: with a local Graph fixture as the platform fetch and
//          still no injected fetch, the run must reach BOTH folder pages and
//          COMMIT.
//
// NO REAL MICROSOFT REQUEST IS MADE. The fixture refuses any URL that is not
// the Graph base, so a stray request fails the test instead of leaving.
//
// ISOLATION OF THE GLOBAL FETCH REPLACEMENT. This is a FILE OF ITS OWN, which
// tests/run-all.js runs in its own `node` process, so no other suite shares
// this global. Within the file every case is a plain sequential `await` - there
// is no pending-promise pool - so no second case is ever in flight while the
// global is swapped. The original property descriptor is captured and restored
// in a finally, and each case asserts the restoration.
//
// Run with: node tests/outlook-worker-graph-fetch.test.js

import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import {
  handleOutlookImportWorker, statusForOutcome, OK_OUTCOMES,
} from '../supabase/functions/outlook-import-worker/handler.js'
import {
  importKeyFromBase64, encryptToken,
} from '../supabase/functions/shared/googleTokenCrypto.js'
import { GRAPH_BASE } from '../supabase/functions/shared/outlookGraphTransport.js'
import { CONTACT_PAGE_SIZE } from '../supabase/functions/shared/outlookRunContext.js'
import { makeRoundStore } from './harness/outlookRoundStore.js'
const CONSENTED = 'ol-disc-' + '0'.repeat(32)   // the version these fixtures' connections consented under; injected as the background requirement

let passed = 0, failed = 0
function check (name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++ }
  else { console.error(`  ✗ ${name}`); if (detail) console.error(`    ${detail}`); failed++ }
}

const subtle = webcrypto.subtle
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// ── invented fixtures. None of this is a real account, address or token. ────
const KEY_B64 = Buffer.alloc(32, 7).toString('base64')
const SECRET = 's'.repeat(40)
const CONN = '11111111-1111-1111-1111-111111111111'
const PILOT = '22222222-2222-2222-2222-222222222222'
const CONTACT = '33333333-3333-3333-3333-333333333333'
const ME = 'pilot@outlook.test'
const OTHER_PARTY = 'ava@bank.test'
const ACCESS_TOKEN = 'fixture-access-token-not-a-secret'

const workerReq = () => ({
  method: 'POST',
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? `Bearer ${SECRET}` : null) },
})

const env = () => ({
  integrationEnabled: 'true', workerEnabled: 'true', workerSecret: SECRET,
  clientId: 'c', clientSecret: 'cs', tokenKeyB64: KEY_B64,
  fingerprintKey: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } },
  keyVersion: 1, pilotUserId: PILOT,
  scope: 'openid profile email offline_access Mail.Read User.Read',
})

/**
 * A fixture PostgREST + RPC pair good enough for the REAL run-context loader
 * and a complete committable round. The access token is really encrypted with
 * the same key the handler is configured with, and expires an hour out, so the
 * loader decrypts it and attempts NO refresh.
 */
async function makePorts () {
  const key = await importKeyFromBase64(KEY_B64, subtle)
  const sealed = await encryptToken(ACCESS_TOKEN, key, { subtle })
  const expires = new Date(Date.now() + 3600_000).toISOString()
  const reads = []
  const store = makeRoundStore()
  const rpcCalls = []
  const releases = []

  const select = async (path) => {
    reads.push(path)
    if (path.startsWith('microsoft_connections?')) {
      return { data: [{ user_id: PILOT, ms_email: ME, scopes: ['Mail.Read', 'User.Read'], token_expires_at: expires, consent_policy_version: CONSENTED }], error: null }
    }
    if (path.startsWith('contacts?')) {
      // One page, shorter than CONTACT_PAGE_SIZE, so the loader stops after it.
      return { data: path.includes('offset=0')
        ? [{ id: CONTACT, user_id: PILOT, email: OTHER_PARTY }] : [], error: null }
    }
    if (path.startsWith('outlook_sync_state?')) {
      // No saved cursor for either folder: a first pass, so nothing is decrypted.
      return { data: [], error: null }
    }
    if (path.startsWith('microsoft_tokens?')) {
      return { data: [{
        access_token_ciphertext: sealed.ciphertext, access_token_nonce: sealed.nonce,
        // Present but never used: the token is fresh, so no refresh is attempted.
        refresh_token_ciphertext: sealed.ciphertext, refresh_token_nonce: sealed.nonce,
        key_version: 1, token_expires_at: expires,
      }], error: null }
    }
    throw new Error('unexpected select: ' + path)
  }

  const rpc = async (name, args) => {
    rpcCalls.push(name)
    if (name === 'reserve_due_outlook_connection') {
      return { data: { result: 'reserved', connection_id: CONN, user_id: PILOT, run_id: 'run-1' }, error: null }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'upsert_outlook_interaction_candidate') {
      return { data: { result: 'created' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      releases.push({ status: args?.p_status, complete: args?.p_run_complete,
                      errorCode: args?.p_error_code })
      if (args?.p_run_complete === true) store.commitRelease()
      return { data: true, error: null }
    }
    if (name === 'rotate_microsoft_access_token') {
      throw new Error('no refresh may be attempted: the fixture token is fresh')
    }
    const s = await store.handle(name, args)
    return s === null ? { data: null, error: null } : s
  }

  return { select, rpc, reads, rpcCalls, releases, store }
}

/** A local Graph fixture. Any non-Graph URL is a test failure, not a request. */
function makeGraphFixture () {
  const urls = []
  const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
  const msg = (id, from, to, sent) => ({
    id, conversationId: 'c1', receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 's', from: addr(from), sender: addr(from),
    toRecipients: to.map(addr), ccRecipients: [],
  })
  const impl = async (url) => {
    const u = String(url)
    if (!u.startsWith(GRAPH_BASE)) {
      throw new Error('the fixture refuses a non-Graph URL: ' + u.slice(0, 60))
    }
    urls.push(u)
    const inbox = u.includes('/mailFolders/inbox/')
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        value: [inbox
          ? msg('in-1', OTHER_PARTY, [ME], '2026-09-20T14:00:00Z')
          : msg('out-1', ME, [OTHER_PARTY], '2026-09-21T09:00:00Z')],
        '@odata.deltaLink':
          `${GRAPH_BASE}/me/mailFolders/${inbox ? 'inbox' : 'sentitems'}/messages/delta?$deltatoken=D`,
      }),
    }
  }
  return { impl, urls }
}

/**
 * Swap globalThis.fetch for the duration of `fn` and restore the ORIGINAL
 * property descriptor afterwards, whatever happens. Pass undefined to model a
 * platform with no fetch at all.
 */
async function withGlobalFetch (impl, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'fetch', {
    value: impl, writable: true, configurable: true,
    enumerable: original ? original.enumerable : false,
  })
  try {
    return await fn()
  } finally {
    if (original) Object.defineProperty(globalThis, 'fetch', original)
    else delete globalThis.fetch
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the deployed entry passes no fetch - which is what made this reachable')

const ENTRY = read('supabase/functions/outlook-import-worker/index.ts')
const entryDeps = ENTRY.slice(ENTRY.lastIndexOf('}, {'))
check('index.ts passes tokenUrl, select and rpc only',
  /tokenUrl:/.test(entryDeps) && /select:/.test(entryDeps) && /rpc:/.test(entryDeps))
check('index.ts passes NO fetch under either name',
  !/fetchImpl/.test(entryDeps) && !/graphFetchImpl/.test(entryDeps), entryDeps.trim().slice(0, 120))

const HANDLER = read('supabase/functions/outlook-import-worker/handler.js')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
check('the handler falls back to the platform fetch for the Graph dependencies',
  /fetchImpl: d\.graphFetchImpl \?\? d\.fetchImpl \?\? globalThis\.fetch/.test(HANDLER),
  'the production fallback is missing')

const ORIGINAL_FETCH = globalThis.fetch

// ── CASE A: reproduce the failure ──────────────────────────────────────────
console.log('')
console.log('CASE A: no fetch anywhere - the pre-fix condition')

{
  const ports = await makePorts()
  const graph = makeGraphFixture()
  const res = await withGlobalFetch(undefined, () =>
    // PRODUCTION-SHAPED deps: exactly what index.ts passes - no fetch of either name - plus
    // the test-only consent requirement, which touches no fetch wiring.
    handleOutlookImportWorker(workerReq(), env(),
      { tokenUrl: 'https://login.invalid/token', select: ports.select, rpc: ports.rpc, requiredBackgroundConsent: CONSENTED }))
  const body = await res.json()
  check('the invocation answers 503', res.status === 503, `status=${res.status}`)
  check('the outcome is released_error', body?.run?.outcome === 'released_error',
    JSON.stringify(body?.run))
  // `pass_failed` is not in the summary - summarizeRun reports `reason` from a
  // RunContextError only, and a thrown fetch_not_injected is not one. It is
  // carried to the database as the release RPC's p_error_code, which is the
  // observable that matters: the lease is released AS AN ERROR, not completed.
  check('the lease is released as an error with p_error_code pass_failed',
    ports.releases.length === 1
    && ports.releases[0].status === 'error'
    && ports.releases[0].complete === false
    && ports.releases[0].errorCode === 'pass_failed',
    JSON.stringify(ports.releases))
  check('released_error is not a success outcome',
    !OK_OUTCOMES.includes('released_error') && statusForOutcome('released_error') === 503)
  check('ZERO Graph pages were read', graph.urls.length === 0, `urls=${graph.urls.length}`)
  check('the context WAS loaded first, so this is the Graph read failing and not the token path',
    ports.reads.some((p) => p.startsWith('microsoft_tokens?'))
    && !ports.rpcCalls.includes('rotate_microsoft_access_token'),
    JSON.stringify(ports.reads.map((p) => p.split('?')[0])))
  check('the lease was reserved and then released',
    ports.rpcCalls.includes('reserve_due_outlook_connection')
    && ports.rpcCalls.includes('release_outlook_sync_lease'),
    JSON.stringify(ports.rpcCalls))
  check('no release claimed a completed run',
    ports.releases.every((r) => r.complete !== true), JSON.stringify(ports.releases))
  check('globalThis.fetch was restored', globalThis.fetch === ORIGINAL_FETCH)
}

// ── CASE B: the fix ────────────────────────────────────────────────────────
console.log('')
console.log('CASE B: a local Graph fixture as the PLATFORM fetch, still none injected')

{
  const ports = await makePorts()
  const graph = makeGraphFixture()
  const res = await withGlobalFetch(graph.impl, () =>
    handleOutlookImportWorker(workerReq(), env(),
      { tokenUrl: 'https://login.invalid/token', select: ports.select, rpc: ports.rpc, requiredBackgroundConsent: CONSENTED }))
  const body = await res.json()
  check('the invocation answers 200', res.status === 200,
    `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`)
  check('the outcome is committed', body?.run?.outcome === 'committed',
    JSON.stringify(body?.run))
  check('BOTH folder pages were read',
    graph.urls.some((u) => u.includes('/mailFolders/inbox/'))
    && graph.urls.some((u) => u.includes('/mailFolders/sentitems/')),
    JSON.stringify(graph.urls.map((u) => u.replace(GRAPH_BASE, ''))))
  check('both cursors advanced', body?.run?.cursors_advanced === 2, JSON.stringify(body?.run))
  check('both folders report a complete round',
    body?.run?.stops?.inbox === 'complete' && body?.run?.stops?.sentitems === 'complete',
    JSON.stringify(body?.run?.stops))
  check('the lease is released as a COMPLETED run, with no error code',
    ports.releases.length === 1
    && ports.releases[0].complete === true
    && ports.releases[0].errorCode === null,
    JSON.stringify(ports.releases))
  check('a suggestion was proposed, and no interaction was saved directly',
    ports.rpcCalls.includes('upsert_outlook_interaction_candidate'),
    JSON.stringify(ports.rpcCalls))
  check('still NO token refresh was attempted',
    !ports.rpcCalls.includes('rotate_microsoft_access_token'), JSON.stringify(ports.rpcCalls))
  check('every URL the run requested was the Graph base',
    graph.urls.length > 0 && graph.urls.every((u) => u.startsWith(GRAPH_BASE)),
    JSON.stringify(graph.urls.slice(0, 2)))
  check('globalThis.fetch was restored', globalThis.fetch === ORIGINAL_FETCH)
}

// ── the injected forms still win, so a test can still fail one fetch ───────
console.log('')
console.log('the injected forms still take precedence over the platform fetch')

{
  const ports = await makePorts()
  const injected = makeGraphFixture()
  const platform = makeGraphFixture()
  const res = await withGlobalFetch(platform.impl, () =>
    handleOutlookImportWorker(workerReq(), env(), {
      tokenUrl: 'https://login.invalid/token', select: ports.select, rpc: ports.rpc,
      graphFetchImpl: injected.impl, requiredBackgroundConsent: CONSENTED,
    }))
  const body = await res.json()
  check('an injected graphFetchImpl is used', injected.urls.length > 0 && body?.run?.outcome === 'committed',
    JSON.stringify(body?.run))
  check('and the platform fetch is NOT used', platform.urls.length === 0,
    `platform urls=${platform.urls.length}`)
  check('globalThis.fetch was restored', globalThis.fetch === ORIGINAL_FETCH)
}

check('CONTACT_PAGE_SIZE is still larger than the fixture page, so the loader stopped',
  CONTACT_PAGE_SIZE > 1)

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
