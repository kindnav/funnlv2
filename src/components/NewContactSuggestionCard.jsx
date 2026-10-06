import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import { track } from '../lib/analytics'
import {
  NCC_INTERACTION_TYPES, RELATIONSHIP_TYPES, NCC_BOUNDS,
  validateProposal, acceptArgs, acceptOutcome, dismissOutcome,
  initialReviewState, proposalEdited, evidenceLabel, summaryPresent,
} from '../lib/newContactReview'
import { resultCode } from '../lib/calendarReview'
import { SUGGESTION_EVENTS, suggestionEventProps } from '../lib/suggestionAnalytics'
import { dismissConfirmFocusTarget } from '../lib/dismissConfirmFocus'
import InteractionSourceBadge from '../components/InteractionSourceBadge'

const CARD = 'bg-card border border-line-1 rounded-2xl p-[18px]'
const FIELD = 'mt-1 w-full bg-input border border-line-2 rounded-lg px-2 py-[7px] text-[13px] text-hi'
const LABEL = 'text-[11px] text-muted'

function formatDate (iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined,
    { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/**
 * ONE proposed contact and the interaction that comes with it, reviewed TOGETHER.
 *
 * WHY THEY ARE ONE CARD. The two records are created by one transaction, so splitting
 * them across two cards would offer the user a choice the database does not have, and
 * accepting half of it would be impossible to honour. The interaction can be left out
 * entirely - that IS a real choice the RPC supports - but it is a checkbox on this
 * card, not a separate suggestion.
 *
 * ── NOTHING IS CREATED BEFORE "SAVE CONTACT & INTERACTION" ──────────────────
 * Rendering this card runs no mutation. Every edit is local component state. Dismiss
 * calls the dismiss RPC, which only marks the candidate and erases its draft fields.
 * The ONLY path that inserts a contact or an interaction is handleAccept, behind an
 * explicit button press, through accept_new_contact_candidate - which creates both in
 * one transaction, or neither.
 *
 * ── THE EMAIL IS READ-ONLY, AND THAT IS NOT A LIMITATION ────────────────────
 * It came from the provider's envelope and it is the one part of the proposal that was
 * not inferred. `accept_new_contact_candidate` reads it from the stored row and ignores
 * any caller value, so an editable field here would be a lie about what gets saved.
 */
export default function NewContactSuggestionCard ({ candidate, onResolved }) {
  const [state, setState] = useState(() => initialReviewState(candidate))
  const [busy, setBusy] = useState(false)
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const [error, setError] = useState('')
  const confirmBtnRef = useRef(null)
  const dismissBtnRef = useRef(null)
  const restoreFocusRef = useRef(false)

  const set = (k) => (e) => {
    const v = e?.target?.type === 'checkbox' ? e.target.checked : e.target.value
    setState((prev) => ({ ...prev, [k]: v }))
  }

  // Same focus contract as the interaction card: opening the confirmation moves focus
  // to its primary button so focus is not dropped to <body> as Dismiss unmounts, and
  // cancelling by button or Escape returns it to Dismiss.
  useEffect(() => {
    let target = null
    if (confirmDismiss) target = dismissConfirmFocusTarget('open')
    else if (restoreFocusRef.current) {
      restoreFocusRef.current = false
      target = dismissConfirmFocusTarget('cancel')
    }
    if (target === 'confirm') confirmBtnRef.current?.focus()
    else if (target === 'dismiss') dismissBtnRef.current?.focus()
  }, [confirmDismiss])

  function closeConfirm () {
    restoreFocusRef.current = true
    setConfirmDismiss(false)
  }

  const email = typeof candidate.proposed_email === 'string' ? candidate.proposed_email : ''
  const displayName = state.name.trim().length > 0 ? state.name.trim() : (email || 'New contact')
  const nameEvidence = evidenceLabel(candidate.proposed_name_evidence)
  const hasSummary = summaryPresent(candidate)
  const edited = proposalEdited(candidate, state)

  async function handleAccept () {
    if (busy) return
    setError('')
    const v = validateProposal(state)
    if (!v.ok) { setError(acceptOutcome(v.code).message); return }
    setBusy(true)
    try {
      const { data, error: rpcErr } = await supabase.rpc(
        'accept_new_contact_candidate', acceptArgs(candidate.id, state))
      if (rpcErr) { setError(acceptOutcome('write_failed').message); setBusy(false); return }
      const outcome = acceptOutcome(resultCode(data))
      if (outcome.removeFromQueue) {
        track(SUGGESTION_EVENTS.accepted, suggestionEventProps(candidate.source, {
          edited,
          // BOOLEANS AND A CONTROLLED ENUM ONLY. No name, address, company or note.
          proposed_contact: true,
          with_interaction: state.createInteraction !== false,
        }))
        window.dispatchEvent(new Event('funnl:interactions-changed'))
        onResolved(candidate.id, outcome.message)
      } else {
        setError(outcome.message)
        setBusy(false)
      }
    } catch {
      setError(acceptOutcome('write_failed').message)
      setBusy(false)
    }
  }

  async function handleDismiss () {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const { data, error: rpcErr } = await supabase.rpc('dismiss_new_contact_candidate', {
        p_candidate_id: candidate.id,
      })
      if (rpcErr) { setError(dismissOutcome('unknown').message); setBusy(false); return }
      const outcome = dismissOutcome(resultCode(data))
      if (outcome.removeFromQueue) {
        track(SUGGESTION_EVENTS.dismissed,
          suggestionEventProps(candidate.source, { proposed_contact: true }))
        onResolved(candidate.id, outcome.message)
      } else {
        setError(outcome.message)
        setBusy(false)
      }
    } catch {
      setError(dismissOutcome('unknown').message)
      setBusy(false)
    }
  }

  return (
    <div className={CARD}>
      <div className="flex items-start gap-3">
        <div className="flex-none w-10 h-10 rounded-lg flex items-center justify-center font-display font-bold text-[14px]"
             style={{ background: getAvatarColor(displayName), color: 'var(--color-paper)' }}
             aria-hidden="true">
          {getInitials(displayName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[8.5px] font-semibold tracking-[1.5px] text-accent uppercase">
              New person
            </span>
            <InteractionSourceBadge source={candidate.source} />
          </div>
          <div className="mt-1 font-display font-semibold text-[15px] text-hi truncate">
            {displayName}
          </div>
          {/* Read-only, and said plainly: this came from the message's envelope. */}
          <div className="text-[12px] text-muted truncate" title={email}>{email}</div>
          {nameEvidence && (
            <div className="mt-[2px] text-[11px] text-lower">Name {nameEvidence}</div>
          )}

          {/* ── the interaction that comes with them ───────────────────────── */}
          <div className="mt-3 border-t border-line-1 pt-3">
            <span className="block mb-2 font-mono text-[8.5px] font-semibold tracking-[1.5px] text-muted uppercase">
              The conversation
            </span>
            {hasSummary ? (
              <p className="text-[12px] text-muted leading-relaxed">{candidate.draft_summary}</p>
            ) : (
              // NEVER a placeholder note. If no summary was produced, the card says so
              // and the reviewer writes their own.
              <p className="text-[12px] text-lower leading-relaxed">
                No summary was prepared for this exchange. Add your own note below.
              </p>
            )}
            {candidate.draft_follow_up && (
              <p className="mt-2 text-[12px] text-accent leading-relaxed">
                Suggested next step: {candidate.draft_follow_up}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              <span className="font-mono text-[10px] px-2 py-[3px] rounded-full bg-elevated text-tag">
                {state.interactionType}
              </span>
              <span className="text-muted">{formatDate(state.interactionDate)}</span>
            </div>
          </div>

          {/* ── the editable review, always visible: a draft is for correcting ── */}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className={LABEL}>Name
              <input type="text" value={state.name} onChange={set('name')} disabled={busy}
                     maxLength={NCC_BOUNDS.name} className={FIELD} />
            </label>
            <label className={LABEL}>Company
              <input type="text" value={state.company} onChange={set('company')} disabled={busy}
                     maxLength={NCC_BOUNDS.company} placeholder="Optional" className={FIELD} />
            </label>
            <label className={LABEL}>Role
              <input type="text" value={state.role} onChange={set('role')} disabled={busy}
                     maxLength={NCC_BOUNDS.role} placeholder="Optional" className={FIELD} />
            </label>
            <label className={LABEL}>How you met
              <input type="text" value={state.howMet} onChange={set('howMet')} disabled={busy}
                     maxLength={NCC_BOUNDS.howMet} placeholder="Optional" className={FIELD} />
            </label>
            <label className={LABEL}>Relationship
              <select value={state.relationshipType} onChange={set('relationshipType')}
                      disabled={busy} className={FIELD}>
                <option value="">Not set</option>
                {RELATIONSHIP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className={LABEL}>Tags
              <input type="text" value={state.tags} onChange={set('tags')} disabled={busy}
                     placeholder="recruiter, target firm" className={FIELD} />
            </label>
          </div>

          <label className="mt-2 flex items-center gap-2 text-[12px] text-mid">
            <input type="checkbox" checked={state.createInteraction !== false}
                   onChange={set('createInteraction')} disabled={busy}
                   className="accent-accent" />
            Also log this conversation as an interaction
          </label>

          {state.createInteraction !== false && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className={LABEL}>Interaction type
                <select value={state.interactionType} onChange={set('interactionType')}
                        disabled={busy} className={FIELD}>
                  {NCC_INTERACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className={LABEL}>Date
                <input type="date" value={state.interactionDate} onChange={set('interactionDate')}
                       disabled={busy} className={FIELD} />
              </label>
              <label className={`${LABEL} sm:col-span-2`}>Note
                <textarea value={state.interactionNotes} onChange={set('interactionNotes')}
                          disabled={busy} rows={3} maxLength={NCC_BOUNDS.notes}
                          className={`${FIELD} resize-none`} />
              </label>
              <label className={LABEL}>Follow up on
                <input type="date" value={state.followUpDate} onChange={set('followUpDate')}
                       disabled={busy} className={FIELD} />
              </label>
            </div>
          )}

          {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}

          {!confirmDismiss ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={handleAccept} disabled={busy}
                      className="bg-hi text-surface text-[12px] font-bold px-[16px] py-[7px] rounded-[9px] disabled:opacity-40 hover:opacity-85 transition-opacity motion-reduce:transition-none">
                {busy
                  ? 'Working…'
                  : (state.createInteraction !== false
                      ? 'Save contact & interaction'
                      : 'Save contact')}
              </button>
              <button ref={dismissBtnRef} type="button" onClick={() => setConfirmDismiss(true)}
                      disabled={busy}
                      className="bg-elevated text-mid text-[12px] font-semibold px-[16px] py-[7px] rounded-[9px] disabled:opacity-40 hover:text-hi transition-colors">
                Dismiss
              </button>
            </div>
          ) : (
            <div className="mt-3" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) closeConfirm() }}>
              <p className="text-[12px] text-muted mb-2">
                Dismiss this suggestion? No contact or interaction will be created, and this
                person won’t be suggested again.
              </p>
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
