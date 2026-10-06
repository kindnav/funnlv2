# Outlook privacy and consent — human-review readiness packet

**Status: MIXED, and the distinction is the point of this section.** One artefact is
already PUBLISHED; everything else in this packet is a draft, unapproved and not
configured. Read the four-row table under "WHAT IS PUBLISHED AND WHAT IS NOT" before
quoting anything from here.

Artefacts B, C and D in that table are **DRAFT FOR OWNER/LEGAL REVIEW**: unapproved,
unconfigured, and not published to anyone.

**WHAT IS PUBLISHED AND WHAT IS NOT.** Four different things are easy to confuse.

| | Artefact | Where it lives | Published? | Approved? |
|---|---|---|---|---|
| **A** | The conditional Outlook section of the Privacy Policy | `src/pages/PrivacyPage.jsx`, **live at `/privacy`** | **YES, live now**, dated September 27, 2026 | yes, owner-approved |
| **B** | Revised permission wording (adds `User.Read`) | **this document only** | no | no |
| **C** | The just-in-time consent disclosure shown before the redirect | `src/lib/outlookDisclosure.js`, **Draft PRs #56 / #57 only** | no | no |
| **D** | The Outlook code itself: Edge Functions, Settings UI, disconnect, the import pass, the candidate write path and the suggestion review surface, plus three forward migrations | **Draft PRs #54-#59 only**, unmerged | n/a | n/a |

A is a live public promise and nothing in these branches changes it. B and C are drafts in
this repository. D is code that exists in Git and nowhere else: no Outlook Edge Function is
deployed, no migration from the stack is applied, both flags are off, and every Outlook
table in Production holds zero rows. An Entra application **is now registered** (client
ID `af27b250-da0b-443e-bcac-38a67737d640`); registration is not the same as credentials,
live consent, deployment, or a completed Microsoft round trip, and none of those exist. "It exists in a Draft branch"
and "it exists in Production" are different claims throughout this document.

**LAUNCH GATE: DISCONNECT NOW EXISTS, AND IS VERIFIED AT THE DATABASE LAYER.**

Draft PR #57 adds the disconnect path this gate required: a connected-status display,
a two-step disconnect control in Settings, and a read path for the status. The removal
behaviour was verified against a real Postgres rather than asserted, by
`tests/sql/outlook-disconnect-runtime.sql`, and again over real HTTP through real PostgREST by `tests/local/outlook-rpc-postgrest.mjs`. Both flags remain off.

What was required, and what the verification actually found:

| Required on disconnect | Where it lives | Verified outcome |
|---|---|---|
| The connection row | `microsoft_connections` | **deleted** |
| The encrypted access and refresh tokens | `microsoft_tokens` | **deleted** (composite FK cascade) |
| The delta cursors and lease state | `outlook_sync_state` | **deleted** (composite FK cascade) |
| Any unconsumed OAuth state | `microsoft_oauth_states` | **deleted** |
| Any pending or deferred suggestions | `interaction_candidates`, `new_contact_candidates` | **emptied, NOT deleted** - see below |
| (not previously listed) The link from a suggestion to a mail item | `outlook_candidate_refs` | **deleted** (cascade) |

**The suggestion row is not deleted.** `run_microsoft_local_cleanup()` sets its status to
`invalidated` and NULLs every `proposed_*` field, every draft and the retained subject,
leaving an empty provenance shell. The schema enforces the emptying independently:
`ncc_terminal_erased` and `interaction_candidates_terminal_draft_erased` forbid a
non-pending row from holding that content at all. Every user-visible description in the
branch says "emptied", never "deleted", and a test fails if that wording drifts.

Contacts and interactions the user already saved are **kept**. Disconnecting a mailbox
is not a request to delete their CRM. The SQL test sweeps every user-scoped table in the
schema, so an Outlook table added later that disconnect forgets to clear will fail there
rather than go unnoticed.

**Still open: upstream revocation.** Deleting a refresh token locally does not invalidate
it at Microsoft, and no revocation call exists in this codebase. Nothing in the branch
claims otherwise: the disclosure and the confirmation both state that disconnecting
removes Funnl's copy and does not withdraw the permission at Microsoft, and point the
user at their Microsoft account permissions page. A test asserts that every sentence
mentioning revocation or withdrawal is a negative one.

**One forward migration was needed, and only one.** The removal behaviour needed none -
**One forward migration was added for the status read, and its justification was overstated.**
An earlier version of this section said the `authenticated` role "holds no table privilege" on
`microsoft_connections` "so a browser query is denied". Measured afterwards on a disposable
database with real roles: there is no TABLE-level grant, so `select=*` returns 42501 - but a
COLUMN-level grant already exposes exactly the non-secret columns (`ms_email`, `status`,
`needs_reauth`, `connected_at`, `consented_at`, `consent_policy_version`, `scopes`,
`account_type`, `last_result_code`, `last_success_at`, `updated_at`), and a select naming only
those returns **200** through PostgREST, scoped to the owner by RLS. So the browser could already
read the reviewable columns and `20260929000000` was **not strictly necessary**; it is a preferred
single contract that cannot be widened by editing a select. The migration's own header records the
correction. `20260929000000` adds
`get_my_outlook_connection()` (SECURITY DEFINER, STABLE, zero arguments,
`authenticated`-only) returning only the fields the card displays, and never a token,
ciphertext, nonce, connection id or Microsoft account id. It is **unapplied**.

**CURRENT STACK — six unmerged Draft PRs, none deployed.**

| PR | Adds | Deployed? |
|---|---|---|
| #54 | OAuth start + callback binding gate; forward migration `20260928000000` adding `User.Read` | no; migration **unapplied** |
| #55 | Callback token exchange, id_token validation, Graph `/me`, finalization | no |
| #56 | Settings **Connect Outlook** UI + draft just-in-time disclosure | no; flag off |
| #57 | Connected status + user-controlled disconnect; forward migration `20260929000000` adding the status read path | no; migration **unapplied**; flag off |
| #58 | Bounded, dormant Inbox/Sent **metadata pass** and a private worker endpoint | no; both worker flags unset; endpoint answers 501 |
| #59 | Outlook **candidate write path** (forward migration `20260930000000`), the manually triggered run, and the **suggestion review surface** | no; migration **unapplied**; worker flags and `VITE_OUTLOOK_REVIEW_ENABLED` all unset |

Nothing in the stack syncs a mailbox, creates a contact or logs an interaction, and
no Outlook OAuth flow has ever run against Microsoft.

**THE ONE DIVERGENCE BETWEEN A AND C, unresolved.** Artefact A is live and tells readers
Outlook would use *one* delegated permission. Artefacts B, C and D name **two**, because Graph
`GET /me` — the only way to satisfy `ms_email NOT NULL` — cannot be called without `User.Read`,
which Microsoft describes as reading the signed-in user's full profile and basic company
information. Until A is revised to match, or the design changes to avoid `User.Read`, **no
Outlook consent may be collected.** Nothing in the current branches publishes or alters A.

On every other material fact — the two-step read, reading shortlisted message text, storing no
message bodies, sending Anthropic a minimized pseudonymized extract, Anthropic's 30-day
retention with the 2-year and 7-year exceptions, no Zero Data Retention agreement, no
per-record deletion, and review-before-save — A and C now say the same thing, and a test
asserts C does not omit a fact A states.

