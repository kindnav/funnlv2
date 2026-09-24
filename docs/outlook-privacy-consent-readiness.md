# Outlook privacy and consent — human-review readiness packet

**Status: DRAFT FOR OWNER/LEGAL REVIEW. Nothing in this packet is published, deployed or
configured.** The Outlook integration does not exist: there is no Edge Function, OAuth flow,
worker, UI, secret, feature flag, scheduler or Entra registration, and every Outlook table in
Production holds zero rows. The public Privacy Policy date remains **September 20, 2026** and
must not change until the publication commit.

Prepared against merged `main` `0ee55eb33ba54ba4527e3a1c2da4fbe2eb332941` (PR #50).

---

## 1. What this packet covers

1. A conditional Outlook section drafted into `src/pages/PrivacyPage.jsx` (not published).
2. Proposed just-in-time consent copy shown immediately before the Microsoft OAuth state is
   minted (not implemented).
3. The consent mechanics the applied schema already enforces.
4. An evidence table mapping every public claim to committed code, the applied migration, or an
   official provider document.
5. Owner/legal decisions and downstream technical blockers.

---

## 2. Proposed just-in-time consent copy

Shown **before** the Microsoft authorization redirect and before any OAuth state row is created.
Affirmative action required; no pre-selected checkbox, no implied consent, no "continue means
you agree".

> ### Connect Outlook?
>
> Connecting Outlook is **optional**. Funnl works fully without it.
>
> **What you would be granting.** One Microsoft permission: **Mail.Read** ("Read user mail").
> It is read-only — Funnl can never send, reply, delete, move or change anything in your mailbox.
> Please note this permission lets an app read your mail generally, including message bodies and
> attachments. Funnl asks for much less than that, as described below, but the permission itself
> is mailbox-wide.
>
> **What Funnl would read.** Messages in your **Inbox** and **Sent Items** only. First just the
> envelope — sender, recipients (To and Cc), their names and addresses, subject, sent/received
> times, the conversation identifier, and whether it is a draft — to decide whether a message is
> worth reading. Then, only for messages that pass that check, the **message text** (Microsoft's
> plain-text body, and the version that excludes the quoted reply history) plus five headers that
> identify automated and bulk mail: `Auto-Submitted`, `Precedence`, `List-Id`, `List-Unsubscribe`,
> `X-Auto-Response-Suppress`. Those headers are turned into simple yes/no facts and then discarded.
>
> **What Funnl would never touch.** Attachments or their contents, raw MIME, your Microsoft
> contacts, calendars or files, shared mailboxes — and it never sends, replies, deletes or
> modifies mail.
>
> **Funnl does not store your emails.** Message text is held in memory only while a message is
> processed. Funnl's database cannot store a message body, attachment or header collection.
>
> **AI.** To turn an exchange into a draft you can edit, Funnl sends **Anthropic (Claude)** a
> minimized extract: the current message text, an optional signature block, a shortened subject,
> the direction and date. The two people are labelled only **USER** and **CONTACT** — no email
> addresses, no domain, no Microsoft identifiers, no tokens, no attachments, no raw headers.
>
> **Anthropic's retention.** Anthropic deletes API inputs and outputs within **30 days**. Funnl
> does **not** have a Zero Data Retention agreement. If Anthropic's automated systems flag content
> as violating their Usage Policy, they may keep it for **up to 2 years**, and the related safety
> classification scores for **up to 7 years**. Anthropic does not train its models on commercial
> API data by default. Anthropic does not offer per-record deletion to paid API customers, so
> Funnl cannot promise to have an individual record deleted on request.
>
> **Nothing is added to your network automatically.** Everything arrives as a suggestion you
> **accept, dismiss, or defer**. A suggested new contact's email address comes from Microsoft's
> message envelope, never from the AI, and is fixed while you accept it — afterwards you can edit
> it like any other contact.
>
> **You can disconnect at any time** from Settings. Disconnecting deletes your Microsoft
> connection, your stored authorization and the sync state, and erases the content of any pending
> suggestion. Contacts and interactions you already accepted stay.
>
> [Read the Privacy Policy](/privacy)
>
> `[ Connect Outlook ]`   `[ Cancel ]`

**Consent version placeholder:** `outlook-content-v1` — a placeholder only. Not implemented, not
written to Production, and the value must be fixed at implementation time.

---

## 3. Consent mechanics the applied schema already enforces

These are not proposals; migration `20260921000000` already enforces them.

| Mechanic | Enforcement |
|---|---|
| Consent is recorded **before** the OAuth state exists | `finalize_microsoft_connection` copies `consented_at` and `consent_policy_version` **from the consumed state row**, never from a caller argument |
| The state stores evidence, not prose | `microsoft_oauth_states` holds a state hash, user, timestamps and policy version — there is no column for disclosure text |
| Single-use, locked state | finalization selects the state `FOR UPDATE` and consumes it; a second use cannot succeed |
| Ownership is derived, not supplied | the RPC takes `p_expected_user_id` and matches it against the state's own `user_id` |
| Active connection implies the permission | `microsoft_connections_active_requires_mail_read` — status `active` requires `Mail.Read` in `scopes` |
| Only the canonical permissions may be stored | `microsoft_connections_scopes_allowlist` — `scopes` must be a subset of `Mail.Read, offline_access, openid, email, profile` |
| Consent version is always present | `consent_policy_version` is `NOT NULL`, 1–40 chars, no control characters or whitespace |
| Re-authorization needs fresh consent | a new connection requires a new state row, which requires a new `consented_at` / `consent_policy_version` |

**Unresolved:** whether a refused or failed callback consumes the state is **not** settled by the
applied RPC in a way I can state publicly — the finalization path consumes the state, but there is
no implemented callback yet to define the refusal path. Decide this when the callback is built.

---

## 4. Evidence table — every public claim to its source

| # | Public claim | Evidence |
|---|---|---|
| 1 | Outlook is not available / not enabled / not in pilot | No Edge Function (12 deployed, none Outlook), no `config.toml` section, no OAuth code, no UI import, no secret, no flag; all Outlook tables zero rows |
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
| 22 | Disconnect behavior | `disconnect_my_outlook` → `run_microsoft_local_cleanup`: invalidates pending/deferred candidates and NULLs every proposed field, deletes OAuth states, deletes `microsoft_connections` (cascading tokens, sync state, provenance refs) |
| 23 | Provenance records hold no provider identifiers | `outlook_candidate_refs` stores connection id, fingerprints and key version only — no message/conversation id, address or subject |

---

## 5. Claims deliberately NOT made (and why)

| Not claimed | Reason |
|---|---|
| A Funnl-side "context deleted after 30 days" promise | The schema **caps** `context_expires_at` at `created_at + 30 days`, but `expire_pending_outlook_context` is **unscheduled** — `pg_cron` is not installed, there is no `cron` schema, and no migration schedules it. Nothing currently erases expired context. Promising a schedule would be false. **Owner decision + implementation required.** |
| "Your tokens are encrypted" as present tense | No OAuth flow exists, so no token exists. The schema would store them encrypted; the policy says "would be". Token encryption is a **launch requirement**, below. |
| "Funnl employees never read your email" | Too absolute. The drafted wording allows support-with-permission, security investigation, and legal requirement — and separately discloses that Anthropic runs its own safety systems and may review flagged content under their policy. |
| A specific history/lookback window | The worker is unbuilt; no lookback is implemented. |
| That the Microsoft consent screen shows Funnl's Privacy/Terms links | The [consent experience](https://learn.microsoft.com/en-us/entra/identity-platform/application-consent-experience) documents the prompt's building blocks (publisher, verification badge, permissions, report link) and does not confirm Terms/Privacy links appear there. Confirm at registration. |
| That the app is verified or certified | Unverified publishers display "**Unverified**" in the consent prompt. Publisher verification is an owner decision. |

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
- [ ] 11. The launch-time publication date (replaces September 20, 2026 in the publication commit).
- [ ] 12. Authorization for a one-account real-mailbox pilot.

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
4. In the **publication commit only**: change "Last updated" from September 20, 2026 to the real
   date and rewrite the section from conditional ("would") to present tense.
5. `tests/privacy-policy-outlook.test.js` must be updated in that same commit — it currently pins
   both the conditional framing and the September 20 date and will fail if either is changed
   without deliberate intent.
