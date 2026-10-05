// Request handler for outlook-oauth-callback.
//
// ENDPOINTS ARE PARAMETERS, NOT CONFIGURATION.
// An earlier revision resolved the Microsoft token, JWKS and Graph URLs from
// environment variables behind a "loopback only" guard, and claimed that guard
// made redirection impossible in Production. That claim was wrong on both
// counts: the variables could simply be set, and host.docker.internal is a
// route to the Docker host rather than a loopback address. A reachable
// override would receive the authorization code and the client secret at
// /token and the Graph access token at /me.
//
// So the deployable entrypoint (index.ts) now passes FIXED Microsoft and Graph
// URLs and reads no endpoint configuration at all. There is no branch in the
// deployed code that can point these credentials anywhere else, regardless of
// how the environment is configured. The integration suite injects fixture
// endpoints through a SEPARATE harness entrypoint that is never deployed.

import { PRODUCTION_ENDPOINTS } from './endpoints.js'
// outlook-oauth-callback — receives Microsoft's response_mode=form_post
// completion and refuses anything that did not start in THIS browser.
//
// ─────────────────────────────────────────────────────────────────────────────
// ADR: why response_mode=form_post rather than query
// ─────────────────────────────────────────────────────────────────────────────
// SCOPE OF THE CLAIM — stated precisely, because an earlier draft overstated it.
// The state is NOT kept out of every URL. buildOutlookAuthUrl deliberately puts
// `state` (and `nonce`, and the PKCE challenge) in the OUTBOUND authorization URL
// to login.microsoftonline.com — that is how the protocol works, and that URL is
// a real navigation that lands in the user's history like any other.
//
// What form_post changes is the INBOUND leg. With response_mode=query, Microsoft
// returns the result as a top-level GET to
//     https://www.getfunnl.com/api/outlook-oauth-callback?code=...&state=...
// which puts the authorization code AND the state into a URL on OUR branded
// origin. That is the leg worth protecting, for two reasons the outbound leg does
// not share:
//   * it is the only leg carrying `code`, a bearer credential until redeemed;
//   * it is on our own origin, so the values land in our access logs, in any
//     Referer sent from our page, and in our own error reporting.
// form_post moves both into a POST body, so neither appears in the branded
// callback URL, in our server logs, or in the history entry for our own origin.
//
// The cost is that the callback arrives as a CROSS-SITE TOP-LEVEL POST, which a
// SameSite=Lax cookie is not sent on — so the binding cookie must be
// SameSite=None; Secure. That is a real widening of the cookie's reach, accepted
// deliberately: the cookie is __Host- prefixed, HttpOnly, Path=/, ten-minute-
// lived, and its value is useless without the matching unconsumed state row.
//
// Rejected alternative (query + SameSite=Lax): a tighter cookie, paid for by
// putting `code` and `state` into a URL on our own origin. Between "the state may
// be sent on a cross-site POST" and "the code and state are written into our
// branded URL and our logs", the first is the smaller exposure, and it is the one
// the binding gate is designed around. The corrected, narrower analysis does not
// change the decision. If a repo constraint later forces query mode, this
// analysis must be revisited BEFORE switching.
//
// ─────────────────────────────────────────────────────────────────────────────
// Order of operations. The binding gate runs BEFORE any database read, any token
// exchange, and any Graph call, so an unbound completion costs nothing, touches
// no row, and cannot burn a state.
//   1. dormancy gate
//   2. POST only
//   3. bounded body parse
//   4. BINDING GATE  <- before anything expensive or stateful
//   5. state lookup (unknown / consumed / expired refused before the provider)
//   6. token redemption, id_token validation, Graph /me, finalize RPC
// Every terminal response is a 303 to the canonical Settings error page and every
// one of them clears the binding cookie.

