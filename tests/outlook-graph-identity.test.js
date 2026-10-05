// The Graph-vs-id_token identity check, and the Settings surface for a refused
// callback.
//
// WHY THIS SUITE EXISTS. The first live pilot consent refused with
// graph_identity_mismatch and returned to a Settings page that showed nothing
// at all. Two separate defects:
//
//   1. The only existing coverage of this path (tests/outlook-callback-exchange
//      .test.js) used SYNTHETIC identifiers - 'oid-1', 'oid-' + tid - which are
//      neither GUIDs nor hex, so no realistic representation was ever exercised
//      and nothing here could have been caught before a live consent.
//   2. buildOutlookSettingsRedirect produced /settings?outlook=error and NO
//      code read that parameter, so a refusal was indistinguishable from never
//      having tried.
//
// WHAT IS DECIDED HERE, AND ON WHAT EVIDENCE. The question raised by the live
// refusal was whether a personal Microsoft account's Graph `id` and its
// id_token `oid` are two representations of one value (a 16-hex CID, and that
// CID zero-padded into GUID form). Primary documentation does not support
// treating them as equivalent - `oid` is documented as a GUID that "Microsoft
// Graph returns ... as the `id` property", `user.id` is documented as opaque
// with no format and no personal-account carve-out, and the single primary-doc
// mention of a "Microsoft Account CID" is on the BETA userAccountInformation
// resource (a different entity) with no format stated at all. So the
// equivalence is NOT granted. Exact equality stands for both account types,
// unknown shapes stay REJECTED, and the relationship is only RECORDED in a
// privacy-safe diagnostic so the live representation can be established from a
// refusal instead of guessed at.
//
// WHAT IS BEHAVIOURAL HERE, AND WHAT IS NOT - stated plainly.
//
//   BEHAVIOURAL: resolveMailboxFromGraphBody, fetchMailboxAddress,
//   describeIdentityMismatch, identifierShape, isZeroPaddedGuidOf,
//   readOutlookCallbackResult and messageForOutcome are all EXECUTED. These are
//   the same functions the callback and the card call.
//
//   NOT BEHAVIOURAL: the card is never rendered. This suite is zero-dependency
//   Node, which cannot import .jsx without a transform, and the repo carries no
//   JSDOM or React testing library. The JSX-only properties - that the banner
//   is outside every status branch, that it is announced, that it shows the
//   generic copy - are checked by SCANNING THE SOURCE. Structural assertions
//   are not proof of runtime behaviour.
//
//   NOT EXERCISED AT ALL: the real deployed callback. Its finalize /
//   no-finalize behaviour is asserted two ways - by scanning the handler source
//   for the ordering, and by a REAL run of the handler under Deno in
//   tests/outlook-callback-positive-integration.test.js, which is opt-in
//   (FUNNL_EDGE_INTEGRATION=1 + Docker). Neither contacts Microsoft.
//
// NO REAL IDENTIFIER APPEARS IN THIS FILE. Every value below is invented for
// the test; none is any live account's oid, Graph id or address.
//
// Run with: node tests/outlook-graph-identity.test.js

import assert from 'assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  resolveMailboxFromGraphBody,
  fetchMailboxAddress,
  describeIdentityMismatch,
  identifierShape,
  isZeroPaddedGuidOf,
  IDENTIFIER_SHAPES,
} from '../supabase/functions/shared/microsoftGraphMe.js'
import {
  readOutlookCallbackResult,
  messageForOutcome,
  OUTLOOK_CALLBACK_RESULTS,
} from '../src/lib/outlookConnection.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

// Executable code only. Assertions about ordering and logging must not be
// satisfied by this repo's own explanatory prose, which names the very symbols
// being searched for.
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

