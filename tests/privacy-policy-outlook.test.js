// Outlook privacy-policy and consent-readiness invariants.
//
// These tests pin material public wording to the MERGED source, the APPLIED schema and the
// official provider retention contract. They exist so nobody can quietly weaken or delete a
// disclosure while the corresponding implementation is still in the tree.
//
// The policy section is currently CONDITIONAL because the integration does not exist. When it
// ships, the publication commit must update both the policy and this file deliberately.
//
// Run with: node tests/privacy-policy-outlook.test.js
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

const POLICY = read('src/pages/PrivacyPage.jsx')
const PACKET = read('docs/outlook-privacy-consent-readiness.md')
const MIGRATION = read('supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql')
// The SUMMARY bound moved to 2,000 in a forward migration. The 2026-09-21 file above still
// reads 200 and is the superseded bound, so the disclosed length is pinned against the file
// that actually establishes what the database enforces - WHEN that file is present.
//
// It can legitimately be absent. The policy change publishes to main before the feature
// branch merges, so between those two steps main carries the 2,000 wording without the
// migration file. That is deliberate and it is still truthful, because the disclosed value is
// a CEILING: while the database still enforces 200, every stored summary is at most 200,
// which is also at most 2,000. Present or absent, the page assertions below are unconditional;
// only the migration cross-check waits for the file, and it is strict the moment it arrives.
// The scopes the code actually requests, so the policy's count cannot drift from it.

// The Outlook section only (so assertions cannot accidentally pass on Gmail wording).
const START = POLICY.indexOf('<Section title="Outlook connection (invited accounts only)">')
const END = POLICY.indexOf('<Section title="Analytics: behavior, not content">')
const OUTLOOK = START !== -1 && END !== -1 ? POLICY.slice(START, END) : ''
// The just-in-time notice AS RENDERED - the paragraphs array, not its source file, where each
// paragraph is split across concatenated string literals and a phrase never appears whole.
// The cohort release moved the statement of WHERE the restriction is enforced into the notice,
// so the restriction test reads both documents.

// --------------------------------------------------------------------------
// RETENTION DURATIONS: an allowlist, not a denylist.
//
// This section may state a retention duration only where Anthropic's own published contract
// is being disclosed. A denylist of phrasings was tried first and was worthless: 9 of 10
// obvious rewordings walked straight through it (erases ... after 30 days, kept for no more
// than 30 days, retained for thirty days, passive voice, or no Funnl subject at all).
//
// So instead: pin each approved disclosure to its exact present wording, mask those out, and
// require that NO duration expression survives anywhere else in the visible prose. A future
// Funnl retention schedule must therefore be added to APPROVED_RETENTION_DISCLOSURES on
// purpose - and only once it is implemented and owner/legal have approved saying so. A new
// duration appearing here without that is meant to fail.

// Reader-visible prose only: JSX tags removed, {' '} joins collapsed, whitespace normalized.
const OUTLOOK_PROSE = OUTLOOK
  .replace(/<[^>]+>/g, ' ')
  .split("{' '}").join(' ')
  .replace(/\s+/g, ' ')
  .trim()

const APPROVED_RETENTION_DISCLOSURES = [
  { why: 'Anthropic standard retention, headline clause',
    text: "Anthropic's retention — 30 days, and not Zero Data Retention —" },
  { why: 'Anthropic deletes API inputs and outputs within 30 days',
    text: 'Anthropic automatically deletes API inputs and outputs from its systems within 30 days' },
  { why: 'Anthropic flagged-content exception, up to 2 years',
    text: 'Anthropic may retain the inputs and outputs for up to 2 years' },
  { why: 'Anthropic trust-and-safety classification scores, up to 7 years',
    text: 'the related trust-and-safety classification scores for up to 7 years' },
  { why: 'the same Anthropic window restated where ad hoc deletion is ruled out',
    text: 'that 30-day window, and the exceptions above, are what apply' },
  { why: "Anthropic's window is explicitly not a Funnl schedule",
    text: "Anthropic's 30 days is not a Funnl deletion schedule" },
]

