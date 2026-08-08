// Avatar gradient contrast verification — WCAG 4.5:1 at every sampled point.
// Parses gradient hex values directly from avatarUtils.js source so this test
// always reflects the actual production palette rather than a hand-written copy.
// Run with: node tests/avatar-contrast.test.js
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { contrastRatio, interpolateGradient } from './color-contrast.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const PAPER          = '#F7F2E7'
const MIN_CONTRAST   = 4.5
const SAMPLE_POSITIONS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
const HUE_NAMES      = ['Terracotta', 'Teal', 'Rose', 'Blue', 'Amber', 'Warm Brown']

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

// Parse all gradient hex pairs from avatarUtils.js source so the test always
// reflects the live production palette and fails immediately if it drifts.
const src = readFileSync(join(root, 'src/lib/avatarUtils.js'), 'utf8')
const gradientRe = /linear-gradient\(135deg,(#[0-9A-Fa-f]{6}),(#[0-9A-Fa-f]{6})\)/g
const gradients = []
let m
while ((m = gradientRe.exec(src)) !== null) {
  gradients.push([m[1], m[2]])
}

if (gradients.length !== 6) {
  console.error(`Expected 6 gradient slots in avatarUtils.js, found ${gradients.length}`)
  process.exit(1)
}

// 6 slots × 11 sample points = 66 tests
for (let slot = 0; slot < gradients.length; slot++) {
  const [hexA, hexB] = gradients[slot]
  const hueName = HUE_NAMES[slot] || `Slot ${slot}`
  console.log(`\nSlot ${slot} — ${hueName}: ${hexA} → ${hexB}`)

  for (const t of SAMPLE_POSITIONS) {
    const pct = Math.round(t * 100)
    const hex = interpolateGradient(hexA, hexB, t)
    const ratio = contrastRatio(hex, PAPER)
    test(
      `Slot ${slot} (${hueName}) at ${pct}%: ${hex} contrast ${ratio.toFixed(2)}:1 ≥ ${MIN_CONTRAST}:1`,
      () => {
        assert.ok(
          ratio >= MIN_CONTRAST,
          `${hex} at t=${t} (${pct}%) has contrast ${ratio.toFixed(3)}:1 — must be ≥ ${MIN_CONTRAST}:1 against Paper ${PAPER}`
        )
      }
    )
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
