/**
 * search-command-palette.test.js — Source-string tests for CommandPalette.jsx
 *
 * Tests the implementation contracts of the upgraded CommandPalette without
 * rendering React.  All assertions are on the raw source text.
 *
 * Run with: node tests/search-command-palette.test.js
 *
 * Covers:
 *   Imports & dependencies
 *   Debounce
 *   ILIKE escaping
 *   Contact query fields (relationship_note)
 *   Interaction notes query
 *   Navigation commands
 *   Log Interaction flow
 *   Import action
 *   AI handoff (Arrow+Enter; Tab removed; router state)
 *   Recent contacts (localStorage)
 *   No-results prefill
 *   Mobile full-screen
 *   Focus trap
 *   Account-switch cleanup
 *   ProStatus usage (no independent RPC)
 *   Forbidden patterns (no raw color, no dangerouslySetInnerHTML, no purple/violet/indigo)
 *   ARIA attributes
 *   Stale-query guard
 *   Keyboard shortcuts
 *   Result grouping (section labels)
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

const src = readFileSync(resolve('src/components/CommandPalette.jsx'), 'utf8')

// ── Imports & dependencies ─────────────────────────────────────────────────────

console.log('\nImports & dependencies')

test('imports useProStatus from lib/useProStatus', () => {
  assert.ok(src.includes("from '../lib/useProStatus'"), 'must import useProStatus')
})
test('imports classifyProStatus from lib/pro-ui-status', () => {
  assert.ok(src.includes("from '../lib/pro-ui-status'"), 'must import classifyProStatus')
})
test('imports escapeIlike from searchUtils', () => {
  assert.ok(src.includes('escapeIlike') && src.includes('searchUtils'), 'must import escapeIlike from searchUtils')
})
test('imports highlightSegments from searchUtils', () => {
  assert.ok(src.includes('highlightSegments') && src.includes('searchUtils'), 'must import highlightSegments')
})
test('imports extractNoteSnippet from searchUtils', () => {
  assert.ok(src.includes('extractNoteSnippet') && src.includes('searchUtils'), 'must import extractNoteSnippet')
})
test('imports readRecentContacts and writeRecentContact from searchUtils', () => {
  assert.ok(src.includes('readRecentContacts') && src.includes('writeRecentContact'), 'must import recent-contact helpers')
})
test('imports NAVIGATION_COMMANDS from searchUtils', () => {
  assert.ok(src.includes('NAVIGATION_COMMANDS'), 'must import NAVIGATION_COMMANDS')
})
test('imports filterNavigationCommands from searchUtils', () => {
  assert.ok(src.includes('filterNavigationCommands'), 'must import filterNavigationCommands')
})
test('imports buildAIPrefillState from searchUtils', () => {
  assert.ok(src.includes('buildAIPrefillState'), 'must import buildAIPrefillState')
})
test('imports buildAIHandoffLabel from searchUtils', () => {
  assert.ok(src.includes('buildAIHandoffLabel'), 'must import buildAIHandoffLabel')
})
test('imports buildNoResultPrefill from searchUtils', () => {
  assert.ok(src.includes('buildNoResultPrefill'), 'must import buildNoResultPrefill')
})
test('imports resolveActivationAction from activationActionCoordinator', () => {
  assert.ok(src.includes('resolveActivationAction') && src.includes('activationActionCoordinator'), 'must import resolveActivationAction')
})
test('imports buildPickerNavigationState from contactPickerUtils', () => {
  assert.ok(src.includes('buildPickerNavigationState') && src.includes('contactPickerUtils'), 'must import buildPickerNavigationState')
})
test('imports supabase client', () => {
  assert.ok(src.includes("from '../lib/supabase'"), 'must import supabase')
})

// ── Debounce ──────────────────────────────────────────────────────────────────

console.log('\nDebounce')

test('debounce constant DEBOUNCE_MS = 200', () => {
  assert.ok(src.includes('DEBOUNCE_MS') && src.includes('200'), 'must define DEBOUNCE_MS = 200')
})
test('debounceRef declared as useRef', () => {
  assert.ok(src.includes('debounceRef') && src.includes('useRef'), 'must declare debounceRef')
})
test('setTimeout used with debounceRef for search', () => {
  assert.ok(
    src.includes('debounceRef.current') && src.includes('setTimeout'),
    'search must use debounceRef with setTimeout'
  )
})
test('debounce cleared on query change', () => {
  assert.ok(
    src.includes('clearTimeout(debounceRef.current)'),
    'must clear debounceRef on each query change'
  )
})
test('debounce cleared in cleanup / close', () => {
  // clearTimeout called in cleanup (not just in query effect)
  const matches = (src.match(/clearTimeout/g) || []).length
  assert.ok(matches >= 2, `must call clearTimeout at least twice, found ${matches}`)
})

// ── ILIKE escaping ────────────────────────────────────────────────────────────

console.log('\nILIKE escaping')

test('escapeIlike is called in the search effect', () => {
  // After the separate-query refactor the query is bounded to MAX_SEARCH_QUERY_LENGTH
  // before escaping, so the call is escapeIlike(boundNorm), not escapeIlike(norm).
  assert.ok(src.includes('escapeIlike(boundNorm)') || src.includes('escapeIlike(norm)'), 'must call escapeIlike on the normalized query')
})
test('pattern variable wraps ILIKE-escaped value in % delimiters', () => {
  // After the separate-query refactor, the pattern is built from escaped (not safeVal),
  // because each field query passes the value as a bound .ilike() parameter rather
  // than interpolating into a .or() grammar string.
  assert.ok(
    src.includes('`%${escaped}%`') || src.includes('`%${safeVal}%`') || src.includes("'%'+escaped+'%'"),
    'must wrap the ilike value in % delimiters'
  )
})

// ── Contact query fields ───────────────────────────────────────────────────────

console.log('\nContact query fields')

test('contact query includes relationship_note in select', () => {
  assert.ok(src.includes('relationship_note'), 'contacts query must select relationship_note')
})
test('contact ilike includes relationship_note', () => {
  const ilIkeMatcher = /ilike.*relationship_note|relationship_note.*ilike/
  assert.ok(ilIkeMatcher.test(src), 'contact query must filter by relationship_note')
})
test('contact query includes name, company, role in select', () => {
  // These were in the original; must still be present
  const contactSelectIdx = src.indexOf("'contacts'")
  assert.ok(contactSelectIdx !== -1, 'contacts table must be queried')
  const region = src.slice(contactSelectIdx, contactSelectIdx + 300)
  assert.ok(region.includes('name') && region.includes('company') && region.includes('role'), 'contact select must include name, company, role')
})
test('contact query has a .limit() call', () => {
  assert.ok(src.includes('.limit('), 'contact query must have a result limit')
})

// ── Interaction notes query ────────────────────────────────────────────────────

console.log('\nInteraction notes query')

test('interactions table is queried for notes search', () => {
  assert.ok(src.includes("'interactions'"), 'must query the interactions table')
})
test('interactions query selects notes field', () => {
  const intIdx = src.indexOf("'interactions'")
  const region = src.slice(intIdx, intIdx + 300)
  assert.ok(region.includes('notes'), 'interactions query must select notes')
})
test('interactions query uses ilike on notes', () => {
  const intIdx = src.indexOf("'interactions'")
  const region = src.slice(intIdx, intIdx + 400)
  assert.ok(region.includes('ilike'), 'interactions query must use ilike')
})
test('interactions query joins contacts via !inner', () => {
  assert.ok(src.includes('contacts!inner'), 'interactions query must join contacts with !inner')
})
test('queries run concurrently (Promise.allSettled)', () => {
  assert.ok(src.includes('Promise.allSettled'), 'queries must run concurrently with Promise.allSettled')
})
test('separate per-field ilike queries (no .or() interpolation)', () => {
  // Safe filter strategy: each field is queried independently so user input is
  // passed as a bound .ilike() parameter, not interpolated into a .or() string.
  assert.ok(!src.includes(".or(`name.ilike."), 'must NOT use .or() with interpolated user input')
  assert.ok(!src.includes('.or(`name.ilike.'), 'must NOT use .or() with interpolated user input (template)')
})
test('tag search uses .contains() array operator', () => {
  assert.ok(src.includes('.contains('), 'tag search must use .contains() array operator')
})

// ── Navigation commands ────────────────────────────────────────────────────────

console.log('\nNavigation commands')

test('NAVIGATION_COMMANDS used for nav results', () => {
  assert.ok(src.includes('NAVIGATION_COMMANDS'), 'must reference NAVIGATION_COMMANDS')
})
test('filterNavigationCommands called with query and canUsePro', () => {
  assert.ok(src.includes('filterNavigationCommands'), 'must call filterNavigationCommands')
})
test('Section label for navigation ("Go to" or "Navigation")', () => {
  assert.ok(src.includes('Go to') || src.includes('Navigation'), 'must have a "Go to" section label')
})
test('navigate() called when nav command is selected', () => {
  // nav commands use navigate(nav.route)
  assert.ok(src.includes('nav.route'), 'must navigate to nav.route')
})

// ── Log Interaction flow ───────────────────────────────────────────────────────

console.log('\nLog Interaction flow')

test('handleLogInteraction function present', () => {
  assert.ok(src.includes('handleLogInteraction'), 'handleLogInteraction must be defined')
})
test('resolveActivationAction called somewhere in the component', () => {
  // handleLogInteraction first appears in the block comment; search the full source.
  assert.ok(src.includes('resolveActivationAction'), 'must call resolveActivationAction')
})
test('open_drawer path dispatches funnl:open-add-contact', () => {
  assert.ok(src.includes("'funnl:open-add-contact'"), 'open_drawer path must dispatch funnl:open-add-contact')
})
test('open_picker path sets pickerContacts state', () => {
  assert.ok(src.includes('setPickerContacts'), 'must call setPickerContacts for picker flow')
})
test('navigate path uses buildPickerNavigationState', () => {
  assert.ok(src.includes('buildPickerNavigationState'), 'navigate path must use buildPickerNavigationState')
})

// ── Import action ─────────────────────────────────────────────────────────────

console.log('\nImport action')

test("import action navigates to '/contacts?import=1'", () => {
  assert.ok(src.includes('/contacts?import=1'), "import action must navigate to /contacts?import=1")
})

// ── AI handoff ────────────────────────────────────────────────────────────────

console.log('\nAI handoff')

test('handleAIHandoff function present', () => {
  assert.ok(src.includes('handleAIHandoff'), 'handleAIHandoff must be defined')
})
test('AI handoff guarded by canUsePro', () => {
  const idx = src.indexOf('handleAIHandoff')
  const region = src.slice(idx, idx + 300)
  assert.ok(region.includes('canUsePro'), 'handleAIHandoff must check canUsePro')
})
test('AI handoff uses buildAIPrefillState for router state', () => {
  assert.ok(src.includes('buildAIPrefillState'), 'AI handoff must call buildAIPrefillState')
})
test("AI handoff navigates to '/ai'", () => {
  assert.ok(src.includes("'/ai'") || src.includes('"/ai"'), "AI handoff must navigate to /ai")
})
test('Tab key does NOT intercept for AI handoff in onKeyDown (Tab is focus-trap only)', () => {
  // The Tab → AI handoff was removed. Tab is handled only by the focus-trap
  // useEffect (FOCUSABLE selector), not by onKeyDown for AI navigation.
  // AI row is reached via ArrowDown + Enter or click.
  const onKeyDownIdx = src.indexOf('function onKeyDown(e)')
  assert.ok(onKeyDownIdx !== -1, 'onKeyDown must be defined')
  const onKeyDownBody = src.slice(onKeyDownIdx, onKeyDownIdx + 600)
  assert.ok(!onKeyDownBody.includes('handleAIHandoff'), 'onKeyDown must NOT call handleAIHandoff for Tab')
})
test('No Tab kbd hint shown on AI row or in footer', () => {
  // Tab hints for AI were removed; footer shows only ↑↓, ↵, esc
  const footerIdx = src.lastIndexOf('navigate</span>')
  // Check that "Tab" + "ask AI" do not co-appear as a footer hint
  assert.ok(!src.includes('Tab</kbd> ask AI') && !src.includes('Tab</kbd> ask AI'), 'footer must NOT show Tab ask AI hint')
  // Check AI row has no Tab <kbd> element
  const aiRowIdx = src.indexOf('buildAIHandoffLabel')
  const aiRowRegion = src.slice(aiRowIdx, aiRowIdx + 300)
  assert.ok(!aiRowRegion.includes('<kbd'), 'AI row must NOT contain a <kbd> Tab hint')
})
test('buildAIHandoffLabel used for AI row label', () => {
  assert.ok(src.includes('buildAIHandoffLabel'), 'must use buildAIHandoffLabel for the AI result label')
})

// ── Recent contacts (localStorage) ───────────────────────────────────────────

console.log('\nRecent contacts')

test('readRecentContacts called for recent contacts', () => {
  assert.ok(src.includes('readRecentContacts'), 'must call readRecentContacts')
})
test('writeRecentContact called on contact activation', () => {
  assert.ok(src.includes('writeRecentContact'), 'must call writeRecentContact when contact is opened')
})
test('clearRecentContacts is imported (used for explicit user-initiated history clearing)', () => {
  // clearRecentContacts must still be imported from searchUtils so it is
  // available for future user-facing "clear history" actions.
  // It must NOT be called during account-switch; stored history is preserved
  // so User A's recents survive switching to User B and back.
  assert.ok(src.includes('clearRecentContacts'), 'clearRecentContacts must be imported')
})
test('clearRecentContacts is NOT called inside the account-switch handler', () => {
  // The account-switch block must only clear in-memory state; it must not
  // delete the other user's persistent storage history.
  // Strip single-line comments first — the source intentionally includes a comment
  // mentioning clearRecentContacts(prev) to document WHY it is absent.
  const authIdx = src.indexOf('onAuthStateChange')
  const switchBlock = src.slice(authIdx, authIdx + 1200)
  const codeOnly = switchBlock.replace(/\/\/[^\n]*/g, '')
  const hasClearCall = codeOnly.includes('clearRecentContacts(prev)') ||
    codeOnly.includes('clearRecentContacts(newUid)')
  assert.ok(!hasClearCall, 'clearRecentContacts must NOT be called in the account-switch handler')
})
test('uid state tracks current user for recent contacts scoping', () => {
  assert.ok(src.includes('setUid') || src.includes('[uid,'), 'must track uid for recent contacts scoping')
})
test('recent contacts fetched via DB batch when ids present', () => {
  assert.ok(src.includes('.in('), 'must batch-fetch recent contacts by IDs using .in()')
})

