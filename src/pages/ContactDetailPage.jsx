import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import { track } from '../lib/analytics'
import { CONTACT_AI_ENABLED, snoozeOptionToDate } from '../lib/contactDirectoryUtils'
import { effectiveOutreachStatus } from '../lib/contactFormUtils'
import { typeChangeFields, followUpDateChanged, shouldFireOutreachChangeOnEdit } from '../lib/interactionFormUtils'
import { clearCompletionFields } from '../lib/followUpUtils'
import { completeFollowUp, snoozeFollowUp as snoozeFollowUpAction } from '../lib/followUpActions'
import TopBar from '../components/TopBar'
import AddContactDrawer from '../components/AddContactDrawer'
import LogInteractionSheet from '../components/LogInteractionSheet'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getLocalDateOffset(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function relativeDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const days = Math.round((now - date) / 86400000)
  if (days < 0) { const n = Math.abs(days); return n === 1 ? 'Tomorrow' : `In ${n} days` }
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
  const months = Math.floor(days / 30)
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`
  const years = Math.floor(days / 365)
  return years === 1 ? '1 year ago' : `${years} years ago`
}

function formatFollowUpLabel(dateStr, today) {
  if (!dateStr) return null
  if (dateStr === today) return 'Today'
  const cmp = dateStr.localeCompare(today)
  const label = relativeDate(dateStr)
  return cmp < 0 ? `${label} (overdue)` : label
}

// ── Interaction type colors (named constants — no periwinkle) ──────────────────

const IC_COFFEE  = { bg: 'rgba(199,169,107,0.15)', stroke: '#C7A96B' }      // gold tint
const IC_EMAIL   = { bg: 'rgba(255,68,35,0.12)',   stroke: 'var(--color-ember)' } // ember tint
const IC_EVENT   = { bg: 'rgba(47,212,182,0.12)',  stroke: 'var(--color-success)' } // success tint
const IC_CALL    = { bg: 'rgba(140,133,122,0.12)', stroke: '#8C857A' }  // neutral
const IC_MESSAGE = { bg: 'rgba(140,133,122,0.12)', stroke: '#8C857A' }  // neutral
const IC_OTHER   = { bg: 'rgba(140,133,122,0.12)', stroke: '#8C857A' }      // neutral

const TYPE_STYLES = {
  'Coffee chat': IC_COFFEE,
  'Email':       IC_EMAIL,
  'Event':       IC_EVENT,
  'Call':        IC_CALL,
  'Message':     IC_MESSAGE,
  'Other':       IC_OTHER,
}
function typeStyle(t) { return TYPE_STYLES[t] || IC_OTHER }

function TypeIcon({ type, color }) {
  const p = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }
  if (type === 'Coffee chat') return <svg {...p}><path d="M4 9h16v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9z"/><path d="M18 9h2a2 2 0 0 1 0 4h-2"/><path d="M7 3v2M12 3v2M17 3v2"/></svg>
  if (type === 'Email')       return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/></svg>
  if (type === 'Event')       return <svg {...p}><path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>
  if (type === 'Call')        return <svg {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.8 19.8 0 0 1 1.61 3.41 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.57a16 16 0 0 0 6.07 6.07l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
  if (type === 'Message')     return <svg {...p}><path d="M4 5h16v10H8l-4 4z"/></svg>
  return <svg {...p}><circle cx="12" cy="12" r="4" fill={color} stroke="none"/></svg>
}

// ── Shared form styles ────────────────────────────────────────────────────────

const iCls = 'w-full bg-input border border-line-3 rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-lower outline-none focus:border-[rgba(255,68,35,0.4)] transition-colors'
const lCls = 'mb-[7px] block text-[12.5px] font-semibold text-mid'
const sCls = `${iCls} cursor-pointer`
const TYPE_OPTIONS = ['Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other']

const OUTREACH_STATUS_LABELS = {
  'awaiting_response': 'Awaiting response',
  'responded':         'Responded',
  'meeting_booked':    'Meeting booked',
  'no_response':       'No response',
  'declined':          'Declined',
}
const OUTREACH_STATUS_STYLES = {
  'awaiting_response': { text: 'var(--color-warning)',  bg: 'rgba(199,169,107,0.12)', border: 'rgba(199,169,107,0.25)' },
  'responded':         { text: 'var(--color-success)',  bg: 'rgba(47,212,182,0.12)',  border: 'rgba(47,212,182,0.2)'  },
  'meeting_booked':    { text: 'var(--color-success)',  bg: 'rgba(47,212,182,0.12)',  border: 'rgba(47,212,182,0.2)'  },
  'no_response':       { text: 'var(--color-muted)',    bg: 'var(--color-elevated)',  border: 'var(--color-line-2)'   },
  'declined':          { text: 'var(--color-danger)',   bg: 'rgba(194,51,77,0.1)',    border: 'rgba(194,51,77,0.2)'   },
}
function OutreachStatusBadge({ status }) {
  const s = OUTREACH_STATUS_STYLES[status]
  if (!s) return null
  return (
    <span className="inline-block text-[11px] font-mono font-semibold px-2 py-[3px] rounded-full border"
      style={{ color: s.text, background: s.bg, borderColor: s.border }}>
      {OUTREACH_STATUS_LABELS[status] || status}
    </span>
  )
}

// ── Snooze dropdown ───────────────────────────────────────────────────────────

function SnoozeMenu({ onSnooze, onClose, saving, error }) {
  const ref = useRef(null)
  const [customDate, setCustomDate] = useState('')

  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose() }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])

  const presets = [
    { label: 'Tomorrow', option: 'tomorrow'   },
    { label: '3 days',   option: 'three_days' },
    { label: '1 week',   option: 'one_week'   },
  ]

  const minDate = getLocalDateOffset(1)

  return (
    <div ref={ref}
      className="absolute left-0 top-full mt-1 z-20 min-w-[164px] rounded-xl border border-line-3 shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
      style={{ background: 'var(--color-card)' }}>
      <div className="p-1">
        {presets.map(o => (
          <button key={o.option} onClick={() => onSnooze(o.option)}
            disabled={saving}
            className="w-full text-left text-[12.5px] font-medium text-hi px-3 py-[9px] rounded-lg hover:bg-elevated transition-colors block disabled:opacity-40 disabled:cursor-not-allowed">
            {o.label}
          </button>
        ))}
      </div>
      <div className="border-t border-line-2 px-3 py-2.5 space-y-2">
        <input
          type="date"
          value={customDate}
          min={minDate}
          disabled={saving}
          onChange={e => setCustomDate(e.target.value)}
          className="w-full bg-input border border-line-3 rounded-lg px-3 py-[7px] text-[12.5px] text-hi outline-none focus:border-[rgba(255,68,35,0.4)] transition-colors disabled:opacity-40"
        />
        <button
          type="button"
          onClick={() => customDate && onSnooze('custom', customDate)}
          disabled={!customDate || saving}
          className="w-full text-[12.5px] font-semibold text-mid border border-line-2 rounded-lg px-3 py-[6px] hover:text-hi hover:border-line-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'var(--color-elevated)' }}
        >
          {saving ? 'Saving…' : 'Set custom date'}
        </button>
      </div>
      {error && (
        <div className="px-3 pb-2.5 text-[11.5px] font-medium" style={{ color: 'var(--color-danger)' }}>
          {error}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════

function ContactDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()

  const [contact, setContact] = useState(null)
  const [interactions, setInteractions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [editDrawerOpen, setEditDrawerOpen] = useState(false)

  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [type, setType] = useState('Coffee chat')
  const [interactionDate, setInteractionDate] = useState(getLocalToday)
  const [notes, setNotes] = useState('')
  const [followUpDate, setFollowUpDate] = useState('')
  const [outreachStatus, setOutreachStatus] = useState('')
  const [trackOutreach, setTrackOutreach] = useState(false)
  const [loggedMsg, setLoggedMsg] = useState(false)
  const [loggedWarning, setLoggedWarning] = useState('')

  const [editingInteractionId, setEditingInteractionId] = useState(null)
  const [interactionEditForm, setInteractionEditForm] = useState({})
  const [savingInteraction, setSavingInteraction] = useState(false)
  const [interactionSaveError, setInteractionSaveError] = useState('')
  const [deletingInteractionId, setDeletingInteractionId] = useState(null)
  const [interactionsError, setInteractionsError] = useState('')

  // Follow-up action state
  const [doneLoading, setDoneLoading]   = useState(false)
  const [doneError, setDoneError]       = useState('')
  const [snoozeLoading, setSnoozeLoading] = useState(false)
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)
  const [snoozeError, setSnoozeError] = useState('')

  const interactionFormRef   = useRef(null)
  const followUpDateInputRef = useRef(null)
  const focusFollowUpRef     = useRef(false)
  const sourceFollowUpIdRef  = useRef(null)
  const loggedWarningTimerRef = useRef(null)
  // Ref to the Log interaction button — receives focus when the mobile sheet closes.
  const logCTARef            = useRef(null)
  // Tracks whether focus was on a mobile trigger before the sheet opened.
  const sheetPrevFocusRef    = useRef(null)

  useEffect(() => () => {
    if (loggedWarningTimerRef.current) clearTimeout(loggedWarningTimerRef.current)
  }, [])

  // Capture/restore focus for the mobile bottom sheet.
  useEffect(() => {
    if (showForm) {
      sheetPrevFocusRef.current = document.activeElement
    } else if (sheetPrevFocusRef.current) {
      const el = sheetPrevFocusRef.current
      sheetPrevFocusRef.current = null
      if (window.innerWidth < 768) setTimeout(() => el?.focus(), 0)
    }
  }, [showForm])

  // Explicit type-change handler — used by both the desktop form and mobile sheet.
  // Resets outreach state on any actual type change; no-ops for same-type reselection.
  function handleTypeChange(newType) {
    const fields = typeChangeFields(type, newType)
    if (fields) {
      setTrackOutreach(false)
      setOutreachStatus('')
    }
    setType(newType)
  }

  const fetchContact = useCallback(async () => {
    const { data, error } = await supabase.from('contacts').select('*').eq('id', id).single()
    if (error) setError(error.message); else setContact(data)
    setLoading(false)
  }, [id])

  const fetchInteractions = useCallback(async () => {
    const { data, error } = await supabase
      .from('interactions').select('*').eq('contact_id', id)
      .order('interaction_date', { ascending: false })
    if (error) {
      setInteractionsError("Couldn't load interactions. Refresh to try again.")
    } else {
      setInteractionsError('')
      setInteractions(data)
    }
  }, [id])

  useEffect(() => {
    fetchContact()
    fetchInteractions()
  }, [fetchContact, fetchInteractions])

  useEffect(() => {
    if (location.state?.openInteractionForm) {
      if (location.state.sourceFollowUpId) {
        sourceFollowUpIdRef.current = location.state.sourceFollowUpId
      }
      setShowForm(true)
      navigate(location.pathname, { replace: true, state: {} })
    } else if (location.state?.openFollowUpForm) {
      focusFollowUpRef.current = true
      setShowForm(true)
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location.state, location.pathname, navigate])

  useEffect(() => {
    if (showForm && !loading) {
      interactionFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      if (focusFollowUpRef.current) {
        focusFollowUpRef.current = false
        setTimeout(() => followUpDateInputRef.current?.focus(), 300)
      }
    }
  }, [showForm, loading])

  async function handleDelete() {
    const { error } = await supabase.from('contacts').delete().eq('id', id)
    if (error) { setError(error.message); return }
    navigate('/contacts')
  }

  // ── Follow-up Done / Snooze ───────────────────────────────────────────────

  async function handleDoneFollowUp(interactionId) {
    const target = interactions.find(i => i.id === interactionId)
    if (!target) return
    setDoneLoading(true)
    try {
      const result = await completeFollowUp(target, {
        client: supabase,
        track,
        dispatch: () => window.dispatchEvent(new Event('funnl:followups-changed')),
      })
      if (!result.ok) {
        setDoneError(result.errorMessage)
        return
      }
      setSnoozeMenuOpen(false)
      setDoneError('')
      fetchInteractions()
    } finally {
      setDoneLoading(false)
    }
  }

  // option: 'tomorrow' | 'three_days' | 'one_week' | 'custom'
  // customDate: YYYY-MM-DD string (only when option === 'custom')
  async function handleSnoozeFollowUp(option, customDate) {
    if (!snoozeMenuOpen) return  // guard stale clicks
    setSnoozeLoading(true)
    setSnoozeError('')

    const nextFollowUp = interactions.find(i => i.follow_up_date)
    if (!nextFollowUp) { setSnoozeLoading(false); setSnoozeMenuOpen(false); return }

    const result = await snoozeFollowUpAction(nextFollowUp, option, customDate, getLocalToday(), {
      client: supabase,
      track,
      dispatch: () => window.dispatchEvent(new Event('funnl:followups-changed')),
    })
    setSnoozeLoading(false)
    if (!result.ok) {
      setSnoozeError(result.errorMessage || "Couldn't update the date. Try again.")
      return  // keep menu open — snoozeMenuOpen stays true, controls re-enabled
    }

    setSnoozeMenuOpen(false)
    fetchInteractions()
  }

  // ── Interaction CRUD ──────────────────────────────────────────────────────

  function startEditInteraction(interaction) {
    setInteractionEditForm({
      type: interaction.type || 'Coffee chat', date: interaction.interaction_date,
      notes: interaction.notes || '', followUpDate: interaction.follow_up_date || '',
      outreachStatus: interaction.outreach_status || '',
      trackOutreach: !!interaction.outreach_status,
      _originalOutreachStatus: interaction.outreach_status || '',
      _originalFollowUpDate: interaction.follow_up_date || '',
    })
    setInteractionSaveError(''); setEditingInteractionId(interaction.id)
  }

  async function handleSaveInteraction(e) {
    e.preventDefault(); setSavingInteraction(true); setInteractionSaveError('')
    const editType = interactionEditForm.type
    const effectiveOutreach = effectiveOutreachStatus(
      editType, interactionEditForm.trackOutreach, interactionEditForm.outreachStatus
    )
    const finalFollowUpDate = interactionEditForm.followUpDate || null
    const { error } = await supabase.from('interactions').update({
      type: interactionEditForm.type, interaction_date: interactionEditForm.date,
      notes: interactionEditForm.notes || null, follow_up_date: finalFollowUpDate,
      outreach_status: effectiveOutreach,
      ...(followUpDateChanged(originalFollowUpDate, finalFollowUpDate) ? clearCompletionFields() : {}),
    }).eq('id', editingInteractionId)
    setSavingInteraction(false)
    if (error) { setInteractionSaveError(error.message); return }

    // Outreach analytics — fire only when the status actually changed.
    const prevStatus = interactionEditForm._originalOutreachStatus || null
    if (shouldFireOutreachChangeOnEdit(prevStatus, effectiveOutreach)) {
      track('outreach_status_changed', { status: effectiveOutreach || null, context: 'edit_interaction' })
    }

    // Dispatch follow-up badge refresh only when the date was genuinely added,
    // changed, or removed. Passing through an identical value must not dispatch.
    const originalFollowUpDate = interactionEditForm._originalFollowUpDate ?? ''
    if (followUpDateChanged(originalFollowUpDate, finalFollowUpDate)) {
      window.dispatchEvent(new Event('funnl:followups-changed'))
    }

    setEditingInteractionId(null); fetchInteractions()
  }

  async function handleDeleteInteraction(interactionId) {
    const { error } = await supabase.from('interactions').delete().eq('id', interactionId)
    if (!error) { setDeletingInteractionId(null); fetchInteractions() }
  }

  async function handleLogInteraction(e) {
    e.preventDefault(); setSubmitting(true); setFormError('')
    const effectiveOutreach = effectiveOutreachStatus(type, trackOutreach, outreachStatus)
    const { error } = await supabase.from('interactions').insert([{
      contact_id: id, type, interaction_date: interactionDate,
      notes: notes || null, follow_up_date: followUpDate || null,
      outreach_status: effectiveOutreach,
    }])
    setSubmitting(false)
    if (error) { setFormError(error.message); return }
    track('interaction_logged', { interaction_type: type, has_follow_up: !!followUpDate, has_notes: !!notes })
    window.dispatchEvent(new Event('funnl:interactions-changed'))
    if (followUpDate) {
      track('followup_set')
      window.dispatchEvent(new Event('funnl:followups-changed'))
    }
    if (effectiveOutreach) track('outreach_status_changed', { status: effectiveOutreach, context: 'new_interaction' })

    const srcId = sourceFollowUpIdRef.current
    if (srcId) {
      sourceFollowUpIdRef.current = null
      const srcInteraction = interactions.find(i => i.id === srcId)
      const logResultPayload = completionPayload(
        srcInteraction?.follow_up_date || null,
        'log_result',
        new Date().toISOString()
      )
      const { error: clearError } = await supabase
        .from('interactions').update(logResultPayload)
        .eq('id', srcId).eq('contact_id', id)
      if (clearError) {
        console.error('[Funnl] Log Result: follow-up clear failed:', clearError.message)
        if (loggedWarningTimerRef.current) clearTimeout(loggedWarningTimerRef.current)
        setLoggedWarning("Interaction logged, but the previous follow-up couldn't be cleared — remove it from Follow-ups manually.")
        loggedWarningTimerRef.current = setTimeout(() => setLoggedWarning(''), 8000)
      } else {
        window.dispatchEvent(new Event('funnl:followups-changed'))
        track('followup_completed', { method: 'log_result' })
      }
    }

    setType('Coffee chat'); setNotes(''); setFollowUpDate(''); setOutreachStatus(''); setTrackOutreach(false)
    setShowForm(false); fetchInteractions()
    setLoggedMsg(true); setTimeout(() => setLoggedMsg(false), 3000)
  }

  // ── Loading / error screens ───────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-muted text-sm">Loading…</p>
      </div>
    )
  }

  if (error || !contact) {
    return (
      <div className="min-h-screen bg-surface px-4 py-6">
        <Link to="/contacts" className="text-sm font-medium text-accent hover:text-tag no-underline">← Contacts</Link>
        <p className="mt-4 text-sm text-danger">{error || 'Contact not found.'}</p>
      </div>
    )
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const today = getLocalToday()

  // Any open follow-up, earliest first (not just overdue)
  const nextFollowUp = interactions
    .filter(i => i.follow_up_date)
    .sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date))[0] || null

  const nextFollowUpIsOverdue = nextFollowUp && nextFollowUp.follow_up_date < today
  const nextFollowUpIsToday  = nextFollowUp && nextFollowUp.follow_up_date === today

  const latestOutreach = interactions
    .filter(i => i.outreach_status)
    .sort((a, b) => b.interaction_date.localeCompare(a.interaction_date))[0] || null

  const hasAnyDetails = contact.email || contact.linkedin_url || contact.how_met ||
    contact.relationship_type || contact.relationship_note || latestOutreach

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-surface">

      {/* ── TopBar (shared component) ── */}
      <TopBar
        breadcrumb={
          <Link to="/contacts"
            className="inline-flex items-center gap-1 text-[12.5px] font-medium hover:text-hi transition-colors no-underline"
            style={{ color: 'var(--color-mid)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
            <span>Contacts</span>
          </Link>
        }
        title={contact.name}
        actions={
          <>
            <button
              onClick={() => setEditDrawerOpen(true)}
              className="hidden md:inline-flex items-center text-[12.5px] font-semibold px-3 h-8 rounded-[8px] border border-line-2 hover:border-line-3 transition-colors"
              style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
            >
              Edit
            </button>
            {contact.email && (
              <a
                href={`mailto:${contact.email}`}
                title={contact.email}
                className="w-8 h-8 hidden md:flex items-center justify-center rounded-[8px] border border-line-2 hover:border-line-3 transition-colors"
                style={{ background: 'var(--color-elevated)' }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
                </svg>
              </a>
            )}
          </>
        }
        cta={
          <button
            ref={logCTARef}
            onClick={() => setShowForm(v => !v)}
            className="h-8 flex items-center gap-[6px] px-[11px] rounded-[8px] text-[12.5px] font-semibold hover:opacity-90 transition-opacity"
            style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            <span className="hidden md:inline">Log interaction</span>
          </button>
        }
      />

      {/* ── TWO-COLUMN LAYOUT ── */}
      <div className="grid grid-cols-1 md:grid-cols-[270px_1fr]">

          {/* ── LEFT: Context rail ── */}
          <div className="md:border-r border-line-1 md:sticky md:top-[54px] md:h-[calc(100vh-54px)] md:overflow-y-auto">
            <div className="p-5 space-y-5">

              {/* Identity */}
              <div className="text-center pb-5 border-b border-line-1">
                <div
                  className="w-[60px] h-[60px] rounded-[16px] mx-auto mb-3 flex items-center justify-center text-[22px] font-bold"
                  style={{ background: getAvatarColor(contact.name), color: 'var(--color-paper)' }}
                >
                  {getInitials(contact.name)}
                </div>
                <h1 className="font-display text-[17px] font-bold text-hi leading-tight break-words">{contact.name}</h1>
                {(contact.role || contact.company) && (
                  <p className="text-[12.5px] text-muted mt-1 break-words">
                    {[contact.role, contact.company].filter(Boolean).join(' · ')}
                  </p>
                )}
                {contact.tags && contact.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3 justify-center">
                    {contact.tags.map(tag => (
                      <span key={tag} className="text-[11px] font-semibold text-tag bg-elevated border border-line-2 px-[9px] py-[3px] rounded-full">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                {/* Mobile actions */}
                <div className="flex gap-2 mt-4 md:hidden">
                  <button onClick={() => setEditDrawerOpen(true)}
                    className="flex-1 text-[12.5px] font-semibold py-[8px] rounded-[9px] border border-line-2 hover:border-line-3 transition-colors"
                    style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}>
                    Edit
                  </button>
                  {contact.email && (
                    <a href={`mailto:${contact.email}`}
                      className="flex-none px-3 flex items-center justify-center rounded-[9px] border border-line-2 hover:border-line-3 transition-colors"
                      style={{ background: 'var(--color-elevated)' }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
                      </svg>
                    </a>
                  )}
                </div>
              </div>

              {/* Next step card */}
              {nextFollowUp && (
                <div className="rounded-xl border border-line-2 p-4" style={{ background: 'var(--color-card)' }}>
                  <p className="text-[10.5px] font-bold uppercase tracking-wide text-low mb-2">Next step</p>
                  <p className="text-[13px] font-semibold text-hi mb-1">Follow-up</p>
                  <p className="text-[12.5px] font-medium mb-3"
                    style={{ color: nextFollowUpIsOverdue ? 'var(--color-ember)' : nextFollowUpIsToday ? 'var(--color-warning)' : 'var(--color-muted)' }}>
                    {formatFollowUpLabel(nextFollowUp.follow_up_date, today)}
                  </p>
                  <div className="flex gap-2 relative">
                    <button
                      onClick={() => handleDoneFollowUp(nextFollowUp.id)}
                      disabled={doneLoading || snoozeLoading}
                      className="flex-1 text-[12px] font-semibold py-[7px] rounded-[8px] border border-line-2 hover:border-line-3 transition-colors disabled:opacity-40"
                      style={{ background: 'var(--color-elevated)', color: 'var(--color-hi)' }}
                    >
                      {doneLoading ? '…' : '✓ Done'}
                    </button>
                    <div className="relative">
                      <button
                        onClick={() => setSnoozeMenuOpen(v => !v)}
                        disabled={doneLoading || snoozeLoading}
                        className="text-[12px] font-semibold px-3 py-[7px] rounded-[8px] border border-line-2 hover:border-line-3 transition-colors disabled:opacity-40"
                        style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
                      >
                        Snooze
                      </button>
                      {snoozeMenuOpen && (
                        <SnoozeMenu
                          onSnooze={handleSnoozeFollowUp}
                          onClose={() => { setSnoozeMenuOpen(false); setSnoozeError('') }}
                          saving={snoozeLoading}
                          error={snoozeError}
                        />
                      )}
                    </div>
                  </div>
                  {doneError && (
                    <p role="alert" className="text-[11.5px] mt-1.5 font-medium" style={{ color: 'var(--color-danger)' }}>
                      {doneError}
                    </p>
                  )}
                </div>
              )}

              {/* Details */}
              <div className="space-y-3 pb-5 border-b border-line-1">
                <p className="text-[10.5px] font-bold tracking-[0.8px] text-lower uppercase font-mono">Details</p>
                {hasAnyDetails ? (
                  <div className="space-y-3">
                    {contact.email && (
                      <div>
                        <p className="text-[11.5px] text-low mb-0.5">Email</p>
                        <a href={`mailto:${contact.email}`} className="text-[13px] font-medium text-accent hover:text-tag transition-colors no-underline break-all">{contact.email}</a>
                      </div>
                    )}
                    {contact.linkedin_url && (
                      <div>
                        <p className="text-[11.5px] text-low mb-0.5">LinkedIn</p>
                        <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-[13px] font-medium text-accent hover:text-tag transition-colors no-underline break-all">{contact.linkedin_url}</a>
                      </div>
                    )}
                    {contact.how_met && (
                      <div>
                        <p className="text-[11.5px] text-low mb-0.5">How you met</p>
                        <p className="text-[13px] font-medium text-hi">{contact.how_met}</p>
                      </div>
                    )}
                    {contact.relationship_type && (
                      <div>
                        <p className="text-[11.5px] text-low mb-0.5">Relationship</p>
                        <span className="inline-block text-[11.5px] font-semibold text-accent bg-elevated border border-line-2 px-[10px] py-[3px] rounded-full">
                          {contact.relationship_type}
                        </span>
                      </div>
                    )}
                    {contact.relationship_note && (
                      <div>
                        <p className="text-[11.5px] text-low mb-0.5">Why they matter</p>
                        <p className="text-[13px] font-medium text-hi leading-[1.5]">{contact.relationship_note}</p>
                      </div>
                    )}
                    {latestOutreach && (
                      <div>
                        <p className="text-[11.5px] text-low mb-1">Latest outreach</p>
                        <div className="flex items-center gap-2">
                          <OutreachStatusBadge status={latestOutreach.outreach_status} />
                          <span className="text-[11px] text-low">{relativeDate(latestOutreach.interaction_date)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[12.5px] text-low">
                    No details saved yet.{' '}
                    <button onClick={() => setEditDrawerOpen(true)} className="text-accent hover:text-tag transition-colors">Edit</button>
                    {' '}to add more.
                  </p>
                )}
              </div>

              {/* Contact AI slot — deferred while CONTACT_AI_ENABLED is false */}
              {/* CONTACT_AI_ENABLED = false → section removed entirely */}

              {/* Delete */}
              <div>
                {confirmingDelete ? (
                  <div className="space-y-2">
                    <p className="text-[12px] text-muted leading-snug">
                      Permanently deletes this contact and all their interactions.
                    </p>
                    <div className="flex gap-3">
                      <button onClick={handleDelete} className="text-[12.5px] font-bold text-danger hover:opacity-80 transition-opacity">Yes, delete</button>
                      <button onClick={() => setConfirmingDelete(false)} className="text-[12.5px] font-medium text-low hover:text-mid transition-colors">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setConfirmingDelete(true)} className="text-[12px] font-medium text-lower hover:text-danger transition-colors">
                    Delete contact
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── RIGHT: Timeline ── */}
          <div className="p-4 md:p-6">

            {/* Success banner */}
            {loggedMsg && (
              <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-xl border"
                style={{ background: 'rgba(47,212,182,0.08)', borderColor: 'rgba(47,212,182,0.22)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5"/>
                </svg>
                <p className="text-[12.5px] text-success font-medium">Interaction logged</p>
              </div>
            )}

            {/* Partial-success warning */}
            {loggedWarning && (
              <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-xl bg-[rgba(255,184,77,0.08)] border border-[rgba(255,184,77,0.2)]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none mt-[1px]">
                  <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
                </svg>
                <p className="text-[12.5px] text-warning font-medium leading-relaxed">{loggedWarning}</p>
              </div>
            )}

            {/* Interactions header */}
            <div className="flex items-center justify-between mb-4">
              <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono">Interactions</p>
              <button
                onClick={() => setShowForm(v => !v)}
                className="text-[12.5px] font-bold text-accent hover:text-tag transition-colors"
              >
                {showForm ? 'Cancel' : '+ Log'}
              </button>
            </div>

            {/* Log interaction form — desktop only; mobile uses LogInteractionSheet */}
            {showForm && (
              <form ref={interactionFormRef} onSubmit={handleLogInteraction} className="hidden md:block mb-5 space-y-3 bg-elevated border border-line-2 rounded-xl p-4">
                <div>
                  <label className={lCls}>Type</label>
                  <select value={type} onChange={e => handleTypeChange(e.target.value)} className={sCls}>
                    {TYPE_OPTIONS.map(o => <option key={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className={lCls}>Date <span className="text-accent">*</span></label>
                  <input type="date" value={interactionDate} onChange={e => setInteractionDate(e.target.value)} required className={iCls}/>
                </div>
                <div>
                  <label className={lCls}>Notes</label>
                  <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
                    placeholder="What did you talk about? Any key takeaways?"
                    className={`${iCls} resize-y min-h-[80px]`}/>
                </div>
                <div>
                  <label className={lCls}>Follow-up date</label>
                  <input ref={followUpDateInputRef} type="date" value={followUpDate} onChange={e => setFollowUpDate(e.target.value)} className={iCls}/>
                </div>
                {(type === 'Email' || type === 'Message') && (
                  <div className="space-y-2.5">
                    <label className="flex items-center gap-2.5 cursor-pointer select-none">
                      <input type="checkbox" checked={trackOutreach}
                        onChange={e => {
                          setTrackOutreach(e.target.checked)
                          if (e.target.checked && !outreachStatus) setOutreachStatus('awaiting_response')
                          if (!e.target.checked) setOutreachStatus('')
                        }}
                        className="w-4 h-4 accent-[#FF4423] cursor-pointer"/>
                      <span className="text-[13px] font-semibold text-hi">This was outreach I sent</span>
                    </label>
                    <p className="text-[12px] text-lower">Track the response manually. Automatic inbox syncing is not enabled.</p>
                    {trackOutreach && (
                      <select value={outreachStatus} onChange={e => setOutreachStatus(e.target.value)} className={sCls}>
                        <option value="awaiting_response">Awaiting response</option>
                        <option value="responded">Responded</option>
                        <option value="meeting_booked">Meeting booked</option>
                        <option value="no_response">No response</option>
                        <option value="declined">Declined</option>
                      </select>
                    )}
                  </div>
                )}
                {(type === 'Call' || type === 'Other') && (
                  <div>
                    <label className={lCls}>
                      Outreach status
                      <span className="text-lower font-normal ml-1">— Track the outcome manually. Automatic syncing is not enabled.</span>
                    </label>
                    <select value={outreachStatus} onChange={e => setOutreachStatus(e.target.value)} className={sCls}>
                      <option value="">— not set —</option>
                      <option value="awaiting_response">Awaiting response</option>
                      <option value="responded">Responded</option>
                      <option value="meeting_booked">Meeting booked</option>
                      <option value="no_response">No response</option>
                      <option value="declined">Declined</option>
                    </select>
                  </div>
                )}
                {formError && <p className="text-sm text-danger">{formError}</p>}
                <button type="submit" disabled={submitting}
                  className="w-full text-[13.5px] font-bold py-[11px] rounded-[11px] hover:opacity-90 transition-opacity disabled:opacity-40"
                  style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}>
                  {submitting ? 'Saving…' : 'Save interaction'}
                </button>
              </form>
            )}

            {/* Interaction timeline */}
            {interactionsError ? (
              <div className="text-center py-8">
                <p className="text-[13px] text-danger mb-2">{interactionsError}</p>
                <button onClick={fetchInteractions} className="text-[12px] text-accent hover:text-tag transition-colors">Try again</button>
              </div>
            ) : interactions.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-[13px] font-medium text-mid mb-1">No interactions yet</p>
                <p className="text-[12px] text-low">Click <span className="text-accent">+ Log</span> to record your first one.</p>
              </div>
            ) : (
              <div>
                {interactions.map((interaction, index) => {
                  const isLast = index === interactions.length - 1
                  const style = typeStyle(interaction.type)
                  return (
                    <div key={interaction.id} className="flex gap-[14px]">
                      <div className="flex flex-col items-center flex-none">
                        <div className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center flex-none" style={{ background: style.bg }}>
                          <TypeIcon type={interaction.type} color={style.stroke}/>
                        </div>
                        {!isLast && <div className="w-0.5 flex-1 bg-line-1 mt-1 min-h-[16px]"/>}
                      </div>
                      <div className={`flex-1 min-w-0 ${!isLast ? 'pb-5' : ''}`}>
                        {editingInteractionId === interaction.id ? (
                          <form onSubmit={handleSaveInteraction} className="space-y-3 bg-elevated border border-line-2 rounded-xl p-3 mb-1">
                            <div>
                              <label className={lCls}>Type</label>
                              <select value={interactionEditForm.type}
                                onChange={e => {
                                  const newType = e.target.value
                                  const fields = typeChangeFields(interactionEditForm.type, newType)
                                  setInteractionEditForm(prev => ({ ...prev, type: newType, ...(fields || {}) }))
                                }}
                                className={sCls}>
                                {TYPE_OPTIONS.map(o => <option key={o}>{o}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className={lCls}>Date</label>
                              <input type="date" value={interactionEditForm.date}
                                onChange={e => setInteractionEditForm({ ...interactionEditForm, date: e.target.value })}
                                required className={iCls}/>
                            </div>
                            <div>
                              <label className={lCls}>Notes</label>
                              <textarea value={interactionEditForm.notes}
                                onChange={e => setInteractionEditForm({ ...interactionEditForm, notes: e.target.value })}
                                rows={3} className={`${iCls} resize-y`}/>
                            </div>
                            <div>
                              <label className={lCls}>Follow-up date</label>
                              <input type="date" value={interactionEditForm.followUpDate}
                                onChange={e => setInteractionEditForm({ ...interactionEditForm, followUpDate: e.target.value })}
                                className={iCls}/>
                            </div>
                            {(interactionEditForm.type === 'Email' || interactionEditForm.type === 'Message') && (
                              <div className="space-y-2.5">
                                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                                  <input type="checkbox" checked={!!interactionEditForm.trackOutreach}
                                    onChange={e => {
                                      const checked = e.target.checked
                                      setInteractionEditForm(prev => ({
                                        ...prev, trackOutreach: checked,
                                        outreachStatus: checked ? (prev.outreachStatus || 'awaiting_response') : '',
                                      }))
                                    }}
                                    className="w-4 h-4 accent-[#FF4423] cursor-pointer"/>
                                  <span className="text-[13px] font-semibold text-hi">This was outreach I sent</span>
                                </label>
                                <p className="text-[12px] text-lower">Track the response manually. Automatic inbox syncing is not enabled.</p>
                                {interactionEditForm.trackOutreach && (
                                  <select value={interactionEditForm.outreachStatus || ''}
                                    onChange={e => setInteractionEditForm({ ...interactionEditForm, outreachStatus: e.target.value })}
                                    className={sCls}>
                                    <option value="awaiting_response">Awaiting response</option>
                                    <option value="responded">Responded</option>
                                    <option value="meeting_booked">Meeting booked</option>
                                    <option value="no_response">No response</option>
                                    <option value="declined">Declined</option>
                                  </select>
                                )}
                              </div>
                            )}
                            {(interactionEditForm.type === 'Call' || interactionEditForm.type === 'Other') && (
                              <div>
                                <label className={lCls}>
                                  Outreach status
                                  <span className="text-lower font-normal ml-1">— Track the outcome manually. Automatic syncing is not enabled.</span>
                                </label>
                                <select value={interactionEditForm.outreachStatus || ''}
                                  onChange={e => setInteractionEditForm({ ...interactionEditForm, outreachStatus: e.target.value })}
                                  className={sCls}>
                                  <option value="">— not set —</option>
                                  <option value="awaiting_response">Awaiting response</option>
                                  <option value="responded">Responded</option>
                                  <option value="meeting_booked">Meeting booked</option>
                                  <option value="no_response">No response</option>
                                  <option value="declined">Declined</option>
                                </select>
                              </div>
                            )}
                            {interactionSaveError && <p className="text-sm text-danger">{interactionSaveError}</p>}
                            <div className="flex gap-2">
                              <button type="submit" disabled={savingInteraction}
                                className="flex-1 text-[13px] font-bold py-2.5 rounded-[10px] hover:opacity-90 transition-opacity disabled:opacity-40"
                                style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}>
                                {savingInteraction ? 'Saving…' : 'Save'}
                              </button>
                              <button type="button" onClick={() => setEditingInteractionId(null)}
                                className="px-4 text-[13px] font-semibold text-mid bg-card border border-line-3 rounded-[10px] hover:text-hi transition-colors">
                                Cancel
                              </button>
                            </div>
                          </form>
                        ) : (
                          <div className="pt-0.5">
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <div className="flex items-center gap-2 flex-wrap min-w-0">
                                <span className="text-[13.5px] font-bold text-hi">{interaction.type || 'Interaction'}</span>
                                {interaction.outreach_status && <OutreachStatusBadge status={interaction.outreach_status} />}
                              </div>
                              <div className="flex items-center gap-3 flex-none">
                                <span className="text-[11.5px] text-low">{relativeDate(interaction.interaction_date)}</span>
                                <button onClick={() => startEditInteraction(interaction)} className="text-[11.5px] font-medium text-lower hover:text-mid transition-colors">Edit</button>
                                {deletingInteractionId === interaction.id ? (
                                  <span className="flex items-center gap-1.5">
                                    <button onClick={() => handleDeleteInteraction(interaction.id)} className="text-[11.5px] font-bold text-danger hover:opacity-80 transition-opacity">Delete</button>
                                    <button onClick={() => setDeletingInteractionId(null)} className="text-[11.5px] text-lower hover:text-mid transition-colors">Cancel</button>
                                  </span>
                                ) : (
                                  <button onClick={() => setDeletingInteractionId(interaction.id)} className="text-[11.5px] font-medium text-lower hover:text-danger transition-colors">Delete</button>
                                )}
                              </div>
                            </div>
                            {interaction.notes && (
                              <p className="text-[12.5px] leading-[1.55] text-muted whitespace-pre-wrap break-words mb-1.5">{interaction.notes}</p>
                            )}
                            {interaction.follow_up_date && (
                              <p className="text-[11.5px] font-medium text-warning">Follow up: {interaction.follow_up_date}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

      {/* Mobile bottom sheet — shown on small screens instead of the desktop inline form */}
      <LogInteractionSheet
        open={showForm}
        onClose={() => setShowForm(false)}
        contactName={contact?.name}
        focusRestoreRef={logCTARef}
        type={type}
        onTypeChange={handleTypeChange}
        interactionDate={interactionDate}
        setInteractionDate={setInteractionDate}
        notes={notes}
        setNotes={setNotes}
        followUpDate={followUpDate}
        setFollowUpDate={setFollowUpDate}
        trackOutreach={trackOutreach}
        setTrackOutreach={setTrackOutreach}
        outreachStatus={outreachStatus}
        setOutreachStatus={setOutreachStatus}
        onSubmit={handleLogInteraction}
        submitting={submitting}
        formError={formError}
        followUpDateRef={followUpDateInputRef}
      />

      {/* Edit contact drawer */}
      {editDrawerOpen && contact && (
        <>
          <div
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(20,17,15,0.45)', animation: 'fade-in 0.2s ease-out' }}
            onClick={() => setEditDrawerOpen(false)}
          />
          <AddContactDrawer
            contact={contact}
            onClose={() => setEditDrawerOpen(false)}
            onSuccess={() => { setEditDrawerOpen(false); fetchContact() }}
          />
        </>
      )}
    </div>
  )
}

export default ContactDetailPage
