#!/usr/bin/env node
// OWNER-RUN, BEFORE ROLLOUT: does this tenant actually apply the conversation-lookup filter?
//
// WHAT THIS SCRIPT DOES: it PRINTS the exact requests, built by this head's own
// `buildConversationLookupRequest`, so the owner runs them signed in as the pilot mailbox.
// It makes no network call, reads no credential, and writes no file. Everything it prints
// goes to the terminal only.
//
// WHY IT EXISTS. The reference pages list the OData parameters as supported but do not state
// per-property filterability, and a silently ignored `$filter` returns HTTP 200 with a
// perfectly plausible body. So 200 is not the test. The test is that a cutoff chosen to
// EXCLUDE a known message actually excludes it, and that a cutoff chosen to INCLUDE it
// actually includes it - on `receivedDateTime` for Inbox and `sentDateTime` for Sent Items,
// which is what the worker relies on when it narrows a window.
//
// EVERY CUTOFF IS REASONED ABOUT AS TRANSMITTED. The builder's formatter truncates the
// fraction, so an instant of `10:00:00.900Z` goes on the wire as `10:00:00Z`. A helper that
// described the instant it chose rather than the one it sends made a claim the request could
// not support; see scripts/lib/outlook-filter-cutoffs.mjs and
// tests/outlook-filter-cutoffs.test.js. The production builder is unchanged.
//
// WHAT IS DELIBERATELY NOT ASSERTED: response ORDER. The recovery path never sends
// `$orderby` and refuses `@odata.nextLink` rather than depending on order, so no ordering
// behaviour is an activation requirement. Do not add `$orderby`: that would test a request
// the worker never makes.
//
// PRIVACY. The conversation id and the instants you pass are REAL identifiers and appear in
// the printed URLs, on your screen. Do not paste URLs, bodies, addresses or ids into chat or
// into any durable log. Report only the statuses, counts and booleans the template asks for.

import {
  buildConversationLookupRequest, MAX_RECOVERY_MESSAGES_PER_FOLDER, ENVELOPE_SELECT,
  RECOVERY_FILTER_PROPERTY,
} from '../supabase/functions/shared/outlookGraphTransport.js'
import {
  inclusiveCutoff, exclusiveCutoff, discriminatingCutoff,
} from './lib/outlook-filter-cutoffs.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(String(process.argv[i]).replace(/^--/, ''), process.argv[i + 1])
}
const conv = args.get('conversation')

const HANDOFF = `
═══════════════════════════════════════════════════════════════════════════════
 CONVERSATION-LOOKUP FILTER CHECK - read-only, owner-run, nothing is written
═══════════════════════════════════════════════════════════════════════════════

 STEP 0 - WHICH ACCOUNT
   Open https://developer.microsoft.com/graph/graph-explorer and sign in with the
   SAME Microsoft account that is connected to Funnl. If you are unsure which that
   is, read it from Funnl's own Settings page (the connected-account line) rather
   than from anywhere else - and do not paste it into chat.
   Consent the \`Mail.Read\` scope when Graph Explorer asks. Nothing below needs any
   other scope, and every request is a GET.

 STEP 1 - GET A CONVERSATION ID (one read-only query)
   Run this in Graph Explorer exactly as written:

     GET https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$select=conversationId,subject&$top=10

   Pick a thread you know received a REPLY - so it has messages in both folders -
   and copy its \`conversationId\`.

 STEP 2 - COPY THESE LOCALLY, NOT INTO CHAT
   In your own terminal, in this repository:

     node scripts/outlook-filter-check.mjs --conversation <conversationId>

   That prints the two positive-control requests. Run both in Graph Explorer, then
   from their results copy FOUR instants - again into your terminal, not into chat:

     from A-inbox      one message's receivedDateTime  and its sentDateTime
     from A-sentitems  one message's sentDateTime      and its receivedDateTime

   Prefer a message whose two instants are in DIFFERENT seconds; the final step is
   only possible then, and the script will say NOT AVAILABLE rather than pretend
   otherwise. Then:

     node scripts/outlook-filter-check.mjs --conversation <conversationId> \\
          --inbox-received <ISO> --inbox-sent <ISO> \\
          --sent-sent <ISO>      --sent-received <ISO>

 STEP 3 - REPORT
   Only the statuses, counts and booleans in the template the script prints at the
   end. No URLs, no bodies, no addresses, no identifiers.
`

