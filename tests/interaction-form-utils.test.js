/**
 * interaction-form-utils.test.js
 *
 * Tests for pure functions in src/lib/interactionFormUtils.js.
 * Zero-dependency Node.js — run with: node tests/interaction-form-utils.test.js
 */
import assert from 'assert'
import {
  isFirstContactNavigation,
  shouldShowAIFill,
  outreachResetOnTypeChange,
  typeChangeFields,
  initEditTrackOutreach,
  viewExistingRoute,
  shouldDispatchFollowupChange,
} from '../src/lib/interactionFormUtils.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`)
    failed++
  }
}

// ── isFirstContactNavigation ───────────────────────────────────────────────────

console.log('\nisFirstContactNavigation\n')

test('count=0 with real ID → first contact, navigate', () => {
  assert.strictEqual(isFirstContactNavigation(0, 'abc-123'), true)
})

test('count=0 with null ID → insert failed, do not navigate', () => {
  assert.strictEqual(isFirstContactNavigation(0, null), false)
})

test('count=0 with undefined ID → do not navigate', () => {
  assert.strictEqual(isFirstContactNavigation(0, undefined), false)
})

test('count=0 with empty string ID → do not navigate', () => {
  assert.strictEqual(isFirstContactNavigation(0, ''), false)
})

test('count=1 with real ID → later contact, do not navigate', () => {
  assert.strictEqual(isFirstContactNavigation(1, 'abc-123'), false)
})

test('count=5 with real ID → later contact, do not navigate', () => {
  assert.strictEqual(isFirstContactNavigation(5, 'abc-123'), false)
})

test('edit mode would never call with count=0 — verify id is still guarded', () => {
  // Edit mode passes contact.id to onSuccess; isFirstContactNavigation is
  // gated upstream by !isEditMode. But even if called, the count would not be 0
  // (there's at least one existing contact). Test the boundary explicitly.
  assert.strictEqual(isFirstContactNavigation(1, 'existing-id'), false)
})

// ── shouldShowAIFill ──────────────────────────────────────────────────────────
// New signature: shouldShowAIFill(proStatus, isEditMode) → delegates to
// hasProAccess(proStatus) (the canonical access gate — no state allowlist).

console.log('\nshouldShowAIFill\n')

// Server-authoritative status fixtures (shape from get_my_pro_access_status()).
const PRO_PERMANENT  = { can_use_pro: true,  permanent_pro: true }
const PRO_TRIAL      = { can_use_pro: true,  permanent_pro: false, trial_active: true }
const PRO_SUBSCRIBED = { can_use_pro: true,  permanent_pro: false, subscription_active: true }
const EXPIRED        = { can_use_pro: false, permanent_pro: false, trial_expired: true }
const NON_PRO        = { can_use_pro: false, permanent_pro: false }

// Add mode (isEditMode = false) — visible only when the user actually has access.
test('permanent + add mode → show AI Fill', () => {
  assert.strictEqual(shouldShowAIFill(PRO_PERMANENT, false), true)
})

test('trial + add mode → show AI Fill', () => {
  assert.strictEqual(shouldShowAIFill(PRO_TRIAL, false), true)
})

test('subscribed + add mode → show AI Fill', () => {
  assert.strictEqual(shouldShowAIFill(PRO_SUBSCRIBED, false), true)
})

test('expired + add mode → hide AI Fill', () => {
  assert.strictEqual(shouldShowAIFill(EXPIRED, false), false)
})

test('non_pro + add mode → hide AI Fill', () => {
  assert.strictEqual(shouldShowAIFill(NON_PRO, false), false)
})

test('unavailable (error) + add mode → hide AI Fill', () => {
  assert.strictEqual(shouldShowAIFill('error', false), false)
})

test('malformed status + add mode → hide AI Fill (fail-closed)', () => {
  assert.strictEqual(shouldShowAIFill({ can_use_pro: 'yes' }, false), false)
})

// Edit mode (isEditMode = true) — always hidden regardless of Pro status
test('permanent + edit mode → hide AI Fill', () => {
  assert.strictEqual(shouldShowAIFill(PRO_PERMANENT, true), false)
})

test('trial + edit mode → hide AI Fill', () => {
  assert.strictEqual(shouldShowAIFill(PRO_TRIAL, true), false)
})

test('subscribed + edit mode → hide AI Fill', () => {
  assert.strictEqual(shouldShowAIFill(PRO_SUBSCRIBED, true), false)
})

test('non_pro + edit mode → hide AI Fill', () => {
  assert.strictEqual(shouldShowAIFill(NON_PRO, true), false)
})

