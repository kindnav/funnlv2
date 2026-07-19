import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { identifyUser, track } from '../lib/analytics'

// Redirect URLs: www subdomain in production, current origin in local dev.
// import.meta.env.PROD is true in Vite production builds, false in dev server.
const welcomeRedirectUrl = import.meta.env.PROD
  ? 'https://www.getfunnl.com/welcome'
  : `${window.location.origin}/welcome`

const resetRedirectUrl = import.meta.env.PROD
  ? 'https://www.getfunnl.com/reset-password'
  : `${window.location.origin}/reset-password`

// Must be outside SignInPage to avoid remount on every keystroke
function InputWrapper({ children }) {
  return (
    <div className="flex items-center gap-[10px] rounded-xl border border-[rgba(255,255,255,0.09)] bg-input px-[14px] py-[13px] focus-within:border-[rgba(139,124,255,0.5)] focus-within:shadow-[0_0_0_3px_rgba(108,92,255,0.12)] transition-[border-color,box-shadow] duration-150">
      {children}
    </div>
  )
}

function SignInPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [mode, setMode] = useState(location.pathname === '/signup' ? 'signup' : 'signin') // 'signin' | 'signup' | 'pending' | 'forgot' | 'reset-sent'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [resendLoading, setResendLoading] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendStatus, setResendStatus] = useState('idle') // 'idle' | 'sent' | 'error'
  const [resendError, setResendError] = useState('')
  const resendTimerRef = useRef(null)

  // Captured once on mount — shows after arriving from /reset-password
  const [showResetBanner] = useState(!!location.state?.passwordReset)

  // Keep form in sync if React Router reuses this component without remounting.
  // mode is in deps because the guards read it; the guards prevent resets during pending/forgot/reset-sent.
  useEffect(() => {
    if (location.pathname === '/signup' && mode !== 'signup' && mode !== 'pending' && mode !== 'forgot' && mode !== 'reset-sent') {
      setMode('signup')
    } else if (location.pathname === '/signin' && mode !== 'signin' && mode !== 'pending' && mode !== 'forgot' && mode !== 'reset-sent') {
      setMode('signin')
    }
  }, [location.pathname, mode])

  // Fire once per arrival at signup mode: on initial mount at /signup AND on /signin → /signup navigation.
  useEffect(() => {
    if (mode === 'signup') track('signup_started')
  }, [mode])

  // Clean up the resend countdown timer on unmount.
  useEffect(() => {
    return () => { if (resendTimerRef.current) clearInterval(resendTimerRef.current) }
  }, [])

  function startResendCooldown() {
    if (resendTimerRef.current) clearInterval(resendTimerRef.current)
    setResendCooldown(60)
    resendTimerRef.current = setInterval(() => {
      setResendCooldown(prev => {
        if (prev <= 1) {
          clearInterval(resendTimerRef.current)
          resendTimerRef.current = null
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  function switchMode(newMode) {
    setMode(newMode)
    setEmail('')
    setPassword('')
    setConfirmPassword('')
    setError('')
    setResendStatus('idle')
    setResendError('')
    setResendCooldown(0)
    if (resendTimerRef.current) {
      clearInterval(resendTimerRef.current)
      resendTimerRef.current = null
    }
  }

  async function handleSignIn(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) { setError(error.message); return }
    try {
      if (data.user) identifyUser(data.user.id, data.user.email)
      track('user_signed_in')
    } catch {
      // Analytics must never block sign-in.
    }
    navigate('/', { replace: true })
  }

  async function handleSignUp(e) {
    e.preventDefault()
    setError('')
    if (password !== confirmPassword) { setError('Passwords do not match.'); return }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return }
    setLoading(true)
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: welcomeRedirectUrl },
    })
    setLoading(false)
    if (error) { setError(error.message); return }
    track('user_signed_up')
    startResendCooldown()
    setMode('pending')
  }

  async function handleForgotPassword(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: resetRedirectUrl,
    })
    setLoading(false)
    if (error) { setError(error.message); return }
    setMode('reset-sent')
  }

  async function handleResend() {
    if (resendLoading || resendCooldown > 0) return

    setResendLoading(true)
    setResendStatus('idle')
    setResendError('')

    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: welcomeRedirectUrl },
      })

      if (error) {
        setResendStatus('error')
        setResendError('Something went wrong. Please try again.')
        return
      }

      setResendStatus('sent')
      startResendCooldown()
    } catch {
      setResendStatus('error')
      setResendError('Something went wrong. Please try again.')
    } finally {
      setResendLoading(false)
    }
  }

  // ── Shared pieces ──────────────────────────────────────────────────────────

  const logoTileSmall = (
    <div className="w-[36px] h-[36px] rounded-[10px] bg-[#4B3AF0] flex items-center justify-center shadow-[0_4px_14px_rgba(75,58,240,0.4)] flex-none">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="white"/>
      </svg>
    </div>
  )

  const envelopeIcon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
      <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
    </svg>
  )

  const lockIcon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6C6C78" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
      <rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>
    </svg>
  )

  const inputCls = 'flex-1 bg-transparent text-[14px] text-hi placeholder-[#54545E] outline-none'
  const labelCls = 'block text-[13px] font-semibold text-[#C7C7D1] mb-2'

  // ── Shared right panel ─────────────────────────────────────────────────────

  const rightPanel = (
    <div
      className="hidden lg:flex w-[520px] flex-col justify-center p-14 relative overflow-hidden"
      style={{ background: 'linear-gradient(150deg,#3A2D66,#1C1633 55%,#100D1E)' }}
    >
      <div className="absolute top-[-80px] right-[-80px] w-[320px] h-[320px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,rgba(139,124,255,0.35),transparent 70%)' }}/>
      <div className="absolute bottom-[-100px] left-[-60px] w-[280px] h-[280px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,rgba(47,212,182,0.16),transparent 70%)' }}/>

      <div className="relative">
        <div className="w-16 h-16 rounded-[18px] bg-[#4B3AF0] flex items-center justify-center shadow-[0_12px_40px_rgba(75,58,240,0.5)] mb-9">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="white"/>
          </svg>
        </div>

        <h3 className="font-display text-[34px] font-bold text-white leading-[1.25] mb-[14px] tracking-[-0.5px]">
          Your networking, organized.
        </h3>
        <p className="text-[15px] leading-[1.6] text-[rgba(255,255,255,0.7)] mb-10 max-w-[380px]">
          Track every contact, coffee chat, and follow-up, and let Funnl AI tell you who to reach next.
        </p>

        <div className="flex flex-col gap-[14px]">
          <div className="flex items-center gap-[14px] bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.08)] rounded-[14px] px-[18px] py-4">
            <div className="w-[38px] h-[38px] rounded-[11px] bg-[rgba(139,124,255,0.22)] flex items-center justify-center flex-none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B4A8FF" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="3"/><path d="M2.5 20c0-3 2.5-5.5 5.5-5.5S13.5 17 13.5 20"/><circle cx="17" cy="9" r="2.4"/><path d="M15 14.6c2.8.3 5 2.6 5 5.4"/>
              </svg>
            </div>
            <div>
              <p className="text-[14px] font-bold text-white">Every contact in one place</p>
              <p className="text-[12.5px] text-[rgba(255,255,255,0.55)]">Recruiters, alumni, and referrals organized by tag.</p>
            </div>
          </div>

          <div className="flex items-center gap-[14px] bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.08)] rounded-[14px] px-[18px] py-4">
            <div className="w-[38px] h-[38px] rounded-[11px] bg-[rgba(47,212,182,0.18)] flex items-center justify-center flex-none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6EE7D6" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>
              </svg>
            </div>
            <div>
              <p className="text-[14px] font-bold text-white">Never miss a follow-up</p>
              <p className="text-[12.5px] text-[rgba(255,255,255,0.55)]">Follow-up dates keep your outreach on track.</p>
            </div>
          </div>

          <div className="flex items-center gap-[14px] bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.08)] rounded-[14px] px-[18px] py-4">
            <div className="w-[38px] h-[38px] rounded-[11px] bg-[rgba(245,166,35,0.18)] flex items-center justify-center flex-none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#FFB84D">
                <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
              </svg>
            </div>
            <div>
              <p className="text-[14px] font-bold text-white">AI-guided outreach</p>
              <p className="text-[12.5px] text-[rgba(255,255,255,0.55)]">Funnl AI drafts messages and suggests who to reach.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  // ── Pending confirmation screen ────────────────────────────────────────────

  if (mode === 'pending') {
    const resendDisabled = resendLoading || resendCooldown > 0
    return (
      <div className="flex min-h-screen">
        <div className="flex flex-1 flex-col justify-center bg-[#0A0A0C] px-6 md:px-[88px]">
          <div className="mx-auto w-full max-w-[400px]">
            <div className="flex items-center gap-[11px] mb-14">
              {logoTileSmall}
              <span className="font-display font-bold text-[23px] text-hi tracking-[-0.5px]">Funnl</span>
            </div>

            <div className="w-14 h-14 rounded-2xl bg-[rgba(139,124,255,0.12)] flex items-center justify-center mb-6">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3 7 9 6 9-6"/>
              </svg>
            </div>

            <h1 className="font-display text-[32px] font-bold text-hi mb-3 tracking-[-0.5px]">Check your email</h1>
            <p className="text-[15px] leading-relaxed text-[#9A9AA5] mb-2">
              We sent a confirmation link to{' '}
              <span className="font-semibold text-hi">{email}</span>.
            </p>
            <p className="text-[15px] leading-relaxed text-[#9A9AA5] mb-8">
              Click that link to verify your account. Check your spam or promotions folder if you don't see it.
            </p>

            <div className="mb-8">
              <button
                type="button"
                onClick={handleResend}
                disabled={resendDisabled}
                className="w-full py-3 rounded-xl border border-[rgba(255,255,255,0.09)] bg-elevated text-[14px] font-semibold text-mid hover:text-hi hover:border-[rgba(139,124,255,0.4)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {resendLoading
                  ? 'Sending…'
                  : resendCooldown > 0
                    ? `Resend in ${resendCooldown}s`
                    : 'Resend confirmation email'}
              </button>

              {resendStatus === 'sent' && (
                <p aria-live="polite" className="mt-2.5 text-[13px] text-success text-center">Sent — check your inbox and spam folder.</p>
              )}
              {resendStatus === 'error' && (
                <p role="alert" className="mt-2.5 text-[13px] text-danger text-center">{resendError}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => switchMode('signin')}
              className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold py-[14px] rounded-xl shadow-[0_8px_22px_rgba(91,69,240,0.4)] hover:opacity-90 transition-opacity"
            >
              Back to Sign In
            </button>
          </div>
        </div>
        {rightPanel}
      </div>
    )
  }

  // ── Reset link sent screen ─────────────────────────────────────────────────

  if (mode === 'reset-sent') {
    return (
      <div className="flex min-h-screen">
        <div className="flex flex-1 flex-col justify-center bg-[#0A0A0C] px-6 md:px-[88px]">
          <div className="mx-auto w-full max-w-[400px]">
            <div className="flex items-center gap-[11px] mb-14">
              {logoTileSmall}
              <span className="font-display font-bold text-[23px] text-hi tracking-[-0.5px]">Funnl</span>
            </div>
            <h1 className="font-display text-[32px] font-bold text-hi mb-3 tracking-[-0.5px]">Check your email</h1>
            <p className="text-[15px] leading-relaxed text-[#9A9AA5] mb-2">
              We sent a password reset link to{' '}
              <span className="font-semibold text-hi">{email}</span>.
            </p>
            <p className="text-[15px] leading-relaxed text-[#9A9AA5] mb-8">
              Click that link to set a new password, then come back here and sign in.
            </p>
            <p className="text-[13.5px] text-[#6C6C78] mb-8">
              Didn't receive it? Check your spam folder, or{' '}
              <button onClick={() => switchMode('forgot')} className="text-accent underline hover:text-tag transition-colors">
                try again
              </button>.
            </p>
            <button
              onClick={() => switchMode('signin')}
              className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold py-[14px] rounded-xl shadow-[0_8px_22px_rgba(91,69,240,0.4)] hover:opacity-90 transition-opacity"
            >
              Back to Sign In
            </button>
          </div>
        </div>
        {rightPanel}
      </div>
    )
  }

  // ── Sign in / Sign up / Forgot password screen ─────────────────────────────

  return (
    <div className="flex min-h-screen">
      <div className="flex flex-1 flex-col justify-center bg-[#0A0A0C] px-6 md:px-[88px]">
        <div className="mx-auto w-full max-w-[400px]">

          {/* Logo lockup */}
          <div className="flex items-center gap-[11px] mb-14">
            {logoTileSmall}
            <span className="font-display font-bold text-[23px] text-hi tracking-[-0.5px]">Funnl</span>
          </div>

          {/* Password reset success banner */}
          {mode === 'signin' && showResetBanner && (
            <div className="flex items-center gap-3 mb-6 rounded-xl border border-[rgba(47,212,182,0.25)] bg-[rgba(47,212,182,0.08)] px-4 py-3">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="flex-none">
                <path d="M20 6L9 17l-5-5"/>
              </svg>
              <p className="text-[13.5px] text-success font-medium">Password updated — sign in with your new password.</p>
            </div>
          )}

          {/* Heading + subtitle */}
          <h1 className="font-display text-[34px] font-bold text-hi tracking-[-0.5px] mb-2">
            {mode === 'signin' ? 'Welcome back' : mode === 'signup' ? 'Create account' : 'Reset your password'}
          </h1>
          {mode === 'signin' && (
            <p className="text-[15px] text-[#9A9AA5] mb-[34px]">Sign in to pick up where your network left off.</p>
          )}
          {mode === 'signup' && (
            <p className="text-[15px] text-[#9A9AA5] mb-[34px]">Start turning networking conversations into follow-ups that lead somewhere.</p>
          )}
          {mode === 'forgot' && (
            <p className="text-[15px] text-[#9A9AA5] mb-[34px]">Enter your email and we'll send you a reset link.</p>
          )}

          {/* Sign-in form */}
          {mode === 'signin' && (
            <form onSubmit={handleSignIn} className="space-y-5">
              <div>
                <label className={labelCls}>Email</label>
                <InputWrapper>
                  {envelopeIcon}
                  <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                    required autoFocus className={inputCls} placeholder="alex@university.edu"/>
                </InputWrapper>
              </div>
              <div>
                <label className={labelCls}>Password</label>
                <InputWrapper>
                  {lockIcon}
                  <input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)}
                    required className={inputCls} placeholder="Enter password"/>
                </InputWrapper>
                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="mt-2 text-[12.5px] text-low hover:text-accent transition-colors"
                >
                  Forgot password?
                </button>
              </div>

              {error && <p className="text-sm text-danger">{error}</p>}

              <button type="submit" disabled={loading}
                className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold py-[14px] rounded-xl shadow-[0_8px_22px_rgba(91,69,240,0.4)] hover:opacity-90 transition-opacity disabled:opacity-50 mt-1">
                {loading ? 'Signing in…' : 'Sign in'}
              </button>

              <p className="text-center text-[13.5px] text-[#6C6C78] pt-2">
                Don't have an account?{' '}
                <button type="button" onClick={() => { switchMode('signup'); navigate('/signup') }} className="text-accent font-semibold hover:text-tag transition-colors">
                  Create one
                </button>
              </p>
            </form>
          )}

          {/* Sign-up form */}
          {mode === 'signup' && (
            <form onSubmit={handleSignUp} className="space-y-5">
              <div>
                <label className={labelCls}>Email</label>
                <InputWrapper>
                  {envelopeIcon}
                  <input id="signup-email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                    required autoFocus className={inputCls} placeholder="you@university.edu"/>
                </InputWrapper>
              </div>
              <div>
                <label className={labelCls}>Password</label>
                <InputWrapper>
                  {lockIcon}
                  <input id="signup-password" type="password" value={password} onChange={e => setPassword(e.target.value)}
                    required className={inputCls} placeholder="At least 6 characters"/>
                </InputWrapper>
              </div>
              <div>
                <label className={labelCls}>Confirm Password</label>
                <InputWrapper>
                  {lockIcon}
                  <input id="confirm-password" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                    required className={inputCls} placeholder="Re-enter your password"/>
                </InputWrapper>
              </div>

              {error && <p className="text-sm text-danger">{error}</p>}

              <button type="submit" disabled={loading}
                className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold py-[14px] rounded-xl shadow-[0_8px_22px_rgba(91,69,240,0.4)] hover:opacity-90 transition-opacity disabled:opacity-50 mt-1">
                {loading ? 'Creating account…' : 'Create account'}
              </button>

              <p className="text-center text-[13.5px] text-[#6C6C78] pt-2">
                Already have an account?{' '}
                <button type="button" onClick={() => { switchMode('signin'); navigate('/signin') }} className="text-accent font-semibold hover:text-tag transition-colors">
                  Sign in
                </button>
              </p>
            </form>
          )}

          {/* Forgot password form */}
          {mode === 'forgot' && (
            <form onSubmit={handleForgotPassword} className="space-y-5">
              <div>
                <label className={labelCls}>Email</label>
                <InputWrapper>
                  {envelopeIcon}
                  <input id="forgot-email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                    required autoFocus className={inputCls} placeholder="alex@university.edu"/>
                </InputWrapper>
              </div>

              {error && <p className="text-sm text-danger">{error}</p>}

              <button type="submit" disabled={loading}
                className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold py-[14px] rounded-xl shadow-[0_8px_22px_rgba(91,69,240,0.4)] hover:opacity-90 transition-opacity disabled:opacity-50">
                {loading ? 'Sending…' : 'Send reset link'}
              </button>

              <p className="text-center text-[13.5px] text-[#6C6C78] pt-2">
                <button type="button" onClick={() => switchMode('signin')} className="text-accent font-semibold hover:text-tag transition-colors">
                  ← Back to sign in
                </button>
              </p>
            </form>
          )}

        </div>

        {/* Privacy policy link */}
        <p className="text-center text-[12px] text-[#4A4A56] mt-6">
          <Link to="/privacy" className="hover:text-[#6C6C78] transition-colors no-underline">Privacy Policy</Link>
        </p>

      </div>
      {rightPanel}
    </div>
  )
}

export default SignInPage
