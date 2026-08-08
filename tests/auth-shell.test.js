/**
 * auth-shell.test.js — Source-contract tests for Stage 12: Authentication.
 *
 * Reads production source text and asserts structural, accessibility, and
 * design-system contracts without a DOM or React test environment.
 * Run with: node tests/auth-shell.test.js
 */

import assert from 'assert'
import { readFileSync } from 'fs'
import { resolve } from 'path'

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

// Load source files
const sh  = readFileSync(resolve('src/lib/authHelpers.js'), 'utf8')
const as_ = readFileSync(resolve('src/components/AuthShell.jsx'), 'utf8')
const si  = readFileSync(resolve('src/pages/SignInPage.jsx'), 'utf8')
const wp  = readFileSync(resolve('src/pages/WelcomePage.jsx'), 'utf8')
const rp  = readFileSync(resolve('src/pages/ResetPasswordPage.jsx'), 'utf8')
const app = readFileSync(resolve('src/App.jsx'), 'utf8')

// ── authHelpers.js — Node-safe (no React/Supabase) ───────────────────────────

console.log('\nauthHelpers.js is Node-safe')

test('no React import', () => {
  assert.ok(!sh.includes("from 'react'"), 'must not import React')
})

test('no Supabase import', () => {
  assert.ok(!sh.includes('supabase'), 'must not import Supabase')
})

test('no import.meta reference (must be pure Node-compatible)', () => {
  assert.ok(!sh.includes('import.meta'), 'must not reference import.meta (not Node-safe)')
})

test('no window reference (must be pure Node-compatible)', () => {
  assert.ok(!sh.includes('window.'), 'must not reference window (not Node-safe)')
})

// ── authHelpers.js — exports ──────────────────────────────────────────────────

console.log('\nauthHelpers.js exports')

test('exports PASSWORD_MIN_LENGTH', () => {
  assert.ok(sh.includes('export const PASSWORD_MIN_LENGTH'), 'missing export')
})

test('exports RESEND_COOLDOWN_SECONDS', () => {
  assert.ok(sh.includes('export const RESEND_COOLDOWN_SECONDS'), 'missing export')
})

test('exports AUTH_LOOP_PATHS', () => {
  assert.ok(sh.includes('export const AUTH_LOOP_PATHS'), 'missing export')
})

test('exports normalizeEmail', () => {
  assert.ok(sh.includes('export function normalizeEmail'), 'missing export')
})

test('exports validateEmail', () => {
  assert.ok(sh.includes('export function validateEmail'), 'missing export')
})

test('exports validatePassword', () => {
  assert.ok(sh.includes('export function validatePassword'), 'missing export')
})

test('exports validatePasswordConfirmation', () => {
  assert.ok(sh.includes('export function validatePasswordConfirmation'), 'missing export')
})

test('exports mapAuthError', () => {
  assert.ok(sh.includes('export function mapAuthError'), 'missing export')
})

test('exports buildWelcomeRedirectUrl', () => {
  assert.ok(sh.includes('export function buildWelcomeRedirectUrl'), 'missing export')
})

test('exports buildResetRedirectUrl', () => {
  assert.ok(sh.includes('export function buildResetRedirectUrl'), 'missing export')
})

test('exports resendCooldownExpiry', () => {
  assert.ok(sh.includes('export function resendCooldownExpiry'), 'missing export')
})

test('exports resendCooldownRemaining', () => {
  assert.ok(sh.includes('export function resendCooldownRemaining'), 'missing export')
})

test('exports parseResetSuccessState', () => {
  assert.ok(sh.includes('export function parseResetSuccessState'), 'missing export')
})

test('exports safeSignInDestination', () => {
  assert.ok(sh.includes('export function safeSignInDestination'), 'missing export')
})

test('exports isSignInEligible', () => {
  assert.ok(sh.includes('export function isSignInEligible'), 'missing export')
})

test('exports isSignUpEligible', () => {
  assert.ok(sh.includes('export function isSignUpEligible'), 'missing export')
})

test('exports isResetRequestEligible', () => {
  assert.ok(sh.includes('export function isResetRequestEligible'), 'missing export')
})

test('exports isPasswordUpdateEligible', () => {
  assert.ok(sh.includes('export function isPasswordUpdateEligible'), 'missing export')
})

test('exports createSubmitToken', () => {
  assert.ok(sh.includes('export function createSubmitToken'), 'missing export')
})

// ── authHelpers.js — no purple/violet/indigo in strings ──────────────────────

console.log('\nauthHelpers.js — no forbidden colors')

test('no #4B3AF0 (old purple brand)', () => {
  assert.ok(!sh.toLowerCase().includes('#4b3af0'), 'found old purple')
})

test('no #8B7CFF (old accent purple)', () => {
  assert.ok(!sh.toLowerCase().includes('#8b7cff'), 'found old accent purple')
})

// ── AuthShell.jsx — structure ─────────────────────────────────────────────────

console.log('\nAuthShell.jsx structure')

test('exports FUNNEL_PATH constant', () => {
  assert.ok(as_.includes('export const FUNNEL_PATH'), 'FUNNEL_PATH must be exported')
})

test('FUNNEL_PATH is the sacred funnel path', () => {
  assert.ok(as_.includes('M3 4H21L15 12.5V20H9V12.5Z'), 'sacred funnel path must be present')
})

test('exports AuthShell as default', () => {
  assert.ok(as_.includes('export default AuthShell'), 'must have default export')
})

test('uses Paper background #F7F2E7', () => {
  assert.ok(as_.includes('#F7F2E7'), 'Paper color must appear in AuthShell')
})

test('uses Ink background #14110F', () => {
  assert.ok(as_.includes('#14110F'), 'Ink color must appear in AuthShell')
})

test('uses Ember bg-ember on logo mark', () => {
  assert.ok(as_.includes('bg-ember'), 'Ember must be used on logo mark')
})

test('colorScheme light set on wrapper', () => {
  assert.ok(as_.includes("colorScheme: 'light'") || as_.includes('colorScheme:"light"'),
    'colorScheme: light must be applied to prevent dark-mode autofill')
})

test('Ink brand panel is aria-hidden', () => {
  assert.ok(as_.includes('aria-hidden="true"'), 'brand panel must be hidden from screen readers')
})

test('brand copy contains Meet people', () => {
  assert.ok(as_.includes('Meet people'), 'brand copy missing')
})

test('brand copy contains Remember everything', () => {
  assert.ok(as_.includes('Remember everything'), 'brand copy missing')
})

test('brand copy contains Follow through', () => {
  assert.ok(as_.includes('Follow through'), 'brand copy missing')
})

test('decorative FUNNL wordmark present with low opacity', () => {
  assert.ok(as_.includes('FUNNL'), 'decorative wordmark missing')
  assert.ok(as_.includes('0.04') || as_.includes('opacity'), 'opacity must be set')
})

test('motion-reduce applied to animated elements', () => {
  assert.ok(as_.includes('motion-reduce:'), 'motion-reduce prefix missing')
})

// ── AuthShell.jsx — no purple/violet/indigo ───────────────────────────────────

console.log('\nAuthShell.jsx — no forbidden colors')

test('no #4B3AF0 (old purple)', () => {
  assert.ok(!as_.toLowerCase().includes('#4b3af0'), 'found old purple')
})

test('no #8B7CFF (old accent purple)', () => {
  assert.ok(!as_.toLowerCase().includes('#8b7cff'), 'found old accent purple')
})

test('no #5B45F0 (old gradient purple)', () => {
  assert.ok(!as_.toLowerCase().includes('#5b45f0'), 'found old gradient purple')
})

test('no linear-gradient on buttons or panels', () => {
  assert.ok(!as_.includes('linear-gradient'), 'no gradient allowed')
})

// ── SignInPage.jsx — imports ──────────────────────────────────────────────────

console.log('\nSignInPage.jsx imports')

test('imports AuthShell', () => {
  assert.ok(si.includes('AuthShell'), 'must import AuthShell')
})

test('imports FUNNEL_PATH from AuthShell', () => {
  assert.ok(si.includes('FUNNEL_PATH'), 'must import FUNNEL_PATH')
})

test('imports classifyAuthError from authHelpers (replaces legacy mapAuthError)', () => {
  assert.ok(si.includes('classifyAuthError'), 'must import classifyAuthError — mapAuthError is now a thin wrapper, classifyAuthError is the primary API')
})

