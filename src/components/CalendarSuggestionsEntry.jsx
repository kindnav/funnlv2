import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { CALENDAR_INGESTION_ENABLED } from '../lib/calendarIngestion'

// Dashboard entry point for the Calendar review queue. Only mounts a query when the
// ingestion flag is enabled, and only renders when there is at least one pending
// suggestion to review. Shows a count only — never any candidate/contact detail.
export default function CalendarSuggestionsEntry() {
  const [count, setCount] = useState(null)   // null until loaded; number afterwards

  useEffect(() => {
    if (!CALENDAR_INGESTION_ENABLED) return   // disabled → no candidate query at all
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

  if (!CALENDAR_INGESTION_ENABLED) return null
  if (!count || count < 1) return null   // nothing to review → no entry

  return (
    <Link
      to="/calendar-suggestions"
      className="flex items-center gap-3 bg-card border border-line-1 rounded-2xl px-[18px] py-[14px] mb-[14px] hover:border-line-3 transition-colors"
    >
      <span className="flex-none w-9 h-9 rounded-lg flex items-center justify-center text-[16px]"
            style={{ background: 'var(--color-elevated)' }} aria-hidden="true">🗓️</span>
      <span className="min-w-0 flex-1">
        <span className="block font-display font-semibold text-[14px] text-hi">Calendar suggestions</span>
        <span className="block text-[12px] text-muted">
          {count} {count === 1 ? 'person' : 'people'} from your calendar to review
        </span>
      </span>
      <span className="flex-none font-mono text-[11px] font-semibold px-2 py-[3px] rounded-full bg-accent text-surface">{count}</span>
      <span className="flex-none text-muted text-[16px]" aria-hidden="true">›</span>
    </Link>
  )
}
