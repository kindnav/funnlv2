import { useEffect, useState, useCallback, useMemo } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import ImportContactsModal from '../components/ImportContactsModal'
import TopBar from '../components/TopBar'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import {
  parseSortParam, buildDirectoryEntry, sortDirectoryEntries,
  filterByTag, searchDirectory, buildTagCounts, getLocalToday,
} from '../lib/contactDirectoryUtils'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelativeDate(dateStr) {
  if (!dateStr) return null
  const today = getLocalToday()
  const [ty, tm, td] = today.split('-').map(Number)
  const [dy, dm, dd] = dateStr.split('-').map(Number)
  const diff = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return `${diff} days ago`
  const d = new Date(Date.UTC(dy, dm - 1, dd))
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const sameYear = dy === ty
  return sameYear
    ? `${months[d.getUTCMonth()]} ${d.getUTCDate()}`
    : `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${dy}`
}

function formatFollowUpDate(dateStr) {
  if (!dateStr) return null
  const today = getLocalToday()
  if (dateStr === today) return 'Today'
  const [ty, tm, td] = today.split('-').map(Number)
  const [dy, dm, dd] = dateStr.split('-').map(Number)
  const diff = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000)
  const d = new Date(Date.UTC(dy, dm - 1, dd))
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const label = `${months[d.getUTCMonth()]} ${d.getUTCDate()}`
  if (diff > 0) return `${label} (overdue)`
  return label
}

// ── AttentionBadge ─────────────────────────────────────────────────────────────

function AttentionBadge({ category, nextFollowUp }) {
  if (category === 'overdue') {
    return (
      <span
        className="inline-flex items-center gap-[5px] text-[11px] font-semibold px-[8px] py-[3px] rounded-full flex-none"
        style={{ background: 'rgba(255,68,35,0.12)', color: 'var(--color-ember)' }}
      >
        <span className="w-[5px] h-[5px] rounded-full flex-none" style={{ background: 'var(--color-ember)' }} />
        {nextFollowUp ? formatFollowUpDate(nextFollowUp.follow_up_date) : 'Overdue'}
      </span>
    )
  }
  if (category === 'due_today') {
    return (
      <span
        className="inline-flex items-center gap-[5px] text-[11px] font-semibold px-[8px] py-[3px] rounded-full flex-none"
        style={{ background: 'rgba(255,184,77,0.12)', color: 'var(--color-warning)' }}
      >
        <span className="w-[5px] h-[5px] rounded-full flex-none" style={{ background: 'var(--color-warning)' }} />
        Due today
      </span>
    )
  }
  if (category === 'awaiting_response') {
    return (
      <span
        className="inline-flex items-center gap-[5px] text-[11px] font-semibold px-[8px] py-[3px] rounded-full flex-none"
        style={{ background: 'rgba(255,68,35,0.10)', color: 'var(--color-ember)' }}
      >
        <span className="w-[5px] h-[5px] rounded-full flex-none" style={{ background: 'var(--color-accent)' }} />
        Awaiting reply
      </span>
    )
  }
  return null
}

// ── DirectoryRow ──────────────────────────────────────────────────────────────

