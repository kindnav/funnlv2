// Tests for src/lib/authHelpers.js -- pure functions, no React/Supabase.
// Run with: node tests/auth-helpers.test.js

import assert from 'assert'
import {
  PASSWORD_MIN_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  AUTH_LOOP_PATHS,
  normalizeEmail,
  validateEmail,
  validatePassword,
  validatePasswordConfirmation,
  mapAuthError,
  classifyAuthError,
  normalizeOrigin,
  validateOrigin,
  buildWelcomeRedirectUrl,
  buildResetRedirectUrl,
  resendCooldownExpiry,
  resendCooldownRemaining,
  parseResetSuccessState,
  safeSignInDestination,
  getInvalidFields,
  validationToError,
  classifySignInResult,
  classifySignUpResult,
  classifyPasswordUpdateResult,
  classifyResendResult,
  classifyRecoveryAuthEvent,
  isSignInEligible,
  isSignUpEligible,
  isResetRequestEligible,
  isPasswordUpdateEligible,
  createSubmitToken,
} from '../src/lib/authHelpers.js'

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

// ── Constants ────────────────────────────────────────────────────────────────

console.log('\nConstants')

test('PASSWORD_MIN_LENGTH is 6', () => {
  assert.strictEqual(PASSWORD_MIN_LENGTH, 6)
})

test('RESEND_COOLDOWN_SECONDS is 60', () => {
  assert.strictEqual(RESEND_COOLDOWN_SECONDS, 60)
})

test('AUTH_LOOP_PATHS is a Set', () => {
  assert.ok(AUTH_LOOP_PATHS instanceof Set)
})

test('AUTH_LOOP_PATHS contains /signin, /signup, /welcome, /reset-password', () => {
  assert.ok(AUTH_LOOP_PATHS.has('/signin'))
  assert.ok(AUTH_LOOP_PATHS.has('/signup'))
  assert.ok(AUTH_LOOP_PATHS.has('/welcome'))
  assert.ok(AUTH_LOOP_PATHS.has('/reset-password'))
})

test('AUTH_LOOP_PATHS does not contain / or /contacts', () => {
  assert.ok(!AUTH_LOOP_PATHS.has('/'))
  assert.ok(!AUTH_LOOP_PATHS.has('/contacts'))
})

// ── normalizeEmail ───────────────────────────────────────────────────────────

console.log('\nnormalizeEmail')

test('trims leading/trailing whitespace', () => {
  assert.strictEqual(normalizeEmail('  alex@example.com  '), 'alex@example.com')
})

test('lowercases the result', () => {
  assert.strictEqual(normalizeEmail('Alex@EXAMPLE.COM'), 'alex@example.com')
})

test('returns empty string for null', () => {
  assert.strictEqual(normalizeEmail(null), '')
})

test('returns empty string for undefined', () => {
  assert.strictEqual(normalizeEmail(undefined), '')
})

test('coerces numbers to string', () => {
  assert.strictEqual(typeof normalizeEmail(42), 'string')
})

test('trims and lowercases together', () => {
  assert.strictEqual(normalizeEmail('  USER@Domain.ORG  '), 'user@domain.org')
})

test('already normalized value passes through unchanged', () => {
  assert.strictEqual(normalizeEmail('user@example.com'), 'user@example.com')
})

// ── validateEmail ────────────────────────────────────────────────────────────

console.log('\nvalidateEmail')

test('empty string returns empty code', () => {
  const r = validateEmail('')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'empty')
})

test('null input returns empty code', () => {
  assert.strictEqual(validateEmail(null).code, 'empty')
})

test('missing @ returns invalid code', () => {
  const r = validateEmail('notanemail')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'invalid')
})

test('missing TLD returns invalid code', () => {
  const r = validateEmail('user@domain')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'invalid')
})

test('@ at position 0 returns invalid code', () => {
  const r = validateEmail('@domain.com')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'invalid')
})

test('valid email returns ok code and normalized value', () => {
  const r = validateEmail('Alex@Example.com')
  assert.strictEqual(r.valid, true)
  assert.strictEqual(r.code, 'ok')
  assert.strictEqual(r.normalized, 'alex@example.com')
})

test('valid university email passes', () => {
  const r = validateEmail('student@university.edu')
  assert.ok(r.valid)
})

test('subdomain email passes', () => {
  const r = validateEmail('user@mail.example.co.uk')
  assert.ok(r.valid)
})

// ── validatePassword ─────────────────────────────────────────────────────────

console.log('\nvalidatePassword')

test('null returns empty code', () => {
  assert.strictEqual(validatePassword(null).code, 'empty')
})

test('empty string returns empty code', () => {
  assert.strictEqual(validatePassword('').code, 'empty')
})

test('5 chars returns too_short (below 6)', () => {
  assert.strictEqual(validatePassword('abcde').code, 'too_short')
})

test('6 chars (exactly PASSWORD_MIN_LENGTH) returns ok', () => {
  const r = validatePassword('abcdef')
  assert.strictEqual(r.valid, true)
  assert.strictEqual(r.code, 'ok')
})

