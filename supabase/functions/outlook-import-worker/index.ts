// Deno entry point only. Every decision lives in handler.js so it can be driven from
// a plain Node test; this file exists to read the environment and nothing else.
import { handleOutlookImportWorker } from './handler.js'

Deno.serve((req: Request) => handleOutlookImportWorker(req, {
  integrationEnabled: Deno.env.get('OUTLOOK_INTEGRATION_ENABLED') ?? null,
  workerEnabled: Deno.env.get('OUTLOOK_IMPORT_WORKER_ENABLED') ?? null,
  workerSecret: Deno.env.get('OUTLOOK_WORKER_SECRET') ?? null,
}))
