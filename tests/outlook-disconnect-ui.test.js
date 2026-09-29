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
import {
  DISCONNECT_CONSEQUENCES, DISCONNECT_CONFIRM_LABEL,
  classifyStatusResponse, classifyDisconnectResponse,
  messageForDisconnect, messageForStatus,
  loadOutlookStatus, runOutlookDisconnect,
} from '../src/lib/outlookDisconnect.js'

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

const CARD = readFileSync(new URL('../src/components/OutlookConnectionCard.jsx', import.meta.url), 'utf8')
const LIB = readFileSync(new URL('../src/lib/outlookDisconnect.js', import.meta.url), 'utf8')
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

test('a connected mailbox is reported with the fields the card shows', () => {
  const r = classifyStatusResponse(null, CONNECTED)
  assert.strictEqual(r.kind, 'connected')
  assert.strictEqual(r.connection.mailbox, 'me@example.test')
  assert.strictEqual(r.connection.needsReauth, false)
  assert.strictEqual(r.connection.consentVersion, CONNECTED.consent_policy_version)
  assert.deepStrictEqual(r.connection.scopes, ['Mail.Read', 'User.Read', 'offline_access'])
})

test('needs_reauth is carried through so the card can warn', () => {
  const r = classifyStatusResponse(null, { ...CONNECTED, needs_reauth: true, status: 'needs_reauth' })
  assert.strictEqual(r.connection.needsReauth, true)
  assert.strictEqual(r.connection.status, 'needs_reauth')
})

test('not_connected and unauthorized are distinct, and neither carries a mailbox', () => {
  const a = classifyStatusResponse(null, { result: 'not_connected' })
  assert.strictEqual(a.kind, 'not_connected')
  assert.strictEqual(a.connection, undefined)
  const b = classifyStatusResponse(null, { result: 'unauthorized' })
  assert.strictEqual(b.kind, 'signed_out')
  assert.strictEqual(b.connection, undefined)
})

test('a PostgREST error, an unknown result and a non-object are all just failures', () => {
  assert.strictEqual(classifyStatusResponse({ message: 'permission denied' }, null).kind, 'error')
  assert.strictEqual(classifyStatusResponse(null, { result: 'something_new' }).kind, 'error')
  assert.strictEqual(classifyStatusResponse(null, null).kind, 'error')
  assert.strictEqual(classifyStatusResponse(null, 'connected').kind, 'error')
})

test('the status object is built field by field, so an unexpected field cannot leak', () => {
  // If the RPC were ever widened by mistake, the card still only ever sees the
  // reviewed fields: this maps explicitly rather than spreading the response.
  const r = classifyStatusResponse(null, {
    ...CONNECTED,
    access_token: 'should-never-reach-the-ui',
    refresh_token_ciphertext: 'nor-this',
    id: '00000000-0000-0000-0000-000000000000',
  })
  const keys = Object.keys(r.connection).sort()
  assert.deepStrictEqual(keys, [
    'accountType', 'connectedAt', 'consentVersion', 'mailbox',
    'needsReauth', 'scopes', 'status',
  ])
  assert.ok(!JSON.stringify(r).includes('should-never-reach-the-ui'))
  assert.ok(!JSON.stringify(r).includes('nor-this'))
})

test('a malformed scopes value degrades to an empty list rather than throwing', () => {
  assert.deepStrictEqual(classifyStatusResponse(null, { ...CONNECTED, scopes: 'Mail.Read' }).connection.scopes, [])
  assert.deepStrictEqual(
    classifyStatusResponse(null, { ...CONNECTED, scopes: ['Mail.Read', 7, null] }).connection.scopes,
    ['Mail.Read'],
  )
})

test('loadOutlookStatus surfaces a thrown RPC as a controlled failure', async () => {
  const r = await loadOutlookStatus({ rpc: async () => { throw new Error('offline') } })
  assert.strictEqual(r.kind, 'error')
  assert.ok(r.message.length > 0)
  assert.ok(!/offline/i.test(r.message), 'the raw error must not reach the user')
})

test('loadOutlookStatus returns a message only when there is nothing to show', async () => {
  const ok = await loadOutlookStatus({ rpc: async () => ({ data: CONNECTED, error: null }) })
  assert.strictEqual(ok.message, '')
  const out = await loadOutlookStatus({ rpc: async () => ({ data: { result: 'unauthorized' }, error: null }) })
  assert.ok(/sign in again/i.test(out.message))
})

