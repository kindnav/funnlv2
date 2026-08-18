// Source-invariant tests for the Phase A migration + Phase A scope guard.
//
// HONESTY NOTE: these are STATIC SOURCE-SCAN assertions over the migration SQL
// text and the Phase A files. They do NOT execute against a PostgreSQL instance:
// they do NOT prove runtime RLS enforcement, actual lease-race atomicity, or that
// a stale run is really rejected at execution time. They assert that the SQL and
// files are SHAPED correctly (tables, columns, constraints, indexes, RLS toggles,
// REVOKE/GRANT hardening, RPC signatures/guards) and that no out-of-scope feature
// (Gmail, Calendar-write, live API calls, scheduler, webhook, AI, UI) leaked in.
// Runtime behavior is validated only when the migration is applied in a later,
// separately-approved rollout.
//
// Run: node tests/calendar-migration-invariants.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const MIGRATION = readFileSync(
  join(ROOT, 'supabase/migrations/20260817000000_add_calendar_ingestion.sql'),
  'utf8',
)
const SHARED = {
  emailMatch: readFileSync(join(ROOT, 'supabase/functions/shared/calendarEmailMatch.js'), 'utf8'),
  fingerprint: readFileSync(join(ROOT, 'supabase/functions/shared/calendarFingerprint.js'), 'utf8'),
  time: readFileSync(join(ROOT, 'supabase/functions/shared/calendarTime.js'), 'utf8'),
  relevance: readFileSync(join(ROOT, 'supabase/functions/shared/calendarRelevance.js'), 'utf8'),
  flag: readFileSync(join(ROOT, 'src/lib/calendarIngestion.js'), 'utf8'),
}
// Comment strippers so scope-guard / count scans see CODE only, not the
// descriptive "NO Gmail / NO webhook / no Supabase" wording in the comments.
function stripSql(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // block comments
    .replace(/--[^\n]*/g, ' ')          // line comments
}
function stripJs(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')   // // line comments (not http://)
}

const MIGRATION_CODE = stripSql(MIGRATION)
const HELPERS_CODE = [SHARED.emailMatch, SHARED.fingerprint, SHARED.time, SHARED.relevance].map(stripJs).join('\n')
const ALL_PHASE_A_CODE = MIGRATION_CODE + '\n' + HELPERS_CODE + '\n' + stripJs(SHARED.flag)

let passed = 0
let failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}
const has = (re) => re.test(MIGRATION)

// ── Tables + columns ──────────────────────────────────────────────────────────
console.log('\nSchema objects (source scan)')

test('creates the three Phase A tables', () => {
  assert.ok(has(/CREATE TABLE public\.interaction_candidates/))
  assert.ok(has(/CREATE TABLE public\.google_calendar_event_refs/))
  assert.ok(has(/CREATE TABLE public\.google_calendar_sync_state/))
})
test('interaction_candidates has required columns', () => {
  for (const col of [
    'user_id', 'contact_id', 'source', 'source_fingerprint', 'proposed_type',
    'proposed_interaction_date', 'proposed_notes', 'status', 'interaction_id',
    'source_last_state',
  ]) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(MIGRATION), `missing column ${col}`)
  }
})
test('event_refs has typed occurrence + event window columns', () => {
  for (const col of [
    'original_occurrence_at', 'original_occurrence_date', 'event_start_at',
    'event_end_at', 'event_start_date', 'event_end_date', 'event_timezone',
  ]) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(MIGRATION), `missing column ${col}`)
  }
})
test('sync_state has cursor + lease + run fields', () => {
  for (const col of ['sync_token', 'backfilled_through', 'sync_status', 'sync_lease_until', 'sync_run_id', 'last_run_complete', 'last_error_code']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(MIGRATION), `missing column ${col}`)
  }
})

// ── Constraints ───────────────────────────────────────────────────────────────
console.log('\nConstraints (source scan)')

