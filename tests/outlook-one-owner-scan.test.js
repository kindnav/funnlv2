// ONE FUNNL OWNER PER MICROSOFT ACCOUNT - static proof of migration 20261014000000.
//
// The migration re-issues finalize_microsoft_connection. These checks pin that the ONLY
// change is the fenced `-- >>> 20261014` / `-- <<< 20261014` blocks: strip them and the
// function must equal the applied 20260928000000 definition byte for byte. They also pin
// that the migration deletes, disconnects and updates nothing outside the function, that
// the index is on the provider identity (tenant + object id) and not on mailbox text, and
// that the callback maps the refusal only after the browser binding has passed.
//
// Behaviour (the defect reproduced, the refusal, the race, same-user updates, subscription
// interference) is proven against a real database in tests/local/outlook-one-owner.mjs.

import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const APPLIED = 'supabase/migrations/20260928000000_outlook_add_user_read_scope.sql'
const FIX = 'supabase/migrations/20261014000000_outlook_one_owner_per_microsoft_account.sql'
const HANDLER = 'supabase/functions/outlook-oauth-callback/handler.js'

let passed = 0
let failed = 0
const pending = []
function test (name, fn) {
  pending.push((async () => { try { await fn(); console.log('  OK   ' + name); passed += 1 } catch (e) {
    console.error('  FAIL ' + name)
    console.error('       ' + (e && e.message ? e.message : String(e)))
    failed += 1
  } })())
}

const START = 'CREATE OR REPLACE FUNCTION public.finalize_microsoft_connection(\n'
const END = '\n$$;\n'

function functionText (file) {
  const s = read(file)
  const i = s.indexOf(START)
  assert.ok(i >= 0, `${file}: no finalize_microsoft_connection definition`)
  const j = s.indexOf(END, i)
  assert.ok(j > i, `${file}: unterminated function body`)
  return s.slice(i, j + END.length)
}

/** Remove every fenced block, markers included. */
function stripFenced (text) {
  return text.replace(/^[ \t]*-- >>> 20261014[^\n]*\n[\s\S]*?^[ \t]*-- <<< 20261014[^\n]*\n/gm, '')
}

const fix = read(FIX)
const fixFn = functionText(FIX)
const outside = fix.replace(fixFn, '')

test('the fix is the latest migration that defines finalize_microsoft_connection', () => {
  const files = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  const definers = files.filter((f) =>
    read(`supabase/migrations/${f}`).includes('FUNCTION public.finalize_microsoft_connection('))
  assert.strictEqual(definers[definers.length - 1], FIX.split('/').pop(), definers.join(', '))
  assert.strictEqual(definers[definers.length - 2], APPLIED.split('/').pop(), definers.join(', '))
})

test('with the fenced blocks removed, the function equals the applied definition byte for byte', () => {
  const stripped = stripFenced(fixFn)
  const applied = functionText(APPLIED)
  if (stripped !== applied) {
    const a = applied.split('\n'); const b = stripped.split('\n')
    const k = a.findIndex((l, n) => l !== b[n])
    assert.fail(`first difference at line ${k + 1}:\n  applied: ${JSON.stringify(a[k])}\n  fix:     ${JSON.stringify(b[k])}`)
  }
})

test('exactly four fenced blocks, each opened and closed', () => {
  assert.strictEqual((fixFn.match(/-- >>> 20261014/g) || []).length, 4)
  assert.strictEqual((fixFn.match(/-- <<< 20261014/g) || []).length, 4)
})

test('the refusal is a controlled result returned from both the check and the race handler', () => {
  assert.strictEqual((fixFn.match(/RETURN jsonb_build_object\('result', 'account_in_use'\);/g) || []).length, 2)
  // The race handler maps ONLY this index's violation; anything else re-raises.
  assert.ok(/EXCEPTION WHEN unique_violation THEN\s+GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;\s+IF v_constraint = 'microsoft_connections_ms_identity_unique' THEN\s+RETURN jsonb_build_object\('result', 'account_in_use'\);\s+END IF;\s+RAISE;\s+END;/.test(fixFn))
})

