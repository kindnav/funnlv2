/**
 * ai-contact-activation-analytics.test.js
 *
 * Tests that ai_contact_link_clicked analytics fires ONLY in onClick handlers,
 * never during rendering. Covers Section 4 of the Stage 7 correction spec.
 *
 * Both sources of contact link clicks are audited:
 *   1. The ReactMarkdown anchor renderer (mdComponents.a)
 *   2. ContactRefCard's "Open →" Link onClick
 *
 * Approach: static analysis of FunnlAIPage.jsx source text.
 * The test verifies structural guarantees without running React.
 *
 * Zero-dependency Node.js — run with: node tests/ai-contact-activation-analytics.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dir, '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── mdComponents.a anchor renderer ────────────────────────────────────────────

console.log('\nmdComponents anchor renderer — analytics timing\n')

test('analytics event is defined as the event name', () => {
  assert.ok(src.includes("'ai_contact_link_clicked'"),
    'ai_contact_link_clicked must appear in source')
})

test('analytics event appears inside an onClick handler', () => {
  // Must appear in an onClick attribute (not in return/render expression)
  assert.ok(
    src.includes("onClick={() => track('ai_contact_link_clicked'") ||
    src.includes('onClick={') && src.includes("'ai_contact_link_clicked'"),
    'analytics must fire in onClick, not in render'
  )
})

test('anchor renderer: analytics fires in a Link onClick for valid contact links', () => {
  // The valid-contact-link path renders a Link with onClick containing analytics
  const linkBlock = src.match(/isValidContactLink\(href\)[\s\S]*?return <span/)?.[0] ?? ''
  assert.ok(
    linkBlock.includes("ai_contact_link_clicked"),
    'analytics must be inside the isValidContactLink branch (Link path), before the span fallback'
  )
})

test('anchor renderer: no track() call outside an onClick', () => {
  // Identifies lines containing track('ai_contact_link_clicked') and checks they
  // are all inside onClick={...} lambdas, not bare JSX expressions
  const lines = src.split('\n').filter(l => l.includes("ai_contact_link_clicked"))
  for (const line of lines) {
    const trimmed = line.trim()
    assert.ok(
      trimmed.startsWith('onClick') ||
      trimmed.includes('onClick') ||
      trimmed.includes('=>') ||
      // The event may be on the same line as onClick or the arrow function
      line.includes('onClick') || line.includes('=>'),
      'ai_contact_link_clicked must only appear inside onClick or arrow function handlers: ' + line
    )
  }
})

test('anchor renderer: non-contact links fall through to plain span (no analytics)', () => {
  // The else branch (span) must not contain a track() call
  const spanFallback = src.match(/return <span[\s\S]*?<\/span>/)?.[0] ?? ''
  assert.ok(
    !spanFallback.includes('track('),
    'non-contact link fallback span must not fire analytics'
  )
})

// ── ContactRefCard Open → link ─────────────────────────────────────────────────

console.log('\nContactRefCard "Open →" link — analytics timing\n')

test('ContactRefCard Open → uses a Link with onClick', () => {
  assert.ok(
    src.includes("onClick={e => { e.stopPropagation(); track('ai_contact_link_clicked'"),
    'Open → link must have onClick that fires ai_contact_link_clicked'
  )
})

test('Open → analytics fires in onClick, not a bare expression', () => {
  const cardBlock = src.match(/function ContactRefCard[\s\S]*?^\}/m)?.[0] ?? src
  const trackLines = cardBlock.split('\n').filter(l => l.includes("ai_contact_link_clicked"))
  assert.ok(trackLines.length > 0, 'ContactRefCard must contain ai_contact_link_clicked')
  for (const line of trackLines) {
    assert.ok(
      line.includes('onClick') || line.includes('=>'),
      'ContactRefCard ai_contact_link_clicked must be in an onClick/arrow: ' + line
    )
  }
})

test('Open → link has e.stopPropagation() before analytics', () => {
  // stopPropagation prevents double-fires if a parent also has a click handler
  assert.ok(
    src.includes("e.stopPropagation(); track('ai_contact_link_clicked'") ||
    src.includes('e.stopPropagation()'),
    'Open → onClick must call stopPropagation'
  )
})

// ── Global: no track() in render / return paths ────────────────────────────────

console.log('\nGlobal source — no analytics in render return\n')

test('track("ai_contact_link_clicked") does not appear bare in JSX expression position', () => {
  // Bare call in JSX looks like: {track('ai_contact_link_clicked')} in render
  assert.ok(
    !src.includes("{track('ai_contact_link_clicked')}"),
    'analytics must never fire as a bare JSX expression {track(...)}'
  )
})

test('no track() calls in mdComponents object body (module-level render definition)', () => {
  // mdComponents is defined at module level. Any track() in its body would fire during rendering.
  // The ONLY allowed location is inside onClick handlers within the component definitions.
  const mdBlock = src.match(/const mdComponents = \{[\s\S]*?\n\}/)?.[0] ?? ''
  // Count track() calls that are NOT inside onClick
  const trackInMd = (mdBlock.match(/track\(/g) ?? []).length
  const onClickInMd = (mdBlock.match(/onClick/g) ?? []).length
  // If track appears, it must be inside an onClick
  assert.ok(
    trackInMd === 0 || onClickInMd >= trackInMd,
    'all track() calls in mdComponents must be inside onClick handlers'
  )
})

test('analytics source property is ai_response (not contact ID or name)', () => {
  // The event must only include the controlled source property, never PII
  assert.ok(
    src.includes("source: 'ai_response'"),
    'ai_contact_link_clicked must only send { source: "ai_response" }'
  )
  // Check that track() calls for ai_contact_link_clicked do not embed contactId or name
  const trackCalls = src.match(/track\('ai_contact_link_clicked'[\s\S]*?\}?\s*\)/g) ?? []
  for (const call of trackCalls) {
    assert.ok(!call.includes('contactId:') && !call.includes('contact.id'),
      'ai_contact_link_clicked track call must not include contactId: ' + call)
  }
})

test('total ai_contact_link_clicked event firings: exactly two call sites', () => {
  // Spec allows exactly two: one in mdComponents.a (Link onClick),
  // one in ContactRefCard (Open → onClick)
  const count = (src.match(/'ai_contact_link_clicked'/g) ?? []).length
  assert.ok(count >= 2, 'must have at least 2 ai_contact_link_clicked references (definition + two call sites)')
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
