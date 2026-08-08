/**
 * TopBar — per-page top bar that sits sticky at the top of each page's scroll container.
 * Usage:
 *   <TopBar
 *     title="Contacts"
 *     count={42}                          // optional badge count (hidden in breadcrumb mode)
 *     searchPlaceholder="Search people…"  // opens CommandPalette on click (hidden in breadcrumb mode)
 *     onSearchClick={openPalette}         // called when search area is clicked
 *     actions={<button>...</button>}      // optional ghost actions (left of CTA)
 *     cta={<button>...</button>}          // one ember CTA button (right-most)
 *     breadcrumb={<Link>...</Link>}       // when set: renders a back-breadcrumb at start;
 *                                         //   title becomes flex-1 truncate, search is hidden
 *   />
 *
 * The search bar is a visual trigger only — clicking it fires onSearchClick.
 * Actual search is handled by CommandPalette.
 */
export default function TopBar({ title, count, searchPlaceholder, onSearchClick, actions, cta, breadcrumb }) {
  const showSearch = !breadcrumb && (onSearchClick || searchPlaceholder)

  return (
    <div
      className="sticky top-0 z-30 flex items-center gap-[10px] px-[20px] md:px-[28px] py-[11px] border-b border-line-1"
      style={{ background: 'var(--color-base)' }}
    >
      {/* Breadcrumb — only in detail-page mode */}
      {breadcrumb && (
        <>
          <div className="flex-none">{breadcrumb}</div>
          <span className="text-[13px] flex-none hidden md:block" style={{ color: 'var(--color-low)' }}>/</span>
        </>
      )}

      {/* Title + count */}
      <div className={`flex items-baseline gap-[8px] ${breadcrumb ? 'flex-1 min-w-0' : 'flex-none'}`}>
        <h1
          className={`text-[16px] font-display font-semibold leading-none ${breadcrumb ? 'truncate' : ''}`}
          style={{ color: 'var(--color-hi)' }}
        >
          {title}
        </h1>
        {!breadcrumb && count != null && count > 0 && (
          <span className="text-[11px] font-mono font-medium" style={{ color: 'var(--color-low)' }}>
            {count}
          </span>
        )}
      </div>

      {/* Search trigger — grows to fill available space; hidden in breadcrumb mode */}
      {showSearch && (
        <button
          type="button"
          onClick={onSearchClick}
          className="flex-1 min-w-0 flex items-center gap-[8px] px-[11px] h-[34px] rounded-[9px] border border-line-2 text-left transition-colors hover:border-line-3 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-accent/60"
          style={{ background: 'var(--color-input)' }}
          aria-label="Open global search"
          aria-haspopup="dialog"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-low)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
          </svg>
          <span className="text-[12px] truncate" style={{ color: 'var(--color-lower)' }}>
            {searchPlaceholder || 'Search…'}
          </span>
          <span className="ml-auto text-[10px] font-mono px-[5px] py-[2px] rounded-[4px] flex-none hidden md:flex items-center gap-[2px]"
            style={{ background: 'var(--color-elevated)', color: 'var(--color-low)', border: '1px solid var(--color-line-2)' }}>
            ⌘K
          </span>
        </button>
      )}

      {/* Ghost action buttons slot */}
      {actions && (
        <div className="flex items-center gap-[6px] flex-none">
          {actions}
        </div>
      )}

      {/* One ember CTA (right-most) */}
      {cta && (
        <div className="flex-none">
          {cta}
        </div>
      )}
    </div>
  )
}
