// Pure function used by the ai-chat Edge Function.
// Plain JavaScript (no TypeScript annotations) so Node.js test files
// can import directly without transpilation. Imported by index.ts (Deno).

/** Maximum number of messages allowed in a single conversation (both roles combined). */
export const MAX_MESSAGES = 20

/**
 * Maximum characters allowed per user message.
 * Applies to all user messages (historical and current).
 * Exceeding this for the current user message returns errorCode 'prompt_too_long'.
 */
export const MAX_USER_MESSAGE_CHARS = 8_000

/**
 * Maximum characters an assistant response may occupy in provider conversation history.
 * If an assistant message exceeds this, it is shortened deterministically before being
 * forwarded to the provider. The full content is NEVER modified in the browser —
 * only the copy sent as provider history is shortened.
 *
 * Value justification: the app's PRIMARY_MAX_TOKENS = 4,096 tokens.
 * At ~5 chars/token (English + markdown), max output ≈ 20,480 chars.
 * This limit is set just below that maximum so any legitimately generated
 * response fits without shortening under normal conditions.
 */
export const MAX_ASSISTANT_HISTORY_CHARS = 20_000

/**
 * Maximum combined characters for the entire conversation history sent to the provider.
 * Trimming removes the oldest complete user+assistant pairs first.
 * The current user message is always preserved.
 */
export const MAX_TOTAL_CONVERSATION_CHARS = 40_000

// Marker inserted into the provider history copy when an assistant response is shortened.
// This marker never appears in the browser-visible assistant message content.
const ASSISTANT_HISTORY_MARKER = '\n[Previous assistant response shortened for conversation history]\n'

const VALID_ROLES = new Set(['user', 'assistant'])

/**
 * Shortens an oversized assistant response for use in provider conversation history.
 *
 * Preserves the beginning and end of the response, inserting a neutral marker in
 * the middle. The original string is never mutated.
 *
 * Adjusts cut boundaries to avoid splitting a UTF-16 surrogate pair.
 *
 * @param {string} content - The full assistant response content
 * @returns {string} Content at most MAX_ASSISTANT_HISTORY_CHARS chars long
 */
export function shortenAssistantForHistory(content) {
  if (content.length <= MAX_ASSISTANT_HISTORY_CHARS) return content

  const available = Math.max(0, MAX_ASSISTANT_HISTORY_CHARS - ASSISTANT_HISTORY_MARKER.length)
  const firstHalf = Math.floor(available / 2)
  const lastHalf = available - firstHalf

  // Avoid orphaning a UTF-16 high surrogate (U+D800–U+DBFF) at the end of the
  // first slice or a low surrogate (U+DC00–U+DFFF) at the start of the last slice.
  let startEnd = firstHalf
  if (startEnd > 0 && startEnd < content.length) {
    const code = content.charCodeAt(startEnd - 1)
    if (code >= 0xD800 && code <= 0xDBFF) startEnd--
  }

  let endStart = content.length - lastHalf
  if (endStart > 0 && endStart < content.length) {
    const code = content.charCodeAt(endStart)
    if (code >= 0xDC00 && code <= 0xDFFF) endStart++
  }

  return content.slice(0, startEnd) + ASSISTANT_HISTORY_MARKER + content.slice(endStart)
}

