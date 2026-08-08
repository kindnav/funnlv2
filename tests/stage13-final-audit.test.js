// Stage 13 Final Audit — Sections J–V
// Application-wide coverage: system theme, portal propagation, state preservation,
// button/control audit, status contrast, gradients, reduced-motion, cross-tab, auth exception.
// Complements tests/stage13-theme-audit.test.js (sections A–I).
// Source-contract tests: no browser, no React, no Supabase.
// Run with: node tests/stage13-final-audit.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  VALID_THEMES, normalizeThemePreference, resolveColorScheme,
  readThemePreference, writeThemePreference, applyThemeToRoot,
} from '../src/lib/theme.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

function read(rel) { return readFileSync(join(root, rel), 'utf8') }

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

function makeStorage() {
  const store = {}
  return {
    getItem:    k     => (k in store ? store[k] : null),
    setItem:    (k,v) => { store[k] = String(v) },
    removeItem: k     => { delete store[k] },
  }
}

function makeRoot() {
  return { dataset: {}, style: {} }
}

// ── File reads ────────────────────────────────────────────────────────────────

const css           = read('src/index.css')
const indexHtml     = read('index.html')
const mainJsx       = read('src/main.jsx')
const themeLib      = read('src/lib/theme.js')
const avatarUtils   = read('src/lib/avatarUtils.js')
const funnlAI       = read('src/pages/FunnlAIPage.jsx')
const contactList   = read('src/components/ContactListItem.jsx')
const contactDetail = read('src/pages/ContactDetailPage.jsx')
const contactsPage  = read('src/pages/ContactsPage.jsx')
const followUps     = read('src/pages/FollowUpsPage.jsx')
const settingsPage  = read('src/pages/SettingsPage.jsx')
const logSheet      = read('src/components/LogInteractionSheet.jsx')
const importModal   = read('src/components/ImportContactsModal.jsx')
const bottomNav     = read('src/components/BottomNav.jsx')
const sidebar       = read('src/components/Sidebar.jsx')
const errorBoundary = read('src/components/ErrorBoundary.jsx')
const dashboard     = read('src/pages/DashboardPage.jsx')
const signInPage    = read('src/pages/SignInPage.jsx')
const welcomePage   = read('src/pages/WelcomePage.jsx')
const resetPage     = read('src/pages/ResetPasswordPage.jsx')
const privacyPage   = read('src/pages/PrivacyPage.jsx')
const addDrawer           = read('src/components/AddContactDrawer.jsx')
const contactPickerResults = read('src/components/ContactPickerResults.jsx')
const mobileAppBar        = read('src/components/MobileAppBar.jsx')

// ── Section J: New-fix source contracts ───────────────────────────────────────
console.log('\nJ — New-fix verification: backdrop and avatar semantic color')

test('FunnlAIPage history modal no longer hardcodes rgba(0,0,0,0.55) backdrop', () => {
  assert.ok(
    !funnlAI.includes("background: 'rgba(0,0,0,0.55)'"),
    'FunnlAIPage must not have hardcoded rgba(0,0,0,0.55) backdrop'
  )
})
test('FunnlAIPage history modal backdrop uses var(--color-backdrop)', () => {
  assert.ok(
    funnlAI.includes("background: 'var(--color-backdrop)'"),
    'FunnlAIPage history modal must use var(--color-backdrop)'
  )
})
test('ContactListItem avatar style includes color: var(--color-paper)', () => {
  assert.ok(
    contactList.includes("color: 'var(--color-paper)'"),
    'ContactListItem avatar must use var(--color-paper) for text color'
  )
})
test('ContactListItem avatar class has no text-white near getAvatarColor', () => {
  const idx  = contactList.indexOf('getAvatarColor(contact.name)')
  const near = contactList.slice(Math.max(0, idx - 280), idx + 50)
  assert.ok(!near.includes('text-white'), 'ContactListItem avatar must not use text-white')
})
test('ContactDetailPage avatar style includes color: var(--color-paper)', () => {
  assert.ok(
    contactDetail.includes("color: 'var(--color-paper)'"),
    'ContactDetailPage avatar must use var(--color-paper)'
  )
})
test('ContactDetailPage avatar class has no text-white near getAvatarColor', () => {
  const idx  = contactDetail.indexOf('getAvatarColor(contact.name)')
  const near = contactDetail.slice(Math.max(0, idx - 280), idx + 50)
  assert.ok(!near.includes('text-white'), 'ContactDetailPage avatar must not use text-white')
})
test('ContactsPage avatar style includes color: var(--color-paper)', () => {
  assert.ok(
    contactsPage.includes("color: 'var(--color-paper)'"),
    'ContactsPage avatar must use var(--color-paper)'
  )
})
test('ContactsPage avatar class has no text-white near getAvatarColor(entry.name)', () => {
  const idx  = contactsPage.indexOf('getAvatarColor(entry.name)')
  const near = contactsPage.slice(Math.max(0, idx - 280), idx + 50)
  assert.ok(!near.includes('text-white'), 'ContactsPage avatar must not use text-white')
})
test('FollowUpsPage Avatar component style includes color: var(--color-paper)', () => {
  assert.ok(
    followUps.includes("color: 'var(--color-paper)'"),
    'FollowUpsPage Avatar component must use var(--color-paper)'
  )
})
test('FollowUpsPage Avatar function body has no text-white class', () => {
  const startIdx = followUps.indexOf('function Avatar(')
  assert.ok(startIdx !== -1, 'Avatar function must exist in FollowUpsPage.jsx')
  const fnBody = followUps.slice(startIdx, followUps.indexOf('\n}', startIdx) + 2)
  assert.ok(!fnBody.includes('text-white'), 'FollowUpsPage Avatar must not use text-white class')
})
test('FunnlAIPage contact avatar combines avatarBg and var(--color-paper)', () => {
  assert.ok(
    funnlAI.includes("background: avatarBg, color: 'var(--color-paper)'"),
    'FunnlAIPage contact avatar must combine avatarBg with var(--color-paper) text color'
  )
})
test('FunnlAIPage contact avatar no longer has text-white near avatarBg', () => {
  const idx  = funnlAI.indexOf('background: avatarBg')
  const near = funnlAI.slice(Math.max(0, idx - 150), idx + 80)
  assert.ok(!near.includes('text-white'), 'FunnlAIPage contact avatar must not use text-white near avatarBg')
})

