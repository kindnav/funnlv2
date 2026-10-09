// Pending suggestions: the count the navigation badge shows, and the lightweight signature
// the queue page polls so it can notice arrivals, refreshed proposals and resolutions made
// elsewhere WITHOUT throwing away the reviewer's work.
//
// Two tables, one queue. An interaction suggestion (`interaction_candidates`) and a proposed
// new person (`new_contact_candidates`) are both "something to review", and the Suggestions
// page lists both, so the badge and the poll cover both. The poll reads ids and updated_at
// only: no candidate detail, no contact name travels for a check.
//
// THE REFRESH RULE, and why it is a poll. Proposals are written by a server process while
// Funnl may be closed - or open on this very page. The simplest supported way to notice
// them is to re-read the pending SIGNATURE every REFRESH_INTERVAL_MS while the tab is
// visible, and once more when it becomes visible again: no realtime channel, no publication
// change, no RLS rework. What the page then does with a difference is decided by
// diffPendingSignature below, and applied card by card - never by reloading the list.
//
// REPRODUCED BEFORE THIS EXISTED: the first revision reloaded the whole first page on any
// count change. That unmounted every card, discarding typed edits, focus, an open dismissal
// confirmation and every page loaded past the first; and a refreshed proposal with an
// unchanged count was never noticed at all.

export const SUGGESTIONS_REFRESH_INTERVAL_MS = 30_000
export const SUGGESTIONS_CHANGED_EVENT = 'funnl:suggestions-changed'
export const NEW_SUGGESTIONS_MESSAGE = 'New suggestions arrived and were added to the list.'
export const UPDATED_SUGGESTIONS_MESSAGE = 'A suggestion was updated with newer mail.'
export const HELD_UPDATES_MESSAGE = 'A newer version of a suggestion you are editing is waiting. Your edits are kept; choose "Use newer draft" on the card if you want it.'
/** The most pending rows one signature read covers per queue. */
export const SIGNATURE_LIMIT = 500

/**
 * Pending count across both queues for the signed-in user (RLS scopes the rows), or null
 * when either count failed - a failed count must never read as "nothing pending".
 * @param {object} client  a supabase-js client (injected so this stays testable)
 */
export async function countPendingSuggestions (client) {
  try {
    const [a, b] = await Promise.all([
      client.from('interaction_candidates').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      client.from('new_contact_candidates').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    ])
    if (a?.error || b?.error) return null
    const ca = typeof a?.count === 'number' ? a.count : 0
    const cb = typeof b?.count === 'number' ? b.count : 0
    return ca + cb
  } catch {
    return null
  }
}

/**
 * The pending SIGNATURE: every pending row's id, kind and updated_at, for both queues.
 * Null when either read failed.
 * @returns {Promise<null|Array<{id:string, kind:'interaction'|'new_contact', updatedAt:string}>>}
 */
export async function fetchPendingSignature (client) {
  try {
    const [a, b] = await Promise.all([
      client.from('interaction_candidates').select('id, updated_at').eq('status', 'pending').limit(SIGNATURE_LIMIT),
      client.from('new_contact_candidates').select('id, updated_at').eq('status', 'pending').limit(SIGNATURE_LIMIT),
    ])
    if (a?.error || b?.error) return null
    const rows = []
    for (const r of a?.data || []) rows.push({ id: r.id, kind: 'interaction', updatedAt: String(r.updated_at ?? '') })
    for (const r of b?.data || []) rows.push({ id: r.id, kind: 'new_contact', updatedAt: String(r.updated_at ?? '') })
    return rows
  } catch {
    return null
  }
}

/** The signature as a Map id -> { kind, updatedAt }. */
export function indexSignature (rows) {
  const m = new Map()
  for (const r of Array.isArray(rows) ? rows : []) m.set(r.id, { kind: r.kind, updatedAt: r.updatedAt })
  return m
}

/**
 * Pure: what changed between the signature the page knows and a fresh one.
 * `known` null means "first observation" - learn only, change nothing.
 * @returns {{added:Array<{id,kind}>, changed:Array<{id,kind}>, removed:Array<{id,kind}>}}
 */
export function diffPendingSignature (known, freshRows) {
  const none = { added: [], changed: [], removed: [] }
  if (!Array.isArray(freshRows)) return none
  const fresh = indexSignature(freshRows)
  if (!(known instanceof Map)) return none
  const added = []
  const changed = []
  const removed = []
  for (const [id, f] of fresh) {
    const k = known.get(id)
    if (!k) added.push({ id, kind: f.kind })
    else if (k.updatedAt !== f.updatedAt) changed.push({ id, kind: f.kind })
  }
  for (const [id, k] of known) {
    if (!fresh.has(id)) removed.push({ id, kind: k.kind })
  }
  return { added, changed, removed }
}

