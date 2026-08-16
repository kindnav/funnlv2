// Non-functional "Funnl Pro — Coming Soon" state shown at every Subscribe entry
// point while billing is disabled (BILLING_ENABLED === false). It is a disabled
// control by construction — it has no onClick and can never invoke checkout. The
// fully reviewed Subscribe button is rendered instead only when billing is enabled.
//
// size: 'sm' matches the Settings CTA sizing; 'md' matches the Funnl AI locked CTA.

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