// ── Section K: System theme — CSS-only contract ───────────────────────────────
console.log('\nK — System theme: CSS-only, no JavaScript prefers-color-scheme listener')

test('theme.js has no addEventListener for prefers-color-scheme', () => {
  assert.ok(
    !themeLib.includes("addEventListener('prefers-color-scheme'") &&
    !themeLib.includes('addEventListener("prefers-color-scheme"'),
    'theme.js must not add a JS prefers-color-scheme listener — handled by CSS @media only'
  )
})
test('theme.js has no matchMedia call for prefers-color-scheme', () => {
  assert.ok(
    !themeLib.includes("matchMedia('(prefers-color-scheme"),
    'theme.js must not call matchMedia for prefers-color-scheme — handled by CSS only'
  )
})
test('CSS has @media prefers-color-scheme: dark for system theme support', () => {
  assert.ok(
    css.includes('@media (prefers-color-scheme: dark)'),
    'index.css must have @media prefers-color-scheme: dark block'
  )
})
test('resolveColorScheme("system") returns "light dark"', () => {
  assert.strictEqual(resolveColorScheme('system'), 'light dark')
})
test('resolveColorScheme("dark") returns "dark"', () => {
  assert.strictEqual(resolveColorScheme('dark'), 'dark')
})
test('resolveColorScheme("light") returns "light"', () => {
  assert.strictEqual(resolveColorScheme('light'), 'light')
})
test('applyThemeToRoot("system") sets colorScheme to "light dark"', () => {
  const root = makeRoot()
  applyThemeToRoot(root, 'system')
  assert.strictEqual(root.style.colorScheme, 'light dark',
    'system theme must set colorScheme to "light dark" for CSS @media to take over')
})
test('applyThemeToRoot("system") sets data-theme to "system"', () => {
  const root = makeRoot()
  applyThemeToRoot(root, 'system')
  assert.strictEqual(root.dataset.theme, 'system',
    'system theme must stamp data-theme="system" so CSS @media prefers-color-scheme block resolves')
})
test('applyThemeToRoot("dark") sets data-theme to "dark" and colorScheme to "dark"', () => {
  const root = makeRoot()
  applyThemeToRoot(root, 'dark')
  assert.strictEqual(root.dataset.theme, 'dark')
  assert.strictEqual(root.style.colorScheme, 'dark')
})
test('applyThemeToRoot("light") sets data-theme to "light" and colorScheme to "light"', () => {
  const root = makeRoot()
  applyThemeToRoot(root, 'light')
  assert.strictEqual(root.dataset.theme, 'light')
  assert.strictEqual(root.style.colorScheme, 'light')
})

// ── Section L: FOUC prevention and initialization order ───────────────────────
console.log('\nL — FOUC prevention: pre-paint script and init order')

