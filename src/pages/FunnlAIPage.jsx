import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useProStatus, useProRefresh } from '../lib/useProStatus'
import { classifyProStatus } from '../lib/pro-ui-status'
import { track } from '../lib/analytics'
import { extractInvokeError } from '../lib/ai-chat-error'
import { buildProviderMessages, isRetryEligible } from '../lib/ai-chat-conversation'
import { isValidContactLink } from '../lib/contactLinkValidator'
import { extractChildrenText } from '../lib/extractChildrenText'
import { createRequestGate } from '../lib/ai-chat-request-gate'
import { getAvatarColor, getInitials } from '../lib/avatarUtils'
import TopBar from '../components/TopBar'
import {
  MAX_HISTORY_SESSIONS, historyKey, currentKey,
  INITIAL_MESSAGE, TICKER_PHRASES,
  extractContactRefs, sessionTitle, relativeTime,
  HISTORY_VERSION, validateContactRefs, isArchivable,
  parseStoredHistory, genMsgId, revalidateHistorySession,
  parseStoredCurrentSession,
} from '../lib/ai-history'

// ── Icons ─────────────────────────────────────────────────────────────────────

const SparkleIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
  </svg>
)
const SendIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 19V5M6 11l6-6 6 6"/>
  </svg>
)
const HistoryIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/>
  </svg>
)

// ── WorkTicker ────────────────────────────────────────────────────────────────

function WorkTicker() {
  const [idx, setIdx] = useState(0)
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  useEffect(() => {
    if (prefersReduced) return
    const t = setInterval(() => setIdx(i => (i + 1) % TICKER_PHRASES.length), 1800)
    return () => clearInterval(t)
  }, [prefersReduced])
  return (
    <div className="flex items-center gap-2.5 py-1" aria-live="polite" role="status" aria-label="Funnl AI is working">
      <div className="w-6 h-6 rounded-[8px] flex items-center justify-center flex-shrink-0 text-white" style={{ background: 'var(--color-ember)' }}>
        <SparkleIcon size={11}/>
      </div>
      <span className="font-mono text-[13px]" style={{ color: 'var(--color-ember)' }}>{TICKER_PHRASES[idx]}</span>
    </div>
  )
}

// ── Mobile history modal ──────────────────────────────────────────────────────

