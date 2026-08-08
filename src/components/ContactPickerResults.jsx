/**
 * ContactPickerResults — shared contact-picker results list.
 *
 * Handles all picker states in one place:
 *   loading          — spinner text while the Supabase query runs
 *   error            — "Could not load contacts." + Try again
 *   no contacts      — "No contacts yet." + Add your first contact
 *   no search match  — `No contacts match "[query]".` + Clear search
 *   results          — scrollable list of contact rows
 *
 * Keyboard navigation (roving-tabindex pattern):
 *   ArrowDown from the search input (via inputRef) → focuses first result
 *   ArrowDown / ArrowUp between result rows
 *   ArrowUp on first result → returns focus to the search input
 *   Enter on a result row → selects it
 *   Tab / Shift+Tab follow natural DOM order
 *
 * The "no contacts" empty state never appears when the query failed — callers
 * must render the error state first.
 *
 * Props:
 *   filtered       {id, name, company, role}[]  — filtered, already sliced to max 20
 *   contacts       {id, ...}[]                  — all loaded (for empty-state check)
 *   loading        boolean
 *   error          Error | null
 *   query          string                       — current search text
 *   onSelect       fn(contact)                  — user picked a contact
 *   onRetry        fn()                         — re-fetch after error
 *   onAddContact   fn()                         — open AddContactDrawer
 *   onClearSearch  fn()                         — clear query string
 *   inputRef       React ref to the search <input>  — for ArrowDown delegation
 */
import { useEffect, useRef } from 'react'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'

export default function ContactPickerResults({
  filtered, contacts, loading, error, query,
  onSelect, onRetry, onAddContact, onClearSearch, inputRef,
}) {
  // Stable array of refs rebuilt on each render — always current at event time.
  const itemRefs = useRef([])
  itemRefs.current = []

  function setItemRef(el, i) {
    if (el) itemRefs.current[i] = el
  }

  // Wire ArrowDown on the search input so keyboard users can reach the list.
  useEffect(() => {
    const input = inputRef?.current
    if (!input) return
    function onInputKey(e) {
      if (e.key === 'ArrowDown' && itemRefs.current[0]) {
        e.preventDefault()
        itemRefs.current[0].focus()
      }
    }
    input.addEventListener('keydown', onInputKey)
    return () => input.removeEventListener('keydown', onInputKey)
  }, [inputRef])

  function handleItemKey(e, i, contact) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      itemRefs.current[i + 1]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (i === 0) {
        inputRef?.current?.focus()
      } else {
        itemRefs.current[i - 1]?.focus()
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onSelect(contact)
    }
  }

  // ── States ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <p
        className="text-[13px] text-center py-[24px]"
        style={{ color: 'var(--color-muted)' }}
        aria-live="polite"
        aria-busy="true"
      >
        Loading…
      </p>
    )
  }

  if (error) {
    return (
      <div className="text-center py-[24px] px-[16px]">
        <p className="text-[13px] font-medium" style={{ color: 'var(--color-danger)' }}>
          Could not load contacts.
        </p>
        <button
          onClick={onRetry}
          className="mt-[10px] text-[13px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
          style={{ color: '#FF4423' }}
        >
          Try again
        </button>
      </div>
    )
  }

  if (contacts.length === 0) {
    return (
      <div className="text-center py-[24px] px-[16px]">
        <p className="text-[13px]" style={{ color: 'var(--color-muted)' }}>No contacts yet.</p>
        <button
          onClick={onAddContact}
          className="mt-[8px] text-[13px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
          style={{ color: '#FF4423' }}
        >
          Add your first contact
        </button>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="text-center py-[24px] px-[16px]">
        <p className="text-[13px]" style={{ color: 'var(--color-muted)' }}>
          No contacts match &ldquo;{query}&rdquo;.
        </p>
        <button
          onClick={onClearSearch}
          className="mt-[8px] text-[13px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
          style={{ color: '#FF4423' }}
        >
          Clear search
        </button>
      </div>
    )
  }

  // ── Results list ─────────────────────────────────────────────────────────────

  return (
    <div role="listbox" aria-label="Contacts">
      {filtered.map((c, i) => (
        <button
          key={c.id}
          ref={el => setItemRef(el, i)}
          role="option"
          aria-selected="false"
          onClick={() => onSelect(c)}
          onKeyDown={e => handleItemKey(e, i, c)}
          className="w-full flex items-center gap-[12px] px-[16px] py-[10px] text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#FF4423]"
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(20,17,15,0.04)'}
          onMouseLeave={e => e.currentTarget.style.background = ''}
        >
          <div
            className="w-[32px] h-[32px] rounded-[9px] flex items-center justify-center text-[11px] font-bold flex-none shrink-0"
            style={{ background: getAvatarColor(c.name), color: 'var(--color-paper)' }}
            aria-hidden="true"
          >
            {getInitials(c.name)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-hi)' }}>
              {c.name}
            </p>
            {(c.role || c.company) && (
              <p className="text-[11px] truncate mt-[1px]" style={{ color: 'var(--color-muted)' }}>
                {[c.role, c.company].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>
      ))}
    </div>
  )
}
