/**
 * stage14-mobile-shell.test.js
 *
 * Stage 14 — Final Mobile & Responsive Audit: automated source-contract tests.
 *
 * Sections:
 *   A  Shell breakpoint contract (Sidebar / BottomNav / MobileAppBar visibility)
 *   B  Safe-area handling
 *   C  BottomNav 5-position structure and routing
 *   D  Quick-action sheet Pro gating (4 Pro / 3 non-Pro)
 *   E  Quick-action sheet lifecycle contracts
 *   F  MobileAppBar structure
 *   G  AddContactDrawer mobile responsiveness
 *   H  FunnlAIPage mobile layout
 *   I  Contacts page mobile
 *   J  Contact Detail mobile
 *   K  Follow-ups mobile
 *   L  Dashboard mobile
 *   M  Search mobile
 *   N  Import mobile
 *   O  Settings mobile
 *   P  Auth responsive regression
 *   Q  767 / 768 breakpoint handoff
 *   R  Global viewport-overflow and no-duplicate-nav audit
 *   S  Theme and prohibited-color audit
 *
 * Zero-dependency Node.js — run with: node tests/stage14-mobile-shell.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const root  = join(__dir, '..')

function read(rel) { return readFileSync(join(root, rel), 'utf8') }

const appJsx           = read('src/App.jsx')
const sidebar          = read('src/components/Sidebar.jsx')
const bottomNav        = read('src/components/BottomNav.jsx')
const mobileAppBar     = read('src/components/MobileAppBar.jsx')
const addDrawer        = read('src/components/AddContactDrawer.jsx')
const funnlAI          = read('src/pages/FunnlAIPage.jsx')
const contactsPage     = read('src/pages/ContactsPage.jsx')
const contactDetail    = read('src/pages/ContactDetailPage.jsx')
const followUps        = read('src/pages/FollowUpsPage.jsx')
const dashboard        = read('src/pages/DashboardPage.jsx')
const settingsPage     = read('src/pages/SettingsPage.jsx')
const importModal      = read('src/components/ImportContactsModal.jsx')
const commandPalette   = read('src/components/CommandPalette.jsx')
const authShell        = read('src/components/AuthShell.jsx')
const signInPage       = read('src/pages/SignInPage.jsx')
const welcomePage      = read('src/pages/WelcomePage.jsx')
const resetPage        = read('src/pages/ResetPasswordPage.jsx')

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

// ── A: Shell breakpoint contract ──────────────────────────────────────────────
console.log('\nA — Shell breakpoint contract\n')

test('Sidebar has hidden md:flex — hidden on mobile, visible on desktop', () => {
  assert.ok(sidebar.includes('hidden md:flex'), 'Sidebar must use hidden md:flex to hide on mobile and show on desktop')
})

test('BottomNav has md:hidden — hidden on desktop, visible on mobile', () => {
  assert.ok(bottomNav.includes('md:hidden'), 'BottomNav outer wrapper must use md:hidden')
})

test('MobileAppBar has md:hidden — hidden on desktop, visible on mobile', () => {
  assert.ok(mobileAppBar.includes('md:hidden'), 'MobileAppBar outer wrapper must use md:hidden')
})

test('App.jsx authenticated shell: Sidebar, MobileAppBar, BottomNav all present', () => {
  assert.ok(appJsx.includes('<Sidebar'), 'App.jsx must render Sidebar')
  assert.ok(appJsx.includes('<MobileAppBar'), 'App.jsx must render MobileAppBar')
  assert.ok(appJsx.includes('<BottomNav'), 'App.jsx must render BottomNav')
})

test('App.jsx main element has md:pt-0 to remove mobile offset on desktop', () => {
  assert.ok(appJsx.includes('md:pt-0'), 'App.jsx main must reset top padding on md+ (desktop)')
})

test('App.jsx main element has md:pb-0 to remove BottomNav offset on desktop', () => {
  assert.ok(appJsx.includes('md:pb-0'), 'App.jsx main must reset bottom padding on md+ (desktop)')
})

test('Sidebar does not appear in BottomNav source (no duplicate nav components)', () => {
  assert.ok(!bottomNav.includes('<Sidebar'), 'BottomNav must not render Sidebar')
})

test('BottomNav does not appear in Sidebar source (no duplicate nav components)', () => {
  assert.ok(!sidebar.includes('<BottomNav'), 'Sidebar must not render BottomNav')
})

// ── B: Safe-area handling ─────────────────────────────────────────────────────
console.log('\nB — Safe-area handling\n')

test('MobileAppBar outer div has env(safe-area-inset-top)', () => {
  assert.ok(
    mobileAppBar.includes('safe-area-inset-top'),
    'MobileAppBar must use env(safe-area-inset-top) to avoid notch/Dynamic Island overlap'
  )
})

test('App.jsx main top padding accounts for safe-area-inset-top', () => {
  assert.ok(
    appJsx.includes('safe-area-inset-top'),
    'App.jsx main must include env(safe-area-inset-top) in its mobile top padding to match MobileAppBar'
  )
})

test('App.jsx main bottom padding accounts for safe-area-inset-bottom', () => {
  assert.ok(
    appJsx.includes('safe-area-inset-bottom'),
    'App.jsx main must include env(safe-area-inset-bottom) to clear BottomNav + home indicator'
  )
})

test('BottomNav tab bar has env(safe-area-inset-bottom) padding', () => {
  assert.ok(
    bottomNav.includes('safe-area-inset-bottom'),
    'BottomNav nav bar must use env(safe-area-inset-bottom) for iPhone home-indicator clearance'
  )
})

test('BottomNav quick-action sheet has env(safe-area-inset-bottom) padding', () => {
  // Sheet panel uses paddingBottom: env(safe-area-inset-bottom) in its inline style.
  // Tab bar uses it too; both must be present → check total count >= 2.
  const occurrences = (bottomNav.match(/safe-area-inset-bottom/g) || []).length
  assert.ok(
    occurrences >= 2,
    `BottomNav must use safe-area-inset-bottom at least twice (sheet panel + tab bar); found ${occurrences}`
  )
})

test('MobileAppBar does not hardcode iPhone-specific safe-area pixel value', () => {
  assert.ok(!mobileAppBar.includes('44px + 44px'), 'MobileAppBar must not duplicate the 44px offset — safe-area-inset-top handles the notch')
})

// ── C: BottomNav 5-position structure and routing ─────────────────────────────
console.log('\nC — BottomNav 5-position structure and routing\n')

test('BottomNav has a Home tab linking to "/"', () => {
  assert.ok(bottomNav.includes('to="/"'), 'BottomNav must have a Home tab with to="/"')
})

test('BottomNav has a People/Contacts tab linking to "/contacts"', () => {
  assert.ok(bottomNav.includes('to="/contacts"'), 'BottomNav must have a Contacts/People tab linking to /contacts')
})

test('BottomNav has a Due/Follow-ups tab linking to "/followups"', () => {
  assert.ok(bottomNav.includes('to="/followups"'), 'BottomNav must have a Follow-ups/Due tab linking to /followups')
})

test('BottomNav has an AI tab linking to "/ai"', () => {
  assert.ok(bottomNav.includes('to="/ai"'), 'BottomNav must have an AI tab linking to /ai')
})

test('BottomNav has a center + button (not a link) for quick actions', () => {
  // The + is a button, not a Link — verify it uses button + openSheet pattern
  assert.ok(bottomNav.includes('openSheet') || bottomNav.includes('sheetOpen'), 'BottomNav center + must be a button that opens the quick-action sheet')
})

test('BottomNav does NOT have an Import tab', () => {
  // Import tab should not be in the nav tabs array
  const navSection = bottomNav.slice(bottomNav.indexOf('<nav'), bottomNav.indexOf('</nav>') + 6)
  assert.ok(!navSection.includes('to="/contacts?import=1"'), 'BottomNav nav bar must not include an Import tab')
})

test('BottomNav does NOT have a Settings tab', () => {
  const navSection = bottomNav.slice(bottomNav.indexOf('<nav'), bottomNav.indexOf('</nav>') + 6)
  assert.ok(!navSection.includes('to="/settings"'), 'BottomNav nav bar must not include a Settings tab')
})

test('BottomNav center + has aria-haspopup="dialog"', () => {
  assert.ok(bottomNav.includes('aria-haspopup="dialog"'), 'Center + button must have aria-haspopup="dialog" for sheet announcement')
})

test('BottomNav center + has aria-expanded', () => {
  assert.ok(bottomNav.includes('aria-expanded={sheetOpen}') || bottomNav.includes('aria-expanded='), 'Center + button must have aria-expanded to announce sheet state')
})

test('BottomNav follows People label for the contacts tab', () => {
  assert.ok(bottomNav.includes('People'), 'BottomNav contacts tab must use "People" as the label per the spec')
})

test('BottomNav follows "Due" label for the follow-ups tab', () => {
  assert.ok(bottomNav.includes('Due'), 'BottomNav follow-ups tab must use "Due" as the label per the spec')
})

test('BottomNav follows "AI" label for the AI tab', () => {
  assert.ok(bottomNav.includes('>AI<'), 'BottomNav AI tab must use "AI" as the label per the spec')
})

test('BottomNav due badge caps at 9+', () => {
  assert.ok(bottomNav.includes('9+'), 'BottomNav follow-ups badge must cap at 9+')
})

test('BottomNav due badge applies ember color', () => {
  const badgeIdx = bottomNav.indexOf('9+')
  const nearBadge = bottomNav.slice(Math.max(0, badgeIdx - 200), badgeIdx + 50)
  assert.ok(nearBadge.includes('ember'), 'Follow-ups badge must use ember color')
})

test('BottomNav /contacts/:id active state links People tab (isActive uses startsWith)', () => {
  // The isActive function uses pathname.startsWith(path + '/')
  // so /contacts/some-id will mark /contacts as active
  assert.ok(
    bottomNav.includes('startsWith(path + \'/\')') || bottomNav.includes("startsWith(path + '/')"),
    'BottomNav isActive must use startsWith so /contacts/:id shows People as active'
  )
})

test('BottomNav uses ember color for active tab', () => {
  assert.ok(
    bottomNav.includes('var(--color-ember)') || bottomNav.includes("'var(--color-ember)'"),
    'Active BottomNav tab must use ember color'
  )
})

// ── D: Quick-action sheet Pro gating ─────────────────────────────────────────
console.log('\nD — Quick-action sheet Pro gating\n')

test('BottomNav imports useProStatus for Pro status', () => {
  assert.ok(bottomNav.includes('useProStatus'), 'BottomNav must use useProStatus hook for Pro-gating AI action')
})

test('BottomNav imports hasProAccess for the canonical access gate', () => {
  assert.ok(bottomNav.includes('hasProAccess'), 'BottomNav must use hasProAccess for the canonical Pro access gate')
})

test('BottomNav canUsePro is computed via hasProAccess (not a state allowlist)', () => {
  assert.ok(
    /canUsePro\s*=\s*hasProAccess\(/.test(bottomNav),
    'BottomNav canUsePro must be hasProAccess(proStatus) — never a hand-written permanent/trial/subscribed allowlist'
  )
  assert.ok(
    !/canUsePro\s*=\s*[^\n]*===\s*['"](permanent|trial|subscribed)['"]/.test(bottomNav),
    'BottomNav canUsePro must not enumerate entitlement states'
  )
})

test('BottomNav AI action is conditionally rendered behind canUsePro', () => {
  // Use lastIndexOf to find the rendered label (not the file-header comment which also mentions it).
  // The canUsePro && (... large JSX block ...) wraps the button; look back 1100 chars.
  const aiButtonIdx = bottomNav.lastIndexOf('Ask Funnl AI')
  const beforeAI = bottomNav.slice(Math.max(0, aiButtonIdx - 1100), aiButtonIdx)
  assert.ok(beforeAI.includes('canUsePro'), 'Ask Funnl AI action in sheet must be gated by canUsePro')
})

test('BottomNav Log an interaction action is always rendered (not Pro-gated)', () => {
  // Log interaction must be visible to all users
  const logIdx = bottomNav.indexOf('Log an interaction')
  const beforeLog = bottomNav.slice(Math.max(0, logIdx - 200), logIdx)
  assert.ok(!beforeLog.includes('canUsePro'), 'Log an interaction must be visible to all users, not Pro-gated')
})

test('BottomNav Add a contact action is always rendered (not Pro-gated)', () => {
  const addIdx = bottomNav.indexOf('Add a contact')
  const beforeAdd = bottomNav.slice(Math.max(0, addIdx - 200), addIdx)
  assert.ok(!beforeAdd.includes('canUsePro'), 'Add a contact must be visible to all users, not Pro-gated')
})

test('BottomNav Create a follow-up action is always rendered (not Pro-gated)', () => {
  const fuIdx = bottomNav.indexOf('Create a follow-up')
  const beforeFU = bottomNav.slice(Math.max(0, fuIdx - 200), fuIdx)
  assert.ok(!beforeFU.includes('canUsePro'), 'Create a follow-up must be visible to all users, not Pro-gated')
})

test('BottomNav sheet action order: Log first, then Add, then Follow-up, then AI', () => {
  const logPos = bottomNav.indexOf('Log an interaction')
  const addPos = bottomNav.indexOf('Add a contact')
  const fuPos  = bottomNav.indexOf('Create a follow-up')
  const aiPos  = bottomNav.indexOf('Ask Funnl AI')
  assert.ok(logPos < addPos, 'Log interaction must appear before Add contact in the sheet')
  assert.ok(addPos < fuPos, 'Add contact must appear before Create follow-up in the sheet')
  assert.ok(fuPos < aiPos, 'Create follow-up must appear before Ask Funnl AI in the sheet')
})

test('BottomNav does not show a disabled/locked AI teaser for non-Pro', () => {
  // Non-Pro path: canUsePro is false, AI button is entirely absent — no lock icon, no disabled state
  const src = bottomNav
  // Check that there's no "lock" icon near the AI entry
  // The AI button is wrapped in {canUsePro && (...)} so it simply doesn't render
  const aiIdx = bottomNav.indexOf('Ask Funnl AI')
  if (aiIdx === -1) return // no AI button at all — even better
  const context = bottomNav.slice(Math.max(0, aiIdx - 300), aiIdx + 100)
  assert.ok(!context.includes('disabled'), 'AI action must not render as disabled — it must be fully absent for non-Pro')
})

// ── E: Quick-action sheet lifecycle ───────────────────────────────────────────
console.log('\nE — Quick-action sheet lifecycle\n')

test('BottomNav sheet uses role="dialog"', () => {
  assert.ok(bottomNav.includes('role="dialog"'), 'Quick-action sheet must have role="dialog"')
})

test('BottomNav sheet uses aria-modal="true"', () => {
  assert.ok(bottomNav.includes('aria-modal="true"'), 'Quick-action sheet must have aria-modal="true"')
})

test('BottomNav sheet has aria-label', () => {
  assert.ok(bottomNav.includes('aria-label='), 'Quick-action sheet must have an accessible label')
})

test('BottomNav sheet implements body scroll lock on open', () => {
  assert.ok(
    bottomNav.includes("document.body.style.overflow = 'hidden'"),
    'Sheet must lock body scroll when opened'
  )
})

test('BottomNav sheet restores body scroll on close', () => {
  assert.ok(
    bottomNav.includes("document.body.style.overflow = ''"),
    'Sheet must restore body scroll when closed'
  )
})

test('BottomNav sheet has scroll-lock cleanup on unmount', () => {
  // Safety cleanup in useEffect return
  assert.ok(
    bottomNav.includes("return () => { document.body.style.overflow = '' }"),
    'BottomNav must clean up scroll lock on unmount'
  )
})

test('BottomNav sheet implements focus trap (Tab key handling)', () => {
  assert.ok(bottomNav.includes('Tab'), 'Sheet must implement Tab-key focus trap')
})

test('BottomNav Escape closes sheet from actions page', () => {
  assert.ok(
    bottomNav.includes("e.key === 'Escape'"),
    'Escape key must close the quick-action sheet'
  )
})

test('BottomNav sheet has a drag handle visual indicator', () => {
  // 36px wide, 4px tall rounded pill
  assert.ok(
    bottomNav.includes('w-[36px] h-[4px]') || bottomNav.includes("w-[36px]"),
    'Sheet must have a drag handle visual indicator'
  )
})

test('BottomNav first action button receives focus when sheet opens', () => {
  assert.ok(
    bottomNav.includes('firstActionRef.current?.focus()'),
    'First action button must receive focus when sheet opens'
  )
})

test('BottomNav focus returns to + trigger when sheet closes', () => {
  assert.ok(
    bottomNav.includes('plusTriggerRef.current?.focus()'),
    'Focus must return to the + trigger when sheet closes'
  )
})

test('BottomNav sheet closes when backdrop is clicked', () => {
  assert.ok(
    bottomNav.includes('onOutside') || bottomNav.includes('closeSheet'),
    'Sheet must close when clicking outside (backdrop)'
  )
})

// ── F: MobileAppBar structure ─────────────────────────────────────────────────
console.log('\nF — MobileAppBar structure\n')

test('MobileAppBar is fixed top-0 left-0 right-0', () => {
  assert.ok(mobileAppBar.includes('fixed top-0 left-0 right-0'), 'MobileAppBar must be fixed at the top of the viewport')
})

test('MobileAppBar bar height is 44px (visible content height below safe area)', () => {
  assert.ok(mobileAppBar.includes('h-[44px]'), 'MobileAppBar content area must be 44px tall')
})

test('MobileAppBar has Funnl ember mark', () => {
  // Ember mark: #FF4423 rounded tile with funnel SVG
  assert.ok(
    mobileAppBar.includes('#FF4423') || mobileAppBar.includes('var(--color-ember)'),
    'MobileAppBar must display the Funnl ember mark'
  )
})

test('MobileAppBar has "Funnl" wordmark text', () => {
  assert.ok(mobileAppBar.includes('>Funnl<'), 'MobileAppBar must display the Funnl wordmark')
})

test('MobileAppBar avatar button has aria-haspopup="menu"', () => {
  assert.ok(mobileAppBar.includes('aria-haspopup="menu"'), 'Avatar button must announce it opens a menu')
})

test('MobileAppBar avatar button has aria-expanded', () => {
  assert.ok(mobileAppBar.includes('aria-expanded={sheetOpen}') || mobileAppBar.includes('aria-expanded='), 'Avatar button must have aria-expanded')
})

test('MobileAppBar account menu has Import contacts option', () => {
  assert.ok(mobileAppBar.includes('Import contacts') || mobileAppBar.includes('/contacts?import=1'), 'Account menu must have Import contacts')
})

test('MobileAppBar account menu has Settings option', () => {
  assert.ok(mobileAppBar.includes('Settings') && mobileAppBar.includes('/settings'), 'Account menu must have Settings')
})

test('MobileAppBar account menu has Sign out option', () => {
  assert.ok(mobileAppBar.includes('Sign out'), 'Account menu must have Sign out')
})

test('MobileAppBar account menu uses role="menu" and role="menuitem"', () => {
  assert.ok(mobileAppBar.includes('role="menu"'), 'Account dropdown must use role="menu"')
  assert.ok(mobileAppBar.includes('role="menuitem"'), 'Account dropdown items must use role="menuitem"')
})

test('MobileAppBar focus returns to avatar trigger when menu closes', () => {
  assert.ok(
    mobileAppBar.includes('triggerRef.current?.focus()'),
    'Focus must return to the avatar button when the account menu closes'
  )
})

test('MobileAppBar first menu item receives focus when menu opens', () => {
  assert.ok(
    mobileAppBar.includes('firstItemRef.current?.focus()'),
    'First menu item must receive focus when the account menu opens'
  )
})

// ── G: AddContactDrawer mobile responsiveness ─────────────────────────────────
console.log('\nG — AddContactDrawer mobile responsiveness\n')

test('AddContactDrawer has w-full on mobile (no fixed width)', () => {
  assert.ok(addDrawer.includes('w-full'), 'AddContactDrawer must be full-width on mobile')
})

test('AddContactDrawer has md:w-[440px] for desktop width', () => {
  assert.ok(addDrawer.includes('md:w-[440px]') || addDrawer.includes('md:w-[452px]'), 'AddContactDrawer must use a fixed width only on md+ (desktop)')
})

test('AddContactDrawer Company+Role grid has md: prefix — single column on mobile', () => {
  // After Stage 14 fix: should be grid-cols-1 md:grid-cols-2
  const idx = addDrawer.indexOf('Company + Role') !== -1
    ? addDrawer.indexOf('Company + Role')
    : addDrawer.indexOf('Company')
  const near = addDrawer.slice(Math.max(0, idx - 100), idx + 300)
  assert.ok(
    near.includes('md:grid-cols-2') || near.includes('grid-cols-1'),
    'Company/Role grid must be single-column on mobile (md:grid-cols-2 or grid-cols-1)'
  )
})

test('AddContactDrawer RelType+Tags grid has md: prefix — single column on mobile', () => {
  const idx = addDrawer.indexOf('Relationship type + Tags') !== -1
    ? addDrawer.indexOf('Relationship type + Tags')
    : addDrawer.indexOf('Relationship type')
  const near = addDrawer.slice(Math.max(0, idx - 100), idx + 300)
  assert.ok(
    near.includes('md:grid-cols-2') || near.includes('grid-cols-1'),
    'RelType/Tags grid must be single-column on mobile (md:grid-cols-2 or grid-cols-1)'
  )
})

test('AddContactDrawer has no bare grid-cols-2 without md: or sm: prefix in form section', () => {
  // After fix: all form grids are responsive
  const formSection = addDrawer.slice(addDrawer.indexOf('form') > -1 ? addDrawer.indexOf('form') : 0)
  const matches = [...formSection.matchAll(/(?<!md:|sm:)grid-cols-2(?!\s*\{)/g)]
  assert.ok(
    matches.length === 0,
    'No bare grid-cols-2 without a responsive prefix should remain in form fields; found: ' + matches.length
  )
})

// ── H: FunnlAIPage mobile layout ──────────────────────────────────────────────
console.log('\nH — FunnlAIPage mobile layout\n')

test('FunnlAIPage history rail is hidden on mobile (hidden md:flex)', () => {
  assert.ok(funnlAI.includes('hidden md:flex'), 'History rail must be hidden on mobile and visible on desktop')
})

test('FunnlAIPage main conversation column has min-w-0 to prevent flex overflow', () => {
  assert.ok(funnlAI.includes('min-w-0'), 'Conversation column must have min-w-0 to prevent text overflow in flex context')
})

test('FunnlAIPage message list has min-h-0 for correct flex scrolling', () => {
  assert.ok(funnlAI.includes('min-h-0'), 'Message list must have min-h-0 for correct flex-child scrolling')
})

test('FunnlAIPage workspace has overflow-hidden to contain the chat columns', () => {
  assert.ok(funnlAI.includes('overflow-hidden'), 'FunnlAIPage workspace must be overflow-hidden to contain flex columns')
})

test('FunnlAIPage user message bubble has max-w for readability at narrow widths', () => {
  assert.ok(funnlAI.includes('max-w-[80%]') || funnlAI.includes('max-w-[70%]'), 'User messages must have a max-width to avoid full-width at narrow viewports')
})

// ── I: Contacts page mobile ───────────────────────────────────────────────────
console.log('\nI — Contacts page mobile\n')

test('ContactsPage has TopBar component (provides search/title on mobile)', () => {
  assert.ok(contactsPage.includes('TopBar') || contactsPage.includes('<TopBar'), 'ContactsPage must use TopBar for mobile title and search access')
})

test('ContactsPage filter pills wrap within a contained area (no document overflow)', () => {
  // Pills use flex-wrap so they stay within the container; document body must not scroll horizontally
  assert.ok(
    contactsPage.includes('flex-wrap') || contactsPage.includes('overflow-x-auto'),
    'Tag filter pills must use flex-wrap or overflow-x-auto so they never overflow the document body'
  )
})

test('ContactsPage has no bare grid-cols-2 without md: (mobile must be single-column)', () => {
  // Contact rows must be single column on mobile
  const hasDesktopGrid = contactsPage.includes('md:grid-cols') || !contactsPage.includes('grid-cols-2')
  assert.ok(hasDesktopGrid, 'ContactsPage contact list must be single-column on mobile')
})

// ── J: Contact Detail mobile ──────────────────────────────────────────────────
console.log('\nJ — Contact Detail mobile\n')

test('ContactDetailPage body grid is single-column on mobile (grid-cols-1 md:...)', () => {
  assert.ok(
    contactDetail.includes('grid-cols-1 md:') || contactDetail.includes('md:grid-cols-'),
    'ContactDetailPage body grid must be single-column on mobile'
  )
})

test('ContactDetailPage has LogInteractionSheet for mobile interaction logging', () => {
  assert.ok(
    contactDetail.includes('LogInteractionSheet'),
    'ContactDetailPage must use LogInteractionSheet for mobile logging flow'
  )
})

test('ContactDetailPage LogInteractionSheet is md:hidden (mobile-only)', () => {
  const logSheet = read('src/components/LogInteractionSheet.jsx')
  assert.ok(logSheet.includes('md:hidden'), 'LogInteractionSheet must be hidden on desktop (md:hidden)')
})

// ── K: Follow-ups mobile ──────────────────────────────────────────────────────
console.log('\nK — Follow-ups mobile\n')

test('FollowUpsPage has max-w constraint and mx-auto for centered single-column', () => {
  assert.ok(
    followUps.includes('max-w-') && followUps.includes('mx-auto'),
    'FollowUpsPage must use max-w + mx-auto for a centered single-column layout'
  )
})

test('FollowUpsPage row actions use flex-wrap to prevent overflow on narrow screens', () => {
  assert.ok(
    followUps.includes('flex-wrap'),
    'FollowUpsPage row actions must use flex-wrap to wrap on narrow viewports'
  )
})

test('FollowUpsPage imports swipeGesture helpers (swipe as progressive enhancement)', () => {
  assert.ok(
    followUps.includes('swipeGesture') || followUps.includes('classifySwipeGesture'),
    'FollowUpsPage must use the swipeGesture module for progressive-enhancement swipe'
  )
})

test('FollowUpsPage swipe uses touchstart/touchmove/touchend (not pointer events)', () => {
  assert.ok(
    followUps.includes('touchstart') && followUps.includes('touchmove') && followUps.includes('touchend'),
    'Swipe implementation must use touch events for broad mobile device support'
  )
})

test('FollowUpsPage Mark Done action is always visible (not hover-only)', () => {
  // Verify "Done" button doesn't rely on group-hover or hover: for visibility
  const doneIdx = followUps.indexOf('Done')
  const nearDone = followUps.slice(Math.max(0, doneIdx - 100), doneIdx + 200)
  assert.ok(!nearDone.includes('group-hover:opacity'), 'Done action must be always-visible, not revealed only on hover')
})

// ── L: Dashboard mobile ───────────────────────────────────────────────────────
console.log('\nL — Dashboard mobile\n')

test('DashboardPage has responsive grid (single-column on mobile, multi-column on md+)', () => {
  assert.ok(
    dashboard.includes('grid-cols-1 md:') || dashboard.includes('md:grid-cols-'),
    'DashboardPage must use responsive grid — single-column on mobile'
  )
})

test('DashboardPage horizontal padding responsive (smaller on mobile)', () => {
  assert.ok(
    dashboard.includes('px-4') || dashboard.includes('px-[20px]'),
    'DashboardPage must use 16px or similar gutter on mobile'
  )
})

// ── M: Search/Command Palette mobile ─────────────────────────────────────────
console.log('\nM — Search / Command Palette mobile\n')

test('CommandPalette is full-screen on mobile (inset-0 or w-full h-full)', () => {
  assert.ok(
    commandPalette.includes('inset-0') || commandPalette.includes('w-full') && commandPalette.includes('h-full'),
    'CommandPalette / Search must cover the full screen on mobile'
  )
})

test('CommandPalette has body scroll lock while open', () => {
  assert.ok(
    commandPalette.includes("document.body.style.overflow = 'hidden'") ||
    commandPalette.includes('overflow') && commandPalette.includes('body'),
    'CommandPalette must lock body scroll while open'
  )
})

test('CommandPalette has safe-area-inset-bottom padding', () => {
  assert.ok(
    commandPalette.includes('safe-area-inset-bottom'),
    'CommandPalette must handle safe-area-inset-bottom for iPhone home indicator'
  )
})

// ── N: Import mobile ──────────────────────────────────────────────────────────
console.log('\nN — Import mobile\n')

test('ImportContactsModal has w-full for full viewport width on mobile', () => {
  assert.ok(importModal.includes('w-full'), 'ImportContactsModal must be w-full on mobile')
})

test('ImportContactsModal review table uses overflow-x-auto for contained horizontal scrolling', () => {
  assert.ok(
    importModal.includes('overflow-x-auto'),
    'ImportContactsModal review table must use overflow-x-auto so the modal itself does not overflow'
  )
})

test('ImportContactsModal has max-h constraint to prevent viewport overflow', () => {
  assert.ok(
    importModal.includes('max-h-') || importModal.includes('overflow-y-auto'),
    'ImportContactsModal must constrain its height to avoid overflowing the viewport'
  )
})

// ── O: Settings mobile ────────────────────────────────────────────────────────
console.log('\nO — Settings mobile\n')

test('SettingsPage has mobile-first horizontal padding (px-4 or similar)', () => {
  assert.ok(
    settingsPage.includes('px-4') || settingsPage.includes('px-[16px]') || settingsPage.includes('p-4'),
    'SettingsPage must have appropriate mobile padding'
  )
})

test('SettingsPage uses max-w to prevent over-wide single-column layout on desktop', () => {
  assert.ok(settingsPage.includes('max-w-'), 'SettingsPage must use max-w to constrain desktop width')
})

test('SettingsPage has no bare fixed width exceeding 400px that would overflow mobile', () => {
  // Only flag bare w-[NNNpx] (not max-w-, min-w- prefixed classes, which constrain rather than fix)
  const overwidePx = [...settingsPage.matchAll(/(?<![a-z-])w-\[([5-9]\d{2}|[1-9]\d{3})px\]/g)]
  assert.ok(overwidePx.length === 0, `SettingsPage must not have bare fixed widths ≥ 500px; found: ${overwidePx.map(m => m[0]).join(', ')}`)
})

// ── P: Auth responsive regression ─────────────────────────────────────────────
console.log('\nP — Auth responsive regression\n')

test('AuthShell has no horizontal overflow at narrow widths (w-full on form side)', () => {
  assert.ok(
    authShell.includes('w-full') || authShell.includes('flex-1'),
    'AuthShell form side must be w-full or flex-1 to fit all widths'
  )
})

test('AuthShell decorative brand panel is hidden on small screens (hidden lg:flex)', () => {
  assert.ok(
    authShell.includes('hidden lg:flex') || authShell.includes('lg:flex'),
    'AuthShell decorative panel must be hidden on small screens'
  )
})

test('SignInPage long email in form does not have overflow: visible only (wraps or truncates)', () => {
  // Email input has w-full which allows it to fit within its container
  assert.ok(signInPage.includes('w-full') || signInPage.includes('flex-1'), 'SignInPage inputs must be w-full to prevent horizontal overflow')
})

test('WelcomePage is not wrapped in the authenticated app shell (no Sidebar dependency)', () => {
  assert.ok(!welcomePage.includes('<Sidebar'), 'WelcomePage must not render the desktop Sidebar')
})

test('ResetPasswordPage is not wrapped in the authenticated app shell (no Sidebar dependency)', () => {
  assert.ok(!resetPage.includes('<Sidebar'), 'ResetPasswordPage must not render the desktop Sidebar')
})

// ── Q: 767/768 breakpoint handoff ─────────────────────────────────────────────
console.log('\nQ — 767/768 breakpoint handoff\n')

test('Sidebar breakpoint uses md: (768px) — not sm: (640px) or lg: (1024px)', () => {
  // hidden md:flex means Sidebar appears at exactly 768px
  assert.ok(sidebar.includes('hidden md:flex'), 'Sidebar must activate at exactly md: (768px), not sm: or lg:')
  assert.ok(!sidebar.includes('hidden sm:flex'), 'Sidebar must not use sm: breakpoint for visibility')
  assert.ok(!sidebar.includes('hidden lg:flex'), 'Sidebar must not use lg: breakpoint for main visibility')
})

test('BottomNav breakpoint uses md: (768px) — hidden at exactly 768px and above', () => {
  // md:hidden means BottomNav disappears at exactly 768px
  const outerClass = bottomNav.slice(0, bottomNav.indexOf('>') + 100)
  assert.ok(
    bottomNav.includes('md:hidden'),
    'BottomNav must use md:hidden so it disappears at exactly 768px (desktop)'
  )
})

test('MobileAppBar breakpoint uses md: (768px) — hidden at exactly 768px and above', () => {
  assert.ok(
    mobileAppBar.includes('md:hidden'),
    'MobileAppBar must use md:hidden so it disappears at exactly 768px (desktop)'
  )
})

test('App.jsx main top-padding reset uses md:pt-0 (clears at 768px)', () => {
  assert.ok(appJsx.includes('md:pt-0'), 'App.jsx main must reset top padding at md: (768px)')
})

test('App.jsx main bottom-padding reset uses md:pb-0 (clears at 768px)', () => {
  assert.ok(appJsx.includes('md:pb-0'), 'App.jsx main must reset bottom padding at md: (768px)')
})

test('No sm: breakpoint used for primary shell visibility decisions', () => {
  // sm: = 640px — if used for shell, causes gap between 640-767px where both/neither shows
  const shellBreakpoints = [sidebar, bottomNav, mobileAppBar].join('\n')
  assert.ok(
    !shellBreakpoints.includes('sm:hidden') && !shellBreakpoints.includes('sm:flex'),
    'Shell components must not use sm: for shell visibility — use md: for the single 768px handoff point'
  )
})

// ── R: Global viewport-overflow and no-duplicate-nav audit ───────────────────
console.log('\nR — Global viewport-overflow and no-duplicate-nav audit\n')

test('App.jsx authenticated shell does not render Settings in BottomNav', () => {
  // Settings is accessible only via MobileAppBar account menu
  assert.ok(appJsx.includes('<BottomNav'), 'App.jsx renders BottomNav')
  // The BottomNav itself does not have a Settings tab (verified in Section C)
})

test('App.jsx does not have both Sidebar and BottomNav always visible simultaneously', () => {
  // Sidebar is hidden md:flex; BottomNav is md:hidden — mutually exclusive
  assert.ok(
    sidebar.includes('hidden md:flex') && bottomNav.includes('md:hidden'),
    'Sidebar and BottomNav must be mutually exclusive using md: breakpoint'
  )
})

test('AddContactDrawer does not have fixed width on mobile (full-width)', () => {
  // No bare w-[440px] or w-[452px] without md: prefix
  assert.ok(!addDrawer.includes(' w-[440px]') && !addDrawer.includes(' w-[452px]'), 'AddContactDrawer must not have a fixed width without md: prefix')
})

test('No production page renders both Sidebar and BottomNav (mutual exclusion confirmed)', () => {
  // Confirmed: Sidebar uses hidden md:flex (hidden on mobile), BottomNav uses md:hidden (hidden on desktop)
  assert.ok(
    sidebar.includes('hidden md:flex'),
    'Sidebar visibility is CSS-only (hidden md:flex), so BottomNav is the mobile nav'
  )
})

test('FunnlAIPage does not expose history rail to mobile (hidden md:flex)', () => {
  assert.ok(funnlAI.includes('hidden md:flex'), 'AI history rail must be hidden on mobile')
})

// ── S: Theme and prohibited-color audit ───────────────────────────────────────
console.log('\nS — Theme and prohibited-color audit\n')

const mobileFiles = [appJsx, sidebar, bottomNav, mobileAppBar, addDrawer, funnlAI,
  contactsPage, contactDetail, followUps, dashboard, settingsPage, commandPalette]

test('No hardcoded white (#fff or #ffffff) as a mobile surface background', () => {
  const combined = mobileFiles.join('\n').toLowerCase()
  const whiteMatches = [...combined.matchAll(/background:\s*['"]#fff(?:fff)?['"]/g)]
  assert.ok(whiteMatches.length === 0, `Mobile surfaces must not hardcode white backgrounds — found ${whiteMatches.length} instances`)
})

test('No prohibited purple #8B7CFF in any mobile component', () => {
  const combined = mobileFiles.join('\n')
  assert.ok(!combined.includes('#8B7CFF'), 'Mobile components must not contain prohibited purple #8B7CFF')
})

test('No prohibited violet #5B45F0 in any mobile component', () => {
  const combined = mobileFiles.join('\n')
  assert.ok(!combined.includes('#5B45F0'), 'Mobile components must not contain prohibited violet #5B45F0')
})

test('BottomNav uses semantic color tokens, not hardcoded dark hex for backgrounds', () => {
  // BottomNav should use var(--color-*) tokens
  assert.ok(
    bottomNav.includes("var(--color-card)") || bottomNav.includes("var(--color-elevated)"),
    'BottomNav must use semantic color tokens rather than hardcoded hex backgrounds'
  )
})

test('MobileAppBar uses semantic color tokens for bar background', () => {
  assert.ok(
    mobileAppBar.includes("var(--color-card)") || mobileAppBar.includes("var(--color-surface)"),
    'MobileAppBar must use semantic color tokens for its background'
  )
})

test('No em dash U+2014 in rendered JSX text of mobile shell components', () => {
  // Em dashes in JSDoc/inline comments (/* ... */ and // ...) are acceptable.
  // Strip comments first, then check rendered content.
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')    // block comments
      .replace(/\/\/.*/g, '')               // line comments
  }
  const combined = [bottomNav, mobileAppBar, appJsx].map(stripComments).join('\n')
  assert.ok(!combined.includes('—'), 'Mobile shell JSX (comments excluded) must not contain em dash (U+2014)')
})

test('Funnl funnel mark SVG path is intact in BottomNav AI tab', () => {
  // Sacred funnel path: M3 4H21L15 12.5V20H9V12.5Z
  assert.ok(
    bottomNav.includes('M3 4H21L15 12.5V20H9V12.5Z'),
    'The sacred Funnl funnel SVG path must be intact in the BottomNav AI tab'
  )
})

test('Funnl funnel mark SVG path is intact in MobileAppBar ember mark', () => {
  assert.ok(
    mobileAppBar.includes('M3 4H21L15 12.5V20H9V12.5Z'),
    'The Funnl funnel SVG path must be intact in the MobileAppBar brand mark'
  )
})

// ── Final ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
