# PR #24 — Stripe Layer D: Billing & Subscriptions

## Current deployment state (verified via read-only `supabase functions list` on 2026-08-14)

Each component is documented separately — the Stripe surface is a **mix** of deployed-but-older-version and not-deployed. Do NOT read this as "all deployed" or "all undeployed."

**Preview vs production:** merging/pushing this PR causes Vercel to automatically build a **PR Preview** deployment. That is NOT a production deployment — the branch frontend is not on `www.getfunnl.com`. "Nothing deployed to production" is accurate; "nothing deployed" is not (a preview exists).

| Component | Deployed? | Prod version | Notes |
|---|---|---|---|
| Migration `20260812000000_add_subscriptions.sql` | **Applied** | — | `subscriptions` table exists; `get_my_pro_access_status()` RPC works; data live |
| Migration ledger for `20260812000000` | Gap (local-only) | — | **Required repair** before next `db push`: `npx supabase migration repair --status applied 20260812000000 --linked` |
| Migration `20260813000000_add_webhook_idempotency.sql` | **NOT applied** | — | Adds `stripe_webhook_events` (+`claim_token`, jsonb `claim_webhook_event()`, `mark_webhook_event()`), the R3/R6 failure codes, and (R6) the partial unique index `subscriptions_stripe_subscription_id_uniq`. Must be applied **before** the updated stripe-webhook is deployed |
| Migration `20260815003056_add_checkout_session_singleflight.sql` | **NOT applied** | — | R1: `checkout_operations` table + `claim_checkout_operation()` / `finalize_checkout_operation()` RPCs (durable server-side checkout single-flight). Generated via `supabase migration new`. Must be applied **before** the updated create-checkout-session is deployed (the new handler calls both RPCs) |
| `create-checkout-session` Edge Function | **Deployed (older version)** | v2 | Live but predates this branch. The older version relies on a browser `attemptId` for idempotency and blocks only active/past_due — it does **not** have the durable single-flight or full status policy. Redeploy from this branch **after** applying `20260815003056`. `verify_jwt = true` |
| `stripe-webhook` Edge Function | **Deployed (older version)** | v4 | Live and has processed Stripe events; `verify_jwt = false` (correct — Stripe carries no Supabase JWT). Predates this branch's idempotency + reliability rewrite (`claim_token`/`mark_webhook_event`, event-shape validation, authoritative field validation, deletion filter, invoice-informational, status allowlist). **Do not redeploy until migration `20260813000000` is applied** |
| `create-billing-portal-session` Edge Function | **NOT deployed** | — | Absent from `functions list`. Requires Stripe Customer Portal configured in the Stripe dashboard first |
| `ai-chat` | **Deployed (subscription-aware)** | v17 | Entitlement check includes subscription state |
| `ai-parse-contact` | **Deployed (subscription-aware)** | v6 | Entitlement check includes subscription state |
| `ai-map-csv` | **Deployed (subscription-aware)** | v6 | Entitlement check includes subscription state |
| `ai-categorize-contacts` | **Deployed (subscription-aware)** | v5 | Entitlement check includes subscription state |
| Frontend (SettingsPage, FunnlAIPage, pro-ui-status, checkoutPolling, useProStatus, stripeUrl) | **NOT merged / NOT deployed** | — | All Stripe UI lives on this branch; awaiting merge to `main` |

**Net effect:** checkout and the webhook are live at older versions, so the billing path partially functions today, but the webhook-idempotency table, the checkout single-flight table, the token-validated finalizes, the authoritative-field/status/period hardening, the identity-uniqueness index, the billing-portal function, and all frontend Stripe UI are **not** in production. Redeploying `create-checkout-session` (after `20260815003056`) and `stripe-webhook` (after `20260813000000`) from this branch is required to pick up the corrections.

**Duplicate-subscription protection is NOT the React guard.** `createActionGuard()` only protects a single mounted component; it does nothing across tabs, devices, sessions, or direct authenticated calls. The authoritative protection is the server-side `checkout_operations` single-flight (R1) plus the full status policy (R2) — both of which require applying `20260815003056` and redeploying the function. Until then, the older live function does **not** have this protection.