test('more than 6 chars returns ok', () => {
  assert.ok(validatePassword('password123').valid)
})

test('too_short message references PASSWORD_MIN_LENGTH', () => {
  const r = validatePassword('x')
  assert.ok(r.message.includes(String(PASSWORD_MIN_LENGTH)))
})

// ── validatePasswordConfirmation ─────────────────────────────────────────────

console.log('\nvalidatePasswordConfirmation')

test('empty confirmation returns empty code', () => {
  assert.strictEqual(validatePasswordConfirmation('abc', '').code, 'empty')
})

test('null confirmation returns empty code', () => {
  assert.strictEqual(validatePasswordConfirmation('abc', null).code, 'empty')
})

test('mismatched passwords return mismatch code', () => {
  const r = validatePasswordConfirmation('abc', 'xyz')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.code, 'mismatch')
})

test('matching passwords return ok', () => {
  const r = validatePasswordConfirmation('secret123', 'secret123')
  assert.strictEqual(r.valid, true)
  assert.strictEqual(r.code, 'ok')
})

test('mismatch message contains useful text', () => {
  const r = validatePasswordConfirmation('abc', 'xyz')
  assert.ok(r.message.length > 0)
})

// ── mapAuthError ─────────────────────────────────────────────────────────────

console.log('\nmapAuthError')

test('null/undefined returns empty string', () => {
  assert.strictEqual(mapAuthError(null), '')
  assert.strictEqual(mapAuthError(undefined), '')
})

test('invalid credentials → friendly message', () => {
  const r = mapAuthError({ message: 'Invalid login credentials' })
  assert.ok(r.includes('Incorrect') || r.includes('password'))
  assert.ok(!r.toLowerCase().includes('credential'))
})

test('email not confirmed → prompt to check inbox', () => {
  const r = mapAuthError({ message: 'Email not confirmed' })
  assert.ok(r.toLowerCase().includes('confirm'))
})

test('user already registered → sign in suggestion', () => {
  const r = mapAuthError({ message: 'User already registered' })
  assert.ok(r.toLowerCase().includes('already'))
})

test('invalid email → friendly message, no raw text', () => {
  const r = mapAuthError({ message: 'Invalid email format' })
  assert.ok(r.toLowerCase().includes('valid email') || r.toLowerCase().includes('email'))
  assert.ok(!r.toLowerCase().includes('format'))
})

test('password too short → references minimum length', () => {
  const r = mapAuthError({ message: 'Password should be at least 6 characters' })
  assert.ok(r.includes(String(PASSWORD_MIN_LENGTH)))
})

test('rate limit by message → friendly message', () => {
  const r = mapAuthError({ message: 'For security purposes you can only request this after 60 seconds' })
  assert.ok(r.toLowerCase().includes('attempt') || r.toLowerCase().includes('wait') || r.toLowerCase().includes('many'))
})

test('rate limit by status 429 → friendly message', () => {
  const r = mapAuthError({ message: '', status: 429 })
  assert.ok(r.toLowerCase().includes('attempt') || r.toLowerCase().includes('wait') || r.toLowerCase().includes('many'))
})

test('network error → connection message', () => {
  const r = mapAuthError({ message: 'Failed to fetch' })
  assert.ok(r.toLowerCase().includes('network') || r.toLowerCase().includes('connect'))
})

test('expired link → link expired message', () => {
  const r = mapAuthError({ message: 'Token has expired' })
  assert.ok(r.toLowerCase().includes('expire') || r.toLowerCase().includes('link'))
})

test('string error is also mapped', () => {
  const r = mapAuthError('invalid login credentials')
  assert.ok(r.length > 0)
  assert.ok(!r.toLowerCase().includes('credential'))
})

test('unknown error returns generic fallback', () => {
  const r = mapAuthError({ message: 'Some totally unknown server error xyz' })
  assert.ok(r.length > 0)
  assert.ok(!r.toLowerCase().includes('unknown server error'))
})

test('never exposes raw Supabase message for unknown errors', () => {
  const raw = 'PGERR 23505 duplicate key value violates unique constraint profiles_pkey'
  const r = mapAuthError({ message: raw })
  assert.ok(!r.includes('PGERR') && !r.includes('23505') && !r.includes('profiles_pkey'))
})

// mapAuthError delegates to classifyAuthError -- verify it still returns a string
test('mapAuthError returns a string (backward compat)', () => {
  assert.strictEqual(typeof mapAuthError({ message: 'Invalid login credentials' }), 'string')
  assert.strictEqual(typeof mapAuthError(null), 'string')
})

// ── classifyAuthError ─────────────────────────────────────────────────────────

console.log('\nclassifyAuthError')

test('null returns ok code with empty message', () => {
  const r = classifyAuthError(null)
  assert.strictEqual(r.code, 'ok')
  assert.strictEqual(r.message, '')
  assert.deepStrictEqual(r.fields, [])
  assert.strictEqual(r.level, 'form')
})

