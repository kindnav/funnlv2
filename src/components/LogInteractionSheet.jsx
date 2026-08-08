/**
 * LogInteractionSheet — mobile-only bottom sheet for logging an interaction.
 *
 * Rendered only on screens below md (768 px). The desktop inline form in
 * ContactDetailPage takes over above that breakpoint.
 *
 * All form state and the submit handler live in ContactDetailPage so there is
 * one source of truth for mutation logic, analytics, and Log Result behaviour.
 * This component is a pure UI shell — it receives state + setters as props and
 * calls onSubmit (handleLogInteraction) directly.
 *
 * Accessibility
 *   - role="dialog" aria-modal="true"
 *   - Labelled via aria-labelledby pointing to the visible sheet title
 *   - Initial focus lands on the Type selector on open
 *   - Full focus trap: Tab/Shift+Tab cycle within the sheet
 *   - Escape closes the sheet (same as Cancel button)
 *   - Body scroll locked while open (cleaned up on unmount)
 *   - Focus restoration: caller supplies focusRestoreRef (points to the
 *     element that triggered the sheet). Sheet focuses it on close.
 */
import { useEffect, useRef } from 'react'

const SHEET_TITLE_ID = 'log-sheet-title'
const FOCUSABLE_SEL  = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const TYPE_OPTIONS = ['Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other']
const iCls = 'w-full bg-input border border-line-3 rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-lower outline-none focus:border-[rgba(255,68,35,0.4)] transition-colors'
const lCls = 'mb-[7px] block text-[12.5px] font-semibold text-mid'
const sCls = `${iCls} cursor-pointer`