Artefact C is what `OUTLOOK_DISCLOSURE_VERSION` identifies. That variable is unset in
every environment, and `outlook-oauth-start` refuses to mint a state without it, so no
consent can be recorded today even by accident. The version string and the text it
names must be approved **together**: a version sent without its matching displayed
text would be evidence of nothing.

**What exists where — code in a Draft branch is not code in Production.**

| | In the repository | Deployed to Production |
|---|---|---|
| Outlook schema (`microsoft_connections`, `microsoft_tokens`, `microsoft_oauth_states`, `outlook_sync_state`) | yes, on `main` | **yes, applied** (`20260921000000`, `20260922175616`) — all tables hold **zero rows** |
| `User.Read` scope migration `20260928000000` | yes, in **Draft PR #54 only** | **no — unapplied** |
| Connection-status migration `20260929000000` | yes, in **Draft PR #57 only** | **no — unapplied** |
| Candidate-write migration `20260930000000` | yes, in **Draft PR #59 only** | **no — unapplied** |
| `outlook-oauth-start` / `outlook-oauth-callback` Edge Functions | yes: start + binding gate in **Draft PR #54**, token exchange and finalization in **Draft PR #55** | **no — never deployed**, and dormant behind `OUTLOOK_INTEGRATION_ENABLED` (unset) |
| Settings UI: consent card, connected status, disconnect | yes, in **Draft PRs #56 / #57** — `SettingsPage.jsx` does import the card on those branches | **no** — the import exists in the bundle but the card never mounts. It now needs **both** `VITE_OUTLOOK_CONNECTION_ENABLED === 'true'` **and** the viewer to be the designated account (`VITE_OUTLOOK_PILOT_USER_ID`); both are unset. The first flag is **global**, so on its own it would show the card to every user — which is why the second condition exists. Neither authorizes anything: see §4a |
| Mailbox import worker | yes, in **Draft PRs #58 / #59** — the metadata pass, the run orchestrator and a private endpoint | **no** — never deployed; the endpoint answers 501 `no_token_access_path` and is dormant behind two unset flags |
| Suggestion review surface (show / edit / accept / dismiss) | yes, on `main` for Calendar; extended to Outlook in **Draft PR #59** | **no** — the whole surface is gated, and both `VITE_CALENDAR_INGESTION_ENABLED` and `VITE_OUTLOOK_REVIEW_ENABLED` are unset |
| Scheduler for the worker or for context expiry | no | no |
| Entra app **registration** | n/a (not a repository artefact) | **yes — registered**: client ID `af27b250-da0b-443e-bcac-38a67737d640`, work/school **and** personal accounts, one **Web** redirect URI `https://www.getfunnl.com/api/outlook-oauth-callback`, delegated `Mail.Read` + `User.Read`. The earlier personal-account registration is **superseded and must not be used.** |
| Client secret, token-encryption key, fingerprint HMAC key, `OUTLOOK_DISCLOSURE_VERSION`, `OUTLOOK_WORKER_SECRET` | no | **no — none configured** |
| `OUTLOOK_PILOT_USER_ID` (**function environment** — the authoritative gate) | n/a | **no — unset, so nobody can connect or be imported** |
| `VITE_OUTLOOK_PILOT_USER_ID` (**build-time, presentation only** — hides the Settings card from other users) | n/a | **no — unset, so the card renders for nobody** |
| Admin consent / a user ever completing the Microsoft prompt | n/a | **no — no round trip has ever happened**; nothing has been granted and no token has ever existed |

So: the Outlook OAuth flow, the Settings consent card, connected status and disconnect all
**exist in unmerged Drafts**, and the Settings card is even imported there. None of it is
reachable: no Outlook Edge Function has ever been deployed, no Outlook OAuth flow has ever
run, no client secret or encryption key is configured for one to use, no consent has ever
been collected and no Microsoft round trip has ever completed, both
build flags are unset, both forward migrations are unapplied, and every Outlook table in
Production holds zero rows. The public Privacy Policy date is the owner-approved
**September 27, 2026**, which is the date of the text **currently live**. That approval
is historical: it attached to the previous wording, not to the revision in this packet.

> **THIS REVISION IS NOT APPROVED AND NOT PUBLISHED.** The Outlook section and the
> consent notice quoted below are Draft. They need the owner’s review, and publishing
> them needs a separate commit carrying the **real publication date** — not
> September 27, 2026, which has passed. Pilot consent must not be collected against
> the live page while it still describes the superseded wording.

Prepared against merged `main` `ef4aa21827fb3675620bb516e0432f39ddb79247`; updated for the
four-PR Outlook stack #54 (`8f27553`) → #55 (`827414b`) → #56 (`549954c`) → #57 (`20f1b2d`),
all of which are **unmerged, unapplied and undeployed**.

---

## 0. CURRENT STATE — read this before the inventories below

**The inventories in sections 4 onwards are HISTORICAL.** They were written for the
envelope-only pilot and describe the state at that time. Several of their "not
configured" and "never collected" statements are no longer true, and one earlier
revision of this packet repeated them as current. This section is the accurate
summary; where it disagrees with anything below, this section is right.

### Three different values, and they are not interchangeable

| What | Where | Current state |
|---|---|---|
| `OUTLOOK_DISCLOSURE_VERSION` | Supabase config, read by `outlook-oauth-start`, stamped into the OAuth state | **Was configured in Production** for the envelope-only text (`ol-disc-81fe8944fd2be59ac3c059c229b4d28e`). That is not an inference: the pilot account connected and completed a real mailbox import, and that function refuses with `config_missing` unless the configured value matches the text it shows. **Its value today has not been read from this branch and is not asserted here.** |
| The version derived from the notice in this packet | `src/lib/outlookDisclosure.js`, computed from the paragraph array | **`ol-disc-f142258e3aa0fdc3c47a53af92a648f5`**. New, and configured nowhere. |
| `REQUIRED_CONTENT_CONSENT_VERSION` and `REQUIRED_THIRD_PARTY_CONSENT_VERSION` | `supabase/functions/shared/outlookContentConsent.js` | **Both `null`.** These are the two gates that decide whether the server reads a body and whether anything goes to Anthropic. While they are null it does neither — whatever any connection recorded, and whatever the server disclosure version is set to. |

### What that means in practice

- **A consent notice has been published, and consent has been collected.** The
  envelope-only disclosure was published and the pilot connection recorded its
  version. Statements below that no Outlook disclosure has ever been published, or
  that no consent has ever been collected, are historical and were true when written.
- **The content release is not reachable.** The two worker constants are null, so the
  body read and the Anthropic call are both closed for every connection. That is the
  gate that matters, and it is independent of (1).
- **The pilot cannot be upgraded in place.** `consent_policy_version` is copied out of
  the OAuth state at finalization. The pilot recorded the envelope-only version, and
  the two documents say opposite things about body reading, so it must disconnect and
  reconnect. The old version is deliberately not accepted as an alternative.
- **Whether `outlook-oauth-start` currently answers `config_missing` is unknown from
  here.** It depends on the value of (1), which has not been read. Do not assume
  either answer without a read-only check.

---

## 1. What this packet covers

1. The conditional Outlook section **already published** at `/privacy` (artefact A) — quoted
   here for comparison only. **This pass does not change it.**
