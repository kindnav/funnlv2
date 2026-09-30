// Everything ONE reserved Outlook connection needs for a run, loaded server-side.
//
// WHAT THIS REPLACES. runOutlookImport has always taken a `loadRunContext` port so the
// run could be driven with fixtures. Until now the only implementation was a test stub
// that handed over a plaintext access token. This is the real one: the caller supplies
// no user id, no connection id, no token, no cursor and no candidate content - the
// connection id comes from the reservation RPC, and everything else is read here.
//
// WHAT IT LOADS, AND NOTHING MORE. Scoped to the single connection the reservation
// returned:
//   * the owner (microsoft_connections.user_id) and mailbox address;
//   * that owner's contacts, id + email only - the fields the participant matcher needs;
//   * the two encrypted delta cursors, decrypted in memory;
//   * the encrypted access and refresh tokens, decrypted in memory.
// It never lists connections, never reads another user's rows, and never selects a
// column it does not use.
//
// TOKEN HANDLING.
//   * The token-encryption key is imported once from the caller-supplied base64 secret
//     as a NON-EXTRACTABLE AES-GCM key (googleTokenCrypto.js, unchanged - the module is
//     provider-neutral despite its name, and duplicating it for Microsoft would mean
//     two implementations of the same primitive).
//   * If the stored access token is absent or within EXPIRY_SKEW_SECONDS of expiry, it
//     is refreshed at Microsoft's fixed token endpoint using the existing confidential
//     -client exchange (microsoftTokenExchange.refreshAccessToken), which already sends
//     the secret only to that endpoint, bounds the body and refuses redirects.
//   * A refreshed token is persisted through rotate_microsoft_access_token BEFORE the
//     run uses it, so a rotated refresh token is never lost. Microsoft invalidates the
//     old refresh token when it rotates one, so losing the new one would break the
//     connection permanently.
//
// WHAT NEVER LEAVES THIS MODULE. A plaintext token, a refresh token, the client secret,
// a ciphertext, a nonce, a delta cursor, or the encryption key. It returns a context
// object for the run and a controlled reason code on failure; it logs nothing at all.
//
// FAIL CLOSED. A missing client id, client secret, token URL or encryption key is a
// configuration failure, not a runtime one: the loader refuses before reading anything.

import { importKeyFromBase64, encryptToken, decryptToken } from './googleTokenCrypto.js'
import { refreshAccessToken } from './microsoftTokenExchange.js'
import { GRAPH_FOLDERS } from './outlookGraphTransport.js'

/** Refresh this far ahead of expiry, so a token cannot die mid-run. */
export const EXPIRY_SKEW_SECONDS = 300

/** Contacts are loaded for the matcher, so the read is bounded like the matcher is. */
export const MAX_CONTACTS_LOADED = 5000

/** Every reason a context load can fail. Controlled; safe to log. */
export const CONTEXT_FAILURES = Object.freeze([
  'config_missing',          // client id / secret / token url / encryption key absent
  'key_unusable',            // the encryption key is present but not a 32-byte base64
  'connection_unreadable',   // the reserved connection could not be read back
  'token_row_missing',       // the connection has no token row
  'token_undecryptable',     // wrong key, or the ciphertext was tampered with
  'cursor_undecryptable',    // a stored delta cursor could not be decrypted
  'refresh_failed',          // Microsoft refused or was unreachable
  'rotation_not_persisted',  // the refreshed token could not be stored
  'contacts_unreadable',
  'sync_state_unreadable',
])

const isNonEmpty = (v) => typeof v === 'string' && v.length > 0

/**
 * A controlled error carrying a reason code and nothing else. Deliberately not an
 * Error subclass carrying a provider message: a thrown provider message can contain a
 * URL or an address, and this is the value that crosses back into the handler.
 */
export class RunContextError extends Error {
  constructor (reason) {
    super(reason)
    this.name = 'RunContextError'
    this.reason = CONTEXT_FAILURES.includes(reason) ? reason : 'connection_unreadable'
  }
}