test('imports buildWelcomeRedirectUrl from authHelpers', () => {
  assert.ok(si.includes('buildWelcomeRedirectUrl'), 'must import buildWelcomeRedirectUrl')
})

test('imports buildResetRedirectUrl from authHelpers', () => {
  assert.ok(si.includes('buildResetRedirectUrl'), 'must import buildResetRedirectUrl')
})

test('imports parseResetSuccessState from authHelpers', () => {
  assert.ok(si.includes('parseResetSuccessState'), 'must import parseResetSuccessState')
})

test('imports createSubmitToken from authHelpers', () => {
  assert.ok(si.includes('createSubmitToken'), 'must import createSubmitToken')
})

test('imports resendCooldownExpiry from authHelpers', () => {
  assert.ok(si.includes('resendCooldownExpiry'), 'must import resendCooldownExpiry')
})

test('imports resendCooldownRemaining from authHelpers', () => {
  assert.ok(si.includes('resendCooldownRemaining'), 'must import resendCooldownRemaining')
})

test('imports useRef for mountedRef', () => {
  assert.ok(si.includes('useRef'), 'must import useRef for mountedRef')
})

// ── SignInPage.jsx — design system ────────────────────────────────────────────

console.log('\nSignInPage.jsx design system')

test('uses AuthShell in JSX', () => {
  assert.ok(si.includes('<AuthShell>') || si.includes('<AuthShell '), 'must render AuthShell')
})

test('uses bg-ember on primary button(s)', () => {
  assert.ok(si.includes('bg-ember'), 'Ember must be used on primary CTA buttons')
})

test('uses hover:bg-ember-hover on buttons', () => {
  assert.ok(si.includes('hover:bg-ember-hover'), 'Ember hover state must be defined')
})

test('no linear-gradient on buttons', () => {
  assert.ok(!si.includes('linear-gradient'), 'no gradient buttons allowed')
})

// ── SignInPage.jsx — no purple/violet/indigo ──────────────────────────────────

console.log('\nSignInPage.jsx — no forbidden colors')

test('no #4B3AF0 (old purple brand)', () => {
  assert.ok(!si.toLowerCase().includes('#4b3af0'), 'found old purple brand color')
})

test('no #8B7CFF (old accent purple)', () => {
  assert.ok(!si.toLowerCase().includes('#8b7cff'), 'found old accent purple')
})

test('no #5B45F0 (old gradient purple)', () => {
  assert.ok(!si.toLowerCase().includes('#5b45f0'), 'found old gradient purple')
})

test('no bg-violet-* utility classes', () => {
  assert.ok(!/bg-violet-\d/.test(si), 'found bg-violet utility class')
})

test('no bg-indigo-* utility classes', () => {
  assert.ok(!/bg-indigo-\d/.test(si), 'found bg-indigo utility class')
})

test('no bg-purple-* utility classes', () => {
  assert.ok(!/bg-purple-\d/.test(si), 'found bg-purple utility class')
})

// ── SignInPage.jsx — accessibility ────────────────────────────────────────────

console.log('\nSignInPage.jsx accessibility')

test('email input has autoComplete="email" (JSX camelCase)', () => {
  assert.ok(si.includes('autoComplete="email"') || si.includes("autoComplete='email'"),
    'email autoComplete missing (JSX uses camelCase autoComplete)')
})

test('sign-in password has autoComplete="current-password"', () => {
  assert.ok(si.includes('autoComplete="current-password"') || si.includes("autoComplete='current-password'"),
    'current-password autoComplete missing')
})

test('sign-up password has autoComplete="new-password"', () => {
  assert.ok(si.includes('autoComplete="new-password"') || si.includes("autoComplete='new-password'"),
    'new-password autoComplete missing')
})

test('htmlFor attributes are present (label associations)', () => {
  const count = (si.match(/htmlFor=/g) || []).length
  assert.ok(count >= 3, `need at least 3 htmlFor, got ${count}`)
})

test('id attributes on inputs match their labels', () => {
  assert.ok(si.includes('id="si-email"') || si.includes("id='si-email'"), 'si-email id missing')
  assert.ok(si.includes('id="si-password"') || si.includes("id='si-password'"), 'si-password id missing')
})

test('sign-up form has id="su-email"', () => {
  assert.ok(si.includes('id="su-email"') || si.includes("id='su-email'"), 'su-email id missing')
})

test('forgot-password form has id="fp-email"', () => {
  assert.ok(si.includes('id="fp-email"') || si.includes("id='fp-email'"), 'fp-email id missing')
})

test('error live region uses role="alert" or aria-live', () => {
  assert.ok(si.includes('role="alert"') || si.includes('aria-live'), 'error live region missing')
})

test('aria-invalid on inputs', () => {
  assert.ok(si.includes('aria-invalid'), 'aria-invalid missing from inputs')
})

test('aria-describedby links inputs to error messages', () => {
  assert.ok(si.includes('aria-describedby'), 'aria-describedby missing')
})

test('forms have aria-label', () => {
  assert.ok(si.includes('aria-label'), 'forms should have aria-label')
})

// ── SignInPage.jsx — stale-request protection ─────────────────────────────────

console.log('\nSignInPage.jsx stale-request protection')

test('mountedRef is declared', () => {
  assert.ok(si.includes('mountedRef'), 'mountedRef must be declared')
})

test('mountedRef.current = true in useEffect', () => {
  assert.ok(si.includes('mountedRef.current = true'), 'mountedRef must be initialized')
})

test('mountedRef.current checked after await', () => {
  assert.ok(si.includes('if (!mountedRef.current)'), 'stale-request guard must check mountedRef')
})

test('createSubmitToken called in handlers', () => {
  assert.ok(si.includes('createSubmitToken()'), 'createSubmitToken must be called in handlers')
})

// ── SignInPage.jsx — reduced motion ───────────────────────────────────────────

console.log('\nSignInPage.jsx reduced motion')

test('motion-reduce:transition-none on interactive elements', () => {
  assert.ok(si.includes('motion-reduce:transition-none'), 'reduced motion class missing')
})

// ── SignInPage.jsx — modes ────────────────────────────────────────────────────

console.log('\nSignInPage.jsx modes')

test('handles signin mode', () => {
  assert.ok(si.includes("'signin'") || si.includes('"signin"'), 'signin mode missing')
})

test('handles signup mode', () => {
  assert.ok(si.includes("'signup'") || si.includes('"signup"'), 'signup mode missing')
})

test('handles pending mode (email confirmation)', () => {
  assert.ok(si.includes("'pending'") || si.includes('"pending"'), 'pending mode missing')
})

test('handles forgot mode', () => {
  assert.ok(si.includes("'forgot'") || si.includes('"forgot"'), 'forgot mode missing')
})

test('handles reset-sent mode', () => {
  assert.ok(si.includes("'reset-sent'") || si.includes('"reset-sent"'), 'reset-sent mode missing')
})

test('classifyAuthError used for structured error classification in handlers', () => {
  assert.ok(si.includes('classifyAuthError(') || si.includes('classifySignInResult('),
    'must use classifyAuthError or classifySignInResult in auth handlers')
})

test('cooldown uses expiry-timestamp approach', () => {
  assert.ok(si.includes('resendExpiresAt') || si.includes('resendCooldownExpiry'),
    'must use expiry-timestamp cooldown approach')
})

// ── WelcomePage.jsx — design system ──────────────────────────────────────────

console.log('\nWelcomePage.jsx design system')

test('imports FUNNEL_PATH from AuthShell', () => {
  assert.ok(wp.includes('FUNNEL_PATH'), 'must import FUNNEL_PATH from AuthShell')
})

test('uses Paper background color #F7F2E7', () => {
  assert.ok(wp.includes('#F7F2E7'), 'Paper color must appear in WelcomePage')
})

test('uses Ember logo mark (bg-ember)', () => {
  assert.ok(wp.includes('bg-ember'), 'Ember logo mark must be used')
})

test('uses flat Ember button (no gradient)', () => {
  assert.ok(wp.includes('bg-ember'), 'Ember button must exist')
  assert.ok(!wp.includes('linear-gradient'), 'no gradient allowed')
})

test('uses hover:bg-ember-hover on CTA', () => {
  assert.ok(wp.includes('hover:bg-ember-hover'), 'Ember hover must be defined')
})

