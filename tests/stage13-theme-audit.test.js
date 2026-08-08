// Stage 13 — Application-Wide Dark Theme and System Theme Audit
// Source-contract tests: no browser, no React, no Supabase.
// All checks read raw source files, so if a regression is introduced the test fails.
// Run with: node tests/stage13-theme-audit.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

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

const css = read('src/index.css')
const privacyPage   = read('src/pages/PrivacyPage.jsx')
const errorBoundary = read('src/components/ErrorBoundary.jsx')
const contactsPage  = read('src/pages/ContactsPage.jsx')
const settingsPage  = read('src/pages/SettingsPage.jsx')
const logSheet      = read('src/components/LogInteractionSheet.jsx')
const bottomNav     = read('src/components/BottomNav.jsx')
const importModal   = read('src/components/ImportContactsModal.jsx')

// ── Section A: CSS token values — light (Paper default) ──────────────────────
console.log('\nA — Light (Paper) token values in @theme')

test('light base = #F7F2E7', () => {
  assert.ok(css.includes('--color-base:     #F7F2E7'), 'Light --color-base must be #F7F2E7')
})
test('light card = #FFFFFF', () => {
  assert.ok(css.includes('--color-card:     #FFFFFF'), 'Light --color-card must be #FFFFFF')
})
test('light elevated = #F0EBD6', () => {
  assert.ok(css.includes('--color-elevated: #F0EBD6'), 'Light --color-elevated must be #F0EBD6')
})
test('light input = #FFFFFF (explicit block)', () => {
  assert.ok(css.includes("--color-input:    #FFFFFF"), 'Light --color-input must be #FFFFFF')
})
test('light hi = #14110F', () => {
  assert.ok(css.includes('--color-hi:    #14110F'), 'Light --color-hi must be #14110F')
})
test('light mid = #52504B', () => {
  assert.ok(css.includes('--color-mid:   #52504B'), 'Light --color-mid must be #52504B')
})
test('light ember = #FF4423', () => {
  assert.ok(css.includes('--color-ember:      #FF4423'), 'Light --color-ember must be #FF4423')
})
test('light line-1 = rgba(20,17,15,0.08)', () => {
  assert.ok(css.includes('--color-line-1:   rgba(20,17,15,0.08)'), 'Light --color-line-1 must be 0.08 ink')
})
test('light line-2 = rgba(20,17,15,0.10)', () => {
  assert.ok(css.includes('--color-line-2:   rgba(20,17,15,0.10)'), 'Light --color-line-2 must be 0.10 ink')
})
test('light line-3 = rgba(20,17,15,0.15)', () => {
  assert.ok(css.includes('--color-line-3:   rgba(20,17,15,0.15)'), 'Light --color-line-3 must be 0.15 ink')
})
test('light backdrop token present', () => {
  assert.ok(css.includes('--color-backdrop: rgba(20,17,15,0.55)'), 'Light --color-backdrop must be rgba(20,17,15,0.55)')
})

// ── Section B: CSS token values — dark (Night) ────────────────────────────────
console.log('\nB — Dark (Night) token values in both dark blocks')