function HistoryModal({
  open, onClose, history, currentSessionId,
  onLoadSession, onNewChat, triggerRef,
}) {
  const dialogRef        = useRef(null)
  const firstFocusRef    = useRef(null)

  // Move focus into dialog when opened
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => firstFocusRef.current?.focus(), 30)
    return () => clearTimeout(timer)
  }, [open])

  // Restore focus to trigger button when closed
  useEffect(() => {
    if (!open) triggerRef?.current?.focus()
  }, [open, triggerRef])

  // Focus trap + Escape
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last  = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  // Body scroll lock
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 50 }}
      onClick={onClose}
      aria-hidden="false"
    >
      {/* Backdrop */}
      <div style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop)' }} aria-hidden="true"/>
      {/* Sheet */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-history-modal-title"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          maxHeight: '70dvh', display: 'flex', flexDirection: 'column',
          background: 'var(--color-elevated)',
          borderTop: '1px solid var(--color-line-2)',
          borderRadius: '16px 16px 0 0',
        }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line-1 flex-none">
          <h2 id="ai-history-modal-title" className="text-[14px] font-semibold text-hi">Conversations</h2>
          <button
            type="button" onClick={onClose}
            className="text-[12px] text-low hover:text-mid transition-colors px-2 py-1 rounded-lg hover:bg-card"
            aria-label="Close conversation history">
            Close
          </button>
        </div>
        <div className="p-3 border-b border-line-1 flex-none">
          <button
            ref={firstFocusRef}
            type="button"
            onClick={() => { onNewChat(); onClose() }}
            className="w-full text-[13px] font-semibold py-2.5 rounded-xl transition-colors"
            style={{ color: 'var(--color-ember)', background: 'rgba(255,68,35,0.08)', border: '1px solid rgba(255,68,35,0.2)' }}
            aria-label="Start a new conversation">
            + New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1" role="list" aria-label="Past conversations">
          {history.length === 0 ? (
            <p className="text-[12px] text-lower text-center py-5 px-4">No past conversations</p>
          ) : history.map(session => (
            <button
              key={session.id}
              type="button"
              role="listitem"
              onClick={() => { onLoadSession(session); onClose() }}
              className="w-full text-left px-4 py-3 transition-colors hover:bg-card"
              aria-current={session.id === currentSessionId ? 'true' : undefined}
              aria-label={session.title + ', ' + relativeTime(session.createdAt)}>
              <p className="text-[13px] font-medium text-hi truncate leading-snug">{session.title}</p>
              <p className="text-[11px] text-lower mt-0.5">{relativeTime(session.createdAt)}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── ContactRefCard ────────────────────────────────────────────────────────────

// Always uses validated DB data (name, company, role) — never raw provider content.
function ContactRefCard({ name, contactId, company, role }) {
  const navigate = useNavigate()
  const initials = getInitials(name)
  const avatarBg = getAvatarColor(name)
  const subtitle = [role, company].filter(Boolean).join(' · ')
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl" style={{ background: 'var(--color-elevated)', border: '1px solid var(--color-line-2)' }}>
      <div className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-[12px] flex-shrink-0" style={{ background: avatarBg, color: 'var(--color-paper)' }} aria-hidden="true">
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-semibold text-hi truncate">{name}</p>
        {subtitle && <p className="text-[11.5px] text-muted truncate">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button type="button"
          onClick={() => navigate('/contacts/' + contactId, { state: { openFollowUpForm: true } })}
          className="text-[11.5px] font-medium px-2.5 py-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--color-ember)', background: 'rgba(255,68,35,0.09)', border: '1px solid rgba(255,68,35,0.2)' }}>
          Set follow-up
        </button>
        <Link to={'/contacts/' + contactId}
          onClick={e => { e.stopPropagation(); track('ai_contact_link_clicked', { source: 'ai_response' }) }}
          aria-label={'Open ' + name + "'s contact"}
          className="text-[11.5px] font-medium px-2.5 py-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--color-mid)', background: 'var(--color-card)', border: '1px solid var(--color-line-2)' }}>
          Open →
        </Link>
      </div>
    </div>
  )
}

// ── Markdown overrides ────────────────────────────────────────────────────────

// Module-level — no component state. Analytics in onClick only, never in render.
const mdComponents = {
  p:      ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed text-hi">{children}</p>,
  ul:     ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5 text-hi">{children}</ul>,
  ol:     ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5 text-hi">{children}</ol>,
  li:     ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-hi">{children}</strong>,
  em:     ({ children }) => <em className="italic">{children}</em>,
  h1:     ({ children }) => <h3 className="font-semibold text-[15px] mb-1.5 mt-3 first:mt-0 text-hi">{children}</h3>,
  h2:     ({ children }) => <h4 className="font-semibold text-[14px] mb-1 mt-2.5 first:mt-0 text-hi">{children}</h4>,
  h3:     ({ children }) => <h5 className="font-semibold text-[13.5px] mb-1 mt-2 first:mt-0 text-hi">{children}</h5>,
  a: ({ href, children }) => {
    if (isValidContactLink(href)) {
      const name      = extractChildrenText(children)
      const ariaLabel = name ? 'Open ' + name + "'s contact" : 'Open contact details'
      // Analytics in onClick only — never fires during render.
      return (
        <Link to={href} aria-label={ariaLabel}
          onClick={() => track('ai_contact_link_clicked', { source: 'ai_response' })}
          className="font-medium underline underline-offset-2 transition-opacity hover:opacity-70"
          style={{ color: 'var(--color-ember)' }}>
          {children}
        </Link>
      )
    }
    return <span style={{ color: 'var(--color-mid)' }}>{children}</span>
  },
}

// ── Starter prompts ───────────────────────────────────────────────────────────

const STARTER_PROMPTS = [
  "Who haven't I followed up with?",
  "Which contacts have no interactions logged?",
  "What patterns do you notice in my networking?",
  "Who should I be thinking about reaching out to?",
]

// ── Main component ────────────────────────────────────────────────────────────

function FunnlAIPage() {
  // Pro status entirely from the shared provider — no local override.
  // useProRefresh() updates all consumers (Sidebar, Settings, FunnlAIPage).
  const proStatus     = useProStatus()
  const proRefresh    = useProRefresh()
  const displayStatus = classifyProStatus(proStatus)
  const isProUser     = displayStatus === 'permanent' || displayStatus === 'trial' || displayStatus === 'subscribed'
  const isCheckingPro = proStatus === null

  const [userId,      setUserId]      = useState(null)
  const [contacts,    setContacts]    = useState([]) // [{id,name,company,role}] for ref validation
  const [history,     setHistory]     = useState([])
  const [messages,    setMessages]    = useState([INITIAL_MESSAGE])
  const [input,       setInput]       = useState('')
  const [loading,     setLoading]     = useState(false)
  const [isRetrying,  setIsRetrying]  = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [subscribing, setSubscribing] = useState(false)

  const isRetryingRef       = useRef(false)
  const bottomRef           = useRef(null)
  const inputRef            = useRef(null)
  const historyTriggerRef   = useRef(null) // for focus restoration after mobile modal closes
  const gateRef             = useRef(null)
  if (!gateRef.current) gateRef.current = createRequestGate()
  const currentSessionIdRef = useRef(null) // stable ID for the active conversation
  const pendingFocusRef     = useRef(false) // focus composer after Pro resolves
  const prevUserIdRef       = useRef(null)  // detect genuine account switches
  const isComposingRef      = useRef(false) // IME composition guard

  const navigate = useNavigate()
  const location = useLocation()

  // Mount: populate input from router state prefill (user must submit explicitly),
  // load userId, contacts, and localStorage history/current session.
  useEffect(() => {
    const aiPrompt = location.state?.aiPrompt
    if (typeof aiPrompt === 'string' && aiPrompt.trim()) {
      setInput(aiPrompt.trim())
      pendingFocusRef.current = true
      // Clear consumed router state so refresh/back do not re-insert the prompt
      navigate(location.pathname, { replace: true, state: {} })
    }
    let active = true
    async function init() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!active || !session?.user?.id) return
      const uid = session.user.id
      setUserId(uid)
      // Load contacts for contact-reference validation
      const { data: contactData } = await supabase
        .from('contacts')
        .select('id, name, company, role')
        .eq('user_id', uid)
      if (active && Array.isArray(contactData)) setContacts(contactData)
      // Load archived history
      setHistory(parseStoredHistory(localStorage.getItem(historyKey(uid))))
      // Restore in-progress session using validated parser
      const stored = parseStoredCurrentSession(localStorage.getItem(currentKey(uid)))
      if (active && stored.length > 0) setMessages([INITIAL_MESSAGE, ...stored])
    }
    init()
    return () => { active = false }
  }, []) // mount only

  // Account-switch isolation: when userId changes mid-session (not first load),
  // clear all per-user state before re-loading the new user's data.
  useEffect(() => {
    if (!userId) return
    if (prevUserIdRef.current && prevUserIdRef.current !== userId) {
      gateRef.current.invalidate()
      setMessages([INITIAL_MESSAGE])
      setHistory([])
      setContacts([])
      setInput('')
      setLoading(false)
      currentSessionIdRef.current = null
    }
    prevUserIdRef.current = userId
  }, [userId])

  // Focus the composer once Pro status resolves (handles the prefill case).
  // Never auto-submits — the user must press Enter or click Send.
  useEffect(() => {
    if (!isCheckingPro && pendingFocusRef.current) {
      pendingFocusRef.current = false
      inputRef.current?.focus()
    }
  }, [isCheckingPro])

  // Persist current session
  useEffect(() => {
    if (!userId) return
    const toStore = messages.filter(m => !m.localOnly && !m.error)
    if (toStore.length === 0) localStorage.removeItem(currentKey(userId))
    else try { localStorage.setItem(currentKey(userId), JSON.stringify(toStore)) } catch { /* ignore */ }
  }, [messages, userId])

  // Scroll to bottom
  useEffect(() => {
    if (isProUser) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, isProUser])

  // ── Archive / load ─────────────────────────────────────────────────────────

  function archiveCurrentSession(currentMessages, uid) {
    if (!isArchivable(currentMessages) || !uid) return
    // Reuse the stable session ID if one exists; prevents duplicate history entries
    // when archiveCurrentSession is called multiple times for the same session.
    const sessionId = currentSessionIdRef.current ??
      ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()))
    currentSessionIdRef.current = sessionId
    const session = {
      v: HISTORY_VERSION,
      id: sessionId,
      title: sessionTitle(currentMessages),
      createdAt: new Date().toISOString(),
      messages: currentMessages.filter(m => !m.localOnly && !m.error),
    }
    setHistory(prev => {
      // Remove any existing entry with this ID before prepending (upsert semantics)
      const deduped  = prev.filter(s => s.id !== sessionId)
      const updated  = [session, ...deduped].slice(0, MAX_HISTORY_SESSIONS)
      try { localStorage.setItem(historyKey(uid), JSON.stringify(updated)) } catch { /* ignore */ }
      return updated
    })
  }

  // ── Send / retry ───────────────────────────────────────────────────────────

  async function sendMessage(text) {
    const trimmed = (text ?? '').trim()
    if (!trimmed || loading) return
    const gate = gateRef.current
    const token = gate.begin()
    const userMsg = { id: genMsgId(), role: 'user', content: trimmed }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setLoading(true)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    try {
      const { data, error: fnError } = await supabase.functions.invoke('ai-chat', {
        body: { messages: buildProviderMessages(nextMessages), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      })
      if (!gate.isCurrent(token)) return
      const invokeError = await extractInvokeError(fnError, data)
      if (!gate.isCurrent(token)) return
      if (invokeError) {
        track('ai_assistant_failed', { code: invokeError.code, retryable: invokeError.retryable })
        setMessages(prev => { const u = [...prev]; u[u.length - 1] = { ...userMsg, error: invokeError }; return u })
        return
      }
      if (!data?.reply) {
        const fb = { code: 'empty_provider_response', message: 'No response received — please try again.', retryable: true, request_id: data?.request_id ?? null }
        track('ai_assistant_failed', { code: fb.code, retryable: fb.retryable })
        setMessages(prev => { const u = [...prev]; u[u.length - 1] = { ...userMsg, error: fb }; return u })
        return
      }
      track('ai_assistant_used')
      const aMsg = { id: genMsgId(), role: 'assistant', content: data.reply }
      if (data.truncated) aMsg.truncated = true
      setMessages(prev => { const u = [...prev]; u[u.length - 1] = userMsg; return [...u, aMsg] })
    } catch {
      if (!gate.isCurrent(token)) return
      const fb = { code: 'internal_error', message: 'Something went wrong — please try again.', retryable: true, request_id: null }
      track('ai_assistant_failed', { code: fb.code, retryable: fb.retryable })
      setMessages(prev => { const u = [...prev]; u[u.length - 1] = { ...userMsg, error: fb }; return u })
    } finally {
      if (gate.isCurrent(token)) setLoading(false)
    }
  }

  async function retryMessage(index) {
    if (loading) return
    const gate = gateRef.current
    const token = gate.begin()
    // Clear the error, preserve the stable ID
    setMessages(prev => prev.map((m, i) => i === index ? { id: m.id, role: m.role, content: m.content } : m))
    setLoading(true)
    try {
      const retryMsgs = messages.map((m, i) => i === index ? { role: m.role, content: m.content } : m)
      const { data, error: fnError } = await supabase.functions.invoke('ai-chat', {
        body: { messages: buildProviderMessages(retryMsgs), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      })
      if (!gate.isCurrent(token)) return
      const invokeError = await extractInvokeError(fnError, data)
      if (!gate.isCurrent(token)) return
      if (invokeError) {
        track('ai_assistant_failed', { code: invokeError.code, retryable: invokeError.retryable })
        setMessages(prev => prev.map((m, i) => i === index ? { ...m, error: invokeError } : m))
        return
      }
      if (!data?.reply) {
        const fb = { code: 'empty_provider_response', message: 'No response received — please try again.', retryable: true, request_id: data?.request_id ?? null }
        track('ai_assistant_failed', { code: fb.code, retryable: fb.retryable })
        setMessages(prev => prev.map((m, i) => i === index ? { ...m, error: fb } : m))
        return
      }
      track('ai_assistant_used')
      const aMsg = { id: genMsgId(), role: 'assistant', content: data.reply }
      if (data.truncated) aMsg.truncated = true
      setMessages(prev => {
        const u = prev.map((m, i) => i === index ? { id: m.id, role: m.role, content: m.content } : m)
        return [...u, aMsg]
      })
    } catch {
      if (!gate.isCurrent(token)) return
      const fb = { code: 'internal_error', message: 'Something went wrong — please try again.', retryable: true, request_id: null }
      track('ai_assistant_failed', { code: fb.code, retryable: fb.retryable })
      setMessages(prev => prev.map((m, i) => i === index ? { ...m, error: fb } : m))
    } finally {
      if (gate.isCurrent(token)) setLoading(false)
    }
  }

  function dismissError(index) {
    const text = messages[index]?.content ?? ''
    setMessages(prev => prev.filter((_, i) => i !== index))
    setInput(text)
    inputRef.current?.focus()
  }

  function startNewChat(source) {
    gateRef.current.invalidate()
    archiveCurrentSession(messages, userId)
    currentSessionIdRef.current = null
    setMessages([INITIAL_MESSAGE])
    setInput('')
    setLoading(false)
    if (userId) localStorage.removeItem(currentKey(userId))
    track('ai_chat_reset', { source: source ?? 'user_action' })
    inputRef.current?.focus()
  }

  function loadSession(session) {
    // Invalidate any in-flight request first
    gateRef.current.invalidate()
    setLoading(false)
    // Archive the outgoing conversation (only if switching away from a different session)
    if (currentSessionIdRef.current !== session.id) {
      archiveCurrentSession(messages, userId)
    }
    currentSessionIdRef.current = session.id
    // Revalidate contact refs against currently authenticated user's contacts
    // so deleted contacts do not retain Open/Set follow-up actions.
    const revalidated = revalidateHistorySession(session, contacts)
    const hydrated = revalidated.messages.map(m => m.id ? m : { ...m, id: genMsgId() })
    setMessages([INITIAL_MESSAGE, ...hydrated])
    setHistoryOpen(false)
    if (userId) try { localStorage.setItem(currentKey(userId), JSON.stringify(session.messages)) } catch { /* ignore */ }
  }

  async function handleSubscribe() {
    if (subscribing) return
    setSubscribing(true)
    const { data, error } = await supabase.functions.invoke('create-checkout-session')
    setSubscribing(false)
    if (error || !data?.url) return  // Silent on error — user can retry
    window.location.href = data.url
  }

  async function retryProStatus() {
    if (isRetryingRef.current) return
    isRetryingRef.current = true
    setIsRetrying(true)
    try {
      await proRefresh()
    } finally {
      isRetryingRef.current = false
      setIsRetrying(false)
    }
  }

  // ── Keyboard handlers ──────────────────────────────────────────────────────

  function handleCompositionStart() { isComposingRef.current = true  }
  function handleCompositionEnd()   { isComposingRef.current = false }

  function handleKeyDown(e) {
    // Do not submit during IME composition (CJK, etc.)
    if (e.nativeEvent?.isComposing || isComposingRef.current) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) }
  }

  function handleInputChange(e) {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  const hasUserMessaged = messages.some(m => m.role === 'user' && !m.localOnly)

  // Loading screen — shown while Pro status RPC is in flight
  if (isCheckingPro) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--color-surface)' }}>
        <div className="w-5 h-5 rounded-full border-2 animate-spin" style={{ borderColor: 'rgba(255,68,35,0.25)', borderTopColor: 'var(--color-ember)' }}/>
      </div>
    )
  }

  function renderLocked() {
    if (displayStatus === 'unavailable') {
      return (
        <div className="flex flex-col items-center justify-center min-h-[300px] h-full text-center gap-5 py-12">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'var(--color-elevated)', border: '1px solid var(--color-line-2)', color: 'var(--color-low)' }}>
            <SparkleIcon size={22}/>
          </div>
          <div className="max-w-[260px]" aria-live="polite" role="status">
            <h3 className="font-display text-[18px] font-bold text-hi mb-2">Pro status unavailable</h3>
            <p className="text-[13px] leading-relaxed text-muted mb-4">We couldn't verify your Pro access right now. Please try again.</p>
            <button onClick={retryProStatus} disabled={isRetrying} className="text-[13px] font-semibold transition-opacity disabled:opacity-40" style={{ color: 'var(--color-ember)' }}>
              {isRetrying ? 'Checking…' : 'Retry'}
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="flex flex-col items-center justify-center min-h-[300px] h-full text-center gap-5 py-12">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center opacity-60 text-white" style={{ background: 'var(--color-ember)' }}>
          <SparkleIcon size={22}/>
        </div>
        <div className="max-w-[280px]">
          {proStatus?.trial_expired ? (
            <>
              <h3 className="font-display text-[18px] font-bold text-hi mb-2">Your trial has ended</h3>
              <p className="text-[13px] leading-relaxed text-muted mb-5">
                Subscribe to continue asking questions about your network — who to follow up with, who's gone cold, who you know at a specific company.
              </p>
            </>
          ) : (
            <>
              <h3 className="font-display text-[18px] font-bold text-hi mb-2">AI only available for Pro</h3>
              <p className="text-[13px] leading-relaxed text-muted mb-5">Ask anything about your network — who's gone cold, who you know at a specific company, what to follow up on next.</p>
            </>
          )}
          <button
            onClick={handleSubscribe}
            disabled={subscribing}
            className="text-[13px] font-bold text-white px-5 py-[10px] rounded-[10px] disabled:opacity-40 hover:opacity-90 transition-opacity motion-reduce:transition-none"
            style={{ background: 'linear-gradient(135deg,#8B7CFF,#5B45F0)' }}
          >
            {subscribing ? 'Loading…' : 'Subscribe — $7.99/month'}
          </button>
        </div>
      </div>
    )
  }

  function renderComposer() {
    const disabledBar = placeholder => (
      <div className="flex items-center rounded-[20px] cursor-not-allowed opacity-40 select-none" style={{ background: 'var(--color-input)', border: '1px solid var(--color-line-2)' }}>
        <span className="flex-1 text-[14px] text-lower pl-5 py-[14px]">{placeholder}</span>
        <div className="flex-none p-2">
          <div className="w-9 h-9 rounded-[12px] flex items-center justify-center text-white" style={{ background: 'var(--color-ember)' }}><SendIcon/></div>
        </div>
      </div>
    )
    if (displayStatus === 'unavailable') return disabledBar('Unable to verify access…')
    if (!isProUser)                       return disabledBar('AI only available for Pro…')
    return (
      <>
        <div className="flex items-end rounded-[20px] transition-all duration-150" style={{ background: 'var(--color-input)', border: '1px solid var(--color-line-3)' }}>
          <textarea ref={inputRef} value={input} onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder="Ask about your network…" rows={1} disabled={loading}
            className="flex-1 bg-transparent text-[14px] text-hi outline-none resize-none disabled:opacity-50 leading-relaxed pl-5 pr-2 py-[14px]"
            aria-label="Message Funnl AI"/>
          <div className="flex-none p-2">
            <button type="button" onClick={() => sendMessage(input)} disabled={loading || !input.trim()}
              className="w-9 h-9 rounded-[12px] flex items-center justify-center transition-all disabled:opacity-30 active:scale-95 text-white"
              style={{ background: 'var(--color-ember)' }} aria-label="Send message">
              <SendIcon/>
            </button>
          </div>
        </div>
        <p className="text-[11px] text-lower text-center mt-2">Enter to send · Shift+Enter for new line</p>
      </>
    )
  }

  // ── Pro badge for TopBar actions slot ──────────────────────────────────────

  const proBadge = (displayStatus === 'permanent' || displayStatus === 'subscribed') ? (
    <span className="font-mono text-[9.5px] font-bold tracking-[0.5px] px-1.5 py-0.5 rounded-[5px]"
      style={{ color: 'var(--color-ember)', background: 'rgba(255,68,35,0.1)', border: '1px solid rgba(255,68,35,0.22)' }}>
      PRO
    </span>
  ) : displayStatus === 'trial' && (proStatus?.days_remaining ?? 0) > 0 ? (
    <span className="font-mono text-[9.5px] font-bold tracking-[0.5px] px-1.5 py-0.5 rounded-[5px]"
      style={{ color: 'var(--color-warning)', background: 'rgba(165,106,0,0.1)', border: '1px solid rgba(165,106,0,0.2)' }}>
      {proStatus.days_remaining === 1 ? '1 DAY LEFT' : proStatus.days_remaining + ' DAYS LEFT'}
    </span>
  ) : null

  // TopBar workspace toolbar actions: Pro badge + mobile history trigger
  const topBarActions = (
    <>
      {proBadge}
      {/* Mobile history trigger — desktop rail is always visible */}
      <button
        ref={historyTriggerRef}
        type="button"
        onClick={() => setHistoryOpen(o => !o)}
        className="md:hidden flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-xl transition-colors"
        style={{ color: 'var(--color-mid)', background: 'var(--color-elevated)', border: '1px solid var(--color-line-2)' }}
        aria-expanded={historyOpen}
        aria-controls="ai-history-modal"
        aria-label="Open conversation history">
        <HistoryIcon/>
        <span className="hidden xs:inline">History</span>
      </button>
    </>
  )

  // TopBar CTA: New chat (shown once user has sent a message)
  const newChatCta = isProUser && hasUserMessaged ? (
    <button type="button" onClick={() => startNewChat('user_action')}
      className="text-[12px] font-semibold px-3 py-1.5 rounded-xl transition-colors"
      style={{ color: 'var(--color-ember)', background: 'rgba(255,68,35,0.08)', border: '1px solid rgba(255,68,35,0.18)' }}
      aria-label="Start a new conversation">
      + New chat
    </button>
  ) : null

  // ── Page render ────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--color-surface)' }}>

      {/* Shared TopBar — no competing custom sticky header */}
      <TopBar title="Funnl AI" actions={topBarActions} cta={newChatCta}
        searchPlaceholder="Find, log, or ask anything…"
        onSearchClick={() => window.dispatchEvent(new CustomEvent('funnl:open-command-palette'))}/>

      {/* Workspace: history rail (desktop) + conversation column */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* History rail — desktop only, 190px, always visible */}
        <aside className="hidden md:flex flex-col flex-none border-r border-line-1" style={{ width: 190, background: 'var(--color-elevated)' }} aria-label="Conversation history">
          <div className="p-3 border-b border-line-1 flex-shrink-0">
            <button type="button" onClick={() => startNewChat('user_action')}
              className="w-full text-[12.5px] font-semibold py-2 rounded-xl text-left px-3 transition-colors"
              style={{ color: 'var(--color-ember)', background: 'rgba(255,68,35,0.08)', border: '1px solid rgba(255,68,35,0.2)' }}
              aria-label="Start a new conversation">
              + New chat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1" role="list" aria-label="Past conversations">
            {history.length === 0 ? (
              <p className="text-[11.5px] text-lower px-3 py-5 text-center leading-relaxed">Past conversations will appear here</p>
            ) : history.map(session => (
              <button key={session.id} type="button" onClick={() => loadSession(session)}
                className="w-full text-left px-3 py-2.5 transition-colors hover:bg-card"
                aria-current={session.id === currentSessionIdRef.current ? 'true' : undefined}
                aria-label={session.title + ', ' + relativeTime(session.createdAt)}>
                <p className="text-[12px] font-medium text-hi truncate leading-snug">{session.title}</p>
                <p className="text-[10.5px] text-lower mt-0.5">{relativeTime(session.createdAt)}</p>
              </button>
            ))}
          </div>
        </aside>

        {/* Main conversation column */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          {/* Conversation / locked */}
          <div className="flex-1 overflow-y-auto min-h-0 px-4 md:px-6 py-5">
            {!isProUser ? renderLocked() : (
              <div className="space-y-5 max-w-[680px] mx-auto">
                {messages.map(msg => (
                  <div key={msg.id}>
                    {msg.role === 'user' ? (
                      <div className="flex justify-end">
                        <div className="max-w-[80%] md:max-w-[70%]">
                          <div className={'inline-block px-4 py-2.5 rounded-2xl text-[14px] leading-relaxed whitespace-pre-wrap text-white' + (msg.error ? ' opacity-50' : '')}
                            style={{ background: 'var(--color-ember)', borderBottomRightRadius: 6 }}>
                            {msg.content}
                          </div>
                          {msg.error && (
                            <div className="flex flex-col items-end gap-1.5 mt-2" aria-live="polite" role="status">
                              <p className="text-[12px] text-danger leading-snug text-right">{msg.error.message}</p>
                              {msg.error.request_id && <p className="text-[10.5px] font-mono text-lower">Support ref: {msg.error.request_id}</p>}
                              <div className="flex gap-3 items-center flex-wrap justify-end">
                                <button type="button" onClick={() => {
                                  const idx = messages.indexOf(msg)
                                  if (idx >= 0) dismissError(idx)
                                }} className="text-[11.5px] text-low hover:text-mid transition-colors">Dismiss</button>
                                {isRetryEligible(messages, messages.indexOf(msg)) && (
                                  <button type="button" onClick={() => retryMessage(messages.indexOf(msg))} disabled={loading}
                                    className="text-[11.5px] font-medium transition-opacity disabled:opacity-40" style={{ color: 'var(--color-ember)' }}>Retry</button>
                                )}
                                {msg.error.code === 'invalid_request' && (
                                  <button type="button" onClick={() => startNewChat('ai_error_recovery')}
                                    className="text-[11.5px] font-medium transition-opacity" style={{ color: 'var(--color-ember)' }}>Start new chat</button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-6 h-6 rounded-[8px] flex items-center justify-center flex-none text-white" style={{ background: 'var(--color-ember)' }}><SparkleIcon size={11}/></div>
                          <span className="font-mono text-[10.5px] text-lower">Funnl AI</span>
                        </div>
                        <div className="ml-8 p-4 rounded-2xl text-[14px]" style={{ background: 'var(--color-card)', border: '1px solid var(--color-line-2)' }}>
                          <ReactMarkdown components={mdComponents}>{msg.content}</ReactMarkdown>
                          {msg.truncated && <p className="text-[11px] italic mt-3 text-lower">Response may be cut short — feel free to ask a follow-up.</p>}
                        </div>
                        {!msg.localOnly && (() => {
                          // Use revalidated refs if available (from loadSession); otherwise validate live.
                          const refs = extractContactRefs(msg.content)
                          const validRefs = msg._validContactRefs ?? validateContactRefs(refs, contacts)
                          return validRefs.length > 0 ? (
                            <div className="ml-8 mt-2 space-y-2">
                              {validRefs.map(ref => (
                                <ContactRefCard
                                  key={ref.contactId}
                                  name={ref.name}
                                  contactId={ref.contactId}
                                  company={ref.company}
                                  role={ref.role}
                                />
                              ))}
                            </div>
                          ) : null
                        })()}
                      </div>
                    )}
                  </div>
                ))}
                {!hasUserMessaged && (
                  <div className="flex flex-wrap gap-2 ml-8">
                    {STARTER_PROMPTS.map(prompt => (
                      <button key={prompt} type="button" onClick={() => sendMessage(prompt)}
                        className="text-[12.5px] font-medium px-4 py-2 rounded-full transition-colors"
                        style={{ color: 'var(--color-mid)', background: 'var(--color-elevated)', border: '1px solid var(--color-line-2)' }}>
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
                {loading && <div className="ml-8"><WorkTicker/></div>}
                <div ref={bottomRef}/>
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="flex-none px-4 md:px-6 pb-5 pt-3 border-t border-line-1">{renderComposer()}</div>
        </div>
      </div>

      {/* Mobile history modal — fixed position, accessible dialog */}
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        history={history}
        currentSessionId={currentSessionIdRef.current}
        onLoadSession={loadSession}
        onNewChat={() => startNewChat('user_action')}
        triggerRef={historyTriggerRef}
      />
    </div>
  )
}

export default FunnlAIPage