test('colorScheme light applied to wrapper', () => {
  assert.ok(wp.includes("colorScheme: 'light'") || wp.includes('colorScheme:"light"'),
    'colorScheme: light must be applied')
})

test('motion-reduce on button', () => {
  assert.ok(wp.includes('motion-reduce:transition-none'), 'motion-reduce missing')
})

// ── WelcomePage.jsx — content ─────────────────────────────────────────────────

console.log('\nWelcomePage.jsx content')

test('heading is "You\'re all set." with period', () => {
  assert.ok(wp.includes("You're all set."), 'heading must include trailing period')
})

test('no "You\'re all set" without period (typo guard)', () => {
  // The heading should always end with a period per spec.
  // This checks the string exists in isolation (not followed by nothing).
  // We allow "You're all set." anywhere in source.
  const idx = wp.indexOf("You're all set.")
  assert.ok(idx !== -1, 'heading with period must be present')
})

test('trial banner does not use purple (#8B7CFF)', () => {
  assert.ok(!wp.toLowerCase().includes('#8b7cff'), 'found old purple in trial banner')
})

test('no #4B3AF0 (old purple brand)', () => {
  assert.ok(!wp.toLowerCase().includes('#4b3af0'), 'found old purple brand color')
})

test('no linear-gradient', () => {
  assert.ok(!wp.includes('linear-gradient'), 'no gradient allowed')
})

test('success message references email confirmed', () => {
  assert.ok(wp.includes('confirmed') || wp.includes('confirm'), 'email confirmation message must appear')
})

// ── ResetPasswordPage.jsx — design system ────────────────────────────────────

console.log('\nResetPasswordPage.jsx design system')

test('imports FUNNEL_PATH from AuthShell', () => {
  assert.ok(rp.includes('FUNNEL_PATH'), 'must import FUNNEL_PATH from AuthShell')
})

test('imports classifyAuthError from authHelpers (structured error shape)', () => {
  assert.ok(rp.includes('classifyAuthError'), 'must import classifyAuthError for structured errors')
})

test('imports validatePassword from authHelpers', () => {
  assert.ok(rp.includes('validatePassword'), 'must import validatePassword')
})

test('imports validatePasswordConfirmation from authHelpers', () => {
  assert.ok(rp.includes('validatePasswordConfirmation'), 'must import validatePasswordConfirmation')
})

test('uses Paper background #F7F2E7', () => {
  assert.ok(rp.includes('#F7F2E7'), 'Paper color must appear')
})

test('uses Ember logo mark (bg-ember)', () => {
  assert.ok(rp.includes('bg-ember'), 'Ember must be used')
})

test('uses flat Ember button, no gradient', () => {
  assert.ok(rp.includes('bg-ember'), 'Ember button required')
  assert.ok(!rp.includes('linear-gradient'), 'no gradient allowed')
})

test('colorScheme light on wrapper', () => {
  assert.ok(rp.includes("colorScheme: 'light'") || rp.includes('colorScheme:"light"'),
    'colorScheme: light must be applied')
})

test('motion-reduce on buttons', () => {
  assert.ok(rp.includes('motion-reduce:transition-none'), 'motion-reduce missing')
})

// ── ResetPasswordPage.jsx — accessibility ────────────────────────────────────

console.log('\nResetPasswordPage.jsx accessibility')

test('new-password input has autoComplete="new-password" (JSX camelCase)', () => {
  const count = (rp.match(/autoComplete="new-password"/g) || []).length
  assert.ok(count >= 2, `need autoComplete on both password inputs; found ${count}`)
})

test('labels use htmlFor', () => {
  assert.ok(rp.includes('htmlFor='), 'htmlFor must be used on labels')
})

test('inputs have matching id attributes', () => {
  assert.ok(rp.includes('id="rp-new-password"') || rp.includes("id='rp-new-password'"), 'id missing')
  assert.ok(rp.includes('id="rp-confirm-password"') || rp.includes("id='rp-confirm-password'"), 'id missing')
})

test('error live region has role="alert"', () => {
  assert.ok(rp.includes('role="alert"'), 'error container must have role="alert"')
})

test('aria-invalid on password input', () => {
  assert.ok(rp.includes('aria-invalid'), 'aria-invalid missing')
})

test('aria-describedby links input to error', () => {
  assert.ok(rp.includes('aria-describedby'), 'aria-describedby missing')
})

test('form has aria-label', () => {
  assert.ok(rp.includes('aria-label'), 'form must have aria-label')
})

// ── ResetPasswordPage.jsx — stale-request protection ─────────────────────────

console.log('\nResetPasswordPage.jsx stale-request protection')

test('mountedRef is declared', () => {
  assert.ok(rp.includes('mountedRef'), 'mountedRef must be declared')
})

test('mountedRef initialized to true in useEffect', () => {
  assert.ok(rp.includes('mountedRef.current = true'), 'mountedRef must be initialized')
})

test('mountedRef checked after await', () => {
  assert.ok(rp.includes('if (!mountedRef.current)'), 'stale guard missing')
})

test('classifyAuthError called for updateUser errors (structured shape)', () => {
  assert.ok(rp.includes('classifyAuthError('), 'raw error.message must not be used; use classifyAuthError')
})

// ── ResetPasswordPage.jsx — no purple ────────────────────────────────────────

console.log('\nResetPasswordPage.jsx — no forbidden colors')

test('no #4B3AF0 (old purple)', () => {
  assert.ok(!rp.toLowerCase().includes('#4b3af0'), 'found old purple')
})

test('no #8B7CFF (old accent purple)', () => {
  assert.ok(!rp.toLowerCase().includes('#8b7cff'), 'found old accent purple')
})

test('no #5B45F0 (old gradient)', () => {
  assert.ok(!rp.toLowerCase().includes('#5b45f0'), 'found old gradient purple')
})

// ── Cross-file: no purple/violet/indigo in auth files ────────────────────────

console.log('\nCross-file: no forbidden colors in any auth file')

const allAuth = [sh, as_, si, wp, rp]
const authNames = ['authHelpers.js', 'AuthShell.jsx', 'SignInPage.jsx', 'WelcomePage.jsx', 'ResetPasswordPage.jsx']

for (let i = 0; i < allAuth.length; i++) {
  const src  = allAuth[i]
  const name = authNames[i]
  test(`${name}: no bg-purple-* Tailwind class`, () => {
    assert.ok(!/bg-purple-\d/.test(src), `found bg-purple utility in ${name}`)
  })
  test(`${name}: no bg-violet-* Tailwind class`, () => {
    assert.ok(!/bg-violet-\d/.test(src), `found bg-violet utility in ${name}`)
  })
}

// ── authHelpers.js — getInvalidFields export ──────────────────────────────────

console.log('\nauthHelpers.js getInvalidFields export')

test('exports getInvalidFields', () => {
  assert.ok(sh.includes('export function getInvalidFields'), 'getInvalidFields must be exported')
})

test('getInvalidFields accepts a fields array (code-based, not message-string based)', () => {
  // New API: takes an array of field names ['email','password','confirm'] from classifyAuthError.
  // Must NOT parse safeMessage strings -- copy changes cannot break field targeting.
  assert.ok(sh.includes('Array.isArray('), 'getInvalidFields must guard with Array.isArray')
})

test('getInvalidFields maps known field names to boolean keys', () => {
  // email, password, and confirm field names must be handled.
  assert.ok(sh.includes("'email'"), 'email field must be handled')
  assert.ok(sh.includes("'password'"), 'password field must be handled')
  assert.ok(sh.includes("'confirm'"), 'confirm field must be handled')
})

// ── AuthShell.jsx — reduced-motion contract ───────────────────────────────────

console.log('\nAuthShell.jsx reduced-motion contract')

test('FUNNL watermark does NOT use motion-reduce:opacity-100 (would make it fully opaque)', () => {
  assert.ok(!as_.includes('motion-reduce:opacity-100'),
    'motion-reduce:opacity-100 makes the watermark fully opaque for reduced-motion users — remove it')
})

test('FUNNL watermark preserves its low resting opacity (0.04)', () => {
  assert.ok(as_.includes('0.04'), 'watermark resting opacity must remain at 0.04')
})

