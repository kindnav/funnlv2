import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { canUseAI } from '../lib/ai'
import { track } from '../lib/analytics'
import { extractInvokeError } from '../lib/ai-chat-error'
import { buildProviderMessages, isRetryEligible } from '../lib/ai-chat-conversation'
import { isValidContactLink } from '../lib/contactLinkValidator'

// Markdown component overrides — applied only to assistant messages.
// Raw HTML is not rendered (react-markdown default, kept intentionally).
const mdComponents = {
  p:      ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul:     ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
  ol:     ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
  li:     ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-hi">{children}</strong>,
  em:     ({ children }) => <em className="italic">{children}</em>,
  a:      ({ href, children }) => {
    if (isValidContactLink(href)) {
      return (
        <Link
          to={href}
          aria-label={`Open ${typeof children === 'string' ? children : 'contact'}'s contact`}
          onClick={() => track('ai_contact_link_clicked', { source: 'ai_response' })}
          className="text-accent underline hover:opacity-80 transition-opacity"
        >
          {children}
        </Link>
      )
    }
    return <span>{children}</span>
  },
}

const STARTER_PROMPTS = [
  "Who haven't I followed up with?",
  "Which contacts have no interactions logged?",
  "What patterns do you notice in my networking?",
  "Who should I be thinking about reaching out to?",
]

const INITIAL_MESSAGE = {
  role: 'assistant',
  content: "Your network is loaded. Ask me anything about your contacts — who you know somewhere, who's gone quiet, what your follow-up situation looks like, or whatever you're wondering about.",
  // localOnly: this greeting is frontend-only and must never be sent to the provider.
  // buildProviderMessages() in ai-chat-conversation.js filters it out before invocation.
  // The Edge Function rejects any conversation that starts with an assistant message.
  localOnly: true,
}

const SparkleIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
  </svg>
)

const SendIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M6 11l6-6 6 6"/>
  </svg>
)

