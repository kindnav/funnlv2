// Deno entry point only. Every decision lives in handler.js so it can be driven from a
// plain Node test; this file reads the environment, builds the production ports, and
// nothing else.
//
// Deployed with verify_jwt = false (supabase/config.toml): Microsoft Graph carries no Funnl
// JWT. Authentication is the per-subscription clientState, whose SHA-256 the database
// compares before any wake-up is recorded, and the subscription id itself - both chosen by
// Funnl at creation time and known only to Funnl and Microsoft.
import { handleOutlookNotifications, makeWorkerKick } from './handler.js'
import { makePostgrestPorts } from '../outlook-import-worker/endpoints.js'

const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
const ports = makePostgrestPorts({
  url: supabaseUrl,
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
})
// The kick reuses the worker's existing shared secret (OUTLOOK_WORKER_SECRET) - the same
// value the scheduled tick presents. No new credential exists for this path.
const kick = makeWorkerKick({
  workerUrl: supabaseUrl ? `${supabaseUrl}/functions/v1/outlook-import-worker` : '',
  workerSecret: Deno.env.get('OUTLOOK_WORKER_SECRET') ?? '',
})

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined

Deno.serve((req: Request) => handleOutlookNotifications(req, {
  integrationEnabled: Deno.env.get('OUTLOOK_INTEGRATION_ENABLED') ?? null,
}, {
  rpc: ports.rpc,
  kick,
  // Supabase's edge runtime keeps a background promise alive after the response is sent;
  // without it the kick would still be started, and would simply not be awaited.
  waitUntil: (p: Promise<unknown>) => {
    if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime?.waitUntil === 'function') EdgeRuntime.waitUntil(p)
  },
}))
