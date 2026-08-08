/**
 * funnl-ai-stage7.test.js
 *
 * Stage 7 tests: pure-function helpers exported from FunnlAIPage,
 * plus static structural assertions about the AI page implementation.
 *
 * Zero-dependency Node.js — run with: node tests/funnl-ai-stage7.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  extractContactRefs,
  sessionTitle,
  relativeTime,
  TICKER_PHRASES,
  MAX_HISTORY_SESSIONS,
  INITIAL_MESSAGE,
} from '../src/lib/ai-history.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const src   = readFileSync(join(__dir, '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── extractContactRefs ─────────────────────────────────────────────────────────

console.log('\nextractContactRefs\n')

test('returns empty array for empty string', () => {
  assert.deepStrictEqual(extractContactRefs(''), [])
})

test('returns empty array for non-string input', () => {
  assert.deepStrictEqual(extractContactRefs(null), [])
  assert.deepStrictEqual(extractContactRefs(42), [])
})

test('returns empty array for text with no contact links', () => {
  assert.deepStrictEqual(extractContactRefs('Hello world, no links here.'), [])
})

test('extracts a single contact ref', () => {
  const md = '[Alice Smith](/contacts/00000000-0000-0000-0000-000000000001)'
  const refs = extractContactRefs(md)
  assert.strictEqual(refs.length, 1)
  assert.strictEqual(refs[0].name, 'Alice Smith')
  assert.strictEqual(refs[0].contactId, '00000000-0000-0000-0000-000000000001')
})

test('extracts multiple distinct refs in order', () => {
  const md = [
    '[Alice](/contacts/00000000-0000-0000-0000-000000000001) and',
    '[Bob](/contacts/00000000-0000-0000-0000-000000000002)',
  ].join(' ')
  const refs = extractContactRefs(md)
  assert.strictEqual(refs.length, 2)
  assert.strictEqual(refs[0].name, 'Alice')
  assert.strictEqual(refs[1].name, 'Bob')
})

test('deduplicates same UUID appearing twice', () => {
  const id  = '00000000-0000-0000-0000-000000000001'
  const md  = '[Alice](/contacts/' + id + ') and [Alice again](/contacts/' + id + ')'
  const refs = extractContactRefs(md)
  assert.strictEqual(refs.length, 1)
  assert.strictEqual(refs[0].contactId, id)
})

test('normalises UUID to lowercase', () => {
  const md = '[Alice](/contacts/00000000-0000-0000-0000-AABBCCDD0001)'
  const refs = extractContactRefs(md)
  assert.strictEqual(refs[0].contactId, '00000000-0000-0000-0000-aabbccdd0001')
})

test('does not match non-UUID paths', () => {
  const md = '[Alice](/contacts/not-a-uuid)'
  assert.deepStrictEqual(extractContactRefs(md), [])
})

test('does not match external href links', () => {
  const md = '[Alice](https://linkedin.com/in/alice)'
  assert.deepStrictEqual(extractContactRefs(md), [])
})

test('handles inline prose with contact links', () => {
  const id = '12345678-1234-1234-1234-123456789012'
  const md = 'You should follow up with [John Doe](/contacts/' + id + ') about the role.'
  const refs = extractContactRefs(md)
  assert.strictEqual(refs.length, 1)
  assert.strictEqual(refs[0].name, 'John Doe')
})

// ── sessionTitle ───────────────────────────────────────────────────────────────

console.log('\nsessionTitle\n')

test('returns default for empty array', () => {
  assert.strictEqual(sessionTitle([]), 'New conversation')
})

test('returns default for non-array', () => {
  assert.strictEqual(sessionTitle(null), 'New conversation')
})

test('returns default when no user messages', () => {
  assert.strictEqual(sessionTitle([INITIAL_MESSAGE]), 'New conversation')
})

test('skips messages with errors', () => {
  const msgs = [
    { role: 'user', content: 'error msg', error: { code: 'internal_error' } },
    { role: 'user', content: 'clean msg' },
  ]
  assert.strictEqual(sessionTitle(msgs), 'clean msg')
})

test('returns first user message up to 60 chars', () => {
  const msgs = [{ role: 'user', content: 'Short message' }]
  assert.strictEqual(sessionTitle(msgs), 'Short message')
})

test('truncates long messages at 57 chars with ellipsis', () => {
  const long = 'A'.repeat(70)
  const msgs = [{ role: 'user', content: long }]
  const title = sessionTitle(msgs)
  assert.strictEqual(title.length, 58) // 57 chars + 1 Unicode ellipsis character
  assert.ok(title.endsWith('…'))
})

test('exactly 60 chars is not truncated', () => {
  const exact = 'B'.repeat(60)
  const msgs = [{ role: 'user', content: exact }]
  assert.strictEqual(sessionTitle(msgs), exact)
})

// ── relativeTime ───────────────────────────────────────────────────────────────

console.log('\nrelativeTime\n')

const NOW = new Date('2026-07-30T12:00:00Z')

test('returns empty string for invalid ISO', () => {
  assert.strictEqual(relativeTime('not-a-date', NOW), '')
})

test('returns Today for same day', () => {
  assert.strictEqual(relativeTime('2026-07-30T08:00:00Z', NOW), 'Today')
})

test('returns Yesterday for one day ago', () => {
  assert.strictEqual(relativeTime('2026-07-29T08:00:00Z', NOW), 'Yesterday')
})

test('returns N days ago for 2-6 days', () => {
  assert.strictEqual(relativeTime('2026-07-28T08:00:00Z', NOW), '2 days ago')
  assert.strictEqual(relativeTime('2026-07-24T08:00:00Z', NOW), '6 days ago')
})

test('returns formatted date for 7+ days ago', () => {
  const result = relativeTime('2026-07-01T08:00:00Z', NOW)
  assert.ok(result.includes('Jul'), 'should include month abbreviation')
  assert.ok(result.includes('1'),   'should include day')
})

test('returns Just now for future timestamp', () => {
  assert.strictEqual(relativeTime('2026-07-31T12:00:00Z', NOW), 'Just now')
})

// ── Constants ──────────────────────────────────────────────────────────────────

console.log('\nConstants\n')

test('TICKER_PHRASES has 4 entries', () => {
  assert.strictEqual(TICKER_PHRASES.length, 4)
})

test('TICKER_PHRASES are non-empty strings', () => {
  TICKER_PHRASES.forEach(p => {
    assert.strictEqual(typeof p, 'string')
    assert.ok(p.trim().length > 0)
  })
})

test('MAX_HISTORY_SESSIONS is 10', () => {
  assert.strictEqual(MAX_HISTORY_SESSIONS, 10)
})

test('INITIAL_MESSAGE is localOnly', () => {
  assert.strictEqual(INITIAL_MESSAGE.localOnly, true)
  assert.strictEqual(INITIAL_MESSAGE.role, 'assistant')
})

// ── Static structural assertions ──────────────────────────────────────────────

console.log('\nFunnlAIPage static assertions\n')

// Visual system — ember, no purple
test('uses ember color token on send button', () => {
  assert.ok(src.includes('var(--color-ember)'), 'must use ember token')
})

test('has no purple hex #8B7CFF', () => {
  assert.ok(!src.includes('#8B7CFF'), 'must not contain old purple hex')
})

test('has no purple rgba(139,124,255', () => {
  assert.ok(!src.includes('rgba(139,124,255'), 'must not contain purple rgba')
})

test('has no purple gradient 5B45F0', () => {
  assert.ok(!src.includes('5B45F0'), 'must not contain purple gradient')
})

// Layout — 190px history rail
test('has 190px history rail', () => {
  assert.ok(src.includes('190'), 'must include 190px rail width')
})

test('history rail is desktop-only (hidden md:flex)', () => {
  assert.ok(src.includes('hidden md:flex'), 'must be hidden on mobile, flex on md+')
})

// Work ticker
test('includes WorkTicker component', () => {
  assert.ok(src.includes('WorkTicker'), 'must render WorkTicker during loading')
})

test('WorkTicker uses font-mono', () => {
  assert.ok(src.includes('font-mono'), 'WorkTicker phrases must use mono font')
})

// Contact reference cards
test('includes ContactRefCard component', () => {
  assert.ok(src.includes('ContactRefCard'), 'must render ContactRefCard for contact refs')
})

test('Set follow-up action exists', () => {
  assert.ok(src.includes('Set follow-up'), 'must have Set follow-up action in contact cards')
})

test('Set follow-up navigates with openFollowUpForm state', () => {
  assert.ok(src.includes('openFollowUpForm'), 'Set follow-up must pass openFollowUpForm state')
})

test('Open → link exists in contact cards', () => {
  assert.ok(src.includes('Open →'), 'must have Open → navigation in contact cards')
})

// Pro access via context
test('uses useProStatus hook from context', () => {
  assert.ok(src.includes('useProStatus'), 'must use context-based Pro status hook')
})

test('uses classifyProStatus for display classification', () => {
  assert.ok(src.includes('classifyProStatus'), 'must classify Pro status for rendering')
})

test('handles trial badge with days remaining', () => {
  assert.ok(src.includes('days_remaining') && src.includes('DAYS LEFT'), 'must show trial countdown')
})

test('handles permanent PRO badge', () => {
  assert.ok(src.includes("displayStatus === 'permanent'") && src.includes('PRO'), 'must show PRO badge for permanent users')
})

// Prefilled routing
test('reads aiPrompt from location.state', () => {
  assert.ok(src.includes('aiPrompt') && src.includes('location.state'), 'must read prefill from Router state')
})

test('clears Router state after reading prefill', () => {
  assert.ok(src.includes('replace: true') && src.includes('state: {}'), 'must clear Router state to prevent resend on back/refresh')
})

// Analytics events preserved
test('fires ai_assistant_used on success', () => {
  assert.ok(src.includes("'ai_assistant_used'"), 'must fire ai_assistant_used')
})

test('fires ai_assistant_failed with code and retryable', () => {
  assert.ok(src.includes("'ai_assistant_failed'") && src.includes('retryable'), 'must fire ai_assistant_failed')
})

test('fires ai_contact_link_clicked', () => {
  assert.ok(src.includes("'ai_contact_link_clicked'"), 'must fire ai_contact_link_clicked')
})

test('fires ai_chat_reset with source', () => {
  assert.ok(src.includes("'ai_chat_reset'") && src.includes('source'), 'must fire ai_chat_reset')
})

// Error model
test('error retry button exists', () => {
  assert.ok(src.includes('Retry') && src.includes('retryMessage'), 'must have Retry button')
})

test('error dismiss button exists', () => {
  assert.ok(src.includes('Dismiss') && src.includes('dismissError'), 'must have Dismiss button')
})

test('invalid_request shows Start new chat', () => {
  assert.ok(src.includes("invalid_request") && src.includes('Start new chat'), 'must show Start new chat for invalid_request')
})

// Request gate preserved
test('uses createRequestGate', () => {
  assert.ok(src.includes('createRequestGate'), 'must use request gate for stale-request prevention')
})

// Mobile history
test('mobile history dropdown exists', () => {
  assert.ok(src.includes('historyOpen') && src.includes('History'), 'must have mobile history toggle')
})

test('mobile history is aria-controlled', () => {
  assert.ok(src.includes('aria-expanded') && src.includes('aria-controls'), 'mobile history toggle must have aria attributes')
})

// localStorage history
test('uses localStorage for session history', () => {
  assert.ok(src.includes('localStorage'), 'must persist conversation history to localStorage')
})

test('has historyKey and currentKey exports', () => {
  assert.ok(src.includes('historyKey') && src.includes('currentKey'), 'must export storage key helpers')
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)

