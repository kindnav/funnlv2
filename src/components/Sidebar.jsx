import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// Defined outside Sidebar to avoid React remount-on-render issues
function NavItem({ to, label, icon, badge, active }) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-3 px-3 py-[10px] rounded-[10px] text-[14px] font-medium transition-colors no-underline ${
        active
          ? 'bg-[rgba(108,92,255,0.14)] text-hi shadow-[inset_0_0_0_1px_rgba(139,124,255,0.18)]'
          : 'text-low hover:text-hi hover:bg-[rgba(255,255,255,0.04)]'
      }`}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge}
    </Link>
  )
}

// Local date string — avoids UTC-offset "wrong day" bugs
function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function Sidebar() {
  const location = useLocation()
  const [user, setUser] = useState(null)
  const [followUpCount, setFollowUpCount] = useState(0)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user))
    fetchFollowUpCount()
  }, [])

  async function fetchFollowUpCount() {
    const { count } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .not('follow_up_date', 'is', null)
      .lte('follow_up_date', getLocalToday())
    setFollowUpCount(count || 0)
  }

  function getInitials(email) {
    if (!email) return 'F'
    return email.split('@')[0].slice(0, 2).toUpperCase()
  }

  function getUsername(email) {
    if (!email) return 'user'
    return email.split('@')[0]
  }

  function isActive(path) {
    if (path === '/') return location.pathname === '/'
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  const iconStroke = (active) => active ? '#8B7CFF' : '#6C6C78'

  return (
    <div className="w-[248px] min-w-[248px] h-screen flex flex-col bg-sidebar border-r border-[rgba(255,255,255,0.06)] overflow-y-auto">

      {/* Logo */}
      <div className="flex items-center gap-[10px] px-[18px] pt-[18px] pb-5">
        <div className="w-8 h-8 rounded-[9px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center shadow-[0_4px_14px_rgba(91,69,240,0.4)] flex-none">
          <svg width="16" height="16" viewBox="0 0 100 100" fill="none">
            <rect x="8" y="6" width="84" height="17" rx="4" fill="white"/>
            <rect x="20" y="27" width="60" height="17" rx="4" fill="white" opacity="0.85"/>
            <rect x="32" y="48" width="36" height="17" rx="4" fill="white" opacity="0.7"/>
            <rect x="44" y="69" width="12" height="17" rx="4" fill="white" opacity="0.55"/>
          </svg>
        </div>
        <span className="font-display font-bold text-[20px] text-hi tracking-[-0.5px]">Funnl</span>
      </div>

      {/* User account card */}
      <div className="mx-[14px] mb-5 flex items-center gap-[10px] bg-elevated rounded-xl border border-[rgba(255,255,255,0.05)] px-2 py-2">
        <div className="relative flex-none">
          <div className="w-[34px] h-[34px] rounded-[9px] bg-[linear-gradient(135deg,#FF6B8A,#F5A623)] flex items-center justify-center text-[13px] font-bold text-white">
            {getInitials(user?.email)}
          </div>
          <span className="absolute bottom-[-2px] right-[-2px] w-[11px] h-[11px] rounded-full bg-success border-2 border-elevated"/>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-hi leading-tight truncate">{getUsername(user?.email)}</div>
          <div className="text-[11px] text-low">Funnl user</div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6C6C78" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </div>

      {/* MENU */}
      <div className="px-[22px] pb-2 text-[10.5px] font-bold tracking-[1.2px] text-lower uppercase font-mono">MENU</div>
      <div className="flex flex-col gap-[3px] px-[14px]">
        <NavItem
          to="/"
          label="Dashboard"
          active={isActive('/')}
          icon={
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={iconStroke(isActive('/'))} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 10.2 12 3l9 7.2"/><path d="M5.5 8.8V21h13V8.8"/>
            </svg>
          }
        />
        <NavItem
          to="/contacts"
          label="Contacts"
          active={isActive('/contacts')}
          icon={
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={iconStroke(isActive('/contacts'))} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="3"/>
              <path d="M2.5 20c0-3 2.5-5.5 5.5-5.5S13.5 17 13.5 20"/>
              <circle cx="17" cy="9" r="2.4"/>
              <path d="M15 14.6c2.8.3 5 2.6 5 5.4"/>
            </svg>
          }
        />
        <NavItem
          to="/followups"
          label="Follow-ups"
          active={isActive('/followups')}
          icon={
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={iconStroke(isActive('/followups'))} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
            </svg>
          }
          badge={
            followUpCount > 0 ? (
              <span className="text-[11px] font-bold text-warning bg-[rgba(245,166,35,0.15)] px-[7px] py-[1px] rounded-full">
                {followUpCount}
              </span>
            ) : null
          }
        />
        <NavItem
          to="/ai"
          label="Funnl AI"
          active={isActive('/ai')}
          icon={
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke={iconStroke(isActive('/ai'))} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
            </svg>
          }
          badge={
            <span className="text-[9.5px] font-bold tracking-[0.5px] text-accent bg-[rgba(139,124,255,0.14)] px-1.5 py-0.5 rounded-[5px] font-mono">
              NEW
            </span>
          }
        />
      </div>

      {/* Divider */}
      <div className="h-px bg-[rgba(255,255,255,0.06)] mx-[14px] my-5"/>

      {/* PIPELINE */}
      <div className="px-[22px] pb-[10px] text-[10.5px] font-bold tracking-[1.2px] text-lower uppercase font-mono">PIPELINE</div>
      <div className="flex flex-col gap-0.5 px-[14px]">
        <Link to="/contacts" className="flex items-center gap-[10px] px-3 py-2 rounded-[9px] hover:bg-[rgba(255,255,255,0.03)] transition-colors no-underline">
          <span className="w-2 h-2 rounded-[3px] bg-accent flex-none"/>
          <span className="flex-1 text-[13px] text-mid">Target firms</span>
        </Link>
        <Link to="/contacts" className="flex items-center gap-[10px] px-3 py-2 rounded-[9px] hover:bg-[rgba(255,255,255,0.03)] transition-colors no-underline">
          <span className="w-2 h-2 rounded-[3px] bg-warning-deep flex-none"/>
          <span className="flex-1 text-[13px] text-mid">Recruiters</span>
        </Link>
        <Link to="/contacts" className="flex items-center gap-[10px] px-3 py-2 rounded-[9px] hover:bg-[rgba(255,255,255,0.03)] transition-colors no-underline">
          <span className="w-2 h-2 rounded-[3px] bg-success flex-none"/>
          <span className="flex-1 text-[13px] text-mid">Alumni</span>
        </Link>
      </div>

      {/* Spacer */}
      <div className="flex-1"/>

      {/* Settings + Sign out */}
      <div className="px-[14px] pb-3 flex flex-col gap-0.5">
        <button className="flex items-center gap-3 w-full px-3 py-[10px] rounded-[10px] text-[14px] font-medium text-low hover:text-hi hover:bg-[rgba(255,255,255,0.04)] transition-colors text-left">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 3v2.4M12 18.6V21M4.3 4.3l1.7 1.7M18 18l1.7 1.7M3 12h2.4M18.6 12H21M4.3 19.7 6 18M18 6l1.7-1.7"/>
          </svg>
          <span>Settings</span>
        </button>
        <button
          onClick={() => supabase.auth.signOut()}
          className="flex items-center gap-3 w-full px-3 py-[10px] rounded-[10px] text-[14px] font-medium text-low hover:text-danger hover:bg-[rgba(255,107,138,0.06)] transition-colors text-left"
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          <span>Sign out</span>
        </button>
      </div>

      {/* Funnl AI promo card */}
      <div className="mx-[14px] mb-4 bg-[linear-gradient(160deg,#2A2140,#171227)] border border-[rgba(139,124,255,0.28)] rounded-2xl p-[15px]">
        <div className="flex items-center gap-[7px] mb-[7px]">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="#B4A8FF">
            <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
          </svg>
          <span className="text-[13px] font-bold text-hi">Funnl AI</span>
        </div>
        <p className="text-[11.5px] leading-[1.5] text-[#B0A8C8] mb-3">Ask anything about your network and get instant answers.</p>
        <Link
          to="/ai"
          className="block w-full bg-hi text-[#1A1530] text-center rounded-[9px] py-2 text-[12.5px] font-bold no-underline"
        >
          Try Funnl AI
        </Link>
      </div>

    </div>
  )
}

export default Sidebar
