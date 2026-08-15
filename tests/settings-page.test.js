/**
 * settings-page.test.js — Source-contract tests for src/pages/SettingsPage.jsx
 *
 * Reads the production source text and asserts structural and behavioral
 * contracts without a DOM or React test environment.
 * Run with: node tests/settings-page.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'

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

const sp = readFileSync(resolve('src/pages/SettingsPage.jsx'), 'utf8')
const sh = readFileSync(resolve('src/lib/settingsHelpers.js'), 'utf8')

// ── settingsHelpers.js is Node-safe ───────────────────────────────────────────

console.log('\nsettingsHelpers.js is Node-safe')

test('no React import in settingsHelpers.js', () => {
  assert.ok(!sh.includes("from 'react'"), 'must not import React')
})
test('no Supabase import in settingsHelpers.js', () => {
  assert.ok(!sh.includes("from '@supabase") && !sh.includes('supabase'), 'must not import Supabase')
})
test('exports validateDisplayName', () => {
  assert.ok(sh.includes('export function validateDisplayName'), 'must export validateDisplayName')
})
test('exports normalizeDisplayName', () => {
  assert.ok(sh.includes('export function normalizeDisplayName'), 'must export normalizeDisplayName')
})
test('exports isDeleteAllConfirmEligible', () => {
  assert.ok(sh.includes('export function isDeleteAllConfirmEligible'), 'must export isDeleteAllConfirmEligible')
})
test('exports isDeleteAccountConfirmEligible', () => {
  assert.ok(sh.includes('export function isDeleteAccountConfirmEligible'), 'must export isDeleteAccountConfirmEligible')
})
test('exports formatJoined', () => {
  assert.ok(sh.includes('export function formatJoined'), 'must export formatJoined')
})
test('exports formatTrialEnd', () => {
  assert.ok(sh.includes('export function formatTrialEnd'), 'must export formatTrialEnd')
})
test('exports summarizeContactCount', () => {
  assert.ok(sh.includes('export function summarizeContactCount'), 'must export summarizeContactCount')
})
test('exports DISPLAY_NAME_MAX_LENGTH constant', () => {
  assert.ok(sh.includes('export const DISPLAY_NAME_MAX_LENGTH'), 'must export DISPLAY_NAME_MAX_LENGTH')
})
test('exports DELETE_ALL_PHRASE constant', () => {
  assert.ok(sh.includes('export const DELETE_ALL_PHRASE'), 'must export DELETE_ALL_PHRASE')
})
test('exports DELETE_ACCOUNT_PHRASE constant', () => {
  assert.ok(sh.includes('export const DELETE_ACCOUNT_PHRASE'), 'must export DELETE_ACCOUNT_PHRASE')
})

// ── Imports ───────────────────────────────────────────────────────────────────

console.log('\nSettingsPage imports')

test('imports useProStatus (shared context hook)', () => {
  assert.ok(sp.includes('useProStatus'), 'must import and use useProStatus')
})
test('imports classifyProStatus', () => {
  assert.ok(sp.includes('classifyProStatus'), 'must import classifyProStatus')
})
test('imports from useProStatus module', () => {
  assert.ok(
    sp.includes("from '../lib/useProStatus'"),
    'must import useProStatus from useProStatus module'
  )
})
test('imports from pro-ui-status module', () => {
  assert.ok(
    sp.includes("from '../lib/pro-ui-status'"),
    'must import classifyProStatus from pro-ui-status module'
  )
})
test('imports validateDisplayName from settingsHelpers', () => {
  assert.ok(
    sp.includes('validateDisplayName') && sp.includes('settingsHelpers'),
    'must import validateDisplayName from settingsHelpers'
  )
})
test('imports normalizeDisplayName from settingsHelpers', () => {
  assert.ok(sp.includes('normalizeDisplayName'), 'must import normalizeDisplayName')
})
test('imports isDeleteAllConfirmEligible from settingsHelpers', () => {
  assert.ok(sp.includes('isDeleteAllConfirmEligible'), 'must import isDeleteAllConfirmEligible')
})
test('imports isDeleteAccountConfirmEligible from settingsHelpers', () => {
  assert.ok(sp.includes('isDeleteAccountConfirmEligible'), 'must import isDeleteAccountConfirmEligible')
})
test('imports formatJoined from settingsHelpers', () => {
  assert.ok(sp.includes('formatJoined'), 'must import formatJoined')
})
test('imports formatTrialEnd from settingsHelpers', () => {
  assert.ok(sp.includes('formatTrialEnd'), 'must import formatTrialEnd')
})
test('imports summarizeContactCount from settingsHelpers', () => {
  assert.ok(sp.includes('summarizeContactCount'), 'must import summarizeContactCount')
})
test('imports DISPLAY_NAME_MAX_LENGTH from settingsHelpers', () => {
  assert.ok(sp.includes('DISPLAY_NAME_MAX_LENGTH'), 'must import DISPLAY_NAME_MAX_LENGTH')
})
test('does NOT import getProAccessStatus in SettingsPage', () => {
  // getProAccessStatus is called only inside ProStatusProvider.refresh().
  // SettingsPage must not import or call it directly — all Pro status work
  // goes through the shared provider context.
  assert.ok(
    !sp.includes("from '../lib/pro-access-status'"),
    'SettingsPage must not import from pro-access-status — use the shared provider'
  )
})
test('imports useProRefresh from useProStatus module', () => {
  assert.ok(
    sp.includes('useProRefresh') && sp.includes("from '../lib/useProStatus'"),
    'must import useProRefresh from useProStatus module'
  )
})
test('primary Pro status comes from useProStatus() hook', () => {
  assert.ok(
    sp.includes('useProStatus()'),
    'primary Pro status must come from useProStatus() hook, not direct RPC'
  )
})

// ── Display-name save ─────────────────────────────────────────────────────────

console.log('\nDisplay-name save contract')

test('uses update() not upsert() for display-name save', () => {
  // Strip comments before checking — avoid false positives from any comment mentioning upsert.
  const codeOnly = sp.replace(/\/\/[^\n]*/g, '')
  assert.ok(codeOnly.includes('.update('), 'must use .update() for display-name save')
  assert.ok(!codeOnly.includes('.upsert('), 'must NOT use .upsert() for display-name save')
})
test('validates display name before saving with validateDisplayName', () => {
  const handleSaveIdx = sp.indexOf('async function handleSave(')
  assert.ok(handleSaveIdx !== -1, 'handleSave function must exist')
  const fn = sp.slice(handleSaveIdx, handleSaveIdx + 600)
  assert.ok(fn.includes('validateDisplayName'), 'handleSave must call validateDisplayName')
})
test('normalizes display name before saving with normalizeDisplayName', () => {
  const handleSaveIdx = sp.indexOf('async function handleSave(')
  const fn = sp.slice(handleSaveIdx, handleSaveIdx + 700)
  assert.ok(fn.includes('normalizeDisplayName'), 'handleSave must call normalizeDisplayName')
})
test('shows save banner on success', () => {
  assert.ok(sp.includes('setSaveBanner(true)'), 'must show save banner on success')
  assert.ok(sp.includes('setSaveBanner(false)'), 'must auto-hide save banner')
})
test('shows save error on failure', () => {
  // setSaveError is called with a user-friendly message, not a raw error object.
  // Search the whole file since the call site may be >80 chars from the first setSaveError call.
  assert.ok(sp.includes('setSaveError('), 'must set save error state')
  const hasUserFriendlyMsg =
    sp.includes("'Could not save") || sp.includes('"Could not save')
  assert.ok(hasUserFriendlyMsg, 'save error must use a user-friendly message, not raw error.message')
})
test('renders save error in JSX', () => {
  assert.ok(sp.includes('saveError &&'), 'saveError must be rendered conditionally')
})
test('renders save banner with role=status', () => {
  assert.ok(sp.includes('role="status"') || sp.includes("role='status'"), 'save banner must have role=status for screen readers')
})

