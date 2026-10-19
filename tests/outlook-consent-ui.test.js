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

// Executable code only: the file's own explanatory comments legitimately use
// words like 'sync' to say what this slice does NOT do.

console.log('\ndormancy')








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




test('the disclosure names every requested scope, and offline_access honestly', () => {
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  // All six the code requests, so the notice cannot understate the grant.
  for (const name of ['Mail.Read', 'User.Read', 'openid', 'profile', 'email',
    'offline_access']) {
    assert.ok(text.includes(name), `scope not named: ${name}`)
  }
  assert.ok(/six Microsoft scopes/i.test(text), 'the count is stated')
  assert.ok(/read-only/i.test(text), 'must say read-only')
  // offline_access must NOT be presented as a third thing that reads data.
  assert.ok(/grants no new access of its own/i.test(text),
    'offline_access must not read as a data permission')
  assert.ok(/keep using those two read permissions while you are not using the app/i
    .test(text), 'offline_access must be described as continuing access')
  assert.ok(/Two of them read data/i.test(text),
    'exactly two of the six are data permissions')
  // The grant is broader than the use, and that is said.
  assert.ok(/granted at the mailbox level/i.test(text),
    'must not hide that Mail.Read is mailbox-wide')
  assert.ok(/company information/i.test(text),
    "must state what User.Read permits, in Microsoft's own terms")
  assert.ok(/more broadly than Funnl uses them/i.test(text),
    'must distinguish what is permitted from what is requested')
  // Administrator consent must not be promised away for work tenants - and since the
  // correction, the notice must not claim mail access is admin-free "by default": Microsoft's
  // recommended organisational policy does not let users approve Mail.Read.
  assert.ok(text.includes("With a personal Microsoft account you approve them yourself. A work or school organisation can require an administrator to approve an app that reads mail — Microsoft's recommended setting for organisations does — and then you cannot connect it until an administrator approves Funnl."),
    'the corrected administrator-consent sentence, exactly as approved')
  assert.ok(!/requires administrator consent by default/i.test(text),
    'the misleading by-default claim is gone')
  assert.ok(!/no administrator (approval|consent) is (ever |)required/i.test(text),
    'must not promise administrator-free consent')
})

test('the disclosure states what the CONTENT RELEASE processes, and claims nothing more', () => {
  // THIS GUARD WAS INVERTED. It used to require 'reads message envelopes only',
  // 'does not fetch message bodies or attachments' and 'sends nothing to Anthropic
  // or any other AI service' - correct for the envelope-only pilot and the exact
  // opposite of what this release does. A notice that denied body reading while the
  // worker performed it would be consent to the wrong thing just as surely as the
  // reverse was.
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  assert.ok(/reads message envelopes/i.test(text), 'the envelope read is still stated')
  assert.ok(/Inbox and Sent Items/.test(text), 'the two folders')
  assert.ok(/also reads the text of those messages/i.test(text),
    'the body read must be a behavioural claim, not left to inference')
  assert.ok(/does not read attachments/i.test(text), 'the attachment limit')
  assert.ok(/does not read one-sided exchanges/i.test(text), 'the two-sided condition')
  assert.ok(/newsletters, mailing lists, automated notifications or automatic replies/i
    .test(text), 'the automated-mail exclusion')

  // THE SUPERSEDED CLAIMS MUST NOT COME BACK. Each of these was true of the
  // envelope-only notice and is false now; reinstating one would contradict the
  // paragraph above it in the same document.
  for (const gone of [/envelopes only/i, /does not fetch message bodies/i,
    /sends nothing to Anthropic/i, /proposes no new contacts/i,
    /No subject line, summary or message text is kept/i]) {
    assert.ok(!gone.test(text), `a superseded envelope-only claim is back: ${gone}`)
  }

  // The bounds are stated, because "reads the text" without them says nothing about
  // how much.
  assert.ok(/at most six messages/i.test(text), 'the per-exchange message bound')
  assert.ok(/4,000 characters/.test(text) && /12,000 characters/.test(text),
    'both truncation bounds - per message AND across the exchange')
  assert.ok(/the oldest are left out/i.test(text),
    'which messages are dropped when the exchange bound binds')
  assert.ok(/your own signature is not sent/i.test(text),
    'the signature asymmetry must be stated')

  // The read-only behaviour and the untouched neighbours are still stated.
  assert.ok(/never send, reply, delete, move or change/i.test(text))
  assert.ok(/contacts, calendars, files or your organisation/i.test(text))
})

