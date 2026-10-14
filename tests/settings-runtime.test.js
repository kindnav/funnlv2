/**
 * settings-runtime.test.js
 *
 * Runtime-level tests for Settings infrastructure:
 *   1. classifyProStatus integration — all 6 UI states
 *   2. settingsHelpers full chain — edge cases and boundary values
 *   3. useProStatus provider source contracts
 *   4. Theme module pure functions for Settings use
 *   5. delete-account Edge Function contract audit
 *
 * Uses pure function imports and source-contract assertions.
 * No React, no DOM, no Supabase — safe to run with: node tests/settings-runtime.test.js
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

// ── Import pure modules ──────────────────────────────────────────────────────

import {
  classifyProStatus,
} from '../src/lib/pro-ui-status.js'

import {
  DISPLAY_NAME_MAX_LENGTH,
  DELETE_ALL_PHRASE,
  DELETE_ACCOUNT_PHRASE,
  normalizeDisplayName,
  validateDisplayName,
  isDeleteAllConfirmEligible,
  isDeleteAccountConfirmEligible,
  formatJoined,
  formatTrialEnd,
  summarizeContactCount,
} from '../src/lib/settingsHelpers.js'

import {
  VALID_THEMES,
  normalizeThemePreference,
  resolveColorScheme,
  readThemePreference,
  writeThemePreference,
  applyThemeToRoot,
} from '../src/lib/theme.js'

// ── Read source files for contract assertions ────────────────────────────────

const providerSrc = readFileSync(resolve('src/lib/useProStatus.js'), 'utf8')
const settingsSrc = readFileSync(resolve('src/pages/SettingsPage.jsx'), 'utf8')
const helpersSrc  = readFileSync(resolve('src/lib/settingsHelpers.js'), 'utf8')
const edgeSrc     = readFileSync(resolve('supabase/functions/delete-account/index.ts'), 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: classifyProStatus — all six Pro states
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nclassifyProStatus — all six Settings Pro states')

test('null (loading) → unavailable', () => {
  assert.strictEqual(classifyProStatus(null), 'unavailable')
})
test('"error" (RPC failed) → unavailable', () => {
  assert.strictEqual(classifyProStatus('error'), 'unavailable')
})
test('unexpected string → unavailable', () => {
  assert.strictEqual(classifyProStatus('some-other-string'), 'unavailable')
})
test('missing required boolean fields → unavailable', () => {
  assert.strictEqual(classifyProStatus({}), 'unavailable')
  assert.strictEqual(classifyProStatus({ can_use_pro: true }), 'unavailable')
  assert.strictEqual(classifyProStatus({ permanent_pro: false }), 'unavailable')
})
test('permanent_pro=true with can_use_pro=true → permanent', () => {
  assert.strictEqual(classifyProStatus({ permanent_pro: true, can_use_pro: true }), 'permanent')
})
test('permanent_pro=true but can_use_pro=false → unavailable (contradiction guard)', () => {
  // A grant flag that disagrees with can_use_pro=false is internally inconsistent;
  // classifyProStatus must not render a Pro label. can_use_pro is authoritative.
  assert.strictEqual(classifyProStatus({ permanent_pro: true, can_use_pro: false, trial_active: false }), 'unavailable')
})
test('permanent_pro=false, can_use_pro=true, trial_active=true → trial', () => {
  assert.strictEqual(
    classifyProStatus({ permanent_pro: false, can_use_pro: true, trial_active: true }),
    'trial'
  )
})
test('permanent_pro=false, can_use_pro=false, trial_expired=true → expired', () => {
  assert.strictEqual(
    classifyProStatus({ permanent_pro: false, can_use_pro: false, trial_expired: true }),
    'expired'
  )
})
test('permanent_pro=false, can_use_pro=false, no trial → non_pro', () => {
  assert.strictEqual(
    classifyProStatus({ permanent_pro: false, can_use_pro: false, trial_expired: false }),
    'non_pro'
  )
  assert.strictEqual(
    classifyProStatus({ permanent_pro: false, can_use_pro: false }),
    'non_pro'
  )
})
test('unavailable states must never return permanent, trial, expired, or non_pro', () => {
  const bad = [null, 'error', '', 42, true, false, [], {}]
  for (const v of bad) {
    const result = classifyProStatus(v)
    assert.ok(
      result === 'unavailable',
      `classifyProStatus(${JSON.stringify(v)}) must be unavailable, got ${result}`
    )
  }
})
test('days_remaining on a trial object — classifies as trial', () => {
  const obj = { permanent_pro: false, can_use_pro: true, trial_active: true, days_remaining: 3 }
  assert.strictEqual(classifyProStatus(obj), 'trial')
})
test('days_remaining = 0 still classifies as trial (provider math, not negative)', () => {
  const obj = { permanent_pro: false, can_use_pro: true, trial_active: true, days_remaining: 0 }
  assert.strictEqual(classifyProStatus(obj), 'trial')
})
test('trial expired flag takes precedence over zero days', () => {
  const obj = { permanent_pro: false, can_use_pro: false, trial_active: false, trial_expired: true, days_remaining: 0 }
  assert.strictEqual(classifyProStatus(obj), 'expired')
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: settingsHelpers full chain — edge cases
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsettingsHelpers edge cases')

test('validateDisplayName: single character is valid', () => {
  const r = validateDisplayName('A')
  assert.strictEqual(r.valid, true)
  assert.strictEqual(r.code, 'ok')
})
test('validateDisplayName: unicode emoji is valid', () => {
  const r = validateDisplayName('Naveen 🚀')
  assert.strictEqual(r.valid, true)
})
test('validateDisplayName: name at exactly max length (with surrounding spaces) is valid', () => {
  const padded = '  ' + 'X'.repeat(DISPLAY_NAME_MAX_LENGTH) + '  '
  const r = validateDisplayName(padded)
  assert.strictEqual(r.valid, true, 'trimmed result at exactly max length must be valid')
})
test('validateDisplayName: name at max+1 after trim is invalid', () => {
  const r = validateDisplayName('X'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'too_long')
})
test('validateDisplayName: all three error codes produce non-empty messages', () => {
  const empty   = validateDisplayName('')
  const tooLong = validateDisplayName('X'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))
  const invalid = validateDisplayName('A\nB')
  assert.ok(empty.message.length > 0,   'empty code must have message')
  assert.ok(tooLong.message.length > 0, 'too_long code must have message')
  assert.ok(invalid.message.length > 0, 'invalid_chars code must have message')
})
test('normalizeDisplayName: converts number to string', () => {
  assert.strictEqual(normalizeDisplayName(0), '0')
  assert.strictEqual(normalizeDisplayName(42), '42')
})
test('isDeleteAllConfirmEligible: phrase constants match', () => {
  assert.ok(isDeleteAllConfirmEligible(DELETE_ALL_PHRASE))
})
test('isDeleteAllConfirmEligible: no whitespace tolerance', () => {
  assert.strictEqual(isDeleteAllConfirmEligible(' ' + DELETE_ALL_PHRASE), false)
  assert.strictEqual(isDeleteAllConfirmEligible(DELETE_ALL_PHRASE + ' '), false)
})
test('isDeleteAccountConfirmEligible: phrase constants match', () => {
  assert.ok(isDeleteAccountConfirmEligible(DELETE_ACCOUNT_PHRASE))
})
test('isDeleteAccountConfirmEligible: both-sides trim allowed', () => {
  assert.ok(isDeleteAccountConfirmEligible('  ' + DELETE_ACCOUNT_PHRASE + '  '))
})
test('formatJoined: returns Unknown for all falsy inputs', () => {
  for (const v of [null, undefined, '', 0, false]) {
    const result = formatJoined(v)
    // false and 0 coerce to false in the !ts guard
    if (!v) assert.strictEqual(result, 'Unknown', `formatJoined(${JSON.stringify(v)}) must be Unknown`)
  }
})
test('formatJoined: no em dash in any output path', () => {
  const allOutputs = [
    formatJoined(null),
    formatJoined(undefined),
    formatJoined(''),
    formatJoined('not-a-date'),
    formatJoined('2026-01-01T00:00:00Z'),
  ]
  for (const output of allOutputs) {
    assert.ok(!output.includes('—'), `formatJoined must never return em dash, got: ${output}`)
  }
})
test('formatTrialEnd: returns Unknown for all falsy inputs', () => {
  for (const v of [null, undefined, '']) {
    assert.strictEqual(formatTrialEnd(v), 'Unknown')
  }
})
test('formatTrialEnd: no em dash in any output path', () => {
  const allOutputs = [
    formatTrialEnd(null),
    formatTrialEnd(undefined),
    formatTrialEnd(''),
    formatTrialEnd('not-a-date'),
    formatTrialEnd('2026-08-15T12:00:00Z'),
  ]
  for (const output of allOutputs) {
    assert.ok(!output.includes('—'), `formatTrialEnd must never return em dash, got: ${output}`)
  }
})
test('summarizeContactCount: boundary values', () => {
  assert.strictEqual(summarizeContactCount(0), 'no contacts')
  assert.strictEqual(summarizeContactCount(1), '1 contact')
  assert.strictEqual(summarizeContactCount(2), '2 contacts')
  assert.strictEqual(summarizeContactCount(999), '999 contacts')
})
test('summarizeContactCount: negative is treated as no contacts', () => {
  assert.strictEqual(summarizeContactCount(-5), 'no contacts')
})
test('summarizeContactCount: NaN is treated as no contacts', () => {
  assert.strictEqual(summarizeContactCount(NaN), 'no contacts')
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: useProStatus provider source contracts
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nuseProStatus provider source contracts')

test('ProStatusProvider is exported', () => {
  assert.ok(providerSrc.includes('export function ProStatusProvider'), 'must export ProStatusProvider')
})
test('useProStatus is exported', () => {
  assert.ok(providerSrc.includes('export function useProStatus()'), 'must export useProStatus')
})
test('useProRefresh is exported', () => {
  assert.ok(providerSrc.includes('export function useProRefresh()'), 'must export useProRefresh')
})
test('useCallback is imported for stable refresh reference', () => {
  assert.ok(providerSrc.includes('useCallback'), 'must import useCallback for stable refresh function')
})
test('context default shape includes status and refresh', () => {
  const ctxIdx = providerSrc.indexOf('createContext(')
  const region = providerSrc.slice(ctxIdx, ctxIdx + 220)
  assert.ok(
    region.includes('status: null') && /refresh:\s*async/.test(region),
    'context default must include status null and an async refresh'
  )
})
test('useProStatus returns context.status (not the whole context)', () => {
  const hookIdx = providerSrc.indexOf('export function useProStatus()')
  const fn = providerSrc.slice(hookIdx, hookIdx + 100)
  assert.ok(fn.includes('.status'), 'useProStatus must return context.status')
})
test('useProRefresh returns context.refresh', () => {
  const hookIdx = providerSrc.indexOf('export function useProRefresh()')
  const fn = providerSrc.slice(hookIdx, hookIdx + 100)
  assert.ok(fn.includes('.refresh'), 'useProRefresh must return context.refresh')
})
test('refresh function uses useCallback for stability', () => {
  assert.ok(
    providerSrc.includes('useCallback(async') || providerSrc.includes('useCallback(() =>') ||
    providerSrc.includes('= useCallback('),
    'refresh must be wrapped in useCallback'
  )
})
test('refresh function calls getProAccessStatus', () => {
  const refreshIdx = providerSrc.indexOf('const refresh = useCallback')
  const region = providerSrc.slice(refreshIdx, refreshIdx + 200)
  assert.ok(region.includes('getProAccessStatus'), 'refresh must call getProAccessStatus')
})
test('refresh updates provider state with null-coalesced error sentinel', () => {
  const refreshIdx = providerSrc.indexOf('const refresh = useCallback')
  const region = providerSrc.slice(refreshIdx, refreshIdx + 320)
  assert.ok(
    region.includes("?? 'error'") || region.includes('?? "error"'),
    'refresh must coalesce null to error sentinel'
  )
})
test('SettingsPage imports useProRefresh from useProStatus module', () => {
  assert.ok(
    settingsSrc.includes('useProRefresh') && settingsSrc.includes("from '../lib/useProStatus'"),
    'SettingsPage must import useProRefresh from useProStatus'
  )
})
test('SettingsPage does not import getProAccessStatus', () => {
  assert.ok(
    !settingsSrc.includes("from '../lib/pro-access-status'"),
    'SettingsPage must not import pro-access-status — goes through provider'
  )
})
test('SettingsPage proStatus is rawProStatus only (no local override)', () => {
  assert.ok(
    !settingsSrc.includes('retryStatus'),
    'SettingsPage must not have a local retryStatus override'
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 4: Theme module pure functions for Settings use
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nTheme module — pure function coverage for Settings')

test('VALID_THEMES contains exactly light, dark, system', () => {
  assert.ok(VALID_THEMES.has('light'),  'must include light')
  assert.ok(VALID_THEMES.has('dark'),   'must include dark')
  assert.ok(VALID_THEMES.has('system'), 'must include system')
  assert.strictEqual(VALID_THEMES.size, 3, 'must have exactly 3 themes')
})
test('normalizeThemePreference: valid values pass through', () => {
  assert.strictEqual(normalizeThemePreference('light'),  'light')
  assert.strictEqual(normalizeThemePreference('dark'),   'dark')
  assert.strictEqual(normalizeThemePreference('system'), 'system')
})
test('normalizeThemePreference: invalid values fall back to light', () => {
  assert.strictEqual(normalizeThemePreference(null),         'light')
  assert.strictEqual(normalizeThemePreference(undefined),    'light')
  assert.strictEqual(normalizeThemePreference(''),           'light')
  assert.strictEqual(normalizeThemePreference('purple'),     'light')
  assert.strictEqual(normalizeThemePreference('auto'),       'light')
  assert.strictEqual(normalizeThemePreference('resolved'),   'light')
})
test('normalizeThemePreference: no fourth theme accepted', () => {
  assert.strictEqual(normalizeThemePreference('dimmed'), 'light')
  assert.strictEqual(normalizeThemePreference('solarized'), 'light')
})
test('resolveColorScheme: light → light', () => {
  assert.strictEqual(resolveColorScheme('light'), 'light')
})
test('resolveColorScheme: dark → dark', () => {
  assert.strictEqual(resolveColorScheme('dark'), 'dark')
})
test('resolveColorScheme: system → light dark (both)', () => {
  assert.strictEqual(resolveColorScheme('system'), 'light dark')
})
test('readThemePreference: returns normalized preference from storage', () => {
  const mockStorage = { getItem: () => 'dark' }
  assert.strictEqual(readThemePreference(mockStorage), 'dark')
})
test('readThemePreference: falls back to light for null storage value', () => {
  const mockStorage = { getItem: () => null }
  assert.strictEqual(readThemePreference(mockStorage), 'light')
})
test('readThemePreference: falls back to light for invalid stored value', () => {
  const mockStorage = { getItem: () => 'resolved' }
  assert.strictEqual(readThemePreference(mockStorage), 'light')
})
test('writeThemePreference: writes valid values to storage', () => {
  const written = {}
  const mockStorage = { setItem: (k, v) => { written[k] = v } }
  writeThemePreference(mockStorage, 'dark')
  assert.strictEqual(written['funnl-theme'], 'dark')
})
test('writeThemePreference: does not write invalid values', () => {
  const written = {}
  const mockStorage = { setItem: (k, v) => { written[k] = v } }
  writeThemePreference(mockStorage, 'purple')
  assert.strictEqual(written['funnl-theme'], undefined)
})
test('writeThemePreference: does not persist resolved theme over system', () => {
  // Writing 'light' or 'dark' directly replaces 'system' — this test verifies
  // that Settings must call setTheme('system') not setTheme('light') when System is selected.
  // The pure function accepts 'light'/'dark'/'system' only.
  const written = {}
  const mockStorage = { setItem: (k, v) => { written[k] = v } }
  writeThemePreference(mockStorage, 'system')
  assert.strictEqual(written['funnl-theme'], 'system')
})
test('applyThemeToRoot: stamps data-theme and colorScheme on root', () => {
  const root = { dataset: {}, style: {} }
  applyThemeToRoot(root, 'dark')
  assert.strictEqual(root.dataset.theme, 'dark')
  assert.strictEqual(root.style.colorScheme, 'dark')
})
test('applyThemeToRoot: system theme sets color-scheme to "light dark"', () => {
  const root = { dataset: {}, style: {} }
  applyThemeToRoot(root, 'system')
  assert.strictEqual(root.dataset.theme, 'system')
  assert.strictEqual(root.style.colorScheme, 'light dark')
})
test('applyThemeToRoot: invalid theme normalizes to light before applying', () => {
  const root = { dataset: {}, style: {} }
  applyThemeToRoot(root, 'bogus')
  assert.strictEqual(root.dataset.theme, 'light')
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 5: delete-account Edge Function contract audit
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ndelete-account Edge Function contract audit')

test('Edge Function validates Authorization header before anything', () => {
  const authCheckIdx = edgeSrc.indexOf('Authorization')
  assert.ok(authCheckIdx !== -1, 'must check Authorization header')
  // Auth check must come before any admin operation
  const adminIdx = edgeSrc.indexOf('admin')
  assert.ok(authCheckIdx < adminIdx, 'auth check must precede any admin operation')
})
test('Edge Function verifies JWT via supabase.auth.getUser() (not trusting browser UID)', () => {
  assert.ok(edgeSrc.includes('auth.getUser()'), 'must verify JWT with auth.getUser()')
  assert.ok(!edgeSrc.includes('req.json()') || !edgeSrc.includes('userId'), 'must not trust a user ID from the request body')
})
test('Edge Function uses service-role key for deletion (admin client)', () => {
  assert.ok(
    edgeSrc.includes('SUPABASE_SERVICE_ROLE_KEY'),
    'must use service-role key for privileged admin operations'
  )
})
test('Edge Function deletes contacts (triggers cascade to interactions)', () => {
  assert.ok(edgeSrc.includes("from('contacts')") || edgeSrc.includes('.from("contacts")'), 'must delete contacts')
  assert.ok(edgeSrc.includes('.delete()'), 'must call delete()')
})
test('Edge Function scopes contact deletion to verified user.id', () => {
  const contactDelIdx = edgeSrc.indexOf("from('contacts')")
  const region = edgeSrc.slice(contactDelIdx, contactDelIdx + 200)
  assert.ok(region.includes('user.id'), 'contact deletion must be scoped to verified user.id')
})
test('Edge Function uses admin.auth.admin.deleteUser — not accessible from browser', () => {
  assert.ok(
    edgeSrc.includes('auth.admin.deleteUser'),
    'must use admin.auth.admin.deleteUser for auth deletion'
  )
})
test('Edge Function returns { success: true } on success', () => {
  assert.ok(edgeSrc.includes('success: true'), 'must return success: true on success')
})
test('Edge Function returns { error: ... } on failure', () => {
  assert.ok(edgeSrc.includes('error:'), 'must return error on failure')
})
test('Edge Function throws / returns 500 on contact deletion failure', () => {
  assert.ok(
    edgeSrc.includes('throw') || edgeSrc.includes('500'),
    'must handle contact deletion failure'
  )
})
test('SettingsPage checks both error and success flag from invoke', () => {
  // SettingsPage now delegates result classification to classifyDeleteAccountResponse()
  // which checks both the invokeError and data.success internally.
  const daIdx = settingsSrc.indexOf('async function handleDeleteAccount(')
  const fn = settingsSrc.slice(daIdx, daIdx + 750)
  assert.ok(fn.includes('error'), 'must receive invoke error')
  // Either delegates to classifyDeleteAccountResponse (which checks data.success internally)
  // or performs the check directly.
  assert.ok(
    fn.includes('classifyDeleteAccountResponse') || fn.includes('data?.success') || fn.includes('result.ok'),
    'must check data.success flag from function response (directly or via classifyDeleteAccountResponse)'
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 6: Structural safety — no prohibited patterns
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nStructural safety — prohibited patterns')

test('no purple/indigo color classes in Settings (Paper/Ink/Ember system)', () => {
  // Check that old purple-system classes are not present.
  // Accent color is ember (#FF4423), not purple/indigo.
  // text-accent / bg-accent are allowed (they map to the theme token, not a hardcoded purple).
  const badClasses = ['text-purple-', 'text-indigo-', 'bg-purple-', 'bg-indigo-', 'bg-violet-']
  for (const cls of badClasses) {
    assert.ok(!settingsSrc.includes(cls), `Settings must not use ${cls} class`)
  }
})
test('no CSS gradient in Settings (Ink button uses bg-hi not gradient)', () => {
  assert.ok(!settingsSrc.includes('linear-gradient'), 'Settings must not use gradient backgrounds')
})
test('no hardcoded hex color strings that are not CSS custom property references', () => {
  // Danger red as rgba with opacity is allowed (for borders)
  // '#' color strings should not appear except for the funnel SVG fill
  const hexColors = settingsSrc.match(/"#[0-9a-fA-F]{6}"/g) || []
  for (const color of hexColors) {
    // Only the Funnl funnel SVG fill colors are allowed (#FF4423)
    assert.ok(
      color.includes('FF4423'),
      `Unexpected hardcoded hex color ${color} — use CSS custom property tokens instead`
    )
  }
})
test('profile query does not use select(*)', () => {
  assert.ok(
    !settingsSrc.includes("select('*')") && !settingsSrc.includes('select("*")'),
    'must use explicit column selection, not select(*)'
  )
})
test('profile query selects display_name (may also include target_firms)', () => {
  const hasDisplayName = settingsSrc.includes("'display_name'") || settingsSrc.includes("'display_name,") || settingsSrc.includes("display_name, target_firms")
  assert.ok(hasDisplayName, "profile query must select display_name")
})
test('display name update uses .update() not .upsert()', () => {
  const codeOnly = settingsSrc.replace(/\/\/[^\n]*/g, '')
  assert.ok(codeOnly.includes('.update('), 'must use .update()')
  assert.ok(!codeOnly.includes('.upsert('), 'must not use .upsert()')
})
test('contact count uses head:true to avoid fetching rows', () => {
  assert.ok(
    settingsSrc.includes('head: true'),
    'contact count query must use head: true to avoid fetching row data'
  )
})
test('both dialogs have separate state (not shared)', () => {
  // Delete-all uses deleteAllInput; delete-account uses deleteInput — distinct state.
  assert.ok(settingsSrc.includes('deleteAllInput'), 'delete-all must have its own input state')
  assert.ok(settingsSrc.includes('deleteInput'), 'delete-account must have its own input state')
  // They must be separate (verify both appear independently)
  assert.ok(
    settingsSrc.indexOf('deleteAllInput') !== settingsSrc.indexOf('deleteInput'),
    'delete-all and delete-account must use separate input state variables'
  )
})

