import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { describeSyncStatus } from '../lib/outlookSyncStatus'
import { SUGGESTIONS_CHANGED_EVENT } from '../lib/pendingSuggestions'

// Settings → Outlook → the sync status block, shown only on a CONNECTED card.
//
// Everything rendered comes from get_my_outlook_sync_status(), an authenticated-only RPC
// that reads the persisted sync state, the retry state and the change-notification
// subscription for the signed-in user's own connection. The clock used for "x minutes
// ago" is the server's `server_now`, so a wrong device clock cannot make a stale sync look
// fresh. Re-read every minute while the tab is visible, and when the Suggestions page
// announces a change - never on a timer that assumes a sync happened.

const REFRESH_MS = 60_000

const TONE_CLASS = {
  ok: 'border-success/40 bg-success/10 text-success',
  info: 'border-accent/40 bg-accent/10 text-tag',
  warn: 'border-warning/40 bg-warning/10 text-warning',
  error: 'border-danger/40 bg-danger/10 text-danger',
  muted: 'border-line-2 bg-elevated text-muted',
}

export default function OutlookSyncStatus () {
  const [answer, setAnswer] = useState(null)      // the RPC's jsonb, or null
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('get_my_outlook_sync_status')
      if (error || !data || typeof data !== 'object') { setFailed(true); return }
      setFailed(false)
      setAnswer(data)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    load()
    const tick = () => { if (document.visibilityState === 'visible') load() }
    const timer = setInterval(tick, REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener(SUGGESTIONS_CHANGED_EVENT, tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener(SUGGESTIONS_CHANGED_EVENT, tick)
    }
  }, [load])

  if (failed) {
    return (
      <p className="mt-3 text-sm text-muted" role="status" aria-live="polite" data-testid="outlook-sync-status">
        Sync status is unavailable right now.
      </p>
    )
  }
  const view = describeSyncStatus(answer, Date.parse(answer?.server_now ?? '') || Date.now())
  if (!view) return null

  return (
    <div
      className={`mt-3 rounded-xl border p-3 ${TONE_CLASS[view.tone] || TONE_CLASS.muted}`}
      role="status"
      aria-live="polite"
      data-testid="outlook-sync-status"
      data-tone={view.tone}
    >
      <p className="text-sm font-semibold">{view.headline}</p>
      <p className="mt-1 text-sm text-muted">{view.detail}</p>
      <p className="mt-1 text-[12px] text-muted" data-testid="outlook-listening">{view.listening.text}</p>
      {answer?.pending_suggestions > 0 && (
        <p className="mt-1 text-[12px] text-muted">
          {answer.pending_suggestions} {answer.pending_suggestions === 1 ? 'suggestion' : 'suggestions'} waiting for your review.
        </p>
      )}
      {view.reconnect && (
        <p className="mt-2 text-sm">Use <span className="font-semibold">Disconnect Outlook</span> below, then connect again.</p>
      )}
    </div>
  )
}