test('invalid_credentials: correct code, empty fields (form-level)', () => {
  const r = classifyAuthError({ message: 'Invalid login credentials' })
  assert.strictEqual(r.code, 'invalid_credentials')
  assert.deepStrictEqual(r.fields, [])
  assert.strictEqual(r.level, 'form')
  assert.ok(r.message.length > 0)
})

test('email_not_confirmed: form-level (not email-field)', () => {
  const r = classifyAuthError({ message: 'Email not confirmed' })
  assert.strictEqual(r.code, 'email_not_confirmed')
  assert.deepStrictEqual(r.fields, [])
  assert.strictEqual(r.level, 'form')
})

test('user_exists: fields contains email, level is field', () => {
  const r = classifyAuthError({ message: 'User already registered' })
  assert.strictEqual(r.code, 'user_exists')
  assert.deepStrictEqual(r.fields, ['email'])
  assert.strictEqual(r.level, 'field')
})

test('invalid_email: fields contains email, level is field', () => {
  const r = classifyAuthError({ message: 'Invalid email format' })
  assert.strictEqual(r.code, 'invalid_email')
  assert.deepStrictEqual(r.fields, ['email'])
  assert.strictEqual(r.level, 'field')
})

test('password_too_short: fields contains password, level is field', () => {
  const r = classifyAuthError({ message: 'Password should be at least 6 characters' })
  assert.strictEqual(r.code, 'password_too_short')
  assert.deepStrictEqual(r.fields, ['password'])
  assert.strictEqual(r.level, 'field')
})

test('rate_limited: form-level, empty fields', () => {
  const r = classifyAuthError({ message: 'For security purposes you can only request this after 60 seconds' })
  assert.strictEqual(r.code, 'rate_limited')
  assert.deepStrictEqual(r.fields, [])
  assert.strictEqual(r.level, 'form')
})

test('rate_limited via status 429: correct code', () => {
  const r = classifyAuthError({ message: '', status: 429 })
  assert.strictEqual(r.code, 'rate_limited')
})

test('network_error: form-level', () => {
  const r = classifyAuthError({ message: 'Failed to fetch' })
  assert.strictEqual(r.code, 'network_error')
  assert.deepStrictEqual(r.fields, [])
  assert.strictEqual(r.level, 'form')
})

test('expired_link: form-level', () => {
  const r = classifyAuthError({ message: 'Token has expired' })
  assert.strictEqual(r.code, 'expired_link')
  assert.deepStrictEqual(r.fields, [])
  assert.strictEqual(r.level, 'form')
})

test('unknown: form-level, empty fields', () => {
  const r = classifyAuthError({ message: 'Some totally unknown server error xyz' })
  assert.strictEqual(r.code, 'unknown')
  assert.deepStrictEqual(r.fields, [])
  assert.strictEqual(r.level, 'form')
})

test('string error maps correctly', () => {
  const r = classifyAuthError('invalid login credentials')
  assert.strictEqual(r.code, 'invalid_credentials')
})

test('message is always a non-empty string for non-ok codes', () => {
  const codes = [
    { message: 'Invalid login credentials' },
    { message: 'Email not confirmed' },
    { message: 'User already registered' },
    { message: 'Invalid email format' },
    { message: 'Password should be at least 6 characters' },
    { message: 'For security purposes you can only request this after 60 seconds' },
    { message: 'Failed to fetch' },
    { message: 'Token has expired' },
    { message: 'Unknown xyz' },
  ]
  for (const err of codes) {
    const r = classifyAuthError(err)
    assert.ok(r.message.length > 0, `expected non-empty message for "${err.message}"`)
  }
})

test('fields is always an array', () => {
  const r = classifyAuthError({ message: 'Anything' })
  assert.ok(Array.isArray(r.fields))
})

test('level is always "field" or "form"', () => {
  const r = classifyAuthError({ message: 'Anything' })
  assert.ok(r.level === 'field' || r.level === 'form')
})

// mapAuthError output matches classifyAuthError message
test('mapAuthError output matches classifyAuthError message', () => {
  const err = { message: 'Invalid login credentials' }
  assert.strictEqual(mapAuthError(err), classifyAuthError(err).message)
})

// ── normalizeOrigin ───────────────────────────────────────────────────────────

console.log('\nnormalizeOrigin')

test('normalizeOrigin: trims trailing slash', () => {
  assert.strictEqual(normalizeOrigin('https://www.getfunnl.com/'), 'https://www.getfunnl.com')
})

test('normalizeOrigin: preserves origin with no trailing slash', () => {
  assert.strictEqual(normalizeOrigin('https://www.getfunnl.com'), 'https://www.getfunnl.com')
})

test('normalizeOrigin: works with localhost', () => {
  assert.strictEqual(normalizeOrigin('http://localhost:5173'), 'http://localhost:5173')
})

test('normalizeOrigin: trims trailing slash from localhost', () => {
  assert.strictEqual(normalizeOrigin('http://localhost:5173/'), 'http://localhost:5173')
})

