import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from './supabase'
import { countPendingSuggestions, SUGGESTIONS_CHANGED_EVENT, SUGGESTIONS_REFRESH_INTERVAL_MS } from './pendingSuggestions'

/**
 * The pending-suggestion count for the navigation badge. Refreshed on every route change
 * (like the follow-up badge) and whenever the Suggestions page announces a change through
 * SUGGESTIONS_CHANGED_EVENT - after an accept, a dismiss, or a background arrival it noticed.
 * Disabled (the review surface off) -> no query at all, count 0.
 */
export function usePendingSuggestionCount (enabled) {
  const [count, setCount] = useState(0)
  const location = useLocation()

  const refresh = useCallback(async () => {
    if (!enabled) return
    const n = await countPendingSuggestions(supabase)
    if (typeof n === 'number') setCount(n)
  }, [enabled])

  useEffect(() => { refresh() }, [refresh, location.pathname])

  useEffect(() => {
    if (!enabled) return undefined
    const handler = () => refresh()
    window.addEventListener(SUGGESTIONS_CHANGED_EVENT, handler)
    return () => window.removeEventListener(SUGGESTIONS_CHANGED_EVENT, handler)
  }, [enabled, refresh])

  // Arrivals while ANOTHER page is open: the same bounded head counts, on the same interval
  // as the queue, only while the tab is visible, and once more when it becomes visible.
  useEffect(() => {
    if (!enabled) return undefined
    const tick = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh() }
    const timer = setInterval(tick, SUGGESTIONS_REFRESH_INTERVAL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [enabled, refresh])

  return enabled ? count : 0
}
