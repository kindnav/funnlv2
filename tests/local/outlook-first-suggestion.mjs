#!/usr/bin/env node
// ONE REVIEWABLE OUTLOOK SUGGESTION, end to end, locally.
//
// This is the manual trigger for the milestone. It drives the SAME run module the
// worker endpoint would call (shared/outlookImportRun.js) against:
//   * CONTROLLED MICROSOFT FIXTURES - a fake fetch serving scripted Graph delta pages.
//     No request ever leaves this machine and no mailbox is involved.
//   * A REAL Postgres - the project's own Supabase image, with every migration applied
//     including the unapplied forward ones, and the real anon / authenticated /
//     service_role roles.
//   * REAL PostgREST - the worker acts as service_role over HTTP; the reviewing user
//     acts with their own JWT, exactly as the browser would.
//
// WHAT IT PROVES (each is an assertion below, not a claim):
//   1. one qualifying two-sided exchange with an EXISTING contact creates exactly one
//      PENDING Outlook interaction suggestion, and advances the encrypted cursors;
//   2. a rerun does not duplicate it;
//   3. another user's contact is never matched, even with the identical address;
//   4. an incomplete pass writes no candidate and advances no cursor;
//   5. no interaction exists until the user explicitly accepts, and the note saved is
//      the note the USER typed - the worker fabricates none;
//   6. a dismissal creates no interaction and is never resurrected by a later run.
//
// WHAT IT DOES NOT COVER, stated rather than implied:
//   * The browser and supabase-js. The review reads/writes go straight to PostgREST
//     with a minted JWT, so Kong's apikey check and the React components are not
//     exercised here. The page's own query shape IS exercised: the select string is
//     imported from src/lib/calendarReview.js rather than retyped.
//   * GoTrue. JWTs are minted locally with a throwaway secret; no sign-in happens.
//   * Token acquisition. The access token is injected. A deployed worker has no way to
//     obtain one, which is why the endpoint answers 501.
//
// REQUIREMENTS: Docker, plus the two images the project already uses.
// RUN: node tests/local/outlook-first-suggestion.mjs   (builds and tears down)

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, createHmac, webcrypto } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'
import { runOutlookImport, summarizeRun } from '../../supabase/functions/shared/outlookImportRun.js'
import { CANDIDATE_SELECT } from '../../src/lib/calendarReview.js'
import { GRAPH_BASE } from '../../supabase/functions/shared/outlookGraphTransport.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-suggest-pg'
const REST = 'funnl-suggest-rest'
const NET = 'funnl-suggest-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const BASE = 'http://127.0.0.1:53998'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const ME = 'student@getfunnl.test'
const RECRUITER = 'ava@bank.test'
const JWT_SECRET = randomBytes(32).toString('hex')   // per run; never printed

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
  u2: () => mintJwt({ role: 'authenticated', sub: U2, aud: 'authenticated' }),
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

/** The worker's RPC port: PostgREST, as service_role. */
function workerRpc (calls) {
  return async (name, args) => {
    calls.push(name)
    const r = await http('POST', `/rpc/${name}`, { token: TOK.worker(), body: args })
    if (r.status >= 400) return { data: null, error: { status: r.status, raw: r.raw.slice(0, 200) } }
    return { data: r.body, error: null }
  }
}

// ── a real cursor encryptor, so the DB stores ciphertext ──────────────────────
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

// ── Microsoft fixtures ───────────────────────────────────────────────────────

const addr = (e) => ({ emailAddress: { address: e, name: e.split('@')[0] } })
function gmsg ({ id, conv, from, to, sent }) {
  return {
    id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 'Following up after the info session',
    from: addr(from), sender: addr(from), toRecipients: to.map(addr), ccRecipients: [],
  }
}
const INBOUND = gmsg({ id: 'ms-in-1', conv: 'conv-1', from: RECRUITER, to: [ME], sent: '2026-09-20T14:05:00Z' })
const OUTBOUND = gmsg({ id: 'ms-out-1', conv: 'conv-1', from: ME, to: [RECRUITER], sent: '2026-09-21T09:12:00Z' })