2. The just-in-time consent copy shown immediately before the Microsoft OAuth state is minted
   (artefact C). It **is implemented**, in `src/lib/outlookDisclosure.js` and
   `src/components/OutlookConnectionCard.jsx` in Draft PRs #56 / #57, and is **unapproved,
   unconfigured and unreachable**: the card mounts only when
   `VITE_OUTLOOK_CONNECTION_ENABLED` is exactly `true` (it is unset everywhere) and
   `outlook-oauth-start` refuses without `OUTLOOK_DISCLOSURE_VERSION` (also unset).
3. The consent mechanics the applied schema already enforces.
4. An evidence table mapping every public claim to committed code, the applied migration, or an
   official provider document.
5. Owner/legal decisions and downstream technical blockers.

---

## 2. Proposed just-in-time consent copy

Shown **before** the Microsoft authorization redirect and before any OAuth state row is
created. Affirmative action required; no pre-selected checkbox, no implied consent, no
"continue means you agree".

> **STATUS: NOT PUBLISHED — THIS text, this version.** The paragraphs below are a
> draft for review and the version derived from them is configured nowhere.
>
> That is narrower than the claim this box used to make. It said no Outlook disclosure
> had ever been published, that `OUTLOOK_DISCLOSURE_VERSION` was not configured in any
> environment, and that no consent had ever been collected. **All three were out of
> date**: the envelope-only disclosure was published, the server version was
> configured in Production, and the pilot connected under it. See section 0.

**THIS IS THE CONTENT RELEASE.** It replaces the eleven envelope-only paragraphs rather
than adding to them: three of those eleven state the opposite of what this release does,
and a notice that both promises and denies body reading is evidence of nothing. The
replacements are tabulated in `docs/outlook-content-disclosure-draft.md` section A.

The twenty-one paragraphs below are **quoted from `src/lib/outlookDisclosure.js` verbatim**,
character for character, because the version is derived from those exact strings. A test
re-reads the array and fails if this section paraphrases any of them.

> 1. Connecting Outlook is optional. Funnl works fully without it.

> 2. Access is restricted to one designated Funnl-controlled test account. Funnl’s servers refuse a connection request from any other account.

> 3. You would grant six Microsoft scopes. Two of them read data, and both are read-only: Mail.Read (“Read user mail”) and User.Read (“Sign in and read user profile”). Three are the standard sign-in scopes openid, profile and email. The sixth, offline_access, grants no new access of its own — it is what lets Funnl keep using those two read permissions while you are not using the app, so a read can run without asking you to sign in again.

> 4. Microsoft grants those two more broadly than Funnl uses them. Mail.Read is granted at the mailbox level: it would technically permit reading message bodies and attachments anywhere in your mailbox. User.Read permits your profile and basic company information; Funnl asks it for three fields and uses them only to record which mailbox is connected. Neither requires administrator consent by default, but a work or school tenant can be configured to require an administrator to approve the app, and then you may not be able to consent for yourself.

> 5. Funnl reads message envelopes — who sent each message, who it was addressed to, the subject, the times, which conversation it belongs to and whether it is a draft — from your Inbox and Sent Items. Where you and one other person have both written in the same exchange, Funnl also reads the text of those messages, so it can draft a short summary of what was discussed. It does not read one-sided exchanges, does not read attachments, and does not act on newsletters, mailing lists, automated notifications or automatic replies. Funnl can never send, reply, delete, move or change anything in your mailbox, and does not read your Microsoft contacts, calendars, files or your organisation’s directory.

> 6. For one exchange Funnl reads at most six messages: the most recent ones, with up to two from each side kept back so a reply from either of you is always included. Each message is trimmed to 4,000 characters and at most 12,000 characters are used across the whole exchange, so where messages are long fewer than six are used and the oldest are left out. Funnl reads the current message rather than the quoted history below it, and removes tracking markup and hidden characters first. The other person’s signature block is kept, up to 600 characters, because it is the only place a name is reliably stated; your own signature is not sent anywhere. The subject line is trimmed to 160 characters.

> 7. To write the summary, Funnl sends that cleaned text to Anthropic, the company that provides Funnl’s AI. Anthropic receives the message text, the subject, the date, and a label saying which side wrote each message — you and the other person are labelled only as USER and CONTACT rather than by address. When Funnl is proposing someone who is not yet one of your contacts, it also sends the display name your mail provider shows for that person, because that name is what the proposal is for.

> 8. This is not anonymous, and Funnl does not claim it is. The message text and the signature block are what the two of you wrote, so they can contain names, employers, phone numbers or anything else either of you put in an email, and Funnl does not try to strip that out. Assume the extract can identify the people in the exchange. What Funnl does guarantee is narrower and checkable: your email address, the other person’s email address, their email domain, your Microsoft account and tenant details, Microsoft message and conversation identifiers, authorisation tokens, attachments and raw headers are not included, and the outgoing request is checked for each of them before it is sent.

> 9. Anthropic’s published policy for its API is to delete inputs and outputs from its systems within 30 days of receiving or generating them. Three things can extend that: where its automated systems flag something as violating its usage policy, the inputs and outputs may be kept for up to 2 years and the resulting trust-and-safety classification scores for up to 7 years; it may keep data where the law requires it, or as necessary to act on usage-policy violations; and a customer can negotiate different terms, including zero retention. Funnl has no zero-retention agreement with Anthropic, so this is not zero-retention processing.

> 10. A suggestion keeps the summary, the suggested next step, the subject line, the contact, the date, the type (Email) and one-way fingerprints of the exchange, so the same conversation is not suggested twice. The message text itself is discarded once the summary is written — it is not saved to Funnl’s database and not written to any log. The fingerprints are pseudonymous but are stored against your account, so they are personal data about you; they cannot be turned back into a message, an address or a subject line.

> 11. When the other person is not already one of your contacts, Funnl will propose adding them. The proposed email address comes from the message itself and the proposed name from the name your mail provider shows for the sender or from their signature. Funnl will not guess a company, a job title, how you met, a LinkedIn profile or a tag — those fields are left blank for you to fill in if you want them.

> 12. Nothing enters your network until you accept it. Funnl stores the suggestion so it is still waiting when you come back. Before accepting you can edit the name, the company, the role, how you met, the relationship, the tags, the summary, the interaction type, the date and the follow-up date. The email address is the one exception: it is taken from the message itself and shown read-only — it is the one part of the proposal Funnl did not infer, and it is what identifies the person.

> 13. You accept, edit or dismiss a suggestion — there is no deferral option. Accepting creates the contact and the first interaction together. You can also choose to save the contact without logging the conversation — the interaction is a checkbox you can clear. Dismissing a suggestion creates neither and deletes the draft.

> 14. Where an exchange is unclear, Funnl sets it aside rather than guessing: more than one other person involved, a message Funnl could not read, a message whose headers your provider did not return, or a summary that did not come back usable. In those cases you get no suggestion for that exchange and nothing is written — never a suggestion with an empty note.

> 15. While a read is in progress Funnl keeps working records, one per conversation it is part-way through, and — once you have agreed to body reading — an encrypted reference to each message it has selected, so it can read them once both folders have been examined. Those references are encrypted with the same key as the synchronisation state and hold no subject, address, name or body.

> 16. They belong to that single read, which becomes unusable 24 hours after it starts. Becoming unusable is not the same as being erased: they are actually removed when a later read starts, when a read completes, when a read is reset, or when you disconnect. Waiting, or looking at the progress of a read, removes nothing — so if a read is abandoned and none of those happens, its working records stay stored.

