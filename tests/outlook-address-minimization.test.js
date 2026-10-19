// THE REPRODUCED OCTOBER 12 FAILURE, AND ITS FIX, THROUGH THE REAL CONTENT PATH.
//
// What happened in Production: a genuine four-message, two-sided exchange - two in Inbox,
// two in Sent Items, one external participant, same conversationId, none drafts, clean
// automation headers - produced no suggestion.
//
// HOW THE CAUSE WAS ESTABLISHED, and how it was not. The notification-kicked run's report
// was NOT retained: the kick path discards the worker's response, so no live report names
// this cause. The retained scheduled report, from the earlier round, says
// `not_two_sided: 1, recovered_messages: 1, bodies_read: 0, model_calls: 0, created: 0` -
// that round only. The cause was established by running the FOUR ACTUAL MESSAGES through
// this same path OFFLINE: both the first pair and the complete four-message exchange
// return `minimization_failed` with categories ["address"], before the model, and a
// control that redacts signature addresses and omits the unsafe display name passes every
// pre-model check. No Anthropic request was made in establishing any of that.
//
// TWO INDEPENDENT CAUSES, and each is reproduced here on its own:
//
//   1. SIGNATURE / BODY ADDRESSES. `sanitizeMessageContent` decodes HTML and entities,
//      strips unsafe characters, trims quotes and footers and splits the signature - but
//      never removed an email address. A signature block (the one place this product
//      accepts a company or title from) commonly contains one, so where a model-bound
//      field carried an address the drafted request carried it too, and
//      `assertRequestMinimization`'s structural rule - any bare address anywhere in the
//      payload is a leak - correctly refused the request. An exchange with no address in
//      a model-bound field was unaffected.
//
//   2. AN ADDRESS-VALUED PROVIDER DISPLAY NAME. `counterpartyFromEnvelopes` returned the
//      provider's display name verbatim. Many providers set it to the address itself
//      ("noor@fund.test") or to "Name <addr>", and that value went into the request as
//      `CONTACT display name as recorded by the mail provider: ...` - the same refusal -
//      and, worse, was the fallback `proposedName`, so an address could have been stored
//      as a contact's name.
//
// The guard was right both times. The fix is upstream of it, and the guard is untouched:
// these tests assert it still refuses the pre-fix shapes.
//
// WHAT IS NOT TESTED HERE. No Anthropic request is ever made: the request is built and
// inspected offline. The handler-level cross-round test lives in
// tests/outlook-two-sided-rounds.test.js, which drives the real worker.
//
// Run with: node tests/outlook-address-minimization.test.js

import assert from 'node:assert'
import {
  sanitizeMessageContent, sanitizeSubject, redactEmailAddresses, safeProviderDisplayName,
  EMAIL_REDACTED,
} from '../supabase/functions/shared/outlookContentSanitizer.js'
import {
  buildDraftRequest, assertRequestMinimization,
} from '../supabase/functions/shared/outlookDraftContract.js'

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed += 1 }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed += 1 }
}

const ADDRESS_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i

const ME = 'pilot@outlook.test'
const THEM = 'noor@fund.test'

// A real-shaped inbound message: prose, then a signature block that names a company and a
// role - the evidence this product wants - and also carries an address and a phone number.
const INBOUND_HTML = [
  '<div>Happy to. I am free Thursday afternoon; send a couple of times and I will confirm.</div>',
  '<div>--</div>',
  '<div>Noor Haddad<br>Director, Credit Desk<br>Fund Partners<br>',
  'noor@fund.test<br>+1 555 0100</div>',
].join('')

// The same, with the address entity-encoded. Graph returns HTML; an encoded address must
// be caught AFTER decoding, or it decodes into the request and trips the guard there.
const INBOUND_ENCODED = INBOUND_HTML.replace(
  'noor@fund.test', 'noor&#64;fund&#46;test')

const sanitize = (html) => sanitizeMessageContent({
  bodyContentType: 'html', bodyContent: html,
  uniqueBodyContentType: 'html', uniqueBodyContent: html,
  subject: 'RE: Following up',
})


/** The request the content pass would send for this sanitized message. */
const requestFor = ({ text, signature, displayName }) => buildDraftRequest({
  mode: 'new_contact',
  displayName,
  subject: 'RE: Following up',
  messages: [{ direction: 'inbound', sentAt: '2026-09-21T14:00:00Z', text, signature }],
  // The contract requires an explicit allowlist of dates the model may choose from.
  allowedDates: ['2026-09-21', '2026-09-22'],
})

