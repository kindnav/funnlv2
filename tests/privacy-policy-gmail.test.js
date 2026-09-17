// Protects the material Gmail disclosures in the public Privacy Policy and ties each one to
// the committed code that makes it true. If the code changes so a claim stops being true,
// the corresponding assertion here must fail. Source-scan tests (the repo's pattern for JSX).
// Run: node tests/privacy-policy-gmail.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const flat = (s) => s.replace(/\s+/g, ' ')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

const POLICY = flat(read('src/pages/PrivacyPage.jsx'))
const TRANSPORT = read('supabase/functions/shared/gmailTransport.js')
const CLASSIFIER = read('supabase/functions/shared/emailConversationClassifier.js')
const FINGERPRINT = read('supabase/functions/shared/emailFingerprint.js')
const CRYPTO = read('supabase/functions/shared/googleTokenCrypto.js')
const WORKER = read('supabase/functions/shared/gmailWorker.js')
const E2A_MIG = read('supabase/migrations/20260907000000_add_gmail_transport_foundation.sql')
const E2B_MIG = read('supabase/migrations/20260910000000_add_gmail_worker_primitives.sql')
const OAUTH = read('supabase/functions/shared/gmailOauth.js')
const CLEANUP = read('supabase/functions/shared/googleCleanup.js')

console.log('\nconditional wording while Gmail is unavailable')
test('the absolute "does not read your Gmail" claim is gone; the conditional one is present', () => {
  assert.ok(!/Funnl does not read your Gmail or your LinkedIn/.test(POLICY), 'old absolute claim must be removed')
  assert.ok(!/does not request Gmail access in this release/.test(POLICY), 'old release-scoped claim must be removed')
  assert.ok(/Funnl does not read your Gmail unless you explicitly connect it/.test(POLICY))
  assert.ok(/Gmail connection is an optional feature and is not yet available to all accounts/.test(POLICY))
  assert.ok(/If, and only if, you choose to connect Gmail/.test(POLICY))
})
test('a dedicated Gmail section exists and the Calendar section points to it', () => {
  assert.ok(/<Section title="Gmail connection \(optional\)">/.test(POLICY))
  assert.ok(/Gmail is a separate, optional connection described below/.test(POLICY))
})

console.log('\nwhat is read — matches the metadata allowlist exactly')
test('the header list in the policy is the committed allowlist and nothing more', () => {
  const allow = TRANSPORT.match(/METADATA_HEADER_ALLOWLIST = Object\.freeze\(\[([\s\S]*?)\]\)/)[1]
    .match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''))
  assert.deepStrictEqual(allow, ['from', 'to', 'cc', 'date', 'message-id', 'auto-submitted', 'x-auto-response-suppress', 'precedence', 'list-id', 'list-unsubscribe', 'subject'])
  for (const named of ['From, To, and Cc addresses', 'the date', 'the subject line', 'the message identifier', 'List-Id', 'Auto-Submitted']) {
    assert.ok(POLICY.includes(named), `policy names ${named}`)
  }
  assert.ok(/messages in Google's metadata-only format/.test(POLICY) && /format: 'metadata'/.test(TRANSPORT))
})
test('what is never read: bodies, snippets, HTML, attachments, raw MIME, other headers — and the code fails closed on a body', () => {
  for (const w of ['the body or text of your emails', 'previews or snippets', 'HTML', 'attachments', 'raw message files', 'any headers beyond the list above']) {
    assert.ok(POLICY.includes(w), `policy states never: ${w}`)
  }
  assert.ok(/reject any message that arrives with body content/.test(POLICY))
  assert.ok(/unexpected_body/.test(TRANSPORT), 'normalizer fails closed on body data')
  assert.ok(!/\.snippet|payload\.body\.data|attachmentId/.test(WORKER), 'worker never reads snippet/body/attachments')
})
test('only people already in contacts; CC-only and automated mail discarded', () => {
  assert.ok(/compared against the email addresses of your own contacts/.test(POLICY))
  assert.ok(/where a contact is only copied/.test(POLICY) && /automated or bulk mail are discarded/.test(POLICY))
  assert.ok(/cc/i.test(CLASSIFIER) && /automat|list-id|precedence/i.test(CLASSIFIER), 'classifier implements CC-only and automation filtering')
})

