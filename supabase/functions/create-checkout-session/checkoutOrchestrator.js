// Injectable orchestration for create-checkout-session.
//
// Contains the REAL control flow used in production by index.ts: durable subscription
// gating, atomic server-side checkout single-flight (claim/reuse/finalize), Stripe
// session creation with an opaque idempotency key, explicit provider-outcome
// classification, and crash-safe finalization. index.ts is a thin wrapper that
// authenticates the caller, builds the service-role client + real Stripe fetch, and
// delegates here. Node tests call this exported function directly with injected fakes.
//
// All effects are injected via `deps`:
//   supabaseAdmin       — .from('subscriptions').select().eq().maybeSingle();
//                         .rpc('claim_checkout_operation'|'finalize_checkout_operation', args)
//   createStripeSession — async ({ params, idempotencyKey, stripeKey }) =>
//                           { outcome: 'success'|'definitive_failure'|'unknown_failure',
//                             status: number, session: object|null }
//                         (may THROW on network failure — treated as unknown/retryable)
//   env                 — { priceId, stripeKey, successUrl, cancelUrl }
//   user                — { id, email }
//   now (ms), log, requestId
//
// Returns { status: number, body: object } — index.ts serializes body as JSON.
//
// LOGGING: only requestId + controlled reason/outcome codes are logged. NEVER Stripe
// response bodies, URLs, session IDs, customer IDs, emails, user IDs, or metadata.

import { buildCheckoutIdempotencyKey, isValidCheckoutUrl, validateStripeSession } from './checkoutHelpers.js'
import { checkoutModeForStatus } from '../shared/subscriptionStatusPolicy.js'

function resp(status, body) {
  return { status, body }
}
const noopLog = () => {}