// ── No-results prefill ─────────────────────────────────────────────────────────

console.log('\nNo-results prefill')

test('buildNoResultPrefill called for no-results state', () => {
  assert.ok(src.includes('buildNoResultPrefill'), 'must call buildNoResultPrefill')
})
test('no-results "Add X as contact" dispatches funnl:open-add-contact with prefillName', () => {
  assert.ok(src.includes('prefillName'), 'no-results action must pass prefillName in event detail')
})

// ── Mobile full-screen ─────────────────────────────────────────────────────────

console.log('\nMobile full-screen')

test('mobile Cancel button present (md:hidden)', () => {
  assert.ok(src.includes('md:hidden') && src.includes('Cancel'), 'must have md:hidden Cancel button for mobile')
})
test('panel uses h-dvh for dynamic viewport height on mobile (software-keyboard-safe)', () => {
  // h-dvh (100dvh) adjusts as the virtual keyboard appears; h-full is kept as
  // a secondary class for browsers that do not support dvh units.
  assert.ok(src.includes('h-dvh'), 'panel must include h-dvh for mobile viewport height')
  assert.ok(src.includes('h-full'), 'h-full must be retained as a fallback')
})
test('panel has rounded corners on desktop (md:rounded)', () => {
  assert.ok(src.includes('md:rounded'), 'panel must have md:rounded corners (desktop only)')
})
test('mobile safe-area padding present', () => {
  assert.ok(
    src.includes('safe-area-inset-bottom') || src.includes('env(safe-area-inset-bottom'),
    'must include safe-area-inset-bottom for mobile'
  )
})

