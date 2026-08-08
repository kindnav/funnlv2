/**
 * ContactPickerModal — desktop/tablet contact-selection dialog.
 *
 * Used by DashboardPage quick actions (Log an interaction, Create a follow-up).
 * Shares data logic with BottomNav's sheet picker via useContactPicker and
 * ContactPickerResults.
 *
 * Accessibility:
 *   - role="dialog" aria-modal="true" aria-labelledby
 *   - Initial focus on search input
 *   - Focus trap: Tab / Shift+Tab stay inside the panel
 *   - Escape closes (stops propagation so nested Escape events don't bubble)
 *   - Focus returns to the triggering element when the modal unmounts
 *   - Body scroll locked while open
 *   - Backdrop click closes without selecting
 *   - Clicking inside the panel does not propagate to the backdrop
 *   - Arrow key navigation through results (via ContactPickerResults)
 *   - Visible focus rings on all interactive elements
 *
 * Props:
 *   title           — heading text ("Log an interaction", "Create a follow-up")
 *   onSelect        — fn(contact) called when user picks a contact
 *   onClose         — fn() called on Escape / backdrop click / X button
 *   onAddContact    — fn() called when user taps "Add your first contact" (no-contacts state)
 *   contacts        — optional preloaded contacts from the parent page; when supplied the
 *                     hook skips the Supabase fetch and filters client-side from this array.
 *                     Pass undefined while the parent is still loading.
 */
import { useEffect, useRef } from 'react'
import { useContactPicker } from '../lib/useContactPicker'
import ContactPickerResults from './ContactPickerResults'

const TITLE_ID = 'cp-modal-title'

export default function ContactPickerModal({ title, onSelect, onClose, onAddContact, contacts: preloadedContacts }) {
  const panelRef       = useRef(null)
  const inputRef       = useRef(null)
  const returnFocusRef = useRef(null)

  const { query, setQuery, contacts, filtered, loading, error, retry } = useContactPicker({
    preloadedContacts,
  })

  // Capture the triggering element so focus can return when the modal closes.
  useEffect(() => {
    returnFocusRef.current = document.activeElement
  }, [])

  // Body scroll lock while open.
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // Initial focus on the search input.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  // Return focus to the trigger element when the modal unmounts.
  useEffect(() => {
    return () => {
      const el = returnFocusRef.current
      if (el && typeof el.focus === 'function') el.focus()
    }
  }, [])

  // Escape closes the modal.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Focus trap: Tab / Shift+Tab wrap within the panel.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last  = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      {/* Backdrop — clicking here closes; clicks inside the panel do not reach this. */}
      <div
        className="fixed inset-0 bg-[rgba(20,17,15,0.45)] z-50"
        onClick={onClose}
        aria-hidden="true"
        style={{ animation: 'fade-in 0.15s ease-out' }}
      />

      {/* Centering container — pointer-events none so backdrop receives clicks. */}
      <div className="fixed inset-0 z-50 flex items-center justify-center px-[16px] pointer-events-none">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          className="w-full max-w-[440px] rounded-[18px] border border-line-2 shadow-[0_24px_64px_rgba(0,0,0,0.18)] pointer-events-auto overflow-hidden"
          style={{ background: 'var(--color-card)' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-[18px] pt-[16px] pb-[12px] border-b border-line-1">
            <h3
              id={TITLE_ID}
              className="text-[14px] font-semibold"
              style={{ color: 'var(--color-hi)' }}
            >
              {title}
            </h3>
            <button
              onClick={onClose}
              className="w-[28px] h-[28px] rounded-[7px] flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
              style={{ color: 'var(--color-muted)' }}
              aria-label="Close"
              onMouseEnter={e => e.currentTarget.style.background = 'var(--color-elevated)'}
              onMouseLeave={e => e.currentTarget.style.background = ''}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {/* Search input */}
          <div className="px-[14px] pt-[12px] pb-[8px]">
            <div
              className="flex items-center gap-[8px] px-[12px] h-[38px] rounded-[10px] border border-line-2"
              style={{ background: 'var(--color-elevated)' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                ref={inputRef}
                type="text"
                placeholder="Search by name, company, or role…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:opacity-50"
                style={{ color: 'var(--color-hi)' }}
                aria-label="Search contacts"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
                  style={{ color: 'var(--color-low)' }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--color-mid)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--color-low)'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12"/>
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Results — all states handled by ContactPickerResults */}
          <div className="overflow-y-auto max-h-[320px]" style={{ scrollbarWidth: 'thin' }}>
            <ContactPickerResults
              filtered={filtered}
              contacts={contacts}
              loading={loading}
              error={error}
              query={query}
              onSelect={onSelect}
              onRetry={retry}
              onAddContact={onAddContact}
              onClearSearch={() => setQuery('')}
              inputRef={inputRef}
            />
          </div>
        </div>
      </div>
    </>
  )
}
