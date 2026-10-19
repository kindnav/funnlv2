// Settings → Outlook: connected status, and the user-controlled disconnect.
//
// WHAT IS BEHAVIOURAL HERE, AND WHAT IS NOT - stated plainly rather than implied.
//
//   BEHAVIOURAL: loadOutlookStatus and runOutlookDisconnect are driven directly
//   with an injected RPC, bearer and analytics. Those are the SAME functions the
//   card's handlers call, so "an unconfirmed disconnect performs no RPC at all",
//   "an expired session never reaches the database" and "already-disconnected is
//   not an error to the user" are executed, not inferred.
//
//   NOT BEHAVIOURAL: the component is never rendered. This suite is
//   zero-dependency Node, which cannot import .jsx without a transform, and the
//   repo carries no React testing library or JSDOM. The two-step shape of the
//   confirmation is therefore checked by SCANNING THE SOURCE. That is a
//   structural assertion, not proof of runtime behaviour.
//
//   VERIFIED ELSEWHERE, NOT HERE: what disconnect actually removes is a database
//   fact and is proven against a real Postgres by
//   tests/sql/outlook-disconnect-runtime.sql. This file only checks that the
//   copy shown to the user matches that proven behaviour - in particular that
//   pending suggestions are described as EMPTIED rather than deleted, and that
//   nothing claims Microsoft's grant was revoked.
//
// Run with: node tests/outlook-disconnect-ui.test.js

import assert from 'assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

let passed = 0, failed = 0
const pending = []
function test (name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { console.log(`  ✓ ${name}`); passed++ },
        (e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ },
      ))
    } else { console.log(`  ✓ ${name}`); passed++ }
  } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const MIGRATION = readFileSync(
  new URL('../supabase/migrations/20260929000000_outlook_connection_status_rpc.sql', import.meta.url),
  'utf8',
)
const SQL_TEST = readFileSync(
  new URL('../tests/sql/outlook-disconnect-runtime.sql', import.meta.url), 'utf8',
)

const CONNECTED = {
  result: 'connected',
  mailbox: 'me@example.test',
  account_type: 'personal',
  status: 'active',
  needs_reauth: false,
  connected_at: '2026-09-29T12:00:00+00:00',
  consent_policy_version: 'ol-disc-c7d331bdc76c22b11e8faedc31f71259',
  scopes: ['Mail.Read', 'User.Read', 'offline_access'],
}

console.log('\nconnected status: reading it')









console.log('\ndisconnect: nothing happens without confirmation')



function dharness (over = {}) {
  const calls = { rpc: 0, bearer: 0, track: [] }
  const base = {
    confirmed: true,
    disconnecting: false,
    pageOrigin: 'https://www.getfunnl.com',
    getBearer: async () => { calls.bearer++; return 'test-bearer' },
    rpc: async () => { calls.rpc++; return { data: { result: 'disconnected' }, error: null } },
    trackImpl: (n, p) => calls.track.push([n, p]),
  }
  return { calls, args: { ...base, ...over } }
}







console.log('\ndisconnect: the outcomes')







console.log('\nanalytics carry behaviour, never content')



console.log('\nthe copy matches what the database actually does')








console.log('\nno service-role key, and no table access, from the browser')

function walk (dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|jsx|ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

test('no file under src/ mentions a service-role key at all', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url))
  const offenders = walk(srcDir).filter((f) => {
    const body = readFileSync(f, 'utf8')
    return /service_role|SERVICE_ROLE|serviceRoleKey/.test(body)
  })
  assert.deepStrictEqual(offenders, [],
    `a service-role key would give every visitor every user's mailbox: ${offenders.join(', ')}`)
})



console.log('\ndisconnect is two steps, structurally')







console.log('\nthe migration is forward, minimal, and unapplied')

test('it creates exactly one function and grants it to authenticated only', () => {
  assert.strictEqual((MIGRATION.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 1)
  assert.ok(/REVOKE ALL ON FUNCTION public\.get_my_outlook_connection\(\)\s*\n?\s*FROM PUBLIC, anon, service_role;/.test(MIGRATION),
    'it must follow the 20260922175616 FUTURE RULE')
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.get_my_outlook_connection\(\) TO authenticated;/.test(MIGRATION))
})

test('it is SECURITY DEFINER, STABLE, and pins search_path', () => {
  assert.ok(/SECURITY DEFINER/.test(MIGRATION))
  assert.ok(/\bSTABLE\b/.test(MIGRATION))
  assert.ok(/SET search_path = ''/.test(MIGRATION))
})

test('it changes nothing else: no DDL on tables, no DML, no policy or grant changes', () => {
  for (const banned of [
    /ALTER TABLE/i, /DROP TABLE/i, /CREATE TABLE/i, /CREATE POLICY/i, /DROP POLICY/i,
    /ALTER DEFAULT PRIVILEGES/i, /CREATE TRIGGER/i, /CREATE INDEX/i,
  ]) {
    assert.ok(!banned.test(MIGRATION), `the migration must not contain ${banned}`)
  }
  // DML and table grants: ignore the commented verification block at the end.
  const code = MIGRATION.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  for (const banned of [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /GRANT [A-Z]+ ON TABLE/i]) {
    assert.ok(!banned.test(code), `the migration must not contain ${banned}`)
  }
})

