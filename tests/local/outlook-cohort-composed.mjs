// THE COHORT, COMPOSED: the real worker, the real reservation, over real PostgREST.
//
// The other two proofs each leave a gap. tests/local/outlook-cohort-reservation.mjs asks the
// SQL function directly through psql, so nothing about the worker's calls is exercised. The
// in-repo suites drive the real run module but inject fake RPC results, so nothing about the
// real function is exercised. This file closes the gap between them: every RPC the run makes
// is an HTTP call to PostgREST against this project's Postgres image with every migration
// applied, and the eligibility decision is the one in SQL.
//
// WHAT IT PROVES
//   1. the OLD three-argument function's actual answer to a four-argument call - measured,
//      not assumed, because a comment in the first revision of this work claimed it would
//      "silently ignore" the new argument;
//   2. after the migration, a THREE-named-parameter call still works by OMITTING the
//      defaulted fourth - which is the compatibility that matters, and is not what passing
//      an explicit NULL tests;
//   3. TWO INVITED ACCOUNTS UNDER ONE COHORT VALUE, with the REAL RESERVATION choosing
//      which one each invocation serves, each mailbox dispatched from that request's own
//      bearer token, each writing its own candidates of BOTH kinds, and each invocation
//      leaving EVERY COLUMN OF EVERY ROW of the other account unchanged - compared as an
//      ordered full-row md5 per table plus the row count, not as a projection of a few
//      columns, and in both directions: the account the first invocation served is compared
//      again after the second one runs, by which point it has candidates, provenance rows
//      and committed cursors to preserve;
//   4. a third account that is not in the cohort is never reserved, and removal then
//      re-addition against the SAME durable fixture leaves state untouched and resumes
//      from the account's own committed cursor;
//   5. account isolation with POSITIVE CONTROLS: each user can read and accept their own
//      candidates of both kinds, and the other user's identical request on the same row is
//      refused without changing it - so a missing grant or a missing RPC cannot pass for
//      ownership enforcement.
//
// EVERY CHECK HERE IS REQUIRED. There is no "pending" or "known-not-yet" category: a
// failure, or a prerequisite that did not happen, exits non-zero.
//
// NOT part of `npm test`: it needs Docker. Teardown is unconditional.
// RUN: node tests/local/outlook-cohort-composed.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, createHmac, webcrypto } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'
import { runOutlookImport, summarizeRun } from '../../supabase/functions/shared/outlookImportRun.js'
import { GRAPH_BASE } from '../../supabase/functions/shared/outlookGraphTransport.js'
import { ANTHROPIC_MESSAGES_URL } from '../../supabase/functions/shared/outlookDraftContract.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-cohortc-pg'
const REST = 'funnl-cohortc-rest'
const NET = 'funnl-cohortc-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const BASE = 'http://127.0.0.1:53997'
const JWT_SECRET = randomBytes(32).toString('hex')
const FIXTURE_KEY = 'sk-ant-fixture-not-a-real-key'

const COHORT_MIGRATION = '20261013120000_outlook_cohort_reservation.sql'

// A and B are invited; C is not. Identical in every other way. Each account has TWO
// conversations: one with a party Funnl already knows (which yields an interaction
// suggestion) and one with a stranger (which yields a new-contact proposal). Both owners
// therefore end up with a candidate of BOTH kinds, which is what the isolation checks at
// the end need in order to be about ownership rather than about an empty table.
const ACC = {
  A: { user: '00000000-0000-4000-8000-0000000000aa', conn: '10000000-0000-4000-8000-0000000000aa',
       me: 'a@cohort.test', known: 'ava@firm.test', stranger: 'zoe@firm.test',
       knownName: 'Ava Recruiter', strangerName: 'Zoe Adeyemi' },
  B: { user: '00000000-0000-4000-8000-0000000000bb', conn: '10000000-0000-4000-8000-0000000000bb',
       me: 'b@cohort.test', known: 'noor@fund.test', stranger: 'kai@fund.test',
       knownName: 'Noor Analyst', strangerName: 'Kai Lindqvist' },
  C: { user: '00000000-0000-4000-8000-0000000000cc', conn: '10000000-0000-4000-8000-0000000000cc',
       me: 'c@cohort.test', known: 'omar@desk.test', stranger: 'rhea@desk.test',
       knownName: 'Omar Desk', strangerName: 'Rhea Byrne' },
}
const KEYS = ['A', 'B', 'C']
const ALL_ADDRESSES = KEYS.flatMap((k) => [ACC[k].me, ACC[k].known, ACC[k].stranger])

const CONSENT = `ol-disc-${'e'.repeat(32)}`
// THE SHAPE contentPermissions() EXPECTS, and the reason the first revision of this harness
// never completed a round. It passed the bare string, and contentPermissions does
// `'content' in required`, which THROWS on a string: "Cannot use 'in' operator to search
// for 'content' in ol-disc-ee...". The run reported that as `released_error` with no RPC
// rejection and no injected port of its own throwing - which is exactly how a fixture fault
// can be mistaken for a worker fault. The background requirement stays a separate scalar,
// because that is the parameter's real shape.
const REQUIRED_CONSENT = { content: CONSENT, thirdParty: CONSENT }

let passed = 0
let failed = 0
async function test (name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed += 1 }
  catch (e) { console.error(`  FAIL ${name}\n       ${e && e.message}`); failed += 1 }
}

// ── docker plumbing ──────────────────────────────────────────────────────────
const docker = (a, o = {}) => execFileSync('docker', a, { encoding: 'utf8', stdio: 'pipe', ...o })
const quiet = (a) => spawnSync('docker', a, { stdio: 'ignore' })

function psql (sql, { user = 'postgres', tuplesOnly = true } = {}) {
  const args = ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q']
  if (tuplesOnly) args.push('-At')
  args.push('-f', '-')
  return execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: 'pipe' })
}
const psqlFile = (p, user = 'postgres') =>
  psql(readFileSync(join(ROOT, p), 'utf8'), { user, tuplesOnly: false })
const rows = (sql) => psql(sql).trim().split('\n').filter(Boolean).map((l) => l.split('|'))
const one = (sql) => psql(sql).trim()

/**
 * Align auth.uid() with the PRODUCTION definition.
 *
 * THE REASON THIS IS NOT OPTIONAL. This image defines auth.uid() as
 * `current_setting('request.jwt.claim.sub')` - the SINGULAR legacy form - while PostgREST
 * v14 sets the JSON form, `request.jwt.claims`. Against the image as shipped, auth.uid() is
 * therefore NULL for every HTTP request, RLS hides every row from everybody, and the
 * acceptance RPCs answer `not_found` to their own owner. An isolation suite run that way
 * PASSES COMPLETELY WITHOUT PROVING ANYTHING: "A cannot see B's rows" is true because
 * nobody can see any row. Production's auth.uid() reads the JSON form, which is why
 * Production works; aligning the definition makes the local database behave like Production
 * and is what lets the positive controls below mean something. Nothing in the repo changes.
 *
 * tests/sql/_bootstrap-disposable-db.sql records the mismatch, and
 * tests/local/outlook-pilot-browser.mjs makes the same substitution for the same reason.
 */