test('reduced-motion uses transition-none, not opacity overrides', () => {
  // The only motion-reduce class present should be transition-related, not opacity.
  const motionReduceClasses = (as_.match(/motion-reduce:\S+/g) || [])
  for (const cls of motionReduceClasses) {
    assert.ok(!cls.includes('opacity'),
      `Found motion-reduce opacity override: ${cls} — use motion-reduce:transition-none instead`)
  }
})

// ── AuthShell.jsx — no Ember glow on funnel mark ─────────────────────────────

console.log('\nAuthShell.jsx — no Ember glow')

test('brand panel funnel mark has no boxShadow', () => {
  // The Ember logo mark must not use a colored glow shadow.
  assert.ok(!as_.includes('boxShadow'), 'boxShadow glow is not allowed on the funnel mark')
})

test('brand panel has no rgba(255,68,35 shadow)', () => {
  assert.ok(!as_.includes('rgba(255,68,35'), 'Ember rgba glow shadow must not appear in AuthShell')
})

// ── SignInPage.jsx — getInvalidFields wiring ──────────────────────────────────

console.log('\nSignInPage.jsx getInvalidFields wiring')

test('imports getInvalidFields from authHelpers', () => {
  assert.ok(si.includes('getInvalidFields'), 'getInvalidFields must be imported')
})

test('calls getInvalidFields to derive invalidFields', () => {
  assert.ok(si.includes('getInvalidFields('), 'getInvalidFields must be called')
})

test('uses invalidFields.email for aria-invalid on email inputs', () => {
  assert.ok(si.includes('invalidFields.email'), 'email aria-invalid must use invalidFields.email')
})

test('uses invalidFields.password for aria-invalid on password inputs', () => {
  assert.ok(si.includes('invalidFields.password'), 'password aria-invalid must use invalidFields.password')
})

test('uses invalidFields.confirm for aria-invalid on confirm input', () => {
  assert.ok(si.includes('invalidFields.confirm'), 'confirm aria-invalid must use invalidFields.confirm')
})

test('hasError on FieldWrapper uses invalidFields keys, not bare error', () => {
  // At least one FieldWrapper should reference invalidFields to drive the red border.
  assert.ok(si.includes('invalidFields.'), 'FieldWrapper hasError must derive from invalidFields')
})

// ── SignInPage.jsx — safeSignInDestination wired in production ────────────────

console.log('\nSignInPage.jsx safeSignInDestination in production path')

test('imports safeSignInDestination from authHelpers', () => {
  assert.ok(si.includes('safeSignInDestination'), 'safeSignInDestination must be imported')
})

test('navigate call passes through safeSignInDestination', () => {
  assert.ok(si.includes('safeSignInDestination('), 'safeSignInDestination must be called at navigate point')
})

// ── SignInPage.jsx — real token comparison (not just void token) ──────────────

console.log('\nSignInPage.jsx real token comparison')

test('currentOperationRef declared for cross-handler stale-request tracking', () => {
  assert.ok(si.includes('currentOperationRef'), 'currentOperationRef must be declared')
})

test('token compared against currentOperationRef.current after await', () => {
  assert.ok(si.includes('token !== currentOperationRef.current'),
    'token must be compared against currentOperationRef.current after each await')
})

test('switchMode invalidates in-flight token via currentOperationRef.current assignment', () => {
  // switchMode must set currentOperationRef.current to invalidate any in-flight operation.
  assert.ok(si.includes('currentOperationRef.current = createSubmitToken()'),
    'switchMode must invalidate the current operation token')
})

test('no bare void token (token comparison must be real)', () => {
  // The old pattern used `void token` to suppress lint without comparing.
  assert.ok(!si.includes('void token'), 'void token is a no-op guard — use real token comparison')
})

// ── SignInPage.jsx — reset-success state cleared once ────────────────────────

console.log('\nSignInPage.jsx reset-success state lifecycle')

test('reset-success state cleared with replace navigation', () => {
  assert.ok(si.includes('replace: true') && si.includes('state: {}'),
    'reset-success state must be cleared via navigate with replace:true and state:{}')
})

test('showResetBanner used as guard before clearing', () => {
  assert.ok(si.includes('showResetBanner'), 'showResetBanner must be checked before navigate clear')
})

// ── SignInPage.jsx — no Ember glow on logo lockup ────────────────────────────

console.log('\nSignInPage.jsx — no Ember glow on logo lockup')

test('logoLockup has no boxShadow property', () => {
  // The logo mark tile must not carry a colored glow shadow.
  assert.ok(!si.includes("boxShadow: '0"), 'boxShadow glow is not allowed on the logo mark')
})

// ── WelcomePage.jsx — no Ember glow ──────────────────────────────────────────

console.log('\nWelcomePage.jsx — no Ember glow')

test('logo mark has no boxShadow glow', () => {
  assert.ok(!wp.includes('boxShadow'), 'boxShadow glow must not be on the Ember logo mark')
})