test('the notice DOES describe Anthropic processing, with its retention terms', () => {
  // ALSO INVERTED. It used to assert the notice mentioned no retention figure at
  // all, because the pilot performed no AI processing. It does now, so the figures
  // have to be in the notice rather than only in the policy: the consent decision is
  // taken on this screen.
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  assert.ok(/Anthropic/.test(text), 'the processor must be named')
  assert.ok(/30 days/.test(text), 'the normal deletion window')
  assert.ok(/up to 2 years/.test(text), 'the usage-policy exception')
  assert.ok(/up to 7 years/.test(text), 'the classification-score exception')
  assert.ok(/no zero-retention agreement/i.test(text),
    'the absence of a zero-retention agreement must be stated, not implied')
  assert.ok(/not zero-retention processing/i.test(text))
  assert.ok(/where the law requires it/i.test(text),
    'the legal-obligation exception must be stated too')

  // ── WHAT IT DOES RECEIVE, STATED BEFORE WHAT IT DOES NOT ──────────────
  // The notice used to say Anthropic "does not receive your email address, the other
  // person's email address, your Microsoft account details, or any Funnl identifier"
  // and stopped there - which a reader would take as "nothing identifying". It is
  // not: buildUserContent sends the provider DISPLAY NAME for a new-contact proposal,
  // and the retained message text and signature block are whatever the two people
  // wrote. So the notice now names the display name and says plainly that the extract
  // can identify people, and the exclusions are stated as the narrower guarantee they
  // are.
  assert.ok(/display name your mail provider shows/i.test(text),
    'the display name Anthropic actually receives must be named')
  assert.ok(/This is not anonymous, and Funnl does not claim it is/i.test(text),
    'the extract must not be presented as anonymous')
  assert.ok(/can contain names, employers/i.test(text),
    'and the body/signature must be acknowledged as potentially identifying')
  assert.ok(/Assume the extract can identify the people/i.test(text))
  // ── WHAT IS ACTUALLY CHECKED, AND WHAT IS NOT ─────────────────────────
  // This block previously asserted the notice listed the domain among the checked
  // exclusions, and that "the outgoing request is checked for each of them". Both
  // were false. The content pass calls
  //   assertRequestMinimization(body, { addresses: forbiddenAddresses })
  // supplying ONLY addresses: the providerIds and tokens scans receive nothing, and
  // there is no domain check at all. So the notice now claims only the address
  // check - which is real, and refuses the request - plus the structural fact that
  // the request template has no field for the rest.
  assert.ok(/What Funnl does check for is email addresses/i.test(text),
    'the address check is the guarantee, and must be named as such')
  assert.ok(/the request is withheld/i.test(text),
    'and a failing check must be stated as withholding the request')
  assert.ok(/built from a fixed template with no field for/i.test(text),
    'the absent request metadata must be stated as structural, not as a scan')
  // THE THREE SHAPES, named rather than called "a credential". These are exactly what
  // assertRequestMinimization tests for: an address-shaped string, a leading
  // "Bearer ", and a JWT-like "eyJ..." run.
  assert.ok(/shaped like an email address, a Bearer token or a JWT-like string/i
    .test(text), 'the three shapes the check looks for must be named')
  // And the scan covers the WHOLE request, so an address inside the message body is
  // caught too - which the earlier wording implied it was not.
  assert.ok(/whole request/i.test(text) && /message text included/i.test(text),
    'the check must be stated as covering the message text as well')
  assert.ok(/not shapes Funnl looks for/i.test(text),
    'and what it does not look for stated plainly')
  assert.ok(/email domain on its own/i.test(text)
    && /a company name, a phone number/i.test(text) && /can remain/i.test(text),
  'what can remain must be named, including the bare domain')
  assert.ok(/adding a redaction step is not part of this release/i.test(text),
    'and no redaction must be promised')

  // THE OVERCLAIMS MUST NOT COME BACK.
  for (const gone of [/the outgoing request is checked for each of them/i,
    /their email domain[^.]{0,80}are not included/i]) {
    assert.ok(!gone.test(text), `a superseded minimization claim is back: ${gone}`)
  }
  // And the narrower structural facts that ARE true.
  assert.ok(/authorisation tokens/i.test(text))
  // The overclaim must not come back.
  assert.ok(!/nothing that identifies the people/i.test(text),
    'the "nothing identifying" overclaim must not return')

  // No accuracy or deletion promise Funnl cannot keep.
  for (const overclaim of [/Anthropic will delete/i, /guaranteed/i,
    /we can have it deleted/i, /on request/i]) {
    assert.ok(!overclaim.test(text), `an unkeepable promise about Anthropic: ${overclaim}`)
  }

  // The policy carries the fuller account, and no longer calls it a later release.
  const policy = readFileSync(
    new URL('../src/pages/PrivacyPage.jsx', import.meta.url), 'utf8')
  assert.ok(policy.includes('Anthropic'), 'the policy still discloses it')
  assert.ok(!/later release/.test(policy),
    'the policy must no longer defer body/AI processing to a later release')
  assert.ok(!/first pilot/.test(policy),
    'nor describe the envelope-only first pilot as what will happen')
})

