import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import { track } from '../lib/analytics'

// ── Get today's date in LOCAL timezone — avoids UTC-offset "wrong day" bugs ─
function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Offset today by N days in LOCAL timezone — no toISOString() ──────────────
function getLocalDateOffset(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
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
  return dateStr
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
function FollowUpRow({ interaction, today, isLast, isSaving, snoozeOpen, customDate, onCustomDateChange, onDone, onSnoozeToggle, onSnoozeOption, onSnoozeClose }) {
  const menuRef = useRef(null)

  // Outside-click: toggle button and menu share the same ref boundary so clicking
  // the toggle is never mistaken for an outside click
  useEffect(() => {
    if (!snoozeOpen) return
    function handleMouseDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onSnoozeClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [snoozeOpen, onSnoozeClose])

  const name = interaction.contacts?.name || 'Unknown'
  const style = statusStyle(interaction.follow_up_date, today)
  const snoozeLabel = interaction.follow_up_date > today ? 'Reschedule' : 'Snooze'

  return (
    <div className={`py-[15px] ${!isLast ? 'border-b border-[rgba(255,255,255,0.05)]' : ''}`}>

      {/* Row 1: contact link + status pill */}
      <div className="flex items-center gap-3">
        <Link
          to={`/contacts/${interaction.contact_id}`}
          className="flex items-center gap-3 flex-1 min-w-0 no-underline group"
        >
          <div
            className="w-[42px] h-[42px] rounded-xl flex items-center justify-center text-[14px] font-bold text-white flex-none"
            style={{ background: getAvatarColor(name) }}
          >
            {getInitials(name)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14.5px] font-bold text-hi truncate group-hover:text-accent transition-colors">{name}</p>
            <p className="text-[13px] text-muted truncate">{interaction.type || 'Interaction'}</p>
          </div>
        </Link>
        <span className={`text-[11.5px] font-bold px-[11px] py-[4px] rounded-full flex-none ${style.pill}`}>
          {statusLabel(interaction.follow_up_date, today)}
        </span>
      </div>

      {/* Row 2: action buttons — indented to align under name text */}
      <div className="flex items-center gap-2 mt-2 ml-[54px] flex-wrap">

        {/* Mark Done */}
        <button
          type="button"
          onClick={onDone}
          disabled={isSaving}
          className="flex items-center gap-1.5 text-[12px] font-semibold text-success bg-[rgba(47,212,182,0.08)] border border-[rgba(47,212,182,0.2)] px-3 py-[5px] rounded-[7px] hover:border-[rgba(47,212,182,0.4)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          Done
        </button>

        {/* Snooze/Reschedule toggle + menu — same ref boundary so toggle click is not an outside click */}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={onSnoozeToggle}
            disabled={isSaving}
            aria-expanded={snoozeOpen}
            className="flex items-center gap-1.5 text-[12px] font-semibold text-mid bg-elevated border border-line-3 px-3 py-[5px] rounded-[7px] hover:border-[rgba(255,255,255,0.18)] hover:text-hi transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {snoozeLabel}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d={snoozeOpen ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'}/>
            </svg>
          </button>

          {snoozeOpen && (
            <div className="absolute top-full left-0 mt-1.5 w-[192px] bg-[#1A1A24] border border-[rgba(255,255,255,0.1)] rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-10 p-2 space-y-0.5">
              {[
                { label: 'Tomorrow',  opt: 'tomorrow'   },
                { label: 'In 3 days', opt: 'three_days' },
                { label: 'In 1 week', opt: 'one_week'   },
              ].map(({ label, opt }) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => onSnoozeOption(opt)}
                  disabled={isSaving}
                  className="w-full text-left text-[13px] text-mid px-3 py-[7px] rounded-lg hover:bg-[rgba(255,255,255,0.06)] hover:text-hi transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {label}
                </button>
              ))}
              <div className="border-t border-line-2 pt-2 mt-1 px-1 space-y-1.5">
                <input
                  type="date"
                  value={customDate}
                  onChange={e => onCustomDateChange(e.target.value)}
                  min={getLocalDateOffset(1)}
                  className="w-full bg-input border border-line-3 rounded-lg px-3 py-[7px] text-[12.5px] text-hi outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors"
                />
                <button
                  type="button"
                  onClick={() => onSnoozeOption('custom')}
                  disabled={isSaving || !customDate}
                  className="w-full text-[12.5px] font-semibold text-accent bg-[rgba(139,124,255,0.1)] border border-[rgba(139,124,255,0.22)] rounded-lg px-3 py-[6px] hover:bg-[rgba(139,124,255,0.18)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Confirm
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Log Result — Link carries Router state so ContactDetailPage opens the form and clears this follow-up */}
        <Link
          to={`/contacts/${interaction.contact_id}`}
          state={{ openInteractionForm: true, sourceFollowUpId: interaction.id }}
          className="flex items-center gap-1 text-[12px] font-semibold text-accent bg-[rgba(139,124,255,0.08)] border border-[rgba(139,124,255,0.18)] px-3 py-[5px] rounded-[7px] hover:border-[rgba(139,124,255,0.4)] transition-colors no-underline"
        >
          Log Result
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </Link>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════

function FollowUpsPage() {
  const [interactions, setInteractions] = useState([])
  const [loading, setLoading]           = useState(true)
  const [fetchError, setFetchError]     = useState('')
  const [savingId, setSavingId]         = useState(null)
  const [snoozeOpenId, setSnoozeOpenId] = useState(null)
  const [customDate, setCustomDate]     = useState('')
  const [feedback, setFeedback]         = useState(null)

  const feedbackTimerRef = useRef(null)
  const today = getLocalToday()

  // Cleanup feedback timer on unmount
  useEffect(() => () => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
  }, [])

  // Close snooze menu on Escape key
  useEffect(() => {
    if (!snoozeOpenId) return
    function onKey(e) { if (e.key === 'Escape') setSnoozeOpenId(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snoozeOpenId])

  useEffect(() => { fetchFollowUps() }, [])

  // quiet=true: skip loading screen, leave current rows visible if refetch fails
  async function fetchFollowUps(quiet = false) {
    if (!quiet) { setFetchError(''); setLoading(true) }
    const { data, error } = await supabase
      .from('interactions')
      .select('*, contacts(id, name)')
      .not('follow_up_date', 'is', null)
      .order('follow_up_date', { ascending: true })
    if (!quiet) setLoading(false)
    if (error) {
      if (quiet) {
        showFeedback('error', "Couldn't refresh. Your list may be out of date.")
      } else {
        setFetchError(error.message)
      }
      return
    }
    setInteractions(data || [])
  }

  function showFeedback(type, msg) {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
    setFeedback({ type, msg })
    if (type === 'success') {
      feedbackTimerRef.current = setTimeout(() => setFeedback(null), 3000)
    }
  }

  // Stable close callback — used as dep in FollowUpRow's outside-click useEffect
  const closeSnooze = useCallback(() => setSnoozeOpenId(null), [])

  async function handleDone(interactionId) {
    setSavingId(interactionId)
    try {
      const { data: updated, error } = await supabase
        .from('interactions')
        .update({ follow_up_date: null })
        .eq('id', interactionId)
        .select('id')
        .single()
      if (error || !updated?.id) {
        console.error('[Funnl] Mark done failed:', error?.message)
        showFeedback('error', "Couldn't mark done. Try again.")
        return
      }
      track('followup_completed', { method: 'mark_done' })
      window.dispatchEvent(new Event('funnl:followups-changed'))
      showFeedback('success', 'Follow-up marked done.')
      await fetchFollowUps(true)
    } finally {
      setSavingId(null)
    }
  }

  async function handleSnooze(interactionId, option) {
    const todayStr = getLocalToday()
    let newDate
    if      (option === 'tomorrow')   newDate = getLocalDateOffset(1)
    else if (option === 'three_days') newDate = getLocalDateOffset(3)
    else if (option === 'one_week')   newDate = getLocalDateOffset(7)
    else {
      // 'custom' — validate before touching the database
      if (!customDate || customDate <= todayStr) {
        showFeedback('error', 'Pick a date after today.')
        return
      }
      newDate = customDate
    }
    setSavingId(interactionId)
    try {
      const { data: updated, error } = await supabase
        .from('interactions')
        .update({ follow_up_date: newDate })
        .eq('id', interactionId)
        .select('id')
        .single()
      if (error || !updated?.id) {
        console.error('[Funnl] Snooze failed:', error?.message)
        showFeedback('error', "Couldn't update the date. Try again.")
        return
      }
      setSnoozeOpenId(null)
      setCustomDate('')
      // Format the new date in local time — no toISOString()
      const [y, m, d] = newDate.split('-').map(Number)
      const label = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      showFeedback('success', `Snoozed until ${label}.`)
      track('followup_snoozed', { option })
      window.dispatchEvent(new Event('funnl:followups-changed'))
      await fetchFollowUps(true)
    } finally {
      setSavingId(null)
    }
  }

  // YYYY-MM-DD string comparison is lexicographically correct for ISO dates
  const overdue    = interactions.filter(i => i.follow_up_date < today)
  const todayItems = interactions.filter(i => i.follow_up_date === today)
  const upcoming   = interactions.filter(i => i.follow_up_date > today)

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
          <button onClick={() => fetchFollowUps()} className="text-accent text-sm font-semibold hover:text-tag transition-colors">
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
          Mark conversations done, snooze follow-ups, or log a result directly from this page.
        </p>
      </div>

      {/* Inline feedback banner — success auto-dismisses, error persists until next action */}
      {feedback && (
        <div
          aria-live="polite"
          className={`flex items-center gap-2 mb-5 px-4 py-3 rounded-xl text-[13px] font-medium border ${
            feedback.type === 'success'
              ? 'text-success bg-[rgba(47,212,182,0.1)] border-[rgba(47,212,182,0.22)]'
              : 'text-danger bg-[rgba(255,107,138,0.08)] border-[rgba(255,107,138,0.2)]'
          }`}
        >
          {feedback.type === 'success' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
            </svg>
          )}
          {feedback.msg}
        </div>
      )}

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
            <FollowUpRow
              key={item.id}
              interaction={item}
              today={today}
              isLast={i === overdue.length - 1}
              isSaving={savingId === item.id}
              snoozeOpen={snoozeOpenId === item.id}
              customDate={snoozeOpenId === item.id ? customDate : ''}
              onCustomDateChange={setCustomDate}
              onDone={() => handleDone(item.id)}
              onSnoozeToggle={() => setSnoozeOpenId(v => v === item.id ? null : item.id)}
              onSnoozeOption={(opt) => handleSnooze(item.id, opt)}
              onSnoozeClose={closeSnooze}
            />
          ))}
          <div className="pb-1"/>
        </div>
      )}

      {/* Today */}
      {todayItems.length > 0 && (
        <div className="bg-card border border-line-2 rounded-2xl px-5 mb-4">
          <div className="pt-5 pb-2">
            <GroupHeading dot="#FFB84D" label="Today" count={todayItems.length}/>
          </div>
          {todayItems.map((item, i) => (
            <FollowUpRow
              key={item.id}
              interaction={item}
              today={today}
              isLast={i === todayItems.length - 1}
              isSaving={savingId === item.id}
              snoozeOpen={snoozeOpenId === item.id}
              customDate={snoozeOpenId === item.id ? customDate : ''}
              onCustomDateChange={setCustomDate}
              onDone={() => handleDone(item.id)}
              onSnoozeToggle={() => setSnoozeOpenId(v => v === item.id ? null : item.id)}
              onSnoozeOption={(opt) => handleSnooze(item.id, opt)}
              onSnoozeClose={closeSnooze}
            />
          ))}
          <div className="pb-1"/>
        </div>
      )}

      {/* Upcoming */}
      {upcoming.length > 0 && (
        <div className="bg-card border border-line-2 rounded-2xl px-5 mb-4">
          <div className="pt-5 pb-2">
            <GroupHeading dot="#8B7CFF" label="Upcoming" count={upcoming.length}/>
          </div>
          {upcoming.map((item, i) => (
            <FollowUpRow
              key={item.id}
              interaction={item}
              today={today}
              isLast={i === upcoming.length - 1}
              isSaving={savingId === item.id}
              snoozeOpen={snoozeOpenId === item.id}
              customDate={snoozeOpenId === item.id ? customDate : ''}
              onCustomDateChange={setCustomDate}
              onDone={() => handleDone(item.id)}
              onSnoozeToggle={() => setSnoozeOpenId(v => v === item.id ? null : item.id)}
              onSnoozeOption={(opt) => handleSnooze(item.id, opt)}
              onSnoozeClose={closeSnooze}
            />
          ))}
          <div className="pb-1"/>
        </div>
      )}

    </div>
  )
}

export default FollowUpsPage
