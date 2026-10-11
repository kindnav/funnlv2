#!/usr/bin/env node
// LATER EXCHANGES IN A SETTLED THREAD, against REAL database functions.
//
// This drives the SAME run module the worker endpoint calls
// (shared/outlookImportRun.js) against:
//   * CONTROLLED MICROSOFT FIXTURES - a fake fetch serving scripted delta pages (selected
//     by the delta TOKEN the request carries, so a round that does not commit genuinely
//     re-lists the same page), the per-message envelope GET, the bounded conversation
//     lookup (honouring the conversationId clause, the per-folder instant window, $top and
//     @odata.nextLink) and the per-message content read. No request leaves this machine.
//   * A CONTROLLED ANTHROPIC FIXTURE - the same fake fetch answers the Messages API and
//     records every request body, so what the model would have been sent is MEASURED.
//   * A REAL Postgres - the project's own Supabase image, every migration applied in
//     order, with the real anon / authenticated / service_role roles.
//   * REAL PostgREST - the worker acts as service_role over HTTP; the reviewer accepts and
//     dismisses with their own JWT through the real acceptance RPCs.
//
// WHY IT EXISTS. tests/outlook-two-sided-rounds.test.js proves the handler against an
// IN-MEMORY MODEL of the producer RPCs. That model is a reading of the SQL, and a reading
// can be wrong: it answered `created` for a rotated thread where the real function answers
// `exists_terminal`, which hid an integration defect completely. Every outcome asserted
// here is the real function's own.
//
// WHAT IT DOES NOT COVER, stated rather than implied:
//   * THE BROWSER. No click happens; review writes go straight to PostgREST.
//   * REAL MICROSOFT AND REAL ANTHROPIC. Every provider response is a local fixture built
//     from the documented contract. These tests say what the code does GIVEN a response of
//     that shape; they are not evidence that either provider produces it.
//   * GoTrue. JWTs are minted locally with a throwaway secret; no sign-in happens.
//   * Token acquisition. The Graph access token is injected.
//
// NO REAL ADDRESS, NAME, MESSAGE OR KEY APPEARS IN THIS FILE.
//
// REQUIREMENTS: Docker, plus the two images the project already uses.
// RUN: node tests/local/outlook-thread-segments-flow.mjs   (builds and tears down)

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, createHmac, webcrypto } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'
import { runOutlookImport, summarizeRun } from '../../supabase/functions/shared/outlookImportRun.js'
import {
  GRAPH_BASE, MAX_RECOVERY_MESSAGES_PER_FOLDER,
} from '../../supabase/functions/shared/outlookGraphTransport.js'
import { ANTHROPIC_MESSAGES_URL } from '../../supabase/functions/shared/outlookDraftContract.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-seg-pg'
const REST = 'funnl-seg-rest'
const NET = 'funnl-seg-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const BASE = 'http://127.0.0.1:53995'

const U1 = '11111111-1111-1111-1111-111111111111'
const ME = 'student@getfunnl.test'
const KNOWN = 'ava@bank.test'            // already a contact
const STRANGER = 'priya@fund.test'       // not in Funnl
const LEGACY_NEW = 'noor@firm.test'      // not in Funnl, becomes one via acceptance
const LONG_NEW = 'dana@house.test'       // the same, on a thread with a back-catalogue
const JWT_SECRET = randomBytes(32).toString('hex')   // per run; never printed

const APPROVED = 'ol-disc-' + 'a'.repeat(32)
const REQUIRED = { content: APPROVED, thirdParty: APPROVED }
const FIXTURE_KEY = 'sk-ant-fixture-not-a-real-key'
const SEGMENTS_MIGRATION = '20261011000000_outlook_thread_segments.sql'

let passed = 0, failed = 0
async function test (name, fn) {
  try { await fn(); console.log(`  OK   ${name}`); passed++ }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ }
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
const rows = (sql) => psql(sql).trim().split('\n').filter(Boolean).map((r) => r.split('|'))

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

