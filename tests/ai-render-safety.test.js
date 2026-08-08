/**
 * ai-render-safety.test.js
 *
 * Tests for URL/markdown safety in the AI rendering path.
 * Covers isValidContactLink(), static ReactMarkdown safety assertions,
 * and structural rendering-safety properties of FunnlAIPage.
 *
 * Zero-dependency Node.js — run with: node tests/ai-render-safety.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { isValidContactLink } from '../src/lib/contactLinkValidator.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const aiSrc = readFileSync(join(__dir, '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── isValidContactLink ─────────────────────────────────────────────────────────

console.log('\nisValidContactLink — URL validation\n')

test('accepts valid contact path', () => {
  assert.strictEqual(isValidContactLink('/contacts/00000000-0000-0000-0000-000000000001'), true)
})

test('rejects JavaScript URL', () => {
  assert.strictEqual(isValidContactLink('javascript:alert(1)'), false)
})

test('rejects javascript: with uppercase', () => {
  assert.strictEqual(isValidContactLink('JAVASCRIPT:void(0)'), false)
})

test('rejects data: URL', () => {
  assert.strictEqual(isValidContactLink('data:text/html,<script>alert(1)</script>'), false)
})

test('rejects external https URL', () => {
  assert.strictEqual(isValidContactLink('https://evil.com'), false)
})

test('rejects /contacts/ with non-UUID path', () => {
  assert.strictEqual(isValidContactLink('/contacts/../../admin'), false)
  assert.strictEqual(isValidContactLink('/contacts/not-a-uuid'), false)
})

test('rejects /contacts/ with query param', () => {
  assert.strictEqual(isValidContactLink('/contacts/00000000-0000-0000-0000-000000000001?x=y'), false)
})

test('rejects /contacts/ with fragment', () => {
  assert.strictEqual(isValidContactLink('/contacts/00000000-0000-0000-0000-000000000001#section'), false)
})

test('rejects empty string', () => {
  assert.strictEqual(isValidContactLink(''), false)
})

test('rejects null', () => {
  assert.strictEqual(isValidContactLink(null), false)
})

test('rejects /contacts/ with uppercase UUID (server validates, client allows only lowercase)', () => {
  // The frontend validator enforces lowercase UUIDs; the Edge Function sanitizer
  // accepts mixed-case from the model and outputs canonical lowercase.
  assert.strictEqual(isValidContactLink('/contacts/00000000-0000-0000-0000-AABBCCDD0001'), false)
})

// ── FunnlAIPage static safety assertions ──────────────────────────────────────

console.log('\nFunnlAIPage — rendering safety\n')

test('no dangerouslySetInnerHTML', () => {
  assert.ok(!aiSrc.includes('dangerouslySetInnerHTML'),
    'must not use dangerouslySetInnerHTML in the AI page')
})

test('ReactMarkdown is used (safe markdown rendering)', () => {
  assert.ok(aiSrc.includes('ReactMarkdown'),
    'must use ReactMarkdown for safe markdown rendering')
})

test('ReactMarkdown has components prop (overrides default renderers)', () => {
  assert.ok(aiSrc.includes('components={mdComponents}'),
    'must override ReactMarkdown components to control rendering')
})

test('anchor renderer rejects non-contact links as plain text', () => {
  // The `a` renderer in mdComponents returns a <span> for non-contact URLs
  assert.ok(aiSrc.includes("return <span"),
    'anchor renderer must degrade non-contact links to plain text spans')
})

test('anchor renderer validates contact links via isValidContactLink', () => {
  assert.ok(aiSrc.includes('isValidContactLink(href)'),
    'anchor renderer must validate hrefs before rendering as Link')
})

test('contact links use react-router Link (not <a> tag)', () => {
  assert.ok(aiSrc.includes("<Link to={href}"),
    'validated contact links must use react-router Link, not bare <a>')
})

test('no script: URLs in source', () => {
  assert.ok(!aiSrc.includes('javascript:') && !aiSrc.includes('javascript :'),
    'must not reference javascript: URLs')
})

test('no raw HTML rendering (no html prop on ReactMarkdown)', () => {
  // html: true would allow raw HTML in markdown — must not be set
  assert.ok(!aiSrc.includes('html={true}') && !aiSrc.includes("html: true"),
    'raw HTML rendering must be disabled in ReactMarkdown')
})

// ── URL sanitization via mdComponents ──────────────────────────────────────────

console.log('\nFunnlAIPage — URL sanitization via anchor renderer\n')

test('ai_contact_link_clicked fires only on isValidContactLink path', () => {
  // The analytics event is inside the isValidContactLink branch
  const linkBlock = aiSrc.match(/isValidContactLink\(href\)[\s\S]*?return <span/)?.[0] ?? ''
  assert.ok(
    linkBlock.includes("ai_contact_link_clicked"),
    'analytics event must only fire on validated contact links'
  )
})

test('external link fallback does not navigate', () => {
  // Non-contact URLs degrade to <span> — no navigation possible
  assert.ok(aiSrc.includes("return <span"),
    'non-contact URLs become plain spans — no navigation'
  )
})

// ── ContactRefCard safety ──────────────────────────────────────────────────────

console.log('\nContactRefCard — rendering safety\n')

test('ContactRefCard uses validated contactId from allowedContacts only', () => {
  // The rendering code passes refs from validateContactRefs (not raw extractContactRefs)
  assert.ok(aiSrc.includes('validateContactRefs(refs, contacts)'),
    'ContactRefCard refs must come from validateContactRefs, not raw extractContactRefs'
  )
})

test('ContactRefCard does not render for unknown contacts', () => {
  // Only validRefs (post-validation) are mapped to ContactRefCard
  assert.ok(aiSrc.includes('validRefs.map('),
    'ContactRefCards must only render for validated refs'
  )
})

test('Set follow-up uses validated contactId', () => {
  // The navigate call in ContactRefCard uses the contactId from the validated ref
  assert.ok(
    aiSrc.includes("navigate('/contacts/' + contactId") || aiSrc.includes("'/contacts/' + contactId"),
    'Set follow-up must use the validated contactId from DB'
  )
})

test('Open → link uses validated contactId', () => {
  assert.ok(
    aiSrc.includes("to={'/contacts/' + contactId}"),
    'Open → link must use the validated contactId'
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