// ── Focus trap ─────────────────────────────────────────────────────────────────

console.log('\nFocus trap')

test('Tab key intercepted for focus trap', () => {
  // Focus trap intercepts Tab
  const focusTrapRegion = src.indexOf('FOCUSABLE')
  assert.ok(focusTrapRegion !== -1, 'FOCUSABLE selector must be defined for focus trap')
})
test('querySelectorAll(FOCUSABLE) used to find focusable elements', () => {
  assert.ok(src.includes('querySelectorAll'), 'must use querySelectorAll to find focusable elements')
})
test('focus restored on close', () => {
  assert.ok(src.includes('triggerRef') || src.includes('focusRestoreRef') || src.includes('triggerRef.current'), 'must restore focus to trigger element on close')
})
test('panelRef tracks the dialog panel for focus trap', () => {
  assert.ok(src.includes('panelRef'), 'panelRef must be used for focus trap boundary')
})

// ── Account-switch cleanup ─────────────────────────────────────────────────────

console.log('\nAccount-switch cleanup')

test('onAuthStateChange used for account switch detection', () => {
  assert.ok(src.includes('onAuthStateChange'), 'must use onAuthStateChange for account switch')
})
test('account switch clears query state', () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes("setQuery('')") || region.includes("setQuery"), 'must clear query on account switch')
})
test('account switch clears contact results', () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 800)
  assert.ok(region.includes('setContactResults') || region.includes('Contact'), 'must clear contact results on account switch')
})
test('account switch clears in-memory recent contacts (setRecentContacts)', () => {
  const idx = src.indexOf('onAuthStateChange')
  const region = src.slice(idx, idx + 1200)
  assert.ok(region.includes('setRecentContacts'), 'must call setRecentContacts to clear in-memory recents on account switch')
})
test('auth subscription unsubscribed on cleanup', () => {
  assert.ok(src.includes('unsubscribe'), 'must unsubscribe auth listener on cleanup')
})
test('searchGenRef incremented on account switch to invalidate in-flight queries', () => {
  assert.ok(src.includes('searchGenRef'), 'must use searchGenRef to invalidate stale queries')
})