> 17. A suggestion you never act on carries a 30-day review window, and what that window does depends on which button you press. After it passes, Funnl will not let you accept the suggestion: it tells you the suggestion has expired and takes it off the list on screen. But it stays stored, still waiting, and comes back the next time the page loads — so accepting is not a way to clear an expired suggestion.

> 18. Dismissing it does work, and is not refused by that window. Dismissing marks the suggestion dismissed and erases the drafted summary, the suggested next step and any proposed email address and name in the same step. Nothing acts on the deadline on its own, so an expired suggestion stays stored until you dismiss it, disconnect, delete the contact it refers to, or delete your Funnl account.

> 19. You can disconnect at any time from this screen. That deletes the connection, the stored Microsoft authorisation, the mailbox synchronisation state, the working records, the message references and the provenance records, and invalidates any suggestion you have not reviewed. An invalidated suggestion is not deleted: it keeps the contact, the date and its fingerprint so the same exchange is not suggested again, and it goes when you delete that contact or your Funnl account.

> 20. Disconnecting removes Funnl’s copy of the authorisation, so Funnl has nothing left to start a new read with. A read already under way may finish using access it had already obtained. Disconnecting does not withdraw the permission at Microsoft — to do that, remove Funnl from the permissions page of your Microsoft account.

> 21. Funnl’s Privacy Policy sets all of this out in full, including what is kept and when it is deleted.

These are the complete contents of `OUTLOOK_DISCLOSURE_PARAGRAPHS`. The card renders
each as a paragraph and shows nothing else as disclosure.

**Consent version:** derived, not declared. It is computed from the text above as
`ol-disc-<first 32 hex of SHA-256 over the paragraphs joined by newline>`, so any edit
produces a different version and the server's exact-string gate refuses the stale one.

The derived version for this text is **`ol-disc-f142258e3aa0fdc3c47a53af92a648f5`**
(fingerprint `f142258e3aa0fdc3c47a53af92a648f5`). **Not approved, and configured nowhere.**
The server's `OUTLOOK_DISCLOSURE_VERSION` is not set to it; what that variable is set
to today has not been read from this branch. Independently of it, both worker consent
constants in `supabase/functions/shared/outlookContentConsent.js` are `null`, so the
server performs no body read and no third-party call regardless of what any connection
recorded. See section 0 for the three values kept apart.

The previous value, `ol-disc-81fe8944fd2be59ac3c059c229b4d28e`, identified the
envelope-only text and is what the live pilot connection recorded. It is deliberately
**not** accepted as an alternative: the two documents say opposite things about body
reading, so that connection must disconnect and reconnect rather than be treated as
having agreed to this one.

The wording and the three server values must be approved together — approving one
without the others is self-defeating, since the version moves with the text.

---

## 3. Consent mechanics the applied schema already enforces

These are not proposals; migration `20260921000000` already enforces them.

| Mechanic | Enforcement |
|---|---|
| Consent is recorded **before** the OAuth state exists | `finalize_microsoft_connection` copies `consented_at` and `consent_policy_version` **from the consumed state row**, never from a caller argument |
| The state stores evidence, not prose | `microsoft_oauth_states` holds a state hash, user, timestamps and policy version — there is no column for disclosure text |
| Single-use, locked state | finalization selects the state `FOR UPDATE` and consumes it; a second use cannot succeed |
| Ownership is derived, not supplied | the RPC takes `p_expected_user_id` and matches it against the state's own `user_id` |
| Active connection implies the permissions | `microsoft_connections_active_requires_mail_read` — status `active` requires **both** `Mail.Read` and `User.Read` in `scopes` (tightened by migration `20260928000000`) |
| Only the canonical permissions may be stored | `microsoft_connections_scopes_allowlist` — `scopes` must be a subset of `Mail.Read, User.Read, offline_access, openid, email, profile` (extended by migration `20260928000000`) |
| Consent version is always present | `consent_policy_version` is `NOT NULL`, 1–40 chars, no control characters or whitespace |
| Re-authorization needs fresh consent | a new connection requires a new state row, which requires a new `consented_at` / `consent_policy_version` |

**Resolved since this section was written.** Draft PR #55 implements the callback, so the
refusal path is now defined rather than open: `handler.js` looks the state up first and refuses
an unknown, already-consumed or expired state **before any request reaches Microsoft**, and
only the `'stored'` result of `finalize_microsoft_connection` counts as success. Finalization
consumes the state under `FOR UPDATE`, so a second use cannot succeed. That behaviour is in a
Draft branch and undeployed; it is not a Production fact.

---

## 4. Evidence table — every public claim to its source