// ── Stage 11: settingsLifecycle pure function runtime tests ──────────────────

import {
  THEME_ORDER,
  isRequestCurrent,
  planDisplayNameSave,
  classifyDeleteAccountResponse,
  canCloseDialog,
  moveThemeRadio,
  getDeleteAllRefreshEvents,
  getProfileChangedRefreshEvents,
} from '../src/lib/settingsLifecycle.js'

console.log('\nStage 11: settingsLifecycle runtime integration')

test('THEME_ORDER from lifecycle matches SettingsPage usage', () => {
  assert.deepStrictEqual(THEME_ORDER, ['light', 'dark', 'system'])
})
test('isRequestCurrent returns false when unmounted even if gen matches', () => {
  assert.ok(!isRequestCurrent(false, 5, 5), 'unmounted request must be discarded')
})
test('isRequestCurrent returns false when gen advanced', () => {
  assert.ok(!isRequestCurrent(true, 3, 4), 'stale gen must discard request')
})
test('planDisplayNameSave returns noop for unchanged value', () => {
  const r = planDisplayNameSave('Alice', 'Alice')
  assert.strictEqual(r.action, 'noop')
})
test('planDisplayNameSave returns save with trimmed value', () => {
  const r = planDisplayNameSave('  Bob  ', 'Alice')
  assert.strictEqual(r.action, 'save')
  assert.strictEqual(r.normalized, 'Bob')
})
test('planDisplayNameSave returns error for empty string', () => {
  const r = planDisplayNameSave('', 'Alice')
  assert.strictEqual(r.action, 'error')
  assert.strictEqual(r.code, 'empty')
})
test('classifyDeleteAccountResponse — success path returns ok:true', () => {
  const r = classifyDeleteAccountResponse(null, { success: true })
  assert.ok(r.ok === true && r.code === 'success')
})
test('classifyDeleteAccountResponse — network error returns ok:false network_error', () => {
  const r = classifyDeleteAccountResponse(new Error('net'), null)
  assert.ok(!r.ok && r.code === 'network_error')
})
test('classifyDeleteAccountResponse — structured code passthrough', () => {
  const r = classifyDeleteAccountResponse(null, { success: false, error: { code: 'jwt_expired' } })
  assert.ok(!r.ok && r.code === 'jwt_expired')
})
test('canCloseDialog returns true when not busy', () => {
  assert.ok(canCloseDialog(false))
})
test('canCloseDialog returns false when busy', () => {
  assert.ok(!canCloseDialog(true))
})
test('moveThemeRadio advances forward through order', () => {
  assert.strictEqual(moveThemeRadio(['light','dark','system'], 'light', 'ArrowRight'), 'dark')
  assert.strictEqual(moveThemeRadio(['light','dark','system'], 'system', 'ArrowRight'), 'light') // wrap
})
test('moveThemeRadio goes to first on Home, last on End', () => {
  assert.strictEqual(moveThemeRadio(['light','dark','system'], 'dark', 'Home'), 'light')
  assert.strictEqual(moveThemeRadio(['light','dark','system'], 'dark', 'End'), 'system')
})
test('moveThemeRadio returns null for unhandled keys', () => {
  assert.strictEqual(moveThemeRadio(['light','dark','system'], 'dark', 'Enter'), null)
})
test('getDeleteAllRefreshEvents returns both required events', () => {
  const evts = getDeleteAllRefreshEvents()
  assert.ok(evts.includes('funnl:contacts-changed'))
  assert.ok(evts.includes('funnl:followups-changed'))
})
test('getProfileChangedRefreshEvents returns funnl:profile-changed', () => {
  const evts = getProfileChangedRefreshEvents()
  assert.ok(evts.includes('funnl:profile-changed') && evts.length === 1)
})

