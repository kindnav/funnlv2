import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { canUseAI } from '../lib/ai'

function normalizeUrl(url) {
  const s = url.trim()
  if (!s) return null
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return 'https://' + s
}

const iCls = 'w-full bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors'
const iClsAI = 'w-full bg-[rgba(139,124,255,0.06)] border border-[rgba(139,124,255,0.35)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors'
const lCls = 'mb-[7px] block text-[12.5px] font-semibold text-mid'

function AddContactDrawer({ onClose, onSuccess }) {
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('')
  const [howMet, setHowMet] = useState('')
  const [email, setEmail] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [skillsInput, setSkillsInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // AI Fill state
  const [isProUser, setIsProUser] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiFilledFields, setAiFilledFields] = useState(new Set())
  const [aiFollowUpSuggestion, setAiFollowUpSuggestion] = useState('')

  // Check Pro status on mount
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) canUseAI(data.user.id).then(setIsProUser)
    })
  }, [])

  // Close on Escape key
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Lock background scroll while drawer is open
  useEffect(() => {
    const mainEl = document.querySelector('main')
    if (!mainEl) return
    mainEl.style.overflowY = 'hidden'
    return () => { mainEl.style.overflowY = '' }
  }, [])

  // Returns the highlighted input class if AI filled this field, otherwise the standard class
  function inputCls(field) {
    return aiFilledFields.has(field) ? iClsAI : iCls
  }

  // When the user manually edits an AI-filled field, remove its highlight
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

    const contact = data?.contact
    if (!contact || typeof contact !== 'object') {
      setAiError('Could not parse the text — please try again.')
      return
    }

    // Fill form fields and track which ones were filled so they can be highlighted
    const filled = new Set()
    if (contact.name)            { setName(contact.name);                       filled.add('name') }
    if (contact.company)         { setCompany(contact.company);                 filled.add('company') }
    if (contact.role)            { setRole(contact.role);                       filled.add('role') }
    if (contact.how_met)         { setHowMet(contact.how_met);                  filled.add('howMet') }
    if (contact.email)           { setEmail(contact.email);                     filled.add('email') }
    if (contact.linkedin_url)    { setLinkedinUrl(contact.linkedin_url);        filled.add('linkedinUrl') }
    if (contact.tags?.length)    { setTagsInput(contact.tags.join(', '));       filled.add('tags') }
    if (contact.skills?.length)  { setSkillsInput(contact.skills.join(', '));   filled.add('skills') }

    setAiFilledFields(filled)

    // follow_up_suggestion lives on interactions, not contacts — show it as a reminder
    if (contact.follow_up_suggestion) {
      setAiFollowUpSuggestion(contact.follow_up_suggestion)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Name is required.')
      return
    }

    setSubmitting(true)

    const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean)
    const skills = skillsInput.split(',').map(s => s.trim()).filter(Boolean)

    const { error } = await supabase.from('contacts').insert([{
      name: trimmedName,
      company: company || null,
      role: role || null,
      how_met: howMet || null,
      email: email || null,
      linkedin_url: normalizeUrl(linkedinUrl),
      tags: tags.length > 0 ? tags : null,
      skills: skills.length > 0 ? skills : null,
    }])

    setSubmitting(false)

    if (error) {
      setError(error.message)
      return
    }

    onSuccess()
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="fixed inset-y-0 right-0 w-full md:w-[452px] bg-[#0E0E12] border-l border-[rgba(255,255,255,0.09)] z-50 flex flex-col shadow-[-30px_0_60px_rgba(0,0,0,0.5)]"
      style={{ animation: 'slide-in-right 0.25s ease-out' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-[26px] py-[22px] border-b border-[rgba(255,255,255,0.06)] flex-none">
        <h2 className="font-display text-[19px] font-bold text-hi">Add contact</h2>
        <button
          type="button"
          onClick={onClose}
          className="w-[34px] h-[34px] rounded-[9px] bg-elevated border border-[rgba(255,255,255,0.08)] flex items-center justify-center hover:border-[rgba(255,255,255,0.18)] transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#A0A0AD" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>
      </div>

      {/* Scrollable form body */}
      <div className="flex-1 overflow-y-auto px-[26px] py-[22px] space-y-4">

        {/* ── AI Fill section (Pro users only) ── */}
        {isProUser && (
          <div className="p-4 bg-elevated border border-[rgba(139,124,255,0.22)] rounded-xl">
            {/* Label row */}
            <div className="flex items-center gap-2 mb-3">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#8B7CFF">
                <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
              </svg>
              <span className="text-[13px] font-bold text-hi">AI Fill</span>
              <span className="text-[10px] font-bold font-mono text-accent bg-[rgba(139,124,255,0.15)] px-1.5 py-0.5 rounded-[5px] tracking-[0.5px]">PRO</span>
            </div>

            {/* Textarea */}
            <textarea
              value={aiText}
              onChange={e => setAiText(e.target.value)}
              placeholder="Paste anything about this person — name, company, where you met, skills, follow-up timing..."
              rows={3}
              className="w-full bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors resize-none"
            />

            {/* Error */}
            {aiError && (
              <p className="text-[12px] text-danger mt-2">{aiError}</p>
            )}

            {/* Parse button */}
            <button
              type="button"
              onClick={handleAIParse}
              disabled={aiLoading || !aiText.trim()}
              className="mt-2.5 w-full flex items-center justify-center gap-2 bg-[rgba(139,124,255,0.1)] border border-[rgba(139,124,255,0.25)] text-accent text-[13px] font-bold rounded-[10px] py-2.5 hover:bg-[rgba(139,124,255,0.18)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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

            {/* Post-parse feedback */}
            {aiFilledFields.size > 0 && (
              <p className="text-[11px] text-muted mt-2.5 text-center leading-relaxed">
                Fields highlighted in purple were filled by AI — review and edit before saving.
              </p>
            )}

            {/* Follow-up suggestion (lives on interactions, not contacts — show as a reminder) */}
            {aiFollowUpSuggestion && (
              <div className="mt-2.5 flex items-start gap-2 px-3 py-2 bg-[rgba(255,184,77,0.08)] border border-[rgba(255,184,77,0.2)] rounded-lg">
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

        {/* ── Manual form fields ── */}
        <div>
          <label className={lCls}>Name <span className="text-accent">*</span></label>
          <input
            value={name}
            onChange={e => { setName(e.target.value); clearAiFill('name') }}
            required
            autoFocus
            className={inputCls('name')}
            placeholder="Full name"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
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

        <div>
          <label className={lCls}>How you met</label>
          <input
            value={howMet}
            onChange={e => { setHowMet(e.target.value); clearAiFill('howMet') }}
            className={inputCls('howMet')}
            placeholder="Spring Career Fair"
          />
        </div>

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

        <div>
          <label className={lCls}>LinkedIn URL</label>
          <input
            value={linkedinUrl}
            onChange={e => { setLinkedinUrl(e.target.value); clearAiFill('linkedinUrl') }}
            className={inputCls('linkedinUrl')}
            placeholder="linkedin.com/in/…"
          />
        </div>

        <div>
          <label className={lCls}>Tags</label>
          <input
            value={tagsInput}
            onChange={e => { setTagsInput(e.target.value); clearAiFill('tags') }}
            className={inputCls('tags')}
            placeholder="alumni, recruiter, target firm"
          />
          <p className="mt-1.5 text-[11px] text-lower">Separate multiple tags with commas</p>
        </div>

        <div>
          <label className={lCls}>Skills</label>
          <input
            value={skillsInput}
            onChange={e => { setSkillsInput(e.target.value); clearAiFill('skills') }}
            className={inputCls('skills')}
            placeholder="python, excel, financial modeling"
          />
          <p className="mt-1.5 text-[11px] text-lower">Separate multiple skills with commas</p>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      {/* Sticky footer */}
      <div className="flex gap-[10px] px-[26px] py-[18px] border-t border-[rgba(255,255,255,0.06)] flex-none">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 bg-transparent text-mid border border-[rgba(255,255,255,0.1)] rounded-[11px] py-3 text-[14px] font-semibold hover:text-hi hover:border-[rgba(255,255,255,0.18)] transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold rounded-[11px] py-3 shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {submitting ? 'Saving…' : 'Save contact'}
        </button>
      </div>
    </form>
  )
}

export default AddContactDrawer
