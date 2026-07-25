// Theme management: Dark / Light / System
// Persists in localStorage. Applies by stamping data-theme on <html>.
// Tailwind v4 token overrides in index.css respond to that attribute.
// Default when no preference is stored: dark.

// ── Pure functions — no browser globals, safe to import and call in Node.js ──

export const VALID_THEMES = new Set(['dark', 'light', 'system'])

/** Returns the theme string if valid, otherwise 'dark'. */
export function normalizeThemePreference(value) {
  return VALID_THEMES.has(value) ? value : 'dark'
}

/** Returns the CSS color-scheme value for a given theme. */
export function resolveColorScheme(theme) {
  return theme === 'system' ? 'light dark' : theme
}

/** Read and validate the stored theme preference from any storage object. */
export function readThemePreference(storage) {
  return normalizeThemePreference(storage.getItem('funnl-theme'))
}

/** Write a theme preference to any storage object (no-op for invalid values). */
export function writeThemePreference(storage, theme) {
  if (VALID_THEMES.has(theme)) storage.setItem('funnl-theme', theme)
}

/** Apply a theme to any root element by setting dataset.theme and style.colorScheme. */
export function applyThemeToRoot(root, theme) {
  root.dataset.theme = normalizeThemePreference(theme)
  root.style.colorScheme = resolveColorScheme(normalizeThemePreference(theme))
}

// ── Browser wrappers — use localStorage and document.documentElement ──
// These cannot be called in Node.js. Import the pure functions above for tests.

export function getTheme() {
  return readThemePreference(localStorage)
}

export function setTheme(theme) {
  writeThemePreference(localStorage, theme)
  applyTheme(theme)
}

export function applyTheme(theme) {
  applyThemeToRoot(document.documentElement, theme)
}

export function initTheme() {
  applyTheme(getTheme())
}