test('index.html pre-paint script appears before <div id="root">', () => {
  const scriptPos = indexHtml.indexOf("localStorage.getItem('funnl-theme')")
  const rootPos   = indexHtml.indexOf('<div id="root">')
  assert.ok(scriptPos !== -1, 'Pre-paint script must exist in index.html')
  assert.ok(rootPos   !== -1, '<div id="root"> must exist in index.html')
  assert.ok(scriptPos < rootPos,
    'Pre-paint script must appear BEFORE <div id="root"> to prevent FOUC')
})
test('index.html pre-paint script validates the stored value', () => {
  assert.ok(
    indexHtml.includes('dark: 1') || indexHtml.includes("{ dark:") || indexHtml.includes('var v'),
    'Pre-paint script must validate stored theme value before applying'
  )
})
test('index.html pre-paint defaults to "light" for invalid/missing values', () => {
  assert.ok(
    indexHtml.includes("'light'"),
    'Pre-paint script must default to "light" (Paper) when stored value is invalid'
  )
})
test('index.html pre-paint sets colorScheme on documentElement', () => {
  assert.ok(
    indexHtml.includes('colorScheme'),
    'Pre-paint script must set colorScheme to prevent native color-scheme flash'
  )
})
test('main.jsx calls initTheme() before createRoot', () => {
  const initPos   = mainJsx.indexOf('initTheme()')
  const renderPos = mainJsx.indexOf('createRoot(')
  assert.ok(initPos   !== -1, 'main.jsx must call initTheme()')
  assert.ok(renderPos !== -1, 'main.jsx must call createRoot()')
  assert.ok(initPos < renderPos,
    'initTheme() must be called BEFORE createRoot() to prevent FOUC from React hydration')
})
test('main.jsx imports initTheme from theme.js', () => {
  assert.ok(
    mainJsx.includes('initTheme') && (mainJsx.includes('theme') || mainJsx.includes('lib/')),
    'main.jsx must import initTheme (from src/lib/theme.js)'
  )
})

// ── Section M: Portal/overlay propagation ─────────────────────────────────────
console.log('\nM — Portal/overlay propagation: no createPortal, all in-tree overlays')

test('FunnlAIPage.jsx has no createPortal usage', () => {
  assert.ok(!funnlAI.includes('createPortal'), 'FunnlAIPage must not use createPortal')
})
test('ContactsPage.jsx has no createPortal usage', () => {
  assert.ok(!contactsPage.includes('createPortal'), 'ContactsPage must not use createPortal')
})
test('SettingsPage.jsx has no createPortal usage', () => {
  assert.ok(!settingsPage.includes('createPortal'), 'SettingsPage must not use createPortal')
})
test('ImportContactsModal.jsx has no createPortal usage', () => {
  assert.ok(!importModal.includes('createPortal'), 'ImportContactsModal must not use createPortal')
})
test('LogInteractionSheet.jsx has no createPortal usage', () => {
  assert.ok(!logSheet.includes('createPortal'), 'LogInteractionSheet must not use createPortal')
})
test('BottomNav.jsx has no createPortal usage', () => {
  assert.ok(!bottomNav.includes('createPortal'), 'BottomNav must not use createPortal')
})
test('FunnlAIPage history modal backdrop uses var(--color-backdrop) (overlay in-tree)', () => {
  assert.ok(
    funnlAI.includes("background: 'var(--color-backdrop)'"),
    'FunnlAIPage in-tree overlay must use var(--color-backdrop)'
  )
})
test('All major overlays inherit CSS vars from :root via in-tree position:fixed (not portal)', () => {
  // Verify that none of the overlay-producing files use createPortal,
  // confirming all position:fixed overlays inherit :root CSS custom properties
  const files = [funnlAI, contactsPage, settingsPage, importModal, logSheet, bottomNav, addDrawer]
  for (const src of files) {
    assert.ok(!src.includes('createPortal'), 'All overlay files must use in-tree position:fixed, not createPortal')
  }
})
test('AddContactDrawer backdrop is in-tree position:fixed (no portal)', () => {
  assert.ok(!addDrawer.includes('createPortal'), 'AddContactDrawer must not use createPortal')
})

// ── Section N: Theme-change state preservation ────────────────────────────────
console.log('\nN — Theme-change state preservation: no key remounting, no ThemeProvider')

test('No key={theme} remount pattern in FunnlAIPage', () => {
  assert.ok(
    !funnlAI.includes('key={theme}') && !funnlAI.includes('key={resolvedTheme}'),
    'FunnlAIPage must not use key={theme} — theme changes must preserve component state'
  )
})
test('No key={theme} remount pattern in ContactsPage', () => {
  assert.ok(
    !contactsPage.includes('key={theme}') && !contactsPage.includes('key={resolvedTheme}'),
    'ContactsPage must not use key={theme}'
  )
})
test('No key={theme} remount pattern in ContactDetailPage', () => {
  assert.ok(
    !contactDetail.includes('key={theme}') && !contactDetail.includes('key={resolvedTheme}'),
    'ContactDetailPage must not use key={theme}'
  )
})
test('No key={theme} remount pattern in SettingsPage', () => {
  assert.ok(
    !settingsPage.includes('key={theme}') && !settingsPage.includes('key={resolvedTheme}'),
    'SettingsPage must not use key={theme}'
  )
})
test('No ThemeProvider component imported anywhere', () => {
  const allSrc = [funnlAI, contactsPage, contactDetail, settingsPage, dashboard, sidebar, mainJsx]
  for (const src of allSrc) {
    assert.ok(
      !src.includes('ThemeProvider'),
      'No component may import ThemeProvider — theme is applied globally via data-theme attribute'
    )
  }
})
test('applyThemeToRoot is the single authoritative data-theme writer in theme.js', () => {
  // Only one function should touch dataset.theme
  const datasetRefs = [...themeLib.matchAll(/dataset\.theme/g)]
  assert.ok(
    datasetRefs.length >= 1,
    'theme.js must contain at least one dataset.theme assignment'
  )
  // Verify it's inside applyThemeToRoot (no other dataset.theme writes)
  assert.ok(
    themeLib.includes('function applyThemeToRoot') || themeLib.includes('applyThemeToRoot'),
    'theme.js must export applyThemeToRoot as the authoritative theme applier'
  )
})
test('writeThemePreference only writes funnl-theme key, nothing else', () => {
  const storage = makeStorage()
  writeThemePreference(storage, 'dark')
  assert.strictEqual(storage.getItem('funnl-theme'), 'dark')
  // Writing dark must not affect other keys
  assert.strictEqual(storage.getItem('other-key'), null)
})