test('dark base = #14110F (media block)', () => {
  const mediaBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.ok(mediaBlock.includes('--color-base:     #14110F'), 'Dark --color-base must be #14110F in media block')
})
test('dark card = #1C1815 (media block)', () => {
  const mediaBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.ok(mediaBlock.includes('--color-card:     #1C1815'), 'Dark --color-card must be #1C1815 in media block')
})
test('dark elevated = #241F1B (media block)', () => {
  const mediaBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.ok(mediaBlock.includes('--color-elevated: #241F1B'), 'Dark --color-elevated must be #241F1B in media block')
})
test('dark input = #241F1B (elevated, not card) — media block', () => {
  const mediaBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.ok(mediaBlock.includes('--color-input:    #241F1B'),
    'Dark --color-input must be #241F1B (elevated level) in media block')
  assert.ok(!mediaBlock.includes('--color-input:    #1C1815'),
    'Dark --color-input must NOT be #1C1815 (card level) in media block')
})
test('dark input = #241F1B — [data-theme="dark"] block', () => {
  const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'))
  assert.ok(darkBlock.includes('--color-input:    #241F1B'),
    'Dark --color-input must be #241F1B in [data-theme="dark"] block')
})
test('dark hi = #F7F2E7 (media block)', () => {
  const mediaBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.ok(mediaBlock.includes('--color-hi:       #F7F2E7'), 'Dark --color-hi must be #F7F2E7 in media block')
})
test('dark line-1 uses paper RGBA (media block)', () => {
  const mediaBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.ok(mediaBlock.includes('--color-line-1:   rgba(247,242,231,0.08)'), 'Dark line-1 must be paper-based')
})
test('dark backdrop token in media block', () => {
  const mediaBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.ok(mediaBlock.includes('--color-backdrop: rgba(20,17,15,0.72)'), 'Media block must override --color-backdrop to 0.72')
})
test('dark backdrop token in [data-theme="dark"] block', () => {
  const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'))
  assert.ok(darkBlock.includes('--color-backdrop: rgba(20,17,15,0.72)'), '[data-theme="dark"] must override --color-backdrop to 0.72')
})
test('light backdrop override in [data-theme="light"] block', () => {
  const lightBlock = css.slice(css.indexOf(':root[data-theme="light"]'))
  assert.ok(lightBlock.includes('--color-backdrop: rgba(20,17,15,0.55)'), '[data-theme="light"] must set --color-backdrop to 0.55')
})

// ── Section C: Native controls — date + datetime-local color-scheme ───────────
console.log('\nC — Native date/datetime-local controls: color-scheme')

test('date input gets color-scheme: light by default', () => {
  assert.ok(css.includes('input[type="date"]') && css.includes('color-scheme: light'), 'date input must default to color-scheme: light')
})
test('datetime-local input gets color-scheme: light by default', () => {
  assert.ok(css.includes('input[type="datetime-local"]') && css.includes('color-scheme: light'),
    'datetime-local must also have a color-scheme: light default')
})
test('datetime-local gets dark override in media query', () => {
  const mediaBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.ok(mediaBlock.includes('input[type="datetime-local"]') && mediaBlock.includes('color-scheme: dark'),
    'datetime-local must get color-scheme: dark in @media prefers-color-scheme: dark')
})
test('[data-theme="dark"] overrides datetime-local to dark', () => {
  const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'))
  assert.ok(darkBlock.includes('input[type="datetime-local"]') && darkBlock.includes('color-scheme: dark'),
    '[data-theme="dark"] must override datetime-local color-scheme to dark')
})
test('[data-theme="light"] pins datetime-local to light', () => {
  const lightBlock = css.slice(css.indexOf(':root[data-theme="light"]'))
  assert.ok(lightBlock.includes('input[type="datetime-local"]') && lightBlock.includes('color-scheme: light'),
    '[data-theme="light"] must explicitly set datetime-local color-scheme to light')
})
test('date and datetime-local rules are symmetrical (both present in all theme blocks)', () => {
  const blocks = [
    css.slice(css.indexOf('@media (prefers-color-scheme: dark)')),
    css.slice(css.indexOf(':root[data-theme="dark"]')),
    css.slice(css.indexOf(':root[data-theme="light"]')),
  ]
  for (const block of blocks) {
    assert.ok(block.includes('input[type="date"]'), 'date must appear in all three theme override blocks')
    assert.ok(block.includes('input[type="datetime-local"]'), 'datetime-local must appear in all three theme override blocks')
  }
})

// ── Section D: No legacy purple — source contracts ───────────────────────────
console.log('\nD — Legacy purple removed from source files')

