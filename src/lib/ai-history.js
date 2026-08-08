/**
 * ai-history.js — Pure helpers for FunnlAI conversation history.
 *
 * No React, no Supabase — safe to import in Node.js test files.
 */

export const MAX_HISTORY_SESSIONS = 10
export const historyKey = uid => `funnl_ai_history_${uid}`
export const currentKey = uid => `funnl_ai_current_${uid}`

/** Generate a short stable ID for a message object. */
export function genMsgId() {
  return Math.random().toString(36).slice(2, 10)
}

export const INITIAL_MESSAGE = {
  id:       'initial',
  role:     'assistant',
  content:  "Your network is loaded. Ask me anything about your contacts — who you know somewhere, who's gone quiet, what your follow-up situation looks like, or whatever you're wondering about.",
  localOnly: true,
}

export const TICKER_PHRASES = [
  'Reading your network…',
  'Connecting the dots…',
  'Looking for patterns…',
  'Thinking it through…',
]

/**
 * Extract all contact refs ([Name](/contacts/<uuid>)) from AI markdown output.
 * Deduplicates by UUID. Returns [{name, contactId}].
 */
export function extractContactRefs(markdown) {
  if (typeof markdown !== 'string') return []
  const refs = []
  const seen = new Set()
  const re = /\[([^\]]+)\]\(\/contacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi
  let m
  while ((m = re.exec(markdown)) !== null) {
    const name = m[1]
    const id   = m[2].toLowerCase()
    if (!seen.has(id)) { seen.add(id); refs.push({ name, contactId: id }) }
  }
  return refs
}

/**
 * Derive a display title for a session from the first real user message.
 * Truncates to 60 chars (57 + '…').
 */
export function sessionTitle(messages) {
  if (!Array.isArray(messages)) return 'New conversation'
  const first = messages.find(m => m.role === 'user' && !m.localOnly && !m.error)
  if (!first?.content) return 'New conversation'
  return first.content.length > 60 ? first.content.slice(0, 57) + '…' : first.content
}

/**
 * Human-readable relative timestamp for conversation history rail.
 * Returns '' for invalid dates, 'Just now' for future timestamps.
 */
export function relativeTime(isoStr, now = new Date()) {
  const d = new Date(isoStr)
  if (isNaN(d)) return ''
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24))
  if (diffDays < 0)   return 'Just now'
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7)   return diffDays + ' days ago'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ── History schema ────────────────────────────────────────────────────────────

/** Schema version stored in every archived session object. */
export const HISTORY_VERSION = 1

/**
 * Validate that a value has the minimum required shape for a stored session.
 * Accepts sessions with or without the `v` field (backward compat with pre-v1 storage).
 */
export function validateHistorySession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return false
  if (typeof session.id !== 'string' || !session.id.trim()) return false
  if (typeof session.title !== 'string') return false
  if (typeof session.createdAt !== 'string') return false
  if (!Array.isArray(session.messages)) return false
  return true
}

/**
 * Safely parse a raw localStorage string into an array of valid session objects.
 * Returns [] on null, empty, malformed JSON, non-array, or all-invalid sessions.
 */
export function parseStoredHistory(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(validateHistorySession)
  } catch {
    return []
  }
}

/**
 * Returns true when the messages array contains at least one real (non-localOnly,
 * non-error) user message — i.e., the session is worth archiving.
 */
export function isArchivable(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(m => m?.role === 'user' && !m.localOnly && !m.error)
}

/**
 * Returns true when `sessionId` already appears in the `sessions` array.
 * Used to detect duplicate archival before prepending a session.
 */
export function isDuplicateSession(sessions, sessionId) {
  if (!Array.isArray(sessions) || typeof sessionId !== 'string') return false
  return sessions.some(s => s?.id === sessionId)
}

/**
 * Caps a sessions array at `max` entries (newest-first order assumed).
 * Defaults to MAX_HISTORY_SESSIONS.
 */
export function capHistory(sessions, max = MAX_HISTORY_SESSIONS) {
  if (!Array.isArray(sessions)) return []
  const limit = typeof max === 'number' && max > 0 ? max : MAX_HISTORY_SESSIONS
  return sessions.slice(0, limit)
}

// ── Contact reference validation ──────────────────────────────────────────────

