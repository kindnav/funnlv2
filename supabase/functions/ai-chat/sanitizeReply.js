// Output sanitizers for ai-chat Edge Function replies.
// Plain JavaScript (no TypeScript annotations) so Node.js test files
// can import them directly without transpilation.
//
// Processing order when used together: sanitizeContactLinks first, then sanitizeAssistantReply.
// sanitizeContactLinks operates on markdown link syntax before any character-level changes.

// ── Contact link sanitization ─────────────────────────────────────────────────

// Matches any markdown link: [label](url)
// Supports one level of balanced parentheses in the URL (e.g. javascript:void(0))
// so that the full URL is captured and not truncated at an inner ')'.
const LINK_RE = /\[([^\]]*)\]\(([^)(]*(?:\([^)]*\)[^)(]*)*)\)/g

// Matches ONLY safe internal contact paths: /contacts/<canonical-uuid>
// UUID must be all lowercase hex digits (4 groups of 8-4-4-4-12).
// Rejects: external URLs, javascript:, data:, protocol-relative, any other path.
// The i flag allows mixed-case UUIDs from the model; we normalize to lowercase for lookup.
const CONTACT_PATH_RE = /^\/contacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function normalizeNameForCompare(s) {
  if (!s || typeof s !== 'string') return ''
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Validates and sanitizes contact links in an AI-generated markdown reply.
 *
 * Retains a markdown link ONLY when all three conditions hold:
 *   1. The URL exactly matches /contacts/<uuid>
 *   2. The UUID is present in allowedContacts
 *   3. The link label case-insensitively matches the stored contact name (whitespace normalized)
 *
 * On any validation failure the link is degraded to plain text (just the label).
 * The rest of the answer is always preserved — a bad link never discards surrounding text.
 *
 * Rejects without explicit checks (covered by CONTACT_PATH_RE failing to match):
 *   external URLs, javascript: URIs, data: URIs, protocol-relative URLs, and
 *   URL-encoded path bypasses (e.g. %2Fcontacts%2F...).
 *
 * Handles duplicate contact names: validation is by ID+name pair, so two contacts
 * with the same display name but different IDs are both accepted when correctly linked.
 *
 * @param {string} markdown - AI-generated reply text (may contain markdown links)
 * @param {Array<{id: string, name: string}>} allowedContacts - contacts from the current user's DB query
 * @returns {string} markdown with only validated contact links intact; all others become plain text
 */
export function sanitizeContactLinks(markdown, allowedContacts) {
  if (!markdown || typeof markdown !== 'string') return markdown ?? ''

  // Build a lookup: lowercased UUID → normalized name
  const contactMap = new Map()
  if (Array.isArray(allowedContacts)) {
    for (const c of allowedContacts) {
      if (c && typeof c.id === 'string' && typeof c.name === 'string' && c.id && c.name) {
        contactMap.set(c.id.toLowerCase(), normalizeNameForCompare(c.name))
      }
    }
  }

  return markdown.replace(LINK_RE, (match, label, href) => {
    // Normalize href: trim surrounding whitespace before testing
    const trimmedHref = (href ?? '').trim()
    const pathMatch = CONTACT_PATH_RE.exec(trimmedHref)

    if (!pathMatch) {
      // Not a contact path — degrade to plain text
      return label
    }

    const uuid = pathMatch[1].toLowerCase()
    const expectedName = contactMap.get(uuid)

    if (expectedName === undefined) {
      // UUID not in this user's allowedContacts — degrade to plain text
      return label
    }

    if (normalizeNameForCompare(label) !== expectedName) {
      // Label doesn't match the stored contact name — degrade to plain text
      return label
    }

    // All checks pass — preserve the original markdown link
    return match
  })
}

// ── Em dash / en dash sanitizer ───────────────────────────────────────────────

/**
 * Removes em dashes and sentence-punctuation en dashes from an AI reply.
 *
 * Em dash (U+2014): always replaced with " - " (space-hyphen-space) regardless
 * of surrounding context — the system prompt instructs the model never to use one.
 * This is a defensive final-output safety net.
 *
 * En dash (U+2013): replaced only when it appears as sentence punctuation, i.e.
 * surrounded by spaces on both sides. En dashes used as range separators
 * (e.g. "2020–2021", "pages 5–10") have no surrounding spaces and are preserved.
 *
 * Normal hyphens in compound words ("follow-up", "well-known") and ISO date
 * separators ("2026-07-26") are never touched — this function only targets
 * Unicode em dash (U+2014) and en dash (U+2013) code points.
 *
 * @param {string} reply - sanitized markdown reply text
 * @returns {string} reply with em dashes removed and sentence-punctuation en dashes replaced
 */
export function sanitizeAssistantReply(reply) {
  if (!reply || typeof reply !== 'string') return reply ?? ''

  let result = reply
  // Em dash — always replace regardless of context
  result = result.replace(/—/g, ' - ')
  // En dash — only replace when used as sentence punctuation (space on both sides)
  result = result.replace(/ – /g, ' - ')

  return result
}
