import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

function normalizeUrl(url) {
  const s = url.trim()
  if (!s) return null
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return 'https://' + s
}

const iCls = 'w-full bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors'
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

  // Close on Escape key
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Lock background scroll while drawer is open.
  // Early-return pattern: if mainEl isn't found (shouldn't happen), no cleanup needed.
  // React always runs the returned cleanup on unmount, so scroll can never stay locked.
  useEffect(() => {
    const mainEl = document.querySelector('main')
    if (!mainEl) return
    mainEl.style.overflowY = 'hidden'
    return () => { mainEl.style.overflowY = '' }
  }, [])

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
        <div>
          <label className={lCls}>Name <span className="text-accent">*</span></label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            required
            autoFocus
            className={iCls}
            placeholder="Full name"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={lCls}>Company</label>
            <input value={company} onChange={e => setCompany(e.target.value)} className={iCls} placeholder="Goldman Sachs"/>
          </div>
          <div>
            <label className={lCls}>Role</label>
            <input value={role} onChange={e => setRole(e.target.value)} className={iCls} placeholder="Summer Analyst"/>
          </div>
        </div>

        <div>
          <label className={lCls}>How you met</label>
          <input value={howMet} onChange={e => setHowMet(e.target.value)} className={iCls} placeholder="Spring Career Fair"/>
        </div>

        <div>
          <label className={lCls}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={iCls} placeholder="name@company.com"/>
        </div>

        <div>
          <label className={lCls}>LinkedIn URL</label>
          <input value={linkedinUrl} onChange={e => setLinkedinUrl(e.target.value)} className={iCls} placeholder="linkedin.com/in/…"/>
        </div>

        <div>
          <label className={lCls}>Tags</label>
          <input
            value={tagsInput}
            onChange={e => setTagsInput(e.target.value)}
            className={iCls}
            placeholder="alumni, recruiter, target firm"
          />
          <p className="mt-1.5 text-[11px] text-lower">Separate multiple tags with commas</p>
        </div>

        <div>
          <label className={lCls}>Skills</label>
          <input
            value={skillsInput}
            onChange={e => setSkillsInput(e.target.value)}
            className={iCls}
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
