/**
 * global-add-contact.test.js
 *
 * Tests for GlobalAddContactController architecture and the pure helpers in
 * src/lib/globalAddContactUtils.js.
 *
 * Pure function tests: resolveAddResult, shouldOpenDrawer
 * Static assertions: verify the architecture is wired correctly in source files
 *   without running the React component.
 *
 * Zero-dependency Node.js — run with: node tests/global-add-contact.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { resolveAddResult, shouldOpenDrawer } from '../src/lib/globalAddContactUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function src(rel) { return readFileSync(join(ROOT, rel), 'utf8') }

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`)
    failed++
  }
}

// ── resolveAddResult ──────────────────────────────────────────────────────────

console.log('\nresolveAddResult\n')

test('first contact with valid id → navigate-first action', () => {
  const r = resolveAddResult({ id: 'abc-123', isFirstContact: true })
  assert.strictEqual(r.action, 'navigate-first')
})

test('first contact → path is /contacts/:id', () => {
  const r = resolveAddResult({ id: 'abc-123', isFirstContact: true })
  assert.strictEqual(r.path, '/contacts/abc-123')
})

test('first contact → state has openInteractionForm: true', () => {
  const r = resolveAddResult({ id: 'abc-123', isFirstContact: true })
  assert.strictEqual(r.state.openInteractionForm, true)
})

test('later contact with valid id → emit-changed action', () => {
  const r = resolveAddResult({ id: 'def-456', isFirstContact: false })
  assert.strictEqual(r.action, 'emit-changed')
})

test('later contact → no path or state on emit-changed', () => {
  const r = resolveAddResult({ id: 'def-456', isFirstContact: false })
  assert.strictEqual(r.path, undefined)
  assert.strictEqual(r.state, undefined)
})

test('null id regardless of isFirstContact → noop', () => {
  assert.strictEqual(resolveAddResult({ id: null, isFirstContact: true }).action, 'noop')
  assert.strictEqual(resolveAddResult({ id: null, isFirstContact: false }).action, 'noop')
})

test('empty string id → noop', () => {
  assert.strictEqual(resolveAddResult({ id: '', isFirstContact: true }).action, 'noop')
})

test('undefined id → noop', () => {
  assert.strictEqual(resolveAddResult({ id: undefined, isFirstContact: false }).action, 'noop')
})

test('first contact path uses exact uuid from result', () => {
  const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
  const r = resolveAddResult({ id: uuid, isFirstContact: true })
  assert(r.path.includes(uuid), `Expected path to include ${uuid}, got ${r.path}`)
})

test('emit-changed action is immutable across calls', () => {
  const r1 = resolveAddResult({ id: 'x', isFirstContact: false })
  const r2 = resolveAddResult({ id: 'y', isFirstContact: false })
  assert.strictEqual(r1.action, 'emit-changed')
  assert.strictEqual(r2.action, 'emit-changed')
})

// ── shouldOpenDrawer ──────────────────────────────────────────────────────────

console.log('\nshouldOpenDrawer\n')

test('drawer is closed → should open', () => {
  assert.strictEqual(shouldOpenDrawer(false), true)
})

test('drawer is already open → should not open (no stacking)', () => {
  assert.strictEqual(shouldOpenDrawer(true), false)
})

// ── Static architecture assertions ───────────────────────────────────────────
// These verify the code wiring by reading source files, covering behavioral
// tests that cannot easily be expressed as pure Node.js unit tests.

console.log('\nArchitecture: GlobalAddContactController wiring\n')

const controller = src('src/components/GlobalAddContactController.jsx')
const appSrc      = src('src/App.jsx')
const dashSrc     = src('src/pages/DashboardPage.jsx')
const contactsSrc = src('src/pages/ContactsPage.jsx')

test('GlobalAddContactController imports resolveAddResult', () => {
  assert(controller.includes('resolveAddResult'), 'resolveAddResult not imported in GlobalAddContactController')
})

test('GlobalAddContactController listens for funnl:open-add-contact', () => {
  assert(controller.includes("'funnl:open-add-contact'"), 'funnl:open-add-contact event not found in controller')
})

test('GlobalAddContactController dispatches funnl:contacts-changed on later contact', () => {
  assert(controller.includes("'funnl:contacts-changed'"), 'funnl:contacts-changed not dispatched in controller')
})

test('GlobalAddContactController navigates on first contact (navigate-first)', () => {
  assert(controller.includes('navigate-first'), 'navigate-first action not handled in controller')
})

test('GlobalAddContactController guards against stacking (shouldOpenDrawer)', () => {
  assert(controller.includes('shouldOpenDrawer'), 'no stacking guard in controller')
})

test('App.jsx imports GlobalAddContactController', () => {
  assert(appSrc.includes('GlobalAddContactController'), 'GlobalAddContactController not imported in App.jsx')
})

test('App.jsx renders GlobalAddContactController in authenticated shell', () => {
  assert(appSrc.includes('<GlobalAddContactController'), 'GlobalAddContactController not rendered in App.jsx')
})

test('DashboardPage does NOT have a funnl:open-add-contact listener', () => {
  assert(
    !dashSrc.includes("addEventListener('funnl:open-add-contact'"),
    'DashboardPage still has a funnl:open-add-contact listener (should be removed)'
  )
})

test('ContactsPage does NOT have a funnl:open-add-contact listener', () => {
  assert(
    !contactsSrc.includes("addEventListener('funnl:open-add-contact'"),
    'ContactsPage still has a funnl:open-add-contact listener (should be removed)'
  )
})

test('DashboardPage does NOT import AddContactDrawer', () => {
  assert(
    !dashSrc.includes("import AddContactDrawer"),
    'DashboardPage still imports AddContactDrawer for add mode'
  )
})

test('ContactsPage does NOT import AddContactDrawer', () => {
  assert(
    !contactsSrc.includes("import AddContactDrawer"),
    'ContactsPage still imports AddContactDrawer for add mode'
  )
})

test('DashboardPage dispatches funnl:open-add-contact for Add contact CTAs', () => {
  assert(
    dashSrc.includes("'funnl:open-add-contact'"),
    'DashboardPage does not dispatch funnl:open-add-contact'
  )
})

test('ContactsPage dispatches funnl:open-add-contact for Add contact CTAs', () => {
  assert(
    contactsSrc.includes("'funnl:open-add-contact'"),
    'ContactsPage does not dispatch funnl:open-add-contact'
  )
})

test('DashboardPage listens for funnl:contacts-changed to refetch', () => {
  assert(
    dashSrc.includes("'funnl:contacts-changed'"),
    'DashboardPage does not listen for funnl:contacts-changed'
  )
})

test('ContactsPage listens for funnl:contacts-changed to refetch', () => {
  assert(
    contactsSrc.includes("'funnl:contacts-changed'"),
    'ContactsPage does not listen for funnl:contacts-changed'
  )
})

test('Only one funnl:open-add-contact listener across all files (in controller only)', () => {
  // The event is dispatched in multiple places but must only be LISTENED TO in the controller
  const listenerCount = [
    appSrc, dashSrc, contactsSrc,
    src('src/pages/FollowUpsPage.jsx'),
    src('src/pages/FunnlAIPage.jsx'),
    src('src/pages/SettingsPage.jsx'),
  ].filter(s => s.includes("addEventListener('funnl:open-add-contact'")).length
  assert.strictEqual(listenerCount, 0,
    `Found unexpected funnl:open-add-contact listeners in page files (count: ${listenerCount})`
  )
  // The controller itself must have the listener
  assert(
    controller.includes("addEventListener('funnl:open-add-contact'"),
    'GlobalAddContactController is missing its funnl:open-add-contact listener'
  )
})

test('BottomNav dispatches funnl:open-add-contact for Add contact action', () => {
  const bn = src('src/components/BottomNav.jsx')
  assert(bn.includes("'funnl:open-add-contact'"), 'BottomNav does not dispatch the event')
})

test('CommandPalette dispatches funnl:open-add-contact for Add contact action', () => {
  const cp = src('src/components/CommandPalette.jsx')
  assert(cp.includes("'funnl:open-add-contact'"), 'CommandPalette does not dispatch the event')
})

test('GlobalAddContactController renders AddContactDrawer with contacts prop', () => {
  assert(controller.includes('<AddContactDrawer'), 'AddContactDrawer not rendered in controller')
  assert(controller.includes('contacts={contacts}'), 'contacts prop not passed in controller')
})

test('GlobalAddContactController removes event listener on unmount (cleanup)', () => {
  assert(
    controller.includes("removeEventListener('funnl:open-add-contact'"),
    'Controller does not clean up its event listener'
  )
})

test('ContactDetailPage edit-mode drawer is separate and unaffected', () => {
  const detail = src('src/pages/ContactDetailPage.jsx')
  // Edit mode drawer still exists in ContactDetailPage
  assert(detail.includes('<AddContactDrawer'), 'ContactDetailPage edit drawer is missing')
  // But it is in edit mode (contact={contact} prop)
  assert(detail.includes('contact={contact}'), 'ContactDetailPage drawer is not in edit mode')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
