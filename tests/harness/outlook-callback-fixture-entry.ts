// TEST HARNESS ONLY. Never deployed.
//
// This file exists so the integration suite can drive the REAL callback handler
// against local fixture endpoints WITHOUT the deployable code containing any
// branch that could redirect Microsoft or Graph traffic.
//
// It lives outside supabase/functions deliberately: `supabase functions deploy
// outlook-oauth-callback` uploads that directory, so a fixture entrypoint kept
// inside it could be shipped by accident. Nothing here is reachable from
// supabase/functions/outlook-oauth-callback/index.ts, which imports only
// PRODUCTION_ENDPOINTS.
//
// The endpoint values come from arguments this process is started with, not from
// anything the production handler consults.

import { createRemoteJWKSet } from 'https://esm.sh/jose@5'
import { handleOutlookCallback } from '../../supabase/functions/outlook-oauth-callback/handler.js'

const base = Deno.env.get('FIXTURE_BASE') ?? ''
if (!base) {
  console.error('fixture harness requires FIXTURE_BASE')
  Deno.exit(1)
}

const fixtureEndpoints = {
  tokenUrl: `${base}/token`,
  graphMeUrl: `${base}/me`,
  // Every tenant resolves to the one local key set. The handler still computes
  // the tenant-derived URL and still pins the issuer to that tenant; only the
  // transport is redirected here.
  jwksFor: (_tenantDerivedUrl: string) => createRemoteJWKSet(new URL(`${base}/jwks`)),
}

Deno.serve((req: Request) => handleOutlookCallback(req, fixtureEndpoints))
