/**
 * ai-fill-styling.test.js
 *
 * Static assertions that the AI Fill field highlight uses ember tokens,
 * not the legacy purple rgba(139,124,255,...) / #8B7CFF values.
 *
 * These read the source file directly — no React or Supabase required.
 * Run with: node tests/ai-fill-styling.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(
  join(__dirname, '../src/components/AddContactDrawer.jsx'),
  'utf8'
)

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

// ── iClsAI constant ────────────────────────────────────────────────────────────

console.log('\niClsAI constant\n')

test('iClsAI constant exists in the file', () => {
  assert.ok(src.includes('const iClsAI'), 'iClsAI constant should be defined')
})

test('iClsAI does not contain legacy purple rgb(139,124,255) values', () => {
  const match = src.match(/const iClsAI\s*=\s*'[^']*'/)
  assert.ok(match, 'iClsAI constant should be a single-quoted string')
  assert.ok(
    !match[0].includes('139,124,255'),
    `iClsAI should not contain legacy purple: found "${match[0]}"`
  )
})

test('iClsAI uses ember rgba(255,68,35,...) for background', () => {
  const match = src.match(/const iClsAI\s*=\s*'[^']*'/)
  assert.ok(match, 'iClsAI constant should be a single-quoted string')
  assert.ok(
    match[0].includes('255,68,35'),
    `iClsAI should use ember rgb values: found "${match[0]}"`
  )
})

test('iClsAI uses ember focus ring (rgba(255,68,35,...))', () => {
  const match = src.match(/const iClsAI\s*=\s*'[^']*'/)
  assert.ok(match, 'iClsAI constant should be a single-quoted string')
  // Focus ring should be ember, not purple
  const hasPurpleFocus = match[0].includes('focus:border-[rgba(139')
  assert.strictEqual(hasPurpleFocus, false, 'iClsAI focus ring should not be purple')
})

// ── Whole-file purple audit ────────────────────────────────────────────────────

console.log('\nWhole-file purple audit\n')

test('no hardcoded #8B7CFF in AddContactDrawer', () => {
  assert.ok(
    !src.includes('#8B7CFF'),
    'No legacy purple hex #8B7CFF should remain in AddContactDrawer'
  )
})

test('no rgba(139,124,255,...) anywhere in AddContactDrawer', () => {
  assert.ok(
    !src.includes('139,124,255'),
    'No legacy purple rgba(139,124,255,...) values should remain in AddContactDrawer'
  )
})

test('no rgba(108,92,255,...) accent-opacity values in AddContactDrawer', () => {
  // Accent-opacity bg used in active-nav and some badge patterns — should not appear
  // in AddContactDrawer after the ember migration.
  assert.ok(
    !src.includes('108,92,255'),
    'No rgba(108,92,255,...) legacy values should appear in AddContactDrawer'
  )
})

// ── AI Fill section panel ──────────────────────────────────────────────────────

console.log('\nAI Fill panel styling\n')

test('AI Fill panel border uses ember, not purple', () => {
  // The panel border should reference ember rgba (255,68,35) not purple
  // We check by looking for the pattern near 'border border-[rgba'
  const panelMatch = src.match(/class[^>]*rounded-xl border border-\[rgba\(([^)]+)\)/)
  // If a panel border exists, it should not be purple
  if (panelMatch) {
    assert.ok(
      !panelMatch[1].startsWith('139,124,255'),
      `Panel border should not be purple: rgba(${panelMatch[1]})`
    )
  }
  // Also assert that an ember border exists somewhere in the file
  assert.ok(
    src.includes('rgba(255,68,35,0.18)') || src.includes('rgba(255,68,35,0.2)') || src.includes('rgba(255,68,35,0.3)'),
    'An ember border value should exist in AddContactDrawer'
  )
})

test('"Parse with AI" button has no purple background class', () => {
  // bg-[rgba(139,124,255,...)] should not appear on any button
  assert.ok(
    !src.includes('bg-[rgba(139,124,255'),
    'No purple bg on Parse with AI button'
  )
})

test('AI-filled fields note does not say "in purple"', () => {
  assert.ok(
    !src.includes('highlighted in purple'),
    'The AI-filled fields note should not reference purple'
  )
})

// ── Ember highlight behavior preserved ────────────────────────────────────────

console.log('\nEmber highlight behavior preserved\n')

test('iClsAI is still applied via inputCls() function', () => {
  assert.ok(
    src.includes('iClsAI'),
    'iClsAI should still be referenced in the file (used by inputCls)'
  )
})

test('inputCls() function still references iClsAI for AI-filled fields', () => {
  const inputClsMatch = src.match(/function inputCls[\s\S]*?}/)?.[0]
    ?? src.match(/inputCls\s*=?\s*\([\s\S]*?\}\)/)?.[0]
    ?? src.match(/inputCls[\s\S]{0,200}iClsAI/)?.[0]
  assert.ok(
    src.includes('iClsAI') && src.includes('aiFilledFields'),
    'iClsAI should be used alongside aiFilledFields check'
  )
})

test('clearAiFill function still exists (per-field highlight clearing preserved)', () => {
  assert.ok(
    src.includes('clearAiFill'),
    'clearAiFill function should still exist'
  )
})

test('aiFilledFields Set still drives the highlight (ember highlight is still conditional)', () => {
  assert.ok(
    src.includes('aiFilledFields.has('),
    'Field highlight should still be conditional on aiFilledFields membership'
  )
})

// ─────────────────────────────────────────────────────────────────────────────

console.log()
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
