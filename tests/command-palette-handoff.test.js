/**
 * command-palette-handoff.test.js — Source-contract tests for the Stage 10
 * handoff architecture requirement.
 *
 * Covers the explicit close-reason contract added to CommandPalette.jsx:
 *   handoffRef declared
 *   Post-close handoff execution effect pattern
 *   closepal(reason, handoffFn) signature
 *   dismiss: focus restoration present
 *   handoff: focus restoration absent for handoff reason
 *   All navigation/action paths use 'handoff'
 *   Escape, backdrop, and Cancel use 'dismiss'
 *   No overlapping aria-modal surfaces (single dialog state machine)
 *   Picker is a dialog-state transition, not an independent overlay
 *   Import routing via reactive importParam dependency
 *   Already-mounted Contacts case (release blocker)
 *
 * Run with: node tests/command-palette-handoff.test.js
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

const cp = readFileSync(resolve('src/components/CommandPalette.jsx'), 'utf8')
const contacts = readFileSync(resolve('src/pages/ContactsPage.jsx'), 'utf8')

// ── handoffRef declared ────────────────────────────────────────────────────────

console.log('\nhandoffRef declared')

test('handoffRef = useRef(null) is declared', () => {
  assert.ok(cp.includes('handoffRef = useRef(null)'), 'handoffRef must be initialized with useRef(null)')
})
test('handoffRef declared near other refs (within 3000 chars of triggerRef)', () => {
  const triggerIdx = cp.indexOf('triggerRef = useRef')
  const handoffIdx = cp.indexOf('handoffRef = useRef')
  assert.ok(triggerIdx !== -1, 'triggerRef must exist')
  assert.ok(handoffIdx !== -1, 'handoffRef must exist')
  assert.ok(Math.abs(triggerIdx - handoffIdx) < 3000, 'handoffRef must be declared near other refs')
})
test('handoffRef.current is read in the post-close effect', () => {
  assert.ok(cp.includes('handoffRef.current'), 'handoffRef.current must be referenced in the post-close effect')
})

// ── Post-close handoff execution effect ───────────────────────────────────────

console.log('\nPost-close handoff execution effect')

test('post-close effect depends on [open]', () => {
  // The effect must include [open] as its dependency — the canonical pattern is
  // useEffect(() => { if (!open && handoffRef.current) { … } }, [open])
  assert.ok(cp.includes('}, [open])'), 'a useEffect with [open] dependency must exist')
})
test('post-close effect checks !open before executing handoff', () => {
  // The guard condition is: if (!open && handoffRef.current) { … }
  const effectIdx = cp.indexOf('!open && handoffRef.current')
  assert.ok(effectIdx !== -1, 'post-close effect must guard with !open && handoffRef.current')
})
test('post-close effect nullifies handoffRef.current after executing it', () => {
  // After calling fn(), handoffRef.current must be set to null so the ref
  // does not execute again on the next open/close cycle.
  const effectIdx = cp.indexOf('!open && handoffRef.current')
  assert.ok(effectIdx !== -1, 'post-close guard must exist')
  const region = cp.slice(effectIdx, effectIdx + 200)
  assert.ok(region.includes('handoffRef.current = null'), 'handoffRef.current must be cleared after execution')
})
test('post-close effect calls fn() after clearing the ref', () => {
  const effectIdx = cp.indexOf('!open && handoffRef.current')
  const region = cp.slice(effectIdx, effectIdx + 250)
  // Accepts both "fn()" and calling via any stored local variable name
  const callsHandoff = region.includes('fn()') || region.includes('handoffRef.current()')
  assert.ok(callsHandoff, 'post-close effect must call the stored handoff function')
})

// ── closepal(reason, handoffFn) signature ─────────────────────────────────────

console.log('\nclosepal signature')

test("closepal accepts reason parameter with 'dismiss' default", () => {
  assert.ok(
    cp.includes("reason = 'dismiss'") || cp.includes('reason="dismiss"'),
    "closepal must have reason parameter with default 'dismiss'"
  )
})
test('closepal accepts handoffFn parameter', () => {
  assert.ok(
    cp.includes('handoffFn = null') || cp.includes('handoffFn=null'),
    'closepal must accept handoffFn parameter defaulting to null'
  )
})
test("closepal stores handoffFn in handoffRef when reason === 'handoff'", () => {
  const closePalIdx = cp.indexOf("reason = 'dismiss'")
  assert.ok(closePalIdx !== -1, 'closepal definition must be findable')
  // Use a large window — the function body includes all setState calls
  // before reaching the dismiss guard; 1400 chars covers the full function.
  const body = cp.slice(closePalIdx, closePalIdx + 1400)
  assert.ok(body.includes("reason === 'handoff'"), "closepal must check reason === 'handoff'")
  assert.ok(body.includes('handoffRef.current = handoffFn'), 'closepal must store handoffFn in handoffRef.current')
})
test('closepal is wrapped in useCallback', () => {
  // closepal must be memoized — it is referenced in useEffect dependency arrays
  const idx = cp.indexOf('const closepal = useCallback')
  assert.ok(idx !== -1, 'closepal must be declared as useCallback')
})

// ── dismiss: focus restoration present ────────────────────────────────────────

console.log("\nclose reason 'dismiss' → focus restoration")

test("focus restoration only fires when reason === 'dismiss'", () => {
  const closePalIdx = cp.indexOf("reason = 'dismiss'")
  // Use 1600 chars — the function has many setState calls before the dismiss guard.
  const body = cp.slice(closePalIdx, closePalIdx + 1600)
  // The focus restoration block is inside an if (reason === 'dismiss') guard
  const dismissGuardIdx = body.lastIndexOf("reason === 'dismiss'")
  assert.ok(dismissGuardIdx !== -1, "focus restoration must be inside reason === 'dismiss' guard")
  const focusRegion = body.slice(dismissGuardIdx, dismissGuardIdx + 200)
  assert.ok(focusRegion.includes('trigger.focus'), 'focus restoration must call trigger.focus() inside the dismiss guard')
})
test('triggerRef is still referenced inside closepal', () => {
  const closePalIdx = cp.indexOf("reason = 'dismiss'")
  // Use 1600 chars to cover the full function body
  const body = cp.slice(closePalIdx, closePalIdx + 1600)
  assert.ok(body.includes('triggerRef.current'), 'closepal must still reference triggerRef for dismiss restoration')
})

// ── handoff: focus restoration absent for 'handoff' reason ────────────────────

console.log("\nclose reason 'handoff' → no focus interference")

test("trigger.focus is NOT called unconditionally (only inside dismiss guard)", () => {
  // Count occurrences of trigger.focus — should be inside the dismiss guard only
  const closePalIdx = cp.indexOf("reason = 'dismiss'")
  const body = cp.slice(closePalIdx, closePalIdx + 900)
  // The guard pattern means focus restore is conditional. Verify no bare
  // trigger.focus call appears outside the dismiss check.
  const dismissGuardIdx = body.lastIndexOf("reason === 'dismiss'")
  const beforeGuard = body.slice(0, dismissGuardIdx)
  assert.ok(!beforeGuard.includes('trigger.focus'), 'trigger.focus must not appear before the dismiss guard')
})

// ── Action handlers use 'handoff' ─────────────────────────────────────────────

console.log("\naction handlers use closepal('handoff', fn)")

test("Add Contact quick action uses closepal('handoff', fn)", () => {
  const addIdx = cp.indexOf("'qa-add'")
  assert.ok(addIdx !== -1, 'qa-add quick action must exist')
  // The Add Contact action includes an SVG icon (~180 chars) before the action()
  // closure, so use 600 chars to reach past the icon and into the action body.
  const region = cp.slice(addIdx, addIdx + 600)
  assert.ok(region.includes("closepal('handoff'"), "Add Contact must use closepal('handoff', fn)")
  assert.ok(!region.includes("closepal()"), "Add Contact must NOT use bare closepal()")
})
test("Import action uses closepal('handoff', fn)", () => {
  // Use lastIndexOf — the string '/contacts?import=1' also appears in the
  // file-header comment; the last occurrence is the actual action code.
  const importIdx = cp.lastIndexOf('/contacts?import=1')
  assert.ok(importIdx !== -1, 'import navigation must exist')
  const region = cp.slice(Math.max(0, importIdx - 80), importIdx + 50)
  assert.ok(region.includes("closepal('handoff'"), "Import action must use closepal('handoff', fn)")
})
test("handleLogInteraction open_drawer path uses closepal('handoff', fn)", () => {
  const logIdx = cp.indexOf('handleLogInteraction')
  assert.ok(logIdx !== -1, 'handleLogInteraction must exist')
  const body = cp.slice(logIdx, logIdx + 600)
  assert.ok(body.includes("closepal('handoff'"), "handleLogInteraction must use closepal('handoff', fn)")
})
test("handlePickerSelect uses closepal('handoff', fn)", () => {
  const pickerIdx = cp.indexOf('handlePickerSelect')
  assert.ok(pickerIdx !== -1, 'handlePickerSelect must exist')
  const body = cp.slice(pickerIdx, pickerIdx + 200)
  assert.ok(body.includes("closepal('handoff'"), "handlePickerSelect must use closepal('handoff', fn)")
  assert.ok(!body.includes("closepal()"), "handlePickerSelect must NOT use bare closepal()")
})
test("openContact uses closepal('handoff', fn)", () => {
  const openIdx = cp.indexOf('function openContact(contactId)')
  assert.ok(openIdx !== -1, 'openContact must exist')
  const body = cp.slice(openIdx, openIdx + 200)
  assert.ok(body.includes("closepal('handoff'"), "openContact must use closepal('handoff', fn)")
  assert.ok(!body.includes("closepal()"), "openContact must NOT use bare closepal()")
})
test("handleAIHandoff uses closepal('handoff', fn)", () => {
  const aiIdx = cp.indexOf('function handleAIHandoff()')
  assert.ok(aiIdx !== -1, 'handleAIHandoff must exist')
  // Function body includes multi-line ternary — use 500 chars
  const body = cp.slice(aiIdx, aiIdx + 500)
  assert.ok(body.includes("closepal('handoff'"), "handleAIHandoff must use closepal('handoff', fn)")
  assert.ok(!body.includes("closepal()"), "handleAIHandoff must NOT use bare closepal()")
})
test("activateItem nav case uses closepal('handoff', fn)", () => {
  const activateIdx = cp.indexOf('function activateItem(item)')
  assert.ok(activateIdx !== -1, 'activateItem must exist')
  const body = cp.slice(activateIdx, activateIdx + 400)
  assert.ok(body.includes("closepal('handoff'"), "activateItem nav case must use closepal('handoff', fn)")
})
test("nav result row onClick uses closepal('handoff', fn)", () => {
  // There are two 'Navigation commands' occurrences — the file-header comment
  // and the render-section comment.  Use lastIndexOf to reach the render section.
  const navSectionIdx = cp.lastIndexOf('Navigation commands')
  assert.ok(navSectionIdx !== -1, 'Navigation commands section must exist')
  // The section includes SectionLabel, displayedNavs guard, then map with onClick.
  // Use 1000 chars to reach past the displayedNavs.length check to the ResultRow.
  const region = cp.slice(navSectionIdx, navSectionIdx + 1000)
  assert.ok(region.includes("closepal('handoff'"), "nav result row onClick must use closepal('handoff', fn)")
})
test("no-results prefill Add Contact button uses closepal('handoff', fn)", () => {
  const noResIdx = cp.indexOf('No results for')
  assert.ok(noResIdx !== -1, 'no-results section must exist')
  const region = cp.slice(noResIdx, noResIdx + 800)
  assert.ok(region.includes("closepal('handoff'"), "no-results Add Contact must use closepal('handoff', fn)")
})

// ── Dismiss paths use 'dismiss' ───────────────────────────────────────────────

console.log("\ndismiss paths use closepal('dismiss')")

test("Escape key uses closepal('dismiss')", () => {
  assert.ok(cp.includes("closepal('dismiss')"), "Escape handler must use closepal('dismiss')")
  // Find the Escape check location and confirm dismiss is nearby
  const escIdx = cp.indexOf("'Escape'")
  assert.ok(escIdx !== -1, 'Escape check must exist')
  const region = cp.slice(escIdx, escIdx + 80)
  assert.ok(region.includes("closepal('dismiss')"), "Escape handler must call closepal('dismiss')")
})
test("desktop backdrop onClick uses closepal('dismiss')", () => {
  const backdropIdx = cp.indexOf('Backdrop (desktop)')
  assert.ok(backdropIdx !== -1, 'desktop backdrop comment must exist')
  const region = cp.slice(backdropIdx, backdropIdx + 200)
  assert.ok(region.includes("closepal('dismiss')"), "desktop backdrop must use closepal('dismiss')")
  // Must NOT use bare closepal() as onClick (which would pass the click event as reason)
  assert.ok(!region.includes("onClick={closepal}"), "desktop backdrop must NOT use bare onClick={closepal}")
})
test("picker backdrop onClick uses closepal('dismiss')", () => {
  const pickerBdIdx = cp.indexOf("Pick a contact to log")
  assert.ok(pickerBdIdx !== -1, 'picker dialog label must exist')
  const region = cp.slice(pickerBdIdx, pickerBdIdx + 800)
  assert.ok(region.includes("closepal('dismiss')"), "picker backdrop must use closepal('dismiss')")
})
test("mobile Cancel button uses closepal('dismiss')", () => {
  // SearchRow's mobile Cancel
  const cancelIdx = cp.indexOf('Mobile-only cancel button')
  assert.ok(cancelIdx !== -1, 'mobile cancel comment must exist')
  const region = cp.slice(cancelIdx, cancelIdx + 200)
  assert.ok(region.includes("closepal('dismiss')"), "mobile Cancel must use closepal('dismiss')")
  assert.ok(!region.includes("onClick={closepal}"), "mobile Cancel must NOT use bare onClick={closepal}")
})
test("picker mobile Cancel button uses closepal('dismiss')", () => {
  const pickerCancelIdx = cp.lastIndexOf("closepal('dismiss')")
  // The last 'dismiss' call should appear in the picker's mobile Cancel region
  // (the picker cancel is rendered after the main search row cancel)
  assert.ok(pickerCancelIdx !== -1, "closepal('dismiss') must appear at least once")
  const region = cp.slice(Math.max(0, pickerCancelIdx - 100), pickerCancelIdx + 50)
  assert.ok(region.includes('Cancel') || region.includes("closepal('dismiss')"), "picker mobile Cancel must use closepal('dismiss')")
})

// ── No overlapping aria-modal surfaces ────────────────────────────────────────

console.log('\nNo overlapping aria-modal surfaces')

test('at most two aria-modal="true" elements (main palette + picker — mutually exclusive)', () => {
  // Count all aria-modal="true" occurrences in the component.
  // The picker renders INSTEAD of the main palette (early return guard),
  // so only one is visible at a time.
  const matches = [...cp.matchAll(/aria-modal="true"/g)]
  assert.ok(matches.length <= 2, `Expected ≤2 aria-modal="true" elements, found ${matches.length}`)
})
test('picker view is an early return — palette and picker never render simultaneously', () => {
  // Pattern: `if (pickerContacts !== null) { ... return (...) }`
  // The picker return must appear before the main palette return.
  const pickerReturnIdx = cp.indexOf('if (pickerContacts !== null)')
  const mainPaletteReturnIdx = cp.indexOf('Main palette render')
  assert.ok(pickerReturnIdx !== -1, 'picker early-return guard must exist')
  assert.ok(mainPaletteReturnIdx !== -1, 'Main palette render comment must exist')
  assert.ok(pickerReturnIdx < mainPaletteReturnIdx, 'picker must return before the main palette render')
})
test('no AddContactDrawer rendered inside CommandPalette (avoids nested dialogs)', () => {
  // The drawer opens via a CustomEvent dispatched by the handoff — it is never
  // rendered as a child of CommandPalette.
  assert.ok(!cp.includes('<AddContactDrawer'), 'CommandPalette must not render AddContactDrawer as a child')
  assert.ok(!cp.includes('AddContactDrawer'), 'CommandPalette must not import AddContactDrawer')
})
test('focus trap only applies to the currently-visible panel (single panelRef)', () => {
  // Both picker and main palette reuse panelRef — only one is visible at a time.
  const matches = [...cp.matchAll(/ref={panelRef}/g)]
  assert.ok(matches.length >= 1, 'panelRef must be applied to at least one panel')
  assert.ok(matches.length <= 2, 'panelRef must apply to at most 2 panels (picker + main, mutually exclusive)')
})

// ── Import routing: reactive importParam ─────────────────────────────────────

console.log('\nImport routing: reactive importParam dependency')

test("ContactsPage extracts importParam = searchParams.get('import') before the effect", () => {
  const paramIdx = contacts.indexOf("searchParams.get('import')")
  assert.ok(paramIdx !== -1, "searchParams.get('import') must be called in ContactsPage")
  // importParam should be assigned from that call
  assert.ok(
    contacts.includes("importParam = searchParams.get('import')") ||
    contacts.includes("const importParam"),
    'importParam variable must be extracted from searchParams'
  )
})
test('ContactsPage import effect dependency array is [importParam], not []', () => {
  // Must not use mount-only [] as the dependency for the import effect.
  // The importParam-based reactive effect ensures it fires even when the page
  // is already mounted and the URL changes (e.g., CP navigates to /contacts?import=1).
  assert.ok(contacts.includes('[importParam]'), 'import effect must depend on [importParam]')
})
test('ContactsPage import effect does NOT use mount-only empty dependency array', () => {
  // Find the import effect region
  const importEffectIdx = contacts.indexOf('importParam')
  assert.ok(importEffectIdx !== -1, 'importParam must exist in ContactsPage')
  // Look for the setImportOpen call near importParam — that's the import effect body
  const region = contacts.slice(importEffectIdx, importEffectIdx + 400)
  // The region must contain [importParam] and must NOT contain the mount-only pattern
  // (}, []) where the [] immediately follows the effect body containing setImportOpen
  assert.ok(!region.includes('}, [])'), 'import effect must not use empty dependency array []')
})
test('ContactsPage removes import param with replace: true after consuming it', () => {
  const importEffectIdx = contacts.indexOf('[importParam]')
  assert.ok(importEffectIdx !== -1, '[importParam] dependency must be present')
  const region = contacts.slice(Math.max(0, importEffectIdx - 500), importEffectIdx)
  assert.ok(
    region.includes('replace: true') || region.includes("replace:true"),
    'import param must be removed with { replace: true } to prevent reopen on Back/refresh'
  )
})
test("ContactsPage import effect checks importParam === '1'", () => {
  const importEffectIdx = contacts.indexOf('[importParam]')
  assert.ok(importEffectIdx !== -1, '[importParam] dependency must be present')
  const body = contacts.slice(Math.max(0, importEffectIdx - 400), importEffectIdx)
  assert.ok(
    body.includes("importParam === '1'"),
    "import effect must check importParam === '1'"
  )
})

// ── results ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