if (!conv) {
  console.log(HANDOFF)
  process.exit(0)
}

const show = (label, req, note) => {
  console.log(`\n### ${label}`)
  if (note) console.log(`    ${note}`)
  console.log(`${req.method} ${req.url}`)
  console.log(`headers: ${JSON.stringify(req.headers)}`)
}

console.log(`
═══════════════════════════════════════════════════════════════════════════════
 Requests built by this head's own buildConversationLookupRequest. Bounds,
 projection and headers are the worker's, unmodified:

   $top            ${MAX_RECOVERY_MESSAGES_PER_FOLDER}  (one page per folder; the worker refuses @odata.nextLink)
   $select         ${ENVELOPE_SELECT.join(',')}
   Prefer          IdType="ImmutableId"
   filter property inbox -> ${RECOVERY_FILTER_PROPERTY.inbox}
                   sentitems -> ${RECOVERY_FILTER_PROPERTY.sentitems}
   $orderby        NEVER sent. Do not add it.

 Record ONLY: HTTP status, the number of items in "value", whether every item's
 conversationId equals the one you asked for, and whether @odata.nextLink is present.`)

// ── STEP A: the positive control ────────────────────────────────────────────
console.log(`
───────────────────────────────────────────────────────────────────────────────
 A - POSITIVE CONTROL: conversation only, no window
 Both must return HTTP 200 with a NON-EMPTY value array, every conversationId
 matching, and NO @odata.nextLink. An empty array proves nothing: it is what a
 silently ignored filter returns for a thread with no messages in that folder, and
 what an accepted filter returns too. If either is empty, pick another thread. If
 either carries @odata.nextLink the test window is not complete and the later
 counts cannot be compared - pick a shorter thread.`)
for (const folder of ['inbox', 'sentitems']) {
  show(`A-${folder}  conversation only`,
    buildConversationLookupRequest({ folder, conversationId: conv }))
}

const inboxR = args.get('inbox-received')
const inboxS = args.get('inbox-sent')
const sentS = args.get('sent-sent')
const sentR = args.get('sent-received')

if (!inboxR || !sentS) {
  console.log(`
 Now re-run with the four instants (see STEP 2 of the handoff; run this script with
 no arguments to print it again).`)
  process.exit(0)
}

// ── STEP B/C: inclusion and exclusion, as transmitted ───────────────────────
console.log(`
───────────────────────────────────────────────────────────────────────────────
 B / C - INCLUSION AND EXCLUSION
 \`ge\` is inclusive. B uses the second CONTAINING the chosen message, so the message
 must be returned; C uses the next whole second, so it must not. Equal counts across
 B and C would mean the window is not applied at all - the failure 200 hides.`)

const exactness = []
for (const [folder, iso] of [['inbox', inboxR], ['sentitems', sentS]]) {
  const inc = inclusiveCutoff(iso)
  const exc = exclusiveCutoff(iso)
  if (!inc.ok || !exc.ok) {
    console.log(`\n### B/C-${folder}  SKIPPED: "${iso}" is not a timestamp`)
    continue
  }
  exactness.push([folder, inc.exact])
  show(`B-${folder}  cutoff at the containing second (must INCLUDE the message)`,
    buildConversationLookupRequest({ folder, conversationId: conv, sinceIso: inc.cutoff }),
    inc.exact
      ? `transmitted ${inc.transmitted} - EQUALS the message timestamp, so this IS an exact`
        + ' inclusive-boundary test'
      : `transmitted ${inc.transmitted} - the message timestamp carries a fraction, so the`
        + ' transmitted cutoff is BELOW it. Report this as inclusion only; it is NOT an'
        + ' exact inclusive-boundary test.')
  show(`C-${folder}  next whole second (must EXCLUDE the message)`,
    buildConversationLookupRequest({ folder, conversationId: conv, sinceIso: exc.cutoff }),
    `transmitted ${exc.transmitted}`)
}