/**
 * Validates, bounds, and normalizes a client-provided messages array before
 * forwarding it to the Anthropic API.
 *
 * Steps applied in order:
 * 1. Validates that the input is a non-empty array.
 * 2. Validates each message: role must be 'user' or 'assistant', content must be a
 *    non-empty trimmed string.
 *    - User messages exceeding MAX_USER_MESSAGE_CHARS return errorCode 'prompt_too_long'.
 *    - Assistant messages exceeding MAX_ASSISTANT_HISTORY_CHARS are shortened
 *      deterministically for provider history via shortenAssistantForHistory().
 *      The original browser-visible content is NEVER modified.
 *    Extra properties are stripped.
 * 3. Requires the conversation to start with a user message.
 *    The frontend's buildProviderMessages() filters out localOnly messages
 *    (including INITIAL_MESSAGE) before invoking the Edge Function. A leading
 *    assistant role indicates a frontend bug and is rejected defensively.
 * 4. Validates strict role alternation on the complete original sequence BEFORE
 *    any history trimming. An invalid sequence cannot become valid merely because
 *    trimming would have removed its malformed portion from the front.
 * 5. Validates that the original conversation ends with a user message BEFORE
 *    any trimming, for the same reason.
 * 6. Trims the oldest full turns (user+assistant pairs) when total character count
 *    exceeds MAX_TOTAL_CONVERSATION_CHARS. Trimming always removes complete pairs
 *    to preserve alternation; orphaned assistant replies are also removed.
 *    The current user message (last) is always preserved.
 * 7. Caps total message count at MAX_MESSAGES, keeping the most recent messages.
 *    After slicing, any leading assistant message is stripped to ensure the result
 *    starts with a user message.
 * 8. Defensive post-trim invariant: re-validates that the result is non-empty,
 *    alternating, and ends with a user message.
 *
 * On validation failure returns:
 *   { messages: null, errorCode: string, validationReason: string }
 *
 * On success returns:
 *   { messages: Array, errorCode: null }
 *
 * errorCode is the public value included in the HTTP response.
 * validationReason is an internal diagnostic for privacy-safe logging only —
 * it must never be included in any HTTP response body.
 *
 * @param {any} messages - Raw client-supplied value from the request body
 * @returns {{ messages: {role:string,content:string}[]|null, errorCode: string|null, validationReason?: string }}
 */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return { messages: null, errorCode: 'invalid_request', validationReason: 'messages_not_array' }
  }
  if (messages.length === 0) {
    return { messages: null, errorCode: 'invalid_request', validationReason: 'messages_empty' }
  }

  // Step 2: validate and normalize each message to { role, content } only.
  // - User messages: reject if over MAX_USER_MESSAGE_CHARS (prompt_too_long).
  // - Assistant messages: shorten if over MAX_ASSISTANT_HISTORY_CHARS (never reject).
  const validated = []
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      return { messages: null, errorCode: 'invalid_request', validationReason: 'invalid_message_shape' }
    }
    if (!VALID_ROLES.has(m.role)) {
      return { messages: null, errorCode: 'invalid_request', validationReason: 'invalid_role' }
    }
    if (typeof m.content !== 'string') {
      return { messages: null, errorCode: 'invalid_request', validationReason: 'invalid_message_shape' }
    }
    const content = m.content.trim()
    if (!content) {
      return { messages: null, errorCode: 'invalid_request', validationReason: 'blank_content' }
    }

    if (m.role === 'user') {
      if (content.length > MAX_USER_MESSAGE_CHARS) {
        return { messages: null, errorCode: 'prompt_too_long', validationReason: 'user_message_too_long' }
      }
      validated.push({ role: 'user', content })
    } else {
      // assistant: shorten if oversized, never reject
      const historyContent = shortenAssistantForHistory(content)
      validated.push({ role: 'assistant', content: historyContent })
    }
  }

  // Step 3: require the conversation to start with a user message.
  if (validated[0]?.role !== 'user') {
    return { messages: null, errorCode: 'invalid_request', validationReason: 'leading_assistant' }
  }

  // Step 4: validate strict role alternation on the COMPLETE original sequence
  // before any trimming. An over-budget sequence with consecutive roles must not
  // become valid merely because trimming would have removed its malformed portion.
  for (let i = 1; i < validated.length; i++) {
    if (validated[i].role === validated[i - 1].role) {
      return { messages: null, errorCode: 'invalid_request', validationReason: 'invalid_role_sequence' }
    }
  }

  // Step 5: require the original conversation to end with a user message before
  // any trimming. Same principle: an invalid trailing state must not be hidden by
  // front-trimming that preserves the tail.
  if (validated[validated.length - 1].role !== 'user') {
    return { messages: null, errorCode: 'invalid_request', validationReason: 'conversation_not_user_terminated' }
  }

  // Step 6: trim oldest turns when total character count exceeds budget.
  // Always remove a user message together with the assistant reply that follows it
  // so that alternation is preserved after trimming.
  let normalized = validated
  let totalChars = normalized.reduce((sum, m) => sum + m.content.length, 0)

  while (totalChars > MAX_TOTAL_CONVERSATION_CHARS && normalized.length > 1) {
    const oldest = normalized.shift()
    totalChars -= oldest.content.length
    if (normalized.length > 0 && normalized[0].role === 'assistant') {
      const orphan = normalized.shift()
      totalChars -= orphan.content.length
    }
  }

  // Step 7: cap total message count, keeping the most recent.
  if (normalized.length > MAX_MESSAGES) {
    normalized = normalized.slice(normalized.length - MAX_MESSAGES)
    while (normalized.length > 0 && normalized[0].role === 'assistant') {
      normalized.shift()
    }
  }

  // Step 8: defensive post-trim invariants. The pre-trim checks (steps 4–5) already
  // validated the original sequence. These re-checks guard against any unexpected
  // edge case in the trimming/capping logic above.
  if (normalized.length === 0) {
    return { messages: null, errorCode: 'invalid_request', validationReason: 'conversation_empty_after_normalization' }
  }

  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].role === normalized[i - 1].role) {
      return { messages: null, errorCode: 'invalid_request', validationReason: 'invalid_role_sequence' }
    }
  }

  if (normalized[normalized.length - 1].role !== 'user') {
    return { messages: null, errorCode: 'invalid_request', validationReason: 'conversation_not_user_terminated' }
  }

  return { messages: normalized, errorCode: null }
}