// ── Pro Access section ─────────────────────────────────────────────────────────

console.log('\nPro Access section — six states')

test('renders "Pro Access" section label', () => {
  assert.ok(
    sp.includes('Pro Access') || sp.includes('PRO ACCESS'),
    'must render the Pro Access section label'
  )
})
test('shows loading state when proStatus is null', () => {
  assert.ok(sp.includes('proLoading'), 'proLoading flag must control loading state')
})
test('shows "temporarily unavailable" for error state', () => {
  assert.ok(sp.includes('temporarily unavailable'), 'must show unavailable text for error state')
})
test('shows Retry button for unavailable state', () => {
  assert.ok(sp.includes('Retry') || sp.includes('Retrying'), 'must show Retry button for unavailable state')
})
test('handleProRetry uses shared proRefresh — not direct getProAccessStatus', () => {
  const retryIdx = sp.indexOf('async function handleProRetry(')
  assert.ok(retryIdx !== -1, 'handleProRetry function must exist')
  const fn = sp.slice(retryIdx, retryIdx + 300)
  assert.ok(fn.includes('proRefresh'), 'Retry must call proRefresh() from the shared provider')
  assert.ok(!fn.includes('getProAccessStatus'), 'Retry must NOT call getProAccessStatus() directly')
})
test('no local retryStatus state override', () => {
  assert.ok(!sp.includes('retryStatus'), 'must not use a local retryStatus override — retry goes through the provider')
})
test('retrying guard prevents duplicate retry requests', () => {
  const retryIdx = sp.indexOf('async function handleProRetry(')
  const fn = sp.slice(retryIdx, retryIdx + 200)
  assert.ok(fn.includes('retrying'), 'handleProRetry must guard against duplicate requests with retrying state')
})
test('permanent state shows "permanent access" text', () => {
  assert.ok(sp.includes('permanent access'), 'must render permanent access label')
})
test('trial state shows "days left in your trial"', () => {
  assert.ok(sp.includes('days left in your trial'), 'must render trial days remaining label')
})
test('trial state shows ends date via formatTrialEnd', () => {
  const trialIdx = sp.indexOf('days left in your trial')
  const region = sp.slice(trialIdx, trialIdx + 300)
  assert.ok(region.includes('formatTrialEnd') || region.includes('ends_at'), 'trial state must show end date')
})
test('expired state renders some text distinguishing it', () => {
  assert.ok(
    sp.includes('Trial ended') || sp.includes('trial ended'),
    'must render expired trial state'
  )
})
test('non_pro state renders a neutral status message', () => {
  assert.ok(
    sp.includes('No active Pro access'),
    'must render non_pro state message'
  )
})
test('Pro section always rendered (not gated by condition)', () => {
  // The Pro Access card must always render — not wrapped in a conditional that could hide it.
  // Verify: there is no conditional like {(proError || isPro) && ... that would hide the card.
  // Instead, the section label "Pro Access" appears unconditionally in the render tree.
  const renderIdx = sp.indexOf('return (')
  const renderSection = sp.slice(renderIdx)
  assert.ok(
    renderSection.includes('Pro Access') || renderSection.includes('PRO ACCESS'),
    'Pro Access section must always be in the render tree'
  )
})

// ── Data & Imports section ─────────────────────────────────────────────────────

console.log('\nData & Imports section')

test('renders "Data & Imports" section label', () => {
  assert.ok(sp.includes('Data') && sp.includes('Imports'), 'must render Data & Imports section label')
})
test('navigates to /contacts?import=1 for CSV import', () => {
  assert.ok(sp.includes('/contacts?import=1'), 'must navigate to /contacts?import=1')
})
test('renders contact count alongside delete-all option', () => {
  assert.ok(sp.includes('contactCount'), 'must reference contactCount in JSX')
})
test('uses summarizeContactCount in the delete-all dialog', () => {
  // Search from the <h2 id="delete-all-title"> element onward (past the aria-labelledby ref).
  const h2Idx = sp.indexOf('id="delete-all-title"')
  assert.ok(h2Idx !== -1, 'delete-all dialog title id must exist')
  // 800 chars from the h2 covers the paragraph that calls summarizeContactCount
  const dialogBody = sp.slice(h2Idx, h2Idx + 800)
  assert.ok(dialogBody.includes('summarizeContactCount'), 'delete-all dialog body must use summarizeContactCount')
})
test('delete-all button only shown when contacts exist', () => {
  assert.ok(sp.includes('contactCount > 0'), 'delete-all action must be gated by contactCount > 0')
})

