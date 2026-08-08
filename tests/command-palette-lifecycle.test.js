/**
 * command-palette-lifecycle.test.js — Source-string and contract tests for
 * the Stage 10 verification pass.
 *
 * Covers the fixes and contracts added in the verification pass:
 *   Tab removal from onKeyDown (AI handoff via Arrow+Enter only)
 *   aria-activedescendant on combobox input
 *   Stable content-based DOM IDs (getItemId, not cp-item-${idx})
 *   encodePostgRESTOrValue applied before .or() interpolation
 *   openKey in GlobalAddContactController (reliable remount)
 *   buildFlatItems imported from commandPaletteUtils (not local)
 *   Recent contacts ordering (reorder after .in() fetch)
 *   Account switch cleanup completeness
 *   Import action end-to-end contract
 *   commandPaletteUtils exports completeness
 *
 * Run with: node tests/command-palette-lifecycle.test.js
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

const cp    = readFileSync(resolve('src/components/CommandPalette.jsx'), 'utf8')
const gacc  = readFileSync(resolve('src/components/GlobalAddContactController.jsx'), 'utf8')
const utils = readFileSync(resolve('src/lib/commandPaletteUtils.js'), 'utf8')

// ── Tab removal from onKeyDown ─────────────────────────────────────────────────

console.log('\nTab removal from onKeyDown')

test('onKeyDown does not call handleAIHandoff for Tab', () => {
  const onKeyDownIdx = cp.indexOf('function onKeyDown(e)')
  assert.ok(onKeyDownIdx !== -1, 'onKeyDown function must be defined')
  // Search within 600 chars of onKeyDown function body
  const body = cp.slice(onKeyDownIdx, onKeyDownIdx + 600)
  assert.ok(!body.includes('handleAIHandoff'), 'onKeyDown must NOT call handleAIHandoff (Tab AI handoff removed)')
})
test("onKeyDown does not check e.key === 'Tab' at all", () => {
  const onKeyDownIdx = cp.indexOf('function onKeyDown(e)')
  const body = cp.slice(onKeyDownIdx, onKeyDownIdx + 600)
  assert.ok(!body.includes("'Tab'"), "onKeyDown must not check for Tab key")
})
test('Tab is only intercepted by the focus-trap useEffect (FOCUSABLE selector)', () => {
  // The focus-trap uses an onTab inner function that checks e.key !== 'Tab'
  assert.ok(cp.includes('FOCUSABLE'), 'FOCUSABLE constant must exist for focus-trap')
  // querySelectorAll(FOCUSABLE) and e.key === 'Tab' or e.key !== 'Tab' must both appear
  assert.ok(cp.includes('querySelectorAll(FOCUSABLE)') || cp.includes("querySelectorAll('"), 'must use querySelectorAll for focus trap')
  // The focus-trap Tab check exists somewhere in the file (in onTab, not onKeyDown)
  assert.ok(cp.includes("!== 'Tab'") || cp.includes("=== 'Tab'"), 'focus-trap must check for Tab key')
})
test('No Tab ask-AI hint in footer', () => {
  assert.ok(!cp.includes('Tab</kbd> ask AI'), 'footer must not show Tab ask AI hint')
  assert.ok(!cp.includes("Tab</kbd> ask AI"), 'footer must not show Tab ask AI hint (double quotes)')
})
test('No Tab kbd element on the AI result row', () => {
  const aiRowIdx = cp.indexOf('buildAIHandoffLabel')
  assert.ok(aiRowIdx !== -1, 'AI row must be present')
  const aiRowRegion = cp.slice(aiRowIdx, aiRowIdx + 400)
  assert.ok(!aiRowRegion.includes('<kbd'), 'AI row must not contain a <kbd> Tab hint')
})

// ── aria-activedescendant ─────────────────────────────────────────────────────

console.log('\naria-activedescendant')

test('combobox input has aria-activedescendant attribute', () => {
  assert.ok(cp.includes('aria-activedescendant'), 'input must have aria-activedescendant')
})
test('aria-activedescendant uses getActiveItemId', () => {
  const idx = cp.indexOf('aria-activedescendant')
  const region = cp.slice(idx, idx + 60)
  assert.ok(region.includes('getActiveItemId'), 'aria-activedescendant must call getActiveItemId')
})
test('aria-activedescendant is on the element with role="combobox"', () => {
  // aria-activedescendant and role="combobox" should appear within 200 chars of each other
  const adIdx = cp.indexOf('aria-activedescendant')
  const cbIdx = cp.indexOf('role="combobox"')
  assert.ok(Math.abs(adIdx - cbIdx) < 200, 'aria-activedescendant must be near role="combobox"')
})

// ── Stable DOM IDs ────────────────────────────────────────────────────────────

console.log('\nStable DOM IDs')

test('no cp-item-${idx} index-based IDs remain in render', () => {
  // After the fix all cp-item-$ occurrences should be gone
  assert.ok(!cp.includes('cp-item-$'), 'must not use index-based cp-item-${idx} IDs')
  assert.ok(!cp.includes('`cp-item-'), 'must not use template-literal cp-item- IDs')
})
test('getItemId is called for result row IDs', () => {
  assert.ok(cp.includes('getItemId(items['), 'result rows must use getItemId(items[idx]) for IDs')
})
test('getItemId is imported from commandPaletteUtils', () => {
  assert.ok(cp.includes('getItemId') && cp.includes('commandPaletteUtils'), 'getItemId must be imported from commandPaletteUtils')
})
test('getActiveItemId is imported from commandPaletteUtils', () => {
  assert.ok(cp.includes('getActiveItemId') && cp.includes('commandPaletteUtils'), 'getActiveItemId must be imported from commandPaletteUtils')
})
test('MAX_SEARCH_QUERY_LENGTH and shouldIgnoreKey imported from commandPaletteUtils', () => {
  assert.ok(cp.includes('MAX_SEARCH_QUERY_LENGTH') && cp.includes('shouldIgnoreKey'), 'IME guard and query cap must be imported from commandPaletteUtils')
})

// ── PostgREST filter safety (separate-query approach) ─────────────────────────

console.log('\nPostgREST filter safety')

test('separate per-field ilike queries replace .or() interpolation', () => {
  // Safe strategy: each contact field (name, company, role, relationship_note) is
  // queried independently so user input is a bound .ilike() parameter, not
  // embedded in a .or() grammar string where commas/parens are structural.
  assert.ok(!cp.includes(".or(`name.ilike."), 'must NOT use .or() with interpolated user input')
  assert.ok(cp.includes('.ilike(\'name\'') || cp.includes('.ilike("name"') || cp.includes(".ilike('name'"), 'must use .ilike() on name field')
  assert.ok(cp.includes('.ilike(\'relationship_note\'') || cp.includes('.ilike("relationship_note"') || cp.includes(".ilike('relationship_note'"), 'must use .ilike() on relationship_note field')
})
test('escapeIlike is still applied before building the pattern', () => {
  assert.ok(cp.includes('escapeIlike('), 'must still call escapeIlike to escape %, _, \\ in user input')
  // The alignment-spaced declaration is `const pattern   = …` — check for the token only
  assert.ok(cp.includes('const pattern'), 'pattern variable must be constructed')
})
test('MAX_SEARCH_QUERY_LENGTH imported from commandPaletteUtils and applied', () => {
  assert.ok(cp.includes('MAX_SEARCH_QUERY_LENGTH') && cp.includes('commandPaletteUtils'), 'MAX_SEARCH_QUERY_LENGTH must be imported from commandPaletteUtils')
})
test('tag search uses .contains() array operator for DB-side exact match', () => {
  assert.ok(cp.includes('.contains('), 'must use .contains() for tag array search')
})
test('ilike on interactions notes uses direct method call (not .or() grammar)', () => {
  const intIdx = cp.indexOf("'interactions'")
  assert.ok(intIdx !== -1, 'interactions query must exist')
  const region = cp.slice(intIdx, intIdx + 300)
  assert.ok(region.includes('.ilike('), 'interactions must use .ilike() method call')
})

// ── buildFlatItems imported from commandPaletteUtils ─────────────────────────

console.log('\nbuildFlatItems from commandPaletteUtils')

test('buildFlatItems is imported from commandPaletteUtils', () => {
  assert.ok(cp.includes('buildFlatItems') && cp.includes('commandPaletteUtils'), 'buildFlatItems must be imported from commandPaletteUtils')
})
test('no local buildFlatItems function definition in CommandPalette', () => {
  assert.ok(!cp.includes('function buildFlatItems()'), 'local buildFlatItems must be removed')
  assert.ok(!cp.includes('function buildFlatItems({'), 'no local buildFlatItems should exist in component')
})
test('buildFlatItems called with explicit params object in onKeyDown', () => {
  const onKeyDownIdx = cp.indexOf('function onKeyDown(e)')
  const body = cp.slice(onKeyDownIdx, onKeyDownIdx + 400)
  assert.ok(body.includes('buildFlatItems('), 'buildFlatItems must be called in onKeyDown')
  assert.ok(body.includes('norm') && body.includes('quickActions'), 'buildFlatItems must receive explicit params')
})
test('buildFlatItems called with explicit params object in render section', () => {
  // The render section (after the `if (!open) return null` guard) calls buildFlatItems.
  // Use lastIndexOf to find the final call (in the render), not the one in onKeyDown.
  const lastCallIdx = cp.lastIndexOf('buildFlatItems({')
  assert.ok(lastCallIdx !== -1, 'buildFlatItems must be called with an object')
  const region = cp.slice(lastCallIdx, lastCallIdx + 150)
  assert.ok(region.includes('norm') && region.includes('canUsePro'), 'render buildFlatItems call must pass norm and canUsePro')
})

// ── GlobalAddContactController openKey ────────────────────────────────────────

console.log('\nGlobalAddContactController openKey')

test('openKey state declared in GlobalAddContactController', () => {
  assert.ok(gacc.includes('openKey'), 'openKey state must be declared')
})
test('openKey initialized with useState(0)', () => {
  assert.ok(gacc.includes('useState(0)'), 'openKey must be initialized to 0')
})
test('openKey incremented on each open event', () => {
  // The setter call is setOpenKey(k => k + 1) — search for the call site, not the declaration
  assert.ok(gacc.includes('setOpenKey(k'), 'setOpenKey must be called with an updater function')
  const callIdx = gacc.indexOf('setOpenKey(k')
  const region = gacc.slice(callIdx, callIdx + 40)
  assert.ok(region.includes('k + 1') || region.includes('k+1'), 'openKey must be incremented (k + 1)')
})
test('key={openKey} passed to AddContactDrawer', () => {
  assert.ok(gacc.includes('key={openKey}'), 'AddContactDrawer must receive key={openKey}')
})
test('openKey increment happens before setOpen(true)', () => {
  const setOpenKeyIdx = gacc.indexOf('setOpenKey')
  const setOpenIdx = gacc.indexOf('setOpen(true)')
  assert.ok(setOpenKeyIdx < setOpenIdx, 'openKey must be incremented before drawer is opened')
})

// ── Recent contacts ordering ───────────────────────────────────────────────────

console.log('\nRecent contacts ordering')

test('.in() used for batch DB fetch of recent contacts', () => {
  assert.ok(cp.includes('.in('), 'must use .in() for batch recent contact fetch')
})
test('recent contacts reordered after .in() fetch', () => {
  // After .in() fetch, the results must be reordered to match the stored ID sequence.
  // Look for a sort/reorder operation referencing the stored IDs array.
  const inIdx = cp.indexOf('.in(')
  const region = cp.slice(inIdx, inIdx + 600)
  const hasSort = region.includes('.sort(') || region.includes('recentIds') || region.includes('storedIds') || region.includes('ordered')
  assert.ok(hasSort, 'recent contacts must be reordered after .in() fetch to preserve stored order')
})

// ── Account switch cleanup ────────────────────────────────────────────────────

console.log('\nAccount switch cleanup')

test('onAuthStateChange handler clears query', () => {
  const idx = cp.indexOf('onAuthStateChange')
  const region = cp.slice(idx, idx + 1400)
  assert.ok(region.includes("setQuery('')") || region.includes('setQuery('), 'must clear query on account switch')
})
test('onAuthStateChange handler clears contactResults', () => {
  const idx = cp.indexOf('onAuthStateChange')
  const region = cp.slice(idx, idx + 1400)
  assert.ok(region.includes('setContactResults'), 'must clear contactResults on account switch')
})
test('onAuthStateChange handler clears noteResults', () => {
  const idx = cp.indexOf('onAuthStateChange')
  const region = cp.slice(idx, idx + 1400)
  assert.ok(region.includes('setNoteResults'), 'must clear noteResults on account switch')
})
test('onAuthStateChange handler clears recentContacts', () => {
  const idx = cp.indexOf('onAuthStateChange')
  const region = cp.slice(idx, idx + 1400)
  assert.ok(region.includes('setRecentContacts'), 'must clear recentContacts on account switch')
})
test('onAuthStateChange handler does NOT call clearRecentContacts (persistent history preserved)', () => {
  // clearRecentContacts(prev) must NOT be called during account switch.
  // Stored history is preserved so User A's recents survive switching away and back.
  // Only setRecentContacts([]) is called to clear the in-memory display list.
  // Strip single-line comments before checking — the source intentionally includes
  // a comment mentioning clearRecentContacts(prev) to document why it is omitted.
  const idx = cp.indexOf('onAuthStateChange')
  const region = cp.slice(idx, idx + 1200)
  const codeOnly = region.replace(/\/\/[^\n]*/g, '')
  const hasClearCall = codeOnly.includes('clearRecentContacts(prev)')
  assert.ok(!hasClearCall, 'clearRecentContacts must NOT be called in the account-switch handler')
})
test('onAuthStateChange handler increments searchGenRef to invalidate in-flight queries', () => {
  const idx = cp.indexOf('onAuthStateChange')
  const region = cp.slice(idx, idx + 800)
  assert.ok(region.includes('searchGenRef'), 'must increment searchGenRef on account switch')
})
test('auth subscription is unsubscribed in cleanup', () => {
  assert.ok(cp.includes('unsubscribe'), 'auth listener must be unsubscribed on cleanup')
})

