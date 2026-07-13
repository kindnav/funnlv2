import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'

function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Defined outside BottomNav to avoid React remount-on-render issues
function TabItem({ to, label, active, children }) {
  return (
    <Link
      to={to}
      className={`flex-1 flex flex-col items-center justify-center gap-[3px] py-3 no-underline ${
        active ? 'text-accent' : 'text-low'
      }`}
    >
      {children}
      <span className={`text-[10px] font-semibold font-mono leading-none ${active ? 'text-accent' : 'text-low'}`}>
        {label}
      </span>
    </Link>
  )
}

function BottomNav() {
  const location = useLocation()
  const [followUpCount, setFollowUpCount] = useState(0)

  const fetchCount = useCallback(async () => {
    const { count } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .not('follow_up_date', 'is', null)
      .lte('follow_up_date', getLocalToday())
    setFollowUpCount(count || 0)
  }, [])

  useEffect(() => { fetchCount() }, [fetchCount])

  // Refresh badge whenever a follow-up action completes on FollowUpsPage
  useEffect(() => {
    const handler = () => fetchCount()
    window.addEventListener('funnl:followups-changed', handler)
    return () => window.removeEventListener('funnl:followups-changed', handler)
  }, [fetchCount])

  function isActive(path) {
    if (path === '/') return location.pathname === '/'
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  function stroke(path) {
    return isActive(path) ? '#8B7CFF' : '#6C6C78'
  }

  return (
    <div
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex bg-sidebar border-t border-[rgba(255,255,255,0.07)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <TabItem to="/" label="Home" active={isActive('/')}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke('/')} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 10.2 12 3l9 7.2"/><path d="M5.5 8.8V21h13V8.8"/>
        </svg>
      </TabItem>

      <TabItem to="/contacts" label="Contacts" active={isActive('/contacts')}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke('/contacts')} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="3"/>
          <path d="M2.5 20c0-3 2.5-5.5 5.5-5.5S13.5 17 13.5 20"/>
          <circle cx="17" cy="9" r="2.4"/>
          <path d="M15 14.6c2.8.3 5 2.6 5 5.4"/>
        </svg>
      </TabItem>

      <TabItem to="/followups" label="Follow-ups" active={isActive('/followups')}>
        <div className="relative">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke('/followups')} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
          </svg>
          {followUpCount > 0 && (
            <span className="absolute -top-1 -right-2 min-w-[16px] h-[16px] rounded-full bg-warning text-[9px] font-bold text-[#0B0B0E] flex items-center justify-center px-[3px] leading-none">
              {followUpCount > 9 ? '9+' : followUpCount}
            </span>
          )}
        </div>
      </TabItem>

      <TabItem to="/ai" label="Funnl AI" active={isActive('/ai')}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke('/ai')} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
        </svg>
      </TabItem>
    </div>
  )
}

export default BottomNav