console.log('\nDEFECT 1 - an address in the body or signature reached the request')

test('REPRODUCED: the pre-fix shape is refused by the guard, with category "address"', () => {
  // The pre-fix sanitizer is modelled exactly: everything it did EXCEPT redaction.
  // (That is the one behaviour this change adds, so leaving it out reproduces the bug.)
  const s = sanitize(INBOUND_HTML)
  assert.strictEqual(s.ok, true)
  const unredacted = {
    text: s.text.replace(EMAIL_REDACTED, 'noor@fund.test'),
    signature: (s.signature ?? '').replace(EMAIL_REDACTED, 'noor@fund.test'),
    displayName: 'Noor Haddad',
  }
  assert.ok(ADDRESS_RE.test(unredacted.signature + unredacted.text),
    'the reproduction must actually contain an address')
  const verdict = assertRequestMinimization(requestFor(unredacted), { addresses: [THEM, ME] })
  assert.strictEqual(verdict.ok, false)
  assert.deepStrictEqual(verdict.found, ['address'],
    'the same refusal the offline reproduction over the four actual messages produced')
})

test('FIXED: the sanitized message carries no address, and the request passes', () => {
  const s = sanitize(INBOUND_HTML)
  assert.strictEqual(s.ok, true)
  assert.ok(!ADDRESS_RE.test(s.text), 'no address survives in the text')
  assert.ok(!ADDRESS_RE.test(s.signature ?? ''), 'none in the signature either')
  const verdict = assertRequestMinimization(
    requestFor({ text: s.text, signature: s.signature, displayName: 'Noor Haddad' }),
    { addresses: [THEM, ME] })
  assert.deepStrictEqual(verdict, { ok: true })
})

test('the signature still carries the name, company and role evidence', () => {
  const s = sanitize(INBOUND_HTML)
  const sig = s.signature ?? ''
  assert.ok(sig.includes('Noor Haddad'), 'the name survives')
  assert.ok(sig.includes('Director, Credit Desk'), 'the role survives')
  assert.ok(sig.includes('Fund Partners'), 'the company survives')
  assert.ok(sig.includes('+1 555 0100'), 'other contact detail is not collateral damage')
  assert.ok(sig.includes(EMAIL_REDACTED), 'and the address is marked as removed, not silently dropped')
})

test('an ENTITY-ENCODED address is redacted too, because decoding happens first', () => {
  const s = sanitize(INBOUND_ENCODED)
  assert.strictEqual(s.ok, true)
  const all = s.text + ' ' + (s.signature ?? '')
  assert.ok(!ADDRESS_RE.test(all), 'the decoded address must not survive')
  assert.ok(!all.includes('&#64;'), 'and the encoded form is gone as well')
  assert.ok(all.includes(EMAIL_REDACTED))
})

test('a mailto: link leaves no address behind', () => {
  const s = sanitize('<p>Reach me at <a href="mailto:noor@fund.test">noor@fund.test</a>.</p>'
    + '<p>Thursday afternoon suits me well, so send two or three times across.</p>')
  assert.strictEqual(s.ok, true)
  const all = s.text + ' ' + (s.signature ?? '')
  assert.ok(!ADDRESS_RE.test(all), all)
})

test('a subject line carrying an address is redacted as well', () => {
  const subj = sanitizeSubject('FW: intro to noor@fund.test about Thursday')
  assert.ok(!ADDRESS_RE.test(subj), subj)
  assert.ok(subj.includes('intro to') && subj.includes('about Thursday'),
    'the rest of the subject is preserved')
})

test('REPRODUCED: `mailto:` was stripped from ordinary prose, and no longer is', () => {
  // The first version removed every `mailto:` before matching addresses, so a sentence
  // ABOUT the scheme lost the word it was about. The prefix now only travels with an
  // address that is actually being redacted.
  assert.strictEqual(
    redactEmailAddresses('The mailto: protocol opens an email app.'),
    'The mailto: protocol opens an email app.')
  assert.strictEqual(redactEmailAddresses('See RFC 6068 for mailto: syntax.'),
    'See RFC 6068 for mailto: syntax.')
  // Attached to an address, the whole thing goes - no dangling scheme left behind.
  assert.strictEqual(redactEmailAddresses('write to mailto:noor@fund.test now'),
    'write to ' + EMAIL_REDACTED + ' now')
  assert.strictEqual(redactEmailAddresses('mailto:noor&#64;fund.test'), EMAIL_REDACTED)
  assert.ok(!redactEmailAddresses('mailto:noor@fund.test').includes('mailto'))
})

