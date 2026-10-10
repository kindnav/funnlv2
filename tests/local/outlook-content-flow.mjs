#!/usr/bin/env node
// THE COMPLETE CONTENT FLOW, locally: a real summary, a proposed contact, and the
// acceptance that creates both.
//
// This drives the SAME run module the worker endpoint calls
// (shared/outlookImportRun.js) end to end against:
//   * CONTROLLED MICROSOFT FIXTURES - a fake fetch serving scripted Graph delta pages
//     AND scripted per-message content reads. No request leaves this machine and no
//     mailbox is involved.
//   * A CONTROLLED ANTHROPIC FIXTURE - the same fake fetch answers the Messages API
//     with a scripted tool-use payload. No provider is contacted and no key exists.
//   * A REAL Postgres - the project's own Supabase image, every migration applied
//     including the eight unapplied forward ones, with the real anon / authenticated /
//     service_role roles.
//   * REAL PostgREST - the worker acts as service_role over HTTP; the reviewing user
//     acts with their own JWT, exactly as the browser would.
//
// WHAT IT PROVES - each is an assertion below, not a claim:
//   1. a MEANINGFUL KNOWN-CONTACT SUMMARY: the stored note says what was discussed,
//      and it is the model's validated summary rather than a subject or a count;
//   2. an UNKNOWN-CONTACT PROPOSAL WITH AN INTERACTION: one new_contact_candidates row
//      carrying the draft, with the address taken from the Graph envelope;
//   3. EDITS PRESERVED ON ACCEPTANCE: the user's corrected name, company and note are
//      what land in contacts and interactions - not the proposal;
//   4. ZERO CONTACTS AND INTERACTIONS BEFORE ACCEPTANCE: counted directly in the
//      database after the whole run, and again after a dismissal;
//   5. DUPLICATE PREVENTION: a second identical run creates no second suggestion, no
//      second handle, and no second contact;
//   6. STALE CONSENT: a connection on the envelope-only disclosure stores ZERO
//      handles, reads ZERO bodies and makes ZERO model calls - counted at the fixture;
//   7. INTERRUPTED CONTENT PROCESSING RESUMES WITH NOTHING SKIPPED: an invocation
//      stopped mid-batch writes no noteless suggestion for the conversation it was
//      working on, and the next invocation summarizes that exact conversation.
//
// WHAT IT DOES NOT COVER, stated rather than implied:
//   * THE BROWSER. No click happens. The review reads and writes go straight to
//     PostgREST with a minted JWT, so Kong, supabase-js and every React component are
//     unexercised. What IS exercised is the page's own query shape and argument
//     builder - both imported from src/lib/newContactReview.js rather than retyped.
//   * REAL MICROSOFT AND REAL ANTHROPIC. Every provider response is a local fixture
//     built from the documented contract. These tests say what the code does GIVEN a
//     response of that shape; they are not evidence that either provider produces it.
//   * GoTrue. JWTs are minted locally with a throwaway secret; no sign-in happens.
//   * Token acquisition. The Graph access token is injected.
//
// NO REAL ADDRESS, NAME, MESSAGE OR KEY APPEARS IN THIS FILE.
//
// REQUIREMENTS: Docker, plus the two images the project already uses.
// RUN: node tests/local/outlook-content-flow.mjs   (builds and tears down)

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, createHmac, webcrypto } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'
import { runOutlookImport, summarizeRun } from '../../supabase/functions/shared/outlookImportRun.js'
import { GRAPH_BASE } from '../../supabase/functions/shared/outlookGraphTransport.js'
import { ANTHROPIC_MESSAGES_URL } from '../../supabase/functions/shared/outlookDraftContract.js'
import {
  NCC_SELECT, acceptArgs, initialReviewState,
} from '../../src/lib/newContactReview.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-content-pg'
const REST = 'funnl-content-rest'
const NET = 'funnl-content-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const BASE = 'http://127.0.0.1:53997'

const U1 = '11111111-1111-1111-1111-111111111111'
const ME = 'student@getfunnl.test'
const KNOWN = 'ava@bank.test'            // already a contact
const STRANGER = 'priya@fund.test'       // not in Funnl
const JWT_SECRET = randomBytes(32).toString('hex')   // per run; never printed

// THE APPROVED DISCLOSURE VERSION, invented for this harness only. Production's two
// constants are null, so nothing here can open a gate anywhere else.
const APPROVED = 'ol-disc-' + 'a'.repeat(32)
const ENVELOPE_ONLY = 'ol-disc-' + '0'.repeat(32)
const REQUIRED = { content: APPROVED, thirdParty: APPROVED }
const FIXTURE_KEY = 'sk-ant-fixture-not-a-real-key'

let passed = 0, failed = 0
async function test (name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

// ── plumbing ─────────────────────────────────────────────────────────────────
const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', ...opts })
const quiet = (args) => spawnSync('docker', args, { stdio: 'ignore' })
const sleepSync = (ms) => spawnSync('node', ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore' })

function psql (sql, { user = 'postgres', tuplesOnly = true } = {}) {
  const args = ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q']
  if (tuplesOnly) args.push('-At')
  args.push('-f', '-')
  return execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: 'pipe' })
}
const one = (sql) => psql(sql).trim()
const num = (sql) => Number(one(sql))

function waitForPg (timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline) {
    const r = spawnSync('docker',
      ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: 'CREATE TABLE public._probe(i int); DROP TABLE public._probe;', encoding: 'utf8' })
    if (r.status === 0) { streak += 1; if (streak >= 3) return } else { streak = 0 }
    sleepSync(1000)
  }
  throw new Error('Postgres never became stably DDL-ready')
}

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
  u1: () => mintJwt({ role: 'authenticated', sub: U1, aud: 'authenticated' }),
}