test('index.css has no old purple #4B3AF0', () => {
  assert.ok(!css.includes('#4B3AF0'), 'index.css must not contain legacy purple #4B3AF0')
})
test('index.css has no old purple #8B7CFF', () => {
  assert.ok(!css.includes('#8B7CFF'), 'index.css must not contain legacy purple #8B7CFF')
})
test('index.css has no old purple #5B45F0', () => {
  assert.ok(!css.includes('#5B45F0'), 'index.css must not contain legacy purple #5B45F0')
})
test('index.css has no rgba(139,124,255,...)', () => {
  assert.ok(!css.includes('rgba(139,124,255'), 'index.css must not contain purple rgba(139,124,255,...)')
})
test('PrivacyPage has no legacy purple logo #4B3AF0', () => {
  assert.ok(!privacyPage.includes('#4B3AF0'), 'PrivacyPage must not contain legacy purple #4B3AF0')
})
test('PrivacyPage has no purple logo shadow rgba(75,58,240,...)', () => {
  assert.ok(!privacyPage.includes('rgba(75,58,240'), 'PrivacyPage must not have old purple shadow')
})
test('PrivacyPage logo tile uses bg-ember', () => {
  assert.ok(privacyPage.includes('bg-ember'), 'PrivacyPage logo tile must use bg-ember')
})
test('PrivacyPage notice box has no purple rgba(139,124,255,...)', () => {
  assert.ok(!privacyPage.includes('rgba(139,124,255'), 'PrivacyPage notice box must not use purple')
})
test('PrivacyPage notice box uses themed token (bg-elevated or border-line)', () => {
  assert.ok(
    privacyPage.includes('bg-elevated') || privacyPage.includes('border-line-1'),
    'PrivacyPage notice box must use bg-elevated or border-line-1 for theming'
  )
})
test('ErrorBoundary Reload button has no purple gradient #8B7CFF / #5B45F0', () => {
  assert.ok(!errorBoundary.includes('#8B7CFF') && !errorBoundary.includes('#5B45F0'),
    'ErrorBoundary Reload button must not use purple gradient')
})
test('ErrorBoundary Reload button uses bg-ember', () => {
  assert.ok(errorBoundary.includes('bg-ember'), 'ErrorBoundary Reload button must use bg-ember')
})
test('ContactsPage awaiting_response badge has no purple rgba(139,124,255,...)', () => {
  assert.ok(!contactsPage.includes('rgba(139,124,255'), 'ContactsPage must not use purple badge fill')
})
test('ContactsPage awaiting_response badge uses ember rgba fill', () => {
  assert.ok(contactsPage.includes('rgba(255,68,35,0.10)') || contactsPage.includes('rgba(255,68,35,'),
    'ContactsPage awaiting_response badge must use ember rgba fill')
})

// ── Section E: Backdrop token — source contracts ──────────────────────────────
console.log('\nE — var(--color-backdrop) used for overlay scrims')

test('SettingsPage delete-all backdrop uses --color-backdrop token', () => {
  assert.ok(settingsPage.includes("var(--color-backdrop)"),
    'SettingsPage backdrop must use var(--color-backdrop)')
})
test('SettingsPage no longer uses bg-black/50 for overlays', () => {
  assert.ok(!settingsPage.includes('bg-black/50'),
    'SettingsPage must not use bg-black/50 for dialog backdrops')
})
test('LogInteractionSheet backdrop uses --color-backdrop token', () => {
  assert.ok(logSheet.includes("var(--color-backdrop)"),
    'LogInteractionSheet backdrop must use var(--color-backdrop)')
})
test('LogInteractionSheet no hardcoded rgba(0,0,0,0.45)', () => {
  assert.ok(!logSheet.includes('rgba(0,0,0,0.45)'),
    'LogInteractionSheet must not hardcode rgba(0,0,0,0.45)')
})
test('ImportContactsModal outer backdrop uses --color-backdrop', () => {
  assert.ok(importModal.includes("var(--color-backdrop)"),
    'ImportContactsModal outer backdrop must use var(--color-backdrop)')
})
test('ContactsPage delete modal backdrop uses --color-backdrop', () => {
  assert.ok(contactsPage.includes("var(--color-backdrop)"),
    'ContactsPage delete modal must use var(--color-backdrop)')
})
test('BottomNav sheet backdrop uses --color-backdrop token', () => {
  assert.ok(bottomNav.includes("var(--color-backdrop)"),
    'BottomNav sheet backdrop must use var(--color-backdrop)')
})

