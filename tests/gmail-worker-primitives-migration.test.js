// Source-invariant tests for the E2B Gmail worker/capability service primitives migration.
//
// HONESTY NOTE: these are STATIC SOURCE-SCAN assertions over the migration SQL text. They
// do NOT execute against PostgreSQL — runtime behavior (atomic reservation, run fencing,
// ownership refusal, grant enforcement) is validated separately by replaying the migration
// on a disposable local Supabase stack. These assertions prove the SQL is SHAPED correctly
// and that nothing out of scope (table/column changes, scheduler, live scope, Edge shell)
// leaked in.
//
// Run: node tests/gmail-worker-primitives-migration.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MIG = readFileSync(join(ROOT, 'supabase/migrations/20260910000000_add_gmail_worker_primitives.sql'), 'utf8')
const CODE = MIG.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}
const fn = (name) => CODE.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$\\$;`))[0]

console.log('\nmigration is purely additive (RPCs only — no schema change)')
test('no CREATE/ALTER/DROP of any table, column, constraint, index or policy', () => {
  for (const re of [/CREATE TABLE/, /ALTER TABLE/, /DROP TABLE/, /DROP COLUMN/, /ADD COLUMN/,
                    /CREATE INDEX/, /CREATE POLICY/, /DROP CONSTRAINT/, /ADD CONSTRAINT/]) {
    assert.ok(!re.test(CODE), `must not contain ${re}`)
  }
})
test('no apply-time DML (applying the migration rewrites no rows)', () => {
  const topLevel = CODE.replace(/AS \$\$[\s\S]*?\$\$;/g, 'AS <BODY>;')
  assert.strictEqual((topLevel.match(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\s/gmi) || []).length, 0)
})
test('exactly four functions, all hardened', () => {
  const fns = CODE.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) || []
  assert.strictEqual(fns.length, 4)
  for (const f of fns) {
    const name = (f.match(/FUNCTION public\.(\w+)/) || [])[1]
    assert.ok(/SECURITY DEFINER/.test(f), `${name} SECURITY DEFINER`)
    assert.ok(/SET search_path = ''/.test(f), `${name} empty search_path`)
  }
})
test('no dynamic SQL', () => {
  assert.ok(!/EXECUTE\s+'/.test(CODE) && !/EXECUTE\s+format/.test(CODE) && !/\bformat\(/.test(CODE))
})
test('the three worker/callback RPCs are service-role only', () => {
  for (const f of ['upsert_google_capability', 'reserve_due_gmail_connection', 'invalidate_email_candidates_by_fingerprint']) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\)[\\s\\S]{0,40}FROM PUBLIC, anon, authenticated`).test(CODE), `${f} revoke`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\([^)]*\\)[\\s\\S]{0,30}TO service_role`).test(CODE), `${f} grant`)
  }
})
test('ONLY disconnect_my_gmail is granted to authenticated', () => {
  const grants = CODE.match(/GRANT EXECUTE ON FUNCTION public\.\w+\([^)]*\)[\s\S]{0,40}?TO \w+;/g) || []
  const toAuth = grants.filter((g) => /TO authenticated;/.test(g))
  assert.strictEqual(toAuth.length, 1, `expected 1 authenticated grant, got ${toAuth.length}`)
  assert.ok(/disconnect_my_gmail/.test(toAuth[0]))
})

console.log('\ndisconnect_my_gmail (the user\'s own off switch)')
test('takes NO arguments and derives the caller from auth.uid()', () => {
  assert.ok(/CREATE OR REPLACE FUNCTION public\.disconnect_my_gmail\(\)/.test(CODE), 'zero-arg')
  const f = fn('disconnect_my_gmail')
  assert.ok(/v_uid := \(SELECT auth\.uid\(\)\)/.test(f))
  assert.ok(/'unauthorized'/.test(f), 'anonymous caller refused')
})
test('disables ONLY the gmail capability — Calendar is never matched', () => {
  const f = fn('disconnect_my_gmail')
  const upd = f.match(/UPDATE public\.google_connection_capabilities[\s\S]*?;/)[0]
  assert.ok(/AND product\s+= 'gmail'/.test(upd), 'product predicate pins gmail')
  assert.ok(!/'calendar'/.test(f), 'calendar is never referenced')
  assert.ok(/AND user_id\s+= v_uid/.test(upd), 'scoped to the caller')
})
test('erases pending gmail suggestions AND their retained subjects', () => {
  const f = fn('disconnect_my_gmail')
  const upd = f.match(/UPDATE public\.interaction_candidates[\s\S]*?;/)[0]
  assert.ok(/retained_subject\s+= NULL/.test(upd))
  assert.ok(/context_expires_at = NULL/.test(upd))
  assert.ok(/AND source\s+= 'gmail'/.test(upd), 'never touches calendar candidates')
  assert.ok(/AND status\s+= 'pending'/.test(upd), 'terminal candidates preserved')
  assert.ok(/user_id = v_uid/.test(upd))
})
test('drops the Gmail cursor so a reconnect starts a fresh bounded import', () => {
  const f = fn('disconnect_my_gmail')
  assert.ok(/DELETE FROM public\.gmail_sync_state WHERE connection_id = v_conn/.test(f))
})
test('never deletes the connection, the tokens, or any interaction', () => {
  const f = fn('disconnect_my_gmail')
  assert.ok(!/DELETE FROM public\.google_connections/.test(f))
  assert.ok(!/DELETE FROM public\.google_tokens/.test(f))
  assert.ok(!/public\.google_tokens/.test(f), 'the shared refresh token is never touched')
  assert.ok(!/public\.interactions\b/.test(f), 'accepted interactions are the user\'s data')
})
test('is idempotent when nothing is connected', () => {
  const f = fn('disconnect_my_gmail')
  assert.ok(/'not_connected'/.test(f))
  assert.ok(f.indexOf("'not_connected'") < f.indexOf('UPDATE public.google_connection_capabilities'))
})
test('returns controlled codes + counts only (no provider detail)', () => {
  const f = fn('disconnect_my_gmail')
  const returns = f.match(/RETURN jsonb_build_object\([\s\S]*?\);/g) || []
  assert.ok(returns.length >= 3)
  for (const r of returns) {
    assert.ok(!/retained_subject|history_id|google_email|sub\b|token/.test(r), `leaky return: ${r}`)
  }
})
test('marked NOT DEPLOYED / NOT APPLIED', () => {
  assert.ok(/NOT DEPLOYED|NOT APPLIED/.test(MIG))
})

console.log('\nupsert_google_capability')
test('validates product + status enums and result-code length', () => {
  const f = fn('upsert_google_capability')
  assert.ok(/p_product NOT IN \('calendar', 'gmail'\)/.test(f))
  assert.ok(/p_status NOT IN \('active', 'needs_reauth', 'revoked', 'disabled'\)/.test(f))
  assert.ok(/char_length\(p_result_code\) > 100/.test(f))
})
test('refuses an owner mismatch and an unknown connection (no mutation)', () => {
  const f = fn('upsert_google_capability')
  assert.ok(/'unknown_connection'/.test(f) && /'owner_mismatch'/.test(f))
  // the ownership check must come BEFORE the INSERT
  assert.ok(f.indexOf("'owner_mismatch'") < f.indexOf('INSERT INTO public.google_connection_capabilities'))
})
test('touches ONLY the (connection, product) row — product isolation', () => {
  const f = fn('upsert_google_capability')
  assert.ok(/ON CONFLICT \(connection_id, product\) DO UPDATE/.test(f))
  // no statement may update capabilities across products
  assert.ok(!/UPDATE public\.google_connection_capabilities/.test(f))
})
test('never clears a prior last_success_at on a failure write', () => {
  const f = fn('upsert_google_capability')
  assert.ok(/ELSE public\.google_connection_capabilities\.last_success_at/.test(f))
})

console.log('\nreserve_due_gmail_connection')
test('reserves at most ONE row (no all-user sweep)', () => {
  const f = fn('reserve_due_gmail_connection')
  assert.ok(/LIMIT 1/.test(f), 'single-row LIMIT')
  assert.ok(!/FOR UPDATE OF s SKIP LOCKED/.test(f), 'must not lock the nullable outer-join side')
})
test('exactly-one-winner comes from the guarded upsert + ROW_COUNT check', () => {
  const f = fn('reserve_due_gmail_connection')
  assert.ok(/ON CONFLICT \(connection_id\) DO UPDATE[\s\S]*?WHERE public\.gmail_sync_state\.sync_status <> 'running'[\s\S]*?sync_lease_until < now\(\)/.test(f))
  assert.ok(/GET DIAGNOSTICS v_n = ROW_COUNT;[\s\S]*?IF v_n <> 1 THEN[\s\S]*?'none_due'/.test(f))
})
test('due predicate: active+granted+not-needs_reauth, live lease excluded, backoff honored', () => {
  const f = fn('reserve_due_gmail_connection')
  assert.ok(/cap\.status = 'active'/.test(f) && /cap\.granted IS TRUE/.test(f) && /cap\.needs_reauth IS FALSE/.test(f))
  assert.ok(/conn\.status = 'active'/.test(f))
  assert.ok(/s\.sync_lease_until < now\(\)/.test(f), 'live lease excluded')
  assert.ok(/s\.next_attempt_at IS NULL OR s\.next_attempt_at <= now\(\)/.test(f), 'backoff honored')
})
test('an incomplete run is retried after backoff, bounded (10 tries, >= 5 min apart)', () => {
  const f = fn('reserve_due_gmail_connection')
  assert.ok(/s\.last_run_complete IS NOT TRUE/.test(f), 'incomplete runs are distinguished')
  assert.ok(/s\.retry_count < 10/.test(f), 'bounded retries')
  assert.ok(/s\.last_synced_at < now\(\) - interval '5 minutes'/.test(f), 'floor between attempts')
  // the daily cadence must still be the rule for complete runs
  assert.ok(/s\.last_synced_at < now\(\) - make_interval\(secs => p_due_after_seconds\)/.test(f))
})
test('never-synced connections are immediately due', () => {
  const f = fn('reserve_due_gmail_connection')
  assert.ok(/s\.connection_id IS NULL/.test(f), 'missing sync-state row is due')
  assert.ok(/s\.last_synced_at IS NULL/.test(f), 'null last_synced_at is due')
  assert.ok(/NULLS FIRST/.test(f), 'never-synced ordered first')
})
test('lease bounds validated', () => {
  const f = fn('reserve_due_gmail_connection')
  assert.ok(/p_lease_seconds < 1 OR p_lease_seconds > 600/.test(f))
  assert.ok(/invalid_due_after/.test(f))
})

console.log('\ninvalidate_email_candidates_by_fingerprint')
test('invalidates ONLY the listed fingerprints (never a keep-set sweep)', () => {
  const f = fn('invalidate_email_candidates_by_fingerprint')
  assert.ok(/ic\.source_fingerprint = ANY \(p_fingerprints\)/.test(f), 'positive list match')
  assert.ok(!/NOT \(ic\.source_fingerprint = ANY/.test(f), 'must NOT be an inverse keep-set')
})
test('bounded + shape-validated input', () => {
  const f = fn('invalidate_email_candidates_by_fingerprint')
  assert.ok(/array_length\(p_fingerprints, 1\) > 500/.test(f))
  assert.ok(/f !~ '\^\[0-9a-f\]\{64\}\$'/.test(f))
})
test('run-fenced with the documented lock order, only pending rows', () => {
  const f = fn('invalidate_email_candidates_by_fingerprint')
  assert.ok(/FOR SHARE OF s/.test(f), 'sync-state locked FOR SHARE first')
  assert.ok(/'stale_run'/.test(f))
  assert.ok(/ic\.status = 'pending'/.test(f), 'terminal rows untouched')
})
test('erases retained context on invalidation', () => {
  const f = fn('invalidate_email_candidates_by_fingerprint')
  assert.ok(/retained_subject = NULL/.test(f) && /context_expires_at = NULL/.test(f))
})
test('scoped to the connection and its owning user', () => {
  const f = fn('invalidate_email_candidates_by_fingerprint')
  assert.ok(/r\.connection_id = p_connection_id/.test(f) && /ic\.user_id = v_uid/.test(f))
})

console.log('\nscope guard')
test('no live Gmail scope, scheduler, Edge shell, flag, or secret in the SQL', () => {
  assert.ok(!/gmail\.readonly|gmail\.metadata|googleapis\.com\/auth/.test(CODE), 'no live scope')
  assert.ok(!/pg_cron|cron\.schedule|pg_net|net\.http|webhook/i.test(CODE), 'no scheduler/webhook')
  assert.ok(!/VITE_|Deno\.serve|createClient|ANTHROPIC/.test(CODE), 'no Edge/flag/secret')
})
test('returns controlled codes only — no address/subject/token in any return', () => {
  for (const f of ['upsert_google_capability', 'reserve_due_gmail_connection', 'invalidate_email_candidates_by_fingerprint']) {
    const body = fn(f)
    const returns = body.match(/jsonb_build_object\([^;]*\)/g) || []
    for (const r of returns) {
      assert.ok(!/email|subject|token|ciphertext|address/i.test(r), `${f} return must not carry sensitive fields: ${r}`)
    }
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