const okRes = (body) => ({ status: 200, headers: { get: () => null }, json: async () => body })
const finalPage = (folder, items) => ({
  value: items,
  '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=CURSOR-${folder}`,
})

/** The happy fixture: one two-sided exchange, both folders finishing cleanly. */
function completeProvider (requests) {
  return async (url) => {
    requests.push(url)
    return okRes(url.includes('/mailFolders/inbox/')
      ? finalPage('inbox', [INBOUND])
      : finalPage('sentitems', [OUTBOUND]))
  }
}
/** Inbox finishes; Sent Items never does. */
function incompleteProvider (requests) {
  return async (url) => {
    requests.push(url)
    if (url.includes('/mailFolders/inbox/')) return okRes(finalPage('inbox', [INBOUND]))
    return okRes({
      value: [OUTBOUND],
      '@odata.nextLink': `${GRAPH_BASE}/me/mailFolders/sentitems/messages/delta?$skiptoken=sent-next`,
    })
  }
}

const KEY_RING = {
  current: { keyBytes: new Uint8Array(32).fill(11), keyVersion: 1 },
  subtle: webcrypto.subtle,
}

/** Everything one connection's run needs. Supplied, never queried by the run module. */
function contextLoader (contacts) {
  return async () => ({
    primaryEmail: ME,
    aliases: [],
    timeZone: 'America/New_York',
    userId: U1,
    contacts,
    cursors: { inbox: null, sentitems: null },
    accessToken: 'injected-fixture-token',
    keyRing: KEY_RING,
  })
}

const SEED = `
DELETE FROM public.interaction_candidates WHERE user_id IN ('${U1}','${U2}');
DELETE FROM public.interactions WHERE user_id IN ('${U1}','${U2}');
DELETE FROM public.contacts WHERE user_id IN ('${U1}','${U2}');
DELETE FROM public.microsoft_connections WHERE user_id IN ('${U1}','${U2}');
INSERT INTO public.microsoft_connections
  (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
   status, consented_at, consent_policy_version)
VALUES ('${U1}', 'acct-1', 'consumers', 'personal', '${ME}',
        ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(),
        'ol-disc-00000000000000000000000000000000');
-- BOTH users track the SAME address. Only u1's contact may ever be matched.
INSERT INTO public.contacts (user_id, name, email) VALUES ('${U1}', 'Ava Recruiter', '${RECRUITER}');
INSERT INTO public.contacts (user_id, name, email) VALUES ('${U2}', 'Ava (someone else)', '${RECRUITER}');
`

