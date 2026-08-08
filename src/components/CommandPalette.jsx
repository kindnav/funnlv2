/**
 * CommandPalette — ⌘K / Ctrl+K global search + quick actions.  STAGE 10.
 *
 * What is implemented:
 *   ✅ ⌘K / Ctrl+K keyboard shortcut (macOS + Windows/Linux)
 *   ✅ funnl:open-command-palette CustomEvent trigger
 *   ✅ Escape + backdrop to close; focus restored to trigger element
 *   ✅ Focus trap: Tab / Shift+Tab cycle within dialog; never escapes
 *   ✅ Body scroll lock while open
 *   ✅ WCAG: role="dialog", aria-modal, aria-label, combobox, listbox, aria-live
 *   ✅ Contact search: name, company, role, relationship_note
 *   ✅ Notes search: interaction notes (concurrent query, distinct group)
 *   ✅ Tags searched on contact results client-side after fetch
 *   ✅ Safe ILIKE pattern escaping (%, _, \) via escapeIlike
 *   ✅ 200ms debounce on non-empty queries
 *   ✅ Stale-request generation guard (searchGenRef)
 *   ✅ Recent contacts: localStorage (user-scoped v1) + DB batch fetch
 *   ✅ Recent writeback on contact activation (not on hover/keyboard highlight)
 *   ✅ Account switch: clears query, results, and local recent state
 *   ✅ Quick actions: Add contact, Log interaction, Import contacts
 *   ✅ Log Interaction: zero contacts → Add drawer; 1 contact → navigate direct;
 *       2+ contacts → inline contact picker within the palette
 *   ✅ Import action: navigates to /contacts?import=1
 *   ✅ Navigation commands: Home, Contacts, Follow-ups, (AI for Pro), Settings
 *   ✅ AI handoff (Pro only): "Ask Funnl AI about X" result, Arrow+Enter to select,
 *       navigates to /ai with { aiPrompt } router state consumed by FunnlAIPage
 *   ✅ No-results: "Add X as a contact" with safe name prefill
 *   ✅ Pro status: uses shared ProStatusProvider (one RPC, no independent call)
 *   ✅ Non-Pro: no AI row, no AI navigation command
 *   ✅ Partial error: contacts fail shows note results and vice versa
 *   ✅ Mobile full-screen: full viewport, Cancel button, safe-area padding
 *   ✅ Reduced motion: palette entrance animation suppressed
 *   ✅ Result groups: Recent | Contacts | Notes | Quick Actions | Navigation | Ask AI
 *   ✅ Safe highlight: highlightSegments (segments, no HTML)
 *   ✅ Safe snippet: extractNoteSnippet (no HTML)
 *   ✅ Explicit selected columns in all queries (no select('*'))
 *
 * Deferred:
 *   ❌ Partial tag DB search (requires custom RPC; tags checked client-side only)
 *   ❌ Sequential G-chord shortcuts (complex; document as deviation)
 *   ❌ Note-specific scroll in ContactDetailPage (not yet supported by that page)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProStatus } from '../lib/useProStatus'
import { classifyProStatus } from '../lib/pro-ui-status'
import { supabase } from '../lib/supabase'
import { resolveActivationAction } from '../lib/activationActionCoordinator'
import { buildPickerNavigationState } from '../lib/contactPickerUtils'
import {
  normalizeQuery,
  escapeIlike,
  highlightSegments,
  extractNoteSnippet,
  recentContactsKey,
  readRecentContacts,
  writeRecentContact,
  clearRecentContacts,
  buildAIPrefillState,
  buildAIHandoffLabel,
  buildNoResultPrefill,
  NAVIGATION_COMMANDS,
  filterNavigationCommands,
} from '../lib/searchUtils'
import {
  MAX_SEARCH_QUERY_LENGTH,
  shouldIgnoreKey,
  getItemId,
  getActiveItemId,
  buildFlatItems,
} from '../lib/commandPaletteUtils'

// ── Internal helpers ──────────────────────────────────────────────────────────

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
const DEBOUNCE_MS = 200
const CONTACT_LIMIT = 7
const NOTE_LIMIT = 5
const RECENT_DISPLAY = 6
// MAX_SEARCH_QUERY_LENGTH imported from commandPaletteUtils — keeps the DB pattern within URL-safe bounds

// Check if prefers-reduced-motion is active (SSR-safe).
function prefersReducedMotion() {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

// ── Highlight span (safe — segments only, no raw HTML injection) ─────────────

function Highlight({ text, query }) {
  if (!text) return null
  const segments = highlightSegments(String(text), query)
  return (
    <>
      {segments.map((seg, i) =>
        seg.match
          ? <mark key={i} className="rounded-[2px] px-[1px]" style={{ background: 'rgba(255,68,35,0.18)', color: 'inherit' }}>{seg.text}</mark>
          : <span key={i}>{seg.text}</span>
      )}
    </>
  )
}

// ── Section heading (not focusable, not a result) ─────────────────────────────

function SectionLabel({ children }) {
  return (
    <div className="px-[14px] pt-[10px] pb-[4px]" aria-hidden="true">
      <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--color-low)' }}>
        {children}
      </span>
    </div>
  )
}

// ── Contact avatar initials ────────────────────────────────────────────────────

function ContactAvatar({ name, size = 28 }) {
  const initial = (name || '?').charAt(0).toUpperCase()
  return (
    <span
      className="rounded-full flex items-center justify-center flex-none text-[10px] font-bold"
      style={{ width: size, height: size, background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CommandPalette() {
  const navigate = useNavigate()

  // ── Core state ────────────────────────────────────────────────────────────
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [uid, setUid] = useState(null)

  // Search results
  const [contactResults, setContactResults] = useState([])
  const [noteResults, setNoteResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [errorContacts, setErrorContacts] = useState(null)
  const [errorNotes, setErrorNotes] = useState(null)

  // Recent contacts
  const [recentContacts, setRecentContacts] = useState([])    // hydrated contact objects
  const [recentIdsLoaded, setRecentIdsLoaded] = useState(false)

  // Keyboard / active index
  const [activeIdx, setActiveIdx] = useState(0)

  // Log interaction inline picker
  const [pickerContacts, setPickerContacts] = useState(null)  // null=hidden; []=loading; [...]=ready
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')

  // ── Refs ──────────────────────────────────────────────────────────────────
  const inputRef   = useRef(null)
  const panelRef   = useRef(null)
  const triggerRef = useRef(null)        // element focused when palette opened → restored on close

  // Stale-request guard: increment before each search; discard responses with old counters.
  const searchGenRef = useRef(0)

  // Debounce timer
  const debounceRef = useRef(null)

  // Auth subscription
  const authSubRef = useRef(null)

  // Mounted guard (prevents state updates after unmount)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // Pending handoff: set by closepal('handoff', fn) and consumed by the effect
  // below once open flips to false (scroll-lock and focus-trap both released).
  const handoffRef = useRef(null)

  // ── Pro status ────────────────────────────────────────────────────────────
  // Shared ProStatusProvider — one RPC per app mount, broadcast to all consumers.
  const proStatus = useProStatus()
  const displayStatus = classifyProStatus(proStatus)
  const canUsePro = displayStatus === 'permanent' || displayStatus === 'trial'

  // ── UID fetch + auth subscription ─────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!mountedRef.current) return
      setUid(data.session?.user?.id ?? null)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mountedRef.current) return
      const newUid = session?.user?.id ?? null
      setUid(prev => {
        if (prev !== null && prev !== newUid) {
          // Account switch — clear all in-memory state immediately.
          // Persistent localStorage history (under each uid's scoped key) is
          // intentionally preserved so User A's recents survive a switch back.
          // clearRecentContacts(prev) is NOT called here; it is reserved for
          // explicit user-initiated history deletion.
          searchGenRef.current++
          setOpen(false)
          setQuery('')
          setContactResults([])
          setNoteResults([])
          setLoading(false)
          setErrorContacts(null)
          setErrorNotes(null)
          setRecentContacts([])
          setRecentIdsLoaded(false)
          setActiveIdx(0)
          setPickerContacts(null)
        }
        return newUid
      })
    })
    authSubRef.current = subscription

    return () => {
      authSubRef.current?.unsubscribe()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // ── Open / close ──────────────────────────────────────────────────────────
  const openPalette = useCallback(() => {
    triggerRef.current = document.activeElement
    setOpen(true)
    setQuery('')
    setContactResults([])
    setNoteResults([])
    setActiveIdx(0)
    setPickerContacts(null)
    setPickerQuery('')
    setErrorContacts(null)
    setErrorNotes(null)
  }, [])

  // reason: 'dismiss' (Escape / backdrop / Cancel) — restores focus to trigger.
  //         'handoff' (action / navigation) — suppresses focus restore; executes
  //         handoffFn after the palette has fully closed so the next interactive
  //         surface takes focus cleanly with no competing focus-trap.
  const closepal = useCallback((reason = 'dismiss', handoffFn = null) => {
    // Increment generation so any in-flight DB query is treated as stale and
    // its setState callbacks are discarded.  Debounce must be cleared first so
    // no new query can start after we close.
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null }
    searchGenRef.current++
    // Store callback before flipping open; the post-close effect fires it once
    // open becomes false and the focus-trap / scroll-lock are released.
    if (reason === 'handoff' && typeof handoffFn === 'function') {
      handoffRef.current = handoffFn
    }
    setOpen(false)
    setQuery('')
    setContactResults([])
    setNoteResults([])
    setLoading(false)
    setErrorContacts(null)
    setErrorNotes(null)
    setActiveIdx(0)
    setPickerContacts(null)
    // Restore focus only for dismiss — handoff actions will activate their own
    // destination surface and must not fight it for focus.
    if (reason === 'dismiss') {
      const trigger = triggerRef.current
      if (trigger && typeof trigger.focus === 'function') {
        setTimeout(() => { try { trigger.focus() } catch (_) {} }, 0)
      }
    }
  }, [])

  // Execute the pending handoff after the palette has closed and its focus-trap
  // and scroll-lock have been released (open transitions false → effect fires).
  useEffect(() => {
    if (!open && handoffRef.current) {
      const fn = handoffRef.current
      handoffRef.current = null
      fn()
    }
  }, [open])

  // ── Global keyboard shortcut + event listeners ─────────────────────────────
  useEffect(() => {
    const onEvent = () => openPalette()
    window.addEventListener('funnl:open-command-palette', onEvent)

    function onKey(e) {
      // ⌘K / Ctrl+K — prevent browser default (link focusing, etc.)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (open) {
          // Already open — refocus the search input rather than toggling closed
          inputRef.current?.focus()
        } else {
          openPalette()
        }
        return
      }
      if (e.key === 'Escape' && open) closepal('dismiss')
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('funnl:open-command-palette', onEvent)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, openPalette, closepal])

  // Focus the search input when the palette opens
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [open])

  // Body scroll lock
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = prev }
    }
  }, [open])

  // ── Focus trap ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    function onTab(e) {
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(el => !el.closest('[hidden]'))
      if (focusable.length === 0) { e.preventDefault(); return }
      const first = focusable[0]
      const last  = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first || !panel.contains(document.activeElement)) {
          e.preventDefault(); last.focus()
        }
      } else {
        if (document.activeElement === last || !panel.contains(document.activeElement)) {
          e.preventDefault(); first.focus()
        }
      }
    }
    window.addEventListener('keydown', onTab)
    return () => window.removeEventListener('keydown', onTab)
  }, [open])

  // ── Hydrate recent contacts ───────────────────────────────────────────────
  useEffect(() => {
    if (!open || recentIdsLoaded || !uid) return

    const ids = readRecentContacts(uid)
    setRecentIdsLoaded(true)

    if (ids.length === 0) {
      // Fallback: fetch 6 most-recently created contacts
      supabase
        .from('contacts')
        .select('id, name, company, role')
        .order('created_at', { ascending: false })
        .limit(RECENT_DISPLAY)
        .then(({ data }) => {
          if (mountedRef.current) setRecentContacts(data || [])
        })
    } else {
      // Batch fetch by IDs (one query)
      supabase
        .from('contacts')
        .select('id, name, company, role')
        .in('id', ids.slice(0, RECENT_DISPLAY))
        .then(({ data }) => {
          if (!mountedRef.current) return
          // Restore storage order: hydrated rows may come back in any DB order
          const byId = Object.fromEntries((data || []).map(c => [c.id, c]))
          const ordered = ids.slice(0, RECENT_DISPLAY).map(id => byId[id]).filter(Boolean)
          setRecentContacts(ordered)
        })
    }
  }, [open, uid, recentIdsLoaded])

  // ── Debounced search ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const norm = normalizeQuery(query)

    if (!norm) {
      setContactResults([])
      setNoteResults([])
      setLoading(false)
      setErrorContacts(null)
      setErrorNotes(null)
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null }
      return
    }

    setLoading(true)

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const gen = ++searchGenRef.current

      // Cap normalised query at MAX_SEARCH_QUERY_LENGTH characters so large
      // clipboard pastes never produce an oversized PostgREST request.
      const boundNorm = norm.slice(0, MAX_SEARCH_QUERY_LENGTH)
      const escaped   = escapeIlike(boundNorm)
      const pattern   = `%${escaped}%`

      // Safe filter strategy: run one .ilike() query per field (each value is
      // passed as a bound parameter, not interpolated into .or() grammar).
      // A 5th query does an exact array-contains check for tag matches.
      // Results are merged client-side by contact ID, deduped, and capped.
      //
      // NOTE: tag matching is exact and case-sensitive (text[] @> operator).
      // Partial/case-insensitive tag search requires a DB migration (RPC with
      // unnest + ilike); deferred — documented as a known design deviation.
      const [byName, byCompany, byRole, byNote, byTag, nResult] = await Promise.allSettled([
        supabase
          .from('contacts')
          .select('id, name, company, role, relationship_note, tags')
          .ilike('name', pattern)
          .limit(CONTACT_LIMIT),
        supabase
          .from('contacts')
          .select('id, name, company, role, relationship_note, tags')
          .ilike('company', pattern)
          .limit(CONTACT_LIMIT),
        supabase
          .from('contacts')
          .select('id, name, company, role, relationship_note, tags')
          .ilike('role', pattern)
          .limit(CONTACT_LIMIT),
        supabase
          .from('contacts')
          .select('id, name, company, role, relationship_note, tags')
          .ilike('relationship_note', pattern)
          .limit(CONTACT_LIMIT),
        supabase
          .from('contacts')
          .select('id, name, company, role, relationship_note, tags')
          .contains('tags', [boundNorm])
          .limit(CONTACT_LIMIT),
        supabase
          .from('interactions')
          .select('id, notes, interaction_date, contact_id, contacts!inner(id, name, company)')
          .ilike('notes', pattern)
          .not('notes', 'is', null)
          .limit(NOTE_LIMIT),
      ])

      if (!mountedRef.current || gen !== searchGenRef.current) return  // stale — discard

      setLoading(false)

      // Merge all fulfilled contact results; deduplicate by ID (field-priority order:
      // name → company → role → relationship_note → exact tag match).
      const anyContactFailed = [byName, byCompany, byRole, byNote, byTag]
        .some(r => r.status === 'rejected')
      const seenIds = new Set()
      const merged  = []
      for (const result of [byName, byCompany, byRole, byNote, byTag]) {
        if (result.status === 'fulfilled') {
          for (const c of (result.value.data || [])) {
            if (!seenIds.has(c.id)) { seenIds.add(c.id); merged.push(c) }
          }
        }
      }
      if (merged.length > 0 || !anyContactFailed) {
        setContactResults(merged.slice(0, CONTACT_LIMIT))
        setErrorContacts(null)
      } else {
        setContactResults([])
        setErrorContacts('Could not search contacts')
      }

      if (nResult.status === 'fulfilled') {
        setNoteResults(nResult.value.data || [])
        setErrorNotes(null)
      } else {
        setNoteResults([])
        setErrorNotes('Could not search notes')
      }

      setActiveIdx(0)
    }, DEBOUNCE_MS)
  }, [query, open])

  // ── Quick action list ─────────────────────────────────────────────────────
  const quickActions = [
    {
      id: 'qa-add',
      label: 'Add a contact',
      icon: (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
          <path d="M16 11h6M19 8v6"/>
        </svg>
      ),
      action: () => {
        closepal('handoff', () => window.dispatchEvent(new CustomEvent('funnl:open-add-contact')))
      },
    },
    {
      id: 'qa-log',
      label: 'Log an interaction',
      icon: (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
      ),
      action: () => handleLogInteraction(),
    },
    {
      id: 'qa-import',
      label: 'Import contacts',
      icon: (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
      ),
      action: () => closepal('handoff', () => navigate('/contacts?import=1')),
    },
  ]

  // Navigation commands (filtered by pro status)
  const navCommands = NAVIGATION_COMMANDS.filter(cmd => !cmd.requiresPro || canUsePro)

  // ── Log Interaction handler ────────────────────────────────────────────────
  async function handleLogInteraction() {
    setPickerLoading(true)
    const { data } = await supabase
      .from('contacts')
      .select('id, name, company')
      .order('created_at', { ascending: false })
      .limit(50)
    if (!mountedRef.current) return
    setPickerLoading(false)
    const contacts = data || []
    const result = resolveActivationAction('log', contacts)
    if (result.type === 'open_drawer') {
      closepal('handoff', () => window.dispatchEvent(new CustomEvent('funnl:open-add-contact')))
    } else if (result.type === 'navigate') {
      const state = buildPickerNavigationState('interaction')
      closepal('handoff', () => navigate(`/contacts/${result.contactId}`, { state }))
    } else if (result.type === 'open_picker') {
      // Show inline contact picker within the palette
      setPickerContacts(contacts)
      setPickerQuery('')
    }
  }

  // Activate a contact from the inline picker
  function handlePickerSelect(contact) {
    const state = buildPickerNavigationState('interaction')
    closepal('handoff', () => navigate(`/contacts/${contact.id}`, { state }))
  }

  // ── Navigate to contact (writes recent) ───────────────────────────────────
  function openContact(contactId) {
    if (uid) writeRecentContact(uid, contactId)
    closepal('handoff', () => navigate(`/contacts/${contactId}`))
  }

  // ── AI handoff ────────────────────────────────────────────────────────────
  function handleAIHandoff() {
    if (!canUsePro) return
    // Cap at MAX_SEARCH_QUERY_LENGTH so oversized clipboard pastes do not
    // produce an unexpectedly large router-state payload.
    const boundedQuery = typeof query === 'string' ? query.slice(0, MAX_SEARCH_QUERY_LENGTH) : ''
    const state = buildAIPrefillState(boundedQuery)
    closepal('handoff', () => state ? navigate('/ai', { state }) : navigate('/ai'))
  }

  // ── Keyboard navigation in main palette ───────────────────────────────────
  // buildFlatItems is imported from commandPaletteUtils — it is the single
  // source of truth for keyboard order = visual order.
  //
  // Tab is intentionally NOT intercepted here.  The focus-trap useEffect
  // (above) handles Tab / Shift+Tab to cycle focus within the dialog.
  // The AI row is reachable via ArrowDown + Enter, or by clicking.
  //
  // shouldIgnoreKey() returns true while IME composition is active so that
  // CJK candidate-selection keys (Enter, Arrow) are not consumed by the
  // palette before the IME has finished composing.
  function onKeyDown(e) {
    if (shouldIgnoreKey(e)) return  // IME composition active — let IME handle it
    const norm = normalizeQuery(query)
    const items = buildFlatItems({ norm, recentContacts, contactResults, noteResults, quickActions, canUsePro })
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => (i + 1) % Math.max(1, items.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => (i - 1 + Math.max(1, items.length)) % Math.max(1, items.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activateItem(items[activeIdx])
    }
  }

  function activateItem(item) {
    if (!item) return
    if (item.kind === 'recent' || item.kind === 'contact') {
      openContact(item.contact.id)
    } else if (item.kind === 'action') {
      item.action.action()
    } else if (item.kind === 'nav') {
      closepal('handoff', () => navigate(item.nav.route))
    } else if (item.kind === 'note') {
      openContact(item.note.contacts?.id || item.note.contact_id)
    } else if (item.kind === 'ai') {
      handleAIHandoff()
    }
  }

  // ── Picker keyboard handler ────────────────────────────────────────────────
  const [pickerActiveIdx, setPickerActiveIdx] = useState(0)

  function filteredPickerContacts() {
    const q = normalizeQuery(pickerQuery)
    if (!q) return pickerContacts || []
    return (pickerContacts || []).filter(c =>
      c.name?.toLowerCase().includes(q) ||
      c.company?.toLowerCase().includes(q)
    )
  }

  function onPickerKeyDown(e) {
    if (shouldIgnoreKey(e)) return  // IME composition active — let IME handle it
    const list = filteredPickerContacts()
    if (e.key === 'ArrowDown') { e.preventDefault(); setPickerActiveIdx(i => Math.min(i + 1, list.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setPickerActiveIdx(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && list[pickerActiveIdx]) { e.preventDefault(); handlePickerSelect(list[pickerActiveIdx]) }
    if (e.key === 'Escape')    { e.preventDefault(); setPickerContacts(null); setTimeout(() => inputRef.current?.focus(), 0) }
  }

  // ── Render guards ─────────────────────────────────────────────────────────
  if (!open) return null

  const norm = normalizeQuery(query)
  const hasQuery = !!norm
  const items = buildFlatItems({ norm, recentContacts, contactResults, noteResults, quickActions, canUsePro })
  const prefill = !hasQuery ? null : buildNoResultPrefill(query)
  const noResults = hasQuery && !loading && contactResults.length === 0 && noteResults.length === 0

  const motionClass = prefersReducedMotion() ? '' : 'animate-[fade-in_0.15s_ease-out]'

  // ── Render ────────────────────────────────────────────────────────────────

  // Search row JSX — inlined directly in the render tree (not a nested component)
  // so React keeps the same <input> DOM node across re-renders and keyboard focus
  // is never lost after typing a character.
  const searchRowJSX = (
    <div className="flex items-center gap-[10px] px-[14px] py-[11px] border-b border-line-1">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setActiveIdx(0) }}
        onKeyDown={onKeyDown}
        placeholder="Find, log, or ask anything…"
        aria-label="Search contacts or run an action"
        aria-controls="cp-listbox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-activedescendant={getActiveItemId(items, activeIdx)}
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        className="flex-1 bg-transparent border-none outline-none text-[14px] placeholder:text-[color:var(--color-lower)]"
        style={{ color: 'var(--color-hi)' }}
      />
      {query && (
        <button
          onClick={() => { setQuery(''); setActiveIdx(0); inputRef.current?.focus() }}
          className="text-[12px] flex-none"
          style={{ color: 'var(--color-low)' }}
          aria-label="Clear search"
          tabIndex={0}
        >✕</button>
      )}
      {/* Mobile-only cancel button */}
      <button
        onClick={() => closepal('dismiss')}
        className="md:hidden text-[13px] flex-none font-medium"
        style={{ color: 'var(--color-ember)' }}
        aria-label="Cancel search"
      >
        Cancel
      </button>
      {/* Desktop keyboard hint */}
      <kbd
        className="hidden md:flex text-[10px] font-mono px-[5px] py-[2px] rounded-[4px] items-center"
        style={{ background: 'var(--color-elevated)', color: 'var(--color-low)', border: '1px solid var(--color-line-2)' }}
        aria-hidden="true"
      >
        esc
      </kbd>
    </div>
  )

  // ── Inline picker view ────────────────────────────────────────────────────
  if (pickerContacts !== null) {
    const pfList = filteredPickerContacts()
    return (
      <div
        className={`fixed inset-0 z-[200] flex flex-col md:items-center md:justify-center md:pt-[10vh] ${motionClass}`}
        role="dialog"
        aria-modal="true"
        aria-label="Pick a contact to log interaction"
        style={{ background: 'rgba(20,17,15,0.5)' }}
      >
        <div className="absolute inset-0" onClick={() => closepal('dismiss')} aria-hidden="true"/>
        <div
          ref={panelRef}
          className="relative w-full h-full md:h-auto md:max-h-[70vh] md:max-w-[540px] md:mx-[16px] md:rounded-[16px] md:border md:border-line-2 md:shadow-[0_24px_80px_rgba(0,0,0,0.25)] overflow-hidden flex flex-col"
          style={{ background: 'var(--color-card)' }}
        >
          {/* Picker input */}
          <div className="flex items-center gap-[10px] px-[14px] py-[11px] border-b border-line-1">
            <button
              onClick={() => { setPickerContacts(null); setTimeout(() => inputRef.current?.focus(), 0) }}
              className="text-[12px] flex-none"
              style={{ color: 'var(--color-mid)' }}
              aria-label="Back to search"
            >
              ←
            </button>
            <input
              autoFocus
              type="text"
              value={pickerQuery}
              onChange={e => { setPickerQuery(e.target.value); setPickerActiveIdx(0) }}
              onKeyDown={onPickerKeyDown}
              placeholder="Search contacts…"
              aria-label="Search contacts to log interaction"
              className="flex-1 bg-transparent border-none outline-none text-[14px] placeholder:text-[color:var(--color-lower)]"
              style={{ color: 'var(--color-hi)' }}
            />
            <button onClick={() => closepal('dismiss')} className="md:hidden text-[13px] flex-none font-medium" style={{ color: 'var(--color-ember)' }}>Cancel</button>
          </div>
          <div className="px-[14px] py-[8px] border-b border-line-1">
            <p className="text-[11.5px]" style={{ color: 'var(--color-muted)' }}>Choose a contact to log an interaction with</p>
          </div>
          <div className="flex-1 overflow-y-auto">
            {pfList.length === 0 && (
              <p className="px-[14px] py-[14px] text-[13px]" style={{ color: 'var(--color-muted)' }}>No contacts found</p>
            )}
            {pfList.map((c, i) => (
              <button
                key={c.id}
                className="w-full flex items-center gap-[12px] px-[14px] py-[10px] text-left transition-colors"
                style={{ background: pickerActiveIdx === i ? 'var(--color-elevated)' : 'transparent', color: 'var(--color-hi)' }}
                onMouseEnter={() => setPickerActiveIdx(i)}
                onClick={() => handlePickerSelect(c)}
              >
                <ContactAvatar name={c.name}/>
                <span className="flex-1 min-w-0">
                  <span className="text-[13px] font-medium block truncate">{c.name}</span>
                  {c.company && <span className="text-[11px] block truncate" style={{ color: 'var(--color-muted)' }}>{c.company}</span>}
                </span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--color-lower)" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
              </button>
            ))}
            <div className="h-[6px]"/>
          </div>
        </div>
      </div>
    )
  }

  // ── Main palette render ────────────────────────────────────────────────────
  return (
    <div
      className={`fixed inset-0 z-[200] flex flex-col md:items-center md:justify-center md:pt-[10vh] ${motionClass}`}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* Backdrop (desktop) */}
      <div className="hidden md:block absolute inset-0 bg-[rgba(20,17,15,0.5)]" onClick={() => closepal('dismiss')} aria-hidden="true"/>

      {/* Mobile backdrop */}
      <div className="md:hidden absolute inset-0" style={{ background: 'var(--color-surface)' }} aria-hidden="true"/>

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative w-full h-full h-dvh md:h-auto md:max-w-[540px] md:mx-[16px] md:rounded-[16px] md:border md:border-line-2 md:shadow-[0_24px_80px_rgba(0,0,0,0.25)] flex flex-col overflow-hidden"
        style={{ background: 'var(--color-card)' }}
      >
        {/* Search input row */}
        {searchRowJSX}

        {/* Results scroll area
            Desktop: max-h so it doesn't overflow the viewport
            Mobile: flex-1 so it fills remaining screen height
        */}
        <div
          id="cp-listbox"
          role="listbox"
          aria-label="Search results"
          className="flex-1 md:flex-none md:max-h-[400px] overflow-y-auto pb-safe"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          {/* ── Loading ── */}
          {hasQuery && loading && (
            <div
              className="px-[16px] py-[14px] text-[13px]"
              style={{ color: 'var(--color-muted)' }}
              aria-live="polite"
              role="status"
            >
              Searching…
            </div>
          )}

          {/* ── Partial errors ── */}
          {hasQuery && !loading && errorContacts && (
            <div className="px-[14px] py-[10px]" aria-live="assertive">
              <p className="text-[11.5px]" style={{ color: 'var(--color-danger)' }}>{errorContacts}</p>
            </div>
          )}
          {hasQuery && !loading && errorNotes && (
            <div className="px-[14px] pb-[6px]" aria-live="assertive">
              <p className="text-[11.5px]" style={{ color: 'var(--color-danger)' }}>{errorNotes}</p>
            </div>
          )}

          {/* ── No results ── */}
          {noResults && !errorContacts && !errorNotes && (
            <div className="px-[16px] py-[14px]" aria-live="polite" role="status">
              <p className="text-[13px]" style={{ color: 'var(--color-muted)' }}>
                No results for &ldquo;{query}&rdquo;
              </p>
              {prefill ? (
                <button
                  className="mt-[10px] text-[12px] font-semibold flex items-center gap-[6px]"
                  style={{ color: 'var(--color-ember)' }}
                  onClick={() => {
                    const name = prefill
                    closepal('handoff', () => window.dispatchEvent(new CustomEvent('funnl:open-add-contact', { detail: { prefillName: name } })))
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                  Add &ldquo;{prefill}&rdquo; as a contact
                </button>
              ) : (
                <button
                  className="mt-[10px] text-[12px] font-semibold flex items-center gap-[6px]"
                  style={{ color: 'var(--color-ember)' }}
                  onClick={() => closepal('handoff', () => window.dispatchEvent(new CustomEvent('funnl:open-add-contact')))}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                  Add a contact
                </button>
              )}
            </div>
          )}

          {/* ── Empty state: recent contacts ── */}
          {!hasQuery && recentContacts.length > 0 && (
            <>
              <SectionLabel>Recent contacts</SectionLabel>
              {recentContacts.map((c, i) => {
                const idx = i
                const isActive = activeIdx === idx
                return (
                  <ResultRow
                    key={c.id}
                    isActive={isActive}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => openContact(c.id)}
                    aria-selected={isActive}
                    id={getItemId(items[idx])}
                  >
                    <ContactAvatar name={c.name}/>
                    <span className="flex-1 min-w-0">
                      <span className="text-[13px] font-medium block truncate" style={{ color: 'var(--color-hi)' }}>{c.name}</span>
                      {(c.company || c.role) && (
                        <span className="text-[11px] block truncate" style={{ color: 'var(--color-muted)' }}>
                          {[c.role, c.company].filter(Boolean).join(' at ')}
                        </span>
                      )}
                    </span>
                    <ChevronIcon/>
                  </ResultRow>
                )
              })}
            </>
          )}

          {/* ── Empty state: no recent contacts ── */}
          {!hasQuery && recentContacts.length === 0 && (
            <div className="px-[14px] py-[10px]">
              <p className="text-[12px]" style={{ color: 'var(--color-lower)' }}>No recent contacts yet</p>
            </div>
          )}

          {/* ── Contact results ── */}
          {hasQuery && !loading && contactResults.length > 0 && (
            <>
              <SectionLabel>Contacts</SectionLabel>
              {contactResults.map((c, i) => {
                const idx = i
                const isActive = activeIdx === idx
                return (
                  <ResultRow
                    key={c.id}
                    isActive={isActive}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => openContact(c.id)}
                    aria-selected={isActive}
                    id={getItemId(items[idx])}
                  >
                    <ContactAvatar name={c.name}/>
                    <span className="flex-1 min-w-0">
                      <span className="text-[13px] font-medium block truncate" style={{ color: 'var(--color-hi)' }}>
                        <Highlight text={c.name} query={query}/>
                      </span>
                      {(c.company || c.role) && (
                        <span className="text-[11px] block truncate" style={{ color: 'var(--color-muted)' }}>
                          <Highlight text={[c.role, c.company].filter(Boolean).join(' at ')} query={query}/>
                        </span>
                      )}
                    </span>
                    <ChevronIcon/>
                  </ResultRow>
                )
              })}
            </>
          )}

          {/* ── Note results ── */}
          {hasQuery && !loading && noteResults.length > 0 && (
            <>
              <SectionLabel>Notes</SectionLabel>
              {noteResults.map((n, i) => {
                const idx = (hasQuery ? contactResults.length : recentContacts.length) + i
                const isActive = activeIdx === idx
                const snippet = extractNoteSnippet(n.notes, norm)
                const contactName = n.contacts?.name || ''
                const contactCompany = n.contacts?.company || ''
                return (
                  <ResultRow
                    key={n.id}
                    isActive={isActive}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => openContact(n.contacts?.id || n.contact_id)}
                    aria-selected={isActive}
                    id={getItemId(items[idx])}
                  >
                    <span
                      className="w-[28px] h-[28px] rounded-[8px] flex items-center justify-center flex-none"
                      style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
                      aria-hidden="true"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                      </svg>
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="text-[12px] block truncate font-medium" style={{ color: 'var(--color-hi)' }}>
                        {contactName}{contactCompany ? ` · ${contactCompany}` : ''}
                      </span>
                      <span className="text-[11px] block leading-[1.45] line-clamp-2" style={{ color: 'var(--color-muted)' }}>
                        <Highlight text={snippet} query={query}/>
                      </span>
                    </span>
                    <ChevronIcon/>
                  </ResultRow>
                )
              })}
            </>
          )}

          {/* ── Quick actions ── */}
          {(() => {
            const offset = hasQuery
              ? contactResults.length + noteResults.length
              : recentContacts.length
            return (
              <>
                <SectionLabel>Quick actions</SectionLabel>
                {quickActions.map((action, i) => {
                  const idx = offset + i
                  const isActive = activeIdx === idx
                  return (
                    <ResultRow
                      key={action.id}
                      isActive={isActive}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={action.action}
                      aria-selected={isActive}
                      id={getItemId(items[idx])}
                    >
                      <span
                        className="w-[28px] h-[28px] rounded-[8px] flex items-center justify-center flex-none"
                        style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
                        aria-hidden="true"
                      >
                        {action.icon}
                      </span>
                      <span className="text-[13px] font-medium flex-1" style={{ color: 'var(--color-hi)' }}>
                        {action.label}
                      </span>
                      {pickerLoading && action.id === 'qa-log' && (
                        <span className="text-[10px]" style={{ color: 'var(--color-lower)' }}>…</span>
                      )}
                    </ResultRow>
                  )
                })}
              </>
            )
          })()}

          {/* ── Navigation commands ── */}
          {(() => {
            const offset = (hasQuery
              ? contactResults.length + noteResults.length
              : recentContacts.length) + quickActions.length
            const displayedNavs = hasQuery
              ? filterNavigationCommands(NAVIGATION_COMMANDS, norm, canUsePro)
              : navCommands
            if (displayedNavs.length === 0) return null
            return (
              <>
                <SectionLabel>Go to</SectionLabel>
                {displayedNavs.map((nav, i) => {
                  const idx = offset + i
                  const isActive = activeIdx === idx
                  return (
                    <ResultRow
                      key={nav.id}
                      isActive={isActive}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => closepal('handoff', () => navigate(nav.route))}
                      aria-selected={isActive}
                      id={getItemId(items[idx])}
                    >
                      <span
                        className="w-[28px] h-[28px] rounded-[8px] flex items-center justify-center flex-none"
                        style={{ background: 'var(--color-elevated)', color: 'var(--color-mid)' }}
                        aria-hidden="true"
                      >
                        <NavIcon route={nav.route}/>
                      </span>
                      <span className="text-[13px] font-medium flex-1" style={{ color: 'var(--color-hi)' }}>{nav.label}</span>
                    </ResultRow>
                  )
                })}
              </>
            )
          })()}

          {/* ── Ask Funnl AI (Pro only) ── */}
          {canUsePro && (() => {
            const offset = (hasQuery
              ? contactResults.length + noteResults.length
              : recentContacts.length) + quickActions.length +
              (hasQuery
                ? filterNavigationCommands(NAVIGATION_COMMANDS, norm, canUsePro).length
                : navCommands.length)
            const isActive = activeIdx === offset
            return (
              <>
                <SectionLabel>Ask</SectionLabel>
                <ResultRow
                  isActive={isActive}
                  onMouseEnter={() => setActiveIdx(offset)}
                  onClick={handleAIHandoff}
                  aria-selected={isActive}
                  id={getItemId(items[offset])}
                >
                  <span
                    className="w-[28px] h-[28px] rounded-[8px] flex items-center justify-center flex-none"
                    style={{ background: 'rgba(255,68,35,0.1)', color: 'var(--color-ember)' }}
                    aria-hidden="true"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M3 4H21L15 12.5V20H9V12.5Z"/>
                    </svg>
                  </span>
                  <span className="text-[13px] font-medium flex-1 truncate" style={{ color: 'var(--color-hi)' }}>
                    {buildAIHandoffLabel(query)}
                  </span>
                </ResultRow>
              </>
            )
          })()}

          <div className="h-[6px]" aria-hidden="true"/>
        </div>

        {/* Footer — desktop only */}
        <div className="hidden md:flex px-[14px] py-[8px] border-t border-line-1 items-center gap-[14px]" aria-hidden="true">
          <span className="text-[10px]" style={{ color: 'var(--color-lower)' }}><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span className="text-[10px]" style={{ color: 'var(--color-lower)' }}><kbd className="font-mono">↵</kbd> select</span>
          <span className="text-[10px]" style={{ color: 'var(--color-lower)' }}><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>

      {/* Screen-reader live region for result count */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {hasQuery && !loading && `${contactResults.length + noteResults.length} results found`}
      </div>
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function ResultRow({ isActive, onMouseEnter, onClick, children, 'aria-selected': ariaSel, id }) {
  return (
    <button
      id={id}
      role="option"
      aria-selected={ariaSel}
      className="w-full flex items-center gap-[12px] px-[14px] py-[9px] text-left transition-colors"
      style={{
        background: isActive ? 'var(--color-elevated)' : 'transparent',
        margin: '2px 4px',
        width: 'calc(100% - 8px)',
        borderRadius: 8,
      }}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--color-lower)" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6"/>
    </svg>
  )
}

function NavIcon({ route }) {
  if (route === '/') return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
  if (route === '/contacts') return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  )
  if (route === '/followups') return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
    </svg>
  )
  if (route === '/ai') return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 4H21L15 12.5V20H9V12.5Z"/>
    </svg>
  )
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3"/><path d="M12 3v2.4M12 18.6V21M4.3 4.3l1.7 1.7M18 18l1.7 1.7M3 12h2.4M18.6 12H21M4.3 19.7 6 18M18 6l1.7-1.7"/>
    </svg>
  )
}