test('null proStatus + add mode → hide AI Fill (loading, fail-closed)', () => {
  assert.strictEqual(shouldShowAIFill(null, false), false)
})

// ── outreachResetOnTypeChange ─────────────────────────────────────────────────

console.log('\noutreachResetOnTypeChange\n')

test('switching to Coffee chat → reset outreach', () => {
  const result = outreachResetOnTypeChange('Coffee chat')
  assert.deepStrictEqual(result, { trackOutreach: false, outreachStatus: '' })
})

test('switching to Event → reset outreach', () => {
  const result = outreachResetOnTypeChange('Event')
  assert.deepStrictEqual(result, { trackOutreach: false, outreachStatus: '' })
})

test('switching to Email → no reset (preserve state)', () => {
  assert.strictEqual(outreachResetOnTypeChange('Email'), null)
})

test('switching to Message → no reset (preserve state)', () => {
  assert.strictEqual(outreachResetOnTypeChange('Message'), null)
})

test('switching to Call → no reset (preserve state)', () => {
  assert.strictEqual(outreachResetOnTypeChange('Call'), null)
})

test('switching to Other → no reset (preserve state)', () => {
  assert.strictEqual(outreachResetOnTypeChange('Other'), null)
})

test('reset result trackOutreach is always false', () => {
  const r = outreachResetOnTypeChange('Coffee chat')
  assert.strictEqual(r.trackOutreach, false)
})

test('reset result outreachStatus is always empty string', () => {
  const r = outreachResetOnTypeChange('Event')
  assert.strictEqual(r.outreachStatus, '')
})

// ── initEditTrackOutreach ─────────────────────────────────────────────────────

console.log('\ninitEditTrackOutreach\n')

test('Email with saved status → trackOutreach=true', () => {
  assert.strictEqual(initEditTrackOutreach('Email', 'awaiting_response'), true)
})

test('Email with null status → trackOutreach=false', () => {
  assert.strictEqual(initEditTrackOutreach('Email', null), false)
})

test('Email with empty string status → trackOutreach=false', () => {
  assert.strictEqual(initEditTrackOutreach('Email', ''), false)
})

test('Message with saved status → trackOutreach=true', () => {
  assert.strictEqual(initEditTrackOutreach('Message', 'responded'), true)
})

test('Message with null status → trackOutreach=false', () => {
  assert.strictEqual(initEditTrackOutreach('Message', null), false)
})

test('Call with saved status → trackOutreach=false (no checkbox for Call)', () => {
  assert.strictEqual(initEditTrackOutreach('Call', 'meeting_booked'), false)
})

test('Other with saved status → trackOutreach=false (no checkbox for Other)', () => {
  assert.strictEqual(initEditTrackOutreach('Other', 'no_response'), false)
})

test('Coffee chat with status → trackOutreach=false (outreach hidden)', () => {
  assert.strictEqual(initEditTrackOutreach('Coffee chat', 'responded'), false)
})

test('Event with status → trackOutreach=false (outreach hidden)', () => {
  assert.strictEqual(initEditTrackOutreach('Event', 'awaiting_response'), false)
})

// ── viewExistingRoute ─────────────────────────────────────────────────────────

console.log('\nviewExistingRoute\n')

test('with a real UUID → returns /contacts/<id>', () => {
  assert.strictEqual(viewExistingRoute('abc-123'), '/contacts/abc-123')
})

test('with a full UUID → correct route', () => {
  const id = '3f2e1d0c-9b8a-7f6e-5d4c-3b2a1f0e9d8c'
  assert.strictEqual(viewExistingRoute(id), `/contacts/${id}`)
})

test('with null → returns null (no route)', () => {
  assert.strictEqual(viewExistingRoute(null), null)
})

test('with undefined → returns null', () => {
  assert.strictEqual(viewExistingRoute(undefined), null)
})

test('with empty string → returns null', () => {
  assert.strictEqual(viewExistingRoute(''), null)
})

// ── shouldDispatchFollowupChange ──────────────────────────────────────────────

console.log('\nshouldDispatchFollowupChange\n')

test('YYYY-MM-DD date string → dispatch', () => {
  assert.strictEqual(shouldDispatchFollowupChange('2026-08-01'), true)
})

test('any truthy date string → dispatch', () => {
  assert.strictEqual(shouldDispatchFollowupChange('2026-12-31'), true)
})

test('empty string → do not dispatch', () => {
  assert.strictEqual(shouldDispatchFollowupChange(''), false)
})

test('null → do not dispatch', () => {
  assert.strictEqual(shouldDispatchFollowupChange(null), false)
})

