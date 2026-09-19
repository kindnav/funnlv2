// Source-invariant tests for Gmail retention cleanup PR-A:
//   * 20260918000000_add_gmail_retention_cleanup.sql  (atomic whole-Google cleanup RPC,
//     bounded index-backed expiry, partial index)
//   * the tombstone-retention decision (minimal terminal candidate + one-way HMAC
//     fingerprint persist until contact/account deletion; nothing else survives)
//
// SCOPE NOTE: this suite covers ONLY the files shipped in PR-A. The assertions for the
// later phases — the pg_cron migration (20260918000100, held back to the final rollout
// step) and shared/googleCleanup.js + its two Edge callers (PR-B) — are packaged with
// those files when their PRs are prepared; the complete combined suite lives on the
// local staging branch until then.
//
// HONESTY NOTE: these are STATIC SOURCE-SCAN assertions over SQL/JS/TS text. They do
// not execute PostgreSQL. Runtime behavior (atomicity, ownership, grants, RLS, cascades,
// SKIP LOCKED overlap, index use) is validated by tests/sql/gmail-retention-runtime.sql
// replayed on a disposable local Supabase stack — see docs/gmail-privacy-readiness.md.
//
// Run: node tests/gmail-retention-invariants.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const RET_MIG = read('supabase/migrations/20260918000000_add_gmail_retention_cleanup.sql')
const CAL_MIG = read('supabase/migrations/20260817000000_add_calendar_ingestion.sql')
const E2A_MIG = read('supabase/migrations/20260907000000_add_gmail_transport_foundation.sql')
const E2B_MIG = read('supabase/migrations/20260910000000_add_gmail_worker_primitives.sql')
const RET = stripSql(RET_MIG)
const GMAIL_WORKER = stripJs(read('supabase/functions/shared/gmailWorker.js'))
const POLICY = read('src/pages/PrivacyPage.jsx')
const ALL_MIGS = ['20260817000000_add_calendar_ingestion.sql', '20260823074250_add_calendar_reconciliation.sql',
  '20260825002308_add_calendar_candidate_review_rpcs.sql', '20260829002747_add_interaction_source.sql',
  '20260907000000_add_gmail_transport_foundation.sql', '20260910000000_add_gmail_worker_primitives.sql',
  '20260918000000_add_gmail_retention_cleanup.sql']
  .map((f) => stripSql(read('supabase/migrations/' + f))).join('\n')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}