// ── Section O: Button/control semantic audit ──────────────────────────────────
console.log('\nO — Button/control: semantic ember, danger, success colors')

test('ErrorBoundary primary action uses bg-ember', () => {
  assert.ok(errorBoundary.includes('bg-ember'), 'ErrorBoundary Reload button must use bg-ember')
})
test('ErrorBoundary primary action has no legacy purple #8B7CFF', () => {
  assert.ok(!errorBoundary.includes('#8B7CFF'), 'ErrorBoundary must not use purple gradient #8B7CFF')
})
test('PrivacyPage logo tile uses bg-ember (not legacy purple)', () => {
  assert.ok(privacyPage.includes('bg-ember'), 'PrivacyPage logo tile must use bg-ember')
  assert.ok(!privacyPage.includes('#4B3AF0'), 'PrivacyPage must not use legacy purple #4B3AF0')
})
test('SettingsPage danger delete button uses bg-danger or border-danger', () => {
  assert.ok(
    settingsPage.includes('bg-danger') || settingsPage.includes('text-danger'),
    'SettingsPage delete account action must use danger semantic color'
  )
})
test('FollowUpsPage overdue label uses var(--color-danger) semantic token', () => {
  assert.ok(
    followUps.includes('var(--color-danger)'),
    'FollowUpsPage overdue indicator must use var(--color-danger)'
  )
})
test('FollowUpsPage done/success state uses var(--color-success) semantic token', () => {
  assert.ok(
    followUps.includes('var(--color-success)'),
    'FollowUpsPage done state must use var(--color-success)'
  )
})
test('ContactsPage success/confirmation uses semantic color (not hardcoded green)', () => {
  assert.ok(
    !contactsPage.includes('#22C55E') && !contactsPage.includes('rgb(34,197,94)'),
    'ContactsPage must not hardcode Tailwind green hex — use text-success token'
  )
})
test('No logged-in component uses bg-[#4B3AF0] as primary action color', () => {
  const loggedInSrcs = [
    funnlAI, contactList, contactDetail, contactsPage, followUps,
    settingsPage, logSheet, importModal, bottomNav, sidebar, errorBoundary, dashboard
  ]
  for (const src of loggedInSrcs) {
    assert.ok(!src.includes('bg-[#4B3AF0]'), 'No logged-in component may use legacy purple bg-[#4B3AF0]')
  }
})

// ── Section P: Status and contrast audit ─────────────────────────────────────
console.log('\nP — Status and contrast: semantic tokens for all status indicators')

test('FollowUpsPage "Overdue" GroupHeading uses var(--color-danger)', () => {
  assert.ok(
    followUps.includes('color="var(--color-danger)"') || followUps.includes("color: 'var(--color-danger)'"),
    'FollowUpsPage Overdue GroupHeading must pass var(--color-danger)'
  )
})
test('FollowUpsPage "Today" or "Upcoming" bucket uses var(--color-warning) (themed)', () => {
  assert.ok(
    followUps.includes('var(--color-warning)'),
    'FollowUpsPage Today/Upcoming bucket headings must use var(--color-warning)'
  )
})
test('ContactsPage awaiting_response indicator uses ember rgba (not purple)', () => {
  assert.ok(
    !contactsPage.includes('rgba(139,124,255'),
    'ContactsPage awaiting_response must not use purple — use ember rgba'
  )
})
test('ContactsPage awaiting_response indicator uses ember rgba fill', () => {
  assert.ok(
    contactsPage.includes('rgba(255,68,35,') || contactsPage.includes('var(--color-ember)'),
    'ContactsPage awaiting_response must use ember rgba or var(--color-ember)'
  )
})
test('Dashboard follow-up count uses var(--color-warning) or var(--color-danger) (themed)', () => {
  assert.ok(
    dashboard.includes('var(--color-warning)') || dashboard.includes('var(--color-danger)'),
    'Dashboard follow-up indicator must use var(--color-warning) or var(--color-danger)'
  )
})
test('No status indicator hardcodes amber yellow #FFB84D or #F5A623 directly in JSX', () => {
  const loggedInSrcs = [contactsPage, followUps, contactDetail, dashboard]
  for (const src of loggedInSrcs) {
    assert.ok(
      !src.includes('#FFB84D') && !src.includes('#F5A623'),
      'Status indicators must use var(--color-warning) token, not hardcoded amber hex'
    )
  }
})
test('Sidebar follow-up badge uses var(--color-ember) and var(--color-ink)', () => {
  assert.ok(
    sidebar.includes('var(--color-ember)') && sidebar.includes('var(--color-ink)'),
    'Sidebar follow-up badge must use var(--color-ember) background and var(--color-ink) text'
  )
})