// ── Section F: BottomNav tab color — CSS var, not hardcoded hex ───────────────
console.log('\nF — BottomNav tabColor uses CSS custom properties')

test('tabColor returns var(--color-ember) for active state', () => {
  assert.ok(bottomNav.includes("var(--color-ember)"),
    'BottomNav tabColor must return var(--color-ember) for active')
})
test('tabColor returns var(--color-low) for inactive state', () => {
  assert.ok(bottomNav.includes("var(--color-low)"),
    'BottomNav tabColor must return var(--color-low) for inactive')
})
test('BottomNav tabColor does not hardcode #FF4423 for active', () => {
  // Allow #FF4423 in focus-visible outlines (those are explicit ember for browser override),
  // but the tabColor function must not use it for the tab icon/label colors.
  const tabColorFnMatch = bottomNav.match(/const tabColor[^}]+}/)
  const fn = tabColorFnMatch ? tabColorFnMatch[0] : ''
  assert.ok(!fn.includes('#FF4423'),
    'tabColor function must not hardcode #FF4423; use var(--color-ember) instead')
})
test('BottomNav tabColor does not hardcode #8C857A for inactive', () => {
  const tabColorFnMatch = bottomNav.match(/const tabColor[^}]+}/)
  const fn = tabColorFnMatch ? tabColorFnMatch[0] : ''
  assert.ok(!fn.includes('#8C857A'),
    'tabColor function must not hardcode #8C857A; use var(--color-low) instead')
})
test('BottomNav badge uses var(--color-ember) for background', () => {
  assert.ok(bottomNav.includes("background: 'var(--color-ember)'") || bottomNav.includes("var(--color-ember)"),
    'BottomNav follow-up badge must use var(--color-ember) background')
})
test('BottomNav badge uses var(--color-ink) for text', () => {
  assert.ok(bottomNav.includes("var(--color-ink)"),
    'BottomNav badge text must use var(--color-ink)')
})

// ── Section G: ImportContactsModal C object uses CSS vars ─────────────────────
console.log('\nG — ImportContactsModal C object uses CSS custom properties')

test('C.bg uses var(--color-base)', () => {
  assert.ok(importModal.includes("bg:          'var(--color-base)'") || importModal.includes("bg: 'var(--color-base)'"),
    'C.bg must use var(--color-base)')
})
test('C.ink uses var(--color-hi)', () => {
  assert.ok(importModal.includes("'var(--color-hi)'"),
    'C.ink must use var(--color-hi)')
})
test('C.inkMid uses var(--color-mid)', () => {
  assert.ok(importModal.includes("'var(--color-mid)'"),
    'C.inkMid must use var(--color-mid)')
})
test('C.inkLow uses var(--color-low)', () => {
  assert.ok(importModal.includes("'var(--color-low)'"),
    'C.inkLow must use var(--color-low)')
})
test('C.inkLower uses var(--color-lower)', () => {
  assert.ok(importModal.includes("'var(--color-lower)'"),
    'C.inkLower must use var(--color-lower)')
})
test('C.border uses var(--color-line-2)', () => {
  assert.ok(importModal.includes("'var(--color-line-2)'"),
    'C.border must use var(--color-line-2)')
})
test('C.ember uses var(--color-ember)', () => {
  assert.ok(importModal.includes("ember:       'var(--color-ember)'"),
    'C.ember must use var(--color-ember)')
})
test('C.danger uses var(--color-danger)', () => {
  assert.ok(importModal.includes("'var(--color-danger)'"),
    'C.danger must use var(--color-danger)')
})
test('ImportContactsModal C object no longer hardcodes #F7F2E7', () => {
  // Read just the C object block
  const cStart = importModal.indexOf('const C = {')
  const cEnd   = importModal.indexOf('}', cStart)
  const cBlock = importModal.slice(cStart, cEnd)
  assert.ok(!cBlock.includes('#F7F2E7'),
    'C object must not hardcode #F7F2E7 (Paper white)')
})
test('ImportContactsModal C object no longer hardcodes #14110F', () => {
  const cStart = importModal.indexOf('const C = {')
  const cEnd   = importModal.indexOf('}', cStart)
  const cBlock = importModal.slice(cStart, cEnd)
  assert.ok(!cBlock.includes('#14110F'),
    'C object must not hardcode #14110F (Ink black)')
})

