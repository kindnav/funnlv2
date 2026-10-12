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
// WHAT IS DELIBERATELY NOT ASSERTED: response ORDER. The recovery path never sends
// `$orderby` and refuses `@odata.nextLink` rather than depending on order, so no ordering
// behaviour is an activation requirement. Do not add `$orderby` to these requests: that
// would test a request the worker never makes.
//
// PRIVACY. The conversation id and the instants you pass are REAL identifiers and appear in
// the printed URLs, on your screen. Do not paste URLs, bodies, addresses or ids back into
// chat or into any durable log. Report only the statuses, the counts, and the booleans the
// results template asks for.
//
// USAGE
//   node scripts/outlook-filter-check.mjs --conversation <conversationId> \
//        --inbox-received <ISO> [--inbox-sent <ISO>] \
//        --sent-sent <ISO>      [--sent-received <ISO>]
//
//   --conversation     the conversationId of a thread with messages in BOTH folders
//   --inbox-received   receivedDateTime of one known INBOX message in that thread
//   --inbox-sent       that same message's sentDateTime, if it differs from the above
//   --sent-sent        sentDateTime of one known SENT ITEMS message in that thread
//   --sent-received    that same message's receivedDateTime, if it differs
//
// Get those four values from request A's own output (step 1), so nothing is guessed.

import {
  buildConversationLookupRequest, MAX_RECOVERY_MESSAGES_PER_FOLDER, ENVELOPE_SELECT,
  RECOVERY_FILTER_PROPERTY,
} from '../supabase/functions/shared/outlookGraphTransport.js'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
}

const conv = args.get('conversation')
if (!conv) {
  console.log(`
Run step 1 first to obtain the four instants, then re-run with them.

  node scripts/outlook-filter-check.mjs --conversation <conversationId>

Signed in as the pilot mailbox in Graph Explorer (https://developer.microsoft.com/graph/graph-explorer),
with the Mail.Read scope consented. Method GET for every request below. Nothing here writes.
`)
  process.exit(0)
}