async function http (method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text.length ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed, raw: text }
}

function workerRpc (calls) {
  return async (name, args) => {
    calls.push(name)
    const r = await http('POST', `/rpc/${name}`, { token: TOK.worker(), body: args })
    if (r.status >= 400) return { data: null, error: { status: r.status, raw: r.raw.slice(0, 200) } }
    return { data: r.body, error: null }
  }
}

// ── a real AES-GCM sealer, so the DB stores real ciphertext ──────────────────
// The SAME one seals the cursors and the message handles, which is the production
// arrangement: one key per connection, held by the caller, never seen by the run.
const CURSOR_KEY = await webcrypto.subtle.importKey(
  'raw', randomBytes(32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])

async function encryptCursor (plaintext) {
  const iv = randomBytes(12)
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv },
    CURSOR_KEY, new TextEncoder().encode(plaintext))
  return {
    ciphertext: Buffer.from(ct).toString('base64'),
    nonce: Buffer.from(iv).toString('base64'),
    keyVersion: 1,
  }
}
async function decryptCursor (ciphertext, nonce) {
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(nonce, 'base64') },
    CURSOR_KEY, Buffer.from(ciphertext, 'base64'))
  return new TextDecoder().decode(plain)
}

// ── Microsoft fixtures ───────────────────────────────────────────────────────
const addr = (e, n) => ({ emailAddress: { address: e, name: n ?? e.split('@')[0] } })

function discoveryItem ({ id, conv, from, to, sent, subject }) {
  return {
    id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject, from: addr(from), sender: addr(from), toRecipients: to.map((t) => addr(t)),
    ccRecipients: [],
  }
}

// TWO conversations: one with a contact who exists, one with a stranger.
const KNOWN_IN = discoveryItem({
  id: 'AAkALgAAknown-in-1', conv: 'conv-known', from: KNOWN, to: [ME],
  sent: '2026-09-20T14:05:00Z', subject: 'Following up after the info session',
})
const KNOWN_OUT = discoveryItem({
  id: 'AAkALgAAknown-out-1', conv: 'conv-known', from: ME, to: [KNOWN],
  sent: '2026-09-21T09:12:00Z', subject: 'RE: Following up after the info session',
})
const NEW_IN = discoveryItem({
  id: 'AAkALgAAnew-in-1', conv: 'conv-new', from: STRANGER, to: [ME],
  sent: '2026-09-22T11:00:00Z', subject: 'Summer analyst referral',
})
const NEW_OUT = discoveryItem({
  id: 'AAkALgAAnew-out-1', conv: 'conv-new', from: ME, to: [STRANGER],
  sent: '2026-09-22T16:30:00Z', subject: 'RE: Summer analyst referral',
})

// The BODIES. Invented, and deliberately specific enough that a summary of them can be
// told apart from a summary of the subject line.
const BODIES = {
  'AAkALgAAknown-in-1':
    'Great to meet you at the info session. I have put your name forward for the '
    + 'spring insight week and the team would like a short call next week to talk '
    + 'through your interest in credit. Does Tuesday morning work?',
  'AAkALgAAknown-out-1':
    'Thank you - Tuesday morning is perfect. I will prepare a few questions about '
    + 'the credit desk and send over my availability for the insight week.',
  'AAkALgAAnew-in-1':
    'I spoke to our analyst programme lead and she is happy to review your '
    + 'application for the summer cohort. Could you send an updated CV by Friday, '
    + 'and let me know whether you prefer the markets or the coverage track?'
    // A signature block the sanitizer splits off (short, trailing, cue-bearing), which is
    // the input evidence for name_evidence = 'explicit_signature' above. No address.
    + ['', '', 'Best,', 'Priya Nair', 'Analyst Programme Team | Harbour Street Partners'].join(String.fromCharCode(10)),
  'AAkALgAAnew-out-1':
    'That is really kind of you. I will send the CV tomorrow - markets is the '
    + 'better fit given the modelling work I did last summer.',
}

const ENVELOPES = Object.fromEntries(
  [KNOWN_IN, KNOWN_OUT, NEW_IN, NEW_OUT].map((m) => [m.id, m]))

// THE DETAILED NOTES the fixture model returns. One prose paragraph each, no line breaks and
// no URL (the generated-note rules), carrying the topics, the advice, the offer, the named
// dates, the next steps and the open question of each exchange - 2026-10-10's workstream.
// Both are over 200 characters, so neither could have been stored before 20261010180000.
const KNOWN_CONTACT_NOTE = 'She put your name forward for the spring insight week and wants '
  + 'a short call on Tuesday morning about the credit desk. She said the team values '
  + 'candidates who can talk through a trade idea end to end rather than recite products, '
  + 'and advised reading the desk commentary before the call. She offered to introduce you '
  + 'to a second-year analyst on the same desk afterwards. You agreed to send your '
  + 'availability for the insight week and to prepare two questions about credit. Left open: '
  + 'whether the call is with her or with the desk head.'
const NEW_CONTACT_NOTE = 'She put your application in front of the analyst programme lead '
  + 'and asked for an updated CV by Friday, plus your track preference. She explained the '
  + 'summer cohort screens on a competency call before any technical stage, and advised '
  + 'preparing examples of working to a deadline. She offered to flag the application '
  + 'internally once the CV arrives, and mentioned the markets track suits the modelling '
  + 'work you described better than coverage. Left open: whether the insight week can run in '
  + 'parallel with the summer application.'

const okRes = (body) => ({ status: 200, headers: { get: () => null }, json: async () => body })
const finalPage = (folder, items) => ({
  value: items,
  '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=CURSOR-${folder}`,
})

