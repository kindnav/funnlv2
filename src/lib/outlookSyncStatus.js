// The Outlook sync status shown in Settings, derived ONLY from persisted state.
//
// Pure: no clock of its own (the caller passes `nowMs`, which should be the server's
// `server_now` when the RPC answered), no Supabase import, so it is testable in plain Node.
//
// Every line below is backed by a column: `activity` is 'running' only while a lease is live
// in outlook_sync_state, 'retry_scheduled' only while next_retry_at is in the future,
// 'error' only when a last_error_code is recorded. Nothing here is a timer, a spinner that
// assumes progress, or an optimistic "synced" label.

export const SYNC_TONES = Object.freeze(['ok', 'info', 'warn', 'error', 'muted'])

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** "just now", "4 minutes ago", "3 hours ago", "2 days ago" - or '' when unreadable. */
export function formatRelativePast (iso, nowMs) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return ''
  const d = Math.max(0, nowMs - t)
  if (d < MIN) return 'just now'
  if (d < HOUR) { const n = Math.round(d / MIN); return `${n} minute${n === 1 ? '' : 's'} ago` }
  if (d < DAY) { const n = Math.round(d / HOUR); return `${n} hour${n === 1 ? '' : 's'} ago` }
  const n = Math.round(d / DAY)
  return `${n} day${n === 1 ? '' : 's'} ago`
}

/** "in 4 minutes", "in 2 hours" - or '' when the moment is unreadable or already past. */
export function formatRelativeFuture (iso, nowMs) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t) || !Number.isFinite(nowMs) || t <= nowMs) return ''
  const d = t - nowMs
  if (d < MIN) return 'in under a minute'
  if (d < HOUR) { const n = Math.round(d / MIN); return `in ${n} minute${n === 1 ? '' : 's'}` }
  if (d < DAY) { const n = Math.round(d / HOUR); return `in ${n} hour${n === 1 ? '' : 's'}` }
  const n = Math.round(d / DAY)
  return `in ${n} day${n === 1 ? '' : 's'}`
}

/**
 * The "listening for new mail" line, from the subscription record.
 * @returns {{text:string, tone:string}}
 */
export function describeListening (sub, nowMs) {
  if (!sub || typeof sub !== 'object') {
    return { text: 'Not yet listening for new mail. Checks still run about every 15 minutes.', tone: 'muted' }
  }
  const exp = Date.parse(sub.expires_at ?? '')
  if (sub.status === 'active' && Number.isFinite(exp) && exp > nowMs) {
    const when = formatRelativeFuture(sub.expires_at, nowMs)
    return { text: `Listening for new mail${when ? ` (renews ${when})` : ''}.`, tone: 'ok' }
  }
  if (sub.status === 'reauthorize') {
    return { text: 'Microsoft asked Funnl to re-confirm its mail listener; the next check does that.', tone: 'warn' }
  }
  if (sub.status === 'removed') {
    return { text: 'Microsoft removed the mail listener; the next check sets it up again.', tone: 'warn' }
  }
  if (sub.status === 'failed') {
    return { text: `Could not set up the mail listener${sub.last_error_code ? ` (${sub.last_error_code})` : ''}. Checks still run about every 15 minutes.`, tone: 'warn' }
  }
  return { text: 'The mail listener has expired; the next check sets it up again.', tone: 'warn' }
}

/**
 * The whole status block, or null when there is nothing to show (not connected).
 * @param {object|null} s   the get_my_outlook_sync_status() answer
 * @param {number} nowMs    the reference clock (the RPC's server_now when available)
 * @returns {null|{headline:string, detail:string, listening:{text:string,tone:string}, tone:string, reconnect:boolean, queued:boolean}}
 */
export function describeSyncStatus (s, nowMs) {
  if (!s || typeof s !== 'object' || s.result !== 'connected') return null
  const now = Number.isFinite(nowMs) ? nowMs : Date.parse(s.server_now ?? '') || Date.now()
  const listening = describeListening(s.subscription, now)
  const lastOk = formatRelativePast(s.last_success_at, now)
  const queued = s.wake_pending === true

  if (s.needs_reauth === true || s.status !== 'active') {
    return {
      tone: 'error',
      headline: 'Needs your permission again',
      detail: 'Funnl cannot check this mailbox until you disconnect and reconnect Outlook.',
      listening, reconnect: true, queued: false,
    }
  }
  if (s.activity === 'running') {
    return {
      tone: 'info',
      headline: 'Checking your mailbox now',
      detail: lastOk ? `Last successful sync ${lastOk}.` : 'This is the first check.',
      listening, reconnect: false, queued,
    }
  }
  if (s.activity === 'retry_scheduled') {
    const when = formatRelativeFuture(s.next_retry_at, now)
    return {
      tone: 'warn',
      headline: 'The last check did not finish',
      detail: `Funnl will try again${when ? ` ${when}` : ' shortly'}${s.last_error_code ? ` (${s.last_error_code})` : ''}.${lastOk ? ` Last successful sync ${lastOk}.` : ''}`,
      listening, reconnect: false, queued,
    }
  }
  if (s.activity === 'error') {
    return {
      tone: 'warn',
      headline: 'The last check did not finish',
      detail: `${s.last_error_code ? `Reason: ${s.last_error_code}. ` : ''}The next scheduled check will try again.${lastOk ? ` Last successful sync ${lastOk}.` : ''}`,
      listening, reconnect: false, queued,
    }
  }
  if (s.activity === 'never_synced' || !lastOk) {
    return {
      tone: 'muted',
      headline: 'Not synced yet',
      detail: queued ? 'New mail was signalled; the first check is queued.' : 'The first check runs automatically within a few minutes.',
      listening, reconnect: false, queued,
    }
  }
  return {
    tone: 'ok',
    headline: 'Up to date',
    detail: `Last successful sync ${lastOk}.${queued ? ' New mail was signalled; a check is queued.' : ''}`,
    listening, reconnect: false, queued,
  }
}
