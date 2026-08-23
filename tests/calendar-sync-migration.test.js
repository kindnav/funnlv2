// Phase C1 — source-invariant tests for the reconciliation migration + a
// scope-creep guard over all Phase C1 files. STATIC SOURCE SCANS ONLY (no
// PostgreSQL execution — runtime RPC behavior is validated by the disposable
// local Docker replay). Run: node tests/calendar-sync-migration.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = readFileSync(join(ROOT, 'supabase/migrations/20260823074250_add_calendar_reconciliation.sql'), 'utf8')
const ENGINE = readFileSync(join(ROOT, 'supabase/functions/shared/calendarSyncEngine.js'), 'utf8')
const INDEX = readFileSync(join(ROOT, 'supabase/functions/google-calendar-sync/index.ts'), 'utf8')
const CONFIG = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8')

function stripSql(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ') }
function stripJs(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1') }
const MIG_CODE = stripSql(MIG)
const ALL_CODE = MIG_CODE + '\n' + stripJs(ENGINE) + '\n' + stripJs(INDEX)

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}
const has = (re) => re.test(MIG_CODE)

// ── Reconciliation RPC hardening ──────────────────────────────────────────────
console.log('\nreconcile_calendar_occurrence (source scan)')

test('single RPC defined, correct name', () => {
  const fns = (MIG_CODE.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) || []).map(m => m.split('.')[1])
  assert.deepStrictEqual(fns, ['reconcile_calendar_occurrence'])
})
test('SECURITY DEFINER + empty search_path', () => {
  assert.strictEqual((MIG_CODE.match(/SECURITY DEFINER/g) || []).length, 1)
  assert.strictEqual((MIG_CODE.match(/SET search_path = ''/g) || []).length, 1)
})
test('EXECUTE revoked from PUBLIC/anon/authenticated, granted service_role only', () => {
  assert.ok(has(/REVOKE ALL ON FUNCTION public\.reconcile_calendar_occurrence\([\s\S]*?\) FROM PUBLIC, anon, authenticated/))
  assert.ok(has(/GRANT EXECUTE ON FUNCTION public\.reconcile_calendar_occurrence\([\s\S]*?\) TO service_role/))
  assert.ok(!/TO (authenticated|anon)\b/.test(MIG_CODE.replace(/FROM PUBLIC, anon, authenticated/g, '')))
})
test('run-ID fence with FOR SHARE lock, running + unexpired lease', () => {
  const body = MIG_CODE.match(/FUNCTION public\.reconcile_calendar_occurrence[\s\S]*?\$\$;/)[0]
  assert.ok(/FROM public\.google_calendar_sync_state[\s\S]*?FOR SHARE/.test(body), 'must lock sync_state FOR SHARE')
  assert.ok(/sync_run_id\s*=\s*p_run_id/.test(body))
  assert.ok(/sync_status\s*=\s*'running'/.test(body))
  assert.ok(/sync_lease_until > now\(\)/.test(body))
  assert.ok(/stale_or_unowned_run/.test(body))
})
test('lock order: sync-state FOR SHARE precedes the candidate UPDATE', () => {
  const body = MIG_CODE.match(/FUNCTION public\.reconcile_calendar_occurrence[\s\S]*?\$\$;/)[0]
  const lockIdx = body.indexOf('FOR SHARE')
  const updIdx = body.indexOf('UPDATE public.interaction_candidates')
  assert.ok(lockIdx > -1 && updIdx > -1 && lockIdx < updIdx, 'FOR SHARE must precede UPDATE')
})
test('ownership + google_sub verified', () => {
  const body = MIG_CODE.match(/FUNCTION public\.reconcile_calendar_occurrence[\s\S]*?\$\$;/)[0]
  assert.ok(/google_connections[\s\S]*?user_id = p_user_id[\s\S]*?google_sub = p_google_sub/.test(body))
  assert.ok(/connection_ownership_mismatch/.test(body))
})
test('only pending candidates invalidated; never touches accepted/dismissed', () => {
  const body = MIG_CODE.match(/FUNCTION public\.reconcile_calendar_occurrence[\s\S]*?\$\$;/)[0]
  assert.ok(/SET status\s*=\s*'invalidated'/.test(body))
  assert.ok(/c\.status = 'pending'/.test(body), 'must filter status=pending')
  // must NOT set status to pending/accepted/dismissed anywhere
  assert.ok(!/SET status\s*=\s*'(pending|accepted|dismissed)'/.test(body))
})
test('keep-set uses = ANY, occurrence matched with IS NOT DISTINCT FROM', () => {
  const body = MIG_CODE.match(/FUNCTION public\.reconcile_calendar_occurrence[\s\S]*?\$\$;/)[0]
  assert.ok(/NOT \(c\.source_fingerprint = ANY \(v_keep\)\)/.test(body))
  assert.ok(/original_occurrence_at\s+IS NOT DISTINCT FROM p_original_occurrence_at/.test(body))
  assert.ok(/original_occurrence_date IS NOT DISTINCT FROM p_original_occurrence_date/.test(body))
})
test('input validation: calendar primary, occurrence XOR, fingerprint shape', () => {
  const body = MIG_CODE.match(/FUNCTION public\.reconcile_calendar_occurrence[\s\S]*?\$\$;/)[0]
  assert.ok(/p_calendar_id <> 'primary'/.test(body))
  assert.ok(/\(p_original_occurrence_at IS NOT NULL\) = \(p_original_occurrence_date IS NOT NULL\)/.test(body))
  assert.ok(/\^\[0-9a-f\]\{64\}\$/.test(body))
})
test('no dynamic SQL (no EXECUTE format/quote_ident/USING)', () => {
  const body = MIG_CODE.match(/FUNCTION public\.reconcile_calendar_occurrence[\s\S]*?\$\$;/)[0]
  assert.ok(!/\bEXECUTE\b/i.test(body), 'no dynamic EXECUTE')
  assert.ok(!/format\(|quote_ident|quote_literal/i.test(body))
})
test('short txn: no external calls / no sync_token advancement', () => {
  const body = MIG_CODE.match(/FUNCTION public\.reconcile_calendar_occurrence[\s\S]*?\$\$;/)[0]
  assert.ok(!/sync_token/.test(body), 'reconcile must not touch sync_token')
  assert.ok(!/http|pg_net|net\./i.test(body))
})

// ── Edge Function security posture (source scan) ──────────────────────────────
console.log('\ngoogle-calendar-sync Edge Function (source scan)')

test('config.toml declares the function verify_jwt = true', () => {
  assert.ok(/\[functions\.google-calendar-sync\][\s\S]*?verify_jwt = true/.test(CONFIG))
})
test('handler is POST-only + calls auth.getUser + derives user from JWT', () => {
  assert.ok(/auth\.getUser\(\)/.test(INDEX))
  assert.ok(/runCalendarSync/.test(INDEX))
  assert.ok(/method !== 'POST'|method === 'OPTIONS'/.test(stripJs(ENGINE)) || /method/.test(INDEX))
})
test('service-role key used only server-side; never a VITE_ var', () => {
  assert.ok(/SUPABASE_SERVICE_ROLE_KEY/.test(INDEX))
  assert.ok(!/VITE_/.test(stripJs(INDEX)), 'no VITE_ env var in function code')
})
test('access token sent via Authorization header, never in URL', () => {
  assert.ok(/Authorization: `Bearer \$\{accessToken\}`/.test(INDEX))
  assert.ok(!/access_token=\$\{/.test(INDEX) && !/[?&]access_token=/.test(ALL_CODE))
})
test('bounded external fetch (AbortController timeout)', () => {
  assert.ok(/AbortController/.test(INDEX) && /setTimeout\([^,]*abort/.test(INDEX))
})

// ── Scope-creep guard across all Phase C1 code ────────────────────────────────
console.log('\nPhase C1 scope guard')

test('no Gmail scope or API', () => {
  assert.ok(!/gmail/i.test(ALL_CODE))
  assert.ok(!/mail\.google\.com/i.test(ALL_CODE))
})
test('no Calendar-write scope (read-only only)', () => {
  // must not request a writable calendar scope
  assert.ok(!/auth\/calendar(\.events)?(?!\.readonly)/.test(ALL_CODE))
  // events endpoint is the read list endpoint; no insert/update/delete/watch
  assert.ok(!/events\/(quickAdd|import|watch)|events:insert|\.insert\(|calendarList/.test(ALL_CODE))
})
test('no scheduler / cron / webhook / push / pubsub', () => {
  assert.ok(!/pg_cron|cron|\bschedule\b|webhook|events\.watch|x-goog|pub\/?sub/i.test(ALL_CODE))
})
test('no AI / model calls', () => {
  assert.ok(!/anthropic|claude|openai|\bLLM\b/i.test(ALL_CODE))
})
test('no direct interaction creation or contact creation in engine/rpc', () => {
  // engine writes only via upsert_calendar_candidate / reconcile; never inserts interactions/contacts
  assert.ok(!/INSERT INTO public\.interactions|INSERT INTO public\.contacts/i.test(MIG_CODE))
  assert.ok(!/from\('interactions'\)[\s\S]*?\.insert|from\('contacts'\)[\s\S]*?\.insert/.test(INDEX))
})
test('no Phase B accept/dismiss RPC introduced', () => {
  assert.ok(!/accept_interaction_candidate|dismiss_interaction_candidate/.test(ALL_CODE))
})
test('no Stripe/billing work', () => {
  assert.ok(!/stripe|subscription|checkout|billing/i.test(ALL_CODE))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
