// Source-invariant tests for the E2A Gmail transport foundation migration + adapter.
//
// HONESTY NOTE: these are STATIC SOURCE-SCAN assertions over the migration SQL text
// and the pure adapter. They do NOT execute against PostgreSQL: they do not prove
// runtime RLS, lease-race atomicity, or cursor semantics at execution time (that is
// validated only when the migration is replayed on a disposable local stack in the
// validation step). They assert the SQL/files are SHAPED correctly (tables, columns,
// constraints, RLS toggles, REVOKE/GRANT hardening, RPC guards, cursor-on-complete)
// and that no out-of-scope feature (live gmail scope, Edge Function, scheduler,
// webhook, UI, secret, prohibited provider column) leaked in.
//
// Run: node tests/gmail-migration-invariants.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MIG = readFileSync(join(ROOT, 'supabase/migrations/20260907000000_add_gmail_transport_foundation.sql'), 'utf8')
const ADAPTER = readFileSync(join(ROOT, 'supabase/functions/shared/gmailTransport.js'), 'utf8')

function stripSql(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}
const CODE = stripSql(MIG)

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}
const has = (re) => re.test(CODE)

console.log('\nsource / integration constraint widening (additive, data preserved)')
test('interaction_candidates source widened to gmail+outlook (keeps google_calendar)', () => {
  assert.ok(/interaction_candidates_source_check[\s\S]*?CHECK \(source IN \('google_calendar', 'gmail', 'outlook'\)\)/.test(CODE))
})
test('interactions source widened to include manual+google_calendar+gmail+outlook', () => {
  assert.ok(/interactions_source_check[\s\S]*?CHECK \(source IN \('manual', 'google_calendar', 'gmail', 'outlook'\)\)/.test(CODE))
})
test('google_oauth_states integration widened to calendar+gmail', () => {
  assert.ok(/google_oauth_states_integration_check[\s\S]*?CHECK \(integration_type IN \('calendar', 'gmail'\)\)/.test(CODE))
})
test('constraints are DROP IF EXISTS + ADD (does not edit an applied migration)', () => {
  assert.ok(/DROP CONSTRAINT IF EXISTS interaction_candidates_source_check/.test(CODE))
  assert.ok(/DROP CONSTRAINT IF EXISTS interactions_source_check/.test(CODE))
})

console.log('\ncapability table')
test('google_connection_capabilities: table + RLS + hardening + policy', () => {
  assert.ok(has(/CREATE TABLE public\.google_connection_capabilities/))
  assert.ok(has(/ALTER TABLE public\.google_connection_capabilities ENABLE ROW LEVEL SECURITY/))
  assert.ok(has(/REVOKE ALL ON TABLE public\.google_connection_capabilities FROM authenticated/))
  assert.ok(has(/GRANT SELECT \([\s\S]*?\) ON TABLE public\.google_connection_capabilities TO authenticated/))
  assert.ok(has(/GRANT ALL ON TABLE public\.google_connection_capabilities TO service_role/))
  assert.ok(has(/CREATE POLICY "gcc_select_own"[\s\S]*?USING \(\(SELECT auth\.uid\(\)\) = user_id\)/))
  assert.ok(has(/gcc_connection_product_unique UNIQUE \(connection_id, product\)/))
  assert.ok(has(/gcc_product_check\s+CHECK \(product IN \('calendar', 'gmail'\)\)/))
})
test('capability table has NO token/secret columns', () => {
  const block = CODE.match(/CREATE TABLE public\.google_connection_capabilities[\s\S]*?\);/)[0]
  for (const bad of ['ciphertext', 'nonce', 'refresh', 'access_token', 'history_id']) {
    assert.ok(!new RegExp(bad).test(block), `capability table must not contain ${bad}`)
  }
})

