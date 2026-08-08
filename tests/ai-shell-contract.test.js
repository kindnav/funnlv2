/**
 * ai-shell-contract.test.js
 *
 * Tests for the FunnlAI page shell contract per Sections 1, 10, 14, 15:
 *   - TopBar is imported and used (no competing custom sticky header)
 *   - title="Funnl AI" passed to TopBar
 *   - Workspace toolbar below TopBar holds AI-specific controls
 *   - Desktop history rail at 190px is preserved
 *   - No re-exported helpers from FunnlAIPage (tests import from ai-history.js directly)
 *   - Outcome A: AI navigation visible to all users in Sidebar, BottomNav
 *   - IME composition guard on the composer
 *   - No purple/violet arbitrary CSS values in the page
 *   - No dangerouslySetInnerHTML
 *   - No javascript: links
 *   - No PII in AI analytics events
 *   - deriveAIContactActionEligibility NOT wired for inline use in FunnlAIPage
 *   - All localStorage keys are user-scoped (contain uid)
 *
 * Zero-dependency Node.js — run with: node tests/ai-shell-contract.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const aiSrc     = readFileSync(join(__dir, '..', 'src', 'pages', 'FunnlAIPage.jsx'), 'utf8')
const sidebarSrc = readFileSync(join(__dir, '..', 'src', 'components', 'Sidebar.jsx'), 'utf8')
const bottomSrc  = readFileSync(join(__dir, '..', 'src', 'components', 'BottomNav.jsx'), 'utf8')

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

// ── TopBar integration ─────────────────────────────────────────────────────────

console.log('\nShared TopBar integration\n')

test('TopBar is imported from components/TopBar', () => {
  assert.ok(
    aiSrc.includes("from '../components/TopBar'") || aiSrc.includes("from \"../components/TopBar\""),
    'FunnlAIPage must import TopBar from components/TopBar'
  )
})

test('<TopBar> is rendered in the JSX', () => {
  assert.ok(
    aiSrc.includes('<TopBar') || aiSrc.includes('<TopBar '),
    'FunnlAIPage must render the shared <TopBar> component'
  )
})

test('TopBar receives title="Funnl AI"', () => {
  assert.ok(
    aiSrc.includes('title="Funnl AI"'),
    'TopBar must receive title="Funnl AI"'
  )
})

test('no custom sticky header competing with TopBar', () => {
  // A custom header would use sticky + z-30 or z-40 outside of TopBar's own div
  // The page must not define its own <header> or sticky div with a title
  const hasCompetingHeader =
    aiSrc.includes('<header') ||
    (aiSrc.match(/sticky top-0 z-3[0-9]/g) ?? []).length > 1 // TopBar itself counts as 1
  assert.ok(
    !aiSrc.includes('<header') &&
    !aiSrc.includes("className=\"sticky top-0 z-30") &&
    !aiSrc.includes("className=\"sticky top-0 z-40"),
    'no competing sticky header must exist in FunnlAIPage beyond TopBar'
  )
})

test('desktop history rail is present (190px width)', () => {
  assert.ok(
    aiSrc.includes('190') || aiSrc.includes('w-[190px]') || aiSrc.includes('width: 190'),
    'the 190px desktop history rail must be preserved'
  )
})

test('history rail is hidden on mobile and visible on desktop (md:flex)', () => {
  assert.ok(
    aiSrc.includes('hidden md:flex'),
    'history rail must use hidden md:flex to show only on desktop'
  )
})

// ── No re-exports from FunnlAIPage ─────────────────────────────────────────────

console.log('\nNo re-exports from FunnlAIPage\n')

test('FunnlAIPage does not re-export ai-history helpers', () => {
  assert.ok(
    !aiSrc.includes('export {') && !aiSrc.includes('export const') && !aiSrc.match(/^export function/m),
    'FunnlAIPage must not re-export any named exports — tests import from ai-history.js directly'
  )
})

test('FunnlAIPage has a default export (the component)', () => {
  assert.ok(
    aiSrc.includes('export default FunnlAIPage'),
    'FunnlAIPage must have a default export of the component'
  )
})

// ── Outcome A: AI navigation for all users ────────────────────────────────────

console.log('\nOutcome A: AI navigation visible to all users\n')

test('Sidebar has a link to /ai (visible to all users)', () => {
  assert.ok(
    sidebarSrc.includes("'/ai'") || sidebarSrc.includes('"/ai"') || sidebarSrc.includes("to=\"/ai\""),
    'Sidebar must have a link to /ai — visible to all users (Outcome A)'
  )
})

test('BottomNav has a link to /ai', () => {
  assert.ok(
    bottomSrc.includes("'/ai'") || bottomSrc.includes('"/ai"') || bottomSrc.includes('to="/ai"'),
    'BottomNav must have a link to /ai'
  )
})

test('Sidebar AI link is not conditionally hidden by pro status', () => {
  // Outcome A: the nav link is always visible; gating is inside FunnlAIPage
  // The link must not be wrapped in a conditional pro check
  const linkContext = sidebarSrc.match(/\/ai[\s\S]{0,200}/)?.[0] ?? ''
  assert.ok(
    !linkContext.includes('isProUser') && !linkContext.includes('ai_enabled') && !linkContext.includes('canUseAI'),
    'Sidebar AI link must not be conditionally hidden by Pro status (Outcome A)'
  )
})

// ── IME composition guard ─────────────────────────────────────────────────────

console.log('\nIME composition guard\n')

test('handleKeyDown checks nativeEvent.isComposing', () => {
  assert.ok(
    aiSrc.includes('isComposing') && aiSrc.includes('nativeEvent'),
    'handleKeyDown must check e.nativeEvent.isComposing to prevent Enter during CJK composition'
  )
})

test('onCompositionStart handler is on the textarea', () => {
  assert.ok(
    aiSrc.includes('onCompositionStart'),
    'textarea must have onCompositionStart handler for IME composition tracking'
  )
})

test('onCompositionEnd handler is on the textarea', () => {
  assert.ok(
    aiSrc.includes('onCompositionEnd'),
    'textarea must have onCompositionEnd handler for IME composition tracking'
  )
})

// ── Security: no purple/violet inline styles, no XSS vectors ────────────────

console.log('\nSecurity — no forbidden values or XSS vectors\n')

test('no dangerouslySetInnerHTML', () => {
  assert.ok(!aiSrc.includes('dangerouslySetInnerHTML'),
    'FunnlAIPage must not use dangerouslySetInnerHTML')
})

test('no javascript: protocol links', () => {
  assert.ok(!aiSrc.includes('javascript:'),
    'FunnlAIPage must not reference javascript: URLs')
})

test('no purple/violet arbitrary hex values (uses design token instead)', () => {
  // Stage 7 removes purple/violet in favor of ember; check for common purple hex codes
  const purplePattern = /#[89][Bb][7-9][Cc][Ff][Ff]|#[Aa][Bb][7-9][Cc][Ff][Ff]|violet|purple/
  assert.ok(
    !purplePattern.test(aiSrc),
    'FunnlAIPage must not contain purple or violet hex values — use ember token instead'
  )
})

test('ember token references the CSS variable (not hardcoded hex)', () => {
  assert.ok(
    aiSrc.includes('var(--color-ember)') || aiSrc.includes("'ember'"),
    'Stage 7 ember color must reference the CSS variable, not a hardcoded hex'
  )
})

// ── PII in analytics ──────────────────────────────────────────────────────────

console.log('\nPII hygiene in analytics\n')

test('no contact names sent in analytics events', () => {
  const trackCalls = aiSrc.match(/track\(['"]\w[^)]*\)/g) ?? []
  for (const call of trackCalls) {
    assert.ok(
      !call.includes('contact.name') && !call.includes('name:') && !call.includes('.name'),
      'track() calls must not include contact names: ' + call
    )
  }
})

test('no emails sent in analytics events', () => {
  const trackCalls = aiSrc.match(/track\(['"]\w[^)]*\)/g) ?? []
  for (const call of trackCalls) {
    assert.ok(
      !call.includes('email') && !call.includes('.email'),
      'track() calls must not include email addresses: ' + call
    )
  }
})

// ── deriveAIContactActionEligibility: not wired in page ───────────────────────

console.log('\nInline follow-up mode — dead code removed\n')

test('deriveAIContactActionEligibility is NOT imported in FunnlAIPage', () => {
  assert.ok(
    !aiSrc.includes('deriveAIContactActionEligibility'),
    'deriveAIContactActionEligibility must not be imported or called in FunnlAIPage — inline mode is not supported'
  )
})

test('ContactRefCard uses navigate-only path for follow-up (openFollowUpForm state)', () => {
  assert.ok(
    aiSrc.includes('openFollowUpForm: true'),
    'ContactRefCard must navigate with openFollowUpForm: true — the only supported follow-up path'
  )
})

// ── User-scoped localStorage keys ─────────────────────────────────────────────

console.log('\nUser-scoped localStorage\n')

test('history key is user-scoped via historyKey(uid)', () => {
  assert.ok(
    aiSrc.includes('historyKey(') || aiSrc.includes('historyKey(uid'),
    'history localStorage key must be user-scoped via historyKey(uid)'
  )
})

test('current session key is user-scoped via currentKey(uid)', () => {
  assert.ok(
    aiSrc.includes('currentKey(') || aiSrc.includes('currentKey(uid'),
    'current session key must be user-scoped via currentKey(uid)'
  )
})

test('no bare localStorage key strings in FunnlAIPage', () => {
  // Keys must use historyKey/currentKey helpers (which include uid)
  assert.ok(
    !aiSrc.includes("'funnl_ai_history'") && !aiSrc.includes("'funnl_ai_current'"),
    'must not use bare key strings — always use the user-scoped helper functions'
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
