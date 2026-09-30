// The Microsoft endpoint and the database ports the DEPLOYED worker uses.
//
// The token URL is a CONSTANT, not configuration: nothing in the deployed path reads an
// environment variable to decide where the client secret and the refresh token are sent.
// It is the same constant the OAuth callback redeems against.
//
// OUTBOUND REQUEST AUDIT — what this function can talk to, and what each request
// carries:
//
//   1. MS_TOKEN_ENDPOINT   POST  client secret + refresh token
//                                redirect: 'error'  (microsoftTokenExchange.js)
//   2. graph.microsoft.com GET   Authorization: Bearer <graph access token>
//                                redirect: 'manual', and the Location header is never
//                                read  (outlookGraphTransport.js)
//   3. SUPABASE_URL/rest/v1  the project's own PostgREST, with the service-role key.
//                                redirect: 'error' on every call - see below.
//
// Unlike the OAuth callback, this function does NOT use supabase-js: the two database
// ports below are plain fetch, so their redirect policy is ours rather than a library's.
// That is the whole reason for writing them out here.
//
// NEVER LOGGED, and this module logs nothing at all: the service-role key, the client
// secret, a token, a ciphertext, a nonce, a delta cursor, a row, or a provider body.

import { MS_TOKEN_ENDPOINT } from '../shared/microsoftOauthHelpers.js'
import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from '../shared/boundedJson.js'

/** One deadline per database call, covering the request and the body read. */
export const DB_TIMEOUT_MS = 15_000

/**
 * Build the `select` and `rpc` ports over the project's own PostgREST.
 *
 * Both refuse redirects: a 307 or 308 preserves method and body, so a followed redirect
 * would repost the service-role key - and, for an RPC, a token ciphertext - to whatever
 * host the response named.
 *
 * @param {{url: string, serviceRoleKey: string, fetchImpl?: Function}} p
 */
export function makePostgrestPorts ({ url, serviceRoleKey, fetchImpl = globalThis.fetch }) {
  const base = String(url ?? '').replace(/\/+$/, '')
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  async function call (path, init) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), DB_TIMEOUT_MS)
    try {
      let res
      try {
        res = await fetchImpl(`${base}/rest/v1/${path}`, {
          ...init,
          headers,
          signal: ctrl.signal,
          redirect: 'error',
        })
      } catch {
        // The thrown message can contain the URL and the key; only a flag survives.
        return { data: null, error: { code: 'unreachable' } }
      }
      if (!res || typeof res.status !== 'number') return { data: null, error: { code: 'malformed' } }
      if (res.status >= 400) {
        // The PostgREST body can name columns and values. Only the status class is kept.
        return { data: null, error: { code: res.status >= 500 ? 'server_error' : 'rejected' } }
      }
      const read = await readJsonBounded(res, MAX_PROVIDER_BODY_BYTES)
      if (!read.ok) return { data: null, error: { code: 'malformed' } }
      return { data: read.value, error: null }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    select: (path) => call(path, { method: 'GET' }),
    rpc: (name, args) => call(`rpc/${name}`, {
      method: 'POST',
      body: JSON.stringify(args ?? {}),
    }),
  }
}

/** The fixed provider endpoint the deployed worker refreshes against. */
export const PRODUCTION_TOKEN_URL = MS_TOKEN_ENDPOINT