console.log('\ngmail_sync_state (service-role only; cursor hidden)')
test('gmail_sync_state: RLS on, NO authenticated grant, service_role only', () => {
  assert.ok(has(/CREATE TABLE public\.gmail_sync_state/))
  assert.ok(has(/ALTER TABLE public\.gmail_sync_state ENABLE ROW LEVEL SECURITY/))
  assert.ok(has(/REVOKE ALL ON TABLE public\.gmail_sync_state FROM authenticated/))
  assert.ok(has(/GRANT ALL\s+ON TABLE public\.gmail_sync_state TO service_role/))
  // No GRANT of any kind to authenticated and no policy for the sync-state table.
  assert.ok(!/GRANT[^;]*public\.gmail_sync_state[^;]*TO authenticated/.test(CODE))
  assert.ok(!/CREATE POLICY[^;]*ON public\.gmail_sync_state/.test(CODE))
})
test('gmail_sync_state has running-requires-lease + unique(connection)', () => {
  assert.ok(has(/gss2_running_requires_lease[\s\S]*?sync_status <> 'running' OR \(sync_run_id IS NOT NULL AND sync_lease_until IS NOT NULL\)/))
  assert.ok(has(/gss2_connection_unique UNIQUE \(connection_id\)/))
})

console.log('\nemail_candidate_refs (service-role only; no raw provider data)')
test('email_candidate_refs: RLS, no anon/authenticated grant, service_role only', () => {
  assert.ok(has(/CREATE TABLE public\.email_candidate_refs/))
  assert.ok(has(/ALTER TABLE public\.email_candidate_refs ENABLE ROW LEVEL SECURITY/))
  assert.ok(has(/REVOKE ALL ON TABLE public\.email_candidate_refs FROM anon/))
  assert.ok(has(/REVOKE ALL ON TABLE public\.email_candidate_refs FROM authenticated/))
  assert.ok(!/GRANT[^;]*public\.email_candidate_refs[^;]*TO (anon|authenticated)/.test(CODE))
  assert.ok(!/CREATE POLICY[^;]*ON public\.email_candidate_refs/.test(CODE))
})
test('email_candidate_refs stores HMAC fingerprint + key version, NO raw provider fields', () => {
  const block = CODE.match(/CREATE TABLE public\.email_candidate_refs[\s\S]*?\);/)[0]
  assert.ok(/source_fingerprint\s+text/.test(block))
  assert.ok(/ecr_fingerprint_shape\s+CHECK \(source_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(block))
  assert.ok(/key_version\s+smallint/.test(block))
  // Address-bearing / content / raw-id column names must be absent (the table name
  // itself legitimately contains "email", so we target column-name tokens).
  for (const bad of ['message_id', 'thread_id', 'history_id', 'email_address', 'from_address', 'sender', 'recipient', 'subject', 'body', 'snippet', 'ciphertext', 'nonce']) {
    assert.ok(!new RegExp(bad).test(block), `email_candidate_refs must not contain ${bad}`)
  }
})

console.log('\nretained-context columns')
test('interaction_candidates gains retained_subject(<=160) + context_expires_at', () => {
  assert.ok(has(/ADD COLUMN IF NOT EXISTS retained_subject\s+text/))
  assert.ok(has(/ADD COLUMN IF NOT EXISTS context_expires_at timestamptz/))
  assert.ok(has(/interaction_candidates_retained_subject_len[\s\S]*?char_length\(retained_subject\) <= 160/))
})

