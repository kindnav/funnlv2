# PR #24 — Stripe Layer D: Billing & Subscriptions

## Current deployment state (verified via read-only `supabase functions list` on 2026-08-14)

Each component is documented separately — the Stripe surface is a **mix** of deployed-but-older-version and not-deployed. Do NOT read this as "all deployed" or "all undeployed."

| Component | Deployed? | Prod version | Notes |
|---|---|---|---|
| Migration `20260812000000_add_subscriptions.sql` | **Applied** | — | `subscriptions` table exists; `get_my_pro_access_status()` RPC works; data live |
| Migration ledger for `20260812000000` | Gap (local-only) | — | **Required repair** before next `db push`: `npx supabase migration repair --status applied 20260812000000 --linked` |
| Migration `20260813000000_add_webhook_idempotency.sql` | **NOT applied** | — | Adds `stripe_webhook_events` table + `claim_token`, `claim_webhook_event()` (jsonb), `mark_webhook_event()`. Must be applied **before** the updated stripe-webhook is deployed (the new handler calls `mark_webhook_event()` and reads `claim_token`) |
| `create-checkout-session` Edge Function | **Deployed (older version)** | v2 | Live in production but predates this branch's reliability changes (`checkoutHelpers.js`, `stripeUrl` validation, `attemptId` idempotency). Redeploy from this branch to update. `verify_jwt = true` |
| `stripe-webhook` Edge Function | **Deployed (older version)** | v4 | Live and has processed Stripe events; `verify_jwt = false` (correct — Stripe carries no Supabase JWT). Predates this branch's idempotency + reliability rewrite (`claim_token`/`mark_webhook_event`, event-shape validation, authoritative field validation, deletion filter, invoice-informational, status allowlist). **Do not redeploy until migration `20260813000000` is applied** |
| `create-billing-portal-session` Edge Function | **NOT deployed** | — | Absent from `functions list`. Requires Stripe Customer Portal configured in the Stripe dashboard first |
| `ai-chat` | **Deployed (subscription-aware)** | v17 | Entitlement check includes subscription state |
| `ai-parse-contact` | **Deployed (subscription-aware)** | v6 | Entitlement check includes subscription state |
| `ai-map-csv` | **Deployed (subscription-aware)** | v6 | Entitlement check includes subscription state |
| `ai-categorize-contacts` | **Deployed (subscription-aware)** | v5 | Entitlement check includes subscription state |
| Frontend (SettingsPage, FunnlAIPage, pro-ui-status, checkoutPolling, useProStatus, stripeUrl) | **NOT merged / NOT deployed** | — | All Stripe UI lives on this branch; awaiting merge to `main` |

**Net effect:** checkout and the webhook are live at older versions, so the billing path partially functions today, but the idempotency table, the token-validated finalize, the authoritative-field/status hardening, the billing-portal function, and all frontend Stripe UI are **not** in production. Redeploying `create-checkout-session` and `stripe-webhook` from this branch (after applying migration `20260813000000`) is required to pick up the reliability corrections.

## What this PR includes

### Schema
- `public.subscriptions` table — stores per-user Stripe subscription state; service-role writes only; SELECT for authenticated own row
- Updated `get_my_pro_access_status()` RPC — adds `subscription_active`, `subscription_status`, `subscription_period_end`, `cancel_at_period_end`; `can_use_pro = permanent_pro OR trial_active OR subscription_active`
- `public.stripe_webhook_events` table (pending migration) — idempotency tracking with a `claim_token` column; `claim_webhook_event()` PL/pgSQL function returns JSONB (`{result, claim_token}`) with atomic claim/retry/stale-reclaim semantics (stale reclaim uses compare-and-swap on `created_at` so only one concurrent reclaimer wins); `mark_webhook_event()` PL/pgSQL function validates the `claim_token` before finalizing a row; controlled `failure_code` CHECK constraint (10 allowed codes) plus a status/failure-code consistency constraint

