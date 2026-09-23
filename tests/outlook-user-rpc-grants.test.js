// Static invariants for the Outlook PR-A1 grant correction:
// supabase/migrations/20260922175616_revoke_service_role_from_outlook_user_rpcs.sql
//
// Root cause: this project's pre-existing `pg_default_acl` for schema `public`
// (objtype 'f') grants EXECUTE to anon, authenticated AND service_role on every
// function created by postgres. 20260921000000 revoked PUBLIC + anon on the four
// user-action RPCs and granted authenticated, but never named service_role, so the
// default-ACL grant survived in Production. This migration revokes exactly those four.
//
// The catalog-level proof (including a disposable upgrade that first reproduces
// Production's pre-fix ACL, then applies only this migration) lives in
// tests/sql/outlook-user-rpc-grants-runtime.sql.
//
// Run with: node tests/outlook-user-rpc-grants.test.js
import assert from 'assert'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

const MIG_REL = 'supabase/migrations/20260922175616_revoke_service_role_from_outlook_user_rpcs.sql'
const SQL = read(MIG_REL)
const CODE = SQL.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
const PRA = read('supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql')
const RUNTIME = read('tests/sql/outlook-user-rpc-grants-runtime.sql')

// The four user-action RPCs and their EXACT committed signatures (from 20260921000000).
const USER_FNS = {
  accept_new_contact_candidate: 'uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date',
  dismiss_new_contact_candidate: 'uuid',
  defer_candidate: 'text, uuid, timestamptz',
  disconnect_my_outlook: '',
}
const WORKER_FNS = ['finalize_microsoft_connection', 'update_microsoft_connection_state', 'reserve_due_outlook_connection',
  'renew_outlook_sync_lease', 'release_outlook_sync_lease', 'invalidate_outlook_candidates_by_fingerprint',
  'run_microsoft_local_cleanup', 'expire_pending_outlook_context']
const norm = (s) => s.replace(/\s+/g, ' ').trim()