function alignAuthUidWithProduction () {
  psql(`
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$f$;`, { user: 'supabase_admin', tuplesOnly: false })
}

function waitForPg (timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline) {
    const d = spawnSync('docker',
      ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: 'CREATE TABLE public._probe(i int); DROP TABLE public._probe;', encoding: 'utf8' })
    if (d.status === 0) { streak += 1; if (streak >= 3) return } else streak = 0
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)'])
  }
  throw new Error('postgres never became ready')
}

async function waitForRest (timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`, { headers: { Accept: 'application/json' } })
      if (r.status < 500) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('PostgREST never became ready')
}

function teardown () {
  quiet(['rm', '-f', REST]); quiet(['rm', '-f', PG]); quiet(['network', 'rm', NET])
}

// ── JWTs: the roles PostgREST switches into ──────────────────────────────────
function mintJwt (claims) {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = seg({ alg: 'HS256', typ: 'JWT' })
  const body = seg({ ...claims, iat: now, exp: now + 3600 })
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
const TOK = {
  worker: () => mintJwt({ role: 'service_role', aud: 'authenticated' }),
  user: (id) => mintJwt({ role: 'authenticated', aud: 'authenticated', sub: id }),
}

async function http (method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (token) { headers.Authorization = `Bearer ${token}`; headers.apikey = token }
  const r = await fetch(`${BASE}${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const raw = await r.text()
  let parsed = null
  try { parsed = raw.length ? JSON.parse(raw) : null } catch { parsed = null }
  return { status: r.status, body: parsed, raw }
}

// ── the worker's ports, over HTTP ────────────────────────────────────────────
function workerRpc (calls) {
  return async (name, args) => {
    calls.push({ name, args })
    const r = await http('POST', `/rpc/${name}`, { token: TOK.worker(), body: args })
    if (r.status >= 400) {
      // NAMED, not swallowed. Every RPC here goes to the real function, so a rejection is
      // either a real contract mismatch or a fixture that does not match the schema - and
      // the run's own report cannot tell the difference, because it never forwards a message.
      // LONG ENOUGH TO NAME THE CONSTRAINT. A 23514 whose message is cut off before the
      // constraint name tells you a check failed and nothing about which one, and these
      // rows are synthetic fixtures, so there is nothing here to withhold.
      console.error(`       [rpc ${r.status}] ${name}: ${r.raw.slice(0, 900)}`)
      return { data: null, error: { status: r.status, raw: r.raw.slice(0, 900) } }
    }
    return { data: r.body, error: null }
  }
}

const CURSOR_KEY = await webcrypto.subtle.importKey(
  'raw', randomBytes(32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
async function encryptCursor (plaintext) {
  const iv = randomBytes(12)
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, CURSOR_KEY,
    new TextEncoder().encode(plaintext))
  return { ciphertext: Buffer.from(ct).toString('base64'),
    nonce: Buffer.from(iv).toString('base64'), keyVersion: 1 }
}
async function decryptCursor (ciphertext, nonce) {
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(nonce, 'base64') }, CURSOR_KEY,
    Buffer.from(ciphertext, 'base64'))
  return new TextDecoder().decode(plain)
}

const RING = { current: { keyBytes: new Uint8Array(32).fill(7), keyVersion: 1 },
  accepted: [], subtle: webcrypto.subtle }

/** The committed cursors for ONE connection, read back from the database and decrypted. */
async function committedCursors (connId) {
  const got = rows(`SELECT folder, coalesce(delta_link_ciphertext,''), coalesce(delta_link_nonce,'')
                      FROM public.outlook_sync_state WHERE connection_id='${connId}' ORDER BY folder;`)
  const out = { inbox: null, sentitems: null }
  for (const [folder, ct, nonce] of got) {
    if (ct && nonce) out[folder] = await decryptCursor(ct, nonce)
  }
  return out
}

/**
 * The context the run loads AFTER the reservation has chosen a connection - so it is built
 * from the reserved owner, which is what makes a cohort run realistic: the harness does not
 * decide whose mailbox is read, the reservation does.
 *
 * THE ACCESS TOKEN IS PER ACCOUNT (`token-A`, `token-B`, `token-C`). The provider dispatches
 * on it, so whichever mailbox a round reads is the one its own reservation chose.
 */
function contextLoader () {
  // THE REAL SIGNATURE is loadRunContext(connectionId, runId, { deadlineMs, now }) -
  // positional, and the connection id is what says whose mailbox this round is for. Guessing
  // an options object made every round throw, which the run correctly reported as
  // `released_error`: the harness was wrong, not the worker.
  return async (connectionId) => {
    const key = KEYS.find((k) => ACC[k].conn === connectionId)
    const acc = ACC[key]
    if (!acc) throw new Error(`context for an unknown connection: ${connectionId}`)
    const contacts = rows(
      `SELECT id, user_id, email FROM public.contacts WHERE user_id='${acc.user}' ORDER BY id;`)
      .map(([id, user_id, email]) => ({ id, user_id, email }))
    return {
      primaryEmail: acc.me,
      aliases: [],
      timeZone: 'America/New_York',
      userId: acc.user,
      contacts,
      cursors: await committedCursors(acc.conn),
      accessToken: `token-${key}`,
      keyRing: RING,
      consentVersion: CONSENT,
    }
  }
}

// ── one mailbox per account: two threads each, one known party and one stranger ──
const okRes = (body) => ({ status: 200, headers: { get: () => null }, json: async () => body })
const addr = (e, n) => ({ emailAddress: { address: e, name: n } })
const qp = (u, name) => {
  const m = String(u).match(new RegExp('[?&]' + name.replace('$', '\\$') + '=([^&]*)'))
  return m ? decodeURIComponent(m[1]) : null
}

/**
 * The source text of each message, TAGGED so the model fixture can tell the four threads
 * apart - that tag is all the model request carries about which exchange it is. No address
 * appears in any body: an address in a model request is refused by the real minimization
 * guard, and a fixture that smuggled one in would be testing the guard rather than the
 * cohort.
 */
