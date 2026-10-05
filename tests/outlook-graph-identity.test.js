// The Graph-vs-id_token identity check, and the Settings surface for a refused
// callback.
//
// WHY THIS EXISTS. The first live pilot consent refused with
// graph_identity_mismatch and returned to a Settings page that showed nothing.
// The only prior coverage of this path used SYNTHETIC identifiers ('oid-1'),
// neither GUID nor hex, so no realistic representation was ever exercised.
//
// WHAT IS DECIDED. Zero-padding of a personal-account `oid` has been described
// publicly, but the exact relationship to what Graph /me returned FOR OUR LIVE
// ACCOUNT is unverified - nothing recorded it. So exact (case-insensitive)
// equality stands for both account types, unknown shapes stay REJECTED, and the
// relationship is only RECORDED in a privacy-safe diagnostic, so the next
// controlled pilot attempt establishes the shape without logging either
// identifier.
//
// SCOPE. The functions below are EXECUTED. Two source scans cover the
// handler's ordering and its log hygiene, which cannot be imported here
// (handler.js imports from esm.sh). Real-handler behaviour is proven by
// tests/outlook-callback-positive-integration.test.js (opt-in: Docker +
// FUNNL_EDGE_INTEGRATION=1); the rendered card by
// tests/local/outlook-pilot-browser.mjs. No real Microsoft response is
// exercised anywhere, and every identifier here is invented.
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
// PERSONAL_SHORT_16 is its zero-padded relationship. WORK_OID_GUID does not,
// so WORK_SHORT_16 is a bare suffix coincidence.
const PERSONAL_OID_GUID = '00000000-0000-0000-7a3b-9c15e204d6f8'
const PERSONAL_SHORT_16 = '7a3b9c15e204d6f8'
const WORK_OID_GUID = 'c41d8f72-5b90-4e63-a1d2-77f0ba3c9e45'
const WORK_SHORT_16 = 'a1d277f0ba3c9e45'
const MAIL = 'student@outlook.test'

console.log('')
console.log('strict refusal: every non-identical pair fails closed')

test('an exactly equal pair resolves, for either account type', () => {
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody({ id: PERSONAL_OID_GUID, mail: MAIL }, PERSONAL_OID_GUID, 'personal'),
    { ok: true, email: MAIL })
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody({ id: WORK_OID_GUID, mail: MAIL }, WORK_OID_GUID, 'work'),
    { ok: true, email: MAIL })
  // Case and surrounding space are normalised, nothing else is.
  assert.deepStrictEqual(
    resolveMailboxFromGraphBody({ id: ' ' + PERSONAL_OID_GUID.toUpperCase(), mail: MAIL },
      PERSONAL_OID_GUID, 'personal'),
    { ok: true, email: MAIL })
})

test('the PERSONAL equivalent-looking pair is still refused', () => {
  const r = resolveMailboxFromGraphBody(
    { id: PERSONAL_SHORT_16, mail: MAIL }, PERSONAL_OID_GUID, 'personal')
  assert.strictEqual(r.ok, false, 'the unverified equivalence must not be granted')
  assert.strictEqual(r.reason, 'graph_identity_mismatch')
  assert.strictEqual(r.email, undefined, 'no address may come back on a refusal')
})

test('WORK stays strict, including a GUID vs its own trailing 16 hex digits', () => {
  const r = resolveMailboxFromGraphBody({ id: WORK_SHORT_16, mail: MAIL }, WORK_OID_GUID, 'work')
  assert.strictEqual(r.reason, 'graph_identity_mismatch')
  assert.strictEqual(r.diagnostic.account, 'work')
})

test('malformed, unrelated, suffix-matching and address-shaped ids are refused', () => {
  const refused = [
    PERSONAL_SHORT_16.toUpperCase(),            // right digits, wrong form
    PERSONAL_OID_GUID.replace(/-/g, ''),        // flat 32-hex
    '7a3b9c15e204d6f9',                         // one digit different
    '9c15e204d6f8', 'e204d6f8', '00000000',     // partial suffix / prefix
    '00000000-0000-0000-1111-222222222222',     // a different account
    MAIL, 'oid-1', 'z'.repeat(16), '-'.repeat(36),
  ]
  for (const id of refused) {
    const r = resolveMailboxFromGraphBody({ id, mail: MAIL }, PERSONAL_OID_GUID, 'personal')
    assert.strictEqual(r.reason, 'graph_identity_mismatch', `accepted ${id}`)
  }
  // Absent or non-string ids and oids get their own controlled reasons, and no
  // diagnostic - there was nothing to compare.
  assert.strictEqual(resolveMailboxFromGraphBody({ mail: MAIL }, PERSONAL_OID_GUID).reason,
    'graph_me_no_id')
  assert.strictEqual(resolveMailboxFromGraphBody({ id: '  ', mail: MAIL }, PERSONAL_OID_GUID).reason,
    'graph_me_no_id')
  assert.strictEqual(resolveMailboxFromGraphBody(null, PERSONAL_OID_GUID).reason,
    'graph_me_malformed')
  const noOid = resolveMailboxFromGraphBody({ id: PERSONAL_OID_GUID, mail: MAIL }, '')
  assert.strictEqual(noOid.reason, 'no_validated_oid')
  assert.strictEqual(noOid.diagnostic, undefined)
})

