/**
 * MobileAppBar — mobile-only (md:hidden) fixed top bar.
 *
 * Provides the account/avatar handle on mobile since the desktop NavRail
 * (which has the avatar) is hidden on mobile.
 *
 * Left: Funnl ember mark + wordmark.
 * Right: user avatar → taps open account sheet (Import, Settings, Sign out).
 *
 * Import and Settings are accessible ONLY through this bar on mobile —
 * they are not in the center + sheet.
 *
 * Height: 44px. The App.jsx authenticated shell adds pt-[44px] md:pt-0 to
 * the main scroll container to prevent content from sliding under this bar.
 *
 * Accessibility:
 *   - Avatar button has aria-expanded + aria-haspopup="menu"
 *   - Sheet uses role="menu" with role="menuitem" on each action
 *   - Escape closes the sheet and returns focus to the avatar button
 *   - First menu item receives focus when the sheet opens
 *   - Outside click closes
 */
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'

export default function MobileAppBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const [profile, setProfile] = useState(null)
  const [user, setUser] = useState(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const sheetRef = useRef(null)
  const triggerRef = useRef(null)    // avatar button — focus returns here on close
  const firstItemRef = useRef(null)  // "Import contacts" — focused on open

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      if (data.user) {
        supabase.from('profiles').select('display_name').eq('id', data.user.id).maybeSingle()
          .then(({ data: p }) => setProfile(p))
      }
    })
  }, [location.pathname])

  // Focus first menu item when sheet opens; return focus when it closes.
  const prevSheetOpen = useRef(false)
  useEffect(() => {
    const wasOpen = prevSheetOpen.current
    prevSheetOpen.current = sheetOpen

    if (sheetOpen && !wasOpen) {
      // Sheet just opened — focus first menu item
      setTimeout(() => firstItemRef.current?.focus(), 50)
    } else if (!sheetOpen && wasOpen) {
      // Sheet just closed — return focus to avatar button
      setTimeout(() => triggerRef.current?.focus(), 0)
    }
  }, [sheetOpen])

  // Escape closes the sheet
  useEffect(() => {
    if (!sheetOpen) return
    function onKey(e) {
      if (e.key === 'Escape') setSheetOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sheetOpen])

  // Outside-click closes the sheet
  useEffect(() => {
    if (!sheetOpen) return
    function onOutside(e) {
      if (sheetRef.current && !sheetRef.current.contains(e.target) &&
          triggerRef.current && !triggerRef.current.contains(e.target)) {
        setSheetOpen(false)
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [sheetOpen])

  async function handleSignOut() {
    setSigningOut(true)
    await supabase.auth.signOut().catch(() => {})
    window.location.assign('/signin')
  }

  function closeAndNavigate(path) {
    setSheetOpen(false)
    navigate(path)
  }

  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'F'
  const avatarBg = getAvatarColor(displayName)
  const initials = getInitials(displayName)

  return (
    <div className="md:hidden fixed top-0 left-0 right-0 z-40" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      {/* Bar — height is 44px of visible content below the safe area */}
      <div
        className="flex items-center px-[16px] h-[44px] border-b border-line-1"
        style={{ background: 'var(--color-card)' }}
      >
        {/* Funnl mark + wordmark */}
        <div className="flex items-center gap-[8px] flex-1">
          <span className="w-[24px] h-[24px] rounded-[7px] flex items-center justify-center flex-none" style={{ background: '#FF4423' }} aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#14110F"/>
            </svg>
          </span>
          <span className="text-[15px] font-display font-semibold leading-none" style={{ color: 'var(--color-hi)' }}>Funnl</span>
        </div>

        {/* Avatar button — opens account menu */}
        <button
          ref={triggerRef}
          onClick={() => setSheetOpen(s => !s)}
          className="w-[30px] h-[30px] rounded-full flex items-center justify-center flex-none font-display font-bold text-[10.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF4423]"
          style={{ background: avatarBg, color: 'var(--color-paper)' }}
          aria-label="Account menu"
          aria-expanded={sheetOpen}
          aria-haspopup="menu"
        >
          {initials}
        </button>
      </div>

      {/* Account sheet */}
      {sheetOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 top-[44px] bg-[rgba(20,17,15,0.35)]"
            onClick={() => setSheetOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={sheetRef}
            role="menu"
            aria-label="Account options"
            className="absolute top-[44px] right-[12px] w-[200px] rounded-[14px] border border-line-2 shadow-[0_8px_32px_rgba(0,0,0,0.18)] overflow-hidden"
            style={{ background: 'var(--color-card)' }}
          >
            {/* Account info (not interactive — presentational) */}
            <div className="px-[14px] py-[12px] border-b border-line-1" aria-hidden="true">
              <p className="text-[12px] font-semibold truncate" style={{ color: 'var(--color-hi)' }}>{displayName}</p>
              {user?.email && (
                <p className="text-[10.5px] truncate mt-[1px]" style={{ color: 'var(--color-muted)' }}>{user.email}</p>
              )}
            </div>

            {/* Menu items */}
            <div className="py-[6px]">
              <button
                ref={firstItemRef}
                role="menuitem"
                className="w-full flex items-center gap-[10px] px-[14px] py-[10px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#FF4423]"
                onClick={() => closeAndNavigate('/contacts?import=1')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span className="text-[13px]" style={{ color: 'var(--color-hi)' }}>Import contacts</span>
              </button>

              <button
                role="menuitem"
                className="w-full flex items-center gap-[10px] px-[14px] py-[10px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#FF4423]"
                onClick={() => closeAndNavigate('/settings')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M12 3v2.4M12 18.6V21M4.3 4.3l1.7 1.7M18 18l1.7 1.7M3 12h2.4M18.6 12H21M4.3 19.7 6 18M18 6l1.7-1.7"/>
                </svg>
                <span className="text-[13px]" style={{ color: 'var(--color-hi)' }}>Settings</span>
              </button>

              <div className="mx-[14px] my-[4px] h-px" style={{ background: 'var(--color-line-1)' }} aria-hidden="true"/>

              <button
                role="menuitem"
                className="w-full flex items-center gap-[10px] px-[14px] py-[10px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#FF4423]"
                onClick={handleSignOut}
                disabled={signingOut}
                aria-disabled={signingOut}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                <span className="text-[13px]" style={{ color: 'var(--color-danger)' }}>
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
