import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { track } from '../lib/analytics'
import { useProStatus } from '../lib/useProStatus'
import { classifyProStatus, hasProAccess } from '../lib/pro-ui-status'
import { findDuplicate } from '../lib/contactFormUtils'
import { viewExistingRoute } from '../lib/interactionFormUtils'

function normalizeUrl(url) {
  const s = (url || '').trim()
  if (!s) return null
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return 'https://' + s
}

// Standard input (ember-tinted focus to match page theme)
const iCls = 'w-full bg-input border border-line-3 rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-lower outline-none focus:border-[rgba(255,68,35,0.4)] transition-colors'
// AI-filled input — restrained ember tint so the highlight is distinct but subtle
const iClsAI = 'w-full bg-[rgba(255,68,35,0.05)] border border-[rgba(255,68,35,0.3)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-lower outline-none focus:border-[rgba(255,68,35,0.4)] transition-colors'
const sCls = `${iCls} cursor-pointer`
const lCls = 'mb-[7px] block text-[12.5px] font-semibold text-mid'

// contact=null  → add mode; all fields start empty
// contact={...} → edit mode; fields pre-populated from contact object
// contacts=[..] → list of existing contacts for duplicate detection (pass [] to skip)
// onSuccess({ id, isFirstContact }) → called after successful save.
//   Add mode: isFirstContact=true when this was the user's very first contact.
//   Edit mode: isFirstContact is always false.
function AddContactDrawer({ contact, contacts = [], onClose, onSuccess, initialName = '' }) {
  const isEditMode = !!contact
  const navigate = useNavigate()

  // Form fields — pre-populated in edit mode; initialName pre-fills name in add mode
  const [name,             setName]             = useState(contact?.name               ?? initialName   ?? '')
  const [company,          setCompany]          = useState(contact?.company             ?? '')
  const [role,             setRole]             = useState(contact?.role                ?? '')
  const [howMet,           setHowMet]           = useState(contact?.how_met             ?? '')
  const [relationshipType, setRelationshipType] = useState(contact?.relationship_type   ?? '')
  const [relationshipNote, setRelationshipNote] = useState(contact?.relationship_note   ?? '')
  const [email,            setEmail]            = useState(contact?.email               ?? '')
  const [linkedinUrl,      setLinkedinUrl]      = useState(contact?.linkedin_url        ?? '')
  const [tagsInput,        setTagsInput]        = useState(
    contact?.tags ? contact.tags.join(', ') : ''
  )
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState('')

  // Pro status for AI Fill gate (add mode only)
  const proStatus = useProStatus()
  const proClass  = classifyProStatus(proStatus)
  const showAIFill = !isEditMode && hasProAccess(proStatus)

  // AI Fill state
  const [aiText,              setAiText]              = useState('')
  const [aiLoading,           setAiLoading]           = useState(false)
  const [aiError,             setAiError]             = useState('')
  const [aiFilledFields,      setAiFilledFields]      = useState(new Set())
  const [aiFollowUpSuggestion, setAiFollowUpSuggestion] = useState('')

  // Live duplicate check (excluding self in edit mode)
  const duplicate = findDuplicate(contacts, name, company, isEditMode ? contact?.id : undefined)

  const drawerRef       = useRef(null)
  const restoreFocusRef = useRef(null)

  // Snapshot focused element on mount; restore it when drawer unmounts
  useEffect(() => {
    restoreFocusRef.current = document.activeElement
    return () => {
      try { restoreFocusRef.current?.focus() } catch (_) {}
    }
  }, [])

  // Focus trap: Tab/Shift+Tab cycles within the drawer; Escape closes
  useEffect(() => {
    const el = drawerRef.current
    if (!el) return

    function getFocusable() {
      return [...el.querySelectorAll(
        'input, select, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter(n => !n.disabled && getComputedStyle(n).display !== 'none')
    }

    function onKey(e) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      const els = getFocusable()
      if (!els.length) return
      const first = els[0]
      const last  = els[els.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Scroll-lock the main content area while drawer is open
  useEffect(() => {
    const mainEl = document.querySelector('main')
    if (!mainEl) return
    mainEl.style.overflowY = 'hidden'
    return () => { mainEl.style.overflowY = '' }
  }, [])

  function inputCls(field) {
    return aiFilledFields.has(field) ? iClsAI : iCls
  }

  function clearAiFill(field) {
    setAiFilledFields(prev => {
      const next = new Set(prev)
      next.delete(field)
      return next
    })
  }

  async function handleAIParse() {
    if (!aiText.trim()) return
    setAiLoading(true)
    setAiError('')
    setAiFilledFields(new Set())
    setAiFollowUpSuggestion('')

    const { data, error: fnError } = await supabase.functions.invoke('ai-parse-contact', {
      body: { text: aiText },
    })

    setAiLoading(false)

    if (fnError || data?.error) {
      setAiError(fnError?.message || data?.error || 'Something went wrong — please try again.')
      return
    }

    const parsed = data?.contact
    if (!parsed || typeof parsed !== 'object') {
      setAiError('Could not parse the text — please try again.')
      return
    }

    const filled = new Set()
    if (parsed.name)              { setName(parsed.name);                          filled.add('name') }
    if (parsed.company)           { setCompany(parsed.company);                    filled.add('company') }
    if (parsed.role)              { setRole(parsed.role);                          filled.add('role') }
    if (parsed.how_met)           { setHowMet(parsed.how_met);                     filled.add('howMet') }
    if (parsed.email)             { setEmail(parsed.email);                        filled.add('email') }
    if (parsed.linkedin_url)      { setLinkedinUrl(parsed.linkedin_url);           filled.add('linkedinUrl') }
    if (parsed.tags?.length)      { setTagsInput(parsed.tags.join(', '));          filled.add('tags') }
    if (parsed.relationship_note) { setRelationshipNote(parsed.relationship_note); filled.add('relationshipNote') }

    setAiFilledFields(filled)
    track('ai_fill_used', { fields_filled: filled.size })

    if (parsed.follow_up_suggestion) setAiFollowUpSuggestion(parsed.follow_up_suggestion)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    const trimmedName = name.trim()
    if (!trimmedName) { setError('Name is required.'); return }

    setSubmitting(true)
    const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean)
    const payload = {
      name:              trimmedName,
      company:           company || null,
      role:              role || null,
      how_met:           howMet || null,
      email:             email || null,
      linkedin_url:      normalizeUrl(linkedinUrl),
      tags:              tags.length > 0 ? tags : null,
      relationship_type: relationshipType || null,
      relationship_note: relationshipNote.trim() || null,
    }

    if (isEditMode) {
      const { error: updateError } = await supabase.from('contacts').update(payload).eq('id', contact.id)
      setSubmitting(false)
      if (updateError) { setError(updateError.message); return }
      onSuccess?.({ id: contact.id, isFirstContact: false })
    } else {
      const { data: newContact, error: insertError } = await supabase
        .from('contacts').insert([payload]).select('id').single()
      setSubmitting(false)
      if (insertError) { setError(insertError.message); return }

      track('contact_added', {
        via_ai_fill: aiFilledFields.size > 0,
        has_tags: tags.length > 0,
        has_relationship_type: !!relationshipType,
      })

      // Post-insert count query is authoritative: if count===1 this is the first contact.
      const { count } = await supabase.from('contacts').select('id', { count: 'exact', head: true })
      const isFirstContact = count === 1
      if (isFirstContact) track('first_contact_added')

      onSuccess?.({ id: newContact?.id ?? null, isFirstContact })
    }
  }

  const title     = isEditMode ? 'Edit contact' : 'Add contact'
  const saveLabel = submitting ? 'Saving…' : isEditMode ? 'Save changes' : 'Save contact'

  return (
    <form
      ref={drawerRef}
      onSubmit={handleSubmit}
      className="fixed inset-y-0 right-0 w-full md:w-[440px] z-50 flex flex-col"
      style={{
        background: 'var(--color-card)',
        borderLeft: '1px solid var(--color-line-3)',
        boxShadow: '-30px 0 60px rgba(0,0,0,0.3)',
        animation: 'slide-in-right 0.25s ease-out',
      }}
      aria-label={title}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-[26px] py-[22px] border-b border-line-1 flex-none">
        <h2 className="font-display text-[18px] font-bold text-hi">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="w-[34px] h-[34px] rounded-[9px] border border-line-2 flex items-center justify-center hover:border-line-3 transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--color-ember)]"
          style={{ background: 'var(--color-elevated)' }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-mid)" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-[26px] py-[22px] space-y-4">

        {/* ── AI Fill (add mode + Pro/trial only) ── */}
        {showAIFill && (
          <div className="p-4 rounded-xl border border-[rgba(255,68,35,0.18)]" style={{ background: 'var(--color-elevated)' }}>
            <div className="flex items-center gap-2 mb-3">
              <svg width="14" height="14" viewBox="0 0 24 24" style={{ fill: 'var(--color-ember)' }}>
                <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
              </svg>
              <span className="text-[13px] font-bold text-hi">AI Fill</span>
              <span
                className="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded-[5px] tracking-[0.5px]"
                style={{ color: 'var(--color-ember)', background: 'rgba(255,68,35,0.1)' }}
              >
                {proClass === 'trial' ? 'TRIAL' : 'PRO'}
              </span>
            </div>

            <textarea
              value={aiText}
              onChange={e => setAiText(e.target.value)}
              placeholder="Paste anything about this person — name, company, where you met, follow-up timing…"
              rows={3}
              className="w-full bg-input border border-line-3 rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-lower outline-none focus:border-[rgba(255,68,35,0.4)] transition-colors resize-none"
            />

            {aiError && (
              <p className="text-[12px] mt-2" style={{ color: 'var(--color-danger)' }}>{aiError}</p>
            )}

            <button
              type="button"
              onClick={handleAIParse}
              disabled={aiLoading || !aiText.trim()}
              className="mt-2.5 w-full flex items-center justify-center gap-2 text-[13px] font-bold rounded-[10px] py-2.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                color: 'var(--color-ember)',
                background: 'rgba(255,68,35,0.07)',
                borderColor: 'rgba(255,68,35,0.3)',
              }}
              onMouseEnter={e => !e.currentTarget.disabled && (e.currentTarget.style.background = 'rgba(255,68,35,0.12)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,68,35,0.07)')}
            >
              {aiLoading ? (
                <>
                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                  Parsing…
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
                  </svg>
                  Parse with AI
                </>
              )}
            </button>

            {aiFilledFields.size > 0 && (
              <p className="text-[11px] text-muted mt-2.5 text-center leading-relaxed">
                AI-filled fields are highlighted — review before saving.
              </p>
            )}

            {aiFollowUpSuggestion && (
              <div className="mt-2.5 flex items-start gap-2 px-3 py-2 rounded-lg border border-[rgba(255,184,77,0.2)]" style={{ background: 'rgba(255,184,77,0.08)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#FFB84D" strokeWidth="2" strokeLinecap="round" className="flex-none mt-[1px]">
                  <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
                </svg>
                <p className="text-[11.5px] text-warning leading-relaxed">
                  Reminder: follow up in <strong>{aiFollowUpSuggestion}</strong> — add the date when you log an interaction.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Duplicate warning ── */}
        {duplicate && (
          <div
            className="flex items-start gap-3 px-4 py-3 rounded-xl border border-[rgba(255,184,77,0.3)]"
            style={{ background: 'rgba(255,184,77,0.07)' }}
            role="alert"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" strokeWidth="2" strokeLinecap="round" className="flex-none mt-[1px]">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] leading-relaxed text-warning">
                <strong>{duplicate.name}</strong>
                {duplicate.company ? ` at ${duplicate.company}` : ''} already exists.
                You can still save if this is a different person.
              </p>
              <button
                type="button"
                onClick={() => {
                  const route = viewExistingRoute(duplicate.id)
                  onClose()
                  if (route) navigate(route)
                }}
                className="mt-1.5 text-[12px] font-semibold text-warning underline underline-offset-2 hover:opacity-75 transition-opacity"
              >
                View existing →
              </button>
            </div>
          </div>
        )}

        {/* ── Name ── */}
        <div>
          <label className={lCls}>
            Name <span style={{ color: 'var(--color-ember)' }}>*</span>
          </label>
          <input
            value={name}
            onChange={e => { setName(e.target.value); clearAiFill('name') }}
            required
            autoFocus={!isEditMode}
            className={inputCls('name')}
            placeholder="Full name"
          />
        </div>

        {/* ── Company + Role ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={lCls}>Company</label>
            <input
              value={company}
              onChange={e => { setCompany(e.target.value); clearAiFill('company') }}
              className={inputCls('company')}
              placeholder="Goldman Sachs"
            />
          </div>
          <div>
            <label className={lCls}>Role</label>
            <input
              value={role}
              onChange={e => { setRole(e.target.value); clearAiFill('role') }}
              className={inputCls('role')}
              placeholder="Summer Analyst"
            />
          </div>
        </div>

        {/* ── How you met ── */}
        <div>
          <label className={lCls}>How you met</label>
          <input
            value={howMet}
            onChange={e => { setHowMet(e.target.value); clearAiFill('howMet') }}
            className={inputCls('howMet')}
            placeholder="Spring Career Fair"
          />
        </div>

        {/* ── Relationship type + Tags ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={lCls}>Relationship type</label>
            <select
              value={relationshipType}
              onChange={e => setRelationshipType(e.target.value)}
              className={sCls}
            >
              <option value="">— not set —</option>
              <option>Mentor</option>
              <option>Collaborator</option>
              <option>Referral path</option>
              <option>Potential employer</option>
              <option>Connector</option>
              <option>Other</option>
            </select>
          </div>
          <div>
            <label className={lCls}>Tags</label>
            <input
              value={tagsInput}
              onChange={e => { setTagsInput(e.target.value); clearAiFill('tags') }}
              className={inputCls('tags')}
              placeholder="alumni, recruiter"
            />
            <p className="mt-1.5 text-[11px] text-lower">Comma-separated</p>
          </div>
        </div>

        {/* ── Why this person matters ── */}
        <div>
          <label className={lCls}>Why this person matters</label>
          <input
            value={relationshipNote}
            onChange={e => { setRelationshipNote(e.target.value); clearAiFill('relationshipNote') }}
            className={inputCls('relationshipNote')}
            placeholder="e.g. Can intro me to the PM team at Stripe"
          />
        </div>

        {/* ── Email ── */}
        <div>
          <label className={lCls}>Email</label>
          <input
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); clearAiFill('email') }}
            className={inputCls('email')}
            placeholder="name@company.com"
          />
        </div>

        {/* ── LinkedIn URL ── */}
        <div>
          <label className={lCls}>LinkedIn URL</label>
          <input
            value={linkedinUrl}
            onChange={e => { setLinkedinUrl(e.target.value); clearAiFill('linkedinUrl') }}
            className={inputCls('linkedinUrl')}
            placeholder="linkedin.com/in/…"
          />
        </div>

        {error && (
          <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p>
        )}
      </div>

      {/* Sticky footer */}
      <div className="flex gap-[10px] px-[26px] py-[18px] border-t border-line-1 flex-none">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 text-[14px] font-semibold rounded-[11px] py-3 border border-line-2 hover:border-line-3 transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--color-ember)]"
          style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 text-[14px] font-bold rounded-[11px] py-3 hover:opacity-90 transition-opacity disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-[var(--color-ember)]"
          style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}
        >
          {saveLabel}
        </button>
      </div>
    </form>
  )
}

export default AddContactDrawer
