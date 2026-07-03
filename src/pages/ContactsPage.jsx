import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import ContactListItem from '../components/ContactListItem'
import AddContactDrawer from '../components/AddContactDrawer'

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
          (c.tags && c.tags.some(t => t.toLowerCase().includes(q)))
        )
      })

  return (
    <div className="min-h-screen bg-surface">

      {/* Contacts list content — blurred + non-interactive when drawer is open */}
      <div className={`px-9 py-8 transition-all duration-200 ${showDrawer ? 'blur-[1.5px] opacity-40 pointer-events-none select-none' : ''}`}>

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
            onClick={() => setShowDrawer(true)}
            className="flex items-center gap-2 bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-[18px] py-[11px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity flex-none"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Add contact
          </button>
        </div>

        {fetchError && <p className="mb-4 text-sm text-danger">{fetchError}</p>}

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
        ) : contacts.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-hi font-semibold mb-1">No contacts yet</p>
            <p className="text-sm text-muted">Click "+ Add contact" to start building your network.</p>
          </div>
        ) : filteredContacts.length === 0 ? (
          <p className="text-sm text-muted">
            No contacts match{activeTag ? ` the "${activeTag}" filter` : ''}{searchQuery ? ` "${searchQuery}"` : ''}.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-[14px]">
            {filteredContacts.map(contact => (
              <ContactListItem key={contact.id} contact={contact}/>
            ))}
          </div>
        )}
      </div>

      {/* Drawer backdrop + drawer — rendered outside the blurred div so the drawer stays crisp */}
      {showDrawer && (
        <>
          {/* Backdrop covers the content area only (not the 248px sidebar) */}
          <div
            className="fixed inset-y-0 left-[248px] right-0 bg-[rgba(6,6,8,0.55)] z-40 cursor-default"
            onClick={() => setShowDrawer(false)}
            style={{ animation: 'fade-in 0.2s ease-out' }}
          />
          <AddContactDrawer
            onClose={() => setShowDrawer(false)}
            onSuccess={() => { setShowDrawer(false); fetchContacts() }}
          />
        </>
      )}
    </div>
  )
}

export default ContactsPage
