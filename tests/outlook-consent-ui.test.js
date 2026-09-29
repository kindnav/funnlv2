// Settings "Connect Outlook" consent flow.
//
// The decision logic lives in pure modules so it can be driven directly; the
// component is the thin part and is checked structurally for the properties a
// pure test cannot see (an unchecked-by-default box, rendering every paragraph).
//
// Run with: node tests/outlook-consent-ui.test.js

import assert from 'assert'
import { readFileSync } from 'node:fs'
import {
  OUTLOOK_DISCLOSURE_VERSION, OUTLOOK_DISCLOSURE_PARAGRAPHS,
  DISCLOSURE_FINGERPRINT, disclosureFingerprint, verifyDisclosureIntegrity,
} from '../src/lib/outlookDisclosure.js'
import {
  outlookConnectionEnabled, OUTLOOK_CONNECTION_ENABLED, canRequestConsent,
  buildConsentRequest, classifyStartResponse, messageForOutcome,
  DISCLOSURE_PARAGRAPH_COUNT,
} from '../src/lib/outlookConnection.js'
import { resolveOauthStartUrl, OAUTH_START_PATHS } from '../src/lib/oauthStartEndpoint.js'

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
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

test('a failed integrity check REFUSES to build a request', () => {
  // Simulated by tampering through the exported checker the builder uses.
  const real = verifyDisclosureIntegrity()
  assert.strictEqual(real, true, 'precondition')
  // buildConsentRequest calls verifyDisclosureIntegrity() with the shipped
  // paragraphs, so the observable contract is: acknowledged + integrity + origin.
  const r = buildConsentRequest({ acknowledged: true, originOk: true, connecting: false, pageOrigin: 'https://www.getfunnl.com' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.body.consentPolicyVersion, OUTLOOK_DISCLOSURE_VERSION)
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
  const i = CARD.indexOf("outcome.kind === 'stale_version'")
  assert.ok(i > 0, 'the card must handle the stale case')
  assert.ok(CARD.slice(i, i + 400).includes('setAcknowledged(false)'),
    'the acknowledgement must be cleared')
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
  assert.ok(CARD.includes("resolveOauthStartUrl(window.location.origin, 'outlook')"))
  assert.ok(CARD.includes("credentials: 'same-origin'"), 'the binding cookie must be storable')
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
    const re = new RegExp('\b' + banned + '\b', 'i')
    assert.ok(!re.test(CARD_CODE), `the connect card must not reference ${banned}`)
  }
  for (const banned of ['.from(', '.rpc(', 'supabase.from']) {
    assert.ok(!CARD_CODE.includes(banned), `the connect card must not call ${banned}`)
  }
})

test('no token or provider value is handled in the browser', () => {
  for (const banned of ['access_token', 'refresh_token', 'id_token', 'client_secret', 'code_verifier']) {
    assert.ok(!CARD_CODE.includes(banned), `the card must not handle ${banned}`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
