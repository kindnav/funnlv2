import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import ContactListItem from '../components/ContactListItem'
import AddContactDrawer from '../components/AddContactDrawer'
import ImportContactsModal from '../components/ImportContactsModal'

const FILTER_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Target firms', value: 'target firm' },
  { label: 'Recruiters', value: 'recruiter' },
  { label: 'Alumni', value: 'alumni' },
]

const TABLE_COLS = [
  { key: 'name',              label: 'Name',         sortable: true },
  { key: 'company',           label: 'Company',      sortable: true },
  { key: 'role',              label: 'Role',         sortable: true },
  { key: 'relationship_type', label: 'Relationship', sortable: true },
  { key: 'tags',              label: 'Tags',         sortable: true },
]

function sortContacts(list, col, dir) {
  if (!col) return list
  return [...list].sort((a, b) => {
    const aVal = col === 'tags' ? ((a.tags || [])[0] || '') : (a[col] || '')
    const bVal = col === 'tags' ? ((b.tags || [])[0] || '') : (b[col] || '')
    const cmp = aVal.toString().toLowerCase().localeCompare(bVal.toString().toLowerCase())
    return dir === 'asc' ? cmp : -cmp
  })
}

function ContactsPage() {
  const navigate = useNavigate()
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')
  const [showDrawer, setShowDrawer] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // View toggle — persisted to localStorage (same pattern as funnl_confirmed_ and funnl_activated_)
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('funnl_contacts_view') || 'cards')

  // Table sort state — reset when switching view so each view starts clean
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')

  // Individual contact delete
  const [confirmDeleteContact, setConfirmDeleteContact] = useState(null)
  const [deletingContact, setDeletingContact] = useState(false)
  const [deleteContactError, setDeleteContactError] = useState('')

  // Delete all contacts
  const [showDeleteAll, setShowDeleteAll] = useState(false)
  const [deleteAllInput, setDeleteAllInput] = useState('')
  const [deletingAll, setDeletingAll] = useState(false)
  const [deleteAllError, setDeleteAllError] = useState('')

  // URL-based tag filter — sidebar YOUR TAGS links drive this by linking to /contacts?tag=recruiter
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTag = searchParams.get('tag') || ''

  function setActiveTag(tag) {
    if (tag) setSearchParams({ tag }); else setSearchParams({})
  }

  function handleViewChange(mode) {
    setViewMode(mode)
    setSortCol(null)
    setSortDir('asc')
    localStorage.setItem('funnl_contacts_view', mode)
  }

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
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

  async function handleDeleteContact(contact) {
    setDeletingContact(true)
    setDeleteContactError('')
    const { error } = await supabase.from('contacts').delete().eq('id', contact.id)
    setDeletingContact(false)
    if (error) { setDeleteContactError(error.message); return }
    setConfirmDeleteContact(null)
    fetchContacts()
  }

  async function handleDeleteAll() {
    setDeletingAll(true)
    setDeleteAllError('')
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setDeleteAllError('Not signed in. Please refresh and try again.')
      setDeletingAll(false)
      return
    }
    // Explicitly scoped to this user's contacts via .eq('user_id', user.id).
    // RLS also enforces auth.uid() = user_id at the database level — two independent guards.
    // ON DELETE CASCADE removes all interactions for deleted contacts automatically.
    const { error } = await supabase.from('contacts').delete().eq('user_id', user.id)
    setDeletingAll(false)
    if (error) { setDeleteAllError(`Delete failed: ${error.message}`); return }
    setShowDeleteAll(false)
    setDeleteAllInput('')
    fetchContacts()
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
          (c.relationship_type && c.relationship_type.toLowerCase().includes(q))
        )
      })

  // Sorted contacts for table view — card view uses filteredContacts directly (preserves created_at order)
  const displayContacts = sortContacts(filteredContacts, sortCol, sortDir)

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
            placeholder="Search by name, company, role, or tag…"
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

        {/* Filter pills + view toggle */}
        <div className="flex gap-2 flex-wrap mb-[22px] items-center">
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

          {/* View toggle — cards / table, right-aligned */}
          <div className="ml-auto flex items-center bg-elevated border border-[rgba(255,255,255,0.07)] rounded-[9px] p-[3px] gap-[2px]">
            <button
              onClick={() => handleViewChange('cards')}
              title="Card view"
              className={`w-[30px] h-[26px] rounded-[7px] flex items-center justify-center transition-colors ${
                viewMode === 'cards' ? 'bg-[rgba(139,124,255,0.18)] text-accent' : 'text-low hover:text-mid'
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
              </svg>
            </button>
            <button
              onClick={() => handleViewChange('table')}
              title="Table view"
              className={`w-[30px] h-[26px] rounded-[7px] flex items-center justify-center transition-colors ${
                viewMode === 'table' ? 'bg-[rgba(139,124,255,0.18)] text-accent' : 'text-low hover:text-mid'
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Contact grid / table */}
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
        ) : viewMode === 'table' ? (

          /* ── TABLE VIEW ── */
          <div className="rounded-2xl border border-[rgba(255,255,255,0.07)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="bg-[rgba(255,255,255,0.02)] border-b border-[rgba(255,255,255,0.07)]">
                    {TABLE_COLS.map(col => (
                      <th
                        key={col.key}
                        onClick={() => col.sortable && handleSort(col.key)}
                        className={`px-4 py-[10px] text-left text-[11px] font-bold tracking-[0.8px] font-mono uppercase select-none transition-colors ${
                          col.sortable ? 'cursor-pointer' : ''
                        } ${sortCol === col.key ? 'text-mid' : 'text-lower hover:text-mid'}`}
                      >
                        <span className="flex items-center gap-1">
                          {col.label}
                          {sortCol === col.key && (
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                              {sortDir === 'asc'
                                ? <polyline points="18 15 12 9 6 15"/>
                                : <polyline points="6 9 12 15 18 9"/>
                              }
                            </svg>
                          )}
                        </span>
                      </th>
                    ))}
                    {/* Delete column — header intentionally blank */}
                    <th className="w-10 px-3"/>
                  </tr>
                </thead>
                <tbody>
                  {displayContacts.map(contact => (
                    <tr
                      key={contact.id}
                      onClick={() => navigate(`/contacts/${contact.id}`)}
                      className="group border-b border-[rgba(255,255,255,0.05)] last:border-0 cursor-pointer hover:bg-[rgba(255,255,255,0.025)] transition-colors"
                    >
                      {/* Name + mini avatar */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-7 h-7 rounded-full flex-none flex items-center justify-center text-[10px] font-bold text-white"
                            style={{ background: getAvatarColor(contact.name) }}
                          >
                            {getInitials(contact.name)}
                          </div>
                          <span className="text-[13.5px] font-semibold text-hi">{contact.name}</span>
                        </div>
                      </td>
                      {/* Company */}
                      <td className="px-4 py-3 text-[13.5px] text-muted">
                        {contact.company || <span className="text-lower">—</span>}
                      </td>
                      {/* Role */}
                      <td className="px-4 py-3 text-[13.5px] text-muted">
                        {contact.role || <span className="text-lower">—</span>}
                      </td>
                      {/* Relationship type */}
                      <td className="px-4 py-3">
                        {contact.relationship_type
                          ? <span className="text-[12.5px] font-semibold text-accent">{contact.relationship_type}</span>
                          : <span className="text-[13px] text-lower">—</span>
                        }
                      </td>
                      {/* Tags */}
                      <td className="px-4 py-3">
                        {contact.tags?.length > 0
                          ? <div className="flex flex-wrap gap-1">
                              {contact.tags.map(tag => (
                                <span
                                  key={tag}
                                  className="text-[11px] font-semibold text-tag bg-[rgba(108,92,255,0.13)] border border-[rgba(108,92,255,0.22)] px-[8px] py-[2px] rounded-full"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          : <span className="text-[13px] text-lower">—</span>
                        }
                      </td>
                      {/* Delete — hover-reveal, same pattern as card view */}
                      <td className="px-3 py-3 w-10">
                        <button
                          onClick={e => { e.stopPropagation(); setDeleteContactError(''); setConfirmDeleteContact(contact) }}
                          title="Delete contact"
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-low hover:text-danger hover:bg-[rgba(255,107,138,0.08)] opacity-0 group-hover:opacity-100 transition"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        ) : (

          /* ── CARD VIEW ── */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[14px]">
            {filteredContacts.map(contact => (
              <ContactListItem
                key={contact.id}
                contact={contact}
                onDeleteRequest={c => { setDeleteContactError(''); setConfirmDeleteContact(c) }}
              />
            ))}
          </div>

        )}

        {/* Delete all contacts — shown only when contacts exist and the list loaded cleanly */}
        {!loading && !fetchError && contacts.length > 0 && (
          <div className="mt-16 pt-5 border-t border-[rgba(255,255,255,0.05)] flex justify-center">
            <button
              onClick={() => { setDeleteAllError(''); setShowDeleteAll(true) }}
              className="text-[12px] font-medium text-lower hover:text-danger transition-colors"
            >
              Delete all contacts
            </button>
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

      {/* ── Individual contact delete confirmation modal ── */}
      {confirmDeleteContact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ animation: 'fade-in 0.15s ease-out' }}>
          <div
            className="absolute inset-0 bg-[rgba(0,0,0,0.65)]"
            onClick={() => { if (!deletingContact) setConfirmDeleteContact(null) }}
          />
          <div className="relative w-full max-w-[400px] bg-card border border-[rgba(255,255,255,0.09)] rounded-2xl p-6 shadow-[0_24px_64px_rgba(0,0,0,0.7)]">
            <div className="w-10 h-10 rounded-xl bg-[rgba(255,107,138,0.1)] border border-[rgba(255,107,138,0.2)] flex items-center justify-center mb-4">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
              </svg>
            </div>
            <h2 className="font-display font-bold text-[17px] text-hi mb-2">
              Delete {confirmDeleteContact.name}?
            </h2>
            <p className="text-[13.5px] text-muted leading-relaxed mb-5">
              This will permanently delete this contact and all their interactions. This cannot be undone.
            </p>
            {deleteContactError && (
              <p className="text-[13px] text-danger mb-4">{deleteContactError}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDeleteContact(null)}
                disabled={deletingContact}
                className="flex-1 bg-elevated border border-[rgba(255,255,255,0.09)] text-mid text-[14px] font-semibold py-[11px] rounded-[11px] hover:text-hi transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteContact(confirmDeleteContact)}
                disabled={deletingContact}
                className="flex-1 bg-[#FF6B8A] text-white text-[14px] font-bold py-[11px] rounded-[11px] hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                {deletingContact ? 'Deleting…' : 'Yes, delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete all contacts confirmation modal ── */}
      {showDeleteAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ animation: 'fade-in 0.15s ease-out' }}>
          <div
            className="absolute inset-0 bg-[rgba(0,0,0,0.65)]"
            onClick={() => {
              if (!deletingAll) { setShowDeleteAll(false); setDeleteAllInput(''); setDeleteAllError('') }
            }}
          />
          <div className="relative w-full max-w-[440px] bg-card border border-[rgba(255,255,255,0.09)] rounded-2xl p-6 shadow-[0_24px_64px_rgba(0,0,0,0.7)]">
            <div className="w-10 h-10 rounded-xl bg-[rgba(255,107,138,0.1)] border border-[rgba(255,107,138,0.2)] flex items-center justify-center mb-4">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <h2 className="font-display font-bold text-[17px] text-hi mb-2">Delete all contacts</h2>
            <p className="text-[13.5px] text-muted leading-relaxed mb-5">
              This will permanently delete all{' '}
              <strong className="text-hi">{contacts.length}</strong>{' '}
              {contacts.length === 1 ? 'contact' : 'contacts'} and all their interactions. This cannot be undone.
            </p>
            <label className="block text-[12.5px] font-semibold text-mid mb-2">
              Type <span className="font-mono text-hi">delete all contacts</span> to confirm
            </label>
            <input
              value={deleteAllInput}
              onChange={e => setDeleteAllInput(e.target.value)}
              placeholder="delete all contacts"
              autoFocus
              className="w-full bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(255,107,138,0.4)] transition-colors mb-4"
            />
            {deleteAllError && (
              <p className="text-[13px] text-danger mb-3">{deleteAllError}</p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => { setShowDeleteAll(false); setDeleteAllInput(''); setDeleteAllError('') }}
                disabled={deletingAll}
                className="flex-1 bg-elevated border border-[rgba(255,255,255,0.09)] text-mid text-[14px] font-semibold py-[11px] rounded-[11px] hover:text-hi transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAll}
                disabled={deletingAll || deleteAllInput !== 'delete all contacts'}
                className="flex-1 bg-[#FF6B8A] text-white text-[14px] font-bold py-[11px] rounded-[11px] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deletingAll
                  ? 'Deleting…'
                  : `Delete ${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'}`
                }
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ContactsPage
