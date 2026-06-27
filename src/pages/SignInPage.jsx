import { useState } from 'react'
import { supabase } from '../lib/supabase'

function SignInPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    setLoading(false)
    if (error) {
      setError(error.message)
    }
  }

  return (
    <div className="flex min-h-screen">
      <div className="flex w-full flex-col justify-center bg-black px-10 lg:w-1/2">
        <div className="mx-auto w-full max-w-sm">
          <p className="mb-12 text-xl font-semibold text-white">Funnl</p>
          <h1 className="mb-8 text-4xl font-bold text-white">Sign In</h1>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium text-white">
                Email
              </label>
              <div className="flex items-center gap-2 rounded-md border border-gray-600 bg-black px-3 py-3 focus-within:border-indigo-500">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 shrink-0 text-indigo-500">
                  <path d="M2.94 6.94A2 2 0 0 1 4 6h12a2 2 0 0 1 1.06.94L10 12.5 2.94 6.94ZM2 8.6V14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.6l-7.4 5.55a1 1 0 0 1-1.2 0L2 8.6Z" />
                </svg>
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
              <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-300">
                Password
              </label>
              <div className="flex items-center gap-2 rounded-md border border-gray-700 bg-black px-3 py-3 focus-within:border-indigo-500">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 shrink-0 text-gray-500">
                  <path
                    fillRule="evenodd"
                    d="M10 1a4 4 0 0 0-4 4v2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V5a4 4 0 0 0-4-4Zm2 6V5a2 2 0 1 0-4 0v2h4Z"
                    clipRule="evenodd"
                  />
                </svg>
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
          </form>
        </div>
      </div>

      <div className="hidden w-1/2 flex-col justify-end bg-gradient-to-br from-neutral-700 via-neutral-900 to-black p-16 lg:flex">
        <p className="text-3xl font-light text-white">Your networking, organized.</p>
      </div>
    </div>
  )
}

export default SignInPage
