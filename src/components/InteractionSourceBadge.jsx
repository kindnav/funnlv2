import { getSourceProvider } from '../lib/interactionSource'

// Small, secondary provenance badge shown ONLY for interactions/suggestions that came
// from a recognized source provider (currently just Google Calendar). Manual and any
// unknown source render nothing, so a hand-logged interaction never shows a badge.
//
// The interaction's own type label/icon (Coffee chat, Email, ...) stays primary; this
// badge only communicates ORIGIN and is styled to sit visually below the type and
// Funnl's own UI (muted, small, bordered chip).
//
// TEMPORARY ICON — the glyph below is an original, neutral calendar mark bundled inline
// (no emoji, no remote hotlink). It is NOT the official Google Calendar product icon and
// does not imitate Google's colors or visual identity. It may be replaced ONLY with
// authorized official Google Calendar artwork obtained and used per Google's brand
// guidelines; until then the neutral glyph plus the explicit "Google Calendar" text
// communicates the source without implying endorsement.
//
// Provider-aware: presentation comes from getSourceProvider(source); adding gmail/outlook
// later means adding a registry entry (interactionSource.js) and a glyph case below.

function SourceGlyph({ source }) {
  if (source === 'google_calendar') {
    return (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M3.5 9.5H20.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 3.25V6.5M16 3.25V6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }
  return null
}

export default function InteractionSourceBadge({ source, className = '' }) {
  const provider = getSourceProvider(source)
  if (!provider) return null
  return (
    <span
      className={`inline-flex items-center gap-[4px] flex-none font-mono text-[9.5px] font-semibold px-[7px] py-[3px] rounded-full bg-elevated text-muted border border-line-1 ${className}`}
      title={provider.title}
      aria-label={provider.ariaLabel}
      data-source={provider.key}
    >
      <SourceGlyph source={source} />
      <span>{provider.label}</span>
    </span>
  )
}