console.log('\ndisconnect: nothing happens without confirmation')

test('the disconnect result codes map one-to-one, and nothing else is success', () => {
  assert.strictEqual(classifyDisconnectResponse(null, { result: 'disconnected' }).kind, 'disconnected')
  assert.strictEqual(classifyDisconnectResponse(null, { result: 'not_connected' }).kind, 'already_disconnected')
  assert.strictEqual(classifyDisconnectResponse(null, { result: 'unauthorized' }).kind, 'signed_out')
  for (const bad of [null, undefined, 'disconnected', 42, { result: 'partial' }, {}]) {
    assert.strictEqual(classifyDisconnectResponse(null, bad).kind, 'error', JSON.stringify(bad))
  }
  // An error object wins even when a body is present: a partial failure must
  // never be read as a completed disconnect.
  assert.strictEqual(
    classifyDisconnectResponse({ message: 'timeout' }, { result: 'disconnected' }).kind, 'error')
})


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

test('UNCONFIRMED: no RPC is made and the bearer is never even requested', async () => {
  const h = dharness({ confirmed: false })
  const r = await runOutlookDisconnect(h.args)
  assert.strictEqual(h.calls.rpc, 0, 'nothing may be sent without confirmation')
  assert.strictEqual(h.calls.bearer, 0, 'refusal must precede any credential use')
  assert.strictEqual(r.disconnected, false)
  assert.strictEqual(r.kind, 'not_confirmed')
})

test('a truthy-but-not-true confirmation is still a refusal', async () => {
  for (const v of ['true', 1, {}, [], 'yes']) {
    const h = dharness({ confirmed: v })
    const r = await runOutlookDisconnect(h.args)
    assert.strictEqual(h.calls.rpc, 0, `confirmed=${JSON.stringify(v)} must refuse`)
    assert.strictEqual(r.disconnected, false)
  }
})

test('a request already in flight does not start a second one', async () => {
  const h = dharness({ disconnecting: true })
  await runOutlookDisconnect(h.args)
  assert.strictEqual(h.calls.rpc, 0)
})

test('a non-canonical origin makes no RPC', async () => {
  const h = dharness({ pageOrigin: 'https://getfunnl.com' })
  const r = await runOutlookDisconnect(h.args)
  assert.strictEqual(h.calls.rpc, 0)
  assert.ok(/www\.getfunnl\.com/.test(r.message))
})

test('no session: refuses before reaching the database', async () => {
  const h = dharness({ getBearer: async () => null })
  const r = await runOutlookDisconnect(h.args)
  assert.strictEqual(h.calls.rpc, 0)
  assert.strictEqual(r.kind, 'signed_out')
})

test('a thrown bearer lookup is treated as signed out, not as a crash', async () => {
  const h = dharness({ getBearer: async () => { throw new Error('boom') } })
  const r = await runOutlookDisconnect(h.args)
  assert.strictEqual(h.calls.rpc, 0)
  assert.strictEqual(r.kind, 'signed_out')
})

console.log('\ndisconnect: the outcomes')

test('SUCCESS: exactly one RPC, and it reports disconnected', async () => {
  const h = dharness()
  const r = await runOutlookDisconnect(h.args)
  assert.strictEqual(h.calls.rpc, 1, 'exactly one call')
  assert.strictEqual(r.kind, 'disconnected')
  assert.strictEqual(r.disconnected, true)
})

test('ALREADY GONE is not an error to the user', async () => {
  // Another tab, or a connection the provider already revoked. The user asked
  // for it to be gone and it is gone.
  const h = dharness({ rpc: async () => ({ data: { result: 'not_connected' }, error: null }) })
  const r = await runOutlookDisconnect(h.args)
  assert.strictEqual(r.kind, 'already_disconnected')
  assert.strictEqual(r.disconnected, true)
  assert.ok(!/could not/i.test(r.message))
})

test('the database refusing an unauthenticated caller reads as signed out', async () => {
  const h = dharness({ rpc: async () => ({ data: { result: 'unauthorized' }, error: null }) })
  const r = await runOutlookDisconnect(h.args)
  assert.strictEqual(r.kind, 'signed_out')
  assert.strictEqual(r.disconnected, false)
})

