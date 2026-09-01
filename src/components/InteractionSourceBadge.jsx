// Small, polished source badge shown ONLY for interactions that originated from an
// accepted Google Calendar candidate (source === 'google_calendar'). Manual
// interactions (or any other/unknown source) render nothing, so it never appears on
// interactions a user logged by hand.
//
// The interaction's own type label/icon (Coffee chat, Email, ...) is kept separately —
// this badge describes the ORIGIN, not the interaction type.
//
// Asset note: the small glyph below is an original, generic calendar mark bundled
// inline (no emoji, no remote hotlink, no reproduction of Google's brand logo). The
// "Google Calendar" text carries the attribution, consistent with how
// GoogleConnectionCard already labels the connection. No provider ids, event data,
// fingerprints, tokens, or refs are involved — only the safe coarse origin label.
import { isGoogleCalendarSource } from '../lib/interactionSource'

export default function InteractionSourceBadge({ source, className = '' }) {
  if (!isGoogleCalendarSource(source)) return null
  return (
    <span
      className={`inline-flex items-center gap-[4px] flex-none font-mono text-[9.5px] font-semibold px-[7px] py-[3px] rounded-full bg-elevated text-muted border border-line-1 ${className}`}
      title="Added from Google Calendar"
      aria-label="Source: Google Calendar"
      data-source="google_calendar"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M3.5 9.5H20.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 3.25V6.5M16 3.25V6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span>Google Calendar</span>
    </span>
  )
}
