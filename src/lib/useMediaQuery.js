import { useEffect, useState } from 'react'

/** Tailwind's md breakpoint: the desktop layout starts here. */
export const MD_UP = '(min-width: 768px)'

/**
 * True while the media query matches; follows changes (resize, rotation).
 * Without matchMedia (very old browsers, non-DOM tests) it is false, so callers
 * fall back to their small-screen behaviour.
 */
export function useMediaQuery(query) {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}