// ── Stage 11: FunnlAIPage Pro RPC fix — source contract ──────────────────────

const aiPageSrc = readFileSync(resolve('src/pages/FunnlAIPage.jsx'), 'utf8')
const sidebarSrc = readFileSync(resolve('src/components/Sidebar.jsx'), 'utf8')

console.log('\nStage 11: FunnlAIPage Pro RPC fix source contract')

test('FunnlAIPage does NOT import getProAccessStatus directly', () => {
  assert.ok(
    !aiPageSrc.includes("from '../lib/pro-access-status'"),
    'FunnlAIPage must not import from pro-access-status — use the shared provider'
  )
})
test('FunnlAIPage imports useProRefresh from useProStatus module', () => {
  assert.ok(
    aiPageSrc.includes('useProRefresh') && aiPageSrc.includes("from '../lib/useProStatus'"),
    'FunnlAIPage must import useProRefresh from useProStatus'
  )
})
test('FunnlAIPage retryProStatus calls proRefresh not getProAccessStatus', () => {
  const retryIdx = aiPageSrc.indexOf('async function retryProStatus(')
  const fn = aiPageSrc.slice(retryIdx, retryIdx + 400)
  assert.ok(fn.includes('proRefresh'), 'retryProStatus must call proRefresh()')
  assert.ok(!fn.includes('getProAccessStatus'), 'retryProStatus must NOT call getProAccessStatus()')
})
test('FunnlAIPage has no localProStatus state (no local override)', () => {
  assert.ok(!aiPageSrc.includes('localProStatus'), 'FunnlAIPage must not have a localProStatus state override')
})
test('FunnlAIPage proStatus comes from useProStatus() directly (no ?? fallback)', () => {
  // Look for "proStatus = useProStatus()" or assignment without ?? override
  assert.ok(
    aiPageSrc.includes('useProStatus()'),
    'FunnlAIPage must use useProStatus() for proStatus'
  )
  // No local override via ??
  assert.ok(
    !aiPageSrc.includes('localProStatus ??'),
    'FunnlAIPage must not use localProStatus ?? override'
  )
})

