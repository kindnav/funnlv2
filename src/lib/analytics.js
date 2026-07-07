import posthog from 'posthog-js'

export function initAnalytics() {
  posthog.init(import.meta.env.VITE_POSTHOG_KEY, {
    api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
    capture_pageview: true,
    capture_pageleave: true,
    // Disable autocapture — we only track the specific events defined in this file.
    // This keeps analytics focused and avoids a firehose of every DOM click.
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