const BODIES = {
  'A-KNOWN': 'A-KNOWN-BODY Good to speak at the panel. Your name has gone forward for the '
    + 'spring programme and the team would like a short call next week.',
  'A-NEW': 'A-NEW-BODY I introduced myself after the panel - happy to read your resume if '
    + 'you send it over, and I can flag anything that stands out.',
  'B-KNOWN': 'B-KNOWN-BODY Thursday afternoon works on my side. Send two or three times and '
    + 'I will confirm one of them.',
  'B-NEW': 'B-NEW-BODY Good to meet you at the society dinner. Tell me which modules you '
    + 'took and I will pass your name to the desk.',
  'C-KNOWN': 'C-KNOWN-BODY This thread belongs to the account that was never invited and '
    + 'must never be read.',
  'C-NEW': 'C-NEW-BODY This thread belongs to the account that was never invited and must '
    + 'never be read.',
}
const DRAFT_NOTES = {
  'A-KNOWN': 'She confirmed your name went forward for the spring programme and asked for a '
    + 'short call next week. Left open: which day.',
  'A-NEW': 'He introduced himself after the panel and offered to read your resume. Left '
    + 'open: when you send it.',
  'B-KNOWN': 'She offered Thursday afternoon and asked for two or three times. Left open: '
    + 'which one is confirmed.',
  'B-NEW': 'He asked which modules you took and offered to pass your name to the desk. Left '
    + 'open: whether a referral follows.',
}
const TAGS = Object.keys(BODIES)

function mailboxes () {
  const world = {}
  for (const key of KEYS) {
    const a = ACC[key]
    const w = { inbox: [], sentitems: [], envelopes: {}, bodies: {}, folderOf: {} }
    for (const kind of ['KNOWN', 'NEW']) {
      const tag = `${key}-${kind}`
      const party = kind === 'KNOWN' ? a.known : a.stranger
      const partyName = kind === 'KNOWN' ? a.knownName : a.strangerName
      const conv = `AAQkA-${key}-${kind}`
      const inId = `msg-${tag}-in`
      const outId = `msg-${tag}-out`
      const env = (id, from, fromName, to, toName, sent) => ({
        id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
        subject: `Thread ${tag}`, from: addr(from, fromName), sender: addr(from, fromName),
        toRecipients: [addr(to, toName)], ccRecipients: [],
      })
      const inbound = env(inId, party, partyName, a.me, 'Me', '2026-09-21T14:00:00Z')
      const outbound = env(outId, a.me, 'Me', party, partyName, '2026-09-21T16:00:00Z')
      w.inbox.push(inbound)
      w.sentitems.push(outbound)
      w.envelopes[inId] = inbound
      w.envelopes[outId] = outbound
      w.folderOf[inId] = 'inbox'
      w.folderOf[outId] = 'sentitems'
      // Both halves carry the thread's tag, so a body read from either side routes the
      // model fixture to the same draft.
      w.bodies[inId] = BODIES[tag]
      w.bodies[outId] = `${tag}-BODY Thanks - noted, and I will come back to you.`
    }
    world[key] = w
  }
  return world
}
const WORLD = mailboxes()

function contentResponse (env, text) {
  return okRes({
    id: env.id,
    conversationId: env.conversationId,
    receivedDateTime: env.receivedDateTime,
    sentDateTime: env.sentDateTime,
    subject: env.subject,
    from: env.from,
    sender: env.sender,
    toRecipients: env.toRecipients,
    ccRecipients: [],
    body: { contentType: 'text', content: text },
    uniqueBody: { contentType: 'text', content: text },
    // Present and clean, so the screening stage has something to ASSESS rather than a
    // missing-headers deferral.
    internetMessageHeaders: [{ name: 'Received', value: 'by fixture' }],
  })
}

function modelResponse (payload) {
  return okRes({
    id: 'msg_fixture', type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  })
}

/**
 * The draft a model request earns, chosen from the body tag the request actually carries.
 *
 * It also RECORDS which schema the request asked for. Whether a thread yields a
 * new-contact proposal or an interaction suggestion is the worker's decision, made from
 * whether the other party is already one of that user's contacts - so the correlation
 * between the tag and the schema is an assertion worth making, and it is made after the
 * round rather than thrown here, where a throw would surface as `released_error`.
 */
function draftFor (requestBody, counts) {
  const tag = TAGS.find((t) => requestBody.indexOf(`${t}-BODY`) >= 0) ?? null
  const isNew = requestBody.indexOf('new_contact_suggestion') >= 0
  counts.drafts.push({ tag, isNew })
  if (!tag) return modelResponse({ result: 'no_suggestion', reason: 'fixture: untagged body' })
  const which = tag.endsWith('-NEW') ? 'stranger' : 'known'
  const key = tag.slice(0, 1)
  const base = {
    summary: DRAFT_NOTES[tag] ?? 'Fixture note.',
    summary_evidence: 'explicit_body',
    follow_up: 'Send the times and confirm one of them.',
    interaction_date: null,
  }
  return modelResponse(isNew
    ? { result: 'new_contact_suggestion',
        name: which === 'stranger' ? ACC[key].strangerName : ACC[key].knownName,
        name_evidence: 'explicit_signature', name_confidence: 'high', ...base }
    : { result: 'interaction_draft', ...base })
}

/**
 * Graph and Anthropic, with the mailbox chosen by the REQUEST'S OWN BEARER TOKEN.
 *
 * WHY THE TOKEN AND NOT A CALLER-SUPPLIED KEY. The first revision took the account key from
 * the test and served that mailbox whatever token arrived, so a round that read the WRONG
 * mailbox would still have been handed the "right" answer and the check would still have
 * passed. The token is minted per account by the context loader, which runs only after the
 * reservation has chosen a connection - so dispatching on it means the mailbox a round sees
 * is the one its own reservation and context load chose, and nothing else. A request whose
 * token names no account is refused loudly rather than served.
 */
function provider (counts) {
  return async (url, init) => {
    const u = String(url)
    if (u === ANTHROPIC_MESSAGES_URL) {
      counts.model += 1
      const sent = String(init?.body ?? '')
      // The privacy guards here are PRODUCTION's: the request was built and checked by the
      // real contract before it reached this fixture. This is the belt that proves the
      // braces held.
      for (const a of ALL_ADDRESSES) {
        if (sent.includes(a)) counts.leakedAddresses.push(a)
      }
      return draftFor(sent, counts)
    }

    const h = init?.headers
    const auth = String(
      (h && typeof h.get === 'function' ? h.get('authorization') : null)
      ?? h?.Authorization ?? h?.authorization ?? '')
    const key = KEYS.find((k) => auth.includes(`token-${k}`)) ?? null
    counts.tokens.push({ key, url: u.slice(0, 70) })
    if (!key) throw new Error(`a Graph request carried no account token: ${auth.slice(0, 24)}`)
    const w = WORLD[key]

    if (u.includes('/subscriptions')) {
      return { status: 403, headers: { get: () => null },
        json: async () => ({ error: { code: 'ExtensionError', message: 'fixture: no subscription' } }) }
    }

    const m = u.match(/\/me\/messages\/([^?]+)\?/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const env = w.envelopes[id]
      const select = qp(u, '$select') || ''
      if (select.indexOf('uniqueBody') < 0) {
        counts.envelopes.push({ key, id })
        if (!env) {
          return { status: 404, headers: { get: () => null },
            json: async () => ({ error: { code: 'ErrorItemNotFound' } }) }
        }
        return okRes({ ...env })
      }
      counts.bodies.push({ key, id })
      const text = w.bodies[id]
      if (!env || !text) {
        return { status: 404, headers: { get: () => null },
          json: async () => ({ error: { code: 'ErrorItemNotFound' } }) }
      }
      return contentResponse(env, text)
    }

    const folder = u.includes('/mailFolders/inbox/') || u.includes('/mailFolders/inbox?')
      || u.includes("/mailFolders('inbox')") ? 'inbox' : 'sentitems'
    if (u.includes('/messages/delta')) {
      // THE TOKEN DECIDES, as it does at Graph. A first listing has no $deltatoken and
      // returns the folder; a resumed listing presents the token it was given and returns
      // only what arrived since - here, nothing. Re-serving the whole folder to a resumed
      // request, which the first version of this fixture did, is behaviour no mailbox has.
      const token = qp(u, '$deltatoken')
      counts.deltas.push({ key, folder, token })
      const link = `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=${key}-1`
      return okRes({ value: token ? [] : w[folder], '@odata.deltaLink': link })
    }
    const filter = qp(u, '$filter')
    if (filter !== null) {
      const conv = (filter.match(/^conversationId eq '([^']*)'/) || [])[1] ?? null
      counts.lookups.push({ key, folder, conv })
      const value = w[folder].filter((e) => e.conversationId === conv)
      return okRes({ value })
    }
    return okRes({ value: [] })
  }
}

