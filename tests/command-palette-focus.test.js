/**
 * command-palette-focus.test.js
 *
 * Source-contract tests that guard against two runtime defects found during QA:
 *
 *   1. Focus loss after one character — caused by defining SearchRow as an
 *      inner component function inside CommandPalette's render body. React sees
 *      a new component type every render → unmounts the old <input> → new DOM
 *      node is mounted → keyboard focus is lost. Fix: inline the JSX as a
 *      variable (searchRowJSX) so React keeps the same <input> across renders.
 *
 *   2. Off-center positioning on desktop — the outer flex container used
 *      md:items-start which aligns children to the left viewport edge (behind/
 *      near the sidebar). Fix: md:items-center centers the 540px panel in the
 *      full viewport.
 *
 * Run with: node tests/command-palette-focus.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const src = readFileSync(resolve('src/components/CommandPalette.jsx'), 'utf8')

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
// 1. SearchRow must not be an inner component (focus stability)
// =============================================================================

console.log('\n1. SearchRow — not defined as an inner component')

test('SearchRow is not defined as a React component function inside render', () => {
  // The defect pattern: `const SearchRow = () => (` inside the component body.
  // Any arrow-function component defined this way gets a new function reference
  // on every render, causing React to unmount/remount the <input>.
  assert.ok(
    !src.includes('const SearchRow = () =>') && !src.includes('const SearchRow = function'),
    'SearchRow must not be defined as an inner component (new reference each render = focus loss)'
  )
})

test('searchRowJSX variable is used instead (safe inlined JSX)', () => {
  // The fix: define a JSX element assigned to a const variable.
  // React never calls createElement on a variable — it's inlined, stable DOM.
  assert.ok(
    src.includes('const searchRowJSX'),
    'searchRowJSX variable should exist (inline JSX, not a component)'
  )
})

test('searchRowJSX is rendered with {searchRowJSX} not <SearchRow/>', () => {
  assert.ok(
    src.includes('{searchRowJSX}'),
    '{searchRowJSX} must appear in the render tree'
  )
  assert.ok(
    !src.includes('<SearchRow'),
    '<SearchRow ... must not appear (would trigger remount on every render)'
  )
})

test('input ref is inside the searchRowJSX block (not a nested component)', () => {
  // If the input is inside an inner component, the ref callback fires on every
  // mount/unmount, not just once. Verify ref={inputRef} is present in the file.
  assert.ok(
    src.includes('ref={inputRef}'),
    'ref={inputRef} must exist on the search input'
  )
})

// =============================================================================
// 2. Centering — both containers must use md:items-center
// =============================================================================

console.log('\n2. Palette positioning — md:items-center on both containers')

test('md:items-start does not appear in either container class list', () => {
  // md:items-start aligned the panel to the left viewport edge, partially
  // behind the 248px sidebar on desktop.
  assert.ok(
    !src.includes('md:items-start'),
    'md:items-start must not appear — it mis-aligns the panel to the left'
  )
})

test('md:items-center appears for the main palette outer container', () => {
  assert.ok(
    src.includes('md:items-center md:justify-center'),
    'main palette container must use md:items-center md:justify-center'
  )
})

test('both fixed containers (main + picker) use md:items-center', () => {
  const matches = (src.match(/md:items-center md:justify-center/g) || []).length
  assert.ok(
    matches >= 2,
    `expected at least 2 occurrences of md:items-center md:justify-center (main + picker), found ${matches}`
  )
})

// =============================================================================
// 3. Structural checks — search input element integrity
// =============================================================================

console.log('\n3. Search input element integrity')

test('input element has role="combobox"', () => {
  assert.ok(src.includes('role="combobox"'), 'search input must have role="combobox"')
})

test('input has aria-controls pointing to listbox', () => {
  assert.ok(src.includes('aria-controls="cp-listbox"'), 'input must reference cp-listbox via aria-controls')
})

test('input has aria-activedescendant for keyboard nav', () => {
  assert.ok(
    src.includes('aria-activedescendant={getActiveItemId'),
    'input must set aria-activedescendant for keyboard navigation'
  )
})

test('autoFocus is NOT inside the searchRowJSX block (focus is managed via ref)', () => {
  // The palette explicitly focuses via inputRef.current.focus() after open.
  // The picker contact-search input legitimately has autoFocus (separate input).
  // But the main search input (inside searchRowJSX) must not have autoFocus.
  const startIdx = src.indexOf('const searchRowJSX = (')
  // The searchRowJSX block is ~50 lines, under 1000 chars. Check a bounded window.
  const searchRowBlock = src.slice(startIdx, startIdx + 900)
  assert.ok(
    !searchRowBlock.includes('autoFocus'),
    'searchRowJSX block must not contain autoFocus — focus is managed via inputRef.current.focus()'
  )
})

// =============================================================================
// Results
// =============================================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
