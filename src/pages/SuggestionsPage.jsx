import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import { track } from '../lib/analytics'
import TopBar from '../components/TopBar'
import {
  CANDIDATE_SELECT, INTERACTION_TYPES, REVIEW_PAGE_SIZE, REVIEW_NOTES_MAX, REVIEW_FOLLOW_UP_MAX,
  validateOverrides, acceptResultOutcome, dismissResultOutcome, resultCode,
  keysetFilter, cursorFrom, dedupeById, computeHasMore,
} from '../lib/calendarReview'
import { SUGGESTION_REVIEW_ENABLED } from '../lib/suggestionReview'
import { SUGGESTION_EVENTS, suggestionEventProps } from '../lib/suggestionAnalytics'

import { dismissConfirmFocusTarget } from '../lib/dismissConfirmFocus'
import InteractionSourceBadge from '../components/InteractionSourceBadge'
import NewContactSuggestionCard from '../components/NewContactSuggestionCard'
import PendingUpdateNotice from '../components/PendingUpdateNotice'
import { NCC_SELECT } from '../lib/newContactReview'
import {
  fetchPendingSignature, diffPendingSignature, mergeQueueRows, cardKey, nextSignatureCheckpoint, busyExcept,
  SUGGESTIONS_REFRESH_INTERVAL_MS, SUGGESTIONS_CHANGED_EVENT,
  NEW_SUGGESTIONS_MESSAGE, UPDATED_SUGGESTIONS_MESSAGE, HELD_UPDATES_MESSAGE,
} from '../lib/pendingSuggestions'

const CARD = 'bg-card border border-line-1 rounded-2xl p-[18px]'
const SECTION_LABEL = 'block mb-[10px] font-mono text-[8.5px] font-semibold tracking-[1.5px] text-muted uppercase'

function formatDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || ''
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// One reviewable candidate. Owns its edit fields, single-flight busy state, and outcome.
function CandidateCard({ candidate, onResolved, onBusyChange, pendingUpdate = null, onTakeUpdate }) {
  const name = candidate.contacts?.name || 'Unknown contact'
  const company = candidate.contacts?.company || ''
  const role = candidate.contacts?.role || ''
  const [editing, setEditing] = useState(false)
  const [type, setType] = useState(candidate.proposed_type)
  const [date, setDate] = useState(candidate.proposed_interaction_date)
  const [notes, setNotes] = useState(candidate.proposed_notes || '')
  // The suggested next step is REVIEWABLE, not decorative: kept as drafted, edited, or
  // cleared, and whatever is approved is saved with the interaction. The follow-up date is
  // the reviewer's own choice and starts empty - a date is never derived from the step.
  const [nextStep, setNextStep] = useState(candidate.draft_follow_up || '')
  const [followUpDate, setFollowUpDate] = useState('')
  const [busy, setBusy] = useState(false)              // single-flight guard for Accept/Dismiss
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const [error, setError] = useState('')
  const confirmBtnRef = useRef(null)                   // "Yes, dismiss" (focused when confirm opens)
  const dismissBtnRef = useRef(null)                   // initiating "Dismiss" (focus restored here on cancel/escape)
  const restoreFocusRef = useRef(false)                // true → restore focus to Dismiss after confirm closes

  // Focus management for the inline dismiss confirmation. Opening it moves focus to the
  // primary button (so focus is not lost as the Dismiss button unmounts); cancelling it
  // via Cancel OR Escape restores focus to the initiating Dismiss button (dismissConfirmFocusTarget:
  // 'open'→'confirm', 'cancel'/'escape'→'dismiss') instead of dropping focus to <body>.
  useEffect(() => {
    let target = null
    if (confirmDismiss) {
      target = dismissConfirmFocusTarget('open')        // 'confirm'
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false
      target = dismissConfirmFocusTarget('cancel')      // 'dismiss' (same as 'escape')
    }
    if (target === 'confirm') confirmBtnRef.current?.focus()
    else if (target === 'dismiss') dismissBtnRef.current?.focus()
  }, [confirmDismiss])

  // DIRTY means the reviewer changed something the save will carry. It is independent of the
  // edit fields being open: "Done editing" closes the fields and keeps the values, so a dirty
  // card stays dirty until acceptance, dismissal, or the explicit choice to take a newer draft.
  // (REPRODUCED BEFORE THIS: Done editing let a waiting draft in, which remounted the card
  // and erased the typed note.)
  const dirty = (
    type !== candidate.proposed_type ||
    date !== candidate.proposed_interaction_date ||
    (notes || '') !== (candidate.proposed_notes || '') ||
    (nextStep || '') !== (candidate.draft_follow_up || '') ||
    followUpDate !== ''
  )
  // BUSY means the reviewer is in the middle of something on this card: editing, holding
  // unsaved changes, deciding a dismissal, or waiting on Accept/Dismiss. The page holds
  // background updates to a busy card and applies them only when it frees up, so typed
  // values, focus and the open confirmation survive a refresh. Reported on every change so
  // the page's set stays exact.
  const busyNow = editing || dirty || confirmDismiss || busy
  useEffect(() => {
    if (typeof onBusyChange === 'function') onBusyChange(candidate.id, busyNow)
  }, [busyNow, candidate.id, onBusyChange])
  useEffect(() => () => { if (typeof onBusyChange === 'function') onBusyChange(candidate.id, false) }, [candidate.id, onBusyChange])

  // Close the confirmation and flag that focus must return to the Dismiss button.
  function closeConfirm() {
    restoreFocusRef.current = true
    setConfirmDismiss(false)
  }

  const edited = dirty

  async function handleAccept() {
    if (busy) return                                   // prevent double submission
    setError('')
    const v = validateOverrides({ type, date, notes, followUp: nextStep, followUpDate })
    if (!v.ok) { setError(acceptResultOutcome(v.code).message); return }
    setBusy(true)
    try {
      const { data, error: rpcErr } = await supabase.rpc('accept_interaction_candidate', {
        p_candidate_id: candidate.id,
        p_override_type: type,
        p_override_date: date,
        p_override_notes: notes || null,
        // The approved next step (null when the reviewer cleared it) and the date the
        // reviewer chose (null when they did not). Both survive acceptance server-side.
        p_follow_up: nextStep.trim() || null,
        p_follow_up_date: followUpDate || null,
      })
      if (rpcErr) { setError(acceptResultOutcome('unknown').message); setBusy(false); return }
      const outcome = acceptResultOutcome(resultCode(data))
      if (outcome.removeFromQueue) {
        track(SUGGESTION_EVENTS.accepted,
          suggestionEventProps(candidate.source, { edited: !!edited }))
        window.dispatchEvent(new Event('funnl:interactions-changed'))
        onResolved(candidate.id, outcome.message)
      } else {
        setError(outcome.message); setBusy(false)      // validation/auth issue — stay in queue
      }
    } catch {
      setError(acceptResultOutcome('unknown').message); setBusy(false)
    }
  }

  async function handleDismiss() {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const { data, error: rpcErr } = await supabase.rpc('dismiss_interaction_candidate', {
        p_candidate_id: candidate.id,
      })
      if (rpcErr) { setError(dismissResultOutcome('unknown').message); setBusy(false); return }
      const outcome = dismissResultOutcome(resultCode(data))
      if (outcome.removeFromQueue) {
        track(SUGGESTION_EVENTS.dismissed, suggestionEventProps(candidate.source))
        onResolved(candidate.id, outcome.message)
      } else {
        setError(outcome.message); setBusy(false)
      }
    } catch {
      setError(dismissResultOutcome('unknown').message); setBusy(false)
    }
  }

  return (
    <div className={CARD} data-card="interaction" data-candidate-id={candidate.id}>
      <div className="flex items-start gap-3">
        <div className="flex-none w-10 h-10 rounded-lg flex items-center justify-center font-display font-bold text-[14px]"
             style={{ background: getAvatarColor(name), color: 'var(--color-paper)' }} aria-hidden="true">
          {getInitials(name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display font-semibold text-[15px] text-hi truncate">{name}</div>
          {(company || role) && (
            <div className="text-[12px] text-muted truncate">{[role, company].filter(Boolean).join(' · ')}</div>
          )}
          {!editing && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              <span className="font-mono text-[10px] px-2 py-[3px] rounded-full bg-elevated text-tag">{type}</span>
              <span className="text-muted">{formatDate(date)}</span>
              <InteractionSourceBadge source={candidate.source} />
            </div>
          )}
          {!editing && notes && (
            <p className="mt-2 text-[12px] text-muted leading-relaxed line-clamp-2">{notes}</p>
          )}
          {/* The suggested next step and the provenance, shown the way the new-person card
              shows them. Both come from the same draft as the note; neither is editable here,
              and accepting records the note alone - the next step is for the reviewer to act
              on or fold into the note. */}
          {!editing && nextStep && (
            <p className="mt-1 text-[12px] text-accent leading-relaxed">
              Suggested next step: {nextStep}
            </p>
          )}
          {!editing && followUpDate && (
            <p className="mt-1 text-[12px] text-muted">Follow-up on {formatDate(followUpDate)}</p>
          )}
          {!editing && candidate.extraction_status === 'ai_extracted' && (
            <p className="mt-1 text-[11px] text-lower">
              Drafted by AI from the message text. Review it before accepting.
            </p>
          )}

          {editing && (
            <div className="mt-3 grid gap-2">
              <label className="text-[11px] text-muted">Type
                <select value={type} onChange={(e) => setType(e.target.value)} disabled={busy}
                        className="mt-1 w-full bg-input border border-line-2 rounded-lg px-2 py-[7px] text-[13px] text-hi">
                  {INTERACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-[11px] text-muted">Date
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy}
                       className="mt-1 w-full bg-input border border-line-2 rounded-lg px-2 py-[7px] text-[13px] text-hi" />
              </label>
              <label className="text-[11px] text-muted">Note
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} rows={2} maxLength={REVIEW_NOTES_MAX}
                          className="mt-1 w-full bg-input border border-line-2 rounded-lg px-2 py-[7px] text-[13px] text-hi resize-none" />
              </label>
              {/* The next step is saved as part of the interaction note when kept; clearing it
                  drops it. The follow-up date is optional and is the reviewer's choice. */}
              <label className="text-[11px] text-muted">Next step (optional)
                <input type="text" name="nextStep" value={nextStep} onChange={(e) => setNextStep(e.target.value)} disabled={busy}
                       maxLength={REVIEW_FOLLOW_UP_MAX} placeholder="Leave blank to drop the suggested step"
                       className="mt-1 w-full bg-input border border-line-2 rounded-lg px-2 py-[7px] text-[13px] text-hi" />
              </label>
              <label className="text-[11px] text-muted">Follow-up date (optional)
                <input type="date" name="followUpDate" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} disabled={busy}
                       className="mt-1 w-full bg-input border border-line-2 rounded-lg px-2 py-[7px] text-[13px] text-hi" />
              </label>
            </div>
          )}

          {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}

          <PendingUpdateNotice pendingUpdate={pendingUpdate} busy={busy} onTake={() => onTakeUpdate?.(candidate.id)} />

          {/* Actions */}
          {!confirmDismiss ? (
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={handleAccept} disabled={busy}
                      className="bg-hi text-surface text-[12px] font-bold px-[16px] py-[7px] rounded-[9px] disabled:opacity-40 hover:opacity-85 transition-opacity motion-reduce:transition-none">
                {busy ? 'Working…' : 'Accept'}
              </button>
              <button ref={dismissBtnRef} type="button" onClick={() => setConfirmDismiss(true)} disabled={busy}
                      className="bg-elevated text-mid text-[12px] font-semibold px-[16px] py-[7px] rounded-[9px] disabled:opacity-40 hover:text-hi transition-colors">
                Dismiss
              </button>
              <button type="button" onClick={() => setEditing((v) => !v)} disabled={busy}
                      className="ml-auto text-[12px] text-accent hover:opacity-80 disabled:opacity-40">
                {editing ? 'Done editing' : 'Edit details'}
              </button>
            </div>
          ) : (
            <div className="mt-3" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) closeConfirm() }}>
              <p className="text-[12px] text-muted mb-2">Dismiss this suggestion? It won’t be suggested again.</p>
              <div className="flex items-center gap-2">
                <button ref={confirmBtnRef} type="button" onClick={handleDismiss} disabled={busy}
                        className="bg-danger text-surface text-[12px] font-bold px-[16px] py-[7px] rounded-[9px] disabled:opacity-40 hover:opacity-85 transition-opacity">
                  {busy ? 'Working…' : 'Yes, dismiss'}
                </button>
                <button type="button" onClick={closeConfirm} disabled={busy}
                        className="bg-elevated text-mid text-[12px] font-semibold px-[16px] py-[7px] rounded-[9px] disabled:opacity-40 hover:text-hi transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function SuggestionsPage() {
  const [status, setStatus] = useState('loading')   // loading | error | ready
  const [items, setItems] = useState([])
  const [proposals, setProposals] = useState([])   // people not yet in Funnl
  const [proposalsHaveMore, setProposalsHaveMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [banner, setBanner] = useState('')
  const viewedRef = useRef(false)
  const aliveRef = useRef(true)          // false after unmount → drop late responses
  const cursorRef = useRef(null)         // keyset boundary: last row FETCHED (not last shown)
  const proposalCursorRef = useRef(null) // the same, for the proposals queue
  const loadingProposalsRef = useRef(false)  // synchronous single-flight for its refill
  const initGenRef = useRef(0)           // generation guard so a stale (re)load can't win
  const loadingMoreRef = useRef(false)   // synchronous single-flight for Load more

  useEffect(() => () => { aliveRef.current = false }, [])

  // One keyset page strictly after `cursor` (null = first page). RLS scopes to the
  // signed-in user; only safe columns + own contact are selected. Deterministic order
  // (date DESC, id DESC) so equal dates never reorder between fetches.
  const fetchPage = useCallback(async (cursor) => {
    let q = supabase
      .from('interaction_candidates')
      .select(CANDIDATE_SELECT)
      .eq('status', 'pending')
      .order('proposed_interaction_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(REVIEW_PAGE_SIZE)
    const filter = keysetFilter(cursor)
    if (filter) q = q.or(filter)
    const { data, error } = await q
    if (error) throw error
    return (data || []).map((r) => ({ ...r, kind: 'interaction' }))
  }, [])

  // ── the PROPOSED-PEOPLE queue, keyset-paged on its OWN cursor ────────────
  // ITS OWN CURSOR, not a shared one. The two queues live in different tables with
  // independent id spaces, so no single cursor can order them - but each is ordered
  // by exactly the same pair, (proposed_interaction_date DESC, id DESC), so the
  // keyset helpers the interaction queue already uses work unchanged here. Two
  // cursors, one page size, no combined-provider pagination layer.
  //
  // This replaced a single bounded read of 20 with no continuation. Resolving those
  // twenty drained the list and the page then said "You're all caught up" while
  // proposal 21 sat unreachable in the database - a queue that quietly loses work
  // past its first page is worse than one that is slow.
  //
  // READ-ONLY. Rendering the queue runs no mutation: nothing is created until the
  // reviewer presses Save on a card.
  const fetchProposals = useCallback(async (cursor) => {
    let q = supabase
      .from('new_contact_candidates')
      .select(NCC_SELECT)
      .eq('status', 'pending')
      .order('proposed_interaction_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(REVIEW_PAGE_SIZE)
    const filter = keysetFilter(cursor)
    if (filter) q = q.or(filter)
    const { data, error } = await q
    if (error) throw error
    return (data || []).map((r) => ({ ...r, kind: 'new_contact' }))
  }, [])

  const loadInitial = useCallback(async () => {
    const gen = ++initGenRef.current      // invalidate any in-flight load
    loadingMoreRef.current = false
    loadingProposalsRef.current = false
    setStatus('loading')
    try {
      // Both queues in parallel. A failure in EITHER is a failed load: showing an
      // interaction queue while silently hiding every proposed person would make the
      // "all caught up" state a lie.
      const [rows, proposals] = await Promise.all([fetchPage(null), fetchProposals(null)])
      if (!aliveRef.current || gen !== initGenRef.current) return   // stale / unmounted
      cursorRef.current = cursorFrom(rows)
      proposalCursorRef.current = cursorFrom(proposals)
      setItems(rows)
      setProposals(proposals)
      setHasMore(computeHasMore(rows.length))
      setProposalsHaveMore(computeHasMore(proposals.length))
      setStatus('ready')
      if (!viewedRef.current) {
        viewedRef.current = true
        // One event per distinct source across BOTH queues. A queue holding both a
        // Calendar and an Outlook suggestion must not be recorded as calendar-only.
        for (const s of [...new Set([...rows, ...proposals].map((r) => r.source))]) {
          track(SUGGESTION_EVENTS.viewed, suggestionEventProps(s))
        }
      }
    } catch {
      if (!aliveRef.current || gen !== initGenRef.current) return
      setStatus('error')
    }
  }, [fetchPage, fetchProposals])

  useEffect(() => {
    if (!SUGGESTION_REVIEW_ENABLED) return   // disabled → no query runs at all
    loadInitial()
  }, [loadInitial])

  // WHILE THE QUEUE IS OPEN, notice what changes in the background - WITHOUT disturbing the
  // reviewer. Proposals are written by a server process while Funnl may be closed, or open on
  // this very page; a pending proposal can also be REFRESHED by newer mail (same id, newer
  // updated_at), or resolved from another tab. The simplest supported way to see all three is
  // a bounded read of the pending SIGNATURE (ids + updated_at of both queues) every
  // SUGGESTIONS_REFRESH_INTERVAL_MS while the tab is visible, and once more when it becomes
  // visible again; no realtime channel, no publication or RLS change.
  //
  // What a difference does is decided card by card (mergeQueueRows), never by reloading the
  // list: arrivals are inserted in queue order, a refreshed proposal is swapped in under a new
  // key so it remounts with its new draft, a resolved one is removed - UNLESS that card is
  // BUSY (editing, confirming a dismissal, or mid-accept), in which case the update is HELD
  // and applied when the card frees up, and the banner says so. Loaded pages past the first
  // are untouched; the page's own accept/dismiss update the known signature so they never
  // read as a change.
  //
  // REPRODUCED BEFORE THIS: the first revision reloaded the first page on any count change,
  // unmounting every card - typed edits, focus, an open confirmation and loaded pages were
  // all lost - and a refreshed proposal with an unchanged count was never noticed.
  const knownRef = useRef(null)                 // Map id -> { kind, updatedAt } of the last signature CHECKPOINT
  const busyRef = useRef(new Set())             // ids whose card is busy right now
  const heldRef = useRef(new Map())             // id -> { id, row | null } waiting for a busy card
  const [busyVersion, setBusyVersion] = useState(0)
  const [heldVersion, setHeldVersion] = useState(0)   // bumped whenever heldRef changes, so cards re-render their notice
  // Snapshots of the two lists, kept in step by effects AFTER each render. The merge plan is
  // computed from a snapshot, outside any state updater, so an updater never has to run
  // synchronously or assign anything for the page to learn what was held. A busy id always
  // names a MOUNTED card, which is therefore always present in the snapshot - so the held set
  // computed from it is exact even when React has queued or batched an update.
  const itemsRef = useRef([])
  const proposalsRef = useRef([])
  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => { proposalsRef.current = proposals }, [proposals])
  const onBusyChange = useCallback((id, isBusy) => {
    const was = busyRef.current.has(id)
    if (isBusy) busyRef.current.add(id); else busyRef.current.delete(id)
    if (was !== isBusy) setBusyVersion((v) => v + 1)
  }, [])

  /** Fetch full rows for ids, by kind, with the same selects the queues use. */
  const fetchRows = useCallback(async (entries) => {
    const ids = { interaction: [], new_contact: [] }
    for (const e of entries) if (ids[e.kind]) ids[e.kind].push(e.id)
    const [a, b] = await Promise.all([
      ids.interaction.length
        ? supabase.from('interaction_candidates').select(CANDIDATE_SELECT).eq('status', 'pending').in('id', ids.interaction)
        : Promise.resolve({ data: [], error: null }),
      ids.new_contact.length
        ? supabase.from('new_contact_candidates').select(NCC_SELECT).eq('status', 'pending').in('id', ids.new_contact)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (a?.error || b?.error) return null
    return {
      interaction: (a.data || []).map((r) => ({ ...r, kind: 'interaction' })),
      new_contact: (b.data || []).map((r) => ({ ...r, kind: 'new_contact' })),
    }
  }, [])

  /**
   * Apply one merge to one queue; returns what was held. The plan is computed PURELY from the
   * list snapshot; the state updater stays pure as well (it re-plans from `prev` when the
   * snapshot it was planned against is no longer current) and assigns nothing outside itself.
   * `busy` may be narrowed (busyExcept) when the reviewer explicitly released one card.
   */
  const applyMerge = useCallback((listRef, setter, { added = [], changed = [], removedIds = [] }, busy = busyRef.current) => {
    const snapshot = listRef.current
    const planned = mergeQueueRows({ list: snapshot, added, changed, removedIds, busy })
    setter((prev) => (prev === snapshot
      ? planned.list
      : mergeQueueRows({ list: prev, added, changed, removedIds, busy }).list))
    return planned.held
  }, [])

  /** Record held updates; the version bump lets each card show its notice. */
  const holdUpdates = useCallback((held) => {
    if (held.length === 0) return
    for (const h of held) heldRef.current.set(h.id, h)
    setHeldVersion((v) => v + 1)
  }, [])

  /**
   * THE EXPLICIT CHOICE: the reviewer pressed "Use newer draft" (or "Remove from list") on a
   * card whose update was held. Only that card is released from the busy set for this one
   * merge; every other busy card keeps its hold.
   */
  const takeHeldUpdate = useCallback((id) => {
    const h = heldRef.current.get(id)
    if (!h) return
    heldRef.current.delete(id)
    setHeldVersion((v) => v + 1)
    const change = h.row ? { changed: [h.row] } : { removedIds: [id] }
    const released = busyExcept(busyRef.current, id)
    if (h.row ? h.row.kind === 'new_contact' : proposalsRef.current.some((r) => r.id === id)) {
      applyMerge(proposalsRef, setProposals, change, released)
    } else {
      applyMerge(itemsRef, setItems, change, released)
    }
    if (heldRef.current.size === 0) setBanner('')
  }, [applyMerge])

  useEffect(() => {
    if (!SUGGESTION_REVIEW_ENABLED) return undefined
    let cancelled = false
    let inFlight = false
    const poll = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (inFlight) return
      inFlight = true
      try {
        const fresh = await fetchPendingSignature(supabase)
        if (cancelled || fresh === null) return
        if (knownRef.current === null) { knownRef.current = nextSignatureCheckpoint(null, fresh, true); return }   // first observation
        const diff = diffPendingSignature(knownRef.current, fresh)
        if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) return
        // The full rows for what changed. A FAILED fetch leaves the checkpoint where it is, so
        // the same difference is seen - and fetched - again on the next poll, even when the
        // signature has not moved in between. The checkpoint advances only below, after the
        // rows have been applied or held.
        const rows = await fetchRows([...diff.added, ...diff.changed])
        if (cancelled) return
        if (rows === null) { knownRef.current = nextSignatureCheckpoint(knownRef.current, fresh, false); return }
        const byKind = (kind, entries) => entries.filter((e) => e.kind === kind).map((e) => e.id)
        const pick = (list, ids) => list.filter((r) => ids.includes(r.id))
        const heldA = applyMerge(itemsRef, setItems, {
          added: pick(rows.interaction, byKind('interaction', diff.added)),
          changed: pick(rows.interaction, byKind('interaction', diff.changed)),
          removedIds: byKind('interaction', diff.removed),
        })
        const heldB = applyMerge(proposalsRef, setProposals, {
          added: pick(rows.new_contact, byKind('new_contact', diff.added)),
          changed: pick(rows.new_contact, byKind('new_contact', diff.changed)),
          removedIds: byKind('new_contact', diff.removed),
        })
        holdUpdates([...heldA, ...heldB])
        knownRef.current = nextSignatureCheckpoint(knownRef.current, fresh, true)
        if (heldA.length + heldB.length > 0) setBanner(HELD_UPDATES_MESSAGE)
        else if (diff.added.length > 0) setBanner(NEW_SUGGESTIONS_MESSAGE)
        else if (diff.changed.length > 0) setBanner(UPDATED_SUGGESTIONS_MESSAGE)
        window.dispatchEvent(new Event(SUGGESTIONS_CHANGED_EVENT))
      } finally {
        inFlight = false
      }
    }
    const timer = setInterval(poll, SUGGESTIONS_REFRESH_INTERVAL_MS)
    document.addEventListener('visibilitychange', poll)
    poll()
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [fetchRows, applyMerge, holdUpdates])

  // A HELD update is applied the moment its card is no longer busy - which, for a card with
  // unsaved changes, is only after acceptance or dismissal (both of which also clear the hold)
  // or the reviewer's explicit choice above. A card that merely closed its edit fields with
  // nothing changed, or cancelled a dismissal, frees up here.
  useEffect(() => {
    if (heldRef.current.size === 0) return
    const ready = [...heldRef.current.values()].filter((h) => !busyRef.current.has(h.id))
    if (ready.length === 0) return
    for (const h of ready) heldRef.current.delete(h.id)
    setHeldVersion((v) => v + 1)
    const changedI = ready.filter((h) => h.row && h.row.kind === 'interaction').map((h) => h.row)
    const changedN = ready.filter((h) => h.row && h.row.kind === 'new_contact').map((h) => h.row)
    const removed = ready.filter((h) => h.row === null).map((h) => h.id)
    applyMerge(itemsRef, setItems, { added: [], changed: changedI, removedIds: removed })
    applyMerge(proposalsRef, setProposals, { added: [], changed: changedN, removedIds: removed })
    if (heldRef.current.size === 0) setBanner(changedI.length + changedN.length > 0 ? UPDATED_SUGGESTIONS_MESSAGE : '')
  }, [busyVersion, applyMerge])

  /** One more page of PROPOSALS, on its own cursor and its own single-flight. */
  const loadMoreProposals = useCallback(async () => {
    if (loadingProposalsRef.current) return
    loadingProposalsRef.current = true
    const gen = initGenRef.current
    try {
      const rows = await fetchProposals(proposalCursorRef.current)
      if (!aliveRef.current || gen !== initGenRef.current) return
      if (rows.length > 0) proposalCursorRef.current = cursorFrom(rows)
      setProposals((prev) => dedupeById(prev, rows))
      setProposalsHaveMore(computeHasMore(rows.length))
    } catch {
      /* keep the existing list; the refill and Load more can both be retried */
    } finally {
      loadingProposalsRef.current = false
    }
  }, [fetchProposals])

  // Load more pulls the next page of EACH queue that still has one, so one button
  // means "show me more to review" rather than "more of whichever list I happen to
  // be looking at". Each queue keeps its own cursor and its own single-flight, so a
  // failure in one does not disturb the other.
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return        // synchronous single-flight
    loadingMoreRef.current = true
    const gen = initGenRef.current            // tie this page to the current load session
    setLoadingMore(true)
    try {
      const work = []
      if (hasMore) {
        work.push((async () => {
          const rows = await fetchPage(cursorRef.current)
          if (!aliveRef.current || gen !== initGenRef.current) return
          if (rows.length > 0) cursorRef.current = cursorFrom(rows)
          setItems((prev) => dedupeById(prev, rows))
          setHasMore(computeHasMore(rows.length))
        })())
      }
      if (proposalsHaveMore) work.push(loadMoreProposals())
      await Promise.all(work)
    } catch {
      /* keep existing lists; Load more can be retried */
    } finally {
      if (aliveRef.current && gen === initGenRef.current) setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [fetchPage, hasMore, proposalsHaveMore, loadMoreProposals])

  // If resolving rows drains the visible page while more remain beyond the cursor,
  // pull the next page so the user never sees a false "all caught up".
  useEffect(() => {
    if (status === 'ready' && items.length === 0 && hasMore && !loadingMoreRef.current) {
      loadMore()
    }
  }, [status, items.length, hasMore, loadMore])

  // THE SAME REFILL FOR THE PROPOSALS QUEUE. Resolving every visible proposal while
  // more remain past the cursor must pull the next page, not show "all caught up" -
  // which is exactly what happened when this queue had no continuation at all.
  useEffect(() => {
    if (status === 'ready' && proposals.length === 0 && proposalsHaveMore
        && !loadingProposalsRef.current) {
      loadMoreProposals()
    }
  }, [status, proposals.length, proposalsHaveMore, loadMoreProposals])

  // Nothing at all is left to review. Both queues, because an empty interaction queue
  // with a proposed person still waiting is emphatically not "all caught up".
  const queueEmpty = items.length === 0 && proposals.length === 0
  // And neither queue may have anything past its cursor.
  const anyMore = hasMore || proposalsHaveMore

  function handleResolved(id, message) {
    // Only the rendered list shrinks; cursorRef is untouched, so Load more still
    // continues from the correct boundary (no skip, no duplicate). Both queues are
    // filtered because the two tables have independent id spaces - a collision is
    // effectively impossible, and filtering both costs nothing and cannot be wrong.
    setItems((prev) => prev.filter((c) => c.id !== id))
    setProposals((prev) => prev.filter((c) => c.id !== id))
    setBanner(message)
    // The queue knows this row is gone; the poll must not read the drop as a change, and
    // the navigation badge should drop with it.
    if (knownRef.current instanceof Map) knownRef.current.delete(id)
    busyRef.current.delete(id)
    if (heldRef.current.delete(id)) setHeldVersion((v) => v + 1)
    window.dispatchEvent(new Event(SUGGESTIONS_CHANGED_EVENT))
  }

  // heldVersion exists to re-render this component when heldRef changes (the cards read
  // their notice from the ref during render); it carries no other meaning.
  void heldVersion

  // Flag off → render nothing (route is also flag-gated).
  if (!SUGGESTION_REVIEW_ENABLED) return null

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Suggestions" searchPlaceholder="Find, log, or ask anything…" onSearchClick={() => {}} />
      <div className="flex-1 px-4 py-5 md:px-6 md:py-6 max-w-3xl mx-auto w-full">
        <p className="text-[13px] text-muted mb-4">
          Review what your connected sources found. Nothing is saved to your network until you
          accept it: an existing contact gets one interaction, and someone new gets a contact you
          can edit first. Dismissing a suggestion creates nothing.
        </p>

        {banner && (
          <div role="status" aria-live="polite" className="mb-4 text-[13px] text-success bg-elevated border border-line-1 rounded-xl px-4 py-3">
            {banner}
          </div>
        )}

        {status === 'loading' && (
          <div role="status" aria-live="polite" className="text-[13px] text-muted py-10 text-center">Loading suggestions…</div>
        )}

        {status === 'error' && (
          <div className="text-center py-10">
            <p className="text-[14px] text-hi mb-3">Couldn’t load suggestions.</p>
            <button type="button" onClick={loadInitial}
                    className="bg-hi text-surface text-[12px] font-bold px-[18px] py-[8px] rounded-[9px] hover:opacity-85 transition-opacity">
              Try again
            </button>
          </div>
        )}

        {status === 'ready' && queueEmpty && anyMore && (
          <div role="status" aria-live="polite" className="text-[13px] text-muted py-10 text-center">Loading more…</div>
        )}

        {status === 'ready' && queueEmpty && !anyMore && (
          <div className="text-center py-14">
            <span className={SECTION_LABEL}>Suggestions</span>
            <h2 className="font-display font-semibold text-[18px] text-hi mb-2">You’re all caught up</h2>
            <p className="text-[14px] text-muted max-w-xs mx-auto leading-relaxed">
              No suggestions to review right now.
            </p>
          </div>
        )}

        {status === 'ready' && !queueEmpty && (
          <>
            <div className="grid gap-3">
              {/* People not yet in Funnl come FIRST: each one is a decision about
                  whether someone enters the network at all, which is a bigger call
                  than logging one more interaction against a contact that exists. */}
              {proposals.map((c) => (
                <NewContactSuggestionCard key={cardKey(c)} candidate={c} onResolved={handleResolved} onBusyChange={onBusyChange}
                                          pendingUpdate={heldRef.current.get(c.id) ?? null} onTakeUpdate={takeHeldUpdate} />
              ))}
              {items.map((c) => (
                <CandidateCard key={cardKey(c)} candidate={c} onResolved={handleResolved} onBusyChange={onBusyChange}
                               pendingUpdate={heldRef.current.get(c.id) ?? null} onTakeUpdate={takeHeldUpdate} />
              ))}
            </div>
            {anyMore && (
              <div className="mt-4 text-center">
                <button type="button" onClick={loadMore} disabled={loadingMore}
                        className="bg-elevated text-mid text-[12px] font-semibold px-[18px] py-[8px] rounded-[9px] disabled:opacity-40 hover:text-hi transition-colors">
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