test('normalizeOrigin: null returns empty string', () => {
  assert.strictEqual(normalizeOrigin(null), '')
})

test('normalizeOrigin: undefined returns empty string', () => {
  assert.strictEqual(normalizeOrigin(undefined), '')
})

test('normalizeOrigin: empty string returns empty string', () => {
  assert.strictEqual(normalizeOrigin(''), '')
})

test('normalizeOrigin: non-string returns empty string', () => {
  assert.strictEqual(normalizeOrigin(42), '')
})

// ── buildWelcomeRedirectUrl ───────────────────────────────────────────────────

console.log('\nbuildWelcomeRedirectUrl')

test('appends /welcome to origin', () => {
  assert.strictEqual(buildWelcomeRedirectUrl('https://www.getfunnl.com'), 'https://www.getfunnl.com/welcome')
})

test('works with localhost origin', () => {
  assert.strictEqual(buildWelcomeRedirectUrl('http://localhost:5173'), 'http://localhost:5173/welcome')
})

test('trims trailing slash before appending', () => {
  assert.strictEqual(buildWelcomeRedirectUrl('https://www.getfunnl.com/'), 'https://www.getfunnl.com/welcome')
})

test('no double-slash when origin has trailing slash', () => {
  const r = buildWelcomeRedirectUrl('http://localhost:5173/')
  assert.ok(!r.includes('//welcome'))
})

// ── buildResetRedirectUrl ─────────────────────────────────────────────────────

console.log('\nbuildResetRedirectUrl')

test('appends /reset-password to origin', () => {
  assert.strictEqual(buildResetRedirectUrl('https://www.getfunnl.com'), 'https://www.getfunnl.com/reset-password')
})

test('works with localhost origin', () => {
  assert.strictEqual(buildResetRedirectUrl('http://localhost:5173'), 'http://localhost:5173/reset-password')
})

test('trims trailing slash before appending', () => {
  assert.strictEqual(buildResetRedirectUrl('https://www.getfunnl.com/'), 'https://www.getfunnl.com/reset-password')
})

// ── resendCooldownExpiry ──────────────────────────────────────────────────────

console.log('\nresendCooldownExpiry')

test('returns nowMs + seconds * 1000', () => {
  const now = 1_000_000
  const r = resendCooldownExpiry(now, 60)
  assert.strictEqual(r, now + 60_000)
})

test('uses RESEND_COOLDOWN_SECONDS as default', () => {
  const now = 1_000_000
  assert.strictEqual(resendCooldownExpiry(now), now + RESEND_COOLDOWN_SECONDS * 1000)
})

test('custom seconds override works', () => {
  assert.strictEqual(resendCooldownExpiry(0, 30), 30_000)
})

// ── resendCooldownRemaining ───────────────────────────────────────────────────

console.log('\nresendCooldownRemaining')

test('returns 0 when expiresAtMs is null', () => {
  assert.strictEqual(resendCooldownRemaining(null, Date.now()), 0)
})

test('returns 0 when expiresAtMs is undefined', () => {
  assert.strictEqual(resendCooldownRemaining(undefined, Date.now()), 0)
})

test('returns 0 when past expiry', () => {
  const now = 2_000_000
  assert.strictEqual(resendCooldownRemaining(1_000_000, now), 0)
})

test('returns ceiling of remaining seconds', () => {
  const now = 1_000_000
  const expiry = now + 59_500 // 59.5 s remaining
  assert.strictEqual(resendCooldownRemaining(expiry, now), 60) // ceiling
})

test('returns whole seconds at clean boundary', () => {
  const now = 1_000_000
  const expiry = now + 30_000
  assert.strictEqual(resendCooldownRemaining(expiry, now), 30)
})

test('never goes below 0', () => {
  const result = resendCooldownRemaining(0, 999_999_999)
  assert.ok(result >= 0)
})

// ── parseResetSuccessState ────────────────────────────────────────────────────

console.log('\nparseResetSuccessState')

test('returns true for { passwordReset: true }', () => {
  assert.strictEqual(parseResetSuccessState({ passwordReset: true }), true)
})

test('returns false for null', () => {
  assert.strictEqual(parseResetSuccessState(null), false)
})

test('returns false for undefined', () => {
  assert.strictEqual(parseResetSuccessState(undefined), false)
})

test('returns false for empty object', () => {
  assert.strictEqual(parseResetSuccessState({}), false)
})

test('returns false for { passwordReset: 1 } (string/number, not boolean)', () => {
  assert.strictEqual(parseResetSuccessState({ passwordReset: 1 }), false)
  assert.strictEqual(parseResetSuccessState({ passwordReset: 'true' }), false)
})

test('returns false for { passwordReset: false }', () => {
  assert.strictEqual(parseResetSuccessState({ passwordReset: false }), false)
})

// ── safeSignInDestination ─────────────────────────────────────────────────────

console.log('\nsafeSignInDestination')

test('null returns /', () => {
  assert.strictEqual(safeSignInDestination(null), '/')
})

