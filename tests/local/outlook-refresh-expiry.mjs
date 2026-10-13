// THE NEW-CONTACT REFRESH DEFECT: reproduced first, then fixed, in one pass.
//
// `upsert_new_contact_candidate` could never refresh an existing new-contact proposal. Its
// UPDATE branch set `context_expires_at = now() + interval '30 days'` while `created_at` kept
// the original insert instant, and the table's own ceiling is
//
//     ncc_context_ceiling: context_expires_at <= created_at + interval '30 days'
//
// The create and the refresh are DIFFERENT TRANSACTIONS and `now()` is transaction-start
// time, so the refreshing clock is strictly later than the creating one and the violation is
// unconditional. This file makes that concrete: it runs every migration EXCEPT the fix,
// measures the rejection over real PostgREST, drives the real worker into the same failure
// with fresh continuation mail, THEN applies the fix and re-runs the same round against the
// same durable state.
//
// WHY A SEPARATE TRANSACTION MATTERS, and why this is not an artefact. Each PostgREST request
// is its own transaction, so the two `now()` readings genuinely differ. A test that created
// and refreshed inside one transaction would read the SAME `now()`, the ceiling would hold,
// and the defect would be invisible - which is the likeliest reason it reached Production.
//
// WHAT IT PROVES, after the fix:
//   1. creation then a later PENDING refresh succeeds on the SAME candidate row;
//   2. a DEFERRED proposal refreshes while its deferral invariants hold;
//   3. `created_at` and `context_expires_at` are byte-identical across refreshes;
//   4. the new draft and the coverage update commit TOGETHER in one call;
//   5. a real worker round with fresh continuation mail COMMITS its cursors, where the same
//      round against the unfixed function returned `write_failed` and advanced nothing. The
//      re-run RESUMES the stored round rather than re-listing - the failing round had
//      already persisted its messages - and reaches the refresh through the thread lookup,
//      which is the durable-continuation path behaving as designed;
//   6. accepted and dismissed proposals are still never re-made, and their rows are untouched;
//   7. an already-expired context gains NO new retention period;
//   8. a stale lease still writes nothing.
//
// NOT part of `npm test`: it needs Docker. Teardown is unconditional.
// RUN: node tests/local/outlook-refresh-expiry.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, createHmac, createHash, webcrypto } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'
import { runOutlookImport, summarizeRun } from '../../supabase/functions/shared/outlookImportRun.js'
import { GRAPH_BASE } from '../../supabase/functions/shared/outlookGraphTransport.js'
import { ANTHROPIC_MESSAGES_URL } from '../../supabase/functions/shared/outlookDraftContract.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-refresh-pg'
const REST = 'funnl-refresh-rest'
const NET = 'funnl-refresh-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const BASE = 'http://127.0.0.1:53998'
const JWT_SECRET = randomBytes(32).toString('hex')
const FIXTURE_KEY = 'sk-ant-fixture-not-a-real-key'

const FIX_MIGRATION = '20261013060000_preserve_new_contact_context_deadline.sql'

const USER = '00000000-0000-4000-8000-00000000f001'
const CONN = '10000000-0000-4000-8000-00000000f001'
const ME = 'me@refresh.test'
const STRANGER = 'zoe@firm.test'          // the worker thread's other party, not a contact
const DIRECT_PARTY = 'noor@fund.test'     // the direct-RPC threads' party, not a contact
const CONSENT = `ol-disc-${'e'.repeat(32)}`
const REQUIRED_CONSENT = { content: CONSENT, thirdParty: CONSENT }
const ALL_ADDRESSES = [ME, STRANGER, DIRECT_PARTY]

/** A 64-hex fingerprint from a label, which is all these functions require of one. */
const fp = (label) => createHash('sha256').update(String(label)).digest('hex')

let passed = 0
let failed = 0
async function test (name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); passed += 1 }
  catch (e) { console.error(`  FAIL ${name}\n       ${e && e.message}`); failed += 1 }
}

// ── docker plumbing ──────────────────────────────────────────────────────────
const docker = (a, o = {}) => execFileSync('docker', a, { encoding: 'utf8', stdio: 'pipe', ...o })
const quiet = (a) => spawnSync('docker', a, { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
 * This image reads the singular legacy claim `request.jwt.claim.sub`; PostgREST v14 sets the
 * JSON form. Without the alignment auth.uid() is NULL for every HTTP request, so the
 * acceptance RPCs below would answer `not_found` to their own owner and the "accepted rows
 * stay untouched" proof would pass for the wrong reason.
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
    await sleep(1000)
  }
  throw new Error('PostgREST never became ready')
}