// ── The migration itself ──────────────────────────────────────────────────────
console.log('\nrevoke migration')
test('migration file exists with a CLI-generated timestamp after 20260921000000', () => {
  const files = readdirSync(join(root, 'supabase/migrations')).sort()
  assert.ok(files.includes('20260922175616_revoke_service_role_from_outlook_user_rpcs.sql'))
  assert.strictEqual(files[files.length - 1], '20260922175616_revoke_service_role_from_outlook_user_rpcs.sql', 'must be the newest migration')
  assert.ok(files.includes('20260921000000_add_outlook_content_draft_primitives.sql'), 'PR-A migration still present')
  assert.ok(!files.some(f => f.startsWith('20260918000100')), 'the held-back Cron migration must stay absent')
})
test('revokes service_role EXECUTE on exactly the four user-action RPCs, schema-qualified, with exact argument types', () => {
  const revokes = [...CODE.matchAll(/REVOKE EXECUTE ON FUNCTION (public\.\w+)\(([^)]*)\)\s*FROM service_role;/g)]
    .map(m => [m[1], norm(m[2])])
  assert.strictEqual(revokes.length, 4, `expected 4 revokes, found ${revokes.length}`)
  assert.deepStrictEqual(
    revokes.map(([n]) => n).sort(),
    Object.keys(USER_FNS).map(n => `public.${n}`).sort())
  for (const [name, args] of revokes) {
    const short = name.replace('public.', '')
    assert.strictEqual(args, USER_FNS[short], `${short} signature`)
    assert.ok(args === PRA.match(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${short}\\(([^)]*)\\) TO authenticated`, 's'))?.[1].replace(/\s+/g, ' ').trim(),
      `${short} signature must match the applied GRANT in 20260921000000`)
  }
})
test('every revoke is schema-qualified and carries an argument list (no unqualified or bare name)', () => {
  const stmts = CODE.split(';').map(s => s.trim()).filter(s => /^REVOKE/i.test(s))
  assert.strictEqual(stmts.length, 4)
  for (const s of stmts) {
    assert.ok(/ON FUNCTION public\./.test(s), `unqualified: ${norm(s).slice(0, 70)}`)
    assert.ok(/public\.\w+\s*\(/.test(s), `missing argument list (overload-ambiguous): ${norm(s).slice(0, 70)}`)
    assert.ok(!/ALL FUNCTIONS|ON SCHEMA|ROUTINES/i.test(s), `over-broad target: ${norm(s).slice(0, 70)}`)
  }
})
test('scope: no default-privilege change, no other revoke/grant, no DDL, no DML', () => {
  assert.ok(!/ALTER DEFAULT PRIVILEGES|pg_default_acl/i.test(CODE), 'must not change default privileges')
  assert.ok(!/\bGRANT\b/i.test(CODE), 'no GRANT of any kind')
  assert.ok(!/FROM (PUBLIC|anon|authenticated)\b/i.test(CODE), 'authenticated/PUBLIC/anon access is not modified here')
  assert.ok(!/\b(CREATE|ALTER|DROP|TRUNCATE|COMMENT ON)\b/i.test(CODE), 'no DDL')
  assert.ok(!/\b(INSERT INTO|UPDATE |DELETE FROM|SELECT )/i.test(CODE), 'no DML or queries outside comments')
  assert.ok(!/cron\.|pg_cron|pg_net|CREATE EXTENSION|vault\.|VITE_|http/i.test(CODE), 'no scheduler/extension/secret/provider work')
})
test('worker RPCs, review RPCs and Gmail/Calendar objects are never named in executable code', () => {
  for (const f of WORKER_FNS) assert.ok(!CODE.includes(f), `${f} must not be touched`)
  for (const f of ['accept_interaction_candidate', 'dismiss_interaction_candidate']) assert.ok(!CODE.includes(f), `${f} must not be touched`)
  assert.ok(!/gmail|calendar|google/i.test(CODE), 'no Gmail/Calendar/Google reference')
})
test('the comment documents the default-ACL root cause, the deliberate non-change, and the future rule', () => {
  assert.ok(/pg_default_acl/.test(SQL) && /grants EXECUTE to anon, authenticated AND\n--\s*service_role/.test(SQL), 'default-ACL cause')
  assert.ok(/It does NOT alter project-wide default privileges \(no ALTER DEFAULT\n--\s*PRIVILEGES\)/.test(SQL), 'explicit non-change')
  assert.ok(/narrows[\s\S]{0,400}?exactly the four user-action signatures|REVOKE EXECUTE from service_role on exactly the four user-action signatures/.test(SQL), 'scope statement')
  assert.ok(/FUTURE RULE:[\s\S]{0,200}REVOKE ALL ON FUNCTION[\s\S]{0,60}service_role/.test(SQL), 'future rule for new user-only functions')
})

// ── The contract being corrected (from the applied PR-A migration) ────────────
console.log('\ncontract alignment with 20260921000000')
test('PR-A granted authenticated (not service_role) on the four user RPCs and revoked PUBLIC + anon only', () => {
  for (const [name, args] of Object.entries(USER_FNS)) {
    const grant = new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\) TO authenticated;`, 's')
    assert.ok(grant.test(PRA), `${name} authenticated grant`)
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon;`, 's').test(PRA.replace(/\n\s+/g, ' ')), `${name} revoked PUBLIC+anon`)
    assert.ok(!new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\)\\s*TO service_role`, 's').test(PRA), `${name} never granted service_role explicitly`)
    assert.strictEqual(norm(args), norm(USER_FNS[name]))
  }
})
test('PR-A keeps the eight worker RPCs service_role-only (revoking authenticated) — unchanged by this PR', () => {
  const flat = PRA.replace(/\n\s+/g, ' ')
  for (const f of WORKER_FNS) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`).test(flat), `${f} revoke`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\([^)]*\\) TO service_role;`).test(flat), `${f} service grant`)
  }
})
test('the four user RPCs still derive ownership only from auth.uid() and take no user id (bodies untouched)', () => {
  for (const name of Object.keys(USER_FNS)) {
    const i = PRA.indexOf(`CREATE FUNCTION public.${name}(`)
    assert.ok(i !== -1, `${name} body`)
    const body = PRA.slice(i, PRA.indexOf('\n$$;', i))
    assert.ok(/v_uid\s+uuid := \(SELECT auth\.uid\(\)\)/.test(body), `${name} auth.uid()`)
    assert.ok(!/p_user_id/.test(body), `${name} must not accept a user id`)
  }
})

// ── Runtime harness coverage ──────────────────────────────────────────────────
console.log('\nruntime harness coverage')
test('runtime SQL reproduces the Production default-ACL condition before applying the fix', () => {
  for (const s of ['PRODUCTION-LIKE PRE-FIX ACL', 'GRANT EXECUTE ON FUNCTION public.accept_new_contact_candidate',
    'apply ONLY the new forward migration', 'service_role lost EXECUTE on exactly the four user RPCs',
    'worker RPCs unchanged', 'review RPC ACLs unchanged', 'source hashes unchanged', 'no table ACL / policy / RLS / index / constraint / column / trigger / owner drift',
    'zero Outlook rows']) {
    assert.ok(RUNTIME.includes(s), `runtime SQL missing: ${s}`)
  }
  assert.ok(/RUN ONLY AGAINST A DISPOSABLE LOCAL SUPABASE STACK/.test(RUNTIME))
  const addrs = [...RUNTIME.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]+/gi)].map(m => m[0])
  assert.ok(addrs.every(a => a.endsWith('@example.invalid')), `non-example.invalid address: ${addrs.join(', ')}`)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