/**
 * The worker's RPC port: EVERY call goes to the real function over real HTTP.
 *
 * `hooks` runs arbitrary work immediately BEFORE a named call, which is how a reviewer
 * decision landing between the coverage lookup and the producer write is staged - an
 * interleaving a test cannot otherwise reach.
 */
function workerRpc (calls, hooks = {}) {
  return async (name, args) => {
    calls.push({ name, args })
    if (typeof hooks[name] === 'function') await hooks[name](args, calls)
    const r = await http('POST', `/rpc/${name}`, { token: TOK.worker(), body: args })
    if (r.status >= 400) return { data: null, error: { status: r.status, raw: r.raw.slice(0, 200) } }
    return { data: r.body, error: null }
  }
}

// ── a real AES-GCM sealer, so the DB stores real ciphertext ──────────────────
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

// ── THE FINGERPRINT KEY RING, and a genuine rotation ─────────────────────────
// V1 alone, then V2 current with V1 still ACCEPTED. Rotating changes the conversation
// fingerprint AND every message fingerprint, because all of them are HMACs under the same
// key - which is the whole reason the thread lookup needs ring variants.
const K1 = { keyBytes: new Uint8Array(32).fill(11), keyVersion: 1 }
const K2 = { keyBytes: new Uint8Array(32).fill(22), keyVersion: 2 }
const RING_V1 = { current: K1, accepted: [], subtle: webcrypto.subtle }
const RING_V2 = { current: K2, accepted: [K1], subtle: webcrypto.subtle }

// ── Microsoft fixtures ───────────────────────────────────────────────────────
const addr = (e, n) => ({ emailAddress: { address: e, name: n ?? e.split('@')[0] } })

function envelopeOf ({ id, conv, from, to, sent, subject }) {
  return {
    id, conversationId: conv, receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject, from: addr(from), sender: addr(from), toRecipients: to.map((t) => addr(t)),
    ccRecipients: [],
  }
}

/** One thread as a list of turns: [who, 'YYYY-MM-DDTHH:MM:SSZ', bodyText]. */
function thread ({ party, conv, turns }) {
  const envelopes = {}; const folderOf = {}; const bodies = {}; const ids = []
  turns.forEach(([who, at, text], i) => {
    const id = 'AAkALgAA' + conv + '-' + String(i).padStart(2, '0')
    const subject = i === 0 ? 'Following up' : 'RE: Following up'
    envelopes[id] = who === 'me'
      ? envelopeOf({ id, conv, from: ME, to: [party], sent: at, subject })
      : envelopeOf({ id, conv, from: party, to: [ME], sent: at, subject })
    folderOf[id] = who === 'me' ? 'sentitems' : 'inbox'
    bodies[id] = text
    ids.push(id)
  })
  return { envelopes, folderOf, bodies, ids, conv, party }
}

/** Merge threads into one mailbox world. */
function world (...threads) {
  return {
    envelopes: Object.assign({}, ...threads.map((t) => t.envelopes)),
    folderOf: Object.assign({}, ...threads.map((t) => t.folderOf)),
    bodies: Object.assign({}, ...threads.map((t) => t.bodies)),
  }
}

const okRes = (body) => ({ status: 200, headers: { get: () => null }, json: async () => body })
const qp = (u, name) => {
  const m = String(u).match(new RegExp('[?&]' + name.replace('$', '\\$') + '=([^&]*)'))
  return m ? decodeURIComponent(m[1]) : null
}

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

const newCounts = () => ({
  delta: 0, bodies: 0, model: 0, bodyIds: [], modelBodies: [], lookups: [], envelopeGets: [],
})

