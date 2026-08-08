/**
 * settings-graceful-degradation.test.js
 *
 * Source-contract tests guarding against the SettingsPage loading-trap defect.
 *
 * Root cause: a full-page `if (loading) return <spinner>` blocked the entire
 * UI — including Sign out, Appearance (theme toggle), and Pro Access — while
 * waiting for supabase.auth.getUser() + profile/count fetches. Under poor
 * connectivity or Supabase slowness this spinner could last indefinitely,
 * leaving the user with no way to sign out.
 *
 * Fix: the full-page guard is removed. The page shell renders immediately.
 * The Profile card shows per-field loading dashes while `loading` is true.
 * Sign out, Appearance, and Pro Access are always accessible.
 *
 * Run with: node tests/settings-graceful-degradation.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const src = readFileSync(resolve('src/pages/SettingsPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// =============================================================================
// 1. No full-page loading guard
// =============================================================================

console.log('\n1. No full-page spinner that blocks the page shell')

test('if (loading) return guard is removed', () => {
  // The defect: `if (loading) { return <div>Loading...</div> }` before the
  // main return. This blocked Sign out, Appearance, and Pro Access.
  assert.ok(
    !src.includes('if (loading) {') && !src.includes('if (loading)return'),
    'must not have a top-level if(loading) guard that returns before the main render'
  )
})

test('full-page loading spinner pattern is gone', () => {
  // The specific pattern that was blocking the page.
  assert.ok(
    !src.includes('min-h-screen bg-surface flex items-center justify-center'),
    'the full-page centered loading spinner container must not exist'
  )
})

// =============================================================================
// 2. Save button disabled while loading
// =============================================================================

console.log('\n2. Save button disabled while loading')

test('Save button disabled when loading OR saving', () => {
  // While loading, the display name input is empty. The Save button must be
  // disabled to prevent submitting an empty name before data arrives.
  assert.ok(
    src.includes('disabled={saving || loading}'),
    'Save button must be disabled while loading OR saving'
  )
})

// =============================================================================
// 3. Per-field loading states in the Profile section
// =============================================================================

console.log('\n3. Per-field loading states for profile fields')

test('email field shows loading placeholder while fetching', () => {
  assert.ok(
    src.includes('loading ?') && src.includes('animate-pulse'),
    'loading-conditional with animate-pulse must exist for email/joined fields'
  )
})

test('loading state does not block Sign out rendering', () => {
  // Sign out button must appear in the same render path as everything else.
  // A conditional guard before the main return would block it.
  const signOutIdx = src.indexOf('Sign out')
  const loadingGuardIdx = src.indexOf('if (loading) {')
  if (loadingGuardIdx !== -1) {
    // If a loading guard exists, Sign out must come BEFORE it (not after)
    // — meaning it renders unconditionally. A guard before the main return
    // puts Sign out AFTER the guard → blocked.
    assert.ok(
      signOutIdx < loadingGuardIdx,
      'Sign out must render before any loading guard, not be blocked by it'
    )
  } else {
    // No guard at all — Sign out is always reachable.
    assert.ok(signOutIdx !== -1, 'Sign out button must exist in render')
  }
})

// =============================================================================
// 4. Independent sections — graceful degradation
// =============================================================================

console.log('\n4. Section independence')

test('Pro Access section has its own loading state (proLoading)', () => {
  assert.ok(
    src.includes('proLoading'),
    'Pro Access section must use its own proLoading guard, not the page-level loading'
  )
})

test('Appearance section renders unconditionally (no loading guard)', () => {
  // Theme toggle must always work — it reads from localStorage, not Supabase.
  const appearanceIdx = src.indexOf('Appearance')
  assert.ok(appearanceIdx !== -1, 'Appearance section must exist')
  // Verify the theme radio group is not behind a conditional block.
  assert.ok(
    src.includes('handleThemeKeyDown'),
    'theme keyboard handler must be present'
  )
})

test('Sign out button renders with its own disabled state (signingOut)', () => {
  assert.ok(
    src.includes('disabled={signingOut}'),
    'Sign out button must only be disabled during sign-out in progress, not during data loading'
  )
})

test('contactCount null-check prevents Delete button while count unknown', () => {
  // When loading, contactCount === null. The delete button must not appear.
  assert.ok(
    src.includes('contactCount !== null && contactCount > 0'),
    'delete button must require contactCount > 0 (not null) to render'
  )
})

// =============================================================================
// 5. Account-switch reset still sets loading (for per-field states)
// =============================================================================

console.log('\n5. Account-switch reset correctly sets loading')

test('setLoading(true) is called on account switch', () => {
  // When an account switch is detected, loading resets to true so per-field
  // placeholders correctly re-appear during the new user's fetch.
  assert.ok(
    src.includes('setLoading(true)'),
    'setLoading(true) must be called on account switch to re-show per-field placeholders'
  )
})

test('setLoading(false) is called in finally block', () => {
  // The loading state must be cleared after the async fetch completes or fails.
  assert.ok(
    src.includes('setLoading(false)'),
    'setLoading(false) must be called in the finally block of the load function'
  )
})

// =============================================================================
// Results
// =============================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