test('REPRODUCED: an UPPERCASE or mixed-case attached scheme survived as a word', () => {
  // The plain pattern was case-sensitive while the encoded one was not, so `MAILTO:` and
  // `MailTo:` were left behind with only the address replaced.
  for (const s of ['write to MAILTO:noor@fund.test now', 'write to MailTo:noor@fund.test now',
    'write to mailto:noor@fund.test now', 'write to Mailto:noor&#64;fund.test now']) {
    const out = redactEmailAddresses(s)
    assert.strictEqual(out, 'write to ' + EMAIL_REDACTED + ' now', s)
    assert.ok(!/mailto/i.test(out), 'no scheme fragment may survive: ' + out)
  }
})

test('REPRODUCED: an address-only display name returned the SCHEME as the name', () => {
  // safeProviderDisplayName strips the placeholder, so `MAILTO:address` used to leave
  // "MAILTO" - two letters, so it passed the name check and was offered as the person.
  for (const n of ['MAILTO:noor@fund.test', 'MailTo:noor@fund.test', 'mailto:noor@fund.test',
    'MAILTO:noor&#64;fund.test', '<MAILTO:noor@fund.test>']) {
    const out = safeProviderDisplayName(n)
    assert.strictEqual(out, null, n + ' -> ' + JSON.stringify(out))
  }
  // And a real name in front of an uppercase scheme still survives, intact.
  assert.strictEqual(safeProviderDisplayName('Noor Haddad <MAILTO:noor@fund.test>'), 'Noor Haddad')
})

test('prose about the scheme is unchanged in any case', () => {
  for (const s of ['The mailto: protocol opens an email app.',
    'The MAILTO: protocol opens an email app.',
    'MailTo: is the scheme name, and Mailto: is how some docs write it.',
    'See RFC 6068 for MAILTO: syntax.']) {
    assert.strictEqual(redactEmailAddresses(s), s, s)
  }
  // A display name is not a sentence, but the same rule holds: no address, no rewrite.
  assert.strictEqual(safeProviderDisplayName('Mailto Working Group'), 'Mailto Working Group')
})

test('redaction is surgical: ordinary text and @-handles are untouched', () => {
  assert.strictEqual(redactEmailAddresses('Thursday at three works.'), 'Thursday at three works.')
  // Not an address: no dotted TLD. Left alone rather than mangled.
  assert.strictEqual(redactEmailAddresses('ask @noor on the desk'), 'ask @noor on the desk')
  assert.strictEqual(redactEmailAddresses(''), '')
  assert.strictEqual(redactEmailAddresses(null), null)
})

console.log('\nDEFECT 2 - an address-valued provider display name')

test('REPRODUCED: an address as the display name is refused by the guard', () => {
  const req = requestFor({ text: 'Thursday afternoon works.', signature: null, displayName: THEM })
  const verdict = assertRequestMinimization(req, { addresses: [THEM, ME] })
  assert.strictEqual(verdict.ok, false)
  assert.deepStrictEqual(verdict.found, ['address'])
})

test('an entity-encoded address in a display name does not survive either', () => {
  assert.strictEqual(safeProviderDisplayName('noor&#64;fund&#46;test'), null)
  assert.strictEqual(safeProviderDisplayName('Noor Haddad &lt;noor&#64;fund.test&gt;'), 'Noor Haddad')
})

console.log('\nthe guards themselves are intact')

test('assertRequestMinimization still refuses a bare address anywhere', () => {
  const r = assertRequestMinimization({ system: 'x', messages: [{ role: 'user', content: 'noor@fund.test' }] })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.found, ['address'])
})

test('and still refuses a forbidden address even without the structural match', () => {
  // A declared address that is not email-shaped is still caught by the explicit scan.
  const r = assertRequestMinimization(
    { system: 'x', messages: [{ role: 'user', content: 'ref noor_at_fund' }] },
    { addresses: ['noor_at_fund'] })
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.found, ['address'])
})

test('and still refuses tokens and provider ids', () => {
  assert.deepStrictEqual(
    assertRequestMinimization({ a: 'Bearer abc' }).found, ['token'])
  assert.deepStrictEqual(
    assertRequestMinimization({ a: 'AAkALgAAid' }, { providerIds: ['AAkALgAAid'] }).found,
    ['provider_id'])
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