// ── ProStatus usage ────────────────────────────────────────────────────────────

console.log('\nProStatus usage (shared RPC, no independent call)')

test('useProStatus() used (not getProAccessStatus directly)', () => {
  assert.ok(src.includes('useProStatus()'), 'must call useProStatus() from shared context')
})
test('classifyProStatus applied to proStatus', () => {
  assert.ok(src.includes('classifyProStatus(proStatus)'), 'must call classifyProStatus(proStatus)')
})
test('canUsePro derived from displayStatus', () => {
  assert.ok(src.includes('canUsePro'), 'must derive canUsePro for Pro-gated features')
})
test('AI section only rendered when canUsePro=true', () => {
  // The "Ask" section is wrapped in a canUsePro check
  const askIdx = src.lastIndexOf('Ask')
  const region = src.slice(Math.max(0, askIdx - 200), askIdx + 50)
  assert.ok(region.includes('canUsePro'), 'Ask AI section must be gated by canUsePro')
})

// ── Stale-query guard ──────────────────────────────────────────────────────────

console.log('\nStale-query guard')

test('searchGenRef declared as useRef', () => {
  assert.ok(src.includes('searchGenRef') && src.includes('useRef'), 'searchGenRef must be a useRef')
})
test('generation counter incremented before each search', () => {
  assert.ok(
    src.includes('++searchGenRef.current') || src.includes('searchGenRef.current++'),
    'must increment searchGenRef.current before each search'
  )
})
test('stale check after async DB calls', () => {
  // Accept either ordering: gen !== searchGenRef.current  OR  searchGenRef.current !== gen
  const hasForward  = src.includes('gen !== searchGenRef.current')
  const hasReversed = src.includes('searchGenRef.current !== gen')
  assert.ok(hasForward || hasReversed, 'must compare gen against searchGenRef.current to discard stale results')
})