test('EMAIL IS NEVER IDENTITY, and no address is ever invented', () => {
  // Both addresses agree and are the only thing that agrees. Still refused.
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: MAIL, mail: MAIL, userPrincipalName: MAIL },
      PERSONAL_OID_GUID, 'personal').reason,
    'graph_identity_mismatch')
  // A matching id with no usable address fails rather than filling the NOT NULL
  // column with something made up.
  assert.strictEqual(
    resolveMailboxFromGraphBody({ id: PERSONAL_OID_GUID, userPrincipalName: 'DOMAIN\\user' },
      PERSONAL_OID_GUID, 'personal').reason,
    'no_usable_mailbox_address')
})

console.log('')
console.log('the diagnostic: relationship recorded, nothing identifying logged')

test('the relationship boolean is true for the zero-padded pair, both ways', () => {
  const fwd = describeIdentityMismatch(PERSONAL_SHORT_16, PERSONAL_OID_GUID, 'personal')
  assert.strictEqual(fwd.graph_id_is_short_form_of_oid, true)
  assert.strictEqual(fwd.oid_is_short_form_of_graph_id, false)
  assert.strictEqual(fwd.account, 'personal')
  assert.strictEqual(fwd.graph_id_shape, 'hex16')
  assert.strictEqual(fwd.oid_shape, 'guid')
  assert.strictEqual(fwd.graph_id_len, 16)
  assert.strictEqual(fwd.oid_len, 36)
  assert.strictEqual(fwd.equal_case_insensitive, false)

  const rev = describeIdentityMismatch(PERSONAL_OID_GUID, PERSONAL_SHORT_16, 'personal')
  assert.strictEqual(rev.graph_id_is_short_form_of_oid, false)
  assert.strictEqual(rev.oid_is_short_form_of_graph_id, true)
})

test('a suffix coincidence without an all-zero leading half is NOT the relationship', () => {
  // The whole point: WORK_SHORT_16 IS the trailing 16 hex digits of
  // WORK_OID_GUID, and must still report false.
  assert.strictEqual(isZeroPaddedGuidOf(WORK_OID_GUID, WORK_SHORT_16), false)
  assert.strictEqual(isZeroPaddedGuidOf(PERSONAL_OID_GUID, PERSONAL_SHORT_16), true)
  for (const [g, s] of [
    [PERSONAL_OID_GUID, 'deadbeefdeadbeef'],
    [PERSONAL_OID_GUID, PERSONAL_SHORT_16 + '0'],
    [PERSONAL_OID_GUID, MAIL],
    ['not-a-guid', PERSONAL_SHORT_16],
    [PERSONAL_SHORT_16, PERSONAL_SHORT_16],
    [null, undefined],
  ]) assert.strictEqual(isZeroPaddedGuidOf(g, s), false, `${g} / ${s}`)
})

test('an unrelated pair reports both directions false', () => {
  const d = describeIdentityMismatch('00000000-0000-0000-1111-222222222222',
    PERSONAL_OID_GUID, 'personal')
  assert.strictEqual(d.graph_id_is_short_form_of_oid, false)
  assert.strictEqual(d.oid_is_short_form_of_graph_id, false)
})

test('the account label comes from the validated tenant, and is never guessed', () => {
  // A zero-padded pair on a WORK tenant: relationship reported, still refused,
  // and labelled work - so a consumers-tenant finding cannot be confused with it.
  const w = resolveMailboxFromGraphBody(
    { id: PERSONAL_SHORT_16, mail: MAIL }, PERSONAL_OID_GUID, 'work')
  assert.strictEqual(w.ok, false)
  assert.strictEqual(w.diagnostic.account, 'work')
  assert.strictEqual(w.diagnostic.graph_id_is_short_form_of_oid, true)
  for (const t of [undefined, null, '', 'PERSONAL', 'consumer', 42]) {
    assert.strictEqual(describeIdentityMismatch('a', 'b', t).account, 'unknown',
      JSON.stringify(t))
  }
})

