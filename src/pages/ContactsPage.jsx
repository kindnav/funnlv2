import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import ContactListItem from '../components/ContactListItem'
import AddContactDrawer from '../components/AddContactDrawer'
import ImportContactsModal from '../components/ImportContactsModal'

const FILTER_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Target firms', value: 'target firm' },
  { label: 'Recruiters', value: 'recruiter' },
  { label: 'Alumni', value: 'alumni' },
]

function ContactsPage() {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')
  const [showDrawer, setShowDrawer] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // URL-based tag filter — sidebar Pipeline links drive this by linking to /contacts?tag=recruiter
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTag = searchParams.get('tag') || ''

  function setActiveTag(tag) {
    if (tag) setSearchParams({ tag }); else setSearchParams({})
  }

  useEffect(() => { fetchContacts() }, [])

  async function fetchContacts() {
    setLoading(true)
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) setFetchError(error.message); else setContacts(data)
    setLoading(false)
  }

  // Apply tag filter first, then text search
  const tagFiltered = activeTag
    ? contacts.filter(c => c.tags && c.tags.some(t => t.toLowerCase().includes(activeTag.toLowerCase())))
    : contacts

  const filteredContacts = searchQuery.trim() === ''
    ? tagFiltered
    : tagFiltered.filter(c => {
        const q = searchQuery.toLowerCase()
        return (
          c.name.toLowerCase().includes(q) ||
          (c.company && c.company.toLowerCase().includes(q)) ||
          (c.role && c.role.toLowerCase().includes(q)) ||
          (c.tags && c.tags.some(t => t.toLowerCase().includes(q))) ||
          (c.skills && c.skills.some(s => s.toLowerCase().includes(q)))
        )
      })

  return (
    <div className="min-h-screen bg-surface">

      {/* Contacts list content — blurred + non-interactive when drawer is open */}
      <div className={`px-4 py-6 md:px-9 md:py-8 transition-all duration-200 ${showDrawer ? 'blur-[1.5px] opacity-40 pointer-events-none select-none' : ''}`}>

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
          <div className="flex items-center gap-2 flex-none">
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-2 bg-elevated border border-[rgba(255,255,255,0.09)] text-mid hover:text-hi hover:border-[rgba(255,255,255,0.16)] text-[14px] font-semibold px-[12px] md:px-[14px] py-[10px] rounded-[11px] transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span className="hidden md:inline">Import</span>
            </button>
            <button
              onClick={() => setShowDrawer(true)}
              className="flex items-center gap-2 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-[14px] md:px-[18px] py-[11px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              <span className="hidden md:inline">Add contact</span>
            </button>
          </div>
        </div>

        {/* Search bar */}
        <div className="flex items-center gap-[10px] bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[14px] py-3 mb-[18px]">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#6C6C78" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/>
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
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
          {FILTER_OPTIONS.map(option => (
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
        ) : fetchError ? (
          <div className="text-center py-12">
            <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-[rgba(255,107,138,0.1)] border border-[rgba(255,107,138,0.2)] flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
              </svg>
            </div>
            <p className="text-hi font-semibold mb-2">Couldn't load contacts</p>
            <p className="text-muted text-sm mb-5">Check your connection and try again.</p>
            <button onClick={fetchContacts} className="text-accent text-sm font-semibold hover:text-tag transition-colors">Try again</button>
          </div>
        ) : contacts.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-[72px] h-[72px] mx-auto mb-6 rounded-[20px] bg-[rgba(108,92,255,0.12)] border border-[rgba(139,124,255,0.25)] flex items-center justify-center">
              <svg width="32" height="32" viewBox="0 0 100 100" fill="none">
                <rect x="8" y="6" width="84" height="17" rx="4" fill="#C7BFFF"/>
                <rect x="20" y="27" width="60" height="17" rx="4" fill="#9D8FFF"/>
                <rect x="32" y="48" width="36" height="17" rx="4" fill="#8B7CFF"/>
                <rect x="44" y="69" width="12" height="17" rx="4" fill="#5B45F0"/>
              </svg>
            </div>
            <h2 className="font-display text-[20px] font-bold text-hi mb-2">Start building your network</h2>
            <p className="text-[14px] leading-relaxed text-muted mb-6 max-w-[320px] mx-auto">
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
        ) : filteredContacts.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center">
            <div className="w-12 h-12 mb-4 rounded-xl bg-elevated border border-[rgba(255,255,255,0.07)] flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6C6C78" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/>
              </svg>
            </div>
            <p className="text-[14px] font-semibold text-hi mb-1">No contacts found</p>
            <p className="text-[13px] text-muted mb-4">
              {searchQuery ? `No results for "${searchQuery}"` : `No contacts tagged "${activeTag}"`}
            </p>
            <button
              onClick={() => { setSearchQuery(''); setActiveTag('') }}
              className="text-[13px] font-medium text-accent hover:text-tag transition-colors"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[14px]">
            {filteredContacts.map(contact => (
              <ContactListItem key={contact.id} contact={contact}/>
            ))}
          </div>
        )}
      </div>

      {/* Drawer backdrop + drawer — rendered outside the blurred div so the drawer stays crisp */}
      {showDrawer && (
        <>
          <div
            className="fixed inset-0 md:left-[248px] bg-[rgba(6,6,8,0.55)] z-40 cursor-default"
            onClick={() => setShowDrawer(false)}
            style={{ animation: 'fade-in 0.2s ease-out' }}
          />
          <AddContactDrawer
            onClose={() => setShowDrawer(false)}
            onSuccess={() => { setShowDrawer(false); fetchContacts() }}
          />
        </>
      )}

      {/* Import modal */}
      {importOpen && (
        <ImportContactsModal
          onClose={() => setImportOpen(false)}
          onImported={() => fetchContacts()}
        />
      )}
    </div>
  )
}

export default ContactsPage
