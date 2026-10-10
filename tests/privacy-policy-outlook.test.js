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
import { readFileSync, existsSync } from 'fs'
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
const NOTES_MIGRATION_PATH = 'supabase/migrations/20261010180000_detailed_ai_interaction_notes.sql'
const NOTES_MIGRATION = existsSync(join(root, NOTES_MIGRATION_PATH)) ? read(NOTES_MIGRATION_PATH) : null
const TRANSPORT = read('supabase/functions/shared/outlookGraphTransport.js')
const NORMALIZE = read('supabase/functions/shared/outlookMessageNormalize.js')
const DRAFT = read('supabase/functions/shared/outlookDraftContract.js')
// The scopes the code actually requests, so the policy's count cannot drift from it.
const OUTLOOK_OAUTH_SCOPES = JSON.parse(
  '[' + /OUTLOOK_OAUTH_SCOPES = Object\.freeze\(\[([\s\S]*?)\]\)/
    .exec(read('supabase/functions/shared/microsoftOauthHelpers.js'))[1]
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => '"' + s.replace(/^'|'$/g, '') + '"').join(',') + ']')

// The Outlook section only (so assertions cannot accidentally pass on Gmail wording).
const START = POLICY.indexOf('<Section title="Outlook connection (not yet available)">')
const END = POLICY.indexOf('<Section title="Analytics: behavior, not content">')
const OUTLOOK = START !== -1 && END !== -1 ? POLICY.slice(START, END) : ''

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

test('an Outlook section exists and is isolated from the Gmail section', () => {
  assert.ok(START !== -1, 'Outlook section present')
  assert.ok(END > START, 'Analytics section follows it')
  assert.ok(OUTLOOK.length > 2000, 'section has substance')
  assert.ok(!OUTLOOK.includes('Gmail connection (optional)'), 'does not swallow the Gmail section')
})

test('the section describes the RESTRICTION, not non-existence', () => {
  // It must read correctly BEFORE and DURING the restricted pilot, without being
  // republished in between. So it says who can connect (one designated account) rather
  // than asserting whether the pilot is running - an assertion that would go stale.
  assert.ok(OUTLOOK.includes('Outlook connection (not yet available)'),
    'the title still marks it unavailable to the reader')
  assert.ok(/Outlook is not generally available/.test(OUTLOOK_PROSE),
    'it states availability rather than an absolute about the reader')
  assert.ok(/only a single designated Funnl-controlled test account may start an Outlook connection/
    .test(OUTLOOK_PROSE), 'it names who may start a connection')
  assert.ok(/refuse a connection request from any other account/.test(OUTLOOK_PROSE),
    'and where that is enforced')
  // The start gate restricts NEW connections. It is not evidence that no retained row
  // exists elsewhere, so the page must not claim that.
  assert.ok(!/no Outlook-derived records exist for any other account/.test(OUTLOOK_PROSE),
    'the gate must not be presented as proof of absent historical rows')
  assert.ok(!/You cannot connect Outlook/.test(OUTLOOK_PROSE),
    'the superseded absolute must not return')
  // And it does NOT claim the restriction means nobody has Outlook records.
  assert.ok(/designated account is itself a Funnl account/.test(OUTLOOK_PROSE),
    'it admits the designated account is a Funnl account')
  assert.ok(/Outlook-derived records will exist for it/.test(OUTLOOK_PROSE),
    'it does not claim no Outlook-derived records exist for any account')
  // The conditional framing for the UNBUILT parts is retained.
  const flat = OUTLOOK.replace(/\s+/g, ' ')
  assert.ok(/if, and only if,<\/em> you choose to connect Outlook/i.test(flat),
    'uses the conditional "if, and only if" framing')
  // THE LATER-RELEASE FRAMING IS GONE, deliberately: body reading and the Anthropic
  // call are what this release does, so deferring them to a later one would now be
  // the false statement. What stays conditional is CONNECTING - the integration is
  // still restricted to one designated account and gated by a flag.
  assert.ok(!/later release/.test(OUTLOOK_PROSE),
    'the section must no longer defer body reading or AI to a later release')
  assert.ok(!/first pilot/.test(OUTLOOK_PROSE),
    'nor describe an envelope-only first pilot as what will happen')
  // The superseded absolutes must not come back.
  for (const gone of [/This connection does not exist yet/,
    /Nothing here is in\s+effect today/,
    /holds no\s+Outlook data for anyone/]) {
    assert.ok(!gone.test(OUTLOOK), `superseded claim is back: ${gone}`)
  }
})