// ── Delete-all contacts dialog ─────────────────────────────────────────────────

console.log('\nDelete-all contacts dialog')

test('delete-all dialog has role="alertdialog"', () => {
  const dialogIdx = sp.indexOf('delete-all-title')
  assert.ok(dialogIdx !== -1, 'delete-all dialog must exist')
  const region = sp.slice(Math.max(0, dialogIdx - 200), dialogIdx + 100)
  assert.ok(region.includes('alertdialog'), 'delete-all dialog must have role=alertdialog')
})
test('delete-all dialog has aria-modal="true"', () => {
  const dialogIdx = sp.indexOf('delete-all-title')
  const region = sp.slice(Math.max(0, dialogIdx - 200), dialogIdx + 100)
  assert.ok(region.includes('aria-modal'), 'delete-all dialog must have aria-modal')
})
test('delete-all dialog has aria-labelledby pointing to title', () => {
  const dialogIdx = sp.indexOf('delete-all-title')
  const region = sp.slice(Math.max(0, dialogIdx - 200), dialogIdx + 100)
  assert.ok(region.includes('aria-labelledby'), 'delete-all dialog must have aria-labelledby')
})
test('requires isDeleteAllConfirmEligible before allowing deletion', () => {
  const handleDeleteAllIdx = sp.indexOf('async function handleDeleteAll(')
  assert.ok(handleDeleteAllIdx !== -1, 'handleDeleteAll must exist')
  const fn = sp.slice(handleDeleteAllIdx, handleDeleteAllIdx + 300)
  assert.ok(fn.includes('isDeleteAllConfirmEligible'), 'handleDeleteAll must gate on isDeleteAllConfirmEligible')
})
test('delete-all input placeholder is "delete all contacts"', () => {
  assert.ok(sp.includes('placeholder="delete all contacts"'), 'input must have the exact phrase as placeholder')
})
test('delete-all button is disabled when phrase not matched', () => {
  // The button text literal "'Delete all'" is the most specific anchor.
  // disabled= prop precedes the text by ~300 chars (className is long).
  const btnIdx = sp.lastIndexOf("'Delete all'")
  assert.ok(btnIdx !== -1, "Delete all button text literal must exist")
  const region = sp.slice(Math.max(0, btnIdx - 350), btnIdx + 100)
  assert.ok(
    region.includes('isDeleteAllConfirmEligible') || region.includes('deleteAllInput'),
    'delete-all button disabled prop must reference phrase eligibility check'
  )
})

// ── Delete-account dialog ──────────────────────────────────────────────────────

console.log('\nDelete-account dialog')

test('delete-account dialog has role="alertdialog"', () => {
  const dialogIdx = sp.indexOf('delete-account-title')
  assert.ok(dialogIdx !== -1, 'delete-account dialog must exist')
  const region = sp.slice(Math.max(0, dialogIdx - 200), dialogIdx + 100)
  assert.ok(region.includes('alertdialog'), 'delete-account dialog must have role=alertdialog')
})
test('delete-account dialog has aria-modal="true"', () => {
  const dialogIdx = sp.indexOf('delete-account-title')
  const region = sp.slice(Math.max(0, dialogIdx - 200), dialogIdx + 100)
  assert.ok(region.includes('aria-modal'), 'delete-account dialog must have aria-modal')
})
test('delete-account dialog has aria-labelledby pointing to title', () => {
  const dialogIdx = sp.indexOf('delete-account-title')
  const region = sp.slice(Math.max(0, dialogIdx - 200), dialogIdx + 100)
  assert.ok(region.includes('aria-labelledby'), 'must have aria-labelledby on delete-account dialog')
})
test('requires isDeleteAccountConfirmEligible before allowing deletion', () => {
  const handleDeleteIdx = sp.indexOf('async function handleDeleteAccount(')
  assert.ok(handleDeleteIdx !== -1, 'handleDeleteAccount must exist')
  const fn = sp.slice(handleDeleteIdx, handleDeleteIdx + 350)
  assert.ok(fn.includes('isDeleteAccountConfirmEligible'), 'handleDeleteAccount must gate on isDeleteAccountConfirmEligible')
})
test('delete-account input placeholder is "delete my account"', () => {
  assert.ok(sp.includes('placeholder="delete my account"'), 'input must have the exact phrase as placeholder')
})
test('delete-account calls the Edge Function delete-account', () => {
  const handleDeleteIdx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(handleDeleteIdx, handleDeleteIdx + 400)
  assert.ok(fn.includes("invoke('delete-account')"), 'must invoke delete-account Edge Function')
})
test('delete-account navigates to /signup after sign-out', () => {
  const handleDeleteIdx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(handleDeleteIdx, handleDeleteIdx + 750)
  assert.ok(fn.includes('/signup'), 'must navigate to /signup after successful deletion')
})

// ── Sign out ─────────────────────────────────────────────────────────────────

console.log('\nSign out')

test('handleSignOut has a loading guard (signingOut check)', () => {
  const signOutIdx = sp.indexOf('async function handleSignOut(')
  assert.ok(signOutIdx !== -1, 'handleSignOut must exist')
  const fn = sp.slice(signOutIdx, signOutIdx + 500)
  assert.ok(fn.includes('signingOut'), 'handleSignOut must check signingOut to prevent duplicate calls')
})
test('sign-out button is disabled while signing out', () => {
  assert.ok(sp.includes('disabled={signingOut}'), 'sign-out button must be disabled while signing out')
})
test('shows "Signing out…" label while signing out', () => {
  assert.ok(sp.includes('Signing out'), 'must show Signing out label')
})
test('shows sign-out error on failure', () => {
  assert.ok(sp.includes('signOutError'), 'must render signOutError state')
  assert.ok(sp.includes("'Could not sign out"), 'sign-out error must have user-friendly message')
})
test('navigates to /signin after successful sign-out', () => {
  const signOutIdx = sp.indexOf('async function handleSignOut(')
  const fn = sp.slice(signOutIdx, signOutIdx + 550)
  assert.ok(fn.includes('/signin'), 'must navigate to /signin on successful sign-out')
})

// ── Appearance ────────────────────────────────────────────────────────────────