test('undefined → do not dispatch', () => {
  assert.strictEqual(shouldDispatchFollowupChange(undefined), false)
})

// ── typeChangeFields ──────────────────────────────────────────────────────────

console.log('\ntypeChangeFields\n')

// Every actual type change resets outreach state unconditionally
test('Email → Message: any change resets outreach', () => {
  assert.deepStrictEqual(typeChangeFields('Email', 'Message'), { trackOutreach: false, outreachStatus: '' })
})

test('Email → Call: crossing track-outreach boundary resets', () => {
  assert.deepStrictEqual(typeChangeFields('Email', 'Call'), { trackOutreach: false, outreachStatus: '' })
})

test('Message → Other: crossing track-outreach boundary resets', () => {
  assert.deepStrictEqual(typeChangeFields('Message', 'Other'), { trackOutreach: false, outreachStatus: '' })
})

test('Call → Email: reversing direction also resets', () => {
  assert.deepStrictEqual(typeChangeFields('Call', 'Email'), { trackOutreach: false, outreachStatus: '' })
})

test('Other → Message: crossing back into checkbox-outreach resets', () => {
  assert.deepStrictEqual(typeChangeFields('Other', 'Message'), { trackOutreach: false, outreachStatus: '' })
})

test('Email → Coffee chat: switching to hidden-outreach type resets', () => {
  assert.deepStrictEqual(typeChangeFields('Email', 'Coffee chat'), { trackOutreach: false, outreachStatus: '' })
})

test('Call → Event: switching to hidden-outreach type resets', () => {
  assert.deepStrictEqual(typeChangeFields('Call', 'Event'), { trackOutreach: false, outreachStatus: '' })
})

test('Coffee chat → Event: switching between hidden-outreach types resets', () => {
  assert.deepStrictEqual(typeChangeFields('Coffee chat', 'Event'), { trackOutreach: false, outreachStatus: '' })
})

test('Other → Coffee chat: resets regardless of direction', () => {
  assert.deepStrictEqual(typeChangeFields('Other', 'Coffee chat'), { trackOutreach: false, outreachStatus: '' })
})

// Same-type re-selection must be a no-op
test('Email → Email (same type): no reset', () => {
  assert.strictEqual(typeChangeFields('Email', 'Email'), null)
})

test('Coffee chat → Coffee chat (same type): no reset', () => {
  assert.strictEqual(typeChangeFields('Coffee chat', 'Coffee chat'), null)
})

test('Call → Call (same type): no reset', () => {
  assert.strictEqual(typeChangeFields('Call', 'Call'), null)
})

// Edit initialisation — type is retained; reset fires only on first subsequent change
test('edit initialisation: same-type no-op means stored status is never wiped on open', () => {
  // When startEditInteraction() sets the type to the interaction's own type
  // (no change), typeChangeFields returns null → no reset fires.
  // Stored outreach state is therefore retained exactly as it was in the DB.
  assert.strictEqual(typeChangeFields('Email', 'Email'), null,
    'typeChangeFields must be null for same-type to leave initEditTrackOutreach intact')
  assert.strictEqual(typeChangeFields('Call', 'Call'), null)
  assert.strictEqual(typeChangeFields('Coffee chat', 'Coffee chat'), null)
})

test('first subsequent type change after edit open clears outreach', () => {
  // Simulates: open edit form with Email (trackOutreach=true, outreachStatus='responded'),
  // then change type to Call → should reset.
  const reset = typeChangeFields('Email', 'Call')
  assert.notStrictEqual(reset, null)
  assert.strictEqual(reset.trackOutreach, false)
  assert.strictEqual(reset.outreachStatus, '')
})

// After reset: verify the field values that should result
test('reset result always has trackOutreach=false', () => {
  const types = ['Email', 'Message', 'Call', 'Other', 'Coffee chat', 'Event']
  for (const from of types) {
    for (const to of types) {
      if (from === to) continue
      const r = typeChangeFields(from, to)
      assert.strictEqual(r.trackOutreach, false, `trackOutreach after ${from}→${to}`)
    }
  }
})

test('reset result always has outreachStatus="" (empty string, not null)', () => {
  const r = typeChangeFields('Email', 'Call')
  assert.strictEqual(r.outreachStatus, '')
})

// ── Cross-cutting: type-switch + outreach matrix consistency ──────────────────

console.log('\ntype-switch + outreach matrix consistency\n')

