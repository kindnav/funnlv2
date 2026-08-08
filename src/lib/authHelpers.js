/**
 * authHelpers.js -- Pure auth helpers.
 * No React or Supabase imports -- safe to unit-test in Node.js.
 *
 * Exported constants and functions cover:
 *   email normalization + validation
 *   password validation + confirmation
 *   auth error mapping (never exposes raw Supabase errors)
 *   redirect URL construction
 *   resend cooldown (expiry-timestamp approach)
 *   route-state parsing
 *   post-auth destination validation
 *   submission eligibility checks
 *   stale-request token creation
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum password length enforced client-side and server-side. */
export const PASSWORD_MIN_LENGTH = 6

/** Resend cooldown in seconds (60 s). */
export const RESEND_COOLDOWN_SECONDS = 60

/** Route paths that must never be used as a post-sign-in destination. */
export const AUTH_LOOP_PATHS = new Set([
  '/signin',
  '/signup',
  '/welcome',
  '/reset-password',
])

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw email value for submission.
 * Trims surrounding whitespace and converts to lowercase.
 * Does not validate shape.
 * @param {any} raw
 * @returns {string}
 */
export function normalizeEmail(raw) {
  if (raw == null) return ''
  return String(raw).trim().toLowerCase()
}

/**
 * Validates the shape of an email address for client-side pre-submission.
 * @param {any} raw
 * @returns {{ valid: boolean, code: string, message: string, normalized?: string }}
 *   Codes: 'ok' | 'empty' | 'invalid'
 */