const newCounts = () => ({ model: 0, drafts: [], leakedAddresses: [], bodies: [],
  envelopes: [], deltas: [], lookups: [], tokens: [] })

/** Which single account a round actually talked to, from the tokens its requests carried. */
function servedAccount (counts) {
  const seen = [...new Set(counts.tokens.map((t) => t.key))]
  assert.strictEqual(seen.length, 1,
    `exactly one account's mailbox may be read per invocation, saw ${JSON.stringify(seen)}`)
  return seen[0]
}

/** Make every account due again, so each round is a fresh reservation decision. */
function makeDue () {
  psql(`UPDATE public.outlook_sync_state
           SET sync_status='idle', sync_lease_until=NULL, sync_run_id=NULL,
               next_retry_at=NULL, retry_count=0, last_run_complete=true,
               last_success_at=now() - interval '2 hours',
               last_attempt_at=now() - interval '2 hours';
        UPDATE public.microsoft_connections SET wake_requested_at=NULL;`, { tuplesOnly: false })
}

/**
 * Wraps an injected port so a throw inside the HARNESS is visible.
 *
 * WHY THIS EXISTS. The run deliberately never forwards a thrown message - it can contain a
 * URL or an address - and reports `released_error` instead. That is right for production and
 * blinding for a harness: a fixture bug and a worker bug look identical. So every port this
 * file injects reports its own failure before rethrowing.
 */
function traced (name, fn) {
  return async (...args) => {
    try { return await fn(...args) } catch (e) {
      console.error(`       [harness] ${name} threw: ${e && e.message}`)
      throw e
    }
  }
}

/** One invocation of the REAL run, with the cohort it is configured with. */
async function round (cohort, { fetchWrap } = {}) {
  const counts = newCounts()
  const calls = []
  const base = provider(counts)
  const run = await runOutlookImport({
    rpc: traced('rpc', workerRpc(calls)),
    pilotUserId: cohort,
    encryptCursor: traced('encryptCursor', encryptCursor),
    decryptCursor: traced('decryptCursor', decryptCursor),
    loadRunContext: traced('loadRunContext', contextLoader()),
    anthropicApiKey: FIXTURE_KEY,
    requiredConsent: REQUIRED_CONSENT,
    requiredBackgroundConsent: CONSENT,
    deps: { fetchImpl: traced('graph', fetchWrap ? fetchWrap(base) : base) },
  })
  return { run, report: summarizeRun(run), counts, calls }
}

/**
 * AN ORDERED FULL-ROW DIGEST PER TABLE, computed in the database.
 *
 * WHY NOT THE PROJECTION BELOW. `observedOf()` reads the few columns the positive checks
 * need - a cursor is present, a lease is released. Comparing two of those and calling the
 * result "byte-for-byte unchanged" was wrong: every column it does not read could have moved.
 * A candidate's draft, its evidence codes, its `updated_at`, its `context_expires_at`, a
 * provenance row's coverage columns, the connection's own fields and a recovery record were
 * all outside the comparison.
 *
 * So each table in scope is reduced to `md5` over `t::text` of EVERY row, ordered by that
 * table's own key, together with the row count. `t::text` is the whole row, so any change to
 * any column in any row changes the digest; the explicit ORDER BY makes it stable across
 * reads, and the count distinguishes "nothing there" from "one row that happens to digest
 * the same". Nothing but the digest and the count is ever printed - no row, no identifier,
 * no ciphertext - which is also why this is a digest rather than a row-by-row diff.
 */
const DIGEST_SCOPES = (key) => [
  ['connection', 'public.microsoft_connections', `t.id='${ACC[key].conn}'`, 't.id'],
  ['sync_state', 'public.outlook_sync_state', `t.connection_id='${ACC[key].conn}'`, 't.folder'],
  ['interaction_candidates', 'public.interaction_candidates', `t.user_id='${ACC[key].user}'`, 't.id'],
  ['new_contact_candidates', 'public.new_contact_candidates', `t.user_id='${ACC[key].user}'`, 't.id'],
  ['candidate_refs', 'public.outlook_candidate_refs', `t.user_id='${ACC[key].user}'`, 't.id'],
  ['thread_recovery', 'public.outlook_thread_recovery', `t.user_id='${ACC[key].user}'`, 't.conversation_fingerprint'],
]

function digestOf (key) {
  const out = {}
  for (const [label, table, where, order] of DIGEST_SCOPES(key)) {
    // E'\x1e' (record separator) joins the rows: a delimiter no fixture text contains, so
    // two different row sets cannot collapse into one string.
    const v = one(`SELECT coalesce(md5(string_agg(t::text, E'\\x1e' ORDER BY ${order})), 'empty')
                     || ' x' || count(*)
                     FROM ${table} t WHERE ${where};`)
    out[label] = v
  }
  return out
}

/** Compare two digests and say which table moved, without printing a row. */
function assertSameDigest (label, actual, expected) {
  const moved = Object.keys(expected).filter((k) => actual[k] !== expected[k])
  assert.deepStrictEqual(moved, [],
    `${label}: ${moved.map((k) => `${k} ${expected[k]} -> ${actual[k]}`).join('; ')}`)
}

