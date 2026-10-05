// The Graph-vs-id_token identity rule, and the Settings surface for a refused
// callback.
//
// WHAT THIS NOW ENFORCES. Two rules and no others:
//   RULE 1, every account type: case-insensitive exact equality.
//   RULE 2, PERSONAL ONLY: the validated `oid` is a GUID whose leading 16 hex
//           digits are zero and whose trailing 16 are exactly the Graph `id`.
//
// Rule 2 exists because one controlled Production attempt MEASURED that shape
// for the pilot's personal account - account=personal, oid_shape=guid/len 36,
// graph_id_shape=hex16/len 16, graph_id_is_short_form_of_oid=true - using only
// the shape and relationship booleans this module already emitted. No
// identifier was logged to establish it, and none appears in this file: every
// value below is invented.
//
// WHAT MUST STILL FAIL, and is asserted here: the reverse direction, a flat
// 32-hex form, a bare suffix match, an email match, rule 2 on work/school or
// unknown accounts, unrelated personal ids, and malformed ids.
//
// SCOPE. The functions below are EXECUTED. Two source scans cover the
// handler's ordering and its log hygiene, which cannot be imported here
// (handler.js imports from esm.sh). Real-handler behaviour - including that the
// mapped personal pair now REACHES finalization and that ms_account_id stays
// the validated oid - is proven by
// tests/outlook-callback-positive-integration.test.js (opt-in: Docker +
// FUNNL_EDGE_INTEGRATION=1); the rendered card by
// tests/local/outlook-pilot-browser.mjs. No real Microsoft response is
// exercised anywhere.
//
// Run with: node tests/outlook-graph-identity.test.js

import assert from 'assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  resolveMailboxFromGraphBody,
  fetchMailboxAddress,
  classifyGraphIdentityMatch,
  describeIdentityMismatch,
  identifierShape,
  isZeroPaddedGuidOf,
  IDENTITY_MATCH_EXACT,
  IDENTITY_MATCH_PERSONAL_SHORT_FORM,
  IDENTITY_MATCHES,
} from '../supabase/functions/shared/microsoftGraphMe.js'
import {
  readOutlookCallbackResult,
  messageForOutcome,
  OUTLOOK_CALLBACK_RESULTS,
} from '../src/lib/outlookConnection.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

