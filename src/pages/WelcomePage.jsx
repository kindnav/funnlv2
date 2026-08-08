import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { identifyUser, track } from '../lib/analytics'
import { getProAccessStatus } from '../lib/pro-access-status'
import { FUNNEL_PATH } from '../components/AuthShell'

function WelcomePage() {
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = useState(false)
  // null = loading, true = trial active, false = not active, 'error' = status unavailable
  const [trialDisplay, setTrialDisplay] = useState(null)

  // Fire email_confirmed once per browser per user -- fires only when Supabase has
  // verified the session and the email_confirmed_at timestamp is set.
  // localStorage prevents re-fires on refresh or repeat visits.
  // No PII in event properties; identifyUser() links the event to the PostHog person.
  //
  // Trial activation sequence:
  //   1. Call start_my_pro_trial() as an idempotent reconciliation step. The primary
  //      activation path is the on_email_confirmed DB trigger. This RPC covers the
  //      case where a confirmed user's eligible row still has started_at IS NULL
  //      (e.g., trigger did not fire due to transient infrastructure issues).
  //      We await it so its write completes before we read status, but we never use
  //      its started_now field to drive UI or analytics.
  //   2. Call getProAccessStatus() for the server-authoritative state (DB clock, not browser).
  //   3. Show the trial banner when the server confirms trial_active = true.
  //   4. Fire pro_trial_started with localStorage deduplication (best-effort, not exact-once).
  //      A second-device visit to /welcome may fire the event again on that device, but
  //      PostHog deduplicates by distinct_id in funnel views.
  useEffect(() => {
    async function maybeTrackEmailConfirmed() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.user?.email_confirmed_at) {
          setTrialDisplay('error')
          return
        }
        const userId = session.user.id

        // Email confirmed analytics (once per browser)
        if (!localStorage.getItem('funnl_confirmed_' + userId)) {
          identifyUser(userId, session.user.email)
          track('email_confirmed')
          localStorage.setItem('funnl_confirmed_' + userId, '1')
        }

        // Recovery mechanism: call start_my_pro_trial() for confirmed users whose
        // eligible pro_trials row still has started_at IS NULL (e.g., if the
        // on_email_confirmed trigger did not fire due to transient infrastructure
        // issues). This call is idempotent (WHERE started_at IS NULL guard) and
        // only updates existing rows -- it does not create missing rows or extend
        // existing trials. Failure is swallowed; getProAccessStatus() is authoritative.
        try {
          await supabase.rpc('start_my_pro_trial')
        } catch {
          // Recovery failure is acceptable -- primary trigger may have already fired
        }

        // Server-authoritative status (DB clock, not browser Date)
        const status = await getProAccessStatus()
        if (!status) {
          setTrialDisplay('error')
          return
        }

        const trialIsActive = status.trial_active === true
        setTrialDisplay(trialIsActive)

        // pro_trial_started: fire once per browser per user (best-effort dedup).
        // Keyed separately from email_confirmed so they can be independently tracked.
        if (trialIsActive && !localStorage.getItem('funnl_trial_started_' + userId)) {
          track('pro_trial_started')
          localStorage.setItem('funnl_trial_started_' + userId, '1')
        }
      } catch {
        // Any unhandled failure must not block the welcome page
        setTrialDisplay('error')
      }
    }
    maybeTrackEmailConfirmed()
  }, [])

  async function handleContinue() {
    setSigningOut(true)
    // Sign out first -- confirmation links auto-create a session; clear it so /signin renders
    // in the unauthenticated route tree. signOut() clears local storage regardless of server error.
    const { error } = await supabase.auth.signOut()
    if (error) console.error('Sign-out on welcome failed:', error.message)
    navigate('/signin')
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ backgroundColor: '#F7F2E7', colorScheme: 'light' }}
    >
      <div className="w-full max-w-[400px] text-center">

        {/* Ember logo mark */}
        <div
          className="w-[52px] h-[52px] rounded-[14px] bg-ember flex items-center justify-center mx-auto mb-8"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d={FUNNEL_PATH} fill="white"/>
          </svg>
        </div>

        {/* Success icon */}
        <div
          className="w-[72px] h-[72px] rounded-full flex items-center justify-center mx-auto mb-6"
          style={{
            backgroundColor: 'rgba(46,125,91,0.1)',
            border: '1.5px solid rgba(46,125,91,0.3)',
          }}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#2E7D5B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
        </div>

        {/* Heading -- period is intentional (spec) */}
        <h1 className="font-display font-bold text-[28px] tracking-[-0.5px] mb-3" style={{ color: '#1C1510' }}>
          You're all set.
        </h1>

        {/* Body */}
        <p className="text-[15px] leading-relaxed mb-4" style={{ color: '#6B5A4A' }}>
          Your email is confirmed.<br/>You can sign in now.
        </p>

        {/* Trial notice -- server-authoritative, loading skeleton skipped (brief) */}
        {trialDisplay === true && (
          <div
            className="flex items-center gap-2 rounded-xl px-4 py-3 mb-6 text-left"
            style={{
              backgroundColor: 'rgba(255,68,35,0.08)',
              border: '1.5px solid rgba(255,68,35,0.25)',
            }}
            role="status"
            aria-live="polite"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="#FF4423" className="flex-none" aria-hidden="true">
              <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
            </svg>
            <p className="text-[13px] font-medium leading-snug" style={{ color: '#CC3000' }}>
              Your 7-day Funnl Pro trial has started -- explore AI features after signing in.
            </p>
          </div>
        )}

        {/* Status unavailable -- neutral fallback, never shows false success */}
        {trialDisplay === 'error' && (
          <div
            className="rounded-xl px-4 py-3 mb-6 text-left"
            style={{
              backgroundColor: 'rgba(0,0,0,0.04)',
              border: '1.5px solid rgba(0,0,0,0.1)',
            }}
          >
            <p className="text-[13px] leading-snug" style={{ color: '#8C857A' }}>
              Account confirmed. Pro trial status will refresh after you sign in.
            </p>
          </div>
        )}

        {/* Primary CTA -- Ember, flat, no gradient */}
        <button
          onClick={handleContinue}
          disabled={signingOut}
          className="w-full bg-ember hover:bg-ember-hover text-white text-[15px] font-bold rounded-[12px] py-[14px] transition-colors motion-reduce:transition-none disabled:opacity-50 disabled:cursor-not-allowed"
          aria-busy={signingOut}
        >
          {signingOut ? 'Signing out...' : 'Continue to sign in'}
        </button>

      </div>
    </div>
  )
}

export default WelcomePage