const fnBody = (code, name) => {
  const m = code.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`))
  assert.ok(m, `function ${name} present`)
  return m[0]
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nretention migration — shape')
test('forward-only: no table/column/policy/constraint change; one partial index; no apply-time DML', () => {
  for (const re of [/CREATE TABLE/, /ALTER TABLE/, /DROP TABLE/, /DROP COLUMN/, /ADD COLUMN/, /CREATE POLICY/, /DROP POLICY/, /DROP CONSTRAINT/, /ADD CONSTRAINT/, /DROP INDEX/]) {
    assert.ok(!re.test(RET), `must not contain ${re}`)
  }
  assert.strictEqual((RET.match(/CREATE INDEX/g) || []).length, 1)
  const topLevel = RET.replace(/AS \$\$[\s\S]*?\$\$;/g, 'AS <BODY>;')
  assert.strictEqual((topLevel.match(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\s/gmi) || []).length, 0)
})
test('no migration repair, no --linked, no dynamic SQL, no provider/HTTP call, no scheduler in the retention migration', () => {
  assert.ok(!/migration repair|--linked/.test(RET_MIG))
  assert.ok(!/EXECUTE\s+'/.test(RET) && !/EXECUTE\s+format/.test(RET) && !/\bformat\(/.test(RET))
  assert.ok(!/gmail\.googleapis|googleapis\.com|pg_net|net\.http|http_post|webhook|fetch\(/i.test(RET))
  assert.ok(!/pg_cron|cron\.schedule/i.test(RET), 'the Cron job lives in its own later migration')
})
test('exactly two functions, both SECURITY DEFINER with empty search_path, both service_role only', () => {
  const fns = RET.match(/CREATE FUNCTION public\.\w+[\s\S]*?\$\$;/g) || []
  assert.strictEqual(fns.length, 2)
  for (const f of fns) {
    const name = f.match(/FUNCTION public\.(\w+)/)[1]
    assert.ok(/SECURITY DEFINER/.test(f), `${name} SECURITY DEFINER`)
    assert.ok(/SET search_path = ''/.test(f), `${name} empty search_path`)
  }
  for (const f of ['expire_pending_email_context\\(integer\\)', 'run_google_local_cleanup\\(uuid\\)']) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f} FROM PUBLIC, anon, authenticated`).test(RET), `${f} revoke`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f} TO service_role`).test(RET), `${f} grant`)
  }
  assert.ok(!/TO authenticated/.test(RET) && !/TO anon/.test(RET), 'nothing granted to a browser role')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nbounded expiry')
test('the unbounded zero-arg overload is DROPPED before the bounded one is CREATED (no leftover overload)', () => {
  const drop = RET.indexOf('DROP FUNCTION IF EXISTS public.expire_pending_email_context()')
  const create = RET.indexOf('CREATE FUNCTION public.expire_pending_email_context(p_batch_size integer DEFAULT 500)')
  assert.ok(drop >= 0 && create > drop)
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.expire_pending_email_context/.test(RET))
})
test('expiry touches only pending rows past their deadline, bounded, ordered, SKIP LOCKED, and keeps the tombstone', () => {
  const b = fnBody(RET, 'expire_pending_email_context')
  assert.ok(/status = 'pending'/.test(b))
  assert.ok(/context_expires_at IS NOT NULL/.test(b) && /context_expires_at <= now\(\)/.test(b))
  assert.ok(/ORDER BY context_expires_at, id/.test(b), 'deterministic order')
  assert.ok(/LIMIT p_batch_size/.test(b), 'bounded')
  assert.ok(/FOR UPDATE SKIP LOCKED/.test(b), 'overlap-safe')
  assert.ok(/p_batch_size < 1 OR p_batch_size > 5000/.test(b), 'batch bound validated')
  assert.ok(/SET retained_subject\s*=\s*NULL,\s*context_expires_at\s*=\s*NULL/.test(b), 'erases only the context fields')
  assert.ok(!/status\s*=\s*'(invalidated|dismissed|accepted)'/.test(b.replace(/WHERE[\s\S]*?(?=ORDER|\)|$)/g, '')), 'never changes status')
  assert.ok(!/source_fingerprint|contact_id|interaction_id/.test(b), 'never touches the tombstone/link columns')
  assert.ok(!/DELETE/.test(b), 'never deletes a candidate row')
  assert.ok(!/public\.interactions\b/.test(b), 'never touches accepted interactions')
  assert.ok(!/gmail|google|http|net\./i.test(b.replace(/expire_pending_email_context/g, '')), 'never references a provider')
})
test('expiry returns controlled codes and counts only (no subject, id, or user data)', () => {
  const b = fnBody(RET, 'expire_pending_email_context')
  assert.ok(/'result',\s*'ok'/.test(b) && /'expired',\s*v_n/.test(b) && /'more',\s*v_more/.test(b) && /'invalid_batch_size'/.test(b))
  assert.ok(!/RAISE|retained_subject\s*\|\||jsonb_agg|array_agg/.test(b))
})
test('the partial index matches the expiry predicate and order', () => {
  assert.ok(/CREATE INDEX IF NOT EXISTS interaction_candidates_pending_context_expiry_idx\s+ON public\.interaction_candidates \(context_expires_at, id\)\s+WHERE status = 'pending' AND context_expires_at IS NOT NULL/.test(RET))
})
test('no runtime code calls the expiry (it is scheduler-only); the worker never calls it', () => {
  for (const p of ['supabase/functions/gmail-sync-worker/index.ts', 'supabase/functions/shared/gmailWorker.js', 'supabase/functions/google-calendar-sync/index.ts', 'supabase/functions/google-oauth-callback/index.ts']) {
    assert.ok(!/expire_pending_email_context/.test(read(p)), `${p} must not call the expiry`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nwhole-Google disconnect — atomic cleanup RPC')
test('run_google_local_cleanup invalidates ONLY pending Gmail candidates of the given user and erases both context fields', () => {
  const b = fnBody(RET, 'run_google_local_cleanup')
  const upd = b.match(/UPDATE public\.interaction_candidates[\s\S]*?ROW_COUNT;/)[0]
  assert.ok(/SET status\s*=\s*'invalidated'/.test(upd))
  assert.ok(/retained_subject\s*=\s*NULL/.test(upd) && /context_expires_at\s*=\s*NULL/.test(upd))
  assert.ok(/WHERE user_id = p_user_id\s+AND source\s*=\s*'gmail'\s+AND status\s*=\s*'pending'/.test(upd), 'user + gmail + pending predicate')
  assert.ok(!/source_fingerprint|contact_id|interaction_id/.test(upd), 'tombstone and links untouched')
})
test('cleanup order: candidates first, then oauth states, then the connection — one transaction, no DELETE of candidates or interactions', () => {
  const b = fnBody(RET, 'run_google_local_cleanup')
  const i1 = b.indexOf('UPDATE public.interaction_candidates')
  const i2 = b.indexOf('DELETE FROM public.google_oauth_states WHERE user_id = p_user_id')
  const i3 = b.indexOf('DELETE FROM public.google_connections WHERE user_id = p_user_id')
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2)
  assert.ok(!/DELETE FROM public\.interaction_candidates|DELETE FROM public\.interactions|DELETE FROM public\.email_candidate_refs/.test(b))
  assert.ok(!/COMMIT|ROLLBACK|START TRANSACTION/.test(b), 'no explicit transaction control (the function IS the transaction)')
  assert.ok(!/google_tokens|google_connection_capabilities|gmail_sync_state/.test(b), 'cascades do that work exactly as before')
})
test('ownership: only p_user_id (from the verified JWT) scopes every statement; NULL is refused; no auth.uid() (service path)', () => {
  const b = fnBody(RET, 'run_google_local_cleanup')
  assert.ok(/IF p_user_id IS NULL THEN\s+RETURN jsonb_build_object\('result', 'invalid_user'\)/.test(b))
  assert.strictEqual((b.match(/= p_user_id/g) || []).length, 3, 'all three statements scoped by the user id')
  assert.ok(!/auth\.uid\(\)/.test(b))
})
test('idempotent + controlled result: returns counts only', () => {
  const b = fnBody(RET, 'run_google_local_cleanup')
  assert.ok(/'result',\s*'cleaned'/.test(b) && /'gmail_candidates_invalidated',\s*v_cands/.test(b))
  assert.ok(!/RAISE EXCEPTION/.test(b), 'nothing to clean is not an error')
})

test('Gmail-only disconnect (disconnect_my_gmail) is unchanged and remains the user-callable path', () => {
  const b = fnBody(stripSql(E2B_MIG), 'disconnect_my_gmail')
  assert.ok(/auth\.uid\(\)/.test(b) && /AND product\s+= 'gmail'/.test(b) && /DELETE FROM public\.gmail_sync_state/.test(b))
  assert.ok(!/disconnect_my_gmail/.test(RET), 'the retention migration does not redefine it')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\ntombstone retention decision')
test('no migration ever DELETEs a candidate row (tombstones persist until contact/account deletion via cascades)', () => {
  const bodies = ALL_MIGS.replace(/AS \$\$([\s\S]*?)\$\$;/g, (_, b) => b)
  assert.ok(!/DELETE FROM public\.interaction_candidates/.test(bodies))
  assert.ok(!/DELETE FROM public\.email_candidate_refs/.test(bodies))
  assert.ok(/contact_id\s+uuid\s+NOT NULL REFERENCES public\.contacts\(id\) ON DELETE CASCADE/.test(CAL_MIG), 'contact deletion cascades the tombstone')
  assert.ok(/user_id\s+uuid\s+NOT NULL REFERENCES auth\.users\(id\)\s+ON DELETE CASCADE/.test(CAL_MIG), 'account deletion cascades the tombstone')
  assert.ok(/candidate_id\s+uuid\s+PRIMARY KEY\s+REFERENCES public\.interaction_candidates\(id\) ON DELETE CASCADE/.test(E2A_MIG), 'refs follow the candidate')
})
test('every subject-erasing path preserves source_fingerprint (accept, dismiss, invalidate, gmail disconnect, whole-Google cleanup, expiry)', () => {
  const paths = [
    fnBody(stripSql(E2A_MIG), 'accept_interaction_candidate'),
    fnBody(stripSql(E2A_MIG), 'dismiss_interaction_candidate'),
    fnBody(stripSql(E2B_MIG), 'invalidate_email_candidates_by_fingerprint'),
    fnBody(stripSql(E2B_MIG), 'disconnect_my_gmail'),
    fnBody(RET, 'run_google_local_cleanup'),
    fnBody(RET, 'expire_pending_email_context'),
  ]
  for (const b of paths) {
    const name = b.match(/FUNCTION public\.(\w+)/)[1]
    assert.ok(/retained_subject\s*=\s*NULL/.test(b), `${name} erases the subject`)
    // Every UPDATE ... SET list (the plpgsql header's `SET search_path` is excluded).
    for (const m of b.matchAll(/UPDATE public\.\w+(?:\s+AS\s+\w+|\s+\w+)?\s+SET\s+([\s\S]*?)\s+(?:WHERE|FROM)\b/g)) {
      assert.ok(!/source_fingerprint/.test(m[1]), `${name} never rewrites the fingerprint`)
    }
    assert.ok(!/DELETE FROM public\.interaction_candidates/.test(b), `${name} never deletes the row`)
  }
})
test('the terminal tombstone can hold nothing but: fingerprint, status, type/date/notes proposal, contact link, timestamps', () => {
  // Every column ever added to interaction_candidates across all migrations.
  const cols = new Set()
  const createBlock = CAL_MIG.match(/CREATE TABLE public\.interaction_candidates \(([\s\S]*?)\n\);/)[1]
  for (const line of createBlock.split('\n')) {
    const m = line.match(/^\s+([a-z_]+)\s+(uuid|text|date|timestamptz|boolean|smallint|integer)\b/)
    if (m) cols.add(m[1])
  }
  for (const m of ALL_MIGS.matchAll(/ALTER TABLE public\.interaction_candidates\s+ADD COLUMN IF NOT EXISTS\s+([a-z_]+)/g)) cols.add(m[1])
  for (const m of ALL_MIGS.matchAll(/ADD COLUMN IF NOT EXISTS\s+([a-z_]+)\s+(?:text|timestamptz)[^;]*?;/g)) cols.add(m[1])
  const allowed = new Set(['id', 'user_id', 'contact_id', 'source', 'source_fingerprint', 'proposed_type', 'proposed_interaction_date',
    'proposed_notes', 'status', 'interaction_id', 'source_last_state', 'created_at', 'updated_at', 'retained_subject', 'context_expires_at'])
  for (const c of cols) assert.ok(allowed.has(c), `unexpected column on interaction_candidates: ${c}`)
  for (const c of cols) assert.ok(!/message_id|thread_id|history_id|header|snippet|body|attachment|address|from_|to_|sender|recipient|token|raw/.test(c), `provider data column: ${c}`)
  // email_candidate_refs likewise: only fingerprint + key version + coarse provenance.
  const refs = E2A_MIG.match(/CREATE TABLE public\.email_candidate_refs \(([\s\S]*?)\n\);/)[1]
  const refCols = [...refs.matchAll(/^\s+([a-z_]+)\s+(uuid|text|smallint|timestamptz)\b/gm)].map((m) => m[1])
  assert.deepStrictEqual(refCols.sort(), ['candidate_id', 'connection_id', 'created_at', 'key_version', 'provider', 'source_fingerprint', 'updated_at', 'user_id'])
})
test('browser roles cannot select the fingerprint or context deadline; refs/cursor tables have no browser grant at all', () => {
  const grant = CAL_MIG.match(/GRANT SELECT \(([\s\S]*?)\) ON TABLE public\.interaction_candidates TO authenticated;/)[1]
  assert.ok(!/source_fingerprint|user_id|interaction_id/.test(grant))
  const laterGrants = [...(E2A_MIG + E2B_MIG + RET_MIG).matchAll(/GRANT SELECT \(([^)]*)\) ON TABLE public\.interaction_candidates TO authenticated/g)].map((m) => m[1])
  assert.deepStrictEqual(laterGrants, ['retained_subject'], 'only retained_subject was added for the review UI')
  assert.ok(!/context_expires_at\)?\s+ON TABLE public\.interaction_candidates TO authenticated/.test(E2A_MIG + E2B_MIG + RET_MIG))
  assert.ok(/REVOKE ALL ON TABLE public\.email_candidate_refs FROM authenticated;[\s\S]*?GRANT ALL\s+ON TABLE public\.email_candidate_refs TO service_role;/.test(E2A_MIG))
  assert.ok(!/GRANT[^;]*ON TABLE public\.email_candidate_refs TO (authenticated|anon)/.test(E2A_MIG + E2B_MIG + RET_MIG))
  assert.ok(!/GRANT/.test(RET.replace(/GRANT EXECUTE ON FUNCTION[^;]*;/g, '')), 'the retention migration adds no table grant')
})
test('the worker still never persists provider ids/headers (tombstone content cannot regress via the worker)', () => {
  assert.ok(!/message_id:|thread_id:|threadId:|messageId:|snippet|payload\.headers|raw:/.test(GMAIL_WORKER.match(/upsert_email_candidate[\s\S]{0,600}/g)?.join('') || ''))
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nconsistency with the published Privacy Policy')
test('policy still makes NO 30-day promise (no expiry scheduler is applied in Production)', () => {
  assert.ok(!/30 days/.test(POLICY))
})
test('policy wording for whole-Google disconnect now matches run_google_local_cleanup (PUBLICATION GATE: publish only after PR-B deploys the caller)', () => {
  assert.ok(/deletes the stored Google tokens and the Google connection from Funnl, together with the connection's capability, cursor, and reference records/.test(POLICY))
  // The pre-correction sentence must never return.
  assert.ok(!/Pending Gmail suggestions are not removed by this path/.test(POLICY), 'old wording removed')
  // Corrected wording (prepared on docs/gmail-whole-google-disconnect-erasure): erased on that path,
  // tombstone + fingerprint retained until contact/account deletion.
  assert.ok(/Funnl removes pending Gmail suggestions from your active Suggestions and erases their retained subject lines and context/.test(POLICY))
  assert.ok(/The minimal terminal suggestion record and its one-way fingerprint remain only to prevent the same conversation from being suggested again, and are deleted when you delete the related contact or your account/.test(POLICY))
  assert.ok(/SET status\s*=\s*'invalidated'/.test(fnBody(RET, 'run_google_local_cleanup')), 'the applied RPC does exactly that')
  // Not asserted here: that the deployed Edge helper already calls the RPC. Until PR-B is deployed the
  // corrected text must stay unpublished (the live system would erase LESS than the text promises).
})
test('policy fingerprint-retention sentence matches the decision (until contact or account deletion)', () => {
  assert.ok(/its record \(without the subject line\) and its fingerprint remain so the conversation is not suggested again\. They are deleted when you delete the contact they concern or delete your account/.test(POLICY))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