import {
  parseCallbackFormBody,
  readBoundedStream,
  CALLBACK_MAX_BODY_BYTES,
} from '../shared/googleOauthHelpers.js'
import {
  verifyMsBrowserBinding,
  buildClearedMsBindingCookie,
} from '../shared/microsoftOauthBinding.js'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { jwtVerify } from 'https://esm.sh/jose@5'
import {
  OUTLOOK_CANONICAL_ERROR_REDIRECT,
  buildOutlookSettingsRedirect,
  identityFromIdTokenClaims,
  isValidConfiguredOutlookCallbackUrl,
} from '../shared/microsoftOauthHelpers.js'
import { sha256Hex, resolveReturnOrigin } from '../shared/googleOauthHelpers.js'
import { importKeyFromBase64, decryptToken, encryptToken } from '../shared/googleTokenCrypto.js'
import { verifyMicrosoftIdToken } from '../shared/microsoftIdToken.js'
import { redeemAuthorizationCode, grantedScopesSufficient } from '../shared/microsoftTokenExchange.js'
import { fetchMailboxAddress } from '../shared/microsoftGraphMe.js'

// NOTE ON REUSE: parseCallbackFormBody and readBoundedStream are
// provider-neutral. The parser requires application/x-www-form-urlencoded,
// rejects duplicate state/code/error parameters (no last-wins), bounds the body,
// and IGNORES unknown fields — so Microsoft's extra error_description,
// error_subcode and session_state pass through harmlessly. Verified against the
// Microsoft form_post contract before reuse.

const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

// 303 See Other: after a form_post POST, force the browser to GET the Location,
// so the OAuth body is never re-sent onward. Never 301/302/307/308.
function redirect (location) {
  return new Response(null, {
    status: 303,
    headers: {
      ...securityHeaders,
      'Set-Cookie': buildClearedMsBindingCookie(),
      Location: location,
    },
  })
}
/**
 * @param {Request} req
 * @param {{tokenUrl: string, graphMeUrl: string, jwksFor: (u: string) => unknown}} endpoints
 */
