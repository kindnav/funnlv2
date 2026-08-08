/**
 * tests/settings-lifecycle.test.js
 *
 * Zero-dependency Node.js tests for src/lib/settingsLifecycle.js
 * Run: node tests/settings-lifecycle.test.js
 */

// ── Minimal test harness ───────────────────────────────────────────────────
let passed = 0
let failed = 0
const failures = []

function assert(condition, label) {
  if (condition) {
    passed++
  } else {
    failed++
    failures.push(label)
    console.error(`  FAIL: ${label}`)
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ── Load module under test ─────────────────────────────────────────────────
// settingsLifecycle imports settingsHelpers which has no Node-incompatible deps.
import(new URL('../src/lib/settingsLifecycle.js', import.meta.url).href).then(mod => {
  const {
    THEME_ORDER,
    isRequestCurrent,
    planDisplayNameSave,
    classifyDeleteAccountResponse,
    canCloseDialog,
    moveThemeRadio,
    getDeleteAllRefreshEvents,
    getProfileChangedRefreshEvents,
  } = mod

  // ── THEME_ORDER ────────────────────────────────────────────────────────────
  console.log('THEME_ORDER')
  assert(Array.isArray(THEME_ORDER), 'THEME_ORDER is an array')
  assert(THEME_ORDER[0] === 'light', 'THEME_ORDER[0] is light')
  assert(THEME_ORDER[1] === 'dark',  'THEME_ORDER[1] is dark')
  assert(THEME_ORDER[2] === 'system','THEME_ORDER[2] is system')
  assert(THEME_ORDER.length === 3,   'THEME_ORDER has exactly 3 entries')

  // ── isRequestCurrent ───────────────────────────────────────────────────────
  console.log('isRequestCurrent')
  assert(isRequestCurrent(true, 0, 0),   'true when mounted=true and gens match')
  assert(!isRequestCurrent(false, 0, 0), 'false when unmounted')
  assert(!isRequestCurrent(true, 0, 1),  'false when gen advanced by 1')
  assert(!isRequestCurrent(true, 2, 3),  'false when gen advanced by more')
  assert(!isRequestCurrent(false, 5, 5), 'false when unmounted even if gens match')
  assert(isRequestCurrent(true, 99, 99), 'true for high matching gen numbers')

  // ── planDisplayNameSave ───────────────────────────────────────────────────
  console.log('planDisplayNameSave')
  // error paths
  let r = planDisplayNameSave('', 'Alice')
  assert(r.action === 'error', 'empty string → error')
  assert(r.code === 'empty',   'empty string → code empty')

  r = planDisplayNameSave('   ', 'Alice')
  assert(r.action === 'error', 'whitespace-only → error')

  const longName = 'A'.repeat(81)
  r = planDisplayNameSave(longName, 'Alice')
  assert(r.action === 'error',    'too-long → error')
  assert(r.code === 'too_long',   'too-long → code too_long')

  r = planDisplayNameSave('Bad\x00Name', '')
  assert(r.action === 'error',         'control char → error')
  assert(r.code === 'invalid_chars',   'control char → code invalid_chars')

  // noop paths
  r = planDisplayNameSave('Alice', 'Alice')
  assert(r.action === 'noop', 'identical value → noop')

  r = planDisplayNameSave('  Alice  ', 'Alice')
  assert(r.action === 'noop', 'whitespace-trimmed equals saved → noop')

  // save paths
  r = planDisplayNameSave('Bob', 'Alice')
  assert(r.action === 'save', 'different valid value → save')
  assert(r.normalized === 'Bob', 'normalized field present on save')

  r = planDisplayNameSave('  Charlie  ', 'Alice')
  assert(r.action === 'save',       'trimmed-different → save')
  assert(r.normalized === 'Charlie','normalized is trimmed')

  r = planDisplayNameSave('Alice', '')
  assert(r.action === 'save', 'saved is empty, new is valid → save')

  // ── classifyDeleteAccountResponse ─────────────────────────────────────────
  console.log('classifyDeleteAccountResponse')
  // network error (invoke threw)
  r = classifyDeleteAccountResponse(new Error('network'), null)
  assert(r.ok === false,          'invoke error → ok=false')
  assert(r.code === 'network_error', 'invoke error → code=network_error')

  // no data
  r = classifyDeleteAccountResponse(null, null)
  assert(r.ok === false,    'null data → ok=false')
  assert(r.code === 'unknown', 'null data → code=unknown')

  r = classifyDeleteAccountResponse(null, undefined)
  assert(r.ok === false, 'undefined data → ok=false')

  // success
  r = classifyDeleteAccountResponse(null, { success: true })
  assert(r.ok === true,        'success:true → ok=true')
  assert(r.code === 'success', 'success:true → code=success')

  // structured error codes
  r = classifyDeleteAccountResponse(null, { success: false, error: { code: 'auth_failed' } })
  assert(r.ok === false,           'auth_failed → ok=false')
  assert(r.code === 'auth_failed', 'auth_failed → code=auth_failed')

  r = classifyDeleteAccountResponse(null, { success: false })
  assert(r.ok === false,    'no error code → ok=false')
  assert(r.code === 'unknown', 'no error code → code=unknown')

  r = classifyDeleteAccountResponse(null, { success: false, error: {} })
  assert(r.code === 'unknown', 'empty error obj → code=unknown')

  // invokeError wins over data
  r = classifyDeleteAccountResponse(new Error('net'), { success: true })
  assert(r.ok === false, 'invokeError wins over success:true data')

  // ── canCloseDialog ─────────────────────────────────────────────────────────
  console.log('canCloseDialog')
  assert(canCloseDialog(false),  'not busy → can close')
  assert(!canCloseDialog(true),  'busy → cannot close')
  // falsy coercion
  assert(canCloseDialog(0),      '0 is falsy → can close')
  assert(!canCloseDialog(1),     '1 is truthy → cannot close')

  // ── moveThemeRadio ─────────────────────────────────────────────────────────
  console.log('moveThemeRadio')
  const themes = ['light', 'dark', 'system']

  // ArrowRight / ArrowDown — forward wrapping
  assert(moveThemeRadio(themes, 'light', 'ArrowRight') === 'dark',   'right from light → dark')
  assert(moveThemeRadio(themes, 'dark', 'ArrowRight') === 'system',  'right from dark → system')
  assert(moveThemeRadio(themes, 'system', 'ArrowRight') === 'light', 'right from system wraps → light')
  assert(moveThemeRadio(themes, 'light', 'ArrowDown') === 'dark',    'down from light → dark')
  assert(moveThemeRadio(themes, 'system', 'ArrowDown') === 'light',  'down from system wraps → light')

  // ArrowLeft / ArrowUp — backward wrapping
  assert(moveThemeRadio(themes, 'dark', 'ArrowLeft') === 'light',    'left from dark → light')
  assert(moveThemeRadio(themes, 'light', 'ArrowLeft') === 'system',  'left from light wraps → system')
  assert(moveThemeRadio(themes, 'system', 'ArrowLeft') === 'dark',   'left from system → dark')
  assert(moveThemeRadio(themes, 'dark', 'ArrowUp') === 'light',      'up from dark → light')
  assert(moveThemeRadio(themes, 'light', 'ArrowUp') === 'system',    'up from light wraps → system')

  // Home / End
  assert(moveThemeRadio(themes, 'dark', 'Home') === 'light',   'Home always → first (light)')
  assert(moveThemeRadio(themes, 'light', 'Home') === 'light',  'Home on first → first')
  assert(moveThemeRadio(themes, 'dark', 'End') === 'system',   'End always → last (system)')
  assert(moveThemeRadio(themes, 'system', 'End') === 'system', 'End on last → last')

  // Unhandled keys → null
  assert(moveThemeRadio(themes, 'dark', 'Tab') === null,    'Tab → null')
  assert(moveThemeRadio(themes, 'dark', 'Enter') === null,  'Enter → null')
  assert(moveThemeRadio(themes, 'dark', 'Space') === null,  'Space → null')
  assert(moveThemeRadio(themes, 'dark', 'a') === null,      'letter a → null')

  // Unknown current theme → null for any key
  assert(moveThemeRadio(themes, 'auto', 'ArrowRight') === null, 'unknown theme → null')
  assert(moveThemeRadio(themes, '', 'ArrowRight') === null,     'empty theme → null')

  // Single-element array — wraps in place
  assert(moveThemeRadio(['dark'], 'dark', 'ArrowRight') === 'dark', 'single-item right wraps in place')
  assert(moveThemeRadio(['dark'], 'dark', 'ArrowLeft') === 'dark',  'single-item left wraps in place')

  // ── getDeleteAllRefreshEvents ──────────────────────────────────────────────
  console.log('getDeleteAllRefreshEvents')
  const delEvts = getDeleteAllRefreshEvents()
  assert(Array.isArray(delEvts), 'returns an array')
  assert(delEvts.includes('funnl:contacts-changed'),  'includes contacts-changed')
  assert(delEvts.includes('funnl:followups-changed'), 'includes followups-changed')
  assert(delEvts.length === 2, 'exactly 2 events')
  // Verify order: contacts before followups
  assert(delEvts[0] === 'funnl:contacts-changed',  'contacts-changed is first')
  assert(delEvts[1] === 'funnl:followups-changed', 'followups-changed is second')
  // Independent arrays each call
  assert(getDeleteAllRefreshEvents() !== getDeleteAllRefreshEvents(), 'returns new array each call')

  // ── getProfileChangedRefreshEvents ────────────────────────────────────────
  console.log('getProfileChangedRefreshEvents')
  const profEvts = getProfileChangedRefreshEvents()
  assert(Array.isArray(profEvts), 'returns an array')
  assert(profEvts.includes('funnl:profile-changed'), 'includes profile-changed')
  assert(profEvts.length === 1, 'exactly 1 event')
  assert(getProfileChangedRefreshEvents() !== getProfileChangedRefreshEvents(), 'returns new array each call')

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\nsettings-lifecycle: ${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.error('Failures:', failures)
    process.exit(1)
  }
}).catch(err => {
  console.error('Failed to load settingsLifecycle.js:', err.message)
  process.exit(1)
})
