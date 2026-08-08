/**
 * onboarding-static.test.js
 *
 * Static source assertions for Stage 9 onboarding components in DashboardPage.jsx.
 * Verifies: FunnelFillMark SVG path, clip-path usage, WelcomeCard personalization,
 * ActivationProgressStrip ARIA progressbar, CompletionStrip text, storage integration,
 * deriveActivationState-driven rendering, collapsed control, and state variable declarations.
 *
 * No React, no DOM, no Supabase.
 *
 * Run with: node tests/onboarding-static.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '../src/pages/DashboardPage.jsx'), 'utf8')

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

// ── activationHelpers imports ─────────────────────────────────────────────────

console.log('\nactivationHelpers imports')

test('imports getFunnelInset', () => {
  assert.ok(src.includes('getFunnelInset'))
})
test('imports deriveActivationState', () => {
  assert.ok(src.includes('deriveActivationState'), 'must import deriveActivationState (new derivation fn)')
})
test('imports getNextAction', () => {
  assert.ok(src.includes('getNextAction'))
})
test('imports buildStepSummary', () => {
  assert.ok(src.includes('buildStepSummary'))
})
test('imports buildProgressAriaLabel', () => {
  assert.ok(src.includes('buildProgressAriaLabel'), 'must import buildProgressAriaLabel for ARIA')
})
test('imports getFirstName', () => {
  assert.ok(src.includes('getFirstName'))
})
test('imports sessionDismissKey', () => {
  assert.ok(src.includes('sessionDismissKey'))
})
test('imports welcomeSkipKey', () => {
  assert.ok(src.includes('welcomeSkipKey'), 'must import welcomeSkipKey for persistent welcome skip')
})
test('imports completionSessionKey', () => {
  assert.ok(src.includes('completionSessionKey'), 'must import completionSessionKey for session persistence')
})
test('imports readSessionFlag', () => {
  assert.ok(src.includes('readSessionFlag'))
})
test('imports writeSessionFlag', () => {
  assert.ok(src.includes('writeSessionFlag'))
})
test('imports clearSessionFlag', () => {
  assert.ok(src.includes('clearSessionFlag'), 'must import clearSessionFlag for reopenStrip')
})
test('imports readLocalFlag', () => {
  assert.ok(src.includes('readLocalFlag'), 'must import readLocalFlag for welcome skip')
})
test('imports writeLocalFlag', () => {
  assert.ok(src.includes('writeLocalFlag'), 'must import writeLocalFlag for welcome skip')
})

// ── State declarations ────────────────────────────────────────────────────────

console.log('\nstate declarations')

test('displayName state declared', () => {
  assert.ok(src.includes('displayName') && src.includes('setDisplayName'))
})
test('uid state declared', () => {
  assert.ok(src.includes("const [uid") || src.includes('[uid,'))
})
test('justCompleted state declared', () => {
  assert.ok(src.includes('justCompleted') && src.includes('setJustCompleted'))
})
test('stripDismissed state declared', () => {
  assert.ok(src.includes('stripDismissed') && src.includes('setStripDismissed'))
})
test('welcomeSkipped state declared', () => {
  assert.ok(src.includes('welcomeSkipped') && src.includes('setWelcomeSkipped'),
    'welcomeSkipped state must be declared for localStorage-backed welcome skip')
})
test('prevUidRef declared (account-switch isolation)', () => {
  assert.ok(src.includes('prevUidRef'), 'prevUidRef must track previous uid for account-switch detection')
})
test('collapsedBtnRef declared (focus restoration)', () => {
  assert.ok(src.includes('collapsedBtnRef'), 'collapsedBtnRef must support focus restoration on strip reopen')
})

// ── Profile query includes display_name ───────────────────────────────────────

console.log('\nprofile query')

test('profile select includes display_name', () => {
  assert.ok(src.includes("'activation_five_contacts_at, activation_first_interaction_at, activation_first_followup_at, activation_completed_at, display_name'"))
})

// ── FunnelFillMark component ──────────────────────────────────────────────────

console.log('\nFunnelFillMark')

test('FunnelFillMark function declared', () => {
  assert.ok(src.includes('function FunnelFillMark('))
})
test('sacred funnel path M3 4H21L15 12.5V20H9V12.5Z present', () => {
  const count = (src.match(/M3 4H21L15 12\.5V20H9V12\.5Z/g) || []).length
  assert.ok(count >= 2, `Expected at least 2 occurrences, found ${count}`)
})
test('FunnelFillMark uses getFunnelInset', () => {
  const fnStart = src.indexOf('function FunnelFillMark(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('getFunnelInset'), 'FunnelFillMark must call getFunnelInset')
})
test('FunnelFillMark has base SVG at opacity 0.18', () => {
  const fnStart = src.indexOf('function FunnelFillMark(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('opacity: 0.18') || fnBody.includes('opacity={0.18}'), 'base SVG must be at 0.18 opacity')
})
test('FunnelFillMark overlay SVG uses clipPath', () => {
  const fnStart = src.indexOf('function FunnelFillMark(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('clipPath'), 'overlay SVG must use clipPath')
})
test('FunnelFillMark fill is #FF4423 (ember)', () => {
  const fnStart = src.indexOf('function FunnelFillMark(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('#FF4423'), 'funnel fill must be #FF4423')
})
test('FunnelFillMark has aria-hidden="true"', () => {
  const fnStart = src.indexOf('function FunnelFillMark(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('aria-hidden'), 'FunnelFillMark must be aria-hidden')
})
test('FunnelFillMark respects prefers-reduced-motion', () => {
  const fnStart = src.indexOf('function FunnelFillMark(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(
    fnBody.includes('prefers-reduced-motion') || fnBody.includes('prefersReducedMotion'),
    'FunnelFillMark must check prefers-reduced-motion before animating'
  )
})
test('FunnelFillMark transition is conditional (none when reduced motion)', () => {
  const fnStart = src.indexOf('function FunnelFillMark(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes("'none'") || fnBody.includes('"none"'),
    'FunnelFillMark must set transition to none when motion is reduced')
})

// ── WelcomeCard component ─────────────────────────────────────────────────────

console.log('\nWelcomeCard')

test('WelcomeCard function declared', () => {
  assert.ok(src.includes('function WelcomeCard('))
})
test('WelcomeCard accepts displayName prop', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('displayName'), 'WelcomeCard must use displayName prop')
})
test('WelcomeCard calls getFirstName', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('getFirstName'), 'WelcomeCard must call getFirstName(displayName)')
})
test('WelcomeCard has personalized greeting branch (firstName ?)', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('Welcome to Funnl,'), 'WelcomeCard must include personalized greeting text')
})
test('WelcomeCard fallback greeting when no name', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('Welcome to Funnl.'), 'WelcomeCard must have fallback greeting without name')
})
test('WelcomeCard has Add first contact CTA', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('Add your first contact') || fnBody.includes('Add'), 'WelcomeCard must have add CTA')
})
test('WelcomeCard has Import CSV CTA', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('Import') || fnBody.includes('CSV'), 'WelcomeCard must have import CTA')
})
test('WelcomeCard has skip/tertiary CTA', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('Skip') || fnBody.includes('skip'), 'WelcomeCard must have a skip/tertiary CTA')
})
test('WelcomeCard ember primary button (#FF4423)', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(
    fnBody.includes('#FF4423') || fnBody.includes('var(--color-ember)'),
    'WelcomeCard primary button must use ember color'
  )
})
test('WelcomeCard flat funnel SVG (no FunnelFillMark animation)', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('M3 4H21L15 12.5V20H9V12.5Z'), 'WelcomeCard must include funnel SVG path directly')
  assert.ok(!fnBody.includes('FunnelFillMark'), 'WelcomeCard must use flat SVG, not the animated FunnelFillMark')
})
test('WelcomeCard onSkip prop accepted', () => {
  const fnStart = src.indexOf('function WelcomeCard(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('onSkip'), 'WelcomeCard must accept onSkip prop')
})

// ── ActivationProgressStrip component ────────────────────────────────────────

console.log('\nActivationProgressStrip')

test('ActivationProgressStrip function declared', () => {
  assert.ok(src.includes('function ActivationProgressStrip('))
})
test('ActivationProgressStrip uses FunnelFillMark', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('FunnelFillMark'), 'ActivationProgressStrip must use FunnelFillMark')
})
test('ActivationProgressStrip calls buildStepSummary', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('buildStepSummary'), 'must call buildStepSummary')
})
test('ActivationProgressStrip has onDismiss prop', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('onDismiss'), 'must have onDismiss prop')
})
test('ActivationProgressStrip has onNextAction prop', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('onNextAction'), 'must have onNextAction prop')
})
test('ActivationProgressStrip accepts completedCount prop', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('completedCount'), 'must accept completedCount for ARIA progressbar')
})
test('ActivationProgressStrip has role="progressbar" on inner div', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('role="progressbar"'),
    'must have role="progressbar" on the visual progress indicator')
})
test('ActivationProgressStrip has aria-valuemin="0"', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('aria-valuemin="0"'), 'progressbar must have aria-valuemin="0"')
})
test('ActivationProgressStrip has aria-valuemax="3"', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('aria-valuemax="3"'), 'progressbar must have aria-valuemax="3"')
})
test('ActivationProgressStrip has aria-valuenow', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('aria-valuenow'), 'progressbar must have aria-valuenow bound to completedCount')
})
test('ActivationProgressStrip has aria-label on progressbar', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('aria-label'), 'progressbar must have aria-label')
})
test('ActivationProgressStrip dismiss button present (✕ or aria-label)', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('✕') || fnBody.includes('Dismiss'), 'dismiss button must be present')
})
test('ActivationProgressStrip ember CTA button', () => {
  const fnStart = src.indexOf('function ActivationProgressStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(
    fnBody.includes('var(--color-ember)') || fnBody.includes('#FF4423'),
    'must have ember CTA button'
  )
})

// ── CompletionStrip component ─────────────────────────────────────────────────

console.log('\nCompletionStrip')

test('CompletionStrip function declared', () => {
  assert.ok(src.includes('function CompletionStrip('))
})
test('CompletionStrip uses FunnelFillMark with stepsCompleted=3', () => {
  const fnStart = src.indexOf('function CompletionStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('FunnelFillMark'), 'CompletionStrip must use FunnelFillMark')
  assert.ok(fnBody.includes('stepsCompleted={3}'), 'CompletionStrip must pass stepsCompleted={3}')
})
test('CompletionStrip has "Your Funnl is running." text', () => {
  const fnStart = src.indexOf('function CompletionStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('Your Funnl is running.'), 'must include canonical completion message')
})
test('CompletionStrip has role="status"', () => {
  const fnStart = src.indexOf('function CompletionStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('role="status"'), 'must have role="status"')
})
test('CompletionStrip has COMPLETED mono label', () => {
  const fnStart = src.indexOf('function CompletionStrip(')
  const fnEnd   = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('COMPLETED'), 'CompletionStrip must show COMPLETED label')
})

// ── dismissStrip callback ─────────────────────────────────────────────────────

console.log('\ndismissStrip callback')

test('dismissStrip function declared', () => {
  assert.ok(src.includes('function dismissStrip(') || src.includes('dismissStrip = '), 'dismissStrip must be declared')
})
test('dismissStrip calls writeSessionFlag', () => {
  const fnStart = src.indexOf('function dismissStrip(')
  const fnEnd   = src.indexOf('\n  }', fnStart)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('writeSessionFlag'), 'dismissStrip must call writeSessionFlag')
})
test('dismissStrip calls setStripDismissed(true)', () => {
  const fnStart = src.indexOf('function dismissStrip(')
  const fnEnd   = src.indexOf('\n  }', fnStart)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('setStripDismissed(true)'), 'dismissStrip must set stripDismissed to true')
})

// ── reopenStrip callback ──────────────────────────────────────────────────────

console.log('\nreopenStrip callback')

test('reopenStrip function declared', () => {
  assert.ok(src.includes('function reopenStrip('), 'reopenStrip must be declared')
})
test('reopenStrip calls clearSessionFlag', () => {
  const fnStart = src.indexOf('function reopenStrip(')
  const fnEnd   = src.indexOf('\n  }', fnStart)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('clearSessionFlag'), 'reopenStrip must clear the dismiss flag')
})
test('reopenStrip calls setStripDismissed(false)', () => {
  const fnStart = src.indexOf('function reopenStrip(')
  const fnEnd   = src.indexOf('\n  }', fnStart)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('setStripDismissed(false)'), 'reopenStrip must reset stripDismissed to false')
})

// ── skipWelcome callback ──────────────────────────────────────────────────────

console.log('\nskipWelcome callback')

test('skipWelcome function declared', () => {
  assert.ok(src.includes('function skipWelcome('), 'skipWelcome must be declared')
})
test('skipWelcome calls writeLocalFlag (localStorage persistence)', () => {
  const fnStart = src.indexOf('function skipWelcome(')
  const fnEnd   = src.indexOf('\n  }', fnStart)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('writeLocalFlag'), 'skipWelcome must persist to localStorage')
})
test('skipWelcome calls setWelcomeSkipped(true)', () => {
  const fnStart = src.indexOf('function skipWelcome(')
  const fnEnd   = src.indexOf('\n  }', fnStart)
  const fnBody  = src.slice(fnStart, fnEnd)
  assert.ok(fnBody.includes('setWelcomeSkipped(true)'), 'skipWelcome must update state')
})

// ── sessionStorage / localStorage integration ─────────────────────────────────

console.log('\nstorage integration')

test('readSessionFlag called in fetchAll', () => {
  const fetchStart = src.indexOf('async function fetchAll(')
  const fetchEnd   = src.indexOf('\n  async function ', fetchStart + 1)
  const fetchBody  = src.slice(fetchStart, fetchEnd)
  assert.ok(fetchBody.includes('readSessionFlag'), 'fetchAll must read the dismiss flag from sessionStorage')
})
test('sessionDismissKey called in fetchAll', () => {
  const fetchStart = src.indexOf('async function fetchAll(')
  const fetchEnd   = src.indexOf('\n  async function ', fetchStart + 1)
  const fetchBody  = src.slice(fetchStart, fetchEnd)
  assert.ok(fetchBody.includes('sessionDismissKey'), 'fetchAll must use sessionDismissKey')
})
test('readLocalFlag called in fetchAll for welcomeSkipped', () => {
  const fetchStart = src.indexOf('async function fetchAll(')
  const fetchEnd   = src.indexOf('\n  async function ', fetchStart + 1)
  const fetchBody  = src.slice(fetchStart, fetchEnd)
  assert.ok(fetchBody.includes('readLocalFlag'), 'fetchAll must read welcomeSkipped from localStorage')
})
test('welcomeSkipKey called in fetchAll', () => {
  const fetchStart = src.indexOf('async function fetchAll(')
  const fetchEnd   = src.indexOf('\n  async function ', fetchStart + 1)
  const fetchBody  = src.slice(fetchStart, fetchEnd)
  assert.ok(fetchBody.includes('welcomeSkipKey'), 'fetchAll must use welcomeSkipKey')
})
test('completionSessionKey called in fetchAll (restore justCompleted across nav)', () => {
  const fetchStart = src.indexOf('async function fetchAll(')
  const fetchEnd   = src.indexOf('\n  async function ', fetchStart + 1)
  const fetchBody  = src.slice(fetchStart, fetchEnd)
  assert.ok(fetchBody.includes('completionSessionKey'), 'fetchAll must check completionSessionKey')
})
test('writeSessionFlag called in recordMilestones on completion', () => {
  const msStart = src.indexOf('async function recordMilestones(')
  const msEnd   = src.indexOf('\n  function ', msStart)
  const msBody  = src.slice(msStart, msEnd)
  assert.ok(msBody.includes('writeSessionFlag'), 'recordMilestones must persist completion session flag')
})
test('completionSessionKey called in recordMilestones', () => {
  const msStart = src.indexOf('async function recordMilestones(')
  const msEnd   = src.indexOf('\n  function ', msStart)
  const msBody  = src.slice(msStart, msEnd)
  assert.ok(msBody.includes('completionSessionKey'), 'recordMilestones must use completionSessionKey')
})

// ── Account-switch isolation ──────────────────────────────────────────────────

console.log('\naccount-switch isolation')

test('prevUidRef.current checked in fetchAll', () => {
  const fetchStart = src.indexOf('async function fetchAll(')
  const fetchEnd   = src.indexOf('\n  async function ', fetchStart + 1)
  const fetchBody  = src.slice(fetchStart, fetchEnd)
  assert.ok(fetchBody.includes('prevUidRef.current'), 'fetchAll must use prevUidRef for account-switch detection')
})
test('account-switch clears setWelcomeSkipped', () => {
  const fetchStart = src.indexOf('async function fetchAll(')
  const fetchEnd   = src.indexOf('\n  async function ', fetchStart + 1)
  const fetchBody  = src.slice(fetchStart, fetchEnd)
  // Find the account-switch block
  const switchIdx = fetchBody.indexOf('prevUidRef.current !== resolvedUid')
  assert.ok(switchIdx > -1, 'must have account-switch check')
  const switchBlock = fetchBody.slice(switchIdx, switchIdx + 600)
  assert.ok(switchBlock.includes('setWelcomeSkipped'), 'account-switch must clear welcomeSkipped')
})
test('account-switch clears setJustCompleted', () => {
  const fetchStart = src.indexOf('async function fetchAll(')
  const fetchEnd   = src.indexOf('\n  async function ', fetchStart + 1)
  const fetchBody  = src.slice(fetchStart, fetchEnd)
  const switchIdx  = fetchBody.indexOf('prevUidRef.current !== resolvedUid')
  const switchBlock = fetchBody.slice(switchIdx, switchIdx + 600)
  assert.ok(switchBlock.includes('setJustCompleted'), 'account-switch must clear justCompleted')
})

// ── deriveActivationState called in render ────────────────────────────────────

console.log('\nderiveActivationState in render')

test('displayMode derived using deriveActivationState', () => {
  assert.ok(src.includes('deriveActivationState({'), 'render must call deriveActivationState()')
})
test('deriveActivationState receives milestones', () => {
  const dmIdx  = src.indexOf('deriveActivationState({')
  const dmEnd  = src.indexOf('})', dmIdx)
  const dmBlock = src.slice(dmIdx, dmEnd)
  assert.ok(dmBlock.includes('milestones'), 'must pass milestones to deriveActivationState')
})
test('deriveActivationState receives contactCount', () => {
  const dmIdx  = src.indexOf('deriveActivationState({')
  const dmEnd  = src.indexOf('})', dmIdx)
  const dmBlock = src.slice(dmIdx, dmEnd)
  assert.ok(dmBlock.includes('contactCount'), 'must pass contactCount to deriveActivationState')
})
test('deriveActivationState receives welcomeSkipped', () => {
  const dmIdx  = src.indexOf('deriveActivationState({')
  const dmEnd  = src.indexOf('})', dmIdx)
  const dmBlock = src.slice(dmIdx, dmEnd)
  assert.ok(dmBlock.includes('welcomeSkipped'), 'must pass welcomeSkipped to deriveActivationState')
})
test('deriveActivationState receives stripDismissed', () => {
  const dmIdx  = src.indexOf('deriveActivationState({')
  const dmEnd  = src.indexOf('})', dmIdx)
  const dmBlock = src.slice(dmIdx, dmEnd)
  assert.ok(dmBlock.includes('stripDismissed'), 'must pass stripDismissed to deriveActivationState')
})
test('deriveActivationState receives justCompleted', () => {
  const dmIdx  = src.indexOf('deriveActivationState({')
  const dmEnd  = src.indexOf('})', dmIdx)
  const dmBlock = src.slice(dmIdx, dmEnd)
  assert.ok(dmBlock.includes('justCompleted'), 'must pass justCompleted to deriveActivationState')
})
test('displayMode destructured from deriveActivationState result', () => {
  assert.ok(src.includes('displayMode') && src.includes('deriveActivationState'),
    'displayMode must come from deriveActivationState')
})

// ── displayMode rendering gates ───────────────────────────────────────────────

console.log('\ndisplayMode rendering gates')

test("displayMode === 'welcome' renders WelcomeCard", () => {
  assert.ok(
    src.includes("displayMode === 'welcome'") && src.includes('<WelcomeCard'),
    "welcome mode must render WelcomeCard"
  )
})
test("displayMode === 'compact' renders ActivationProgressStrip", () => {
  assert.ok(
    src.includes("displayMode === 'compact'") && src.includes('<ActivationProgressStrip'),
    "compact mode must render ActivationProgressStrip (was 'progress')"
  )
})
test("displayMode === 'newly_completed' renders CompletionStrip", () => {
  assert.ok(
    src.includes("displayMode === 'newly_completed'") && src.includes('<CompletionStrip'),
    "newly_completed mode must render CompletionStrip (was 'completion')"
  )
})
test("displayMode === 'collapsed' renders collapsed reopen control", () => {
  assert.ok(
    src.includes("displayMode === 'collapsed'"),
    "collapsed mode must render collapsed reopen control"
  )
})
test('WelcomeCard receives displayName prop', () => {
  const idx = src.indexOf('<WelcomeCard')
  const end = src.indexOf('/>', idx)
  const tag = src.slice(idx, end)
  assert.ok(tag.includes('displayName'), 'WelcomeCard must receive displayName prop')
})
test('WelcomeCard onSkip wired to skipWelcome', () => {
  const idx = src.indexOf('<WelcomeCard')
  const end = src.indexOf('/>', idx)
  const tag = src.slice(idx, end)
  assert.ok(tag.includes('skipWelcome'), 'WelcomeCard onSkip must be wired to skipWelcome()')
})
test('ActivationProgressStrip receives onDismiss={dismissStrip}', () => {
  const idx = src.indexOf('<ActivationProgressStrip')
  const end = src.indexOf('/>', idx)
  const tag = src.slice(idx, end)
  assert.ok(tag.includes('onDismiss={dismissStrip}'), 'must pass dismissStrip as onDismiss')
})
test('ActivationProgressStrip receives completedCount', () => {
  const idx = src.indexOf('<ActivationProgressStrip')
  const end = src.indexOf('/>', idx)
  const tag = src.slice(idx, end)
  assert.ok(tag.includes('completedCount'), 'must pass completedCount to ActivationProgressStrip')
})
test('ActivationProgressStrip receives ariaLabel from buildProgressAriaLabel', () => {
  const idx = src.indexOf('<ActivationProgressStrip')
  const end = src.indexOf('/>', idx)
  const tag = src.slice(idx, end)
  assert.ok(tag.includes('ariaLabel'), 'must pass ariaLabel to ActivationProgressStrip')
  assert.ok(tag.includes('buildProgressAriaLabel'), 'ariaLabel must come from buildProgressAriaLabel')
})

// ── Collapsed reopen control ──────────────────────────────────────────────────

console.log('\ncollapsed reopen control')

test('collapsed control has aria-label="Show setup progress"', () => {
  assert.ok(src.includes('Show setup progress'), 'collapsed button must have "Show setup progress" label')
})
test('collapsed control calls reopenStrip on click', () => {
  // Find the collapsed control button
  const collapsedIdx = src.indexOf("displayMode === 'collapsed'")
  const collapsedBlock = src.slice(collapsedIdx, collapsedIdx + 800)
  assert.ok(collapsedBlock.includes('reopenStrip'), 'collapsed button must call reopenStrip')
})
test('collapsed control has ref={collapsedBtnRef}', () => {
  const collapsedIdx = src.indexOf("displayMode === 'collapsed'")
  const collapsedBlock = src.slice(collapsedIdx, collapsedIdx + 800)
  assert.ok(collapsedBlock.includes('collapsedBtnRef'), 'collapsed button must use collapsedBtnRef for focus restoration')
})
test('collapsed control has dot indicator', () => {
  const collapsedIdx = src.indexOf("displayMode === 'collapsed'")
  const collapsedBlock = src.slice(collapsedIdx, collapsedIdx + 800)
  // Dot indicator uses border (not color alone for accessibility)
  assert.ok(collapsedBlock.includes('border'), 'collapsed indicator dot must use border (not color-only signal)')
})
test('collapsed control has funnel SVG path', () => {
  const collapsedIdx = src.indexOf("displayMode === 'collapsed'")
  const collapsedBlock = src.slice(collapsedIdx, collapsedIdx + 1400)
  assert.ok(collapsedBlock.includes('M3 4H21L15 12.5V20H9V12.5Z'), 'collapsed control must show sacred funnel path')
})
test('collapsed control has visible focus style', () => {
  const collapsedIdx = src.indexOf("displayMode === 'collapsed'")
  const collapsedBlock = src.slice(collapsedIdx, collapsedIdx + 800)
  assert.ok(collapsedBlock.includes('onFocus') || collapsedBlock.includes('focus:'),
    'collapsed button must have visible focus style')
})

// ── setJustCompleted in recordMilestones ──────────────────────────────────────

console.log('\nsetJustCompleted in recordMilestones')

test('setJustCompleted(true) called when activation_completed_at claimed', () => {
  const milestonesStart = src.indexOf('async function recordMilestones(')
  const milestonesEnd   = src.indexOf('\n  function ', milestonesStart)
  const body            = src.slice(milestonesStart, milestonesEnd)
  assert.ok(body.includes('setJustCompleted(true)'), 'recordMilestones must set justCompleted on completion')
})
test('setJustCompleted comes after activation_completed event', () => {
  const milestonesStart   = src.indexOf('async function recordMilestones(')
  const milestonesEnd     = src.indexOf('\n  function ', milestonesStart)
  const body              = src.slice(milestonesStart, milestonesEnd)
  const completedEventIdx = body.indexOf("track('activation_completed'")
  const justCompletedIdx  = body.indexOf('setJustCompleted(true)')
  assert.ok(completedEventIdx > -1,    'activation_completed event must fire in recordMilestones')
  assert.ok(justCompletedIdx > -1,     'setJustCompleted(true) must be in recordMilestones')
  assert.ok(justCompletedIdx > completedEventIdx, 'setJustCompleted must come after the analytics event')
})

// ── No old mode names used ────────────────────────────────────────────────────

console.log('\nno stale mode name strings in render')

test("'progress' mode string not used as render gate (replaced by 'compact')", () => {
  assert.ok(
    !src.includes("displayMode === 'progress'"),
    "must not check displayMode === 'progress' — use 'compact' instead"
  )
})
test("'completion' mode string not used as render gate (replaced by 'newly_completed')", () => {
  assert.ok(
    !src.includes("displayMode === 'completion'"),
    "must not check displayMode === 'completion' — use 'newly_completed' instead"
  )
})

// ── No references to old ChecklistCard component ──────────────────────────────

console.log('\nold ChecklistCard removed')

test('ChecklistCard is no longer defined or referenced', () => {
  assert.ok(
    !src.includes('function ChecklistCard('),
    'ChecklistCard component must be removed — replaced by onboarding sub-components'
  )
})
test('ChecklistStep is no longer defined', () => {
  assert.ok(
    !src.includes('function ChecklistStep('),
    'ChecklistStep component must be removed'
  )
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