/** The few columns the POSITIVE checks read. Never used as a preservation comparison. */
const observedOf = (key) => ({
  cursors: rows(`SELECT folder, coalesce(delta_link_ciphertext,'none')
                   FROM public.outlook_sync_state WHERE connection_id='${ACC[key].conn}'
                  ORDER BY folder;`),
  // `(... > now())::text` renders 'true'/'false', and 'none' when the lease is NULL. Spelled
  // out because comparing it against psql's bare-boolean 't' is what made the lease check
  // vacuous for as long as it existed.
  leases: rows(`SELECT folder, sync_status, coalesce((sync_lease_until > now())::text,'none')
                  FROM public.outlook_sync_state WHERE connection_id='${ACC[key].conn}'
                 ORDER BY folder;`),
  interactions: rows(`SELECT id, status FROM public.interaction_candidates
                        WHERE user_id='${ACC[key].user}' ORDER BY id;`),
  newContacts: rows(`SELECT id, status FROM public.new_contact_candidates
                       WHERE user_id='${ACC[key].user}' ORDER BY id;`),
  refs: Number(one(`SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id='${ACC[key].user}';`)),
  recovery: Number(one(`SELECT count(*) FROM public.outlook_thread_recovery WHERE user_id='${ACC[key].user}';`)),
  lastSuccess: one(`SELECT coalesce(max(last_success_at)::text,'never') FROM public.outlook_sync_state
                     WHERE connection_id='${ACC[key].conn}';`),
})

/**
 * Every lease this account holds is released and no folder is left running.
 *
 * THE SECOND COMPARISON USED TO BE MEANINGLESS. It read `notStrictEqual(future, 't')`, but
 * the query casts the boolean with `::text`, which renders 'true' and 'false' - psql only
 * prints a BARE boolean as 't'/'f'. So the assertion was "'true' is not 't'", which holds for
 * ever, whether or not a lease was held. Found while writing
 * tests/local/outlook-refresh-expiry.mjs, where the same mistake failed loudly because that
 * check was written the other way round.
 *
 * Now positive, and it requires rows to exist: a check over an empty list passes too.
 */
function assertLeasesReleased (key) {
  const seen = observedOf(key).leases
  assert.strictEqual(seen.length, 2, `${key} must have both folders in sync state`)
  for (const [folder, status, future] of seen) {
    assert.notStrictEqual(status, 'running', `${key}/${folder} is still running`)
    assert.ok(future === 'none' || future === 'false',
      `${key}/${folder} still holds a live lease (lease_in_future=${future})`)
  }
}