/**
 * Approved FUNNL durations - a SEPARATE list, because the invariant differs.
 *
 * Every entry in APPROVED_RETENTION_DISCLOSURES is attributed to Anthropic, and the
 * test above checks that attribution: a duration drifting onto Funnl is the precise
 * failure that list exists to catch. This one is a Funnl duration on purpose, so it
 * cannot live there - putting it there would have meant relaxing the attribution
 * check for all six, and the suite said so.
 *
 * The content release introduces exactly one: a suggestion has a 30-day review
 * window, after which it CANNOT BE ACCEPTED. That is enforced rather than
 * aspirational - both accept RPCs refuse an expired suggestion, proven against real
 * Postgres in tests/sql/outlook-accept-expiry-runtime.sql.
 *
 * It is emphatically NOT a deletion promise, and is admitted here only because the
 * policy also states what it does not mean. Those statements are asserted
 * separately, so removing any of them while keeping this duration fails the suite.
 */
const APPROVED_FUNNL_DURATIONS = [
  { why: 'the review window, which is a refusal and not a deletion',
    text: 'A pending suggestion carries a 30-day review window' },
]

// A retention duration is a QUANTITY, optionally restated in digits, optionally qualified,
// then a UNIT. Kept as small named pieces so the invariant can be audited by eye, and written
// generically so it catches the class rather than a list of phrasings. Earlier versions missed
// 'within a month', '30 calendar days', 'thirty (30) days', 'sixteen days', '45 consecutive
// days' and 'one quarter'.
const DURATION_DIGITS = '[0-9]+(?:\\.[0-9]+)?'                         // 30, 1.5
const DURATION_ONES = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|'
  + 'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)'
const DURATION_TENS = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)'
// thirty, forty-five, forty five, seven
const DURATION_WORD = '(?:' + DURATION_TENS + '(?:[- ]' + DURATION_ONES + ')?|' + DURATION_ONES + ')'
const DURATION_ARTICLE = '(?:an?)'                                        // a month, an extra week
const DURATION_QUANTITY = '(?:' + DURATION_DIGITS + '|' + DURATION_WORD + '|' + DURATION_ARTICLE + ')'
const DURATION_RESTATED = '(?:[- ]*\\(\\s*' + DURATION_DIGITS + '\\s*\\))?'   // thirty (30)
const DURATION_QUALIFIER = '(?:[- ]*(?:calendar|business|consecutive|working|full|additional)\\b)*'
const DURATION_UNIT = '(?:day|week|month|quarter|year)s?'
const durationRe = (flags) => new RegExp('\\b' + DURATION_QUANTITY + DURATION_RESTATED
  + DURATION_QUALIFIER + '[- ]*' + DURATION_UNIT + '\\b', flags)

// The Outlook prose with every approved disclosure removed. Anything left that looks like a
// retention duration is an unapproved claim.
function unapprovedDurations () {
  let rest = OUTLOOK_PROSE
  for (const { text } of APPROVED_RETENTION_DISCLOSURES) rest = rest.split(text).join(' [APPROVED] ')
  for (const { text } of APPROVED_FUNNL_DURATIONS) rest = rest.split(text).join(' [APPROVED] ')
  return (rest.match(durationRe('ig')) || []).map((hit) => {
    const at = rest.indexOf(hit)
    return `${hit} -> ...${rest.slice(Math.max(0, at - 90), at + hit.length + 40)}...`
  })
}

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

// ── Framing: unavailable and conditional ─────────────────────────────────────
console.log('\nconditional framing')




// ── Permission scope ─────────────────────────────────────────────────────────
console.log('\npermission scope')

// ── Storage ──────────────────────────────────────────────────────────────────
console.log('\nstorage and retention')





// ── Anthropic ────────────────────────────────────────────────────────────────
console.log('\nAnthropic disclosures')







test('no Funnl-side context-erasure schedule is promised while none is scheduled', () => {
  // The expiry RPC exists but nothing runs it: no pg_cron, no cron schema, no scheduling migration.
  assert.ok(MIGRATION.includes('expire_pending_outlook_context'), 'the RPC exists')
  assert.ok(!/cron\.schedule/.test(MIGRATION), 'nothing schedules it in the migration')
  assert.ok(/currently unenforced|unscheduled|does not currently erase|Nothing currently erases/i.test(PACKET),
    'the readiness packet records the gap for the owner')
})

// ── Suggestion behavior ──────────────────────────────────────────────────────
console.log('\nsuggestion behavior')




// ── Tokens and human access ──────────────────────────────────────────────────
console.log('\ntokens and human access')



// ── Date guard and non-regression ────────────────────────────────────────────
console.log('\npublication date guard')






// ── Readiness packet ─────────────────────────────────────────────────────────
console.log('\nreadiness packet')

