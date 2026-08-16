// Non-functional "Funnl Pro — Coming Soon" state shown wherever a paid upgrade
// would eventually appear (Settings Pro Access, the locked Funnl AI screen).
// It is a disabled control by construction — it has no onClick and cannot start
// any checkout, billing, or payment flow. There is no Stripe/checkout code on
// main; this is purely informational UI.
//
// size: 'sm' matches the Settings copy sizing; 'md' matches the Funnl AI screen.

export default function ProComingSoon({ size = 'sm' }) {
  const sizeCls = size === 'md'
    ? 'text-[13px] px-5 py-[10px] rounded-[10px]'
    : 'text-[12px] px-4 py-[9px] rounded-[9px]'

  return (
    <div>
      <button
        type="button"
        disabled
        aria-disabled="true"
        className={`inline-block font-bold text-mid bg-elevated border border-line-2 cursor-not-allowed ${sizeCls}`}
      >
        Funnl Pro — Coming Soon
      </button>
      <p className="text-[10.5px] text-low mt-2">Paid plans are not available yet.</p>
    </div>
  )
}