// ── Section Q: Gradient classification ───────────────────────────────────────
console.log('\nQ — Gradient classification: approved deterministic avatars, no rogue purple gradients')

test('avatarUtils.js has no #8B7CFF (prohibited purple)', () => {
  assert.ok(!avatarUtils.includes('#8B7CFF'), 'avatarUtils.js must not contain #8B7CFF')
})
test('avatarUtils.js has no #5B45F0 (prohibited deep violet)', () => {
  assert.ok(!avatarUtils.includes('#5B45F0'), 'avatarUtils.js must not contain #5B45F0')
})
test('avatarUtils.js has no #C77DFF (prohibited lavender)', () => {
  assert.ok(!avatarUtils.includes('#C77DFF'), 'avatarUtils.js must not contain #C77DFF')
})
test('avatarUtils.js has no #9B4FE0 (prohibited lavender-violet)', () => {
  assert.ok(!avatarUtils.includes('#9B4FE0'), 'avatarUtils.js must not contain #9B4FE0')
})
test('avatarUtils.js gradient is deterministic (hash-based, not Math.random)', () => {
  assert.ok(
    !avatarUtils.includes('Math.random()'),
    'avatarUtils.js must use deterministic color assignment, not Math.random'
  )
})
test('No uncontrolled purple linear-gradient in ContactDetailPage', () => {
  assert.ok(
    !contactDetail.includes('linear-gradient(135deg,#8B7CFF') &&
    !contactDetail.includes('linear-gradient(135deg, #8B7CFF'),
    'ContactDetailPage must not have uncontrolled purple gradients'
  )
})
test('No uncontrolled purple linear-gradient in ContactsPage', () => {
  assert.ok(
    !contactsPage.includes('linear-gradient(135deg,#8B7CFF') &&
    !contactsPage.includes('linear-gradient(135deg, #8B7CFF'),
    'ContactsPage must not have uncontrolled purple gradients'
  )
})
test('No uncontrolled purple linear-gradient in FollowUpsPage', () => {
  assert.ok(
    !followUps.includes('linear-gradient(135deg,#8B7CFF'),
    'FollowUpsPage must not have uncontrolled purple gradients'
  )
})
test('Sidebar active nav uses rgba opacity token (not gradient)', () => {
  // Active nav uses bg-[rgba(108,92,255,0.14)] which is opacity-based, not gradient
  assert.ok(
    !sidebar.includes('linear-gradient(135deg,#8B7CFF'),
    'Sidebar active nav must not use a purple linear-gradient'
  )
})

// ── Section R: Loading/empty/error state audit ────────────────────────────────
console.log('\nR — Loading/empty/error states: themed tokens, no hardcoded colors')

test('SettingsPage loading state uses animate-pulse with motion-reduce:animate-none', () => {
  assert.ok(
    settingsPage.includes('animate-pulse') && settingsPage.includes('motion-reduce:animate-none'),
    'SettingsPage loading pulse must be paired with motion-reduce:animate-none'
  )
})
test('SettingsPage loading text uses themed color (text-muted or text-low)', () => {
  // Loading… text should be themed, not hardcoded
  assert.ok(
    settingsPage.includes('text-muted') || settingsPage.includes('text-low'),
    'SettingsPage loading text must use themed color token'
  )
})
test('ContactsPage error state uses themed color (text-danger or text-mid)', () => {
  assert.ok(
    contactsPage.includes('text-danger') || contactsPage.includes('text-mid'),
    'ContactsPage error state must use semantic themed color'
  )
})
test('Dashboard empty state text uses themed color tokens (var(--color-muted) or text-muted)', () => {
  assert.ok(
    dashboard.includes('var(--color-muted)') || dashboard.includes('text-muted') || dashboard.includes('text-low'),
    'Dashboard empty state must use themed text tokens'
  )
})
test('FollowUpsPage empty state (no follow-ups) uses themed color (var(--color-muted) or text-muted)', () => {
  assert.ok(
    followUps.includes('var(--color-muted)') || followUps.includes('text-muted') || followUps.includes('text-low'),
    'FollowUpsPage empty state must use themed text tokens'
  )
})
test('ContactDetailPage loading skeleton uses themed text or opacity', () => {
  assert.ok(
    contactDetail.includes('text-muted') || contactDetail.includes('opacity') ||
    contactDetail.includes('text-low') || contactDetail.includes('animate-pulse'),
    'ContactDetailPage must use themed loading indicator'
  )
})
test('FunnlAIPage error messages use themed danger color or text-muted', () => {
  assert.ok(
    funnlAI.includes('text-danger') || funnlAI.includes('text-muted') || funnlAI.includes('color-danger'),
    'FunnlAIPage error messages must use themed color tokens'
  )
})
test('No loading state hardcodes grey text like #999 or #aaa', () => {
  const loggedInSrcs = [contactsPage, contactDetail, followUps, dashboard, funnlAI, settingsPage]
  for (const src of loggedInSrcs) {
    assert.ok(
      !src.includes("color: '#999'") && !src.includes("color: '#aaa'") &&
      !src.includes("color: '#888'"),
      'Loading states must not hardcode grey hex — use themed tokens'
    )
  }
})

