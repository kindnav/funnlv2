// The Microsoft and Graph endpoints the DEPLOYED callback uses.
//
// These are constants, not configuration. Nothing in the deployed path reads an
// environment variable to decide where the authorization code, the client
// secret or the Graph access token are sent, so no environment mistake can
// redirect them.
//
// Tests that need fixture endpoints do NOT change this file and do NOT set any
// variable: they import the handler directly from a separate harness entrypoint
// that is never deployed, and pass their own object. See
// tests/harness/outlook-callback-fixture-entry.ts.

import { createRemoteJWKSet } from 'https://esm.sh/jose@5'
import { MS_TOKEN_ENDPOINT } from '../shared/microsoftOauthHelpers.js'
import { GRAPH_ME_URL } from '../shared/microsoftGraphMe.js'
import { jwksUrlForTenant } from '../shared/microsoftIdToken.js'

/**
 * `jwksFor` receives the TENANT-DERIVED JWKS URL computed by the id_token
 * module and returns a key set. In production that URL is used unchanged, so
 * the signing keys always come from the tenant that claims to have issued the
 * token — and the signature check is what makes that claim trustworthy.
 */
export const PRODUCTION_ENDPOINTS = Object.freeze({
  tokenUrl: MS_TOKEN_ENDPOINT,
  graphMeUrl: GRAPH_ME_URL,
  jwksFor: (tenantDerivedUrl) => createRemoteJWKSet(new URL(tenantDerivedUrl)),
  jwksUrlForTenant,
})