/**
 * Pure: given the last count the page knew and a fresh one, what should it do?
 * Kept for the badge hook; the page uses diffPendingSignature.
 * @returns {{reload:boolean, announce:boolean}}
 */
export function decideRefresh (known, fresh) {
  if (typeof fresh !== 'number') return { reload: false, announce: false }
  if (typeof known !== 'number') return { reload: false, announce: false }   // first observation: learn only
  if (fresh === known) return { reload: false, announce: false }
  return { reload: true, announce: fresh > known }
}

/** Keyset order of the queue: proposed_interaction_date DESC, id DESC. */
export function compareQueueRows (a, b) {
  const da = String(a?.proposed_interaction_date ?? '')
  const db = String(b?.proposed_interaction_date ?? '')
  if (da !== db) return da < db ? 1 : -1
  const ia = String(a?.id ?? '')
  const ib = String(b?.id ?? '')
  if (ia === ib) return 0
  return ia < ib ? 1 : -1
}

/**
 * Pure: merge a fresh set of rows into the loaded list without disturbing cards the
 * reviewer is working on. `busy` is the set of ids whose card reports an edit in progress,
 * an open dismissal confirmation or an in-flight accept/dismiss.
 *
 * - added rows are inserted in queue order (a new card never remounts an existing one);
 * - changed rows replace the loaded row unless the card is busy, in which case the update
 *   is HELD and returned so the page can apply it when the card frees up;
 * - removed rows (resolved elsewhere) leave the list unless the card is busy, in which case
 *   the removal is held the same way.
 *
 * @returns {{list:Array<object>, held:Array<{id:string, row:object|null}>, applied:{added:number, changed:number, removed:number}}}
 */
export function mergeQueueRows ({ list, added = [], changed = [], removedIds = [], busy = new Set() }) {
  const out = Array.isArray(list) ? list.slice() : []
  const held = []
  const applied = { added: 0, changed: 0, removed: 0 }
  const byId = new Map(out.map((r, i) => [r.id, i]))
  for (const row of changed) {
    const i = byId.get(row.id)
    if (i === undefined) continue
    if (busy.has(row.id)) { held.push({ id: row.id, row }); continue }
    out[i] = row
    applied.changed += 1
  }
  for (const id of removedIds) {
    const i = out.findIndex((r) => r.id === id)
    if (i === -1) continue
    if (busy.has(id)) { held.push({ id, row: null }); continue }
    out.splice(i, 1)
    applied.removed += 1
  }
  for (const row of added) {
    if (out.some((r) => r.id === row.id)) continue
    out.push(row)
    applied.added += 1
  }
  out.sort(compareQueueRows)
  return { list: out, held, applied }
}

/**
 * Pure: the signature checkpoint the page should keep after one poll.
 *
 * The checkpoint advances ONLY when the rows a difference named were fetched and then applied
 * or held (`applied` true). A transient failure of the full-row fetch leaves the checkpoint
 * where it was, so the next poll sees the same difference again and retries - even when the
 * signature itself has not changed in between. Advancing first and fetching second (the
 * earlier order) lost any change whose fetch happened to fail: the next poll compared equal
 * signatures and never asked again.
 *
 * @param {Map|null} known   the checkpoint before this poll
 * @param {Array|null} fresh  the signature just read
 * @param {boolean} applied  whether the changed rows were fetched and applied/held
 * @returns {Map|null}
 */
export function nextSignatureCheckpoint (known, fresh, applied) {
  if (known === null || known === undefined) return indexSignature(fresh)   // first observation learns only
  return applied === true ? indexSignature(fresh) : known
}

/**
 * Pure: the set of ids whose cards are busy, minus one the reviewer explicitly released - the
 * card whose "Use newer draft" / "Remove from list" was pressed. Never mutates the input.
 */
export function busyExcept (busy, id) {
  const out = new Set(busy instanceof Set ? busy : [])
  out.delete(id)
  return out
}

/** A card's React key: the id, plus the row version so a refreshed proposal remounts fresh. */
export function cardKey (row) {
  return `${row?.id ?? ''}:${row?.updated_at ?? ''}`
}

/** The badge text: numbers up to 9, then "9+". */
export function badgeLabel (count) {
  if (!Number.isInteger(count) || count < 1) return null
  return count > 9 ? '9+' : String(count)
}
