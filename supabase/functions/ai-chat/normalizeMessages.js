// Pure function used by the ai-chat Edge Function.
// Plain JavaScript (no TypeScript annotations) so Node.js test files
// can import directly without transpilation. Imported by index.ts (Deno).

/** Maximum number of messages allowed in a single conversation (both roles combined). */
export const MAX_MESSAGES = 20

/** Maximum characters allowed per individual message. */
export const MAX_MESSAGE_CHARS = 4_000

/** Maximum combined characters for the entire conversation. */
export const MAX_TOTAL_CONVERSATION_CHARS = 20_000

const VALID_ROLES = new Set(['user', 'assistant'])

/**
 * Validates, bounds, and normalizes a client-provided messages array before
 * forwarding it to the Anthropic API.
 *
 * Steps applied in order:
 * 1. Validates that the input is a non-empty array.
 * 2. Validates each message: role must be 'user' or 'assistant', content must be a
 *    non-empty trimmed string within MAX_MESSAGE_CHARS. Extra properties are stripped.
 * 3. Strips the frontend's synthetic opening assistant greeting (INITIAL_MESSAGE) —
 *    only the very first message when its role is 'assistant'. Real assistant replies
 *    at any other position are never stripped.
 * 4. Trims the oldest full turns (user+assistant pairs) when total character count
 *    exceeds MAX_TOTAL_CONVERSATION_CHARS. Trimming always removes pairs to preserve
 *    alternation; orphaned assistant replies after a removed user message are also removed.
 * 5. Caps total message count at MAX_MESSAGES, keeping the most recent messages.
 *    After slicing, any leading assistant message is stripped to ensure the result
 *    starts with a user message.
 * 6. Validates strict role alternation throughout the sequence.
 * 7. Validates that the final message is from the user.
 *
 * Returns { messages: null, errorCode: 'invalid_request' } on any validation
 * failure so callers can return HTTP 400 without logging any user content.
 *
 * @param {any} messages - Raw client-supplied value from the request body
 * @returns {{ messages: {role:string,content:string}[]|null, errorCode: string|null }}
 */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: null, errorCode: 'invalid_request' }
  }

  // Step 1+2: validate and strip each message to { role, content } only.
  const validated = []
  for (const m of messages) {
    if (!m || typeof m !== 'object') return { messages: null, errorCode: 'invalid_request' }
    if (!VALID_ROLES.has(m.role)) return { messages: null, errorCode: 'invalid_request' }
    if (typeof m.content !== 'string') return { messages: null, errorCode: 'invalid_request' }
    const content = m.content.trim()
    if (!content) return { messages: null, errorCode: 'invalid_request' }
    if (content.length > MAX_MESSAGE_CHARS) return { messages: null, errorCode: 'invalid_request' }
    validated.push({ role: m.role, content })
  }

  // Step 3: require the conversation to start with a user message.
  // The frontend's buildProviderMessages() filters out localOnly messages (including
  // INITIAL_MESSAGE) before invoking the Edge Function, so a leading assistant role
  // should never arrive here. Silently stripping it would mask a frontend bug —
  // rejecting it is the correct defensive posture.
  let normalized = validated
  if (normalized[0]?.role !== 'user') {
    return { messages: null, errorCode: 'invalid_request' }
  }

  // Step 4: trim oldest turns when total character count exceeds budget.
  // Always remove a user message together with the assistant reply that follows it
  // so that alternation is preserved after trimming.
  let totalChars = normalized.reduce((sum, m) => sum + m.content.length, 0)

  while (totalChars > MAX_TOTAL_CONVERSATION_CHARS && normalized.length > 1) {
    const oldest = normalized.shift()
    totalChars -= oldest.content.length
    // If removing a user message exposed an orphaned assistant reply at position 0,
    // remove it too — an assistant response without its prompt is invalid context.
    if (normalized.length > 0 && normalized[0].role === 'assistant') {
      const orphan = normalized.shift()
      totalChars -= orphan.content.length
    }
  }

  // Step 5: cap total message count, keeping the most recent.
  if (normalized.length > MAX_MESSAGES) {
    normalized = normalized.slice(normalized.length - MAX_MESSAGES)
    // After slicing, the first entry might be an assistant reply — strip until user.
    while (normalized.length > 0 && normalized[0].role === 'assistant') {
      normalized.shift()
    }
  }

  if (normalized.length === 0) {
    return { messages: null, errorCode: 'invalid_request' }
  }

  // Step 6: validate strict alternation (consecutive same-role messages indicate a bug).
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].role === normalized[i - 1].role) {
      return { messages: null, errorCode: 'invalid_request' }
    }
  }

  // Step 7: final message must be from the user.
  if (normalized[normalized.length - 1].role !== 'user') {
    return { messages: null, errorCode: 'invalid_request' }
  }

  return { messages: normalized, errorCode: null }
}