// ── Keyboard shortcuts ─────────────────────────────────────────────────────────

console.log('\nKeyboard shortcuts')

test('⌘K or Ctrl+K opens palette (metaKey || ctrlKey)', () => {
  assert.ok(
    (src.includes('metaKey') || src.includes('ctrlKey')) && src.includes("'k'"),
    'must handle ⌘K/Ctrl+K shortcut'
  )
})
test('Escape closes palette', () => {
  assert.ok(src.includes("'Escape'") && src.includes('closepal'), 'Escape key must close palette')
})
test('ArrowDown navigates to next result', () => {
  assert.ok(src.includes("'ArrowDown'"), 'ArrowDown must be handled')
})
test('ArrowUp navigates to previous result', () => {
  assert.ok(src.includes("'ArrowUp'"), 'ArrowUp must be handled')
})
test('Enter activates highlighted result', () => {
  assert.ok(src.includes("'Enter'"), 'Enter must activate the selected result')
})

// ── Result grouping (section labels) ──────────────────────────────────────────

console.log('\nResult grouping (section labels)')

test('Recent contacts section label present', () => {
  assert.ok(src.includes('Recent'), 'must have a Recent section label')
})
test('Contacts section label present', () => {
  assert.ok(src.includes('Contacts'), 'must have a Contacts section label')
})
test('Notes section label present', () => {
  assert.ok(src.includes('Notes'), 'must have a Notes section label')
})
test('Quick actions section label present', () => {
  assert.ok(src.includes('Quick actions') || src.includes('quick-actions') || src.includes('Quick'), 'must have a Quick actions label')
})
test('SectionLabel component defined', () => {
  assert.ok(src.includes('SectionLabel'), 'must define a SectionLabel component or function')
})