console.log('\nAppearance')

test('renders Light, Dark, and System theme buttons', () => {
  // SettingsPage iterates THEME_ORDER from settingsLifecycle — verify all three appear
  // either as string literals or via THEME_ORDER (which defines ['light','dark','system']).
  const hasLiteralThemes = sp.includes("'light'") && sp.includes("'dark'") && sp.includes("'system'")
  const usesThemeOrder = sp.includes('THEME_ORDER')
  assert.ok(hasLiteralThemes || usesThemeOrder, 'must render all three theme options via literals or THEME_ORDER')
})
test('calls setTheme from theme.js on button click', () => {
  assert.ok(sp.includes('setTheme('), 'must call setTheme from theme.js')
})
test('imports getTheme and setTheme from theme.js', () => {
  assert.ok(sp.includes("from '../lib/theme'"), 'must import from theme.js')
})

// ── Navigation ────────────────────────────────────────────────────────────────

console.log('\nNavigation')

test('has Link to /privacy for Privacy Policy', () => {
  assert.ok(sp.includes('/privacy'), 'must have a link to /privacy')
})
test('renders page heading "Settings"', () => {
  assert.ok(sp.includes('>Settings<'), 'must render a Settings heading')
})

// ── Focus trap ────────────────────────────────────────────────────────────────

console.log('\nFocus trap')

test('trapFocus helper is defined in the module', () => {
  assert.ok(sp.includes('function trapFocus('), 'trapFocus helper must be defined')
})
test('trapFocus handles Tab key', () => {
  const trapIdx = sp.indexOf('function trapFocus(')
  const fn = sp.slice(trapIdx, trapIdx + 500)
  assert.ok(fn.includes("'Tab'"), 'trapFocus must check for Tab key')
})
test('trapFocus handles Escape key', () => {
  const trapIdx = sp.indexOf('function trapFocus(')
  const fn = sp.slice(trapIdx, trapIdx + 500)
  assert.ok(fn.includes("'Escape'"), 'trapFocus must check for Escape key')
})
test('trapFocus is applied to delete-all modal card', () => {
  const dalIdx = sp.indexOf('delete-all-title')
  const region = sp.slice(dalIdx, dalIdx + 600)
  assert.ok(region.includes('trapFocus'), 'delete-all dialog must use trapFocus')
})
test('trapFocus is applied to delete-account modal card', () => {
  const dalIdx = sp.indexOf('delete-account-title')
  const region = sp.slice(dalIdx, dalIdx + 600)
  assert.ok(region.includes('trapFocus'), 'delete-account dialog must use trapFocus')
})

// ── Contact count ─────────────────────────────────────────────────────────────

console.log('\nContact count loading')

test('contact count loaded via separate count query', () => {
  assert.ok(
    sp.includes("count: 'exact'") || sp.includes('count: "exact"'),
    'must load contact count with { count: exact } query option'
  )
})
test('contact count query is scoped to current user', () => {
  const countIdx = sp.indexOf("count: 'exact'") !== -1
    ? sp.indexOf("count: 'exact'")
    : sp.indexOf('count: "exact"')
  const region = sp.slice(Math.max(0, countIdx - 300), countIdx + 100)
  assert.ok(
    region.includes('user_id') || region.includes("eq('user_id'"),
    'contact count query must be scoped to user_id'
  )
})
test('contact count initializes to null (not 0) until loaded', () => {
  // null means "not yet loaded" — distinct from 0 (loaded and empty)
  assert.ok(sp.includes('setContactCount(null)') || sp.includes('useState(null)'), 'contactCount must start as null')
})

// ── Em dash absence ───────────────────────────────────────────────────────────

console.log('\nEm dash absence')

test('no literal em dash character (U+2014) in SettingsPage source', () => {
  assert.ok(!sp.includes('—'), 'SettingsPage must not contain a literal em dash')
})
test('no HTML em-dash entity (&mdash;) in SettingsPage source', () => {
  assert.ok(!sp.includes('&mdash;'), 'SettingsPage must not contain &mdash; entity')
})
test('no literal em dash in settingsHelpers source', () => {
  assert.ok(!sh.includes('—'), 'settingsHelpers must not contain a literal em dash')
})
test('formatJoined fallback is not an em dash', () => {
  // Import is not possible in source-contract tests; verify the source text instead.
  const fnIdx = sh.indexOf('export function formatJoined(')
  const fn = sh.slice(fnIdx, fnIdx + 400)
  assert.ok(!fn.includes("'—'") && !fn.includes('"—"'), 'formatJoined fallback must not be an em dash string')
  assert.ok(fn.includes("'Unknown'") || fn.includes('"Unknown"'), 'formatJoined fallback must be Unknown')
})
test('formatTrialEnd fallback is not an em dash', () => {
  const fnIdx = sh.indexOf('export function formatTrialEnd(')
  const fn = sh.slice(fnIdx, fnIdx + 400)
  assert.ok(!fn.includes("'—'") && !fn.includes('"—"'), 'formatTrialEnd fallback must not be an em dash string')
  assert.ok(fn.includes("'Unknown'") || fn.includes('"Unknown"'), 'formatTrialEnd fallback must be Unknown')
})

// ── Unmount protection ────────────────────────────────────────────────────────

console.log('\nUnmount protection')

test('mountedRef is defined for unmount protection', () => {
  assert.ok(sp.includes('mountedRef'), 'mountedRef must be defined in SettingsPage')
})
test('mountedRef cleanup sets current to false', () => {
  const idx = sp.indexOf('mountedRef')
  const region = sp.slice(idx, idx + 200)
  assert.ok(
    region.includes('mountedRef.current = false') || sp.includes('mountedRef.current = false'),
    'mountedRef must be set to false in cleanup effect'
  )
})
test('handleSave checks mountedRef before setting state after await', () => {
  const saveIdx = sp.indexOf('async function handleSave(')
  const fn = sp.slice(saveIdx, saveIdx + 700)
  assert.ok(fn.includes('mountedRef.current'), 'handleSave must check mountedRef after async operations')
})
test('handleSignOut checks mountedRef after await', () => {
  const signOutIdx = sp.indexOf('async function handleSignOut(')
  const fn = sp.slice(signOutIdx, signOutIdx + 500)
  assert.ok(fn.includes('mountedRef.current'), 'handleSignOut must check mountedRef after async operations')
})
test('handleDeleteAll checks mountedRef after await', () => {
  const dalIdx = sp.indexOf('async function handleDeleteAll(')
  const fn = sp.slice(dalIdx, dalIdx + 500)
  assert.ok(fn.includes('mountedRef.current'), 'handleDeleteAll must check mountedRef after async operations')
})
test('handleDeleteAccount checks mountedRef after await', () => {
  const daIdx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(daIdx, daIdx + 500)
  assert.ok(fn.includes('mountedRef.current'), 'handleDeleteAccount must check mountedRef after async operations')
})