function DirectoryRow({ entry, expanded, onToggleExpand, onDeleteRequest }) {
  const navigate = useNavigate()
  const { _status, _interactions } = entry
  const { category, nextFollowUp, lastInteraction } = _status

  const lastNote = _interactions.find(i => i.notes?.trim())
  const hasTags = entry.tags && entry.tags.length > 0
  const hasEmail = !!entry.email
  const hasLinkedIn = !!entry.linkedin_url

  function handleRowClick(e) {
    // Don't navigate when clicking buttons or expanded content
    if (e.target.closest('button') || e.target.closest('a')) return
    navigate(`/contacts/${entry.id}`)
  }

  function handleExpandClick(e) {
    e.stopPropagation()
    onToggleExpand(entry.id)
  }

  return (
    <div className="border-b border-line-1 last:border-b-0">
      {/* Main row */}
      <div
        onClick={handleRowClick}
        className="flex items-center gap-3 py-3 px-4 md:px-5 cursor-pointer group hover:bg-elevated transition-colors"
      >
        {/* Avatar */}
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold flex-none"
          style={{ background: getAvatarColor(entry.name), color: 'var(--color-paper)' }}
        >
          {getInitials(entry.name)}
        </div>

        {/* Name + subtitle */}
        <div className="flex-1 min-w-0">
          <p className="text-[13.5px] font-semibold text-hi truncate leading-tight">{entry.name}</p>
          {(entry.role || entry.company) && (
            <p className="text-[12px] text-muted truncate leading-tight mt-[1px]">
              {[entry.role, entry.company].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>

        {/* Tags — desktop only */}
        {hasTags && (
          <div className="hidden md:flex gap-1 flex-none max-w-[200px] overflow-hidden">
            {entry.tags.slice(0, 3).map(tag => (
              <span
                key={tag}
                className="text-[11px] font-semibold px-[7px] py-[2px] rounded-full border border-line-2 flex-none"
                style={{ background: 'var(--color-elevated)', color: 'var(--color-muted)' }}
              >
                {tag}
              </span>
            ))}
            {entry.tags.length > 3 && (
              <span className="text-[11px] text-low flex-none">+{entry.tags.length - 3}</span>
            )}
          </div>
        )}

        {/* Attention badge */}
        <div className="hidden md:block flex-none">
          <AttentionBadge category={category} nextFollowUp={nextFollowUp} />
        </div>

        {/* Last interaction: type + date — desktop */}
        {lastInteraction && (
          <div className="hidden md:flex items-center gap-1.5 flex-none">
            <span className="text-[11px] font-mono text-lower">{lastInteraction.type}</span>
            <span className="text-[11.5px] text-low">{formatRelativeDate(lastInteraction.interaction_date)}</span>
          </div>
        )}

        {/* Quick actions: Email + LinkedIn — hover-reveal, desktop only */}
        <div className="hidden md:flex items-center gap-1 flex-none opacity-0 group-hover:opacity-100 transition-opacity">
          {hasEmail ? (
            <a
              href={`mailto:${entry.email}`}
              onClick={e => e.stopPropagation()}
              title={entry.email}
              className="w-7 h-7 flex items-center justify-center rounded-[7px] border border-line-2 hover:border-line-3 transition-colors"
              style={{ background: 'var(--color-card)' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
              </svg>
            </a>
          ) : (
            <div title="No email saved"
              className="w-7 h-7 flex items-center justify-center rounded-[7px] border border-line-2 opacity-30"
              style={{ background: 'var(--color-card)' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
              </svg>
            </div>
          )}
          {hasLinkedIn ? (
            <a
              href={entry.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              title="Open LinkedIn"
              className="w-7 h-7 flex items-center justify-center rounded-[7px] border border-line-2 hover:border-line-3 transition-colors text-[11px] font-bold font-mono"
              style={{ background: 'var(--color-card)', color: 'var(--color-low)' }}
            >
              in
            </a>
          ) : (
            <div title="No LinkedIn saved"
              className="w-7 h-7 flex items-center justify-center rounded-[7px] border border-line-2 opacity-30 text-[11px] font-bold font-mono"
              style={{ background: 'var(--color-card)', color: 'var(--color-low)' }}
            >
              in
            </div>
          )}
          <button
            onClick={e => { e.stopPropagation(); navigate(`/contacts/${entry.id}`, { state: { openInteractionForm: true } }) }}
            title="Log interaction"
            className="w-7 h-7 flex items-center justify-center rounded-[7px] border border-line-2 hover:border-line-3 transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--color-ember)]"
            style={{ background: 'var(--color-card)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </button>
        </div>

        {/* Mobile: show attention badge */}
        <div className="md:hidden flex-none">
          <AttentionBadge category={category} nextFollowUp={nextFollowUp} />
        </div>

        {/* Expand chevron */}
        <button
          onClick={handleExpandClick}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="w-7 h-7 flex items-center justify-center rounded-lg flex-none text-low hover:text-mid transition-colors"
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
          >
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div
          className="px-4 md:px-5 pb-4 pt-1"
          onClick={e => e.stopPropagation()}
        >
          <div className="ml-11 border border-line-2 rounded-xl p-4 space-y-3"
            style={{ background: 'var(--color-card)' }}
          >
            {/* Next step */}
            {nextFollowUp ? (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-low mb-1">Next step</p>
                <p className="text-[13px] text-hi">
                  Follow-up scheduled for{' '}
                  <span
                    className="font-semibold"
                    style={{ color: category === 'overdue' ? 'var(--color-ember)' : category === 'due_today' ? 'var(--color-warning)' : 'var(--color-hi)' }}
                  >
                    {formatFollowUpDate(nextFollowUp.follow_up_date)}
                  </span>
                </p>
              </div>
            ) : category === 'awaiting_response' ? (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-low mb-1">Next step</p>
                <p className="text-[13px] text-mid">Waiting for a response</p>
              </div>
            ) : null}

            {/* Relationship note */}
            {entry.relationship_note && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-low mb-1">Why they matter</p>
                <p className="text-[13px] text-muted line-clamp-2">{entry.relationship_note}</p>
              </div>
            )}

            {/* Most recent note */}
            {lastNote && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-low mb-1">
                  Last note · {formatRelativeDate(lastNote.interaction_date)}
                </p>
                <p className="text-[13px] text-muted line-clamp-2">{lastNote.notes}</p>
              </div>
            )}

            {/* Empty state */}
            {!nextFollowUp && category !== 'awaiting_response' && !entry.relationship_note && !lastNote && (
              <p className="text-[13px] text-low">No notes yet.</p>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              <button
                onClick={() => navigate(`/contacts/${entry.id}`, { state: { openInteractionForm: true } })}
                className="text-[12px] font-semibold px-3 py-[6px] rounded-[8px] hover:opacity-90 transition-opacity"
                style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}
              >
                Log interaction
              </button>
              <button
                onClick={() => navigate(`/contacts/${entry.id}`)}
                className="text-[12px] font-semibold px-3 py-[6px] rounded-[8px] border border-line-2 hover:border-line-3 transition-colors"
                style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
              >
                View profile
              </button>
              {hasEmail ? (
                <a
                  href={`mailto:${entry.email}`}
                  onClick={e => e.stopPropagation()}
                  className="text-[12px] font-semibold px-3 py-[6px] rounded-[8px] border border-line-2 hover:border-line-3 transition-colors no-underline"
                  style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
                >
                  Email
                </a>
              ) : (
                <span title="No email saved"
                  className="text-[12px] font-semibold px-3 py-[6px] rounded-[8px] border border-line-2 opacity-30 cursor-not-allowed"
                  style={{ background: 'var(--color-elevated)', color: 'var(--color-low)' }}
                >
                  Email
                </span>
              )}
              {hasLinkedIn ? (
                <a
                  href={entry.linkedin_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="text-[12px] font-semibold px-3 py-[6px] rounded-[8px] border border-line-2 hover:border-line-3 transition-colors no-underline"
                  style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
                >
                  LinkedIn
                </a>
              ) : (
                <span title="No LinkedIn saved"
                  className="text-[12px] font-semibold px-3 py-[6px] rounded-[8px] border border-line-2 opacity-30 cursor-not-allowed"
                  style={{ background: 'var(--color-elevated)', color: 'var(--color-low)' }}
                >
                  LinkedIn
                </span>
              )}
              <button
                onClick={() => onDeleteRequest(entry)}
                className="ml-auto text-[12px] font-medium px-3 py-[6px] rounded-[8px] text-low hover:text-danger transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── ContactsPage ──────────────────────────────────────────────────────────────

const SORT_LABELS = {
  attention: 'Needs attention',
  active: 'Recently active',
  added: 'Recently added',
  az: 'A – Z',
}

function ContactsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [contacts, setContacts] = useState([])
  const [interactions, setInteractions] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState(() => new URLSearchParams(location.search).get('search') || '')
  const [expandedId, setExpandedId] = useState(null)

  // Individual contact delete
  const [confirmDeleteContact, setConfirmDeleteContact] = useState(null)
  const [deletingContact, setDeletingContact] = useState(false)
  const [deleteContactError, setDeleteContactError] = useState('')

  // Delete all contacts
  const [showDeleteAll, setShowDeleteAll] = useState(false)
  const [deleteAllInput, setDeleteAllInput] = useState('')
  const [deletingAll, setDeletingAll] = useState(false)
  const [deleteAllError, setDeleteAllError] = useState('')

  // URL-based state: ?tag=, ?sort=, and ?search= (one-way: URL → state only)
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTag = searchParams.get('tag') || ''
  const activeSort = parseSortParam(searchParams.get('sort'))

  // Sync searchQuery when ?search= param changes (e.g. arriving from Dashboard firm row).
  // User typing does NOT write back to the URL — typing updates local state only.
  const searchURLParam = searchParams.get('search') || ''
  useEffect(() => { setSearchQuery(searchURLParam) }, [searchURLParam])

  function setActiveTag(tag) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (tag) next.set('tag', tag); else next.delete('tag')
      return next
    })
  }

  function setActiveSort(sort) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (sort && sort !== 'attention') next.set('sort', sort); else next.delete('sort')
      return next
    })
  }

  // Auto-open import modal when navigating via ?import=1.
  // importParam is derived from searchParams so this effect re-fires whenever
  // the URL changes — including when CommandPalette navigates to /contacts?import=1
  // while ContactsPage is already mounted (mount-only [] would miss that case).
  const importParam = searchParams.get('import')
  useEffect(() => {
    if (importParam === '1') {
      setImportOpen(true)
      // Remove the signal with replace so refresh and Back never reopen the modal.
      // Other existing params (tag, sort, importBatch, etc.) are preserved because
      // we delete only the 'import' key from the mutable URLSearchParams copy.
      setSearchParams(prev => { prev.delete('import'); return prev }, { replace: true })
    }
  }, [importParam])

  useEffect(() => { fetchAll() }, [])

  // Refetch the contact list when a contact is added via the global drawer.
  useEffect(() => {
    const handler = () => fetchAll()
    window.addEventListener('funnl:contacts-changed', handler)
    return () => window.removeEventListener('funnl:contacts-changed', handler)
  }, [])

  async function fetchAll() {
    setLoading(true)
    setFetchError('')
    const [contactsRes, interactionsRes] = await Promise.all([
      supabase.from('contacts').select('*').order('created_at', { ascending: false }),
      supabase.from('interactions')
        .select('id, contact_id, interaction_date, type, notes, follow_up_date, outreach_status')
        .order('interaction_date', { ascending: false }),
    ])

    if (contactsRes.error) {
      setFetchError(contactsRes.error.message)
    } else {
      setContacts(contactsRes.data)
      setInteractions(interactionsRes.data || [])
    }
    setLoading(false)
  }

  function toggleExpand(id) {
    setExpandedId(prev => prev === id ? null : id)
  }

  async function handleDeleteContact(contact) {
    setDeletingContact(true)
    setDeleteContactError('')
    const { error } = await supabase.from('contacts').delete().eq('id', contact.id)
    setDeletingContact(false)
    if (error) { setDeleteContactError(error.message); return }
    setConfirmDeleteContact(null)
    fetchAll()
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
    const { error } = await supabase.from('contacts').delete().eq('user_id', user.id)
    setDeletingAll(false)
    if (error) { setDeleteAllError(`Delete failed: ${error.message}`); return }
    setShowDeleteAll(false)
    setDeleteAllInput('')
    fetchAll()
  }

  // Build directory entries with attention status
  const today = getLocalToday()
  const allEntries = contacts.map(c => buildDirectoryEntry(c, interactions, today))

  // Tag filter pills: top 8 by count
  const tagCounts = buildTagCounts(contacts)
  const sortedTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([tag]) => tag)

  // Apply tag filter → search → sort
  const tagFiltered = filterByTag(allEntries, activeTag)
  const searched = searchDirectory(tagFiltered, searchQuery)
  const sorted = sortDirectoryEntries(searched, activeSort)

  // Import batch filter: when returning from import modal, show only just-imported contacts
  const importBatchIds = useMemo(() => {
    const ids = location.state?.importBatch
    return Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null
  }, [location.state?.importBatch])

  const displayEntries = importBatchIds
    ? sorted.filter(e => importBatchIds.has(e.id))
    : sorted

  const displayCount = (searchQuery.trim() || activeTag || importBatchIds) ? displayEntries.length : contacts.length

  return (
    <div className="min-h-screen bg-surface">

      {/* TopBar */}
      <TopBar
        title="Contacts"
        count={loading ? null : displayCount}
        onSearchClick={() => window.dispatchEvent(new CustomEvent('funnl:open-command-palette'))}
        searchPlaceholder="Find, log, or ask anything…"
        actions={
          <button
            onClick={() => setImportOpen(true)}
            className="h-[34px] flex items-center gap-[6px] px-[11px] rounded-[9px] border border-line-2 text-[13px] font-medium transition-colors hover:border-line-3"
            style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
            title="Import contacts"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span className="hidden md:inline">Import</span>
          </button>
        }
        cta={
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('funnl:open-add-contact'))}
            className="h-[34px] flex items-center gap-[6px] px-[12px] rounded-[9px] text-[13px] font-semibold hover:opacity-90 transition-opacity"
            style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            <span className="hidden md:inline">Add contact</span>
          </button>
        }
      />

      {/* Main content */}
      <div className="px-0">

        {/* Search + sort bar */}
        <div className="px-4 md:px-5 py-4 flex items-center gap-3 border-b border-line-1">
          <div className="flex-1 flex items-center gap-[10px] bg-input border border-line-2 rounded-xl px-[14px] py-[10px]">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/>
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search name, company, role, notes…"
              className="flex-1 bg-transparent text-[13.5px] text-hi placeholder-low outline-none"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="text-low hover:text-mid transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18"/>
                </svg>
              </button>
            )}
          </div>

          {/* Sort selector */}
          <select
            value={activeSort}
            onChange={e => setActiveSort(e.target.value)}
            className="h-[38px] pl-[10px] pr-[28px] rounded-[9px] border border-line-2 text-[12.5px] font-medium outline-none cursor-pointer appearance-none transition-colors hover:border-line-3"
            style={{
              background: `var(--color-elevated) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239A9AA5' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 8px center`,
              color: 'var(--color-mid)',
            }}
          >
            {Object.entries(SORT_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>

        {/* Tag filter pills */}
        {!loading && !fetchError && contacts.length > 0 && (
          <div className="px-4 md:px-5 py-3 flex gap-2 flex-wrap border-b border-line-1">
            {/* All pill — ink fill when active */}
            <button
              onClick={() => setActiveTag('')}
              className="text-[12px] font-bold px-[12px] py-[5px] rounded-full transition-colors"
              style={
                activeTag === ''
                  ? { background: 'var(--color-ink)', color: 'var(--color-paper)' }
                  : { background: 'var(--color-elevated)', color: 'var(--color-mid)', border: '1px solid var(--color-line-2)' }
              }
            >
              All · {contacts.length}
            </button>

            {/* Tag pills — pale ember wash when active */}
            {sortedTags.map(tag => {
              const isActive = activeTag.toLowerCase() === tag.toLowerCase()
              return (
                <button
                  key={tag}
                  onClick={() => setActiveTag(isActive ? '' : tag)}
                  className="text-[12px] font-bold px-[12px] py-[5px] rounded-full transition-colors"
                  style={
                    isActive
                      ? {
                          background: 'rgba(255,68,35,0.1)',
                          color: 'var(--color-ember)',
                          border: '1px solid var(--color-ember)',
                        }
                      : {
                          background: 'var(--color-elevated)',
                          color: 'var(--color-mid)',
                          border: '1px solid var(--color-line-2)',
                        }
                  }
                >
                  {tag} · {tagCounts[tag.toLowerCase()] || tagCounts[tag] || 0}
                </button>
              )
            })}
          </div>
        )}

        {/* Import batch filter strip — shown when returning from import modal */}
        {importBatchIds && !loading && !fetchError && (
          <div className="px-4 md:px-5 py-2.5 flex items-center gap-3 border-b border-line-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-ember)" strokeWidth="2" strokeLinecap="round">
              <path d="M3 4H21L15 12.5V20H9V12.5Z"/>
            </svg>
            <span className="text-[13px] font-medium text-mid flex-1">
              Showing {displayEntries.length} just-imported {displayEntries.length === 1 ? 'contact' : 'contacts'}
            </span>
            <button
              onClick={() => navigate('/contacts', { replace: true })}
              className="text-[12px] font-semibold text-low hover:text-mid transition-colors"
            >
              Clear ×
            </button>
          </div>
        )}

        {/* Directory content */}
        {loading ? (
          <p className="text-sm text-muted px-4 py-8">Loading…</p>

        ) : fetchError ? (
          <div className="text-center py-12 px-4">
            <div
              className="w-12 h-12 mx-auto mb-4 rounded-xl border flex items-center justify-center"
              style={{ background: 'rgba(194,51,77,0.08)', borderColor: 'rgba(194,51,77,0.2)' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
              </svg>
            </div>
            <p className="text-hi font-semibold mb-2">Couldn't load contacts</p>
            <p className="text-muted text-sm mb-5">Check your connection and try again.</p>
            <button onClick={fetchAll} className="text-accent text-sm font-semibold hover:opacity-80 transition-opacity">Try again</button>
          </div>

        ) : contacts.length === 0 ? (
          <div className="text-center py-16 px-4">
            <div className="w-[72px] h-[72px] mx-auto mb-6 rounded-[20px] bg-elevated border border-line-2 flex items-center justify-center">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="7" r="4"/>
                <path d="M3 20v-1a6 6 0 0 1 12 0v1"/>
                <path d="M18 9v6M21 12h-6"/>
              </svg>
            </div>
            <h2 className="font-display text-[20px] font-bold text-hi mb-2">Start building your network</h2>
            <p className="text-[14px] leading-relaxed text-muted mb-6 max-w-[320px] mx-auto">
              Add your first contact to start tracking coffee chats, follow-ups, and warm intros in one place.
            </p>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('funnl:open-add-contact'))}
              className="inline-flex items-center gap-2 text-[14px] font-bold px-5 py-3 rounded-xl hover:opacity-90 transition-opacity"
              style={{ background: 'var(--color-ember)', color: 'var(--color-paper)' }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              Add your first contact
            </button>
          </div>

        ) : displayEntries.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center px-4">
            <div className="w-12 h-12 mb-4 rounded-xl bg-elevated border border-line-2 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/>
              </svg>
            </div>
            <p className="text-[14px] font-semibold text-hi mb-1">No contacts found</p>
            <p className="text-[13px] text-muted mb-4">
              {importBatchIds ? 'Imported contacts not found. Try refreshing.' : searchQuery ? `No results for "${searchQuery}"` : `No contacts tagged "${activeTag}"`}
            </p>
            <button
              onClick={() => { setSearchQuery(''); setActiveTag(''); navigate('/contacts', { replace: true }) }}
              className="text-[13px] font-medium text-accent hover:opacity-80 transition-opacity"
            >
              Clear filters
            </button>
          </div>

        ) : (
          <div className="border-b border-line-1">
            {displayEntries.map(entry => (
              <DirectoryRow
                key={entry.id}
                entry={entry}
                expanded={expandedId === entry.id}
                onToggleExpand={toggleExpand}
                onDeleteRequest={c => { setDeleteContactError(''); setConfirmDeleteContact(c) }}
              />
            ))}
          </div>
        )}

        {/* Delete all contacts — de-emphasized, shown only when data loaded cleanly */}
        {!loading && !fetchError && contacts.length > 0 && (
          <div className="py-5 flex justify-center">
            <button
              onClick={() => { setDeleteAllError(''); setShowDeleteAll(true) }}
              className="text-[12px] font-medium text-lower hover:text-danger transition-colors"
            >
              Delete all contacts
            </button>
          </div>
        )}
      </div>

      {/* Import modal */}
      {importOpen && (
        <ImportContactsModal
          onClose={() => setImportOpen(false)}
          onImported={() => fetchAll()}
        />
      )}

      {/* Individual contact delete modal */}
      {confirmDeleteContact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ animation: 'fade-in 0.15s ease-out' }}>
          <div className="absolute inset-0" style={{ background: 'var(--color-backdrop)' }} onClick={() => { if (!deletingContact) setConfirmDeleteContact(null) }} />
          <div className="relative w-full max-w-[400px] bg-card border border-line-3 rounded-2xl p-6 shadow-[0_24px_64px_rgba(0,0,0,0.3)]">
            <div className="w-10 h-10 rounded-xl border flex items-center justify-center mb-4"
              style={{ background: 'rgba(194,51,77,0.08)', borderColor: 'rgba(194,51,77,0.2)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
              </svg>
            </div>
            <h2 className="font-display font-bold text-[17px] text-hi mb-2">Delete {confirmDeleteContact.name}?</h2>
            <p className="text-[13.5px] text-muted leading-relaxed mb-5">
              This will permanently delete this contact and all their interactions. This cannot be undone.
            </p>
            {deleteContactError && <p className="text-[13px] text-danger mb-4">{deleteContactError}</p>}
            <div className="flex gap-3">
              <button onClick={() => setConfirmDeleteContact(null)} disabled={deletingContact}
                className="flex-1 bg-elevated border border-line-3 text-mid text-[14px] font-semibold py-[11px] rounded-[11px] hover:text-hi transition-colors disabled:opacity-40">
                Cancel
              </button>
              <button onClick={() => handleDeleteContact(confirmDeleteContact)} disabled={deletingContact}
                className="flex-1 text-[#F7F2E7] text-[14px] font-bold py-[11px] rounded-[11px] hover:opacity-90 transition-opacity disabled:opacity-40"
                style={{ background: 'var(--color-danger)' }}>
                {deletingContact ? 'Deleting…' : 'Yes, delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete all contacts modal */}
      {showDeleteAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ animation: 'fade-in 0.15s ease-out' }}>
          <div className="absolute inset-0" style={{ background: 'var(--color-backdrop)' }}
            onClick={() => { if (!deletingAll) { setShowDeleteAll(false); setDeleteAllInput(''); setDeleteAllError('') } }} />
          <div className="relative w-full max-w-[440px] bg-card border border-line-3 rounded-2xl p-6 shadow-[0_24px_64px_rgba(0,0,0,0.3)]">
            <div className="w-10 h-10 rounded-xl border flex items-center justify-center mb-4"
              style={{ background: 'rgba(194,51,77,0.08)', borderColor: 'rgba(194,51,77,0.2)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <h2 className="font-display font-bold text-[17px] text-hi mb-2">Delete all contacts</h2>
            <p className="text-[13.5px] text-muted leading-relaxed mb-5">
              This will permanently delete all <strong className="text-hi">{contacts.length}</strong>{' '}
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
              className="w-full bg-input border border-line-3 rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-lower outline-none focus:border-[rgba(194,51,77,0.4)] transition-colors mb-4"
            />
            {deleteAllError && <p className="text-[13px] text-danger mb-3">{deleteAllError}</p>}
            <div className="flex gap-3">
              <button onClick={() => { setShowDeleteAll(false); setDeleteAllInput(''); setDeleteAllError('') }} disabled={deletingAll}
                className="flex-1 bg-elevated border border-line-3 text-mid text-[14px] font-semibold py-[11px] rounded-[11px] hover:text-hi transition-colors disabled:opacity-40">
                Cancel
              </button>
              <button onClick={handleDeleteAll} disabled={deletingAll || deleteAllInput !== 'delete all contacts'}
                className="flex-1 text-[#F7F2E7] text-[14px] font-bold py-[11px] rounded-[11px] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--color-danger)' }}>
                {deletingAll ? 'Deleting…' : `Delete ${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ContactsPage