test('empty string returns /', () => {
  assert.strictEqual(safeSignInDestination(''), '/')
})

test('external URL starting with http returns /', () => {
  assert.strictEqual(safeSignInDestination('http://evil.com'), '/')
})

test('protocol-relative URL // returns /', () => {
  assert.strictEqual(safeSignInDestination('//evil.com'), '/')
})

test('javascript: scheme returns /', () => {
  assert.strictEqual(safeSignInDestination('javascript:alert(1)'), '/')
})

test('/signin (auth loop) returns /', () => {
  assert.strictEqual(safeSignInDestination('/signin'), '/')
})

test('/signup (auth loop) returns /', () => {
  assert.strictEqual(safeSignInDestination('/signup'), '/')
})

test('/welcome (auth loop) returns /', () => {
  assert.strictEqual(safeSignInDestination('/welcome'), '/')
})

test('/reset-password (auth loop) returns /', () => {
  assert.strictEqual(safeSignInDestination('/reset-password'), '/')
})

test('valid internal path /contacts returns unchanged', () => {
  assert.strictEqual(safeSignInDestination('/contacts'), '/contacts')
})

test('internal path with query string is accepted', () => {
  assert.strictEqual(safeSignInDestination('/contacts?tag=recruiter'), '/contacts?tag=recruiter')
})

test('/settings is accepted (not an auth loop path)', () => {
  assert.strictEqual(safeSignInDestination('/settings'), '/settings')
})

// ── isSignInEligible ──────────────────────────────────────────────────────────

console.log('\nisSignInEligible')

test('false when submitting', () => {
  assert.strictEqual(isSignInEligible('a@b.com', 'pw', true), false)
})

test('false when email is empty', () => {
  assert.strictEqual(isSignInEligible('', 'pw', false), false)
})

test('false when password is empty', () => {
  assert.strictEqual(isSignInEligible('a@b.com', '', false), false)
})

test('true when all fields present and not submitting', () => {
  assert.strictEqual(isSignInEligible('a@b.com', 'password', false), true)
})

// ── isSignUpEligible ──────────────────────────────────────────────────────────

console.log('\nisSignUpEligible')

test('false when submitting', () => {
  assert.strictEqual(isSignUpEligible('a@b.com', 'pw', 'pw', true), false)
})

test('false when confirm is empty', () => {
  assert.strictEqual(isSignUpEligible('a@b.com', 'pw', '', false), false)
})

test('true when all fields filled and not submitting', () => {
  assert.strictEqual(isSignUpEligible('a@b.com', 'pw', 'pw', false), true)
})

// ── isResetRequestEligible ────────────────────────────────────────────────────

console.log('\nisResetRequestEligible')

test('false when submitting', () => {
  assert.strictEqual(isResetRequestEligible('a@b.com', true), false)
})

test('false when email empty', () => {
  assert.strictEqual(isResetRequestEligible('', false), false)
})

test('true when email present and not submitting', () => {
  assert.strictEqual(isResetRequestEligible('a@b.com', false), true)
})

// ── isPasswordUpdateEligible ──────────────────────────────────────────────────

console.log('\nisPasswordUpdateEligible')

test('false when submitting', () => {
  assert.strictEqual(isPasswordUpdateEligible('abcdef', 'abcdef', true), false)
})

test('false when password too short', () => {
  assert.strictEqual(isPasswordUpdateEligible('abc', 'abc', false), false)
})

test('false when passwords do not match', () => {
  assert.strictEqual(isPasswordUpdateEligible('abcdef', 'different', false), false)
})

test('true when passwords match and meet minimum length', () => {
  assert.strictEqual(isPasswordUpdateEligible('secure123', 'secure123', false), true)
})

test('false when pw is null', () => {
  assert.strictEqual(isPasswordUpdateEligible(null, null, false), false)
})

// ── createSubmitToken ─────────────────────────────────────────────────────────

console.log('\ncreateSubmitToken')

test('returns a number', () => {
  assert.strictEqual(typeof createSubmitToken(), 'number')
})

test('each call returns a strictly larger value', () => {
  const t1 = createSubmitToken()
  const t2 = createSubmitToken()
  assert.ok(t2 > t1)
})

test('tokens are distinct across multiple calls', () => {
  const tokens = Array.from({ length: 5 }, () => createSubmitToken())
  const unique  = new Set(tokens)
  assert.strictEqual(unique.size, 5)
})

test('token is truthy (non-zero positive integer)', () => {
  assert.ok(createSubmitToken() > 0)
})

// ── getInvalidFields ──────────────────────────────────────────────────────────

console.log('\ngetInvalidFields')

// New API: accepts a fields array from classifyAuthError result, not a message string.
// Copy changes can never break field targeting -- codes drive attribution, not messages.

test('returns {} for null', () => {
  assert.deepStrictEqual(getInvalidFields(null), {})
})

test('returns {} for undefined', () => {
  assert.deepStrictEqual(getInvalidFields(undefined), {})
})