test('the serialized diagnostic leaks no part of either identifier', () => {
  const serialized = JSON.stringify(
    describeIdentityMismatch(PERSONAL_SHORT_16, PERSONAL_OID_GUID, 'personal'))
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
  // Only shapes, lengths and booleans - nothing of unbounded content.
  for (const v of Object.values(
    describeIdentityMismatch(PERSONAL_SHORT_16, PERSONAL_OID_GUID, 'personal'))) {
    assert.ok(['number', 'boolean'].includes(typeof v)
      || ['personal', 'work', 'unknown', 'absent', 'guid', 'hex16', 'hex32', 'other'].includes(v),
      `unexpected diagnostic value: ${JSON.stringify(v)}`)
  }
})

test('identifierShape classifies the forms the diagnostic reports', () => {
  assert.strictEqual(identifierShape(PERSONAL_OID_GUID), 'guid')
  assert.strictEqual(identifierShape(PERSONAL_SHORT_16), 'hex16')
  assert.strictEqual(identifierShape('a'.repeat(32)), 'hex32')
  assert.strictEqual(identifierShape(MAIL), 'other')
  assert.strictEqual(identifierShape('   '), 'absent')
  assert.strictEqual(identifierShape(null), 'absent')
})

console.log('')
console.log('fetchMailboxAddress carries the validated account type through')

test('a fetched mismatch reports the account type and the relationship', async () => {
  const r = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID, accountType: 'personal',
    fetchImpl: async () => ({ status: 200, json: async () => ({ id: PERSONAL_SHORT_16, mail: MAIL }) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.strictEqual(r.reason, 'graph_identity_mismatch')
  assert.strictEqual(r.diagnostic.account, 'personal')
  assert.strictEqual(r.diagnostic.graph_id_is_short_form_of_oid, true)
  // Omitting the label still yields a usable record.
  const u = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID,
    fetchImpl: async () => ({ status: 200, json: async () => ({ id: PERSONAL_SHORT_16, mail: MAIL }) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.strictEqual(u.diagnostic.account, 'unknown')
  assert.strictEqual(u.diagnostic.graph_id_is_short_form_of_oid, true)
})

test('a matching fetch resolves; a transport failure carries no diagnostic', async () => {
  assert.deepStrictEqual(await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID, accountType: 'personal',
    fetchImpl: async () => ({ status: 200, json: async () => ({ id: PERSONAL_OID_GUID, mail: MAIL }) }),
    meUrl: 'https://graph.invalid/me',
  }), { ok: true, email: MAIL })
  const f = await fetchMailboxAddress({
    accessToken: 'at', oid: PERSONAL_OID_GUID, accountType: 'personal',
    fetchImpl: async () => ({ status: 403, json: async () => ({}) }),
    meUrl: 'https://graph.invalid/me',
  })
  assert.strictEqual(f.reason, 'graph_me_forbidden')
  assert.strictEqual(f.diagnostic, undefined)
})

console.log('')
console.log('the callback: refuse before finalize, and log only safe values')

const HANDLER = exec(read('supabase/functions/outlook-oauth-callback/handler.js'))

test('an unresolved mailbox returns BEFORE finalize_microsoft_connection', () => {
  // Behaviourally proven against the real handler under Deno by
  // tests/outlook-callback-positive-integration.test.js, which also proves an
  // exactly equal id DOES finalize. This scan guards the ordering in source.
  const guard = HANDLER.indexOf('if (!mailbox.ok)')
  const finalize = HANDLER.indexOf('finalize_microsoft_connection')
  assert.ok(guard > 0 && finalize > 0, 'guard or finalize call missing')
  assert.ok(guard < finalize, 'the guard must precede the finalize RPC')
  assert.ok(/return redirect\(failRedirect\)/.test(HANDLER.slice(guard, finalize)),
    'the guard must return, not fall through')
  assert.ok(/accountType:\s*identity\.accountType/.test(HANDLER),
    'the diagnostic label must come from the validated id_token')
})

test('the diagnostic is logged for graph_identity_mismatch ONLY', () => {
  assert.ok(
    /mailbox\.reason === 'graph_identity_mismatch'[\s\S]{0,200}JSON\.stringify\(mailbox\.diagnostic\)/
      .test(HANDLER),
    'the diagnostic must be gated on the identity-mismatch reason')
  // Every other mailbox failure keeps its bare controlled reason code.
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
  // A URLSearchParams, as the card passes it.
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
  // A failed RETURN must read differently from a failed START.
  assert.notStrictEqual(m, messageForOutcome('unknown_outcome'))
})

test('the card renders it through the shared helper and message map', () => {
  // The rendered banner - its placement, aria-live, and suppression once
  // connected - is driven in a real browser by
  // tests/local/outlook-pilot-browser.mjs. This only guards the wiring.
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
