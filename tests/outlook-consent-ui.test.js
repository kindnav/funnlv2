// Settings "Connect Outlook" consent flow.
//
// The decision logic lives in pure modules so it can be driven directly; the
// component is the thin part and is checked structurally for the properties a
// pure test cannot see (an unchecked-by-default box, rendering every paragraph).
//
// WHAT IS BEHAVIOURAL HERE, AND WHAT IS NOT - stated plainly.
//
//   BEHAVIOURAL: startOutlookConsent is driven directly with injected fetch,
//   navigate, bearer and analytics. That is the SAME function the card's click
//   handler calls, so 'unchecked sends nothing', 'a 409 withdraws the tick' and
//   'success navigates once to the provider URL' are executed, not inferred.
//
//   NOT BEHAVIOURAL: the component is never rendered. This suite is
//   zero-dependency Node, which cannot import .jsx without a transform, and the
//   repo carries no React testing library or JSDOM. So the JSX-only properties
//   - the box defaulting to unchecked, the button bound to the enable condition,
//   every paragraph being rendered - are checked by SCANNING THE SOURCE. Those
//   are structural assertions and are not proof of runtime behaviour. A real
//   click-through would need DOM and event tooling this repo does not have.
//
// Run with: node tests/outlook-consent-ui.test.js

import assert from 'assert'
import { readFileSync } from 'node:fs'
import {
  OUTLOOK_DISCLOSURE_VERSION, OUTLOOK_DISCLOSURE_PARAGRAPHS,
  DISCLOSURE_FINGERPRINT, disclosureFingerprint, verifyDisclosureIntegrity,
  computeDisclosureVersion, DISCLOSURE_VERSION_PREFIX, DIGEST_HEX_CHARS,
} from '../src/lib/outlookDisclosure.js'
import {
  outlookConnectionEnabled, OUTLOOK_CONNECTION_ENABLED, canRequestConsent,
  buildConsentRequest, classifyStartResponse, messageForOutcome,
  DISCLOSURE_PARAGRAPH_COUNT, startOutlookConsent,
} from '../src/lib/outlookConnection.js'
import { resolveOauthStartUrl, OAUTH_START_PATHS } from '../src/lib/oauthStartEndpoint.js'