// ── ARIA attributes ────────────────────────────────────────────────────────────

console.log('\nARIA attributes')

test('dialog has role="dialog"', () => {
  assert.ok(src.includes('role="dialog"'), 'palette must have role="dialog"')
})
test('dialog has aria-modal="true"', () => {
  assert.ok(src.includes('aria-modal="true"'), 'dialog must have aria-modal="true"')
})
test('dialog has aria-label', () => {
  assert.ok(src.includes('aria-label=') && src.includes('dialog'), 'dialog must have aria-label')
})
test('search input has role="combobox"', () => {
  assert.ok(src.includes('role="combobox"'), 'search input must have role="combobox"')
})
test('results list has role="listbox"', () => {
  assert.ok(src.includes('role="listbox"'), 'results list must have role="listbox"')
})
test('result items have role="option"', () => {
  assert.ok(src.includes('role="option"'), 'result items must have role="option"')
})
test('aria-live region present for screen readers', () => {
  assert.ok(src.includes('aria-live'), 'must have aria-live for dynamic result updates')
})
test('aria-selected on result items', () => {
  assert.ok(src.includes('aria-selected'), 'result items must have aria-selected')
})

// ── Forbidden patterns ─────────────────────────────────────────────────────────

console.log('\nForbidden patterns')

test('no dangerouslySetInnerHTML', () => {
  assert.ok(!src.includes('dangerouslySetInnerHTML'), 'must NOT use dangerouslySetInnerHTML')
})
test('no raw violet/indigo/purple Tailwind color classes (Funnl uses ember)', () => {
  // Check for the hard-coded class names that the old design used
  const forbidden = /\btext-violet-|bg-violet-|text-indigo-|bg-indigo-|text-purple-|bg-purple-/
  assert.ok(!forbidden.test(src), 'must NOT use violet/indigo/purple Tailwind color classes')
})
test('no raw hex colors in style props that bypass design tokens', () => {
  // Allow ember-related and known one-off overlay colors; no random palette hardcodings
  // Scan for direct #rrggbb that are NOT known constants
  const hexes = src.match(/#[0-9a-fA-F]{6}/g) || []
  const allowed = new Set([
    '#FF4423',  // ember
    '#060608',  // bg-base
    '#0B0B0E',  // bg-surface
    '#141419',  // bg-card
    '#1A1A21',  // bg-elevated
    '#F4F3F8',  // text-hi
    '#8B7CFF',  // accent (legacy reference)
    '#5B45F0',  // brand gradient
  ])
  const unknown = hexes.filter(h => !allowed.has(h.toUpperCase()) && !allowed.has(h))
  assert.ok(unknown.length === 0, `Found unrecognized hex colors: ${unknown.join(', ')}`)
})

// ── results ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