export function validateEmail(raw) {
  const normalized = normalizeEmail(raw)
  if (!normalized) {
    return { valid: false, code: 'empty', message: 'Email is required.' }
  }
  const atIdx = normalized.indexOf('@')
  const hasTld = atIdx > 0 && atIdx < normalized.length - 1 && normalized.slice(atIdx + 1).includes('.')
  if (!hasTld) {
    return { valid: false, code: 'invalid', message: 'Enter a valid email address.' }
  }
  return { valid: true, code: 'ok', message: '', normalized }
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

/**
 * Validates a password against the minimum length requirement.
 * @param {any} raw
 * @returns {{ valid: boolean, code: string, message: string }}
 *   Codes: 'ok' | 'empty' | 'too_short'
 */
export function validatePassword(raw) {
  if (!raw || String(raw).length === 0) {
    return { valid: false, code: 'empty', message: 'Password is required.' }
  }
  if (String(raw).length < PASSWORD_MIN_LENGTH) {
    return {
      valid: false,
      code: 'too_short',
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    }
  }
  return { valid: true, code: 'ok', message: '' }
}

/**
 * Validates that a confirmation field matches a password.
 * @param {string} password
 * @param {string} confirmation
 * @returns {{ valid: boolean, code: string, message: string }}
 *   Codes: 'ok' | 'empty' | 'mismatch'
 */
export function validatePasswordConfirmation(password, confirmation) {
  if (!confirmation || String(confirmation).length === 0) {
    return { valid: false, code: 'empty', message: 'Please confirm your password.' }
  }
  if (password !== confirmation) {
    return { valid: false, code: 'mismatch', message: 'Passwords do not match.' }
  }
  return { valid: true, code: 'ok', message: '' }
}

// ---------------------------------------------------------------------------
// Auth error mapping
// ---------------------------------------------------------------------------

/**
 * Classifies a Supabase auth error into a structured result.
 * Returns a stable code, a safe user-readable message, the affected field(s),
 * and whether the error is field-level or form-level.
 *
 * Changing the `message` text never breaks field targeting -- callers read `fields`,
 * not message strings.
 *
 * @param {Error|{message?: string, status?: number}|string|null|undefined} err
 * @returns {{ code: string, message: string, fields: string[], level: 'field'|'form' }}
 *   codes: 'ok' | 'invalid_credentials' | 'email_not_confirmed' | 'user_exists' |
 *          'invalid_email' | 'password_too_short' | 'rate_limited' |
 *          'network_error' | 'expired_link' | 'unknown'
 *   fields: subset of ['email', 'password', 'confirm'] -- empty means form-level
 */
export function classifyAuthError(err) {
  if (!err) return { code: 'ok', message: '', fields: [], level: 'form' }

  const raw = typeof err === 'string'
    ? err.toLowerCase()
    : (err.message ?? '').toLowerCase()
  const status = typeof err === 'object' ? (err.status ?? err.statusCode ?? 0) : 0

  if (raw.includes('invalid login credentials') || raw.includes('invalid password') || raw.includes('wrong password')) {
    return { code: 'invalid_credentials', message: 'Incorrect email or password.', fields: [], level: 'form' }
  }
  if (raw.includes('email not confirmed')) {
    return { code: 'email_not_confirmed', message: 'Confirm your email before signing in. Check your inbox and spam folder.', fields: [], level: 'form' }
  }
  if (raw.includes('user already registered') || raw.includes('already registered')) {
    return { code: 'user_exists', message: 'An account with this email already exists. Sign in instead.', fields: ['email'], level: 'field' }
  }
  if ((raw.includes('invalid email') || raw.includes('unable to validate email')) && !raw.includes('confirmed')) {
    return { code: 'invalid_email', message: 'Enter a valid email address.', fields: ['email'], level: 'field' }
  }
  if (raw.includes('password should be at least') || raw.includes('weak password') || raw.includes('password is too short')) {
    return { code: 'password_too_short', message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`, fields: ['password'], level: 'field' }
  }
  if (raw.includes('for security purposes') || raw.includes('rate limit') || raw.includes('too many requests') || status === 429) {
    return { code: 'rate_limited', message: 'Too many attempts. Wait a moment and try again.', fields: [], level: 'form' }
  }
  if (raw.includes('failed to fetch') || raw.includes('network') || raw.includes('unable to connect') || raw.includes('networkerror')) {
    return { code: 'network_error', message: 'Network error. Check your connection and try again.', fields: [], level: 'form' }
  }
  if (raw.includes('expired') || raw.includes('link is invalid') || raw.includes('token has expired') || raw.includes('invalid recovery')) {
    return { code: 'expired_link', message: 'This link has expired. Request a new one from the sign-in page.', fields: [], level: 'form' }
  }
  return { code: 'unknown', message: 'Something went wrong. Please try again.', fields: [], level: 'form' }
}

/**
 * Maps a Supabase auth error to a safe, user-readable message.
 * Thin wrapper around classifyAuthError -- use classifyAuthError directly when
 * field-level attribution or the error code is needed.
 * @param {Error|{message?: string, status?: number}|string|null|undefined} err
 * @returns {string}
 */
export function mapAuthError(err) {
  return classifyAuthError(err).message
}

/**
 * Converts a validate* result (validatePassword, validatePasswordConfirmation, validateEmail)
 * to a structured auth error shape for use alongside classifyAuthError results.
 * Returns null when the validation passed.
 * @param {{ valid: boolean, code: string, message: string }|null} result
 * @param {string|null} [field] - 'email' | 'password' | 'confirm' | null for form-level
 * @returns {{ code: string, message: string, fields: string[], level: 'field'|'form' }|null}
 */
export function validationToError(result, field) {
  if (!result || result.valid) return null
  const fields = field ? [field] : []
  return { code: result.code, message: result.message, fields, level: fields.length ? 'field' : 'form' }
}

// ---------------------------------------------------------------------------
// Redirect URL construction
// ---------------------------------------------------------------------------

/**
 * Strips a single trailing slash from an origin string.
 * Prevents double-slash in redirect URLs when origin already ends with '/'.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'string') return ''
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

/**
 * Builds the email-confirmation redirect URL from a trusted origin.
 * The caller is responsible for supplying the correct origin — for production
 * this is the canonical app origin defined in the caller (never in this module);
 * for development it is the current browser origin, also supplied by the caller.
 * Never derive the origin from user-supplied query parameters or route state.
 * @param {string} origin - trusted app origin (no trailing slash required)
 * @returns {string}
 */
export function buildWelcomeRedirectUrl(origin) {
  return normalizeOrigin(origin) + '/welcome'
}

/**
 * Builds the password-reset redirect URL from a trusted origin.
 * Same origin rules as buildWelcomeRedirectUrl.
 * @param {string} origin - trusted app origin (no trailing slash required)
 * @returns {string}
 */
export function buildResetRedirectUrl(origin) {
  return normalizeOrigin(origin) + '/reset-password'
}

// ---------------------------------------------------------------------------
// Resend cooldown (expiry-timestamp approach)
// ---------------------------------------------------------------------------

/**
 * Computes the expiry timestamp for a resend cooldown.
 * Store this instead of a decrementing counter so background tabs remain accurate.
 * @param {number} nowMs - Date.now() when the resend was triggered
 * @param {number} [seconds] - cooldown duration (default: RESEND_COOLDOWN_SECONDS)
 * @returns {number} timestamp (ms) when the cooldown expires
 */
export function resendCooldownExpiry(nowMs, seconds = RESEND_COOLDOWN_SECONDS) {
  return nowMs + seconds * 1000
}

/**
 * Computes remaining cooldown seconds from an expiry timestamp.
 * Clamped to >= 0 -- never returns a negative value.
 * @param {number|null|undefined} expiresAtMs
 * @param {number} nowMs - current time (Date.now())
 * @returns {number} whole seconds remaining (min 0)
 */
export function resendCooldownRemaining(expiresAtMs, nowMs) {
  if (!expiresAtMs || !nowMs) return 0
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000))
}

// ---------------------------------------------------------------------------
// Route-state parsing
// ---------------------------------------------------------------------------

/**
 * Reads the one-time password-reset success flag from React Router location state.
 * Returns true only when the flag is explicitly boolean true.
 * Validates shape before trusting the value.
 * @param {any} locationState - location.state from useLocation()
 * @returns {boolean}
 */
export function parseResetSuccessState(locationState) {
  return locationState != null && locationState.passwordReset === true
}

// ---------------------------------------------------------------------------
// Post-auth destination validation
// ---------------------------------------------------------------------------

/**
 * Validates a proposed post-sign-in destination.
 * Rejects: external URLs, protocol-relative URLs, javascript:/data: schemes,
 * auth loop paths (signin, signup, welcome, reset-password), and non-string values.
 * Falls back to '/' for any rejected input.
 * @param {any} candidate
 * @returns {string}
 */
export function safeSignInDestination(candidate) {
  if (!candidate || typeof candidate !== 'string') return '/'
  // Must start with '/' but NOT '//' (protocol-relative)
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/'
  // No dangerous schemes (defense in depth -- these cannot start with '/' normally)
  if (/^javascript:|^data:/i.test(candidate)) return '/'
  // Extract path without query/hash for loop detection
  const path = candidate.split('?')[0].split('#')[0]
  if (AUTH_LOOP_PATHS.has(path)) return '/'
  return candidate
}

// ---------------------------------------------------------------------------
// Field-level error attribution
// ---------------------------------------------------------------------------

/**
 * Converts a structured fields array (from classifyAuthError or validationToError)
 * into the { email?, password?, confirm? } shape used by aria-invalid wiring.
 *
 * Accepts the `fields` array from a classified error result -- never parses
 * rendered message strings. Copy changes can never break field targeting.
 *
 * @param {string[]|null|undefined} fields - e.g. ['email'] or [] for form-level
 * @returns {{ email?: true, password?: true, confirm?: true }}
 */
export function getInvalidFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return {}
  const out = {}
  for (const f of fields) {
    if (f === 'email') out.email = true
    if (f === 'password') out.password = true
    if (f === 'confirm' || f === 'confirmPassword') out.confirm = true
  }
  return out
}

// ---------------------------------------------------------------------------
// Submission eligibility
// ---------------------------------------------------------------------------

/**
 * Returns true when all sign-in fields are filled and submission is not in progress.
 */
export function isSignInEligible(emailRaw, password, submitting) {
  return !submitting && normalizeEmail(emailRaw).length > 0 && String(password ?? '').length > 0
}

/**
 * Returns true when all sign-up fields are filled and submission is not in progress.
 */
export function isSignUpEligible(emailRaw, password, confirm, submitting) {
  return !submitting
    && normalizeEmail(emailRaw).length > 0
    && String(password ?? '').length > 0
    && String(confirm ?? '').length > 0
}

/**
 * Returns true when the email field is filled and submission is not in progress.
 */
export function isResetRequestEligible(emailRaw, submitting) {
  return !submitting && normalizeEmail(emailRaw).length > 0
}

/**
 * Returns true when both password fields meet requirements and submission is not in progress.
 */
export function isPasswordUpdateEligible(pw, conf, submitting) {
  const p = String(pw ?? '')
  return !submitting && p.length >= PASSWORD_MIN_LENGTH && p === String(conf ?? '')
}

// ---------------------------------------------------------------------------
// Response classifiers
// ---------------------------------------------------------------------------

/**
 * Classifies a Supabase signInWithPassword response.
 * Returns a discriminated union via the `outcome` field.
 *
 * @param {{ user: object|null, session: object|null }|null|undefined} data
 * @param {Error|{message?: string}|null|undefined} error
 * @returns {{
 *   outcome: 'authenticated'|'no_session'|'missing_user'|'malformed'|'error',
 *   authError: {code:string,message:string,fields:string[],level:string}|null,
 *   session: object|null,
 *   user: object|null
 * }}
 */
export function classifySignInResult(data, error) {
  if (error) {
    return { outcome: 'error', authError: classifyAuthError(error), session: null, user: null }
  }
  if (!data || typeof data !== 'object') {
    return { outcome: 'malformed', authError: null, session: null, user: null }
  }
  if (!data.user) {
    return { outcome: 'missing_user', authError: null, session: null, user: null }
  }
  if (!data.session || typeof data.session !== 'object') {
    return { outcome: 'no_session', authError: null, session: null, user: data.user }
  }
  return { outcome: 'authenticated', authError: null, session: data.session, user: data.user }
}

/**
 * Classifies a Supabase signUp response.
 * Returns a discriminated union via the `outcome` field.
 *
 * @param {{ user: object|null, session: object|null }|null|undefined} data
 * @param {Error|{message?: string}|null|undefined} error
 * @returns {{
 *   outcome: 'confirmation_required'|'authenticated'|'malformed'|'error',
 *   authError: {code:string,message:string,fields:string[],level:string}|null,
 *   user: object|null,
 *   session: object|null
 * }}
 */
export function classifySignUpResult(data, error) {
  if (error) {
    return { outcome: 'error', authError: classifyAuthError(error), user: null, session: null }
  }
  if (!data || typeof data !== 'object' || !data.user) {
    return { outcome: 'malformed', authError: null, user: null, session: null }
  }
  if (data.session && typeof data.session === 'object') {
    return { outcome: 'authenticated', authError: null, user: data.user, session: data.session }
  }
  return { outcome: 'confirmation_required', authError: null, user: data.user, session: null }
}

// ---------------------------------------------------------------------------
// Trusted origin validation
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes a trusted application origin.
 * An origin must be an HTTP or HTTPS URL with no path (beyond /), no search, no fragment.
 * Uses the WHATWG URL constructor (available in Node.js ≥10 and all modern browsers).
 *
 * The caller supplies the origin — this module never reads browser globals.
 *
 * @param {any} raw - candidate origin string
 * @returns {{ valid: boolean, origin: string }}
 *   valid: true when the string is a proper HTTP/HTTPS origin
 *   origin: canonical form (no trailing slash) when valid; '' otherwise
 *
 * Valid:   'https://www.example.com'   → { valid:true,  origin:'https://www.example.com' }
 *          'https://www.example.com/'  → { valid:true,  origin:'https://www.example.com' }
 *          'http://localhost:5173'     → { valid:true,  origin:'http://localhost:5173'   }
 * Invalid: null, '', 'example.com' (no scheme), 'https://x.com/path',
 *          'https://x.com?q=1', 'javascript:x', non-strings
 */
export function validateOrigin(raw) {
  if (!raw || typeof raw !== 'string') return { valid: false, origin: '' }
  const trimmed = raw.trim()
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return { valid: false, origin: '' }
  }
  try {
    const url = new URL(trimmed)
    // Reject query strings, fragments, or paths beyond the bare root
    if (url.search || url.hash) return { valid: false, origin: '' }
    if (url.pathname !== '/' && url.pathname !== '') return { valid: false, origin: '' }
    // url.origin is the canonical form: scheme + host + port, never with a trailing slash
    return { valid: true, origin: url.origin }
  } catch {
    return { valid: false, origin: '' }
  }
}

// ---------------------------------------------------------------------------
// Response classifiers — updateUser and resend
// ---------------------------------------------------------------------------

/**
 * Classifies an updateUser() response.
 * The caller receives `{ data: { user }, error }` from the updateUser auth call.
 *
 * @param {{ user: object|null }|null|undefined} data
 * @param {Error|{message?: string}|null|undefined} error
 * @returns {{
 *   outcome: 'success'|'explicit_error'|'missing_user'|'malformed',
 *   authError: {code:string,message:string,fields:string[],level:string}|null,
 *   user: object|null
 * }}
 */
export function classifyPasswordUpdateResult(data, error) {
  if (error) {
    return { outcome: 'explicit_error', authError: classifyAuthError(error), user: null }
  }
  if (!data || typeof data !== 'object') {
    return { outcome: 'malformed', authError: null, user: null }
  }
  if (!data.user) {
    return { outcome: 'missing_user', authError: null, user: null }
  }
  return { outcome: 'success', authError: null, user: data.user }
}

/**
 * Classifies a Supabase auth.resend() response.
 *
 * @param {Error|{message?: string}|null|undefined} error
 * @returns {{ outcome: 'sent'|'error', authError: {code:string,message:string,fields:string[],level:string}|null }}
 */
export function classifyResendResult(error) {
  if (!error) return { outcome: 'sent', authError: null }
  return { outcome: 'error', authError: classifyAuthError(error) }
}

// ---------------------------------------------------------------------------
// Recovery auth-event classifier
// ---------------------------------------------------------------------------

/**
 * Classifies a Supabase onAuthStateChange event in the context of the
 * password-recovery page.
 *
 * Only PASSWORD_RECOVERY qualifies the user to see the password update form.
 * SIGNED_IN, SIGNED_OUT, and INITIAL_SESSION without a session are not recovery events.
 * All other events (TOKEN_REFRESHED, USER_UPDATED, INITIAL_SESSION with an existing
 * session) do not change the current page state.
 *
 * @param {string} event - the auth state change event string from Supabase
 * @param {object|null} session - the session from the same event
 * @returns {{ state: 'recovery'|'no_session'|'ordinary_session'|'unchanged' }}
 */
export function classifyRecoveryAuthEvent(event, session) {
  if (event === 'PASSWORD_RECOVERY') return { state: 'recovery' }
  if (event === 'SIGNED_OUT') return { state: 'no_session' }
  if (event === 'SIGNED_IN') return { state: 'ordinary_session' }
  if (event === 'INITIAL_SESSION' && !session) return { state: 'no_session' }
  // TOKEN_REFRESHED, USER_UPDATED, INITIAL_SESSION with an existing non-recovery
  // session: leave the current page state unchanged.
  return { state: 'unchanged' }
}

// ---------------------------------------------------------------------------
// Stale-request protection
// ---------------------------------------------------------------------------

let _tokenCounter = 0

/**
 * Creates a unique integer token for stale-request detection.
 * Capture the token at the start of an async operation, then compare
 * after each await to detect whether a newer submission has overtaken it.
 * The specific value is intentionally opaque -- only equality matters.
 * @returns {number}
 */
export function createSubmitToken() {
  return ++_tokenCounter
}