test('returns {} for empty array', () => {
  assert.deepStrictEqual(getInvalidFields([]), {})
})

test('returns {} for non-array (backward-compat guard)', () => {
  assert.deepStrictEqual(getInvalidFields('email'), {})
})

test('["email"] produces { email: true }', () => {
  assert.deepStrictEqual(getInvalidFields(['email']), { email: true })
})

test('["password"] produces { password: true }', () => {
  assert.deepStrictEqual(getInvalidFields(['password']), { password: true })
})

test('["confirm"] produces { confirm: true }', () => {
  assert.deepStrictEqual(getInvalidFields(['confirm']), { confirm: true })
})

test('"confirmPassword" normalizes to confirm', () => {
  assert.deepStrictEqual(getInvalidFields(['confirmPassword']), { confirm: true })
})

test('multiple fields: ["email","password"] produces both', () => {
  const r = getInvalidFields(['email', 'password'])
  assert.strictEqual(r.email, true)
  assert.strictEqual(r.password, true)
  assert.strictEqual(r.confirm, undefined)
})

test('only the listed field key is present -- others absent (not false)', () => {
  const r = getInvalidFields(['email'])
  assert.strictEqual(r.email, true)
  assert.strictEqual(r.password, undefined)
  assert.strictEqual(r.confirm, undefined)
})

test('always returns a plain object (not null, not array)', () => {
  const r = getInvalidFields([])
  assert.ok(r !== null && typeof r === 'object' && !Array.isArray(r))
})

// Integration: classifyAuthError.fields flows correctly through getInvalidFields
test('classifyAuthError user_exists fields -> getInvalidFields -> email: true', () => {
  const { fields } = classifyAuthError({ message: 'User already registered' })
  assert.deepStrictEqual(getInvalidFields(fields), { email: true })
})

test('classifyAuthError invalid_credentials fields -> getInvalidFields -> {}', () => {
  const { fields } = classifyAuthError({ message: 'Invalid login credentials' })
  assert.deepStrictEqual(getInvalidFields(fields), {})
})

// ── validationToError ─────────────────────────────────────────────────────────

console.log('\nvalidationToError')

test('null result returns null', () => {
  assert.strictEqual(validationToError(null, 'email'), null)
})

test('valid result returns null', () => {
  assert.strictEqual(validationToError({ valid: true, code: 'ok', message: '' }, 'email'), null)
})

test('invalid result with field produces correct shape', () => {
  const r = validationToError({ valid: false, code: 'empty', message: 'Email is required.' }, 'email')
  assert.strictEqual(r.code, 'empty')
  assert.strictEqual(r.message, 'Email is required.')
  assert.deepStrictEqual(r.fields, ['email'])
  assert.strictEqual(r.level, 'field')
})

test('invalid result with null field produces form-level error', () => {
  const r = validationToError({ valid: false, code: 'unknown', message: 'Error.' }, null)
  assert.deepStrictEqual(r.fields, [])
  assert.strictEqual(r.level, 'form')
})

test('password field produces fields: ["password"]', () => {
  const r = validationToError({ valid: false, code: 'too_short', message: 'Too short.' }, 'password')
  assert.deepStrictEqual(r.fields, ['password'])
})

test('confirm field produces fields: ["confirm"]', () => {
  const r = validationToError({ valid: false, code: 'mismatch', message: 'Mismatch.' }, 'confirm')
  assert.deepStrictEqual(r.fields, ['confirm'])
})

test('result is null (not a falsy error) for valid input', () => {
  const result = validationToError({ valid: true, code: 'ok', message: '' }, 'password')
  assert.strictEqual(result, null)
})

test('never returns a string', () => {
  const r = validationToError({ valid: false, code: 'empty', message: 'Error.' }, 'email')
  assert.ok(r !== null && typeof r === 'object')
})

// ── classifySignInResult ──────────────────────────────────────────────────────

console.log('\nclassifySignInResult')

test('error: outcome=error with authError', () => {
  const r = classifySignInResult(null, { message: 'Invalid login credentials' })
  assert.strictEqual(r.outcome, 'error')
  assert.ok(r.authError !== null)
  assert.strictEqual(r.authError.code, 'invalid_credentials')
})

test('null data: outcome=malformed', () => {
  const r = classifySignInResult(null, null)
  assert.strictEqual(r.outcome, 'malformed')
  assert.strictEqual(r.authError, null)
})

test('data without user: outcome=missing_user', () => {
  const r = classifySignInResult({ user: null, session: null }, null)
  assert.strictEqual(r.outcome, 'missing_user')
})

test('data with user but no session: outcome=no_session, user present', () => {
  const user = { id: 'abc', email: 'a@example.com' }
  const r = classifySignInResult({ user, session: null }, null)
  assert.strictEqual(r.outcome, 'no_session')
  assert.strictEqual(r.user, user)
})

test('data with user and session: outcome=authenticated', () => {
  const user = { id: 'abc' }
  const session = { access_token: 'tok' }
  const r = classifySignInResult({ user, session }, null)
  assert.strictEqual(r.outcome, 'authenticated')
  assert.strictEqual(r.session, session)
  assert.strictEqual(r.user, user)
  assert.strictEqual(r.authError, null)
})

