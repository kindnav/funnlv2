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
const E2A_MIG = read('supabase/migrations/20260907000000_add_gmail_transport_foundation.sql')
const E2B_MIG = read('supabase/migrations/20260910000000_add_gmail_worker_primitives.sql')
const CAL_MIG = read('supabase/migrations/20260817000000_add_calendar_ingestion.sql')
const CLEANUP = read('supabase/functions/shared/googleCleanup.js')
const RET_MIG = read('supabase/migrations/20260918000000_add_gmail_retention_cleanup.sql')  // applied in Production 2026-09-19
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

console.log('\nsnippet, header, and body wording is precise')

console.log('\nsynchronization description')

console.log('\npersisted data and retention — every claim is enforced by code, and unenforced maxima are NOT published')
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
  // This guard removes EXACTLY the Outlook section and nothing else. That section is the
  // one place in the policy that must state a retention period, because it discloses
  // ANTHROPIC's 30-day API retention: a different party, a different clock, and a required
  // disclosure. Those durations are governed by an exact allowlist in
  // tests/privacy-policy-outlook.test.js, which separately forbids a Funnl-side erasure
  // promise inside Outlook.
  //
  // Every other section stays in scope — Gmail, Google Calendar, Analytics, Your rights,
  // Cookies and local storage — so an unenforced Funnl retention maximum anywhere else in
  // the policy still fails here. An earlier version sliced only the prefix before Outlook,
  // which silently dropped the three sections that follow it; the assertions below exist so
  // that cannot happen again unnoticed.
  //
  // Fail closed: a missing, duplicated or reordered boundary throws instead of quietly
  // scanning a partial document.
  const OUTLOOK_START = '<Section title="Outlook connection (invited accounts only)">'
  const OUTLOOK_END = '<Section title="Analytics: behavior, not content">'
  const startCount = POLICY.split(OUTLOOK_START).length - 1
  const endCount = POLICY.split(OUTLOOK_END).length - 1
  assert.strictEqual(startCount, 1, `Outlook start marker must occur exactly once, found ${startCount}`)
  assert.strictEqual(endCount, 1, `Outlook end marker must occur exactly once, found ${endCount}`)
  const outlookAt = POLICY.indexOf(OUTLOOK_START)
  const afterOutlookAt = POLICY.indexOf(OUTLOOK_END)
  assert.ok(afterOutlookAt > outlookAt, 'the Analytics section must follow the Outlook section')
  const NON_OUTLOOK_POLICY = POLICY.slice(0, outlookAt) + POLICY.slice(afterOutlookAt)
  // Exactly the Outlook section was cut: the lengths must account for it precisely.
  assert.strictEqual(NON_OUTLOOK_POLICY.length, POLICY.length - (afterOutlookAt - outlookAt),
    'the excision must remove exactly the Outlook section')
  assert.ok(!NON_OUTLOOK_POLICY.includes(OUTLOOK_START), 'the Outlook section is out of scope')
  assert.ok(!/Anthropic's 30 days is not a Funnl deletion schedule/.test(NON_OUTLOOK_POLICY),
    'Outlook-only Anthropic wording is out of scope')
  // ... and every other section is still in scope.
  for (const kept of ['<Section title="Gmail connection (optional)">',
    '<Section title="Google Calendar connection">',
    '<Section title="Analytics: behavior, not content">',
    '<Section title="Your rights">',
    '<Section title="Cookies and local storage">']) {
    assert.ok(NON_OUTLOOK_POLICY.includes(kept), `must still be scanned: ${kept}`)
  }
  assert.ok(!/30 days/.test(NON_OUTLOOK_POLICY), 'a maximum the code does not enforce must not be promised')
  assert.ok(/expire_pending_email_context/.test(E2A_MIG), 'the job exists in SQL')
  const callers = ['supabase/functions/gmail-sync-worker/index.ts', 'supabase/functions/shared/gmailWorker.js', 'supabase/functions/google-calendar-sync/index.ts']
    .filter((p) => existsSync(join(ROOT, p)) && /expire_pending_email_context/.test(read(p)))
  assert.deepStrictEqual(callers, [], 'if a caller appears, the policy may publish the maximum — update this test deliberately')
})
test('subject erasure triggers are exactly: accept, dismiss, invalidation, Gmail disconnect, whole-Google (Calendar) disconnect, account deletion', () => {
  assert.ok(/deleted when you accept or dismiss the suggestion, when Funnl learns the email was deleted or moved to spam or trash, when you disconnect Gmail from Settings, when you disconnect Google Calendar \(which ends the whole Google connection\), or when you delete your account/.test(POLICY))
  assert.ok(!/when you disconnect Gmail from Settings, or when you delete your account/.test(POLICY), 'the old five-trigger list (no whole-Google path) is gone')
  assert.ok(/retained_subject\s*=\s*NULL/.test(fnBody(E2A_MIG, 'accept_interaction_candidate')))
  assert.ok(/retained_subject\s*=\s*NULL/.test(fnBody(E2A_MIG, 'dismiss_interaction_candidate')))
  assert.ok(/retained_subject\s*=\s*NULL/.test(fnBody(E2B_MIG, 'invalidate_email_candidates_by_fingerprint')))
  assert.ok(/retained_subject\s*=\s*NULL/.test(fnBody(E2B_MIG, 'disconnect_my_gmail')))
  assert.ok(/retained_subject\s*=\s*NULL/.test(fnBody(RET_MIG, 'run_google_local_cleanup')), 'the whole-Google cleanup RPC erases the subject')
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
test('whole-Google/Calendar disconnect: connection removed, cascade, Gmail ended, pending Gmail context ERASED, tombstone kept', () => {
  assert.ok(/together with the connection's capability, cursor, and reference records/.test(POLICY))
  assert.ok(/this also ends any Gmail connection you had made/.test(POLICY))
  // The old (pre-correction) sentence must never come back.
  assert.ok(!/Pending Gmail suggestions are not removed by this path/.test(POLICY), 'old wording removed')
  assert.ok(!/their retained subject line stays until you accept or dismiss them/.test(POLICY), 'old wording removed')
  // The corrected disclosure: removed from active Suggestions, subject + context erased, tombstone + fingerprint retained.
  assert.ok(/Funnl removes pending Gmail suggestions from your active Suggestions and erases their retained subject lines and context/.test(POLICY))
  assert.ok(/The minimal terminal suggestion record and its one-way fingerprint remain only to prevent the same conversation from being suggested again, and are deleted when you delete the related contact or your account/.test(POLICY))
  assert.ok(!/fingerprint (is|are) deleted (during|on|at) disconnect/i.test(POLICY), 'must not claim the fingerprint is deleted by disconnect')
  // Pinned to the APPLIED database primitive (migration 20260918000000): invalidate pending Gmail only,
  // NULL both context fields, never touch the fingerprint or delete the row, then delete states + connection.
  const rpc = fnBody(RET_MIG, 'run_google_local_cleanup')
  assert.ok(/SET status\s*=\s*'invalidated'/.test(rpc) && /retained_subject\s*=\s*NULL/.test(rpc) && /context_expires_at\s*=\s*NULL/.test(rpc))
  assert.ok(/WHERE user_id = p_user_id\s+AND source\s*=\s*'gmail'\s+AND status\s*=\s*'pending'/.test(rpc), 'pending Gmail rows of that user only')
  assert.ok(!/DELETE FROM public\.interaction_candidates/.test(rpc) && !/source_fingerprint\s*=/.test(rpc), 'tombstone + fingerprint preserved')
  assert.ok(/DELETE FROM public\.google_oauth_states WHERE user_id = p_user_id/.test(rpc) && /DELETE FROM public\.google_connections WHERE user_id = p_user_id/.test(rpc))
  assert.ok((E2A_MIG.match(/REFERENCES public\.google_connections\(id, user_id\) ON DELETE CASCADE/g) || []).length >= 3)
  // PUBLICATION GATE (not a deployment claim): this wording may be PUBLISHED only once the deployed
  // whole-Google cleanup path calls run_google_local_cleanup (PR-B). This test pins the text to the
  // database primitive; it does not assert that the Edge helper already calls it.
})
test('the combined-authorization warning is disclosed in both directions; both disconnect paths erase context and keep only the tombstone', () => {
  assert.ok(/cannot withdraw Gmail access on Google's side without also disconnecting Google Calendar/.test(POLICY))
  assert.ok(/Google Account's third-party access page/.test(POLICY))
  assert.ok(/Disconnecting Google Calendar in Funnl, or deleting your account, revokes the combined authorization and removes both connections/.test(POLICY))
  assert.ok(/Whichever way Gmail ends[^<]*pending Gmail suggestions are removed from your Suggestions and their subject lines and context are erased, and only the minimal terminal record and fingerprint remain until you delete the related contact or your account/.test(POLICY))
  // Gmail-only path: Calendar and the shared authorization stay.
  assert.ok(/Interactions you already accepted stay, and Google Calendar is not affected/.test(POLICY))
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
  assert.ok(/DELETE FROM public\.google_connections WHERE user_id = p_user_id/.test(fnBody(RET_MIG, 'run_google_local_cleanup')))
})
test('collection statement is scoped, not absolute', () => {
  assert.ok(!/does not collect data about you beyond what you explicitly enter or explicitly connect/.test(POLICY), 'old absolute removed')
  assert.ok(/Funnl does not access Google Calendar or Gmail unless you explicitly connect them/.test(POLICY))
  assert.ok(/processes the limited account, usage, diagnostic, cookie, and hosting information described in this policy/.test(POLICY))
  for (const w of ['Account information', 'diagnostic error report', 'Cookies and local storage', 'Standard server logs']) assert.ok(POLICY.includes(w), `policy actually discloses: ${w}`)
})
test('effective date and contact', () => {
  // History: the Gmail wording was published 2026-09-20, once both corrected cleanup callers
  // were deployed; the version before that was dated September 18, 2026. The date then moved
  // to 2026-09-27 for the approved Outlook disclosure publication, and to 2026-10-06 for the
  // Outlook content release.
  //
  // THE SPECIFIC DATE IS DELIBERATELY NOT PINNED HERE. There is one public date line for the
  // whole policy, and the publication decision that sets it belongs to whichever section is
  // being republished - currently tests/privacy-policy-outlook.test.js, which pins it exactly.
  // Pinning the same value in two suites meant every republication broke an unrelated suite
  // that had no opinion about the date, which is what happened on this line twice. What the
  // Gmail suite actually needs is that the policy carries exactly one well-formed public date.
  const dateLines = POLICY.match(/Last updated: [A-Z][a-z]+ \d{1,2}, \d{4}/g) || []
  assert.strictEqual(dateLines.length, 1, 'exactly one well-formed public date line')
  assert.ok(!/Last updated: September 2026</.test(POLICY))
  assert.ok((POLICY.match(/navbir12345@gmail\.com/g) || []).length >= 3)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
