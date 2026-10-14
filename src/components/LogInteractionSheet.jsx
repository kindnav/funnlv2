/**
 * LogInteractionSheet — mobile-only bottom sheet for logging an interaction.
 *
 * Rendered only on screens below md (768 px). The desktop inline form in
 * ContactDetailPage takes over above that breakpoint.
 *
 * All form state and the submit handler live in ContactDetailPage so there is
 * one source of truth for mutation logic, analytics, and Log Result behaviour.
 * This component is a pure UI shell — it receives state + setters as props and
 * calls onSubmit (handleLogInteraction) directly. The fields themselves are
 * InteractionFormFields, shared with the desktop inline form.
 *
 * ContactDetailPage mounts this sheet ONLY below md (useMediaQuery), so its
 * focus trap, Escape handler and scroll lock never act on the desktop page.
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
import InteractionFormFields from './InteractionFormFields'

const SHEET_TITLE_ID = 'log-sheet-title'
const FOCUSABLE_SEL  = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')


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

          <InteractionFormFields
            idPrefix="ls"
            type={type}
            onTypeChange={onTypeChange}
            interactionDate={interactionDate}
            setInteractionDate={setInteractionDate}
            notes={notes}
            setNotes={setNotes}
            followUpDate={followUpDate}
            setFollowUpDate={setFollowUpDate}
            trackOutreach={trackOutreach}
            setTrackOutreach={setTrackOutreach}
            outreachStatus={outreachStatus}
            setOutreachStatus={setOutreachStatus}
            formError={formError}
            typeSelectRef={typeSelRef}
            followUpDateRef={followUpDateRef}
          />

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
