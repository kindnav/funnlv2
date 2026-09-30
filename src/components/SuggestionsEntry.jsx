import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { SUGGESTION_REVIEW_ENABLED } from '../lib/suggestionReview'

// Compact, secondary Dashboard entry into the source-neutral Suggestions queue. Only
// mounts a query when the review gate is enabled, and only renders when there is at
// least one pending suggestion. Shows a count only — never any candidate/contact detail.
//
// THE COPY SAYS 'suggestions', NOT 'people'. An earlier version counted "N people to
// review", which was wrong for the only kind of suggestion that exists today: an
// INTERACTION with a contact the user already has. Nobody new is being proposed, so
// calling it a person to review told the user something untrue about their own data.
// 'suggestion' is also the term that stays correct when new-contact proposals do
// arrive, since the queue mixes both.
export default function SuggestionsEntry() {
  const [count, setCount] = useState(null)   // null until loaded; number afterwards

  useEffect(() => {
    if (!SUGGESTION_REVIEW_ENABLED) return   // disabled → no suggestions query at all
    let alive = true
    ;(async () => {
      const { count: c, error } = await supabase
        .from('interaction_candidates')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
      if (alive && !error) setCount(typeof c === 'number' ? c : 0)
    })()
    return () => { alive = false }
  }, [])

  if (!SUGGESTION_REVIEW_ENABLED) return null
  if (!count || count < 1) return null   // nothing to review → no entry

  return (
    <Link
      to="/suggestions"
      className="flex items-center gap-3 bg-card border border-line-1 rounded-2xl px-[16px] py-[12px] mb-[14px] hover:border-line-3 transition-colors"
    >
      <span className="flex-none w-8 h-8 rounded-lg flex items-center justify-center text-low"
            style={{ background: 'var(--color-elevated)' }} aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
          <path d="M4 7h16M4 12h16M4 17h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display font-semibold text-[13.5px] text-hi">Suggestions</span>
        <span className="block text-[12px] text-muted">
          {count} {count === 1 ? 'suggestion' : 'suggestions'} to review from your connected sources.
        </span>
      </span>
      <span className="flex-none font-mono text-[11px] font-semibold px-2 py-[3px] rounded-full bg-accent text-surface">{count}</span>
      <span className="flex-none text-muted text-[15px]" aria-hidden="true">›</span>
    </Link>
  )
}
