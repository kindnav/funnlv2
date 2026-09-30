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
deployed, no migration from the stack is applied, both flags are off, no Entra application
exists, and every Outlook table in Production holds zero rows. "It exists in a Draft branch"
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
| Settings UI: consent card, connected status, disconnect | yes, in **Draft PRs #56 / #57** — `SettingsPage.jsx` does import the card on those branches | **no** — the import exists in the bundle but the card never mounts: `VITE_OUTLOOK_CONNECTION_ENABLED` is unset, and the predicate requires exactly `'true'` |
| Mailbox import worker | yes, in **Draft PRs #58 / #59** — the metadata pass, the run orchestrator and a private endpoint | **no** — never deployed; the endpoint answers 501 `no_token_access_path` and is dormant behind two unset flags |
| Suggestion review surface (show / edit / accept / dismiss) | yes, on `main` for Calendar; extended to Outlook in **Draft PR #59** | **no** — the whole surface is gated, and both `VITE_CALENDAR_INGESTION_ENABLED` and `VITE_OUTLOOK_REVIEW_ENABLED` are unset |
| Scheduler for the worker or for context expiry | no | no |
| Entra registration, client secret, token-encryption key, `OUTLOOK_DISCLOSURE_VERSION` | no | no |

So: the Outlook OAuth flow, the Settings consent card, connected status and disconnect all
**exist in unmerged Drafts**, and the Settings card is even imported there. None of it is
reachable: no Outlook Edge Function has ever been deployed, no Outlook OAuth flow has ever
run, no Entra application exists to run it against, no consent has ever been collected, both
build flags are unset, both forward migrations are unapplied, and every Outlook table in
Production holds zero rows. The public Privacy Policy date is the owner-approved
**September 27, 2026** and must not change until the publication commit.

Prepared against merged `main` `ef4aa21827fb3675620bb516e0432f39ddb79247`; updated for the
four-PR Outlook stack #54 (`8f27553`) → #55 (`827414b`) → #56 (`549954c`) → #57 (`20f1b2d`),
all of which are **unmerged, unapplied and undeployed**.

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

Shown **before** the Microsoft authorization redirect and before any OAuth state row is created.
Affirmative action required; no pre-selected checkbox, no implied consent, no "continue means
you agree".

> **STATUS: NOT PUBLISHED.** The text below is a draft for review. No Outlook
> disclosure has been published to users, `OUTLOOK_DISCLOSURE_VERSION` is not
> configured in any environment, and no consent has ever been collected.
> `outlook-oauth-start` refuses to mint a state while that variable is unset.

> ### Connect Outlook?
>
> Connecting Outlook is optional. Funnl works fully without it.
>
> You would grant two Microsoft permissions, both read-only. Mail.Read ("Read user mail") lets Funnl read messages in your Inbox and Sent Items. User.Read ("Sign in and read user profile") lets Funnl identify which mailbox you connected.
>
> Microsoft describes User.Read as allowing an app to read the signed-in user’s full profile and basic company information. Funnl asks it for three fields only — your account id, your mail address and your user principal name — and uses them only to record and display which mailbox is connected. The permission permits more than Funnl requests, which is why both are stated here.
>
> Mail.Read is mailbox-wide: it would technically allow reading message bodies and attachments anywhere in your mailbox. Funnl reads only Inbox and Sent Items, and never opens attachments.
>
> Funnl can never send, reply, delete, move or change anything in your mailbox. It does not read your Microsoft contacts, calendars or files, and it does not read your organisation’s directory, your colleagues or your manager.
>
> Funnl would read those two folders in two steps. First the envelope of each message — who sent it, who it was addressed to, the subject, the times, which conversation it belongs to and whether it is a draft — to decide whether the message is worth reading at all. Then, only for the messages that pass that check, the message text itself: Microsoft’s plain-text version of the body and the version that leaves out the quoted reply history, plus five headers that identify newsletters, mailing lists and automatic replies. Those five are reduced to yes/no facts and then discarded.
>
> Funnl does not store your emails. Message text is held in server memory only while a message is being processed. Funnl’s database has no column that can hold a message body, HTML, raw MIME, an attachment, a preview snippet or a collection of headers.
>
> To turn an exchange into a draft you can edit, Funnl would send Anthropic (Claude) a minimized extract: the message text, an optional signature block, a shortened subject, the direction and the date. The two people are labelled only USER and CONTACT. Email addresses, the recipient’s email domain, Microsoft account, tenant, message and conversation identifiers, authorisation tokens, attachments and raw headers are not included.
>
> Anthropic deletes API inputs and outputs within 30 days. Funnl does not have a Zero Data Retention agreement. If Anthropic’s automated systems flag content as violating their Usage Policy, Anthropic may keep those inputs and outputs for up to 2 years, and the related trust-and-safety classification scores for up to 7 years. Anthropic does not train its models on commercial API data by default, and does not offer per-record deletion to paid API customers, so Funnl cannot promise to have an individual record deleted on request.
>
> What Funnl would do with all of this: suggest networking contacts and draft interaction notes from relevant conversations. Nothing is saved as a contact or logged as an interaction until you review it and choose to accept it. You can edit or dismiss every suggestion.
>
> You can disconnect at any time from this screen. Disconnecting deletes the connection, the stored Microsoft authorisation and the mailbox synchronisation state, and empties any suggestion you have not reviewed: each becomes inactive and its proposed details and drafts are removed. Contacts and interactions you already saved are kept.
>
> Disconnecting removes Funnl’s copy of the authorisation, so Funnl has nothing left to start a new read with. A read already under way may finish using access it had already obtained. Disconnecting does not withdraw the permission at Microsoft — to do that, remove Funnl from the permissions page of your Microsoft account.
>
> [Read the Privacy Policy](/privacy)
>
> `[ I have read this ]` (unchecked)   `[ Connect Outlook ]`   `[ Cancel ]`