let passed = 0, failed = 0
// DEFECT THIS REPLACED: the previous runner called fn() and reported a tick
// immediately. Twelve tests in this file are async, so their assertions had not
// yet run when they were counted as passing. This is the same await-aware runner
// tests/outlook-provider-redirect.test.js already uses.
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
// Executable code only: the file's own explanatory comments legitimately use
// words like 'sync' to say what this slice does NOT do.
const NL = String.fromCharCode(10)
const CARD_CODE = CARD
  .split(NL).filter((l) => !/^\s*\/\//.test(l)).join(NL)
const SETTINGS = readFileSync(new URL('../src/pages/SettingsPage.jsx', import.meta.url), 'utf8')

console.log('\ndormancy')

test('the flag is off unless it is exactly the string true', () => {
  assert.strictEqual(outlookConnectionEnabled('true'), true)
  for (const v of ['TRUE', 'True', '1', 'yes', '', ' true', 'true ', null, undefined, true]) {
    assert.strictEqual(outlookConnectionEnabled(v), false, String(v))
  }
})

test('the module-level flag is false outside Vite (fail-safe default)', () => {
  assert.strictEqual(OUTLOOK_CONNECTION_ENABLED, false)
})

test('Settings renders the card ONLY behind that flag', () => {
  assert.ok(SETTINGS.includes('OUTLOOK_CONNECTION_ENABLED && ('),
    'the card must be inside a flag guard')
  const guard = SETTINGS.indexOf('OUTLOOK_CONNECTION_ENABLED && (')
  const mount = SETTINGS.indexOf('<OutlookConnectionCard />')
  assert.ok(guard > 0 && mount > guard, 'the mount must sit inside the guard')
  // It must not share the Calendar flag: the two roll out independently.
  const between = SETTINGS.slice(guard, mount)
  assert.ok(!between.includes('CALENDAR_CONNECTION_ENABLED'))
})

console.log('\nthe version is bound to the text it names')

test('the declared fingerprint matches the paragraphs actually shipped', () => {
  assert.strictEqual(disclosureFingerprint(OUTLOOK_DISCLOSURE_PARAGRAPHS), DISCLOSURE_FINGERPRINT)
  assert.strictEqual(verifyDisclosureIntegrity(), true)
})

test('editing ONE character of the text invalidates the version', () => {
  // This is the guard against a hardcoded version travelling without its text.
  const tampered = [...OUTLOOK_DISCLOSURE_PARAGRAPHS]
  tampered[0] = tampered[0].replace('optional', 'optionai')
  assert.notStrictEqual(disclosureFingerprint(tampered), DISCLOSURE_FINGERPRINT)
  assert.strictEqual(verifyDisclosureIntegrity(tampered), false)
})

test('dropping or reordering a paragraph invalidates the version', () => {
  assert.strictEqual(verifyDisclosureIntegrity(OUTLOOK_DISCLOSURE_PARAGRAPHS.slice(1)), false)
  const swapped = [...OUTLOOK_DISCLOSURE_PARAGRAPHS]
  ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
  assert.strictEqual(verifyDisclosureIntegrity(swapped), false)
})

test('a HEALTHY build produces a request carrying the derived version', () => {
  const r = buildConsentRequest({ acknowledged: true, originOk: true, connecting: false, pageOrigin: 'https://www.getfunnl.com' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.body.consentPolicyVersion, OUTLOOK_DISCLOSURE_VERSION)
})

test('a FAILED integrity check really refuses, and sends nothing', async () => {
  // Driven, not asserted about: verifyIntegrity is injected as failing, which
  // is what a text/fingerprint drift would look like at runtime.
  const failing = () => false
  const r = buildConsentRequest({
    acknowledged: true, originOk: true, connecting: false,
    pageOrigin: 'https://www.getfunnl.com', verifyIntegrity: failing,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'disclosure_integrity_failed')
  assert.strictEqual(r.body, undefined, 'no body may be produced')

  // …and the whole flow makes no network call and does not navigate.
  let fetched = 0, navigated = 0, bearerAsked = 0
  const out = await startOutlookConsent({
    acknowledged: true, connecting: false, pageOrigin: 'https://www.getfunnl.com',
    apikey: 'k', verifyIntegrity: failing,
    getBearer: async () => { bearerAsked++; return 'b' },
    fetchImpl: async () => { fetched++; return { status: 200, json: async () => ({}) } },
    navigate: () => { navigated++ },
  })
  assert.strictEqual(fetched, 0, 'no request may be sent')
  assert.strictEqual(navigated, 0, 'nothing may navigate')
  assert.strictEqual(bearerAsked, 0, 'no credential may be touched')
  assert.strictEqual(out.navigated, false)
  assert.ok(/could not be verified/i.test(out.message))
})

test('integrity failure beats acknowledgement: a ticked box does not override it', () => {
  const r = buildConsentRequest({
    acknowledged: true, originOk: true, connecting: false,
    pageOrigin: 'https://www.getfunnl.com', verifyIntegrity: () => false,
  })
  assert.strictEqual(r.reason, 'disclosure_integrity_failed')
})
test('the card renders EVERY paragraph, not a summary', () => {
  assert.ok(CARD.includes('OUTLOOK_DISCLOSURE_PARAGRAPHS.map('),
    'the card must render the exported paragraphs')
  assert.strictEqual(DISCLOSURE_PARAGRAPH_COUNT, OUTLOOK_DISCLOSURE_PARAGRAPHS.length)
  assert.ok(DISCLOSURE_PARAGRAPH_COUNT >= 5, 'the disclosure must be substantive')
})

test('the disclosure names BOTH permissions and what each is for', () => {
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  assert.ok(text.includes('Mail.Read'), 'must name Mail.Read')
  assert.ok(text.includes('User.Read'), 'must name User.Read')
  assert.ok(/read-only/i.test(text), 'must say read-only')
  assert.ok(/mailbox-wide/i.test(text), 'must not hide that Mail.Read is mailbox-wide')
  assert.ok(/full profile/i.test(text) && /company information/i.test(text),
    "must state what User.Read permits, in Microsoft's own terms")
  assert.ok(/permits more than Funnl requests/i.test(text),
    'must distinguish what is permitted from what is requested')
})

test('the disclosure states review-before-save, not automatic saving', () => {
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  assert.ok(/until you review it/i.test(text))
  assert.ok(/edit or dismiss/i.test(text))
  assert.ok(!/automatically (save|add|log)/i.test(text))
})

console.log('\nrefusal: consent is never implied')

test('the acknowledgement box defaults to UNCHECKED', () => {
  assert.ok(CARD.includes('useState(false)'), 'acknowledged must start false')
  assert.ok(/checked=\{acknowledged\}/.test(CARD), 'the box is controlled by that state')
  assert.ok(!/defaultChecked/.test(CARD), 'it must never be pre-ticked')
})

test('without acknowledgement NO request is built', () => {
  const r = buildConsentRequest({ acknowledged: false, originOk: true, connecting: false, pageOrigin: 'https://www.getfunnl.com' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'not_acknowledged')
  assert.strictEqual(r.body, undefined, 'no body may be produced')
})

test('the Connect button is disabled until every condition holds', () => {
  const ok = { acknowledged: true, integrityOk: true, originOk: true, connecting: false }
  assert.strictEqual(canRequestConsent(ok), true)
  assert.strictEqual(canRequestConsent({ ...ok, acknowledged: false }), false)
  assert.strictEqual(canRequestConsent({ ...ok, integrityOk: false }), false)
  assert.strictEqual(canRequestConsent({ ...ok, originOk: false }), false)
  assert.strictEqual(canRequestConsent({ ...ok, connecting: true }), false)
  assert.ok(CARD.includes('disabled={!canConnect}'), 'the button must be bound to it')
})

test('a non-canonical origin refuses before any request', () => {
  const r = buildConsentRequest({ acknowledged: true, originOk: false, connecting: false, pageOrigin: 'https://getfunnl.com' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'non_canonical_origin')
  // …because a cookie set there could never reach the branded callback.
  assert.strictEqual(resolveOauthStartUrl('https://getfunnl.com', 'outlook').ok, false)
})

console.log('\nstale version')

test('a 409 is classified as a stale version, not a generic error', () => {
  assert.deepStrictEqual(classifyStartResponse(409, { error: 'consent_version_mismatch' }), { kind: 'stale_version' })
  assert.deepStrictEqual(classifyStartResponse(400, { error: 'consent_version_mismatch' }), { kind: 'stale_version' })
})

test('a stale version tells the user to RELOAD and read the current text', () => {
  const msg = messageForOutcome('stale_version')
  assert.ok(/updated/i.test(msg) && /reload/i.test(msg))
  assert.ok(/current version/i.test(msg))
})

test('a stale version WITHDRAWS the acknowledgement', () => {
  // Carrying a tick forward to text the user has not read would be the same
  // defect as a hardcoded version.
  // The decision lives in startOutlookConsent (driven behaviourally below);
  // the card's job is to APPLY it.
  assert.ok(CARD.includes('if (result.clearAcknowledgement) setAcknowledged(false)'),
    'the card must clear the tick when the flow says to')
})

console.log('\nsuccessful start')

test('a 200 with a url is a redirect, and nothing else is', () => {
  assert.deepStrictEqual(classifyStartResponse(200, { url: 'https://login.microsoftonline.com/x' }),
    { kind: 'redirect', url: 'https://login.microsoftonline.com/x' })
  assert.strictEqual(classifyStartResponse(200, {}).kind, 'error')
  assert.strictEqual(classifyStartResponse(200, { url: '' }).kind, 'error')
  assert.strictEqual(classifyStartResponse(200, null).kind, 'error')
})

test('the request carries the return origin and the bound version', () => {
  const r = buildConsentRequest({ acknowledged: true, originOk: true, connecting: false, pageOrigin: 'https://www.getfunnl.com' })
  assert.deepStrictEqual(r.body, {
    returnOrigin: 'https://www.getfunnl.com',
    consentPolicyVersion: OUTLOOK_DISCLOSURE_VERSION,
  })
})

test('it POSTs to the branded Outlook start path', () => {
  assert.strictEqual(OAUTH_START_PATHS.outlook, '/api/outlook-oauth-start')
  assert.deepStrictEqual(resolveOauthStartUrl('https://www.getfunnl.com', 'outlook'),
    { ok: true, url: '/api/outlook-oauth-start' })
  // The card delegates to startOutlookConsent, which resolves the branded path
  // and sets same-origin credentials - both asserted behaviourally below.
  assert.ok(CARD.includes('startOutlookConsent({'), 'the card must delegate to the tested flow')
})

test('every other server outcome has its own message, none echoing the server', () => {
  for (const [status, body, kind] of [
    [503, { error: 'outlook_not_enabled' }, 'not_enabled'],
    [503, { error: 'config_missing' }, 'not_configured'],
    [400, { error: 'consent_required' }, 'consent_required'],
    [401, { error: 'unauthorized' }, 'signed_out'],
    [500, { error: 'internal_error' }, 'error'],
  ]) {
    assert.strictEqual(classifyStartResponse(status, body).kind, kind)
    const msg = messageForOutcome(kind)
    assert.ok(msg.length > 0)
    assert.ok(!msg.includes(body.error), 'a server code must not be shown verbatim')
  }
})

console.log('\nscope: this slice connects only')

test('the card creates no contact, logs no interaction, syncs no mailbox', () => {
  // Word-bounded: 'async function' legitimately contains 'sync'.
  for (const banned of ['contacts', 'interactions', 'sync', 'candidate',
    'accept_new_contact_candidate', 'graph', 'messages']) {
    // String.fromCharCode(92) is a literal backslash. Writing '' here would
    // be the BACKSPACE character, which never matches - an earlier revision did
    // exactly that, so this assertion could not fail.
    const B = String.fromCharCode(92) + 'b'
    const re = new RegExp(B + banned + B, 'i')
    assert.ok(!re.test(CARD_CODE), `the connect card must not reference ${banned}`)
  }
  for (const banned of ['.from(', 'supabase.from']) {
    assert.ok(!CARD_CODE.includes(banned), `the card must not query a table: ${banned}`)
  }
  // .rpc( is now legitimate, but ONLY for the two user-scoped Outlook RPCs, and
  // only with a literal name - a computed name could reach anything granted to
  // the authenticated role.
  const named = [...CARD_CODE.matchAll(/\.rpc\(\s*'([^']*)'/g)].map((m) => m[1]).sort()
  assert.deepStrictEqual(named, ['disconnect_my_outlook', 'get_my_outlook_connection'],
    `the card called unexpected RPCs: ${named.join(', ')}`)
  const allCalls = CARD_CODE.match(/\.rpc\(/g) || []
  assert.strictEqual(allCalls.length, named.length,
    'every .rpc( call must name its function as a literal')
})

test('no token or provider value is handled in the browser', () => {
  for (const banned of ['access_token', 'refresh_token', 'id_token', 'client_secret', 'code_verifier']) {
    assert.ok(!CARD_CODE.includes(banned), `the card must not handle ${banned}`)
  }
})

console.log('')
console.log('behaviour: the start flow, driven directly')

// startOutlookConsent is what the component calls, so these exercise the real
// control flow with injected fetch / navigate rather than asserting on source.
function harness (over = {}) {
  const calls = { fetch: [], navigate: [], track: [] }
  const base = {
    acknowledged: true,
    connecting: false,
    pageOrigin: 'https://www.getfunnl.com',
    apikey: 'sb_publishable_test',
    getBearer: async () => 'test-bearer',
    fetchImpl: async (url, init) => {
      calls.fetch.push({ url, init })
      return { status: 200, json: async () => ({ url: 'https://login.microsoftonline.com/go' }) }
    },
    navigate: (url) => calls.navigate.push(url),
    trackImpl: (n, p) => calls.track.push([n, p]),
  }
  return { calls, args: { ...base, ...over } }
}

test('UNCHECKED: no request is made and nothing navigates', async () => {
  const h = harness({ acknowledged: false })
  const r = await startOutlookConsent(h.args)
  assert.strictEqual(h.calls.fetch.length, 0, 'no request may be sent')
  assert.strictEqual(h.calls.navigate.length, 0, 'nothing may navigate')
  assert.strictEqual(r.navigated, false)
  assert.strictEqual(r.clearAcknowledgement, false)
  assert.ok(r.message.length > 0)
})

test('UNCHECKED: the bearer token is never even requested', async () => {
  let bearerAsked = false
  const h = harness({ acknowledged: false, getBearer: async () => { bearerAsked = true; return 'x' } })
  await startOutlookConsent(h.args)
  assert.strictEqual(bearerAsked, false, 'refusal must happen before any credential use')
})

test('a non-canonical origin makes no request', async () => {
  const h = harness({ pageOrigin: 'https://getfunnl.com' })
  const r = await startOutlookConsent(h.args)
  assert.strictEqual(h.calls.fetch.length, 0)
  assert.ok(/www\.getfunnl\.com/.test(r.message))
})

test('SUCCESS: navigates exactly once, to the provider URL, and nowhere else', async () => {
  const h = harness()
  const r = await startOutlookConsent(h.args)
  assert.strictEqual(h.calls.fetch.length, 1, 'exactly one request')
  assert.strictEqual(h.calls.fetch[0].url, '/api/outlook-oauth-start')
  assert.deepStrictEqual(h.calls.navigate, ['https://login.microsoftonline.com/go'])
  assert.strictEqual(r.navigated, true)
  assert.strictEqual(r.message, '')
})

test('SUCCESS: the request carries the DERIVED version and same-origin credentials', async () => {
  const h = harness()
  await startOutlookConsent(h.args)
  const init = h.calls.fetch[0].init
  assert.strictEqual(init.method, 'POST')
  assert.strictEqual(init.credentials, 'same-origin')
  assert.strictEqual(init.headers.Authorization, 'Bearer test-bearer')
  const body = JSON.parse(init.body)
  assert.strictEqual(body.consentPolicyVersion, OUTLOOK_DISCLOSURE_VERSION)
  assert.strictEqual(body.returnOrigin, 'https://www.getfunnl.com')
})

test('STALE 409: acknowledgement is withdrawn and nothing navigates', async () => {
  const h = harness({
    fetchImpl: async (url, init) => {
      h.calls.fetch.push({ url, init })
      return { status: 409, json: async () => ({ error: 'consent_version_mismatch' }) }
    },
  })
  const r = await startOutlookConsent(h.args)
  assert.strictEqual(r.clearAcknowledgement, true, 'the tick must not survive')
  assert.strictEqual(r.navigated, false)
  assert.strictEqual(h.calls.navigate.length, 0)
  assert.ok(/reload/i.test(r.message))
})

test('a non-stale failure does NOT clear the acknowledgement', async () => {
  const h = harness({
    fetchImpl: async () => ({ status: 500, json: async () => ({ error: 'internal_error' }) }),
  })
  const r = await startOutlookConsent(h.args)
  assert.strictEqual(r.clearAcknowledgement, false)
  assert.strictEqual(r.navigated, false)
})

test('no session: refuses without sending anything', async () => {
  const h = harness({ getBearer: async () => null })
  const r = await startOutlookConsent(h.args)
  assert.strictEqual(h.calls.fetch.length, 0)
  assert.ok(/sign in/i.test(r.message))
})

test('a thrown fetch is a controlled failure, not a crash', async () => {
  const h = harness({ fetchImpl: async () => { throw new Error('offline') } })
  const r = await startOutlookConsent(h.args)
  assert.strictEqual(r.navigated, false)
  assert.ok(r.message.length > 0)
})

test('analytics fire only on a real start, and carry no content', async () => {
  const ok = harness()
  await startOutlookConsent(ok.args)
  assert.deepStrictEqual(ok.calls.track, [['outlook_connect_started', { provider: 'outlook' }]])
  const refused = harness({ acknowledged: false })
  await startOutlookConsent(refused.args)
  assert.deepStrictEqual(refused.calls.track, [])
})


console.log('')
console.log('the version cannot describe two different texts')

test('the version is DERIVED from the text, not an independent constant', () => {
  assert.strictEqual(OUTLOOK_DISCLOSURE_VERSION, computeDisclosureVersion())
  assert.ok(OUTLOOK_DISCLOSURE_VERSION.startsWith(DISCLOSURE_VERSION_PREFIX + '-'))
  assert.ok(OUTLOOK_DISCLOSURE_VERSION.endsWith(disclosureFingerprint(OUTLOOK_DISCLOSURE_PARAGRAPHS)))
})

test('changed text PLUS an updated fingerprint still yields a NEW version', () => {
  // The exact hole in the earlier design: edit the paragraphs, update
  // DISCLOSURE_FINGERPRINT so integrity passes again, and the version was
  // unchanged - so one consent_policy_version could describe two documents.
  const tampered = [...OUTLOOK_DISCLOSURE_PARAGRAPHS]
  tampered[0] = tampered[0] + ' An added sentence.'
  const updatedFingerprint = disclosureFingerprint(tampered)

  // Integrity CAN be repaired that way...
  assert.strictEqual(verifyDisclosureIntegrity(tampered, updatedFingerprint), true,
    'precondition: updating the fingerprint restores integrity')

  // ...but the version must NOT survive it.
  assert.notStrictEqual(computeDisclosureVersion(tampered), OUTLOOK_DISCLOSURE_VERSION,
    'a changed text must produce a different version')
})

test('two texts that COLLIDE under the old FNV-32 scheme are distinguished now', () => {
  // A real collision, found by search. Under the previous 32-bit FNV-1a
  // fingerprint these two distinct strings hashed identically, so an edit
  // could have kept the old version - the claim that a text change NECESSARILY
  // changed the version was false.
  const A = 'Funnl consent text variant 693709'
  const B = 'Funnl consent text variant 1083080'
  assert.notStrictEqual(A, B)

  const fnv1a32 = (s) => {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    return h.toString(16).padStart(8, '0')
  }
  assert.strictEqual(fnv1a32(A), fnv1a32(B), 'precondition: these collide under FNV-32')

  // The replacement separates them, at both the digest and version level.
  assert.notStrictEqual(disclosureFingerprint([A]), disclosureFingerprint([B]))
  assert.notStrictEqual(computeDisclosureVersion([A]), computeDisclosureVersion([B]))
})

test('the digest is SHA-256 truncated to 128 bits, matching node:crypto', async () => {
  const { createHash } = await import('node:crypto')
  const paras = ['alpha', 'beta']
  const joined = paras.join(String.fromCharCode(10))
  const full = createHash('sha256').update(joined, 'utf8').digest('hex')
  assert.strictEqual(disclosureFingerprint(paras), full.slice(0, DIGEST_HEX_CHARS))
  assert.strictEqual(DIGEST_HEX_CHARS, 32, '128 bits')
})

test('the version satisfies the DB consent_policy_version CHECK', () => {
  // 1..40 chars, no whitespace, no control characters.
  assert.ok(OUTLOOK_DISCLOSURE_VERSION.length >= 1 && OUTLOOK_DISCLOSURE_VERSION.length <= 40,
    `length ${OUTLOOK_DISCLOSURE_VERSION.length}`)
  assert.ok(!/[\s]/.test(OUTLOOK_DISCLOSURE_VERSION), 'no whitespace')
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[ -]/.test(OUTLOOK_DISCLOSURE_VERSION), 'no control characters')
})

test('the server still performs an EXACT match, which this does not weaken', () => {
  const startSrc = readFileSync(
    new URL('../supabase/functions/outlook-oauth-start/index.ts', import.meta.url), 'utf8')
  assert.ok(startSrc.includes('consentPolicyVersion !== configuredVersion'),
    'the server must still compare exactly')
  assert.ok(startSrc.includes('consent_version_mismatch'))
})

console.log('')
console.log('the scope scan can actually fail')

test('the word-boundary scan MATCHES an injected banned call', () => {
  // Proves the assertion is live. The earlier revision built its regex from
  // '' (BACKSPACE), so it could never match anything.
  const Q = String.fromCharCode(39)
  const B = String.fromCharCode(92) + 'b'
  const injected = CARD_CODE + NL +
    '  const rows = await supabase.from(' + Q + 'contacts' + Q + ').select()'
  assert.ok(new RegExp(B + 'contacts' + B, 'i').test(injected),
    'a banned identifier must be detected')
  assert.ok(injected.includes('.from('), 'a banned call must be detected')
  // And the real file is clean.
  assert.ok(!new RegExp(B + 'contacts' + B, 'i').test(CARD_CODE))
  assert.ok(!CARD_CODE.includes('.from('))
})

test('a BACKSPACE-built pattern would never match, which is why it is not used', () => {
  const backspace = String.fromCharCode(8)
  const broken = new RegExp(backspace + 'contacts' + backspace, 'i')
  assert.strictEqual(broken.test('supabase.from(contacts)'), false,
    'demonstrates the defect this replaced')
})

console.log('')
console.log('the draft claims no capability that does not exist')

test('the disclosure now OFFERS disconnect, because it exists', () => {
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  assert.ok(/disconnect at any time/i.test(text), 'disconnect is built, so say so')
  assert.ok(!/not built yet/i.test(text), 'the old absence notice must be gone')
})

test('the disclosure describes suggestions as EMPTIED, never as deleted', () => {
  // The applied RPC keeps the suggestion row and NULLs its contents. Calling
  // that deletion would be a false statement about what happened to the data.
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  assert.ok(/empties any suggestion/i.test(text), 'the emptying must be stated')
  assert.ok(!/deletes? (any |your |all )?suggestions?/i.test(text),
    'suggestions are not deleted, so the text must not say they are')
  assert.ok(/Contacts and interactions you already saved are kept/i.test(text),
    'the user must be told their saved records survive')
})

test('the disclosure does NOT claim the Microsoft grant is revoked', () => {
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  assert.ok(/does not withdraw the permission at Microsoft/i.test(text),
    'the limit of a local disconnect must be stated')
  // Checked by NEGATION rather than by banned words: the sentence that mentions
  // withdrawal is exactly the one that says it does not happen. So every sentence
  // mentioning revocation or withdrawal must be a negative one.
  const sentences = text.split(/(?<=[.])\s+/)
  for (const s of sentences) {
    if (!/revok|withdraw/i.test(s)) continue
    assert.ok(/does not|do not|cannot|never/i.test(s),
      `a sentence claims revocation happens: ${s}`)
  }
})

test('a disconnect path really exists, matching the wording', () => {
  assert.ok(/disconnect/i.test(CARD_CODE), 'the card must carry a disconnect control')
  assert.ok(CARD.includes("runOutlookDisconnect"), 'it must go through the reviewed flow')
  assert.ok(CARD.includes("supabase.rpc('disconnect_my_outlook')"),
    'and reach the applied user RPC')
})

async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
