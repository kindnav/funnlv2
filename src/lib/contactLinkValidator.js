// Validates contact link hrefs for the FunnlAI chat renderer.
// Must match the server-side CONTACT_PATH_RE in sanitizeReply.js.
// Exported separately so the regex can be unit-tested without a DOM.

/**
 * Returns true only for safe internal contact paths of the form:
 *   /contacts/<lowercase-uuid>
 *
 * Rejects external URLs, javascript: URIs, data: URIs, protocol-relative URLs,
 * URL-encoded bypasses, and any path that doesn't follow the exact UUID format.
 */
export function isValidContactLink(href) {
  if (!href || typeof href !== 'string') return false
  return /^\/contacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(href)
}
