import { useState } from 'react'
import { supabase } from '../lib/supabase'

const envelopeIcon = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 shrink-0 text-indigo-500">
    <path d="M2.94 6.94A2 2 0 0 1 4 6h12a2 2 0 0 1 1.06.94L10 12.5 2.94 6.94ZM2 8.6V14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.6l-7.4 5.55a1 1 0 0 1-1.2 0L2 8.6Z" />
  </svg>
)

const lockIcon = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 shrink-0 text-gray-500">
    <path fillRule="evenodd" d="M10 1a4 4 0 0 0-4 4v2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V5a4 4 0 0 0-4-4Zm2 6V5a2 2 0 1 0-4 0v2h4Z" clipRule="evenodd" />
  </svg>
)

function SignInPage() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup' | 'pending'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function switchMode(newMode) {
    setMode(newMode)
    setEmail('')
    setPassword('')
    setConfirmPassword('')
    setError('')
  }

  async function handleSignIn(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) setError(error.message)
  }

  async function handleSignUp(e) {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }

    setLoading(true)
    const { error } = await supabase.auth.signUp({ email, password })
    setLoading(false)

    if (error) {
      setError(error.message)
      return
    }

    setMode('pending')
  }

  const rightPanel = (
    <div className="hidden w-1/2 flex-col justify-end bg-gradient-to-br from-neutral-700 via-neutral-900 to-black p-16 lg:flex">
      <p className="text-3xl font-light text-white">Your networking, organized.</p>
    </div>
  )

  // Confirmation-pending screen — shown after a successful sign-up
  if (mode === 'pending') {
    return (
      <div className="flex min-h-screen">
        <div className="flex w-full flex-col justify-center bg-black px-10 lg:w-1/2">
          <div className="mx-auto w-full max-w-sm">
            <p className="mb-12 text-xl font-semibold text-white">Funnl</p>
            <h1 className="mb-4 text-3xl font-bold text-white">Check your email</h1>
            <p className="mb-2 leading-relaxed text-gray-300">
              We sent a confirmation link to{' '}
              <span className="font-medium text-white">{email}</span>.
            </p>
            <p className="mb-8 leading-relaxed text-gray-400">
              Click the link in that email to verify your account, then come back here and sign in with your email and password.
            </p>
            <p className="mb-8 text-sm text-gray-500">
              Didn't receive it? Check your spam folder, or{' '}
              <button
                onClick={() => switchMode('signup')}
                className="text-indigo-400 underline hover:text-indigo-300"
              >
                try signing up again
              </button>
              .
            </p>
            <button
              onClick={() => switchMode('signin')}
              className="w-full rounded-md bg-indigo-600 py-3 text-sm font-semibold uppercase tracking-wide text-white transition hover:bg-indigo-500"
            >
              Back to Sign In
            </button>
          </div>
        </div>
        {rightPanel}
      </div>
    )
  }

  return (
    <div className="flex min-h-screen">
      <div className="flex w-full flex-col justify-center bg-black px-10 lg:w-1/2">
        <div className="mx-auto w-full max-w-sm">
          <p className="mb-12 text-xl font-semibold text-white">Funnl</p>
          <h1 className="mb-8 text-4xl font-bold text-white">
            {mode === 'signin' ? 'Sign In' : 'Create Account'}
          </h1>

          {mode === 'signin' ? (
            <form onSubmit={handleSignIn} className="space-y-6">
              <div>
                <label htmlFor="email" className="mb-2 block text-sm font-medium text-white">Email</label>
                <div className="flex items-center gap-2 rounded-md border border-gray-600 bg-black px-3 py-3 focus-within:border-indigo-500">
                  {envelopeIcon}
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                    className="w-full bg-transparent text-white placeholder-gray-500 outline-none"
                    placeholder="you@example.com"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-300">Password</label>
                <div className="flex items-center gap-2 rounded-md border border-gray-700 bg-black px-3 py-3 focus-within:border-indigo-500">
                  {lockIcon}
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full bg-transparent text-white placeholder-gray-500 outline-none"
                    placeholder="Enter Password"
                  />
                </div>
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md bg-indigo-600 py-3 text-sm font-semibold uppercase tracking-wide text-white transition hover:bg-indigo-500 disabled:opacity-50"
              >
                {loading ? 'Signing In...' : 'Sign In'}
              </button>

              <p className="text-center text-sm text-gray-500">
                Don't have an account?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('signup')}
                  className="text-indigo-400 hover:text-indigo-300"
                >
                  Create one
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={handleSignUp} className="space-y-6">
              <div>
                <label htmlFor="signup-email" className="mb-2 block text-sm font-medium text-white">Email</label>
                <div className="flex items-center gap-2 rounded-md border border-gray-600 bg-black px-3 py-3 focus-within:border-indigo-500">
                  {envelopeIcon}
                  <input
                    id="signup-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                    className="w-full bg-transparent text-white placeholder-gray-500 outline-none"
                    placeholder="you@university.edu"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="signup-password" className="mb-2 block text-sm font-medium text-gray-300">Password</label>
                <div className="flex items-center gap-2 rounded-md border border-gray-700 bg-black px-3 py-3 focus-within:border-indigo-500">
                  {lockIcon}
                  <input
                    id="signup-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full bg-transparent text-white placeholder-gray-500 outline-none"
                    placeholder="At least 6 characters"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="confirm-password" className="mb-2 block text-sm font-medium text-gray-300">Confirm Password</label>
                <div className="flex items-center gap-2 rounded-md border border-gray-700 bg-black px-3 py-3 focus-within:border-indigo-500">
                  {lockIcon}
                  <input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className="w-full bg-transparent text-white placeholder-gray-500 outline-none"
                    placeholder="Re-enter your password"
                  />
                </div>
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md bg-indigo-600 py-3 text-sm font-semibold uppercase tracking-wide text-white transition hover:bg-indigo-500 disabled:opacity-50"
              >
                {loading ? 'Creating Account...' : 'Create Account'}
              </button>

              <p className="text-center text-sm text-gray-500">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('signin')}
                  className="text-indigo-400 hover:text-indigo-300"
                >
                  Sign in
                </button>
              </p>
            </form>
          )}
        </div>
      </div>
      {rightPanel}
    </div>
  )
}

export default SignInPage