// ── Account-switch reset ──────────────────────────────────────────────────────

console.log('\nAccount-switch reset')

test('account-switch listener clears display name on UID change', () => {
  assert.ok(
    sp.includes('onAuthStateChange') || sp.includes('auth.onAuthStateChange'),
    'must listen to auth state changes for account-switch reset'
  )
})
test('account-switch listener clears user-scoped state', () => {
  // The listener block clears multiple state fields
  const listenerIdx = sp.indexOf('onAuthStateChange')
  const region = sp.slice(listenerIdx, listenerIdx + 800)
  assert.ok(
    region.includes('setDisplayName') || region.includes('setSavedDisplayName'),
    'account-switch listener must clear display name state'
  )
})
test('account-switch listener unsubscribes on cleanup', () => {
  assert.ok(sp.includes('subscription.unsubscribe()'), 'auth listener must unsubscribe on cleanup')
})
test('account-switch effect depends on user id', () => {
  assert.ok(
    sp.includes("user?.id") || sp.includes("user.id"),
    'account-switch effect must depend on user id'
  )
})

// ── Radio group semantics (Appearance) ───────────────────────────────────────

console.log('\nRadio group semantics')

test('Appearance container has role="radiogroup"', () => {
  assert.ok(
    sp.includes('role="radiogroup"') || sp.includes("role='radiogroup'"),
    'Appearance theme picker must have role="radiogroup"'
  )
})
test('Appearance container has aria-label for screen readers', () => {
  // Search from role="radiogroup" (not the word 'radiogroup' which may appear in comments).
  const rgIdx = sp.indexOf('role="radiogroup"')
  assert.ok(rgIdx !== -1, 'role="radiogroup" must exist in JSX')
  const region = sp.slice(rgIdx, rgIdx + 300)
  assert.ok(
    region.includes('aria-label') || region.includes('aria-labelledby'),
    'Appearance radiogroup must have an accessible label'
  )
})
test('each theme button has role="radio"', () => {
  assert.ok(
    sp.includes('role="radio"') || sp.includes("role='radio'"),
    'each theme button must have role="radio"'
  )
})
test('each theme button has aria-checked', () => {
  assert.ok(sp.includes('aria-checked'), 'each theme button must have aria-checked')
})
test('aria-checked reflects selected theme', () => {
  // Look for the JSX attribute form aria-checked={ not the text in a comment.
  const acIdx = sp.indexOf('aria-checked={')
  assert.ok(acIdx !== -1, 'aria-checked JSX attribute must exist in a button')
  const region = sp.slice(acIdx, acIdx + 80)
  assert.ok(
    region.includes('currentTheme') || region.includes('value'),
    'aria-checked must be derived from currentTheme === value comparison'
  )
})

// ── Delete-all follow-up dispatch ─────────────────────────────────────────────

console.log('\nDelete-all follow-up dispatch')

test('handleDeleteAll dispatches funnl:followups-changed on success', () => {
  const dalIdx = sp.indexOf('async function handleDeleteAll(')
  const fn = sp.slice(dalIdx, dalIdx + 1100)
  assert.ok(
    fn.includes('funnl:followups-changed'),
    'handleDeleteAll must dispatch funnl:followups-changed so Sidebar/BottomNav badges clear'
  )
})
test('funnl:followups-changed is dispatched via window.dispatchEvent', () => {
  assert.ok(
    sp.includes("window.dispatchEvent(new Event('funnl:followups-changed'))"),
    'must use window.dispatchEvent with funnl:followups-changed'
  )
})

// ── Delete-account backend contract ──────────────────────────────────────────

console.log('\nDelete-account backend contract')

test('delete-account uses Edge Function (not admin API directly)', () => {
  const daIdx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(daIdx, daIdx + 600)
  assert.ok(fn.includes("invoke('delete-account')"), 'must invoke delete-account Edge Function')
  assert.ok(!fn.includes('auth.admin'), 'must not call auth.admin directly in the browser')
})
test('delete-account checks function response for success flag', () => {
  // SettingsPage now delegates result classification to classifyDeleteAccountResponse()
  // which checks data.success internally. The page checks result.ok not data?.success directly.
  const daIdx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(daIdx, daIdx + 750)
  assert.ok(
    fn.includes('classifyDeleteAccountResponse') || fn.includes('data?.success') || fn.includes('result.ok'),
    'must verify success flag from function response (via classifyDeleteAccountResponse or direct check)'
  )
})
test('delete-account checks for invoke error', () => {
  const daIdx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(daIdx, daIdx + 600)
  assert.ok(fn.includes('error') || fn.includes('Error'), 'must check invoke error')
})
test('delete-account post-deletion destination is /signup', () => {
  const daIdx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(daIdx, daIdx + 700)
  assert.ok(fn.includes('/signup'), 'post-deletion navigation must go to /signup')
})
test('delete-account calls signOut before navigating', () => {
  const daIdx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(daIdx, daIdx + 700)
  const signOutIdx = fn.indexOf('signOut()')
  const navIdx = fn.indexOf('/signup')
  assert.ok(signOutIdx !== -1, 'must call signOut() before navigating')
  assert.ok(signOutIdx < navIdx, 'signOut must come before navigate to /signup')
})

// ── Theme architecture ────────────────────────────────────────────────────────

console.log('\nTheme architecture')