console.log('\nRPC hardening (every function)')
test('every CREATE FUNCTION is SECURITY DEFINER + SET search_path = ""', () => {
  const fns = CODE.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) || []
  assert.ok(fns.length >= 6, `expected >=6 functions, saw ${fns.length}`)
  for (const f of fns) {
    const name = (f.match(/FUNCTION public\.(\w+)/) || [])[1]
    assert.ok(/SECURITY DEFINER/.test(f), `${name} must be SECURITY DEFINER`)
    assert.ok(/SET search_path = ''/.test(f), `${name} must set empty search_path`)
  }
})
test('no dynamic SQL anywhere', () => {
  assert.ok(!/EXECUTE\s+'/.test(CODE) && !/EXECUTE\s+format/.test(CODE) && !/\bformat\(/.test(CODE))
})
test('service-only RPCs revoke authenticated + grant service_role only', () => {
  for (const fn of ['claim_gmail_sync_lease', 'renew_gmail_sync_lease', 'release_gmail_sync_lease', 'upsert_email_candidate', 'reconcile_email_episode', 'expire_pending_email_context']) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`).test(CODE), `${fn} must revoke authenticated`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`).test(CODE), `${fn} must grant service_role`)
  }
})
test('user RPCs (accept/dismiss) grant authenticated, revoke anon', () => {
  for (const fn of ['accept_interaction_candidate', 'dismiss_interaction_candidate']) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`).test(CODE))
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`).test(CODE))
  }
})
test('cursor (history_id) advances ONLY on a complete run', () => {
  const rel = CODE.match(/FUNCTION public\.release_gmail_sync_lease[\s\S]*?\$\$;/)[0]
  assert.ok(/history_id\s+= CASE WHEN COALESCE\(p_run_complete, false\) AND p_history_id IS NOT NULL/.test(rel))
})
test('deterministic lock order: sync-state FOR SHARE before candidate writes', () => {
  for (const fn of ['upsert_email_candidate', 'reconcile_email_episode']) {
    const body = CODE.match(new RegExp(`FUNCTION public\\.${fn}[\\s\\S]*?\\$\\$;`))[0]
    assert.ok(/FOR SHARE OF s/.test(body), `${fn} must lock sync-state FOR SHARE first`)
  }
})
test('accept erases retained context + is source-aware; never copies subject into interaction', () => {
  const acc = CODE.match(/FUNCTION public\.accept_interaction_candidate[\s\S]*?\$\$;/)[0]
  assert.ok(/retained_subject = NULL/.test(acc))
  assert.ok(/INSERT INTO public\.interactions[\s\S]*?source\)/.test(acc))
  assert.ok(/v_src := CASE WHEN v_cand\.source IN \('google_calendar',\s*'gmail',\s*'outlook'\)/.test(acc))
  // The interaction INSERT uses v_notes (user-reviewed), NOT retained_subject.
  assert.ok(!/VALUES \([^)]*retained_subject/.test(acc))
})
test('dismiss erases retained context', () => {
  const dis = CODE.match(/FUNCTION public\.dismiss_interaction_candidate[\s\S]*?\$\$;/)[0]
  assert.ok(/status = 'dismissed'[\s\S]*?retained_subject = NULL/.test(dis))
})

