/**
 * topbar-search-semantics.test.js
 *
 * Source-contract tests that guard the TopBar global search affordance fix.
 *
 * Problem: The TopBar search trigger had `cursor-text` on a `<button>`, which
 * communicates "editable text field" to pointer users and assistive technology.
 * It also had `aria-label="Search"` (too generic) and a no-op `onClick` on
 * ContactsPage. This misled users into thinking the TopBar IS an input field
 * they can type into, rather than a launcher that opens CommandPalette.
 *
 * Fixes:
 *   - TopBar: cursor-text → cursor-pointer; aria-label → "Open global search";
 *     aria-haspopup="dialog"; focus-visible ring; type="button" explicit
 *   - ContactsPage: onSearchClick dispatches funnl:open-command-palette event;
 *     searchPlaceholder uses global copy ("Find, log, or ask anything…")
 *   - FollowUpsPage, FunnlAIPage: search trigger wired to CommandPalette
 *
 * The local Contacts search input is intentionally separate:
 *   - It IS a real <input type="text"> that users can type into
 *   - It filters the visible contact list in real time (local scope)
 *   - Its placeholder uses local copy ("Search name, company, role, notes…")
 *   - It coexists with the global launcher — two different things, not duplicates
 *
 * Run with: node tests/topbar-search-semantics.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const topBarSrc     = readFileSync(resolve('src/components/TopBar.jsx'), 'utf8')
const dashSrc       = readFileSync(resolve('src/pages/DashboardPage.jsx'), 'utf8')
const contactsSrc   = readFileSync(resolve('src/pages/ContactsPage.jsx'), 'utf8')
const followupsSrc  = readFileSync(resolve('src/pages/FollowUpsPage.jsx'), 'utf8')
const aiSrc         = readFileSync(resolve('src/pages/FunnlAIPage.jsx'), 'utf8')

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
// 1. TopBar.jsx — button element semantics (not an input)
// =============================================================================

console.log('\n1. TopBar.jsx — search trigger is a <button>, not an <input>')

test('search trigger is a <button> element, not <input>', () => {
  // The trigger must be a <button> — an interactive element that activates a
  // command (CommandPalette). An <input> would invite typing, which is wrong.
  assert.ok(
    topBarSrc.includes('<button') && topBarSrc.includes('onClick={onSearchClick}'),
    '<button> with onClick={onSearchClick} must exist in TopBar'
  )
  assert.ok(
    !topBarSrc.includes('<input') || !topBarSrc.includes('onSearchClick'),
    'onSearchClick must not be on an <input> element'
  )
})

test('button has explicit type="button" to prevent accidental form submission', () => {
  // Without type="button", a button inside a form defaults to type="submit".
  // Explicit type prevents accidental form submissions when the TopBar appears
  // inside or near a form (e.g. the search bar in some pages).
  assert.ok(
    topBarSrc.includes('type="button"'),
    'search trigger <button> must have explicit type="button"'
  )
})

test('button does not use cursor-text (which signals an editable text field)', () => {
  // cursor-text is the correct cursor for <input> elements. On a <button> it
  // misleads pointer users into thinking they can type into it.
  assert.ok(
    !topBarSrc.includes('cursor-text'),
    'cursor-text must not appear in TopBar — it signals "editable input" not "launcher button"'
  )
})

test('button uses cursor-pointer (signals a clickable action)', () => {
  assert.ok(
    topBarSrc.includes('cursor-pointer'),
    'search trigger must use cursor-pointer to signal it is a clickable action'
  )
})

// =============================================================================
// 2. TopBar.jsx — accessible name and role announcement
// =============================================================================

console.log('\n2. TopBar.jsx — accessible name and role semantics')

test('button has aria-label="Open global search" (not just "Search")', () => {
  // "Search" is too generic — it does not tell assistive technology users what
  // kind of search it opens. "Open global search" distinguishes it from the
  // local contact search input below.
  assert.ok(
    topBarSrc.includes('aria-label="Open global search"'),
    'TopBar search trigger must have aria-label="Open global search"'
  )
  assert.ok(
    !topBarSrc.includes('aria-label="Search"'),
    'aria-label="Search" must not remain — it is too generic for a command launcher'
  )
})

test('button has aria-haspopup="dialog" to announce it opens a dialog', () => {
  // aria-haspopup="dialog" tells screen readers that activating this button
  // will open a dialog (CommandPalette is a modal dialog).
  assert.ok(
    topBarSrc.includes('aria-haspopup="dialog"'),
    'search trigger must have aria-haspopup="dialog" to signal it opens CommandPalette'
  )
})

test('button has focus-visible outline ring for keyboard navigation', () => {
  // Keyboard users need a visible focus indicator when tabbing to this trigger.
  assert.ok(
    topBarSrc.includes('focus-visible:outline'),
    'search trigger must have focus-visible:outline for keyboard focus visibility'
  )
})

// =============================================================================
// 3. TopBar.jsx — visual content (search icon, ⌘K badge retained)
// =============================================================================

console.log('\n3. TopBar.jsx — visual affordance elements retained')

test('search icon SVG is present', () => {
  // The magnifying glass icon signals "search" even without the placeholder text.
  assert.ok(
    topBarSrc.includes('<circle cx="11" cy="11"'),
    'search icon (magnifying glass circle) must remain in TopBar'
  )
})

test('command-K badge (⌘K) is present', () => {
  // ⌘K is the keyboard shortcut to open CommandPalette. The badge teaches this
  // shortcut to users and distinguishes this control as a keyboard-accessible launcher.
  assert.ok(
    topBarSrc.includes('⌘K'),
    'keyboard shortcut badge (⌘K) must be present in TopBar search trigger'
  )
})

// =============================================================================
// 4. Search copy consistency — all pages use identical global placeholder
// =============================================================================

console.log('\n4. Search copy — all pages use the same global launcher placeholder')

const GLOBAL_COPY = 'Find, log, or ask anything…'

test('DashboardPage uses global copy in TopBar searchPlaceholder', () => {
  assert.ok(
    dashSrc.includes(GLOBAL_COPY),
    `DashboardPage TopBar must use "${GLOBAL_COPY}"`
  )
})

test('ContactsPage uses global copy in TopBar searchPlaceholder', () => {
  assert.ok(
    contactsSrc.includes(GLOBAL_COPY),
    `ContactsPage TopBar must use "${GLOBAL_COPY}"`
  )
})

test('FollowUpsPage uses global copy in TopBar searchPlaceholder', () => {
  assert.ok(
    followupsSrc.includes(GLOBAL_COPY),
    `FollowUpsPage TopBar must use "${GLOBAL_COPY}"`
  )
})

test('FunnlAIPage uses global copy in TopBar searchPlaceholder', () => {
  assert.ok(
    aiSrc.includes(GLOBAL_COPY),
    `FunnlAIPage TopBar must use "${GLOBAL_COPY}"`
  )
})

test('no page passes page-specific copy like "Search contacts…" to TopBar searchPlaceholder', () => {
  // "Search contacts…" belonged on the local Contacts search input, not the
  // global TopBar launcher. All four pages must use the identical global copy.
  const pageSrcPairs = [
    ['DashboardPage', dashSrc],
    ['ContactsPage', contactsSrc],
    ['FollowUpsPage', followupsSrc],
    ['FunnlAIPage', aiSrc],
  ]
  for (const [name, src] of pageSrcPairs) {
    assert.ok(
      !src.includes('searchPlaceholder="Search contacts…"'),
      `${name} must not pass page-specific "Search contacts…" to TopBar searchPlaceholder`
    )
  }
})

// =============================================================================
// 5. TopBar search trigger fires CommandPalette — all pages wired
// =============================================================================

console.log('\n5. TopBar onSearchClick — all pages dispatch funnl:open-command-palette')

const CP_EVENT = 'funnl:open-command-palette'

test('ContactsPage dispatches CommandPalette event on TopBar click', () => {
  assert.ok(
    contactsSrc.includes(CP_EVENT),
    `ContactsPage must dispatch '${CP_EVENT}' in onSearchClick`
  )
})

test('FollowUpsPage dispatches CommandPalette event on TopBar click', () => {
  assert.ok(
    followupsSrc.includes(CP_EVENT),
    `FollowUpsPage must dispatch '${CP_EVENT}' in onSearchClick`
  )
})

test('FunnlAIPage dispatches CommandPalette event on TopBar click', () => {
  assert.ok(
    aiSrc.includes(CP_EVENT),
    `FunnlAIPage must dispatch '${CP_EVENT}' in onSearchClick`
  )
})

test('DashboardPage dispatches CommandPalette event on TopBar click', () => {
  assert.ok(
    dashSrc.includes(CP_EVENT),
    `DashboardPage must dispatch '${CP_EVENT}' in onSearchClick`
  )
})

// =============================================================================
// 6. ContactsPage — local search input is a real input (distinct from global launcher)
// =============================================================================

console.log('\n6. ContactsPage — local search is a real <input> coexisting with the global launcher')

test('local search control is a real <input type="text"> element', () => {
  // The local Contacts search is a real form input — users CAN type into it.
  // It must be an <input>, not a button or a div.
  assert.ok(
    contactsSrc.includes('<input') && contactsSrc.includes('type="text"'),
    'ContactsPage must have a real <input type="text"> for local contact search'
  )
})

test('local search input has onChange (it is a controlled, editable input)', () => {
  // A controlled input (value + onChange) cannot be mistaken for a read-only
  // display element. The user can type into it and the list filters in real time.
  assert.ok(
    contactsSrc.includes('onChange={e => setSearchQuery(e.target.value)}'),
    'local search input must be controlled with onChange={e => setSearchQuery(...)}'
  )
})

test('local search input uses a different (local-scope) placeholder', () => {
  // The local input placeholder must describe local behavior — filtering the
  // contact list — not the global launcher behavior. Having the same copy on
  // both would re-create the confusion this fix was designed to eliminate.
  assert.ok(
    contactsSrc.includes('Search name, company, role, notes…'),
    'local search input must use local-scope placeholder distinct from the global launcher'
  )
  assert.ok(
    !contactsSrc.includes(`placeholder="${GLOBAL_COPY}"`),
    'local search input must not use the global launcher copy as its placeholder'
  )
})

test('both global launcher and local input coexist in ContactsPage', () => {
  // The coexistence is intentional: the global launcher (TopBar) opens
  // CommandPalette across all content; the local input filters only the
  // displayed contact grid. They serve different scopes.
  const hasGlobalLauncher = contactsSrc.includes(CP_EVENT) && contactsSrc.includes(GLOBAL_COPY)
  const hasLocalInput = contactsSrc.includes('setSearchQuery') && contactsSrc.includes('type="text"')
  assert.ok(
    hasGlobalLauncher && hasLocalInput,
    'ContactsPage must have both a global TopBar launcher and a local search input'
  )
})

// =============================================================================
// Results
// =============================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