test('fingerprint SHA-256 hex shape enforced', () => {
  assert.ok(has(/source_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/))
})
test('proposed_type restricted to existing interaction types', () => {
  assert.ok(has(/proposed_type IN \('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other'\)/))
})
test('candidate status + source_last_state enums', () => {
  assert.ok(has(/status IN \('pending', 'accepted', 'dismissed', 'invalidated'\)/))
  assert.ok(has(/source_last_state IN \('active', 'cancelled', 'deleted'\)/))
})
test('proposed_notes capped at 200 chars', () => {
  assert.ok(has(/char_length\(proposed_notes\) <= 200/))
})
test('interaction-link CHECK allows accepted+NULL tombstone, forbids link on non-accepted', () => {
  // Correct invariant: only accepted rows may hold an interaction_id; accepted+NULL is
  // the "interaction later deleted" tombstone. Must NOT require accepted => NOT NULL
  // (that would make ON DELETE SET NULL abort the user's interaction deletion).
  assert.ok(has(/CHECK \(status = 'accepted' OR interaction_id IS NULL\)/), 'expected accepted-OR-null link check')
  assert.ok(!has(/status <> 'accepted' OR interaction_id IS NOT NULL/), 'old accepted-requires-interaction check must be gone')
})
test('interaction_id FK is ON DELETE SET NULL (deletion leaves accepted tombstone)', () => {
  assert.ok(has(/interaction_id[\s\S]*?REFERENCES public\.interactions\(id\) ON DELETE SET NULL/))
})
test('Phase B accept contract documents accepted+NULL = interaction_previously_deleted', () => {
  assert.ok(/interaction_previously_deleted/.test(MIGRATION), 'accept contract must document the deleted-interaction result')
})
test('candidate uniqueness is (user_id, source_fingerprint)', () => {
  assert.ok(has(/UNIQUE \(user_id, source_fingerprint\)/))
})
test('event_refs occurrence XOR constraint', () => {
  assert.ok(has(/\(original_occurrence_at IS NOT NULL\) <> \(original_occurrence_date IS NOT NULL\)/))
})
test('event_refs timing XOR (timed vs all-day)', () => {
  assert.ok(/event_start_at IS NOT NULL AND event_end_at IS NOT NULL[\s\S]*event_start_date IS NULL AND event_end_date IS NULL/.test(MIGRATION))
})
test('timed end after start + all-day exclusive end constraints', () => {
  assert.ok(has(/event_end_at > event_start_at/))
  assert.ok(has(/event_end_date > event_start_date/))
})
test('provider string length caps present', () => {
  assert.ok(has(/char_length\(google_event_id\) <= 1024/))
  assert.ok(has(/char_length\(google_sub\) <= 255/))
})
test('sync running state requires run + lease', () => {
  assert.ok(has(/sync_status <> 'running' OR \(sync_run_id IS NOT NULL AND sync_lease_until IS NOT NULL\)/))
})
test('calendar_id restricted to primary on ref + sync_state', () => {
  const count = (MIGRATION.match(/calendar_id = 'primary'/g) || []).length
  assert.ok(count >= 2, `expected >=2 calendar_id='primary' checks, saw ${count}`)
})

// ── event_refs NON-UNIQUE occurrence index (group events) ─────────────────────
console.log('\nGroup-event index (source scan)')

test('event_refs occurrence index exists and is NON-UNIQUE', () => {
  assert.ok(has(/CREATE INDEX google_calendar_event_refs_event_idx/))
  // Must not be a UNIQUE index on the occurrence tuple (would block group events).
  assert.ok(!/CREATE UNIQUE INDEX[\s\S]*google_event_id, original_occurrence_at/.test(MIGRATION))
})
test('candidate_id is the event_refs primary key', () => {
  assert.ok(has(/candidate_id\s+uuid\s+PRIMARY KEY/))
})

// ── Indexes ───────────────────────────────────────────────────────────────────
console.log('\nIndexes (source scan)')

test('candidate (user_id, status) + contact indexes', () => {
  assert.ok(has(/CREATE INDEX interaction_candidates_user_status_idx[\s\S]*\(user_id, status\)/))
  assert.ok(has(/CREATE INDEX interaction_candidates_contact_idx[\s\S]*\(contact_id\)/))
})

// ── RLS + grants ──────────────────────────────────────────────────────────────
console.log('\nRLS + grants (source scan)')