// ── invented fixtures ───────────────────────────────────────────────────────
// A zero-padded GUID whose leading 16 hex digits are zero and whose trailing 16
// are a plausible 16-hex account identifier. This is the exact pair the live
// refusal raised a question about.
const PERSONAL_OID_GUID = '00000000-0000-0000-7a3b-9c15e204d6f8'
const PERSONAL_SHORT_16 = '7a3b9c15e204d6f8'
// A work/school account id: a full GUID with a NON-zero leading half.
const WORK_OID_GUID = 'c41d8f72-5b90-4e63-a1d2-77f0ba3c9e45'
const WORK_SHORT_16 = 'a1d277f0ba3c9e45'          // its trailing 16 hex digits
const MAIL = 'student@outlook.test'

// ────────────────────────────────────────────────────────────────────────────
console.log('')
console.log('identifier SHAPE vocabulary (diagnostic only - decides nothing)')

test('every shape is drawn from the frozen vocabulary', () => {
  assert.deepStrictEqual(IDENTIFIER_SHAPES,
    ['absent', 'guid', 'hex16', 'hex32', 'other'])
  assert.ok(Object.isFrozen(IDENTIFIER_SHAPES))
})

test('guid, hex16, hex32, other and absent are each classified', () => {
  assert.strictEqual(identifierShape(PERSONAL_OID_GUID), 'guid')
  assert.strictEqual(identifierShape(WORK_OID_GUID), 'guid')
  assert.strictEqual(identifierShape(PERSONAL_SHORT_16), 'hex16')
  assert.strictEqual(identifierShape('a'.repeat(32)), 'hex32')
  // Uppercase and surrounding space are normalised, not rejected.
  assert.strictEqual(identifierShape('  ' + PERSONAL_OID_GUID.toUpperCase() + ' '), 'guid')
  assert.strictEqual(identifierShape(PERSONAL_SHORT_16.toUpperCase()), 'hex16')
  // Not hex, wrong length, wrong separators, an address: all 'other'.
  assert.strictEqual(identifierShape('oid-1'), 'other')
  assert.strictEqual(identifierShape(MAIL), 'other')
  assert.strictEqual(identifierShape('z'.repeat(16)), 'other')
  assert.strictEqual(identifierShape('7a3b9c15e204d6f'), 'other')   // 15 hex
  assert.strictEqual(identifierShape('-'.repeat(36)), 'other')
  // Absent, blank and non-strings.
  assert.strictEqual(identifierShape(''), 'absent')
  assert.strictEqual(identifierShape('   '), 'absent')
  assert.strictEqual(identifierShape(null), 'absent')
  assert.strictEqual(identifierShape(undefined), 'absent')
  assert.strictEqual(identifierShape(12345), 'absent')
})

console.log('')
console.log('the zero-padded-GUID relationship is REPORTED, never accepted')

test('a zero-padded GUID and its 16-hex trailing half are related', () => {
  assert.strictEqual(isZeroPaddedGuidOf(PERSONAL_OID_GUID, PERSONAL_SHORT_16), true)
  // Case and whitespace insensitive, like the comparison itself.
  assert.strictEqual(
    isZeroPaddedGuidOf(PERSONAL_OID_GUID.toUpperCase(), ' ' + PERSONAL_SHORT_16.toUpperCase()),
    true)
})

test('a trailing-digit coincidence WITHOUT a zero leading half is NOT the relationship', () => {
  // The work GUID's own trailing 16 hex digits. The suffix matches exactly, but
  // the leading half is not zero, so this is an arbitrary suffix match and must
  // never be reported as the zero-padded relationship.
  assert.strictEqual(isZeroPaddedGuidOf(WORK_OID_GUID, WORK_SHORT_16), false)
})

