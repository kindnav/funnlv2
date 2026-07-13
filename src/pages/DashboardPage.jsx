import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AddContactDrawer from '../components/AddContactDrawer'
import ImportContactsModal from '../components/ImportContactsModal'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import { track } from '../lib/analytics'

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

function ChecklistStep({ done, label, children }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-[rgba(255,255,255,0.05)] last:border-b-0">
      {done ? (
        <div className="w-5 h-5 rounded-full bg-[rgba(47,212,182,0.15)] border border-[rgba(47,212,182,0.35)] flex items-center justify-center flex-none mt-[1px]">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l4.5 4.5L19 7"/>
          </svg>
        </div>
      ) : (
        <div className="w-5 h-5 rounded-full border-2 border-[rgba(255,255,255,0.15)] flex-none mt-[1px]"/>
      )}
      <div className="flex-1 min-w-0">
        <p className={`text-[13.5px] font-semibold ${done ? 'text-low' : 'text-hi'}`}>{label}</p>
        {!done && children && <div className="mt-1.5">{children}</div>}
      </div>
    </div>
  )
}

function DashboardPage() {
  const navigate = useNavigate()
  const [contactCount,       setContactCount]       = useState(0)
  const [interactionCount,   setInteractionCount]   = useState(0)
  const [newContactsWeek,    setNewContactsWeek]    = useState(0)
  const [newInteractionsWeek,setNewInteractionsWeek]= useState(0)
  const [dueToday,           setDueToday]           = useState(0)
  const [followUps,          setFollowUps]          = useState([])
  const [recentContacts,     setRecentContacts]     = useState([])
  const [hasFollowUp,        setHasFollowUp]        = useState(false)
  const [milestones,         setMilestones]         = useState(null)
  const [loading,            setLoading]            = useState(true)
  const [fetchError,         setFetchError]         = useState('')
  const [showDrawer,         setShowDrawer]         = useState(false)
  const [showImportModal,    setShowImportModal]    = useState(false)

  // Fires once per DashboardPage mount when the checklist is visible.
  // If the user navigates away and back, the component remounts and this ref
  // resets, so the event may fire again on re-mount. Acceptable for phase 2A.
  const checklistViewedRef = useRef(false)

  useEffect(() => { fetchAll() }, [])

  // Fire activation_checklist_viewed once per mount when milestones load
  // and the user has not yet completed activation
  useEffect(() => {
    if (milestones && milestones.completed === null && !checklistViewedRef.current) {
      track('activation_checklist_viewed')
      checklistViewedRef.current = true
    }
  }, [milestones])

  async function fetchAll() {
    setFetchError('')
    setLoading(true)
    const today = getLocalToday()
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7)
    const weekAgoStr = weekAgo.toISOString()

    // getSession() is async. It normally reads browser storage but Supabase may
    // refresh the token if it has expired. The uid is used to scope the profiles
    // select; RLS is the authoritative authorization layer for all DB queries.
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) {
      setFetchError(sessionError.message)
      setLoading(false)
      return
    }
    const uid = sessionData?.session?.user?.id ?? null

    const [
      { count: contacts,       error: e1 },
      { count: interactions,   error: e2 },
      { count: newContacts,    error: e3 },
      { count: newInteractions,error: e4 },
      { count: todayDue,       error: e5 },
      { data:  followUpsData,  error: e6 },
      { data:  recentData,     error: e7 },
      { count: followUpCount,  error: e8 },
      { data:  profileData,    error: e9 },
    ] = await Promise.all([
      supabase.from('contacts').select('*', { count: 'exact', head: true }),
      supabase.from('interactions').select('*', { count: 'exact', head: true }),
      supabase.from('contacts').select('*', { count: 'exact', head: true }).gte('created_at', weekAgoStr),
      supabase.from('interactions').select('*', { count: 'exact', head: true }).gte('created_at', weekAgoStr),
      supabase.from('interactions').select('*', { count: 'exact', head: true }).eq('follow_up_date', today),
      supabase.from('interactions').select('*, contacts(id, name)').not('follow_up_date', 'is', null).lte('follow_up_date', today).order('follow_up_date', { ascending: true }),
      supabase.from('contacts').select('*').order('created_at', { ascending: false }).limit(5),
      supabase.from('interactions').select('*', { count: 'exact', head: true }).not('follow_up_date', 'is', null),
      uid
        ? supabase.from('profiles')
            .select('activation_five_contacts_at, activation_first_interaction_at, activation_first_followup_at, activation_completed_at')
            .eq('id', uid)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])

    const queryError = e1 || e2 || e3 || e4 || e5 || e6 || e7 || e8 || e9
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
    setHasFollowUp((followUpCount || 0) > 0)

    const ms = {
      fiveContacts:     profileData?.activation_five_contacts_at     ?? null,
      firstInteraction: profileData?.activation_first_interaction_at ?? null,
      firstFollowup:    profileData?.activation_first_followup_at    ?? null,
      completed:        profileData?.activation_completed_at         ?? null,
    }
    setMilestones(ms)
    setLoading(false)

    if (uid) {
      recordMilestones(uid, contacts || 0, interactions || 0, (followUpCount || 0) > 0, ms)
        .catch(err => console.error('[Funnl] recordMilestones threw unexpectedly:', err))
    }
  }

  async function recordMilestones(uid, contactCnt, interactionCnt, hasFollowUpBool, ms) {
    const now     = new Date().toISOString()
    const step1Met = contactCnt >= 5
    const step2Met = interactionCnt >= 1
    const step3Met = hasFollowUpBool

    // Conditional update: sets col to now only if it is still null in the DB.
    // If two tabs race, PostgreSQL serializes the writes; only the first gets a
    // non-empty RETURNING result. The second gets claimed === false and does not
    // fire a PostHog event.
    async function conditionalUpdate(col) {
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
    }

    // Process all three step milestones even if activation_completed_at is already
    // set, to repair any inconsistent null step timestamps.
    // Events fire only when ms.completed === null (user was not yet activated
    // when fetchAll ran); repairs to already-activated users never fire events.
    // Stop on DB error to prevent partially inconsistent writes.

    if (step1Met && ms.fiveContacts === null) {
      const { ok, claimed } = await conditionalUpdate('activation_five_contacts_at')
      if (!ok) return
      if (claimed && ms.completed === null) track('activation_step_completed', { step: 'five_contacts' })
    }

    if (step2Met && ms.firstInteraction === null) {
      const { ok, claimed } = await conditionalUpdate('activation_first_interaction_at')
      if (!ok) return
      if (claimed && ms.completed === null) track('activation_step_completed', { step: 'first_interaction' })
    }

    if (step3Met && ms.firstFollowup === null) {
      const { ok, claimed } = await conditionalUpdate('activation_first_followup_at')
      if (!ok) return
      if (claimed && ms.completed === null) track('activation_step_completed', { step: 'first_followup' })
    }

    // Only attempt activation_completed_at after all step updates succeed without
    // DB errors. claimed === false (another tab won the race) is not an error.
    if (step1Met && step2Met && step3Met && ms.completed === null) {
      const { ok, claimed } = await conditionalUpdate('activation_completed_at')
      if (!ok) return
      if (claimed) {
        track('activation_completed', { contacts_count: contactCnt })
        setMilestones(prev => prev ? { ...prev, completed: now } : prev)
      }
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-muted text-sm">Loading…</p>
      </div>
    )
  }

  // ── Error ─────────────────────────────────────────────────────────────────
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

  // ── Derived activation state ──────────────────────────────────────────────
  const step1Done = contactCount >= 5
  const step2Done = interactionCount >= 1
  const step3Done = hasFollowUp
  const stepsCompleted = [step1Done, step2Done, step3Done].filter(Boolean).length
  const showChecklist = milestones !== null && milestones.completed === null

  // ── Checklist card (shared between zero-contact and full-dashboard views) ─
  const checklistCard = (
    <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="font-display text-[16px] font-bold text-hi leading-snug">Set up your networking workflow</h3>
        <span className="font-mono text-[11px] font-bold text-muted flex-none mt-0.5">{stepsCompleted}/3</span>
      </div>
      <p className="text-[13px] text-muted leading-relaxed mb-4">
        Add the people you're speaking with, save the conversation, and choose when to follow up.
      </p>

      {/* Progress bar */}
      <div className="h-[3px] bg-[rgba(255,255,255,0.07)] rounded-full mb-5 overflow-hidden">
        <div
          className="h-full bg-[linear-gradient(90deg,#8B7CFF,#5B45F0)] rounded-full transition-all duration-500"
          style={{ width: `${Math.round((stepsCompleted / 3) * 100)}%` }}
        />
      </div>

      {/* Step 1 — Add or import 5 contacts */}
      <ChecklistStep done={step1Done} label="Add or import 5 contacts">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowDrawer(true)}
            className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white shadow-[0_4px_12px_rgba(91,69,240,0.3)] hover:opacity-90 transition-opacity"
          >
            Add contact
          </button>
          <button
            onClick={() => setShowImportModal(true)}
            className="text-[12.5px] font-semibold px-3 py-1.5 rounded-lg bg-elevated border border-[rgba(255,255,255,0.1)] text-mid hover:text-hi transition-colors"
          >
            Import CSV
          </button>
        </div>
      </ChecklistStep>

      {/* Step 2 — Log your first conversation */}
      <ChecklistStep done={step2Done} label="Log your first conversation">
        {contactCount > 0
          ? <Link to="/contacts" className="text-[12.5px] font-semibold text-accent hover:text-tag transition-colors no-underline">Go to contacts →</Link>
          : <p className="text-[12px] text-lower">Add a contact first</p>
        }
      </ChecklistStep>

      {/* Step 3 — Schedule your first follow-up */}
      <ChecklistStep done={step3Done} label="Schedule your first follow-up">
        {contactCount > 0
          ? <Link to="/contacts" className="text-[12.5px] font-semibold text-accent hover:text-tag transition-colors no-underline">Go to contacts →</Link>
          : <p className="text-[12px] text-lower">Add a contact first</p>
        }
      </ChecklistStep>
    </div>
  )

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <>
      {/* Zero-contact: centered checklist replaces the old standalone CTA */}
      {contactCount === 0 && (
        <div className="min-h-screen bg-surface flex items-center justify-center p-6 md:p-12">
          <div className="w-full max-w-md">
            {checklistCard}
          </div>
        </div>
      )}

      {/* Full dashboard */}
      {contactCount > 0 && (
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

          {/* Activation checklist — visible until activation_completed_at is set */}
          {showChecklist && <div className="mb-5">{checklistCard}</div>}

          {/* Stat cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">

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

          {/* Funnl AI teaser banner */}
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
        </div>
      )}

      {/* Drawers and modals — shared between zero-contact and full-dashboard states */}
      {showDrawer && (
        <>
          <div
            className="fixed inset-0 md:left-[248px] bg-[rgba(6,6,8,0.55)] z-40"
            onClick={() => setShowDrawer(false)}
            style={{ animation: 'fade-in 0.2s ease-out' }}
          />
          <AddContactDrawer
            onClose={() => setShowDrawer(false)}
            onSuccess={(newId) => {
              setShowDrawer(false)
              if (contactCount === 0 && newId) {
                navigate(`/contacts/${newId}`, { state: { openInteractionForm: true } })
              } else {
                fetchAll()
              }
            }}
          />
        </>
      )}
      {showImportModal && (
        <ImportContactsModal
          onClose={() => setShowImportModal(false)}
          onImported={() => { setShowImportModal(false); fetchAll() }}
        />
      )}
    </>
  )
}

export default DashboardPage
