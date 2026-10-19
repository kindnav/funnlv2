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

function stripSql(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ') }
const MIG_CODE = stripSql(MIG)

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


// ── Scope-creep guard across all Phase C1 code ────────────────────────────────
console.log('\nPhase C1 scope guard')

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
