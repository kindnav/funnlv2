/**
 * Canonical test runner — auto-discovers and runs every *.test.js suite.
 * Usage: node tests/run-all.js   (or: npm test)
 *
 * Discovery: every file in this directory whose name ends in .test.js.
 * Format detection: files that import from 'node:test' are run with
 *   `node --test`; all others are run with `node` directly.
 * Output: per-suite pass/fail counts + a combined summary.
 * Exit code: 0 when all pass, 1 when any fail or when no files are found.
 */
import { execSync } from 'child_process'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = join(__dirname, '..')

// ── Discovery ────────────────────────────────────────────────────────────────

const files = readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort()

if (files.length === 0) {
  console.error('\nERROR: No *.test.js files discovered in tests/.\n')
  process.exit(1)
}

// ── Format detection ─────────────────────────────────────────────────────────

function detectFormat(file) {
  // Read the first 600 bytes — enough to find any import at the top.
  const head = readFileSync(join(__dirname, file), 'utf8').slice(0, 600)
  return head.includes("'node:test'") || head.includes('"node:test"')
    ? 'node-test'  // TAP-like: ℹ pass N / ℹ fail N
    : 'raw'        // custom assert: "N tests: N passed, N failed"
}

// ── Runner ───────────────────────────────────────────────────────────────────

function run(file, format) {
  const path = join(__dirname, file)
  const cmd  = format === 'node-test'
    ? `node --test "${path}"`
    : `node "${path}"`
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '')
  }
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseRaw(output) {
  // "N tests: N passed, N failed"  OR  "N passed, N failed"
  let m = output.match(/(\d+) tests?:\s*(\d+) passed,?\s*(\d+) failed/)
  if (m) return { total: +m[1], passed: +m[2], failed: +m[3] }
  m = output.match(/(\d+) passed,\s*(\d+) failed/)
  if (m) return { total: +m[1] + +m[2], passed: +m[1], failed: +m[2] }
  return null
}

function parseNodeTest(output) {
  // "ℹ pass N"  and optionally  "ℹ fail N"
  const pm = output.match(/ℹ pass\s+(\d+)/)
  const fm = output.match(/ℹ fail\s+(\d+)/)
  if (!pm) return null
  const passed = +pm[1]
  const failed = fm ? +fm[1] : 0
  return { total: passed + failed, passed, failed }
}

function parse(output, format) {
  // Try the expected parser first; fall back to the other one.
  return format === 'node-test'
    ? (parseNodeTest(output) ?? parseRaw(output))
    : (parseRaw(output)     ?? parseNodeTest(output))
}

// ── Run all suites ────────────────────────────────────────────────────────────

let grandTotal  = 0
let grandPassed = 0
const failures  = []
const unparsed  = []

console.log(`\nDiscovered ${files.length} suites — running…\n`)

for (const file of files) {
  const format = detectFormat(file)
  const output = run(file, format)
  const result = parse(output, format)

  if (result) {
    grandTotal  += result.total
    grandPassed += result.passed
    const tag = result.failed > 0 ? `  FAIL (${result.failed} failed)` : ''
    console.log(`  ${String(result.passed).padStart(3)}/${result.total}  ${file}${tag}`)
    if (result.failed > 0) failures.push(file)
  } else {
    console.log(`    ?/?  ${file}  (could not parse output)`)
    unparsed.push(file)
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`)
console.log(`  ${grandPassed}/${grandTotal} tests passed`)
console.log(`  ${files.length} suites discovered\n`)

if (unparsed.length > 0) {
  console.log('  Suites with unparseable output (check manually):')
  unparsed.forEach(f => console.log(`    • ${f}`))
  console.log()
}

if (failures.length > 0 || unparsed.length > 0) {
  console.log('  Failed suites:')
  failures.forEach(f => console.log(`    • ${f}`))
  process.exit(1)
}
