# Phase E1 — Email Classifier Foundation (design)

Provider-neutral, deterministic email-classification foundation. **Pure functions only** —
no network, no DB, no secrets, no OAuth, no migrations, no UI, no feature flags. Gmail and
Outlook raw-response adapters (transport) are deferred to E2/E3. Calendar code is untouched;
this reuses the Calendar engine's *design principles* (bounded input, fail-closed, injected
crypto, controlled codes) without importing or modifying `calendarSyncEngine.js`.

## Modules (all in `supabase/functions/shared/`)
- `emailProviderContract.js` — the normalized message shape + fail-closed structural/privacy validator.
- `emailAddress.js` — conservative mailbox parsing, normalization, exact contact matching.
- `emailAutomation.js` — reason-coded automation / bulk-list classification.
- `emailFingerprint.js` — versioned HMAC-SHA256 fingerprint (injected key).
- `emailConversationClassifier.js` — grouping, episodes, qualification, controlled outcomes.

## 1. Normalized message contract
Metadata-only, provider-independent (`NormalizedMessage`):
`provider` (`gmail|outlook`), `providerMessageKey`, `providerConversationKey`, `timestampIso`
(ISO-8601 **UTC** instant), `fromAddress` (raw header), `toAddresses[]`, `ccAddresses[]`,
`subject` (**transient** input; sanitized/capped only after eligibility — never persisted/logged
before), `automation` (allowlisted facts: `autoSubmitted`, `precedence`, `hasListId`,
`hasListUnsubscribe`, `hasAutoResponseSuppress`), `folderHint` (`inbox|sent|unknown`).

**Prohibited (validator rejects):** body, bodyPreview, uniqueBody, snippet, html, textBody,
attachments, inline content, tracking data, raw headers, raw provider response, mime content.
`classifyNormalizedMessage()` also rejects prototype-pollution keys and oversized fields,
returning a **controlled code** (never a field value).

## 2. Address parser — behavior & limitations
`normalizeEmail` = **trim + lowercase only** (never strips Gmail dots or `+tags`, never resolves
aliases). `parseAddressList` handles bare addr-specs, `"Name" <addr>`, quoted display names with
commas, whitespace, mixed case, multiple recipients, group syntax (`Group: a, b;`), RFC 2047
encoded display names (ignored — only the addr-spec is extracted), and `(comments)`; it
**dedupes** and records `hadMalformed` without exposing content. `parseSingleAddress` (From) returns
`null` unless exactly one valid mailbox is present. **Not full RFC 5322:** no quoted local-parts,
no domain IP-literals, no in-addr comments — these **fail closed** (no address, flagged malformed).
`matchContactByEmail` is exact after normalization and scoped to the syncing user; two owned
contacts on the same normalized address return **`ambiguous_contact`** (never an arbitrary pick).
**MVP owned mailbox = the verified connected provider address only** (no alias inference).

## 3. Automation / bulk filtering (reason-coded)
- **Episode hard-reject (`bulkListReason`):** `List-ID` → `list_id`; `List-Unsubscribe` →
  `list_unsubscribe`; `Precedence: bulk|list|junk` → `precedence_bulk`. Participant-cap is enforced
  in the classifier.
- **Exclude a single message from human counts (`nonHumanReason`):** `Auto-Submitted != no` →
  `auto_submitted`; `X-Auto-Response-Suppress` → `auto_response_suppress`; no-reply/mailer-daemon
  sender local-part → `no_reply_sender`; calendar-notification sender or invitation subject →
  `calendar_notification`; delivery-failure subject → `delivery_failure`; out-of-office subject →
  `out_of_office`. Subject heuristics use the transient subject **in memory only**.
- Excluding one automated message does **not** invalidate an otherwise-human exchange; the
  remaining human messages must independently satisfy every qualification rule. All results are
  **controlled codes only** — never an address, subject, provider id, or header value.

## 4. Qualification & episode rules
Group by `providerConversationKey`; sort by `(timestampIso, providerMessageKey)`; split into
**episodes** when the gap between consecutive **human** messages exceeds **7 days**. A
**contact-episode** is `eligible` only when: the contact is owned by the user and matched by exact
normalized email; ≥1 inbound human message **authored by the contact**; ≥1 outbound human message
from the verified user mailbox with the contact **directly in `To`** (CC-only outbound never
qualifies); ≥2 qualifying human messages; external participants ≤ **10**; the episode has been
**quiet ≥ 24h**; no strong bulk/list evidence; all timestamps/keys determinable. Multiple contacts
may each qualify from one conversation independently. **Suggested date** = date of the latest
qualifying human message; **type** = `Email`. A sanitized subject preview (≤160, control-stripped,
whitespace-normalized) is produced **only after** eligibility. The **episode boundary / fingerprint
input** is the **first qualifying message key** (never a bare date).

## 5. HMAC fingerprint — format, version, rotation
`emailFingerprint.computeEmailFingerprint(fields, { subtle, keyBytes, keyVersion })` →
**64 lowercase hex** (satisfies the existing `source_fingerprint` `^[0-9a-f]{64}$` CHECK), keyed
(HMAC-SHA256, irreversible — unlike the unkeyed Calendar SHA-256). Committed inputs (length-prefixed
canonical, `format|keyVersion|provider|accountNamespace|contactId|conversationKey|firstMessageKey`):
boundaries can't be forged (collision-resistant). The **key is dependency-injected** (no real
secret in E1). Store `keyVersion` alongside each fingerprint so rotating the key/version yields new
fingerprints for **new** candidates without silently altering existing stored ones. The key and raw
inputs are never logged.