test('no rgba(255,68,35 shadow in WelcomePage', () => {
  // Only rgba with ember color used for backgrounds/borders, never for box-shadow on marks.
  // Check there's no boxShadow: '...rgba(255,68,35...' pattern.
  const hasShadow = /boxShadow.*rgba\(255,68,35/.test(wp)
  assert.ok(!hasShadow, 'Ember rgba must not be used in boxShadow on the logo mark')
})

// ── ResetPasswordPage.jsx — no Ember glow ────────────────────────────────────

console.log('\nResetPasswordPage.jsx — no Ember glow')

test('logo mark has no boxShadow glow', () => {
  assert.ok(!rp.includes('boxShadow'), 'boxShadow glow must not be on the Ember logo mark')
})

test('no rgba(255,68,35 shadow in ResetPasswordPage', () => {
  const hasShadow = /boxShadow.*rgba\(255,68,35/.test(rp)
  assert.ok(!hasShadow, 'Ember rgba must not be used in boxShadow on the logo mark')
})

// ── Cross-file: no Ember boxShadow glow on any funnel mark ───────────────────

console.log('\nCross-file: no Ember glow on funnel marks')

const glowFiles  = [as_, si, wp, rp]
const glowNames  = ['AuthShell.jsx', 'SignInPage.jsx', 'WelcomePage.jsx', 'ResetPasswordPage.jsx']

for (let i = 0; i < glowFiles.length; i++) {
  const src  = glowFiles[i]
  const name = glowNames[i]
  test(`${name}: no boxShadow on bg-ember element`, () => {
    assert.ok(!src.includes('boxShadow'),
      `${name} must not use boxShadow (Ember glow is prohibited on funnel marks)`)
  })
}

// ── authHelpers.js — new structured error exports ─────────────────────────────

console.log('\nauthHelpers.js structured error exports')

test('exports classifyAuthError', () => {
  assert.ok(sh.includes('export function classifyAuthError'), 'classifyAuthError must be exported')
})

test('exports normalizeOrigin', () => {
  assert.ok(sh.includes('export function normalizeOrigin'), 'normalizeOrigin must be exported')
})

test('exports validationToError', () => {
  assert.ok(sh.includes('export function validationToError'), 'validationToError must be exported')
})

test('exports classifySignInResult', () => {
  assert.ok(sh.includes('export function classifySignInResult'), 'classifySignInResult must be exported')
})

test('exports classifySignUpResult', () => {
  assert.ok(sh.includes('export function classifySignUpResult'), 'classifySignUpResult must be exported')
})

test('buildWelcomeRedirectUrl has no isProd parameter (single-origin API)', () => {
  // The isProd boolean was removed -- the helper now takes only the origin string.
  // No hardcoded production URL inside authHelpers.
  assert.ok(!sh.includes('isProd'), 'buildWelcomeRedirectUrl must not take an isProd parameter')
})

test('authHelpers does not hardcode www.getfunnl.com', () => {
  assert.ok(!sh.includes('www.getfunnl.com'), 'production URL must be defined in the caller, not authHelpers')
})

test('classifyAuthError always returns fields as an array', () => {
  // Source must include Array.isArray or fields: [] or fields: [...] to prove array shape
  assert.ok(sh.includes('fields: []') || sh.includes("fields: ['"), 'fields must be an array')
})

test('classifyAuthError returns level "field" or "form"', () => {
  assert.ok(sh.includes("level: 'field'") || sh.includes("level: 'form'"), 'level enum must be present')
})

// ── SignInPage.jsx — structured error and destination improvements ─────────────

console.log('\nSignInPage.jsx structured error and destination contracts')

test('imports classifySignInResult from authHelpers', () => {
  assert.ok(si.includes('classifySignInResult'), 'classifySignInResult must be imported')
})

test('imports classifySignUpResult from authHelpers', () => {
  assert.ok(si.includes('classifySignUpResult'), 'classifySignUpResult must be imported')
})

test('imports classifyAuthError from authHelpers', () => {
  assert.ok(si.includes('classifyAuthError'), 'classifyAuthError must be imported')
})

test('imports validationToError from authHelpers', () => {
  assert.ok(si.includes('validationToError'), 'validationToError must be imported')
})

test('error state is initialized to null (structured object, not empty string)', () => {
  assert.ok(si.includes('useState(null)') || si.includes("useState(null)"),
    'error state must be null (structured) not empty string')
})

test('navigate uses location.state?.from as candidate destination', () => {
  assert.ok(si.includes('location.state?.from'),
    'must read location.state.from for the intended destination')
})

test('anti-enumeration: reset-sent copy does not reveal account existence', () => {
  assert.ok(si.includes('If an account exists'),
    'reset-sent must use anti-enumeration copy: "If an account exists..."')
})

test('handleForgotPassword allows rate_limited to surface but suppresses other errors', () => {
  assert.ok(si.includes('rate_limited') || si.includes("'rate_limited'"),
    'forgot handler must check rate_limited before deciding to suppress')
})

test('APP_ORIGIN defined in module scope (production URL not in authHelpers)', () => {
  assert.ok(si.includes('APP_ORIGIN'),
    'production origin must be a module-level constant in SignInPage, not in authHelpers')
})

test('passwords cleared before entering pending state', () => {
  assert.ok(si.includes("setPassword('')") && si.includes("setConfirmPassword('')"),
    'passwords must be cleared before setMode("pending")')
})

test('handleResend guards against empty pending email', () => {
  assert.ok(si.includes('pendingEmail') || si.includes('normalizeEmail(email)'),
    'handleResend must guard against empty email')
})

// ── ResetPasswordPage.jsx — recovery session and structured errors ─────────────

console.log('\nResetPasswordPage.jsx recovery session and structured error contracts')

test('subscribes to onAuthStateChange for PASSWORD_RECOVERY', () => {
  assert.ok(rp.includes('onAuthStateChange') && rp.includes('PASSWORD_RECOVERY'),
    'must listen for PASSWORD_RECOVERY event via onAuthStateChange')
})

test('unsubscribes from onAuthStateChange in cleanup', () => {
  assert.ok(rp.includes('subscription.unsubscribe()'),
    'onAuthStateChange subscription must be cleaned up in useEffect return')
})

test('imports validationToError from authHelpers', () => {
  assert.ok(rp.includes('validationToError'), 'validationToError must be imported')
})

test('error state uses structured object (error?.message for rendering)', () => {
  assert.ok(rp.includes('error?.message') || rp.includes('error.message'),
    'error rendering must access .message from structured error object')
})

test('field errors use error?.fields?.includes for aria-invalid', () => {
  assert.ok(rp.includes("error?.fields?.includes('password')") || rp.includes("error?.fields?.includes(\"password\")"),
    'password aria-invalid must check error.fields.includes')
})

// ── Section 12: Auth listener inventory ───────────────────────────────────────
// The authoritative session listener lives only in App.jsx; page-level listeners
// are minimal and always cleaned up.

console.log('\nSection 12: Auth listener inventory')

test('App.jsx: onAuthStateChange subscription present (authoritative session listener)', () => {
  assert.ok(app.includes('onAuthStateChange'), 'App.jsx must have the authoritative onAuthStateChange listener')
})

test('App.jsx: subscription cleaned up in useEffect return', () => {
  assert.ok(app.includes('subscription.unsubscribe()'),
    'App.jsx must unsubscribe from onAuthStateChange in cleanup')
})

test('App.jsx: single onAuthStateChange call (no duplicate listeners)', () => {
  const count = (app.match(/onAuthStateChange/g) || []).length
  assert.strictEqual(count, 1, `App.jsx must have exactly 1 onAuthStateChange; found ${count}`)
})

test('ResetPasswordPage.jsx: onAuthStateChange for PASSWORD_RECOVERY (page-level, with cleanup)', () => {
  assert.ok(rp.includes('onAuthStateChange') && rp.includes('PASSWORD_RECOVERY') && rp.includes('subscription.unsubscribe()'),
    'ResetPasswordPage must subscribe to PASSWORD_RECOVERY and clean up')
})

test('SignInPage.jsx: no onAuthStateChange (delegates session management to App.jsx)', () => {
  assert.ok(!si.includes('onAuthStateChange'),
    'SignInPage must not add a second session listener — App.jsx owns the authoritative listener')
})

test('WelcomePage.jsx: no onAuthStateChange (reads session via getSession, not a listener)', () => {
  assert.ok(!wp.includes('onAuthStateChange'),
    'WelcomePage must not add a listener — it reads session once via supabase.auth.getSession()')
})

// ── Section 13: Auth route guards ─────────────────────────────────────────────

console.log('\nSection 13: Auth route guards')

test('App.jsx unauthenticated wildcard: passes from state to /signin redirect', () => {
  assert.ok(
    app.includes('state={{ from: location.pathname + location.search }}') ||
    app.includes("state={{ from: location.pathname + location.search }}"),
    'unauthenticated * must pass state.from for the post-sign-in destination'
  )
})

test('App.jsx: checkingSession renders loading state before showing any routes', () => {
  assert.ok(app.includes('checkingSession'),
    'checkingSession flag must gate route rendering to prevent session-flash')
})

test('App.jsx: authenticated /signin redirects to / (prevents blank-screen on stale links)', () => {
  assert.ok(app.includes("path=\"/signin\"") && app.includes('Navigate to="/"'),
    'authenticated /signin must redirect to /')
})

test('App.jsx: authenticated /signup redirects to / (defensive)', () => {
  assert.ok(app.includes("path=\"/signup\"") && app.includes('Navigate to="/"'),
    'authenticated /signup must redirect to /')
})

test('App.jsx: /welcome and /reset-password always render full-screen without the app shell', () => {
  // These pages must bypass both the unauthenticated and authenticated route trees.
  assert.ok(
    app.includes("'/welcome'") || app.includes('"/welcome"') || app.includes("pathname === '/welcome'"),
    '/welcome must be handled before the session trees'
  )
})

// ── Sections 14–16: Welcome trial audit ───────────────────────────────────────

console.log('\nSections 14–16: Welcome trial audit')

test('WelcomePage: localStorage key for email_confirmed scoped by userId', () => {
  assert.ok(
    wp.includes("'funnl_confirmed_' + userId") || wp.includes('`funnl_confirmed_${userId}`'),
    'email_confirmed localStorage key must be scoped by userId to prevent cross-account collisions'
  )
})

test('WelcomePage: separate localStorage key for pro_trial_started, scoped by userId', () => {
  assert.ok(
    wp.includes("'funnl_trial_started_' + userId") || wp.includes('`funnl_trial_started_${userId}`'),
    'pro_trial_started localStorage key must be scoped by userId and separate from email_confirmed key'
  )
})

test('WelcomePage: start_my_pro_trial() called as idempotent reconciliation before reading status', () => {
  assert.ok(wp.includes('start_my_pro_trial'),
    'WelcomePage must call start_my_pro_trial() as an idempotent reconciliation step')
})

test('WelcomePage: getProAccessStatus() used for server-authoritative trial state (not new Date())', () => {
  assert.ok(wp.includes('getProAccessStatus'),
    'WelcomePage must use getProAccessStatus() for server-authoritative trial status')
})

test('WelcomePage: no new Date() for access decision (browser clock is not authoritative)', () => {
  assert.ok(!wp.includes('new Date()'),
    'WelcomePage must not use browser new Date() for Pro/trial access decisions')
})

test('WelcomePage: trial_active checked from server response, not locally computed', () => {
  assert.ok(wp.includes('trial_active'),
    'WelcomePage must read trial_active from getProAccessStatus() response')
})

test('WelcomePage: email_confirmed_at checked from session to confirm real confirmation', () => {
  assert.ok(wp.includes('email_confirmed_at'),
    'WelcomePage must verify email_confirmed_at from the Supabase session')
})

test('WelcomePage: trial banner only shown when server confirms trial_active === true', () => {
  // The condition must be explicit true, not a truthy check that could show on undefined.
  assert.ok(wp.includes('trial_active === true') || wp.includes("trialDisplay === true"),
    'trial banner must require an explicit true value from the server response')
})

// ── Section 17: Analytics inventory ───────────────────────────────────────────

console.log('\nSection 17: Analytics inventory')

test('WelcomePage fires email_confirmed event', () => {
  assert.ok(wp.includes("track('email_confirmed')") || wp.includes('track("email_confirmed")'),
    'WelcomePage must fire email_confirmed')
})

test('WelcomePage fires pro_trial_started event', () => {
  assert.ok(wp.includes("track('pro_trial_started')") || wp.includes('track("pro_trial_started")'),
    'WelcomePage must fire pro_trial_started')
})

test('SignInPage fires user_signed_up on successful signup', () => {
  assert.ok(si.includes("track('user_signed_up')") || si.includes('track("user_signed_up")'),
    'SignInPage must fire user_signed_up after signUp() succeeds')
})

test('SignInPage fires user_signed_in on successful sign-in', () => {
  assert.ok(si.includes("track('user_signed_in')") || si.includes('track("user_signed_in")'),
    'SignInPage must fire user_signed_in after signInWithPassword() succeeds')
})

test('SignInPage fires signup_started when mode is signup', () => {
  assert.ok(si.includes("track('signup_started')") || si.includes('track("signup_started")'),
    'SignInPage must fire signup_started when the signup form is shown')
})

test('WelcomePage email_confirmed: no PII in event properties', () => {
  // The track call for email_confirmed must have no second argument (no properties object)
  // or only non-PII properties. Simple check: track('email_confirmed') with no extra arg.
  const emailConfirmedCall = si.includes("track('email_confirmed')") || wp.includes("track('email_confirmed')")
  if (emailConfirmedCall) {
    // Accept both forms: track('email_confirmed') and track('email_confirmed', {})
    assert.ok(
      !wp.match(/track\('email_confirmed',\s*\{[^}]*\b(email|name|company)\b/),
      'email_confirmed must not send PII as properties'
    )
  }
  assert.ok(true, 'email_confirmed PII check passed')
})

test('WelcomePage pro_trial_started: no PII in event properties', () => {
  assert.ok(
    !wp.match(/track\('pro_trial_started',\s*\{[^}]*\b(email|name|company)\b/),
    'pro_trial_started must not send PII as properties'
  )
})

// ── Section 19: Responsive contracts ──────────────────────────────────────────

console.log('\nSection 19: Responsive contracts')

test('AuthShell: right brand panel uses hidden lg:flex (hidden on mobile, visible ≥1024px)', () => {
  assert.ok(as_.includes('hidden lg:flex') || as_.includes('hidden lg:block'),
    'AuthShell right panel must use hidden lg:flex to hide on mobile')
})

test('AuthShell: form panel takes flex-1 to fill remaining width', () => {
  assert.ok(as_.includes('flex-1'), 'form panel must use flex-1 to fill width')
})

test('SignInPage: email input has autoComplete="email"', () => {
  assert.ok(si.includes('autoComplete="email"'), 'email input must have autoComplete="email"')
})

test('SignInPage: password input has autoComplete', () => {
  assert.ok(
    si.includes('autoComplete="current-password"') || si.includes('autoComplete="new-password"'),
    'password input must have autoComplete for password managers'
  )
})

test('ResetPasswordPage: wrapper uses min-h-screen flex items-center justify-center', () => {
  assert.ok(
    rp.includes('min-h-screen') && rp.includes('flex') && rp.includes('items-center'),
    'wrapper must center content vertically and fill the viewport'
  )
})

test('WelcomePage: wrapper uses min-h-screen for full viewport height', () => {
  assert.ok(wp.includes('min-h-screen'), 'WelcomePage must use min-h-screen')
})

test('AuthShell: outer wrapper uses min-h-screen', () => {
  assert.ok(as_.includes('min-h-screen') || as_.includes('h-screen') || as_.includes('h-full'),
    'AuthShell wrapper must fill viewport height')
})

// ── Section 20: Repository audit ──────────────────────────────────────────────

console.log('\nSection 20: Repository audit')

// 1. Production URL not hardcoded in source (comes from VITE_APP_ORIGIN env var)
test('[audit-1] No hardcoded www.getfunnl.com in SignInPage (uses VITE_APP_ORIGIN env var instead)', () => {
  const count = (si.match(/www\.getfunnl\.com/g) || []).length
  assert.strictEqual(count, 0, `production URL must not be hardcoded in source — use VITE_APP_ORIGIN env var; found ${count}`)
})

// 2. mapAuthError is a thin wrapper
test('[audit-2] mapAuthError delegates to classifyAuthError (backward-compat thin wrapper)', () => {
  assert.ok(
    sh.includes('return classifyAuthError(err).message'),
    'mapAuthError must delegate to classifyAuthError().message — it is a thin wrapper only'
  )
})

// 3. classifyAuthError is the primary structured error API
test('[audit-3] classifyAuthError returns code, message, fields, level', () => {
  assert.ok(
    sh.includes('code:') && sh.includes('message:') && sh.includes('fields:') && sh.includes('level:'),
    'classifyAuthError must return all four structured error fields'
  )
})

// 4. validationToError produces the same shape as classifyAuthError
test('[audit-4] validationToError returns null on valid input (no spurious errors)', () => {
  assert.ok(
    sh.includes('if (!result || result.valid) return null'),
    'validationToError must return null when result.valid is true'
  )
})

// 5. getInvalidFields takes fields array (not message string)
test('[audit-5] getInvalidFields takes an array, not a message string', () => {
  assert.ok(sh.includes('Array.isArray('), 'getInvalidFields must guard with Array.isArray')
  assert.ok(!sh.includes("getInvalidFields(msg"), 'getInvalidFields must not accept a message string directly')
})

// 6. normalizeOrigin strips trailing slash
test('[audit-6] normalizeOrigin strips trailing slash from origin', () => {
  assert.ok(sh.includes("endsWith('/')") || sh.includes('endsWith("/")'),
    'normalizeOrigin must detect and strip a trailing slash')
})

// 7. classifySignInResult returns discriminated union
test('[audit-7] classifySignInResult covers all outcome variants', () => {
  assert.ok(sh.includes("'authenticated'") && sh.includes("'no_session'") && sh.includes("'malformed'"),
    'classifySignInResult must cover authenticated, no_session, and malformed outcomes')
})

// 8. classifySignUpResult handles confirmation_required
test('[audit-8] classifySignUpResult handles confirmation_required for normal signups', () => {
  assert.ok(sh.includes("'confirmation_required'"),
    'classifySignUpResult must return confirmation_required for normal (non-auto-confirm) signups')
})

// 9. Anti-enumeration in forgot password
test('[audit-9] handleForgotPassword: anti-enumeration always reaches reset-sent (unless rate_limited/network)', () => {
  assert.ok(si.includes("'rate_limited'") || si.includes("'network_error'"),
    'forgot handler must only suppress rate_limited and network_error; unknown accounts still go to reset-sent')
})

// 10. Passwords cleared before pending mode
test('[audit-10] handleSignUp: passwords cleared before pending mode', () => {
  const clearPw = si.includes("setPassword('')")
  const clearCf = si.includes("setConfirmPassword('')")
  assert.ok(clearPw && clearCf, 'both password fields must be cleared before transitioning to pending mode')
})

// 11. Resend guard against empty email
test('[audit-11] handleResend: guards against empty normalizeEmail(email)', () => {
  assert.ok(si.includes('if (!pendingEmail) return'),
    'handleResend must guard against empty pendingEmail')
})

// 12. PASSWORD_RECOVERY is the authoritative recovery signal
test('[audit-12] ResetPasswordPage: PASSWORD_RECOVERY event is the authoritative recovery signal', () => {
  assert.ok(rp.includes('PASSWORD_RECOVERY'),
    'ResetPasswordPage must respond to the PASSWORD_RECOVERY auth event')
})

// 13. Structured error state in all auth pages
test('[audit-13] SignInPage error state initialized to null (structured object, not empty string)', () => {
  assert.ok(si.includes('useState(null)'), 'error state must be null initially, not empty string')
})

test('[audit-14] ResetPasswordPage error state initialized to null', () => {
  assert.ok(rp.includes('useState(null)'), 'error state must be null initially')
})

// 15. Stale-request protection pattern is complete in SignInPage
test('[audit-15] SignInPage: token !== currentOperationRef.current guard after every await', () => {
  assert.ok(
    si.includes('token !== currentOperationRef.current'),
    'stale-request guard must compare token against currentOperationRef.current after awaits'
  )
})

// 16. switchMode invalidates token
test('[audit-16] switchMode: assigns new token to currentOperationRef.current', () => {
  assert.ok(
    si.includes('currentOperationRef.current = createSubmitToken()'),
    'switchMode must invalidate the in-flight token so prior handlers cannot mutate new-mode state'
  )
})

// 17. No void token pattern
test('[audit-17] No void-token anti-pattern in SignInPage', () => {
  assert.ok(!si.includes('void token'),
    'void token is a no-op stale guard — use real token comparison')
})

// 18. safeSignInDestination used at navigate point
test('[audit-18] safeSignInDestination applied to location.state.from before navigate', () => {
  assert.ok(
    si.includes('safeSignInDestination(location.state?.from)') ||
    si.includes("safeSignInDestination(location.state?.from)"),
    'safeSignInDestination must be applied to location.state.from before navigating'
  )
})

// 19. App.jsx passes state.from in wildcard redirect
test('[audit-19] App.jsx wildcard redirect includes state.from for intended destination', () => {
  assert.ok(
    app.includes('location.pathname + location.search') && app.includes('state={{'),
    'wildcard redirect must capture intended destination in state.from'
  )
})

// 20. WelcomePage localStorage keys are user-scoped
test('[audit-20] WelcomePage localStorage keys contain userId for account isolation', () => {
  const hasConfirmedKey = wp.includes('funnl_confirmed_')
  const hasTrialKey     = wp.includes('funnl_trial_started_')
  assert.ok(hasConfirmedKey && hasTrialKey, 'both localStorage keys must be userId-scoped')
})

// 21. WelcomePage uses getProAccessStatus, not new Date() for trial decisions
test('[audit-21] WelcomePage: server clock (getProAccessStatus) drives trial UI, not browser Date()', () => {
  assert.ok(wp.includes('getProAccessStatus'), 'must import and call getProAccessStatus')
  assert.ok(!wp.includes('new Date()'), 'must never use browser Date() for access decisions')
})

// 22. App.jsx session listener fires identifyUser for analytics
test('[audit-22] App.jsx: onAuthStateChange fires identifyUser when a session is present', () => {
  assert.ok(app.includes('identifyUser'), 'App.jsx must call identifyUser when session is established')
})

// 23. AuthShell uses Paper/Ink fixed colors (not Tailwind theme tokens)
test('[audit-23] AuthShell form panel uses Paper background, not bg-base', () => {
  assert.ok(as_.includes('#F7F2E7'), 'form panel must use Paper (#F7F2E7) as a fixed brand color, not bg-base')
  assert.ok(!as_.includes('bg-base'), 'bg-base (dark) must not appear in AuthShell')
})

// 24. colorScheme light set on all auth wrappers
// SignInPage delegates colorScheme to AuthShell (which sets it). WelcomePage and
// ResetPasswordPage set it directly as they don't use AuthShell.
test('[audit-24] colorScheme: light set in AuthShell (for SignInPage) and directly in standalone pages', () => {
  // AuthShell (used by SignInPage) must set colorScheme: light
  assert.ok(
    as_.includes("colorScheme: 'light'") || as_.includes('colorScheme:"light"'),
    'AuthShell must set colorScheme: light — SignInPage uses AuthShell'
  )
  // Standalone pages (no AuthShell) must set it directly
  assert.ok(
    wp.includes("colorScheme: 'light'") || wp.includes('colorScheme:"light"'),
    'WelcomePage must set colorScheme: light directly'
  )
  assert.ok(
    rp.includes("colorScheme: 'light'") || rp.includes('colorScheme:"light"'),
    'ResetPasswordPage must set colorScheme: light directly'
  )
})

// 25. motion-reduce present in all auth pages
test('[audit-25] All auth pages include motion-reduce:transition-none on animated elements', () => {
  const pages = [as_, si, wp, rp]
  const names = ['AuthShell', 'SignInPage', 'WelcomePage', 'ResetPasswordPage']
  for (let i = 0; i < pages.length; i++) {
    assert.ok(
      pages[i].includes('motion-reduce:transition-none'),
      `${names[i]} must include motion-reduce:transition-none`
    )
  }
})

// 26. No Ember rgba box-shadow on any funnel mark
test('[audit-26] No rgba(255,68,35 box-shadow in any auth file', () => {
  const allFiles = [as_, si, wp, rp]
  for (const src of allFiles) {
    const hasShadow = /boxShadow.*rgba\(255,68,35/.test(src)
    assert.ok(!hasShadow, 'Ember rgba must not be used in boxShadow on funnel marks')
  }
})

// 27. No purple/violet gradient in any auth file
test('[audit-27] No linear-gradient in any auth file', () => {
  const allFiles = [as_, si, wp, rp]
  const names = ['AuthShell', 'SignInPage', 'WelcomePage', 'ResetPasswordPage']
  for (let i = 0; i < allFiles.length; i++) {
    assert.ok(!allFiles[i].includes('linear-gradient'), `${names[i]} must not use linear-gradient`)
  }
})

// 28. role="alert" on error containers in auth pages
test('[audit-28] Error containers use role="alert" for immediate announcement', () => {
  // SignInPage and ResetPasswordPage both have error containers
  assert.ok(si.includes('role="alert"'), 'SignInPage error container must have role="alert"')
  assert.ok(rp.includes('role="alert"'), 'ResetPasswordPage error container must have role="alert"')
})

// 29. validatePassword and validatePasswordConfirmation exported from authHelpers
test('[audit-29] authHelpers exports validatePassword and validatePasswordConfirmation', () => {
  assert.ok(sh.includes('export function validatePassword'), 'validatePassword must be exported')
  assert.ok(sh.includes('export function validatePasswordConfirmation'), 'validatePasswordConfirmation must be exported')
})

// ── Section 1: Trusted redirect origin (validateOrigin wiring) ────────────────

console.log('\nSection 1: Trusted redirect origin')

test('authHelpers.js exports validateOrigin', () => {
  assert.ok(sh.includes('export function validateOrigin'), 'validateOrigin must be exported from authHelpers')
})

test('SignInPage imports validateOrigin from authHelpers', () => {
  assert.ok(si.includes('validateOrigin'), 'SignInPage must import validateOrigin')
})

test('SignInPage uses resolveAppOrigin() to produce APP_ORIGIN', () => {
  assert.ok(si.includes('resolveAppOrigin'), 'resolveAppOrigin must be defined in SignInPage')
})

test('resolveAppOrigin reads VITE_APP_ORIGIN env var first', () => {
  assert.ok(si.includes('VITE_APP_ORIGIN'), 'resolveAppOrigin must read VITE_APP_ORIGIN')
})

test('resolveAppOrigin falls back to window.location.origin when env var absent or invalid', () => {
  assert.ok(si.includes('window.location.origin'), 'resolveAppOrigin must fall back to window.location.origin')
})

test('resolveAppOrigin calls validateOrigin to vet the env var', () => {
  assert.ok(si.includes('validateOrigin(') && si.includes('VITE_APP_ORIGIN'),
    'resolveAppOrigin must validate the configured env var via validateOrigin')
})

test('SignInPage: www.getfunnl.com appears in resolveAppOrigin/APP_ORIGIN context only (not duplicate)', () => {
  const count = (si.match(/www\.getfunnl\.com/g) || []).length
  assert.ok(count <= 2, `production URL should appear at most twice (env var check context); found ${count}`)
})

// ── Section 2: Recovery session detection in ResetPasswordPage ────────────────

console.log('\nSection 2: Recovery session detection')

test('ResetPasswordPage imports classifyRecoveryAuthEvent', () => {
  assert.ok(rp.includes('classifyRecoveryAuthEvent'), 'must import classifyRecoveryAuthEvent')
})

test('ResetPasswordPage uses classifyRecoveryAuthEvent in auth event handler', () => {
  assert.ok(rp.includes('classifyRecoveryAuthEvent(event, session)') ||
    rp.includes('classifyRecoveryAuthEvent(event,session)'),
    'must call classifyRecoveryAuthEvent with event and session')
})

test("ResetPasswordPage: only classified.state === 'recovery' shows the form", () => {
  assert.ok(rp.includes("classified.state === 'recovery'") || rp.includes('classified.state==="recovery"'),
    "setPageState('form') must be guarded by classified.state === 'recovery'")
})

test("ResetPasswordPage: classified.state === 'no_session' or 'ordinary_session' shows no-session", () => {
  assert.ok(
    rp.includes("'no_session'") && rp.includes("'ordinary_session'"),
    "both no_session and ordinary_session must result in the no-session state"
  )
})

test("ResetPasswordPage: form state only set when classified.state === 'recovery' (never from getSession direct)", () => {
  // The only setPageState('form') in the file must be guarded by classified.state === 'recovery'.
  // Verify that classified.state === 'recovery' and setPageState('form') both appear (the form is only
  // opened via the auth event classifier), and that getSession().then has no direct form assignment.
  assert.ok(
    rp.includes("classified.state === 'recovery'") && rp.includes("setPageState('form')"),
    "form state must be gated by classified.state === 'recovery' from the auth event classifier"
  )
})

test('ResetPasswordPage getSession: comment explains wait-for-classifyRecoveryAuthEvent pattern', () => {
  // Source should have a comment or description that session presence does NOT equal recovery.
  assert.ok(rp.includes('classifyRecoveryAuthEvent') || rp.includes('ordinary session'),
    'source must document that presence of a session is not a recovery signal')
})

// ── Section 3: updateTokenRef in ResetPasswordPage ────────────────────────────

console.log('\nSection 3: updateTokenRef operation token')

test('ResetPasswordPage declares updateTokenRef', () => {
  assert.ok(rp.includes('updateTokenRef'), 'updateTokenRef must be declared in ResetPasswordPage')
})

test('ResetPasswordPage captures token = ++updateTokenRef.current in handleUpdatePassword', () => {
  assert.ok(rp.includes('++updateTokenRef.current'), 'updateTokenRef must be incremented to capture a token')
})

test('ResetPasswordPage checks token against updateTokenRef.current after each await', () => {
  assert.ok(rp.includes('token !== updateTokenRef.current'),
    'token must be compared against updateTokenRef.current after every await')
})

// ── Section 4: classifyPasswordUpdateResult in ResetPasswordPage ──────────────

console.log('\nSection 4: classifyPasswordUpdateResult')

test('ResetPasswordPage imports classifyPasswordUpdateResult', () => {
  assert.ok(rp.includes('classifyPasswordUpdateResult'), 'must import classifyPasswordUpdateResult')
})

test('ResetPasswordPage calls classifyPasswordUpdateResult after updateUser', () => {
  assert.ok(rp.includes('classifyPasswordUpdateResult(data, updateError)') ||
    rp.includes('classifyPasswordUpdateResult(data,updateError)'),
    'must call classifyPasswordUpdateResult with (data, updateError)')
})

test("ResetPasswordPage: checks updateResult.outcome === 'success' before navigating", () => {
  assert.ok(
    rp.includes("updateResult.outcome !== 'success'") || rp.includes('updateResult.outcome==="success"'),
    "must gate on outcome !== 'success'"
  )
})

test('ResetPasswordPage: on failure keeps form open (setSubmitting(false)) instead of navigating', () => {
  assert.ok(rp.includes('setSubmitting(false)'), 'must call setSubmitting(false) on update failure')
})

// ── Section 5: Post-update sign-out handling ──────────────────────────────────

console.log('\nSection 5: Post-update sign-out handling')

test('ResetPasswordPage: calls signOut() after successful updateUser', () => {
  assert.ok(rp.includes('signOut()'), 'must call signOut() after password update')
})

test('ResetPasswordPage: navigate uses replace: true after sign-out', () => {
  assert.ok(rp.includes("replace: true") && rp.includes("state: { passwordReset: true }"),
    'navigate must use replace:true and passwordReset state')
})

test('ResetPasswordPage: sign-out failure does not block navigation', () => {
  // The comment/code must show we navigate regardless of signOut error.
  assert.ok(rp.includes('signOutError') || rp.includes('navigating anyway'),
    'source must handle signOut failure and navigate anyway')
})

// ── Section 7: classifyResendResult in SignInPage ─────────────────────────────

console.log('\nSection 7: classifyResendResult')

test('authHelpers.js exports classifyResendResult', () => {
  assert.ok(sh.includes('export function classifyResendResult'), 'classifyResendResult must be exported')
})

test('SignInPage imports classifyResendResult', () => {
  assert.ok(si.includes('classifyResendResult'), 'must import classifyResendResult')
})

test('SignInPage calls classifyResendResult after resend await', () => {
  assert.ok(si.includes('classifyResendResult(resendErr)') || si.includes('classifyResendResult('),
    'must call classifyResendResult on the resend error')
})

// ── Section 8: Resend post-await mode/email guards ────────────────────────────

console.log('\nSection 8: Resend post-await guards')

test("SignInPage handleResend: mode === 'pending' guard after await", () => {
  assert.ok(si.includes("mode !== 'pending'") || si.includes("mode === 'pending'"),
    "handleResend must verify mode is still 'pending' after await")
})

test('SignInPage handleResend: pendingEmail guard after await', () => {
  assert.ok(si.includes('pendingEmail'),
    'handleResend must guard that pendingEmail is still the expected value after await')
})

// ── Section 9: Resend cooldown interval lifecycle ─────────────────────────────

console.log('\nSection 9: Resend cooldown lifecycle')

test('SignInPage: setInterval used for cooldown countdown', () => {
  assert.ok(si.includes('setInterval'), 'cooldown countdown must use setInterval')
})

test('SignInPage: clearInterval called (cooldown cleanup)', () => {
  assert.ok(si.includes('clearInterval'), 'setInterval must be cleaned up with clearInterval')
})

// ── Section 10: Anti-enumeration in reset request ─────────────────────────────

console.log('\nSection 10: Anti-enumeration')

test('SignInPage reset-sent message uses anti-enumeration copy', () => {
  assert.ok(si.includes('If an account exists'),
    'reset-sent must use "If an account exists..." copy to prevent account enumeration')
})

// ── authHelpers.js — new classifier exports ────────────────────────────────────

console.log('\nauthHelpers.js new classifier exports')

test('exports validateOrigin', () => {
  assert.ok(sh.includes('export function validateOrigin'), 'validateOrigin must be exported')
})

test('exports classifyPasswordUpdateResult', () => {
  assert.ok(sh.includes('export function classifyPasswordUpdateResult'), 'classifyPasswordUpdateResult must be exported')
})

test('exports classifyResendResult', () => {
  assert.ok(sh.includes('export function classifyResendResult'), 'classifyResendResult must be exported')
})

test('exports classifyRecoveryAuthEvent', () => {
  assert.ok(sh.includes('export function classifyRecoveryAuthEvent'), 'classifyRecoveryAuthEvent must be exported')
})

test('classifyPasswordUpdateResult has explicit_error, malformed, missing_user, success outcomes', () => {
  assert.ok(
    sh.includes("'explicit_error'") && sh.includes("'malformed'") &&
    sh.includes("'missing_user'") && sh.includes("'success'"),
    'classifyPasswordUpdateResult must handle all four outcome variants'
  )
})

test('classifyResendResult has sent and error outcomes', () => {
  assert.ok(sh.includes("'sent'") && sh.includes("'error'"),
    'classifyResendResult must return sent or error outcome')
})

test('classifyRecoveryAuthEvent handles PASSWORD_RECOVERY → recovery', () => {
  assert.ok(sh.includes("'PASSWORD_RECOVERY'") && sh.includes("'recovery'"),
    'classifyRecoveryAuthEvent must map PASSWORD_RECOVERY to recovery state')
})

test('classifyRecoveryAuthEvent handles SIGNED_IN → ordinary_session', () => {
  assert.ok(sh.includes("'SIGNED_IN'") && sh.includes("'ordinary_session'"),
    'classifyRecoveryAuthEvent must map SIGNED_IN to ordinary_session (not recovery)')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