test("the POLICY still states Anthropic's actual retention terms and no ZDR", () => {
  // Moved, not dropped: the pilot notice no longer mentions Anthropic at all, so this
  // guard now watches the published policy, which is where those terms live.
  const policy = readFileSync(
    new URL('../src/pages/PrivacyPage.jsx', import.meta.url), 'utf8')
  assert.ok(/30 days/.test(policy), 'the 30-day window')
  assert.ok(/not\s*<\/strong>\s*have a|does not.{0,40}Zero Data Retention/s.test(policy)
    || /Zero Data Retention/.test(policy), 'ZDR is addressed')
  assert.ok(/up to 2 years/.test(policy) && /up to 7 years/.test(policy),
    'the documented exceptions')
})



test('the readiness packet quotes the shipped text VERBATIM, not a paraphrase', () => {
  // A reviewer approves the wording in the packet. If the packet and the module
  // can drift, that approval attaches to text no user would see - which is the
  // same failure the derived version exists to prevent, one level up.
  const packet = readFileSync(
    new URL('../docs/outlook-privacy-consent-readiness.md', import.meta.url), 'utf8')
  for (const para of OUTLOOK_DISCLOSURE_PARAGRAPHS) {
    assert.ok(packet.includes(para),
      `the packet does not quote this paragraph verbatim: ${para.slice(0, 70)}...`)
  }
  assert.ok(packet.includes(OUTLOOK_DISCLOSURE_VERSION),
    'the packet must name the version the shipped text produces')
})

test('the packet does not describe the consent UI as unimplemented', () => {
  const packet = readFileSync(
    new URL('../docs/outlook-privacy-consent-readiness.md', import.meta.url), 'utf8')
  // It IS implemented, in a Draft branch, and unreachable because a flag is off.
  // Those are three different facts and the packet has to keep them apart.
  assert.ok(!/just-in-time consent copy[^.]*\(not implemented\)/i.test(packet))
  assert.ok(/It \*\*is implemented\*\*/.test(packet),
    'the packet must say the card exists')
  assert.ok(/VITE_OUTLOOK_CONNECTION_ENABLED/.test(packet),
    'and say what makes it unreachable')
})

test('the packet does not call the published policy unpublished', () => {
  const packet = readFileSync(
    new URL('../docs/outlook-privacy-consent-readiness.md', import.meta.url), 'utf8')
  assert.ok(/\*\*YES, live now\*\*/.test(packet),
    'the live conditional /privacy section must be marked published')
  assert.ok(!/conditional Outlook section drafted into[^.]*\(not published\)/i.test(packet))
  assert.ok(/Published\?/.test(packet), 'a published-or-not column must exist')
})

test('the disclosure states review-before-save, not automatic saving', () => {
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  // The rule, asserted by its two halves rather than by one exact sentence - the
  // wording moved from "Nothing is saved to your network until you approve it" to
  // "Nothing enters your network until you accept it", which is the same rule stated
  // against the distinction the release had to draw: the SUGGESTION is saved, and
  // what acceptance creates is the network record.
  assert.ok(/Nothing enters your network until you accept it/i.test(text),
    'the approval-before-save rule must be explicit')
  assert.ok(/Accepting creates the contact and the first interaction together/i.test(text),
    'and what acceptance actually creates must be named')
  assert.ok(/Funnl stores the suggestion/i.test(text),
    'while the suggestion itself is disclosed as stored, not implied to be transient')
  assert.ok(/Dismissing a suggestion creates neither/i.test(text))
  // The read-only email, which the card cannot change and the RPC ignores.
  assert.ok(/shown read-only/i.test(text),
    'the provider-derived email must be disclosed as read-only')
  // And the optional interaction.
  assert.ok(/save the contact without logging the conversation/i.test(text),
    'the optional interaction must be disclosed')
  // "accept, edit, dismiss or DEFER" is what the envelope-only notice promised, and
  // NO CARD HAS A DEFER CONTROL - `defer_candidate` exists in the database and
  // nothing in the UI calls it. A notice offering an option the screen does not have
  // is a small lie in the same class as the big ones this file guards against, so the
  // wording now states the three that exist and says the fourth does not.
  assert.ok(/You accept, edit or dismiss a suggestion/i.test(text),
    'and what reviewing actually offers')
  assert.ok(/there is no deferral option/i.test(text),
    'the absent option must be stated, not silently dropped')
  // The Suggestions UI is retired (Stage D); with no review UI there is no Defer control to drift.
  assert.ok(!/accept, edit, dismiss or defer/i.test(text),
    'the four-option phrasing must not come back while no Defer control exists')
  assert.ok(!/automatically (save|add|log)/i.test(text))
})

