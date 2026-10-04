// An IN-MEMORY MIRROR of the four round-progress RPCs from migration
// 20261002000000_outlook_durable_continuation.sql.
//
// WHY A MIRROR EXISTS AT ALL. The lease, budget and commit-gate tests need a database
// that answers record_outlook_page_progress and friends, but they are not tests OF the
// SQL - they drive runOutlookImport with a virtual clock and fixture Graph responses,
// which no real Postgres round trip could keep up with.
//
// WHERE THE AUTHORITY ACTUALLY IS. The SQL is the contract. It is exercised for real by
// tests/sql/outlook-durable-continuation-runtime.sql against a disposable Postgres, and
// end to end by tests/local/outlook-worker-token-access.mjs through real PostgREST. This
// file is a convenience, and a test pins its merge rules against the SQL's so the two
// cannot quietly drift: if you change a merge rule in one, change it in the other.
//
// WHAT IT DELIBERATELY DOES NOT DO: the lease fence. The suites that use it supply their
// own reserve/renew/release answers, and `refuse()` below is how a test makes a
// checkpoint come back stale.

import { GRAPH_FOLDERS } from '../../supabase/functions/shared/outlookGraphTransport.js'

/** Mirrors the constants inside record_outlook_page_progress. */
export const MAX_PAGES_PER_ROUND = 200
export const MAX_MESSAGES_PER_ROUND = 10_000
export const MAX_CONVERSATIONS_PER_ROUND = 2_000
export const MAX_EPISODE_MESSAGES = 50
/** The measured safe page size the SQL caps every read-back at. */
export const CONVERSATION_PAGE_SIZE = 200

const blankFolder = () => ({
  round_id: null,
  page_seq: 0,
  pages: 0,
  messages: 0,
  messages_dropped: 0,
  conversations_dropped: 0,
  folder_complete: false,
  write_cursor: null,
  // The round's ONE deadline, mirrored on both folder rows. Milliseconds, or null for no
  // round. Expiry is decided from the EARLIER of the two, exactly as the SQL does.
  round_expires_ms: null,
  next_link_ciphertext: null,
  next_link_nonce: null,
  next_link_key_version: null,
  pending_delta_ciphertext: null,
  pending_delta_nonce: null,
  pending_delta_key_version: null,
  delta_link_ciphertext: null,
  delta_link_nonce: null,
})