function ownContacts () {
  const rows = psql(`SELECT id, user_id, email FROM public.contacts
                      WHERE user_id IN ('${U1}','${U2}') ORDER BY user_id;`).trim().split('\n')
  return rows.filter(Boolean).map((r) => {
    const [id, user_id, email] = r.split('|')
    return { id, user_id, email }
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

  psql("ALTER ROLE authenticator WITH PASSWORD 'disposable';", { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', '53998:3000',
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/'); if (r.status < 500) break } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  // Production's auth.uid() reads the JSON claims PostgREST v14 actually sets; this
  // image ships an older single-source version. Declared, not hidden: see
  // tests/local/outlook-rpc-postgrest.mjs for the same note.
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
          select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $fn$;`,
  { user: 'supabase_admin', tuplesOnly: false })
  console.log('  PostgREST is serving\n')

  // ══ 1. one exchange -> one pending suggestion ═════════════════════════════
  console.log('the worker turns one exchange into one pending suggestion')
  psql(SEED, { tuplesOnly: false })
  const contacts = ownContacts()
  const u1Contact = contacts.find((c) => c.user_id === U1)
  const u2Contact = contacts.find((c) => c.user_id === U2)

  const calls = []
  const requests = []
  let run = await runOutlookImport({
    rpc: workerRpc(calls),
    encryptCursor,
    loadRunContext: contextLoader(contacts),
    deps: { fetchImpl: completeProvider(requests) },
  })

  await test('the run commits, writing exactly one suggestion', () => {
    assert.strictEqual(run.outcome, 'committed', JSON.stringify(summarizeRun(run)))
    assert.strictEqual(run.written, 1)
    assert.strictEqual(run.writeResults.created, 1)
    assert.strictEqual(one(
      `SELECT count(*) FROM public.interaction_candidates WHERE user_id='${U1}' AND source='outlook';`), '1')
  })

  await test('the suggestion is PENDING, typed Email, dated in the user zone, and carries NO invented text', () => {
    const row = psql(`SELECT status, proposed_type, proposed_interaction_date,
        coalesce(proposed_notes,'NULL'), coalesce(retained_subject,'NULL'),
        coalesce(draft_summary,'NULL'), coalesce(draft_follow_up,'NULL'),
        coalesce(summary_evidence,'NULL'), contact_id
      FROM public.interaction_candidates WHERE user_id='${U1}' AND source='outlook';`).trim().split('|')
    assert.strictEqual(row[0], 'pending')
    assert.strictEqual(row[1], 'Email')
    // Last message 2026-09-21T09:12Z is the 21st in New York.
    assert.strictEqual(row[2], '2026-09-21')
    assert.deepStrictEqual(row.slice(3, 8), ['NULL', 'NULL', 'NULL', 'NULL', 'NULL'],
      'a metadata pass must invent no note, subject, summary or next step')
    assert.strictEqual(row[8], u1Contact.id)
  })

  await test('provenance is recorded as fingerprints only, with no message identifier', () => {
    const row = psql(`SELECT episode_fingerprint, coalesce(person_fingerprint,'NULL'), key_version
      FROM public.outlook_candidate_refs WHERE user_id='${U1}';`).trim().split('|')
    assert.match(row[0], /^[0-9a-f]{64}$/)
    assert.match(row[1], /^[0-9a-f]{64}$/)
    assert.strictEqual(row[2], '1')
    const cols = psql(`SELECT string_agg(column_name, ',') FROM information_schema.columns
      WHERE table_name='outlook_candidate_refs';`).trim()
    for (const forbidden of ['message_id', 'conversation_id', 'subject', 'address', 'email']) {
      assert.ok(!cols.includes(forbidden), `refs table exposes ${forbidden}`)
    }
  })

  await test('both encrypted cursors advanced, and the stored value is NOT the plaintext link', () => {
    assert.strictEqual(run.cursorsAdvanced, 2)
    const rows = psql(`SELECT folder, coalesce(delta_link_ciphertext,'NULL'),
        coalesce(delta_link_nonce,'NULL'), coalesce(delta_key_version::text,'NULL'), last_run_complete
      FROM public.outlook_sync_state WHERE user_id='${U1}' ORDER BY folder;`).trim().split('\n')
    assert.strictEqual(rows.length, 2)
    for (const r of rows) {
      const [folder, ct, nonce, kv, complete] = r.split('|')
      assert.ok(ct !== 'NULL' && ct.length > 0, `${folder} cursor not stored`)
      assert.ok(nonce !== 'NULL', `${folder} nonce not stored`)
      assert.strictEqual(kv, '1', folder)
      assert.strictEqual(complete, 't', folder)
      assert.ok(!ct.includes('deltatoken') && !ct.includes('CURSOR-'),
        `${folder} cursor was stored in plaintext`)
      assert.ok(!ct.includes('graph.microsoft.com'), `${folder} cursor leaked the provider URL`)
    }
  })

  await test('the worker called only the three RPCs it is allowed to call', () => {
    const allowed = new Set(['reserve_due_outlook_connection',
      'upsert_outlook_interaction_candidate', 'release_outlook_sync_lease'])
    for (const c of calls) assert.ok(allowed.has(c), `unexpected RPC: ${c}`)
    assert.ok(calls.includes('reserve_due_outlook_connection'))
    assert.ok(calls.indexOf('upsert_outlook_interaction_candidate') <
      calls.lastIndexOf('release_outlook_sync_lease'),
    'the suggestion must be written BEFORE the cursor-advancing release')
  })

  await test('no interaction exists yet, and the contact is untouched', () => {
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), '0',
      'the worker must never create an interaction')
    assert.strictEqual(one(`SELECT count(*) FROM public.contacts WHERE user_id='${U1}';`), '1')
    assert.strictEqual(one(`SELECT name FROM public.contacts WHERE id='${u1Contact.id}';`), 'Ava Recruiter')
  })

  await test('another user\'s contact with the SAME address was not matched', () => {
    assert.strictEqual(one(
      `SELECT count(*) FROM public.interaction_candidates WHERE user_id='${U2}';`), '0')
    assert.strictEqual(one(
      `SELECT count(*) FROM public.interaction_candidates WHERE contact_id='${u2Contact.id}';`), '0')
  })

  await test('the run summary carries no identifier, fingerprint, address or cursor', () => {
    const s = JSON.stringify(summarizeRun(run))
    for (const secret of [U1, U2, u1Contact.id, run.connectionId, RECRUITER, ME,
      'CURSOR-inbox', 'deltatoken', 'Following up']) {
      assert.ok(!s.includes(secret), `the summary leaked: ${String(secret).slice(0, 28)}`)
    }
    assert.ok(!/[0-9a-f]{64}/.test(s), 'the summary leaked a fingerprint')
  })

  // ══ 2. a rerun does not duplicate ═════════════════════════════════════════
  console.log('\na rerun does not duplicate')
  await test('the second run refreshes rather than creating, and there is still ONE row', async () => {
    // Make it due again, then run the identical fixture.
    psql(`UPDATE public.outlook_sync_state SET last_success_at = now() - interval '2 hours'
          WHERE user_id='${U1}';`, { tuplesOnly: false })
    const again = await runOutlookImport({
      rpc: workerRpc([]), encryptCursor,
      loadRunContext: contextLoader(contacts),
      deps: { fetchImpl: completeProvider([]) },
    })
    assert.strictEqual(again.outcome, 'committed', JSON.stringify(summarizeRun(again)))
    assert.strictEqual(again.writeResults.refreshed, 1, JSON.stringify(again.writeResults))
    assert.strictEqual(again.writeResults.created, undefined)
    assert.strictEqual(one(
      `SELECT count(*) FROM public.interaction_candidates WHERE user_id='${U1}';`), '1')
    assert.strictEqual(one(`SELECT count(*) FROM public.outlook_candidate_refs WHERE user_id='${U1}';`), '1')
  })

  // ══ 3. the user reviews it, over PostgREST, with their own JWT ════════════
  console.log('\nthe signed-in user can see it, edit it, and accept it')
  let candidateId = null

  await test('the review queue shows it, with the page\'s own select', async () => {
    const r = await http('GET',
      `/interaction_candidates?select=${encodeURIComponent(CANDIDATE_SELECT)}&status=eq.pending`,
      { token: TOK.u1() })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 200))
    assert.strictEqual(r.body.length, 1, r.raw.slice(0, 300))
    const row = r.body[0]
    candidateId = row.id
    assert.strictEqual(row.source, 'outlook')
    assert.strictEqual(row.proposed_type, 'Email')
    assert.strictEqual(row.proposed_interaction_date, '2026-09-21')
    assert.strictEqual(row.proposed_notes, null, 'nothing was invented for the user to read')
    assert.strictEqual(row.contacts.name, 'Ava Recruiter',
      'the evidence the user needs: which contact this was with')
  })

  await test('the queue never exposes a fingerprint, user id or interaction id', async () => {
    for (const col of ['source_fingerprint', 'user_id', 'interaction_id', 'context_expires_at']) {
      const r = await http('GET', `/interaction_candidates?select=id,${col}`, { token: TOK.u1() })
      assert.strictEqual(r.body?.code, '42501', `${col} is readable by the browser: ${r.raw.slice(0, 160)}`)
    }
  })

  await test('the other user cannot see it', async () => {
    const r = await http('GET', '/interaction_candidates?select=id&status=eq.pending', { token: TOK.u2() })
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(r.body, [])
  })

  await test('the other user cannot accept it either', async () => {
    const r = await http('POST', '/rpc/accept_interaction_candidate',
      { token: TOK.u2(), body: { p_candidate_id: candidateId } })
    assert.strictEqual(r.body?.result, 'not_found')
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions;`), '0')
  })

  await test('ACCEPTING with the user\'s own edits creates the interaction, and only then', async () => {
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), '0',
      'still nothing before the explicit accept')
    const r = await http('POST', '/rpc/accept_interaction_candidate', {
      token: TOK.u1(),
      body: {
        p_candidate_id: candidateId,
        p_override_type: 'Coffee chat',            // the user corrects the type
        p_override_date: '2026-09-22',             // and the date
        p_override_notes: 'Talked about the analyst programme; she offered a referral.',
      },
    })
    assert.strictEqual(r.body?.result, 'accepted', r.raw.slice(0, 200))
    const row = psql(`SELECT type, interaction_date, notes, source, contact_id
      FROM public.interactions WHERE user_id='${U1}';`).trim().split('|')
    assert.strictEqual(row[0], 'Coffee chat', 'the USER\'s type must win')
    assert.strictEqual(row[1], '2026-09-22', 'the USER\'s date must win')
    assert.strictEqual(row[2], 'Talked about the analyst programme; she offered a referral.',
      'the saved note is the one the user typed')
    assert.strictEqual(row[3], 'outlook', 'provenance is recorded on the interaction')
    assert.strictEqual(row[4], u1Contact.id)
  })

  await test('the accepted candidate is terminal, linked, and no longer pending', () => {
    const row = psql(`SELECT status, (interaction_id IS NOT NULL),
        coalesce(context_expires_at::text,'NULL')
      FROM public.interaction_candidates WHERE id='${candidateId}';`).trim().split('|')
    assert.deepStrictEqual(row, ['accepted', 't', 'NULL'])
  })

  await test('a later identical run does NOT resurrect the accepted exchange', async () => {
    psql(`UPDATE public.outlook_sync_state SET last_success_at = now() - interval '2 hours'
          WHERE user_id='${U1}';`, { tuplesOnly: false })
    const again = await runOutlookImport({
      rpc: workerRpc([]), encryptCursor,
      loadRunContext: contextLoader(contacts),
      deps: { fetchImpl: completeProvider([]) },
    })
    assert.strictEqual(again.writeResults.exists_terminal, 1, JSON.stringify(again.writeResults))
    assert.strictEqual(one(
      `SELECT count(*) FROM public.interaction_candidates WHERE user_id='${U1}';`), '1')
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), '1',
      'and no second interaction was created')
  })

  // ══ 4. dismissal ═════════════════════════════════════════════════════════
  console.log('\ndismissal creates nothing and is never resurrected')
  await test('a dismissed suggestion leaves no interaction and stays dismissed', async () => {
    psql(SEED, { tuplesOnly: false })
    const fresh = ownContacts()
    const r1 = await runOutlookImport({
      rpc: workerRpc([]), encryptCursor,
      loadRunContext: contextLoader(fresh),
      deps: { fetchImpl: completeProvider([]) },
    })
    assert.strictEqual(r1.writeResults.created, 1)
    const id = one(`SELECT id FROM public.interaction_candidates WHERE user_id='${U1}';`)
    const d = await http('POST', '/rpc/dismiss_interaction_candidate',
      { token: TOK.u1(), body: { p_candidate_id: id } })
    assert.strictEqual(d.body?.result, 'dismissed', d.raw.slice(0, 160))
    assert.strictEqual(one(`SELECT count(*) FROM public.interactions WHERE user_id='${U1}';`), '0')

    psql(`UPDATE public.outlook_sync_state SET last_success_at = now() - interval '2 hours'
          WHERE user_id='${U1}';`, { tuplesOnly: false })
    const r2 = await runOutlookImport({
      rpc: workerRpc([]), encryptCursor,
      loadRunContext: contextLoader(fresh),
      deps: { fetchImpl: completeProvider([]) },
    })
    assert.strictEqual(r2.writeResults.exists_terminal, 1,
      'a dismissed exchange must never be suggested again')
    assert.strictEqual(one(`SELECT status FROM public.interaction_candidates WHERE id='${id}';`), 'dismissed')
  })

  // ══ 5. an incomplete pass ════════════════════════════════════════════════
  console.log('\nan incomplete pass writes nothing and advances nothing')
  await test('Inbox finishes, Sent Items does not: no candidate, no cursor', async () => {
    psql(SEED, { tuplesOnly: false })
    const fresh = ownContacts()
    const before = one(`SELECT count(*) FROM public.interaction_candidates;`)
    const r = await runOutlookImport({
      rpc: workerRpc([]), encryptCursor,
      loadRunContext: contextLoader(fresh),
      deps: { fetchImpl: incompleteProvider([]) },
    })
    assert.strictEqual(r.outcome, 'incomplete', JSON.stringify(summarizeRun(r)))
    assert.deepStrictEqual(r.incompleteReasons, ['folder_incomplete'])
    assert.strictEqual(r.written, 0)
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates;`), before,
      'an incomplete pass must write no candidate')
    const cursors = psql(`SELECT folder, coalesce(delta_link_ciphertext,'NULL'), last_run_complete
      FROM public.outlook_sync_state WHERE user_id='${U1}' ORDER BY folder;`).trim().split('\n')
    for (const c of cursors) {
      const [folder, ct, complete] = c.split('|')
      assert.strictEqual(ct, 'NULL', `${folder} cursor advanced on an incomplete run`)
      assert.strictEqual(complete, 'f', folder)
    }
  })

  await test('a stale lease is refused: the write RPC is fenced, not merely ordered', async () => {
    // Expire the lease mid-run by hand, then attempt the write with the old run id.
    psql(SEED, { tuplesOnly: false })
    const fresh = ownContacts()
    const reserved = await http('POST', '/rpc/reserve_due_outlook_connection',
      { token: TOK.worker(), body: { p_lease_seconds: 120, p_due_after_seconds: 900 } })
    const { connection_id: conn, run_id: runId } = reserved.body
    psql(`UPDATE public.outlook_sync_state SET sync_lease_until = now() - interval '1 minute'
          WHERE connection_id='${conn}';`, { tuplesOnly: false })
    const w = await http('POST', '/rpc/upsert_outlook_interaction_candidate', {
      token: TOK.worker(),
      body: {
        p_connection_id: conn, p_run_id: runId, p_contact_id: fresh.find((c) => c.user_id === U1).id,
        p_episode_fingerprint: 'a'.repeat(64), p_person_fingerprint: 'b'.repeat(64),
        p_key_version: 1, p_proposed_type: 'Email', p_proposed_date: '2026-09-21',
      },
    })
    assert.strictEqual(w.body?.result, 'stale_run', w.raw.slice(0, 200))
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates;`), '0')
  })

  await test('a user cannot call the worker write RPC at all', async () => {
    const r = await http('POST', '/rpc/upsert_outlook_interaction_candidate', {
      token: TOK.u1(),
      body: {
        p_connection_id: U1, p_run_id: U1, p_contact_id: U1,
        p_episode_fingerprint: 'c'.repeat(64), p_person_fingerprint: null,
        p_key_version: 1, p_proposed_type: 'Email', p_proposed_date: '2026-09-21',
      },
    })
    assert.strictEqual(r.body?.code, '42501', `a user reached the worker RPC: ${r.raw.slice(0, 200)}`)
  })

  await test('the write RPC refuses a new-contact proposal rather than inventing one', async () => {
    psql(SEED, { tuplesOnly: false })
    const reserved = await http('POST', '/rpc/reserve_due_outlook_connection',
      { token: TOK.worker(), body: { p_lease_seconds: 120, p_due_after_seconds: 900 } })
    const w = await http('POST', '/rpc/upsert_outlook_interaction_candidate', {
      token: TOK.worker(),
      body: {
        p_connection_id: reserved.body.connection_id, p_run_id: reserved.body.run_id,
        p_contact_id: null, p_episode_fingerprint: 'd'.repeat(64), p_person_fingerprint: null,
        p_key_version: 1, p_proposed_type: 'Email', p_proposed_date: '2026-09-21',
      },
    })
    assert.strictEqual(w.body?.result, 'contact_required')
    assert.strictEqual(one(`SELECT count(*) FROM public.interaction_candidates;`), '0')
  })
}

try { await main() } catch (e) { console.error(`\nHARNESS ERROR: ${e.message}`); failed++ }
finally { teardown() }
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
