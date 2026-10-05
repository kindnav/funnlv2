// outlook-oauth-callback — deployable entrypoint.
//
// Deliberately thin. All logic lives in handler.js so that the endpoints it
// talks to are PARAMETERS rather than configuration. This file passes the fixed
// production constants and reads no endpoint environment variable, so there is
// no branch in deployed code that can send the authorization code, the client
// secret or the Graph access token anywhere other than Microsoft.
//
// The integration suite exercises the same handler through a separate harness
// entrypoint that is never deployed (tests/harness/outlook-callback-fixture-entry.ts).

import { handleOutlookCallback } from './handler.js'
import { PRODUCTION_ENDPOINTS } from './endpoints.js'

Deno.serve((req: Request) => handleOutlookCallback(req, PRODUCTION_ENDPOINTS))
