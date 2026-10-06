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
//   * that owner's contacts - id, user_id and email only - read in bounded pages,
//     because one response holding the whole supported set exceeds the port's body
//     bound. If the owner has MORE than the supported number, the run FAILS here,
//     before any Graph request and before any cursor could advance: matching against a
//     subset would quietly treat a tracked person as a stranger;
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
import { refreshAccessToken, TOKEN_TIMEOUT_MS } from './microsoftTokenExchange.js'
import { GRAPH_FOLDERS } from './outlookGraphTransport.js'

/** Refresh this far ahead of expiry, so a token cannot die mid-run. */
export const EXPIRY_SKEW_SECONDS = 300

/**
 * The largest contact set this worker supports, matching the participant matcher's own
 * MAX_CONTACTS. Above it the run FAILS rather than matching against a subset.
 */
export const MAX_CONTACTS_LOADED = 5000

/**
 * How many contacts to ask for per request, and why it is not MAX_CONTACTS_LOADED.
 *
 * The database port bounds every JSON response at MAX_PROVIDER_BODY_BYTES (256 KiB).
 * Asking for 5000 rows in one response did not work: measured, 5000 rows of
 * {id, user_id, email} serialise to about 809 KB - three times the bound - so the read
 * failed with `response_too_large` and the run reported `contacts_unreadable`. The
 * previous version only appeared to work because its test stubbed the `select` port and
 * never went through the bound.
 *
 * Worst case per row: a 36-character id, a 36-character user_id, an email at the
 * schema's 320-character ceiling, plus JSON punctuation - about 430 bytes. 400 rows is
 * therefore at most ~172 KB, comfortably inside the bound with room for longer keys.
 */
export const CONTACT_PAGE_SIZE = 400

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
  // More contacts than this worker can match against. Failing is the only honest
  // option: matching against a subset would treat a tracked person as a stranger.
  'too_many_contacts',
  'sync_state_unreadable',
  // The round's saved progress could not be read or written. Not strictly a CONTEXT
  // failure, but it belongs in the same controlled vocabulary: it is a reason a run ends
  // without touching a cursor, and it is reported through the same field.
  'progress_unreadable',
  // The INVOCATION budget ran out while preparing the run. The hosted request would
  // otherwise have been killed mid-load, leaving the lease held until it expired; this
  // way the run gives the lease back and says why.
  'context_budget_exhausted',
])

/**
 * One bounded step of the context load, for budget purposes: a single PostgREST read at
 * the worker port's own deadline (endpoints.js DB_TIMEOUT_MS). Declared here rather than
 * imported because endpoints.js belongs to the worker function, not to shared/; a test
 * pins this to RPC_ROUND_TRIP_MS so the two cannot drift apart.
 */