test('the cross-user check excludes the caller and compares identity, never the mailbox address', () => {
  const block = fixFn.slice(fixFn.indexOf('-- >>> 20261014 ONE FUNNL OWNER'), fixFn.indexOf('-- 5. Connection + tokens'))
  assert.ok(/c\.user_id <> v_uid/.test(block), 'the caller\'s own row is excluded')
  assert.ok(/COALESCE\(pg_catalog\.lower\(c\.ms_tenant_id\), ''\) = COALESCE\(pg_catalog\.lower\(p_ms_tenant_id\), ''\)/.test(block))
  assert.ok(/pg_catalog\.lower\(c\.ms_account_id\) = pg_catalog\.lower\(p_ms_account_id\)/.test(block))
  assert.ok(!/ms_email/.test(block.replace(/^\s*--.*$/gm, '')), 'mailbox text must not be part of identity')
})

test('the check runs after the same-account rule and before any write', () => {
  const same = fixFn.indexOf("'different_account'")
  const check = fixFn.indexOf('-- >>> 20261014 ONE FUNNL OWNER')
  const insert = fixFn.indexOf('INSERT INTO public.microsoft_connections')
  const consume = fixFn.indexOf('SET consumed_at = now()')
  assert.ok(same > 0 && same < check && check < insert && insert < consume)
})

test('the unique index is on tenant + object id, case-folded', () => {
  assert.ok(outside.includes(`CREATE UNIQUE INDEX microsoft_connections_ms_identity_unique
  ON public.microsoft_connections
  ((COALESCE(pg_catalog.lower(ms_tenant_id), '')), (pg_catalog.lower(ms_account_id)));`))
})

test('the migration deletes, disconnects and rewrites nothing outside the function', () => {
  const code = outside.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  for (const verb of [/\bDELETE\b/i, /\bTRUNCATE\b/i, /\bUPDATE\b/i, /\bDROP\b/i, /\bINSERT\b/i, /\bALTER\b/i]) {
    assert.ok(!verb.test(code), `found ${verb} outside the function`)
  }
  // An existing duplicate stops the migration rather than being resolved by it.
  assert.ok(/IF v_dupes > 0 THEN\s+RAISE EXCEPTION 'outlook_one_owner_duplicates/.test(code))
})

test('signature, security and grants are restated unchanged', () => {
  const applied = read(APPLIED)
  const grants = (s) => s.slice(s.indexOf('REVOKE ALL ON FUNCTION public.finalize_microsoft_connection('))
    .split('\n').slice(0, 6).join('\n')
  assert.strictEqual(grants(fix), grants(applied))
  assert.ok(fixFn.includes('SECURITY DEFINER\nSET search_path = \'\'\n'))
})

test('the callback maps account_in_use to in_use only after binding, through its own module', () => {
  const h = read(HANDLER)
  const binding = h.indexOf('verifyMsBrowserBinding(')
  const finalize = h.indexOf("'finalize_microsoft_connection'")
  const map = h.indexOf('refusalRedirect(trustedOrigin, result)')
  assert.ok(binding > 0 && binding < finalize && finalize < map, 'order: binding, finalize, mapping')
  assert.ok(/import \{ refusalRedirect \} from '\.\/refusals\.js'/.test(h))
})

test('refusals.js maps exactly account_in_use, and only with a trusted origin', async () => {
  const m = await import(new URL('../supabase/functions/outlook-oauth-callback/refusals.js', import.meta.url))
  const o = 'https://www.getfunnl.com'
  assert.strictEqual(m.refusalRedirect(o, 'account_in_use'), `${o}/settings?outlook=in_use`)
  for (const r of ['stored', 'different_account', 'state_consumed', 'ACCOUNT_IN_USE', 'in_use', null, undefined, 42]) {
    assert.strictEqual(m.refusalRedirect(o, r), null, String(r))
  }
  for (const bad of [null, undefined, '', 0]) assert.strictEqual(m.refusalRedirect(bad, 'account_in_use'), null)
})

test('the change stays inside the callback: the shared helper is untouched and no other function imports refusals.js', () => {
  const shared = read('supabase/functions/shared/microsoftOauthHelpers.js')
  assert.ok(/const r = result === 'connected' \? 'connected' : 'error'/.test(shared),
    'buildOutlookSettingsRedirect must still emit only connected or error')
  const fns = readdirSync(join(ROOT, 'supabase/functions')).filter((d) => d !== 'outlook-oauth-callback')
  for (const d of fns) {
    for (const f of ['index.ts', 'handler.js']) {
      let t = ''
      try { t = read(`supabase/functions/${d}/${f}`) } catch { continue }
      assert.ok(!t.includes('refusals.js'), `${d}/${f} imports refusals.js`)
    }
  }
})

await Promise.all(pending)
console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
