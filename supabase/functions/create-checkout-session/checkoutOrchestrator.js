// Injectable orchestration for create-checkout-session.
//
// Contains the REAL control flow used in production by index.ts: durable subscription
// gating, atomic server-side checkout single-flight (claim/reuse/finalize), Stripe
// session creation with an opaque idempotency key, URL validation, and crash-safe
// finalization. index.ts is a thin wrapper that authenticates the caller, builds the
// service-role client + real Stripe fetch, and delegates here. Node tests call this
// exported function directly with injected fakes, so they exercise production logic.
//
// All effects are injected via `deps`:
//   supabaseAdmin       — .from('subscriptions').select().eq().maybeSingle();
//                         .rpc('claim_checkout_operation'|'finalize_checkout_operation', args)
//   createStripeSession — async ({ params, idempotencyKey }) =>
//                           { ok: boolean, status: number, session: {url,id,expires_at}|null }
//                         (may THROW on network failure — treated as unknown/retryable)
//   env                 — { priceId, stripeKey, successUrl, cancelUrl }
//   user                — { id, email }
//   now, log, requestId
//
// Returns { status: number, body: object } — index.ts serializes body as JSON.

import { buildCheckoutIdempotencyKey, isValidCheckoutUrl } from './checkoutHelpers.js'
import { checkoutPolicyForStatus } from '../../../src/lib/subscriptionStatusPolicy.js'

function resp(status, body) {
  return { status, body }
}
const noopLog = () => {}

export async function runCheckoutOrchestration({
  user,
  supabaseAdmin,
  createStripeSession,
  env,
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
    return resp(503, { error: 'Checkout not configured - please try again later' })
  }

  // ── 1. Durable subscription state ────────────────────────────────────────────
  const { data: existingSub, error: subError } = await supabaseAdmin
    .from('subscriptions')
    .select('status, stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (subError) {
    log('subscription_lookup_failed', { requestId })
    return resp(503, { error: 'Could not verify subscription status - please try again' })
  }

  const policy = checkoutPolicyForStatus(existingSub?.status)
  if (policy.checkoutMode === 'block') {
    // An existing subscription (or attention state) must be managed, not duplicated.
    log('checkout_blocked', { requestId, reason: policy.uiState })
    return resp(409, { error: 'Subscription needs attention', state: policy.uiState })
  }
  const allowCreate = policy.checkoutMode === 'allow'  // 'reuse_only' → false

  // ── 2. Atomic checkout single-flight claim ───────────────────────────────────
  const { data: claimRaw, error: claimError } = await supabaseAdmin
    .rpc('claim_checkout_operation', {
      p_user_id:      user.id,
      p_price_id:     priceId,
      p_allow_create: allowCreate,
    })

  if (claimError) {
    // Cannot safely claim — fail closed, retryable, never call Stripe.
    log('claim_failed', { requestId })
    return resp(503, { error: 'Could not start checkout - please try again' })
  }

  const result = claimRaw?.result
  if (result === 'reuse') {
    // A ready, unexpired session exists — reuse its validated URL, no Stripe call.
    if (!isValidCheckoutUrl(claimRaw.checkout_url)) {
      log('stored_url_invalid', { requestId })
      return resp(502, { error: 'Could not start checkout - please try again' })
    }
    return resp(200, { url: claimRaw.checkout_url })
  }
  if (result === 'in_progress') {
    // Another instance/tab is creating the session — retryable, no Stripe call.
    return resp(409, { error: 'Checkout already in progress - please try again' })
  }
  if (result === 'blocked_no_reuse') {
    // reuse_only (e.g. 'incomplete') with no recoverable session.
    log('checkout_blocked_no_reuse', { requestId })
    return resp(409, { error: 'Finish your pending payment or manage billing', state: 'payment_incomplete' })
  }
  if (result !== 'claimed' || typeof claimRaw.operation_id !== 'string' || typeof claimRaw.claim_token !== 'string') {
    // Unknown / malformed claim → fail closed.
    log('claim_bad_payload', { requestId })
    return resp(503, { error: 'Could not start checkout - please try again' })
  }

  const operationId = claimRaw.operation_id
  const claimToken  = claimRaw.claim_token

  // ── 3. Build Stripe params (price from env only; never from the browser) ──────
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

  // ── 4. Create the Stripe session (this invocation owns the claim) ─────────────
  let stripeResult
  try {
    stripeResult = await createStripeSession({ params, idempotencyKey, stripeKey })
  } catch {
    // Unknown outcome (network throw). Do NOT finalize — leave the operation
    // 'creating' so a stale reclaim reuses the SAME idempotency key. Retryable.
    log('stripe_threw', { requestId })
    return resp(503, { error: 'Could not start checkout - please try again' })
  }

  if (!stripeResult?.ok) {
    // Definitive Stripe error — the session was not created. Mark failed so the next
    // click starts a fresh operation. (Token-safe: only the current owner finalizes.)
    log('stripe_api_error', { requestId, providerStatus: stripeResult?.status ?? null })
    await supabaseAdmin.rpc('finalize_checkout_operation', {
      p_user_id: user.id, p_claim_token: claimToken, p_state: 'failed',
    })
    return resp(502, { error: 'Could not start checkout - please try again' })
  }

  const session = stripeResult.session ?? {}
  if (!isValidCheckoutUrl(session.url)) {
    log('stripe_invalid_url', { requestId })
    await supabaseAdmin.rpc('finalize_checkout_operation', {
      p_user_id: user.id, p_claim_token: claimToken, p_state: 'failed',
    })
    return resp(502, { error: 'Could not start checkout - please try again' })
  }

  // ── 5. Finalize as ready (token-validated) and return the URL ─────────────────
  // Use Stripe's own expires_at so reuse is bounded by the real session lifetime.
  const expiresAtIso = typeof session.expires_at === 'number' && session.expires_at > 0
    ? new Date(session.expires_at * 1000).toISOString()
    : null

  const { error: finalizeError } = await supabaseAdmin.rpc('finalize_checkout_operation', {
    p_user_id:      user.id,
    p_claim_token:  claimToken,
    p_state:        'ready',
    p_session_id:   typeof session.id === 'string' ? session.id : null,
    p_checkout_url: session.url,
    p_expires_at:   expiresAtIso,
  })
  if (finalizeError) {
    // The session is created and valid; recording it failed. Do not create another —
    // return retryable so a follow-up reuses/reclaims the same operation.
    log('finalize_error', { requestId })
    return resp(503, { error: 'Could not start checkout - please try again' })
  }

  // The Stripe session exists and its URL is validated; idempotency guarantees a
  // single session even if a concurrent owner also observed it. Return the URL.
  return resp(200, { url: session.url })
}
