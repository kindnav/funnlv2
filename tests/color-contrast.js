// WCAG relative luminance and contrast ratio utilities — pure Node.js, no deps.
// Used by avatar-contrast.test.js for gradient sampling verification.

export function hexToRgb(hex) {
  const h = hex.replace(/^#/, '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function linearize(c) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

export function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker  = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

// Linear sRGB interpolation at position t (0=hexA endpoint, 1=hexB endpoint).
// CSS linear-gradient interpolates in sRGB space — this matches that behavior.
export function interpolateGradient(hexA, hexB, t) {
  const [ra, ga, ba] = hexToRgb(hexA)
  const [rb, gb, bb] = hexToRgb(hexB)
  const r = Math.round(ra + t * (rb - ra))
  const g = Math.round(ga + t * (gb - ga))
  const b = Math.round(ba + t * (bb - ba))
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}
