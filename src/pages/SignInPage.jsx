import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { identifyUser, track } from '../lib/analytics'
import AuthShell, { FUNNEL_PATH } from '../components/AuthShell'
import {
  buildWelcomeRedirectUrl,
  buildResetRedirectUrl,
  parseResetSuccessState,
  resendCooldownExpiry,
  resendCooldownRemaining,
  createSubmitToken,
  normalizeEmail,
  normalizeOrigin,
  validateOrigin,
  validatePassword,
  validatePasswordConfirmation,
  validationToError,
  classifyAuthError,
  classifySignInResult,
  classifySignUpResult,
  classifyResendResult,
  getInvalidFields,
  safeSignInDestination,
  PASSWORD_MIN_LENGTH,
} from '../lib/authHelpers'

// ---------------------------------------------------------------------------
// Trusted origin resolution (computed once at module load)
// ---------------------------------------------------------------------------
// Architecture:
//   1. Read VITE_APP_ORIGIN (optional build-time env var). If present and valid,
//      use it — this supports deployments where the redirect domain differs from
//      the serving origin (e.g. a CNAME alias).
//   2. Otherwise fall back to window.location.origin, which is always correct for
//      localhost, Vercel preview URLs, and production without any hardcoding.
//
// Never: query parameters, route state, form values, or hardcoded domain strings.

function resolveAppOrigin() {
  const configured = import.meta.env.VITE_APP_ORIGIN
  if (configured) {
    const result = validateOrigin(configured)
    if (result.valid) return result.origin
    // Misconfigured VITE_APP_ORIGIN: fall through and warn.
    console.warn('[Funnl] VITE_APP_ORIGIN is set but not a valid HTTP/HTTPS origin:', configured)
  }
  // Use the current browser origin. normalizeOrigin strips any trailing slash.
  return normalizeOrigin(window.location.origin)
}

const APP_ORIGIN        = resolveAppOrigin()
const welcomeRedirectUrl = buildWelcomeRedirectUrl(APP_ORIGIN)
const resetRedirectUrl   = buildResetRedirectUrl(APP_ORIGIN)

// ---------------------------------------------------------------------------
// Input field wrapper -- Paper theme (always light, never adapts to dark mode)
// ---------------------------------------------------------------------------

function FieldWrapper({ children, hasError }) {
  const border = hasError
    ? 'border-[#C2334D] focus-within:border-[#C2334D] focus-within:shadow-[0_0_0_3px_rgba(194,51,77,0.12)]'
    : 'border-[#DDD5C8] focus-within:border-[rgba(255,68,35,0.5)] focus-within:shadow-[0_0_0_3px_rgba(255,68,35,0.10)]'
  return (
    <div className={`flex items-center gap-[10px] rounded-xl border bg-white px-[14px] py-[13px] transition-[border-color,box-shadow] motion-reduce:transition-none ${border}`}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Icon helpers (Paper theme -- no purple)
// ---------------------------------------------------------------------------

function EnvelopeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8C857A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8C857A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
      <rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>
    </svg>
  )
}

// Shared class strings for Paper inputs and labels
const inputCls = 'flex-1 min-w-0 bg-transparent text-[14px] text-[#1C1510] placeholder-[#B0A898] outline-none'
const labelCls = 'block text-[13px] font-semibold text-[#4A3C2E] mb-2'

// Ember primary button (flat, no gradient, no glow)
const btnPrimary = 'w-full bg-ember hover:bg-ember-hover text-white text-[15px] font-bold py-[14px] rounded-xl transition-colors motion-reduce:transition-none disabled:opacity-50 disabled:cursor-not-allowed'
const btnSecondary = 'w-full bg-[#EDE9E2] hover:bg-[#E3DDD5] text-[#1C1510] text-[15px] font-bold py-[14px] rounded-xl transition-colors motion-reduce:transition-none disabled:opacity-50 disabled:cursor-not-allowed'

// ---------------------------------------------------------------------------
// SignInPage
// ---------------------------------------------------------------------------

