import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'

// ── Get today's date in LOCAL timezone — avoids UTC-offset "wrong day" bugs ─
function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Status label: how many days overdue, or "In N days" for upcoming ────────
function statusLabel(dateStr, today) {
  if (dateStr === today) return 'Due today'
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const days = Math.round(Math.abs(date - now) / 86400000)
  if (dateStr < today) return days === 1 ? '1 day overdue' : `${days} days overdue`
  if (days === 1) return 'Tomorrow'
  if (days < 7) return `In ${days} days`
  return dateStr  // show raw date for far-future items
}

function statusStyle(dateStr, today) {
  if (dateStr < today) return { pill: 'text-danger bg-[rgba(255,107,138,0.13)] border border-[rgba(255,107,138,0.25)]', dot: '#FF6B8A', label: 'OVERDUE' }
  if (dateStr === today) return { pill: 'text-warning bg-[rgba(245,166,35,0.14)] border border-[rgba(245,166,35,0.25)]', dot: '#FFB84D', label: 'TODAY' }
  return { pill: 'text-mid bg-[rgba(255,255,255,0.06)] border border-[rgba(255,255,255,0.1)]', dot: '#8B7CFF', label: 'UPCOMING' }
}

// ── Group heading component ────────────────────────────────────────────────
function GroupHeading({ dot, label, count }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="w-2 h-2 rounded-full flex-none" style={{ background: dot }}/>
      <span className="text-[12px] font-bold tracking-[0.5px] uppercase font-mono" style={{ color: dot }}>{label}</span>
      <span className="text-[12px] text-low">· {count}</span>
    </div>
  )
}

// ── Interaction row ────────────────────────────────────────────────────────
function FollowUpRow({ interaction, today, isLast }) {
  const name = interaction.contacts?.name || 'Unknown'
  const style = statusStyle(interaction.follow_up_date, today)
  return (
    <Link
      to={`/contacts/${interaction.contact_id}`}
      className={`flex items-center gap-3 py-[15px] no-underline ${!isLast ? 'border-b border-[rgba(255,255,255,0.05)]' : ''}`}
    >
      <div
        className="w-[42px] h-[42px] rounded-xl flex items-center justify-center text-[14px] font-bold text-white flex-none"
        style={{ background: getAvatarColor(name) }}
      >
        {getInitials(name)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[14.5px] font-bold text-hi truncate">{name}</p>
        <p className="text-[13px] text-muted truncate">{interaction.type || 'Interaction'}</p>
      </div>
      <span className={`text-[11.5px] font-bold px-[11px] py-[4px] rounded-full flex-none ${style.pill}`}>
        {statusLabel(interaction.follow_up_date, today)}
      </span>
    </Link>
  )
}

// ══════════════════════════════════════════════════════════════════════════════

function FollowUpsPage() {
  const [interactions, setInteractions] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')

  const today = getLocalToday()

  useEffect(() => { fetchFollowUps() }, [])

  async function fetchFollowUps() {
    setFetchError('')
    setLoading(true)
    const { data, error } = await supabase
      .from('interactions')
      .select('*, contacts(id, name)')
      .not('follow_up_date', 'is', null)
      .order('follow_up_date', { ascending: true })

    if (error) {
      setFetchError(error.message)
    } else {
      setInteractions(data || [])
    }
    setLoading(false)
  }

  // YYYY-MM-DD string comparison is lexicographically correct for ISO dates
  const overdue  = interactions.filter(i => i.follow_up_date < today)
  const todayItems = interactions.filter(i => i.follow_up_date === today)
  const upcoming = interactions.filter(i => i.follow_up_date > today)

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6 md:p-12">
        <div className="text-center max-w-sm">
          <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-[rgba(255,107,138,0.1)] border border-[rgba(255,107,138,0.2)] flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
            </svg>
          </div>
          <p className="text-hi font-semibold mb-2">Couldn't load your follow-ups</p>
          <p className="text-muted text-sm mb-5">Check your connection and try again.</p>
          <button onClick={fetchFollowUps} className="text-accent text-sm font-semibold hover:text-tag transition-colors">
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface px-4 py-6 md:px-9 md:py-8">

      {/* Header */}
      <div className="mb-6">
        <h1 className="font-display font-bold text-[28px] text-hi tracking-[-0.5px]">Follow-ups</h1>
        <p className="text-[14.5px] text-muted mt-1">Stay on top of your outreach — nothing slips through.</p>
      </div>

      {/* Usage hint */}
      <div className="flex items-start gap-3 bg-[rgba(139,124,255,0.06)] border border-[rgba(139,124,255,0.2)] rounded-xl px-4 py-3 mb-7">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B4A8FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none mt-0.5">
          <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
        </svg>
        <p className="text-[13px] text-muted leading-relaxed">
          Click any row to open the contact and update or clear the follow-up date from there.
        </p>
      </div>

      {/* Empty state */}
      {interactions.length === 0 && (
        <div className="text-center py-20">
          <div className="w-[64px] h-[64px] mx-auto mb-5 rounded-[18px] bg-[rgba(108,92,255,0.1)] border border-[rgba(139,124,255,0.2)] flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
            </svg>
          </div>
          <p className="text-[16px] font-bold text-hi mb-2">No follow-up dates set</p>
          <p className="text-[14px] text-muted max-w-xs mx-auto">
            When you log an interaction, add a follow-up date — it'll appear here so you never forget.
          </p>
        </div>
      )}

      {/* Overdue */}
      {overdue.length > 0 && (
        <div className="bg-card border border-[rgba(255,107,138,0.18)] rounded-2xl px-5 mb-4">
          <div className="pt-5 pb-2">
            <GroupHeading dot="#FF6B8A" label="Overdue" count={overdue.length}/>
          </div>
          {overdue.map((item, i) => (
            <FollowUpRow key={item.id} interaction={item} today={today} isLast={i === overdue.length - 1}/>
          ))}
          <div className="pb-1"/>
        </div>
      )}

      {/* Today */}
      {todayItems.length > 0 && (
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl px-5 mb-4">
          <div className="pt-5 pb-2">
            <GroupHeading dot="#FFB84D" label="Today" count={todayItems.length}/>
          </div>
          {todayItems.map((item, i) => (
            <FollowUpRow key={item.id} interaction={item} today={today} isLast={i === todayItems.length - 1}/>
          ))}
          <div className="pb-1"/>
        </div>
      )}

      {/* Upcoming */}
      {upcoming.length > 0 && (
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl px-5 mb-4">
          <div className="pt-5 pb-2">
            <GroupHeading dot="#8B7CFF" label="Upcoming" count={upcoming.length}/>
          </div>
          {upcoming.map((item, i) => (
            <FollowUpRow key={item.id} interaction={item} today={today} isLast={i === upcoming.length - 1}/>
          ))}
          <div className="pb-1"/>
        </div>
      )}

    </div>
  )
}

export default FollowUpsPage