export const CONTEXT_STEP_MS = 15_000

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

  /**
   * The INVOCATION budget, checked between the bounded steps below.
   *
   * WHY THIS EXISTS. Loading the context is the longest stage of a run - a paged contact
   * read plus a token refresh and a rotation RPC, CONTEXT_WORST_MS = 285s - and it used
   * to run with NO reference to the hosted limit at all, because the only budget check
   * lived inside the page loop that comes after it. Reproduced: a 200s context load
   * against a 120s budget returned a 200 'continued' having made zero durable progress,
   * read no mail and saved no checkpoint - and on the real platform the instance was
   * already killed at 150s mid-load, leaving the lease held until it expired.
   *
   * This does NOT make the load resumable. It makes it BOUNDED: the run gives up at a
   * step boundary, releases the lease and reports a controlled reason, instead of being
   * killed. A context load whose real cost exceeds the budget therefore still cannot
   * complete - see the enablement blocker in
   * docs/outlook-durable-continuation-design.md.
   */
  const makeBudget = (opts) => {
    const deadlineMs = Number.isFinite(opts?.deadlineMs)
      ? opts.deadlineMs
      : Number.POSITIVE_INFINITY
    const clock = typeof opts?.now === 'function' ? opts.now : now
    // STRICTLY greater, for the same reason the lease guard is: with exactly the margin
    // left, a step costing its whole worst case finishes at the instant the budget runs
    // out and there is nothing left to release the lease with.
    return (marginMs) => {
      if (deadlineMs - clock() > marginMs) return
      throw new RunContextError('context_budget_exhausted')
    }
  }

  return async function loadRunContext (connectionId, runId, budgetOpts) {
    assertConfigured()
    if (!isNonEmpty(connectionId)) throw new RunContextError('connection_unreadable')
    const budget = makeBudget(budgetOpts)
    budget(CONTEXT_STEP_MS)

    // ── the reserved connection, by id. Only the columns the run uses. ────────
    const conns = await read(
      `microsoft_connections?id=eq.${connectionId}` +
      '&select=user_id,ms_email,scopes,token_expires_at,consent_policy_version&limit=1',
      'connection_unreadable')
    const conn = conns[0]
    if (!conn || !isNonEmpty(conn.user_id) || !isNonEmpty(conn.ms_email)) {
      throw new RunContextError('connection_unreadable')
    }
    const userId = conn.user_id

    // ── that owner's contacts, in bounded pages ──────────────────────────────
    // Only id, user_id and email: the matcher needs the address to match on, the id to
    // attach a suggestion to, and the owner so its own cross-user guard stays a real
    // check rather than a value this module supplied. A name, company or note is never
    // read.
    //
    // Paged because one 5000-row response exceeds the port's body bound. Ordered by id
    // so the pages are stable - PostgREST offsets are not deterministic without it, and
    // an unstable order could both skip and duplicate a contact.
    const contactRows = []
    while (contactRows.length < MAX_CONTACTS_LOADED) {
      // The dominant term: ceil(5000/400) = 13 of the load's 18 bounded calls. Checked
      // per page so a slow mailbox stops at a page boundary rather than being killed.
      budget(CONTEXT_STEP_MS)
      const chunk = await read(
        `contacts?user_id=eq.${userId}&email=not.is.null` +
        `&select=id,user_id,email&order=id.asc` +
        `&limit=${CONTACT_PAGE_SIZE}&offset=${contactRows.length}`,
        'contacts_unreadable')
      for (const row of chunk) contactRows.push(row)
      if (chunk.length < CONTACT_PAGE_SIZE) break     // the last page
    }

    // OVERFLOW, detected rather than ignored. Stopping at exactly MAX_CONTACTS_LOADED is
    // indistinguishable from 'there are more', so ask for one beyond the limit. If it
    // exists, refuse the whole run: a contact left out of the index is not an unknown
    // person, and silently proposing one as a stranger - or deferring a real exchange -
    // would be wrong in a way nobody could see.
    if (contactRows.length >= MAX_CONTACTS_LOADED) {
      const beyond = await read(
        `contacts?user_id=eq.${userId}&email=not.is.null` +
        `&select=id&order=id.asc&limit=1&offset=${MAX_CONTACTS_LOADED}`,
        'contacts_unreadable')
      if (beyond.length > 0) throw new RunContextError('too_many_contacts')
    }

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
    // The remaining steps are the token read, at most one refresh at the exchange's own
    // timeout, and the rotation RPC. Checked as one margin because a refresh that has
    // started cannot be abandoned safely: Microsoft rotates the refresh token, so
    // dropping the response would strand an unusable credential.
    budget(2 * CONTEXT_STEP_MS + TOKEN_TIMEOUT_MS)
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
      // The disclosure version this connection actually agreed to, read from the row
      // rather than from anything the caller supplied. It is copied out of the OAuth
      // state at finalization and CANNOT be upgraded in place, so a connection made
      // under the envelope-only disclosure stays closed until it reconnects. Both
      // content gates are checked against it server-side.
      consentVersion: isNonEmpty(conn.consent_policy_version) ? conn.consent_policy_version : null,
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

/**
 * The matching decryptor, for ONE thing only: a saved @odata.nextLink written by an
 * earlier invocation of the same round.
 *
 * A committed or pending deltaLink never needs this - release takes ciphertext and the
 * ciphertext is already in the row - so the plaintext of a delta cursor exists in exactly
 * the two places it has to: the moment it arrives from Microsoft, and the moment a resumed
 * request uses it.
 *
 * It THROWS on failure rather than returning null. A cursor that will not decrypt must not
 * silently become "start this folder over", which would re-read mail and hide a key
 * problem; the run reports `cursor_undecryptable` and advances nothing.
 */
export function makeCursorDecryptor ({ tokenKeyB64, subtle = globalThis.crypto?.subtle }) {
  let keyPromise = null
  return async function decryptCursor (ciphertext, nonce) {
    if (keyPromise === null) {
      keyPromise = importKeyFromBase64(tokenKeyB64, subtle)
        .catch(() => { throw new RunContextError('key_unusable') })
    }
    const key = await keyPromise
    try {
      return await decryptToken(ciphertext, nonce, key, { subtle })
    } catch {
      throw new RunContextError('cursor_undecryptable')
    }
  }
}