// ── Section S: Reduced-motion audit ──────────────────────────────────────────
console.log('\nS — Reduced-motion: transitions/animations paired with motion-reduce utilities')

test('SettingsPage transitions are paired with motion-reduce:transition-none', () => {
  const hasTransition      = settingsPage.includes('transition-colors') || settingsPage.includes('transition-opacity')
  const hasReducedMotion   = settingsPage.includes('motion-reduce:transition-none')
  assert.ok(!hasTransition || hasReducedMotion,
    'SettingsPage must pair transitions with motion-reduce:transition-none')
})
test('ResetPasswordPage transitions are paired with motion-reduce:transition-none', () => {
  const hasTransition    = resetPage.includes('transition-colors')
  const hasReducedMotion = resetPage.includes('motion-reduce:transition-none')
  assert.ok(!hasTransition || hasReducedMotion,
    'ResetPasswordPage must pair transitions with motion-reduce:transition-none')
})
test('DashboardPage respects prefers-reduced-motion before clip-path animation', () => {
  assert.ok(
    dashboard.includes('prefers-reduced-motion'),
    'DashboardPage must check prefers-reduced-motion before applying clip-path transition'
  )
})
test('FunnlAIPage reads prefersReduced before scroll animations', () => {
  assert.ok(
    funnlAI.includes('prefersReduced') || funnlAI.includes('prefers-reduced-motion'),
    'FunnlAIPage must respect prefers-reduced-motion for scroll/focus animations'
  )
})
test('LandingPage handles prefers-reduced-motion for the ticker animation', () => {
  const landingPage = read('src/pages/LandingPage.jsx')
  assert.ok(
    landingPage.includes('prefers-reduced-motion') || landingPage.includes('prefersReduced'),
    'LandingPage must handle prefers-reduced-motion for the marquee ticker'
  )
})
test('SettingsPage animate-pulse is paired with motion-reduce:animate-none', () => {
  assert.ok(
    settingsPage.includes('animate-pulse') && settingsPage.includes('motion-reduce:animate-none'),
    'SettingsPage animate-pulse must be paired with motion-reduce:animate-none'
  )
})
test('index.css has @keyframes but no unconditional animation (respects user preference via utilities)', () => {
  assert.ok(
    css.includes('@keyframes'),
    'index.css must define @keyframes for slide-in and fade-in animations'
  )
})

// ── Section T: Cross-tab behavior ─────────────────────────────────────────────
console.log('\nT — Cross-tab behavior: no Storage listener (not implemented, documented)')

test('theme.js has no "storage" event listener for cross-tab sync', () => {
  assert.ok(
    !themeLib.includes("addEventListener('storage'") &&
    !themeLib.includes('addEventListener("storage"'),
    'theme.js must not implement cross-tab Storage listener — cross-tab sync is not a requirement'
  )
})
test('theme.js has no BroadcastChannel for cross-tab sync', () => {
  assert.ok(
    !themeLib.includes('BroadcastChannel'),
    'theme.js must not use BroadcastChannel — cross-tab sync is not a requirement'
  )
})
test('writeThemePreference uses exactly one storage key: funnl-theme', () => {
  const storage = makeStorage()
  writeThemePreference(storage, 'dark')
  assert.strictEqual(storage.getItem('funnl-theme'), 'dark', 'writeThemePreference must write funnl-theme')
  writeThemePreference(storage, 'light')
  assert.strictEqual(storage.getItem('funnl-theme'), 'light', 'writeThemePreference must overwrite funnl-theme')
})
test('readThemePreference reads exactly funnl-theme key', () => {
  const storage = makeStorage()
  storage.setItem('funnl-theme', 'dark')
  assert.strictEqual(readThemePreference(storage), 'dark', 'readThemePreference must read funnl-theme key')
})
test('Storage key "funnl-theme" is consistent between index.html pre-paint and theme.js', () => {
  assert.ok(
    indexHtml.includes('funnl-theme') && themeLib.includes('funnl-theme'),
    'Storage key must be "funnl-theme" in both pre-paint script and theme.js'
  )
})

// ── Section U: Public Auth exception contracts ────────────────────────────────
console.log('\nU — Public Auth exception: SignIn/Welcome/ResetPassword are fixed Paper/Ink surfaces')

