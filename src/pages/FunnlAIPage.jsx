// Funnl AI — Layer 3 coming-soon screen
// The chat interface is designed and waiting. Nothing is wired up yet.

function FunnlAIPage() {
  const prompts = [
    'Summarize my coffee chats',
    'Find alumni at Google',
    "Who haven't I contacted?",
  ]

  return (
    <div className="min-h-screen bg-surface flex flex-col" style={{ backgroundImage: 'radial-gradient(circle at 50% -10%, rgba(108,92,255,0.09), transparent 45%)' }}>

      {/* Header */}
      <div className="flex items-center gap-[11px] px-4 md:px-8 py-[22px] border-b border-[rgba(255,255,255,0.06)] flex-none">
        <div className="w-9 h-9 rounded-[10px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center shadow-[0_4px_16px_rgba(91,69,240,0.4)] flex-none">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="white">
            <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
          </svg>
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[16px] font-bold text-hi">Funnl AI</span>
            <span className="font-mono text-[9.5px] font-bold tracking-[0.5px] text-accent bg-[rgba(139,124,255,0.14)] px-1.5 py-0.5 rounded-[5px]">SOON</span>
          </div>
          <p className="text-[12.5px] text-muted">Coming in Layer 3 — keep logging interactions</p>
        </div>
      </div>

      {/* Main area — empty state centered */}
      <div className="flex-1 flex items-center justify-center px-4 py-8 md:px-12 md:py-12">
        <div className="text-center max-w-md">
          <div className="w-[72px] h-[72px] mx-auto mb-6 rounded-[20px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center shadow-[0_16px_48px_rgba(91,69,240,0.45)]">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="white">
              <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
            </svg>
          </div>

          <h1 className="font-display text-[26px] font-bold text-hi mb-3 tracking-[-0.3px]">Funnl AI is coming</h1>

          <p className="text-[14.5px] leading-[1.65] text-muted mb-5">
            Ask anything about your network — who to reach out to, who you know at a specific company, or get a summary of your recent conversations. It reads your notes, not just your contacts.
          </p>

          <p className="font-mono text-[11px] font-bold text-accent bg-[rgba(139,124,255,0.12)] border border-[rgba(139,124,255,0.2)] inline-block px-3 py-1.5 rounded-lg mb-8">
            Arriving in Layer 3 · Claude API
          </p>

          <div className="text-left bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5">
            <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono mb-3">What you'll be able to ask</p>
            <ul className="space-y-2.5">
              {[
                { q: '"Who do I know at Goldman Sachs?"', note: 'Search your network by company' },
                { q: '"Who should I follow up with this week?"', note: 'Based on your interaction history' },
                { q: '"Summarize my coffee chats this month"', note: 'AI reads your logged notes' },
                { q: '"Who mentioned Python skills?"', note: 'Semantic search over your data' },
              ].map(({ q, note }) => (
                <li key={q} className="flex items-start gap-3">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="#B4A8FF" className="flex-none mt-0.5">
                    <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
                  </svg>
                  <div>
                    <p className="text-[13.5px] font-semibold text-hi">{q}</p>
                    <p className="text-[12px] text-low">{note}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Bottom — visual preview of the input experience, intentionally non-interactive */}
      <div className="flex-none px-4 md:px-8 pb-6 pt-3 border-t border-[rgba(255,255,255,0.06)]">
        {/* Prompt chips — pointer-events-none makes clear they're not clickable */}
        <div className="flex gap-2 mb-3 flex-wrap pointer-events-none opacity-40 select-none">
          {prompts.map(p => (
            <span key={p} className="text-[12.5px] text-mid bg-elevated border border-[rgba(255,255,255,0.08)] px-[13px] py-[7px] rounded-full">
              {p}
            </span>
          ))}
        </div>

        {/* Input bar — styled div, not a real input, cursor signals it's not active */}
        <div
          className="flex items-center gap-3 bg-input border border-[rgba(139,124,255,0.35)] rounded-2xl px-4 py-3 cursor-not-allowed"
          title="Funnl AI is coming in Layer 3"
          style={{ boxShadow: '0 0 0 1px rgba(139,124,255,0.18)' }}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#6C6C78" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
            <path d="M21 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9 16"/>
          </svg>
          <span className="flex-1 text-[14.5px] text-lower select-none">Funnl AI is coming in Layer 3…</span>
          <div className="w-9 h-9 rounded-[11px] bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] flex items-center justify-center opacity-40 flex-none">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M6 11l6-6 6 6"/>
            </svg>
          </div>
        </div>
      </div>

    </div>
  )
}

export default FunnlAIPage