let harnessError = null
try {
  console.log('\nbuilding a disposable database and PostgREST')
  teardown()
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', 'POSTGRES_PASSWORD=disposable', PG_IMAGE])
  waitForPg()
  psqlFile('tests/sql/_bootstrap-disposable-db.sql', 'supabase_admin')
  alignAuthUidWithProduction()

  const all = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  assert.ok(all.includes(COHORT_MIGRATION), 'the cohort migration must exist')
  const before = all.filter((f) => f !== COHORT_MIGRATION)
  for (const m of before) psqlFile(`supabase/migrations/${m}`)
  console.log(`  applied ${before.length} migrations, DEFERRING ${COHORT_MIGRATION}`)

  psql("ALTER ROLE authenticator WITH PASSWORD 'disposable';", { user: 'supabase_admin', tuplesOnly: false })
  // PRODUCTION GRANT SHAPE, reproduced deliberately. Supabase grants table privileges to
  // `authenticated` by default - the review queue reads both candidate tables with the
  // viewer's own JWT - while this image does not. Without the grant a cross-account read is
  // refused for the WRONG reason (no privilege at all), the RLS policy is never exercised,
  // and the owner cannot read their own rows either - so the suite would look stronger
  // while proving less.
  psql(`GRANT SELECT ON public.interaction_candidates TO authenticated;
        GRANT SELECT ON public.new_contact_candidates TO authenticated;`,
  { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', '53997:3000',
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitForRest()
  console.log('  PostgREST is serving\n')

  // ══ 1. what the OLD function actually answers ═══════════════════════════════
  console.log('1. the pre-migration function, over HTTP')
  const threeArgBody = { p_lease_seconds: 60, p_due_after_seconds: 900,
    p_pilot_user_id: ACC.A.user }
  await test('three named parameters resolve against the old function', async () => {
    const r = await http('POST', '/rpc/reserve_due_outlook_connection',
      { token: TOK.worker(), body: threeArgBody })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 200))
    assert.strictEqual(r.body?.result, 'none_due', 'no connection exists yet')
  })

  let oldFourArgAnswer = null
  await test('a FOUR-parameter call is REFUSED, not silently narrowed or ignored', async () => {
    const r = await http('POST', '/rpc/reserve_due_outlook_connection',
      { token: TOK.worker(), body: { ...threeArgBody, p_pilot_user_ids: [ACC.A.user] } })
    oldFourArgAnswer = { status: r.status, code: r.body?.code ?? null }
    // MEASURED, because a comment in the first revision of this work asserted the opposite.
    // PostgREST resolves a function by the named arguments in the body; an unknown argument
    // means no candidate matches, which is a 404 with PGRST202 - the request never reaches
    // any function, so "silently ignores the extra argument" was wrong.
    assert.strictEqual(r.status, 404, JSON.stringify(oldFourArgAnswer))
    assert.strictEqual(r.body?.code, 'PGRST202', JSON.stringify(oldFourArgAnswer))
  })
  console.log(`       the old function answers a four-argument call with: ${JSON.stringify(oldFourArgAnswer)}`)

  // ══ 2. apply the migration, then prove compatibility BY OMISSION ═══════════
  console.log('\n2. after the cohort migration')
  psqlFile(`supabase/migrations/${COHORT_MIGRATION}`)
  // PostgREST caches the schema; a NOTIFY is how a project reloads it.
  psql("NOTIFY pgrst, 'reload schema';", { tuplesOnly: false })
  await new Promise((r) => setTimeout(r, 1500))

  await test('a THREE-named-parameter call still works, the fourth OMITTED entirely', async () => {
    // This is the compatibility that matters for the rollout order: the worker deployed
    // today sends exactly these three. Passing an explicit NULL fourth argument would not
    // test it, because that is a different request.
    const r = await http('POST', '/rpc/reserve_due_outlook_connection',
      { token: TOK.worker(), body: threeArgBody })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 300))
    assert.strictEqual(r.body?.result, 'none_due')
  })

  await test('and the FOUR-parameter call now resolves', async () => {
    const r = await http('POST', '/rpc/reserve_due_outlook_connection',
      { token: TOK.worker(), body: { ...threeArgBody, p_pilot_user_ids: [ACC.A.user] } })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 300))
    assert.strictEqual(r.body?.result, 'none_due')
  })

  await test('anon and an authenticated user may not reserve at all', async () => {
    for (const token of [undefined, TOK.user(ACC.A.user)]) {
      const r = await http('POST', '/rpc/reserve_due_outlook_connection',
        { token, body: { ...threeArgBody, p_pilot_user_ids: [ACC.A.user] } })
      assert.ok(r.status === 401 || r.status === 403 || r.status === 404,
        `expected a refusal, got ${r.status}: ${r.raw.slice(0, 120)}`)
    }
  })

  // ══ 3. three accounts, three mailboxes, one excluded ═══════════════════════
  console.log('\n3. the real worker over PostgREST: ONE cohort value, two invited accounts')
  for (const key of KEYS) {
    const a = ACC[key]
    psql(`INSERT INTO auth.users (id, email, email_confirmed_at, created_at, updated_at)
          VALUES ('${a.user}', '${a.me}', now(), now(), now()) ON CONFLICT (id) DO NOTHING;
          INSERT INTO public.microsoft_connections
            (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes, status,
             needs_reauth, consented_at, consent_policy_version)
          VALUES ('${a.conn}', '${a.user}', 'acct-${key}', 'consumers', 'personal', '${a.me}',
                  ARRAY['Mail.Read','User.Read','offline_access'], 'active', false, now(), '${CONSENT}');
          -- ONE party per account is already a contact and one is a stranger, so each
          -- account's round produces an interaction suggestion AND a new-contact proposal.
          INSERT INTO public.contacts (user_id, name, email)
          VALUES ('${a.user}', '${a.knownName}', '${a.known}');
          -- initial_import_done FALSE and no cursor, which is what a newly invited account
          -- actually looks like. Marking a folder done while it holds no delta link is a
          -- state the worker never writes, and seeding it that way made the first round
          -- throw - reported as released_error, with the fixture at fault.
          INSERT INTO public.outlook_sync_state
            (connection_id, user_id, folder, sync_status, initial_import_done,
             last_success_at, last_attempt_at, last_run_complete)
          VALUES ('${a.conn}','${a.user}','inbox','idle',false, now() - interval '2 hours', now() - interval '2 hours', true),
                 ('${a.conn}','${a.user}','sentitems','idle',false, now() - interval '2 hours', now() - interval '2 hours', true);`,
    { tuplesOnly: false })
  }
  // THE SAME VALUE FOR BOTH INVOCATIONS. The first revision configured one eligible user at
  // a time, which made the harness - not the reservation - decide whose mailbox was read,
  // and so proved nothing about serving a cohort.
  const COHORT = `${ACC.A.user},${ACC.B.user}`
  const served = []
  // Accumulated from the invocations that actually read a mailbox. Asserting over a later
  // invocation's counts would be vacuous: by then nothing is due, so there are no drafts to
  // examine and an empty loop passes.
  const allDrafts = []
  const allLeaks = []

  await test('with both invited accounts due, each invocation serves ONE of them, chosen by the reservation', async () => {
    makeDue()
    const before = { A: digestOf('A'), B: digestOf('B'), C: digestOf('C') }
    assert.ok(observedOf('A').cursors.every(([, ct]) => ct === 'none'), 'A starts with no cursor')
    assert.ok(observedOf('B').cursors.every(([, ct]) => ct === 'none'), 'B starts with no cursor')
    // A digest is only a preservation instrument if it is stable when nothing changes.
    assertSameDigest('a digest read twice with nothing between must be identical',
      digestOf('A'), before.A)

    const r1 = await round(COHORT)
    allDrafts.push(...r1.counts.drafts); allLeaks.push(...r1.counts.leakedAddresses)
    assert.ok(['committed', 'ok'].includes(r1.run.outcome), JSON.stringify(r1.report))
    const first = servedAccount(r1.counts)
    assert.ok(first === 'A' || first === 'B', `an invited account must be served, got ${first}`)
    served.push(first)
    const other = first === 'A' ? 'B' : 'A'
    // Every row of the account it did NOT choose, and of the excluded one, is unchanged.
    assertSameDigest(`${other} must be untouched by a round that served ${first}`,
      digestOf(other), before[other])
    assertSameDigest('the excluded account must be untouched', digestOf('C'), before.C)
    // THE ROUND THAT RAN DID WRITE: a preservation check proves nothing if nothing moved
    // anywhere, so the served account's own digest must have changed.
    const movedFirst = Object.keys(before[first]).filter((k) => digestOf(first)[k] !== before[first][k])
    assert.ok(movedFirst.length > 0, `${first} was served but nothing of it changed`)
    // Pinned here, so the SECOND round is measured against it.
    const afterFirst = digestOf(first)

    const r2 = await round(COHORT)
    allDrafts.push(...r2.counts.drafts); allLeaks.push(...r2.counts.leakedAddresses)
    assert.ok(['committed', 'ok'].includes(r2.run.outcome), JSON.stringify(r2.report))
    const second = servedAccount(r2.counts)
    served.push(second)
    // THE RESERVATION'S OWN CHOICE, not the harness's: the longest-unserved connection is
    // preferred, so the second invocation takes the one the first left alone.
    assert.strictEqual(second, other,
      `the second invocation must serve the other invited account, got ${second}`)
    // AND NOW THE OTHER DIRECTION. The first round's account has rows by this point -
    // candidates, provenance, cursors - and the second round must not have touched one
    // column of any of them. That is the case the earlier check could not make, because it
    // only ever compared the account that had nothing yet.
    assertSameDigest(`${first} must be untouched by the round that served ${second}`,
      digestOf(first), afterFirst)
    assertSameDigest('the excluded account is still untouched', digestOf('C'), before.C)
    console.log(`       digests: ${first} and ${second} each served once;`
      + ` ${first} unchanged across the second round; C unchanged throughout`)
  })

  await test('each served account read its OWN mailbox, and wrote candidates of BOTH kinds', async () => {
    assert.deepStrictEqual([...served].sort(), ['A', 'B'],
      `both invited accounts must have been served: ${JSON.stringify(served)}`)
    for (const key of ['A', 'B']) {
      const s = observedOf(key)
      assert.ok(s.cursors.every(([, ct]) => ct !== 'none'),
        `${key} must have committed a cursor for both folders: ${JSON.stringify(s.cursors)}`)
      assert.ok(s.interactions.length >= 1,
        `${key} must have an interaction suggestion for its KNOWN party`)
      assert.ok(s.newContacts.length >= 1,
        `${key} must have a new-contact proposal for its STRANGER`)
      assert.ok(s.refs >= 2, `${key} must have a provenance row per candidate, got ${s.refs}`)
      assertLeasesReleased(key)
    }
  })

  await test('no model request carried an address, and each thread asked for the right schema', async () => {
    // FROM THE TWO INVOCATIONS THAT READ MAIL. Four threads in all - a known party and a
    // stranger for each invited account - so an empty list here is itself a failure.
    assert.deepStrictEqual(allLeaks, [],
      `an address reached the model request: ${JSON.stringify(allLeaks)}`)
    assert.ok(allDrafts.length >= 4,
      `expected a model request per thread, got ${allDrafts.length}`)
    const kinds = new Set()
    for (const d of allDrafts) {
      assert.ok(d.tag, 'every model request must carry a fixture body tag')
      // WHICH SCHEMA IS THE WORKER'S DECISION, made from whether the other party is already
      // one of that user's contacts. The tag says which thread it was, so the two must agree.
      assert.strictEqual(d.isNew, d.tag.endsWith('-NEW'),
        `${d.tag} asked for the wrong schema (new_contact_suggestion=${d.isNew})`)
      kinds.add(d.isNew ? 'new' : 'interaction')
      assert.ok(d.tag.startsWith('A-') || d.tag.startsWith('B-'),
        `a thread outside the cohort reached the model: ${d.tag}`)
    }
    assert.deepStrictEqual([...kinds].sort(), ['interaction', 'new'],
      'both schemas must have been exercised')
  })

  await test('the EXCLUDED account is never reserved, even while it is the only one due', async () => {
    makeDue()
    // Make A and B un-due so C is the only connection the reservation could pick.
    psql(`UPDATE public.outlook_sync_state SET last_success_at = now()
           WHERE connection_id IN ('${ACC.A.conn}','${ACC.B.conn}');`, { tuplesOnly: false })
    const beforeC = digestOf('C')
    const r = await round(COHORT)
    assert.strictEqual(r.run.outcome, 'none_due', JSON.stringify(r.report))
    assert.strictEqual(r.counts.tokens.length, 0, 'the excluded mailbox must not be touched')
    assertSameDigest('nothing of the excluded account may change', digestOf('C'), beforeC)
    assert.strictEqual(observedOf('C').cursors.filter(([, ct]) => ct !== 'none').length, 0,
      'the excluded account has no committed cursor')
  })

  await test('cross-account rows are impossible: no provenance or candidate points elsewhere', async () => {
    const crossed = Number(one(`SELECT count(*) FROM public.outlook_candidate_refs r
                                  JOIN public.microsoft_connections m ON m.id = r.connection_id
                                 WHERE r.user_id <> m.user_id;`))
    assert.strictEqual(crossed, 0,
      "no provenance row may belong to one user under another account's connection")
    const mixed = Number(one(`SELECT count(*) FROM public.interaction_candidates ic
                                JOIN public.contacts ct ON ct.id = ic.contact_id
                               WHERE ct.user_id <> ic.user_id;`))
    assert.strictEqual(mixed, 0, "no candidate may point at another user's contact")
    const cRows = observedOf('C')
    assert.strictEqual(cRows.interactions.length + cRows.newContacts.length + cRows.refs
      + cRows.recovery, 0, `the excluded account has state: ${JSON.stringify(cRows)}`)
  })

  // ══ 4. removal and re-addition, same durable fixture ══════════════════════
  console.log('\n4. removal and re-addition against the same durable state')
  await test('a removed account is refused, and its durable state is untouched', async () => {
    makeDue()
    // B is removed: the cohort is A alone. B is the only account left due.
    psql(`UPDATE public.outlook_sync_state SET last_success_at = now()
           WHERE connection_id IN ('${ACC.A.conn}','${ACC.C.conn}');`, { tuplesOnly: false })
    const before = digestOf('B')
    const r = await round(ACC.A.user)
    assert.strictEqual(r.run.outcome, 'none_due', JSON.stringify(r.report))
    assert.strictEqual(r.counts.tokens.length, 0, "the removed account's mailbox must not be read")
    assertSameDigest("removal must not change one row of B's state", digestOf('B'), before)
  })

  await test('re-added, the same account resumes from its OWN committed cursor', async () => {
    const cursorsBefore = await committedCursors(ACC.B.conn)
    assert.ok(cursorsBefore.inbox && cursorsBefore.sentitems,
      'B must still hold the cursors it committed before removal')
    makeDue()
    psql(`UPDATE public.outlook_sync_state SET last_success_at = now()
           WHERE connection_id IN ('${ACC.A.conn}','${ACC.C.conn}');`, { tuplesOnly: false })
    const beforeB = digestOf('B')
    const seen = []
    const r = await round(COHORT, {
      fetchWrap: (base) => async (url, init) => {
        const u = String(url)
        if (u.includes('/messages/delta')) seen.push(u)
        return base(url, init)
      },
    })
    assert.ok(['committed', 'ok'].includes(r.run.outcome), JSON.stringify(r.report))
    assert.strictEqual(servedAccount(r.counts), 'B', 'the re-added account is the one served')
    // RESUMED, not restarted: both delta requests presented the token B had committed, so
    // the mailbox returned only what arrived since - nothing - rather than the folder again.
    assert.strictEqual(seen.length, 2, `one delta request per folder: ${seen.length}`)
    for (const u of seen) {
      assert.ok(u.includes('deltatoken=B-1'),
        `the resumed round must use B's own committed delta token: ${u}`)
    }
    // A resumed round with no new mail may advance its own sync state and nothing else: the
    // candidates, the provenance rows, the recovery records and the connection must all
    // digest exactly as they did before it ran.
    const afterB = digestOf('B')
    for (const table of ['connection', 'interaction_candidates', 'new_contact_candidates',
      'candidate_refs', 'thread_recovery']) {
      assert.strictEqual(afterB[table], beforeB[table],
        `${table} moved during a resumed round with no new mail: `
        + `${beforeB[table]} -> ${afterB[table]}`)
    }
    assertLeasesReleased('B')
    // A DEFECT THIS HARNESS FOUND, recorded where it was found rather than worked around.
    // When a NEW message does arrive in a thread whose new-contact proposal is still
    // 'pending' or 'deferred', upsert_new_contact_candidate takes its refresh branch and
    // sets `context_expires_at = now() + interval '30 days'` while `created_at` keeps the
    // original insert time. The table's own ceiling is
    // `context_expires_at <= created_at + interval '30 days'`, so the refresh violates it
    // by however long the row has existed - a second is enough. Reproduced here as
    // 23514 / ncc_context_ceiling, which the run surfaces as `rpc_error` and `write_failed`
    // with no cursor advanced. It is pre-existing on main (the refresh branch dates from
    // 20261006000000 and the current definition from 20261010180000), it is NOT caused by
    // the cohort change, and it is not fixed here: a schema correction belongs in its own
    // reviewed migration, not folded into this one. docs/outlook-cohort-rollout-plan.md
    // records it as a named follow-up.
  })

  // ══ 5. one user cannot reach another's review surface ══════════════════════
  console.log('\n5. account isolation over HTTP, with positive controls')
  const own = {}
  for (const key of ['A', 'B']) {
    own[key] = {
      interaction: one(`SELECT id FROM public.interaction_candidates
                         WHERE user_id='${ACC[key].user}' AND status='pending'
                         ORDER BY created_at LIMIT 1;`),
      newContact: one(`SELECT id FROM public.new_contact_candidates
                        WHERE user_id='${ACC[key].user}' AND status='pending'
                        ORDER BY created_at LIMIT 1;`),
    }
  }

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  await test('PREREQUISITE: both users hold a pending candidate of BOTH kinds', async () => {
    // Without this, every refusal below could be a refusal about a row that does not exist.
    for (const key of ['A', 'B']) {
      assert.ok(UUID.test(own[key].interaction),
        `${key} has no pending interaction candidate: ${JSON.stringify(own[key])}`)
      assert.ok(UUID.test(own[key].newContact),
        `${key} has no pending new-contact candidate: ${JSON.stringify(own[key])}`)
    }
  })

  await test('CONTROL: each user can READ their own candidates of both kinds', async () => {
    // If this fails, every "cannot see the other's rows" result below is vacuous - that is
    // precisely what happened while auth.uid() read the claim form PostgREST does not set.
    for (const key of ['A', 'B']) {
      for (const [table, id] of [['interaction_candidates', own[key].interaction],
        ['new_contact_candidates', own[key].newContact]]) {
        const r = await http('GET', `/${table}?select=id,user_id&id=eq.${id}`,
          { token: TOK.user(ACC[key].user) })
        assert.strictEqual(r.status, 200, `${key}/${table}: ${r.raw.slice(0, 200)}`)
        assert.strictEqual((r.body ?? []).length, 1,
          `${key} cannot read its own ${table} row: ${r.raw.slice(0, 200)}`)
        assert.strictEqual(r.body[0].user_id, ACC[key].user)
      }
    }
  })

  await test("neither user SEES the other's candidates, in an open read or a targeted one", async () => {
    for (const [viewer, owner] of [['A', 'B'], ['B', 'A']]) {
      for (const [table, id] of [['interaction_candidates', own[owner].interaction],
        ['new_contact_candidates', own[owner].newContact]]) {
        const open = await http('GET', `/${table}?select=id,user_id`,
          { token: TOK.user(ACC[viewer].user) })
        assert.strictEqual(open.status, 200, `${table}: ${open.raw.slice(0, 200)}`)
        const owners = [...new Set((open.body ?? []).map((row) => row.user_id))]
        assert.ok(owners.length > 0, `${viewer} saw no rows at all, so this proves nothing`)
        assert.ok(owners.every((o) => o === ACC[viewer].user),
          `${viewer} saw other owners in ${table}: ${JSON.stringify(owners)}`)
        // And asking for the other user's row BY ID returns nothing rather than the row.
        const aimed = await http('GET', `/${table}?select=id&id=eq.${id}`,
          { token: TOK.user(ACC[viewer].user) })
        assert.strictEqual(aimed.status, 200, aimed.raw.slice(0, 200))
        assert.strictEqual((aimed.body ?? []).length, 0,
          `${viewer} read ${owner}'s ${table} row by id`)
      }
    }
  })

  await test("a valid accept or dismiss of the OTHER user's candidate is refused, and changes nothing", async () => {
    for (const [intruder, owner] of [['A', 'B'], ['B', 'A']]) {
      const asIntruder = TOK.user(ACC[intruder].user)
      const iid = own[owner].interaction
      const nid = own[owner].newContact
      const beforeI = one(`SELECT status || '|' || coalesce(interaction_id::text,'none')
                             FROM public.interaction_candidates WHERE id='${iid}';`)
      // new_contact_candidates records its acceptance in accepted_contact_id; there is no
      // contact_id column on it, which is what the first version of this query assumed.
      const beforeN = one(`SELECT status || '|' || coalesce(accepted_contact_id::text,'none')
                             FROM public.new_contact_candidates WHERE id='${nid}';`)
      for (const [rpc, body] of [
        ['accept_interaction_candidate', { p_candidate_id: iid, p_override_notes: 'intruder' }],
        ['dismiss_interaction_candidate', { p_candidate_id: iid }],
      ]) {
        const r = await http('POST', `/rpc/${rpc}`, { token: asIntruder, body })
        assert.strictEqual(r.body?.result, 'not_found',
          `${intruder} got ${JSON.stringify(r.body)} from ${rpc} on ${owner}'s row`)
      }
      for (const [rpc, body] of [
        ['accept_new_contact_candidate', { p_candidate_id: nid, p_name: 'Intruder' }],
        ['dismiss_new_contact_candidate', { p_candidate_id: nid }],
      ]) {
        const r = await http('POST', `/rpc/${rpc}`, { token: asIntruder, body })
        assert.strictEqual(r.body?.result, 'not_found',
          `${intruder} got ${JSON.stringify(r.body)} from ${rpc} on ${owner}'s row`)
      }
      assert.strictEqual(one(`SELECT status || '|' || coalesce(interaction_id::text,'none')
                                FROM public.interaction_candidates WHERE id='${iid}';`), beforeI,
      `${owner}'s interaction candidate changed`)
      assert.strictEqual(one(`SELECT status || '|' || coalesce(accepted_contact_id::text,'none')
                                FROM public.new_contact_candidates WHERE id='${nid}';`), beforeN,
      `${owner}'s new-contact candidate changed`)
    }
  })

  await test('CONTROL: the OWNER accepts the very rows the other user could not', async () => {
    // The strongest form of the control: same row, same request shape, different caller.
    // A refusal that flips to 'accepted' when the owner asks cannot have been a missing
    // grant, a malformed request or an absent function.
    for (const key of ['A', 'B']) {
      const asOwner = TOK.user(ACC[key].user)
      const acc = await http('POST', '/rpc/accept_interaction_candidate',
        { token: asOwner, body: { p_candidate_id: own[key].interaction,
          p_override_notes: 'Reviewed by the owner.' } })
      assert.strictEqual(acc.body?.result, 'accepted',
        `${key} could not accept its own interaction candidate: ${acc.raw.slice(0, 200)}`)
      const nc = await http('POST', '/rpc/accept_new_contact_candidate',
        { token: asOwner, body: { p_candidate_id: own[key].newContact,
          p_name: ACC[key].strangerName } })
      assert.strictEqual(nc.body?.result, 'accepted',
        `${key} could not accept its own new-contact candidate: ${nc.raw.slice(0, 200)}`)
    }
    // And the interactions and contacts that resulted belong to the right owners.
    const mixed = Number(one(`SELECT count(*) FROM public.interactions i
                                JOIN public.contacts c ON c.id = i.contact_id
                               WHERE c.user_id <> i.user_id;`))
    assert.strictEqual(mixed, 0, 'an accepted interaction landed under the wrong owner')
  })

  await test('neither user can read ANY worker-only table', async () => {
    for (const table of ['outlook_sync_state', 'outlook_candidate_refs',
      'outlook_thread_recovery', 'outlook_subscriptions', 'microsoft_connections']) {
      for (const who of [ACC.A.user, ACC.B.user]) {
        const r = await http('GET', `/${table}?select=*`, { token: TOK.user(who) })
        const rowsBack = Array.isArray(r.body) ? r.body.length : 0
        assert.ok(r.status >= 400 || rowsBack === 0,
          `${table} leaked ${rowsBack} rows to ${who}: ${r.status} ${r.raw.slice(0, 160)}`)
      }
    }
  })

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
} catch (e) {
  harnessError = e
  console.error(`\nHARNESS ERROR: ${e.message}\n${e.stack}`)
  if (e.stdout) console.error(String(e.stdout).slice(-3000))
  if (e.stderr) console.error(String(e.stderr).slice(-3000))
} finally {
  teardown()
  if (harnessError) {
    console.error('FAILED: the harness threw before finishing; the run proves nothing.')
  }
  if (failed > 0 || harnessError) process.exitCode = 1
}
