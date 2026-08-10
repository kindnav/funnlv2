/**
 * followUpActions.js — shared follow-up mutation sequences.
 *
 * Each action:
 *   1. Builds the correct payload (via followUpUtils pure functions).
 *   2. Performs the Supabase update.
 *   3. On success ONLY: fires the correct analytics event, then dispatches the
 *      funnl:followups-changed event.
 *   4. Returns { ok: boolean, errorMessage: string|null }.
 *
 * Dependencies are injected via the `deps` parameter so that:
 *   - Pages pass { client: supabase, track, dispatch } from their scope.
 *   - Tests pass stubs without module-level mocking.
 *
 * No React, no top-level Supabase or analytics imports — safe for Node.js tests.
 */

import { snoozeOptionToDate } from './contactDirectoryUtils.js'
import {
  completionPayload,
  snoozePayload,
  undoPayload,
  clearCompletionFields,
} from './followUpUtils.js'

// ── completeFollowUp ──────────────────────────────────────────────────────────
//
// Marks a dated follow-up as done (Done button) or completed via Log Result.
// DB update must succeed before analytics or event dispatch.
//
// deps.method    'mark_done' | 'log_result'          default: 'mark_done'
// deps.now       ISO timestamp string                 default: new Date().toISOString()
// deps.client    Supabase client (injectable)
// deps.track     analytics track fn (injectable)
// deps.dispatch  () => void — should dispatch funnl:followups-changed
//
export async function completeFollowUp(interaction, deps = {}) {
  const {
    method   = 'mark_done',
    now      = new Date().toISOString(),
    client,
    track,
    dispatch,
  } = deps
  const payload = completionPayload(interaction.follow_up_date, method, now)
  const { data, error } = await client
    .from('interactions')
    .update(payload)
    .eq('id', interaction.id)
    .select('id')
    .single()
  if (error || !data?.id) {
    return { ok: false, errorMessage: error?.message || 'Update failed' }
  }
  track('followup_completed', { method })
  dispatch()
  return { ok: true, errorMessage: null }
}

// ── snoozeFollowUp ────────────────────────────────────────────────────────────
//
// Reschedules a dated follow-up. Clears completion metadata (snoozePayload).
// Fires followup_snoozed with the chosen option. Analytics + dispatch only on success.
//
export async function snoozeFollowUp(interaction, option, customDate, today, deps = {}) {
  const { client, track, dispatch } = deps
  const newDate = snoozeOptionToDate(option, customDate, today)
  if (!newDate) return { ok: false, errorMessage: 'Pick a date after today.' }
  const payload = snoozePayload(newDate)
  const { data, error } = await client
    .from('interactions')
    .update(payload)
    .eq('id', interaction.id)
    .select('id')
    .single()
  if (error || !data?.id) {
    return { ok: false, errorMessage: error?.message || 'Update failed' }
  }
  track('followup_snoozed', { option })
  dispatch()
  return { ok: true, errorMessage: null }
}

// ── undoFollowUp ──────────────────────────────────────────────────────────────
//
// Restores a completed follow-up to its previous open state.
// No analytics is fired for Undo. Dispatches event only on success.
// Missing previous date → safe error, no DB update.
//
export async function undoFollowUp(interaction, deps = {}) {
  const { client, dispatch } = deps
  const previousDate = interaction.follow_up_previous_date
  if (!previousDate) {
    return { ok: false, errorMessage: "Previous date unavailable — can't undo." }
  }
  const payload = undoPayload(previousDate)
  const { data, error } = await client
    .from('interactions')
    .update(payload)
    .eq('id', interaction.id)
    .select('id')
    .single()
  if (error || !data?.id) {
    return { ok: false, errorMessage: error?.message || 'Update failed' }
  }
  dispatch()
  return { ok: true, errorMessage: null }
}

// ── markResponded ─────────────────────────────────────────────────────────────
//
// Sets outreach_status = 'responded' on an awaiting-response row.
// Does NOT dispatch funnl:followups-changed (follow_up_date unchanged).
// Fires outreach_status_changed only on success.
//
export async function markResponded(interaction, deps = {}) {
  const { client, track } = deps
  const { data, error } = await client
    .from('interactions')
    .update({ outreach_status: 'responded' })
    .eq('id', interaction.id)
    .select('id')
    .single()
  if (error || !data?.id) {
    return { ok: false, errorMessage: error?.message || 'Update failed' }
  }
  track('outreach_status_changed', { status: 'responded', context: 'edit_interaction' })
  return { ok: true, errorMessage: null }
}

// ── nudgeFollowUp ─────────────────────────────────────────────────────────────
//
// Sets a follow-up date on an awaiting-response row that currently has no date.
// Clears completion metadata. Fires followup_set (NOT followup_snoozed).
//
export async function nudgeFollowUp(interaction, option, customDate, today, deps = {}) {
  const { client, track, dispatch } = deps
  const newDate = snoozeOptionToDate(option, customDate, today)
  if (!newDate) return { ok: false, errorMessage: 'Pick a date after today.' }
  const payload = { follow_up_date: newDate, ...clearCompletionFields() }
  const { data, error } = await client
    .from('interactions')
    .update(payload)
    .eq('id', interaction.id)
    .select('id')
    .single()
  if (error || !data?.id) {
    return { ok: false, errorMessage: error?.message || 'Update failed' }
  }
  track('followup_set')
  dispatch()
  return { ok: true, errorMessage: null }
}