function FunnlAIPage() {
  const [isCheckingPro, setIsCheckingPro] = useState(true)
  const [isProUser, setIsProUser]         = useState(false)
  // Message shape: { role, content, error?, truncated? }
  // error: { code, message, retryable, request_id } — present on failed user messages only
  // truncated: true — present on assistant messages where stop_reason was max_tokens
  const [messages, setMessages]           = useState([INITIAL_MESSAGE])
  const [input, setInput]                 = useState('')
  const [loading, setLoading]             = useState(false)
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        canUseAI(data.user.id).then(result => {
          setIsProUser(result)
          setIsCheckingPro(false)
        })
      } else {
        setIsCheckingPro(false)
      }
    })
  }, [])

  useEffect(() => {
    if (isProUser) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, isProUser])

  // Sends a new user message. Keeps the message visible on failure with an
  // inline error and Retry button — does not revert or restore to the input.
  async function sendMessage(text) {
    const trimmed = text.trim()
    if (!trimmed || loading) return

    const userMsg      = { role: 'user', content: trimmed }
    const nextMessages = [...messages, userMsg]

    setMessages(nextMessages)
    setInput('')
    setLoading(true)
    if (inputRef.current) inputRef.current.style.height = 'auto'

    try {
      const { data, error: fnError } = await supabase.functions.invoke('ai-chat', {
        body: {
          messages: buildProviderMessages(nextMessages),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      })

      const invokeError = await extractInvokeError(fnError, data)
      if (invokeError) {
        track('ai_assistant_failed', { code: invokeError.code, retryable: invokeError.retryable })
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = { ...userMsg, error: invokeError }
          return updated
        })
        return
      }

      if (!data?.reply) {
        const fallback = { code: 'empty_provider_response', message: 'No response received — please try again.', retryable: true, request_id: data?.request_id ?? null }
        track('ai_assistant_failed', { code: fallback.code, retryable: fallback.retryable })
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = { ...userMsg, error: fallback }
          return updated
        })
        return
      }

      track('ai_assistant_used')
      const assistantMsg = { role: 'assistant', content: data.reply }
      if (data.truncated) assistantMsg.truncated = true
      setMessages(prev => {
        const updated = [...prev]
        // Clear the user message (keep it clean — no error field on success)
        updated[updated.length - 1] = userMsg
        return [...updated, assistantMsg]
      })
    } catch {
      const fallback = { code: 'internal_error', message: 'Something went wrong — please try again.', retryable: true, request_id: null }
      track('ai_assistant_failed', { code: fallback.code, retryable: fallback.retryable })
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = { ...userMsg, error: fallback }
        return updated
      })
    } finally {
      setLoading(false)
    }
  }

  // Retries the failed message at the given index. Clears the error inline so
  // the message remains visible, then resends without adding a new visible prompt.
  async function retryMessage(index) {
    if (loading) return

    setMessages(prev => prev.map((m, i) =>
      i === index ? { role: m.role, content: m.content } : m
    ))
    setLoading(true)

    try {
      // Build provider payload using the cleared (no-error) message state.
      // Because setMessages above is async, we construct the payload directly.
      const retryMessages = messages.map((m, i) =>
        i === index ? { role: m.role, content: m.content } : m
      )
      const { data, error: fnError } = await supabase.functions.invoke('ai-chat', {
        body: {
          messages: buildProviderMessages(retryMessages),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      })

      const invokeError = await extractInvokeError(fnError, data)
      if (invokeError) {
        track('ai_assistant_failed', { code: invokeError.code, retryable: invokeError.retryable })
        setMessages(prev => prev.map((m, i) =>
          i === index ? { ...m, error: invokeError } : m
        ))
        return
      }

      if (!data?.reply) {
        const fallback = { code: 'empty_provider_response', message: 'No response received — please try again.', retryable: true, request_id: data?.request_id ?? null }
        track('ai_assistant_failed', { code: fallback.code, retryable: fallback.retryable })
        setMessages(prev => prev.map((m, i) =>
          i === index ? { ...m, error: fallback } : m
        ))
        return
      }

      track('ai_assistant_used')
      const assistantMsg = { role: 'assistant', content: data.reply }
      if (data.truncated) assistantMsg.truncated = true
      setMessages(prev => {
        const updated = prev.map((m, i) =>
          i === index ? { role: m.role, content: m.content } : m
        )
        return [...updated, assistantMsg]
      })
    } catch {
      const fallback = { code: 'internal_error', message: 'Something went wrong — please try again.', retryable: true, request_id: null }
      track('ai_assistant_failed', { code: fallback.code, retryable: fallback.retryable })
      setMessages(prev => prev.map((m, i) =>
        i === index ? { ...m, error: fallback } : m
      ))
    } finally {
      setLoading(false)
    }
  }

  // Removes the failed message from history and restores its text to the input
  // so the user can edit before re-sending.
  function dismissError(index) {
    const text = messages[index]?.content ?? ''
    setMessages(prev => prev.filter((_, i) => i !== index))
    setInput(text)
    inputRef.current?.focus()
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  function handleInputChange(e) {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }

  const hasUserMessaged = messages.some(m => m.role === 'user')

  if (isCheckingPro) {
    return (
      <div className="h-full flex items-center justify-center bg-surface">
        <div className="w-5 h-5 rounded-full border-2 border-accent border-t-transparent animate-spin"/>
      </div>
    )
  }

  return (
    <div
      className="h-full flex flex-col bg-surface"
      style={{ backgroundImage: 'radial-gradient(circle at 50% -10%, rgba(108,92,255,0.09), transparent 45%)' }}
    >

      {/* ── Header ─────────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-[11px] px-4 md:px-8 py-[22px] border-b border-line-1 flex-none">
        <div className="w-9 h-9 rounded-[10px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center shadow-[0_4px_16px_rgba(91,69,240,0.4)] flex-none text-white">
          <SparkleIcon size={19}/>
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[16px] font-bold text-hi">Funnl AI</span>
            {isProUser && (
              <span className="font-mono text-[9.5px] font-bold tracking-[0.5px] text-accent bg-[rgba(139,124,255,0.22)] px-1.5 py-0.5 rounded-[5px]">
                PRO
              </span>
            )}
          </div>
          <p className="text-[12.5px] text-muted">
            {isProUser
              ? 'Your networking thinking partner'
              : 'Available with Pro access'}
          </p>
        </div>
      </div>

      {/* ── Messages / locked state ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 md:px-8 py-5">
        {isProUser ? (
          <div className="space-y-4">

            {/* Chat messages */}
            {messages.map((msg, i) => (
              <div key={i}>
                <div className={`flex items-start ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-[28px] h-[28px] rounded-[8px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center flex-none mr-2.5 mt-0.5 text-white">
                      <SparkleIcon size={13}/>
                    </div>
                  )}
                  <div className={`max-w-[80%] md:max-w-[68%] px-4 py-3 text-[14px] leading-relaxed rounded-2xl ${
                    msg.role === 'user'
                      ? `bg-[rgba(139,124,255,0.14)] border border-[rgba(139,124,255,0.45)] text-hi rounded-tr-sm whitespace-pre-wrap${msg.error ? ' opacity-60' : ''}`
                      : 'bg-card border border-line-2 text-muted rounded-tl-sm'
                  }`}>
                    {msg.role === 'assistant' ? (
                      <ReactMarkdown components={mdComponents}>{msg.content}</ReactMarkdown>
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>

                {/* Truncation note for long assistant responses */}
                {msg.role === 'assistant' && msg.truncated && (
                  <div className="flex justify-start pl-[44px] mt-1">
                    <p className="text-[11px] text-lower italic">Response may be cut short — feel free to ask a follow-up.</p>
                  </div>
                )}

                {/* Inline error indicator for failed user messages */}
                {msg.role === 'user' && msg.error && (
                  <div
                    className="flex justify-end mt-2 pr-0.5"
                    aria-live="polite"
                    role="status"
                  >
                    <div className="flex flex-col items-end gap-1.5 max-w-[80%] md:max-w-[68%]">
                      <p className="text-[12px] text-danger leading-snug text-right">
                        {msg.error.message}
                      </p>
                      {msg.error.request_id && (
                        <p className="text-[10.5px] text-lower font-mono">
                          Support ref: {msg.error.request_id}
                        </p>
                      )}
                      <div className="flex gap-3 items-center">
                        <button
                          onClick={() => dismissError(i)}
                          className="text-[11.5px] text-low hover:text-mid transition-colors"
                        >
                          Dismiss
                        </button>
                        {isRetryEligible(messages, i) && (
                          <button
                            onClick={() => retryMessage(i)}
                            disabled={loading}
                            className="text-[11.5px] text-accent hover:opacity-80 transition-opacity disabled:opacity-40 font-medium"
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Starter prompts — visible until first user message */}
            {!hasUserMessaged && (
              <div className="flex flex-wrap gap-2 pl-[36px]">
                {STARTER_PROMPTS.map(prompt => (
                  <button
                    key={prompt}
                    onClick={() => sendMessage(prompt)}
                    className="text-[12.5px] text-mid bg-elevated border border-line-2 px-[13px] py-[7px] rounded-full hover:border-[rgba(139,124,255,0.45)] hover:text-hi transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}

            {/* Thinking dots */}
            {loading && (
              <div className="flex items-start justify-start">
                <div className="w-[28px] h-[28px] rounded-[8px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center flex-none mr-2.5 mt-0.5 text-white">
                  <SparkleIcon size={13}/>
                </div>
                <div className="bg-card border border-line-2 rounded-2xl rounded-tl-sm px-4 py-[14px]">
                  <div className="flex gap-[5px] items-center">
                    <span className="w-[6px] h-[6px] rounded-full bg-low animate-bounce" style={{ animationDelay: '0ms' }}/>
                    <span className="w-[6px] h-[6px] rounded-full bg-low animate-bounce" style={{ animationDelay: '160ms' }}/>
                    <span className="w-[6px] h-[6px] rounded-full bg-low animate-bounce" style={{ animationDelay: '320ms' }}/>
                  </div>
                </div>
              </div>
            )}

            <div ref={bottomRef}/>
          </div>
        ) : (
          /* Locked state — non-Pro */
          <div className="flex flex-col items-center justify-center min-h-[300px] h-full text-center gap-5 py-12">
            <div className="w-[64px] h-[64px] rounded-[18px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center text-white opacity-50 shadow-[0_12px_40px_rgba(91,69,240,0.35)]">
              <SparkleIcon size={28}/>
            </div>
            <div className="max-w-[260px]">
              <h3 className="font-display text-[19px] font-bold text-hi mb-2">AI only available for Pro</h3>
              <p className="text-[13.5px] leading-relaxed text-muted">
                Ask anything about your network — who's gone cold, who you know at a specific company, what to follow up on next.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Input bar ───────────────────────────────────────────────────────────── */}
      <div className="flex-none px-4 md:px-8 pb-6 pt-3 border-t border-line-1">
        {isProUser ? (
          <>
            <div className="flex items-end bg-input border border-line-3 rounded-[20px] focus-within:border-[rgba(139,124,255,0.45)] focus-within:shadow-[0_0_0_3px_rgba(139,124,255,0.07)] transition-all duration-150">
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your network…"
                rows={1}
                disabled={loading}
                className="flex-1 bg-transparent text-[14.5px] text-hi placeholder-[#54545E] outline-none resize-none disabled:opacity-50 leading-relaxed pl-5 pr-2 py-[15px]"
              />
              <div className="flex-none p-[10px]">
                <button
                  onClick={() => sendMessage(input)}
                  disabled={loading || !input.trim()}
                  className="w-9 h-9 rounded-[12px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center hover:opacity-90 active:scale-95 transition-all disabled:opacity-20 shadow-[0_4px_12px_rgba(91,69,240,0.25)]"
                >
                  <SendIcon/>
                </button>
              </div>
            </div>
            <p className="text-[11px] text-lower text-center mt-2.5">Enter to send · Shift+Enter for new line</p>
          </>
        ) : (
          <div className="flex items-center bg-input border border-line-2 rounded-[20px] cursor-not-allowed opacity-40 select-none">
            <span className="flex-1 text-[14.5px] text-lower pl-5 py-[15px]">AI only available for Pro…</span>
            <div className="flex-none p-[10px]">
              <div className="w-9 h-9 rounded-[12px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center">
                <SendIcon/>
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}

export default FunnlAIPage
