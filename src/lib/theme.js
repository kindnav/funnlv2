// Theme management: Dark / Light / System
// Persists in localStorage. Applies by stamping data-theme on <html>.
// Tailwind v4 token overrides in index.css respond to that attribute.
// Default when no preference is stored: dark.

const VALID_THEMES = new Set(['dark', 'light', 'system'])

export function getTheme() {
  const stored = localStorage.getItem('funnl-theme')
  // Validate stored value — older versions may have stored 'system' from a different default.
  // Invalid or missing values fall back to 'dark'.
  return VALID_THEMES.has(stored) ? stored : 'dark'
}

export function setTheme(theme) {
  if (!VALID_THEMES.has(theme)) return
  localStorage.setItem('funnl-theme', theme)
  applyTheme(theme)
}

export function applyTheme(theme) {
  const root = document.documentElement
  // Always set an explicit data-theme attribute so CSS selectors are unambiguous.
  // 'system' is preserved as a value so :root[data-theme="system"] can match.
  root.dataset.theme = VALID_THEMES.has(theme) ? theme : 'dark'

  // color-scheme: lets the browser apply the correct native UI controls (scrollbars,
  // form elements, etc.) and avoids white flash on dark themes.
  if (theme === 'system') {
    root.style.colorScheme = 'light dark'
  } else {
    root.style.colorScheme = theme  // 'dark' or 'light'
  }
}

export function initTheme() {
  applyTheme(getTheme())
}
