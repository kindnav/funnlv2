// Protects the material Gmail disclosures in the public Privacy Policy and ties each one to
// the committed code that makes it true. If the code changes so a claim stops being true,
// the corresponding assertion here must fail. Source-scan tests (the repo's pattern for JSX).
// Run: node tests/privacy-policy-gmail.test.js

import assert from 'assert'
import { readFileSync, existsSync } from 'fs'
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
const HISTORY = read('supabase/functions/shared/gmailHistory.js')
const E2A_MIG = read('supabase/migrations/20260907000000_add_gmail_transport_foundation.sql')
const E2B_MIG = read('supabase/migrations/20260910000000_add_gmail_worker_primitives.sql')
const CAL_MIG = read('supabase/migrations/20260817000000_add_calendar_ingestion.sql')
const CLEANUP = read('supabase/functions/shared/googleCleanup.js')
const ANALYTICS = read('src/lib/analytics.js')
const AI_CHAT = read('supabase/functions/ai-chat/index.ts')
const fnBody = (sql, name) => { const i = sql.indexOf(`FUNCTION public.${name}`); const b = sql.slice(i); return b.slice(0, b.indexOf('$$;')) }

console.log('\nconditional wording while Gmail is unavailable')
test('absolute "does not read your Gmail" claims are gone; conditional wording is present', () => {
  assert.ok(!/Funnl does not read your Gmail or your LinkedIn/.test(POLICY))
  assert.ok(!/does not request Gmail access in this release/.test(POLICY))
  assert.ok(/Funnl does not read your Gmail unless you explicitly connect it/.test(POLICY))
  assert.ok(/Gmail connection is an optional feature and is not yet available to all accounts/.test(POLICY))
  assert.ok(/If, and only if, you choose to connect Gmail/.test(POLICY))
  assert.ok(/<Section title="Gmail connection \(optional\)">/.test(POLICY))
})

