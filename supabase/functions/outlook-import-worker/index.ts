// Deno entry point only. Every decision lives in handler.js so it can be driven from a
// plain Node test; this file reads the environment, builds the production ports, and
// nothing else.
//
// The fingerprint key ring is assembled here from a base64 secret. It does not exist in
// any environment, so `fingerprintKey` is null and the handler fails closed with
// `config_missing` — which is the correct answer until the key is provisioned. The same
// is true of OUTLOOK_PILOT_USER_ID: unset, no account is importable at all.
import { handleOutlookImportWorker } from './handler.js'
import { makePostgrestPorts, PRODUCTION_TOKEN_URL } from './endpoints.js'
import { base64ToBytes } from '../shared/googleTokenCrypto.js'
import { OUTLOOK_CANONICAL_SCOPES } from '../shared/microsoftOauthHelpers.js'
import { PILOT_USER_ENV } from '../shared/outlookPilotGate.js'

function fingerprintKeyRing(b64: string, version: number) {
  if (!b64) return null
  try {
    const keyBytes = base64ToBytes(b64)
    if (keyBytes.length === 0) return null
    return { current: { keyBytes, keyVersion: version } }
  } catch {
    return null
  }
}

Deno.serve((req: Request) => {
  const keyVersion = Number(Deno.env.get('OUTLOOK_KEY_VERSION') ?? '1') || 1
  const ports = makePostgrestPorts({
    url: Deno.env.get('SUPABASE_URL') ?? '',
    serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  })
  return handleOutlookImportWorker(req, {
    integrationEnabled: Deno.env.get('OUTLOOK_INTEGRATION_ENABLED') ?? null,
    workerEnabled: Deno.env.get('OUTLOOK_IMPORT_WORKER_ENABLED') ?? null,
    workerSecret: Deno.env.get('OUTLOOK_WORKER_SECRET') ?? null,
    clientId: Deno.env.get('MICROSOFT_CLIENT_ID') ?? null,
    clientSecret: Deno.env.get('MICROSOFT_CLIENT_SECRET') ?? null,
    tokenKeyB64: Deno.env.get('MICROSOFT_TOKEN_ENCRYPTION_KEY_V1') ?? null,
    fingerprintKey: fingerprintKeyRing(
      Deno.env.get('OUTLOOK_FINGERPRINT_HMAC_KEY_V1') ?? '', keyVersion),
    // The one designated pilot account. Absent, the handler refuses `config_missing`
    // before reading a row - the same fail-closed decision the run's own gate would take,
    // one step earlier and without reserving a lease to release it again.
    pilotUserId: Deno.env.get(PILOT_USER_ENV) ?? null,
    // Shared with the existing AI features. Not configured for this function today,
    // and not required: without it the run reports every conversation's deferral and
    // writes the metadata candidate it writes now. It is read only AFTER both consent
    // gates pass against the connection's own recorded disclosure version.
    anthropicApiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? null,
    // Where Microsoft Graph POSTs change notifications: the deployed outlook-notifications
    // function of this very project. Derived from SUPABASE_URL unless overridden, so no
    // environment names a URL it does not own.
    notificationUrl: Deno.env.get('OUTLOOK_NOTIFICATION_URL')
      ?? (Deno.env.get('SUPABASE_URL') ? `${(Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')}/functions/v1/outlook-notifications` : null),
    keyVersion,
    scope: OUTLOOK_CANONICAL_SCOPES.join(' '),
  }, {
    tokenUrl: PRODUCTION_TOKEN_URL,
    select: ports.select,
    rpc: ports.rpc,
  })
})