test('malformed, unrelated and wrong-length values are never related', () => {
  assert.strictEqual(isZeroPaddedGuidOf(PERSONAL_OID_GUID, 'deadbeefdeadbeef'), false)
  assert.strictEqual(isZeroPaddedGuidOf(PERSONAL_OID_GUID, '7a3b9c15e204d6f'), false)  // 15
  assert.strictEqual(isZeroPaddedGuidOf(PERSONAL_OID_GUID, PERSONAL_SHORT_16 + '0'), false)
  assert.strictEqual(isZeroPaddedGuidOf('not-a-guid', PERSONAL_SHORT_16), false)
  assert.strictEqual(isZeroPaddedGuidOf(PERSONAL_SHORT_16, PERSONAL_SHORT_16), false)
  assert.strictEqual(isZeroPaddedGuidOf(PERSONAL_OID_GUID, MAIL), false)
  assert.strictEqual(isZeroPaddedGuidOf(null, null), false)
  assert.strictEqual(isZeroPaddedGuidOf(undefined, PERSONAL_SHORT_16), false)
  // An all-zero GUID is related only to the all-zero short form.
  assert.strictEqual(isZeroPaddedGuidOf('00000000-0000-0000-0000-000000000000', '0'.repeat(16)), true)
  assert.strictEqual(isZeroPaddedGuidOf('00000000-0000-0000-0000-000000000000', PERSONAL_SHORT_16), false)
})

console.log('')
console.log('PERSONAL account: the equivalent-looking pair is still REJECTED')

test('a 16-hex Graph id against its zero-padded GUID oid does NOT resolve', () => {
  const r = resolveMailboxFromGraphBody(
    { id: PERSONAL_SHORT_16, mail: MAIL }, PERSONAL_OID_GUID, 'personal')
  assert.strictEqual(r.ok, false, 'the undocumented equivalence must not be granted')
  assert.strictEqual(r.reason, 'graph_identity_mismatch')
  assert.strictEqual(r.email, undefined, 'no address may be returned on a refusal')
})

test('the refusal CARRIES the relationship, so the live form can be established', () => {
  const { diagnostic: d } = resolveMailboxFromGraphBody(
    { id: PERSONAL_SHORT_16, mail: MAIL }, PERSONAL_OID_GUID, 'personal')
  assert.strictEqual(d.account, 'personal')
  assert.strictEqual(d.graph_id_shape, 'hex16')
  assert.strictEqual(d.oid_shape, 'guid')
  assert.strictEqual(d.graph_id_len, 16)
  assert.strictEqual(d.oid_len, 36)
  assert.strictEqual(d.equal_case_insensitive, false)
  assert.strictEqual(d.graph_id_is_short_form_of_oid, true)
  assert.strictEqual(d.oid_is_short_form_of_graph_id, false)
})

test('the mirror direction is reported too (GUID from Graph, 16-hex oid)', () => {
  const { diagnostic: d } = resolveMailboxFromGraphBody(
    { id: PERSONAL_OID_GUID, mail: MAIL }, PERSONAL_SHORT_16, 'personal')
  assert.strictEqual(d.graph_id_shape, 'guid')
  assert.strictEqual(d.oid_shape, 'hex16')
  assert.strictEqual(d.graph_id_is_short_form_of_oid, false)
  assert.strictEqual(d.oid_is_short_form_of_graph_id, true)
})

test('an exactly equal personal pair DOES resolve, in either case', () => {
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody({ id: PERSONAL_OID_GUID, mail: MAIL }, PERSONAL_OID_GUID, 'personal'),
    { ok: true, email: MAIL })
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody(
      { id: PERSONAL_OID_GUID.toUpperCase(), mail: MAIL.toUpperCase() },
      PERSONAL_OID_GUID, 'personal'),
    { ok: true, email: MAIL })
})

test('a genuinely different personal account is refused with no relationship', () => {
  const r = resolveMailboxFromGraphBody(
    { id: '00000000-0000-0000-1111-222222222222', mail: MAIL },
    PERSONAL_OID_GUID, 'personal')
  assert.strictEqual(r.reason, 'graph_identity_mismatch')
  assert.strictEqual(r.diagnostic.graph_id_is_short_form_of_oid, false)
  assert.strictEqual(r.diagnostic.oid_is_short_form_of_graph_id, false)
  assert.strictEqual(r.diagnostic.graph_id_shape, 'guid')
})

console.log('')
console.log('WORK/SCHOOL account: equality stays strict')

test('an exactly equal work pair resolves', () => {
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody({ id: WORK_OID_GUID, mail: MAIL }, WORK_OID_GUID, 'work'),
    { ok: true, email: MAIL })
})

