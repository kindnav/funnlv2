import posthog from 'posthog-js'

export function initAnalytics() {
  const key  = import.meta.env.VITE_POSTHOG_KEY
  const host = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com'

  if (!key) {
    console.warn('[Funnl analytics] VITE_POSTHOG_KEY is not set — analytics will not run')
    return
  }

  posthog.init(key, {
    api_host: host,
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false,
    person_profiles: 'identified_only',
  })
}

// Call after sign-in. Links all subsequent events to this user in PostHog.
// Only the Supabase user ID and email are sent — never contact content.
export function identifyUser(userId, email) {
  posthog.identify(userId, { email })
}

// Fire a custom event. Properties must be non-sensitive metadata only —
// never names, companies, notes, emails, or any user-typed contact content.
export function track(event, properties = {}) {
  posthog.capture(event, properties)
}

// Call on sign-out. Clears PostHog's identity cookie so the next
// sign-in starts a fresh anonymous session rather than merging with the old one.
export function resetAnalytics() {
  posthog.reset()
}

// Report an unhandled render error to PostHog Error Tracking.
// componentStack is excluded — it contains the component hierarchy and source
// locations, which are not needed for crash diagnosis and are omitted to
// minimize diagnostic data. Never pass contact names, notes, companies,
// route state, Supabase data, or other user content.
// Explicitly no-ops when VITE_POSTHOG_KEY is absent.
export function trackError(error) {
  if (!import.meta.env.VITE_POSTHOG_KEY) return
  try {
    posthog.captureException(error)
  } catch {
    // Error reporting must never break the fallback.
  }
}
