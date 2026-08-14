# PR #24 — Stripe Layer D: Billing & Subscriptions

## Current deployment state (accurate as of 2026-08-14)

| Component | Status | Notes |
|---|---|---|
| Migration `20260812000000_add_subscriptions.sql` | **Applied to production** | `subscriptions` table exists; `get_my_pro_access_status()` RPC works; data live |
| Migration ledger | Gap (local-only) | Repair: `npx supabase migration repair --status applied 20260812000000 --linked` — do NOT run without approval |
| Migration `20260813000000_add_webhook_idempotency.sql` | **NOT applied** | Adds `stripe_webhook_events` table + `claim_webhook_event()` function; must be applied before stripe-webhook Edge Function is deployed |
| `create-checkout-session` Edge Function | **NOT deployed** | Requires `STRIPE_SECRET_KEY` + `STRIPE_PRO_PRICE_ID` secrets set first |
| `stripe-webhook` Edge Function | **NOT deployed** | Requires idempotency migration + `STRIPE_WEBHOOK_SECRET` secret; deployed with `verify_jwt = false` |
| `create-billing-portal-session` Edge Function | **NOT deployed** | Requires Stripe Customer Portal configured in Stripe dashboard |
| AI Edge Functions (`ai-chat`, `ai-parse-contact`, `ai-map-csv`, `ai-categorize-contacts`) | **At current production versions** | Updated `loadProEntitlement` (3-query) not yet deployed; must be redeployed alongside other Edge Functions |
| Frontend (SettingsPage, FunnlAIPage, pro-ui-status) | **NOT deployed** | All Stripe UI lives on this branch; awaiting merge to `main` |

## What this PR includes

### Schema
- `public.subscriptions` table — stores per-user Stripe subscription state; service-role writes only; SELECT for authenticated own row
- Updated `get_my_pro_access_status()` RPC — adds `subscription_active`, `subscription_status`, `subscription_period_end`, `cancel_at_period_end`; `can_use_pro = permanent_pro OR trial_active OR subscription_active`
- `public.stripe_webhook_events` table (pending migration) — idempotency tracking; `claim_webhook_event()` PL/pgSQL function with atomic claim/retry/stale-reclaim semantics

### Edge Functions
- `create-checkout-session` — verifies JWT, validates `attemptId` UUID, checks for existing active/past_due subscription (409 if blocked), reads price from `STRIPE_PRO_PRICE_ID` env only, builds Stripe Checkout Session, returns `{ url }` after validating `checkout.stripe.com` HTTPS
- `stripe-webhook` — manual HMAC-SHA256 via `crypto.subtle.verify` (constant-time; key imported for `['verify']`); 5-minute replay protection; authoritative Stripe subscription retrieval on every subscription event (`GET /v1/subscriptions/{id}`); fail-closed price validation; atomic idempotency via `claim_webhook_event()` RPC; structured error responses; 5xx on required DB write failures (forces Stripe retry)
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
- `tests/webhook-helpers.test.js` — `SUBSCRIPTION_STATUS_SEMANTICS`, `extractPriceId`, `statusGrantsAccess`, `shouldRetryOnMissingOwnership`
- `tests/stripe-url.test.js` — 22 tests for `isValidStripeUrl` (checkout + portal + invalid input)

## Deployment order (do not deviate)

**Prerequisites — must be done manually before any code deployment:**

1. Verify `subscription_active` appears in `get_my_pro_access_status()` output (confirms `20260812000000` is applied)
2. Optionally repair migration ledger: `npx supabase migration repair --status applied 20260812000000 --linked`
3. Add `STRIPE_SECRET_KEY` to Supabase Edge Function secrets
4. Add `STRIPE_PRO_PRICE_ID` = `price_1U3louJU7lKQodyVjgclua04` to Supabase Edge Function secrets
5. Apply idempotency migration: `supabase db push --linked` (verify exactly 1 pending migration first)

**Deployment steps (in order):**

6. Deploy all Edge Functions:
   ```
   npx supabase functions deploy create-checkout-session --project-ref jzybxhvgnksrwxfivdwt --use-api
   npx supabase functions deploy stripe-webhook --project-ref jzybxhvgnksrwxfivdwt --use-api
   npx supabase functions deploy create-billing-portal-session --project-ref jzybxhvgnksrwxfivdwt --use-api
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

- Publishable key: `pk_test_51TQekQJU7lKQodyVGWyhlWNdsKI9c4w2GKWUCNyDUPvM48lS2Ox8vzNwhqA7F4o2pSU9JMAkvR2SoYxdeOuoDRwq00exY9wbb9` (Supabase secret `STRIPE_PUBLISHABLE_KEY`)
- Price ID: `price_1U3louJU7lKQodyVjgclua04` (Supabase secret `STRIPE_PRO_PRICE_ID`)
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