/**
 * Build the loader runOutlookImport will call with the reserved connection id.
 *
 * @param {object} p
 * @param {(path: string) => Promise<{data: any, error: any}>} p.select
 *        one PostgREST read, AS THE SERVICE ROLE. Injected rather than importing
 *        supabase-js so the redirect and bounding policy stays with the caller.
 * @param {(name: string, args: object) => Promise<{data: any, error: any}>} p.rpc
 * @param {{clientId: string, clientSecret: string, tokenUrl: string, tokenKeyB64: string,
 *          keyVersion?: number, scope?: string}} p.config
 * @param {{fetchImpl?: Function, subtle?: SubtleCrypto, now?: () => number}} [p.deps]
 */
export function makeRunContextLoader ({ select, rpc, config, deps = {} }) {
  if (typeof select !== 'function') throw new Error('select_not_injected')
  if (typeof rpc !== 'function') throw new Error('rpc_not_injected')

  const cfg = config || {}
  const now = deps.now ?? (() => Date.now())
  const subtle = deps.subtle ?? globalThis.crypto?.subtle
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  let keyPromise = null

  /** Imported once per loader, and only when first needed. */
  const tokenKey = () => {
    if (keyPromise === null) {
      keyPromise = importKeyFromBase64(cfg.tokenKeyB64, subtle)
        .catch(() => { throw new RunContextError('key_unusable') })
    }
    return keyPromise
  }

  /** Fail closed before touching the database. */
  function assertConfigured () {
    for (const v of [cfg.clientId, cfg.clientSecret, cfg.tokenUrl, cfg.tokenKeyB64]) {
      if (!isNonEmpty(v)) throw new RunContextError('config_missing')
    }
  }

  async function read (path, failure) {
    let res
    try {
      res = await select(path)
    } catch {
      throw new RunContextError(failure)
    }
    if (res?.error || !Array.isArray(res?.data)) throw new RunContextError(failure)
    return res.data
  }

  return async function loadRunContext (connectionId, runId) {
    assertConfigured()
    if (!isNonEmpty(connectionId)) throw new RunContextError('connection_unreadable')

    // ── the reserved connection, by id. Only the columns the run uses. ────────
    const conns = await read(
      `microsoft_connections?id=eq.${connectionId}` +
      '&select=user_id,ms_email,scopes,token_expires_at&limit=1',
      'connection_unreadable')
    const conn = conns[0]
    if (!conn || !isNonEmpty(conn.user_id) || !isNonEmpty(conn.ms_email)) {
      throw new RunContextError('connection_unreadable')
    }
    const userId = conn.user_id

    // ── that owner's contacts. id + email only: a name is not needed to match. ─
    const contactRows = await read(
      `contacts?user_id=eq.${userId}&email=not.is.null` +
      `&select=id,user_id,email&limit=${MAX_CONTACTS_LOADED}`,
      'contacts_unreadable')

    // ── the encrypted cursors ────────────────────────────────────────────────
    const stateRows = await read(
      `outlook_sync_state?connection_id=eq.${connectionId}` +
      '&select=folder,delta_link_ciphertext,delta_link_nonce',
      'sync_state_unreadable')
    const key = await tokenKey()
    const cursors = {}
    for (const folder of GRAPH_FOLDERS) {
      const row = stateRows.find((r) => r.folder === folder)
      if (!row || !isNonEmpty(row.delta_link_ciphertext) || !isNonEmpty(row.delta_link_nonce)) {
        cursors[folder] = null        // a first pass for this folder
        continue
      }
      try {
        cursors[folder] = await decryptToken(row.delta_link_ciphertext, row.delta_link_nonce, key, { subtle })
      } catch {
        // A cursor that cannot be decrypted must not silently become "start over":
        // that would re-read the whole mailbox. Refuse and let a human look.
        throw new RunContextError('cursor_undecryptable')
      }
    }

    // ── the tokens ───────────────────────────────────────────────────────────
    const tokenRows = await read(
      `microsoft_tokens?connection_id=eq.${connectionId}` +
      '&select=access_token_ciphertext,access_token_nonce,refresh_token_ciphertext,' +
      'refresh_token_nonce,key_version,token_expires_at&limit=1',
      'connection_unreadable')
    const tok = tokenRows[0]
    if (!tok) throw new RunContextError('token_row_missing')

    let accessToken = null
    if (isNonEmpty(tok.access_token_ciphertext) && isNonEmpty(tok.access_token_nonce)) {
      try {
        accessToken = await decryptToken(tok.access_token_ciphertext, tok.access_token_nonce, key, { subtle })
      } catch {
        throw new RunContextError('token_undecryptable')
      }
    }

    const expiresAt = tok.token_expires_at ?? conn.token_expires_at ?? null
    const expiresMs = expiresAt === null ? 0 : Date.parse(expiresAt)
    const stale = accessToken === null
      || !Number.isFinite(expiresMs)
      || expiresMs - now() <= EXPIRY_SKEW_SECONDS * 1000

    if (stale) {
      if (!isNonEmpty(tok.refresh_token_ciphertext) || !isNonEmpty(tok.refresh_token_nonce)) {
        // Nothing to refresh with. The user must reconnect; this run cannot proceed.
        throw new RunContextError('refresh_failed')
      }
      let refreshTokenPlain
      try {
        refreshTokenPlain = await decryptToken(
          tok.refresh_token_ciphertext, tok.refresh_token_nonce, key, { subtle })
      } catch {
        throw new RunContextError('token_undecryptable')
      }

      const refreshed = await refreshAccessToken({
        refreshToken: refreshTokenPlain,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        scope: cfg.scope,
        tokenUrl: cfg.tokenUrl,
        fetchImpl,
        now,
      })
      if (!refreshed.ok) throw new RunContextError('refresh_failed')

      // Persist BEFORE the run uses it. Microsoft invalidates the old refresh token
      // when it rotates one, so a rotated token that is not stored breaks the
      // connection for good.
      const keyVersion = Number.isInteger(cfg.keyVersion) ? cfg.keyVersion : (tok.key_version ?? 1)
      const enc = await encryptToken(refreshed.accessToken, key, { subtle })
      let rot = null
      if (refreshed.rotated) rot = await encryptToken(refreshed.refreshToken, key, { subtle })

      let persisted
      try {
        persisted = await rpc('rotate_microsoft_access_token', {
          p_connection_id: connectionId,
          p_run_id: runId ?? null,
          p_access_ct: enc.ciphertext,
          p_access_nonce: enc.nonce,
          p_refresh_ct: rot ? rot.ciphertext : null,
          p_refresh_nonce: rot ? rot.nonce : null,
          p_key_version: keyVersion,
          p_token_expires_at: refreshed.expiresAt,
        })
      } catch {
        throw new RunContextError('rotation_not_persisted')
      }
      if (persisted?.error || persisted?.data?.result !== 'rotated') {
        throw new RunContextError('rotation_not_persisted')
      }
      accessToken = refreshed.accessToken
    }

    return {
      userId,
      primaryEmail: conn.ms_email,
      aliases: [],
      // The connection carries no time zone, and guessing one would put a late-evening
      // exchange on the wrong day. UTC is the stated, deterministic choice until a
      // per-user zone exists to read.
      timeZone: 'UTC',
      contacts: contactRows,
      cursors,
      accessToken,
      keyRing: cfg.keyRing,
      refreshed: stale,
    }
  }
}

/**
 * The cursor encryptor runOutlookImport needs, bound to the same key.
 * Separate from the loader so the run never sees key material either.
 */
export function makeCursorEncryptor ({ tokenKeyB64, keyVersion = 1, subtle = globalThis.crypto?.subtle }) {
  let keyPromise = null
  return async function encryptCursor (plaintext) {
    if (keyPromise === null) {
      keyPromise = importKeyFromBase64(tokenKeyB64, subtle)
        .catch(() => { throw new RunContextError('key_unusable') })
    }
    const key = await keyPromise
    const { ciphertext, nonce } = await encryptToken(plaintext, key, { subtle })
    return { ciphertext, nonce, keyVersion }
  }
}
