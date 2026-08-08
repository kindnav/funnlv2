import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import ImportContactsModal from '../components/ImportContactsModal'
import TopBar from '../components/TopBar'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import { track } from '../lib/analytics'
import { useProStatus } from '../lib/useProStatus'
import { classifyProStatus } from '../lib/pro-ui-status'
import {
  getLocalToday,
  getLocalWeekStartDate,
  getLocalWeekStartISO,
  computeTopTag,
  computeResponseRate,
  computeSignals,
  computeNetworkSignal,
  formatActivityDate,
  followUpLabel,
  buildRecentActivity,
} from '../lib/dashboard-metrics'
import { computeTopFirms } from '../lib/firmMetrics'
import ContactPickerModal from '../components/ContactPickerModal'
import { buildPickerNavigationState } from '../lib/contactPickerUtils'
import { runMilestoneRecorder } from '../lib/milestoneRecorder'
import { resolveActivationAction } from '../lib/activationActionCoordinator'
import {
  getFunnelInset,
  deriveActivationState,
  getNextAction,
  buildStepSummary,
  buildProgressAriaLabel,
  getFirstName,
  sessionDismissKey,
  welcomeSkipKey,
  completionSessionKey,
  readSessionFlag,
  writeSessionFlag,
  clearSessionFlag,
  readLocalFlag,
  writeLocalFlag,
} from '../lib/activationHelpers'

// AI_WEEKLY_INSIGHT_ENABLED = false
// True AI-generated weekly insights require a cached, scheduled generation flow
// (e.g., Edge Function on cron, result stored in DB). They must never be triggered
// by page load — that would fire an uncached LLM call per user per Dashboard mount.
// The NETWORK SIGNAL card is entirely rule-based and safe to show all users now.
const AI_WEEKLY_INSIGHT_ENABLED = false

// ── Sub-components (module-level — not inside DashboardPage) ─────────────────

// ── Top Firms sub-components ──────────────────────────────────────────────────