## 6. Outcome codes (controlled)
`eligible`, `one_way`, `cc_only`, `ambiguous_contact`, `no_contact_match`, `active_conversation`,
`bulk_or_list`, `participant_cap`, `insufficient_human_messages`, `automation_only`,
`malformed_message`, `undeterminable_date`, `missing_conversation_key`.
**Completeness truthfulness:** intentional filters (bulk/one_way/cc_only/…) are *normal completed*
outcomes and do NOT set `complete=false`; only malformed/unprocessed messages
(`malformed_message`/`undeterminable_date`/`missing_conversation_key`) do. Provider retrieval
caps/truncation/lease/DB errors are an **E2+** concern, not classifier-intrinsic.

## 7. Outlook header recommendation (no Graph call made)
Microsoft Graph offers no Gmail-style per-header selection. Two explicit modes for future Outlook
transport:
1. **`Mail.ReadBasic` message properties only** (from/to/cc/subject/dates/conversationId) — simplest
   and lowest-exposure, but **weaker automation filtering** (no `Auto-Submitted`/`List-*`/
   `X-Auto-Response-Suppress`), so more `bulk_or_list`/automation slips through as false positives.
2. **Select `internetMessageHeaders`** under strict response-byte caps, then **immediately keep only
   the allowlisted automation facts and discard the rest** (never stored/logged).
**Recommendation:** default to **Mode 2 with strict byte caps + immediate discard**, because
accurate automation/list suppression materially reduces false-positive suggestions and matches the
allowlist model already used for Calendar; fall back to Mode 1 only if byte caps prove unreliable.
This is a design recommendation — no Graph request is made in E1. (Owner decision: confirm Mode 2.)

## 8. Future schema / RLS / RPC design corrections (NOT implemented in E1)
- Widen CHECKs **backend-first**: `interaction_candidates_source_check` and
  `interactions_source_check` add `gmail`,`outlook`; `google_oauth_states_integration_check` adds
  `gmail`. `proposed_type` already allows `Email`; `interactions.type` is freeform.
- New service-only **email reference** table: **one episode/conversation reference per candidate**
  (not a mailbox message index). RLS on (defense-in-depth), **no anon/authenticated grant**,
  service-role RPC access only, explicit length + ownership constraints. Store an **HMAC** for
  equality/dedup; store an **encrypted** conversation/thread reference **only if** reversible
  retrieval is later required; **no raw provider id** exposed to clients and none stored unless a
  proven future need arises.
- Email sync-state (per connection+folder) + lease/run-id RPCs mirroring the Calendar lease
  contract. All new RPCs: SECURITY DEFINER, `search_path=''`, service-role EXECUTE only.

## 9. Future capability / token-failure semantics (documented; not implemented)
- `google_connections` stays **one identity/token relationship per user+Google account**. Future
  `google_connection_capabilities` rows independently represent `calendar` and `gmail` scope/status.
- **Missing/lost Gmail scope** → Gmail capability `needs_reauth` (Calendar unaffected). **Missing/lost
  Calendar scope** → Calendar capability `needs_reauth` (Gmail unaffected). **Invalid/revoked refresh
  credential** → connection-wide failure affecting every capability using that credential.
- A Gmail consent attempt must **never overwrite a different `google_sub`** (mismatch → error, no
  overwrite). A callback with **no new refresh token must retain the existing encrypted refresh
  token**. Microsoft stays an isolated `microsoft_*` stack behind the same adapter contract.

## 10. Privacy / retention decisions
- Store only what explains + dedupes a suggestion: user/contact/provider, `proposed_type='Email'`,
  proposed date, qualifying-human count, direction/reason enum, HMAC fingerprint, minimal service-only
  reference, and a **sanitized subject only after qualification (≤160 chars, control-stripped)**.
- **Never** store/log/fingerprint bodies, previews, HTML, attachments, tracking data, full recipient
  lists, mailbox indexes, subjects (in logs/analytics/fingerprints/errors/status), or raw provider ids
  to clients.
- **Retention:** pending suggestion context expires after **30 days**; on **accept/dismiss/invalidate**
  the stored subject/provider-facing context is erased immediately, preserving only the minimal
  state + HMAC tombstone needed for dedup and transition integrity. An accepted interaction receives
  **only the user-reviewed note** — it never silently inherits hidden/raw provider content.
- **Reconciliation (future, not in E1):** additional messages may refresh a still-pending suggestion;
  they must not invalidate an already-valid historical suggestion merely because the conversation
  resumed; accepted/dismissed/invalidated terminal candidates are never resurrected; a new episode
  after the 7-day gap gets a distinct fingerprint.
- **Privacy-policy gap:** the current policy states Funnl does not request/read Gmail — it must be
  rewritten (metadata-only Gmail + Microsoft third party + Limited Use) **before** any email scope is
  requested in production. `gmail.readonly` is a **restricted** scope requiring OAuth verification +
  an **annual CASA third-party security assessment** — a human/console/legal blocker, not code.
