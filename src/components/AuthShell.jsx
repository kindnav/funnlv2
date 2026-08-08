/**
 * AuthShell -- Shared Paper/Ink layout for all Sign In/Sign Up states.
 *
 * Desktop: Paper form panel on the left + Ink brand panel on the right.
 * Narrow viewports: single-column Paper form, brand panel hidden.
 *
 * Colors are brand constants that never change with the user's theme:
 *   Paper (#F7F2E7) -- always light cream
 *   Ink   (#14110F) -- always near-black
 *   Ember (#FF4423) -- always warm orange-red
 *
 * No purple, no violet, no indigo, no gradients, no glow shadows anywhere in this component.
 * Reduced-motion: transitions and animations should use motion-reduce:transition-none /
 * motion-reduce:animate-none. Never use motion-reduce to alter opacity or visibility.
 */

/** Sacred funnel path -- single source of truth for all auth pages. */
export const FUNNEL_PATH = 'M3 4H21L15 12.5V20H9V12.5Z'

function AuthShell({ children }) {
  return (
    <div className="min-h-screen flex" style={{ colorScheme: 'light' }}>

      {/* Paper form panel
          Always cream, never adapts to the user's dark/light theme.
          color-scheme: light ensures browser autofill uses light styling. */}
      <div className="flex-1 flex flex-col justify-center bg-[#F7F2E7] px-6 sm:px-10 lg:px-14 py-12">
        <div className="mx-auto w-full max-w-[420px]">
          {children}
        </div>
      </div>

      {/* Ink brand panel -- hidden on narrow viewports, decorative only */}
      <div
        className="hidden lg:flex flex-col justify-end w-[440px] bg-[#14110F] relative overflow-hidden p-12 pb-14"
        aria-hidden="true"
      >
        {/* Decorative large FUNNL wordmark -- very low contrast, non-interactive.
            "Vertical" treatment: rotated 90 degrees, filling the panel height. */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none overflow-hidden"
          aria-hidden="true"
        >
          <span
            className="font-display font-black text-[240px] leading-none tracking-[-8px]
                       text-[#F7F2E7] whitespace-nowrap -rotate-90"
            style={{ opacity: 0.04 }}
          >
            FUNNL
          </span>
        </div>

        {/* Brand content -- positioned at bottom of panel */}
        <div className="relative z-10">

          {/* Ember funnel mark */}
          <div
            className="w-11 h-11 rounded-[13px] bg-ember flex items-center justify-center mb-9 flex-none"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d={FUNNEL_PATH} fill="white"/>
            </svg>
          </div>

          {/* Brand copy */}
          <p className="font-display font-semibold text-[30px] leading-[1.2] tracking-[-0.4px] mb-5"
             style={{ color: '#F7F2E7' }}>
            Meet people.<br/>
            Remember everything.<br/>
            Follow through.
          </p>
          <p className="text-[13.5px] leading-relaxed" style={{ color: 'rgba(247,242,231,0.52)' }}>
            The networking system for ambitious students.
          </p>

        </div>
      </div>
    </div>
  )
}

export default AuthShell