// Executable code only: this repo's explanatory prose names the very symbols
// the scans search for.
const exec = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')

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
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`); failed++
  }
}

// Invented fixtures. PERSONAL_OID_GUID has an all-zero leading half, so
// PERSONAL_SHORT_16 is its zero-padded short form. WORK_OID_GUID does not, so
// WORK_SHORT_16 is a bare suffix coincidence.
const PERSONAL_OID_GUID = '00000000-0000-0000-7a3b-9c15e204d6f8'
const PERSONAL_SHORT_16 = '7a3b9c15e204d6f8'
const PERSONAL_FLAT_32 = PERSONAL_OID_GUID.replace(/-/g, '')
const WORK_OID_GUID = 'c41d8f72-5b90-4e63-a1d2-77f0ba3c9e45'
const WORK_SHORT_16 = 'a1d277f0ba3c9e45'
const MAIL = 'student@outlook.test'

console.log('')
console.log('RULE 1: case-insensitive exact equality, every account type')

test('an exactly equal pair resolves and reports the exact rule', () => {
  for (const t of ['personal', 'work', 'unknown', undefined]) {
    assert.deepStrictEqual(
      resolveMailboxFromGraphBody({ id: PERSONAL_OID_GUID, mail: MAIL }, PERSONAL_OID_GUID, t),
      { ok: true, email: MAIL, identityMatch: IDENTITY_MATCH_EXACT }, String(t))
  }
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody({ id: WORK_OID_GUID, mail: MAIL }, WORK_OID_GUID, 'work'),
    { ok: true, email: MAIL, identityMatch: IDENTITY_MATCH_EXACT })
  // Case and surrounding space are normalised; nothing else is.
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody({ id: ' ' + WORK_OID_GUID.toUpperCase(), mail: MAIL },
      WORK_OID_GUID, 'work'),
    { ok: true, email: MAIL, identityMatch: IDENTITY_MATCH_EXACT })
})

console.log('')
console.log('RULE 2: the measured personal short form, and ONLY that')

test('a personal 16-hex Graph id against its zero-padded GUID oid now RESOLVES', () => {
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody({ id: PERSONAL_SHORT_16, mail: MAIL },
      PERSONAL_OID_GUID, 'personal'),
    { ok: true, email: MAIL, identityMatch: IDENTITY_MATCH_PERSONAL_SHORT_FORM })
  // Case-insensitive on the short form too, as Graph casing is not promised.
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: PERSONAL_SHORT_16.toUpperCase(), mail: MAIL },
      PERSONAL_OID_GUID, 'personal').identityMatch,
    IDENTITY_MATCH_PERSONAL_SHORT_FORM)
})

test('the REVERSE direction is NOT accepted', () => {
  // A GUID from Graph against a 16-hex oid. Only isZeroPaddedGuidOf(oid, gid)
  // is consulted, so this must stay a mismatch.
  const r = resolveMailboxFromGraphBody({ id: PERSONAL_OID_GUID, mail: MAIL },
    PERSONAL_SHORT_16, 'personal')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'graph_identity_mismatch')
  assert.strictEqual(r.diagnostic.oid_is_short_form_of_graph_id, true,
    'the diagnostic still records the mirror relationship')
  assert.strictEqual(r.diagnostic.graph_id_is_short_form_of_oid, false)
  assert.strictEqual(classifyGraphIdentityMatch(PERSONAL_OID_GUID, PERSONAL_SHORT_16,
    'personal'), null)
})

test('a FLAT 32-hex form is NOT accepted, in either position', () => {
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: PERSONAL_FLAT_32, mail: MAIL },
      PERSONAL_OID_GUID, 'personal').reason,
    'graph_identity_mismatch')
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: PERSONAL_SHORT_16, mail: MAIL },
      PERSONAL_FLAT_32, 'personal').reason,
    'graph_identity_mismatch')
  assert.strictEqual(classifyGraphIdentityMatch(PERSONAL_FLAT_32, PERSONAL_OID_GUID,
    'personal'), null)
})

test('a bare SUFFIX match is NOT accepted - the leading half must be all zero', () => {
  // WORK_SHORT_16 IS the trailing 16 hex digits of WORK_OID_GUID. Even labelled
  // personal, the non-zero leading half must refuse it.
  assert.strictEqual(classifyGraphIdentityMatch(WORK_SHORT_16, WORK_OID_GUID, 'personal'), null)
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: WORK_SHORT_16, mail: MAIL },
      WORK_OID_GUID, 'personal').reason,
    'graph_identity_mismatch')
  // Partial suffixes of a zero-padded GUID are refused as well.
  for (const id of ['9c15e204d6f8', 'e204d6f8', '00000000', '0000000000000000']) {
    assert.strictEqual(classifyGraphIdentityMatch(id, PERSONAL_OID_GUID, 'personal'), null, id)
  }
})

test('rule 2 is refused for WORK/SCHOOL and UNKNOWN accounts', () => {
  for (const t of ['work', 'unknown', undefined, null, '', 42,
    'PERSONAL', 'Personal', 'personal ', ' personal']) {
    assert.strictEqual(
      classifyGraphIdentityMatch(PERSONAL_SHORT_16, PERSONAL_OID_GUID, t), null,
      `accountType ${JSON.stringify(t)} must not unlock rule 2`)
    const r = resolveMailboxFromGraphBody({ id: PERSONAL_SHORT_16, mail: MAIL },
      PERSONAL_OID_GUID, t)
    assert.strictEqual(r.ok, false, `accountType ${JSON.stringify(t)}`)
    assert.strictEqual(r.reason, 'graph_identity_mismatch')
  }
})

test('an unrelated PERSONAL id is still refused', () => {
  for (const id of [
    '00000000-0000-0000-1111-222222222222',   // a different zero-padded account
    '7a3b9c15e204d6f9',                        // one digit different
    '0000000000000000',                        // the padding alone
    'deadbeefdeadbeef',                        // unrelated 16-hex
  ]) {
    const r = resolveMailboxFromGraphBody({ id, mail: MAIL }, PERSONAL_OID_GUID, 'personal')
    assert.strictEqual(r.reason, 'graph_identity_mismatch', `accepted ${id}`)
  }
})

test('EMAIL IS NEVER IDENTITY, and no address is ever invented', () => {
  // Both addresses agree and are the only thing that agrees. Still refused,
  // even on a personal account.
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: MAIL, mail: MAIL, userPrincipalName: MAIL },
      PERSONAL_OID_GUID, 'personal').reason,
    'graph_identity_mismatch')
  // A pair that matches under rule 2 but has no usable address fails rather
  // than filling the NOT NULL column with something made up.
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: PERSONAL_SHORT_16, userPrincipalName: 'DOMAIN\\user' },
      PERSONAL_OID_GUID, 'personal').reason,
    'no_usable_mailbox_address')
})

test('malformed ids and a missing validated oid keep their own reasons', () => {
  assert.strictEqual(resolveMailboxFromGraphBody({ mail: MAIL }, PERSONAL_OID_GUID, 'personal')
    .reason, 'graph_me_no_id')
  assert.strictEqual(resolveMailboxFromGraphBody({ id: '  ', mail: MAIL }, PERSONAL_OID_GUID,
    'personal').reason, 'graph_me_no_id')
  assert.strictEqual(resolveMailboxFromGraphBody({ id: 42, mail: MAIL }, PERSONAL_OID_GUID,
    'personal').reason, 'graph_me_no_id')
  assert.strictEqual(resolveMailboxFromGraphBody(null, PERSONAL_OID_GUID, 'personal').reason,
    'graph_me_malformed')
  assert.strictEqual(resolveMailboxFromGraphBody('a string', PERSONAL_OID_GUID, 'personal')
    .reason, 'graph_me_malformed')
  for (const bad of ['', '   ', null, undefined, 42]) {
    const r = resolveMailboxFromGraphBody({ id: PERSONAL_SHORT_16, mail: MAIL }, bad, 'personal')
    assert.strictEqual(r.reason, 'no_validated_oid', JSON.stringify(bad))
    assert.strictEqual(r.diagnostic, undefined)
  }
  // Nonsense GUID-ish shapes cannot satisfy rule 2.
  assert.strictEqual(classifyGraphIdentityMatch(PERSONAL_SHORT_16, '-'.repeat(36), 'personal'),
    null)
  assert.strictEqual(classifyGraphIdentityMatch('z'.repeat(16), PERSONAL_OID_GUID, 'personal'),
    null)
})

test('the match vocabulary is a frozen controlled enum', () => {
  assert.deepStrictEqual(IDENTITY_MATCHES, ['exact', 'personal_zero_padded_short_form'])
  assert.ok(Object.isFrozen(IDENTITY_MATCHES))
  // Every successful resolve reports one of them, and nothing else.
  for (const [body, oid, t] of [
    [{ id: PERSONAL_OID_GUID, mail: MAIL }, PERSONAL_OID_GUID, 'personal'],
    [{ id: PERSONAL_SHORT_16, mail: MAIL }, PERSONAL_OID_GUID, 'personal'],
    [{ id: WORK_OID_GUID, mail: MAIL }, WORK_OID_GUID, 'work'],
  ]) {
    const r = resolveMailboxFromGraphBody(body, oid, t)
    assert.strictEqual(r.ok, true)
    assert.ok(IDENTITY_MATCHES.includes(r.identityMatch), String(r.identityMatch))
  }
})

test('THE GRAPH ID IS NEVER RETURNED, so it cannot become the stored identity', () => {
  // Under rule 2 the Graph body's 16-hex id must not leak into the result; the
  // caller writes ms_account_id from the validated oid it already holds.
  const r = resolveMailboxFromGraphBody({ id: PERSONAL_SHORT_16, mail: MAIL },
    PERSONAL_OID_GUID, 'personal')
  assert.deepStrictEqual(Object.keys(r).sort(), ['email', 'identityMatch', 'ok'])
  const serialized = JSON.stringify(r)
  assert.ok(!serialized.includes(PERSONAL_SHORT_16))
  assert.ok(!serialized.includes(PERSONAL_OID_GUID))
})

console.log('')
console.log('the diagnostic still explains every remaining mismatch')

test('a refused pair still carries shapes, lengths and both relationship booleans', () => {
  // The reverse direction is the clearest remaining mismatch.
  const d = resolveMailboxFromGraphBody({ id: PERSONAL_OID_GUID, mail: MAIL },
    PERSONAL_SHORT_16, 'personal').diagnostic
  assert.strictEqual(d.account, 'personal')
  assert.strictEqual(d.graph_id_shape, 'guid')
  assert.strictEqual(d.oid_shape, 'hex16')
  assert.strictEqual(d.graph_id_len, 36)
  assert.strictEqual(d.oid_len, 16)
  assert.strictEqual(d.equal_case_insensitive, false)
  assert.strictEqual(d.graph_id_is_short_form_of_oid, false)
  assert.strictEqual(d.oid_is_short_form_of_graph_id, true)
})

test('a work short form is refused, labelled work, and reports no relationship', () => {
  const d = resolveMailboxFromGraphBody({ id: WORK_SHORT_16, mail: MAIL },
    WORK_OID_GUID, 'work').diagnostic
  assert.strictEqual(d.account, 'work')
  assert.strictEqual(d.graph_id_is_short_form_of_oid, false)
  assert.strictEqual(d.oid_is_short_form_of_graph_id, false)
})

test('a zero-padded pair labelled work is refused but the relationship is recorded', () => {
  const d = resolveMailboxFromGraphBody({ id: PERSONAL_SHORT_16, mail: MAIL },
    PERSONAL_OID_GUID, 'work').diagnostic
  assert.strictEqual(d.account, 'work')
  assert.strictEqual(d.graph_id_is_short_form_of_oid, true,
    'recorded, so a mislabelled tenant is diagnosable')
})

test('the serialized diagnostic leaks no part of either identifier', () => {
  const serialized = JSON.stringify(
    describeIdentityMismatch(PERSONAL_FLAT_32, PERSONAL_OID_GUID, 'personal'))
  const runs = new Set()
  for (const v of [PERSONAL_SHORT_16, PERSONAL_OID_GUID, MAIL]) {
    const flat = v.replace(/-/g, '')
    for (let i = 0; i + 4 <= flat.length; i++) runs.add(flat.slice(i, i + 4))
  }
  runs.delete('0000')   // a zero-padded GUID's own padding is not a leak
  for (const run of runs) {
    assert.ok(!serialized.includes(run), `leaked the run ${JSON.stringify(run)}`)
  }
  assert.ok(!serialized.includes('@'), 'no address may appear')
  for (const v of Object.values(
    describeIdentityMismatch(PERSONAL_FLAT_32, PERSONAL_OID_GUID, 'personal'))) {
    assert.ok(['number', 'boolean'].includes(typeof v)
      || ['personal', 'work', 'unknown', 'absent', 'guid', 'hex16', 'hex32', 'other'].includes(v),
      `unexpected diagnostic value: ${JSON.stringify(v)}`)
  }
})

test('the shape and relationship primitives are unchanged', () => {
  assert.strictEqual(identifierShape(PERSONAL_OID_GUID), 'guid')
  assert.strictEqual(identifierShape(PERSONAL_SHORT_16), 'hex16')
  assert.strictEqual(identifierShape(PERSONAL_FLAT_32), 'hex32')
  assert.strictEqual(identifierShape(MAIL), 'other')
  assert.strictEqual(identifierShape('   '), 'absent')
  assert.strictEqual(isZeroPaddedGuidOf(PERSONAL_OID_GUID, PERSONAL_SHORT_16), true)
  assert.strictEqual(isZeroPaddedGuidOf(WORK_OID_GUID, WORK_SHORT_16), false)
  assert.strictEqual(isZeroPaddedGuidOf(PERSONAL_FLAT_32, PERSONAL_SHORT_16), false)
})

console.log('')
console.log('fetchMailboxAddress carries the validated account type through')

test('a fetched personal short-form pair resolves and reports rule 2', async () => {
  const r = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID, accountType: 'personal',
    fetchImpl: async () => ({ status: 200, json: async () => ({ id: PERSONAL_SHORT_16, mail: MAIL }) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.deepStrictEqual(r,
    { ok: true, email: MAIL, identityMatch: IDENTITY_MATCH_PERSONAL_SHORT_FORM })
  // The SAME Graph body with the account type omitted must still be refused -
  // the label is what unlocks rule 2, and it is not defaulted.
  const u = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID,
    fetchImpl: async () => ({ status: 200, json: async () => ({ id: PERSONAL_SHORT_16, mail: MAIL }) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.strictEqual(u.reason, 'graph_identity_mismatch')
  assert.strictEqual(u.diagnostic.account, 'unknown')
})

test('a transport failure still carries no diagnostic and no match', async () => {
  const f = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID, accountType: 'personal',
    fetchImpl: async () => ({ status: 403, json: async () => ({}) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.strictEqual(f.reason, 'graph_me_forbidden')
  assert.strictEqual(f.diagnostic, undefined)
  assert.strictEqual(f.identityMatch, undefined)
})

console.log('')
console.log('the callback: finalize only after a match, and log only safe values')

const HANDLER = exec(read('supabase/functions/outlook-oauth-callback/handler.js'))

test('an unresolved mailbox returns BEFORE finalize_microsoft_connection', () => {
  const guard = HANDLER.indexOf('if (!mailbox.ok)')
  const finalize = HANDLER.indexOf('finalize_microsoft_connection')
  assert.ok(guard > 0 && finalize > 0, 'guard or finalize call missing')
  assert.ok(guard < finalize, 'the guard must precede the finalize RPC')
  assert.ok(/return redirect\(failRedirect\)/.test(HANDLER.slice(guard, finalize)),
    'the guard must return, not fall through')
  assert.ok(/accountType:\s*identity\.accountType/.test(HANDLER),
    'rule 2 must be unlocked only by the validated id_token classification')
})

test('ms_account_id is written from the VALIDATED oid, never the Graph id', () => {
  assert.ok(/p_ms_account_id:\s*identity\.msAccountId/.test(HANDLER))
  // Nothing from the Graph body may reach the identity argument.
  assert.ok(!/p_ms_account_id:\s*mailbox\./.test(HANDLER))
  assert.ok(!/p_ms_account_id:\s*(gid|graphId|body)/.test(HANDLER))
  // The mailbox result supplies the address and the match kind only.
  const uses = HANDLER.match(/mailbox\.[a-zA-Z]+/g) || []
  assert.deepStrictEqual([...new Set(uses)].sort(),
    ['mailbox.diagnostic', 'mailbox.email', 'mailbox.identityMatch', 'mailbox.ok', 'mailbox.reason'])
})

test('the matched rule is logged as a controlled enum', () => {
  assert.ok(/graph_identity_matched['"],\s*mailbox\.identityMatch/.test(HANDLER))
})

test('the diagnostic is logged for graph_identity_mismatch ONLY', () => {
  assert.ok(
    /mailbox\.reason === 'graph_identity_mismatch'[\s\S]{0,200}JSON\.stringify\(mailbox\.diagnostic\)/
      .test(HANDLER),
    'the diagnostic must be gated on the identity-mismatch reason')
  assert.ok(/console\.error\('outlook-oauth-callback mailbox_unresolved', mailbox\.reason\)/
    .test(HANDLER), 'other reasons must still log the bare code')
})

test('no log statement references an identifier, address or secret', () => {
  // A fixed reason CODE may contain any word ('verifier_decrypt_failed'); what
  // must never appear is a reference to a VALUE. So string literals are removed
  // first, keeping only `${...}` interpolations.
  const strip = (l) => l
    .replace(/`([^`]*)`/g, (_m, i) => (i.match(/\$\{[^}]*\}/g) || []).join(' '))
    .replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
  assert.ok(strip("console.error('verifier_decrypt_failed', verifier)").includes('verifier'),
    'the scan cannot detect a real leak')
  assert.ok(!strip("console.error('outlook-oauth-callback verifier_decrypt_failed')")
    .includes('verifier'), 'the scan must not flag a word inside a reason code')

  const banned = ['identity.msAccountId', 'identity.msTenantId',
    'identity.displayAddressHint', 'mailbox.email', 'redeemed.accessToken',
    'redeemed.refreshToken', 'redeemed.idToken', 'verifier', 'stateHash',
    'clientSecret', 'keyB64', 'row.user_id', 'verified.payload']
  const logs = HANDLER.split('\n').filter((l) => /console\.(error|log|warn|info)/.test(l))
  assert.ok(logs.length > 0, 'the handler logs nothing - the scan is vacuous')
  for (const line of logs) {
    const scanned = strip(line)
    for (const b of banned) {
      assert.ok(!scanned.includes(b), `log references ${b}: ${line.trim().slice(0, 80)}`)
    }
    assert.ok(!/\$\{\s*(state|code|cookie)\s*\}/.test(line),
      `log interpolates a secret: ${line.trim().slice(0, 80)}`)
  }
})

