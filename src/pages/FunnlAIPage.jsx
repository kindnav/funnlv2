import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { supabase } from '../lib/supabase'
import { canUseAI } from '../lib/ai'
import { track } from '../lib/analytics'

// Markdown component overrides — applied only to assistant messages.
// Raw HTML is not rendered (react-markdown default, kept intentionally).
const mdComponents = {
  p:      ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul:     ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
  ol:     ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
  li:     ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-hi">{children}</strong>,
  em:     ({ children }) => <em className="italic">{children}</em>,
  a:      ({ children }) => <span>{children}</span>,
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
  const [messages, setMessages]           = useState([INITIAL_MESSAGE])
  const [input, setInput]                 = useState('')
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState('')
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

  // Scroll to latest message
  useEffect(() => {
    if (isProUser) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, isProUser])

  async function sendMessage(text) {
    const trimmed = text.trim()
    if (!trimmed || loading) return

    const userMsg      = { role: 'user', content: trimmed }
    const nextMessages = [...messages, userMsg]

    setMessages(nextMessages)
    setInput('')
    setError('')
    setLoading(true)

    if (inputRef.current) inputRef.current.style.height = 'auto'

    try {
      const { data, error: fnError } = await supabase.functions.invoke('ai-chat', {
        body: { messages: nextMessages },
      })

      setLoading(false)

      if (fnError || data?.error) {
        setError(fnError?.message || data?.error || 'Something went wrong — please try again.')
        return
      }

      if (data?.reply) {
        track('ai_assistant_used')
        setMessages(prev => [...prev, { role: 'assistant', content: data.reply }])
      } else {
        // Guard against a silent blank — data came back but reply is missing
        setError('No response received — please try again.')
      }
    } catch {
      setLoading(false)
      setError('Something went wrong — please try again.')
    }
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
      <div className="flex items-center gap-[11px] px-4 md:px-8 py-[22px] border-b border-[rgba(255,255,255,0.06)] flex-none">
        <div className="w-9 h-9 rounded-[10px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center shadow-[0_4px_16px_rgba(91,69,240,0.4)] flex-none text-white">
          <SparkleIcon size={19}/>
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[16px] font-bold text-hi">Funnl AI</span>
            {isProUser && (
              <span className="font-mono text-[9.5px] font-bold tracking-[0.5px] text-accent bg-[rgba(139,124,255,0.14)] px-1.5 py-0.5 rounded-[5px]">
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
              <div key={i} className={`flex items-start ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-[28px] h-[28px] rounded-[8px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center flex-none mr-2.5 mt-0.5 text-white">
                    <SparkleIcon size={13}/>
                  </div>
                )}
                <div className={`max-w-[80%] md:max-w-[68%] px-4 py-3 text-[14px] leading-relaxed rounded-2xl ${
                  msg.role === 'user'
                    ? 'bg-[rgba(139,124,255,0.14)] border border-[rgba(139,124,255,0.25)] text-hi rounded-tr-sm whitespace-pre-wrap'
                    : 'bg-card border border-[rgba(255,255,255,0.07)] text-muted rounded-tl-sm'
                }`}>
                  {msg.role === 'assistant' ? (
                    <ReactMarkdown components={mdComponents}>{msg.content}</ReactMarkdown>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}

            {/* Starter prompts — visible until first user message */}
            {!hasUserMessaged && (
              <div className="flex flex-wrap gap-2 pl-[36px]">
                {STARTER_PROMPTS.map(prompt => (
                  <button
                    key={prompt}
                    onClick={() => sendMessage(prompt)}
                    className="text-[12.5px] text-mid bg-elevated border border-[rgba(255,255,255,0.08)] px-[13px] py-[7px] rounded-full hover:border-[rgba(139,124,255,0.35)] hover:text-hi transition-colors"
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
                <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl rounded-tl-sm px-4 py-[14px]">
                  <div className="flex gap-[5px] items-center">
                    <span className="w-[6px] h-[6px] rounded-full bg-low animate-bounce" style={{ animationDelay: '0ms' }}/>
                    <span className="w-[6px] h-[6px] rounded-full bg-low animate-bounce" style={{ animationDelay: '160ms' }}/>
                    <span className="w-[6px] h-[6px] rounded-full bg-low animate-bounce" style={{ animationDelay: '320ms' }}/>
                  </div>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex justify-center px-4">
                <p className="text-[13px] text-danger bg-[rgba(255,107,138,0.08)] border border-[rgba(255,107,138,0.2)] px-4 py-2.5 rounded-xl text-center">
                  {error}
                </p>
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
      <div className="flex-none px-4 md:px-8 pb-6 pt-3 border-t border-[rgba(255,255,255,0.06)]">
        {isProUser ? (
          <>
            <div className="flex items-end bg-input border border-[rgba(255,255,255,0.09)] rounded-[20px] focus-within:border-[rgba(139,124,255,0.45)] focus-within:shadow-[0_0_0_3px_rgba(139,124,255,0.07)] transition-all duration-150">
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
          <div className="flex items-center bg-input border border-[rgba(255,255,255,0.07)] rounded-[20px] cursor-not-allowed opacity-40 select-none">
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