export async function runCheckoutOrchestration({
  user,
  supabaseAdmin,
  createStripeSession,
  env,
  now = () => Date.now(),
  log = noopLog,
  requestId = '',
}) {
  const priceId    = env?.priceId    ?? ''
  const stripeKey  = env?.stripeKey  ?? ''
  const successUrl = env?.successUrl ?? ''
  const cancelUrl  = env?.cancelUrl  ?? ''

  if (!user?.id) {
    return resp(401, { error: 'Not authenticated' })
  }
  if (!priceId || !stripeKey) {
    log('config_missing', { requestId })
    return resp(503, { error: 'Checkout not configured. Please try again later.' })
  }

  // ── 1. Durable subscription state ────────────────────────────────────────────
  const { data: existingSub, error: subError } = await supabaseAdmin
    .from('subscriptions')
    .select('status, stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (subError) {
    log('subscription_lookup_failed', { requestId })
    return resp(503, { error: 'Could not verify subscription status. Please try again.' })
  }

  // ── 2. Status-policy gate + checkout mode ────────────────────────────────────
  const mode = checkoutModeForStatus(existingSub?.status)
  if (mode === 'block') {
    // An existing subscription (or attention state) must be managed, not duplicated.
    log('checkout_blocked', { requestId })
    return resp(409, { error: 'Subscription needs attention' })
  }

  // ── 3. Atomic checkout single-flight claim ───────────────────────────────────
  // p_mode: 'reuse_or_create' (none) | 'reuse_only' (incomplete) | 'fresh_only'
  // (canceled/incomplete_expired — never reuse an old/completed ready session).
  const { data: claimRaw, error: claimError } = await supabaseAdmin
    .rpc('claim_checkout_operation', {
      p_user_id:  user.id,
      p_price_id: priceId,
      p_mode:     mode,
    })

  if (claimError) {
    log('claim_failed', { requestId })
    return resp(503, { error: 'Could not start checkout. Please try again.' })
  }

  const result = claimRaw?.result
  if (result === 'reuse') {
    if (!isValidCheckoutUrl(claimRaw.checkout_url)) {
      log('stored_url_invalid', { requestId })
      return resp(502, { error: 'Could not start checkout. Please try again.' })
    }
    return resp(200, { url: claimRaw.checkout_url })
  }
  if (result === 'in_progress') {
    return resp(409, { error: 'Checkout already in progress. Please try again.' })
  }
  if (result === 'blocked_no_reuse') {
    // reuse_only (status incomplete) with no recoverable session.
    log('checkout_blocked_no_reuse', { requestId })
    return resp(409, { error: 'Finish your pending payment or manage billing.', state: 'payment_incomplete' })
  }
  if (result !== 'claimed' || typeof claimRaw.operation_id !== 'string' || typeof claimRaw.claim_token !== 'string') {
    log('claim_bad_payload', { requestId })
    return resp(503, { error: 'Could not start checkout. Please try again.' })
  }

  const operationId = claimRaw.operation_id
  const claimToken  = claimRaw.claim_token

  // Token-validated finalize helper. Returns true only when the row was durably
  // transitioned by THIS owner (no RPC error AND the RPC returned true).
  async function durableFinalize(state, fields) {
    const { data, error } = await supabaseAdmin.rpc('finalize_checkout_operation', {
      p_user_id:      user.id,
      p_claim_token:  claimToken,
      p_state:        state,
      p_session_id:   fields?.sessionId ?? null,
      p_checkout_url: fields?.url ?? null,
      p_expires_at:   fields?.expiresAtIso ?? null,
    })
    if (error) return { durable: false, rpcError: true }
    return { durable: data === true, rpcError: false }
  }

  // ── 4. Build Stripe params (price from env only; never from the browser) ──────
  const params = new URLSearchParams()
  params.set('mode', 'subscription')
  params.set('success_url', successUrl)
  params.set('cancel_url', cancelUrl)
  params.set('line_items[0][price]', priceId)
  params.set('line_items[0][quantity]', '1')
  params.set('client_reference_id', user.id)
  params.set('metadata[user_id]', user.id)
  params.set('subscription_data[metadata][user_id]', user.id)
  if (existingSub?.stripe_customer_id) {
    params.set('customer', existingSub.stripe_customer_id)
  } else if (user.email) {
    params.set('customer_email', user.email)
  }

  // Opaque, PII-free idempotency key derived only from the operation UUID.
  const idempotencyKey = buildCheckoutIdempotencyKey(operationId)

  // ── 5. Create the Stripe session (this invocation owns the claim) ─────────────
  let providerResult
  try {
    providerResult = await createStripeSession({ params, idempotencyKey, stripeKey })
  } catch {
    // Network throw → UNKNOWN outcome. Do NOT finalize — leave the operation
    // 'creating' so a stale reclaim reuses the SAME idempotency key. Retryable.
    log('provider_unknown', { requestId })
    return resp(503, { error: 'Could not start checkout. Please try again.' })
  }

  const outcome = providerResult?.outcome

  // ── UNKNOWN outcome: never finalize; leave 'creating' for idempotent retry ────
  // (network error, HTTP-success-with-invalid-JSON, malformed/transient/ambiguous).
  if (outcome === 'unknown_failure') {
    log('provider_unknown', { requestId })
    return resp(503, { error: 'Could not start checkout. Please try again.' })
  }

  // ── DEFINITIVE failure: the provider proved no session was created ────────────
  if (outcome === 'definitive_failure') {
    log('provider_definitive_failure', { requestId, providerStatus: providerResult?.status ?? null })
    const fin = await durableFinalize('failed')
    if (!fin.durable) {
      // Failure not durably recorded (RPC error, or ownership lost) — return retryable
      // so we never leave a half-recorded state that could later duplicate a session.
      log('failed_finalize_not_durable', { requestId })
      return resp(503, { error: 'Could not start checkout. Please try again.' })
    }
    return resp(502, { error: 'Could not start checkout. Please try again.' })
  }

  // ── SUCCESS: require a complete, future-dated session before finalizing ready ──
  if (outcome !== 'success') {
    // Unknown outcome value → treat as unknown (safest).
    log('provider_unknown', { requestId })
    return resp(503, { error: 'Could not start checkout. Please try again.' })
  }

  const nowSec = Math.floor(now() / 1000)
  const valid  = validateStripeSession(providerResult.session, nowSec)
  if (!valid.ok) {
    // HTTP success but the session is missing id / URL / a valid FUTURE expires_at.
    // The outcome is ambiguous (a session may exist) — treat as UNKNOWN: do NOT
    // finalize, leave 'creating' so a retry reuses the same idempotency key.
    log('provider_success_incomplete', { requestId, reason: valid.reason })
    return resp(503, { error: 'Could not start checkout. Please try again.' })
  }

  const fin = await durableFinalize('ready', { sessionId: valid.id, url: valid.url, expiresAtIso: valid.expiresAtIso })
  if (!fin.durable) {
    // Ownership lost or finalize failed — do NOT claim checkout was safely recorded.
    // Retryable: a follow-up reuses the ready row (if recorded elsewhere) or reclaims.
    log('ready_finalize_not_durable', { requestId })
    return resp(503, { error: 'Could not start checkout. Please try again.' })
  }

  return resp(200, { url: valid.url })
}
