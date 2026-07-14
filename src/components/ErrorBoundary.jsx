import { Component } from 'react'
import { supabase } from '../lib/supabase'
import { trackError } from '../lib/analytics'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, signingOut: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error) {
    // componentStack is excluded — it contains the component hierarchy and
    // source locations, which are not needed for crash diagnosis and are
    // omitted to minimize diagnostic data sent to PostHog.
    trackError(error)
  }

  async handleSignOut() {
    this.setState({ signingOut: true })
    try {
      await supabase.auth.signOut()
    } catch {
      // Full navigation below resets the application even if remote sign-out fails.
    } finally {
      window.location.assign('/signin')
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const { signingOut } = this.state

    return (
      <div role="alert" className="min-h-screen bg-base flex items-center justify-center p-6">
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-8 max-w-sm w-full text-center">
          <div className="w-12 h-12 rounded-full bg-[rgba(255,107,138,0.12)] flex items-center justify-center mx-auto mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/>
              <path d="M12 8v4"/>
              <path d="M12 16h.01"/>
            </svg>
          </div>
          <h2 className="font-display font-bold text-[20px] text-hi mb-2">Something went wrong</h2>
          <p className="text-[14px] text-muted leading-relaxed mb-6">
            Funnl hit an unexpected error. Reload the page to try again.
          </p>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full py-2.5 rounded-xl bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-semibold"
            >
              Reload Funnl
            </button>
            <button
              type="button"
              disabled={signingOut}
              onClick={() => this.handleSignOut()}
              className="w-full py-2.5 rounded-xl bg-elevated border border-[rgba(255,255,255,0.07)] text-mid text-[14px] font-medium hover:text-hi transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