// ── Section H: Repository audit — no purple in active CSS/JSX sources ─────────
console.log('\nH — Repository audit: no legacy purple in CSS/JSX sources')

const jsxFiles = [
  'src/pages/LandingPage.jsx',
  'src/pages/DashboardPage.jsx',
  'src/pages/ContactDetailPage.jsx',
  'src/pages/FunnlAIPage.jsx',
  'src/pages/FollowUpsPage.jsx',
  'src/components/Sidebar.jsx',
  'src/components/AddContactDrawer.jsx',
  'src/components/TopBar.jsx',
]

// Verify no OLD purple hex colors remain in these files
for (const rel of jsxFiles) {
  test(`${rel} has no legacy purple #4B3AF0`, () => {
    const src = read(rel)
    assert.ok(!src.includes('#4B3AF0'), `${rel} must not contain #4B3AF0`)
  })
  test(`${rel} has no legacy purple #8B7CFF`, () => {
    const src = read(rel)
    assert.ok(!src.includes('#8B7CFF'), `${rel} must not contain #8B7CFF`)
  })
}

// ── Section I: Theme system contracts ─────────────────────────────────────────
console.log('\nI — Theme system: architecture contracts')

const indexHtml = read('index.html')
const themeLib  = read('src/lib/theme.js')

test('theme storage key is "funnl-theme" in theme.js', () => {
  assert.ok(themeLib.includes("'funnl-theme'") || themeLib.includes('"funnl-theme"'),
    'theme.js must use "funnl-theme" as the storage key')
})
test('theme default is "light" in theme.js normalizeThemePreference', () => {
  assert.ok(themeLib.includes("'light'"), 'theme.js must default to light (Paper)')
})
test('applyThemeToRoot sets data-theme attribute', () => {
  assert.ok(themeLib.includes('dataset.theme'), 'theme.js applyThemeToRoot must set dataset.theme')
})
test('index.html pre-paint script reads funnl-theme key', () => {
  assert.ok(indexHtml.includes('funnl-theme'), 'index.html must read funnl-theme from localStorage')
})
test('index.html pre-paint covers dark theme', () => {
  assert.ok(indexHtml.includes('dark'), 'index.html pre-paint must handle dark theme')
})
test('index.html pre-paint covers system theme', () => {
  assert.ok(indexHtml.includes('system'), 'index.html pre-paint must handle system theme')
})
test('index.html pre-paint sets colorScheme', () => {
  assert.ok(indexHtml.includes('colorScheme'), 'index.html pre-paint must set colorScheme to prevent flash')
})
test('Settings page imports setTheme from theme.js', () => {
  assert.ok(settingsPage.includes('setTheme') || settingsPage.includes('theme.js'),
    'SettingsPage must reference setTheme or import from theme.js')
})
test('index.css has three data-theme blocks (dark, light, system via @media)', () => {
  assert.ok(
    css.includes(':root[data-theme="dark"]') &&
    css.includes(':root[data-theme="light"]') &&
    css.includes('@media (prefers-color-scheme: dark)'),
    'index.css must have explicit dark, light, and media-query dark theme blocks'
  )
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