console.log('\nproduction-readiness corrections')
test('retained_subject IS readable by authenticated (review UI); context_expires_at is NOT', () => {
  assert.ok(has(/GRANT SELECT \(retained_subject\) ON TABLE public\.interaction_candidates TO authenticated/))
  assert.ok(!/GRANT SELECT \([^)]*context_expires_at[^)]*\) ON TABLE public\.interaction_candidates TO authenticated/.test(CODE))
})
test('upsert_email_candidate dedups across prior-key fingerprints (rotation safe)', () => {
  const up = CODE.match(/FUNCTION public\.upsert_email_candidate[\s\S]*?\$\$;/)[0]
  assert.ok(/p_lookup_fingerprints text\[\]/.test(up), 'lookup-fingerprints param present')
  assert.ok(/source_fingerprint = ANY \(/.test(up), 'dedups across the fingerprint set')
  assert.ok(/array_append\(COALESCE\(p_lookup_fingerprints/.test(up))
  assert.ok(/exists_terminal/.test(up), 'terminal tombstone never resurrected')
  // The refresh UPDATE block must NOT rewrite the stored historical fingerprint.
  const refreshBlock = up.match(/IF v_status <> 'pending'[\s\S]*?'refreshed'\);/)[0]
  assert.ok(!/source_fingerprint\s*=/.test(refreshBlock), 'refresh must not rewrite source_fingerprint')
  assert.ok(/array_length\(p_lookup_fingerprints, 1\) > 5/.test(up), 'lookup set is bounded')
})

console.log('\nre-review corrections')
test('composite (connection_id,user_id) FK enforces owner consistency on all 3 tables', () => {
  assert.ok(has(/google_connections_id_user_key UNIQUE \(id, user_id\)/), 'connections (id,user_id) unique key')
  for (const fk of ['gcc_conn_user_fk', 'gss2_conn_user_fk', 'ecr_conn_user_fk']) {
    assert.ok(new RegExp(`${fk} FOREIGN KEY \\(connection_id, user_id\\)\\s*REFERENCES public\\.google_connections\\(id, user_id\\) ON DELETE CASCADE`).test(CODE), `${fk} composite FK`)
  }
})
test('retained_subject rejects control characters (defense-in-depth CHECK)', () => {
  assert.ok(has(/interaction_candidates_retained_subject_len[\s\S]*?char_length\(retained_subject\) <= 160 AND retained_subject !~ '\[\[:cntrl:\]\]'/))
})
test('upsert rejects a control-character subject with a controlled code', () => {
  const up = CODE.match(/FUNCTION public\.upsert_email_candidate[\s\S]*?\$\$;/)[0]
  assert.ok(/char_length\(p_retained_subject\) > 160 OR p_retained_subject ~ '\[\[:cntrl:\]\]'/.test(up))
})
test('accept PRESERVES the applied Calendar-review behavior (no regression)', () => {
  const acc = CODE.match(/FUNCTION public\.accept_interaction_candidate[\s\S]*?\$\$;/)[0]
  assert.ok(/v_cand\.source_last_state <> 'active'/.test(acc), 'source_last_state guard preserved')
  assert.ok(/FROM public\.contacts[\s\S]*?FOR KEY SHARE/.test(acc), 'contact FOR KEY SHARE lock preserved')
  assert.ok(/WHEN foreign_key_violation THEN/.test(acc), 'FK-violation -> not_found preserved')
  assert.ok(/WHEN deadlock_detected OR serialization_failure THEN/.test(acc), 'deadlock/serialization -> conflict preserved')
  assert.ok(/interaction_previously_deleted/.test(acc), 'accepted+null tombstone preserved')
  // source-aware change present; retained context erased on accept
  assert.ok(/v_src := CASE WHEN v_cand\.source IN \('google_calendar', 'gmail', 'outlook'\)/.test(acc))
  assert.ok(/status = 'accepted'[\s\S]*?retained_subject = NULL/.test(acc))
})

console.log('\nscope guard: nothing out-of-scope leaked into the migration')
test('migration adds NO Edge Function / scheduler / webhook / UI / secret / live scope', () => {
  assert.ok(!/gmail\.readonly|gmail\.metadata|googleapis\.com\/auth/.test(CODE), 'no live Gmail scope in SQL')
  assert.ok(!/pg_cron|cron\.schedule|http_post|net\.http|webhook/i.test(CODE), 'no scheduler/webhook')
  assert.ok(!/VITE_|Deno\.serve|createClient|ANTHROPIC/.test(CODE), 'no Edge/flag/secret')
  assert.ok(!/DROP TABLE/.test(CODE), 'purely additive: no DROP TABLE')
})
test('migration is marked NOT DEPLOYED / NOT APPLIED', () => {
  assert.ok(/NOT DEPLOYED|NOT APPLIED/.test(MIG))
})

console.log('\nadapter scope guard (no network / no live scope wired)')
test('adapter has no fetch/network and does not self-wire a live scope request', () => {
  assert.ok(!/\bfetch\(|XMLHttpRequest|Deno\.serve|createClient/.test(ADAPTER), 'adapter makes no network call')
  // Scope constants exist for the future phase but are not requested by any builder.
  assert.ok(/GMAIL_METADATA_SCOPE/.test(ADAPTER) && /DORMANT/.test(ADAPTER))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
