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
import { NCC_SELECT } from '../lib/newContactReview'

const CARD = 'bg-card border border-line-1 rounded-2xl p-[18px]'
const SECTION_LABEL = 'block mb-[10px] font-mono text-[8.5px] font-semibold tracking-[1.5px] text-muted uppercase'

function formatDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || ''
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// One reviewable candidate. Owns its edit fields, single-flight busy state, and outcome.
function CandidateCard({ candidate, onResolved }) {
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

  // Close the confirmation and flag that focus must return to the Dismiss button.
  function closeConfirm() {
    restoreFocusRef.current = true
    setConfirmDismiss(false)
  }

  const edited = editing && (
    type !== candidate.proposed_type ||
    date !== candidate.proposed_interaction_date ||
    (notes || '') !== (candidate.proposed_notes || '') ||
    (nextStep || '') !== (candidate.draft_follow_up || '') ||
    followUpDate !== ''
  )

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
    <div className={CARD}>
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
          {!editing && candidate.proposed_notes && (
            <p className="mt-2 text-[12px] text-muted leading-relaxed line-clamp-2">{candidate.proposed_notes}</p>
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
  }

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
                <NewContactSuggestionCard key={c.id} candidate={c} onResolved={handleResolved} />
              ))}
              {items.map((c) => <CandidateCard key={c.id} candidate={c} onResolved={handleResolved} />)}
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