test('RLS enabled on all three tables', () => {
  assert.strictEqual((MIGRATION.match(/ENABLE ROW LEVEL SECURITY/g) || []).length, 3)
})
test('all three tables REVOKE ALL from PUBLIC/anon/authenticated', () => {
  for (const t of ['interaction_candidates', 'google_calendar_event_refs', 'google_calendar_sync_state']) {
    assert.ok(new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM authenticated`).test(MIGRATION), `${t} not revoked from authenticated`)
    assert.ok(new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM anon`).test(MIGRATION))
    assert.ok(new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM PUBLIC`).test(MIGRATION))
  }
})
test('candidate authenticated grant is COLUMN-LEVEL SELECT with a safe list', () => {
  assert.ok(/GRANT SELECT \(\s*[\s\S]*?\)\s*ON TABLE public\.interaction_candidates TO authenticated/.test(MIGRATION))
})
test('source_fingerprint, user_id, interaction_id NOT in the authenticated grant', () => {
  const grant = MIGRATION.match(/GRANT SELECT \(([\s\S]*?)\)\s*ON TABLE public\.interaction_candidates TO authenticated/)
  assert.ok(grant, 'column grant not found')
  const cols = grant[1]
  assert.ok(!/\bsource_fingerprint\b/.test(cols), 'source_fingerprint must not be granted')
  assert.ok(!/\buser_id\b/.test(cols), 'user_id must not be granted')
  assert.ok(!/\binteraction_id\b/.test(cols), 'interaction_id must not be granted')
})
test('candidate SELECT-own policy present', () => {
  assert.ok(has(/CREATE POLICY "interaction_candidates_select_own"[\s\S]*USING \(\(SELECT auth\.uid\(\)\) = user_id\)/))
})
test('event_refs + sync_state have NO authenticated grant or policy', () => {
  // Statement-bounded ([^;]*) so a match can't span across an unrelated
  // CREATE POLICY / CREATE INDEX statement.
  assert.ok(!/GRANT[^;]*google_calendar_event_refs TO authenticated/.test(MIGRATION_CODE))
  assert.ok(!/GRANT[^;]*google_calendar_sync_state TO authenticated/.test(MIGRATION_CODE))
  assert.ok(!/CREATE POLICY[^;]*ON public\.google_calendar_event_refs/.test(MIGRATION_CODE))
  assert.ok(!/CREATE POLICY[^;]*ON public\.google_calendar_sync_state/.test(MIGRATION_CODE))
})
test('no authenticated INSERT/UPDATE/DELETE grant on candidates', () => {
  assert.ok(!/GRANT (INSERT|UPDATE|DELETE)[^;]*interaction_candidates TO authenticated/.test(MIGRATION_CODE))
})
test('service_role gets GRANT ALL on all three tables', () => {
  for (const t of ['interaction_candidates', 'google_calendar_event_refs', 'google_calendar_sync_state']) {
    assert.ok(new RegExp(`GRANT ALL\\s+ON TABLE public\\.${t} TO service_role`).test(MIGRATION), `${t} missing service_role GRANT ALL`)
  }
})

// ── RPC inventory + hardening ─────────────────────────────────────────────────
console.log('\nRPCs (source scan)')

const RPCS = [
  'claim_calendar_sync_lease',
  'renew_calendar_sync_lease',
  'release_calendar_sync_lease',
  'upsert_calendar_candidate',
  'store_refreshed_google_token',
  'mark_google_needs_reauth',
]

test('exactly the six Phase A RPCs are defined', () => {
  for (const r of RPCS) {
    assert.ok(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${r}\\(`).test(MIGRATION), `missing RPC ${r}`)
  }
  const created = (MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g) || []).map((m) => m.match(/public\.(\w+)/)[1])
  assert.deepStrictEqual(created.sort(), [...RPCS].sort())
})
test('accept/dismiss RPCs are DEFERRED (not in Phase A)', () => {
  assert.ok(!/FUNCTION public\.accept_interaction_candidate/.test(MIGRATION))
  assert.ok(!/FUNCTION public\.dismiss_interaction_candidate/.test(MIGRATION))
})
test('every RPC is SECURITY DEFINER with empty search_path', () => {
  // Count against comment-stripped SQL so header comments don't inflate the count.
  assert.strictEqual((MIGRATION_CODE.match(/SECURITY DEFINER/g) || []).length, 6)
  assert.strictEqual((MIGRATION_CODE.match(/SET search_path = ''/g) || []).length, 6)
})
test('in-body gen_random_uuid() is schema-qualified (resolves under empty search_path)', () => {
  // Table-column DEFAULTs may stay unqualified (resolved at CREATE TABLE time), but
  // any in-body call inside a SET search_path='' function MUST be pg_catalog-qualified
  // or it risks failing at runtime if only a pgcrypto copy exists in extensions.
  const claim = MIGRATION_CODE.match(/FUNCTION public\.claim_calendar_sync_lease[\s\S]*?\$\$;/)[0]
  assert.ok(/:=\s*pg_catalog\.gen_random_uuid\(\)/.test(claim), 'in-body gen_random_uuid must be pg_catalog-qualified')
  assert.ok(!/:=\s*gen_random_uuid\(\)/.test(claim), 'no unqualified in-body gen_random_uuid()')
})
test('every RPC revokes EXECUTE from PUBLIC/anon/authenticated and grants service_role', () => {
  for (const r of RPCS) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${r}\\(`).test(MIGRATION), `${r} EXECUTE not revoked`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${r}\\(`).test(MIGRATION), `${r} not granted to service_role`)
  }
  assert.strictEqual((MIGRATION.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/g) || []).length, 6)
})
test('upsert_calendar_candidate is run-ID fenced against stale runs', () => {
  const body = MIGRATION.match(/FUNCTION public\.upsert_calendar_candidate[\s\S]*?\$\$;/)[0]
  assert.ok(/sync_run_id\s*=\s*p_run_id/.test(body))
  assert.ok(/sync_lease_until > now\(\)/.test(body))
  assert.ok(/sync_status\s*=\s*'running'/.test(body))
  assert.ok(/stale_or_unowned_run/.test(body))
  assert.ok(/connection_ownership_mismatch/.test(body))
  assert.ok(/contact_ownership_mismatch/.test(body))
})
test('upsert run-fence takes a row lock (FOR SHARE) that conflicts with claim/renew/release UPDATE', () => {
  const codeBody = stripSql(MIGRATION).match(/FUNCTION public\.upsert_calendar_candidate[\s\S]*?\$\$;/)[0]
  // The run-fence SELECT on sync_state must carry a locking clause.
  assert.ok(/FROM public\.google_calendar_sync_state[\s\S]*?FOR SHARE/.test(codeBody), 'run-fence must lock the sync_state row')
})
test('sync-state lock is acquired BEFORE candidate/event_ref writes (consistent lock order)', () => {
  const codeBody = stripSql(MIGRATION).match(/FUNCTION public\.upsert_calendar_candidate[\s\S]*?\$\$;/)[0]
  const lockIdx = codeBody.indexOf('FOR SHARE')
  const candInsertIdx = codeBody.indexOf('INSERT INTO public.interaction_candidates')
  const refInsertIdx = codeBody.indexOf('INSERT INTO public.google_calendar_event_refs')
  assert.ok(lockIdx > -1, 'FOR SHARE lock present')
  assert.ok(lockIdx < candInsertIdx, 'lock must precede candidate INSERT')
  assert.ok(lockIdx < refInsertIdx, 'lock must precede event_ref INSERT')
})
test('candidate + event_ref writes remain one transaction (single plpgsql body, no COMMIT)', () => {
  const codeBody = stripSql(MIGRATION).match(/FUNCTION public\.upsert_calendar_candidate[\s\S]*?\$\$;/)[0]
  assert.ok(!/COMMIT|ROLLBACK|BEGIN TRANSACTION|START TRANSACTION/i.test(codeBody), 'no explicit txn control — one implicit transaction')
  assert.ok(/INSERT INTO public\.interaction_candidates/.test(codeBody))
  assert.ok(/INSERT INTO public\.google_calendar_event_refs/.test(codeBody))
})
test('upsert never resurrects a non-pending candidate', () => {
  const body = MIGRATION.match(/FUNCTION public\.upsert_calendar_candidate[\s\S]*?\$\$;/)[0]
  assert.ok(/WHERE public\.interaction_candidates\.status = 'pending'/.test(body))
})
test('token RPC: access pair + both-or-null refresh + single CASE predicate + account guard', () => {
  const body = MIGRATION.match(/FUNCTION public\.store_refreshed_google_token[\s\S]*?\$\$;/)[0]
  assert.ok(/invalid_access_pair/.test(body))
  assert.ok(/\(p_refresh_ct IS NULL\) <> \(p_refresh_nonce IS NULL\)/.test(body))
  // Both refresh columns switch on the SAME predicate p_refresh_ct IS NULL.
  assert.strictEqual((body.match(/CASE WHEN p_refresh_ct IS NULL/g) || []).length, 2)
  assert.ok(/google_sub = p_expected_google_sub/.test(body))
  assert.ok(/FOR UPDATE/.test(body))
  assert.ok(/token_row_missing/.test(body))
  assert.ok(/connection_row_missing/.test(body))
})
test('token RPC enforces key_version=1 and strictly-future expiry before activation', () => {
  const body = MIGRATION.match(/FUNCTION public\.store_refreshed_google_token[\s\S]*?\$\$;/)[0]
  // key_version must be exactly 1 (reject null / zero / negative / unsupported).
  assert.ok(/p_key_version IS NULL OR p_key_version <> 1[\s\S]*?unsupported_key_version/.test(body), 'must require key_version = 1')
  // expiry must be non-null AND strictly in the future.
  assert.ok(/p_token_expires_at IS NULL OR p_token_expires_at <= now\(\)[\s\S]*?invalid_token_expiry/.test(body), 'must require future expiry')
  // Both guards must precede the UPDATE that sets status = 'active'.
  const keyIdx = body.indexOf('unsupported_key_version')
  const expiryIdx = body.indexOf('invalid_token_expiry')
  const activeIdx = body.indexOf("status           = 'active'")
  assert.ok(keyIdx > -1 && expiryIdx > -1 && activeIdx > -1, 'guards + activation present')
  assert.ok(keyIdx < activeIdx && expiryIdx < activeIdx, 'both guards must run before marking active')
  // The pair/account/row-count protections are retained.
  assert.ok(/invalid_access_pair/.test(body) && /token_row_missing/.test(body) && /connection_row_missing/.test(body))
})
test('mark_google_needs_reauth is account-guarded', () => {
  const body = MIGRATION.match(/FUNCTION public\.mark_google_needs_reauth[\s\S]*?\$\$;/)[0]
  assert.ok(/google_sub = p_expected_google_sub/.test(body))
  assert.ok(/status = 'needs_reauth'/.test(body))
  assert.ok(!/DELETE/.test(body), 'must not delete token material')
})
test('release RPC does not advance a sync token in Phase A', () => {
  const body = MIGRATION.match(/FUNCTION public\.release_calendar_sync_lease[\s\S]*?\$\$;/)[0]
  assert.ok(!/sync_token/.test(body), 'release must not touch sync_token in Phase A')
})