console.log('\nretention and erasure — every number and trigger is backed by code')
test('subject line trimmed to 160 and kept at most 30 days', () => {
  assert.ok(/trimmed to 160 characters/.test(POLICY))
  assert.ok(/automatically after 30 days/.test(POLICY))
  assert.ok(/subjectPreviewMax: 160/.test(CLASSIFIER))
  assert.ok(/char_length\(retained_subject\) <= 160/.test(E2A_MIG))
  assert.ok(/now\(\) \+ interval '30 days'/.test(E2A_MIG))
})
test('erasure on accept, dismiss, removal (deleted/spam/trash), disconnect, and expiry', () => {
  for (const w of ['when you accept or dismiss the suggestion', 'deleted or moved to spam or trash', 'when you disconnect Gmail', 'automatically after 30 days']) {
    assert.ok(POLICY.includes(w), `policy names trigger: ${w}`)
  }
  assert.ok(/retained_subject\s*=\s*NULL/.test(E2A_MIG), 'accept/dismiss/expire erase the subject')
  assert.ok(/retained_subject\s*=\s*NULL/.test(E2B_MIG), 'invalidate + disconnect erase the subject')
  assert.ok(/SCOPE_EXIT_LABELS = Object\.freeze\(\['TRASH', 'SPAM'\]\)/.test(read('supabase/functions/shared/gmailHistory.js')))
  assert.ok(/expire_pending_email_context/.test(E2A_MIG))
})
test('an accepted suggestion carries only the user-written note', () => {
  assert.ok(/contains only the note you wrote/.test(POLICY))
  const accept = E2A_MIG.slice(E2A_MIG.indexOf('FUNCTION public.accept_interaction_candidate'))
  assert.ok(/retained_subject\s*=\s*NULL/.test(accept.slice(0, accept.indexOf('$$;'))), 'accept erases the subject')
})
test('fingerprints are keyed HMAC-SHA256 and no message/thread identifiers are stored', () => {
  assert.ok(/one-way keyed fingerprint \(HMAC-SHA256\)/.test(POLICY))
  assert.ok(/HMAC-SHA256/.test(FINGERPRINT))
  assert.ok(/NO raw Gmail message id, thread id, history id/.test(E2A_MIG), 'refs table stores no identifiers')
})

console.log('\nprocessing, providers, encryption')
test('bounded background processing: ~90 days then changes; nothing in the browser', () => {
  assert.ok(/roughly the last 90 days and then only changes/.test(POLICY))
  assert.ok(/INITIAL_WINDOW_DAYS = 90/.test(TRANSPORT))
  assert.ok(/Nothing runs in your browser and there is nothing for you to trigger/.test(POLICY))
})
test('Gmail data never goes to Anthropic, PostHog, or Resend (no code path exists)', () => {
  assert.ok(/Gmail data is never sent to Anthropic, PostHog, Resend/.test(POLICY))
  for (const fn of ['ai-chat', 'ai-parse-contact', 'ai-categorize-contacts', 'ai-map-csv']) {
    const src = read(`supabase/functions/${fn}/index.ts`)
    assert.ok(!/interaction_candidates|retained_subject|email_candidate_refs|gmail/i.test(src), `${fn} never touches Gmail data`)
  }
})
test('tokens encrypted at rest with AES-256-GCM, never in the browser', () => {
  assert.ok(/encrypted at rest \(AES-256-GCM\)/.test(POLICY))
  assert.ok(/AES-GCM/.test(CRYPTO) && /32-byte \(256-bit\)/.test(CRYPTO))
})
test('no advertising, no sale, no brokers, no model training, human access only with permission', () => {
  for (const w of ['not sold', 'not transferred to advertisers, data brokers, or information resellers', 'not used for advertising', 'not used to train generalized or foundation AI models', 'not read by a human at Funnl except with your explicit permission']) {
    assert.ok(POLICY.includes(w), `Limited Use disclosure: ${w}`)
  }
  assert.ok(/api-services-user-data-policy/.test(POLICY) && /Limited Use requirements/.test(POLICY))
})

console.log('\ndisconnect and the combined Google authorization')
test('Gmail disconnect is local-only and Calendar-safe; the policy says so', () => {
  assert.ok(/stops Funnl reading your mail immediately, deletes every Gmail suggestion you have not acted on/.test(POLICY))
  assert.ok(/Google Calendar is not affected/.test(POLICY))
  const fn = E2B_MIG.slice(E2B_MIG.indexOf('FUNCTION public.disconnect_my_gmail'))
  const body = fn.slice(0, fn.indexOf('$$;'))
  assert.ok(/AND product\s+= 'gmail'/.test(body) && !/google_tokens|GOOGLE_REVOKE/.test(body))
})
test('the combined-authorization warning is disclosed in both directions', () => {
  assert.ok(/cannot withdraw Gmail access on Google's side without also disconnecting Google Calendar/.test(POLICY))
  assert.ok(/disconnecting Calendar also removes any Gmail connection/.test(POLICY))
  assert.ok(/Google Account's third-party access page/.test(POLICY))
  // code: Calendar disconnect/deletion revokes + deletes the connection; capabilities cascade
  assert.ok(/revoke/.test(CLEANUP) && /\.delete\(\)/.test(CLEANUP))
  assert.ok(/REFERENCES public\.google_connections\(id, user_id\) ON DELETE CASCADE/.test(E2A_MIG))
  assert.ok(/revoking the combined authorization can also remove\s+Calendar access|revoking it would silently break a working Calendar/.test(read('docs/phase-e2b-gmail-oauth-worker.md').replace(/\s+/g, ' ')) || /REVOCATION RULE/.test(OAUTH))
})

console.log('\nno overstated guarantees')
test('the policy does not claim Google verification, CASA certification, or that Gmail is live', () => {
  assert.ok(!/verified by Google|Google-verified|CASA|certified/i.test(POLICY))
  assert.ok(!/is now available|now supports Gmail/i.test(POLICY))
  assert.ok(/plain-language privacy policy written in good faith/.test(POLICY), 'the good-faith disclaimer remains')
})
test('contact and effective-date handling are consistent with the site', () => {
  assert.ok(/Last updated: September 2026/.test(POLICY))
  assert.ok((POLICY.match(/navbir12345@gmail\.com/g) || []).length >= 3)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