// ── STEP D: which property is actually filtered ─────────────────────────────
console.log(`
───────────────────────────────────────────────────────────────────────────────
 D - WHICH PROPERTY IS ACTUALLY FILTERED
 Only possible when a message's two instants are far enough apart that a WHOLE
 second lies strictly between them AFTER the builder truncates. Otherwise the
 transmitted cutoff sits below both and separates nothing - which is a real result,
 reported as NOT AVAILABLE.`)

const plan = [
  ['inbox', inboxR, inboxS, RECOVERY_FILTER_PROPERTY.inbox, 'sentDateTime'],
  ['sentitems', sentS, sentR, RECOVERY_FILTER_PROPERTY.sentitems, 'receivedDateTime'],
]
const available = []
for (const [folder, primary, other, primaryName, otherName] of plan) {
  if (!other) {
    console.log(`\n### D-${folder}  NOT AVAILABLE`)
    console.log(`    the second instant was not supplied, so the two cannot be separated`)
    available.push([folder, false])
    continue
  }
  const d = discriminatingCutoff(primary, other)
  if (!d.available) {
    console.log(`\n### D-${folder}  NOT AVAILABLE`)
    console.log(`    ${d.reason}`)
    console.log(`    Report it as NOT AVAILABLE. To demonstrate it, choose a message whose`)
    console.log(`    two instants fall in different seconds.`)
    available.push([folder, false])
    continue
  }
  available.push([folder, true])
  const inc = d.includedUnder === 'a' ? primaryName : otherName
  const exc = d.includedUnder === 'a' ? otherName : primaryName
  show(`D-${folder}  cutoff strictly between the two instants`,
    buildConversationLookupRequest({ folder, conversationId: conv, sinceIso: d.cutoff }),
    `transmitted ${d.transmitted} - under ${inc} this message is INCLUDED; under ${exc} it is`
    + ` EXCLUDED. The worker relies on ${primaryName} for this folder.`)
}

// ── the results template ────────────────────────────────────────────────────
const exactNote = exactness.every(([, e]) => e)
  ? 'both B requests are exact inclusive-boundary tests'
  : 'at least one B request is an INCLUSION test only (fractional timestamp) - '
    + exactness.map(([f, e]) => `${f}:${e ? 'exact' : 'inclusion-only'}`).join(', ')

console.log(`
───────────────────────────────────────────────────────────────────────────────
 REPORT THIS, and nothing else. No URLs, bodies, addresses or identifiers.

   A-inbox       status ___  count ___  all conversationIds match? Y/N  nextLink? Y/N
   A-sentitems   status ___  count ___  all conversationIds match? Y/N  nextLink? Y/N
   B-inbox       status ___  count ___  chosen message present? Y/N
   C-inbox       status ___  count ___  chosen message present? Y/N   (must be N)
   B-sentitems   status ___  count ___  chosen message present? Y/N
   C-sentitems   status ___  count ___  chosen message present? Y/N   (must be N)
   D-inbox       ${available[0] && available[0][1] ? 'status ___  count ___  chosen message present? Y/N' : 'NOT AVAILABLE'}
   D-sentitems   ${available[1] && available[1][1] ? 'status ___  count ___  chosen message present? Y/N' : 'NOT AVAILABLE'}

 VERDICT - every one of these must hold:
   [ ] positive_control_non_empty      A-inbox count > 0 AND A-sentitems count > 0
   [ ] window_complete                 neither A response carries @odata.nextLink
   [ ] conversation_ids_match          every item in every response, both folders
   [ ] inclusion_at_cutoff             B includes the chosen message, both folders
   [ ] exclusion_works                 C excludes it, both folders, and C count < B count
   [ ] inbox_property_is_received      D-inbox agrees with receivedDateTime  (or NOT AVAILABLE)
   [ ] sent_property_is_sent           D-sentitems agrees with sentDateTime  (or NOT AVAILABLE)

 Exactness of the boundary: ${exactNote}.
 An exact inclusive-BOUNDARY claim is only warranted where the line above says exact.

 A 400 on any request means this tenant refuses the filter shape. That is already
 handled - the worker reports \`recovery_unsupported\` and settles the conversation
 rather than retrying - but it BLOCKS rollout of the narrowed window, because a long
 legacy thread could then never be completed.
`)