test('a work GUID vs its own trailing 16 hex digits is REFUSED', () => {
  const r = resolveMailboxFromGraphBody(
    { id: WORK_SHORT_16, mail: MAIL }, WORK_OID_GUID, 'work')
  assert.strictEqual(r.reason, 'graph_identity_mismatch')
  assert.strictEqual(r.diagnostic.account, 'work')
  // The suffix matches, and it is still not the zero-padded relationship.
  assert.strictEqual(r.diagnostic.graph_id_is_short_form_of_oid, false)
  assert.strictEqual(r.diagnostic.oid_is_short_form_of_graph_id, false)
})

test('a zero-padded pair on a WORK tenant is refused and labelled work', () => {
  // The relationship is reported, the refusal is unchanged, and the label makes
  // clear this was NOT the consumers tenant. Nothing may ever accept this.
  const r = resolveMailboxFromGraphBody(
    { id: PERSONAL_SHORT_16, mail: MAIL }, PERSONAL_OID_GUID, 'work')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.diagnostic.account, 'work')
  assert.strictEqual(r.diagnostic.graph_id_is_short_form_of_oid, true)
})

test('an unknown or absent account type is labelled unknown, never guessed', () => {
  for (const t of [undefined, null, '', 'personal ', 'PERSONAL', 'consumer', 42]) {
    const d = describeIdentityMismatch(PERSONAL_SHORT_16, PERSONAL_OID_GUID, t)
    assert.strictEqual(d.account, 'unknown', `accountType ${JSON.stringify(t)}`)
  }
})

console.log('')
console.log('malformed values, unrelated values and email are all refused')

test('a malformed or missing Graph id is its own controlled reason', () => {
  assert.strictEqual(resolveMailboxFromGraphBody({ mail: MAIL }, PERSONAL_OID_GUID).reason,
    'graph_me_no_id')
  assert.strictEqual(resolveMailboxFromGraphBody({ id: '   ', mail: MAIL }, PERSONAL_OID_GUID).reason,
    'graph_me_no_id')
  assert.strictEqual(resolveMailboxFromGraphBody({ id: 42, mail: MAIL }, PERSONAL_OID_GUID).reason,
    'graph_me_no_id')
  assert.strictEqual(resolveMailboxFromGraphBody(null, PERSONAL_OID_GUID).reason,
    'graph_me_malformed')
  assert.strictEqual(resolveMailboxFromGraphBody('a string', PERSONAL_OID_GUID).reason,
    'graph_me_malformed')
})

test('an absent validated oid is refused BEFORE any comparison', () => {
  for (const bad of ['', '   ', null, undefined, 42]) {
    const r = resolveMailboxFromGraphBody({ id: PERSONAL_OID_GUID, mail: MAIL }, bad)
    assert.strictEqual(r.reason, 'no_validated_oid', `oid ${JSON.stringify(bad)}`)
    assert.strictEqual(r.diagnostic, undefined,
      'no identity diagnostic without a validated oid')
  }
})

test('an arbitrary suffix or prefix match is NOT an identity', () => {
  const cases = [
    // trailing digits of the GUID, but not 16 hex
    { id: '9c15e204d6f8', why: 'a 12-hex suffix' },
    { id: 'e204d6f8', why: 'an 8-hex suffix' },
    { id: '00000000', why: 'the zero prefix alone' },
    // the right digits with the hyphens removed - a 32-hex flat GUID
    { id: PERSONAL_OID_GUID.replace(/-/g, ''), why: 'the flat 32-hex GUID' },
    // one digit different
    { id: '7a3b9c15e204d6f9', why: 'one digit different' },
  ]
  for (const c of cases) {
    const r = resolveMailboxFromGraphBody({ id: c.id, mail: MAIL }, PERSONAL_OID_GUID, 'personal')
    assert.strictEqual(r.reason, 'graph_identity_mismatch', c.why)
    assert.strictEqual(r.diagnostic.graph_id_is_short_form_of_oid, false, c.why)
    assert.strictEqual(r.diagnostic.oid_is_short_form_of_graph_id, false, c.why)
  }
})