## Reliability corrections (sixth review round)

1. **Newest-request-wins Pro status (P1).** A dependency-free `createProStatusController()` (`src/lib/proStatusController.js`) owns request sequencing. Every status request (auth-triggered fetch OR `refresh()`) mints a new token; only the newest token for the unchanged UID may write shared state, so an older same-account refresh that resolves later can never overwrite a newer one and re-lock a paying user. Account changes/sign-out bump the token (and a separate `accountGeneration`); unmount deactivates.
2. **Authoritative auth UID/generation for Settings polling (P2).** The provider now exposes `authUserId` and `accountGeneration` (from the auth session, not a separately-loaded profile). Settings checkout polling does not start until the authoritative UID is known (`shouldStartCheckoutPoll`), captures UID+generation, aborts synchronously on any change, and discards stale results — so an account switch that happens before the profile query finishes is still safe.
3. **Real runtime controllers under test (P3).** Tests import and exercise the production `createProStatusController`, `isStalePollResult`, and `shouldStartCheckoutPoll` (no mirrored business logic), covering overlapping same-UID refreshes (both orderings), UID switch/sign-out/unmount during a refresh, TOKEN_REFRESHED, switch-before-profile-load, polling with unknown UID, switch-during-polling, and stale-confirmed/stale-timeout firing no analytics.
4. **Canonical subscription access policy (P4).** `subscriptionGrantsAccess(status)` is exported from the canonical `subscriptionStatusPolicy.js`; `evaluateProEntitlement()` delegates to it (the hardcoded `active || past_due` allowlist is removed). The SQL RPC cannot import JS, so it MIRRORS the granting set (`v_sub_active := v_sub_status IN ('active','past_due')`); a parity test reads the migration SQL and asserts its granting set equals the JS granting set. This is not one executable source across JS and SQL — it is one JS source plus a tested SQL mirror.
5. **Bounded Stripe network timeouts (P5).** Shared `fetchWithTimeout` (`shared/boundedFetch.js`, ~20s AbortController, timers always cleared) wraps every Stripe call. `create-checkout-session`: timeout is an unknown_failure → retryable 503, operation NOT finalized (preserved for idempotent retry). `create-billing-portal-session`: timeout → retryable 503 with the existing visible error. `stripe-webhook`: authoritative-retrieval timeout finalizes the claimed event with the new controlled code `provider_timeout` (token-safe) and returns 503, so Stripe retries and the event is reclaimable; a finalize failure itself returns 500. No raw error/body/PII is logged.
6. **Webhook ownership metadata cross-check (P6).** `crossCheckOwnership(metaUserId, otherUserId)`: when the authoritative subscription `metadata.user_id` is present AND disagrees with the resolved owner (the Checkout Session user, or the DB owner by subscription/customer id), no write happens — the event finalizes with `ownership_mismatch` and returns retryable 5xx. Missing legacy metadata is NOT required and falls back to the existing customer/subscription ownership checks. Applied to `checkout.session.completed` and `customer.subscription.created/updated`.

## Required migration-ledger repair preflight (P7)

**Do NOT run the repair in this task.** Before ANY future `supabase migration repair --status applied 20260812000000 --linked`, a fresh READ-ONLY production comparison must confirm every physical object from `20260812000000_add_subscriptions.sql` matches the local migration. Repair is permitted only when ALL of the following are verified read-only:

- `public.subscriptions` columns match the migration
- `subscriptions_pkey` exists (PK on `user_id`)
- `subscriptions_stripe_customer_id_idx` exists AND is unique
- `subscriptions_status_check` matches the migration's allowed status set
- FK `user_id` → `auth.users(id)` `ON DELETE CASCADE`
- RLS is enabled on `subscriptions`
- `subscriptions_select_own` is the ONLY policy
- `authenticated` has SELECT only (no INSERT/UPDATE/DELETE)
- `anon` has NO access
- `service_role` has full table privileges
- `get_my_pro_access_status()` is SECURITY INVOKER
- the live RPC's `search_path` is empty
- `authenticated` and `service_role` may EXECUTE the RPC
- `PUBLIC` and `anon` may NOT EXECUTE the RPC
- the live RPC includes `active`/`past_due` subscriptions in `can_use_pro`

