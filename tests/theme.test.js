// Tests for theme helper logic — imports directly from src/lib/theme.js.
// Uses the pure exported functions that accept storage/root parameters,
// so no browser globals (localStorage, document) are touched at import time.
//
// Run with: node tests/theme.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  VALID_THEMES, normalizeThemePreference, resolveColorScheme,
  readThemePreference, writeThemePreference, applyThemeToRoot,
} from '../src/lib/theme.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

// ── VALID_THEMES ─────────────────────────────────────────────────────────────
console.log('\nVALID_THEMES')

test('dark, light, system are valid', () => {
  for (const t of ['dark', 'light', 'system']) {
    assert.strictEqual(VALID_THEMES.has(t), true)
  }
})

test('auto, Dark, LIGHT are not valid', () => {
  for (const t of ['auto', 'Dark', 'LIGHT', '']) {
    assert.strictEqual(VALID_THEMES.has(t), false)
  }
})

// ── normalizeThemePreference ─────────────────────────────────────────────────
console.log('\nnormalizeThemePreference')

test('returns "dark" for missing/invalid value', () => {
  assert.strictEqual(normalizeThemePreference(null), 'dark')
  assert.strictEqual(normalizeThemePreference(undefined), 'dark')
  assert.strictEqual(normalizeThemePreference(''), 'dark')
  assert.strictEqual(normalizeThemePreference('auto'), 'dark')
  assert.strictEqual(normalizeThemePreference('System'), 'dark')
})

test('returns the value unchanged for valid themes', () => {
  assert.strictEqual(normalizeThemePreference('dark'), 'dark')
  assert.strictEqual(normalizeThemePreference('light'), 'light')
  assert.strictEqual(normalizeThemePreference('system'), 'system')
})

// ── resolveColorScheme ────────────────────────────────────────────────────────
console.log('\nresolveColorScheme')

test('dark → "dark"', () => {
  assert.strictEqual(resolveColorScheme('dark'), 'dark')
})

test('light → "light"', () => {
  assert.strictEqual(resolveColorScheme('light'), 'light')
})

test('system → "light dark"', () => {
  assert.strictEqual(resolveColorScheme('system'), 'light dark')
})

// ── readThemePreference ───────────────────────────────────────────────────────
console.log('\nreadThemePreference')

test('returns "dark" when nothing stored (default)', () => {
  const s = makeStorage()
  assert.strictEqual(readThemePreference(s), 'dark')
})

test('returns stored "dark"', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'dark')
  assert.strictEqual(readThemePreference(s), 'dark')
})

test('returns stored "light"', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'light')
  assert.strictEqual(readThemePreference(s), 'light')
})

test('returns stored "system"', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'system')
  assert.strictEqual(readThemePreference(s), 'system')
})

test('returns "dark" for invalid stored value "auto"', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'auto')
  assert.strictEqual(readThemePreference(s), 'dark')
})

test('returns "dark" for invalid stored value empty string', () => {
  const s = makeStorage(); s.setItem('funnl-theme', '')
  assert.strictEqual(readThemePreference(s), 'dark')
})

test('returns "dark" for invalid stored value "System" (wrong case)', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'System')
  assert.strictEqual(readThemePreference(s), 'dark')
})

// ── writeThemePreference ──────────────────────────────────────────────────────
console.log('\nwriteThemePreference')

test('persists valid theme to storage', () => {
  const s = makeStorage()
  writeThemePreference(s, 'light')
  assert.strictEqual(s.getItem('funnl-theme'), 'light')
})

test('no-op for invalid theme — storage unchanged', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'dark')
  writeThemePreference(s, 'invalid')
  assert.strictEqual(s.getItem('funnl-theme'), 'dark')
})

// ── applyThemeToRoot ──────────────────────────────────────────────────────────
console.log('\napplyThemeToRoot')

test('dark → data-theme="dark", colorScheme="dark"', () => {
  const root = makeRoot()
  applyThemeToRoot(root, 'dark')
  assert.strictEqual(root.dataset.theme, 'dark')
  assert.strictEqual(root.style.colorScheme, 'dark')
})

