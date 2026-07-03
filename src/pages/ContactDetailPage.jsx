import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── Local date (YYYY-MM-DD) — avoids UTC-offset "wrong day" bugs ─────────────
function getLocalToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

import { getAvatarColor, getInitials } from '../lib/avatarUtils'

// ── Relative date — parses YYYY-MM-DD as local midnight to avoid UTC offset bugs ──
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

// ── Interaction type colours + icons ───────────────────────────────────────
const TYPE_STYLES = {
  'Coffee chat': { bg: 'rgba(245,166,35,0.15)', stroke: '#FFB84D' },
  'Email':       { bg: 'rgba(108,92,255,0.15)', stroke: '#8B7CFF' },
  'Event':       { bg: 'rgba(47,212,182,0.14)', stroke: '#2FD4B6' },
  'Call':        { bg: 'rgba(77,163,255,0.15)', stroke: '#4DA3FF' },
  'Message':     { bg: 'rgba(199,125,255,0.15)', stroke: '#C77DFF' },
  'Other':       { bg: 'rgba(255,255,255,0.07)', stroke: '#A0A0AD' },
}
function typeStyle(t) { return TYPE_STYLES[t] || TYPE_STYLES['Other'] }

function TypeIcon({ type, color }) {
  const p = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }
  if (type === 'Coffee chat') return <svg {...p}><path d="M4 9h16v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9z"/><path d="M18 9h2a2 2 0 0 1 0 4h-2"/><path d="M7 3v2M12 3v2M17 3v2"/></svg>
  if (type === 'Email')       return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/></svg>
  if (type === 'Event')       return <svg {...p}><path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>
  if (type === 'Call')        return <svg {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.8 19.8 0 0 1 1.61 3.41 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.57a16 16 0 0 0 6.07 6.07l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
  if (type === 'Message')     return <svg {...p}><path d="M4 5h16v10H8l-4 4z"/></svg>
  return <svg {...p}><circle cx="12" cy="12" r="4" fill={color} stroke="none"/></svg>
}

// ── Shared form input styles ───────────────────────────────────────────────
const iCls = 'w-full bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors'
const lCls = 'mb-[7px] block text-[12.5px] font-semibold text-mid'
const sCls = `${iCls} cursor-pointer`
const TYPE_OPTIONS = ['Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other']

// ══════════════════════════════════════════════════════════════════════════════

function ContactDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [contact, setContact] = useState(null)
  const [interactions, setInteractions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [isEditing, setIsEditing] = useState(false)
  const [editForm, setEditForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [type, setType] = useState('Coffee chat')
  const [interactionDate, setInteractionDate] = useState(getLocalToday)
  const [notes, setNotes] = useState('')
  const [followUpDate, setFollowUpDate] = useState('')

  const [editingInteractionId, setEditingInteractionId] = useState(null)
  const [interactionEditForm, setInteractionEditForm] = useState({})
  const [savingInteraction, setSavingInteraction] = useState(false)
  const [interactionSaveError, setInteractionSaveError] = useState('')
  const [deletingInteractionId, setDeletingInteractionId] = useState(null)
  const [interactionsError, setInteractionsError] = useState('')

  useEffect(() => { fetchContact(); fetchInteractions() }, [id])

  async function fetchContact() {
    const { data, error } = await supabase.from('contacts').select('*').eq('id', id).single()
    if (error) setError(error.message); else setContact(data)
    setLoading(false)
  }

  async function fetchInteractions() {
    const { data, error } = await supabase.from('interactions').select('*').eq('contact_id', id).order('interaction_date', { ascending: false })
    if (error) {
      setInteractionsError('Couldn\'t load interactions. Refresh to try again.')
    } else {
      setInteractionsError('')
      setInteractions(data)
    }
  }

  function startEdit() {
    setEditForm({
      name: contact.name, company: contact.company || '', role: contact.role || '',
      howMet: contact.how_met || '', email: contact.email || '', linkedinUrl: contact.linkedin_url || '',
      tagsInput: contact.tags ? contact.tags.join(', ') : '',
      skillsInput: contact.skills ? contact.skills.join(', ') : '',
    })
    setSaveError(''); setIsEditing(true)
  }

  async function handleSave(e) {
    e.preventDefault(); setSaving(true); setSaveError('')
    const tags = editForm.tagsInput.split(',').map(t => t.trim()).filter(Boolean)
    const skills = editForm.skillsInput.split(',').map(s => s.trim()).filter(Boolean)
    const { error } = await supabase.from('contacts').update({
      name: editForm.name, company: editForm.company || null, role: editForm.role || null,
      how_met: editForm.howMet || null, email: editForm.email || null, linkedin_url: editForm.linkedinUrl || null,
      tags: tags.length > 0 ? tags : null, skills: skills.length > 0 ? skills : null,
    }).eq('id', id)
    setSaving(false)
    if (error) { setSaveError(error.message); return }
    setIsEditing(false); fetchContact()
  }

  async function handleDelete() {
    const { error } = await supabase.from('contacts').delete().eq('id', id)
    if (error) { setError(error.message); return }
    navigate('/contacts')
  }

  function startEditInteraction(interaction) {
    setInteractionEditForm({
      type: interaction.type || 'Coffee chat', date: interaction.interaction_date,
      notes: interaction.notes || '', followUpDate: interaction.follow_up_date || '',
    })
    setInteractionSaveError(''); setEditingInteractionId(interaction.id)
  }

  async function handleSaveInteraction(e) {
    e.preventDefault(); setSavingInteraction(true); setInteractionSaveError('')
    const { error } = await supabase.from('interactions').update({
      type: interactionEditForm.type, interaction_date: interactionEditForm.date,
      notes: interactionEditForm.notes || null, follow_up_date: interactionEditForm.followUpDate || null,
    }).eq('id', editingInteractionId)
    setSavingInteraction(false)
    if (error) { setInteractionSaveError(error.message); return }
    setEditingInteractionId(null); fetchInteractions()
  }

  async function handleDeleteInteraction(interactionId) {
    const { error } = await supabase.from('interactions').delete().eq('id', interactionId)
    if (!error) { setDeletingInteractionId(null); fetchInteractions() }
  }

  async function handleLogInteraction(e) {
    e.preventDefault(); setSubmitting(true); setFormError('')
    const { error } = await supabase.from('interactions').insert([{
      contact_id: id, type, interaction_date: interactionDate,
      notes: notes || null, follow_up_date: followUpDate || null,
    }])
    setSubmitting(false)
    if (error) { setFormError(error.message); return }
    setNotes(''); setFollowUpDate(''); setShowForm(false); fetchInteractions()
  }

  // ── Loading / error screens ──────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-muted text-sm">Loading…</p>
      </div>
    )
  }

  if (error || !contact) {
    return (
      <div className="min-h-screen bg-surface px-9 py-8">
        <Link to="/contacts" className="text-sm font-medium text-accent hover:text-tag no-underline">← Contacts</Link>
        <p className="mt-4 text-sm text-danger">{error || 'Contact not found.'}</p>
      </div>
    )
  }

  // ── Derived values ───────────────────────────────────────────────────────
  const today = getLocalToday()
  const overdueFollowUp = interactions
    .filter(i => i.follow_up_date && i.follow_up_date <= today)
    .sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date))[0] || null
  const hasAnyDetails = contact.email || contact.linkedin_url || contact.how_met ||
    (contact.skills && contact.skills.length > 0)

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-surface px-9 py-8">

      {/* Back link */}
      <Link to="/contacts" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-hi transition-colors no-underline mb-5">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6"/>
        </svg>
        Contacts
      </Link>

      {/* ── EDIT MODE: full edit form replacing hero + body ── */}
      {isEditing ? (
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-[18px] p-6">
          <h2 className="font-display text-[19px] font-bold text-hi mb-5">Edit contact</h2>
          <form onSubmit={handleSave} className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className={lCls}>Name <span className="text-accent">*</span></label>
              <input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} required className={iCls}/>
            </div>
            <div>
              <label className={lCls}>Company</label>
              <input value={editForm.company} onChange={e => setEditForm({ ...editForm, company: e.target.value })} className={iCls} placeholder="Goldman Sachs"/>
            </div>
            <div>
              <label className={lCls}>Role</label>
              <input value={editForm.role} onChange={e => setEditForm({ ...editForm, role: e.target.value })} className={iCls} placeholder="Summer Analyst"/>
            </div>
            <div className="col-span-2">
              <label className={lCls}>How you met</label>
              <input value={editForm.howMet} onChange={e => setEditForm({ ...editForm, howMet: e.target.value })} className={iCls} placeholder="Spring Career Fair"/>
            </div>
            <div>
              <label className={lCls}>Email</label>
              <input type="email" value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} className={iCls} placeholder="name@company.com"/>
            </div>
            <div>
              <label className={lCls}>LinkedIn URL</label>
              <input value={editForm.linkedinUrl} onChange={e => setEditForm({ ...editForm, linkedinUrl: e.target.value })} className={iCls} placeholder="linkedin.com/in/…"/>
            </div>
            <div>
              <label className={lCls}>Tags</label>
              <input value={editForm.tagsInput} onChange={e => setEditForm({ ...editForm, tagsInput: e.target.value })} className={iCls} placeholder="alumni, recruiter, target firm"/>
              <p className="mt-1.5 text-[11px] text-lower">Separate with commas</p>
            </div>
            <div>
              <label className={lCls}>Skills</label>
              <input value={editForm.skillsInput} onChange={e => setEditForm({ ...editForm, skillsInput: e.target.value })} className={iCls} placeholder="python, excel, financial modeling"/>
              <p className="mt-1.5 text-[11px] text-lower">Separate with commas</p>
            </div>
            {saveError && <p className="col-span-2 text-sm text-danger">{saveError}</p>}
            <div className="col-span-2 flex gap-3 pt-1">
              <button type="submit" disabled={saving} className="flex-1 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold py-3 rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-40">
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" onClick={() => setIsEditing(false)} className="px-5 text-[14px] font-semibold text-mid bg-elevated border border-[rgba(255,255,255,0.09)] rounded-[11px] hover:text-hi transition-colors">
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          {/* ── HERO CARD ── */}
          <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-[18px] p-[22px_24px] flex items-start justify-between gap-4 mb-3">
            {/* Avatar + name + tags */}
            <div className="flex gap-[18px] items-start flex-1 min-w-0">
              <div
                className="w-[66px] h-[66px] rounded-[18px] flex items-center justify-center text-[24px] font-bold text-white flex-none"
                style={{ background: getAvatarColor(contact.name) }}
              >
                {getInitials(contact.name)}
              </div>
              <div className="min-w-0">
                <h1 className="font-display text-[24px] font-bold text-hi tracking-[-0.3px] break-words">{contact.name}</h1>
                {(contact.role || contact.company) && (
                  <p className="text-[14.5px] text-muted mt-0.5 break-words">
                    {[contact.role, contact.company].filter(Boolean).join(' · ')}
                  </p>
                )}
                {contact.tags && contact.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-[11px]">
                    {contact.tags.map(tag => (
                      <span key={tag} className="text-[11px] font-semibold text-tag bg-[rgba(108,92,255,0.13)] border border-[rgba(108,92,255,0.22)] px-[10px] py-[3px] rounded-full">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex gap-[9px] flex-none items-center">
              <button
                onClick={() => setShowForm(v => !v)}
                className="flex items-center gap-[7px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[13.5px] font-bold px-4 py-[10px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 5h16v10H8l-4 4z"/>
                </svg>
                Log interaction
              </button>
              <button
                onClick={startEdit}
                className="bg-elevated text-hi border border-[rgba(255,255,255,0.09)] rounded-[11px] px-4 py-[10px] text-[13.5px] font-semibold hover:border-[rgba(255,255,255,0.2)] transition-colors"
              >
                Edit
              </button>
              {contact.email ? (
                <a href={`mailto:${contact.email}`} title={contact.email} className="w-10 h-10 bg-elevated border border-[rgba(255,255,255,0.09)] rounded-[11px] flex items-center justify-center hover:border-[rgba(139,124,255,0.4)] transition-colors">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8A8A94" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
                  </svg>
                </a>
              ) : (
                <div title="No email saved" className="w-10 h-10 bg-elevated border border-[rgba(255,255,255,0.09)] rounded-[11px] flex items-center justify-center opacity-25">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8A8A94" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
                  </svg>
                </div>
              )}
            </div>
          </div>

          {/* Delete link + confirmation (below hero, separate from primary actions) */}
          <div className="mb-6 px-1">
            {confirmingDelete ? (
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-[12.5px] text-muted">This permanently deletes this contact and all their interactions.</p>
                <button onClick={handleDelete} className="text-[12.5px] font-bold text-danger hover:opacity-80 transition-opacity">Yes, delete</button>
                <button onClick={() => setConfirmingDelete(false)} className="text-[12.5px] font-medium text-low hover:text-mid transition-colors">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmingDelete(true)} className="text-[12.5px] font-medium text-lower hover:text-danger transition-colors">
                Delete contact
              </button>
            )}
          </div>

          {/* ── TWO-COLUMN BODY ── */}
          <div className="grid grid-cols-[1fr_1.35fr] gap-[18px]">

            {/* LEFT: Details + Funnl AI placeholder */}
            <div className="flex flex-col gap-[18px]">

              {/* Details card */}
              <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5">
                <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono mb-4">Details</p>
                {hasAnyDetails ? (
                  <div className="flex flex-col gap-[14px]">
                    {contact.email && (
                      <div>
                        <p className="text-[12px] text-low mb-1">Email</p>
                        <a href={`mailto:${contact.email}`} className="text-[13.5px] font-medium text-accent hover:text-tag transition-colors no-underline break-all">{contact.email}</a>
                      </div>
                    )}
                    {contact.linkedin_url && (
                      <div>
                        <p className="text-[12px] text-low mb-1">LinkedIn</p>
                        <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-[13.5px] font-medium text-accent hover:text-tag transition-colors no-underline break-all">{contact.linkedin_url}</a>
                      </div>
                    )}
                    {contact.how_met && (
                      <div>
                        <p className="text-[12px] text-low mb-1">How you met</p>
                        <p className="text-[13.5px] font-medium text-hi">{contact.how_met}</p>
                      </div>
                    )}
                    {contact.skills && contact.skills.length > 0 && (
                      <div>
                        <p className="text-[12px] text-low mb-2">Skills</p>
                        <div className="flex flex-wrap gap-1.5">
                          {contact.skills.map(skill => (
                            <span key={skill} className="font-mono text-[10.5px] text-skill bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.08)] px-[7px] py-[3px] rounded-[6px]">
                              {skill}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-low">No details saved yet. Click <button onClick={startEdit} className="text-accent hover:text-tag transition-colors">Edit</button> to add more.</p>
                )}
              </div>

              {/* Funnl AI card — honest coming-soon placeholder */}
              <div className="bg-[linear-gradient(150deg,rgba(43,33,64,0.7),rgba(18,17,26,0.7))] border border-[rgba(139,124,255,0.28)] rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="#B4A8FF">
                    <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
                  </svg>
                  <span className="text-[13px] font-bold text-hi">Funnl AI</span>
                </div>
                <p className="text-[12.5px] leading-[1.6] text-[#C5BEDB]">
                  AI summaries of your contacts are coming in a future update. Keep logging interactions — that's the data it will use.
                </p>
                <p className="font-mono text-[10.5px] text-accent mt-3">Coming in Layer 3</p>
              </div>

            </div>

            {/* RIGHT: Follow-up callout + Interactions */}
            <div className="flex flex-col gap-[18px]">

              {/* Follow-up callout — only shown if there's a real overdue follow-up */}
              {overdueFollowUp && (
                <div className="bg-[rgba(245,166,35,0.08)] border border-[rgba(245,166,35,0.28)] rounded-2xl p-4 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-[10px] bg-[rgba(245,166,35,0.16)] flex items-center justify-center flex-none">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFB84D" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-bold text-hi truncate">{overdueFollowUp.type || 'Follow-up'}</p>
                    <p className="text-[12.5px] text-[#C9A867]">
                      {overdueFollowUp.follow_up_date === today ? 'Due today' : `Due ${relativeDate(overdueFollowUp.follow_up_date)}`}
                    </p>
                  </div>
                </div>
              )}

              {/* Interactions card */}
              <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5 flex-1">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono">Interactions</p>
                  <button
                    onClick={() => setShowForm(v => !v)}
                    className="text-[12.5px] font-bold text-accent hover:text-tag transition-colors"
                  >
                    {showForm ? 'Cancel' : '+ Log'}
                  </button>
                </div>

                {/* Log interaction form */}
                {showForm && (
                  <form onSubmit={handleLogInteraction} className="mb-5 space-y-3 bg-elevated border border-[rgba(255,255,255,0.07)] rounded-xl p-4">
                    <div>
                      <label className={lCls}>Type</label>
                      <select value={type} onChange={e => setType(e.target.value)} className={sCls}>
                        {TYPE_OPTIONS.map(o => <option key={o}>{o}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={lCls}>Date <span className="text-accent">*</span></label>
                      <input type="date" value={interactionDate} onChange={e => setInteractionDate(e.target.value)} required className={iCls}/>
                    </div>
                    <div>
                      <label className={lCls}>Notes</label>
                      <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="What did you talk about? Any key takeaways?" className={`${iCls} resize-y min-h-[80px]`}/>
                    </div>
                    <div>
                      <label className={lCls}>Follow-up date</label>
                      <input type="date" value={followUpDate} onChange={e => setFollowUpDate(e.target.value)} className={iCls}/>
                    </div>
                    {formError && <p className="text-sm text-danger">{formError}</p>}
                    <button type="submit" disabled={submitting} className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[13.5px] font-bold py-[11px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-40">
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
                          {/* Icon + connecting line */}
                          <div className="flex flex-col items-center flex-none">
                            <div className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center flex-none" style={{ background: style.bg }}>
                              <TypeIcon type={interaction.type} color={style.stroke}/>
                            </div>
                            {!isLast && <div className="w-0.5 flex-1 bg-[rgba(255,255,255,0.07)] mt-1 min-h-[16px]"/>}
                          </div>

                          {/* Content */}
                          <div className={`flex-1 min-w-0 ${!isLast ? 'pb-5' : ''}`}>
                            {editingInteractionId === interaction.id ? (
                              <form onSubmit={handleSaveInteraction} className="space-y-3 bg-elevated border border-[rgba(255,255,255,0.07)] rounded-xl p-3 mb-1">
                                <div>
                                  <label className={lCls}>Type</label>
                                  <select value={interactionEditForm.type} onChange={e => setInteractionEditForm({ ...interactionEditForm, type: e.target.value })} className={sCls}>
                                    {TYPE_OPTIONS.map(o => <option key={o}>{o}</option>)}
                                  </select>
                                </div>
                                <div>
                                  <label className={lCls}>Date</label>
                                  <input type="date" value={interactionEditForm.date} onChange={e => setInteractionEditForm({ ...interactionEditForm, date: e.target.value })} required className={iCls}/>
                                </div>
                                <div>
                                  <label className={lCls}>Notes</label>
                                  <textarea value={interactionEditForm.notes} onChange={e => setInteractionEditForm({ ...interactionEditForm, notes: e.target.value })} rows={3} className={`${iCls} resize-y`}/>
                                </div>
                                <div>
                                  <label className={lCls}>Follow-up date</label>
                                  <input type="date" value={interactionEditForm.followUpDate} onChange={e => setInteractionEditForm({ ...interactionEditForm, followUpDate: e.target.value })} className={iCls}/>
                                </div>
                                {interactionSaveError && <p className="text-sm text-danger">{interactionSaveError}</p>}
                                <div className="flex gap-2">
                                  <button type="submit" disabled={savingInteraction} className="flex-1 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[13px] font-bold py-2.5 rounded-[10px] hover:opacity-90 transition-opacity disabled:opacity-40">
                                    {savingInteraction ? 'Saving…' : 'Save'}
                                  </button>
                                  <button type="button" onClick={() => setEditingInteractionId(null)} className="px-4 text-[13px] font-semibold text-mid bg-card border border-[rgba(255,255,255,0.09)] rounded-[10px] hover:text-hi transition-colors">
                                    Cancel
                                  </button>
                                </div>
                              </form>
                            ) : (
                              <div className="pt-0.5">
                                <div className="flex items-start justify-between gap-2 mb-1">
                                  <span className="text-[13.5px] font-bold text-hi">{interaction.type || 'Interaction'}</span>
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
          </div>
        </>
      )}
    </div>
  )
}

export default ContactDetailPage