test('an RPC error never claims the mailbox was disconnected', async () => {
  for (const res of [
    { data: null, error: { message: 'permission denied for function' } },
    { data: { result: 'who_knows' }, error: null },
    { data: null, error: null },
  ]) {
    const h = dharness({ rpc: async () => res })
    const r = await runOutlookDisconnect(h.args)
    assert.strictEqual(r.disconnected, false, JSON.stringify(res))
    assert.strictEqual(r.kind, 'error')
  }
})

test('a thrown RPC is a controlled failure and leaks no database message', async () => {
  const h = dharness({ rpc: async () => { throw new Error('connection reset by peer') } })
  const r = await runOutlookDisconnect(h.args)
  assert.strictEqual(r.disconnected, false)
  assert.ok(!/connection reset/i.test(r.message))
})

test('no user-facing message ever echoes a database or PostgREST string', () => {
  for (const kind of ['disconnected', 'already_disconnected', 'signed_out',
    'not_confirmed', 'non_canonical_origin', 'error', 'anything_else']) {
    const m = messageForDisconnect(kind)
    assert.ok(m.length > 0, kind)
    assert.ok(!/(permission denied|PGRST|relation |function |42501|SQLSTATE)/i.test(m), kind)
  }
  for (const kind of ['signed_out', 'error']) {
    assert.ok(messageForStatus(kind).length > 0, kind)
  }
  assert.strictEqual(messageForStatus('connected'), '', 'a healthy state needs no message')
  assert.strictEqual(messageForStatus('not_connected'), '')
})

console.log('\nanalytics carry behaviour, never content')

test('a real disconnect fires one event with no mailbox or identifier in it', async () => {
  const h = dharness()
  await runOutlookDisconnect(h.args)
  assert.deepStrictEqual(h.calls.track, [['outlook_disconnected', { provider: 'outlook' }]])
})

test('nothing is tracked for a refusal, a failure, or an already-gone connection', async () => {
  for (const over of [
    { confirmed: false },
    { getBearer: async () => null },
    { rpc: async () => ({ data: null, error: { message: 'x' } }) },
    { rpc: async () => ({ data: { result: 'not_connected' }, error: null }) },
  ]) {
    const h = dharness(over)
    await runOutlookDisconnect(h.args)
    assert.deepStrictEqual(h.calls.track, [], JSON.stringify(Object.keys(over)))
  }
})

console.log('\nthe copy matches what the database actually does')

test('every consequence is labelled with a verified effect', () => {
  const allowed = ['deleted', 'emptied', 'kept', 'upstream']
  assert.ok(DISCONNECT_CONSEQUENCES.length >= 4, 'the confirmation must be specific')
  for (const c of DISCONNECT_CONSEQUENCES) {
    assert.ok(allowed.includes(c.effect), `unreviewed effect: ${c.effect}`)
    assert.ok(typeof c.text === 'string' && c.text.length > 20, c.effect)
  }
  for (const effect of allowed) {
    assert.ok(DISCONNECT_CONSEQUENCES.some((c) => c.effect === effect),
      `the confirmation never mentions what is ${effect}`)
  }
})

test('suggestions are described as EMPTIED, never as deleted', () => {
  // The applied RPC keeps the candidate row and NULLs its contents. The SQL
  // runtime test asserts exactly that, so the copy must not say "deleted".
  const emptied = DISCONNECT_CONSEQUENCES.filter((c) => c.effect === 'emptied')
  assert.strictEqual(emptied.length, 1)
  const t = emptied[0].text
  assert.ok(/suggestion/i.test(t))
  assert.ok(/emptied|removed/i.test(t))
  assert.ok(!/deleted/i.test(t), 'the suggestion row is not deleted')
  assert.ok(/kept|remains|retained/i.test(t), 'the surviving empty record must be disclosed')
})

test('the confirmation says saved contacts and interactions are KEPT', () => {
  const kept = DISCONNECT_CONSEQUENCES.find((c) => c.effect === 'kept')
  assert.ok(/contacts/i.test(kept.text) && /interactions/i.test(kept.text))
  assert.ok(/kept/i.test(kept.text))
})

test('nothing in the confirmation claims Microsoft revoked anything', () => {
  const upstream = DISCONNECT_CONSEQUENCES.find((c) => c.effect === 'upstream')
  assert.ok(/does not withdraw the permission at Microsoft/i.test(upstream.text),
    'the limit of a local disconnect must be stated')
  const all = DISCONNECT_CONSEQUENCES.map((c) => c.text).join(' ')
  for (const s of all.split(/(?<=[.])\s+/)) {
    if (!/revok|withdraw/i.test(s)) continue
    assert.ok(/does not|do not|cannot|never/i.test(s), `claims revocation: ${s}`)
  }
})