test('authenticated: session and user are passed through', () => {
  const user = { id: 'u1', email: 'u@test.com' }
  const session = { access_token: 'at', expires_at: 9999 }
  const r = classifySignInResult({ user, session }, null)
  assert.strictEqual(r.session.access_token, 'at')
  assert.strictEqual(r.user.email, 'u@test.com')
})

test('non-object data: outcome=malformed', () => {
  const r = classifySignInResult('not-an-object', null)
  assert.strictEqual(r.outcome, 'malformed')
})

// ── classifySignUpResult ──────────────────────────────────────────────────────

console.log('\nclassifySignUpResult')

test('error: outcome=error with authError', () => {
  const r = classifySignUpResult(null, { message: 'User already registered' })
  assert.strictEqual(r.outcome, 'error')
  assert.strictEqual(r.authError.code, 'user_exists')
})

test('null data: outcome=malformed', () => {
  const r = classifySignUpResult(null, null)
  assert.strictEqual(r.outcome, 'malformed')
})

test('data without user: outcome=malformed', () => {
  const r = classifySignUpResult({ user: null, session: null }, null)
  assert.strictEqual(r.outcome, 'malformed')
})

test('user but no session: outcome=confirmation_required', () => {
  const user = { id: 'u1', email: 'u@example.com' }
  const r = classifySignUpResult({ user, session: null }, null)
  assert.strictEqual(r.outcome, 'confirmation_required')
  assert.strictEqual(r.user, user)
  assert.strictEqual(r.session, null)
  assert.strictEqual(r.authError, null)
})

test('user and session: outcome=authenticated (auto-confirm flow)', () => {
  const user = { id: 'u2' }
  const session = { access_token: 'tok' }
  const r = classifySignUpResult({ user, session }, null)
  assert.strictEqual(r.outcome, 'authenticated')
  assert.strictEqual(r.user, user)
  assert.strictEqual(r.session, session)
})

test('error outcome has authError fields array', () => {
  const r = classifySignUpResult(null, { message: 'User already registered' })
  assert.ok(Array.isArray(r.authError.fields))
})

// ── validateOrigin ────────────────────────────────────────────────────────────

console.log('\nvalidateOrigin')

test('valid https origin returns { valid: true, origin }', () => {
  const r = validateOrigin('https://www.getfunnl.com')
  assert.strictEqual(r.valid, true)
  assert.strictEqual(r.origin, 'https://www.getfunnl.com')
})

test('valid http origin returns { valid: true, origin }', () => {
  const r = validateOrigin('http://localhost:5173')
  assert.strictEqual(r.valid, true)
  assert.strictEqual(r.origin, 'http://localhost:5173')
})

test('trailing slash is absorbed — origin has no trailing slash', () => {
  const r = validateOrigin('https://www.getfunnl.com/')
  assert.strictEqual(r.valid, true)
  assert.strictEqual(r.origin, 'https://www.getfunnl.com')
})

test('null returns { valid: false, origin: "" }', () => {
  const r = validateOrigin(null)
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.origin, '')
})

test('undefined returns { valid: false, origin: "" }', () => {
  const r = validateOrigin(undefined)
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.origin, '')
})

test('empty string returns { valid: false, origin: "" }', () => {
  const r = validateOrigin('')
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.origin, '')
})

test('URL with path returns { valid: false }', () => {
  const r = validateOrigin('https://www.getfunnl.com/welcome')
  assert.strictEqual(r.valid, false)
})

test('URL with query string returns { valid: false }', () => {
  const r = validateOrigin('https://www.getfunnl.com?foo=bar')
  assert.strictEqual(r.valid, false)
})

test('URL with fragment returns { valid: false }', () => {
  const r = validateOrigin('https://www.getfunnl.com#section')
  assert.strictEqual(r.valid, false)
})

test('ftp scheme returns { valid: false }', () => {
  const r = validateOrigin('ftp://www.getfunnl.com')
  assert.strictEqual(r.valid, false)
})

test('bare domain (no scheme) returns { valid: false }', () => {
  const r = validateOrigin('www.getfunnl.com')
  assert.strictEqual(r.valid, false)
})

test('non-string value returns { valid: false }', () => {
  const r = validateOrigin(42)
  assert.strictEqual(r.valid, false)
  assert.strictEqual(r.origin, '')
})

// ── classifyPasswordUpdateResult ──────────────────────────────────────────────

console.log('\nclassifyPasswordUpdateResult')

test('error present → outcome=explicit_error with authError', () => {
  const r = classifyPasswordUpdateResult(null, { message: 'Password should be at least 6 characters' })
  assert.strictEqual(r.outcome, 'explicit_error')
  assert.ok(r.authError !== null)
  assert.strictEqual(r.authError.code, 'password_too_short')
  assert.strictEqual(r.user, null)
})

