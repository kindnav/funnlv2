/**
 * NavRail — 68px ink sidebar, desktop only (hidden md:flex).
 *
 * First-session inline labels: labels appear beneath each icon on the very first
 * session (localStorage key 'funnl-rail-labels' absent). They collapse after the
 * first route change (navigation), and stay collapsed permanently. Uses a ref to
 * skip the initial mount and only react to subsequent pathname changes.
 *
 * G-then-key shortcuts: pressing G (not in an input) then H/C/F/A/I/S navigates
 * within a 1.5-second window. Tooltip shows the shortcut text when labels are hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'

function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── RailItem ─────────────────────────────────────────────────────────────────

function RailItem({ to, label, shortcut, active, badge, showLabel, children }) {
  return (
    <Link
      to={to}
      title={showLabel ? undefined : `${label}${shortcut ? `  (${shortcut})` : ''}`}
      aria-label={label}
      className={`relative group flex flex-col items-center justify-center w-[42px] rounded-[12px] transition-all duration-300 no-underline
        ${showLabel ? 'h-[52px] gap-[3px]' : 'h-[42px]'}
        ${active ? 'bg-[rgba(255,68,35,0.16)]' : 'hover:bg-[rgba(247,242,231,0.07)]'}`}
    >
      {children}
      {badge}

      {/* Inline label — first session only */}
      {showLabel && (
        <span className="text-[8.5px] font-semibold leading-none transition-opacity duration-300" style={{ color: active ? '#FF4423' : '#8C857A' }}>
          {label}
        </span>
      )}

      {/* Hover tooltip — shown when labels are collapsed */}
      {!showLabel && (
        <span className="pointer-events-none absolute left-[52px] top-1/2 -translate-y-1/2 z-50
          opacity-0 group-hover:opacity-100 transition-opacity duration-150
          bg-[#14110F] border border-[rgba(247,242,231,0.15)] rounded-[7px]
          px-[9px] py-[5px] whitespace-nowrap shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
          <span className="text-[11px] font-semibold text-[#F7F2E7]">{label}</span>
          {shortcut && (
            <span className="ml-[6px] text-[9px] font-mono text-[#8C857A]">{shortcut}</span>
          )}
        </span>
      )}
    </Link>
  )
}

// ── NavRail ───────────────────────────────────────────────────────────────────