test('the module states the upstream limit where a reader will see it', () => {
  assert.ok(/does not revoke Funnl's grant at Microsoft/i.test(LIB),
    'the file must record that no upstream revocation exists')
  assert.ok(/No\s*(\/\/)?\s*upstream revocation call exists/i.test(LIB),
    'and that the absence is why the copy points at Microsoft instead')
})

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

test('the card reaches the database only through the two user RPCs', () => {
  assert.ok(!/\.from\(/.test(CARD), 'no direct table access from the card')
  const named = [...CARD.matchAll(/\.rpc\(\s*'([^']*)'/g)].map((m) => m[1]).sort()
  assert.deepStrictEqual(named, ['disconnect_my_outlook', 'get_my_outlook_connection'])
})

test('neither RPC takes a user id, so a caller cannot name someone else', () => {
  assert.ok(/supabase\.rpc\('get_my_outlook_connection'\)/.test(CARD))
  assert.ok(/supabase\.rpc\('disconnect_my_outlook'\)/.test(CARD))
  assert.ok(!/rpc\('(get_my_outlook_connection|disconnect_my_outlook)',/.test(CARD),
    'passing arguments would mean the function accepts some')
  assert.ok(/get_my_outlook_connection\(\)/.test(MIGRATION),
    'the migration must declare a zero-argument function')
})

console.log('\ndisconnect is two steps, structurally')

test('the confirmation panel is a separate state that starts closed', () => {
  assert.ok(/const \[confirmingDisconnect, setConfirmingDisconnect\] = useState\(false\)/.test(CARD),
    'the panel must start closed')
  assert.ok(!/defaultChecked|confirmingDisconnect = true/.test(CARD))
})

test('the first button only OPENS the panel; it cannot disconnect', () => {
  const opener = CARD.slice(CARD.indexOf('Disconnect Outlook</'))
  assert.ok(CARD.includes('setConfirmingDisconnect(true)'), 'the first button opens the panel')
  assert.ok(!/setConfirmingDisconnect\(true\)[^)]*handleDisconnect/.test(CARD),
    'opening the panel must not also disconnect')
  assert.strictEqual((CARD.match(/onClick=\{handleDisconnect\}/g) || []).length, 1,
    'exactly one control may disconnect')
  assert.ok(opener.length > 0)
})

test('the only disconnecting control lives inside the open panel', () => {
  const panelStart = CARD.indexOf('{confirmingDisconnect && (')
  assert.ok(panelStart > 0, 'the panel must be conditional on the confirmation state')
  const confirmAt = CARD.indexOf('onClick={handleDisconnect}')
  assert.ok(confirmAt > panelStart, 'the confirm button must render inside the panel')
  assert.ok(CARD.includes('DISCONNECT_CONFIRM_LABEL'), 'and carry the explicit label')
  assert.ok(/^Yes, disconnect/.test(DISCONNECT_CONFIRM_LABEL),
    'the confirming button must restate the action, not say OK')
  assert.ok(/Outlook/.test(DISCONNECT_CONFIRM_LABEL))
  assert.ok(/Cancel/.test(CARD.slice(panelStart)), 'the panel must offer a way out')
})

test('the panel states every consequence rather than a summary', () => {
  assert.ok(/DISCONNECT_CONSEQUENCES\.map\(/.test(CARD),
    'the card must render the reviewed consequence list, not its own wording')
})

test('the confirm handler passes confirmed: true only from that handler', () => {
  assert.strictEqual((CARD.match(/confirmed: true/g) || []).length, 1)
  const handler = CARD.slice(CARD.indexOf('async function handleDisconnect'))
  assert.ok(handler.includes('confirmed: true'))
})

test('a successful disconnect re-reads the status instead of assuming it', () => {
  const handler = CARD.slice(CARD.indexOf('async function handleDisconnect'))
  assert.ok(/if \(result\.disconnected\)/.test(handler))
  assert.ok(/refreshStatus\(\)/.test(handler),
    'the connected/not-connected state must come from the database, not local state')
  assert.ok(/setAcknowledged\(false\)/.test(handler),
    'reconnecting must require a fresh acknowledgement')
})

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

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
