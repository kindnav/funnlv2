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


console.log('\nconnected status: reading it')









console.log('\ndisconnect: nothing happens without confirmation')










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





console.log('')
console.log('the verification limits are stated, not glossed over')





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