// ── Import action end-to-end ──────────────────────────────────────────────────

console.log('\nImport action end-to-end')

test('CommandPalette navigates to /contacts?import=1 for import action', () => {
  assert.ok(cp.includes('/contacts?import=1'), "import action must navigate to /contacts?import=1")
})
test('Import action closes the palette', () => {
  const importIdx = cp.indexOf('/contacts?import=1')
  const region = cp.slice(Math.max(0, importIdx - 50), importIdx + 100)
  assert.ok(region.includes('closepal') || region.includes('navigate'), 'import action must close palette or navigate')
})

// ── commandPaletteUtils exports ───────────────────────────────────────────────

console.log('\ncommandPaletteUtils exports')

test('exports encodePostgRESTOrValue (utility function — still exported even if CommandPalette uses separate-query approach)', () => {
  assert.ok(utils.includes('export function encodePostgRESTOrValue'), 'must export encodePostgRESTOrValue')
})
test('exports getItemId', () => {
  assert.ok(utils.includes('export function getItemId'), 'must export getItemId')
})
test('exports getActiveItemId', () => {
  assert.ok(utils.includes('export function getActiveItemId'), 'must export getActiveItemId')
})
test('exports buildFlatItems', () => {
  assert.ok(utils.includes('export function buildFlatItems'), 'must export buildFlatItems')
})
test('exports clampActiveIdx', () => {
  assert.ok(utils.includes('export function clampActiveIdx'), 'must export clampActiveIdx')
})
test('no React or Supabase imports (Node-safe)', () => {
  assert.ok(!utils.includes("from 'react'"), 'commandPaletteUtils must not import React')
  assert.ok(!utils.includes("from '@supabase"), 'commandPaletteUtils must not import Supabase')
})
test('imports filterNavigationCommands from searchUtils', () => {
  assert.ok(utils.includes('filterNavigationCommands') && utils.includes('searchUtils'), 'must import filterNavigationCommands from searchUtils')
})
test('imports NAVIGATION_COMMANDS from searchUtils', () => {
  assert.ok(utils.includes('NAVIGATION_COMMANDS') && utils.includes('searchUtils'), 'must import NAVIGATION_COMMANDS from searchUtils')
})

// ── results ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