/**
 * ONE fake fetch answering all four Graph surfaces plus Anthropic.
 *
 * WHAT THE MAILBOX WILL ADMIT TO HOLDING. The conversation lookup serves a message only
 * once its delta page has arrived (`seen`) or if it is pre-existing history (`always`), so
 * a half that has not been delivered yet genuinely cannot be recovered - which is what
 * makes the cross-round case real rather than assumed. `always` models mail that predates
 * every delta page, which is how a legacy thread longer than one page exists at all.
 *
 * THE DELTA PAGE IS CHOSEN BY THE TOKEN, not by a counter: a round that does not commit
 * re-lists exactly the page it saw, which is what resumability means here.
 */
function provider ({ world: w, counts, state, draftFor }) {
  return async (url, init) => {
    const u = String(url)
    if (u === ANTHROPIC_MESSAGES_URL) {
      counts.model += 1
      const body = String(init?.body ?? '')
      counts.modelBodies.push(body)
      return modelResponse(draftFor(body))
    }
    const m = u.match(/\/me\/messages\/([^?]+)\?/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const env = w.envelopes[id]
      const select = qp(u, '$select') || ''
      if (select.indexOf('uniqueBody') < 0) {
        counts.envelopeGets.push(id)
        if (!env) {
          return { status: 404, headers: { get: () => null },
                   json: async () => ({ error: { code: 'ErrorItemNotFound' } }) }
        }
        return okRes({ ...env })
      }
      counts.bodies += 1
      counts.bodyIds.push(id)
      const text = w.bodies[id]
      if (!env || !text) return { status: 404, headers: { get: () => null }, json: async () => ({}) }
      return contentResponse(env, text)
    }
    const folder = u.indexOf('/mailFolders/inbox/') >= 0 ? 'inbox' : 'sentitems'
    const filter = qp(u, '$filter')
    if (filter !== null) {
      const convM = filter.match(/^conversationId eq '([^']*)'/)
      const conv = convM ? convM[1] : null
      const geM = filter.match(/(receivedDateTime|sentDateTime) ge (\S+)$/)
      const geProp = geM ? geM[1] : null
      const geAt = geM ? geM[2] : null
      const top = Number(qp(u, '$top')) || MAX_RECOVERY_MESSAGES_PER_FOLDER
      counts.lookups.push({ folder, conv, since: geAt, top,
        hasOrderBy: qp(u, '$orderby') !== null })
      const all = Object.values(w.envelopes)
        .filter((e) => e.conversationId === conv && w.folderOf[e.id] === folder)
        .filter((e) => state.always.has(e.id) || state.seen.has(e.id))
        .filter((e) => geAt === null || String(e[geProp] ?? '').localeCompare(geAt) >= 0)
        .sort((a, b) => String(a.sentDateTime).localeCompare(String(b.sentDateTime)))
      const page = { value: all.slice(0, top) }
      // REAL PAGE BEHAVIOUR: more than one page of history means @odata.nextLink, which
      // the recovery path refuses rather than following.
      if (all.length > top) {
        page['@odata.nextLink'] = `${GRAPH_BASE}/me/mailFolders/${folder}/messages?$skip=${top}`
      }
      return okRes(page)
    }
    // A delta page, chosen by the token the request carries.
    counts.delta += 1
    const tok = qp(u, '$deltatoken')
    const k = tok === null ? 0 : Number(String(tok).split('-').pop())
    const ids = (state.schedule[k] || []).filter((id) => w.folderOf[id] === folder)
    for (const id of ids) state.seen.add(id)
    return okRes({
      value: ids.map((id) => w.envelopes[id]),
      '@odata.deltaLink':
        `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$deltatoken=C${folder}-${k + 1}`,
    })
  }
}

// ── the run context, and one invocation ──────────────────────────────────────
function contextLoader ({ contacts, ring, cursors }) {
  return async () => ({
    primaryEmail: ME,
    aliases: [],
    timeZone: 'America/New_York',
    userId: U1,
    contacts,
    cursors,
    accessToken: 'injected-fixture-token',
    keyRing: ring,
    consentVersion: APPROVED,
  })
}

function ownContacts () {
  return rows(`SELECT id, user_id, email FROM public.contacts WHERE user_id='${U1}' ORDER BY id;`)
    .map(([id, user_id, email]) => ({ id, user_id, email }))
}

