/**
 * BottomNav — mobile-only 5-tab navigation + quick-actions sheet.
 *
 * Tabs: Home · People · center+ · Due · AI
 * Center + opens a quick-actions sheet with:
 *   1. Log an interaction  (primary — opens contact picker → detail page)
 *   2. Add a contact       (opens AddContactDrawer via event)
 *   3. Create a follow-up  (same picker flow as Log interaction)
 *   4. Ask Funnl AI        (Pro only — navigate /ai)
 *
 * Import and Settings are NOT in this sheet — they live behind the avatar menu.
 *
 * The interaction/follow-up actions enter the EXISTING logging flow:
 * contact picker → navigate to ContactDetailPage with openInteractionForm state.
 * No duplicate form is created.
 *
 * Accessibility:
 *   - Sheet uses role="dialog" aria-modal="true" (focus trapped implicitly)
 *   - Escape closes sheet (or goes back from picker to actions)
 *   - First action button receives focus when sheet opens
 *   - Focus returns to the + trigger when sheet closes
 *   - Body scroll locked while sheet is open
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useProStatus } from '../lib/useProStatus'
import { classifyProStatus } from '../lib/pro-ui-status'
import { useContactPicker } from '../lib/useContactPicker'
import { buildPickerNavigationState } from '../lib/contactPickerUtils'
import ContactPickerResults from './ContactPickerResults'

function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Contact picker — mobile sheet variant ────────────────────────────────────
// Uses the same useContactPicker hook and ContactPickerResults as the desktop
// modal. Different outer presentation (sheet layout, back button, mobile sizing).

const SHEET_PICKER_TITLE_ID = 'bn-sheet-picker-title'

function ContactPicker({ onPick, onBack, onClose }) {
  const inputRef = useRef(null)
  const { query, setQuery, contacts, filtered, loading, error, retry } = useContactPicker()

  // Focus search input on mount.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [])

  // Escape → go back to actions. stopImmediatePropagation prevents the outer
  // sheet-level window handler from also firing on the same event.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); onBack() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  function handleAddContact() {
    // Close the whole sheet first, then open the drawer via the established event.
    // Using onClose (not onBack) prevents stacking the sheet and the drawer.
    window.dispatchEvent(new CustomEvent('funnl:open-add-contact'))
    onClose()
  }

  return (
    <div className="flex flex-col max-h-[70vh]">
      {/* Header — back button + title */}
      <div className="flex items-center gap-[10px] px-[16px] pt-[4px] pb-[10px]">
        <button
          onClick={onBack}
          className="w-[30px] h-[30px] rounded-full flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
          style={{ background: 'var(--color-elevated)' }}
          aria-label="Back to quick actions"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <span id={SHEET_PICKER_TITLE_ID} className="text-[13px] font-semibold" style={{ color: 'var(--color-hi)' }}>
          Choose a contact
        </span>
      </div>

      {/* Search */}
      <div className="px-[16px] pb-[10px]">
        <div
          className="flex items-center gap-[8px] px-[10px] h-[36px] rounded-[9px] border border-line-2"
          style={{ background: 'var(--color-input)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name, company, or role…"
            aria-label="Search contacts"
            className="flex-1 bg-transparent border-none outline-none text-[13px] placeholder:opacity-50"
            style={{ color: 'var(--color-hi)' }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
              style={{ color: 'var(--color-low)' }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Results — all states (loading / error / empty / no-match / list) */}
      <div className="flex-1 overflow-y-auto pb-[12px]">
        <ContactPickerResults
          filtered={filtered}
          contacts={contacts}
          loading={loading}
          error={error}
          query={query}
          onSelect={c => onPick(c.id)}
          onRetry={retry}
          onAddContact={handleAddContact}
          onClearSearch={() => setQuery('')}
          inputRef={inputRef}
        />
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function BottomNav() {
  const location = useLocation()
  const navigate = useNavigate()

  const [followUpCount, setFollowUpCount] = useState(0)

  // Pro access — from shared context (one RPC per app mount, not one per component)
  const proStatus     = useProStatus()
  const displayStatus = classifyProStatus(proStatus)
  const canUsePro     = displayStatus === 'permanent' || displayStatus === 'trial' || displayStatus === 'subscribed'

  // Sheet state
  const [sheetOpen, setSheetOpen] = useState(false)
  // 'actions' | 'log-picker' | 'followup-picker'
  const [sheetPage, setSheetPage] = useState('actions')
  const sheetRef = useRef(null)

  // Focus management refs
  const plusTriggerRef = useRef(null)   // the + button — receives focus when sheet closes
  const firstActionRef = useRef(null)   // "Log an interaction" — receives focus when sheet opens

  // ── Follow-up count — re-fetch on route change and on funnl:followups-changed ─

  useEffect(() => {
    async function fetchCount() {
      const { count } = await supabase
        .from('interactions')
        .select('id', { count: 'exact', head: true })
        .not('follow_up_date', 'is', null)
        .lte('follow_up_date', getLocalToday())
      setFollowUpCount(count || 0)
    }
    fetchCount()

    const handler = () => {
      supabase
        .from('interactions')
        .select('id', { count: 'exact', head: true })
        .not('follow_up_date', 'is', null)
        .lte('follow_up_date', getLocalToday())
        .then(({ count }) => setFollowUpCount(count || 0))
    }
    window.addEventListener('funnl:followups-changed', handler)
    return () => window.removeEventListener('funnl:followups-changed', handler)
  }, [location.pathname])

  // ── Sheet open/close — focus management + scroll lock ───────────────────────

  // Focus first action when sheet opens; return focus when it closes.
  const prevSheetOpen = useRef(false)
  useEffect(() => {
    const wasOpen = prevSheetOpen.current
    prevSheetOpen.current = sheetOpen

    if (sheetOpen && !wasOpen) {
      // Sheet just opened — lock scroll, focus first action
      document.body.style.overflow = 'hidden'
      setTimeout(() => firstActionRef.current?.focus(), 60)
    } else if (!sheetOpen && wasOpen) {
      // Sheet just closed — restore scroll, return focus to + trigger
      document.body.style.overflow = ''
      setTimeout(() => plusTriggerRef.current?.focus(), 0)
    }
  }, [sheetOpen])

  // Reset page on close (after animation)
  const prevSheetOpenForPage = useRef(false)
  useEffect(() => {
    if (!sheetOpen && prevSheetOpenForPage.current) {
      setTimeout(() => setSheetPage('actions'), 200)
    }
    prevSheetOpenForPage.current = sheetOpen
  }, [sheetOpen])

  // When Escape returns from the picker sub-view to the actions page, restore
  // focus to the first action button so keyboard users can continue naturally.
  // Tracks the previous page to fire only on transitions TO 'actions', not on
  // initial sheet open (which is handled by the sheet-open effect above).
  const prevSheetPageRef = useRef('actions')
  useEffect(() => {
    const prev = prevSheetPageRef.current
    prevSheetPageRef.current = sheetPage
    if (prev !== 'actions' && sheetPage === 'actions' && sheetOpen) {
      const t = setTimeout(() => firstActionRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [sheetPage, sheetOpen])

  // Escape on the actions page → close sheet.
  // When the picker is showing, its own handler fires e.stopImmediatePropagation()
  // before calling onBack, so this listener never fires while the picker is visible.
  // The sheetPage !== 'actions' branch is a defensive fallback only.
  useEffect(() => {
    if (!sheetOpen) return
    function onKey(e) {
      if (e.key === 'Escape') {
        if (sheetPage !== 'actions') {
          setSheetPage('actions')
        } else {
          setSheetOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetOpen, sheetPage])

  // Ensure scroll lock is cleaned up on unmount (safety net)
  useEffect(() => {
    return () => { document.body.style.overflow = '' }
  }, [])

  // Focus trap: Tab / Shift+Tab stay inside the sheet while it is open.
  useEffect(() => {
    if (!sheetOpen) return
    function onKeyDown(e) {
      if (e.key !== 'Tab') return
      const panel = sheetRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
  }, [sheetOpen])

  // ── Sheet outside-tap close ──────────────────────────────────────────────────

  useEffect(() => {
    if (!sheetOpen) return
    function onOutside(e) {
      if (sheetRef.current && !sheetRef.current.contains(e.target)) setSheetOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [sheetOpen])

  function openSheet() {
    setSheetPage('actions')
    setSheetOpen(true)
  }

  function closeSheet() {
    setSheetOpen(false)
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  function pickContact(contactId, page) {
    const mode  = page === 'followup-picker' ? 'followup' : 'interaction'
    const state = buildPickerNavigationState(mode)
    if (state) navigate(`/contacts/${contactId}`, { state })
    closeSheet()
  }

  function handleAddContact() {
    window.dispatchEvent(new CustomEvent('funnl:open-add-contact'))
    closeSheet()
  }

  function handleAskAI() {
    navigate('/ai')
    closeSheet()
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function isActive(path) {
    if (path === '/') return location.pathname === '/'
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  const tabColor = (path) => isActive(path) ? 'var(--color-ember)' : 'var(--color-low)'

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-50">

      {/* Sheet backdrop + panel */}
      {sheetOpen && (
        <>
          {/* Backdrop — clicking outside closes */}
          <div
            className="fixed inset-0" style={{ background: 'var(--color-backdrop)' }}
            onClick={closeSheet}
            aria-hidden="true"
          />

          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={sheetPage === 'actions' ? 'Quick actions' : 'Choose a contact'}
            className="absolute bottom-[56px] left-0 right-0 rounded-t-[20px] border-t border-line-1"
            style={{ background: 'var(--color-card)', paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="w-[36px] h-[4px] rounded-full mx-auto mt-[10px] mb-[16px]" style={{ background: 'var(--color-line-3)' }} aria-hidden="true"/>

            {/* ── Actions page ────────────────────────────────────────────── */}
            {sheetPage === 'actions' && (
              <div className="px-[16px] pb-[20px] flex flex-col gap-[8px]">

                {/* Log an interaction — primary ember action */}
                <button
                  ref={firstActionRef}
                  className="w-full flex items-center gap-[14px] px-[14px] py-[14px] rounded-[12px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
                  style={{ background: '#FF4423' }}
                  onClick={() => setSheetPage('log-picker')}
                >
                  <span className="w-[36px] h-[36px] rounded-[10px] flex items-center justify-center flex-none bg-[rgba(20,17,15,0.15)]" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                  </span>
                  <div>
                    <div className="text-[14px] font-semibold" style={{ color: 'var(--color-ink)' }}>Log an interaction</div>
                    <div className="text-[12px]" style={{ color: 'rgba(20,17,15,0.65)' }}>Note a conversation or meeting</div>
                  </div>
                </button>

                {/* Add a contact */}
                <button
                  className="w-full flex items-center gap-[14px] px-[14px] py-[13px] rounded-[12px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
                  style={{ background: 'var(--color-elevated)' }}
                  onClick={handleAddContact}
                >
                  <span className="w-[36px] h-[36px] rounded-[10px] flex items-center justify-center flex-none border border-line-2" style={{ background: 'var(--color-card)' }} aria-hidden="true">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="2.2" strokeLinecap="round">
                      <circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
                      <path d="M16 11h6M19 8v6"/>
                    </svg>
                  </span>
                  <div>
                    <div className="text-[14px] font-semibold" style={{ color: 'var(--color-hi)' }}>Add a contact</div>
                    <div className="text-[12px]" style={{ color: 'var(--color-muted)' }}>Manually add someone new</div>
                  </div>
                </button>

                {/* Create a follow-up */}
                <button
                  className="w-full flex items-center gap-[14px] px-[14px] py-[13px] rounded-[12px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
                  style={{ background: 'var(--color-elevated)' }}
                  onClick={() => setSheetPage('followup-picker')}
                >
                  <span className="w-[36px] h-[36px] rounded-[10px] flex items-center justify-center flex-none border border-line-2" style={{ background: 'var(--color-card)' }} aria-hidden="true">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
                    </svg>
                  </span>
                  <div>
                    <div className="text-[14px] font-semibold" style={{ color: 'var(--color-hi)' }}>Create a follow-up</div>
                    <div className="text-[12px]" style={{ color: 'var(--color-muted)' }}>Set a reminder on a contact</div>
                  </div>
                </button>

                {/* Ask Funnl AI — permanent Pro or active trial only; hidden while loading/unavailable */}
                {canUsePro && (
                  <button
                    className="w-full flex items-center gap-[14px] px-[14px] py-[13px] rounded-[12px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
                    style={{ background: 'var(--color-elevated)' }}
                    onClick={handleAskAI}
                  >
                    <span className="w-[36px] h-[36px] rounded-[10px] flex items-center justify-center flex-none border border-line-2" style={{ background: 'var(--color-card)' }} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="var(--color-mid)"/>
                      </svg>
                    </span>
                    <div>
                      <div className="text-[14px] font-semibold" style={{ color: 'var(--color-hi)' }}>Ask Funnl AI</div>
                      <div className="text-[12px]" style={{ color: 'var(--color-muted)' }}>Ask anything about your network</div>
                    </div>
                  </button>
                )}

              </div>
            )}

            {/* ── Contact picker (Log interaction / Create follow-up) ─────── */}
            {(sheetPage === 'log-picker' || sheetPage === 'followup-picker') && (
              <ContactPicker
                onPick={(id) => pickContact(id, sheetPage)}
                onBack={() => setSheetPage('actions')}
                onClose={closeSheet}
              />
            )}
          </div>
        </>
      )}

      {/* ── Tab bar ─────────────────────────────────────────────────────────── */}
      <nav
        aria-label="Main navigation"
        className="flex items-end border-t border-line-1"
        style={{ background: 'var(--color-card)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >

        <Link to="/" className="flex-1 flex flex-col items-center gap-[3px] py-[10px] no-underline" aria-label="Home">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke={tabColor('/')} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 10.2 12 3l9 7.2"/><path d="M5.5 8.8V21h13V8.8"/>
          </svg>
          <span className="text-[9.5px] font-semibold tracking-wide" style={{ color: tabColor('/') }} aria-hidden="true">Home</span>
        </Link>

        <Link to="/contacts" className="flex-1 flex flex-col items-center gap-[3px] py-[10px] no-underline" aria-label="Contacts">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke={tabColor('/contacts')} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="3"/><path d="M2.5 20c0-3 2.5-5.5 5.5-5.5S13.5 17 13.5 20"/>
            <circle cx="17" cy="9" r="2.4"/><path d="M15 14.6c2.8.3 5 2.6 5 5.4"/>
          </svg>
          <span className="text-[9.5px] font-semibold tracking-wide" style={{ color: tabColor('/contacts') }} aria-hidden="true">People</span>
        </Link>

        {/* Center + — floating ember button */}
        <div className="flex-1 flex flex-col items-center pb-[4px]">
          <button
            ref={plusTriggerRef}
            onClick={sheetOpen ? closeSheet : openSheet}
            className="w-[48px] h-[48px] rounded-full flex items-center justify-center -mt-[10px] transition-transform active:scale-95 shadow-[0_4px_16px_rgba(255,68,35,0.35)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
            style={{ background: '#FF4423' }}
            aria-label={sheetOpen ? 'Close quick actions' : 'Quick actions'}
            aria-expanded={sheetOpen}
            aria-haspopup="dialog"
          >
            <svg
              width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="var(--color-ink)" strokeWidth="2.5" strokeLinecap="round"
              aria-hidden="true"
              style={{ transform: sheetOpen ? 'rotate(45deg)' : 'none', transition: 'transform 0.2s' }}
            >
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </button>
        </div>

        <Link to="/followups" className="flex-1 flex flex-col items-center gap-[3px] py-[10px] no-underline relative" aria-label={followUpCount > 0 ? `Follow-ups, ${followUpCount > 9 ? '9 or more' : followUpCount} due` : 'Follow-ups'}>
          {followUpCount > 0 && (
            <span
              className="absolute top-[7px] right-[calc(50%-14px)] min-w-[14px] h-[14px] rounded-full flex items-center justify-center px-[3px] text-[8px] font-bold font-mono leading-none"
              style={{ background: 'var(--color-ember)', color: 'var(--color-ink)' }}
              aria-hidden="true"
            >
              {followUpCount > 9 ? '9+' : followUpCount}
            </span>
          )}
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke={tabColor('/followups')} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
          </svg>
          <span className="text-[9.5px] font-semibold tracking-wide" style={{ color: tabColor('/followups') }} aria-hidden="true">Due</span>
        </Link>

        <Link to="/ai" className="flex-1 flex flex-col items-center gap-[3px] py-[10px] no-underline" aria-label="Funnl AI">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 4H21L15 12.5V20H9V12.5Z" fill={tabColor('/ai')}/>
          </svg>
          <span className="text-[9.5px] font-semibold tracking-wide" style={{ color: tabColor('/ai') }} aria-hidden="true">AI</span>
        </Link>

      </nav>
    </div>
  )
}
