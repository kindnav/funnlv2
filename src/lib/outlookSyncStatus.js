// The Outlook sync status shown in Settings, derived ONLY from persisted state.
//
// Pure: no clock of its own (the caller passes `nowMs`, which should be the server's
// `server_now` when the RPC answered), no Supabase import, so it is testable in plain Node.
//
// Every line below is backed by a column: `activity` is 'running' only while a lease is live
// in outlook_sync_state, 'retry_scheduled' only while next_retry_at is in the future,
// 'error' only when a last_error_code is recorded; `wake_pending` is a recorded signal that
// no completed round has covered; `last_run_complete` says whether the last round finished
// the mailbox; `schedule_active` is the pg_cron job's own flag. Nothing here is a timer, a
// spinner that assumes progress, or an optimistic "synced" label.
//
// REPRODUCED BEFORE THIS REVISION: "Up to date" was shown while new mail was signalled and
// unread, and while a round was paused mid-way; and "checks run about every 15 minutes" was
// claimed before any schedule was switched on.

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
 * What an automatic check can honestly be promised, given the schedule's own flag - and, when
 * the viewer is not currently invited, the fact that the schedule is expected to pass this
 * mailbox over.
 *
 * WHY THE SECOND ARGUMENT EXISTS. `schedule_active` is a property of the CRON JOB, not of this
 * account, so on a removed account the unqualified line said "Automatic checks are on" directly
 * above a panel saying checks are not running for you. Both were true of different things and
 * together they were misleading.
 *
 * WHAT IT DOES NOT CLAIM, and this is the whole point of the wording. The list the browser
 * reads establishes exactly one fact: whether this viewer's id is in the configured value. It
 * does NOT establish that the server has stopped - the configuration is a function-environment
 * variable that takes effect per invocation, a run already reserved still finishes, and this
 * page cannot see either. So the line reports the list membership and frames the consequence
 * as an EXPECTATION, qualified with "once the change has taken effect", instead of asserting
 * a stop it cannot observe.
 * @param {boolean} scheduleActive
 * @param {boolean} [invited]  false when this viewer is not in the configured list
 */
export function describeAutomation (scheduleActive, invited = true) {
  if (invited !== true) {
    return {
      text: 'This mailbox is not on Funnl\u2019s invited list, so once that change has taken '
        + 'effect Funnl does not start new automatic checks of it. Nothing has been deleted, '
        + 'and you can disconnect below whenever you want to.',
      on: false,
    }
  }
  return scheduleActive === true
    ? { text: 'Automatic checks are on: about every 15 minutes, and within minutes of new mail.', on: true }
    : { text: 'Automatic checks are not switched on yet. Checks run only when started by Funnl.', on: false }
}

/**
 * The "listening for new mail" line, from the subscription record. Never promises a
 * fallback check unless the schedule is on.
 *
 * RENEWAL IS NOT A PROPERTY OF THE RECORD. The listener is renewed BY A RUN, so "renews in
 * two days" is a promise about future runs. For a viewer who is not on the invited list the
 * line therefore reports the lapse the record already carries and promises no renewal and no
 * re-creation - the same reason the automation line above says "once the change has taken
 * effect" rather than claiming a stop.
 * @param {boolean} [invited]  false when this viewer is not in the configured list
 * @returns {{text:string, tone:string}}
 */
export function describeListening (sub, nowMs, scheduleActive = false, invited = true) {
  const fallback = scheduleActive === true ? ' Scheduled checks continue about every 15 minutes.' : ''
  if (!sub || typeof sub !== 'object') {
    return { text: `Not yet listening for new mail.${fallback}`, tone: 'muted' }
  }
  const exp = Date.parse(sub.expires_at ?? '')
  if (sub.status === 'active' && Number.isFinite(exp) && exp > nowMs) {
    const when = formatRelativeFuture(sub.expires_at, nowMs)
    if (invited !== true) {
      return {
        text: `Microsoft is still set up to tell Funnl when new mail arrives${when ? `, and that arrangement lapses ${when}` : ''}.`,
        tone: 'muted',
      }
    }
    return { text: `Listening for new mail${when ? ` (renews ${when})` : ''}.`, tone: 'ok' }
  }
  if (invited !== true) {
    // Every remaining branch used to say "the next check sets it up again", which is a
    // promise about a run this page cannot promise.
    return { text: 'Funnl is not set up to be told about new mail in this mailbox.', tone: 'muted' }
  }
  if (sub.status === 'reauthorize') {
    return { text: 'Microsoft asked Funnl to re-confirm its mail listener; the next check does that.', tone: 'warn' }
  }
  if (sub.status === 'removed') {
    return { text: 'Microsoft removed the mail listener; the next check sets it up again.', tone: 'warn' }
  }
  if (sub.status === 'failed') {
    return { text: `Could not set up the mail listener${sub.last_error_code ? ` (${sub.last_error_code})` : ''}.${fallback}`, tone: 'warn' }
  }
  return { text: 'The mail listener has expired; the next check sets it up again.', tone: 'warn' }
}

/**
 * The whole status block, or null when there is nothing to show (not connected).
 * @param {object|null} s   the get_my_outlook_sync_status() answer
 * @param {number} nowMs    the reference clock (the RPC's server_now when available)
 */