/**
 * Filter AI-extracted contact refs to only those whose UUID appears in
 * `allowedContacts` (the authenticated user's contact list). Returns validated
 * refs with the canonical name from the DB record, not the provider-generated label.
 *
 * @param {Array<{name:string,contactId:string}>} refs — from extractContactRefs()
 * @param {Array<{id:string,name:string,company?:string,role?:string}>} allowedContacts
 * @returns {Array<{contactId:string,name:string,company:string|null,role:string|null}>}
 */
export function validateContactRefs(refs, allowedContacts) {
  if (!Array.isArray(refs) || !Array.isArray(allowedContacts)) return []
  const allowedMap = new Map(allowedContacts.map(c => [c.id, c]))
  return refs
    .filter(ref => ref && typeof ref.contactId === 'string' && allowedMap.has(ref.contactId))
    .map(ref => {
      const contact = allowedMap.get(ref.contactId)
      return {
        contactId: ref.contactId,
        name:      contact.name,
        company:   contact.company  ?? null,
        role:      contact.role     ?? null,
      }
    })
}

// ── Inline follow-up eligibility ──────────────────────────────────────────────

/**
 * Determine which action path to use for an AI contact reference.
 *
 * Returns:
 *   { mode: 'none' }    — no valid contact; render no action
 *   { mode: 'navigate', contactId }  — valid contact but no matched interaction;
 *                                       navigate with openFollowUpForm: true
 *   { mode: 'inline', contactId, interactionId } — valid contact AND a validated
 *     interaction that belongs to that contact; may offer inline date picker
 *
 * @param {object|null} reference — the raw AI reference (used for structural check only)
 * @param {object|null} validatedContact — contact from the user's DB (must have .id)
 * @param {object|null} validatedInteraction — interaction from the user's DB (must have .id and .contact_id)
 */
export function deriveAIContactActionEligibility(reference, validatedContact, validatedInteraction) {
  if (!validatedContact || typeof validatedContact.id !== 'string') {
    return { mode: 'none' }
  }
  if (
    validatedInteraction &&
    typeof validatedInteraction.id === 'string' &&
    validatedInteraction.contact_id === validatedContact.id
  ) {
    return { mode: 'inline', contactId: validatedContact.id, interactionId: validatedInteraction.id }
  }
  return { mode: 'navigate', contactId: validatedContact.id }
}

// ── History revalidation ──────────────────────────────────────────────────────

/**
 * Revalidate contact references in a history session against the current contact
 * list. Adds `_validContactRefs` to each assistant message so deleted or
 * inaccessible contacts are silently dropped when the session is re-rendered.
 *
 * Does not mutate source objects. Returns the session unchanged if invalid.
 */
export function revalidateHistorySession(session, allowedContacts) {
  if (!validateHistorySession(session)) return session
  const messages = session.messages.map(msg => {
    if (msg.role !== 'assistant' || !msg.content) return msg
    const refs      = extractContactRefs(msg.content)
    const validRefs = validateContactRefs(refs, allowedContacts)
    return { ...msg, _validContactRefs: validRefs }
  })
  return { ...session, messages }
}

// ── Message normalization ─────────────────────────────────────────────────────

/**
 * Validate a single stored message has the minimum required shape.
 * Accepts messages with or without an ID field (ID is hydrated separately).
 */
export function validateStoredMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false
  if (msg.role !== 'user' && msg.role !== 'assistant') return false
  if (typeof msg.content !== 'string') return false
  return true
}

/**
 * Normalize a message so it always has a stable non-empty string `id`.
 * Returns null for messages that fail basic shape validation (wrong role,
 * non-string content) — callers should discard null results.
 */
export function normalizeMessageId(msg) {
  if (!validateStoredMessage(msg)) return null
  return { ...msg, id: (typeof msg.id === 'string' && msg.id.trim()) ? msg.id : genMsgId() }
}

/**
 * Normalize an array of messages: validate shape, hydrate missing IDs,
 * discard invalid entries. Never throws.
 */
export function hydrateMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map(normalizeMessageId).filter(Boolean)
}

// ── Current-session storage ───────────────────────────────────────────────────

/**
 * Safely parse the current-session localStorage string (stored as a JSON array
 * of messages). Validates each message; hydrates missing IDs; discards invalid
 * entries. Returns [] on null, empty, malformed JSON, non-array, or all-invalid.
 *
 * The current-session record is a flat array (no wrapping object/version) for
 * backward compatibility with the existing storage format.
 */
export function parseStoredCurrentSession(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return hydrateMessages(parsed)
  } catch {
    return []
  }
}