/** The per-message content read, in exactly the shape CONTENT_SELECT asks for. */
function contentResponse (id) {
  const env = ENVELOPES[id]
  const text = BODIES[id]
  if (!env || !text) return { status: 404, headers: { get: () => null }, json: async () => ({}) }
  return okRes({
    id,
    conversationId: env.conversationId,
    receivedDateTime: env.receivedDateTime,
    sentDateTime: env.sentDateTime,
    subject: env.subject,
    from: env.from,
    sender: env.sender,
    toRecipients: env.toRecipients,
    ccRecipients: [],
    // Graph honours Prefer: outlook.body-content-type="text", so both are text.
    body: { contentType: 'text', content: text },
    uniqueBody: { contentType: 'text', content: text },
    // A real, non-automated exchange: the header collection is present and clean.
    internetMessageHeaders: [{ name: 'Received', value: 'by fixture' }],
  })
}

/**
 * A scripted Anthropic reply, in the shape parseDraftPayload actually reads: TEXT
 * blocks whose joined content is the JSON draft. An earlier version of this fixture
 * returned a `tool_use` block, which the parser ignores entirely - it answered
 * `empty_provider_response`, the run reported `model_unavailable`, and every content
 * assertion failed for a reason that had nothing to do with the code under test.
 */
function modelResponse (payload) {
  return okRes({
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  })
}

/**
 * ONE fake fetch answering all three surfaces, with a counter per surface so the
 * "zero body reads, zero model calls" claims are measured rather than asserted.
 */
function provider (counts, opts = {}) {
  return async (url, init) => {
    if (String(url) === ANTHROPIC_MESSAGES_URL) {
      counts.model += 1
      // The request body is captured so the minimization claim can be checked
      // against what would actually have been sent.
      counts.modelBodies.push(String(init?.body ?? ''))
      const payload = JSON.parse(String(init?.body ?? '{}'))
      const text = JSON.stringify(payload)
      // Which conversation is this? Decided from the BODY TEXT the request carries,
      // because that is all the request has - no id, no address.
      if (/analyst programme/i.test(text)) {
        return modelResponse(opts.newContactPayload ?? {
          result: 'new_contact_suggestion',
          // THE CURRENT STRICT CONTRACT (#73): the name triple, summary and its evidence,
          // follow_up and interaction_date - nothing else. The company/role/how_met/
          // linkedin_url triples and the tags array were removed from the model contract;
          // validateDraftResponse rejects any of them as `extra_keys`, which is exactly what
          // this fixture produced until it was brought up to date (reproduced before the
          // repair). The name's evidence is REAL: the inbound body below ends in a
          // signature block that states it.
          name: 'Priya Nair',
          name_evidence: 'explicit_signature',
          name_confidence: 'high',
          // DETAILED, and deliberately far past the old 200-character ceiling: this is the
          // shape the workstream exists to produce, and the harness checks it survives the
          // validator, the producer RPC, the column CHECK and acceptance byte for byte.
          summary: NEW_CONTACT_NOTE,
          summary_evidence: 'explicit_body',
          follow_up: 'Send the updated CV and confirm the markets track.',
          interaction_date: '2026-09-22',
        })
      }
      return modelResponse(opts.knownPayload ?? {
        result: 'interaction_draft',
        summary: KNOWN_CONTACT_NOTE,
        summary_evidence: 'explicit_body',
        follow_up: 'Send your insight-week availability and prepare credit questions.',
        interaction_date: '2026-09-21',
      })
    }
    const u = String(url)
    // A per-message content read: /me/messages/<id>?$select=...
    const m = u.match(/\/me\/messages\/([^?]+)\?/)
    if (m) {
      counts.bodies += 1
      const id = decodeURIComponent(m[1])
      counts.bodyIds.push(id)
      if (opts.failAllBodies === true || opts.failBody === id) {
        return { status: 404, headers: { get: () => null }, json: async () => ({ error: { code: 'ErrorItemNotFound' } }) }
      }
      return contentResponse(id)
    }
    // Otherwise a delta page.
    counts.delta += 1
    return okRes(u.includes('/mailFolders/inbox/')
      ? finalPage('inbox', [KNOWN_IN, NEW_IN])
      : finalPage('sentitems', [KNOWN_OUT, NEW_OUT]))
  }
}

const newCounts = () => ({ delta: 0, bodies: 0, model: 0, bodyIds: [], modelBodies: [] })

const KEY_RING = {
  current: { keyBytes: new Uint8Array(32).fill(11), keyVersion: 1 },
  subtle: webcrypto.subtle,
}

function contextLoader (contacts, consentVersion) {
  return async () => ({
    primaryEmail: ME,
    aliases: [],
    timeZone: 'America/New_York',
    userId: U1,
    contacts,
    cursors: { inbox: null, sentitems: null },
    accessToken: 'injected-fixture-token',
    keyRing: KEY_RING,
    consentVersion,
  })
}

function seed (consentVersion) {
  return `
DELETE FROM public.outlook_candidate_refs WHERE user_id='${U1}';
DELETE FROM public.new_contact_candidates WHERE user_id='${U1}';
DELETE FROM public.interaction_candidates WHERE user_id='${U1}';
DELETE FROM public.interactions WHERE user_id='${U1}';
DELETE FROM public.contacts WHERE user_id='${U1}';
DELETE FROM public.microsoft_connections WHERE user_id='${U1}';
INSERT INTO public.microsoft_connections
  (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
   status, consented_at, consent_policy_version)
VALUES ('${U1}', 'acct-1', 'consumers', 'personal', '${ME}',
        ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(),
        '${consentVersion}');
INSERT INTO public.contacts (user_id, name, email) VALUES ('${U1}', 'Ava Recruiter', '${KNOWN}');
`
}

