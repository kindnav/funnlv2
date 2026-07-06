import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AddContactDrawer from '../components/AddContactDrawer'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'

// Local date string (YYYY-MM-DD) — avoids UTC-offset "wrong day" bugs
function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function followUpStatus(dateStr) {
  const today = getLocalToday()
  return dateStr === today
    ? { label: 'Today', cls: 'text-warning bg-[rgba(245,166,35,0.14)] border border-[rgba(245,166,35,0.3)]' }
    : { label: 'Overdue', cls: 'text-danger bg-[rgba(255,107,138,0.13)] border border-[rgba(255,107,138,0.25)]' }
}

function DashboardPage() {
  const [contactCount, setContactCount] = useState(0)
  const [interactionCount, setInteractionCount] = useState(0)
  const [newContactsWeek, setNewContactsWeek] = useState(0)
  const [newInteractionsWeek, setNewInteractionsWeek] = useState(0)
  const [dueToday, setDueToday] = useState(0)
  const [followUps, setFollowUps] = useState([])
  const [recentContacts, setRecentContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')
  const [showDrawer, setShowDrawer] = useState(false)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setFetchError('')
    setLoading(true)
    const today = getLocalToday()
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7)
    const weekAgoStr = weekAgo.toISOString()

    const [
      { count: contacts, error: e1 },
      { count: interactions, error: e2 },
      { count: newContacts, error: e3 },
      { count: newInteractions, error: e4 },
      { count: todayDue, error: e5 },
      { data: followUpsData, error: e6 },
      { data: recentData, error: e7 },
    ] = await Promise.all([
      supabase.from('contacts').select('*', { count: 'exact', head: true }),
      supabase.from('interactions').select('*', { count: 'exact', head: true }),
      supabase.from('contacts').select('*', { count: 'exact', head: true }).gte('created_at', weekAgoStr),
      supabase.from('interactions').select('*', { count: 'exact', head: true }).gte('created_at', weekAgoStr),
      supabase.from('interactions').select('*', { count: 'exact', head: true }).eq('follow_up_date', today),
      supabase.from('interactions').select('*, contacts(id, name)').not('follow_up_date', 'is', null).lte('follow_up_date', today).order('follow_up_date', { ascending: true }),
      supabase.from('contacts').select('*').order('created_at', { ascending: false }).limit(5),
    ])

    const queryError = e1 || e2 || e3 || e4 || e5 || e6 || e7
    if (queryError) {
      setFetchError(queryError.message)
      setLoading(false)
      return
    }

    setContactCount(contacts || 0)
    setInteractionCount(interactions || 0)
    setNewContactsWeek(newContacts || 0)
    setNewInteractionsWeek(newInteractions || 0)
    setDueToday(todayDue || 0)
    setFollowUps(followUpsData || [])
    setRecentContacts(recentData || [])
    setLoading(false)
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-muted text-sm">Loading…</p>
      </div>
    )
  }

  // ── Error — show a clear message instead of misleading zeros/empty state ──
  if (fetchError) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6 md:p-12">
        <div className="text-center max-w-sm">
          <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-[rgba(255,107,138,0.1)] border border-[rgba(255,107,138,0.2)] flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
            </svg>
          </div>
          <p className="text-hi font-semibold mb-2">Couldn't load your dashboard</p>
          <p className="text-muted text-sm mb-5">Check your connection and try again.</p>
          <button
            onClick={fetchAll}
            className="text-accent text-sm font-semibold hover:text-tag transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  // ── Empty state: brand-new user with no contacts ──────────────────────────
  if (contactCount === 0) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6 md:p-12">
        <div className="text-center max-w-sm">
          <div className="w-[72px] h-[72px] mx-auto mb-6 rounded-[20px] bg-[rgba(108,92,255,0.12)] border border-[rgba(139,124,255,0.25)] flex items-center justify-center">
            <svg width="32" height="32" viewBox="0 0 100 100" fill="none">
              <rect x="8" y="6" width="84" height="17" rx="4" fill="#C7BFFF"/>
              <rect x="20" y="27" width="60" height="17" rx="4" fill="#9D8FFF"/>
              <rect x="32" y="48" width="36" height="17" rx="4" fill="#8B7CFF"/>
              <rect x="44" y="69" width="12" height="17" rx="4" fill="#5B45F0"/>
            </svg>
          </div>
          <h1 className="font-display text-[20px] font-bold text-hi mb-2">Start building your network</h1>
          <p className="text-[14px] leading-relaxed text-muted mb-6">
            Add your first contact to start tracking coffee chats, follow-ups, and warm intros in one place.
          </p>
          <button
            onClick={() => setShowDrawer(true)}
            className="inline-flex items-center gap-2 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-5 py-3 rounded-xl shadow-[0_8px_22px_rgba(91,69,240,0.4)] hover:opacity-90 transition-opacity"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Add your first contact
          </button>
        </div>

        {showDrawer && (
          <>
            <div className="fixed inset-0 md:left-[248px] bg-[rgba(6,6,8,0.55)] z-40" onClick={() => setShowDrawer(false)} style={{ animation: 'fade-in 0.2s ease-out' }}/>
            <AddContactDrawer onClose={() => setShowDrawer(false)} onSuccess={() => { setShowDrawer(false); fetchAll() }}/>
          </>
        )}
      </div>
    )
  }

  // ── Full dashboard ────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-surface px-4 py-6 md:px-9 md:py-8">

      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="font-display font-bold text-[28px] text-hi tracking-[-0.5px]">Dashboard</h1>
          <p className="text-[14.5px] text-muted mt-1">Here's what's on your radar.</p>
        </div>
        <button
          onClick={() => setShowDrawer(true)}
          className="flex items-center gap-2 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-[18px] py-[11px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity flex-none"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Add contact
        </button>
      </div>

      {/* Stat cards — all numbers from real data */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">

        {/* Contacts */}
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5">
          <div className="flex items-center gap-[10px] mb-[14px]">
            <div className="w-[34px] h-[34px] rounded-[9px] bg-[rgba(108,92,255,0.15)] flex items-center justify-center">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="3"/><path d="M2.5 20c0-3 2.5-5.5 5.5-5.5S13.5 17 13.5 20"/><circle cx="17" cy="9" r="2.4"/><path d="M15 14.6c2.8.3 5 2.6 5 5.4"/>
              </svg>
            </div>
            <span className="text-[13.5px] text-muted font-medium">Contacts</span>
          </div>
          <p className="font-display text-[36px] font-bold text-hi leading-none mb-1.5">{contactCount}</p>
          {newContactsWeek > 0 && (
            <p className="text-[12.5px] font-semibold text-success">+{newContactsWeek} this week</p>
          )}
        </div>

        {/* Interactions */}
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5">
          <div className="flex items-center gap-[10px] mb-[14px]">
            <div className="w-[34px] h-[34px] rounded-[9px] bg-[rgba(47,212,182,0.14)] flex items-center justify-center">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5h16v10H8l-4 4z"/>
              </svg>
            </div>
            <span className="text-[13.5px] text-muted font-medium">Interactions</span>
          </div>
          <p className="font-display text-[36px] font-bold text-hi leading-none mb-1.5">{interactionCount}</p>
          {newInteractionsWeek > 0 && (
            <p className="text-[12.5px] font-semibold text-success">+{newInteractionsWeek} this week</p>
          )}
        </div>

        {/* Follow-ups due */}
        <div className={`border rounded-2xl p-5 ${followUps.length > 0 ? 'bg-[rgba(245,166,35,0.06)] border-[rgba(245,166,35,0.22)]' : 'bg-card border-[rgba(255,255,255,0.07)]'}`}>
          <div className="flex items-center gap-[10px] mb-[14px]">
            <div className="w-[34px] h-[34px] rounded-[9px] bg-[rgba(245,166,35,0.14)] flex items-center justify-center">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#FFB84D" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
              </svg>
            </div>
            <span className="text-[13.5px] text-muted font-medium">Follow-ups due</span>
          </div>
          <p className={`font-display text-[36px] font-bold leading-none mb-1.5 ${followUps.length > 0 ? 'text-warning' : 'text-hi'}`}>
            {followUps.length}
          </p>
          {dueToday > 0 && (
            <p className="text-[12.5px] font-semibold text-warning">{dueToday} due today</p>
          )}
        </div>
      </div>

      {/* Funnl AI teaser banner — honest coming-soon, visually matching the design */}
      <div className="flex items-center justify-between gap-4 bg-[linear-gradient(120deg,rgba(43,33,64,0.9),rgba(18,17,26,0.9))] border border-[rgba(139,124,255,0.3)] rounded-2xl px-5 py-4 mb-6 shadow-[0_0_40px_rgba(108,92,255,0.08)]">
        <div className="flex items-center gap-[14px]">
          <div className="w-10 h-10 rounded-[11px] bg-[rgba(139,124,255,0.18)] flex items-center justify-center flex-none">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#B4A8FF">
              <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
            </svg>
          </div>
          <div>
            <p className="text-[14px] font-bold text-hi">Funnl AI is live</p>
            <p className="text-[13px] text-[#B0A8C8]">Ask anything about your network — who to reach, who's gone cold. Available with Pro.</p>
          </div>
        </div>
        <span className="font-mono text-[10.5px] font-bold text-accent bg-[rgba(139,124,255,0.14)] px-2 py-1 rounded-[5px] flex-none">PRO</span>
      </div>

      {/* Two-column body: follow-ups (left) + recent contacts (right) */}
      <div className="grid grid-cols-1 md:grid-cols-[1.25fr_1fr] gap-5">

        {/* Follow-ups due */}
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[15px] font-bold text-hi">Follow-ups due</h3>
          </div>
          {followUps.length === 0 ? (
            <div className="text-center py-6">
              <div className="w-10 h-10 mx-auto mb-3 rounded-xl bg-[rgba(47,212,182,0.12)] border border-[rgba(47,212,182,0.25)] flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12l4.5 4.5L19 7"/>
                </svg>
              </div>
              <p className="text-[13px] font-medium text-hi mb-0.5">You're all caught up</p>
              <p className="text-[12px] text-low">No follow-ups due right now.</p>
            </div>
          ) : (
            <div className="space-y-0">
              {followUps.map((interaction, i) => {
                const name = interaction.contacts?.name || 'Unknown'
                const status = followUpStatus(interaction.follow_up_date)
                return (
                  <Link
                    key={interaction.id}
                    to={`/contacts/${interaction.contact_id}`}
                    className={`flex items-center gap-3 py-[13px] no-underline ${i < followUps.length - 1 ? 'border-b border-[rgba(255,255,255,0.05)]' : ''}`}
                  >
                    <div className="w-[38px] h-[38px] rounded-[11px] flex items-center justify-center text-[13px] font-bold text-white flex-none" style={{ background: getAvatarColor(name) }}>
                      {getInitials(name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13.5px] font-semibold text-hi truncate">{name}</p>
                      <p className="text-[12.5px] text-muted truncate">{interaction.type}</p>
                    </div>
                    <span className={`text-[11px] font-bold px-[9px] py-[3px] rounded-full flex-none ${status.cls}`}>
                      {status.label}
                    </span>
                  </Link>
                )
              })}
            </div>
          )}
        </div>

        {/* Recent contacts */}
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[15px] font-bold text-hi">Recent contacts</h3>
            <Link to="/contacts" className="text-[12.5px] font-semibold text-accent hover:text-tag transition-colors no-underline">
              View all →
            </Link>
          </div>
          <div className="space-y-0">
            {recentContacts.map((contact, i) => (
              <Link
                key={contact.id}
                to={`/contacts/${contact.id}`}
                className={`flex items-center gap-3 py-[11px] no-underline ${i < recentContacts.length - 1 ? 'border-b border-[rgba(255,255,255,0.05)]' : ''}`}
              >
                <div className="w-[36px] h-[36px] rounded-[10px] flex items-center justify-center text-[12.5px] font-bold text-white flex-none" style={{ background: getAvatarColor(contact.name) }}>
                  {getInitials(contact.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold text-hi truncate">{contact.name}</p>
                  {(contact.role || contact.company) && (
                    <p className="text-[12px] text-muted truncate">
                      {[contact.role, contact.company].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>

      </div>

      {/* Add contact drawer + backdrop */}
      {showDrawer && (
        <>
          <div className="fixed inset-0 md:left-[248px] bg-[rgba(6,6,8,0.55)] z-40" onClick={() => setShowDrawer(false)} style={{ animation: 'fade-in 0.2s ease-out' }}/>
          <AddContactDrawer onClose={() => setShowDrawer(false)} onSuccess={() => { setShowDrawer(false); fetchAll() }}/>
        </>
      )}

    </div>
  )
}

export default DashboardPage
