// Tests for theme helper logic (src/lib/theme.js).
// theme.js uses localStorage and document.documentElement, which aren't
// available in Node.js. This file inlines the same logic and tests it with
// minimal mocks so the business rules are independently verified.
//
// Run with: node tests/theme.test.js

import assert from 'assert'

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

// ── Minimal mocks ────────────────────────────────────────────────────────────

function makeStorage() {
  const store = {}
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: k => { delete store[k] },
  }
}

function makeRoot() {
  return { dataset: {}, style: {} }
}

// ── Inline logic from src/lib/theme.js ───────────────────────────────────────
// Must stay in sync with the source file.

const VALID_THEMES = new Set(['dark', 'light', 'system'])

function getTheme(storage) {
  const stored = storage.getItem('funnl-theme')
  return VALID_THEMES.has(stored) ? stored : 'dark'
}

function applyTheme(theme, root) {
  root.dataset.theme = VALID_THEMES.has(theme) ? theme : 'dark'
  root.style.colorScheme = theme === 'system' ? 'light dark' : theme
}

function setTheme(theme, storage, root) {
  if (!VALID_THEMES.has(theme)) return
  storage.setItem('funnl-theme', theme)
  applyTheme(theme, root)
}

function initTheme(storage, root) {
  applyTheme(getTheme(storage), root)
}

// ── getTheme ─────────────────────────────────────────────────────────────────
console.log('\ngetTheme')

test('returns "dark" when nothing is stored (default)', () => {
  const s = makeStorage()
  assert.strictEqual(getTheme(s), 'dark')
})

test('returns stored "dark"', () => {
  const s = makeStorage()
  s.setItem('funnl-theme', 'dark')
  assert.strictEqual(getTheme(s), 'dark')
})

test('returns stored "light"', () => {
  const s = makeStorage()
  s.setItem('funnl-theme', 'light')
  assert.strictEqual(getTheme(s), 'light')
})

test('returns stored "system"', () => {
  const s = makeStorage()
  s.setItem('funnl-theme', 'system')
  assert.strictEqual(getTheme(s), 'system')
})

test('returns "dark" for invalid stored value "auto"', () => {
  const s = makeStorage()
  s.setItem('funnl-theme', 'auto')
  assert.strictEqual(getTheme(s), 'dark')
})

test('returns "dark" for invalid stored value empty string', () => {
  const s = makeStorage()
  s.setItem('funnl-theme', '')
  assert.strictEqual(getTheme(s), 'dark')
})

test('returns "dark" for invalid stored value "System" (wrong case)', () => {
  const s = makeStorage()
  s.setItem('funnl-theme', 'System')
  assert.strictEqual(getTheme(s), 'dark')
})

// ── applyTheme ───────────────────────────────────────────────────────────────
console.log('\napplyTheme')

test('dark → data-theme="dark", colorScheme="dark"', () => {
  const root = makeRoot()
  applyTheme('dark', root)
  assert.strictEqual(root.dataset.theme, 'dark')
  assert.strictEqual(root.style.colorScheme, 'dark')
})

test('light → data-theme="light", colorScheme="light"', () => {
  const root = makeRoot()
  applyTheme('light', root)
  assert.strictEqual(root.dataset.theme, 'light')
  assert.strictEqual(root.style.colorScheme, 'light')
})

test('system → data-theme="system", colorScheme="light dark"', () => {
  const root = makeRoot()
  applyTheme('system', root)
  assert.strictEqual(root.dataset.theme, 'system')
  assert.strictEqual(root.style.colorScheme, 'light dark')
})

test('invalid value falls back to data-theme="dark"', () => {
  const root = makeRoot()
  applyTheme('invalid', root)
  assert.strictEqual(root.dataset.theme, 'dark')
})

test('always sets an explicit data-theme attribute (no undefined)', () => {
  for (const t of ['dark', 'light', 'system']) {
    const root = makeRoot()
    applyTheme(t, root)
    assert.ok(root.dataset.theme !== undefined && root.dataset.theme !== '')
  }
})

// ── setTheme ─────────────────────────────────────────────────────────────────
console.log('\nsetTheme')

test('persists to storage and applies', () => {
  const s = makeStorage()
  const root = makeRoot()
  setTheme('light', s, root)
  assert.strictEqual(s.getItem('funnl-theme'), 'light')
  assert.strictEqual(root.dataset.theme, 'light')
})

test('invalid theme: no-op — storage and root unchanged', () => {
  const s = makeStorage()
  const root = makeRoot()
  s.setItem('funnl-theme', 'dark')
  setTheme('invalid', s, root)
  assert.strictEqual(s.getItem('funnl-theme'), 'dark')
  assert.strictEqual(root.dataset.theme, undefined)
})

// ── initTheme ────────────────────────────────────────────────────────────────
console.log('\ninitTheme')

test('no stored value → applies dark', () => {
  const s = makeStorage()
  const root = makeRoot()
  initTheme(s, root)
  assert.strictEqual(root.dataset.theme, 'dark')
})

test('stored "light" → applies light', () => {
  const s = makeStorage()
  s.setItem('funnl-theme', 'light')
  const root = makeRoot()
  initTheme(s, root)
  assert.strictEqual(root.dataset.theme, 'light')
})

test('stored invalid value → applies dark', () => {
  const s = makeStorage()
  s.setItem('funnl-theme', 'auto')
  const root = makeRoot()
  initTheme(s, root)
  assert.strictEqual(root.dataset.theme, 'dark')
})

// ── Pre-paint script consistency ──────────────────────────────────────────────
// The inline script in index.html must implement the same logic as getTheme/applyTheme.
// Test the pre-paint logic here to ensure it matches.
console.log('\nPre-paint script logic (must match getTheme + applyTheme)')

function runPrePaintScript(storedValue) {
  const store = storedValue !== null ? { 'funnl-theme': storedValue } : {}
  const root = { dataset: {}, style: {} }
  // Mirrors exactly the inline script in index.html:
  const s = { getItem: k => store[k] ?? null }
  const v = { dark: 1, light: 1, system: 1 }
  const t = v[s.getItem('funnl-theme')] ? s.getItem('funnl-theme') : 'dark'
  root.dataset.theme = t
  root.style.colorScheme = t === 'system' ? 'light dark' : t
  return root
}

test('pre-paint: no stored value → data-theme="dark"', () => {
  const root = runPrePaintScript(null)
  assert.strictEqual(root.dataset.theme, 'dark')
})

test('pre-paint: stored "light" → data-theme="light"', () => {
  const root = runPrePaintScript('light')
  assert.strictEqual(root.dataset.theme, 'light')
})

test('pre-paint: stored "system" → data-theme="system", colorScheme="light dark"', () => {
  const root = runPrePaintScript('system')
  assert.strictEqual(root.dataset.theme, 'system')
  assert.strictEqual(root.style.colorScheme, 'light dark')
})

test('pre-paint: stored invalid → data-theme="dark" (same as getTheme fallback)', () => {
  const root = runPrePaintScript('auto')
  assert.strictEqual(root.dataset.theme, 'dark')
})

test('pre-paint and getTheme agree for all valid values', () => {
  for (const t of ['dark', 'light', 'system']) {
    const s = makeStorage()
    s.setItem('funnl-theme', t)
    const fromGetTheme = getTheme(s)
    const fromPrePaint = runPrePaintScript(t).dataset.theme
    assert.strictEqual(fromGetTheme, fromPrePaint, `disagreement for theme=${t}`)
  }
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