test('null data, no error → outcome=malformed', () => {
  const r = classifyPasswordUpdateResult(null, null)
  assert.strictEqual(r.outcome, 'malformed')
  assert.strictEqual(r.authError, null)
  assert.strictEqual(r.user, null)
})

test('data without user → outcome=missing_user', () => {
  const r = classifyPasswordUpdateResult({}, null)
  assert.strictEqual(r.outcome, 'missing_user')
  assert.strictEqual(r.authError, null)
  assert.strictEqual(r.user, null)
})

test('data with user → outcome=success, user passed through', () => {
  const user = { id: 'u1', email: 'u@example.com' }
  const r = classifyPasswordUpdateResult({ user }, null)
  assert.strictEqual(r.outcome, 'success')
  assert.strictEqual(r.authError, null)
  assert.strictEqual(r.user, user)
})

test('error takes precedence over data.user', () => {
  const user = { id: 'u1' }
  const r = classifyPasswordUpdateResult({ user }, { message: 'Token has expired' })
  assert.strictEqual(r.outcome, 'explicit_error')
  assert.strictEqual(r.user, null)
})

test('non-object data returns malformed', () => {
  const r = classifyPasswordUpdateResult('not-an-object', null)
  assert.strictEqual(r.outcome, 'malformed')
})

// ── classifyResendResult ──────────────────────────────────────────────────────

console.log('\nclassifyResendResult')

test('no error → outcome=sent, authError null', () => {
  const r = classifyResendResult(null)
  assert.strictEqual(r.outcome, 'sent')
  assert.strictEqual(r.authError, null)
})

test('no error (undefined) → outcome=sent', () => {
  const r = classifyResendResult(undefined)
  assert.strictEqual(r.outcome, 'sent')
  assert.strictEqual(r.authError, null)
})

test('error → outcome=error, authError has code and message', () => {
  const r = classifyResendResult({ message: 'For security purposes you can only request this after 60 seconds' })
  assert.strictEqual(r.outcome, 'error')
  assert.ok(r.authError !== null)
  assert.strictEqual(r.authError.code, 'rate_limited')
  assert.ok(r.authError.message.length > 0)
})

test('network error → outcome=error with network_error code', () => {
  const r = classifyResendResult({ message: 'Failed to fetch' })
  assert.strictEqual(r.outcome, 'error')
  assert.strictEqual(r.authError.code, 'network_error')
})

test('unknown error → outcome=error with unknown code', () => {
  const r = classifyResendResult({ message: 'Some unexpected error xyz' })
  assert.strictEqual(r.outcome, 'error')
  assert.strictEqual(r.authError.code, 'unknown')
})

// ── classifyRecoveryAuthEvent ─────────────────────────────────────────────────

console.log('\nclassifyRecoveryAuthEvent')

test('PASSWORD_RECOVERY → state=recovery', () => {
  const r = classifyRecoveryAuthEvent('PASSWORD_RECOVERY', { user: { id: 'u1' } })
  assert.strictEqual(r.state, 'recovery')
})

test('SIGNED_OUT → state=no_session', () => {
  const r = classifyRecoveryAuthEvent('SIGNED_OUT', null)
  assert.strictEqual(r.state, 'no_session')
})

test('SIGNED_IN → state=ordinary_session (not recovery)', () => {
  const r = classifyRecoveryAuthEvent('SIGNED_IN', { user: { id: 'u1' } })
  assert.strictEqual(r.state, 'ordinary_session')
})

test('INITIAL_SESSION with null session → state=no_session', () => {
  const r = classifyRecoveryAuthEvent('INITIAL_SESSION', null)
  assert.strictEqual(r.state, 'no_session')
})

test('INITIAL_SESSION with a session present → state=unchanged', () => {
  const r = classifyRecoveryAuthEvent('INITIAL_SESSION', { user: { id: 'u1' } })
  assert.strictEqual(r.state, 'unchanged')
})

test('TOKEN_REFRESHED → state=unchanged', () => {
  const r = classifyRecoveryAuthEvent('TOKEN_REFRESHED', { user: { id: 'u1' } })
  assert.strictEqual(r.state, 'unchanged')
})

test('USER_UPDATED → state=unchanged', () => {
  const r = classifyRecoveryAuthEvent('USER_UPDATED', { user: { id: 'u1' } })
  assert.strictEqual(r.state, 'unchanged')
})

test('unknown event → state=unchanged', () => {
  const r = classifyRecoveryAuthEvent('SOME_FUTURE_EVENT', null)
  assert.strictEqual(r.state, 'unchanged')
})

test('state string is always present in result', () => {
  const events = ['PASSWORD_RECOVERY', 'SIGNED_OUT', 'SIGNED_IN', 'INITIAL_SESSION', 'TOKEN_REFRESHED', 'USER_UPDATED']
  for (const evt of events) {
    const r = classifyRecoveryAuthEvent(evt, null)
    assert.ok(typeof r.state === 'string' && r.state.length > 0, `missing state for event ${evt}`)
  }
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