/**
 * Make the connection due again, the way the passage of time would.
 *
 * reserve_due_outlook_connection refuses a connection that holds a live lease, that
 * has a future next_retry_at, or that succeeded within p_due_after_seconds. A reset
 * that misses any one of those answers `none_due`, which is what an earlier version of
 * this harness did - it reported a clean rerun while actually never running.
 */
function makeDue () {
  psql(`UPDATE public.outlook_sync_state
           SET sync_status = 'idle', sync_run_id = NULL, sync_lease_until = NULL,
               run_started_at = NULL, last_attempt_at = NULL, last_success_at = NULL,
               next_retry_at = NULL, last_run_complete = false, retry_count = 0
         WHERE connection_id = (SELECT id FROM public.microsoft_connections
                                 WHERE user_id = '${U1}');`, { tuplesOnly: false })
}

function ownContacts () {
  return psql(`SELECT id, user_id, email FROM public.contacts WHERE user_id='${U1}' ORDER BY id;`)
    .trim().split('\n').filter(Boolean).map((r) => {
      const [id, user_id, email] = r.split('|')
      return { id, user_id, email }
    })
}

/**
 * One full invocation, with the gates OPEN unless told otherwise.
 *
 * `requestEntryMs` and `now` are supplied only by the interruption scenario. Omitted,
 * the invocation deadline is infinite - which is the right default here, because this
 * harness is proving the CONTENT path, not re-proving the budget arithmetic the unit
 * suites already cover.
 */
function invoke ({
  counts, contacts, consentVersion = APPROVED, now, requestEntryMs, opts = {}, calls = [],
}) {
  return runOutlookImport({
    rpc: workerRpc(calls),
    pilotUserId: U1,
    encryptCursor,
    decryptCursor,
    loadRunContext: contextLoader(contacts, consentVersion),
    anthropicApiKey: FIXTURE_KEY,
    // The gates are injected ONLY here, exactly as the unit tests inject them. The
    // production constants stay null and this harness cannot change them.
    requiredConsent: REQUIRED,
    requiredBackgroundConsent: consentVersion,
    ...(requestEntryMs === undefined ? {} : { requestEntryMs }),
    deps: { fetchImpl: provider(counts, opts), ...(now ? { now } : {}) },
  })
}

function teardown () {
  quiet(['rm', '-f', REST]); quiet(['rm', '-f', PG]); quiet(['network', 'rm', NET])
}