console.log('')
console.log('the Settings callback-result parse, and the generic notice')

test('only the two values the callback produces are recognised', () => {
  assert.deepStrictEqual(OUTLOOK_CALLBACK_RESULTS, ['connected', 'error'])
  assert.strictEqual(readOutlookCallbackResult('?outlook=error'), 'error')
  assert.strictEqual(readOutlookCallbackResult('?outlook=connected'), 'connected')
  assert.strictEqual(readOutlookCallbackResult('outlook=error'), 'error')
  assert.strictEqual(readOutlookCallbackResult('?foo=1&outlook=error&bar=2'), 'error')
  assert.strictEqual(readOutlookCallbackResult(new URLSearchParams('outlook=error')), 'error')
})

test('anything else is null, so no arbitrary text can reach the page', () => {
  for (const s of [
    '?outlook=', '?outlook=ERROR', '?outlook=failed', '?outlook=graph_identity_mismatch',
    '?outlook=<script>alert(1)</script>', '?other=error', '?', '',
    null, undefined, 42, {}, new URLSearchParams('outlook=nope'),
    { getAll: () => { throw new Error('boom') } }, { getAll: () => 'not-an-array' },
  ]) assert.strictEqual(readOutlookCallbackResult(s), null, JSON.stringify(String(s)))
})