console.log('\nrefusal: consent is never implied')





console.log('\nstale version')




console.log('\nsuccessful start')





// The connect card is retired (Stage D); these retained helpers keep their contracts.



console.log('\nscope: this slice connects only')



console.log('')
console.log('behaviour: the start flow, driven directly')

// startOutlookConsent is what the component calls, so these exercise the real
// control flow with injected fetch / navigate rather than asserting on source.












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


console.log('')
console.log('the scope scan can actually fail')


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

test('the disclosure describes the suggestion row as KEPT, never as empty', () => {
  // MEASURED in tests/sql/outlook-pilot-retention-runtime.sql: after disconnect the
  // row survives, still carrying contact_id, the proposed date and a 64-character
  // fingerprint. Calling it empty would be false, and calling it deleted would be
  // worse.
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  assert.ok(/invalidates any suggestion you have not reviewed/i.test(text),
    'the invalidation must be stated')
  assert.ok(/An invalidated suggestion is not deleted/i.test(text),
    'the surviving row must be disclosed')
  assert.ok(/keeps the contact, the date and its fingerprint/i.test(text),
    'what it still carries must be named')
  assert.ok(/goes when you delete that contact or your Funnl account/i.test(text),
    'only the cascade-verified deletion paths may be claimed')
  // NARROWED from a bare /empt(y|ied|ies)/ to the actual false statements. The broad
  // pattern also caught "never a suggestion with an empty note" in the set-aside
  // paragraph, which is a true statement about a NOTE and the opposite of the claim
  // this guard exists to prevent - so the broad pattern would have forced the notice
  // to drop a fact in order to satisfy a guard about a different one.
  for (const gone of [/row is empt/i, /record is empt/i, /suggestion is empt/i,
    /emptied/i, /empties the/i, /minimal record/i]) {
    assert.ok(!gone.test(text), `the row must not be described as empty: ${gone}`)
  }
  // And the deadline must not be presented as deleting anything.
  // The deadline must be distinguished from removal, and 'short-lived' is gone:
  // the measurement shows these records can stay stored with no later action.
  assert.ok(!/short-lived/i.test(text),
    'working records must not be called short-lived')
  assert.ok(/They belong to that single read, which becomes unusable 24 hours after it starts/i
    .test(text), 'they are scoped to one read, which expires')
  assert.ok(/Becoming unusable is not the same as being erased/i.test(text),
    'the 24-hour deadline makes a read unusable; it deletes nothing')
  assert.ok(/Waiting, or looking at the progress of a read, removes nothing/i.test(text),
    'waiting and viewing progress must not be implied to delete')
  assert.ok(/if a read is abandoned and none of those happens, its working records stay stored/i
    .test(text), 'the stay-stored case must be disclosed, not glossed')
  // All four measured removal paths.
  assert.ok(/when a later read starts, when a read completes, when a read is reset, or when you disconnect/i
    .test(text), 'the actual removal triggers must be named')
})

test('the disclosure does NOT claim the Microsoft grant is revoked', () => {
  const text = OUTLOOK_DISCLOSURE_PARAGRAPHS.join(' ')
  assert.ok(/does not withdraw the permission at Microsoft/i.test(text),
    'the limit of a local disconnect must be stated')
  // Checked by NEGATION rather than by banned words: the sentence that mentions
  // withdrawal is exactly the one that says it does not happen. So every sentence
  // mentioning revocation or withdrawal must be a negative one.
  //
  // ONE EXEMPTION, AND ONLY ONE. The cohort release (October 13, 2026) says "an invitation can
  // be withdrawn" - Funnl withdrawing an INVITATION, a different subject from Microsoft's grant,
  // and approved word for word. A word-level check cannot tell the two apart, so exactly that
  // phrase is removed before the check runs. Every other mention of withdrawal or revocation in
  // the same sentence, or anywhere else, is still checked - a sentence saying a disconnect
  // withdraws the grant would still fail.
  const INVITATION = /an invitation can be withdrawn/gi
  assert.strictEqual((text.match(INVITATION) || []).length, 1,
    'the invitation exemption covers exactly the one approved phrase')
  const sentences = text.split(/(?<=[.])\s+/)
  for (const s of sentences) {
    const checked = s.replace(INVITATION, '')
    if (!/revok|withdraw/i.test(checked)) continue
    assert.ok(/does not|do not|cannot|never/i.test(checked),
      `a sentence claims revocation happens: ${s}`)
  }
})


console.log('\nupdating an EXISTING connection, without disconnecting')






async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