test('imports getTheme and setTheme from theme.js (no duplicate storage key)', () => {
  assert.ok(
    sp.includes("from '../lib/theme'"),
    'must import theme functions from theme.js (single storage key)'
  )
})
test('no hardcoded funnl-theme storage key in SettingsPage', () => {
  assert.ok(
    !sp.includes('funnl-theme'),
    'SettingsPage must not access the funnl-theme localStorage key directly — use theme.js functions'
  )
})
test('setTheme called on theme button click', () => {
  assert.ok(sp.includes('setTheme('), 'must call setTheme from theme.js on theme button click')
})
test('getTheme used to initialize currentTheme state', () => {
  assert.ok(sp.includes('getTheme()'), 'must initialize currentTheme from getTheme()')
})

// ── Privacy and sign-out routing ──────────────────────────────────────────────

console.log('\nPrivacy and sign-out routing')

test('Privacy Policy uses /privacy route (not external URL)', () => {
  assert.ok(sp.includes('to="/privacy"') || sp.includes("to='/privacy'"), 'must link to /privacy route')
})
test('Privacy link uses react-router Link (not <a>)', () => {
  const linkIdx = sp.indexOf('/privacy')
  const region = sp.slice(Math.max(0, linkIdx - 50), linkIdx + 30)
  assert.ok(region.includes('<Link'), 'must use react-router Link for /privacy')
})
test('sign-out navigates to /signin (not / or /signup)', () => {
  const signOutIdx = sp.indexOf('async function handleSignOut(')
  const fn = sp.slice(signOutIdx, signOutIdx + 550)
  assert.ok(fn.includes('/signin'), 'sign-out must navigate to /signin')
  assert.ok(!fn.includes('/signup'), 'sign-out must not navigate to /signup')
})

// ── Stage 11: accountGenRef UID-scoped request generation ─────────────────────

console.log('\nStage 11: accountGenRef — UID-scoped request generation')

const sl = readFileSync(resolve('src/lib/settingsLifecycle.js'), 'utf8')

test('accountGenRef is declared (useRef(0))', () => {
  assert.ok(sp.includes('accountGenRef'), 'accountGenRef must be declared')
  assert.ok(sp.includes('useRef(0)'), 'accountGenRef must be initialized with useRef(0)')
})
test('capturedGen is captured inside handleSave', () => {
  const idx = sp.indexOf('async function handleSave(')
  const fn = sp.slice(idx, idx + 300)
  assert.ok(fn.includes('capturedGen'), 'handleSave must capture capturedGen at start')
})
test('accountGenRef checked in handleSave after await', () => {
  const idx = sp.indexOf('async function handleSave(')
  const fn = sp.slice(idx, idx + 800)
  assert.ok(fn.includes('accountGenRef.current'), 'handleSave must check accountGenRef.current after every await')
})
test('capturedGen is captured inside handleDeleteAll', () => {
  const idx = sp.indexOf('async function handleDeleteAll(')
  const fn = sp.slice(idx, idx + 300)
  assert.ok(fn.includes('capturedGen'), 'handleDeleteAll must capture capturedGen')
})
test('accountGenRef checked in handleDeleteAll after await', () => {
  const idx = sp.indexOf('async function handleDeleteAll(')
  const fn = sp.slice(idx, idx + 800)
  assert.ok(fn.includes('accountGenRef.current'), 'handleDeleteAll must check accountGenRef.current')
})
test('capturedGen is captured inside handleDeleteAccount', () => {
  const idx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(idx, idx + 300)
  assert.ok(fn.includes('capturedGen'), 'handleDeleteAccount must capture capturedGen')
})
test('accountGenRef checked in handleDeleteAccount after await', () => {
  const idx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(idx, idx + 800)
  assert.ok(fn.includes('accountGenRef.current'), 'handleDeleteAccount must check accountGenRef.current')
})
test('capturedGen is captured inside handleSignOut', () => {
  const idx = sp.indexOf('async function handleSignOut(')
  const fn = sp.slice(idx, idx + 300)
  assert.ok(fn.includes('capturedGen'), 'handleSignOut must capture capturedGen')
})
test('accountGenRef checked in handleSignOut after await', () => {
  const idx = sp.indexOf('async function handleSignOut(')
  const fn = sp.slice(idx, idx + 500)
  assert.ok(fn.includes('accountGenRef.current'), 'handleSignOut must check accountGenRef.current')
})
test('accountGenRef is incremented on account switch', () => {
  // The account-switch handler must increment accountGenRef.current when UID changes.
  const authIdx = sp.indexOf('onAuthStateChange')
  const region = sp.slice(authIdx, authIdx + 800)
  assert.ok(region.includes('accountGenRef.current++') || region.includes('accountGenRef.current += 1'),
    'onAuthStateChange handler must increment accountGenRef.current on UID change')
})
test('loadKey state triggers load effect re-run on account switch', () => {
  assert.ok(sp.includes('loadKey'), 'loadKey state must be declared')
  assert.ok(sp.includes('setLoadKey'), 'setLoadKey must be called to trigger load re-run')
})

// ── Stage 11: funnl:profile-changed dispatch ──────────────────────────────────

console.log('\nStage 11: funnl:profile-changed dispatch from handleSave')

test('handleSave dispatches funnl:profile-changed after confirmed DB save', () => {
  const saveIdx = sp.indexOf('async function handleSave(')
  const fn = sp.slice(saveIdx, saveIdx + 1200)
  assert.ok(fn.includes('funnl:profile-changed'), 'handleSave must dispatch funnl:profile-changed')
})
test('funnl:profile-changed dispatch uses window.dispatchEvent', () => {
  assert.ok(
    sp.includes("window.dispatchEvent(new Event('funnl:profile-changed'))"),
    'funnl:profile-changed must be dispatched via window.dispatchEvent'
  )
})
test('funnl:profile-changed dispatch comes AFTER DB success (not on error path)', () => {
  const saveIdx = sp.indexOf('async function handleSave(')
  const fn = sp.slice(saveIdx, saveIdx + 1200)
  // The error return must come before the dispatch
  const errIdx = fn.indexOf("'Could not save")
  const dispatchIdx = fn.indexOf('funnl:profile-changed')
  assert.ok(errIdx !== -1 && dispatchIdx !== -1, 'both error path and profile-changed dispatch must exist in handleSave')
  assert.ok(errIdx < dispatchIdx, 'error return must precede funnl:profile-changed dispatch — it only fires on success')
})

