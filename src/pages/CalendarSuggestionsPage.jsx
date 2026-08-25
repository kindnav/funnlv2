import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import { track } from '../lib/analytics'
import TopBar from '../components/TopBar'
import {
  CALENDAR_INGESTION_ENABLED, CANDIDATE_SELECT, INTERACTION_TYPES, REVIEW_PAGE_SIZE,
  validateOverrides, acceptResultOutcome, dismissResultOutcome, resultCode,
} from '../lib/calendarReview'

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
  const [busy, setBusy] = useState(false)              // single-flight guard for Accept/Dismiss
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const [error, setError] = useState('')

  const edited = editing && (
    type !== candidate.proposed_type ||
    date !== candidate.proposed_interaction_date ||
    (notes || '') !== (candidate.proposed_notes || '')
  )

  async function handleAccept() {
    if (busy) return                                   // prevent double submission
    setError('')
    const v = validateOverrides({ type, date, notes })
    if (!v.ok) { setError(acceptResultOutcome(v.code).message); return }
    setBusy(true)
    try {
      const { data, error: rpcErr } = await supabase.rpc('accept_interaction_candidate', {
        p_candidate_id: candidate.id,
        p_override_type: type,
        p_override_date: date,
        p_override_notes: notes || null,
      })
      if (rpcErr) { setError(acceptResultOutcome('unknown').message); setBusy(false); return }
      const outcome = acceptResultOutcome(resultCode(data))
      if (outcome.removeFromQueue) {
        track('calendar_candidate_accepted', { edited: !!edited })
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
        track('calendar_candidate_dismissed')
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
            </div>
          )}
          {!editing && candidate.proposed_notes && (
            <p className="mt-2 text-[12px] text-muted leading-relaxed line-clamp-2">{candidate.proposed_notes}</p>
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
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} rows={2} maxLength={2000}
                          className="mt-1 w-full bg-input border border-line-2 rounded-lg px-2 py-[7px] text-[13px] text-hi resize-none" />
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
              <button type="button" onClick={() => setConfirmDismiss(true)} disabled={busy}
                      className="bg-elevated text-mid text-[12px] font-semibold px-[16px] py-[7px] rounded-[9px] disabled:opacity-40 hover:text-hi transition-colors">
                Dismiss
              </button>
              <button type="button" onClick={() => setEditing((v) => !v)} disabled={busy}
                      className="ml-auto text-[12px] text-accent hover:opacity-80 disabled:opacity-40">
                {editing ? 'Done editing' : 'Edit details'}
              </button>
            </div>
          ) : (
            <div className="mt-3">
              <p className="text-[12px] text-muted mb-2">Dismiss this suggestion? It won’t be suggested again.</p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleDismiss} disabled={busy}
                        className="bg-danger text-surface text-[12px] font-bold px-[16px] py-[7px] rounded-[9px] disabled:opacity-40 hover:opacity-85 transition-opacity">
                  {busy ? 'Working…' : 'Yes, dismiss'}
                </button>
                <button type="button" onClick={() => setConfirmDismiss(false)} disabled={busy}
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

export default function CalendarSuggestionsPage() {
  const [status, setStatus] = useState('loading')   // loading | error | ready
  const [items, setItems] = useState([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [banner, setBanner] = useState('')
  const viewedRef = useRef(false)

  const fetchPage = useCallback(async (from) => {
    // RLS scopes to the signed-in user; only safe columns + own contact are selected.
    const { data, error } = await supabase
      .from('interaction_candidates')
      .select(CANDIDATE_SELECT)
      .eq('status', 'pending')
      .order('proposed_interaction_date', { ascending: false })
      .range(from, from + REVIEW_PAGE_SIZE - 1)
    if (error) throw error
    return data || []
  }, [])

  const loadInitial = useCallback(async () => {
    setStatus('loading')
    try {
      const rows = await fetchPage(0)
      setItems(rows)
      setOffset(rows.length)
      setHasMore(rows.length === REVIEW_PAGE_SIZE)
      setStatus('ready')
      if (!viewedRef.current) { viewedRef.current = true; track('calendar_review_viewed') }
    } catch {
      setStatus('error')
    }
  }, [fetchPage])

  useEffect(() => {
    if (!CALENDAR_INGESTION_ENABLED) return   // disabled → no query runs at all
    loadInitial()
  }, [loadInitial])

  async function loadMore() {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const rows = await fetchPage(offset)
      setItems((prev) => [...prev, ...rows])
      setOffset((o) => o + rows.length)
      setHasMore(rows.length === REVIEW_PAGE_SIZE)
    } catch { /* keep existing list; Load more can be retried */ }
    setLoadingMore(false)
  }

  function handleResolved(id, message) {
    setItems((prev) => prev.filter((c) => c.id !== id))
    setBanner(message)
  }

  // Flag off → render nothing (route is also flag-gated).
  if (!CALENDAR_INGESTION_ENABLED) return null

  return (
    <div className="flex flex-col h-full">
      <TopBar title="Calendar suggestions" searchPlaceholder="Find, log, or ask anything…" onSearchClick={() => {}} />
      <div className="flex-1 px-4 py-5 md:px-6 md:py-6 max-w-3xl mx-auto w-full">
        <p className="text-[13px] text-muted mb-4">
          Review people you met on your calendar and add them as interactions. Accepting creates one
          interaction; dismissing hides the suggestion.
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

        {status === 'ready' && items.length === 0 && (
          <div className="text-center py-14">
            <span className={SECTION_LABEL}>Calendar suggestions</span>
            <h2 className="font-display font-semibold text-[18px] text-hi mb-2">You’re all caught up</h2>
            <p className="text-[14px] text-muted max-w-xs mx-auto leading-relaxed">
              No calendar suggestions to review right now.
            </p>
          </div>
        )}

        {status === 'ready' && items.length > 0 && (
          <>
            <div className="grid gap-3">
              {items.map((c) => <CandidateCard key={c.id} candidate={c} onResolved={handleResolved} />)}
            </div>
            {hasMore && (
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