If any object diverges, do NOT repair — reconcile first. (Codex's read-only audit on the review date confirmed all of the above match, but a fresh check is required at repair time because production can change.)

## Legacy incomplete-subscription rollout safety (P8)

As of the read-only audit, production has **zero `incomplete` and zero `incomplete_expired` subscription rows**, so no current user is affected by the reuse-only behavior. Compatibility rule (documented + tested): a legacy `incomplete` subscription created before `checkout_operations` existed has no reusable operation row, so `claim_checkout_operation` (reuse_only mode) returns `blocked_no_reuse` and the function returns a controlled **409 with `state: payment_incomplete`** directing the user to recovery/billing management. It never creates a duplicate subscription and never claims a reusable Checkout URL exists. The zero-row production preflight remains a required rollout check.

## Reliability corrections (fifth review round)

1. **Checkout clock-type bug fixed (C1).** `create-checkout-session/index.ts` previously passed `now: () => new Date().toISOString()` to the orchestration, which computed `Math.floor(now()/1000)` = NaN, defeating the future-expiration check. Production now passes `nowMs: () => Date.now()` (milliseconds; the contract is named `nowMs`), and `validateStripeSession` fails closed on a non-finite / non-positive `nowSec` (`invalid_clock`). A broken clock can never let a session pass.
2. **Provider-outcome classification corrected (C2).** A shared pure `classifyProviderStatus(status)` (used by `index.ts`) maps: 2xx → success; **408 / 409 / 429 → unknown_failure** (ambiguous / interrupted / idempotency-conflict / rate-limited — retained for idempotent retry, NOT definitive); other 4xx (400/401/402/403/404/422) → definitive_failure; 5xx / 3xx / other → unknown_failure. A 2xx with invalid JSON and a network throw are unknown_failure. 429 is no longer misclassified as definitive.
3. **Account-aware shared ProStatusProvider (C3).** `useProStatus.js` now subscribes to `onAuthStateChange`, tracks the loaded UID + a request generation, and on a real UID change synchronously invalidates the prior generation, clears status to a non-granting loading state, and fetches the new user's status. Results from an earlier account/refresh are discarded; sign-out clears immediately; unmount unsubscribes. `hasProAccess()` still grants only on `can_use_pro === true`.
4. **Settings checkout polling cancelled on account switch (C4).** SettingsPage keeps an `AbortController` for the active polling run, aborts it synchronously on account switch / sign-out / new run / unmount, and gates every post-await mutation/analytics through `isStalePollResult` (mounted + not aborted + unchanged generation + unchanged UID). A stale poll never confirms/timeouts/errors or fires `subscription_access_confirmed` / `subscription_confirmation_timed_out`.
5. **Entitlement-query failures are not misclassified as non-Pro (C5).** A shared `decideEntitlement(loaded, now)` returns `allow` (any successfully-loaded source grants access), `unknown` (no access proven AND at least one entitlement query failed → retryable 500, never pro_required), or `deny` (no access, all queries succeeded → 403). All four AI Edge Functions (`ai-chat`, `ai-parse-contact`, `ai-map-csv`, `ai-categorize-contacts`) use it, so a subscription-only paying user whose subscription query fails transiently gets a retryable 500, not a false 403. Logs remain privacy-safe (controlled error codes only).

## Reliability corrections (fourth review round)

1. **No reuse of a completed/obsolete Checkout Session (R1).** `claim_checkout_operation` now takes a checkout MODE (not a boolean): `reuse_or_create` (none), `reuse_only` (incomplete), `fresh_only` (canceled/incomplete_expired). `fresh_only` NEVER reuses an old ready session — a resubscribe after cancel starts a genuinely new operation atomically (single-flight preserved: two concurrent fresh callers → one claimed, one in_progress).
2. **Price change never reuses a Stripe idempotency key (R2).** A stale `creating` row for the SAME price retains its `operation_id` (reuses the key); for a DIFFERENT price it mints a NEW `operation_id` + token and clears session fields — never reusing a key with different params.
3. **Ambiguous provider outcomes are safe (R3, refined in C2).** `createStripeSession` classifies `success` / `definitive_failure` / `unknown_failure`. **Not all 4xx are definitive:** 408, 409, and 429 are `unknown_failure` (see C2); only 400/401/402/403/404/422 (and similar proofs of no session) are `definitive_failure`. 5xx, HTTP-success-with-invalid-JSON, and network throws are `unknown_failure`. A `success` is only finalized `ready` when the session has a non-empty id, a valid `checkout.stripe.com` URL, and a FUTURE `expires_at`; otherwise it is treated as unknown (not finalized, 503, operation retained for idempotent retry). `definitive_failure` finalizes `failed` and returns 502 ONLY after the failed finalize is durable (RPC ok AND returned true); a finalize RPC error or `data=false` returns 503. A ready finalize that returns `data=false` (ownership lost) returns 503, never a false success.
4. **`no_items` fails closed in the webhook (R4).** Only `no_matching_item` (items exist but none is our price) is ignored 200. `no_items` / malformed / multiple / mixed / `no_period_end` fail closed with `invalid_subscription_item` (500) on checkout.session.completed, subscription.created, and subscription.updated — a malformed authoritative response never silently locks a paying user.
5. **Real FunnlAIPage account-switch (R5).** FunnlAIPage now subscribes to `onAuthStateChange`, bumps an account generation on a genuine UID change, releases the checkout guard, invalidates the AI request gate, clears the old user's state, and loads the new user's data (generation-guarded). `handleSubscribe` captures the generation and gates every post-await side effect (navigation, state, analytics) — including the catch path — on staleness.
6. **Billing attention is not masked by access (R6).** SettingsPage renders an access-preserving billing warning + Manage billing alongside the `permanent`/`subscribed`/`trial` label (e.g. `past_due` keeps Pro AND shows a warning); FunnlAIPage stays unlocked while `can_use_pro` and shows a small non-blocking notice linking to Settings. A normal Subscribe button is never shown for a status the backend blocks/reuse-onlys. `hasProAccess()` remains the only access gate.
7. **Shared policy in an Edge-safe location (R7).** The single canonical policy now lives at `supabase/functions/shared/subscriptionStatusPolicy.js`; the checkout Edge Function imports it via `../shared/…`, and `src/lib/subscriptionStatusPolicy.js` is a thin re-export. No duplicated status map. Vite build + Node module-graph resolution both verified without deploying.
8. **User-facing em dashes removed (R8).** The billing-portal Edge Function's API error messages (and checkout copy) use periods, not U+2014. A targeted test scans the Stripe user-visible strings only.

## Reliability corrections (third review round)

1. **Durable server-side checkout single-flight (R1).** New migration `20260815003056_add_checkout_session_singleflight.sql`: `checkout_operations` table + `claim_checkout_operation()` / `finalize_checkout_operation()` (SECURITY DEFINER, service_role-only, `SET search_path=''`, opaque claim-token ownership, terminal rows can't re-finalize). Two tabs/devices cannot create two Stripe sessions: an atomic `INSERT … ON CONFLICT (user_id) DO NOTHING` gives exactly one caller the claim; others get `in_progress` (no Stripe call). A ready, unexpired session is reused (bounded by Stripe's `expires_at`). The Stripe **idempotency key is the opaque operation UUID (`checkout-op-<uuid>`) — no user id or email**; a crash after Stripe success reuses the SAME operation id so Stripe returns the existing session. `create-checkout-session` is refactored into an injectable `runCheckoutOrchestration()` (thin `index.ts`); the browser `attemptId` is now non-authoritative.
2. **Full subscription-status policy (R2).** One shared `src/lib/subscriptionStatusPolicy.js` used by the checkout backend AND the UI: active/past_due/trialing/unpaid/paused → block; incomplete → reuse-only; canceled/incomplete_expired/none → allow; unknown → fail closed. The UI no longer shows a normal Subscribe button when the backend would reject (a `billing_attention` / `payment_incomplete` display state routes to billing management). This is display-only — `hasProAccess()` remains the sole access gate.
3. **Modern Stripe period-end (R3).** `extractProSubscriptionSnapshot()` reads the period end from the validated Pro subscription **item** (`items.data[n].current_period_end`), with the removed top-level field only as a documented legacy fallback; price validation and period extraction come from the same item; fail-closed on wrong/no/multiple/mixed items or missing period. Applied in checkout.session.completed, subscription.created, subscription.updated.
4. **classifyProStatus consistency (R4).** Now rejects BOTH contradiction directions (grant flag with `can_use_pro=false`, AND `can_use_pro=true` with no grant flag) and validates every boolean field + `subscription_status`; malformed → `unavailable`.
5. **Action-guard robustness (R5).** All three actions (FunnlAIPage checkout, SettingsPage checkout + billing portal) wrap the invoke in try/catch (thrown error → visible error, failed-analytics, guard release, clear loading, no navigate); account-switch paths synchronously release the guards and discard stale results.
6. **DB identity integrity (R6).** Partial unique index `subscriptions_stripe_subscription_id_uniq` (in `20260813000000`); webhook upserts fail closed on a unique violation with failure code `identity_conflict` (never overwrite another user's row).

## Reliability corrections (second review round)

1. **Lost claim token never acknowledges 200** — `mark_webhook_event()` returning false (row reclaimed or already terminal) now returns retryable **503**, never the intended 200. The SQL UPDATE additionally requires `status = 'processing'`, so a terminal row cannot be finalized twice.
2. **Authoritative fetched metadata** — `customer.subscription.created/updated` resolves ownership from the *fetched* subscription's `metadata.user_id` / IDs; the event snapshot is used only as expected values for validation.
3. **Real orchestration is tested** — the handler control flow is extracted to an injectable `runWebhookOrchestration()`; 32 Node tests drive the actual production function.
4. **Signature verification is tested** — `verifyStripeSignature()` extracted and covered by 20 real-HMAC tests (keeps `crypto.subtle.verify`).
5. **Canonical Pro gate** — all access gates use `hasProAccess(can_use_pro)`; no hand-written entitlement-state allowlists remain in `src`; `classifyProStatus()` (display-only) rejects contradictory shapes as `unavailable`.
6. **Validated redirects** — the 3 redirect sites route through `resolveStripeRedirect` → `isValidStripeUrl` before navigating.
7. **Synchronous duplicate-action guards** — `createActionGuard()` prevents two rapid clicks from creating two sessions.
8. **Em dash removed** from the expired-trial subscribe copy.
9. **Credential docs corrected** — no publishable key (unused; not a secret); required secrets are `STRIPE_SECRET_KEY`, `STRIPE_PRO_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`.

## What this PR includes

### Schema
- `public.subscriptions` table — stores per-user Stripe subscription state; service-role writes only; SELECT for authenticated own row
- Updated `get_my_pro_access_status()` RPC — adds `subscription_active`, `subscription_status`, `subscription_period_end`, `cancel_at_period_end`; `can_use_pro = permanent_pro OR trial_active OR subscription_active`
- `public.stripe_webhook_events` table (pending migration) — idempotency tracking with a `claim_token` column; `claim_webhook_event()` PL/pgSQL function returns JSONB (`{result, claim_token}`) with atomic claim/retry/stale-reclaim semantics (stale reclaim uses compare-and-swap on `created_at` so only one concurrent reclaimer wins); `mark_webhook_event()` PL/pgSQL function validates the `claim_token` before finalizing a row; controlled `failure_code` CHECK constraint (10 allowed codes) plus a status/failure-code consistency constraint

### Edge Functions
- `create-checkout-session` — verifies JWT, validates `attemptId` UUID, checks for existing active/past_due subscription (409 if blocked), reads price from `STRIPE_PRO_PRICE_ID` env only, builds Stripe Checkout Session, returns `{ url }` after validating `checkout.stripe.com` HTTPS
- `stripe-webhook` — thin transport wrapper (`index.ts`) over an **injectable orchestration function** (`webhookHandler.js` → `runWebhookOrchestration`), so Node tests exercise the real control flow. Signature verification is extracted to `verifyStripeSignature.js` (manual HMAC-SHA256 via `crypto.subtle.verify`, constant-time; key imported for `['verify']`; 5-minute replay window; injectable clock). The orchestration: **event-shape validation** (rejects malformed `id`/`type`/`created`/`data.object` with 400 even when validly signed); authoritative Stripe subscription retrieval on every subscription event (`GET /v1/subscriptions/{id}`) with **fetched-field validation** (`sub.id`/`sub.customer` must match the event) and uses **only the fetched object's fields, including `metadata.user_id`, for ownership** (the event snapshot is used solely as expected values for validation); fail-closed price validation; **subscription-status allowlist check** before any DB write; **invoice events are informational only** (no DB writes); `subscription.deleted` UPDATE matches **both** `user_id` AND `stripe_subscription_id`; atomic idempotency via `claim_webhook_event()` returning a `claim_token`, finalized via `mark_webhook_event()` — whose UPDATE now also requires `status = 'processing'`, so a terminal row can never be re-finalized. **A lost claim token (mark returns false) returns retryable 503 — never HTTP 200** (a stale handler that lost ownership must not let Stripe stop retrying before the true owner durably finalizes); a failed mark RPC returns 500. Pure validators live in `webhookOrchestrator.js`.
- `create-billing-portal-session` — resolves `stripe_customer_id` server-side from subscriptions table; returns `{ url }` after validating `billing.stripe.com` HTTPS
- `shared/pro-entitlement.js` — updated `evaluateProEntitlement(profile, trial, subscription, now)` with 3-source priority: permanent → subscription → trial

### Frontend
- **Canonical Pro-access gate:** every access gate calls `hasProAccess(proStatus)` (reads the authoritative `can_use_pro`). `classifyProStatus()` is display-only. `FunnlAIPage` (`isProUser`), `BottomNav` (`canUsePro`), `CommandPalette` (`canUsePro`), and `interactionFormUtils.shouldShowAIFill` no longer use hand-written `permanent/trial/subscribed` allowlists — a future entitlement type is covered automatically. `classifyProStatus()` also hardened: any grant flag that contradicts `can_use_pro = false` (or a malformed shape) classifies as `'unavailable'`.
- **Validated redirects:** all three Stripe redirect sites (`FunnlAIPage` checkout, `SettingsPage` checkout, `SettingsPage` portal) route the Edge Function response through `resolveStripeRedirect(data, error, type)` → `isValidStripeUrl` before assigning `window.location.href`; an invalid/missing URL shows the visible error and does not navigate. `checkout_creation_failed` fires on an invalid checkout URL; `billing_portal_opened` fires only after a valid portal URL is confirmed.
- **Synchronous duplicate-action guards:** `createActionGuard()` (in `src/lib/actionGuard.js`) is engaged before generating the `attemptId` or invoking, so two rapid clicks produce exactly one session; the guard releases on controlled failure and stays engaged through successful navigation.
- `SettingsPage.jsx` — Pro Access card: subscribe button, checkout return polling, "Manage billing →" portal button, visible `subscribeError` / `billingPortalError`, analytics
- `FunnlAIPage.jsx` — subscribe button in locked/expired state, visible `subscribeError`
- `src/lib/pro-ui-status.js` — `classifyProStatus()` (display-only, 6 states + contradiction guard); `hasProAccess()` (canonical `can_use_pro === true` gate)
- `src/lib/stripeRedirect.js` — `resolveStripeRedirect(data, error, type)` shared redirect-decision helper
- `src/lib/actionGuard.js` — `createActionGuard()` synchronous single-flight guard
- `src/lib/checkoutPolling.js`, `src/lib/useProStatus.js`, `src/lib/stripeUrl.js` — unchanged from round 1

### Tests
- `tests/checkout-polling.test.js` — 21 tests for `runCheckoutPolling` (was 19; 2 added for returned-value semantics)
- `tests/checkout-helpers.test.js` — `isValidUUID`, `buildCheckoutIdempotencyKey` (opaque, no PII), `isValidCheckoutUrl`
- `tests/checkout-orchestration.test.js` — 21 tests driving the REAL `runCheckoutOrchestration` (status gating, claim reuse/in_progress/blocked, single Stripe call, opaque idempotency key with no PII, stale-reclaim same key, Stripe throw vs error, finalize failure)
- `tests/subscription-status-policy.test.js` — 38 tests for the full shared status policy table (checkoutMode / grantsAccess / uiState / attention)
- `tests/webhook-period-end.test.js` — 14 tests for `extractProSubscriptionSnapshot` (item-level, legacy fallback, wrong/no/multiple/mixed items, missing/invalid period)
- `tests/webhook-helpers.test.js` — pure helpers incl. `extractProSubscriptionSnapshot`, `isUniqueViolation`
- `tests/webhook-orchestrator.test.js` — 57 tests for the pure webhook validators
- `tests/webhook-orchestration.test.js` — 36 tests driving the REAL `runWebhookOrchestration` (adds R3 item-level period-end DB payload, `invalid_subscription_item`, R6 `identity_conflict`)
- `tests/verify-stripe-signature.test.js` — 20 real-HMAC signature tests
- `tests/pro-ui-status.test.js` — hardened `classifyProStatus`: both contradiction directions + every malformed field + strict access-gate source contract
- `tests/stripe-redirect.test.js` — `resolveStripeRedirect` + 3-redirect-site source contract
- `tests/action-guard.test.js` / `tests/checkout-action-safety.test.js` — synchronous guard behavior + handler try/catch + account-switch release source contracts
- `tests/stripe-url.test.js` — `isValidStripeUrl` (checkout + portal + invalid input)

## Deployment order (do not deviate)

**Prerequisites — must be done manually before any code deployment:**

1. Verify `subscription_active` appears in `get_my_pro_access_status()` output (confirms `20260812000000` is applied)
2. **Required: repair the migration ledger** so the applied `20260812000000` migration is not re-attempted by the next `supabase db push`: `npx supabase migration repair --status applied 20260812000000 --linked`. Confirm it still shows as local-only in `supabase migration list --linked` before running. (This task did NOT run the repair.)
3. Add `STRIPE_SECRET_KEY` to Supabase Edge Function secrets (value from the Stripe dashboard)
4. Add `STRIPE_PRO_PRICE_ID` to Supabase Edge Function secrets (value from the Stripe dashboard — not stored in this repo)
5. Apply the two pending migrations: `supabase db push --linked`. **After the ledger repair, a dry run shows exactly TWO pending migrations** — `20260813000000_add_webhook_idempotency.sql` and `20260815003056_add_checkout_session_singleflight.sql`. (This is no longer "exactly one pending migration".) `20260813000000` must be applied before redeploying `stripe-webhook`; `20260815003056` before redeploying `create-checkout-session`.

**Deployment steps (in order):**

6. Deploy / redeploy Edge Functions. `stripe-webhook` and `create-checkout-session` are already live at older versions — these commands **update** them to this branch's code. `create-billing-portal-session` is a first-time deploy. **`stripe-webhook` must not be redeployed until `20260813000000` is applied**, and **`create-checkout-session` must not be redeployed until `20260815003056` is applied** — the new handlers call RPCs (`mark_webhook_event`, `claim_checkout_operation`, `finalize_checkout_operation`) that do not exist until then.
   ```
   npx supabase functions deploy create-checkout-session --project-ref jzybxhvgnksrwxfivdwt --use-api   # updates v2 → branch
   npx supabase functions deploy stripe-webhook --project-ref jzybxhvgnksrwxfivdwt --use-api            # updates v4 → branch (AFTER migration 20260813000000)
   npx supabase functions deploy create-billing-portal-session --project-ref jzybxhvgnksrwxfivdwt --use-api  # first deploy
   ```
   The four AI functions (`ai-chat` v17, `ai-parse-contact` v6, `ai-map-csv` v6, `ai-categorize-contacts` v5) are already deployed with subscription-aware entitlement checks. Redeploy them only if this branch changed their shared code:
   ```
   npx supabase functions deploy ai-chat --project-ref jzybxhvgnksrwxfivdwt --use-api
   npx supabase functions deploy ai-parse-contact --project-ref jzybxhvgnksrwxfivdwt --use-api
   npx supabase functions deploy ai-map-csv --project-ref jzybxhvgnksrwxfivdwt --use-api
   npx supabase functions deploy ai-categorize-contacts --project-ref jzybxhvgnksrwxfivdwt --use-api
   ```
7. Register webhook endpoint in Stripe dashboard → Developers → Webhooks:
   URL: `https://jzybxhvgnksrwxfivdwt.supabase.co/functions/v1/stripe-webhook`
   Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`
8. Copy the `whsec_...` signing secret → add as `STRIPE_WEBHOOK_SECRET` Supabase Edge Function secret
9. Configure Stripe Customer Portal at `dashboard.stripe.com/settings/billing/portal` (enable, set return URL to `https://www.getfunnl.com/settings`)
10. Merge this PR to `main` → wait for Vercel build READY

**No frontend `VITE_STRIPE_*` env vars are needed.** All Stripe credentials live in Supabase Edge Function secrets only.

## Required Supabase Edge Function secrets

This implementation uses NO Stripe publishable key (it never runs Stripe.js on the client — it redirects to Stripe-hosted Checkout/Portal URLs returned by the Edge Functions). The publishable key is not a secret and is not required here.

The exact values live only in Supabase Edge Function secrets and the Stripe dashboard — they are intentionally NOT stored in this repo. Read them from the Stripe dashboard when configuring the secrets.

- `STRIPE_SECRET_KEY` — Stripe secret key (server-side only)
- `STRIPE_PRO_PRICE_ID` — the Pro price ID (read server-side only)
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret (added after the webhook is registered)

No frontend `VITE_STRIPE_*` variables are needed.

- Webhook URL: `https://jzybxhvgnksrwxfivdwt.supabase.co/functions/v1/stripe-webhook`

## Smoke test checklist (Stripe TEST mode)

- [ ] New signup → trial active, AI access works
- [ ] Trial user clicks Subscribe from SettingsPage → `checkout_started` fires → Stripe Checkout opens
- [ ] Trial user clicks Subscribe from FunnlAIPage → same flow
- [ ] Complete checkout with test card `4242 4242 4242 4242` → returns to `?checkout=success` → "Confirming subscription…" shown → "You're on Funnl Pro" on confirmation
- [ ] Slow webhook (simulate delay): timeout state shows "Payment processing" + "Check again" Retry button
- [ ] Retry button: polls immediately, confirms on success
- [ ] Subscribed state → AI works; Settings shows "Manage billing →"
- [ ] "Manage billing →" → Stripe Customer Portal opens; `billing_portal_opened` fires
- [ ] Cancel in portal → `cancel_at_period_end=true` → "Cancels DATE" shown, Pro continues until period end
- [ ] `subscription.deleted` fires → locked state shown
- [ ] Already-subscribed user clicks Subscribe → 409 (no double session)
- [ ] Permanent Pro user (`ai_enabled=true`) unaffected
- [ ] Checkout cancel → "Checkout cancelled" banner shown, not charged
- [ ] Webhook tampered body → 400 rejected (check Edge Function logs)
- [ ] Duplicate webhook delivery → 200 (idempotency table deduplicated, check `stripe_webhook_events` row shows `processed`)
