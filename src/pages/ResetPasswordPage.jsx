import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  classifyAuthError,
  classifyPasswordUpdateResult,
  classifyRecoveryAuthEvent,
  validationToError,
  validatePassword,
  validatePasswordConfirmation,
  PASSWORD_MIN_LENGTH,
} from '../lib/authHelpers'
import { FUNNEL_PATH } from '../components/AuthShell'

const inputCls = [
  'flex-1 min-w-0 bg-transparent text-[14px] text-[#1C1510] placeholder-[#B0A898] outline-none',
].join(' ')

const labelCls = 'block text-[13px] font-semibold text-[#4A3C2E] mb-2'

function LockIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8C857A" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
      <rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>
    </svg>
  )
}

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

function ResetPasswordPage() {
  const navigate = useNavigate()
  const mountedRef = useRef(true)
  // updateTokenRef: stale-request protection for the password-update flow.
  // Each handleUpdatePassword invocation increments this. After every await,
  // we compare the captured token against the ref to detect if a second update
  // started (or the route changed) while the first was in flight.
  const updateTokenRef = useRef(0)
  const [pageState, setPageState] = useState('loading') // 'loading' | 'form' | 'no-session'
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // null = no error; object = { code, message, fields, level } from classifyAuthError/validationToError
  const [error, setError] = useState(null)

  useEffect(() => {
    mountedRef.current = true

    // classifyRecoveryAuthEvent determines which auth events qualify as a real recovery
    // session. Only PASSWORD_RECOVERY may open the form. SIGNED_IN (an ordinary
    // authenticated session, e.g., the user visits /reset-password while logged in) and
    // SIGNED_OUT both result in the no-session state. Other events (TOKEN_REFRESHED,
    // USER_UPDATED, INITIAL_SESSION with an existing session) leave the page state alone.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mountedRef.current) return
      const classified = classifyRecoveryAuthEvent(event, session)
      if (classified.state === 'recovery') setPageState('form')
      else if (classified.state === 'no_session' || classified.state === 'ordinary_session') setPageState('no-session')
      // 'unchanged': do not modify the current page state
    })

    // Fast path: if there is no session at all, show no-session immediately without
    // waiting for an auth event. If a session exists, do NOT infer recovery from it —
    // an ordinary session at /reset-password is not a recovery session. The auth event
    // listener above will classify it correctly via PASSWORD_RECOVERY (recovery link) or
    // SIGNED_IN (ordinary session → no-session).
    supabase.auth.getSession().then(({ data }) => {
      if (!mountedRef.current) return
      if (!data.session) setPageState('no-session')
      // Session present: wait for classifyRecoveryAuthEvent to classify the event type.
    })

    return () => {
      mountedRef.current = false
      subscription.unsubscribe()
    }
  }, [])

  async function handleUpdatePassword(e) {
    e.preventDefault()
    if (submitting) return
    setError(null)

    // Client-side validation -- validationToError produces the same structured shape
    // as classifyAuthError so all rendering treats validation and server errors identically.
    const pwError = validationToError(validatePassword(newPassword), 'password')
    if (pwError) { setError(pwError); return }
    const cfError = validationToError(validatePasswordConfirmation(newPassword, confirmPassword), 'confirm')
    if (cfError) { setError(cfError); return }

    setSubmitting(true)
    // Capture the operation token before the first await. If a second update is
    // submitted (e.g., the user double-clicks, or submits from two tabs), the token
    // will be stale and the first update will silently discard its result.
    const token = ++updateTokenRef.current

    const { data, error: updateError } = await supabase.auth.updateUser({ password: newPassword })

    if (!mountedRef.current || token !== updateTokenRef.current) return

    const updateResult = classifyPasswordUpdateResult(data, updateError)
    if (updateResult.outcome !== 'success') {
      // Keep the form open, keep recovery state valid, show a safe structured error.
      // Do not sign out and do not navigate on failure.
      setError(updateResult.authError ?? classifyAuthError(null))
      setSubmitting(false)
      return
    }

    // Password update confirmed. Sign out to clear the recovery session so the user
    // lands in the unauthenticated route tree when navigating to /signin.
    //
    // Sign-out failure recovery: if sign-out fails, we navigate anyway. The password
    // has already been changed server-side and cannot be rolled back. The user must
    // sign in with their new password. Leaving them on /reset-password with a stale
    // recovery session would be confusing and could allow resubmission.
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) {
      console.error('[Funnl] Sign-out after password update failed — navigating anyway:', signOutError.message)
    }

    if (!mountedRef.current || token !== updateTokenRef.current) return
    // replace: true so Back does not return the user to /reset-password with a spent
    // recovery token. The passwordReset flag is consumed by SignInPage exactly once.
    navigate('/signin', { replace: true, state: { passwordReset: true } })
  }

  const errorId = error?.message ? 'rp-form-error' : undefined

  // Shared logo mark (Paper theme, Ember color)
  const logoMark = (
    <div
      className="w-[52px] h-[52px] rounded-[14px] bg-ember flex items-center justify-center mx-auto mb-8"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d={FUNNEL_PATH} fill="white"/>
      </svg>
    </div>
  )

  // ── Loading ──────────────────────────────────────────────────────────────
  if (pageState === 'loading') {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: '#F7F2E7', colorScheme: 'light' }}
      >
        <p className="text-[14px]" style={{ color: '#8C857A' }}>Loading...</p>
      </div>
    )
  }

  // ── Expired / no recovery session ────────────────────────────────────────
  if (pageState === 'no-session') {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-6"
        style={{ backgroundColor: '#F7F2E7', colorScheme: 'light' }}
      >
        <div className="w-full max-w-[400px] text-center">
          {logoMark}
          <div
            className="w-[72px] h-[72px] rounded-full flex items-center justify-center mx-auto mb-6"
            style={{
              backgroundColor: 'rgba(194,51,77,0.08)',
              border: '1.5px solid rgba(194,51,77,0.2)',
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#C2334D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
            </svg>
          </div>
          <h1 className="font-display font-bold text-[24px] tracking-[-0.3px] mb-3" style={{ color: '#1C1510' }}>
            Link expired
          </h1>
          <p className="text-[14.5px] leading-relaxed mb-8" style={{ color: '#6B5A4A' }}>
            This reset link has already been used or has expired. Request a new one from the sign-in page.
          </p>
          <button
            type="button"
            onClick={() => navigate('/signin')}
            className="w-full bg-ember hover:bg-ember-hover text-white text-[15px] font-bold rounded-[12px] py-[14px] transition-colors motion-reduce:transition-none"
          >
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  // ── New password form ─────────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ backgroundColor: '#F7F2E7', colorScheme: 'light' }}
    >
      <div className="w-full max-w-[400px]">
        {logoMark}
        <h1 className="font-display font-bold text-[28px] tracking-[-0.5px] mb-2 text-center" style={{ color: '#1C1510' }}>
          Set a new password
        </h1>
        <p className="text-[14.5px] text-center mb-8" style={{ color: '#6B5A4A' }}>
          Choose a strong password -- at least {PASSWORD_MIN_LENGTH} characters.
        </p>

        {/* Form-level error live region */}
        {error?.message && (
          <div
            id="rp-form-error"
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2.5 mb-5 rounded-xl px-4 py-3"
            style={{
              backgroundColor: 'rgba(194,51,77,0.07)',
              border: '1.5px solid rgba(194,51,77,0.25)',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C2334D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="flex-none mt-0.5" aria-hidden="true">
              <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
            </svg>
            <p className="text-[13.5px] font-medium" style={{ color: '#C2334D' }}>{error.message}</p>
          </div>
        )}

        <form onSubmit={handleUpdatePassword} noValidate className="space-y-5" aria-label="Set new password">
          <div>
            <label htmlFor="rp-new-password" className={labelCls}>
              New password
              <span className="font-normal ml-1" style={{ color: '#8C857A' }}>
                -- at least {PASSWORD_MIN_LENGTH} characters
              </span>
            </label>
            <FieldWrapper hasError={!!(error?.fields?.includes('password'))}>
              <LockIcon/>
              <input
                id="rp-new-password"
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                required
                autoFocus
                autoComplete="new-password"
                className={inputCls}
                placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
                aria-invalid={error?.fields?.includes('password') ? 'true' : undefined}
                aria-describedby={errorId}
              />
            </FieldWrapper>
          </div>

          <div>
            <label htmlFor="rp-confirm-password" className={labelCls}>
              Confirm new password
            </label>
            <FieldWrapper hasError={!!(error?.fields?.includes('confirm'))}>
              <LockIcon/>
              <input
                id="rp-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                className={inputCls}
                placeholder="Re-enter your new password"
                aria-invalid={error?.fields?.includes('confirm') ? 'true' : undefined}
                aria-describedby={errorId}
              />
            </FieldWrapper>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-ember hover:bg-ember-hover text-white text-[15px] font-bold rounded-[12px] py-[14px] transition-colors motion-reduce:transition-none disabled:opacity-50 disabled:cursor-not-allowed"
            aria-busy={submitting}
          >
            {submitting ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default ResetPasswordPage