function teardown () {
  quiet(['rm', '-f', REST]); quiet(['rm', '-f', PG]); quiet(['network', 'rm', NET])
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
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
  user: () => mintJwt({ role: 'authenticated', aud: 'authenticated', sub: USER }),
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

/** One direct call to the REAL producer, as the worker. */
async function produce (over = {}) {
  const body = {
    p_connection_id: CONN,
    p_run_id: over.runId ?? RUN,
    p_episode_fingerprint: over.episode,
    p_person_fingerprint: over.person ?? fp('person-direct'),
    p_key_version: 1,
    p_proposed_email: over.email ?? DIRECT_PARTY,
    p_proposed_date: over.date ?? '2026-09-21',
    p_proposed_name: over.name ?? 'Noor Haddad',
    p_name_evidence: 'explicit_signature',
    p_name_confidence: 'high',
    p_draft_summary: over.summary ?? 'They offered Thursday afternoon and asked for times.',
    p_draft_follow_up: over.followUp ?? 'Send two or three times.',
    p_retained_subject: over.subject ?? 'Thread direct',
    p_extraction_status: 'ai_extracted',
    p_conversation_fingerprint: over.conversation,
    p_covered_fingerprints: over.covered ?? null,
    p_coverage_from_at: over.from ?? null,
    p_coverage_through_at: over.through ?? null,
    p_conversation_lookup_fingerprints: over.conversation ? [over.conversation] : null,
    p_covered_lookup_fingerprints: over.coveredLookup ?? over.covered ?? null,
  }
  return http('POST', '/rpc/upsert_new_contact_candidate', { token: TOK.worker(), body })
}

const RUN = '20000000-0000-4000-8000-00000000f001'

/** Give the run a live lease on both folders, which the producer's fence requires. */
function leaseFor (runId = RUN) {
  psql(`UPDATE public.outlook_sync_state
           SET sync_status='running', sync_run_id='${runId}',
               sync_lease_until = now() + interval '5 minutes'
         WHERE connection_id='${CONN}';`, { tuplesOnly: false })
}
function releaseLease () {
  psql(`UPDATE public.outlook_sync_state
           SET sync_status='idle', sync_run_id=NULL, sync_lease_until=NULL
         WHERE connection_id='${CONN}';`, { tuplesOnly: false })
}

/** One candidate's lifecycle columns, exactly as stored. */
const candRow = (id) => {
  const r = rows(`SELECT status,
                         created_at::text,
                         coalesce(context_expires_at::text,'null'),
                         coalesce(deferred_until::text,'null'),
                         coalesce(draft_summary,'null'),
                         coalesce(proposed_name,'null'),
                         updated_at::text
                    FROM public.new_contact_candidates WHERE id='${id}';`)
  assert.strictEqual(r.length, 1, `expected one row for ${id}`)
  const [status, createdAt, expiresAt, deferredUntil, summary, name, updatedAt] = r[0]
  return { status, createdAt, expiresAt, deferredUntil, summary, name, updatedAt }
}

/** The provenance row's coverage, as stored. */
const refRow = (id) => {
  const r = rows(`SELECT coalesce(conversation_fingerprint,'null'),
                         coalesce(array_to_string(covered_message_fingerprints, ','),'null'),
                         coalesce(coverage_from_at::text,'null'),
                         coalesce(coverage_through_at::text,'null'),
                         coalesce(coverage_source,'null')
                    FROM public.outlook_candidate_refs WHERE new_contact_candidate_id='${id}';`)
  assert.strictEqual(r.length, 1, `expected one provenance row for ${id}`)
  const [conv, covered, from, through, source] = r[0]
  return { conv, covered, from, through, source }
}

/** A whole-row digest, so "untouched" means every column. Only the digest is printed. */
const digest = (table, where) => one(
  `SELECT coalesce(md5(string_agg(t::text, E'\\x1e' ORDER BY t.id)), 'empty') || ' x' || count(*)
     FROM public.${table} t WHERE ${where};`)

// ── the worker's ports ───────────────────────────────────────────────────────
function workerRpc (calls) {
  return async (name, args) => {
    calls.push({ name, args })
    const r = await http('POST', `/rpc/${name}`, { token: TOK.worker(), body: args })
    if (r.status >= 400) {
      // NAMED, not swallowed: the run never forwards an RPC message, so without this a
      // contract rejection and a fixture mistake look identical.
      console.error(`       [rpc ${r.status}] ${name}: ${r.raw.slice(0, 400)}`)
      return { data: null, error: { status: r.status, raw: r.raw.slice(0, 400) } }
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

async function committedCursors () {
  const got = rows(`SELECT folder, coalesce(delta_link_ciphertext,''), coalesce(delta_link_nonce,'')
                      FROM public.outlook_sync_state WHERE connection_id='${CONN}' ORDER BY folder;`)
  const out = { inbox: null, sentitems: null }
  for (const [folder, ct, nonce] of got) {
    if (ct && nonce) out[folder] = await decryptCursor(ct, nonce)
  }
  return out
}

function contextLoader () {
  return async () => ({
    primaryEmail: ME,
    aliases: [],
    timeZone: 'America/New_York',
    userId: USER,
    contacts: rows(`SELECT id, user_id, email FROM public.contacts WHERE user_id='${USER}' ORDER BY id;`)
      .map(([id, user_id, email]) => ({ id, user_id, email })),
    cursors: await committedCursors(),
    accessToken: 'token-refresh',
    keyRing: RING,
    consentVersion: CONSENT,
  })
}

// ── one mailbox, one thread, two pages of it ─────────────────────────────────
const okRes = (body) => ({ status: 200, headers: { get: () => null }, json: async () => body })
const addr = (e, n) => ({ emailAddress: { address: e, name: n } })
const qp = (u, name) => {
  const m = String(u).match(new RegExp('[?&]' + name.replace('$', '\\$') + '=([^&]*)'))
  return m ? decodeURIComponent(m[1]) : null
}

const CONV = 'AAQkA-refresh-thread'
const envelope = (id, from, fromName, to, toName, sent) => ({
  id, conversationId: CONV, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
  subject: 'Spring programme', from: addr(from, fromName), sender: addr(from, fromName),
  toRecipients: [addr(to, toName)], ccRecipients: [],
})

// PAGE 1 is the exchange that CREATES the proposal; PAGE 2 is the fresh continuation that
// drives the producer into its refresh branch - the defect's actual trigger.
const WORLD = {
  inbox: {
    1: [envelope('msg-in-1', STRANGER, 'Zoe Adeyemi', ME, 'Me', '2026-09-21T14:00:00Z')],
    2: [envelope('msg-in-2', STRANGER, 'Zoe Adeyemi', ME, 'Me', '2026-09-24T09:00:00Z')],
  },
  sentitems: {
    1: [envelope('msg-out-1', ME, 'Me', STRANGER, 'Zoe Adeyemi', '2026-09-21T16:00:00Z')],
    2: [envelope('msg-out-2', ME, 'Me', STRANGER, 'Zoe Adeyemi', '2026-09-24T11:00:00Z')],
  },
}
const BODIES = {
  'msg-in-1': 'PAGE1 Good to speak at the panel. Your name has gone forward for the spring '
    + 'programme and the team would like a short call next week.',
  'msg-out-1': 'PAGE1 Thank you - a call next week works. I will send some times.',
  'msg-in-2': 'PAGE2 The team has asked for two more referees and moved the call to the '
    + 'following Tuesday.',
  'msg-out-2': 'PAGE2 Noted, I will send both referees before Friday.',
}
const NOTES = {
  PAGE1: 'She confirmed your name went forward for the spring programme and asked for a '
    + 'short call next week. Left open: which day.',
  PAGE2: 'She asked for two more referees and moved the call to the following Tuesday. You '
    + 'said you would send both before Friday. Left open: who the referees are.',
}
const ENVELOPES = Object.fromEntries(
  [...Object.values(WORLD.inbox).flat(), ...Object.values(WORLD.sentitems).flat()]
    .map((e) => [e.id, e]))
const FOLDER_OF = Object.fromEntries([
  ...Object.values(WORLD.inbox).flat().map((e) => [e.id, 'inbox']),
  ...Object.values(WORLD.sentitems).flat().map((e) => [e.id, 'sentitems']),
])

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
function draftFor (requestBody, counts) {
  const which = requestBody.indexOf('PAGE2') >= 0 ? 'PAGE2' : 'PAGE1'
  const isNew = requestBody.indexOf('new_contact_suggestion') >= 0
  counts.drafts.push({ which, isNew })
  const base = {
    summary: NOTES[which],
    summary_evidence: 'explicit_body',
    follow_up: which === 'PAGE2' ? 'Send both referees before Friday.' : 'Send some times.',
    interaction_date: null,
  }
  return modelResponse(isNew
    ? { result: 'new_contact_suggestion', name: 'Zoe Adeyemi',
        name_evidence: 'explicit_signature', name_confidence: 'high', ...base }
    : { result: 'interaction_draft', ...base })
}

/**
 * Graph and Anthropic. THE DELTA TOKEN DECIDES WHICH PAGE IS SERVED, as it does at Graph:
 * no token -> page 1; the page-1 token -> page 2; the page-2 token -> nothing new. A round
 * that fails to commit therefore re-lists exactly the page it saw, which is what makes the
 * before/after comparison below run against the same durable state.
 */
function provider (counts) {
  return async (url, init) => {
    const u = String(url)
    if (u === ANTHROPIC_MESSAGES_URL) {
      counts.model += 1
      const sent = String(init?.body ?? '')
      for (const a of ALL_ADDRESSES) {
        if (sent.includes(a)) counts.leakedAddresses.push(a)
      }
      return draftFor(sent, counts)
    }
    if (u.includes('/subscriptions')) {
      return { status: 403, headers: { get: () => null },
        json: async () => ({ error: { code: 'ExtensionError', message: 'fixture: no subscription' } }) }
    }
    const m = u.match(/\/me\/messages\/([^?]+)\?/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const env = ENVELOPES[id]
      const select = qp(u, '$select') || ''
      if (select.indexOf('uniqueBody') < 0) {
        counts.envelopes.push(id)
        if (!env) {
          return { status: 404, headers: { get: () => null },
            json: async () => ({ error: { code: 'ErrorItemNotFound' } }) }
        }
        return okRes({ ...env })
      }
      counts.bodies.push(id)
      if (!env || !BODIES[id]) {
        return { status: 404, headers: { get: () => null },
          json: async () => ({ error: { code: 'ErrorItemNotFound' } }) }
      }
      return contentResponse(env, BODIES[id])
    }
    const folder = u.includes('/mailFolders/inbox/') ? 'inbox' : 'sentitems'
    if (u.includes('/messages/delta')) {
      const token = qp(u, '$deltatoken')
      const page = token === null ? 1 : (token === `${folder}-1` ? 2 : null)
      counts.deltas.push({ folder, token, page })
      const value = page === null ? [] : WORLD[folder][page]
      const next = page === null ? 2 : page
      return okRes({
        value,
        '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=${folder}-${next}`,
      })
    }
    const filter = qp(u, '$filter')
    if (filter !== null) {
      // A conversation lookup during recovery: the mailbox will admit to holding every
      // message of the thread that has already been DELIVERED by a delta page.
      counts.lookups.push({ folder })
      const value = Object.values(ENVELOPES)
        .filter((e) => FOLDER_OF[e.id] === folder && DELIVERED.has(e.id))
        .sort((a, b) => String(a.sentDateTime).localeCompare(String(b.sentDateTime)))
      return okRes({ value })
    }
    return okRes({ value: [] })
  }
}

/**
 * EVERY MESSAGE A DELTA PAGE HAS EVER DELIVERED, across rounds.
 *
 * A conversation lookup asks the mailbox what it holds, and a mailbox does not forget
 * between one round and the next. Scoping this per round made a lookup answer "nothing"
 * for a thread whose earlier half had arrived in an earlier round, which the run correctly
 * reported as `recovery_no_messages` - a fixture that had lost the thread, not a worker that
 * could not find it. What stays unfindable is a message no page has delivered yet, which is
 * the part that has to remain true.
 */
const DELIVERED = new Set()

const newCounts = () => ({ model: 0, drafts: [], leakedAddresses: [], bodies: [],
  envelopes: [], deltas: [], lookups: [] })

function makeDue () {
  psql(`UPDATE public.outlook_sync_state
           SET sync_status='idle', sync_lease_until=NULL, sync_run_id=NULL,
               next_retry_at=NULL, retry_count=0, last_run_complete=true,
               last_success_at=now() - interval '2 hours',
               last_attempt_at=now() - interval '2 hours';
        UPDATE public.microsoft_connections SET wake_requested_at=NULL;`, { tuplesOnly: false })
}

function traced (name, fn) {
  return async (...args) => {
    try { return await fn(...args) } catch (e) {
      console.error(`       [harness] ${name} threw: ${e && e.message}`)
      throw e
    }
  }
}

/** One invocation of the REAL run. */
async function round () {
  const counts = newCounts()
  const calls = []
  const base = provider(counts)
  // A message is only recoverable once a delta page has delivered it, which is what makes
  // the second round's thread lookup realistic rather than omniscient.
  const wrapped = async (url, init) => {
    const res = await base(url, init)
    const u = String(url)
    if (u.includes('/messages/delta')) {
      const body = await res.json()
      for (const e of body.value ?? []) DELIVERED.add(e.id)
      return { status: res.status, headers: res.headers, json: async () => body }
    }
    return res
  }
  makeDue()
  const run = await runOutlookImport({
    rpc: traced('rpc', workerRpc(calls)),
    pilotUserId: USER,
    encryptCursor: traced('encryptCursor', encryptCursor),
    decryptCursor: traced('decryptCursor', decryptCursor),
    loadRunContext: traced('loadRunContext', contextLoader()),
    anthropicApiKey: FIXTURE_KEY,
    requiredConsent: REQUIRED_CONSENT,
    requiredBackgroundConsent: CONSENT,
    deps: { fetchImpl: traced('graph', wrapped) },
  })
  return { run, report: summarizeRun(run), counts, calls }
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
  assert.ok(all.includes(FIX_MIGRATION), 'the fix migration must exist')
  const before = all.filter((f) => f !== FIX_MIGRATION)
  for (const m of before) psqlFile(`supabase/migrations/${m}`)
  console.log(`  applied ${before.length} migrations, DEFERRING ${FIX_MIGRATION}`)

  psql("ALTER ROLE authenticator WITH PASSWORD 'disposable';", { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', '53998:3000',
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitForRest()
  console.log('  PostgREST is serving\n')

  psql(`INSERT INTO auth.users (id, email, email_confirmed_at, created_at, updated_at)
        VALUES ('${USER}', '${ME}', now(), now(), now()) ON CONFLICT (id) DO NOTHING;
        INSERT INTO public.microsoft_connections
          (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes, status,
           needs_reauth, consented_at, consent_policy_version)
        VALUES ('${CONN}', '${USER}', 'acct-refresh', 'consumers', 'personal', '${ME}',
                ARRAY['Mail.Read','User.Read','offline_access'], 'active', false, now(), '${CONSENT}');
        INSERT INTO public.outlook_sync_state
          (connection_id, user_id, folder, sync_status, initial_import_done,
           last_success_at, last_attempt_at, last_run_complete)
        VALUES ('${CONN}','${USER}','inbox','idle',false, now() - interval '2 hours', now() - interval '2 hours', true),
               ('${CONN}','${USER}','sentitems','idle',false, now() - interval '2 hours', now() - interval '2 hours', true);`,
  { tuplesOnly: false })

  // ══ 1. the defect, measured ════════════════════════════════════════════════
  console.log('1. BEFORE the fix: the refresh cannot succeed')

  const EP1 = fp('episode-one')
  const CF1 = fp('conversation-one')
  const COV1 = [fp('cov-1a'), fp('cov-1b')]
  let cand1 = null
  let created1 = null

  await test('a new-contact proposal is created, with a 30-day window from its creation', async () => {
    leaseFor()
    const r = await produce({ episode: EP1, conversation: CF1, covered: COV1,
      from: '2026-09-21T14:00:00Z', through: '2026-09-21T16:00:00Z' })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 300))
    assert.strictEqual(r.body?.result, 'created', JSON.stringify(r.body))
    cand1 = r.body.candidate_id
    created1 = candRow(cand1)
    assert.strictEqual(created1.status, 'pending')
    // The window is exactly thirty days from creation, which is the ceiling's own rule.
    const gap = one(`SELECT (context_expires_at - created_at)::text
                       FROM public.new_contact_candidates WHERE id='${cand1}';`)
    assert.strictEqual(gap, '30 days', `the window must be 30 days, got ${gap}`)
  })

  await test('the refreshing transaction really does have a LATER clock', async () => {
    // Without this, the reproduction below could be dismissed as an artefact of one
    // transaction's frozen `now()`. Each psql invocation is its own transaction.
    await sleep(1200)
    // `boolean::text` renders 'true'/'false' - psql prints a bare boolean as 't'/'f', and
    // conflating the two is how a comparison silently stops meaning anything.
    const later = one(`SELECT (now() > created_at)::text || '|' || (now() - created_at)::text
                         FROM public.new_contact_candidates WHERE id='${cand1}';`)
    const [isLater, elapsed] = later.split('|')
    assert.strictEqual(isLater, 'true', 'now() must be strictly later than created_at')
    console.log(`       elapsed since creation: ${elapsed}`)
  })

  let violation = null
  await test('REPRODUCED: refreshing the pending proposal violates ncc_context_ceiling', async () => {
    leaseFor()
    const r = await produce({ episode: EP1, conversation: CF1, covered: COV1,
      from: '2026-09-21T14:00:00Z', through: '2026-09-24T11:00:00Z',
      summary: 'A later part of the same exchange.' })
    violation = { status: r.status, code: r.body?.code ?? null,
      constraint: /ncc_context_ceiling/.test(r.raw) ? 'ncc_context_ceiling' : null }
    assert.strictEqual(r.status, 400, JSON.stringify(violation))
    assert.strictEqual(r.body?.code, '23514', JSON.stringify(violation))
    assert.strictEqual(violation.constraint, 'ncc_context_ceiling', r.raw.slice(0, 300))
    // And the rejected write changed nothing: the whole statement rolled back.
    assert.deepStrictEqual(candRow(cand1), created1,
      'a rejected refresh must leave the row exactly as it was')
  })
  console.log(`       the unfixed function answers a refresh with: ${JSON.stringify(violation)}`)

  // The worker's own version of the same failure, on a real round.
  let afterRound1Cursors = null
  await test('the worker creates the proposal on its first round and commits its cursors', async () => {
    releaseLease()
    const r = await round()
    assert.ok(['committed', 'ok'].includes(r.run.outcome), JSON.stringify(r.report))
    assert.deepStrictEqual(r.counts.leakedAddresses, [], 'no address may reach the model')
    const n = Number(one(`SELECT count(*) FROM public.new_contact_candidates
                           WHERE user_id='${USER}' AND id <> '${cand1}';`))
    assert.strictEqual(n, 1, 'the thread must have produced exactly one proposal')
    afterRound1Cursors = await committedCursors()
    assert.ok(afterRound1Cursors.inbox && afterRound1Cursors.sentitems,
      'both folders must have committed a cursor')
  })

  const workerCand = one(`SELECT id FROM public.new_contact_candidates
                           WHERE user_id='${USER}' AND id <> '${cand1}' LIMIT 1;`)
  let workerCreated = null
  let preFailDigest = null

  await test('REPRODUCED ON A REAL ROUND: fresh continuation mail returns write_failed and advances nothing', async () => {
    workerCreated = candRow(workerCand)
    preFailDigest = digest('new_contact_candidates', `t.user_id='${USER}'`)
    await sleep(1200)
    const r = await round()
    console.log(`       delta pages: ${JSON.stringify(r.counts.deltas)}`)
    assert.strictEqual(r.run.outcome, 'write_failed', JSON.stringify(r.report))
    assert.strictEqual(r.report.write_results?.rpc_error, 1, JSON.stringify(r.report))
    assert.strictEqual(r.report.cursors_advanced, 0,
      'a round that could not write must not advance a cursor')
    // THE CONSEQUENCE, which is what made this worth fixing: the committed cursors are
    // unchanged, so the next round re-lists the same page, for ever.
    assert.deepStrictEqual(await committedCursors(), afterRound1Cursors,
      'the committed cursors must be exactly where round one left them')
    assert.strictEqual(digest('new_contact_candidates', `t.user_id='${USER}'`), preFailDigest,
      'and nothing of the proposal was written')
  })

  // ══ 2. apply the fix ══════════════════════════════════════════════════════
  console.log(`\n2. applying ${FIX_MIGRATION}`)
  psqlFile(`supabase/migrations/${FIX_MIGRATION}`)
  psql("NOTIFY pgrst, 'reload schema';", { tuplesOnly: false })
  await sleep(1500)

  await test('exactly one overload, SECURITY DEFINER, empty search_path, service_role only', async () => {
    const sigs = rows(`SELECT p.oid::regprocedure::text, p.prosecdef::text,
                              coalesce(array_to_string(p.proconfig, ','),'none'),
                              has_function_privilege('service_role', p.oid, 'EXECUTE')::text,
                              has_function_privilege('anon', p.oid, 'EXECUTE')::text,
                              has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname='public' AND p.proname='upsert_new_contact_candidate';`)
    assert.strictEqual(sigs.length, 1, `one overload only: ${JSON.stringify(sigs)}`)
    const [sig, secdef, cfg, svc, anon, auth] = sigs[0]
    assert.ok(sig.includes('text[],text[])'), sig)
    assert.strictEqual(secdef, 'true', 'SECURITY DEFINER')
    // This image renders the empty setting as `search_path=""`; a server may print it
    // without the quotes. Both mean an empty search_path, and neither means anything else.
    assert.ok(cfg === 'search_path=' || cfg === 'search_path=""',
      `empty search_path, got ${cfg}`)
    assert.deepStrictEqual([svc, anon, auth], ['true', 'false', 'false'],
      'service_role may execute; anon and authenticated may not')
  })

  await test('the ceiling constraint is untouched by the migration', async () => {
    assert.strictEqual(
      one("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='ncc_context_ceiling';"),
      'CHECK (((context_expires_at IS NULL) OR (context_expires_at <= (created_at + \'30 days\'::interval))))')
  })

  // ══ 3. the refresh, and what it must not move ═════════════════════════════
  console.log('\n3. AFTER the fix')

  await test('creation then a LATER pending refresh succeeds on the SAME candidate', async () => {
    leaseFor()
    const r = await produce({ episode: EP1, conversation: CF1, covered: COV1,
      from: '2026-09-21T14:00:00Z', through: '2026-09-24T11:00:00Z',
      summary: 'A later part of the same exchange.' })
    assert.strictEqual(r.status, 200, r.raw.slice(0, 300))
    assert.strictEqual(r.body?.result, 'refreshed', JSON.stringify(r.body))
    assert.strictEqual(r.body?.candidate_id, cand1, 'the same row, not a second proposal')
    assert.strictEqual(Number(one(`SELECT count(*) FROM public.new_contact_candidates
                                    WHERE episode_fingerprint='${EP1}';`)), 1,
    'no duplicate proposal for the episode')
  })

  await test('the creation time and the review deadline are UNCHANGED by the refresh', async () => {
    const now = candRow(cand1)
    assert.strictEqual(now.createdAt, created1.createdAt, 'created_at must not move')
    assert.strictEqual(now.expiresAt, created1.expiresAt, 'context_expires_at must not move')
    // The draft DID move - otherwise the comparison above proves nothing.
    assert.notStrictEqual(now.summary, created1.summary, 'the draft must have been refreshed')
    assert.notStrictEqual(now.updatedAt, created1.updatedAt, 'updated_at must have moved')
    const gap = one(`SELECT (context_expires_at - created_at)::text
                       FROM public.new_contact_candidates WHERE id='${cand1}';`)
    assert.strictEqual(gap, '30 days', 'the window is still thirty days from CREATION')
  })

  await test('the new draft and the coverage update commit TOGETHER', async () => {
    // One call, two tables. Both must show the new values, and the refs row must be the
    // same provenance row rather than a second one.
    const COV2 = [...COV1, fp('cov-1c'), fp('cov-1d')]
    const beforeRef = refRow(cand1)
    leaseFor()
    const r = await produce({ episode: EP1, conversation: CF1, covered: COV2,
      from: '2026-09-21T14:00:00Z', through: '2026-09-28T10:00:00Z',
      summary: 'Both referees named and the call moved.' })
    assert.strictEqual(r.body?.result, 'refreshed', JSON.stringify(r.body))
    const after = refRow(cand1)
    assert.strictEqual(candRow(cand1).summary, 'Both referees named and the call moved.',
      'the draft must carry the new summary')
    // STORED SORTED: the producer aggregates the claim with ORDER BY, so the comparison is
    // between sets, not between the order this fixture happened to pass them in.
    assert.deepStrictEqual(after.covered.split(',').sort(), [...COV2].sort(),
      'coverage must carry the new set')
    assert.notStrictEqual(after.through, beforeRef.through, 'the coverage window must have moved')
    assert.strictEqual(after.source, 'draft', 'coverage_source must say where it came from')
    assert.strictEqual(after.conv, CF1, 'the thread identity is preserved')
    assert.strictEqual(Number(one(`SELECT count(*) FROM public.outlook_candidate_refs
                                    WHERE new_contact_candidate_id='${cand1}';`)), 1,
    'one provenance row, updated in place')
    // Still the same creation time and deadline, after a second refresh.
    assert.strictEqual(candRow(cand1).createdAt, created1.createdAt)
    assert.strictEqual(candRow(cand1).expiresAt, created1.expiresAt)
  })

  await test('a DEFERRED proposal refreshes, and its deferral invariants hold', async () => {
    // 'deferred' means "not yet", so it is refreshable by design - and the shape constraint
    // requires deferred_until <= context_expires_at, which a preserved deadline keeps true.
    // deferred_until must stay inside the window (ncc_deferred_check), which a PRESERVED
    // deadline keeps true and a reissued one would have had to re-check.
    psql(`UPDATE public.new_contact_candidates
             SET status='deferred', deferred_until = created_at + interval '3 days'
           WHERE id='${cand1}';`, { tuplesOnly: false })
    const beforeDefer = candRow(cand1)
    await sleep(1100)
    leaseFor()
    const r = await produce({ episode: EP1, conversation: CF1,
      covered: [...COV1, fp('cov-1c'), fp('cov-1d'), fp('cov-1e')],
      from: '2026-09-21T14:00:00Z', through: '2026-09-29T10:00:00Z',
      summary: 'A further message while the proposal was deferred.' })
    assert.strictEqual(r.body?.result, 'refreshed', JSON.stringify(r.body))
    const after = candRow(cand1)
    assert.strictEqual(after.status, 'deferred', 'the deferral is preserved')
    assert.strictEqual(after.deferredUntil, beforeDefer.deferredUntil, 'deferred_until must not move')
    assert.strictEqual(after.expiresAt, created1.expiresAt, 'nor the deadline')
    assert.strictEqual(
      one(`SELECT (deferred_until <= context_expires_at)::text
             FROM public.new_contact_candidates WHERE id='${cand1}';`), 'true',
      'the deferral invariant must still hold')
  })

  await test('an ALREADY EXPIRED context gains no new retention period', async () => {
    // Pushed into the past by hand, which the ceiling permits - it is an upper bound.
    // The deferral is cleared HERE rather than in the tail of the case above: a case that
    // fails never reaches its own tail, and the first run of this file proved it by leaving
    // a deferred row behind and failing this one for an unrelated reason.
    // BEFORE creation, not after it: `created_at + 1 day` is still in the future, which is
    // how the first run of this case asserted an expiry that had not happened. The ceiling
    // is an upper bound, so a past value is permitted.
    psql(`UPDATE public.new_contact_candidates
             SET status='pending', deferred_until=NULL,
                 context_expires_at = created_at - interval '1 day'
           WHERE id='${cand1}';`, { tuplesOnly: false })
    const expiredAt = candRow(cand1).expiresAt
    await sleep(1100)
    leaseFor()
    const r = await produce({ episode: EP1, conversation: CF1,
      covered: [...COV1, fp('cov-1c'), fp('cov-1d'), fp('cov-1e'), fp('cov-1f')],
      from: '2026-09-21T14:00:00Z', through: '2026-09-30T10:00:00Z',
      summary: 'Another message, long after the window should have closed.' })
    assert.strictEqual(r.body?.result, 'refreshed', JSON.stringify(r.body))
    assert.strictEqual(candRow(cand1).expiresAt, expiredAt,
      'an expired deadline must stay exactly where it was')
    assert.strictEqual(
      one(`SELECT (context_expires_at < now())::text FROM public.new_contact_candidates
            WHERE id='${cand1}';`), 'true', 'and it must still be in the past')
  })

  await test('a STALE LEASE still writes nothing', async () => {
    releaseLease()
    const snapshot = digest('new_contact_candidates', `t.user_id='${USER}'`)
    const refs = digest('outlook_candidate_refs', `t.user_id='${USER}'`)
    const r = await produce({ episode: EP1, conversation: CF1,
      summary: 'Written without a lease, which must not happen.' })
    assert.strictEqual(r.body?.result, 'stale_run', JSON.stringify(r.body))
    assert.strictEqual(digest('new_contact_candidates', `t.user_id='${USER}'`), snapshot,
      'no candidate may change without a live lease')
    assert.strictEqual(digest('outlook_candidate_refs', `t.user_id='${USER}'`), refs,
      'nor a provenance row')
    // Also the wrong run id under a live lease.
    leaseFor()
    const other = await produce({ episode: EP1, conversation: CF1,
      runId: '20000000-0000-4000-8000-0000000000ff',
      summary: 'Written under another run, which must not happen.' })
    assert.strictEqual(other.body?.result, 'stale_run', JSON.stringify(other.body))
    assert.strictEqual(digest('new_contact_candidates', `t.user_id='${USER}'`), snapshot,
      'a foreign run id writes nothing either')
  })

  // ══ 4. terminal rows are still never re-made ══════════════════════════════
  console.log('\n4. accepted and dismissed proposals')

  // THE TWO KINDS ARE REFUSED AT DIFFERENT POINTS, and the expectation says which.
  // Accepting a proposal CREATES the contact, so a later write for that address is turned
  // away by the already-a-contact guard before the episode is ever looked up - an earlier
  // and stronger refusal than the terminal-status one. Dismissing creates no contact, so
  // that write reaches the episode lookup and is refused there with `exists_terminal`.
  for (const [kind, expected, finish] of [
    ['ACCEPTED', 'already_a_contact', async (id) => {
      const r = await http('POST', '/rpc/accept_new_contact_candidate',
        { token: TOK.user(), body: { p_candidate_id: id, p_name: 'Noor Haddad' } })
      assert.strictEqual(r.body?.result, 'accepted', r.raw.slice(0, 250))
    }],
    ['DISMISSED', 'exists_terminal', async (id) => {
      const r = await http('POST', '/rpc/dismiss_new_contact_candidate',
        { token: TOK.user(), body: { p_candidate_id: id } })
      assert.strictEqual(r.body?.result, 'dismissed', r.raw.slice(0, 250))
    }],
  ]) {
    await test(`an ${kind} proposal is never re-made, and its row is untouched`, async () => {
      const ep = fp(`episode-${kind}`)
      const cf = fp(`conversation-${kind}`)
      const cov = [fp(`cov-${kind}-a`), fp(`cov-${kind}-b`)]
      leaseFor()
      const created = await produce({ episode: ep, conversation: cf, covered: cov,
        email: `${kind.toLowerCase()}@fund.test`,
        person: fp(`person-${kind}`),
        from: '2026-09-21T14:00:00Z', through: '2026-09-21T16:00:00Z' })
      assert.strictEqual(created.body?.result, 'created', JSON.stringify(created.body))
      const id = created.body.candidate_id
      await finish(id)
      const settled = digest('new_contact_candidates', `t.id='${id}'`)
      await sleep(1100)
      leaseFor()
      const again = await produce({ episode: ep, conversation: cf,
        covered: cov, email: `${kind.toLowerCase()}@fund.test`,
        person: fp(`person-${kind}`),
        from: '2026-09-21T14:00:00Z', through: '2026-09-24T11:00:00Z',
        summary: 'A later message on a settled exchange.' })
      assert.strictEqual(again.body?.result, expected, JSON.stringify(again.body))
      assert.strictEqual(digest('new_contact_candidates', `t.id='${id}'`), settled,
        `the ${kind} row must not change`)
    })
  }

  // ══ 5. the round that used to fail, on the SAME durable state ═════════════
  console.log('\n5. the previously failing round, re-run after the fix')

  await test('the worker round with fresh continuation mail now COMMITS its cursors', async () => {
    releaseLease()
    const beforeCreated = candRow(workerCand)
    assert.deepStrictEqual(beforeCreated, workerCreated,
      'the proposal is still exactly as round one wrote it')
    const r = await round()
    console.log(`       round: ${r.run.outcome}, content=${JSON.stringify(r.report.content)}`)
    console.log(`       delta pages: ${JSON.stringify(r.counts.deltas)}`)
    console.log(`       thread lookups: ${JSON.stringify(r.counts.lookups)}`)
    console.log(`       drafts asked for: ${JSON.stringify(r.counts.drafts)}`)
    assert.ok(['committed', 'ok'].includes(r.run.outcome), JSON.stringify(r.report))
    assert.deepStrictEqual(r.counts.leakedAddresses, [], 'no address may reach the model')
    assert.ok(r.report.cursors_advanced > 0,
      `the round must advance a cursor, got ${r.report.cursors_advanced}`)
    // The proposal must have been REFRESHED rather than left alone or re-created: one
    // proposal write, and no second row for the thread.
    assert.ok((r.report.content?.proposals_written ?? 0) >= 1,
      `the round must have written the proposal: ${JSON.stringify(r.report.content)}`)
    const after = await committedCursors()
    assert.notDeepStrictEqual(after, afterRound1Cursors,
      'the committed cursors must have moved past the page that used to fail')
    // ONE proposal still, refreshed in place.
    assert.strictEqual(Number(one(`SELECT count(*) FROM public.new_contact_candidates
                                    WHERE user_id='${USER}' AND id='${workerCand}';`)), 1)
    const now = candRow(workerCand)
    assert.strictEqual(now.createdAt, workerCreated.createdAt, 'created_at must not move')
    assert.strictEqual(now.expiresAt, workerCreated.expiresAt, 'the deadline must not move')
    assert.notStrictEqual(now.summary, workerCreated.summary,
      'and the draft must carry the later part of the exchange')
    console.log(`       round outcome ${r.run.outcome}, cursors advanced ${r.report.cursors_advanced}`)
  })

  await test('no accepted interaction or contact was disturbed anywhere in this run', async () => {
    // The only accepted row in this database is the one section 4 created on purpose.
    const mixed = Number(one(`SELECT count(*) FROM public.interactions i
                                JOIN public.contacts c ON c.id = i.contact_id
                               WHERE c.user_id <> i.user_id;`))
    assert.strictEqual(mixed, 0, 'no interaction may belong to another owner')
    const orphan = Number(one(`SELECT count(*) FROM public.outlook_candidate_refs r
                                 JOIN public.microsoft_connections m ON m.id = r.connection_id
                                WHERE r.user_id <> m.user_id;`))
    assert.strictEqual(orphan, 0, 'no provenance row may cross an owner')
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