test('EMAIL IS NEVER IDENTITY - a matching address does not substitute for the id', () => {
  // Both addresses agree and are the only thing that agrees. Still refused.
  const r = resolveMailboxFromGraphBody(
    { id: MAIL, mail: MAIL, userPrincipalName: MAIL }, PERSONAL_OID_GUID, 'personal')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'graph_identity_mismatch')
  // And an id that equals the address is just 'other' - no special handling.
  assert.strictEqual(r.diagnostic.graph_id_shape, 'other')
  // The reverse: a matching id with no usable address still fails, rather than
  // inventing one to satisfy the NOT NULL column.
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: PERSONAL_OID_GUID, userPrincipalName: 'DOMAIN\\user' },
      PERSONAL_OID_GUID, 'personal').reason,
    'no_usable_mailbox_address')
})

console.log('')
console.log('the diagnostic is privacy-safe BY CONSTRUCTION')

test('it contains no substring of either identifier, and no address', () => {
  const d = describeIdentityMismatch(PERSONAL_SHORT_16, PERSONAL_OID_GUID, 'personal')
  const serialized = JSON.stringify(d)
  // Every 4-character run of either identifier must be absent. 4 is short
  // enough to catch a leak and long enough that '0000' from a zero-padded GUID
  // is the only coincidence worth excluding - and it is excluded explicitly.
  const runs = new Set()
  for (const v of [PERSONAL_SHORT_16, PERSONAL_OID_GUID, MAIL]) {
    const flat = v.replace(/-/g, '')
    for (let i = 0; i + 4 <= flat.length; i++) runs.add(flat.slice(i, i + 4))
  }
  runs.delete('0000')
  for (const run of runs) {
    assert.ok(!serialized.includes(run),
      `the diagnostic leaked the 4-character run ${JSON.stringify(run)}`)
  }
  assert.ok(!serialized.includes('@'), 'no address may appear')
})

test('every value is a controlled string, a number or a boolean', () => {
  const d = describeIdentityMismatch(PERSONAL_SHORT_16, PERSONAL_OID_GUID, 'personal')
  assert.deepStrictEqual(Object.keys(d).sort(), [
    'account', 'equal_case_insensitive', 'graph_id_is_short_form_of_oid',
    'graph_id_len', 'graph_id_shape', 'oid_is_short_form_of_graph_id',
    'oid_len', 'oid_shape',
  ])
  assert.ok(['personal', 'work', 'unknown'].includes(d.account))
  assert.ok(IDENTIFIER_SHAPES.includes(d.graph_id_shape))
  assert.ok(IDENTIFIER_SHAPES.includes(d.oid_shape))
  assert.strictEqual(typeof d.graph_id_len, 'number')
  assert.strictEqual(typeof d.oid_len, 'number')
  assert.strictEqual(typeof d.equal_case_insensitive, 'boolean')
  assert.strictEqual(typeof d.graph_id_is_short_form_of_oid, 'boolean')
  assert.strictEqual(typeof d.oid_is_short_form_of_graph_id, 'boolean')
})

test('equal_case_insensitive is false on every mismatch path', () => {
  for (const id of [PERSONAL_SHORT_16, WORK_OID_GUID, MAIL, 'oid-1']) {
    const r = resolveMailboxFromGraphBody({ id, mail: MAIL }, PERSONAL_OID_GUID, 'personal')
    assert.strictEqual(r.diagnostic.equal_case_insensitive, false, id)
  }
})

console.log('')
console.log('fetchMailboxAddress carries the account type through to the diagnostic')