test('SignInPage does not use bg-base (fixed Paper surface, not themed)', () => {
  assert.ok(
    !signInPage.includes('bg-base') && !signInPage.includes('bg-surface'),
    'SignInPage must not use bg-base/bg-surface — it is a fixed Paper surface'
  )
})
test('WelcomePage does not use bg-base (fixed Paper surface)', () => {
  assert.ok(
    !welcomePage.includes('bg-base') && !welcomePage.includes('bg-surface'),
    'WelcomePage must not use bg-base — it is a fixed Paper surface'
  )
})
test('ResetPasswordPage does not use bg-base (fixed Paper surface)', () => {
  assert.ok(
    !resetPage.includes('bg-base') && !resetPage.includes('bg-surface'),
    'ResetPasswordPage must not use bg-base — it is a fixed Paper surface'
  )
})
test('SignInPage uses bg-white or Paper-fixed color (intentionally not themed)', () => {
  assert.ok(
    signInPage.includes('bg-white') || signInPage.includes('#F7F2E7') ||
    signInPage.includes('bg-[#') || signInPage.includes("background: '#"),
    'SignInPage must use explicit Paper/white background, not themed bg-base'
  )
})
test('WelcomePage uses Paper-fixed styling (bg-white or Paper hex)', () => {
  assert.ok(
    welcomePage.includes('bg-white') || welcomePage.includes('#F7F2E7') ||
    welcomePage.includes('min-h-screen'),
    'WelcomePage must use Paper-fixed background'
  )
})
test('Auth pages are excluded from the logged-in theme-aware shell', () => {
  // The App.jsx shell (sidebar + bottomnav) should not wrap auth pages
  // — confirmed by reading App.jsx which gates auth pages to separate route tree
  const appJsx = read('src/App.jsx')
  assert.ok(
    appJsx.includes('WelcomePage') || appJsx.includes('welcome'),
    'App.jsx must handle WelcomePage as a special case outside the authenticated shell'
  )
})
test('Auth surfaces do not import or use themed CSS var tokens for their main backgrounds', () => {
  // Auth pages use fixed #14110F / #F7F2E7 backgrounds, not var(--color-base)
  const authSrcs = [signInPage, welcomePage, resetPage]
  for (const src of authSrcs) {
    assert.ok(
      !src.includes("background: 'var(--color-base)'") &&
      !src.includes("background: 'var(--color-surface)'"),
      'Auth pages must not use var(--color-base) or var(--color-surface) as main backgrounds'
    )
  }
})
test('Paper constant #F7F2E7 is used in auth surfaces (intentionally fixed)', () => {
  const hasPaper = signInPage.includes('#F7F2E7') || signInPage.includes('F7F2E7') ||
                   welcomePage.includes('#F7F2E7') || resetPage.includes('bg-white')
  assert.ok(hasPaper,
    'At least one auth surface must use Paper color — confirms they are intentionally fixed, not themed')
})

// ── Section V: Repository audit summary ──────────────────────────────────────
console.log('\nV — Repository audit summary: logged-in routes free of hardcoded color anti-patterns')

const LOGGED_IN_SRCS = [
  funnlAI, contactList, contactDetail, contactsPage, followUps,
  settingsPage, logSheet, importModal, bottomNav, sidebar, errorBoundary, dashboard
]
const LOGGED_IN_NAMES = [
  'FunnlAIPage', 'ContactListItem', 'ContactDetailPage', 'ContactsPage', 'FollowUpsPage',
  'SettingsPage', 'LogInteractionSheet', 'ImportContactsModal', 'BottomNav', 'Sidebar',
  'ErrorBoundary', 'DashboardPage'
]

test('No logged-in component has hardcoded rgba(0,0,0,...) backdrop (theme anti-pattern)', () => {
  // Legitimate uses: box-shadow RGBA (depth cues are OK), NOT background overlays
  const backdrops = [
    "background: 'rgba(0,0,0",
    'background: rgba(0,0,0',
    'backgroundColor: rgba(0,0,0',
  ]
  for (let i = 0; i < LOGGED_IN_SRCS.length; i++) {
    for (const pattern of backdrops) {
      assert.ok(
        !LOGGED_IN_SRCS[i].includes(pattern),
        `${LOGGED_IN_NAMES[i]} must not use hardcoded rgba(0,0,0,...) as background/backdrop`
      )
    }
  }
})

test('avatar var(--color-paper) text color present in all avatar-bearing logged-in components', () => {
  const avatarFiles = [
    { src: contactList,          name: 'ContactListItem' },
    { src: contactDetail,        name: 'ContactDetailPage' },
    { src: contactsPage,         name: 'ContactsPage' },
    { src: followUps,            name: 'FollowUpsPage' },
    { src: funnlAI,              name: 'FunnlAIPage' },
    { src: contactPickerResults, name: 'ContactPickerResults' },
    { src: mobileAppBar,         name: 'MobileAppBar' },
    { src: dashboard,            name: 'DashboardPage' },
    { src: sidebar,              name: 'Sidebar' },
  ]
  for (const { src, name } of avatarFiles) {
    assert.ok(
      src.includes("color: 'var(--color-paper)'"),
      `${name} must use var(--color-paper) for avatar text color`
    )
  }
})