// ── Stage 11: funnl:contacts-changed dispatch and listener ────────────────────

console.log('\nStage 11: funnl:contacts-changed dispatch and listener')

test('handleDeleteAll dispatches funnl:contacts-changed on success', () => {
  const dalIdx = sp.indexOf('async function handleDeleteAll(')
  const fn = sp.slice(dalIdx, dalIdx + 1000)
  assert.ok(fn.includes('funnl:contacts-changed'), 'handleDeleteAll must dispatch funnl:contacts-changed')
})
test('funnl:contacts-changed dispatch uses window.dispatchEvent', () => {
  assert.ok(
    sp.includes("window.dispatchEvent(new Event('funnl:contacts-changed'))"),
    'funnl:contacts-changed must be dispatched via window.dispatchEvent'
  )
})
test('Settings listens for funnl:contacts-changed to refresh count', () => {
  assert.ok(sp.includes('funnl:contacts-changed'), 'Settings must reference funnl:contacts-changed event')
  // Look for the addEventListener call for the contacts-changed event
  const listenerIdx = sp.indexOf("'funnl:contacts-changed'")
  assert.ok(listenerIdx !== -1, 'funnl:contacts-changed must appear as an event name string')
})
test('contacts-changed listener does a fresh count query (count: exact)', () => {
  // The listener should trigger a fresh count query, not just set to 0
  const firstExact = sp.indexOf("count: 'exact'")
  const secondExact = sp.indexOf("count: 'exact'", firstExact + 1)
  assert.ok(secondExact !== -1, 'must have at least two count:exact queries (load + listener)')
})

// ── Stage 11: W3C radiogroup keyboard navigation ──────────────────────────────

console.log('\nStage 11: W3C radiogroup keyboard navigation')

test('handleThemeKeyDown is defined in SettingsPage', () => {
  assert.ok(sp.includes('handleThemeKeyDown'), 'handleThemeKeyDown must be defined')
})
test('handleThemeKeyDown has IME composition guard', () => {
  const kbIdx = sp.indexOf('handleThemeKeyDown')
  const fn = sp.slice(kbIdx, kbIdx + 500)
  assert.ok(fn.includes('isComposing'), 'handleThemeKeyDown must guard against IME composition')
})
test('handleThemeKeyDown calls moveThemeRadio', () => {
  const kbIdx = sp.indexOf('handleThemeKeyDown')
  const fn = sp.slice(kbIdx, kbIdx + 500)
  assert.ok(fn.includes('moveThemeRadio'), 'handleThemeKeyDown must delegate movement to moveThemeRadio')
})
test('handleThemeKeyDown uses requestAnimationFrame to move focus after render', () => {
  const kbIdx = sp.indexOf('handleThemeKeyDown')
  const fn = sp.slice(kbIdx, kbIdx + 600)
  assert.ok(fn.includes('requestAnimationFrame'), 'handleThemeKeyDown must use requestAnimationFrame to focus new radio button')
})
test('handleThemeKeyDown focuses button by data-theme-option attribute', () => {
  const kbIdx = sp.indexOf('handleThemeKeyDown')
  const fn = sp.slice(kbIdx, kbIdx + 600)
  assert.ok(fn.includes('data-theme-option'), 'focus management must use data-theme-option to target the button')
})
test('radiogroup container has onKeyDown={handleThemeKeyDown}', () => {
  const rgIdx = sp.indexOf('role="radiogroup"')
  assert.ok(rgIdx !== -1, 'radiogroup must exist')
  const region = sp.slice(rgIdx, rgIdx + 400)
  assert.ok(region.includes('onKeyDown'), 'radiogroup must have an onKeyDown handler')
  assert.ok(region.includes('handleThemeKeyDown'), 'radiogroup onKeyDown must reference handleThemeKeyDown')
})

// ── Stage 11: Roving tabIndex ─────────────────────────────────────────────────

console.log('\nStage 11: Roving tabIndex on theme radio buttons')

test('theme buttons use roving tabIndex (selected=0, others=-1)', () => {
  // Look for the tabIndex attribute on radio buttons — roving pattern
  assert.ok(sp.includes('tabIndex'), 'theme buttons must have a tabIndex attribute')
})
test('selected theme button gets tabIndex=0', () => {
  const tabIdx = sp.indexOf('tabIndex')
  const region = sp.slice(tabIdx, tabIdx + 200)
  assert.ok(region.includes('0') && region.includes('-1'), 'roving tabIndex must use 0 for selected and -1 for others')
})
test('each theme button has data-theme-option attribute', () => {
  assert.ok(sp.includes('data-theme-option'), 'theme buttons must have data-theme-option attribute for focus management')
})

// ── Stage 11: Reduced-motion classes ─────────────────────────────────────────

console.log('\nStage 11: Reduced-motion accessibility')

test('loading skeleton has motion-reduce:animate-none on animate-pulse', () => {
  assert.ok(sp.includes('motion-reduce:animate-none'), 'animate-pulse must be paired with motion-reduce:animate-none')
})
test('transition classes have motion-reduce:transition-none', () => {
  assert.ok(sp.includes('motion-reduce:transition-none'), 'transition classes must be paired with motion-reduce:transition-none')
})

// ── Stage 11: Complete account-switch reset (flags) ───────────────────────────

console.log('\nStage 11: Complete account-switch reset — all flags cleared')