// ── Phase A scope guard: NOTHING out of scope leaked in ───────────────────────
console.log('\nScope guard (no Gmail / Calendar-write / API / scheduler / webhook / AI / UI)')

// All scope-guard scans run against comment-stripped CODE so the legitimate
// "we do NOT do X" wording in the file headers cannot trip them.
test('no Gmail scope or Gmail API anywhere in Phase A code', () => {
  assert.ok(!/gmail/i.test(ALL_PHASE_A_CODE), 'Gmail reference found in code')
  assert.ok(!/mail\.google\.com/i.test(ALL_PHASE_A_CODE))
})
test('no Calendar-write scope in code', () => {
  // full (writable) calendar scope must never appear; readonly is not used here anyway.
  assert.ok(!/auth\/calendar(\.events)?(?!\.readonly)/.test(ALL_PHASE_A_CODE), 'writable calendar scope must not appear')
})
test('no live Calendar API surface in Phase A code', () => {
  assert.ok(!/googleapis\.com\/calendar/i.test(ALL_PHASE_A_CODE))
  assert.ok(!/events\.list|events\.watch|nextSyncToken|syncToken/.test(ALL_PHASE_A_CODE), 'sync-engine API surface must not be in Phase A')
})
test('no network I/O in shared helpers (pure)', () => {
  assert.ok(!/\bfetch\s*\(/.test(HELPERS_CODE), 'fetch found in a pure helper')
  assert.ok(!/createClient|\bsupabase\b/i.test(HELPERS_CODE), 'Supabase usage found in a pure helper')
})
test('no scheduler / cron / webhook / push in Phase A code', () => {
  assert.ok(!/cron|pg_cron|\bschedule\b|webhook|events\.watch|X-Goog|pubsub|pub\/sub/i.test(ALL_PHASE_A_CODE))
})
test('no AI / model call in Phase A code', () => {
  assert.ok(!/anthropic|claude|openai|\bLLM\b/i.test(ALL_PHASE_A_CODE))
})
test('flag foundation is not rendered/imported into any page yet', () => {
  // The flag file itself must not import React or render UI.
  assert.ok(!/from 'react'|jsx|<[A-Za-z]/.test(SHARED.flag))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
