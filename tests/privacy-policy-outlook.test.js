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
const TRANSPORT = read('supabase/functions/shared/outlookGraphTransport.js')
const NORMALIZE = read('supabase/functions/shared/outlookMessageNormalize.js')
const DRAFT = read('supabase/functions/shared/outlookDraftContract.js')

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

// Numbers and units a policy could plausibly use. Written-out forms matter: thirty days and
// one month are the same promise as 30 days.
const DURATION_NUMBER = '(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|'
  + 'eleven|twelve|fourteen|fifteen|twenty|thirty|forty|forty-five|sixty|ninety)'
const DURATION_UNIT = '(?:day|week|month|year)'
const durationRe = (flags) => new RegExp(DURATION_NUMBER + '[- ]*' + DURATION_UNIT + 's?', flags)

// The Outlook prose with every approved disclosure removed. Anything left that looks like a
// retention duration is an unapproved claim.
function unapprovedDurations () {
  let rest = OUTLOOK_PROSE
  for (const { text } of APPROVED_RETENTION_DISCLOSURES) rest = rest.split(text).join(' [APPROVED] ')
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

test('the section title and body say the connection does not exist yet', () => {
  assert.ok(OUTLOOK.includes('Outlook connection (not yet available)'), 'title marks it unavailable')
  assert.ok(/This connection does not exist yet/.test(OUTLOOK))
  // JSX wraps across lines, so normalize whitespace before matching the phrase.
  const flat = OUTLOOK.replace(/\s+/g, ' ')
  assert.ok(/if, and only if,<\/em> you choose to connect Outlook/i.test(flat),
    'uses the conditional "if, and only if" framing')
  assert.ok(/Nothing here is in\s+effect today/.test(OUTLOOK))
})

test('no statement claims Outlook is currently enabled, verified, certified or piloted', () => {
  for (const bad of [
    /Outlook is (now )?(available|enabled|live)/i,
    /\bOutlook is verified\b/i,
    /\bMicrosoft(-| )certified\b/i,
    /\bin pilot\b(?!;)/i,
    /you are connected to Outlook/i,
  ]) {
    assert.ok(!bad.test(OUTLOOK), `must not claim: ${bad}`)
  }
  assert.ok(/not available,\s*not enabled, and not in pilot/.test(OUTLOOK),
    'states the negative explicitly')
})

// ── Permission scope ─────────────────────────────────────────────────────────
console.log('\npermission scope')

test('Mail.Read is disclosed as read-only AND as granting message-content access', () => {
  assert.ok(/Mail\.Read/.test(OUTLOOK), 'names the permission')
  assert.ok(/read-only/.test(OUTLOOK), 'says read-only')
  assert.ok(/never allows sending, replying, deleting, moving, or changing/.test(OUTLOOK))
  // The honest half: the permission itself is broader than what Funnl requests.
  assert.ok(/permission to read your mail generally/.test(OUTLOOK),
    'discloses that Mail.Read is mailbox-wide')
  assert.ok(/would technically allow reading\s+message bodies and attachments/.test(OUTLOOK),
    'does not hide the authority the permission grants')
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
  assert.ok(/at most 200 characters/.test(OUTLOOK) && MIGRATION.includes('char_length(draft_summary) BETWEEN 1 AND 200'))
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
  assert.ok(/Email addresses, the recipient's email domain/.test(OUTLOOK), 'exclusions disclosed')
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
  assert.ok(/accept, dismiss, or defer/.test(OUTLOOK))
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
  assert.ok(/disconnecting Outlook would delete your Microsoft connection/.test(OUTLOOK))
  assert.ok(/marked invalidated/.test(OUTLOOK))
  assert.ok(/Interactions and contacts you already accepted remain/.test(OUTLOOK))
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

test('the published date is still September 20, 2026 on this unpublished draft', () => {
  assert.ok(POLICY.includes('Last updated: September 20, 2026'),
    'the public date must not change until the publication commit')
})

test('the section carries a mandatory just-in-time date-change instruction', () => {
  assert.ok(/MANDATORY AT PUBLICATION/.test(POLICY), 'the comment exists')
  assert.ok(/MUST be changed to the real publication date/.test(POLICY))
  assert.ok(/publication commit/i.test(PACKET), 'the packet repeats the requirement')
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
  assert.ok(/outlook-content-v1/.test(PACKET), 'placeholder consent version recorded')
  assert.ok(/DRAFT FOR OWNER\/LEGAL REVIEW/.test(PACKET))
  assert.ok(/finalize_microsoft_connection/.test(PACKET), 'consent mechanics cited to the RPC')
  for (const item of ['Entra registration', 'HMAC key', 'OAuth start and callback',
    'Review UI', 'Pilot authorization', 'Scheduling']) {
    assert.ok(new RegExp(item, 'i').test(PACKET), `blocker listed: ${item}`)
  }
  const boxes = (PACKET.match(/- \[ \]/g) || []).length
  assert.ok(boxes >= 12, `at least 12 owner/legal decisions, found ${boxes}`)
})

test('the packet does not itself claim the integration is live', () => {
  assert.ok(/Nothing in this packet is published, deployed or\s*\n?configured/.test(PACKET))
  assert.ok(/zero rows/.test(PACKET))
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
  ]
  for (const s of mustDetect) assert.ok(durationRe('i').test(s), `must recognize: ${s}`)
  // And it must not fire on the section's non-retention numbers.
  for (const s of ['at most 200 characters', 'at most 160 characters', 'exactly five', 'the two parties']) {
    assert.ok(!durationRe('i').test(s), `must not fire on: ${s}`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