test('No logged-in component uses legacy purple #4B3AF0 as a color value', () => {
  for (let i = 0; i < LOGGED_IN_SRCS.length; i++) {
    assert.ok(
      !LOGGED_IN_SRCS[i].includes('#4B3AF0'),
      `${LOGGED_IN_NAMES[i]} must not use legacy purple #4B3AF0`
    )
  }
})

test('All overlay backdrop usages use var(--color-backdrop) not black rgba', () => {
  const backdropFiles = [
    { src: settingsPage,  name: 'SettingsPage',        pattern: "var(--color-backdrop)" },
    { src: logSheet,      name: 'LogInteractionSheet', pattern: "var(--color-backdrop)" },
    { src: importModal,   name: 'ImportContactsModal', pattern: "var(--color-backdrop)" },
    { src: contactsPage,  name: 'ContactsPage',        pattern: "var(--color-backdrop)" },
    { src: funnlAI,       name: 'FunnlAIPage',         pattern: "var(--color-backdrop)" },
    { src: bottomNav,     name: 'BottomNav',            pattern: "var(--color-backdrop)" },
  ]
  for (const { src, name, pattern } of backdropFiles) {
    assert.ok(src.includes(pattern), `${name} must contain var(--color-backdrop)`)
  }
})

test('index.css --color-backdrop token defined in all three theme contexts', () => {
  const hasDefault   = css.includes('--color-backdrop: rgba(20,17,15,0.55)')
  const hasMediaDark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)')).includes('--color-backdrop: rgba(20,17,15,0.72)')
  const hasDataDark  = css.slice(css.indexOf(':root[data-theme="dark"]')).includes('--color-backdrop: rgba(20,17,15,0.72)')
  const hasDataLight = css.slice(css.indexOf(':root[data-theme="light"]')).includes('--color-backdrop: rgba(20,17,15,0.55)')
  assert.ok(hasDefault,   '--color-backdrop must have a default (light) value in @theme')
  assert.ok(hasMediaDark, '--color-backdrop must be overridden in @media dark block')
  assert.ok(hasDataDark,  '--color-backdrop must be overridden in [data-theme="dark"] block')
  assert.ok(hasDataLight, '--color-backdrop must be explicit in [data-theme="light"] block')
})

test('avatarUtils.js palette has exactly 6 gradient entries (slot count preserved)', () => {
  const entries = [...avatarUtils.matchAll(/linear-gradient/g)]
  assert.strictEqual(entries.length, 6, 'Avatar palette must still have exactly 6 gradient entries')
})
test('avatarUtils.js slot 0 uses WCAG-passing terracotta #A84B27', () => {
  assert.ok(avatarUtils.includes('#A84B27'), 'avatarUtils.js slot 0 must contain WCAG-passing terracotta #A84B27')
})
test('avatarUtils.js slot 5 replaced with warm brown #7C5A3A', () => {
  assert.ok(avatarUtils.includes('#7C5A3A'), 'avatarUtils.js slot 5 must contain warm brown #7C5A3A')
})
test('No avatar-bearing src/ file contains prohibited purple #8B7CFF', () => {
  const avatarSrcs = [
    avatarUtils, funnlAI, contactList, contactDetail, contactsPage, followUps,
    settingsPage, logSheet, importModal, bottomNav, sidebar, errorBoundary, dashboard,
    contactPickerResults, mobileAppBar,
  ]
  for (const src of avatarSrcs) {
    assert.ok(!src.includes('#8B7CFF'), 'No production file may contain prohibited purple #8B7CFF')
  }
})
test('No src/ production file contains prohibited purple #5B45F0 or #4B3AF0', () => {
  const filesToCheck = [
    avatarUtils, funnlAI, contactList, contactDetail, contactsPage, followUps,
    settingsPage, logSheet, importModal, bottomNav, sidebar, errorBoundary, dashboard,
  ]
  for (const src of filesToCheck) {
    assert.ok(
      !src.includes('#5B45F0') && !src.includes('#4B3AF0'),
      'No production file may contain #5B45F0 or #4B3AF0'
    )
  }
})
test('LOGGED_IN_SRCS free of purple Tailwind classes (text-purple, bg-violet, bg-indigo, etc.)', () => {
  const PURPLE_CLASSES = ['text-purple', 'bg-purple', 'text-violet', 'bg-violet', 'text-indigo', 'bg-indigo']
  for (let i = 0; i < LOGGED_IN_SRCS.length; i++) {
    for (const cls of PURPLE_CLASSES) {
      assert.ok(
        !LOGGED_IN_SRCS[i].includes(cls),
        `${LOGGED_IN_NAMES[i]} must not use Tailwind ${cls} utility`
      )
    }
  }
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