function useFocusTrap(containerRef, active) {
  useEffect(() => {
    if (!active || !containerRef.current) return
    const container = containerRef.current
    function handler(e) {
      if (e.key !== 'Tab') return
      const items = Array.from(container.querySelectorAll(FOCUSABLE_SEL))
      if (items.length === 0) { e.preventDefault(); return }
      const first = items[0]
      const last  = items[items.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first || !container.contains(document.activeElement)) {
          e.preventDefault(); last.focus()
        }
      } else {
        if (document.activeElement === last || !container.contains(document.activeElement)) {
          e.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [active, containerRef])
}

export default function LogInteractionSheet({
  open,
  onClose,
  contactName,
  focusRestoreRef,
  // form state
  type,
  interactionDate,
  notes,
  followUpDate,
  trackOutreach,
  outreachStatus,
  // setters
  onTypeChange,
  setInteractionDate,
  setNotes,
  setFollowUpDate,
  setTrackOutreach,
  setOutreachStatus,
  // submission
  onSubmit,
  submitting,
  formError,
  // ref for follow-up date focus (openFollowUpForm flow)
  followUpDateRef,
}) {
  const sheetRef    = useRef(null)
  const typeSelRef  = useRef(null)

  useFocusTrap(sheetRef, open)

  // Body scroll lock
  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [open])

  // Initial focus — type selector on open
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => typeSelRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [open])

  // Escape closes
  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Focus restoration on close
  const prevOpen = useRef(false)
  useEffect(() => {
    const wasOpen = prevOpen.current
    prevOpen.current = open
    if (wasOpen && !open) {
      setTimeout(() => focusRestoreRef?.current?.focus(), 0)
    }
  }, [open, focusRestoreRef])

  if (!open) return null

  return (
    <>
      {/* Backdrop — closes on tap */}
      <div
        className="fixed inset-0 z-40 md:hidden"
        style={{ background: 'var(--color-backdrop)', animation: 'fade-in 0.15s ease-out' }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={SHEET_TITLE_ID}
        className="fixed bottom-0 left-0 right-0 z-50 md:hidden rounded-t-[20px] border-t border-line-2 overflow-y-auto"
        style={{
          background: 'var(--color-card)',
          maxHeight: '90dvh',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 72px)',
          animation: 'slide-in-bottom 0.25s ease-out',
        }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1" aria-hidden="true">
          <div className="w-8 h-1 rounded-full" style={{ background: 'var(--color-line-3)' }}/>
        </div>

        {/* Sheet header */}
        <div className="px-4 pt-1 pb-3 border-b border-line-1">
          <p id={SHEET_TITLE_ID} className="text-[14px] font-semibold text-hi leading-snug">
            Log interaction
            {contactName && (
              <span className="font-normal" style={{ color: 'var(--color-muted)' }}> · {contactName}</span>
            )}
          </p>
        </div>

        {/* Form — single onSubmit pointing at handleLogInteraction in parent */}
        <form onSubmit={onSubmit} className="p-4 space-y-3">

          {/* Type */}
          <div>
            <label className={lCls} htmlFor="ls-type">Type</label>
            <select
              id="ls-type"
              ref={typeSelRef}
              value={type}
              onChange={e => onTypeChange(e.target.value)}
              className={sCls}
            >
              {TYPE_OPTIONS.map(o => <option key={o}>{o}</option>)}
            </select>
          </div>

          {/* Date */}
          <div>
            <label className={lCls} htmlFor="ls-date">
              Date <span style={{ color: 'var(--color-ember)' }}>*</span>
            </label>
            <input
              id="ls-date"
              type="date"
              value={interactionDate}
              onChange={e => setInteractionDate(e.target.value)}
              required
              className={iCls}
            />
          </div>

          {/* Notes */}
          <div>
            <label className={lCls} htmlFor="ls-notes">Notes</label>
            <textarea
              id="ls-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="What did you talk about? Any key takeaways?"
              className={`${iCls} resize-y min-h-[80px]`}
            />
          </div>

          {/* Follow-up date */}
          <div>
            <label className={lCls} htmlFor="ls-followup">Follow-up date</label>
            <input
              id="ls-followup"
              ref={followUpDateRef}
              type="date"
              value={followUpDate}
              onChange={e => setFollowUpDate(e.target.value)}
              className={iCls}
            />
          </div>

          {/* Outreach — Email / Message */}
          {(type === 'Email' || type === 'Message') && (
            <div className="space-y-2.5">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={trackOutreach}
                  onChange={e => {
                    setTrackOutreach(e.target.checked)
                    if (e.target.checked && !outreachStatus) setOutreachStatus('awaiting_response')
                    if (!e.target.checked) setOutreachStatus('')
                  }}
                  className="w-4 h-4 accent-[#FF4423] cursor-pointer"
                />
                <span className="text-[13px] font-semibold text-hi">This was outreach I sent</span>
              </label>
              <p className="text-[12px] text-lower">
                Track the response manually. Automatic inbox syncing is not enabled.
              </p>
              {trackOutreach && (
                <select
                  value={outreachStatus}
                  onChange={e => setOutreachStatus(e.target.value)}
                  className={sCls}
                >
                  <option value="awaiting_response">Awaiting response</option>
                  <option value="responded">Responded</option>
                  <option value="meeting_booked">Meeting booked</option>
                  <option value="no_response">No response</option>
                  <option value="declined">Declined</option>
                </select>
              )}
            </div>
          )}

          {/* Outreach — Call / Other */}
          {(type === 'Call' || type === 'Other') && (
            <div>
              <label className={lCls} htmlFor="ls-outreach-status">
                Outreach status
                <span className="text-lower font-normal ml-1">
                  — Track the outcome manually. Automatic syncing is not enabled.
                </span>
              </label>
              <select
                id="ls-outreach-status"
                value={outreachStatus}
                onChange={e => setOutreachStatus(e.target.value)}
                className={sCls}
              >
                <option value="">— not set —</option>
                <option value="awaiting_response">Awaiting response</option>
                <option value="responded">Responded</option>
                <option value="meeting_booked">Meeting booked</option>
                <option value="no_response">No response</option>
                <option value="declined">Declined</option>
              </select>
            </div>
          )}

          {/* Error */}
          {formError && (
            <p className="text-sm font-medium" style={{ color: 'var(--color-danger)' }}>{formError}</p>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 text-[13.5px] font-bold py-[11px] rounded-[11px] hover:opacity-90 transition-opacity disabled:opacity-40"
              style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}
            >
              {submitting ? 'Saving…' : 'Save interaction'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 text-[13px] font-semibold text-mid border border-line-3 rounded-[11px] hover:text-hi transition-colors"
              style={{ background: 'var(--color-elevated)' }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