test('the section describes the CONTENT RELEASE, with its bounds', () => {
  // REPLACES 'the FIRST PILOT is described as envelope-only'. That guard asserted
  // 'read message envelopes only', 'will not fetch message bodies or attachments'
  // and 'send nothing to Anthropic or any other AI service' - all correct for the
  // envelope-only pilot and all false now. A policy that denied body reading while
  // the worker performed it would be the same failure in the opposite direction.
  assert.ok(/message\s+<strong[^>]*>envelopes<\/strong>/.test(OUTLOOK)
    || /message envelopes/.test(OUTLOOK_PROSE), 'the envelope read is still stated')
  assert.ok(/text of up to six of those messages/.test(OUTLOOK_PROSE),
    'the body read must be stated, with its bound')
  assert.ok(/does not read attachments/.test(OUTLOOK_PROSE))
  assert.ok(/does not read one-sided exchanges/.test(OUTLOOK_PROSE))

  // The superseded absolutes must not come back.
  for (const gone of [/read message envelopes only/,
    /will not fetch message bodies or attachments/,
    /send nothing to Anthropic or any other AI service/,
    /produce no summaries or drafts/]) {
    assert.ok(!gone.test(OUTLOOK_PROSE), `a superseded envelope-only claim is back: ${gone}`)
  }

  // And the bounds, because "reads the text" alone says nothing about how much.
  assert.ok(/4,000 characters/.test(OUTLOOK_PROSE) && /12,000/.test(OUTLOOK_PROSE),
    'both truncation bounds')
  assert.ok(/the oldest are left out/.test(OUTLOOK_PROSE))
  assert.ok(/your own is not sent/.test(OUTLOOK_PROSE), 'the signature asymmetry')

  // The transport still uses the envelope projection for the DELTA request - the
  // content projection is a separate, per-message read, which is what makes the
  // six-message bound meaningful rather than decorative.
  assert.ok(/\$select=\$\{DISCOVERY_SELECT\.join/.test(TRANSPORT),
    'the folder delta request still uses the envelope projection')
  assert.ok(/\$select=\$\{CONTENT_SELECT\.join/.test(TRANSPORT),
    'and the per-message content read is its own bounded request')
})

test('no statement claims the pilot is running, verified or certified', () => {
  for (const bad of [
    /Outlook is (now )?(available|enabled|live)/i,
    /\bOutlook is verified\b/i,
    /\bMicrosoft(-| )certified\b/i,
    /you are connected to Outlook/i,
    // The page must not assert the pilot's RUN STATE in either direction: both
    // readings go stale, one of them silently.
    /the pilot is (now )?(running|live|under way|underway)/i,
    /Funnl is (currently )?testing/i,
    /not in pilot/i,
  ]) {
    assert.ok(!bad.test(OUTLOOK), `must not claim: ${bad}`)
  }
  // Instead: the restriction, and what the first pilot will do WHEN enabled.
  assert.ok(/When this integration is enabled/.test(OUTLOOK_PROSE),
    'the pilot is described conditionally on being enabled')
  // The heading moved from 'What the first pilot will do, when it is enabled' to a
  // description of what Funnl reads, because there is no longer a narrower first
  // pilot to describe separately. The CONDITIONAL framing is what this guard is
  // actually for, and it is asserted above and below.
  assert.ok(/What Funnl reads from your Outlook mailbox/.test(OUTLOOK_PROSE),
    'the read is described under its own heading')
  assert.ok(/if, and only if,/.test(OUTLOOK.replace(/\s+/g, ' ')),
    'and the whole section stays conditional on choosing to connect')
})

// ── Permission scope ─────────────────────────────────────────────────────────
console.log('\npermission scope')

test('all six requested scopes are disclosed, and offline_access is not called a read', () => {
  // The code requests six. Describing 'a single delegated permission' understated the
  // grant; describing offline_access as a third READ permission would overstate it.
  const requested = OUTLOOK_OAUTH_SCOPES
  assert.strictEqual(requested.length, 6, `the code requests ${requested.length} scopes`)
  assert.ok(/six delegated scopes/.test(OUTLOOK_PROSE), 'the count is stated')
  for (const name of ['Mail.Read', 'User.Read', 'openid', 'profile', 'email',
    'offline_access']) {
    assert.ok(OUTLOOK.includes(name), `scope not disclosed: ${name}`)
  }
  // Two read data; three are sign-in; offline_access grants DURATION, not access.
  assert.ok(/Two of them read data, and both are read-only/.test(OUTLOOK_PROSE))
  assert.ok(/not a permission to read anything new/.test(OUTLOOK_PROSE),
    'offline_access must not be presented as a read permission')
  assert.ok(/lets Funnl keep using the two read permissions above while you are not using the app/
    .test(OUTLOOK_PROSE), 'offline_access is described as continuing access')
  // The honest half: the grant is broader than the use.
  assert.ok(/granted at the mailbox level/.test(OUTLOOK_PROSE),
    'discloses that Mail.Read is mailbox-wide')
  assert.ok(/would technically allow reading message bodies and attachments anywhere in your mailbox/
    .test(OUTLOOK_PROSE), 'does not hide the authority the permission grants')
  assert.ok(/never send, reply to, delete, move or change anything in your mailbox/
    .test(OUTLOOK_PROSE), 'read-only is stated as a behaviour')
  // Admin consent: not required by default, but a tenant may demand it anyway.
  assert.ok(/requires administrator consent by default/.test(OUTLOOK_PROSE))
  assert.ok(/work or school tenant may be configured to require an administrator/
    .test(OUTLOOK_PROSE), 'tenant policy caveat present')
  assert.ok(TRANSPORT.includes("GRAPH_MAIL_READ_SCOPE = 'Mail.Read'"), 'matches the code constant')
})

test('every category the code actually requests is disclosed', () => {
  for (const claim of ['Inbox', 'Sent Items', 'sender', 'recipients', 'display names',
    'subject', 'timestamps', 'conversation identifier']) {
    assert.ok(OUTLOOK.includes(claim), `policy must disclose: ${claim}`)
  }
  // Body projections.
  assert.ok(/plain-text body projections|plain-text body/.test(OUTLOOK), 'body text disclosed')
  assert.ok(/unique body|"unique body"/.test(OUTLOOK), 'the quoted-history-excluded body disclosed')
  // And the code really does select them.
  const content = /CONTENT_SELECT = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(TRANSPORT)[1]
  for (const f of ['uniqueBody', 'body', 'internetMessageHeaders', 'from', 'toRecipients',
    'ccRecipients', 'subject', 'conversationId']) {
    assert.ok(content.includes(f), `CONTENT_SELECT really requests ${f}`)
  }
})

test('the five allowlisted headers are named, and match the classifier exactly', () => {
  const HEADERS = ['Auto-Submitted', 'Precedence', 'List-Id', 'List-Unsubscribe', 'X-Auto-Response-Suppress']
  for (const h of HEADERS) assert.ok(OUTLOOK.includes(h), `policy must name ${h}`)
  const looked = new Set([...NORMALIZE.matchAll(/valuesOf\('([a-z-]+)'\)|present\('([a-z-]+)'\)/g)]
    .map((m) => m[1] || m[2]))
  assert.deepStrictEqual([...looked].sort(),
    HEADERS.map((h) => h.toLowerCase()).sort(),
    'the disclosed five are exactly the five the code reads')
})

test('raw headers are described as reduced and discarded', () => {
  assert.ok(/discards the\s*<\/strong>?\s*|discards the/.test(OUTLOOK) || /discard/i.test(OUTLOOK))
  assert.ok(/no header name or value is kept, logged, or sent anywhere/.test(OUTLOOK))
  // Code: only the classified facts leave readMessageContent.
  assert.ok(/automation: automation\.facts/.test(TRANSPORT))
  assert.ok(!/internetMessageHeaders/.test(
    TRANSPORT.slice(TRANSPORT.indexOf('return {\n    ok: true,\n    bodyContentType'))),
    'the header collection is not returned')
})

test('excluded authorities are disclosed and truly absent from the code', () => {
  for (const claim of ['attachment', 'raw MIME', 'Microsoft contacts', 'calendars', 'files', 'shared mailbox']) {
    assert.ok(new RegExp(claim, 'i').test(OUTLOOK), `policy must exclude: ${claim}`)
  }
  assert.ok(/never send, reply to, forward, delete, move, or mark mail/.test(OUTLOOK))
  // Denylist and allowlist are stripped so the scan reads real request-building code.
  const exec = TRANSPORT
    .replace(/^const (FORBIDDEN_PATH_FRAGMENT_RE|ALLOWED_PATH_RE)\s*=[\s\S]*?\/[gimsuy]*\s*$/gm, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  for (const bad of ['$value', '/attachments', '/contacts', '/calendars', '/drive', 'sendMail', '/users/']) {
    assert.ok(!exec.includes(bad), `code must not build ${bad}`)
  }
})

// ── Storage ──────────────────────────────────────────────────────────────────
console.log('\nstorage and retention')

test('raw bodies are stated as not stored, and the schema has no column for them', () => {
  assert.ok(/Raw email bodies would not be stored by Funnl/.test(OUTLOOK))
  assert.ok(/held\s*\n?\s*only in server memory|only in server memory/.test(OUTLOOK))
  const ddl = MIGRATION.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  for (const col of ['body_text', 'raw_body', 'body_content', 'message_body', 'snippet', 'html_body', 'mime']) {
    assert.ok(!ddl.includes(col), `schema must not define ${col}`)
  }
})

test('the disclosed field limits match the applied CHECK constraints', () => {
  // 2,000 on the page, 2,000 in the CHECK that the applied migration installs, in BOTH
  // producer tables. The old 200 must be gone from the disclosed section entirely.
  assert.ok(/at most 2,000 characters/.test(OUTLOOK), 'the page discloses the 2,000-character summary')
  assert.ok(!/at most 200 characters/.test(OUTLOOK), 'the superseded 200 is gone from the section')
  // The follow-up bound did not move, so it stays pinned against the original file.
  if (NOTES_MIGRATION === null) {
    console.log(`      (migration cross-check pending: ${NOTES_MIGRATION_PATH} not on this ref)`)
  } else {
    assert.strictEqual((NOTES_MIGRATION.match(/char_length\(draft_summary\) BETWEEN 1 AND 2000/g) || []).length, 2,
      'both draft_summary CHECKs are re-declared at 2,000')
    assert.ok(NOTES_MIGRATION.includes('char_length(proposed_notes) <= 2000'),
      'and the interaction-candidate note column matches')
    assert.ok(!/BETWEEN 1 AND 200\b/.test(NOTES_MIGRATION),
      'and no superseded 200 bound survives in the forward migration')
  }
  assert.ok(/at most 160 characters/.test(OUTLOOK) && MIGRATION.includes('char_length(draft_follow_up) BETWEEN 1 AND 160'))
  assert.ok(MIGRATION.includes('char_length(retained_subject) <= 160'))
  assert.ok(/length-limited/.test(OUTLOOK))
  assert.ok(MIGRATION.includes('char_length(proposed_name) BETWEEN 1 AND 120'))
})

test('evidence and confidence codes are disclosed as the schema defines them', () => {
  assert.ok(/provider metadata|provider_metadata/.test(OUTLOOK))
  assert.ok(/explicit signature/.test(OUTLOOK))
  assert.ok(/confidence/.test(OUTLOOK))
  assert.ok(MIGRATION.includes("proposed_company_evidence IN ('explicit_signature', 'explicit_body')"))
  assert.ok(MIGRATION.includes("proposed_name_confidence IN ('high', 'medium')"))
})

test('fingerprints are disclosed as one-way and provenance carries no provider identifiers', () => {
  assert.ok(/one-way keyed fingerprints/.test(OUTLOOK))
  assert.ok(/does not store Microsoft message or conversation identifiers, mailbox addresses, or subject lines/.test(OUTLOOK))
  assert.ok(MIGRATION.includes("ocr_episode_fp_shape"), 'refs table pins fingerprint shape')
})

// ── Anthropic ────────────────────────────────────────────────────────────────
console.log('\nAnthropic disclosures')

test('Anthropic is named and the extract is described as minimized and pseudonymized', () => {
  assert.ok(/Anthropic/.test(OUTLOOK), 'Anthropic is named')
  assert.ok(/USER<\/em> and <em>CONTACT/.test(OUTLOOK), 'pseudonymous labels disclosed')
  // THIS PINNED THE WRONG SENTENCE. "Email addresses, the recipient's email domain ...
  // are not included" described an exclusion list that was never checked as a list:
  // the code supplies only addresses to assertRequestMinimization, and there is no
  // domain check at all. Worse, the replacement wording briefly opened the "can
  // remain" paragraph with that same phrase, which read as though an address became
  // exempt once it appeared in message text - it does not, since the scan covers the
  // whole serialized request.
  //
  // So the guard now pins the two halves separately: addresses ARE checked across the
  // whole request, and the bare DOMAIN is named as something that can remain.
  assert.ok(/whole outgoing request, the message text included/.test(OUTLOOK_PROSE),
    'the address check must be stated as covering the message text')
  assert.ok(/An address written in the body of a message is therefore caught/
    .test(OUTLOOK_PROSE), 'and an address in the body must not read as exempt')
  assert.ok(/shaped\s*like an email address, a Bearer token or a JWT-like string/
    .test(OUTLOOK_PROSE.replace(/\s+/g, ' ')), 'the three shapes must be named')
  assert.ok(/email domain on its own/.test(OUTLOOK_PROSE)
    && /can remain/.test(OUTLOOK_PROSE),
  'and the bare domain named as something that can remain')
  // The overclaim must not come back.
  assert.ok(!/checks\s*the outgoing request for each of them/
    .test(OUTLOOK_PROSE.replace(/\s+/g, ' ')),
  'the per-category check overclaim must not return')
  assert.ok(DRAFT.includes('assertRequestMinimization'), 'the code enforces minimization')
})

test('standard 30-day retention and "not Zero Data Retention" are both present', () => {
  assert.ok(/30 days/.test(OUTLOOK), '30-day retention stated')
  assert.ok(/not Zero Data Retention|Zero Data Retention/.test(OUTLOOK))
  assert.ok(/does <strong[^>]*>not<\/strong> have a\s*\n?\s*Zero Data Retention agreement/.test(OUTLOOK),
    'explicitly disclaims ZDR')
  assert.ok(DRAFT.includes('NOT zero data retention'), 'the module says the same')
})

test('the two-year and seven-year safety exceptions are disclosed', () => {
  assert.ok(/up to 2 years/.test(OUTLOOK), 'flagged-content exception')
  assert.ok(/up to 7 years/.test(OUTLOOK), 'classification-score retention')
  assert.ok(DRAFT.includes('up to 2 years') && DRAFT.includes('7 years'), 'module matches')
})

test('the training claim is no broader than Anthropic commercial policy supports', () => {
  assert.ok(/does\s*\n?\s*not use commercial API data to train its models by default/.test(OUTLOOK),
    'scoped to commercial API and qualified with "by default"')
  // Must NOT make an absolute, unqualified promise.
  assert.ok(!/never uses? (your|any) data (to|for) train/i.test(OUTLOOK), 'no absolute never-trains claim')
})

test('no ad hoc Anthropic deletion is promised', () => {
  assert.ok(/cannot promise to have an individual API record deleted on request/.test(OUTLOOK),
    'states the limitation plainly')
  for (const bad of [
    /we (can|will) delete your data from Anthropic/i,
    /request deletion from Anthropic/i,
    /Anthropic will delete it on request/i,
  ]) {
    assert.ok(!bad.test(OUTLOOK), `must not promise: ${bad}`)
  }
})

test('Anthropic retention is kept distinct from Funnl database retention', () => {
  assert.ok(/Anthropic's 30 days is not a Funnl deletion schedule/.test(OUTLOOK))
  // No Funnl-side retention promise anywhere in the section. Enforced by the allowlist
  // invariant at the top of this file rather than by guessing at phrasings.
  assert.deepStrictEqual(unapprovedDurations(), [], 'unapproved retention duration present')
})

test('no Funnl-side context-erasure schedule is promised while none is scheduled', () => {
  // The expiry RPC exists but nothing runs it: no pg_cron, no cron schema, no scheduling migration.
  assert.ok(MIGRATION.includes('expire_pending_outlook_context'), 'the RPC exists')
  assert.ok(!/cron\.schedule/.test(MIGRATION), 'nothing schedules it in the migration')
  assert.ok(/currently unenforced|unscheduled|does not currently erase|Nothing currently erases/i.test(PACKET),
    'the readiness packet records the gap for the owner')
})

// ── Suggestion behavior ──────────────────────────────────────────────────────
console.log('\nsuggestion behavior')

test('no automatic contact or interaction creation is claimed', () => {
  assert.ok(/Nothing would be added to your network automatically/.test(OUTLOOK))
  // INVERTED. The policy promised "you accept, dismiss, or defer them" while NEITHER
  // review card has a defer control - defer_candidate exists in the database and
  // nothing in the UI calls it. The consent notice had already been corrected; the
  // policy had not, so the two contradicted each other on what a reviewer can do.
  assert.ok(!/accept, dismiss, or defer/.test(OUTLOOK),
    'the policy must not promise a deferral the UI does not offer')
  assert.ok(/you accept, edit or dismiss them/.test(OUTLOOK_PROSE),
    'the three options that exist must be named')
  assert.ok(/There is no deferral option/.test(OUTLOOK_PROSE),
    'and the absent one stated rather than silently dropped')
  const page = read('src/pages/SuggestionsPage.jsx')
  const card = read('src/components/NewContactSuggestionCard.jsx')
  assert.ok(!/Defer/.test(page) && !/Defer/.test(card),
    'if a Defer control is ever added, this wording must change with it')
  assert.ok(/never creates a contact or an interaction on its own/.test(OUTLOOK))
  for (const bad of [/automatically (creates|adds) (a )?contact/i, /added for you automatically/i]) {
    assert.ok(!bad.test(OUTLOOK), `must not claim: ${bad}`)
  }
})

test('envelope-only proposed email and read-only acceptance are disclosed and enforced', () => {
  assert.ok(/comes from Microsoft, not from AI/.test(OUTLOOK))
  assert.ok(/taken from\s*\n?\s*the message envelope/.test(OUTLOOK))
  assert.ok(/the address is fixed and cannot be changed in that step/.test(OUTLOOK))
  assert.ok(/you can edit its email like any other contact/.test(OUTLOOK))
  // The applied accept RPC takes no email parameter.
  const i = MIGRATION.indexOf('CREATE FUNCTION public.accept_new_contact_candidate(')
  const sig = MIGRATION.slice(i, MIGRATION.indexOf('RETURNS jsonb', i))
  assert.ok(!/p_email|p_address|p_proposed_email/.test(sig), 'accept RPC takes no address')
  // The validator refuses an AI-supplied address.
  assert.ok(DRAFT.includes('ai_supplied_email'), 'AI output cannot carry an address')
})

test('disconnect wording matches what the applied cleanup RPC actually does', () => {
  assert.ok(/disconnecting Outlook deletes your Microsoft connection/.test(OUTLOOK_PROSE))
  assert.ok(/marked invalidated/.test(OUTLOOK))
  assert.ok(/Interactions and contacts you already accepted remain/.test(OUTLOOK))
  // MEASURED in tests/sql/outlook-pilot-retention-runtime.sql: the suggestion row
  // SURVIVES disconnect, still carrying contact_id, the proposed date and a 64-char
  // fingerprint. Calling it empty, or saying it is deleted, would be false.
  assert.ok(/The suggestion record itself is not deleted/.test(OUTLOOK_PROSE),
    'the surviving row must be disclosed')
  assert.ok(/still carrying the contact it referred to, the proposed date and its one-way fingerprint/
    .test(OUTLOOK_PROSE), 'what it still carries must be named')
  assert.ok(!/leaving only a minimal record/.test(OUTLOOK),
    'the superseded minimal-record wording must not return')
  // Removal is event-driven, and the two remaining deletion claims are the verified ones.
  assert.ok(/events, not by a timer/.test(OUTLOOK_PROSE))
  assert.ok(/deleted when you delete the contact it refers to, or when you delete your Funnl account/
    .test(OUTLOOK_PROSE), 'only the cascade-verified deletion paths are claimed')
  assert.ok(/no scheduled job<\/strong> that acts on that deadline today/.test(
    OUTLOOK.replace(/\s+/g, ' ')) || /no scheduled job/.test(OUTLOOK_PROSE),
  'the absent sweep is disclosed as a limit')
  // THE REVIEW WINDOW IS A REFUSAL, NOT A DELETION, and the policy must say both
  // halves. The approved-duration list admits the clause only because these do.
  assert.ok(/Funnl will not let you accept it/.test(OUTLOOK_PROSE),
    'what the window actually enforces')
  assert.ok(/reappears the next time the page loads/.test(OUTLOOK_PROSE),
    'that taking a row off the list is not a database change')
  // CORRECTED. This pinned "stay stored until you accept it, dismiss it, disconnect
  // Outlook" - listing ACCEPTANCE as a removal path for an expired suggestion, which
  // it is not: accepting one is refused, so the row stays pending. Dismissal is the
  // path that actually clears it, and it is not refused by the window.
  assert.ok(/stay stored until you dismiss it, disconnect Outlook/.test(OUTLOOK_PROSE),
    'and that the text stays stored until an actual removal event')
  assert.ok(/acceptance is not a way to clear an expired suggestion/
    .test(OUTLOOK_PROSE.replace(/\s+/g, ' ')),
  'acceptance must not be offered as a way to clear an expired suggestion')
  assert.ok(/Dismissing an expired suggestion does work, and does clear it/
    .test(OUTLOOK_PROSE), 'and dismissal must be distinguished from it')
  assert.ok(/erases the drafted context/.test(OUTLOOK_PROSE),
    'with what dismissal actually erases')
  // And the working records are disclosed with the right verb.
  // 'short-lived' is gone: the measurement shows they can stay stored indefinitely.
  assert.ok(!/short-lived/.test(OUTLOOK_PROSE),
    'working records must not be called short-lived')
  assert.ok(/working records belonging to one read/.test(OUTLOOK_PROSE),
    'they are scoped to one read')
  assert.ok(/becomes unusable 24 hours after it begins/.test(OUTLOOK_PROSE))
  assert.ok(/becoming unusable is not the same as being erased/i.test(OUTLOOK_PROSE),
    'the deadline must be distinguished from removal')
  assert.ok(/neither does waiting or reading the progress of a read/.test(OUTLOOK_PROSE),
    'waiting and viewing progress must not be implied to delete')
  // The four measured removal paths, each named.
  for (const path of [/later read starting/, /completing/, /reset/, /disconnecting/]) {
    assert.ok(path.test(OUTLOOK_PROSE), `removal path not named: ${path}`)
  }
  assert.ok(/No scheduled job acts on the deadline/.test(OUTLOOK_PROSE),
    'the absent schedule must stay visible')
  const i = MIGRATION.indexOf('CREATE FUNCTION public.run_microsoft_local_cleanup')
  const body = MIGRATION.slice(i, MIGRATION.indexOf('$$;', i))
  assert.ok(body.includes("status = 'invalidated'"), 'RPC invalidates')
  assert.ok(body.includes('proposed_email = NULL'), 'RPC erases proposed values')
  assert.ok(body.includes('DELETE FROM public.microsoft_connections'), 'RPC deletes the connection')
  assert.ok(body.includes('DELETE FROM public.microsoft_oauth_states'), 'RPC discards unused states')
})

// ── Tokens and human access ──────────────────────────────────────────────────
console.log('\ntokens and human access')

test('token storage is described conditionally, not as present behavior', () => {
  assert.ok(/stored only as encrypted values with a key version/.test(OUTLOOK))
  // No OAuth exists yet, so the section must not assert tokens are being held today.
  for (const bad of [
    /your tokens are (currently )?encrypted/i,
    /Funnl (currently )?(stores|holds) your Microsoft (authorization|tokens)/i,
  ]) {
    assert.ok(!bad.test(OUTLOOK), `must not assert present-tense token handling: ${bad}`)
  }
  assert.ok(MIGRATION.includes('access_token_ciphertext') && MIGRATION.includes('refresh_token_ciphertext'),
    'the schema would store them encrypted')
})

test('human-access wording is precise and includes the Anthropic safety exception', () => {
  assert.ok(/not be read by a person at Funnl except/.test(OUTLOOK), 'scoped, not absolute')
  assert.ok(/support\s*\n?\s*request/.test(OUTLOOK) && /security investigation/.test(OUTLOOK) && /law requires it/.test(OUTLOOK))
  assert.ok(/Anthropic operates\s*\n?\s*its own automated safety systems/.test(OUTLOOK),
    'discloses that Anthropic may review flagged content')
  // No blanket claim.
  assert.ok(!/no one at Funnl (ever|will ever) reads? your email/i.test(OUTLOOK))
})

// ── Date guard and non-regression ────────────────────────────────────────────
console.log('\npublication date guard')

test('the public date is the actual October 10, 2026 publication date', () => {
  // Owner/product decision: publish the DETAILED-DRAFT wording (the 2,000-character summary
  // limit and the paragraph describing what the draft records) dated 2026-10-10, the actual
  // New York date of the publishing commit. October 9 (background sync), October 6 (content
  // release), October 5 and September 27 (envelope-only) are historical. If a later merge
  // moves the day, this pin must move with it in that same commit - which is the point of
  // pinning it rather than leaving it free.
  assert.ok(POLICY.includes('Last updated: October 10, 2026'),
    'the approved publication date must be present')
  assert.ok(!/Last updated: October 9, 2026/.test(POLICY),
    'the superseded background-sync date must no longer be the public date')
  assert.ok(!/Last updated: September 2[07], 2026/.test(POLICY),
    'a superseded Last-updated date must be gone')
  assert.ok(!/September 26, 2026/.test(POLICY),
    'the briefly-proposed September 26 date must not linger anywhere in the source')
  assert.strictEqual((POLICY.match(/Last updated:/g) || []).length, 1,
    'exactly one public date line')
  // Once in the public line, twice in the source decision comment (the approval and
  // the recheck instruction). Pinned so a stray extra date cannot creep in unnoticed.
  // Twice now: the public line and the approval in the source decision comment.
  assert.strictEqual((POLICY.match(/October 10, 2026/g) || []).length, 2,
    'one public date line plus the source-comment approval')
  assert.strictEqual((POLICY.match(/Last updated: October 10, 2026/g) || []).length, 1,
    'exactly one public Last-updated line carries the date')
  // October 9 survives TWICE, both in the comment, as history: the background-sync
  // publication record and the note saying it was superseded by this one.
  assert.strictEqual((POLICY.match(/October 9, 2026/g) || []).length, 2,
    'the superseded background-sync date is recorded twice, as history, never as the public date')
  // The content-release approval date survives ONCE, in the comment, as history.
  assert.strictEqual((POLICY.match(/October 6, 2026/g) || []).length, 1,
    'the superseded-as-a-date content-release approval is recorded once, as history')
  // The two superseded approval dates survive ONCE EACH, in the comment, recorded as
  // history - so a replaced approval stays auditable rather than being quietly erased.
  // October 5 is the envelope-only wording this release replaces; September 27 is the
  // one before that.
  assert.strictEqual((POLICY.match(/September 27, 2026/g) || []).length, 1,
    'the oldest superseded approval is recorded once, as history')
  assert.strictEqual((POLICY.match(/October 5, 2026/g) || []).length, 1,
    'and so is the envelope-only approval this release supersedes')
  assert.ok(/October 5, 2026 and September 27, 2026 approvals\s+covered the superseded envelope-only wording/
    .test(POLICY.replace(/\s+/g, ' ')),
    'both are labelled as covering the superseded envelope-only wording')
  // And the current approval says what it actually covers: body processing and the
  // extract sent to Anthropic, not just a reworded disclosure.
  assert.ok(/selected message-body\s+processing/.test(POLICY),
    'the recorded approval names the body processing it authorizes')
})

test('the approved background-sync wording is published VERBATIM (activation packet section 2)', () => {
  const a = "a record of the mail-change subscription Funnl holds with Microsoft for your mailbox: the identifier Microsoft assigns it, when it expires, when Microsoft last signalled a change, how many signals have arrived, and a one-way hash of the secret Funnl uses to recognise Microsoft's signals; plus, on the connection itself, the time and kind of the most recent signal. A signal tells Funnl only that your mailbox changed; Funnl does not store the message identifier it carries."
  const b = "Funnl asks Microsoft to notify its servers when new mail arrives, and aims to start a check within a few minutes of that signal; it also runs a routine check, normally about every fifteen minutes, in case a signal was missed. These checks run automatically on Funnl's servers while Funnl is closed; nothing runs in your browser."
  assert.ok(OUTLOOK.includes(a), 'the subscription-record bullet is present, word for word')
  assert.ok(OUTLOOK.includes(b), 'the two automatic-check sentences are present, word for word')
  assert.ok(/How a read would run<\/strong> — Funnl asks Microsoft/.test(OUTLOOK), 'placed as its own bullet in the Outlook section')
  // The timing is stated as an aim and a normal interval, never as a guarantee or a figure.
  assert.ok(!/within five minutes|5 minutes|p95/i.test(OUTLOOK), 'no latency figure or percentile reaches the user-facing text')
})

test('the section still carries a mandatory date-recheck instruction and an approval that is not legal advice', () => {
  assert.ok(/MANDATORY AT PUBLICATION/.test(POLICY), 'the instruction survives')
  assert.ok(/MUST be changed again in that same commit/.test(POLICY),
    'a later merge date must force another update')
  assert.ok(/PUBLICATION DECISION/.test(POLICY), 'the owner decision is recorded')
  assert.ok(/not legal advice/.test(POLICY),
    'owner approval must not be presented as legal review')
  // The source must carry the disclaimer, and must not make the affirmative claim. A naive
  // negative on 'counsel reviewed' would match the disclaimer itself, so match the claim
  // shapes instead.
  assert.ok(/not evidence that outside\s+counsel reviewed or approved this policy/.test(POLICY),
    'owner approval is explicitly not counsel review')
  for (const claim of [/reviewed and approved by (outside )?counsel/i,
    /counsel has (reviewed|approved) (this|the) policy/i,
    /legally (reviewed|approved)/i, /approved by our lawyers/i]) {
    assert.ok(!claim.test(POLICY), `must not claim legal review: ${claim}`)
  }
  assert.ok(/publication commit/i.test(PACKET), 'the packet repeats the requirement')
})

test('the Outlook section is still not represented as operational', () => {
  // The publication decision changes the date, nothing else. Outlook stays dormant.
  assert.ok(/Outlook is not generally available/.test(OUTLOOK_PROSE))
  assert.ok(/NOT GENERALLY AVAILABLE/.test(POLICY), 'the source comment still says so')
  assert.ok(/WHY THE WORDING IS NOT "DOES NOT EXIST"/.test(POLICY),
    'the source records why the absolutes were dropped')
  assert.ok(/WHAT THE START GATE PROVES, AND WHAT IT DOES NOT/.test(POLICY),
    'the source records that the gate is not proof of absent rows')
  assert.ok(!/no reader of this page can connect/.test(POLICY),
    'the superseded comment must not return')
  for (const bad of [/Outlook is (now )?(available|enabled|live)/i, /you are connected to Outlook/i]) {
    assert.ok(!bad.test(OUTLOOK), `must not claim: ${bad}`)
  }
  // No Funnl retention duration was approved along with the date.
  assert.deepStrictEqual(unapprovedDurations(), [], 'no Funnl duration approved')
  assert.strictEqual(APPROVED_RETENTION_DISCLOSURES.length, 6, 'still exactly six Anthropic clauses')
})

test('existing Gmail and Calendar wording is untouched', () => {
  assert.ok(POLICY.includes('<Section title="Gmail connection (optional)">'))
  assert.ok(POLICY.includes('<Section title="Google Calendar connection">'))
  assert.ok(POLICY.includes('Google API Services User Data Policy'))
  assert.ok(POLICY.includes('metadata-only format'), 'Gmail header-only wording intact')
  assert.ok(/Funnl does not read your Gmail unless you explicitly connect it/.test(POLICY))
})

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

test('each approved Anthropic retention disclosure appears exactly once, attributed and qualified', () => {
  for (const { why, text } of APPROVED_RETENTION_DISCLOSURES) {
    const count = OUTLOOK_PROSE.split(text).length - 1
    assert.strictEqual(count, 1, `${why}: expected exactly one occurrence, found ${count}`)
    // Attribution: Anthropic must be named in the clause or in the run-up to it, so a
    // duration can never be silently re-pointed at Funnl.
    const at = OUTLOOK_PROSE.indexOf(text)
    const window = OUTLOOK_PROSE.slice(Math.max(0, at - 240), at + text.length)
    assert.ok(window.includes('Anthropic'), `${why}: not attributed to Anthropic`)
    assert.ok(/Anthropic|API/.test(window), `${why}: not qualified to Anthropic API processing`)
  }
  // The durations themselves, so a silent renumbering fails.
  assert.ok(/within 30 days/.test(OUTLOOK_PROSE), 'Anthropic 30-day window')
  assert.ok(/up to 2 years/.test(OUTLOOK_PROSE), 'two-year flagged-content exception')
  assert.ok(/up to 7 years/.test(OUTLOOK_PROSE), 'seven-year classification-score retention')
})

test('the one approved FUNNL duration is a refusal, and says so', () => {
  for (const { why, text } of APPROVED_FUNNL_DURATIONS) {
    const count = OUTLOOK_PROSE.split(text).length - 1
    assert.strictEqual(count, 1, `${why}: expected exactly one occurrence, found ${count}`)
    // It must NOT be stated as a deletion, and the three sentences that keep it
    // honest must accompany it.
    const at = OUTLOOK_PROSE.indexOf(text)
    const after = OUTLOOK_PROSE.slice(at, at + 1200)
    assert.ok(/Funnl will not let you accept it/.test(after),
      `${why}: the window must be stated as a refusal`)
    assert.ok(/no scheduled job/.test(after),
      `${why}: the absent sweep must accompany it`)
    assert.ok(/reappears the next time the page loads/.test(after),
      `${why}: and that hiding a row is not a database change`)
    assert.ok(!/delete[sd]? (it|them|the suggestion) (after|within|at) 30/i.test(after),
      `${why}: it must not be restated as a deletion schedule`)
  }
  // Exactly one. A second Funnl duration needs its own review, not a silent addition.
  assert.strictEqual(APPROVED_FUNNL_DURATIONS.length, 1,
    'adding a Funnl duration is a deliberate act')
})

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