test('a fetched mismatch reports the validated account type', async () => {
  const r = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID, accountType: 'personal',
    fetchImpl: async () => ({ status: 200, json: async () => ({ id: PERSONAL_SHORT_16, mail: MAIL }) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'graph_identity_mismatch')
  assert.strictEqual(r.diagnostic.account, 'personal')
  assert.strictEqual(r.diagnostic.graph_id_is_short_form_of_oid, true)
})

test('an omitted account type still produces a usable diagnostic', async () => {
  const r = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID,
    fetchImpl: async () => ({ status: 200, json: async () => ({ id: PERSONAL_SHORT_16, mail: MAIL }) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.strictEqual(r.diagnostic.account, 'unknown')
  assert.strictEqual(r.diagnostic.graph_id_is_short_form_of_oid, true)
})

test('a matching fetch still resolves the address', async () => {
  const r = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID, accountType: 'personal',
    fetchImpl: async () => ({ status: 200, json: async () => ({ id: PERSONAL_OID_GUID, mail: MAIL }) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.deepStrictEqual(r, { ok: true, email: MAIL })
})

test('transport failures carry no diagnostic - they are not identity refusals', async () => {
  const r = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID, accountType: 'personal',
    fetchImpl: async () => ({ status: 403, json: async () => ({}) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.strictEqual(r.reason, 'graph_me_forbidden')
  assert.strictEqual(r.diagnostic, undefined)
})

console.log('')
console.log('the REAL callback: refuse before finalize, and log no identifier')

const HANDLER_REL = 'supabase/functions/outlook-oauth-callback/handler.js'
const HANDLER = read(HANDLER_REL)
const HANDLER_EXEC = exec(HANDLER)

test('the handler passes the VALIDATED account type into the Graph check', () => {
  assert.ok(/accountType:\s*identity\.accountType/.test(HANDLER_EXEC),
    'the diagnostic label must come from the validated id_token, not the Graph body')
})

test('an unresolved mailbox returns BEFORE finalize_microsoft_connection', () => {
  const guard = HANDLER_EXEC.indexOf('if (!mailbox.ok)')
  const finalize = HANDLER_EXEC.indexOf('finalize_microsoft_connection')
  assert.ok(guard > 0, 'the mailbox guard is missing')
  assert.ok(finalize > 0, 'the finalize call is missing')
  assert.ok(guard < finalize,
    'the mailbox guard must precede the finalize RPC, not follow it')
  // And the guard's body must actually leave the function.
  const body = HANDLER_EXEC.slice(guard, finalize)
  assert.ok(/return redirect\(failRedirect\)/.test(body),
    'the guard must return a redirect, not fall through')
})

test('only a stored result is treated as success', () => {
  assert.ok(/result !== 'stored'/.test(HANDLER_EXEC))
  assert.ok(/outlook=error|OUTLOOK_CANONICAL_ERROR_REDIRECT|failRedirect/.test(HANDLER_EXEC))
})

test('the refusal logs the controlled reason AND the diagnostic', () => {
  assert.ok(/mailbox_unresolved['"],\s*mailbox\.reason/.test(HANDLER_EXEC),
    'the controlled reason must be logged')
  assert.ok(/JSON\.stringify\(mailbox\.diagnostic/.test(HANDLER_EXEC),
    'the diagnostic must be logged so a live refusal can be investigated')
})

// A log line's fixed reason CODE is allowed to contain any word - the codes are
// deliberately descriptive ('verifier_decrypt_failed'). What must never appear
// is a REFERENCE to a value. So string literals are removed before scanning,
// keeping only `${...}` interpolations from template strings.
const stripLiterals = (line) => line
  .replace(/`([^`]*)`/g, (_m, inner) => (inner.match(/\$\{[^}]*\}/g) || []).join(' '))
  .replace(/'[^']*'/g, "''")
  .replace(/"[^"]*"/g, '""')

test('no log statement in the handler prints an identifier, address or secret', () => {
  const banned = [
    'identity.msAccountId', 'identity.msTenantId', 'identity.displayAddressHint',
    'mailbox.email', 'redeemed.accessToken', 'redeemed.refreshToken',
    'redeemed.idToken', 'verifier', 'stateHash', 'clientSecret', 'keyB64',
    'row.user_id', 'verified.payload', 'sealedAccess', 'sealedRefresh',
  ]
  const logs = HANDLER_EXEC.split('\n').filter((l) => /console\.(error|log|warn|info)/.test(l))
  assert.ok(logs.length > 0, 'the handler logs nothing at all - the scan is vacuous')
  // The scan must be able to fail: a reference to a banned value inside a log
  // line is detected after literals are stripped.
  assert.ok(
    stripLiterals("console.error('verifier_decrypt_failed', verifier)").includes('verifier'),
    'the literal-stripping scan cannot detect a real leak')
  assert.ok(
    !stripLiterals("console.error('outlook-oauth-callback verifier_decrypt_failed')")
      .includes('verifier'),
    'the scan must not flag a word inside a fixed reason code')
  for (const line of logs) {
    const scanned = stripLiterals(line)
    for (const b of banned) {
      assert.ok(!scanned.includes(b),
        `a log line references ${b}: ${line.trim().slice(0, 90)}`)
    }
    // No bare state, code or cookie interpolation either.
    assert.ok(!/\$\{\s*(state|code|cookie)\s*\}/.test(line),
      `a log line interpolates a secret: ${line.trim().slice(0, 90)}`)
  }
})

test('the shared module grants no equivalence - the comparison stays exact', () => {
  const MOD = exec(read('supabase/functions/shared/microsoftGraphMe.js'))
  // The one comparison that decides identity.
  assert.ok(/gid\.toLowerCase\(\) !== oid\.trim\(\)\.toLowerCase\(\)/.test(MOD),
    'the exact comparison must remain the identity decision')
  // isZeroPaddedGuidOf must be used ONLY inside the diagnostic builder, never
  // as an acceptance condition.
  const decisionLines = MOD.split('\n').filter((l) =>
    /isZeroPaddedGuidOf\(/.test(l) && !/graph_id_is_short_form_of_oid|oid_is_short_form_of_graph_id/.test(l))
  // The remaining references are the declaration and its two guards.
  for (const l of decisionLines) {
    assert.ok(!/\bok:\s*true\b/.test(l),
      `the relationship predicate must never produce an acceptance: ${l.trim()}`)
  }
  assert.ok(!/ok:\s*true[\s\S]{0,200}isZeroPaddedGuidOf/.test(MOD))
})

console.log('')
console.log('Settings shows a short, generic failure for ?outlook=error')

test('only the two values the callback produces are recognised', () => {
  assert.deepStrictEqual(OUTLOOK_CALLBACK_RESULTS, ['connected', 'error'])
  assert.ok(Object.isFrozen(OUTLOOK_CALLBACK_RESULTS))
  assert.strictEqual(readOutlookCallbackResult('?outlook=error'), 'error')
  assert.strictEqual(readOutlookCallbackResult('?outlook=connected'), 'connected')
  assert.strictEqual(readOutlookCallbackResult('outlook=error'), 'error')
  assert.strictEqual(readOutlookCallbackResult('?foo=1&outlook=error&bar=2'), 'error')
})

test('anything else is ignored, so no arbitrary text can reach the page', () => {
  for (const s of [
    '?outlook=', '?outlook=ERROR', '?outlook=errors', '?outlook=failed',
    '?outlook=<script>alert(1)</script>', '?outlook=graph_identity_mismatch',
    '?other=error', '?', '', null, undefined, 42, {},
  ]) {
    assert.strictEqual(readOutlookCallbackResult(s), null, JSON.stringify(s))
  }
})

test('duplicates are refused rather than resolved first- or last-wins', () => {
  assert.strictEqual(readOutlookCallbackResult('?outlook=error&outlook=connected'), null)
  assert.strictEqual(readOutlookCallbackResult('?outlook=connected&outlook=error'), null)
  assert.strictEqual(readOutlookCallbackResult('?outlook=error&outlook=error'), null)
})

test('a URLSearchParams is accepted directly, as the card passes it', () => {
  assert.strictEqual(readOutlookCallbackResult(new URLSearchParams('outlook=error')), 'error')
  assert.strictEqual(readOutlookCallbackResult(new URLSearchParams('outlook=connected')), 'connected')
  assert.strictEqual(readOutlookCallbackResult(new URLSearchParams('')), null)
  assert.strictEqual(readOutlookCallbackResult(new URLSearchParams('outlook=nope')), null)
  // A getAll that throws must not break the page.
  assert.strictEqual(
    readOutlookCallbackResult({ getAll: () => { throw new Error('boom') } }), null)
  assert.strictEqual(readOutlookCallbackResult({ getAll: () => 'not-an-array' }), null)
})

test('the message is short, visible copy with NO provider detail', () => {
  const m = messageForOutcome('callback_failed')
  assert.ok(typeof m === 'string' && m.length > 0)
  assert.ok(m.length <= 120, `too long to be a short notice: ${m.length} chars`)
  assert.ok(/outlook/i.test(m), 'the user must know which connection failed')
  assert.ok(/try again/i.test(m), 'the user must be told what to do')
  // Nothing from the refusal vocabulary, and nothing provider-specific.
  for (const leak of [
    'graph', 'oid', 'tenant', 'token', 'scope', 'mismatch', 'identity',
    'microsoft', 'entra', 'rpc', 'finalize', 'state', '401', '403', '500',
  ]) {
    assert.ok(!m.toLowerCase().includes(leak), `the copy leaks ${leak}: ${m}`)
  }
})

test('an unknown outcome still falls back to generic copy', () => {
  assert.strictEqual(messageForOutcome('something_new'),
    'Could not start the Outlook connection. Please try again.')
  // The two must be distinguishable: a failed RETURN is not a failed START.
  assert.notStrictEqual(messageForOutcome('callback_failed'),
    messageForOutcome('something_new'))
})

console.log('')
console.log('the card renders it (SOURCE SCAN - not proof of runtime behaviour)')

const CARD_REL = 'src/components/OutlookConnectionCard.jsx'
const CARD = read(CARD_REL)
const CARD_EXEC = exec(CARD)

test('the card reads the parameter through the controlled helper', () => {
  assert.ok(/readOutlookCallbackResult/.test(CARD_EXEC))
  assert.ok(/useSearchParams/.test(CARD_EXEC))
  // It must not parse the query string by hand.
  assert.ok(!/location\.search/.test(CARD_EXEC),
    'the card must not read the query string directly')
})

test('the banner is OUTSIDE every status branch, so it shows while loading too', () => {
  const banner = CARD_EXEC.indexOf('callbackFailed &&')
  const firstBranch = CARD_EXEC.indexOf("status === 'loading'")
  assert.ok(banner > 0, 'the banner is missing')
  assert.ok(firstBranch > 0, 'the loading branch is missing')
  assert.ok(banner < firstBranch,
    'the banner must precede the first status branch, not live inside one')
})

test('it is suppressed once the DATABASE says the account is connected', () => {
  assert.ok(/callbackFailed\s*=[\s\S]{0,160}status !== 'connected'/.test(CARD_EXEC),
    'a stale ?outlook=error must not contradict a real connection')
})

test('it is announced to assistive technology', () => {
  const at = CARD_EXEC.indexOf('callbackFailed &&')
  const window = CARD_EXEC.slice(at, at + 400)
  assert.ok(/role="status"/.test(window), 'role="status" missing')
  assert.ok(/aria-live="polite"/.test(window), 'aria-live="polite" missing')
})

test('the copy comes from the shared message map, not inline text', () => {
  const at = CARD_EXEC.indexOf('callbackFailed &&')
  const window = CARD_EXEC.slice(at, at + 400)
  assert.ok(/messageForOutcome\('callback_failed'\)/.test(window),
    'the card must not hand-write the failure copy')
})

test('the card still never reads or renders a provider reason', () => {
  for (const leak of [
    'graph_identity_mismatch', 'mailbox_unresolved', 'diagnostic',
    'graph_me_', 'id_token', 'oid',
  ]) {
    assert.ok(!CARD_EXEC.includes(leak), `the card references ${leak}`)
  }
})

// ────────────────────────────────────────────────────────────────────────────
await Promise.all(pending)
console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