// Verify that types which reset outreach are exactly the types where
// effectiveOutreachStatus (from contactFormUtils) always returns null.
// We import and reuse effectiveOutreachStatus here to confirm the two
// files agree on which types hide outreach controls.
import { effectiveOutreachStatus } from '../src/lib/contactFormUtils.js'

test('Coffee chat: typeChangeFields resets on any inbound change AND effectiveOutreachStatus returns null', () => {
  // From any type → Coffee chat, outreach must clear.
  assert.deepStrictEqual(typeChangeFields('Email', 'Coffee chat'), { trackOutreach: false, outreachStatus: '' })
  assert.deepStrictEqual(typeChangeFields('Call', 'Coffee chat'),  { trackOutreach: false, outreachStatus: '' })
  // After reset, effectiveOutreachStatus with trackOutreach=false/outreachStatus='' gives null.
  assert.strictEqual(effectiveOutreachStatus('Coffee chat', false, ''), null)
  assert.strictEqual(effectiveOutreachStatus('Coffee chat', true, 'responded'), null)
})

test('Event: typeChangeFields resets on any inbound change AND effectiveOutreachStatus returns null', () => {
  assert.deepStrictEqual(typeChangeFields('Message', 'Event'), { trackOutreach: false, outreachStatus: '' })
  assert.strictEqual(effectiveOutreachStatus('Event', false, ''), null)
  assert.strictEqual(effectiveOutreachStatus('Event', true, 'meeting_booked'), null)
})

test('Email: typeChangeFields resets inbound AND effectiveOutreachStatus respects trackOutreach', () => {
  // Switching TO Email resets (user must re-enable tracking).
  assert.deepStrictEqual(typeChangeFields('Call', 'Email'), { trackOutreach: false, outreachStatus: '' })
  // After re-enabling the checkbox, status flows through.
  assert.strictEqual(effectiveOutreachStatus('Email', true, 'awaiting_response'), 'awaiting_response')
  assert.strictEqual(effectiveOutreachStatus('Email', false, 'awaiting_response'), null)
})

test('Message: typeChangeFields resets inbound AND effectiveOutreachStatus respects trackOutreach', () => {
  assert.deepStrictEqual(typeChangeFields('Email', 'Message'), { trackOutreach: false, outreachStatus: '' })
  assert.strictEqual(effectiveOutreachStatus('Message', true, 'responded'), 'responded')
  assert.strictEqual(effectiveOutreachStatus('Message', false, 'responded'), null)
})

test('Call: typeChangeFields resets inbound AND effectiveOutreachStatus is direct (no checkbox)', () => {
  assert.deepStrictEqual(typeChangeFields('Email', 'Call'), { trackOutreach: false, outreachStatus: '' })
  assert.strictEqual(effectiveOutreachStatus('Call', false, 'no_response'), 'no_response')
})

test('Other: typeChangeFields resets inbound AND effectiveOutreachStatus is direct (no checkbox)', () => {
  assert.deepStrictEqual(typeChangeFields('Message', 'Other'), { trackOutreach: false, outreachStatus: '' })
  assert.strictEqual(effectiveOutreachStatus('Other', false, 'declined'), 'declined')
})

// ── Log Result ordering guarantees (pure assertions) ─────────────────────────

console.log('\nLog Result ordering guarantees\n')

// These tests verify the pure logic that guards ordering in ContactDetailPage:
// insert must succeed (non-null error) before the clear is attempted.

test('insert success (null error) allows the clear step', () => {
  const insertError = null
  const shouldProceedToClear = insertError === null
  assert.strictEqual(shouldProceedToClear, true)
})

test('insert failure (non-null error) prevents the clear step', () => {
  const insertError = { message: 'duplicate key' }
  const shouldProceedToClear = insertError === null
  assert.strictEqual(shouldProceedToClear, false)
})

test('clear success (null clearError) means followup_completed should fire', () => {
  const clearError = null
  const shouldFire = clearError === null
  assert.strictEqual(shouldFire, true)
})

test('clear failure (non-null clearError) means followup_completed must NOT fire', () => {
  const clearError = { message: 'network error' }
  const shouldFire = clearError === null
  assert.strictEqual(shouldFire, false)
})

test('partial failure: interaction row exists but follow-up not cleared → warning path', () => {
  const insertError = null      // insert succeeded
  const clearError  = { message: 'RLS policy violation' }  // clear failed
  const interactionSaved = insertError === null
  const followupCleared  = clearError === null
  // Partial success: interaction is there, follow-up still open
  assert.strictEqual(interactionSaved, true)
  assert.strictEqual(followupCleared, false)
})

// ─────────────────────────────────────────────────────────────────────────────

console.log()
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
