// The Microsoft and Graph endpoints the DEPLOYED callback uses.
//
// These are constants, not configuration. Nothing in the deployed path reads an
// environment variable to decide where the authorization code, the client
// secret or the Graph access token are sent.
//
// OUTBOUND REQUEST AUDIT — what this function can talk to, and what each
// request carries:
//
//   1. MS_TOKEN_ENDPOINT   POST  code + client secret + PKCE verifier
//                                redirect: 'error'  (microsoftTokenExchange.js)
//   2. GRAPH_ME_URL        GET   Authorization: Bearer <graph access token>
//                                redirect: 'error'  (microsoftGraphMe.js)
//   3. tenant JWKS URL     GET   no credential at all
//                                redirect: 'error'  (microsoftJwks.js)
//   4. SUPABASE_URL        the project's own PostgREST, via supabase-js, with
//                          the service-role key. Not a provider endpoint; its
//                          redirect handling belongs to supabase-js and is NOT
//                          controlled here. Worth stating rather than implying
//                          otherwise.
//
// The claim this file supports is therefore narrow and checkable: for the three
// provider requests above, a 3xx response is refused rather than followed, so
// those requests cannot be redirected to another host. It is NOT a claim that
// no credential can ever leave this function by any route.
//
// Tests that need fixture endpoints do NOT change this file and set no variable:
// they import the handler from a separate harness entrypoint that is never
// deployed. See tests/harness/outlook-callback-fixture-entry.ts.

import { createLocalJWKSet } from 'https://esm.sh/jose@5'
import { MS_TOKEN_ENDPOINT } from '../shared/microsoftOauthHelpers.js'
import { GRAPH_ME_URL } from '../shared/microsoftGraphMe.js'
import { jwksUrlForTenant } from '../shared/microsoftIdToken.js'
import { fetchJwks } from '../shared/microsoftJwks.js'

/**
 * `jwksFor` receives the TENANT-DERIVED JWKS URL computed by the id_token
 * module. The document is fetched here, under our own redirect policy and
 * bounds, and handed to jose as a LOCAL key set — rather than letting jose
 * perform an uncontrolled fetch of its own.
 *
 * Throwing on failure is deliberate: verifyMicrosoftIdToken treats any throw
 * from jwksFor as 'signature_or_key_invalid', which is the correct outcome when
 * the signing keys cannot be established.
 */
export const PRODUCTION_ENDPOINTS = Object.freeze({
  tokenUrl: MS_TOKEN_ENDPOINT,
  graphMeUrl: GRAPH_ME_URL,
  jwksFor: async (tenantDerivedUrl) => {
    const res = await fetchJwks(tenantDerivedUrl)
    if (!res.ok) throw new Error(res.reason)
    return createLocalJWKSet(res.jwks)
  },
  jwksUrlForTenant,
})
