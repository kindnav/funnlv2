// Theme management: System / Light / Dark
// Persists in localStorage. Applies by stamping data-theme on <html>.
// Tailwind v4 token overrides in index.css respond to that attribute.

export function getTheme() {
  return localStorage.getItem('funnl-theme') || 'system'
}

export function setTheme(theme) {
  localStorage.setItem('funnl-theme', theme)
  applyTheme(theme)
}

export function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'light') {
    root.dataset.theme = 'light'
  } else if (theme === 'dark') {
    root.dataset.theme = 'dark'
  } else {
    delete root.dataset.theme
  }
}

export function initTheme() {
  applyTheme(getTheme())
}