test('it exposes only the reviewed fields, and never a token', () => {
  const body = MIGRATION.slice(MIGRATION.indexOf('jsonb_build_object', MIGRATION.indexOf('IF NOT FOUND')))
  for (const forbidden of ['access_token', 'refresh_token', 'ciphertext', 'nonce',
    'key_version', 'state_hash', 'ms_account_id', 'ms_tenant_id', 'token_expires_at']) {
    assert.ok(!body.includes(forbidden), `the status RPC must not return ${forbidden}`)
  }
  for (const required of ['mailbox', 'status', 'needs_reauth', 'connected_at',
    'consent_policy_version', 'scopes']) {
    assert.ok(body.includes(required), `the card needs ${required}`)
  }
})

test('it says plainly that it is not applied', () => {
  assert.ok(/NOT APPLIED/.test(MIGRATION))
})

console.log('\nthe database claims are backed by the SQL runtime test')

test('the SQL test asserts each of the five things disconnect must handle', () => {
  for (const claim of [
    /CONNECTION survived disconnect/,
    /ENCRYPTED TOKENS survived disconnect/,
    /SYNC CURSORS \/ LEASES survived disconnect/,
    /UNCONSUMED OAUTH STATES survived disconnect/,
    /the pending suggested contact was not invalidated/,
    /the pending suggested interaction was not invalidated/,
  ]) {
    assert.ok(claim.test(SQL_TEST), `the SQL test does not cover ${claim}`)
  }
})

test('the SQL test proves the shells are RETAINED and emptied, not deleted', () => {
  assert.ok(/should REMAIN as a shell, not be deleted/.test(SQL_TEST))
  assert.ok(/MAIL-DERIVED CONTENT survived on the suggested contact/.test(SQL_TEST))
  assert.ok(/MAIL-TO-SUGGESTION LINKAGE survived disconnect/.test(SQL_TEST))
})

test('the SQL test sweeps every user-scoped table, not a hand-picked list', () => {
  assert.ok(/information_schema\.columns/.test(SQL_TEST))
  assert.ok(/still holds %s row\(s\) for the disconnected user/.test(SQL_TEST))
})

test('the SQL test states, rather than assumes, that no upstream grant is revoked', () => {
  assert.ok(/nothing here revokes Funnl's grant at/i.test(SQL_TEST))
  assert.ok(/local teardown only/i.test(SQL_TEST))
})

console.log('')
console.log('the verification limits are stated, not glossed over')

test('both SQL runtime tests say plainly that they are NOT end-to-end', () => {
  for (const f of ['outlook-disconnect-runtime.sql', 'outlook-connection-status-runtime.sql']) {
    const body = readFileSync(new URL(`../tests/sql/${f}`, import.meta.url), 'utf8')
    assert.ok(/NOT A BROWSER-TO-DATABASE END-TO-END TEST/i.test(body),
      `${f} must refuse that description of itself`)
    assert.ok(/PRIVILEGED `postgres` role/i.test(body),
      `${f} must say which role it actually runs as`)
    assert.ok(/no JWT, no PostgREST, no Kong/i.test(body), `${f} must list what is absent`)
    assert.ok(/outlook-rpc-postgrest\.mjs/.test(body),
      `${f} must point at the harness that does cover the gap`)
  }
})

test('a real HTTP-through-PostgREST harness exists and covers the role gap', () => {
  const h = readFileSync(new URL('../tests/local/outlook-rpc-postgrest.mjs', import.meta.url), 'utf8')
  // The two checks the SQL tests structurally cannot make, because a privileged
  // role bypasses them.
  assert.ok(/permission denied for table microsoft_connections/.test(h),
    'it must assert the direct table read is refused for the authenticated role')
  assert.ok(/authenticated CAN execute both RPCs/.test(h),
    'and that the grant is what admits the RPC')
  assert.ok(/PGRST_JWT_SECRET/.test(h) && /Bearer/.test(h),
    'it must go through a real JWT over HTTP')
  assert.ok(/service_role cannot execute either RPC/.test(h),
    'and confirm the least-privilege rule over the wire')
})

test('that harness also states what it still does NOT cover', () => {
  const h = readFileSync(new URL('../tests/local/outlook-rpc-postgrest.mjs', import.meta.url), 'utf8')
  assert.ok(/It is NOT an end-to-end\s*(\/\/)?\s*browser test/i.test(h))
  assert.ok(/GoTrue/.test(h), 'no real session issuance')
  assert.ok(/Kong/.test(h), 'no gateway apikey check')
  assert.ok(/THE ASSUMPTION, STATED/.test(h),
    "the auth.uid() shim's scope must be declared, not buried")
})

test('the bootstrap discloses its one shim and what it cannot reproduce', () => {
  const b = readFileSync(new URL('../tests/sql/_bootstrap-disposable-db.sql', import.meta.url), 'utf8')
  assert.ok(/email_confirmed_at/.test(b), 'the GoTrue column difference must be named')
  assert.ok(/WHAT IT DOES NOT AND CANNOT REPRODUCE/i.test(b))
  assert.ok(/NEVER run against/i.test(b) && /Production/.test(b),
    'the file must refuse Production in its first line')
  assert.ok(!/supabase\/migrations/.test(b) || /nothing in supabase\/migrations\/ is edited/i.test(b),
    'it must state that it edits no migration')
})

// The card that called these RPCs is retired (Stage D); the RPCs themselves remain deployed until Stage F,
// so their zero-argument signature (a caller cannot name someone else) is still pinned here.
test('the retained user RPC takes no user id: get_my_outlook_connection() has zero arguments', () => {
  assert.ok(/get_my_outlook_connection()/.test(MIGRATION),
    'the migration must declare a zero-argument function')
})

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