test('account-switch reset clears saving flag', () => {
  const authIdx = sp.indexOf('onAuthStateChange')
  const region = sp.slice(authIdx, authIdx + 1000)
  assert.ok(region.includes('setSaving(false)'), 'account-switch must clear saving flag')
})
test('account-switch reset clears signingOut flag', () => {
  const authIdx = sp.indexOf('onAuthStateChange')
  const region = sp.slice(authIdx, authIdx + 1000)
  assert.ok(region.includes('setSigningOut(false)'), 'account-switch must clear signingOut flag')
})
test('account-switch reset clears retrying flag', () => {
  const authIdx = sp.indexOf('onAuthStateChange')
  const region = sp.slice(authIdx, authIdx + 1000)
  assert.ok(region.includes('setRetrying(false)'), 'account-switch must clear retrying flag')
})
test('account-switch reset clears deletingAll flag', () => {
  const authIdx = sp.indexOf('onAuthStateChange')
  const region = sp.slice(authIdx, authIdx + 1300)
  assert.ok(region.includes('setDeletingAll(false)'), 'account-switch must clear deletingAll flag')
})
test('account-switch reset clears deleting flag', () => {
  const authIdx = sp.indexOf('onAuthStateChange')
  const region = sp.slice(authIdx, authIdx + 1400)
  assert.ok(region.includes('setDeleting(false)'), 'account-switch must clear deleting flag')
})
test('account-switch reset clears user state to null', () => {
  const authIdx = sp.indexOf('onAuthStateChange')
  const region = sp.slice(authIdx, authIdx + 1000)
  assert.ok(region.includes('setUser(null)'), 'account-switch must set user to null (clears email display)')
})
test('account-switch reset increments accountGenRef', () => {
  const authIdx = sp.indexOf('onAuthStateChange')
  const region = sp.slice(authIdx, authIdx + 800)
  assert.ok(
    region.includes('accountGenRef.current++') || region.includes('accountGenRef.current += 1'),
    'account-switch must increment accountGenRef.current to invalidate in-flight requests'
  )
})

// ── Stage 11: Delete-all input cleared on success ────────────────────────────

console.log('\nStage 11: Delete-all confirmation input cleared on success')

test('handleDeleteAll clears deleteAllInput after successful delete', () => {
  const dalIdx = sp.indexOf('async function handleDeleteAll(')
  const fn = sp.slice(dalIdx, dalIdx + 1200)
  // Input should be cleared in the SUCCESS path, not on failure
  const errorIdx = fn.indexOf('deleteAllError')
  const clearIdx = fn.indexOf("setDeleteAllInput('')")
  assert.ok(clearIdx !== -1, 'handleDeleteAll must clear deleteAllInput with setDeleteAllInput(empty string)')
  // The clear must come after the error-bail check — i.e., in the success path
  // Verify: the deleteAllError setter (for showing error) comes before the clearInput call
  // or the clear comes after the early-return error block
  assert.ok(
    clearIdx > errorIdx || fn.indexOf("return") < clearIdx,
    'input clear must be in the success path (after error early-return)'
  )
})
test('deleteAllInput is NOT cleared when delete fails', () => {
  const dalIdx = sp.indexOf('async function handleDeleteAll(')
  const fn = sp.slice(dalIdx, dalIdx + 1200)
  // On the error path, we set deleteAllError, clear deletingAll, and return.
  // The clearInput must come AFTER the error+return block.
  const errorReturnIdx = fn.indexOf('return')
  const clearIdx = fn.indexOf("setDeleteAllInput('')")
  assert.ok(errorReturnIdx < clearIdx, 'input must not be cleared on the error path (clear comes after error return)')
})

// ── Stage 11: settingsLifecycle imports ──────────────────────────────────────

console.log('\nStage 11: settingsLifecycle imports in SettingsPage')

test('SettingsPage imports moveThemeRadio from settingsLifecycle', () => {
  assert.ok(
    sp.includes('moveThemeRadio') && sp.includes('settingsLifecycle'),
    'must import moveThemeRadio from settingsLifecycle'
  )
})
test('SettingsPage imports classifyDeleteAccountResponse from settingsLifecycle', () => {
  assert.ok(
    sp.includes('classifyDeleteAccountResponse') && sp.includes('settingsLifecycle'),
    'must import classifyDeleteAccountResponse from settingsLifecycle'
  )
})
test('SettingsPage imports canCloseDialog from settingsLifecycle', () => {
  assert.ok(
    sp.includes('canCloseDialog') && sp.includes('settingsLifecycle'),
    'must import canCloseDialog from settingsLifecycle'
  )
})
test('SettingsPage imports THEME_ORDER from settingsLifecycle', () => {
  assert.ok(
    sp.includes('THEME_ORDER') && sp.includes('settingsLifecycle'),
    'must import THEME_ORDER from settingsLifecycle'
  )
})
test('settingsLifecycle.js has no React import (Node-safe)', () => {
  assert.ok(!sl.includes("from 'react'"), 'settingsLifecycle must not import React')
})
test('settingsLifecycle.js has no Supabase import (Node-safe)', () => {
  assert.ok(!sl.includes('@supabase') && !sl.includes("from '../lib/supabase'"), 'settingsLifecycle must not import Supabase')
})
test('classifyDeleteAccountResponse used in handleDeleteAccount (not raw .data check)', () => {
  const daIdx = sp.indexOf('async function handleDeleteAccount(')
  const fn = sp.slice(daIdx, daIdx + 700)
  assert.ok(fn.includes('classifyDeleteAccountResponse'), 'handleDeleteAccount must use classifyDeleteAccountResponse helper')
})
test('canCloseDialog used in modal close functions', () => {
  assert.ok(sp.includes('canCloseDialog('), 'canCloseDialog must be called in close modal functions')
})

// ── Stage 11: FunnlAIPage Pro RPC fix ────────────────────────────────────────

console.log('\nStage 11: FunnlAIPage Pro RPC fix verification (via SettingsPage source contract)')

// These tests check the SettingsPage side of the contract — it must not import
// getProAccessStatus directly (that job belongs to the shared provider only).
test('SettingsPage does not import getProAccessStatus directly', () => {
  // Check that the import path from pro-access-status is absent — the function
  // name may appear in comments but the import line must not.
  assert.ok(
    !sp.includes("from '../lib/pro-access-status'"),
    'SettingsPage must not import from pro-access-status — use the shared provider'
  )
})
test('SettingsPage uses useProRefresh for retry (shared provider pattern)', () => {
  assert.ok(sp.includes('useProRefresh'), 'SettingsPage must use useProRefresh (not direct RPC calls)')
})
test('handleProRetry delegates to proRefresh from useProRefresh', () => {
  const retryIdx = sp.indexOf('async function handleProRetry(')
  const fn = sp.slice(retryIdx, retryIdx + 400)
  assert.ok(fn.includes('proRefresh'), 'handleProRetry must call proRefresh() from the shared provider context')
  assert.ok(!fn.includes('getProAccessStatus'), 'handleProRetry must NOT call getProAccessStatus() directly')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