function SignInPage() {
  const location = useLocation()
  const navigate  = useNavigate()
  const mountedRef = useRef(true)

  // Stale-request protection: each async handler captures a token at start and compares
  // it after every await. switchMode() invalidates the current token so in-flight
  // requests from the previous mode cannot mutate state in the new mode.
  const currentOperationRef = useRef(0)

  // 'signin' | 'signup' | 'pending' | 'forgot' | 'reset-sent'
  const [mode, setMode] = useState(location.pathname === '/signup' ? 'signup' : 'signin')

  const [email,           setEmail]           = useState('')
  const [password,        setPassword]        = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  // null = no error; object = { code, message, fields, level } from classifyAuthError/validationToError
  const [error,           setError]           = useState(null)
  const [loading,         setLoading]         = useState(false)
  const [resendLoading,   setResendLoading]   = useState(false)

  // Expiry-timestamp approach for cooldown (more accurate than decrement-only state
  // across background tabs).
  const [resendExpiresAt, setResendExpiresAt] = useState(null)
  const resendTimerRef = useRef(null)
  const [cooldownRemaining, setCooldownRemaining] = useState(0)

  const [resendStatus, setResendStatus] = useState('idle') // 'idle' | 'sent' | 'error'
  const [resendError,  setResendError]  = useState('')

  // Captured once on mount via lazy initializer -- parseResetSuccessState validates shape.
  // Cleared from history state immediately in a mount-only effect so refresh and Back
  // do not re-show the banner.
  const [showResetBanner] = useState(() => parseResetSuccessState(location.state))

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Clear reset-success route state after reading it once.
  // Replace-navigation removes the state so the banner never re-appears on refresh or Back.
  useEffect(() => {
    if (showResetBanner) {
      navigate(location.pathname, { replace: true, state: {} })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // mount-only -- location.pathname and showResetBanner are stable at first render

  // Keep mode in sync when React Router reuses this component without remounting.
  useEffect(() => {
    const p = location.pathname
    if (p === '/signup' && mode !== 'signup' && mode !== 'pending' && mode !== 'forgot' && mode !== 'reset-sent') {
      setMode('signup')
    } else if (p === '/signin' && mode !== 'signin' && mode !== 'pending' && mode !== 'forgot' && mode !== 'reset-sent') {
      setMode('signin')
    }
  }, [location.pathname, mode])

  // Fire once per arrival at signup mode (mount at /signup OR navigation from /signin).
  useEffect(() => {
    if (mode === 'signup') track('signup_started')
  }, [mode])

  // Cooldown tick -- updates cooldownRemaining every second while an expiry is active.
  useEffect(() => {
    if (!resendExpiresAt) {
      setCooldownRemaining(0)
      return
    }
    function tick() {
      const remaining = resendCooldownRemaining(resendExpiresAt, Date.now())
      if (!mountedRef.current) return
      setCooldownRemaining(remaining)
      if (remaining <= 0) {
        clearInterval(resendTimerRef.current)
        resendTimerRef.current = null
        setResendExpiresAt(null)
      }
    }
    tick()
    resendTimerRef.current = setInterval(tick, 1000)
    return () => {
      clearInterval(resendTimerRef.current)
      resendTimerRef.current = null
    }
  }, [resendExpiresAt])

  function startResendCooldown() {
    setResendExpiresAt(resendCooldownExpiry(Date.now()))
  }

  // Switches mode and clears all form state.
  // Invalidates any in-flight async operation so its resolved value cannot
  // mutate state that now belongs to the new mode.
  function switchMode(newMode) {
    currentOperationRef.current = createSubmitToken()
    setLoading(false)
    setResendLoading(false)
    setMode(newMode)
    setEmail('')
    setPassword('')
    setConfirmPassword('')
    setError(null)
    setResendStatus('idle')
    setResendError('')
    setResendExpiresAt(null)
    setCooldownRemaining(0)
    clearInterval(resendTimerRef.current)
    resendTimerRef.current = null
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  async function handleSignIn(e) {
    e.preventDefault()
    if (loading) return
    setError(null)
    setLoading(true)
    const token = createSubmitToken()
    currentOperationRef.current = token

    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email: normalizeEmail(email),
      password,
    })

    if (!mountedRef.current || token !== currentOperationRef.current) return
    setLoading(false)

    const result = classifySignInResult(data, authError)
    if (result.outcome !== 'authenticated') {
      setError(result.authError ?? classifyAuthError(null))
      return
    }
    try {
      if (result.user) identifyUser(result.user.id, result.user.email)
      track('user_signed_in')
    } catch {
      // Analytics must never block sign-in.
    }
    if (!mountedRef.current || token !== currentOperationRef.current) return
    // Use the actual intended destination the user was heading to before being redirected
    // to sign in. App.jsx stores it in location.state.from via the unauthenticated wildcard.
    navigate(safeSignInDestination(location.state?.from), { replace: true })
  }

  async function handleSignUp(e) {
    e.preventDefault()
    if (loading) return
    setError(null)

    // Client-side validation before the server call.
    // validationToError produces the same { code, message, fields, level } shape as
    // classifyAuthError so all callers treat validation and server errors identically.
    const pwError = validationToError(validatePassword(password), 'password')
    if (pwError) { setError(pwError); return }
    const cfError = validationToError(validatePasswordConfirmation(password, confirmPassword), 'confirm')
    if (cfError) { setError(cfError); return }

    setLoading(true)
    const token = createSubmitToken()
    currentOperationRef.current = token

    const { data, error: authError } = await supabase.auth.signUp({
      email: normalizeEmail(email),
      password,
      options: { emailRedirectTo: welcomeRedirectUrl },
    })

    if (!mountedRef.current || token !== currentOperationRef.current) return
    setLoading(false)

    const result = classifySignUpResult(data, authError)
    if (result.outcome === 'error' || result.outcome === 'malformed') {
      setError(result.authError ?? classifyAuthError(null))
      return
    }
    if (!mountedRef.current || token !== currentOperationRef.current) return
    track('user_signed_up')
    // Clear passwords from memory before entering pending state.
    // Pending context holds only the normalized email (displayed for confirmation).
    setPassword('')
    setConfirmPassword('')
    startResendCooldown()
    setMode('pending')
  }

  async function handleForgotPassword(e) {
    e.preventDefault()
    if (loading) return
    setError(null)
    setLoading(true)
    const token = createSubmitToken()
    currentOperationRef.current = token

    const { error: authError } = await supabase.auth.resetPasswordForEmail(
      normalizeEmail(email),
      { redirectTo: resetRedirectUrl }
    )

    if (!mountedRef.current || token !== currentOperationRef.current) return
    setLoading(false)

    if (authError) {
      const classified = classifyAuthError(authError)
      // Only surface errors where retrying with the same email cannot help.
      // For rate-limiting or network failures the user must act before retrying.
      // For unknown accounts (and all other codes) we still show the success state
      // to avoid revealing whether an address is registered (anti-enumeration).
      if (classified.code === 'rate_limited' || classified.code === 'network_error') {
        setError(classified)
        return
      }
    }
    if (!mountedRef.current || token !== currentOperationRef.current) return
    setMode('reset-sent')
  }

  async function handleResend() {
    if (resendLoading || cooldownRemaining > 0) return
    // Guard: resend requires a valid pending email (set during sign-up).
    const pendingEmail = normalizeEmail(email)
    if (!pendingEmail) return
    setResendLoading(true)
    setResendStatus('idle')
    setResendError('')
    const token = createSubmitToken()
    currentOperationRef.current = token

    try {
      const { error: resendErr } = await supabase.auth.resend({
        type: 'signup',
        email: pendingEmail,
        options: { emailRedirectTo: welcomeRedirectUrl },
      })
      if (!mountedRef.current || token !== currentOperationRef.current) return
      // Additional guards after await:
      // - mode must still be 'pending' (switchMode() updates currentOperationRef, so
      //   the token check above already covers mode switches; this is a redundant
      //   defense against any code path that changes mode without updating the token)
      // - the pending email must still match what was submitted (prevents a stale
      //   resend from claiming a different address's slot)
      if (mode !== 'pending' || normalizeEmail(email) !== pendingEmail) return

      const result = classifyResendResult(resendErr)
      if (result.outcome === 'error') {
        setResendStatus('error')
        setResendError(result.authError.message)
        return
      }
      setResendStatus('sent')
      startResendCooldown()
    } catch (ex) {
      if (!mountedRef.current || token !== currentOperationRef.current) return
      const result = classifyResendResult(ex)
      setResendStatus('error')
      setResendError(result.authError.message)
    } finally {
      // Only clear loading if this operation is still the current one.
      if (mountedRef.current && token === currentOperationRef.current) {
        setResendLoading(false)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Logo lockup (used in all modes at top of form panel)
  // No glow shadow -- the funnel mark never uses box-shadow.
  // ---------------------------------------------------------------------------

  const logoLockup = (
    <div className="flex items-center gap-[10px] mb-12">
      <div className="w-[34px] h-[34px] rounded-[9px] bg-ember flex items-center justify-center flex-none">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d={FUNNEL_PATH} fill="white"/>
        </svg>
      </div>
      <span className="font-display font-bold text-[21px] text-[#1C1510] tracking-[-0.4px]">Funnl</span>
    </div>
  )

  // ---------------------------------------------------------------------------
  // Pending confirmation
  // ---------------------------------------------------------------------------

  if (mode === 'pending') {
    const resendDisabled = resendLoading || cooldownRemaining > 0
    return (
      <AuthShell>
        {logoLockup}

        <div className="w-12 h-12 rounded-[14px] bg-[rgba(255,68,35,0.1)] flex items-center justify-center mb-5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FF4423" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
          </svg>
        </div>

        <h1 className="font-display text-[30px] font-bold text-[#1C1510] mb-3 tracking-[-0.4px]">
          Check your email
        </h1>
        <p className="text-[15px] leading-relaxed text-[#6B5A4A] mb-2">
          We sent a confirmation link to{' '}
          <span className="font-semibold text-[#1C1510]">{email}</span>.
        </p>
        <p className="text-[15px] leading-relaxed text-[#6B5A4A] mb-8">
          Click that link to verify your account. Check your spam or promotions folder if you don't see it within a few minutes.
        </p>

        <div className="mb-6">
          <button
            type="button"
            onClick={handleResend}
            disabled={resendDisabled}
            className="w-full py-3 rounded-xl border border-[#DDD5C8] bg-white text-[14px] font-semibold text-[#6B5A4A] hover:text-[#1C1510] hover:border-[#C8BFB5] transition-colors motion-reduce:transition-none disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={cooldownRemaining > 0 ? `Resend available in ${cooldownRemaining} seconds` : 'Resend confirmation email'}
          >
            {resendLoading
              ? 'Sending...'
              : cooldownRemaining > 0
                ? `Resend in ${cooldownRemaining}s`
                : 'Resend confirmation email'}
          </button>

          {/* Live region for resend status -- polite so screen readers announce after button response */}
          <div aria-live="polite" aria-atomic="true">
            {resendStatus === 'sent' && (
              <p className="mt-3 text-[13px] text-[#2E7D5B] font-medium text-center">
                Sent -- check your inbox and spam folder.
              </p>
            )}
            {resendStatus === 'error' && (
              <p role="alert" className="mt-3 text-[13px] text-[#C2334D] text-center">
                {resendError}
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => { switchMode('signin'); navigate('/signin') }}
          className={btnPrimary}
        >
          Back to sign in
        </button>
      </AuthShell>
    )
  }

  // ---------------------------------------------------------------------------
  // Reset link sent
  // ---------------------------------------------------------------------------

  if (mode === 'reset-sent') {
    return (
      <AuthShell>
        {logoLockup}

        <h1 className="font-display text-[30px] font-bold text-[#1C1510] mb-3 tracking-[-0.4px]">
          Check your email
        </h1>
        <p className="text-[15px] leading-relaxed text-[#6B5A4A] mb-2">
          If an account exists for that email, a reset link has been sent.
        </p>
        <p className="text-[15px] leading-relaxed text-[#6B5A4A] mb-3">
          Click the link in the email to set a new password, then come back and sign in.
        </p>
        <p className="text-[13px] text-[#8C857A] mb-8">
          Didn't receive it? Check your spam folder, or{' '}
          <button
            onClick={() => switchMode('forgot')}
            className="text-[#FF4423] underline hover:text-[#D6330F] transition-colors motion-reduce:transition-none"
          >
            try again
          </button>.
        </p>
        <button
          type="button"
          onClick={() => { switchMode('signin'); navigate('/signin') }}
          className={btnPrimary}
        >
          Back to sign in
        </button>
      </AuthShell>
    )
  }

  // ---------------------------------------------------------------------------
  // Sign in / Sign up / Forgot password
  // ---------------------------------------------------------------------------

  const isSignInMode  = mode === 'signin'
  const isSignUpMode  = mode === 'signup'
  const isForgotMode  = mode === 'forgot'

  // Derive field-level aria-invalid from the structured error's fields array.
  // getInvalidFields(fields) never parses message strings -- copy changes cannot break targeting.
  const invalidFields = getInvalidFields(error?.fields ?? [])

  // aria-describedby linkage
  const errorId = error?.message ? 'auth-form-error' : undefined

  return (
    <AuthShell>
      {logoLockup}

      {/* Password-reset success banner -- consumed once on mount, never re-shown on refresh */}
      {isSignInMode && showResetBanner && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 mb-6 rounded-xl border border-[rgba(46,125,91,0.3)] bg-[rgba(46,125,91,0.08)] px-4 py-3"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2E7D5B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          <p className="text-[13.5px] text-[#2E7D5B] font-medium">
            Password updated. Sign in with your new password.
          </p>
        </div>
      )}

      {/* Page heading */}
      <h1 className="font-display text-[32px] font-bold text-[#1C1510] tracking-[-0.5px] mb-2">
        {isSignInMode ? 'Welcome back.' : isSignUpMode ? 'Create account' : 'Reset your password'}
      </h1>

      {/* Supporting copy */}
      {isSignInMode && (
        <p className="text-[15px] text-[#6B5A4A] mb-8">
          Sign in to pick up where your network left off.
        </p>
      )}
      {isSignUpMode && (
        <p className="text-[15px] text-[#6B5A4A] mb-8">
          Start turning networking conversations into follow-ups that lead somewhere.
        </p>
      )}
      {isForgotMode && (
        <p className="text-[15px] text-[#6B5A4A] mb-8">
          Enter your email and we'll send you a reset link.
        </p>
      )}

      {/* Form-level error live region */}
      {error?.message && (
        <div
          id="auth-form-error"
          role="alert"
          aria-live="assertive"
          className="flex items-start gap-2.5 mb-5 rounded-xl border border-[rgba(194,51,77,0.25)] bg-[rgba(194,51,77,0.07)] px-4 py-3"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C2334D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="flex-none mt-0.5" aria-hidden="true">
            <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
          </svg>
          <p className="text-[13.5px] text-[#C2334D] font-medium">{error.message}</p>
        </div>
      )}

      {/* Sign in form */}
      {isSignInMode && (
        <form onSubmit={handleSignIn} noValidate className="space-y-5" aria-label="Sign in">
          <div>
            <label htmlFor="si-email" className={labelCls}>Email</label>
            <FieldWrapper hasError={!!invalidFields.email}>
              <EnvelopeIcon/>
              <input
                id="si-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="email"
                inputMode="email"
                className={inputCls}
                placeholder="alex@university.edu"
                aria-invalid={invalidFields.email ? 'true' : undefined}
                aria-describedby={errorId}
              />
            </FieldWrapper>
          </div>
          <div>
            <label htmlFor="si-password" className={labelCls}>Password</label>
            <FieldWrapper hasError={!!invalidFields.password}>
              <LockIcon/>
              <input
                id="si-password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className={inputCls}
                placeholder="Enter password"
                aria-invalid={invalidFields.password ? 'true' : undefined}
                aria-describedby={errorId}
              />
            </FieldWrapper>
            <button
              type="button"
              onClick={() => switchMode('forgot')}
              className="mt-2 text-[12.5px] text-[#8C857A] hover:text-[#FF4423] transition-colors motion-reduce:transition-none"
            >
              Forgot password?
            </button>
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`${btnPrimary} mt-1`}
            aria-busy={loading}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>

          <p className="text-center text-[13.5px] text-[#8C857A] pt-1">
            Don't have an account?{' '}
            <button
              type="button"
              onClick={() => { switchMode('signup'); navigate('/signup') }}
              className="text-[#FF4423] font-semibold hover:text-[#D6330F] transition-colors motion-reduce:transition-none"
            >
              Create one
            </button>
          </p>
        </form>
      )}

      {/* Sign up form */}
      {isSignUpMode && (
        <form onSubmit={handleSignUp} noValidate className="space-y-5" aria-label="Create account">
          <div>
            <label htmlFor="su-email" className={labelCls}>Email</label>
            <FieldWrapper hasError={!!invalidFields.email}>
              <EnvelopeIcon/>
              <input
                id="su-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="email"
                inputMode="email"
                className={inputCls}
                placeholder="you@university.edu"
                aria-invalid={invalidFields.email ? 'true' : undefined}
                aria-describedby={errorId}
              />
            </FieldWrapper>
          </div>
          <div>
            <label htmlFor="su-password" className={labelCls}>
              Password
              <span className="font-normal text-[#8C857A] ml-1">-- at least {PASSWORD_MIN_LENGTH} characters</span>
            </label>
            <FieldWrapper hasError={!!invalidFields.password}>
              <LockIcon/>
              <input
                id="su-password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                className={inputCls}
                placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
                aria-invalid={invalidFields.password ? 'true' : undefined}
                aria-describedby={errorId}
              />
            </FieldWrapper>
          </div>
          <div>
            <label htmlFor="su-confirm" className={labelCls}>Confirm password</label>
            <FieldWrapper hasError={!!invalidFields.confirm}>
              <LockIcon/>
              <input
                id="su-confirm"
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                className={inputCls}
                placeholder="Re-enter your password"
                aria-invalid={invalidFields.confirm ? 'true' : undefined}
                aria-describedby={errorId}
              />
            </FieldWrapper>
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`${btnPrimary} mt-1`}
            aria-busy={loading}
          >
            {loading ? 'Creating account...' : 'Create account'}
          </button>

          <p className="text-center text-[13.5px] text-[#8C857A] pt-1">
            Already have an account?{' '}
            <button
              type="button"
              onClick={() => { switchMode('signin'); navigate('/signin') }}
              className="text-[#FF4423] font-semibold hover:text-[#D6330F] transition-colors motion-reduce:transition-none"
            >
              Sign in
            </button>
          </p>
        </form>
      )}

      {/* Forgot password form */}
      {isForgotMode && (
        <form onSubmit={handleForgotPassword} noValidate className="space-y-5" aria-label="Reset password">
          <div>
            <label htmlFor="fp-email" className={labelCls}>Email</label>
            <FieldWrapper hasError={!!invalidFields.email}>
              <EnvelopeIcon/>
              <input
                id="fp-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="email"
                inputMode="email"
                className={inputCls}
                placeholder="alex@university.edu"
                aria-invalid={invalidFields.email ? 'true' : undefined}
                aria-describedby={errorId}
              />
            </FieldWrapper>
          </div>

          <button
            type="submit"
            disabled={loading}
            className={btnPrimary}
            aria-busy={loading}
          >
            {loading ? 'Sending...' : 'Send reset link'}
          </button>

          <p className="text-center text-[13.5px] text-[#8C857A] pt-1">
            <button
              type="button"
              onClick={() => { switchMode('signin'); navigate('/signin') }}
              className="text-[#FF4423] font-semibold hover:text-[#D6330F] transition-colors motion-reduce:transition-none"
            >
              Back to sign in
            </button>
          </p>
        </form>
      )}

      {/* Privacy link -- bottom of form area */}
      <p className="text-center text-[12px] text-[#8C857A] mt-8">
        <Link to="/privacy" className="hover:text-[#6B5A4A] transition-colors motion-reduce:transition-none no-underline">
          Privacy Policy
        </Link>
      </p>
    </AuthShell>
  )
}

export default SignInPage