// ── Stage 11: Sidebar funnl:profile-changed listener ─────────────────────────

console.log('\nStage 11: Sidebar funnl:profile-changed listener')

test('Sidebar listens for funnl:profile-changed event', () => {
  assert.ok(
    sidebarSrc.includes('funnl:profile-changed'),
    'Sidebar must listen for funnl:profile-changed to update display name'
  )
})
test('Sidebar profile-changed listener re-fetches profile', () => {
  const listenerIdx = sidebarSrc.indexOf('funnl:profile-changed')
  const region = sidebarSrc.slice(Math.max(0, listenerIdx - 200), listenerIdx + 300)
  assert.ok(
    region.includes('fetchProfile') || region.includes('profiles'),
    'funnl:profile-changed listener must trigger a profile refetch'
  )
})
test('Sidebar profile-changed listener adds and removes event listener', () => {
  assert.ok(
    sidebarSrc.includes("addEventListener('funnl:profile-changed'") ||
    sidebarSrc.includes('addEventListener("funnl:profile-changed"'),
    'Sidebar must add event listener for funnl:profile-changed'
  )
  assert.ok(
    sidebarSrc.includes("removeEventListener('funnl:profile-changed'") ||
    sidebarSrc.includes('removeEventListener("funnl:profile-changed"'),
    'Sidebar must remove event listener for funnl:profile-changed (cleanup)'
  )
})
test('Sidebar profile-changed effect depends on user?.id', () => {
  const listenerIdx = sidebarSrc.indexOf("'funnl:profile-changed'")
  // The useEffect containing the listener should depend on user.id — find the closest dep array
  const region = sidebarSrc.slice(listenerIdx, listenerIdx + 300)
  assert.ok(
    region.includes('user?.id') || region.includes('user.id'),
    'profile-changed listener effect must depend on user?.id so it re-subscribes on account switch'
  )
})
test('Sidebar has a fetchProfile function', () => {
  assert.ok(
    sidebarSrc.includes('fetchProfile'),
    'Sidebar must define fetchProfile as a reusable function for profile refetching'
  )
})

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