### Edge Functions
- `create-checkout-session` — verifies JWT, validates `attemptId` UUID, checks for existing active/past_due subscription (409 if blocked), reads price from `STRIPE_PRO_PRICE_ID` env only, builds Stripe Checkout Session, returns `{ url }` after validating `checkout.stripe.com` HTTPS
- `stripe-webhook` — manual HMAC-SHA256 via `crypto.subtle.verify` (constant-time; key imported for `['verify']`); 5-minute replay protection; **event-shape validation** (rejects malformed `id`/`type`/`created`/`data.object` with 400 even when validly signed); authoritative Stripe subscription retrieval on every subscription event (`GET /v1/subscriptions/{id}`) with **fetched-field validation** (`sub.id`/`sub.customer` must match the event, and only the fetched object's fields are written); fail-closed price validation; **subscription-status allowlist check** before any DB write; **invoice events are informational only** (no DB writes — `subscription.updated` carries the authoritative period/status); `subscription.deleted` UPDATE matches **both** `user_id` AND `stripe_subscription_id` so a late delete cannot cancel a newer subscription; atomic idempotency via `claim_webhook_event()` RPC returning a `claim_token`, finalized via `mark_webhook_event()` (token-validated so a stale/reclaimed handler cannot overwrite a newer claim); a failed `mark_webhook_event()` RPC returns 500 (never silently ignored); structured error responses; 5xx on required DB write failures (forces Stripe retry). Pure decision logic lives in `webhookOrchestrator.js` (unit-tested).
- `create-billing-portal-session` — resolves `stripe_customer_id` server-side from subscriptions table; returns `{ url }` after validating `billing.stripe.com` HTTPS
- `shared/pro-entitlement.js` — updated `evaluateProEntitlement(profile, trial, subscription, now)` with 3-source priority: permanent → subscription → trial

### Frontend
- `SettingsPage.jsx` — Pro Access card: subscribe button, checkout return polling (`runCheckoutPolling` via `useProStatus.refresh()` which now returns status), "Manage billing →" portal button, `billingPortalError` visible error, visible `subscribeError`, analytics
- `FunnlAIPage.jsx` — subscribe button in locked state, visible `subscribeError` on failure
- `src/lib/pro-ui-status.js` — `classifyProStatus()` returns 6 states including `'subscribed'`; `hasProAccess()` checks `can_use_pro === true` from RPC
- `src/lib/checkoutPolling.js` — `refreshFn` returns new status; `hasAccessFn(newStatus)` uses returned value (no stale React ref)
- `src/lib/useProStatus.js` — `refresh()` now returns the fetched status
- `src/lib/stripeUrl.js` — `isValidStripeUrl(url, type)` validates HTTPS + approved hostname; zero deps

### Tests
- `tests/checkout-polling.test.js` — 21 tests for `runCheckoutPolling` (was 19; 2 added for returned-value semantics)
- `tests/checkout-helpers.test.js` — `isValidUUID`, `buildIdempotencyKey`, `isBlockedByExistingSubscription`
- `tests/webhook-helpers.test.js` — `SUBSCRIPTION_STATUS_SEMANTICS`, `extractPriceId`, `statusGrantsAccess`, `shouldRetryOnMissingOwnership`, `isValidEventId`, `isValidStatus`
- `tests/webhook-orchestrator.test.js` — 57 tests for the pure webhook decision logic: `validateEventShape` (C4), `validateAuthoritativeSub` (C6), `isInvoiceEvent` (C7), `buildDeletionFilter` (C5), `isAllowedSubscriptionStatus` (C8), `classifyClaim`, `buildEventLogPayload`
- `tests/stripe-url.test.js` — 22 tests for `isValidStripeUrl` (checkout + portal + invalid input)

## Deployment order (do not deviate)

**Prerequisites — must be done manually before any code deployment:**

1. Verify `subscription_active` appears in `get_my_pro_access_status()` output (confirms `20260812000000` is applied)
2. **Required: repair the migration ledger** so the applied `20260812000000` migration is not re-attempted by the next `supabase db push`: `npx supabase migration repair --status applied 20260812000000 --linked`. Confirm it still shows as local-only in `supabase migration list --linked` before running.
3. Add `STRIPE_SECRET_KEY` to Supabase Edge Function secrets (value from the Stripe dashboard)
4. Add `STRIPE_PRO_PRICE_ID` to Supabase Edge Function secrets (value from the Stripe dashboard — not stored in this repo)
5. Apply idempotency migration: `supabase db push --linked` (verify exactly 1 pending migration first)

**Deployment steps (in order):**

6. Deploy / redeploy Edge Functions. `stripe-webhook` and `create-checkout-session` are already live at older versions — these commands **update** them to this branch's code. `create-billing-portal-session` is a first-time deploy. **`stripe-webhook` must not be redeployed until migration `20260813000000` is applied (step 5)** — the new handler calls `mark_webhook_event()` and reads `claim_token`, which do not exist until then.
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

## Stripe TEST mode credentials (server-side only)

All Stripe secret values live only in Supabase Edge Function secrets and the Stripe dashboard — they are intentionally NOT stored in this repo. Read the exact values from the Supabase dashboard when configuring secrets.

- `STRIPE_PUBLISHABLE_KEY` — publishable key (server-side secret; not needed by frontend)
- `STRIPE_PRO_PRICE_ID` — the Pro price ID (read server-side only)
- `STRIPE_SECRET_KEY` — secret key (server-side only)
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret (added after the webhook is registered)
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