/** The committed cursors, read back from the DATABASE and decrypted - not remembered. */
async function committedCursors () {
  const got = rows(`SELECT folder, coalesce(delta_link_ciphertext,''), coalesce(delta_link_nonce,'')
                      FROM public.outlook_sync_state
                     WHERE connection_id = (SELECT id FROM public.microsoft_connections
                                             WHERE user_id='${U1}') ORDER BY folder;`)
  const out = { inbox: null, sentitems: null }
  for (const [folder, ct, nonce] of got) {
    if (!ct || !nonce) continue
    out[folder] = await decryptCursor(ct, nonce)
  }
  return out
}

function seed () {
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
        '${APPROVED}');
INSERT INTO public.contacts (user_id, name, email) VALUES ('${U1}', 'Ava Recruiter', '${KNOWN}');
`
}

/** Make the connection due again, the way the passage of time would. */
function makeDue () {
  psql(`UPDATE public.outlook_sync_state
           SET sync_status = 'idle', sync_run_id = NULL, sync_lease_until = NULL,
               run_started_at = NULL, last_attempt_at = NULL, last_success_at = NULL,
               next_retry_at = NULL, last_run_complete = false, retry_count = 0
         WHERE connection_id = (SELECT id FROM public.microsoft_connections
                                 WHERE user_id = '${U1}');`, { tuplesOnly: false })
}

/**
 * One invocation of the SHIPPED worker - the code on `main`, which has no knowledge of
 * threads or coverage - against the pre-migration database.
 *
 * WHY THIS EXISTS. A genuine legacy row is one the DEPLOYED worker wrote. This branch's run
 * module cannot write one: it calls get_outlook_thread_coverage, which does not exist before
 * the migration, and refuses the round - which is exactly why the documented rollout order
 * is migration BEFORE worker deploy. The shipped module is loaded from a git worktree so the
 * ports, fixtures and database are identical and the only difference is the code.
 */
let shippedRunOutlookImport = null
async function loadShippedRun () {
  if (shippedRunOutlookImport !== null) return shippedRunOutlookImport
  const dir = process.env.FUNNL_SHIPPED_WORKTREE
  assert.ok(dir, 'FUNNL_SHIPPED_WORKTREE must point at a worktree of the deployed revision')
  // A shell may hand this over as an MSYS path (/c/Users/...), which is not a Windows
  // absolute path and cannot become a file URL.
  const win = dir.replace(/^\/([a-zA-Z])\//, '$1:/')
  const file = join(win, 'supabase/functions/shared/outlookImportRun.js')
  const mod = await import(pathToFileURL(file).href)
  // If this ever stops being true the gate is testing the wrong code.
  const src = readFileSync(file, 'utf8')
  assert.ok(src.indexOf('get_outlook_thread_coverage') < 0,
    'the worktree is NOT pre-feature: it already knows about thread coverage')
  shippedRunOutlookImport = mod.runOutlookImport
  return shippedRunOutlookImport
}

async function shippedRound ({ world: w, counts, state, ring, draftFor: df, calls = [] }) {
  const shipped = await loadShippedRun()
  makeDue()
  const cursors = await committedCursors()
  const run = await shipped({
    rpc: workerRpc(calls),
    pilotUserId: U1,
    encryptCursor,
    decryptCursor,
    loadRunContext: contextLoader({ contacts: ownContacts(), ring, cursors }),
    anthropicApiKey: FIXTURE_KEY,
    requiredConsent: REQUIRED,
    requiredBackgroundConsent: APPROVED,
    deps: { fetchImpl: provider({ world: w, counts, state, draftFor: df }) },
  })
  return { run, report: summarizeRun(run), calls }
}

/** One invocation, with the committed cursors read from the database first. */
async function round ({ world: w, counts, state, ring, draftFor: df, hooks, calls = [] }) {
  makeDue()
  const cursors = await committedCursors()
  const run = await runOutlookImport({
    rpc: workerRpc(calls, hooks),
    pilotUserId: U1,
    encryptCursor,
    decryptCursor,
    loadRunContext: contextLoader({ contacts: ownContacts(), ring, cursors }),
    anthropicApiKey: FIXTURE_KEY,
    requiredConsent: REQUIRED,
    requiredBackgroundConsent: APPROVED,
    deps: { fetchImpl: provider({ world: w, counts, state, draftFor: df }) },
  })
  return { run, report: summarizeRun(run), calls }
}

// ── reading what the database actually holds ─────────────────────────────────
const refRows = () => rows(`
  SELECT CASE WHEN interaction_candidate_id IS NOT NULL THEN 'interaction' ELSE 'new_contact' END,
         coalesce(conversation_fingerprint,'-'),
         coalesce(array_length(covered_message_fingerprints, 1), 0),
         coalesce(coverage_source, '-'),
         episode_fingerprint
    FROM public.outlook_candidate_refs WHERE user_id='${U1}'
   ORDER BY created_at;`)

const coveredFor = (cfp) => (one(`
  SELECT coalesce(array_to_string(covered_message_fingerprints, ','), '')
    FROM public.outlook_candidate_refs
   WHERE user_id='${U1}' AND conversation_fingerprint='${cfp}' LIMIT 1;`) || '')
  .split(',').filter(Boolean)

const pendingInteractions = () => rows(`
  SELECT id, status, left(coalesce(proposed_notes,''), 10), source_fingerprint
    FROM public.interaction_candidates WHERE user_id='${U1}' ORDER BY created_at;`)

const pendingNewContacts = () => rows(`
  SELECT id, status, left(coalesce(draft_summary,''), 10), episode_fingerprint
    FROM public.new_contact_candidates WHERE user_id='${U1}' ORDER BY created_at;`)

// The note is multi-line by design, and psql -At would split one row across lines, so the
// newlines are folded for reading. The FULL note is compared by length and digest, which is
// what "unchanged" has to mean for reviewer-edited text.
const storedInteractions = () => rows(`
  SELECT id, type, interaction_date::text, length(notes), md5(notes),
         replace(replace(coalesce(notes,''), E'
', ''), E'
', ' / ')
    FROM public.interactions WHERE user_id='${U1}' ORDER BY created_at;`)

function teardown () {
  quiet(['rm', '-f', REST]); quiet(['rm', '-f', PG]); quiet(['network', 'rm', NET])
}

// ── the notes the fixture model returns, keyed on the BODY TAGS the request carries ──
const NOTES = {
  FIRST: 'FIRST-NOTE She put your name forward for the spring insight week and asked for a '
    + 'short call about the credit desk. She said the team values candidates who can talk a '
    + 'trade idea through end to end. You agreed to send your availability. Left open: who '
    + 'joins the call.',
  LATER: 'LATER-NOTE She confirmed a spring opening on the credit desk and proposed Thursday '
    + 'at three. She asked you to prepare two questions about the desk and to bring the '
    + 'modelling example you described. You accepted the time. Left open: whether the desk '
    + 'head joins.',
  THIRD: 'THIRD-NOTE She passed on the feedback after the call and suggested a follow-up in '
    + 'the new year once the spring headcount is confirmed. You agreed to send a short '
    + 'thank-you note first. Left open: the exact headcount date.',
}

function draftFor (body) {
  const isNew = body.indexOf('new_contact_suggestion') >= 0
  const which = /THIRD-/.test(body) ? 'THIRD' : /LATER-/.test(body) ? 'LATER' : 'FIRST'
  const base = {
    summary: NOTES[which],
    summary_evidence: 'explicit_body',
    follow_up: 'Send the availability and prepare the questions.',
    interaction_date: null,
  }
  return isNew
    ? { result: 'new_contact_suggestion', name: 'Priya Nair',
        name_evidence: 'explicit_signature', name_confidence: 'high', ...base }
    : { result: 'interaction_draft', ...base }
}

/** Accept a pending interaction suggestion through the REAL acceptance RPC, as the user. */
async function acceptInteraction (id, notes) {
  const r = await http('POST', '/rpc/accept_interaction_candidate', {
    token: TOK.u1(),
    body: { p_candidate_id: id, p_override_notes: notes ?? null, p_follow_up_date: null },
  })
  assert.strictEqual(r.status, 200, 'accept_interaction_candidate: ' + r.raw.slice(0, 160))
  return r.body
}

/** Accept a pending new-contact proposal through the REAL acceptance RPC, as the user. */
async function acceptNewContact (id, { name, notes }) {
  const r = await http('POST', '/rpc/accept_new_contact_candidate', {
    token: TOK.u1(),
    // The reviewed note reaches the interaction through p_interaction_notes - this RPC
    // creates the contact AND the interaction, so the note is the interaction's own.
    body: { p_candidate_id: id, p_name: name, p_create_interaction: true,
            p_interaction_notes: notes ?? null },
  })
  assert.strictEqual(r.status, 200, 'accept_new_contact_candidate: ' + r.raw.slice(0, 160))
  return r.body
}

async function main () {
  console.log('\nbuilding a disposable Postgres + PostgREST')
  teardown()
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', 'POSTGRES_PASSWORD=disposable', PG_IMAGE])
  waitForPg()
  psql(readFileSync(join(ROOT, 'tests/sql/_bootstrap-disposable-db.sql'), 'utf8'),
    { user: 'supabase_admin', tuplesOnly: false })
  const all = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  // GATE 1 NEEDS A PRE-FEATURE DATABASE. Everything except the segments migration is
  // applied now; that one is applied only after a proposal has been written and accepted by
  // the SHIPPED producer, which is the only way a genuine legacy row comes to exist.
  const before = all.filter((f) => f !== SEGMENTS_MIGRATION)
  assert.strictEqual(before.length, all.length - 1, 'the segments migration must be present to hold back')
  for (const m of before) {
    psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'), { tuplesOnly: false })
  }
  console.log(`  applied ${before.length} migrations; ${SEGMENTS_MIGRATION} HELD BACK`)
  const tables = num(`SELECT count(*) FROM information_schema.tables
                       WHERE table_schema='public' AND table_type='BASE TABLE';`)
  assert.ok(tables >= 23, `only ${tables} tables were built - the schema is partial`)

  psql("ALTER ROLE authenticator WITH PASSWORD 'disposable';", { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', '53995:3000',
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/'); if (r.status < 500) break } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
          select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $fn$;`,
  { user: 'supabase_admin', tuplesOnly: false })
  console.log('  PostgREST is serving')

  const applySegments = () => {
    psql(readFileSync(join(ROOT, 'supabase/migrations', SEGMENTS_MIGRATION), 'utf8'),
      { tuplesOnly: false })
    psql("NOTIFY pgrst, 'reload schema';", { tuplesOnly: false })
    sleepSync(2000)
  }

  const ctx = { applySegments, test, state: null }
  const mod = await import('./outlook-thread-segments-scenarios.mjs')
  await mod.run({
    test, psql, one, num, rows, thread, world, newCounts, round, makeDue, seed, ownContacts,
    refRows, coveredFor, pendingInteractions, pendingNewContacts, storedInteractions,
    RING_V1, RING_V2, draftFor, NOTES, applySegments, acceptInteraction, acceptNewContact,
    http, TOK, U1, ME, KNOWN, STRANGER, LEGACY_NEW, LONG_NEW,
    MAX_RECOVERY_MESSAGES_PER_FOLDER,
    assert, SEGMENTS_MIGRATION, shippedRound,
  })
  void ctx

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
  teardown()
  if (failed > 0) process.exit(1)
}

try { await main() } catch (e) { console.error('\nHARNESS ERROR: ' + (e?.message ?? e)); teardown(); process.exit(1) }
