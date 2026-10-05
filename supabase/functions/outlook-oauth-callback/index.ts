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
//   5. (next slice) token exchange, id_token validation, finalize RPC
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
import { OUTLOOK_CANONICAL_ERROR_REDIRECT } from '../shared/microsoftOauthHelpers.js'

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
function redirect (location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...securityHeaders,
      'Set-Cookie': buildClearedMsBindingCookie(),
      Location: location,
    },
  })
}

Deno.serve(async (req) => {
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

    // ── 5. NEXT SLICE ────────────────────────────────────────────────────────
    // Still to come, deliberately not in this reviewable slice:
    //   - redeem `code` at MS_TOKEN_ENDPOINT with the decrypted PKCE verifier
    //   - validate the id_token: JWKS signature, iss, aud === MICROSOFT_CLIENT_ID,
    //     exp/nbf, and nonce === sha256('nonce:' + state)
    //   - derive identity via identityFromIdTokenClaims (NEVER by decoding the
    //     Graph access token, whose format is not guaranteed)
    //   - encrypt tokens and call finalize_microsoft_connection, which consumes
    //     the state, enforces the scope allowlist and copies consent evidence
    // Until then the flow stops here and reports failure rather than pretending
    // to connect. This endpoint is unreachable in Production anyway: the
    // dormancy gate above returns first.
    console.error('outlook-oauth-callback not_implemented_exchange')
    return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
  } catch (e) {
    console.error('outlook-oauth-callback unexpected', (e as Error)?.name ?? 'error')
    return redirect(OUTLOOK_CANONICAL_ERROR_REDIRECT)
  }
})