test('duplicates are refused, not resolved first- or last-wins', () => {
  assert.strictEqual(readOutlookCallbackResult('?outlook=error&outlook=connected'), null)
  assert.strictEqual(readOutlookCallbackResult('?outlook=connected&outlook=error'), null)
  assert.strictEqual(readOutlookCallbackResult('?outlook=error&outlook=error'), null)
})

test('the notice is short, actionable and carries NO provider detail', () => {
  const m = messageForOutcome('callback_failed')
  assert.ok(m.length > 0 && m.length <= 120, `${m.length} chars`)
  assert.ok(/outlook/i.test(m) && /try again/i.test(m), m)
  for (const leak of ['graph', 'oid', 'tenant', 'token', 'scope', 'mismatch',
    'identity', 'microsoft', 'entra', 'rpc', 'finalize', 'state', '401', '403', '500']) {
    assert.ok(!m.toLowerCase().includes(leak), `leaks ${leak}: ${m}`)
  }
  assert.notStrictEqual(m, messageForOutcome('unknown_outcome'))
})

test('the card renders it through the shared helper and message map', () => {
  const CARD = exec(read('src/components/OutlookConnectionCard.jsx'))
  assert.ok(/readOutlookCallbackResult\(searchParams\)/.test(CARD))
  assert.ok(/messageForOutcome\('callback_failed'\)/.test(CARD))
  assert.ok(!/location\.search/.test(CARD), 'must not parse the query string by hand')
  for (const leak of ['graph_identity_mismatch', 'mailbox_unresolved', 'diagnostic']) {
    assert.ok(!CARD.includes(leak), `the card references ${leak}`)
  }
})

await Promise.all(pending)
console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