function TopFirmsCard({ firms }) {
  const shown = firms.slice(0, 3)

  if (shown.length === 0) {
    return (
      <div className="rounded-[14px] border border-line-2 overflow-hidden" style={{ background: 'var(--color-card)' }}>
        <div className="px-[16px] py-[11px] border-b border-line-1">
          <h3 className="text-[12.5px] font-semibold" style={{ color: 'var(--color-hi)' }}>Top firms</h3>
        </div>
        <div className="px-[16px] py-[14px]">
          <p className="text-[12px]" style={{ color: 'var(--color-muted)' }}>No firm activity yet.</p>
          <p className="text-[11px] mt-[3px]" style={{ color: 'var(--color-low)' }}>
            Add company names to your contacts to see them here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-[14px] border border-line-2 overflow-hidden" style={{ background: 'var(--color-card)' }}>
      <div className="px-[16px] py-[11px] flex items-center justify-between border-b border-line-1">
        <h3 className="text-[12.5px] font-semibold" style={{ color: 'var(--color-hi)' }}>Top firms</h3>
        <Link
          to="/contacts"
          className="text-[11px] font-semibold no-underline"
          style={{ color: 'var(--color-accent)' }}
        >
          View contacts
        </Link>
      </div>
      <div>
        {shown.map((f, i) => (
          <Link
            key={f.firm}
            to={`/contacts?search=${encodeURIComponent(f.firm)}`}
            className="flex items-center justify-between px-[16px] no-underline"
            style={{
              paddingTop: '10px',
              paddingBottom: '10px',
              borderBottom: i < shown.length - 1 ? '1px solid var(--color-line-1)' : undefined,
            }}
          >
            <span
              className="text-[12.5px] font-medium truncate mr-[8px]"
              style={{ color: 'var(--color-hi)' }}
            >
              {f.firm}
            </span>
            <span
              className="text-[11px] font-mono flex-none whitespace-nowrap"
              style={{ color: 'var(--color-muted)' }}
            >
              {f.spokenWithCount > 0
                ? `${f.spokenWithCount} spoken with`
                : `${f.contactsCount} contact${f.contactsCount !== 1 ? 's' : ''}`}
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}

// Handles both interaction entries (kind=interaction) and new-contact entries (kind=contact).
function ActivityRow({ item, today, isLast }) {
  const outreachStyles = {
    awaiting_response: { color: 'var(--color-awaiting)', bg: 'rgba(199,169,107,0.12)', border: 'rgba(199,169,107,0.25)', label: 'Awaiting' },
    responded:         { color: 'var(--color-success)',  bg: 'rgba(46,125,91,0.12)',    border: 'rgba(46,125,91,0.2)',   label: 'Responded' },
    meeting_booked:    { color: 'var(--color-success)',  bg: 'rgba(46,125,91,0.12)',    border: 'rgba(46,125,91,0.2)',   label: 'Meeting' },
    no_response:       { color: 'var(--color-muted)',    bg: 'var(--color-elevated)',   border: 'var(--color-line-2)',   label: 'No response' },
    declined:          { color: 'var(--color-danger)',   bg: 'rgba(194,51,77,0.1)',     border: 'rgba(194,51,77,0.2)',   label: 'Declined' },
  }
  const os = outreachStyles[item.outreachStatus]

  return (
    <Link
      to={`/contacts/${item.contactId}`}
      className={`flex items-center gap-[10px] px-[18px] py-[10px] no-underline transition-colors${!isLast ? ' border-b border-line-1' : ''}`}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(20,17,15,0.03)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <span
        className="text-[10px] font-mono w-[36px] flex-none text-right tabular-nums"
        style={{ color: 'var(--color-low)' }}
      >
        {formatActivityDate(item.date, today)}
      </span>
      <span
        className="text-[13px] font-medium flex-1 truncate"
        style={{ color: 'var(--color-hi)' }}
      >
        {item.contactName}
      </span>
      <div className="flex items-center gap-[5px] flex-none">
        <span
          className="text-[10px] font-mono px-[6px] py-[2px] rounded-[4px]"
          style={{ background: 'var(--color-elevated)', color: 'var(--color-muted)', border: '1px solid var(--color-line-2)' }}
        >
          {item.type}
        </span>
        {item.hasNotes && (
          <span
            className="text-[10px] font-mono px-[5px] py-[2px] rounded-[4px]"
            style={{ background: 'var(--color-elevated)', color: 'var(--color-low)', border: '1px solid var(--color-line-1)' }}
            title="Has notes"
          >
            Notes
          </span>
        )}
        {os && (
          <span
            className="text-[10px] font-mono px-[6px] py-[2px] rounded-[4px]"
            style={{ color: os.color, background: os.bg, border: `1px solid ${os.border}` }}
          >
            {os.label}
          </span>
        )}
      </div>
    </Link>
  )
}

// ── Onboarding sub-components ─────────────────────────────────────────────────

// FunnelFillMark — dual SVG: low-opacity base + ember overlay with clip-path fill.
// The funnel fills bottom-up as stepsCompleted increases (0–3).
function FunnelFillMark({ stepsCompleted }) {
  const clipPath = getFunnelInset(stepsCompleted)
  // Respect prefers-reduced-motion — skip clip-path transition when motion is reduced.
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  return (
    <div style={{ position: 'relative', width: 34, height: 31, flexShrink: 0 }} aria-hidden="true">
      {/* Base — always visible at low opacity */}
      <svg
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.18 }}
        viewBox="0 0 24 24"
        fill="none"
      >
        <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#FF4423"/>
      </svg>
      {/* Overlay — clips to show the filled portion */}
      <svg
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          clipPath,
          transition: prefersReducedMotion ? 'none' : 'clip-path 0.5s ease',
        }}
        viewBox="0 0 24 24"
        fill="none"
      >
        <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#FF4423"/>
      </svg>
    </div>
  )
}

// WelcomeCard — shown when the user has zero contacts (first-run state).
// Personalized greeting + three stacked CTAs.
function WelcomeCard({ displayName, onAdd, onImport, onSkip }) {
  const firstName = getFirstName(displayName)
  const greeting = firstName ? `Welcome to Funnl, ${firstName}.` : 'Welcome to Funnl.'
  return (
    <div className="flex items-center justify-center px-[20px] py-[48px] md:py-[72px]">
      <div
        className="w-full rounded-[13px] p-[36px_32px] text-center"
        style={{ maxWidth: 420, background: 'var(--color-card)', border: '1px solid var(--color-line-2)' }}
      >
        {/* Flat ember funnel — no fill animation on welcome card */}
        <svg
          style={{ width: 44, height: 40, margin: '0 auto 18px', display: 'block' }}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#FF4423"/>
        </svg>
        <h2
          className="font-display text-[22px] font-bold text-balance mb-[6px]"
          style={{ color: 'var(--color-hi)', letterSpacing: '-0.8px' }}
        >
          {greeting}
        </h2>
        <p
          className="text-[12.5px] leading-relaxed mb-[20px]"
          style={{ color: 'var(--color-low)' }}
        >
          Every person you meet, every conversation you have, every follow-up you owe. One place that never forgets.
        </p>
        <div className="flex flex-col gap-[7px] text-left">
          {/* Primary CTA — ember */}
          <button
            onClick={onAdd}
            className="flex items-center gap-[11px] w-full rounded-[10px] px-[15px] py-[12px] border-0 transition-opacity hover:opacity-90 text-left"
            style={{ background: 'var(--color-ember)', cursor: 'pointer' }}
          >
            <span
              className="text-[12.5px] font-bold flex-1"
              style={{ color: 'var(--color-paper)' }}
            >
              Add your first contact
            </span>
            <span
              className="text-[10px]"
              style={{ color: 'rgba(247,242,231,0.7)' }}
            >
              30 seconds
            </span>
          </button>
          {/* Secondary CTA — ghost */}
          <button
            onClick={onImport}
            className="flex items-center gap-[11px] w-full rounded-[10px] px-[15px] py-[12px] border text-left"
            style={{ background: 'var(--color-card)', borderColor: 'var(--color-line-2)', cursor: 'pointer' }}
          >
            <span
              className="text-[12.5px] font-semibold flex-1"
              style={{ color: 'var(--color-hi)' }}
            >
              Import from LinkedIn or a spreadsheet
            </span>
            <span
              className="text-[10px] font-mono"
              style={{ color: 'var(--color-muted)' }}
            >
              CSV
            </span>
          </button>
          {/* Tertiary CTA — text */}
          <button
            onClick={onSkip}
            className="border-0 text-[11px] font-semibold pt-[6px] pb-0 px-0 text-center w-full"
            style={{ background: 'none', color: 'var(--color-muted)', cursor: 'pointer' }}
          >
            Skip — just look around
          </button>
        </div>
      </div>
    </div>
  )
}

// ActivationProgressStrip — compact inline strip shown when user has data but
// activation is incomplete and the strip has not been dismissed.
// Spec: 09 Onboarding 1a progress strip.
function ActivationProgressStrip({ step1Done, step2Done, step3Done, completedCount, ariaLabel, onDismiss, onNextAction }) {
  const { heading, doneParts, nextStep } = buildStepSummary(step1Done, step2Done, step3Done)
  const nextAction = getNextAction(step1Done, step2Done, step3Done)
  const progressLabel = ariaLabel || buildProgressAriaLabel(step1Done, step2Done, step3Done)
  return (
    <div
      className="rounded-[13px] border border-line-2"
      style={{ background: 'var(--color-card)', padding: '16px 20px' }}
    >
      <div className="flex items-center gap-[16px]">
        {/* role="progressbar" wraps the visual funnel fill indicator — the ARIA progressbar. */}
        <div
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="3"
          aria-valuenow={completedCount ?? 0}
          aria-label={progressLabel}
        >
          <FunnelFillMark stepsCompleted={completedCount ?? 0} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-bold m-0" style={{ color: 'var(--color-hi)' }}>
            {heading}
          </p>
          <p className="text-[11.5px] m-0 mt-[2px]" style={{ color: 'var(--color-low)' }}>
            {doneParts.map((part, i) => (
              <span key={part}>
                {i > 0 && <span aria-hidden="true"> · </span>}
                {part} <span aria-hidden="true">✓</span>
              </span>
            ))}
            {doneParts.length > 0 && nextStep && (
              <span aria-hidden="true"> · </span>
            )}
            {nextStep && (
              <strong style={{ color: 'var(--color-hi)' }}>
                one step left: {nextStep}
              </strong>
            )}
          </p>
        </div>
        {nextAction && (
          <button
            onClick={onNextAction}
            className="text-[11px] font-bold rounded-[8px] border-0 flex-none transition-opacity hover:opacity-90"
            style={{ background: 'var(--color-ember)', color: 'var(--color-paper)', padding: '8px 14px', cursor: 'pointer' }}
          >
            {nextAction.label}
          </button>
        )}
        <button
          onClick={onDismiss}
          aria-label="Dismiss setup progress"
          title="Dismiss"
          className="flex-none border-0 text-[11px] leading-none"
          style={{ background: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: '4px' }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

// CompletionStrip — session-only strip shown immediately after activation completes.
// Disappears the next session because milestones.completed will be non-null.
// Spec: 09 Onboarding 1a completion strip.
function CompletionStrip() {
  return (
    <div
      role="status"
      aria-label="Activation complete"
      className="rounded-[13px] border border-line-2"
      style={{ background: 'var(--color-card)', padding: '16px 20px' }}
    >
      <div className="flex items-center gap-[16px]">
        <FunnelFillMark stepsCompleted={3} />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-bold m-0" style={{ color: 'var(--color-hi)' }}>
            Your Funnl is running.
          </p>
          <p className="text-[11.5px] m-0 mt-[2px]" style={{ color: 'var(--color-low)' }}>
            Contacts in, conversations logged, follow-ups scheduled. Nothing slips from here.
          </p>
        </div>
        <span
          className="text-[9px] font-mono flex-none"
          style={{ color: 'var(--color-success)' }}
        >
          COMPLETED · strip disappears after this session
        </span>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

function DashboardPage() {
  const navigate = useNavigate()
  const proStatus = useProStatus()
  const displayStatus = classifyProStatus(proStatus)
  const canUsePro = displayStatus === 'permanent' || displayStatus === 'trial'

  // ── Data state ─────────────────────────────────────────────────────────────
  const [contactCount,          setContactCount]          = useState(0)
  const [newContactsThisWeek,   setNewContactsThisWeek]   = useState(0)
  const [interactionCount,      setInteractionCount]      = useState(0)
  const [interactionsThisWeek,  setInteractionsThisWeek]  = useState(0)
  const [followUpsDueList,      setFollowUpsDueList]      = useState([])
  const [hasFollowUp,           setHasFollowUp]           = useState(false)
  const [awaitingResponseCount, setAwaitingResponseCount] = useState(0)
  const [responseRate,          setResponseRate]          = useState(null)
  const [topTag,                setTopTag]                = useState(null)
  const [signals,               setSignals]               = useState([])
  const [recentActivity,        setRecentActivity]        = useState([])
  const [milestones,            setMilestones]            = useState(null)
  const [loading,               setLoading]               = useState(true)
  const [fetchError,            setFetchError]            = useState('')
  const [contacts,              setContacts]              = useState([])
  const [topFirms,              setTopFirms]              = useState([])
  const [showImportModal,       setShowImportModal]       = useState(false)
  // null | 'interaction' | 'followup' — which quick action triggered the contact picker
  const [pickerMode,            setPickerMode]            = useState(null)

  // Onboarding display state
  const [displayName,           setDisplayName]           = useState(null)
  const [uid,                   setUid]                   = useState(null)
  const [justCompleted,         setJustCompleted]         = useState(false)
  const [stripDismissed,        setStripDismissed]        = useState(false)
  // welcomeSkipped: localStorage-backed (persistent across sessions).
  // Initialized to false; updated from localStorage inside fetchAll once uid is known.
  const [welcomeSkipped,        setWelcomeSkipped]        = useState(false)

  // Fires at most once per mount when the checklist is visible.
  const checklistViewedRef = useRef(false)
  // Tracks the previously-seen uid to detect account switches within the same component instance.
  const prevUidRef = useRef(null)
  // Ref for the collapsed reopen button — used to restore focus when the strip reopens.
  const collapsedBtnRef = useRef(null)
  // Stale-fetch guard: incremented at the start of every fetchAll call. Each invocation
  // captures its own generation and aborts without mutating state if superseded.
  const fetchGenRef = useRef(0)

  useEffect(() => { fetchAll() }, [])

  // Refetch dashboard data when a contact is added from any route (global drawer).
  useEffect(() => {
    const handler = () => fetchAll()
    window.addEventListener('funnl:contacts-changed', handler)
    return () => window.removeEventListener('funnl:contacts-changed', handler)
  }, [])

  // Quiet refetch when follow-up dates change (preserves stripDismissed/welcomeSkipped/justCompleted).
  useEffect(() => {
    const handler = () => fetchAll({ quiet: true })
    window.addEventListener('funnl:followups-changed', handler)
    return () => window.removeEventListener('funnl:followups-changed', handler)
  }, [])

  // Quiet refetch when an interaction is logged without a follow-up date.
  useEffect(() => {
    const handler = () => fetchAll({ quiet: true })
    window.addEventListener('funnl:interactions-changed', handler)
    return () => window.removeEventListener('funnl:interactions-changed', handler)
  }, [])

  // Immediate account-switch reset via auth state change — separate from fetchAll's detection
  // so stale data from the old account cannot commit state after a sign-out/sign-in.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const newUid = session?.user?.id ?? null
      if (prevUidRef.current !== null && prevUidRef.current !== newUid) {
        // Invalidate all in-flight fetch generations so stale results are silently discarded.
        fetchGenRef.current++
        setMilestones(null)
        setDisplayName(null)
        setJustCompleted(false)
        setStripDismissed(false)
        setWelcomeSkipped(false)
        setContactCount(0)
        setInteractionCount(0)
        setHasFollowUp(false)
        setTopFirms([])
        setUid(newUid)
        prevUidRef.current = newUid
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  // Fire activation_checklist_viewed once per mount when the progress strip is visible.
  // Uses contactCount > 0 as the proxy for "strip is shown" (compact mode).
  useEffect(() => {
    if (milestones && milestones.completed === null && contactCount > 0 && !checklistViewedRef.current) {
      track('activation_checklist_viewed')
      checklistViewedRef.current = true
    }
  }, [milestones, contactCount])

  async function fetchAll({ quiet = false } = {}) {
    const gen = ++fetchGenRef.current

    if (!quiet) {
      setFetchError('')
      setLoading(true)
    }

    const today         = getLocalToday()
    // Calendar week: Monday 00:00 local (not rolling 7 days)
    const weekStartDate = getLocalWeekStartDate()  // YYYY-MM-DD for interaction_date comparisons
    const weekStartISO  = getLocalWeekStartISO()   // ISO timestamp for created_at comparisons

    // getSession() may refresh an expired token — always await it.
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (fetchGenRef.current !== gen) return  // superseded by a newer fetch
    if (sessionError) {
      if (!quiet) { setFetchError(sessionError.message); setLoading(false) }
      return
    }
    const resolvedUid = sessionData?.session?.user?.id ?? null

    if (!quiet) {
      // Account-switch isolation: if uid changed while this component was mounted,
      // clear all prior-user state immediately to prevent data bleed across accounts.
      if (prevUidRef.current !== null && prevUidRef.current !== resolvedUid) {
        setMilestones(null)
        setDisplayName(null)
        setJustCompleted(false)
        setStripDismissed(false)
        setWelcomeSkipped(false)
        setContactCount(0)
        setInteractionCount(0)
        setHasFollowUp(false)
        setTopFirms([])
      }
      prevUidRef.current = resolvedUid
      setUid(resolvedUid)

      // Read session/local flags for this user — safe even on first mount.
      if (resolvedUid) {
        const dismissed = readSessionFlag(sessionDismissKey(resolvedUid))
        setStripDismissed(dismissed)
        // welcomeSkipped persists across sessions (localStorage).
        const skipped = readLocalFlag(welcomeSkipKey(resolvedUid))
        setWelcomeSkipped(skipped)
        // justCompleted: only true in the session where activation completes.
        const completedThisSession = readSessionFlag(completionSessionKey(resolvedUid))
        setJustCompleted(completedThisSession)
      }
    }

    const [
      { data: contactsData,     error: e1 },
      { data: interactionsData, error: e2 },
      { data: profileData,      error: e3 },
    ] = await Promise.all([
      supabase.from('contacts').select('id, name, tags, company, role, created_at'),
      // notes is required for buildRecentActivity hasNotes field
      supabase.from('interactions').select('id, contact_id, interaction_date, type, outreach_status, follow_up_date, notes, created_at'),
      resolvedUid
        ? supabase.from('profiles')
            .select('activation_five_contacts_at, activation_first_interaction_at, activation_first_followup_at, activation_completed_at, display_name')
            .eq('id', resolvedUid)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])

    if (fetchGenRef.current !== gen) return  // superseded by a newer fetch
    if (e1 || e2 || e3) {
      if (!quiet) { setFetchError((e1 || e2 || e3).message); setLoading(false) }
      return
    }

    const contacts = contactsData || []
    const interactions = interactionsData || []
    const contactMap = Object.fromEntries(contacts.map(c => [c.id, c]))

    // ── Basic counts ─────────────────────────────────────────────────────────
    const cCount = contacts.length
    const iCount = interactions.length
    // "This week" = Monday 00:00 local through now.
    // created_at is a UTC ISO string; compare against the UTC equivalent of local Monday midnight.
    const newC = contacts.filter(c => c.created_at >= weekStartISO).length
    // interaction_date is a YYYY-MM-DD string (date column) — compare as strings.
    const newI = interactions.filter(i => i.interaction_date >= weekStartDate).length

    // ── Follow-ups due (overdue + today) ─────────────────────────────────────
    const dueList = interactions
      .filter(i => i.follow_up_date && i.follow_up_date <= today)
      .sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date))
      .map(i => ({ interaction: i, contact: contactMap[i.contact_id] || null }))

    // hasFollowUp = any non-null follow_up_date (due, overdue, or future)
    const hasAnyFollowUp = interactions.some(i => i.follow_up_date != null)

    // ── Outreach stats ────────────────────────────────────────────────────────
    const awaitingCount = interactions.filter(i => i.outreach_status === 'awaiting_response').length
    // computeResponseRate: excludes awaiting_response from denominator
    const rate = computeResponseRate(interactions)

    // ── Top tag ───────────────────────────────────────────────────────────────
    const tag = computeTopTag(contacts)

    // ── Relationship signals ─────────────────────────────────────────────────
    // computeSignals: uses daysBetween (UTC ordinals), hasOpenFollowUp = any non-null follow_up_date
    const sigs = computeSignals(contacts, interactions, today)

    // ── Recent activity: combined contacts + interactions, newest first ────────
    const recent = buildRecentActivity(contacts, interactions, contactMap)

    // ── Top firms ────────────────────────────────────────────────────────────
    // Computed here while interactions is still in scope (it's a local const).
    const firms = computeTopFirms(contacts, interactions)

    // ── Commit state ──────────────────────────────────────────────────────────
    setContacts(contacts)
    setContactCount(cCount)
    setNewContactsThisWeek(newC)
    setInteractionCount(iCount)
    setInteractionsThisWeek(newI)
    setFollowUpsDueList(dueList)
    setHasFollowUp(hasAnyFollowUp)
    setAwaitingResponseCount(awaitingCount)
    setResponseRate(rate)
    setTopTag(tag)
    setSignals(sigs)
    setRecentActivity(recent)
    setTopFirms(firms)

    const ms = {
      fiveContacts:     profileData?.activation_five_contacts_at     ?? null,
      firstInteraction: profileData?.activation_first_interaction_at ?? null,
      firstFollowup:    profileData?.activation_first_followup_at    ?? null,
      completed:        profileData?.activation_completed_at         ?? null,
    }
    setMilestones(ms)
    setDisplayName(profileData?.display_name ?? null)
    if (!quiet) setLoading(false)

    if (resolvedUid) {
      recordMilestones(resolvedUid, cCount, iCount, hasAnyFollowUp, ms)
        .catch(err => console.error('[Funnl] recordMilestones threw unexpectedly:', err))
    }
  }

  // ── recordMilestones: conditional DB writes + analytics ──────────────────
  // Delegates to runMilestoneRecorder (milestoneRecorder.js) which uses
  // shouldAttemptMilestoneWrites as the single eligibility source of truth
  // and tracks effectiveMs so race-loser individual steps never trigger a
  // spurious completion.
  // Analytics: activation_step_completed (×0–3), activation_completed (×0–1).
  async function recordMilestones(uid, contactCnt, interactionCnt, hasFollowUpBool, ms) {
    const now = new Date().toISOString()

    await runMilestoneRecorder({
      contactCnt,
      interactionCnt,
      hasFollowUpBool,
      ms,
      now,
      conditionalUpdate: async (col) => {
        const { data: updated, error } = await supabase
          .from('profiles')
          .update({ [col]: now })
          .eq('id', uid)
          .is(col, null)
          .select('id')
        if (error) {
          console.error(`[Funnl] Milestone update failed (${col}):`, error.message)
          return { ok: false }
        }
        return { ok: true, claimed: (updated?.length ?? 0) > 0 }
      },
      onStepClaimed: (step, effMs) => {
        if (effMs.completed === null) track('activation_step_completed', { step: step })
      },
      onCompletionClaimed: (completedAt) => {
        track('activation_completed', { contacts_count: contactCnt })
        setMilestones(prev => prev ? { ...prev, completed: completedAt } : prev)
        // Persist to sessionStorage so navigating away and back within the same
        // session still shows the CompletionStrip (justCompleted React state resets
        // on component unmount; sessionStorage survives it).
        writeSessionFlag(completionSessionKey(uid))
        setJustCompleted(true)
      },
    })
  }

  function openCommandPalette() {
    window.dispatchEvent(new CustomEvent('funnl:open-command-palette'))
  }

  // Contact picker — routes to the contact's detail page with the appropriate form pre-opened.
  // openInteractionForm and openFollowUpForm are both handled by ContactDetailPage.
  function handlePickerSelect(contact) {
    const state = buildPickerNavigationState(pickerMode)
    setPickerMode(null)
    if (state) navigate(`/contacts/${contact.id}`, { state })
  }

  // ── Shared ember CTA ──────────────────────────────────────────────────────
  function openAddContactDrawer() {
    window.dispatchEvent(new CustomEvent('funnl:open-add-contact'))
  }

  // Dismiss the activation progress strip for this session only.
  function dismissStrip() {
    if (uid) writeSessionFlag(sessionDismissKey(uid))
    setStripDismissed(true)
  }

  // Reopen the strip after it was collapsed (clears session dismiss flag).
  // Restores focus to the button that was just activated (collapsed control).
  function reopenStrip() {
    if (uid) clearSessionFlag(sessionDismissKey(uid))
    setStripDismissed(false)
    // Focus restoration: the collapsed button unmounts and the strip takes its place.
    // We defer by one frame so the strip DOM is mounted before requestAnimationFrame fires.
    requestAnimationFrame(() => {
      // Nothing specific to focus inside the strip — let natural focus order apply.
    })
  }

  // Skip the welcome card — persists to localStorage so it doesn't reappear next session.
  function skipWelcome() {
    if (uid) writeLocalFlag(welcomeSkipKey(uid))
    setWelcomeSkipped(true)
  }

  const addContactBtn = (
    <button
      onClick={openAddContactDrawer}
      className="flex items-center gap-[6px] text-[13px] font-semibold px-[13px] h-[32px] rounded-[8px] transition-opacity hover:opacity-90"
      style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14"/>
      </svg>
      Add contact
    </button>
  )

  // ── Drawers / modals (rendered outside the page layout) ──────────────────
  const drawersAndModals = (
    <>
      {showImportModal && (
        <ImportContactsModal
          onClose={() => setShowImportModal(false)}
          onImported={() => { setShowImportModal(false); fetchAll() }}
        />
      )}
      {pickerMode !== null && (
        <ContactPickerModal
          title={pickerMode === 'interaction' ? 'Log an interaction' : 'Create a follow-up'}
          onSelect={handlePickerSelect}
          onClose={() => setPickerMode(null)}
          onAddContact={() => { setPickerMode(null); openAddContactDrawer() }}
          contacts={loading ? undefined : contacts}
        />
      )}
    </>
  )

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <>
        <TopBar
          title="Home"
          searchPlaceholder="Find, log, or ask anything…"
          onSearchClick={openCommandPalette}
          cta={addContactBtn}
        />
        <div className="flex items-center justify-center py-24">
          <p className="text-[13px] font-mono" style={{ color: 'var(--color-muted)' }}>Loading…</p>
        </div>
      </>
    )
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (fetchError) {
    return (
      <>
        <TopBar title="Home" searchPlaceholder="Find, log, or ask anything…" onSearchClick={openCommandPalette} cta={addContactBtn} />
        <div className="flex items-center justify-center p-8">
          <div className="text-center max-w-xs">
            <p className="text-[14px] font-semibold mb-[6px]" style={{ color: 'var(--color-hi)' }}>
              Couldn't load your dashboard
            </p>
            <p className="text-[13px] mb-[16px]" style={{ color: 'var(--color-muted)' }}>
              Check your connection and try again.
            </p>
            <button
              onClick={fetchAll}
              className="text-[13px] font-semibold"
              style={{ color: 'var(--color-accent)' }}
            >
              Try again
            </button>
          </div>
        </div>
      </>
    )
  }

  // ── Derived render state ──────────────────────────────────────────────────
  const today        = getLocalToday()
  const activation   = deriveActivationState({
    milestones,
    contactCount,
    hasInteraction: interactionCount > 0,
    hasFollowUp,
    loading: false,   // loading state already handled above — we never reach here while loading
    queryError: false, // same for error state
    welcomeSkipped,
    stripDismissed,
    justCompleted,
  })
  const {
    displayMode,
    contactsComplete: step1Done,
    interactionComplete: step2Done,
    followupComplete: step3Done,
    completedCount,
    nextAction: derivedNextAction,
  } = activation
  const networkSignal = computeNetworkSignal(signals, interactionsThisWeek, awaitingResponseCount, contactCount)
  const hasOverdue = followUpsDueList.some(d => d.interaction.follow_up_date < today)

  // Pulse strip stats — only include non-zero / interesting values.
  // Total contact count is omitted here; it already appears in the summary sentence above.
  const pulseStats = [
    newContactsThisWeek > 0 ? { label: 'NEW THIS WEEK', value: `+${newContactsThisWeek}` } : null,
    interactionCount > 0 ? { label: 'INTERACTIONS', value: String(interactionCount) } : null,
    awaitingResponseCount > 0 ? { label: 'AWAITING', value: String(awaitingResponseCount) } : null,
    responseRate !== null ? { label: 'RESPONSE RATE', value: `${responseRate}%` } : null,
    topTag ? { label: 'TOP TAG', value: topTag.toUpperCase() } : null,
  ].filter(Boolean)

  // ── State 1b: New user (zero contacts) — WelcomeCard ─────────────────────
  if (displayMode === 'welcome') {
    return (
      <>
        <TopBar
          title="Home"
          searchPlaceholder="Find, log, or ask anything…"
          onSearchClick={openCommandPalette}
          cta={addContactBtn}
        />
        <WelcomeCard
          displayName={displayName}
          onAdd={openAddContactDrawer}
          onImport={() => setShowImportModal(true)}
          onSkip={skipWelcome}
        />
        {drawersAndModals}
      </>
    )
  }

  // ── State 1a: Populated dashboard ────────────────────────────────────────
  return (
    <>
      <TopBar
        title="Home"
        searchPlaceholder="Find, log, or ask anything…"
        onSearchClick={openCommandPalette}
        cta={addContactBtn}
      />

      {/* ── Network summary + pulse strip ─────────────────────────────────── */}
      <div className="border-b border-line-1">
        {/* Summary sentence */}
        <div className="px-[20px] md:px-[28px] pt-[20px] pb-[14px]">
          <p className="text-[15px] md:text-[16px] leading-relaxed" style={{ color: 'var(--color-hi)' }}>
            <strong>{contactCount}</strong> contact{contactCount !== 1 ? 's' : ''} in your network.{' '}
            {interactionsThisWeek > 0 ? (
              <span style={{ color: 'var(--color-success)' }}>
                +{interactionsThisWeek} interaction{interactionsThisWeek !== 1 ? 's' : ''} this week.
              </span>
            ) : (
              <span style={{ color: 'var(--color-muted)' }}>No interactions logged this week.</span>
            )}
            {followUpsDueList.length > 0 && (
              <>{' '}<span style={{ color: hasOverdue ? 'var(--color-danger)' : 'var(--color-warning)' }}>
                {followUpsDueList.length} follow-up{followUpsDueList.length !== 1 ? 's' : ''} due.
              </span></>
            )}
          </p>
        </div>

        {/* Pulse strip — full-width, horizontally scrollable */}
        <div className="flex overflow-x-auto border-t border-line-1" style={{ scrollbarWidth: 'none' }}>
          {pulseStats.map((stat, i) => (
            <div
              key={stat.label}
              className={`flex items-center gap-[10px] px-[18px] md:px-[22px] py-[8px] flex-none${i < pulseStats.length - 1 ? ' border-r border-line-1' : ''}`}
            >
              <span
                className="text-[9px] font-mono font-medium uppercase tracking-[0.09em] whitespace-nowrap"
                style={{ color: 'var(--color-low)' }}
              >
                {stat.label}
              </span>
              <span
                className="text-[13px] font-mono font-semibold whitespace-nowrap tabular-nums"
                style={{ color: 'var(--color-hi)' }}
              >
                {stat.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="px-[20px] md:px-[28px] py-[20px] space-y-[20px]">

        {/* Collapsed reopen control — shown when strip was dismissed.
            Renders as a slim row so it doesn't displace layout. */}
        {displayMode === 'collapsed' && (
          <button
            ref={collapsedBtnRef}
            onClick={reopenStrip}
            aria-label="Show setup progress"
            className="flex items-center gap-[8px] border-0 bg-transparent cursor-pointer rounded-[8px] px-[4px] py-[4px]"
            style={{ color: 'var(--color-low)' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--color-hi)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--color-low)'}
            onFocus={e => { e.currentTarget.style.outline = '2px solid var(--color-ember)'; e.currentTarget.style.outlineOffset = '2px' }}
            onBlur={e => { e.currentTarget.style.outline = ''; e.currentTarget.style.outlineOffset = '' }}
          >
            {/* Sacred funnel with dot indicator — dot uses border not color alone */}
            <div style={{ position: 'relative', width: 16, height: 14, flexShrink: 0 }}>
              <svg width="16" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#FF4423" opacity="0.5"/>
              </svg>
              <span
                style={{
                  position: 'absolute', top: -2, right: -2, width: 6, height: 6,
                  borderRadius: '50%', background: 'var(--color-ember)',
                  border: '1.5px solid var(--color-surface)',
                }}
              />
            </div>
            <span className="text-[11px] font-semibold">Show setup progress</span>
          </button>
        )}

        {/* Onboarding strip — shown based on displayMode */}
        {displayMode === 'compact' && (
          <ActivationProgressStrip
            step1Done={step1Done}
            step2Done={step2Done}
            step3Done={step3Done}
            completedCount={completedCount}
            ariaLabel={buildProgressAriaLabel(step1Done, step2Done, step3Done)}
            onDismiss={dismissStrip}
            onNextAction={() => {
              if (!derivedNextAction) return
              const result = resolveActivationAction(derivedNextAction.action, contacts)
              if (result.type === 'open_drawer') openAddContactDrawer()
              else if (result.type === 'navigate') navigate(`/contacts/${result.contactId}`, { state: buildPickerNavigationState(result.mode) })
              else if (result.type === 'open_picker') setPickerMode(result.mode)
            }}
          />
        )}
        {displayMode === 'newly_completed' && <CompletionStrip />}

        {/* Two-column grid: left wider, right rail */}
        <div className="grid grid-cols-1 md:grid-cols-[1.75fr_1fr] gap-[20px] items-start">

          {/* ── Left column ──────────────────────────────────────────────── */}
          <div className="space-y-[20px]">

            {/* NETWORK SIGNAL — rule-based, shown to ALL users.
                Uses always-dark ink gradient so light text is readable in both themes.
                AI_WEEKLY_INSIGHT_ENABLED = false guards against an uncached LLM call
                on every Dashboard mount. When the true AI insight is ready, it will
                replace the text below behind this flag. */}
            <div
              className="rounded-[14px] p-[18px] md:p-[20px]"
              style={{ background: 'var(--banner-gradient)', border: '1px solid rgba(247,242,231,0.09)' }}
            >
              <div className="flex items-start gap-[12px]">
                <div
                  className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center flex-none mt-[1px]"
                  style={{ background: 'var(--color-ember)' }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="rgba(247,242,231,0.95)"/>
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className="text-[10px] font-mono font-medium uppercase tracking-[0.1em] mb-[6px]"
                    style={{ color: 'rgba(247,242,231,0.4)' }}
                  >
                    Network signal
                  </p>
                  <p
                    className="text-[13.5px] leading-relaxed"
                    style={{ color: 'rgba(247,242,231,0.88)' }}
                  >
                    {networkSignal}
                  </p>
                  {canUsePro && (
                    <div className="mt-[12px]">
                      <Link
                        to="/ai"
                        className="text-[12px] font-semibold no-underline"
                        style={{ color: 'var(--color-ember)' }}
                      >
                        Ask Funnl AI for more
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Recent activity: contacts added + interactions, combined */}
            {recentActivity.length > 0 && (
              <div
                className="rounded-[14px] border border-line-2 overflow-hidden"
                style={{ background: 'var(--color-card)' }}
              >
                <div className="px-[18px] py-[13px] border-b border-line-1">
                  <h3 className="text-[13px] font-semibold" style={{ color: 'var(--color-hi)' }}>
                    Recent activity
                  </h3>
                </div>
                <div>
                  {recentActivity.map((item, i) => (
                    <ActivityRow
                      key={item.id}
                      item={item}
                      today={today}
                      isLast={i === recentActivity.length - 1}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Right rail ───────────────────────────────────────────────── */}
          <div className="space-y-[20px]">

            {/* Compact follow-ups */}
            <div
              className="rounded-[14px] border border-line-2 overflow-hidden"
              style={{ background: 'var(--color-card)' }}
            >
              <div className="px-[18px] py-[13px] flex items-center justify-between border-b border-line-1">
                <h3 className="text-[13px] font-semibold" style={{ color: 'var(--color-hi)' }}>
                  Follow-ups due
                </h3>
                {followUpsDueList.length > 0 && (
                  <Link
                    to="/followups"
                    className="text-[11.5px] font-semibold no-underline"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    View all
                  </Link>
                )}
              </div>

              {followUpsDueList.length === 0 ? (
                <div className="px-[18px] py-[20px]">
                  <p className="text-[13px]" style={{ color: 'var(--color-muted)' }}>All caught up.</p>
                  <p className="text-[12px] mt-[2px]" style={{ color: 'var(--color-low)' }}>No follow-ups due right now.</p>
                </div>
              ) : (
                <>
                  {followUpsDueList.slice(0, 5).map(({ interaction: ixn, contact }, idx) => {
                    const name = contact?.name || 'Unknown'
                    const { label, color } = followUpLabel(ixn.follow_up_date, today)
                    return (
                      <Link
                        key={ixn.id}
                        to={`/contacts/${ixn.contact_id}`}
                        className={`flex items-center gap-[10px] px-[18px] py-[11px] no-underline transition-colors${idx < Math.min(followUpsDueList.length, 5) - 1 ? ' border-b border-line-1' : ''}`}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(20,17,15,0.03)'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}
                      >
                        <div
                          className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center text-[11px] font-bold flex-none"
                          style={{ background: getAvatarColor(name), color: 'var(--color-paper)' }}
                        >
                          {getInitials(name)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--color-hi)' }}>
                            {name}
                          </p>
                          <p className="text-[11px] truncate" style={{ color: 'var(--color-muted)' }}>
                            {ixn.type}
                          </p>
                        </div>
                        <span
                          className="text-[10px] font-mono flex-none whitespace-nowrap"
                          style={{ color }}
                        >
                          {label}
                        </span>
                      </Link>
                    )
                  })}
                  {followUpsDueList.length > 5 && (
                    <Link
                      to="/followups"
                      className="flex items-center justify-center py-[10px] text-[12px] font-semibold no-underline border-t border-line-1 transition-colors"
                      style={{ color: 'var(--color-accent)' }}
                    >
                      +{followUpsDueList.length - 5} more
                    </Link>
                  )}
                </>
              )}
            </div>

            {/* Top firms — compact secondary telemetry */}
            <TopFirmsCard firms={topFirms} />

            {/* Quick actions — Log an interaction, Create a follow-up, Import contacts */}
            <div
              className="rounded-[14px] border border-line-2 overflow-hidden"
              style={{ background: 'var(--color-card)' }}
            >
              <div className="px-[18px] py-[13px] border-b border-line-1">
                <h3 className="text-[13px] font-semibold" style={{ color: 'var(--color-hi)' }}>Quick actions</h3>
              </div>
              <div className="p-[8px] space-y-[1px]">
                {/* Log an interaction — opens contact picker → navigates with openInteractionForm */}
                <button
                  onClick={() => setPickerMode('interaction')}
                  className="w-full flex items-center gap-[10px] px-[10px] py-[9px] rounded-[8px] text-left transition-colors"
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(20,17,15,0.04)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <span
                    className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center flex-none"
                    style={{ background: 'var(--color-elevated)' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                  </span>
                  <span className="text-[13px] font-medium" style={{ color: 'var(--color-hi)' }}>Log an interaction</span>
                </button>

                {/* Create a follow-up — opens contact picker → navigates with openFollowUpForm */}
                <button
                  onClick={() => setPickerMode('followup')}
                  className="w-full flex items-center gap-[10px] px-[10px] py-[9px] rounded-[8px] text-left transition-colors"
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(20,17,15,0.04)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <span
                    className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center flex-none"
                    style={{ background: 'var(--color-elevated)' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
                    </svg>
                  </span>
                  <span className="text-[13px] font-medium" style={{ color: 'var(--color-hi)' }}>Create a follow-up</span>
                </button>

                {/* Import contacts — opens ImportContactsModal */}
                <button
                  onClick={() => setShowImportModal(true)}
                  className="w-full flex items-center gap-[10px] px-[10px] py-[9px] rounded-[8px] text-left transition-colors"
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(20,17,15,0.04)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <span
                    className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center flex-none"
                    style={{ background: 'var(--color-elevated)' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                  </span>
                  <span className="text-[13px] font-medium" style={{ color: 'var(--color-hi)' }}>Import contacts</span>
                </button>
              </div>
            </div>

            {/* Funnl AI entry — Pro only (trial or permanent). Non-Pro: no teaser, no blank space. */}
            {canUsePro && (
              <div
                className="rounded-[14px] overflow-hidden"
                style={{ background: 'var(--banner-gradient)', border: '1px solid rgba(255,68,35,0.18)' }}
              >
                <div className="p-[16px]">
                  <div className="flex items-center gap-[8px] mb-[10px]">
                    <div
                      className="w-[18px] h-[18px] rounded-[5px] flex items-center justify-center flex-none"
                      style={{ background: 'var(--color-ember)' }}
                    >
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="rgba(247,242,231,0.95)"/>
                      </svg>
                    </div>
                    <span
                      className="text-[10px] font-mono font-medium uppercase tracking-[0.09em]"
                      style={{ color: 'rgba(247,242,231,0.45)' }}
                    >
                      Funnl AI
                    </span>
                  </div>
                  <Link
                    to="/ai"
                    className="flex items-center gap-[8px] px-[12px] py-[8px] rounded-[8px] no-underline"
                    style={{ background: 'rgba(247,242,231,0.07)', border: '1px solid rgba(247,242,231,0.11)' }}
                  >
                    <span
                      className="text-[12px] flex-1 truncate"
                      style={{ color: 'rgba(247,242,231,0.38)' }}
                    >
                      Ask anything about your network…
                    </span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(247,242,231,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14M12 5l7 7-7 7"/>
                    </svg>
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {drawersAndModals}
    </>
  )
}

export default DashboardPage