export async function handleOutlookCallback (req, endpoints = PRODUCTION_ENDPOINTS) {
  // ── 1. Hard dormancy gate ──────────────────────────────────────────────────
  // Absent means off. While dormant this endpoint never reads a row, never
  // contacts Microsoft, and never writes anything.
  if ((Deno.env.get('OUTLOOK_INTEGRATION_ENABLED') ?? '') !== 'true') {
    return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
  }

  // ── 2. Method ──────────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: securityHeaders })
  }

  try {
    // ── 3. Bounded body ──────────────────────────────────────────────────────
    const raw = await readBoundedStream(req.body, { maxBytes: CALLBACK_MAX_BODY_BYTES })
    if (!raw.ok) {
      console.error('outlook-oauth-callback body_rejected', raw.reason)
      return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
    }
    const parsed = parseCallbackFormBody(raw.text, req.headers.get('content-type'))
    if (!parsed.ok) {
      console.error('outlook-oauth-callback body_rejected', parsed.reason)
      return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
    }
    const { state, code, error } = parsed

    // ── 4. BINDING GATE ──────────────────────────────────────────────────────
    // Before any database access, token exchange or Graph call. The logged
    // reason is a controlled code: never the state, never the cookie, never
    // provider text.
    const binding = verifyMsBrowserBinding(req.headers.get('cookie'), state)
    if (!binding.ok) {
      console.error('outlook-oauth-callback binding_rejected', binding.reason)
      // Canonical redirect: no validated return origin has been read yet, and
      // reading one would require touching the database before the gate passed.
      return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
    }

    // A user-declined consent is a normal outcome. The state is left to expire
    // rather than consumed, exactly as in the Google flow.
    if (error) {
      console.error('outlook-oauth-callback provider_error')
      return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
    }
    if (!code) {
      console.error('outlook-oauth-callback missing_code')
      return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
    }

    // ── 5. State lookup (service role) ───────────────────────────────────
    // Only reached by a BOUND request. The unbound and provider-error paths
    // above return before any database or provider call.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } },
    )
    const stateHash = await sha256Hex(state)
    const { data: row, error: rowError } = await admin
      .from('microsoft_oauth_states')
      .select('state_hash, user_id, pkce_verifier_ciphertext, pkce_verifier_nonce, key_version, return_origin, expires_at, consumed_at')
      .eq('state_hash', stateHash)
      .eq('integration_type', 'outlook')
      .maybeSingle()
    if (rowError) {
      console.error('outlook-oauth-callback state_lookup_failed')
      return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
    }
    if (!row) {
      console.error('outlook-oauth-callback unknown_state')
      return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
    }
    if (row.consumed_at) {
      // Replay. finalize would refuse too, but refusing here stops a replay
      // from ever reaching the provider.
      console.error('outlook-oauth-callback state_consumed')
      return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
    }
    if (!row.expires_at || Date.parse(row.expires_at) <= Date.now()) {
      console.error('outlook-oauth-callback state_expired')
      return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
    }

    // The return origin is trusted because the start function validated it
    // before persisting. Re-validate anyway: defence in depth costs nothing.
    const trustedOrigin = resolveReturnOrigin(row.return_origin)
    const failRedirect = trustedOrigin
      ? buildOutlookSettingsRedirect(trustedOrigin, 'error')
      : OUTLOOK_CANONICAL_ERROR_REDIRECT

    // ── 6. Configuration ─────────────────────────────────────────────────
    const clientId = Deno.env.get('MICROSOFT_CLIENT_ID') ?? ''
    const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET') ?? ''
    const redirectUri = Deno.env.get('OUTLOOK_OAUTH_CALLBACK_URL') ?? ''
    const keyB64 = Deno.env.get('MICROSOFT_TOKEN_ENCRYPTION_KEY_V1') ?? ''
    if (!clientId || !clientSecret || !keyB64) {
      console.error('outlook-oauth-callback config_missing')
      return redirect(failRedirect)
    }
    // The redirect_uri sent to the token endpoint must be the EXACT branded
    // URI, matching outlook-oauth-start's own check. A merely non-empty value
    // would be forwarded to Microsoft as-is; a wrong one cannot succeed and
    // must not cause a code to leave this function at all.
    if (!isValidConfiguredOutlookCallbackUrl(redirectUri)) {
      console.error('outlook-oauth-callback invalid_callback_url_config')
      return redirect(failRedirect)
    }

    // ── 7. Decrypt the PKCE verifier ─────────────────────────────────────
    let verifier
    try {
      const key = await importKeyFromBase64(keyB64)
      verifier = await decryptToken(
        row.pkce_verifier_ciphertext, row.pkce_verifier_nonce, key)
    } catch {
      console.error('outlook-oauth-callback verifier_decrypt_failed')
      return redirect(failRedirect)
    }

    // ── 8. Redeem the code ───────────────────────────────────────────────
    const redeemed = await redeemAuthorizationCode({
      code, codeVerifier: verifier, clientId, clientSecret, redirectUri,
      tokenUrl: endpoints.tokenUrl,
    })
    if (!redeemed.ok) {
      console.error('outlook-oauth-callback token_exchange_failed', redeemed.reason)
      return redirect(failRedirect)
    }

    // ── 9. The user may have declined individual permissions ─────────────
    const sufficiency = grantedScopesSufficient(redeemed.grantedScopes)
    if (!sufficiency.ok) {
      console.error('outlook-oauth-callback insufficient_scopes', sufficiency.missing.join(','))
      return redirect(failRedirect)
    }

    // ── 10. Validate the id_token ────────────────────────────────────────
    // nonce is bound to THIS state, exactly as the start function derived it.
    const expectedNonce = await sha256Hex('nonce:' + state)
    const verified = await verifyMicrosoftIdToken({
      idToken: redeemed.idToken,
      clientId,
      expectedNonce,
      // jose expresses its key argument as a union of its own types. The
      // shared module is provider-agnostic and deliberately does not depend
      // on them, so the boundary is widened here rather than there.
      verifyJwt: (token, keySet, opts) =>
        jwtVerify(token, keySet, opts),
      jwksFor: (tenantUrl) =>
        endpoints.jwksFor(tenantUrl),
    })
    if (!verified.ok) {
      console.error('outlook-oauth-callback id_token_invalid', verified.reason)
      return redirect(failRedirect)
    }

    // Identity comes from the VALIDATED id_token, never from the Graph
    // access token, whose format is not guaranteed.
    const identity = identityFromIdTokenClaims(verified.payload)
    if (!identity.ok) {
      console.error('outlook-oauth-callback identity_incomplete', identity.reason)
      return redirect(failRedirect)
    }

    // ── 11. Resolve the mailbox address from Graph ───────────────────────
    const mailbox = await fetchMailboxAddress({
      accessToken: redeemed.accessToken,
      oid: identity.msAccountId,
      // Labels the mismatch diagnostic only. It comes from the VALIDATED
      // id_token `tid`, and it grants nothing: the comparison is exact for
      // both account types.
      accountType: identity.accountType,
      meUrl: endpoints.graphMeUrl,
    })
    if (!mailbox.ok) {
      // The controlled reason, plus - on an identity mismatch - a diagnostic
      // made only of shapes, lengths and booleans. It cannot contain an oid, a
      // Graph id, an address, a state, a code, a cookie or a token, nor any
      // substring of one. See describeIdentityMismatch.
      console.error('outlook-oauth-callback mailbox_unresolved', mailbox.reason,
        JSON.stringify(mailbox.diagnostic ?? {}))
      return redirect(failRedirect)
    }

    // ── 12. Encrypt and finalize ─────────────────────────────────────────
    let sealedAccess, sealedRefresh
    try {
      const key = await importKeyFromBase64(keyB64)
      sealedAccess = await encryptToken(redeemed.accessToken, key)
      sealedRefresh = await encryptToken(redeemed.refreshToken, key)
    } catch {
      console.error('outlook-oauth-callback token_encrypt_failed')
      return redirect(failRedirect)
    }

    // Scopes are passed through EXACTLY as the provider granted them. The RPC
    // normalizes and enforces the allowlist; fabricating them here would
    // defeat that check.
    const { data: finalized, error: rpcError } = await admin.rpc(
      'finalize_microsoft_connection', {
        p_state_hash: stateHash,
        p_expected_user_id: row.user_id,
        p_ms_account_id: identity.msAccountId,
        p_ms_tenant_id: identity.msTenantId,
        p_account_type: identity.accountType,
        p_ms_email: mailbox.email,
        p_scopes: redeemed.grantedScopes,
        p_token_expires_at: redeemed.expiresAt,
        p_access_ct: sealedAccess.ciphertext,
        p_access_nonce: sealedAccess.nonce,
        p_refresh_ct: sealedRefresh.ciphertext,
        p_refresh_nonce: sealedRefresh.nonce,
        p_key_version: 1,
      })
    if (rpcError) {
      console.error('outlook-oauth-callback finalize_failed')
      return redirect(failRedirect)
    }
    // ONLY the RPC's own stored result counts as success. Anything else is a
    // refusal it made for a reason we must not paper over.
    const result = finalized?.result ?? 'no_result'
    if (result !== 'stored') {
      console.error('outlook-oauth-callback finalize_refused', result)
      return redirect(failRedirect)
    }

    console.error('outlook-oauth-callback connected')
    return redirect(buildOutlookSettingsRedirect(
      trustedOrigin ?? 'https://www.getfunnl.com', 'connected'))
  } catch (e) {
    console.error('outlook-oauth-callback unexpected', e?.name ?? 'error')
    return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
  }
}