function NavRail() {
  const location = useLocation()
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [followUpCount, setFollowUpCount] = useState(0)

  // First-session inline labels:
  // Show labels until first navigation, then collapse permanently.
  const [showLabels, setShowLabels] = useState(
    () => localStorage.getItem('funnl-rail-labels') !== 'collapsed'
  )
  const mountedRef = useRef(false)

  useEffect(() => {
    // Skip the initial mount — only react to subsequent pathname changes.
    if (!mountedRef.current) { mountedRef.current = true; return }
    if (showLabels) {
      setShowLabels(false)
      localStorage.setItem('funnl-rail-labels', 'collapsed')
    }
  }, [location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchFollowUpCount = useCallback(async () => {
    const { count } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .not('follow_up_date', 'is', null)
      .lte('follow_up_date', getLocalToday())
    setFollowUpCount(count || 0)
  }, [])

  const fetchProfile = useCallback(async (uid) => {
    if (!uid) return
    const { data: p } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('id', uid)
      .maybeSingle()
      .catch(() => ({ data: null }))
    setProfile(p)
  }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      if (data.user) fetchProfile(data.user.id)
    })
    fetchFollowUpCount()
  }, [location.pathname, fetchFollowUpCount, fetchProfile])

  useEffect(() => {
    const handler = () => fetchFollowUpCount()
    window.addEventListener('funnl:followups-changed', handler)
    return () => window.removeEventListener('funnl:followups-changed', handler)
  }, [fetchFollowUpCount])

  // Refresh display name when Settings page confirms a save.
  useEffect(() => {
    if (!user?.id) return
    const uid = user.id
    const handler = () => fetchProfile(uid)
    window.addEventListener('funnl:profile-changed', handler)
    return () => window.removeEventListener('funnl:profile-changed', handler)
  }, [user?.id, fetchProfile])

  // G-then-key sequential nav shortcuts (G then H/C/F/A/I/S).
  // Does not fire when an input, textarea, select, or contenteditable is focused.
  // Does not fire when the CommandPalette is open (its input will be focused).
  useEffect(() => {
    let pendingG = false
    let timer = null

    const ROUTES = { h: '/', c: '/contacts', f: '/followups', a: '/ai', i: '/contacts?import=1', s: '/settings' }

    function isInputFocused() {
      const el = document.activeElement
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    }

    function clearG() { pendingG = false; if (timer) clearTimeout(timer); timer = null }

    function onKeyDown(e) {
      if (isInputFocused() || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        pendingG = true
        if (timer) clearTimeout(timer)
        timer = setTimeout(clearG, 1500)
        return
      }
      if (pendingG) {
        clearG()
        const dest = ROUTES[e.key.toLowerCase()]
        if (dest) { e.preventDefault(); navigate(dest) }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); clearG() }
  }, [navigate])

  function isActive(path) {
    if (path === '/') return location.pathname === '/'
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'F'
  const avatarBg = getAvatarColor(displayName)
  const initials = getInitials(displayName)
  const iconColor = (path) => isActive(path) ? '#FF4423' : '#8C857A'

  return (
    <div className="hidden md:flex w-[68px] min-w-[68px] h-screen flex-col items-center py-[14px] bg-rail flex-none z-40">

      {/* Brand mark — ember tile, links to home */}
      <Link
        to="/"
        className="w-[36px] h-[36px] rounded-[10px] flex items-center justify-center flex-none mb-[14px] no-underline"
        style={{ background: '#FF4423' }}
        title="Home"
        aria-label="Funnl home"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#14110F"/>
        </svg>
      </Link>

      {/* Primary nav */}
      <div className="flex flex-col gap-[4px] flex-none">

        <RailItem to="/" label="Home" shortcut="G then H" active={isActive('/')} showLabel={showLabels}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={iconColor('/')} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 10.2 12 3l9 7.2"/><path d="M5.5 8.8V21h13V8.8"/>
          </svg>
        </RailItem>

        <RailItem to="/contacts" label="Contacts" shortcut="G then C" active={isActive('/contacts')} showLabel={showLabels}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={iconColor('/contacts')} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="3"/>
            <path d="M2.5 20c0-3 2.5-5.5 5.5-5.5S13.5 17 13.5 20"/>
            <circle cx="17" cy="9" r="2.4"/>
            <path d="M15 14.6c2.8.3 5 2.6 5 5.4"/>
          </svg>
        </RailItem>

        <RailItem
          to="/followups"
          label="Follow-ups"
          shortcut="G then F"
          active={isActive('/followups')}
          showLabel={showLabels}
          badge={
            followUpCount > 0 ? (
              <span className="absolute top-[2px] right-[2px] min-w-[15px] h-[15px] rounded-full flex items-center justify-center px-[3px] text-[8.5px] font-bold font-mono leading-none"
                style={{ background: 'var(--color-ember)', color: 'var(--color-ink)' }}>
                {followUpCount > 9 ? '9+' : followUpCount}
              </span>
            ) : null
          }
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={iconColor('/followups')} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
          </svg>
        </RailItem>

        <RailItem to="/ai" label="Funnl AI" shortcut="G then A" active={isActive('/ai')} showLabel={showLabels}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M3 4H21L15 12.5V20H9V12.5Z" fill={iconColor('/ai')}/>
          </svg>
        </RailItem>

      </div>

      {/* Hairline divider */}
      <div className="w-[28px] my-[10px] h-px flex-none" style={{ background: 'rgba(247,242,231,0.12)' }}/>

      {/* Secondary nav */}
      <div className="flex flex-col gap-[4px] flex-none">
        <RailItem to="/contacts?import=1" label="Import" shortcut="G then I" active={false} showLabel={showLabels}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8C857A" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </RailItem>
      </div>

      {/* Spacer */}
      <div className="flex-1"/>

      {/* Bottom: Settings + Account */}
      <div className="flex flex-col gap-[4px] items-center flex-none">
        <RailItem to="/settings" label="Settings" shortcut="G then S" active={isActive('/settings')} showLabel={showLabels}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={iconColor('/settings')} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 3v2.4M12 18.6V21M4.3 4.3l1.7 1.7M18 18l1.7 1.7M3 12h2.4M18.6 12H21M4.3 19.7 6 18M18 6l1.7-1.7"/>
          </svg>
        </RailItem>

        <Link
          to="/settings"
          title={displayName}
          aria-label={`Account: ${displayName}`}
          className="w-[34px] h-[34px] rounded-full flex items-center justify-center flex-none no-underline mt-[5px] font-display font-bold text-[11px]"
          style={{ background: avatarBg, color: 'var(--color-paper)' }}
        >
          {initials}
        </Link>
      </div>

    </div>
  )
}

export default NavRail
