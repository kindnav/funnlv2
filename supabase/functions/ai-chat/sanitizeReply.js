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
 * Retains a markdown link as a CANONICAL link only when all three conditions hold:
 *   1. The URL exactly matches /contacts/<uuid> (with or without mixed case — normalised to lowercase)
 *   2. The UUID is present in allowedContacts
 *   3. The link label case-insensitively matches the stored contact name (whitespace normalised)
 *
 * When all three conditions pass, the returned link is CANONICAL — the label is set to the
 * exact stored name and the UUID is lowercased — regardless of how the model wrote either.
 *
 * First-mention-only: each contact ID receives at most one clickable link per reply. The
 * first valid mention is linked; subsequent valid mentions of the same ID become plain text
 * (the stored name, no link). A failed first attempt (wrong label, unknown UUID, etc.) does
 * NOT consume the linking opportunity — only a successful first mention does.
 *
 * On any validation failure the link is degraded to plain text (just the label).
 * The rest of the answer is always preserved — a bad link never discards surrounding text.
 *
 * Rejects without explicit checks (covered by CONTACT_PATH_RE failing to match):
 *   external URLs, javascript: URIs, data: URIs, protocol-relative URLs, query params,
 *   URL fragments, trailing slashes, and URL-encoded path bypasses.
 *
 * Handles duplicate contact names: validation is by ID+name pair, so two contacts
 * with the same display name but different IDs can each receive one canonical link.
 *
 * @param {string} markdown - AI-generated reply text (may contain markdown links)
 * @param {Array<{id: string, name: string}>} allowedContacts - contacts from the current user's DB query
 * @returns {string} markdown with only canonical validated contact links; all others become plain text
 */
export function sanitizeContactLinks(markdown, allowedContacts) {
  if (!markdown || typeof markdown !== 'string') return markdown ?? ''

  // Build a lookup: lowercase UUID → { id (lowercase), name (exact stored casing) }
  const contactMap = new Map()
  if (Array.isArray(allowedContacts)) {
    for (const c of allowedContacts) {
      if (c && typeof c.id === 'string' && typeof c.name === 'string' && c.id && c.name) {
        contactMap.set(c.id.toLowerCase(), { id: c.id.toLowerCase(), name: c.name })
      }
    }
  }

  // Track which contact IDs have received their one canonical link (first-mention-only).
  // Only added to the set after full validation passes — an invalid first attempt
  // (wrong label, unknown UUID, path mismatch, etc.) does not consume the opportunity.
  const linkedIds = new Set()

  return markdown.replace(LINK_RE, (match, label, href) => {
    // Normalize href: trim surrounding whitespace before testing
    const trimmedHref = (href ?? '').trim()
    const pathMatch = CONTACT_PATH_RE.exec(trimmedHref)

    if (!pathMatch) {
      // Not a contact path (external URL, javascript:, data:, query param, fragment, etc.)
      return label
    }

    const uuid = pathMatch[1].toLowerCase()
    const contact = contactMap.get(uuid)

    if (!contact) {
      // UUID not in this user's allowedContacts — degrade to plain text
      return label
    }

    if (normalizeNameForCompare(label) !== normalizeNameForCompare(contact.name)) {
      // Label doesn't match the stored contact name — degrade to plain text.
      // The ID is NOT added to linkedIds so a later valid mention can still be linked.
      return label
    }

    if (linkedIds.has(uuid)) {
      // This contact has already received its one canonical link — return stored name as plain text
      return contact.name
    }

    // First valid mention: mark as linked and return the canonical link.
    // Canonical form uses exact stored-name casing and a lowercase UUID path.
    // Never trust the model's casing for either.
    linkedIds.add(uuid)
    return `[${contact.name}](/contacts/${uuid})`
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
  // Em dash — absorb any surrounding whitespace so the replacement is a single ' - ',
  // preventing double spaces when the original text had spaces around the dash.
  result = result.replace(/\s*—\s*/g, ' - ')
  // En dash — replace when used as sentence punctuation (one or more spaces on each side).
  // Range en dashes (no surrounding spaces, e.g. 2020–2024) are not matched by \s+.
  result = result.replace(/\s+–\s+/g, ' - ')

  return result
}
