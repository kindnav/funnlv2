import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import ContactListItem from '../components/ContactListItem'

const FILTER_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Target firms', value: 'target firm' },
  { label: 'Recruiters', value: 'recruiter' },
  { label: 'Alumni', value: 'alumni' },
]

function ContactsPage() {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('')
  const [howMet, setHowMet] = useState('')
  const [email, setEmail] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [skillsInput, setSkillsInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // URL-based tag filter — sidebar Pipeline links can drive this by linking to /contacts?tag=recruiter
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTag = searchParams.get('tag') || ''

  function setActiveTag(tag) {
    if (tag) {
      setSearchParams({ tag })
    } else {
      setSearchParams({})
    }
  }

  useEffect(() => {
    fetchContacts()
  }, [])

  async function fetchContacts() {
    setLoading(true)
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      setError(error.message)
    } else {
      setContacts(data)
    }
    setLoading(false)
  }

  function resetForm() {
    setName('')
    setCompany('')
    setRole('')
    setHowMet('')
    setEmail('')
    setLinkedinUrl('')
    setTagsInput('')
    setSkillsInput('')
  }

  async function handleAddContact(e) {
    e.preventDefault()
    setSubmitting(true)
    setError('')

    const tags = tagsInput.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
    const skills = skillsInput.split(',').map((s) => s.trim()).filter((s) => s.length > 0)

    const { error } = await supabase.from('contacts').insert([{
      name,
      company: company || null,
      role: role || null,
      how_met: howMet || null,
      email: email || null,
      linkedin_url: linkedinUrl || null,
      tags: tags.length > 0 ? tags : null,
      skills: skills.length > 0 ? skills : null,
    }])

    setSubmitting(false)

    if (error) {
      setError(error.message)
      return
    }

    resetForm()
    setShowForm(false)
    fetchContacts()
  }

  // Apply tag filter first, then text search on top
  const tagFiltered = activeTag
    ? contacts.filter((c) =>
        c.tags && c.tags.some((t) => t.toLowerCase().includes(activeTag.toLowerCase()))
      )
    : contacts

  const filteredContacts = searchQuery.trim() === ''
    ? tagFiltered
    : tagFiltered.filter((c) => {
        const q = searchQuery.toLowerCase()
        return (
          c.name.toLowerCase().includes(q) ||
          (c.company && c.company.toLowerCase().includes(q)) ||
          (c.role && c.role.toLowerCase().includes(q)) ||
          (c.tags && c.tags.some((t) => t.toLowerCase().includes(q)))
        )
      })

  const inputClass = 'w-full bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors'
  const labelClass = 'mb-[7px] block text-[12.5px] font-semibold text-mid'

  return (
    <div className="min-h-screen bg-surface px-9 py-8">

      {/* Page header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display font-bold text-[28px] text-hi tracking-[-0.5px]">Contacts</h1>
          {!loading && (
            <p className="text-[14.5px] text-muted mt-1">
              {contacts.length} {contacts.length === 1 ? 'person' : 'people'} in your network
            </p>
          )}
        </div>
        <button
          onClick={() => setShowForm((prev) => !prev)}
          className="flex items-center gap-2 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-[18px] py-[11px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity flex-none"
        >
          {showForm ? (
            'Cancel'
          ) : (
            <>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              Add contact
            </>
          )}
        </button>
      </div>

      {/* Add contact form (inline for now — becomes a drawer in step 4) */}
      {showForm && (
        <form
          onSubmit={handleAddContact}
          className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-6 mb-6 grid grid-cols-2 gap-4"
        >
          <div className="col-span-2">
            <label className={labelClass}>Name <span className="text-accent">*</span></label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              className={inputClass}
              placeholder="Full name"
            />
          </div>
          <div>
            <label className={labelClass}>Company</label>
            <input value={company} onChange={(e) => setCompany(e.target.value)} className={inputClass} placeholder="Goldman Sachs"/>
          </div>
          <div>
            <label className={labelClass}>Role</label>
            <input value={role} onChange={(e) => setRole(e.target.value)} className={inputClass} placeholder="Summer Analyst"/>
          </div>
          <div className="col-span-2">
            <label className={labelClass}>How you met</label>
            <input value={howMet} onChange={(e) => setHowMet(e.target.value)} className={inputClass} placeholder="Spring Career Fair"/>
          </div>
          <div>
            <label className={labelClass}>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="name@company.com"/>
          </div>
          <div>
            <label className={labelClass}>LinkedIn URL</label>
            <input value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} className={inputClass} placeholder="linkedin.com/in/…"/>
          </div>
          <div>
            <label className={labelClass}>Tags</label>
            <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} className={inputClass} placeholder="alumni, recruiter, target firm"/>
            <p className="mt-1.5 text-[11px] text-lower">Separate with commas</p>
          </div>
          <div>
            <label className={labelClass}>Skills</label>
            <input value={skillsInput} onChange={(e) => setSkillsInput(e.target.value)} className={inputClass} placeholder="python, excel, financial modeling"/>
            <p className="mt-1.5 text-[11px] text-lower">Separate with commas</p>
          </div>

          {error && <p className="col-span-2 text-sm text-danger">{error}</p>}

          <div className="col-span-2 flex gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold py-3 rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {submitting ? 'Saving…' : 'Save contact'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); resetForm() }}
              className="px-5 text-[14px] font-semibold text-mid bg-elevated border border-[rgba(255,255,255,0.09)] rounded-[11px] hover:text-hi transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Search bar */}
      <div className="flex items-center gap-[10px] bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[14px] py-3 mb-[18px]">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#6C6C78" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/>
        </svg>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search by name, company, role, skill, or tag…"
          className="flex-1 bg-transparent text-[14px] text-hi placeholder-[#6C6C78] outline-none"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} className="text-low hover:text-mid transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </button>
        )}
      </div>

      {/* Filter pills */}
      <div className="flex gap-2 flex-wrap mb-[22px]">
        {FILTER_OPTIONS.map((option) => (
          <button
            key={option.value}
            onClick={() => setActiveTag(option.value)}
            className={`text-[12.5px] font-bold px-[14px] py-[7px] rounded-full transition-colors ${
              activeTag === option.value
                ? 'text-white bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)]'
                : 'text-mid bg-elevated border border-[rgba(255,255,255,0.07)] hover:text-hi'
            }`}
          >
            {option.value === '' ? `All · ${contacts.length}` : option.label}
          </button>
        ))}
      </div>

      {/* Contact grid */}
      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : contacts.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-hi font-semibold mb-1">No contacts yet</p>
          <p className="text-sm text-muted">Add your first contact to start building your network.</p>
        </div>
      ) : filteredContacts.length === 0 ? (
        <p className="text-sm text-muted">
          No contacts match{activeTag ? ` the "${activeTag}" filter` : ''}{searchQuery ? ` "${searchQuery}"` : ''}.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-[14px]">
          {filteredContacts.map((contact) => (
            <ContactListItem key={contact.id} contact={contact} />
          ))}
        </div>
      )}

    </div>
  )
}

export default ContactsPage