async function main () {
  console.log('\nbuilding a disposable Postgres + PostgREST')
  teardown()
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', 'POSTGRES_PASSWORD=disposable', PG_IMAGE])
  waitForPg()
  psql(readFileSync(join(ROOT, 'tests/sql/_bootstrap-disposable-db.sql'), 'utf8'),
    { user: 'supabase_admin', tuplesOnly: false })
  const migrations = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  for (const m of migrations) {
    psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'), { tuplesOnly: false })
  }
  console.log(`  applied ${migrations.length} migrations, none skipped`)
  // A partial build is the failure this catches: an earlier harness silenced psql and
  // tested against 11 tables instead of the full schema.
  const tables = num(`SELECT count(*) FROM information_schema.tables
                       WHERE table_schema='public' AND table_type='BASE TABLE';`)
  assert.ok(tables >= 23, `only ${tables} tables were built - the schema is partial`)
  console.log(`  ${tables} public tables present`)

  psql("ALTER ROLE authenticator WITH PASSWORD 'disposable';", { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', '53997:3000',
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/'); if (r.status < 500) break } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  // This PostgREST image sets only the single-source claim; Production's auth.uid()
  // reads the JSON claims v14 actually sets. Declared, not hidden - the same note is
  // in tests/local/outlook-first-suggestion.mjs.
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
          select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $fn$;`,
  { user: 'supabase_admin', tuplesOnly: false })
  console.log('  PostgREST is serving\n')

  // ════════════════════════════════════════════════════════════════════════
  // 6 FIRST, because it must be proven on an untouched database: STALE CONSENT.
  // ════════════════════════════════════════════════════════════════════════
  console.log('STALE CONSENT: zero handles, zero body reads, zero model calls')
  psql(seed(ENVELOPE_ONLY), { tuplesOnly: false })
  {
    const counts = newCounts()
    const stale = await invoke({ counts, contacts: ownContacts(), consentVersion: ENVELOPE_ONLY })

    await test('the run still completes and still writes the metadata suggestion', () => {
      assert.strictEqual(stale.outcome, 'committed', JSON.stringify(summarizeRun(stale)))
      assert.strictEqual(stale.accepted, 1, 'the known contact still gets its suggestion')
    })

    await test('NOT ONE message body was read and NOT ONE model call was made', () => {
      assert.strictEqual(counts.bodies, 0, `read ${counts.bodies} bodies`)
      assert.strictEqual(counts.model, 0, `made ${counts.model} model calls`)
      assert.ok(counts.delta > 0, 'sanity: the envelope pass did run')
    })

    await test('NOT ONE retrieval handle was stored', () => {
      assert.strictEqual(num('SELECT count(*) FROM public.outlook_round_messages;'), 0)
      assert.strictEqual(stale.handlesStored, 0)
      assert.strictEqual(stale.handleReason, 'content_consent_missing')
    })

    await test('the absence of a note is REPORTED, not silent', () => {
      assert.strictEqual(stale.content.deferred.content_consent_missing, 1,
        JSON.stringify(stale.content))
      assert.strictEqual(stale.content.attempted, 0)
      assert.strictEqual(stale.content.notes_written, 0)
      assert.strictEqual(stale.content.metadata_only, 1)
    })

    await test('the stored note is NULL - never a placeholder', () => {
      assert.strictEqual(one(`SELECT coalesce(proposed_notes,'NULL')
        FROM public.interaction_candidates WHERE user_id='${U1}';`), 'NULL')
    })

    await test('and NO new-contact proposal was made, because no body was read', () => {
      assert.strictEqual(num(`SELECT count(*) FROM public.new_contact_candidates
                               WHERE user_id='${U1}';`), 0)
    })
  }

  // ════════════════════════════════════════════════════════════════════════
  // THE HANDLE'S LIFETIME, proven on a round that is still open. A COMPLETED
  // round deletes its accumulator on release, which cascades to the handles, so
  // this has to be observed before that happens - which is why it is its own
  // section rather than part of the flow below.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\nthe stored retrieval key is CIPHERTEXT, and does not outlive the round')
  psql(seed(APPROVED), { tuplesOnly: false })
  {
    const c = newCounts()
    // Every body read fails, which is RETRYABLE - so nothing is written, no cursor
    // moves, and the round stays open with its handles committed.
    const held = await invoke({
      counts: c, contacts: ownContacts(), opts: { failAllBodies: true },
    })

    await test('an unfinished round keeps its four handles', () => {
      assert.strictEqual(held.handlesStored, 4, JSON.stringify(summarizeRun(held)))
      assert.strictEqual(num('SELECT count(*) FROM public.outlook_round_messages;'), 4)
      assert.strictEqual(held.cursorsAdvanced, 0, 'and commits nothing')
      assert.strictEqual(num(`SELECT count(*) FROM public.interaction_candidates
                               WHERE user_id='${U1}';`), 0,
      'a retryable fetch failure writes no suggestion at all')
    })

    await test('the message id is NOWHERE in the row, in any column', () => {
      const all = psql('SELECT * FROM public.outlook_round_messages;')
      for (const id of Object.keys(BODIES)) {
        assert.ok(!all.includes(id), `the plaintext id ${id.slice(0, 12)}... is stored`)
      }
      for (const leak of [ME, KNOWN, STRANGER, 'info session', 'analyst']) {
        assert.ok(!all.includes(leak), `the handle row leaked ${leak}`)
      }
    })

    await test('and it is REAL ciphertext: all four decrypt to ids the fixture served', async () => {
      const rows = psql(`SELECT message_id_ciphertext, message_id_nonce
        FROM public.outlook_round_messages ORDER BY sent_at;`)
        .trim().split(String.fromCharCode(10))
      const decrypted = []
      for (const r of rows) {
        const [ct, nonce] = r.split('|')
        decrypted.push(await decryptCursor(ct, nonce))
      }
      assert.deepStrictEqual(decrypted.slice().sort(), Object.keys(BODIES).slice().sort())
    })

    await test('a RETRYABLE failure is reported as retryable, not as a missing note', () => {
      assert.strictEqual(held.content.deferred.fetch_failed, 1, JSON.stringify(held.content))
      assert.strictEqual(held.content.notes_written, 0)
      assert.strictEqual(held.content.metadata_only, 0,
        'nothing may fall back to a bare row while the failure is still retryable')
    })
  }

  // ════════════════════════════════════════════════════════════════════════
  // 1 + 2: THE WORKING FLOW, with both gates open.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\na MEANINGFUL summary for a known contact, and a PROPOSAL for a stranger')
  psql(seed(APPROVED), { tuplesOnly: false })
  const contacts = ownContacts()
  const avaId = contacts[0].id
  const counts = newCounts()
  const calls = []
  const run = await invoke({ counts, contacts, calls })

  await test('the run commits, having summarized both conversations', () => {
    assert.strictEqual(run.outcome, 'committed', JSON.stringify(summarizeRun(run)))
    assert.strictEqual(run.content.attempted, 2, JSON.stringify(run.content))
    assert.strictEqual(run.content.notes_written, 1, 'one known contact')
    assert.strictEqual(run.content.proposals_written, 1, 'one stranger')
    assert.strictEqual(run.content.metadata_only, 0, 'and nothing fell back to a bare row')
    assert.deepStrictEqual(Object.keys(run.content.deferred), [],
      `with no deferral at all: ${JSON.stringify(run.content.deferred)}`)
  })

  await test('four handles were stored, two per conversation', () => {
    // Counted from the RUN'S report, because by now they are gone: the handles are
    // round scratch state, and releasing the lease on a completed round deletes
    // outlook_conversation_progress, which cascades to them. Asserting the table is
    // empty afterwards is the more useful claim of the two, so both are made.
    assert.strictEqual(run.handlesStored, 4, JSON.stringify(summarizeRun(run)))
    assert.strictEqual(run.handleReason, null)
  })

  await test('and the handles DO NOT OUTLIVE the round', () => {
    assert.strictEqual(num('SELECT count(*) FROM public.outlook_round_messages;'), 0,
      'a completed round must leave no retrieval key behind')
    assert.strictEqual(num('SELECT count(*) FROM public.outlook_conversation_progress;'), 0,
      'and no accumulator row either')
  })

  await test('ALL FOUR bodies were read, and exactly TWO model calls were made', () => {
    assert.strictEqual(counts.bodies, 4, counts.bodyIds.join(','))
    assert.strictEqual(counts.model, 2, 'one per conversation, never one per message')
  })

  await test('THE KNOWN CONTACT HAS A REAL NOTE, about what was discussed', () => {
    const row = psql(`SELECT contact_id, proposed_type, proposed_interaction_date,
        coalesce(proposed_notes,'NULL')
      FROM public.interaction_candidates WHERE user_id='${U1}' AND source='outlook';`)
      .trim().split('|')
    assert.strictEqual(row[0], avaId)
    assert.strictEqual(row[1], 'Email')
    const note = row[3]
    assert.notStrictEqual(note, 'NULL', 'this is the whole point of the slice')
    // It is a summary of the BODY, not of the subject line.
    assert.ok(/insight week/i.test(note), note)
    assert.ok(/credit/i.test(note), note)
    // DETAILED, AND STORED WHOLE. The producer RPC and the column CHECK accept the model's
    // full note; nothing trims it on the way in. Under the old 200-character ceiling this
    // same note was refused outright (`invalid_notes`), which is why the ceiling moved.
    assert.strictEqual(note, KNOWN_CONTACT_NOTE, 'the stored draft must be the model note, byte for byte')
    assert.ok(note.length > 200, `a detailed note is the point: ${note.length} characters`)
    const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']')
    assert.ok(note.length <= 2000 && !CTRL.test(note), 'and it obeys the generated-note rules')
    // The substance is there: advice, an offer, an agreed next step, an open question.
    for (const fact of [/values candidates/i, /offered to introduce/i, /agreed to send/i, /Left open/i]) {
      assert.ok(fact.test(note), `${fact} must survive into the stored draft`)
    }
    assert.ok(!/Following up after the info session/.test(note),
      'the subject must not be passed off as a summary')
    assert.ok(note.length > 60, `a real sentence, not a label: ${note}`)
  })

  await test('THE STRANGER IS PROPOSED AS A CONTACT, carrying the interaction draft', async () => {
    const r = await http('GET',
      `/new_contact_candidates?select=${encodeURIComponent(NCC_SELECT)}&status=eq.pending`,
      { token: TOK.u1() })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 200))
    assert.strictEqual(r.body.length, 1, JSON.stringify(r.body))
    const p = r.body[0]
    // THE ADDRESS IS THE ENVELOPE'S, lowercased by the write path.
    assert.strictEqual(p.proposed_email, STRANGER)
    assert.strictEqual(p.proposed_name, 'Priya Nair')
    assert.strictEqual(p.proposed_name_evidence, 'explicit_signature')
    // And the interaction travels WITH it.
    assert.ok(/analyst programme/i.test(p.draft_summary), p.draft_summary)
    assert.ok(/CV/.test(p.draft_summary))
    assert.strictEqual(p.draft_summary, NEW_CONTACT_NOTE, 'the proposal carries the model note, byte for byte')
    assert.ok(p.draft_summary.length > 200, `${p.draft_summary.length} characters`)
    assert.strictEqual(p.draft_follow_up, 'Send the updated CV and confirm the markets track.')
    assert.strictEqual(p.proposed_interaction_date, '2026-09-22')
    assert.strictEqual(p.proposed_type, 'Email')
    // THE HONEST PROVENANCE. This used to read 'deterministic' because the write RPC
    // hard-coded it - true while nothing could draft a summary, and a false claim the
    // moment one could.
    assert.strictEqual(p.extraction_status, 'ai_extracted')
  })

  await test('UNSUPPORTED contact fields were stored BLANK, not guessed', () => {
    const row = psql(`SELECT coalesce(proposed_company,'NULL'), coalesce(proposed_role,'NULL'),
        coalesce(proposed_how_met,'NULL'), coalesce(proposed_linkedin_url,'NULL')
      FROM public.new_contact_candidates WHERE user_id='${U1}';`).trim().split('|')
    assert.deepStrictEqual(row, ['NULL', 'NULL', 'NULL', 'NULL'])
  })

  await test('THE REQUEST CARRIED THE BODY BUT NO ADDRESS AND NO MESSAGE ID', () => {
    assert.strictEqual(counts.modelBodies.length, 2)
    for (const b of counts.modelBodies) {
      assert.ok(/insight week|analyst programme/i.test(b), 'the body must be sent')
      for (const leak of [ME, KNOWN, STRANGER, 'getfunnl.test', 'bank.test', 'fund.test',
        'AAkALgAA', U1, avaId]) {
        assert.ok(!b.includes(leak), `the request leaked ${leak}`)
      }
    }
  })

  await test('THE NAME EVIDENCE IS IN THE INPUT: the stranger request carried her signature block, naming her', () => {
    // name_evidence = 'explicit_signature' is only honest if the model was shown a signature
    // that states the name. The sanitizer split the trailing block off the inbound body and
    // the request builder sent it under the CONTACT signature marker.
    const stranger = counts.modelBodies.find((b) => /analyst programme/i.test(b))
    assert.ok(stranger, 'the stranger conversation reached the model')
    assert.ok(stranger.includes('[CONTACT signature block]'), 'the signature block was sent as such')
    assert.ok(stranger.includes('Priya Nair'), 'and it states the proposed name')
    const known = counts.modelBodies.find((b) => /insight week/i.test(b))
    assert.ok(known && !known.includes('Priya Nair'), 'the other conversation did not carry it')
  })

  // ════════════════════════════════════════════════════════════════════════
  // 4: NOTHING IS IN THE NETWORK YET.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\nZERO contacts and interactions before acceptance')

  await test('after a full summarizing run, the network has ONE contact and NO interaction', () => {
    // The one contact is the seeded Ava. The run created nothing.
    assert.strictEqual(num(`SELECT count(*) FROM public.contacts WHERE user_id='${U1}';`), 1)
    assert.strictEqual(num(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), 0)
    assert.strictEqual(num(`SELECT count(*) FROM public.contacts
                             WHERE user_id='${U1}' AND email='${STRANGER}';`), 0)
  })

  await test('READING the queue as the user creates nothing', async () => {
    const before = [
      num(`SELECT count(*) FROM public.contacts WHERE user_id='${U1}';`),
      num(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`),
    ]
    const r = await http('GET',
      `/new_contact_candidates?select=${encodeURIComponent(NCC_SELECT)}&status=eq.pending`,
      { token: TOK.u1() })
    assert.strictEqual(r.status, 200)
    const r2 = await http('GET',
      '/interaction_candidates?select=id,source,proposed_type&status=eq.pending',
      { token: TOK.u1() })
    assert.strictEqual(r2.status, 200)
    assert.deepStrictEqual([
      num(`SELECT count(*) FROM public.contacts WHERE user_id='${U1}';`),
      num(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`),
    ], before, 'opening the queue must create nothing')
  })

  await test('the user cannot write either candidate table directly', async () => {
    const r = await http('PATCH', '/new_contact_candidates?status=eq.pending',
      { token: TOK.u1(), body: { proposed_name: 'Tampered' } })
    assert.ok(r.status >= 400, `a direct UPDATE answered ${r.status}`)
    const d = await http('DELETE', '/new_contact_candidates?status=eq.pending', { token: TOK.u1() })
    assert.ok(d.status >= 400, `a direct DELETE answered ${d.status}`)
  })

  // ════════════════════════════════════════════════════════════════════════
  // 3: EDITS PRESERVED ON ACCEPTANCE.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\nEDITS are what get saved, and both records appear together')

  let candidateId = null
  await test('the user edits the proposal and accepts it ONCE', async () => {
    const r = await http('GET',
      `/new_contact_candidates?select=${encodeURIComponent(NCC_SELECT)}&status=eq.pending`,
      { token: TOK.u1() })
    const row = r.body[0]
    candidateId = row.id

    // THE REVIEW, through the page's own argument builder rather than a retyped body.
    const edited = {
      ...initialReviewState(row),
      name: 'Priya Nair-Shah',                 // corrected
      company: 'Northfield Capital',           // added by the user; nothing stored it
      role: 'Associate',
      howMet: 'Introduced at the markets panel',
      relationshipType: 'Referral path',
      tags: 'referral, markets',
      interactionType: 'Coffee chat',          // changed from Email
      interactionDate: '2026-09-23',           // changed
      interactionNotes: 'She will put my CV in front of the programme lead; markets track.',
      followUpDate: '2026-09-29',
    }
    const acc = await http('POST', '/rpc/accept_new_contact_candidate',
      { token: TOK.u1(), body: acceptArgs(candidateId, edited) })
    assert.strictEqual(acc.status, 200, acc.raw.slice(0, 300))
    assert.strictEqual(acc.body.result, 'accepted', JSON.stringify(acc.body))
    assert.ok(acc.body.contact_id)
    assert.ok(acc.body.interaction_id, 'the interaction must be created with it')
  })

  await test('BOTH records now exist, and carry the USER’S values', () => {
    const c = psql(`SELECT name, coalesce(company,'NULL'), coalesce(role,'NULL'),
        coalesce(how_met,'NULL'), email, coalesce(relationship_type,'NULL'),
        coalesce(array_to_string(tags, '|'),'NULL')
      FROM public.contacts WHERE user_id='${U1}' AND email='${STRANGER}';`).trim().split('|')
    assert.strictEqual(c[0], 'Priya Nair-Shah', 'the corrected name, not the proposal')
    assert.strictEqual(c[1], 'Northfield Capital')
    assert.strictEqual(c[2], 'Associate')
    assert.strictEqual(c[3], 'Introduced at the markets panel')
    // THE ADDRESS IS STILL THE ENVELOPE'S: the RPC ignores any caller value.
    assert.strictEqual(c[4], STRANGER)
    assert.strictEqual(c[5], 'Referral path')

    const i = psql(`SELECT i.type, i.interaction_date, i.notes,
        coalesce(i.follow_up_date::text,'NULL'), i.source
      FROM public.interactions i JOIN public.contacts ct ON ct.id = i.contact_id
      WHERE i.user_id='${U1}' AND ct.email='${STRANGER}';`).trim().split('|')
    assert.strictEqual(i[0], 'Coffee chat', 'the user’s type, not the proposal’s Email')
    assert.strictEqual(i[1], '2026-09-23')
    assert.ok(i[2].includes('programme lead'), i[2])
    assert.ok(!i[2].includes('analyst programme lead and asked'),
      'the model’s wording was replaced by the user’s')
    assert.strictEqual(i[3], '2026-09-29')
    assert.strictEqual(i[4], 'outlook')
  })

  await test('the candidate is marked accepted and its draft is ERASED', () => {
    const row = psql(`SELECT status, coalesce(proposed_email,'NULL'),
        coalesce(proposed_name,'NULL'), coalesce(draft_summary,'NULL'),
        coalesce(retained_subject,'NULL'), coalesce(context_expires_at::text,'NULL')
      FROM public.new_contact_candidates WHERE id='${candidateId}';`).trim().split('|')
    assert.strictEqual(row[0], 'accepted')
    assert.deepStrictEqual(row.slice(1), ['NULL', 'NULL', 'NULL', 'NULL', 'NULL'],
      'every provider-derived field must be erased on acceptance')
  })

  await test('accepting the SAME proposal again creates no second contact', async () => {
    const again = await http('POST', '/rpc/accept_new_contact_candidate',
      { token: TOK.u1(), body: acceptArgs(candidateId, { name: 'Someone Else' }) })
    assert.strictEqual(again.body.result, 'already_accepted', JSON.stringify(again.body))
    assert.strictEqual(num(`SELECT count(*) FROM public.contacts
                             WHERE user_id='${U1}' AND email='${STRANGER}';`), 1)
    assert.strictEqual(num(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), 1)
  })

  await test('DISMISSING the known-contact suggestion creates no interaction', async () => {
    const before = num(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`)
    const id = one(`SELECT id FROM public.interaction_candidates
                     WHERE user_id='${U1}' AND status='pending';`)
    const d = await http('POST', '/rpc/dismiss_interaction_candidate',
      { token: TOK.u1(), body: { p_candidate_id: id } })
    assert.strictEqual(d.status, 200, d.raw.slice(0, 200))
    assert.strictEqual(num(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`),
      before, 'a dismissal must create nothing')
    assert.strictEqual(one(`SELECT status FROM public.interaction_candidates WHERE id='${id}';`),
      'dismissed')
  })

  // ════════════════════════════════════════════════════════════════════════
  // 5: DUPLICATE PREVENTION.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\nDUPLICATE PREVENTION across a rerun')

  await test('a second identical run creates no second suggestion and no second contact', async () => {
    const c2 = newCounts()
    makeDue()
    // The contact list now INCLUDES the accepted stranger, which is what a real
    // second run would load - so that conversation is now a KNOWN contact.
    const run2 = await invoke({ counts: c2, contacts: ownContacts() })
    assert.notStrictEqual(run2.outcome, 'none_due',
      'the rerun must actually run, or this proves nothing')
    assert.ok(['committed', 'incomplete'].includes(run2.outcome),
      JSON.stringify(summarizeRun(run2)))
    assert.strictEqual(num(`SELECT count(*) FROM public.contacts
                             WHERE user_id='${U1}' AND email='${STRANGER}';`), 1,
    'no second contact')
    assert.strictEqual(num(`SELECT count(*) FROM public.new_contact_candidates
                             WHERE user_id='${U1}';`), 1, 'no second proposal row')
    // The previously-dismissed suggestion is not resurrected.
    assert.strictEqual(num(`SELECT count(*) FROM public.interaction_candidates
                             WHERE user_id='${U1}' AND status='pending'
                               AND contact_id='${avaId}';`), 0,
    'a dismissed suggestion must not come back')
  })

  await test('a rerun stores no duplicate handle for a message it already has', () => {
    const dupes = num(`SELECT count(*) FROM (
        SELECT message_fingerprint, count(*) AS n FROM public.outlook_round_messages
         GROUP BY message_fingerprint HAVING count(*) > 1) d;`)
    assert.strictEqual(dupes, 0, 'the message fingerprint is the dedupe key')
  })

  // ════════════════════════════════════════════════════════════════════════
  // 7: AN INTERRUPTED CONTENT STAGE RESUMES WITH NOTHING SKIPPED.
  // ════════════════════════════════════════════════════════════════════════
  console.log('\nan INTERRUPTED content stage resumes without skipping work')
  psql(seed(APPROVED), { tuplesOnly: false })
  {
    const fresh = ownContacts()
    const c3 = newCounts()
    // A clock that jumps as soon as ONE conversation has been summarized, staged on an
    // OBSERVABLE event rather than a tick count: 50s of the 120s budget is spent the
    // moment the fixture answers the first model call. The first conversation's write
    // still fits (70s left, 60s reserved), and the second cannot be admitted (80s
    // needed). So the batch stops exactly between two conversations - which is the
    // case that must not leave a noteless suggestion behind.
    const startMs = Date.now()
    const jumpingClock = () => startMs + (c3.model >= 1 ? 50_000 : 0)

    const first = await invoke({
      counts: c3, contacts: fresh, now: jumpingClock, requestEntryMs: startMs,
    })

    await test('the interrupted invocation stops mid-batch, WITHOUT a noteless suggestion', () => {
      assert.ok(['continued', 'budget_exhausted'].includes(first.outcome),
        JSON.stringify(summarizeRun(first)))
      assert.strictEqual(first.finalize.complete, false, 'the batch is unfinished')
      assert.strictEqual(c3.model, 1, 'exactly one conversation was summarized')
      assert.strictEqual(first.content.deferred.budget_exhausted, 1,
        JSON.stringify(first.content))
      assert.strictEqual(first.cursorsAdvanced, 0, 'and no cursor moved')
      // Whatever it wrote, it wrote NO bare metadata row for a conversation whose
      // content it had not finished.
      const noteless = num(`SELECT count(*) FROM public.interaction_candidates
        WHERE user_id='${U1}' AND status='pending' AND proposed_notes IS NULL;`)
      assert.strictEqual(noteless, 0,
        'a conversation the budget cut short must not land as an empty note')
    })

    await test('the next invocation finishes the round with EVERY conversation summarized', async () => {
      const c4 = newCounts()
      let r = first
      // Carry on until the round completes, exactly as a scheduler would. Bounded so
      // a non-terminating loop fails the test rather than hanging it.
      for (let i = 0; i < 6 && r.outcome !== 'committed'; i++) {
        makeDue()
        r = await invoke({ counts: c4, contacts: ownContacts() })
      }
      assert.strictEqual(r.outcome, 'committed', JSON.stringify(summarizeRun(r)))
      assert.ok(c4.model >= 1, 'the resumed invocation summarized the remaining work')

      // NOTHING WAS SKIPPED: both conversations ended up with content.
      const withNote = num(`SELECT count(*) FROM public.interaction_candidates
        WHERE user_id='${U1}' AND proposed_notes IS NOT NULL;`)
      const proposals = num(`SELECT count(*) FROM public.new_contact_candidates
        WHERE user_id='${U1}' AND draft_summary IS NOT NULL;`)
      assert.strictEqual(withNote + proposals, 2,
        `only ${withNote} notes and ${proposals} proposals - a conversation was skipped`)
    })
  }

  console.log('')
  console.log(`${passed + failed} checks: ${passed} passed, ${failed} failed`)
  console.log('')
  if (failed > 0) process.exitCode = 1
}

try {
  await main()
} catch (e) {
  console.error('\nHARNESS FAILED: ' + (e?.message ?? 'unknown'))
  process.exitCode = 1
} finally {
  teardown()
}