test('the packet records consent mechanics, decisions and blockers', () => {
  // The placeholder `outlook-content-v1` is gone: Draft PR #56 derives the
  // version from the disclosure text, so the packet records the MECHANISM and
  // the current draft value rather than a standalone placeholder string.
  assert.ok(/ol-disc-/.test(PACKET), 'derived consent version recorded')
  assert.ok(/derived, not declared/i.test(PACKET)
    && /computed from the text above/.test(PACKET),
  'the derivation mechanism is recorded')
  // And the packet quotes the SHIPPED strings, so an approval attaches to what a
  // user would actually see. Asserted in full by outlook-consent-ui.test.js.
  assert.ok(/quoted from `src\/lib\/outlookDisclosure\.js` verbatim/.test(PACKET),
    'the packet must say the paragraphs are the shipped ones')
  // CORRECTED. This asserted the packet says "`OUTLOOK_DISCLOSURE_VERSION` is unset",
  // which is the false claim itself: that variable WAS configured in Production for
  // the envelope-only disclosure - the pilot connected under it and completed a real
  // import, which outlook-oauth-start would have refused otherwise. What the packet
  // must now do is keep three values apart and not assert the one it has not read.
  assert.ok(/CURRENT STATE/.test(PACKET),
    'the packet needs an accurate current-state summary above the historical parts')
  assert.ok(/HISTORICAL/.test(PACKET),
    'and the older inventories must be marked as historical')
  assert.ok(/[Ww]as configured in Production/.test(PACKET),
    'the previously configured server version must be acknowledged')
  assert.ok(/has not been read from this branch/.test(PACKET),
    'and its CURRENT value must not be asserted without a read')
  assert.ok(/[Bb]oth `null`/.test(PACKET),
    'the two worker consent constants must be stated as the gate that is closed')
  // The one claim that must NOT appear, because it is the one that was wrong.
  assert.ok(!/OUTLOOK_DISCLOSURE_VERSION` is unset in (any|every) environment/
    .test(PACKET), 'the packet must not claim the server version is unset everywhere')
  assert.ok(/DRAFT FOR OWNER\/LEGAL REVIEW/.test(PACKET))
  assert.ok(/finalize_microsoft_connection/.test(PACKET), 'consent mechanics cited to the RPC')
  for (const item of ['HMAC key', 'OAuth start and callback',
    'Review UI', 'Pilot authorization', 'Scheduling']) {
    assert.ok(new RegExp(item, 'i').test(PACKET), `blocker listed: ${item}`)
  }
  // Entra registration is no longer a blocker - an app IS registered - but the item must
  // stay listed and marked done rather than quietly disappearing, so the packet still
  // accounts for it.
  assert.ok(/Entra app registration/i.test(PACKET), 'blocker listed: Entra registration')
  assert.ok(/~~Entra app registration\.~~ \*\*Done\*\*/.test(PACKET),
    'registration must be recorded as done, not merely dropped')
  // Twelve recorded owner/legal decisions. Item 11 (the publication date) is now decided,
  // so count every box and require the rest to still be open.
  const allBoxes = (PACKET.match(/- \[( |x)\]/g) || []).length
  const openBoxes = (PACKET.match(/- \[ \]/g) || []).length
  assert.ok(allBoxes >= 12, `at least 12 owner/legal decisions, found ${allBoxes}`)
  assert.ok(openBoxes >= 10, `most decisions must still be open, found ${openBoxes}`)
  assert.ok(/- \[x\] 11\./.test(PACKET), 'the publication-date decision is recorded as made')
  assert.ok(/September 27, 2026/.test(PACKET), 'the packet names the approved date')
})

test('the packet separates what IS published from what is not', () => {
  // The packet used to open with "Nothing in this packet is published, deployed or
  // configured", which was false: the conditional Outlook section of the Privacy
  // Policy is live. Asserting that sentence pinned a wrong claim in place, so the
  // requirement is now the true one - the packet must tell the four artefacts
  // apart rather than flatten them.
  assert.ok(/WHAT IS PUBLISHED AND WHAT IS NOT/.test(PACKET),
    'the packet must draw the distinction explicitly')
  assert.ok(/\*\*YES, live now\*\*/.test(PACKET),
    'the live conditional policy section must be marked published')
  assert.ok(!/Nothing in this packet is published/.test(PACKET),
    'that blanket claim is false while the policy section is live')
})

test('the packet does not claim the INTEGRATION is live', () => {
  // Published policy text is not a live integration. These are the facts that
  // must stay stated whatever else changes.
  assert.ok(/zero rows/.test(PACKET))
  assert.ok(/never been deployed|never deployed/i.test(PACKET))
  // An Entra app IS now registered, so the old `no Entra application exists` pin is
  // false and has been replaced. What must stay stated is the DISTINCTION: registration
  // is not credentials, not consent, not deployment, and not a completed round trip.
  assert.ok(!/no Entra application exists/i.test(PACKET),
    'the packet must not repeat the superseded claim that no Entra app exists')
  assert.ok(/registration is not the same as credentials/i.test(PACKET),
    'the packet must distinguish registration from credentials and consent')
  assert.ok(/no client secret/i.test(PACKET), 'no client secret is configured')
  assert.ok(/round trip has (ever )?(happened|completed)/i.test(PACKET),
    'the packet must state that no Microsoft round trip has completed')
  // And the registered values are recorded, so a later reader cannot confuse this app
  // with the superseded personal-account registration.
  assert.ok(/af27b250-da0b-443e-bcac-38a67737d640/.test(PACKET),
    'the packet records which application is registered')
  assert.ok(/superseded/i.test(PACKET),
    'the packet records that the earlier personal-account registration is superseded')
  assert.ok(/no consent has ever been collected/i.test(PACKET))
  assert.ok(/both build flags are unset/i.test(PACKET) || /flags are off/i.test(PACKET))
  assert.ok(/unapplied/i.test(PACKET), 'the forward migrations must be marked unapplied')
  for (const overclaim of [/Outlook is (now )?(live|available|enabled)/i,
    /the integration (is|has) (live|shipped|launched)/i]) {
    assert.ok(!overclaim.test(PACKET), `the packet claims the integration is live: ${overclaim}`)
  }
})


// --------------------------------------------------------------------------
console.log('\nretention-duration allowlist')



test('no unapproved retention duration survives anywhere in the Outlook section', () => {
  assert.deepStrictEqual(unapprovedDurations(), [], 'unapproved retention duration present')
  // The detector must recognize the forms a policy could use, including every one that
  // defeated the previous denylist. Checked against the live pattern, not a copy of it.
  const mustDetect = [
    'Funnl erases your Outlook draft context after 30 days and nothing is kept longer.',
    'Funnl deletes Outlook context after 30 days.',
    'Outlook context is deleted after 30 days.',
    'We remove Outlook drafts within 30 days.',
    'Funnl purges this information at 30 days.',
    'Funnl keeps Outlook context for no more than 30 days.',
    'Outlook context is retained for thirty days.',
    'Local draft context is kept for one month.',
    'We delete this information after four weeks.',
    'Funnl removes Outlook context within 90 days.',
    'deleted after 14 days', 'kept 45 days', 'within 60 days', 'after 90 days',
    'for four weeks', 'for one month', 'for three months', 'for one year',
    'a thirty-day window', 'a 30-day window', 'a thirty day window',
    // variants that defeated the first generation of this detector
    'Funnl deletes Outlook context within a month.',
    'Funnl deletes Outlook context after a calendar month.',
    'Funnl deletes Outlook context after 30 calendar days.',
    'Funnl removes Outlook context within one business month.',
    'Funnl deletes Outlook context after thirty (30) days.',
    'Funnl removes Outlook context after sixteen days.',
    'Funnl removes Outlook context after twenty-one days.',
    'Funnl removes Outlook context after 45 consecutive days.',
    'Funnl retains Outlook context for one quarter.',
    'Funnl retains Outlook context for 1.5 years.',
    // and the rest of the grammar, so a later simplification cannot quietly narrow it
    'forty five days', 'seventeen weeks', 'an additional month', 'two quarters',
    'ninety (90) days', '0.5 years', 'nineteen days', 'fifty days', 'seventy-two days',
    'thirteen days', 'eighteen months', 'an working day', 'a full year',
  ]
  for (const s of mustDetect) assert.ok(durationRe('i').test(s), `must recognize: ${s}`)
  // And it must not fire on the section's non-retention numbers.
  const mustNotDetect = [
    'at most 2,000 characters', 'at most 160 characters', 'exactly five', 'the two parties',
    'a summary of at most 2,000 characters', 'five headers', 'two parties are labelled',
    // the comma in 2,000 is the new shape, so it is covered explicitly
    'a summary of at most 2,000 characters, an optional suggested next step',
    'the sender, the recipients', 'Inbox and Sent Items only', 'a confidence level',
  ]
  for (const s of mustNotDetect) {
    assert.ok(!durationRe('i').test(s), `must not fire on: ${s}`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