| # | Public claim | Evidence |
|---|---|---|
| 1 | Outlook is not available / not enabled / not in pilot | **No Outlook Edge Function is deployed** (12 deployed, none Outlook). The `outlook-oauth-start` / `outlook-oauth-callback` sources and their `config.toml` sections exist in **Draft PRs #54 / #55 only**, are unmerged and undeployed, and are inert unless `OUTLOOK_INTEGRATION_ENABLED` is exactly `true` (unset everywhere). The Settings card IS imported by `SettingsPage.jsx` on **Draft PRs #56 / #57**, and is gated by `OUTLOOK_CONNECTION_ENABLED`, which requires `VITE_OUTLOOK_CONNECTION_ENABLED === 'true'` and is unset in every environment — so the code ships in the bundle and the card never mounts. An Entra app is now **registered** (client ID `af27b250-da0b-443e-bcac-38a67737d640`) but **no client secret, encryption key, fingerprint key, disclosure version or `OUTLOOK_PILOT_USER_ID` is configured**, nothing is deployed, no consent has ever been granted, there is no scheduler, and every Outlook table holds **zero rows**. Separately, the server-side **single-account pilot gate** refuses both connecting and importing for anyone but one designated account, and refuses **everyone** while that account is unset (§4a) |
| 2 | Delegated `Mail.Read`, read-only, user-authorized | [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) — "Read user mail", "Allows the app to read email in user mailboxes", admin consent **not** required; `GRAPH_MAIL_READ_SCOPE = 'Mail.Read'` in `outlookGraphTransport.js`; schema `microsoft_connections_active_requires_mail_read` |
| 3 | Mail.Read is mailbox-wide and would technically permit bodies/attachments | Same reference — Mail.ReadBasic is the variant that *excludes* body and attachments; migration comment: "$select minimization in the worker never narrows the authority Mail.Read grants; the policy discloses it" |
| 4 | Inbox and Sent Items only | `GRAPH_FOLDERS = ['inbox','sentitems']`; schema `oss_folder_check` |
| 5 | Envelope fields read first | `DISCOVERY_SELECT` = id, conversationId, receivedDateTime, sentDateTime, isDraft, subject, from, sender, toRecipients, ccRecipients |
| 6 | Body text read only for messages that pass the check | `CONTENT_SELECT` issued per message after deterministic screening; `MAX_CONTENT_FETCHES_PER_RUN` |
| 7 | Plain-text body and quoted-history-excluded body | `Prefer: outlook.body-content-type="text"`; `uniqueBody` in `CONTENT_SELECT`; [Graph get message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0) Example 3 |
| 8 | Exactly five automation headers | `automationFactsFromHeaders` reads only `auto-submitted`, `precedence`, `list-id`, `list-unsubscribe`, `x-auto-response-suppress`; pinned by `outlook-core-scans.test.js` |
| 9 | Header collection reduced then discarded | `readMessageContent` returns only `automation` facts + `automationComplete`; `internetMessageHeaders` appears exactly twice in executable transport code (select + classifier call) |
| 10 | No attachments / raw MIME / send / write / contacts / calendars / files / shared mailbox | No such builder exists; `FORBIDDEN_PATH_FRAGMENT_RE` refuses `$value`, `/attachments`, `/send`, `/reply`, `/forward`, `/move`, `/copy`, `/users/`, `/contacts`, `/calendar`, `/events`, `/drive`, `/mailboxsettings`; GET-only, `/me`-rooted |
| 11 | Raw bodies not stored | No module touches a database/client/RPC/storage/file; the applied schema defines no body/snippet/HTML/MIME/attachment/header column |
| 12 | Anthropic receives a minimized, pseudonymized extract | `buildUserContent` emits `USER`/`CONTACT` labels; `assertRequestMinimization` rejects addresses and tokens; domain deliberately withheld |
| 13 | 30-day Anthropic retention, not ZDR | [Anthropic retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-personal-data) — "automatically delete inputs and outputs … within 30 days"; code states "This is NOT zero data retention" |
| 14 | Up to 2 years flagged, 7 years classification scores | Same source — "retain inputs and outputs for up to 2 years and trust and safety classification scores for up to 7 years" |
| 15 | No training on commercial API data by default | [Model training](https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training) and [API deletion](https://privacy.claude.com/en/articles/7996875-can-you-delete-data-that-i-sent-via-api) — "We do not use API data for training (unless you have an agreement with us that states otherwise)" |
| 16 | Funnl cannot promise per-record Anthropic deletion | [API deletion](https://privacy.claude.com/en/articles/7996875-can-you-delete-data-that-i-sent-via-api) — "For paid API customers, we do not support ad hoc deletion." |
| 17 | Stored fields and their limits | Migration `20260921000000`: summary 1–200, follow-up 1–160, name/company/role/how-met 1–120, LinkedIn ≤255 matching `linkedin.com/in/`, subject ≤160, evidence enums `provider_metadata`/`explicit_signature`/`explicit_body`, confidence `high`/`medium`, `extraction_status`, fingerprints `^[0-9a-f]{64}$`, `key_version` |
| 18 | Tokens and sync cursor stored encrypted | `microsoft_tokens` = ciphertext + nonce + `key_version`; `outlook_sync_state.delta_link_ciphertext` + nonce + `delta_key_version`; both tables service-role only, RLS on, no `authenticated` grant or policy |
| 19 | Nothing created automatically; accept / dismiss / defer | No module performs any write; `accept_new_contact_candidate`, `dismiss_new_contact_candidate`, `defer_candidate` are the only user paths and are `authenticated`-only |
| 20 | Proposed email is envelope-derived and AI cannot supply it | `accept_new_contact_candidate` takes **no email parameter** and uses `v_cand.proposed_email`; validator rejects any AI output key matching `email/e_mail/mail_address/address` |
| 21 | Email fixed at acceptance, editable afterwards | Accept RPC inserts `v_email` into `contacts.email`; `AddContactDrawer` (the edit form) exposes an editable email input and updates `contacts` |
| 22 | Disconnect behaviour, and the exact difference between deleted and emptied | **Executed against a real Postgres**, not read off the source: `tests/sql/outlook-disconnect-runtime.sql` seeds two users with a connection, tokens, sync cursors, an OAuth state, a pending suggested interaction, a pending suggested contact and the mail links, calls `disconnect_my_outlook()` as one of them, and asserts the four deletions plus `outlook_candidate_refs`, that both candidate rows REMAIN with status `invalidated` and all content NULL, that the other user is untouched, and that no other user-scoped table in the schema retains a row. `ncc_terminal_erased` and `interaction_candidates_terminal_draft_erased` enforce the emptying independently of the RPC |
| 23 | Provenance records hold no provider identifiers | `outlook_candidate_refs` stores connection id, fingerprints and key version only — no message/conversation id, address or subject |
| 24 | The browser can read its own connection status without a service-role key or a table grant | `20260929000000` adds `get_my_outlook_connection()`: SECURITY DEFINER, STABLE, **zero arguments**, `REVOKE ALL … FROM PUBLIC, anon, service_role` then `GRANT EXECUTE … TO authenticated`. It returns mailbox, account type, status, needs_reauth, connected_at, consent version and scopes, and never a token, ciphertext, nonce, key version, connection id or Microsoft account/tenant id. `tests/sql/outlook-connection-status-runtime.sql` asserts the refusal without a session, the caller-follows-identity behaviour, an allowlist over the returned keys, the grants, and that `authenticated` still holds **no** SELECT on `microsoft_connections`. No file under `src/` mentions a service-role key (asserted by `tests/outlook-disconnect-ui.test.js`) |
| 25 | A pending Outlook suggestion can be written only by the worker, only under a live lease, and only for a contact the user already has | `20260930000000` adds `upsert_outlook_interaction_candidate`: SECURITY DEFINER, `service_role` only (`REVOKE ALL … FROM PUBLIC, anon, authenticated`), fenced on `outlook_sync_state.sync_run_id` + `sync_status = running` + `sync_lease_until > now()` with the state row locked `FOR SHARE` in the release RPC's lock order, refusing `contact_required` when no contact is supplied and `contact_not_owned` when the contact belongs to someone else. It writes only `interaction_candidates` and `outlook_candidate_refs`, and every content column (`proposed_notes`, `retained_subject`, `draft_summary`, `draft_follow_up`, `summary_evidence`) is left NULL. Proven over real HTTP through PostgREST against a real Postgres by `tests/local/outlook-first-suggestion.mjs` |
| 26 | No interaction exists until the user explicitly accepts, and the saved note is the user's own | The worker performs no `INSERT INTO interactions`; only `accept_interaction_candidate` does, and it is `authenticated`-only and keyed on `auth.uid()`. The same harness asserts zero interactions before the accept, then a single interaction carrying the user's overridden type, date and note, with `source = outlook`. A dismissed or accepted exchange is tombstoned and never suggested again |

---

## 4a. The single-account pilot restriction

A first real pilot has to be limited to **one** designated mailbox. Before this change it
could not be, and the reason is worth stating precisely, because two things look like
controls and are not.

**What was actually in place, traced:**

| Gate | What it controls | Can it name one account? |
|---|---|---|
| `OUTLOOK_INTEGRATION_ENABLED` (`outlook-oauth-start`) | the OAuth start endpoint, for **every** authenticated Funnl user or none | no — all-or-nothing |
| `reserve_due_outlook_connection` | picks whichever **active, consented, due** connection exists, for **any** user | no — it has no user predicate, so invoking the worker by hand restricts nothing: the reservation chooses the connection, not the caller |
| `VITE_OUTLOOK_CONNECTION_ENABLED`, `VITE_OUTLOOK_REVIEW_ENABLED` | what the browser bundle renders | **no, and never could** — a flag in a browser cannot refuse a request |

So a single-account pilot was **not** possible with the previous configuration, and
account isolation must not be inferred from either a client-side flag or a manual worker
invocation.

**What is in place now.** One function-environment variable, `OUTLOOK_PILOT_USER_ID`,
holding one user id, checked by one predicate
(`supabase/functions/shared/outlookPilotGate.js`) at exactly two server-side points:

1. **Connecting** — `outlook-oauth-start` checks it *after* authentication and *before*
   any state is minted, answering `403 not_in_pilot`. Gating start is sufficient for
   connecting at all: the callback only **reads** a state (it never mints one),
   `microsoft_oauth_states` is `service_role`-only with RLS on, and
   `finalize_microsoft_connection` takes the new connection's owner from the state row
   (`v_uid := v_state.user_id`), never from the request. A refused user therefore has
   nothing for the callback to finalize.
2. **Importing** — enforced in the **reservation itself**, which is the only place it can
   be. `reserve_due_outlook_connection` had no user predicate, so it handed the run
   whichever connection was due for anybody, and the run could not learn whose it was
   until it had loaded the context — a load that decrypts their tokens and, for an
   **expired** access token, refreshes it at Microsoft's token endpoint and persists the
   result. Checking afterwards was therefore too late. Measured, before the change, for a
   non-pilot connection with an expired token:

   ```
   {"outcome":"not_in_pilot","tokenEndpointCalls":1,"tokenGrant":"refresh_token",
    "accessTokenRewritten":true,"expiryRewritten":true,"tokenRowWritten":true,
    "foldersLeased":2}
   ```

   A real provider call on an excluded user's behalf, and their stored credentials
   rewritten. Migration `20261003000000` adds one optional `p_pilot_user_id` argument
   and one conjunct, so only the designated account's due connection can be reserved;
   the result also reports `user_id`, which lets the run verify the owner before loading
   anything. The same measurement after:

   ```
   {"outcome":"none_due","tokenEndpointCalls":0,"accessTokenRewritten":false,
    "expiryRewritten":false,"tokenRowWritten":false,"foldersLeased":0}
   ```

   `none_due` rather than a refusal, which is the stronger answer: an excluded
   connection is no longer refused, it is never offered.

---

## 4b. Retention, as measured rather than assumed

Every claim the published section and the consent notice make about when Outlook-derived
records go away is verified in `tests/sql/outlook-pilot-retention-runtime.sql` against a
real Postgres with all 26 migrations. The wording was corrected where the measurement
contradicted it.

| Claim | Measured | Wording consequence |
|---|---|---|
| The 24-hour round deadline deletes the working records | **No.** Seeded a record whose `round_expires_at` passed 2 days earlier and made no call: still present. The deadline makes the round **unusable**, nothing more | The text says a read becomes *unusable* after 24 hours and is explicit that the deadline deletes nothing |
| `read_outlook_round_progress` deletes them | **No.** It returns `result: ok` with `round_expired: true` and leaves the rows | Not described as a cleanup step anywhere |
| A refused checkpoint or an **incomplete** release deletes them | **No.** Both leave the record in place | This is why the pilot must END BY DISCONNECTING (§7 item 5c) |
| Something deletes them | **Yes, four things:** a checkpoint under a **new** round (the next read), `reset_outlook_round`, a **complete** release, and disconnect | The text names exactly these triggers |
| An expired suggestion disappears without a scheduled sweep | **No.** 45 days past `context_expires_at` it was still present and still **`pending`** | The policy states that removal is event-driven and that no scheduled job acts on the deadline today |
| The sweep, when called, deletes the suggestion | **No.** `expire_pending_outlook_context` reported `expired: 1` and the row remained, status `invalidated`, with `contact_id`, the date and a 64-character fingerprint intact | Described as invalidation, not deletion |
| Disconnect removes all Outlook-derived records | **No.** It removes the connection, the credentials, the sync state, the working records and the provenance refs (1 → 0) — **the suggestion row survives**, still carrying `contact_id`, the proposed date and the fingerprint | The row is **never** called empty, and never called deleted |
| Deleting the related contact removes it | **Yes** — `interaction_candidates.contact_id REFERENCES contacts(id) ON DELETE CASCADE` | Claim retained |
| Deleting the account removes it | **Yes** — cascades from `auth.users`, verified on a throwaway user so the fixture users survive | Claim retained |

**What a pilot row does and does not hold.** Measured: zero rows holding a retained
subject, draft summary, next step or notes — the envelope-only write path never writes
those columns. **That is not the same as holding nothing derived from the mail.** The row
names a contact, carries a proposed date, and carries one-way fingerprints, and all three
are computed **from message envelopes**. They are personal data about the account holder
and the counterparty, the sweep does not touch them, and no schedule removes them.

So the absent cleanup schedule is a **real retention limit**, not an irrelevance. What
the absence of message text changes is its *severity*, not its existence: an expired
suggestion left pending indefinitely retains envelope-derived personal data until the
owner acts. That is tolerable for one owner-controlled account that can disconnect and
delete at will; it is not tolerable for unattended operation, nor for a user who cannot.
It gets worse, not newly real, once the body/AI path ships.

**Not described anywhere, because it does not exist:** the D2 90-day cross-round
recognition record. No migration or function contains it (§6.14).

   **It also fixes starvation.** The ordering is
   `min(last_success_at) ASC NULLS FIRST, c.id ASC`. A connection that has never
   succeeded sorts first, and being refused is not succeeding — so one excluded
   connection returns to the head of the queue every `RETRY_BACKOFF_SECONDS` (300 s)
   for ever, and at a five-minute cadence it takes every invocation. Reproduced over
   three invocations as `committed, not_in_pilot, none_due`; after the change,
   `committed, committed, committed`.

   With `p_pilot_user_id` NULL the selection is byte-for-byte the previous one, which is
   the behaviour to keep while no pilot is configured.

**It fails closed, and that is the point.** With `OUTLOOK_PILOT_USER_ID` unset — or set to
anything that is not a well-formed uuid, including `*` or `true` — **nobody** may connect
or be imported. Enabling Outlook therefore requires deliberately naming the one account,
rather than opening it to every authenticated user by forgetting a second variable. The
variable is required configuration: the worker refuses to run without it, alongside the
client secret and the two keys.

**The browser flags are still not access control, and enabling them is not a pilot.**
`VITE_OUTLOOK_CONNECTION_ENABLED` and `VITE_OUTLOOK_REVIEW_ENABLED` are compiled into
the public bundle and apply to **every** signed-in user. Switching
`VITE_OUTLOOK_CONNECTION_ENABLED` on would offer the Connect card to all of them and
refuse all but one server-side — safe, but a dead end for everybody else. So the card's
guard now also requires the viewer to be the designated account
(`outlookPilotViewer` in `src/lib/outlookConnection.js`, reading a **separate**
`VITE_OUTLOOK_PILOT_USER_ID`). That check is **presentation only**: it hides a dead end,
it authorizes nothing, and a user can edit a value in their own browser. The
authoritative gates are the two server-side ones above.

Two consequences worth stating rather than discovering:

* **The two variables can diverge.** A stale `VITE_OUTLOOK_PILOT_USER_ID` shows the card
  to somebody the server will refuse, or hides it from the real pilot. Neither is a
  security failure; both are confusing. Set them together.
* **The bundle then contains one user id.** Not a credential — a signed-in user can
  already read their own id — but it does reveal *which* account is piloting to anyone
  who reads the bundle. Accepted for a one-account pilot, and a reason to unset it when
  the pilot ends.

**This is not a feature-flag framework** — one server variable, one predicate, three
server-side enforcement points plus one presentation check. The normal Outlook flags
stay off and are unchanged.

**Evidence, and which kind each is.** A source assertion is not behavioural coverage, so
the authorization boundary is executed in three places:

| What | Where | Kind |
|---|---|---|
| Another authenticated user gets **403 `not_in_pilot`** with **zero state inserts**, no binding cookie and no authorization URL; the designated account mints exactly one state; unset or malformed designation refuses **everyone** | `tests/outlook-start-integration.test.js` (36 checks, `FUNNL_EDGE_INTEGRATION=1`) | **executed against the real Deno handler** in a container, with a sink that records every state insert |
| The reservation selects **only** the designated account; an excluded connection is left with **no folder rows at all**; the starvation ordering; `none_due` rather than a fallback; the both-folder fence and the `narrows, never widens` cases; one function, `SECURITY DEFINER`, `search_path` pinned, `authenticated`/`anon` refused EXECUTE | `tests/sql/outlook-pilot-reservation-runtime.sql` | **executed against a real Postgres** with all 26 migrations |
| An excluded connection with an **expired** token causes **no `/token` call, no rotation write, no lease and no cursor**; two due connections and every invocation goes to the pilot while the excluded row stays byte-for-byte unchanged | `tests/local/outlook-worker-token-access.mjs` (41 checks) | **executed through the real worker handler** over real HTTP, real PostgREST, real Postgres |
| The predicate's fail-closed behaviour, the import-side refusal touching nothing, a reservation that omits `user_id` being refused, a malformed designation making **zero database calls**, and the **ordering** of the four gate points | `tests/outlook-pilot-gate.test.js` (24 checks) | behavioural on the predicate and the run; **structural** only for ordering, which no single request can show |

All of it is **fixture-only** in the sense that matters: every Microsoft response is
written by these tests, no mailbox is involved, nothing is deployed, and no consent has
ever been collected.

## 5. Claims deliberately NOT made (and why)

| Not claimed | Reason |
|---|---|
| A Funnl-side "context deleted after 30 days" promise | The schema **caps** `context_expires_at` at `created_at + 30 days`, but `expire_pending_outlook_context` is **unscheduled** — `pg_cron` is not installed, there is no `cron` schema, and no migration schedules it. Nothing currently erases expired context. Promising a schedule would be false. **Owner decision + implementation required.** |
| "Your tokens are encrypted" as present tense | No OAuth flow has ever RUN (the Draft PR #54 code is undeployed and dormant, and although an Entra app is now registered, no client secret or token-encryption key is configured and no Microsoft round trip has ever completed), so no token exists. The schema would store them encrypted; the policy says "would be". Token encryption is a **launch requirement**, below. |
| "Funnl employees never read your email" | Too absolute. The drafted wording allows support-with-permission, security investigation, and legal requirement — and separately discloses that Anthropic runs its own safety systems and may review flagged content under their policy. |
| A specific history/lookback window | No import worker exists in any branch, so no lookback is implemented and none may be promised. |
| That the Microsoft consent screen shows Funnl's Privacy/Terms links | The [consent experience](https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience) documents the prompt's building blocks (publisher, verification badge, permissions, report link) and does not confirm Terms/Privacy links appear there. Confirm at registration. |
| That the app is verified or certified | Unverified publishers display "**Unverified**" in the consent prompt. Publisher verification is an owner decision. |
| That disconnecting revokes Funnl's access at Microsoft | **No upstream revocation call exists in this codebase.** `disconnect_my_outlook()` is a local teardown: it deletes Funnl's copy of the refresh token, but that token stays valid at Microsoft until it expires or the user removes Funnl from their account permissions. Both the disclosure and the disconnect confirmation state this and point the user at Microsoft, and a test asserts that every sentence mentioning revocation or withdrawal is a negative one. **Owner decision: whether to implement an upstream revocation call before the pilot.** |

---

## 6. Owner / legal decisions required

- [ ] 1. Exact public-policy wording (the drafted `Outlook connection (not yet available)` section).
- [ ] 2. Exact consent-dialog wording (§2 above).
- [ ] 3. The Anthropic 30-day retention disclosure.
- [ ] 4. The "up to 2 years" flagged-content exception.
- [ ] 5. The "up to 7 years" classification-score retention.
- [ ] 6. Stating that Funnl cannot obtain ad hoc Anthropic deletion.
- [ ] 7. Human-access wording (support / security / legal, plus Anthropic safety review).
- [ ] 8. Whether a separate Terms of Service update is required.
- [ ] 9. Microsoft Entra **Privacy Statement URL** and **Terms of Service URL** values, and whether
      to pursue publisher verification (unverified apps show "Unverified" at consent).
- [ ] 10. The Funnl-side history window **and** the context-erasure schedule — currently undefined
      and unenforced; see §5.
- [x] 11. The launch-time publication date for the text **now live**.
      **Owner/product decision: September 27, 2026** (superseded September 20, 2026).
      **Historical.** That decision covered the wording published then.
- [ ] 11a. **A publication date for the revised wording in this packet.** September 27,
      2026 has passed, so it cannot be reused: publishing this revision requires a new
      owner-approved date set in the publication commit itself. Until then the live page
      keeps its current date and its current (superseded) text, and pilot consent must
      not be collected.
- [ ] 12. Authorization for a one-account pilot, **and which mailbox**. The restriction is
      server-enforced and fails closed (§4a), so the pilot cannot begin until the owner
      names one Funnl user id for `OUTLOOK_PILOT_USER_ID`. Until it is set, nobody can
      connect or be imported — the intended resting state.

      **The criterion is a usable mailbox, not which kind of account it is.** Choose a
      Funnl-controlled Microsoft account with a **confirmed working Inbox and Sent Items**
      — confirmed by opening the mailbox and seeing mail in both folders, because the
      worker reads exactly those two (`GRAPH_FOLDERS`) and an exchange needs both sides to
      become a suggestion. Populate them with synthetic mail created for the test.

      **The account used to register the Entra application is not, by itself, evidence of
      a usable mailbox.** Registration proves directory access, not mail provisioning: an
      account can own an app registration and have no Exchange licence, no mailbox, or an
      empty one. Verify the mailbox separately from the registration.

      A **personal Outlook.com** account is acceptable for the first pilot if it meets
      that criterion. It does **not** validate the work/school path: a tenant may require
      administrator approval of the app regardless of the no-default-admin-consent
      position, and Microsoft’s risk-based step-up consent can block consent to an
      unverified multitenant app from a tenant other than the registration tenant. Those
      remain untested until a work/school account is used, and no claim is made here that
      consent will succeed on either kind of account.
- [ ] 13. Whether disconnect must also revoke the grant at Microsoft before the pilot. A local
      disconnect is implemented and verified; upstream revocation is not implemented and is not claimed.
- [ ] 14. **The per-conversation continuation record — one policy bullet, and one product choice.**
      Durable continuation (migration `20261002000000`, dormant and unapplied) persists a
      per-conversation record while a sync round is being read, because a two-sided exchange can
      span pages, invocations and both folders and hosted Edge Functions cannot read a mailbox in
      one invocation. Two things need an owner.

      **(a) The policy list does not name it.** The published `What Funnl would keep` list is
      exhaustive. Every *field kind* in the new record is already disclosed there — one-way keyed
      fingerprints with a key version, timestamps, counts, short result codes — but the record
      itself is not, and the synchronization bullet says "position", not "partial conversation
      state". Proposed wording, to be added as a new bullet **inside** the existing
      `What Funnl would keep` list and nowhere else:

      > *while a mailbox is being read:* a temporary record per conversation, holding only one-way
      > keyed fingerprints (with the key version) of the conversation, the person and the first
      > message, whether each side has replied, how many messages were seen, the first and last
      > times, and short result codes. It exists so an exchange split across several reads is
      > recognized as one conversation, contains no message content, subject, email address or
      > Microsoft identifier, and is erased when that read finishes.

      **(b) How long may it live?** As implemented it is **round-scoped**: erased when the round
      commits, and erased for any superseded or expired round the moment a new round starts. That
      recognizes an exchange split across pages, invocations, or Inbox and Sent Items. It does
      **not** recognize one where the reply arrives in a *later* round — you email someone today,
      they answer next week — because by then the earlier half is no longer remembered. Nothing is
      skipped and no cursor moves past unprocessed mail; that exchange is simply never suggested.
      Making it work means keeping per-conversation state *between* rounds, which is a materially
      heavier commitment: a durable, growing record of how many conversations a user has, when each
      was last active, and which involve a tracked contact — needing a retention window, a deletion
      path, an answer for what disconnecting does to it, and a different policy bullet.
      **The implementation deliberately chose the minimal option and did not decide this.**

      A **concrete decision sheet** for the cross-round option — the minimum retained fields
      (keyed fingerprints, two booleans rather than message counts, two timestamps, the matched
      contact id), a proposed **90-day rolling retention** from the last message seen with the
      reasoning and the rejected alternatives, **deletion on disconnect** via the existing
      cascade plus an assertion in the disconnect runtime test, and the **exact replacement
      privacy wording** — is in `docs/outlook-durable-continuation-design.md` §6, under "D2 as a
      decision sheet". Nothing in it is implemented; it exists so the choice can be made on
      specifics. Note that approving it would add a second expiry path while
      `expire_pending_outlook_context` is still unscheduled (§7 item 5).

---

## 7. Downstream technical blockers (each needs its own authorization)

1. ~~Entra app registration.~~ **Done** — client ID `af27b250-da0b-443e-bcac-38a67737d640`,
   registered on the organizational account, supporting work/school **and** personal
   Microsoft accounts. The earlier personal-account registration is superseded and must
   not be used. Registration alone changes nothing at runtime: no secret, no key, no
   deployment, no consent, no round trip.
2. **Redirect URI matches; consent configuration still open.** The single registered
   **Web** redirect URI is `https://www.getfunnl.com/api/outlook-oauth-callback`, which is
   character-for-character `EXPECTED_OUTLOOK_CALLBACK_URL` in
   `supabase/functions/shared/microsoftOauthHelpers.js`; the start endpoint requires an
   exact match, and the **Web** platform is what makes `response_mode=form_post` valid.
   Delegated `Mail.Read` and `User.Read` are registered, matching
   `OUTLOOK_OAUTH_SCOPES`. Still open: the Privacy Statement / Terms URLs (§6 item 9),
   publisher verification, and whether anyone has consented — nobody has.
3. Outlook fingerprint HMAC key and key version provisioning (injected today; does not exist).
4. OAuth start and callback, including token encryption at rest and the refusal path.
5. Worker, lease, bounded cursor reset, and candidate persistence — **including scheduling or
   otherwise invoking `expire_pending_outlook_context`**, without which §5's retention gap stands.
5c. **Ending the pilot: disconnect, do not merely stop calling the worker.**
   1. **Disconnect the designated account** from Settings. Stopping worker invocations
      is NOT equivalent: a refused checkpoint and an incomplete release both leave the
      working records in place (measured, §4b), and nothing else will remove them.
   2. **Verify the result on the real database, after the migrations are eventually
      applied, before claiming the cleanup happened.** §4b was measured on a disposable
      database with all 26 migrations; Production has 19 applied and 7 pending, so the
      cascade that removes the working records does not exist there yet. The claim is
      verified for the code, not for Production.
   3. Expect the **invalidated suggestion row to remain**, carrying its contact, date and
      fingerprint. Remove it by deleting the contact or the account. Do not report it as
      gone.
   4. Revoke at Microsoft separately if required: remove Funnl from the permissions page
      of the Microsoft account. Disconnect does not do this and does not claim to.
   5. Unset `VITE_OUTLOOK_PILOT_USER_ID` so the designated id leaves the public bundle.

   **Standing limit for anything broader.** `expire_pending_outlook_context` is still
   unscheduled, so an expired suggestion stays pending indefinitely. Acceptable for one
   owner-controlled account that can disconnect; **not** acceptable for unattended
   operation or for users who cannot. No scheduler is added here.

5b. **The browser flags are global, and turning them on is not a pilot.**
   `VITE_OUTLOOK_CONNECTION_ENABLED` applies to every signed-in user. The Settings card
   additionally requires the viewer to be the designated account, which is
   **presentation only** (§4a) — it hides a dead end rather than authorizing anybody.

   **How the first controlled browser test actually runs**, in order:
   1. The server gates are configured first: `OUTLOOK_PILOT_USER_ID` set to the one
      Funnl user id, alongside the client secret and the two keys. Until it is set,
      `outlook-oauth-start` answers **403 `not_in_pilot`** to everybody and the
      reservation can select nobody.
   2. `VITE_OUTLOOK_PILOT_USER_ID` is set to the **same** id and
      `VITE_OUTLOOK_CONNECTION_ENABLED` to `true`, then the frontend is deployed. The
      card is now rendered for that one account and for nobody else. If the two values
      disagree, the card appears for somebody the server refuses — confusing, not
      unsafe.
   3. The pilot signs in **in their own browser** and uses the card. The request must
      come from the browser, not from a terminal: the response sets
      `__Host-fnl_ms_oauth_bind`, and the callback will not accept a state without the
      matching cookie. This is also why the branded `/api/outlook-oauth-*` rewrites
      must be live — a cookie set by `*.supabase.co` is never sent to
      `www.getfunnl.com`.
   4. They consent at Microsoft and land back on `/api/outlook-oauth-callback`.
   5. The import is triggered by hand with `OUTLOOK_WORKER_SECRET`. No scheduler is
      needed for this; one is needed only for unattended operation.
   6. Afterwards, unset `VITE_OUTLOOK_PILOT_USER_ID` to take the id back out of the
      public bundle.

5a. Durable continuation is now built and dormant (migration `20261002000000`,
   `outlookContinuedPass.js`, `outlookRoundState.js`). It removes the old blocker that a mailbox
   past the per-invocation ceilings could never make progress. It adds §6.14 above — one policy
   bullet and one retention decision — and leaves two ceilings open: worst-case context loading
   (285 s) still exceeds one free-plan invocation, and an invalid *committed* deltaLink still has no
   restart (only a saved `nextLink` does).
6. Review UI and accept / dismiss / defer wiring.
7. Pilot authorization.
8. Scheduling, last.

Non-blocking engineering note: add an explicit plain-object/prototype guard to
`outlookContentSanitizer.js` for symmetry with the other four modules.

---

## 8. Publication checklist

1. Owner/legal sign-off on every box in §6.
2. Implement blockers 1–6 in §7 under separate authorization.
3. Decide and implement the retention/erasure schedule, then update the policy wording to match.
4. The "Last updated" date is now the approved **September 27, 2026**. If the merge slips past that day, change it again in the merge commit to the real
   date and rewrite the section from conditional ("would") to present tense.
5. `tests/privacy-policy-outlook.test.js` must be updated in that same commit — it currently pins
   both the conditional framing and the September 20 date and will fail if either is changed
   without deliberate intent.