console.log('\ntransient vs persisted: what is processed while checking mail')
test('the header list is exactly the committed allowlist', () => {
  const allow = TRANSPORT.match(/METADATA_HEADER_ALLOWLIST = Object\.freeze\(\[([\s\S]*?)\]\)/)[1].match(/'([^']+)'/g).map((x) => x.replace(/'/g, ''))
  assert.deepStrictEqual(allow, ['from', 'to', 'cc', 'date', 'message-id', 'auto-submitted', 'x-auto-response-suppress', 'precedence', 'list-id', 'list-unsubscribe', 'subject'])
  for (const w of ['From, To, and Cc addresses', 'the Date', 'the Subject', 'the Message-ID', 'Auto-Submitted, X-Auto-Response-Suppress, Precedence, List-Id, List-Unsubscribe']) assert.ok(POLICY.includes(w), w)
  assert.ok(/metadata-only format/.test(POLICY) && /format: 'metadata'/.test(TRANSPORT))
})
test('transient processing of ids, timestamps, labels, cursors, and mailbox address is disclosed', () => {
  for (const w of ['Gmail message and conversation identifiers', 'message timestamps', 'inbox, sent mail, spam, or trash', 'the page cursors Gmail uses within that single check', 'the address of the connected mailbox', 'transient processing']) assert.ok(POLICY.includes(w), w)
  // persisted history cursor vs transient page cursors are distinguished explicitly
  assert.ok(/the only position marker Funnl keeps between checks is the history cursor/.test(POLICY))
  assert.ok(/a persisted Gmail history cursor \(Gmail's own position marker for your mailbox, not a message\)[^<]*different from the page cursors above, which live only for one check/.test(POLICY))
  assert.ok(/history_id/.test(E2A_MIG) && !/page_token|pageToken/.test(E2A_MIG + E2B_MIG), 'page cursors are never persisted')
  assert.ok(/internalDate/.test(TRANSPORT) && /'SENT'|'INBOX'/.test(TRANSPORT) && /SCOPE_EXIT_LABELS = Object\.freeze\(\['TRASH', 'SPAM'\]\)/.test(HISTORY))
  assert.ok(/gmailAddress:\s+data\.google_email/.test(read('supabase/functions/gmail-sync-worker/index.ts')))
})

console.log('\nsnippet, header, and body wording is precise')
test('snippet may be received but is never accessed; non-allowlisted headers discarded; body fails closed', () => {
  assert.ok(/Google may include a short preview \("snippet"\) in its metadata response; Funnl's code does not read, copy, use, display, store, or log it/.test(POLICY))
  assert.ok(!/snippets are never received|never receives a snippet/i.test(POLICY))
  assert.ok(/Headers other than those listed above are discarded/.test(POLICY))
  assert.ok(!/any header .* causes .* reject/i.test(POLICY), 'must not claim every extra header is rejected')
  assert.ok(/If a response unexpectedly contains body content, Funnl rejects that message/.test(POLICY))
  assert.ok(/never requests message bodies, HTML, attachments, images, or raw messages, and never stores them/.test(POLICY))
  // code: snippet always returned by Gmail but never read; allowlist-only survives; body -> unexpected_body
  assert.ok(/`snippet` is ALWAYS returned by Gmail even in metadata mode/.test(TRANSPORT))
  assert.ok(!/raw\.snippet|\.snippet\b/.test(TRANSPORT.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), 'adapter code never touches snippet')
  assert.ok(/'unexpected_body'/.test(TRANSPORT) && /everything else discarded/.test(TRANSPORT))
  assert.ok(!/\.snippet|payload\.body\.data|attachmentId/.test(WORKER))
})

console.log('\nsynchronization description')
test('90 days is the INITIAL import only; History thereafter; runs are bounded', () => {
  assert.ok(/The first check looks back roughly 90 days; after that, Funnl processes only new and changed messages using Gmail's change history/.test(POLICY))
  assert.ok(!/reads a bounded amount of recent header data each time \(it starts with roughly the last 90 days and then only changes\)/.test(POLICY))
  assert.ok(/limited in the number of pages, messages, conversations, and bytes it will read, how many requests it makes at once, and how long it may run/.test(POLICY))
  assert.ok(/INITIAL_WINDOW_DAYS = 90/.test(TRANSPORT))
  for (const k of ['maxPagesPerRun', 'maxMessagesPerRun', 'maxConversationsPerRun', 'maxBytesPerRun', 'maxConcurrency', 'runtimeBudgetMs']) assert.ok(new RegExp(`${k}:`).test(WORKER), k)
})

console.log('\npersisted data and retention — every claim is enforced by code, and unenforced maxima are NOT published')
test('persisted categories are named: tokens, capability status, cursor/state, fingerprint+key version, provenance, subject, accepted fields', () => {
  for (const w of ['encrypted at rest with AES-256-GCM', 'the status of your Gmail connection', 'a persisted Gmail history cursor', 'plus timestamps, retry state, and short result codes', 'the fact that it came from Gmail', 'shortened to at most 160 characters', 'HMAC-SHA256, with the version of the key used']) assert.ok(POLICY.includes(w), w)
  assert.ok(/AES-GCM/.test(CRYPTO) && /32-byte \(256-bit\)/.test(CRYPTO))
  assert.ok(/history_id/.test(E2A_MIG) && /retry_count/.test(E2A_MIG) && /last_result_code/.test(E2A_MIG))
  assert.ok(/key_version/.test(E2A_MIG) && /HMAC-SHA256/.test(FINGERPRINT))
  assert.ok(/subjectPreviewMax: 160/.test(CLASSIFIER) && /char_length\(retained_subject\) <= 160/.test(E2A_MIG))
})
test('"no identifiers are stored" is NOT claimed; the precise statement is', () => {
  assert.ok(!/No message identifiers are stored/.test(POLICY))
  assert.ok(/Raw Gmail message and conversation identifiers are not stored in suggestions or in Funnl's email reference records/.test(POLICY))
  assert.ok(/The history cursor and the fingerprints are used only by Funnl's servers and are never sent to your browser/.test(POLICY))
  assert.ok(/NO raw Gmail message id, thread id, history id/.test(E2A_MIG))
  // browser cannot read the cursor table or refs (no grants)
  assert.ok(/Intentionally NO GRANT and NO POLICY for authenticated: cursor\/lease never leak/.test(E2A_MIG))
  assert.ok(/Intentionally NO GRANT and NO POLICY for authenticated: provider provenance never leaks/.test(E2A_MIG))
})
test('the 30-day subject maximum is NOT published because no scheduler runs the expiry job', () => {
  assert.ok(!/30 days/.test(POLICY), 'a maximum the code does not enforce must not be promised')
  assert.ok(/expire_pending_email_context/.test(E2A_MIG), 'the job exists in SQL')
  const callers = ['supabase/functions/gmail-sync-worker/index.ts', 'supabase/functions/shared/gmailWorker.js', 'supabase/functions/google-calendar-sync/index.ts']
    .filter((p) => existsSync(join(ROOT, p)) && /expire_pending_email_context/.test(read(p)))
  assert.deepStrictEqual(callers, [], 'if a caller appears, the policy may publish the maximum — update this test deliberately')
})
test('subject erasure triggers are exactly: accept, dismiss, invalidation, Gmail disconnect, account deletion', () => {
  assert.ok(/deleted when you accept or dismiss the suggestion, when Funnl learns the email was deleted or moved to spam or trash, when you disconnect Gmail from Settings, or when you delete your account/.test(POLICY))
  assert.ok(/retained_subject\s*=\s*NULL/.test(fnBody(E2A_MIG, 'accept_interaction_candidate')))
  assert.ok(/retained_subject\s*=\s*NULL/.test(fnBody(E2A_MIG, 'dismiss_interaction_candidate')))
  assert.ok(/retained_subject\s*=\s*NULL/.test(fnBody(E2B_MIG, 'invalidate_email_candidates_by_fingerprint')))
  assert.ok(/retained_subject\s*=\s*NULL/.test(fnBody(E2B_MIG, 'disconnect_my_gmail')))
  assert.ok(/REFERENCES auth\.users\(id\)\s+ON DELETE CASCADE/.test(CAL_MIG), 'candidates cascade on account deletion')
})
test('accepted suggestion carries only type/date/note; fingerprints persist until contact/account deletion (disclosed plainly)', () => {
  assert.ok(/contains only the type, date, and note you reviewed; it never inherits the subject line/.test(POLICY))
  assert.ok(/its record \(without the subject line\) and its fingerprint remain so the conversation is not suggested again\. They are deleted when you delete the contact they concern or delete your account/.test(POLICY))
  assert.ok(/REFERENCES public\.contacts\(id\) ON DELETE CASCADE/.test(CAL_MIG))
  assert.ok(!/DELETE FROM public\.interaction_candidates/.test(E2A_MIG + E2B_MIG), 'no purge of terminal candidates exists')
})

console.log('\nthird-party boundaries — narrow, source-backed statements')
test('Supabase: processes and stores the enumerated Gmail-derived data', () => {
  assert.ok(/Supabase also processes and stores the limited connection data described below: encrypted Google authorization tokens, connection and capability status, the synchronization cursor and state, one-way fingerprints, suggestions, and any temporarily retained subject preview/.test(POLICY))
})
test('Anthropic: pending metadata/subjects not sent; accepted interaction fields may be, under the AI disclosure', () => {
  assert.ok(!/Gmail data is never sent to Anthropic/.test(POLICY))
  assert.ok(/Pending suggestions and any retained email subject line are not sent to Anthropic/.test(POLICY))
  assert.ok(/if you later use Funnl AI those fields may be sent to Anthropic like any other interaction/.test(POLICY))
  assert.ok(/Raw Gmail messages, headers, subject lines, message or thread identifiers, and Google tokens are never sent to Anthropic/.test(POLICY))
  // code: ai-chat selects interactions (type/date/notes) and contacts; never candidates/refs/subjects/tokens
  assert.ok(/\.from\('interactions'\)[\s\S]*?\.select\('id, contact_id, type, interaction_date, notes/.test(AI_CHAT))
  assert.ok(!/interaction_candidates|retained_subject|email_candidate_refs|google_tokens|gmail_sync_state/.test(AI_CHAT))
  assert.ok(/retained_subject is never copied into the interaction/.test(E2A_MIG))
})
test('PostHog: account identifier + email disclosed; Gmail content boundaries stated; autocapture off', () => {
  assert.ok(!/It never receives the content of your contacts — not names, companies, notes, emails/.test(POLICY), 'old blanket claim removed')
  assert.ok(/PostHog receives your Funnl account identifier and your <strong className="text-hi font-semibold">account email address<\/strong>/.test(POLICY))
  assert.ok(/does not send it Gmail message content, retained subject lines, mailbox or correspondence addresses, provider identifiers, tokens, or provider responses/.test(POLICY))
  assert.ok(/Automatic capture of page interactions is disabled/.test(POLICY))
  assert.ok(/posthog\.identify\(userId, \{ email \}\)/.test(ANALYTICS), 'identifyUser sends the account email')
  assert.ok(/autocapture:\s*false/.test(ANALYTICS), 'autocapture disabled in code')
})
test('Resend: account email only; no Gmail content', () => {
  assert.ok(/Your Funnl account email address is passed to Resend to deliver these messages; no Gmail mailbox content or Gmail-derived suggestion data is ever sent to Resend/.test(POLICY))
  assert.ok(!/resend/i.test(WORKER + HISTORY + TRANSPORT), 'no Gmail code path touches Resend')
})
test('the broad "never sent to Anthropic, PostHog, Resend" claim is gone', () => {
  assert.ok(!/Gmail data is never sent to Anthropic, PostHog, Resend/.test(POLICY))
})

// Whole-Google local cleanup: two reviewed contracts satisfy the published disclosure that the
// Google connection and its state are removed. Evaluated on comment-stripped code so prose in
// comments can never satisfy (or break) a contract check.
//   direct-delete (currently deployed): the helper itself deletes google_oauth_states + google_connections
//   atomic RPC (reviewed PR-B):          the helper calls run_google_local_cleanup(p_user_id) and issues no client deletes
const CLEANUP_CODE = CLEANUP.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
const usesDirectDeleteContract =
  /\.from\('google_oauth_states'\)[\s\S]*?\.delete\(\)/.test(CLEANUP_CODE) &&
  /\.from\('google_connections'\)[\s\S]*?\.delete\(\)/.test(CLEANUP_CODE) &&
  !/\.rpc\(/.test(CLEANUP_CODE)
const usesAtomicCleanupRpcContract =
  /run_google_local_cleanup/.test(CLEANUP_CODE) &&
  /\.rpc\([^)]*\{\s*p_user_id:\s*userId\s*\}\s*\)/.test(CLEANUP_CODE) &&
  !/\.delete\(\)/.test(CLEANUP_CODE)
// Under BOTH contracts the JavaScript helper never edits candidate rows itself; under the RPC
// contract the database function owns candidate cleanup.
const helperNeverEditsCandidates =
  !/interaction_candidates|retained_subject|context_expires_at|source_fingerprint/.test(CLEANUP_CODE)

console.log('\nwhole-Google local cleanup contract')
test('googleCleanup.js implements exactly one reviewed local-cleanup contract and never edits candidate rows directly', () => {
  assert.ok(usesDirectDeleteContract || usesAtomicCleanupRpcContract, 'the helper must implement a reviewed local-cleanup contract (direct delete or atomic RPC)')
  assert.ok(!(usesDirectDeleteContract && usesAtomicCleanupRpcContract), 'exactly one contract, never a mix')
  assert.ok(helperNeverEditsCandidates, 'the JS helper never edits interaction_candidates / retained_subject / context_expires_at / source_fingerprint directly')
})

console.log('\ndisconnect and deletion — two distinct paths')
test('Gmail-specific disconnect: capability off, sync state deleted, pending invalidated + subjects cleared, Calendar intact', () => {
  assert.ok(/turns off the Gmail connection, deletes Funnl's Gmail synchronization state and persisted history cursor, and removes every pending Gmail suggestion from your Suggestions and erases its subject line/.test(POLICY))
  assert.ok(/the minimal record and its fingerprint remain so the conversation is not suggested again/.test(POLICY), 'tombstone + fingerprint retention on Gmail disconnect is explicit')
  assert.ok(!/DELETE FROM public\.interaction_candidates/.test(fnBody(E2B_MIG, 'disconnect_my_gmail')), 'disconnect invalidates, never deletes candidate rows')
  assert.ok(/Google Calendar is not affected/.test(POLICY))
  const body = fnBody(E2B_MIG, 'disconnect_my_gmail')
  assert.ok(/AND product\s+= 'gmail'/.test(body) && /DELETE FROM public\.gmail_sync_state/.test(body) && /status\s+= 'invalidated'/.test(body) && !/google_tokens|GOOGLE_REVOKE/.test(body))
})
test('whole-Google/Calendar disconnect: connection removed, cascade, Gmail ended, subjects NOT cleared by that path', () => {
  assert.ok(/together with the connection's capability, cursor, and reference records/.test(POLICY))
  assert.ok(/this also ends any Gmail connection you had made/.test(POLICY))
  assert.ok(/Pending Gmail suggestions are not removed by this path; their retained subject line stays until you accept or dismiss them or delete your account/.test(POLICY))
  assert.ok((usesDirectDeleteContract || usesAtomicCleanupRpcContract) && helperNeverEditsCandidates, 'cleanup touches no candidate rows')
  assert.ok((E2A_MIG.match(/REFERENCES public\.google_connections\(id, user_id\) ON DELETE CASCADE/g) || []).length >= 3)
})
test('the combined-authorization warning is disclosed in both directions', () => {
  assert.ok(/cannot withdraw Gmail access on Google's side without also disconnecting Google Calendar/.test(POLICY))
  assert.ok(/Google Account's third-party access page/.test(POLICY))
  assert.ok(/Disconnecting Google Calendar in Funnl, or deleting your account, revokes the combined authorization and removes both connections/.test(POLICY))
})

console.log('\ngeneral policy corrections')
test('no "not a legal document" banner; Supabase Auth password wording; self-service deletion described', () => {
  assert.ok(!/not a legal document drafted by a lawyer/.test(POLICY))
  assert.ok(!/password \(encrypted\)/.test(POLICY))
  assert.ok(/Authentication is managed by Supabase Auth; Funnl never stores your password in plain text/.test(POLICY))
  assert.ok(/you can delete your account from Settings/.test(POLICY))
  assert.ok(/functions\.invoke\('delete-account'\)/.test(read('src/pages/SettingsPage.jsx')))
})
test('no verification / certification / endorsement claim', () => {
  assert.ok(!/verified by Google|Google-verified|CASA|certified|approved by Google|endorsed|legally compliant/i.test(POLICY))
})
test('Limited Use statement with the authoritative link and every required disclosure', () => {
  assert.ok(/Funnl's use and transfer of information received from Google APIs adheres to the\{' '\} <a href="https:\/\/developers\.google\.com\/terms\/api-services-user-data-policy"/.test(POLICY))
  assert.ok(/including the Limited Use requirements/.test(POLICY))
  for (const w of ['not sold', 'not transferred to advertisers, data brokers, or information resellers', 'not used for advertising or retargeting', 'not used to determine creditworthiness or for lending', 'not used to train generalized or foundation AI models', 'Service providers process it only as necessary to provide those features', 'not read by a person at Funnl except with your explicit permission', 'delete your account from Settings']) {
    assert.ok(POLICY.includes(w), w)
  }
})
test('shared Google authorization: whole-Google disconnect/deletion removes it; Gmail-only disconnect keeps it', () => {
  assert.ok(!/Disconnecting, or deleting your account, removes this authorization from Funnl/.test(POLICY), 'old overbroad sentence removed')
  assert.ok(/Disconnecting the entire Google connection[^<]*or deleting your account removes this authorization from Funnl/.test(POLICY))
  assert.ok(/Disconnecting Gmail alone disables Gmail processing but retains the shared Google authorization if Google Calendar remains connected/.test(POLICY))
  // implementation: disconnect_my_gmail never touches the connection or tokens; the Google cleanup deletes them
  const body = fnBody(E2B_MIG, 'disconnect_my_gmail')
  assert.ok(!/google_tokens|DELETE FROM public\.google_connections|UPDATE public\.google_connections/.test(body))
  // The whole-Google path deletes the connection either through the currently deployed client delete
  // or, after PR-B, through the applied RPC — both remove the shared authorization.
  assert.ok(/\.from\('google_connections'\)[\s\S]*?\.delete\(\)/.test(CLEANUP) || /run_google_local_cleanup/.test(CLEANUP))
})
test('collection statement is scoped, not absolute', () => {
  assert.ok(!/does not collect data about you beyond what you explicitly enter or explicitly connect/.test(POLICY), 'old absolute removed')
  assert.ok(/Funnl does not access Google Calendar or Gmail unless you explicitly connect them/.test(POLICY))
  assert.ok(/processes the limited account, usage, diagnostic, cookie, and hosting information described in this policy/.test(POLICY))
  for (const w of ['Account information', 'diagnostic error report', 'Cookies and local storage', 'Standard server logs']) assert.ok(POLICY.includes(w), `policy actually discloses: ${w}`)
})
test('effective date and contact', () => {
  assert.ok(/Last updated: September 18, 2026/.test(POLICY))
  assert.ok(!/Last updated: September 2026</.test(POLICY))
  assert.ok((POLICY.match(/navbir12345@gmail\.com/g) || []).length >= 3)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
