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

const blankFolder = () => ({
  round_id: null,
  page_seq: 0,
  pages: 0,
  messages: 0,
  messages_dropped: 0,
  conversations_dropped: 0,
  folder_complete: false,
  next_link_ciphertext: null,
  next_link_nonce: null,
  next_link_key_version: null,
  pending_delta_ciphertext: null,
  pending_delta_nonce: null,
  pending_delta_key_version: null,
  delta_link_ciphertext: null,
  delta_link_nonce: null,
})

export function makeRoundStore () {
  const folders = Object.fromEntries(GRAPH_FOLDERS.map((f) => [f, blankFolder()]))
  /** conversation fingerprint -> accumulated record */
  const conversations = new Map()
  const refusals = new Map()
  const calls = []

  const refuse = (name, result) => { refusals.set(name, result) }

  const handle = async (name, args) => {
    calls.push(name)
    if (refusals.has(name)) {
      return { data: { result: refusals.get(name) }, error: null }
    }

    if (name === 'read_outlook_round_progress') {
      return {
        data: {
          result: 'ok',
          folders: Object.fromEntries(GRAPH_FOLDERS.map((f) => [f, { ...folders[f] }])),
        },
        error: null,
      }
    }

    if (name === 'reset_outlook_round') {
      conversations.clear()
      for (const f of GRAPH_FOLDERS) {
        const committed = {
          delta_link_ciphertext: folders[f].delta_link_ciphertext,
          delta_link_nonce: folders[f].delta_link_nonce,
        }
        // Exactly like the SQL: the round is discarded, the COMMITTED cursor is not.
        folders[f] = { ...blankFolder(), ...committed }
      }
      return { data: { result: 'reset' }, error: null }
    }

    if (name === 'list_outlook_round_conversations') {
      const rows = [...conversations.values()]
        .sort((a, b) => a.cfp.localeCompare(b.cfp))
      const limit = Number.isInteger(args?.p_limit) ? args.p_limit : 500
      return {
        data: {
          result: 'ok',
          truncated: rows.length > limit,
          conversations: rows.slice(0, limit),
        },
        error: null,
      }
    }

    if (name === 'record_outlook_page_progress') {
      const folder = folders[args.p_folder]
      if (!folder) return { data: { result: 'invalid_folder' }, error: null }
      if (folder.round_id !== null && folder.round_id !== args.p_round_id) {
        return { data: { result: 'round_mismatch' }, error: null }
      }
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
    commitRelease,
    folders,
    conversations,
    calls,
  }
}
