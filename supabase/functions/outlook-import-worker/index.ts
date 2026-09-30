// Deno entry point only. Every decision lives in handler.js so it can be driven from a
// plain Node test; this file reads the environment, builds the production ports, and
// nothing else.
//
// The fingerprint key ring is assembled here from a base64 secret. It does not exist in
// any environment, so `fingerprintKey` is null and the handler fails closed with
// `config_missing` — which is the correct answer until the key is provisioned.
import { handleOutlookImportWorker } from './handler.js'
import { makePostgrestPorts, PRODUCTION_TOKEN_URL } from './endpoints.js'
import { base64ToBytes } from '../shared/googleTokenCrypto.js'
import { OUTLOOK_CANONICAL_SCOPES } from '../shared/microsoftOauthHelpers.js'

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
    keyVersion,
    scope: OUTLOOK_CANONICAL_SCOPES.join(' '),
  }, {
    tokenUrl: PRODUCTION_TOKEN_URL,
    select: ports.select,
    rpc: ports.rpc,
  })
})