export function describeSyncStatus (s, nowMs, invited = true) {
  if (!s || typeof s !== 'object' || s.result !== 'connected') return null
  const now = Number.isFinite(nowMs) ? nowMs : Date.parse(s.server_now ?? '') || Date.now()
  // A viewer who is not in the configured list will not be picked up by the schedule, so the
  // schedule's own flag must not be read to them as a promise about their mailbox.
  const scheduleActive = s.schedule_active === true && invited === true
  const listening = describeListening(s.subscription, now, scheduleActive, invited)
  const automation = describeAutomation(s.schedule_active === true, invited)
  const lastOk = formatRelativePast(s.last_success_at, now)
  const queued = s.wake_pending === true
  const incomplete = s.last_run_complete === false && !!lastOk
  const base = { listening, automation, reconnect: false, queued }

  if (s.needs_reauth === true || s.status !== 'active') {
    // NO DISCONNECT-TO-RENEW, anywhere. Renewal is a same-account OAuth update, and the
    // instruction this used to carry would have erased the synchronisation state, the
    // provenance references and the thread-recovery rows, all of which cascade from the
    // connection. Where the viewer has no update control - not currently invited - the detail
    // says what is true and offers nothing that would fail.
    return {
      ...base,
      tone: 'error',
      headline: 'Needs your permission again',
      detail: invited === true
        ? 'Funnl cannot check this mailbox until you update your Outlook permissions below. '
          + 'Your connection and everything Funnl has already matched stay as they are.'
        : 'Funnl cannot check this mailbox until its permissions are updated, and that is not '
          + 'something you can do from here at the moment. Nothing has been deleted.',
      reconnect: false,
      renew: invited === true,
      queued: false,
    }
  }
  if (s.activity === 'running') {
    // A LIVE LEASE IS A RECORDED FACT and it is kept, invited or not. What changes is the
    // claim: "Checking your mailbox now" next to "Funnl does not start new automatic checks"
    // was a contradiction, so for a removed viewer the headline reports the round that was
    // already under way. A reserved round finishes; it is not cancelled by a list change,
    // and cancelling one mid-way is how a round loses work.
    if (invited !== true) {
      return {
        ...base, tone: 'info', headline: 'A check is still under way',
        detail: `A check that had already started is recorded as still running, and it may `
          + `finish.${lastOk ? ` Last successful sync ${lastOk}.` : ''}`,
      }
    }
    return {
      ...base, tone: 'info', headline: 'Checking your mailbox now',
      detail: lastOk ? `Last successful sync ${lastOk}.` : 'This is the first check.',
    }
  }
  if (s.activity === 'retry_scheduled') {
    const when = formatRelativeFuture(s.next_retry_at, now)
    const code = s.last_error_code ? ` (${s.last_error_code})` : ''
    // `next_retry_at` IS a recorded moment, so a removed viewer still sees it - but "Funnl
    // will try again" is a promise about a future run, and the list in this browser cannot
    // support it either way.
    if (invited !== true) {
      return {
        ...base, tone: 'warn', headline: 'The last check did not finish',
        detail: `A retry is recorded for${when ? ` ${when.replace(/^in /, '')} from now` : ' later'}${code}. `
          + `While this mailbox is off the invited list, this page cannot say whether that `
          + `retry runs.${lastOk ? ` Last successful sync ${lastOk}.` : ''}`,
      }
    }
    return {
      ...base, tone: 'warn', headline: 'The last check did not finish',
      detail: `Funnl will try again${when ? ` ${when}` : ' shortly'}${code}.${lastOk ? ` Last successful sync ${lastOk}.` : ''}`,
    }
  }
  if (s.activity === 'error') {
    const reason = s.last_error_code ? `Reason: ${s.last_error_code}. ` : ''
    if (invited !== true) {
      return {
        ...base, tone: 'warn', headline: 'The last check did not finish',
        detail: `${reason}${lastOk ? `Last successful sync ${lastOk}.` : ''}`.trim()
          || 'The last check did not finish.',
      }
    }
    return {
      ...base, tone: 'warn', headline: 'The last check did not finish',
      detail: `${reason}${scheduleActive ? 'The next scheduled check will try again.' : 'The next check will try again.'}${lastOk ? ` Last successful sync ${lastOk}.` : ''}`,
    }
  }
  if (s.activity === 'never_synced' || !lastOk) {
    return {
      ...base, tone: 'muted', headline: 'Not synced yet',
      detail: queued
        ? (invited === true
            ? 'New mail was signalled; the first check is queued.'
            : 'New mail was signalled and has not been checked yet.')
        : (scheduleActive ? 'The first check runs automatically within a few minutes.' : 'The first check has not run.'),
    }
  }
  // Idle with a complete last round and no signal is the ONLY state that may say up to date.
  if (queued || incomplete) {
    return {
      ...base, tone: 'info', headline: 'A check is due',
      detail: `${queued ? 'New mail was signalled and has not been checked yet.' : 'The last check paused before finishing the mailbox.'}${scheduleActive ? ' It will be picked up by the next automatic check.' : ''} Last successful sync ${lastOk}.`,
    }
  }
  return {
    ...base, tone: 'ok', headline: 'Up to date',
    detail: `Last successful sync ${lastOk}.`,
  }
}