export function makeRoundStore ({ clock } = {}) {
  const folders = Object.fromEntries(GRAPH_FOLDERS.map((f) => [f, blankFolder()]))
  /** conversation fingerprint -> accumulated record */
  const conversations = new Map()
  const refusals = new Map()
  const calls = []

  const nowMs = () => (typeof clock === 'function' ? clock() : Date.now())
  const committedOf = (f) => ({
    delta_link_ciphertext: folders[f].delta_link_ciphertext,
    delta_link_nonce: folders[f].delta_link_nonce,
  })
  /** The EARLIER of the two folder deadlines governs, so a disagreement fails to expired. */
  const roundExpired = () => {
    const ends = GRAPH_FOLDERS
      .filter((f) => folders[f].round_id !== null)
      .map((f) => folders[f].round_expires_ms)
    if (ends.length === 0) return false
    const earliest = ends.reduce((a, b) => (a === null || (b !== null && b < a) ? b : a), null)
    return earliest !== null && earliest <= nowMs()
  }
  const discardRound = () => {
    conversations.clear()
    for (const f of GRAPH_FOLDERS) {
      folders[f] = { ...blankFolder(), ...committedOf(f) }
    }
  }

  const refuse = (name, result) => { refusals.set(name, result) }
  const allow = (name) => { refusals.delete(name) }

  const handle = async (name, args) => {
    calls.push(name)
    if (refusals.has(name)) {
      return { data: { result: refusals.get(name) }, error: null }
    }

    if (name === 'read_outlook_round_progress') {
      const expired = roundExpired()
      return {
        data: {
          result: 'ok',
          // Reported HONESTLY, not as `no round`: pretending there is none is what made
          // the worker invent an id that every checkpoint then refused.
          round_expired: expired,
          folders: Object.fromEntries(GRAPH_FOLDERS.map((f) => [f,
            expired ? { ...blankFolder(), ...committedOf(f) } : { ...folders[f] }])),
        },
        error: null,
      }
    }

    if (name === 'reset_outlook_round') {
      // Exactly like the SQL: the round goes AS A UNIT, the COMMITTED cursor does not.
      discardRound()
      return { data: { result: 'reset' }, error: null }
    }

    if (name === 'list_outlook_round_conversations') {
      // An expired round is not finalised: its records are about to be discarded, so
      // listing it would let a cursor advance past whatever is missing.
      if (roundExpired()) return { data: { result: 'round_expired' }, error: null }
      // p_after is the finalisation resume point: only conversations ordered strictly
      // after it, exactly as the SQL filters them.
      const after = typeof args?.p_after === 'string' && args.p_after.length > 0
        ? args.p_after
        : null
      const rows = [...conversations.values()]
        .filter((r) => after === null || r.cfp > after)
        .sort((a, b) => a.cfp.localeCompare(b.cfp))
      // Capped exactly as the SQL caps it: a caller asking for more than fits would
      // otherwise get a body its own port refuses to read.
      const limit = Math.min(
        Number.isInteger(args?.p_limit) ? args.p_limit : CONVERSATION_PAGE_SIZE,
        CONVERSATION_PAGE_SIZE)
      // WHOLE-ROUND, not per page: a shortened exchange anywhere in the round forfeits
      // every cursor of it, however many pages later the caller reaches the end.
      const truncatedEpisodes = [...conversations.values()]
        .filter((r) => r.taint === 'episode_truncated').length
      return {
        data: {
          result: 'ok',
          more_rows: rows.length > limit,
          round_truncated_episodes: truncatedEpisodes,
          conversations: rows.slice(0, limit),
        },
        error: null,
      }
    }

    if (name === 'advance_outlook_round_write_cursor') {
      if (roundExpired()) return { data: { result: 'round_expired' }, error: null }
      const after = args?.p_after
      if (typeof after !== 'string' || !/^[0-9a-f]{64}$/.test(after)) {
        return { data: { result: 'invalid_cursor' }, error: null }
      }
      for (const f of GRAPH_FOLDERS) {
        if (folders[f].round_id !== args.p_round_id) {
          return { data: { result: 'round_mismatch' }, error: null }
        }
      }
      // MONOTONE, like the SQL: a late or duplicated call cannot rewind finalisation.
      for (const f of GRAPH_FOLDERS) {
        if (folders[f].write_cursor === null || after > folders[f].write_cursor) {
          folders[f].write_cursor = after
        }
      }
      return {
        data: { result: 'advanced', write_cursor: folders.inbox.write_cursor },
        error: null,
      }
    }

    if (name === 'record_outlook_page_progress') {
      if (!folders[args.p_folder]) return { data: { result: 'invalid_folder' }, error: null }
      // A DIFFERENT round is here: discard it if it has expired, refuse if it is live.
      const other = GRAPH_FOLDERS.some(
        (f) => folders[f].round_id !== null && folders[f].round_id !== args.p_round_id)
      if (other) {
        if (!roundExpired()) return { data: { result: 'round_mismatch' }, error: null }
        discardRound()
      } else if (roundExpired()) {
        // The CURRENT round is dead; it must not be extended by another page.
        return { data: { result: 'round_expired' }, error: null }
      }
      const folder = folders[args.p_folder]
      if (args.p_page_seq <= folder.page_seq) {
        return {
          data: {
            result: 'duplicate_page',
            round_pages: folder.pages,
            round_messages: folder.messages,
          },
          error: null,
        }
      }
      if (args.p_page_seq !== folder.page_seq + 1) {
        return { data: { result: 'page_seq_gap' }, error: null }
      }
      if (folder.pages + 1 > MAX_PAGES_PER_ROUND) {
        return { data: { result: 'round_page_cap' }, error: null }
      }
      if (folder.messages + (args.p_messages_seen ?? 0) > MAX_MESSAGES_PER_ROUND) {
        return { data: { result: 'round_message_cap' }, error: null }
      }

      let dropped = 0
      for (const c of args.p_conversations ?? []) {
        const existing = conversations.get(c.cfp)
        if (existing === undefined) {
          if (conversations.size >= MAX_CONVERSATIONS_PER_ROUND) { dropped += 1; continue }
          conversations.set(c.cfp, {
            cfp: c.cfp,
            pfp: c.pfp ?? null,
            efp: c.efp ?? null,
            elookup: c.elookup ?? null,
            first_fp: c.first_fp ?? null,
            first_at: c.first_at ?? null,
            last_at: c.last_at ?? null,
            contact_id: c.contact_id ?? null,
            key_version: c.key_version ?? null,
            inbound: c.inbound ?? 0,
            outbound: c.outbound ?? 0,
            messages: c.messages ?? 0,
            taint: c.taint ?? null,
          })
          continue
        }

        // THE MERGE, mirroring record_outlook_page_progress exactly.
        const replace = c.efp != null && c.first_at != null && (
          existing.efp === null
          || c.first_at < existing.first_at
          || (c.first_at === existing.first_at && (c.first_fp ?? '') < (existing.first_fp ?? ''))
        )
        let taint = existing.taint ?? c.taint ?? null
        if (taint === null && existing.pfp !== null && c.pfp != null && existing.pfp !== c.pfp) {
          taint = 'mixed_counterparties'
        }
        if (taint === null && existing.contact_id !== null && c.contact_id != null
            && existing.contact_id !== c.contact_id) {
          taint = 'ambiguous_contact'
        }
        if (taint === null && existing.messages + (c.messages ?? 0) > MAX_EPISODE_MESSAGES) {
          taint = 'episode_truncated'
        }

        if (replace) {
          existing.efp = c.efp
          existing.elookup = c.elookup ?? null
          existing.first_fp = c.first_fp ?? null
          existing.key_version = c.key_version ?? null
        } else if (existing.key_version === null) {
          existing.key_version = c.key_version ?? null
        }
        existing.pfp = existing.pfp ?? c.pfp ?? null
        existing.contact_id = existing.contact_id ?? c.contact_id ?? null
        if (c.first_at != null && (existing.first_at === null || c.first_at < existing.first_at)) {
          existing.first_at = c.first_at
        }
        if (c.last_at != null && (existing.last_at === null || c.last_at > existing.last_at)) {
          existing.last_at = c.last_at
        }
        existing.inbound += c.inbound ?? 0
        existing.outbound += c.outbound ?? 0
        existing.messages += c.messages ?? 0
        existing.taint = taint
      }

      // Fixed at ADOPTION, identical on both rows, and never extended by a later page.
      const ttlMs = (Number.isInteger(args.p_round_ttl_seconds)
        ? args.p_round_ttl_seconds : 86400) * 1000
      for (const f of GRAPH_FOLDERS) {
        if (folders[f].round_id === null) {
          folders[f].round_id = args.p_round_id
          folders[f].round_expires_ms = nowMs() + ttlMs
        }
      }
      folder.round_id = args.p_round_id
      folder.page_seq = args.p_page_seq
      folder.pages += 1
      folder.messages += args.p_messages_seen ?? 0
      folder.messages_dropped += args.p_messages_dropped ?? 0
      folder.conversations_dropped += dropped
      folder.folder_complete = args.p_folder_complete === true
      folder.next_link_ciphertext = args.p_next_link_ct
      folder.next_link_nonce = args.p_next_link_nonce
      folder.next_link_key_version = args.p_next_link_ct ? args.p_key_version : null
      folder.pending_delta_ciphertext = args.p_pending_delta_ct
      folder.pending_delta_nonce = args.p_pending_delta_nonce
      folder.pending_delta_key_version = args.p_pending_delta_ct ? args.p_key_version : null

      return {
        data: {
          result: 'recorded',
          round_pages: folder.pages,
          round_messages: folder.messages,
          conversations_written: (args.p_conversations ?? []).length - dropped,
          conversations_dropped: dropped,
        },
        error: null,
      }
    }

    return null   // not ours; the caller handles it
  }

  /** Promote the pending cursors, as a confirmed complete release does. */
  const commitRelease = () => {
    for (const f of GRAPH_FOLDERS) {
      if (folders[f].pending_delta_ciphertext !== null) {
        folders[f].delta_link_ciphertext = folders[f].pending_delta_ciphertext
        folders[f].delta_link_nonce = folders[f].pending_delta_nonce
      }
    }
    conversations.clear()
    for (const f of GRAPH_FOLDERS) {
      const committed = {
        delta_link_ciphertext: folders[f].delta_link_ciphertext,
        delta_link_nonce: folders[f].delta_link_nonce,
      }
      folders[f] = { ...blankFolder(), ...committed }
    }
  }

  return {
    handle,
    refuse,
    allow,
    commitRelease,
    folders,
    conversations,
    calls,
  }
}