**These are the exact strings, not a paraphrase.** They are copied from
`OUTLOOK_DISCLOSURE_PARAGRAPHS` in `src/lib/outlookDisclosure.js`, and
`tests/outlook-consent-ui.test.js` fails if this document and that array ever diverge, so a
reviewer approving the text here is approving the text a user would see.

**WHY IT IS THIS LONG.** An earlier draft of the card described the permissions and the
folders and then jumped to "suggestions", omitting the material processing: that shortlisted
message text is actually read, and that a minimized extract of it leaves Funnl for Anthropic.
Artefact A already discloses both. A short notice at the decision point may summarise the
published policy but must not say LESS than it about what happens to the user's mail, so the
two-step read, the absence of body storage, Anthropic and Anthropic's real retention terms
are all named here. Tests assert each of those facts appears in both.

**Consent version:** derived, not declared. Draft PR #56 computes it from the
disclosure text (`ol-disc-<32 hex of SHA-256>`), so any edit to the wording produces a
different version and the server's exact-string gate refuses the stale one. The current
draft value is `ol-disc-34f8d13dc657d2d6ca6377f0c93ca427`. **Not approved.** The server's
`OUTLOOK_DISCLOSURE_VERSION` is unset in every environment, so `outlook-oauth-start`
refuses with `config_missing`. The wording and the server value must be approved together —
approving one without the other is self-defeating, since the version moves with the text.

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
| 1 | Outlook is not available / not enabled / not in pilot | **No Outlook Edge Function is deployed** (12 deployed, none Outlook). The `outlook-oauth-start` / `outlook-oauth-callback` sources and their `config.toml` sections exist in **Draft PRs #54 / #55 only**, are unmerged and undeployed, and are inert unless `OUTLOOK_INTEGRATION_ENABLED` is exactly `true` (unset everywhere). The Settings card IS imported by `SettingsPage.jsx` on **Draft PRs #56 / #57**, and is gated by `OUTLOOK_CONNECTION_ENABLED`, which requires `VITE_OUTLOOK_CONNECTION_ENABLED === 'true'` and is unset in every environment — so the code ships in the bundle and the card never mounts. No Entra app, no secret, no flag, no worker, no scheduler; every Outlook table holds **zero rows** |
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

## 5. Claims deliberately NOT made (and why)

| Not claimed | Reason |
|---|---|
| A Funnl-side "context deleted after 30 days" promise | The schema **caps** `context_expires_at` at `created_at + 30 days`, but `expire_pending_outlook_context` is **unscheduled** — `pg_cron` is not installed, there is no `cron` schema, and no migration schedules it. Nothing currently erases expired context. Promising a schedule would be false. **Owner decision + implementation required.** |
| "Your tokens are encrypted" as present tense | No OAuth flow has ever RUN (the Draft PR #54 code is undeployed and dormant, and no Entra app exists), so no token exists. The schema would store them encrypted; the policy says "would be". Token encryption is a **launch requirement**, below. |
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
- [x] 11. The launch-time publication date. **Owner/product decision: September 27, 2026** (supersedes September 20, 2026). If the merge happens after that day, the date must be updated again in the merge commit.
- [ ] 12. Authorization for a one-account real-mailbox pilot.
- [ ] 13. Whether disconnect must also revoke the grant at Microsoft before the pilot. A local
      disconnect is implemented and verified; upstream revocation is not implemented and is not claimed.

---

## 7. Downstream technical blockers (each needs its own authorization)

1. Entra app registration.
2. Redirect URIs and consent configuration.
3. Outlook fingerprint HMAC key and key version provisioning (injected today; does not exist).
4. OAuth start and callback, including token encryption at rest and the refusal path.
5. Worker, lease, bounded cursor reset, and candidate persistence — **including scheduling or
   otherwise invoking `expire_pending_outlook_context`**, without which §5's retention gap stands.
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