/** One second later, as an OData instant. Used to step a cutoff just past a known message. */
function plusOneSecond (iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) throw new Error('not an instant: ' + iso)
  return new Date(t + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Strictly between two instants, for the property-discrimination request. */
function between (a, b) {
  const x = Date.parse(a); const y = Date.parse(b)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === y) return null
  const mid = Math.floor((Math.min(x, y) + Math.max(x, y)) / 2)
  if (mid === Math.min(x, y)) return null
  return new Date(mid).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const show = (label, req) => {
  console.log(`\n### ${label}`)
  console.log(`${req.method} ${req.url}`)
  console.log(`headers: ${JSON.stringify(req.headers)}`)
}

console.log(`
═══════════════════════════════════════════════════════════════════════════════
 CONVERSATION-LOOKUP FILTER CHECK - read-only, owner-run
═══════════════════════════════════════════════════════════════════════════════
 Built by this head's own buildConversationLookupRequest. Bounds, projection and
 headers are the worker's, unmodified:

   $top            ${MAX_RECOVERY_MESSAGES_PER_FOLDER}  (one page per folder; the worker refuses @odata.nextLink)
   $select         ${ENVELOPE_SELECT.join(',')}
   Prefer          IdType="ImmutableId"
   filter property inbox -> ${RECOVERY_FILTER_PROPERTY.inbox}
                   sentitems -> ${RECOVERY_FILTER_PROPERTY.sentitems}
   $orderby        NEVER sent. Do not add it.

 Every request is a GET. Run each in Graph Explorer signed in as the pilot mailbox
 and record ONLY: HTTP status, the number of items in "value", whether every item's
 conversationId equals the one you asked for, and whether @odata.nextLink is present.`)

// ── STEP 1: the positive control, conversation only ──────────────────────────
console.log(`
───────────────────────────────────────────────────────────────────────────────
 STEP 1 - POSITIVE CONTROL: conversation only, no window
 Both must return HTTP 200 with a NON-EMPTY value array, every conversationId
 matching, and NO @odata.nextLink. An empty array proves nothing: it is what a
 silently ignored filter returns for a thread with no messages in that folder,
 and what an accepted filter returns too. If either is empty, pick another
 thread. If either carries @odata.nextLink the window is not complete and the
 later counts cannot be compared - pick a shorter thread.`)
for (const folder of ['inbox', 'sentitems']) {
  show(`A-${folder}  conversation only`,
    buildConversationLookupRequest({ folder, conversationId: conv }))
}
console.log(`
 From A-inbox pick ONE message and note its receivedDateTime and sentDateTime.
 From A-sentitems pick ONE message and note its sentDateTime and receivedDateTime.
 Re-run this script with those four values to print steps 2 and 3.`)

const inboxR = args.get('inbox-received')
const inboxS = args.get('inbox-sent')
const sentS = args.get('sent-sent')
const sentR = args.get('sent-received')

if (!inboxR || !sentS) process.exit(0)

// ── STEP 2: inclusion and exclusion at a known boundary ─────────────────────
console.log(`
───────────────────────────────────────────────────────────────────────────────
 STEP 2 - INCLUSION AND EXCLUSION
 \`ge\` is inclusive, so a cutoff AT the chosen message must INCLUDE it and a
 cutoff ONE SECOND LATER must EXCLUDE it. Equal counts across B and C would mean
 the window is not being applied at all - which is the failure 200 alone hides.`)

show('B-inbox   cutoff AT the chosen inbox message (must INCLUDE it)',
  buildConversationLookupRequest({ folder: 'inbox', conversationId: conv, sinceIso: inboxR }))
show('C-inbox   cutoff one second LATER (must EXCLUDE it)',
  buildConversationLookupRequest({
    folder: 'inbox', conversationId: conv, sinceIso: plusOneSecond(inboxR),
  }))
show('B-sentitems  cutoff AT the chosen sent message (must INCLUDE it)',
  buildConversationLookupRequest({ folder: 'sentitems', conversationId: conv, sinceIso: sentS }))
show('C-sentitems  cutoff one second LATER (must EXCLUDE it)',
  buildConversationLookupRequest({
    folder: 'sentitems', conversationId: conv, sinceIso: plusOneSecond(sentS),
  }))

// ── STEP 3: WHICH property, when the two differ ─────────────────────────────
console.log(`
───────────────────────────────────────────────────────────────────────────────
 STEP 3 - WHICH PROPERTY IS ACTUALLY FILTERED
 Only possible when a message's two instants DIFFER. A cutoff strictly between
 them is included under one property and excluded under the other, which is what
 separates "a datetime filter works" from "the datetime WE rely on works".`)

const inboxMid = inboxS ? between(inboxR, inboxS) : null
if (inboxMid) {
  const later = Date.parse(inboxR) > Date.parse(inboxS)
  show(`D-inbox   cutoff BETWEEN the two instants - under receivedDateTime this `
    + `message is ${later ? 'INCLUDED' : 'EXCLUDED'}; under sentDateTime it is `
    + `${later ? 'EXCLUDED' : 'INCLUDED'}`,
  buildConversationLookupRequest({ folder: 'inbox', conversationId: conv, sinceIso: inboxMid }))
} else {
  console.log(`
 D-inbox   NOT AVAILABLE: receivedDateTime and sentDateTime are equal (or only one
           was given) for the chosen inbox message, so no cutoff can separate them.
           Report this as not demonstrated rather than claiming the property.`)
}

const sentMid = sentR ? between(sentS, sentR) : null
if (sentMid) {
  const later = Date.parse(sentS) > Date.parse(sentR)
  show(`D-sentitems  cutoff BETWEEN the two instants - under sentDateTime this `
    + `message is ${later ? 'INCLUDED' : 'EXCLUDED'}; under receivedDateTime it is `
    + `${later ? 'EXCLUDED' : 'INCLUDED'}`,
  buildConversationLookupRequest({
    folder: 'sentitems', conversationId: conv, sinceIso: sentMid,
  }))
} else {
  console.log(`
 D-sentitems  NOT AVAILABLE: the two instants are equal (or only one was given) for
              the chosen sent message. Report as not demonstrated.`)
}

// ── the results template ────────────────────────────────────────────────────
console.log(`
───────────────────────────────────────────────────────────────────────────────
 REPORT THIS, and nothing else. No URLs, bodies, addresses or identifiers.

   A-inbox       status ___  count ___  all conversationIds match? Y/N  nextLink? Y/N
   A-sentitems   status ___  count ___  all conversationIds match? Y/N  nextLink? Y/N
   B-inbox       status ___  count ___  chosen message present? Y/N
   C-inbox       status ___  count ___  chosen message present? Y/N   (must be N)
   B-sentitems   status ___  count ___  chosen message present? Y/N
   C-sentitems   status ___  count ___  chosen message present? Y/N   (must be N)
   D-inbox       status ___  count ___  chosen message present? Y/N   (or NOT AVAILABLE)
   D-sentitems   status ___  count ___  chosen message present? Y/N   (or NOT AVAILABLE)

 VERDICT - every one of these must hold:
   [ ] positive_control_non_empty      A-inbox count > 0 AND A-sentitems count > 0
   [ ] window_complete                 neither A response carries @odata.nextLink
   [ ] conversation_ids_match          every item in every response, both folders
   [ ] inclusive_boundary              B includes the chosen message, both folders
   [ ] exclusion_works                 C excludes it, both folders, and C count < B count
   [ ] inbox_property_is_received      D-inbox agrees with receivedDateTime  (or NOT AVAILABLE)
   [ ] sent_property_is_sent           D-sentitems agrees with sentDateTime  (or NOT AVAILABLE)

 A 400 on any request means this tenant refuses the filter shape. That is already
 handled - the worker reports \`recovery_unsupported\` and settles the conversation
 rather than retrying - but it BLOCKS rollout of the narrowed window, because a
 long legacy thread could then never be completed.
`)