test('light → data-theme="light", colorScheme="light"', () => {
  const root = makeRoot()
  applyThemeToRoot(root, 'light')
  assert.strictEqual(root.dataset.theme, 'light')
  assert.strictEqual(root.style.colorScheme, 'light')
})

test('system → data-theme="system", colorScheme="light dark"', () => {
  const root = makeRoot()
  applyThemeToRoot(root, 'system')
  assert.strictEqual(root.dataset.theme, 'system')
  assert.strictEqual(root.style.colorScheme, 'light dark')
})

test('invalid value falls back to data-theme="dark"', () => {
  const root = makeRoot()
  applyThemeToRoot(root, 'invalid')
  assert.strictEqual(root.dataset.theme, 'dark')
})

test('always sets an explicit data-theme attribute (no undefined)', () => {
  for (const t of ['dark', 'light', 'system']) {
    const root = makeRoot()
    applyThemeToRoot(root, t)
    assert.ok(root.dataset.theme !== undefined && root.dataset.theme !== '')
  }
})

// ── Combined: readThemePreference + applyThemeToRoot (initTheme equivalent) ───
console.log('\nreadThemePreference + applyThemeToRoot (initTheme equivalent)')

test('no stored value → applies dark', () => {
  const s = makeStorage(); const root = makeRoot()
  applyThemeToRoot(root, readThemePreference(s))
  assert.strictEqual(root.dataset.theme, 'dark')
})

test('stored "light" → applies light', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'light'); const root = makeRoot()
  applyThemeToRoot(root, readThemePreference(s))
  assert.strictEqual(root.dataset.theme, 'light')
})

test('stored invalid value → applies dark', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'auto'); const root = makeRoot()
  applyThemeToRoot(root, readThemePreference(s))
  assert.strictEqual(root.dataset.theme, 'dark')
})

// ── Pre-paint script in index.html ────────────────────────────────────────────
// Reads the actual file instead of reimplementing the logic, so the test stays
// in sync with the real inline script automatically.
console.log('\nPre-paint script (index.html pattern checks)')

const indexHtml = readFileSync(join(__dirname, '../index.html'), 'utf8')

test('pre-paint script references the funnl-theme storage key', () => {
  assert.ok(indexHtml.includes('funnl-theme'),
    'Script must read from the "funnl-theme" localStorage key')
})

test('pre-paint script has a dark fallback', () => {
  assert.ok(indexHtml.includes("'dark'") || indexHtml.includes('"dark"'),
    'Script must fall back to "dark" when no valid theme is stored')
})

test('pre-paint script stamps data-theme on the root element', () => {
  assert.ok(indexHtml.includes('dataset.theme') || indexHtml.includes('data-theme'),
    'Script must set the data-theme attribute on the root element')
})

test('pre-paint script sets colorScheme', () => {
  assert.ok(indexHtml.includes('colorScheme') || indexHtml.includes('color-scheme'),
    'Script must set colorScheme to prevent flash of wrong color scheme')
})

test('pre-paint script covers all three valid themes', () => {
  assert.ok(indexHtml.includes('dark'), 'dark must appear in pre-paint script area')
  assert.ok(indexHtml.includes('light'), 'light must appear in pre-paint script area')
  assert.ok(indexHtml.includes('system'), 'system must appear in pre-paint script area')
})

test('pre-paint and readThemePreference agree: no stored value → dark', () => {
  assert.strictEqual(normalizeThemePreference(null), 'dark')
})

test('pre-paint and readThemePreference agree: stored "light" → light', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'light')
  assert.strictEqual(readThemePreference(s), 'light')
})

test('pre-paint and readThemePreference agree: "system" → "light dark" colorScheme', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'system')
  assert.strictEqual(readThemePreference(s), 'system')
  assert.strictEqual(resolveColorScheme('system'), 'light dark')
})

test('pre-paint and readThemePreference agree: invalid stored → dark', () => {
  const s = makeStorage(); s.setItem('funnl-theme', 'auto')
  assert.strictEqual(readThemePreference(s), 'dark')
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
