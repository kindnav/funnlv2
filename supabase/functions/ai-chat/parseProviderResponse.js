// Pure function used by the ai-chat Edge Function.
// Plain JavaScript (no TypeScript annotations) so Node.js test files
// can import directly without transpilation. Imported by index.ts (Deno).

/** Values observed in Anthropic's stop_reason field. */
export const STOP_REASON = {
  END_TURN: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  STOP_SEQUENCE: 'stop_sequence',
}

/**
 * Parses an Anthropic Messages API response object and extracts usable text.
 *
 * Collects ALL text-type content blocks in document order. claude-sonnet-5 may
 * emit thinking blocks (type='thinking') before, after, or between text blocks —
 * thinking blocks are skipped because they are internal reasoning, not the reply.
 * Multiple text blocks are joined with a double newline.
 *
 * When stop_reason is 'max_tokens' and text was found, the reply is returned with
 * truncated=true so callers can surface a note to the user. This is preferred over
 * rejecting the partial response: the text is still useful content.
 *
 * Returns error='empty_provider_response' (and reply=null) when:
 *   - response is not an object
 *   - content is missing or not an array
 *   - content is empty
 *   - all blocks are thinking-only (no text blocks)
 *   - all text blocks are whitespace-only
 *   - stop_reason is max_tokens but no text was extracted
 *
 * @param {any} response - Parsed JSON from the Anthropic API
 * @returns {{ reply: string|null, stop_reason: string|null, truncated: boolean, error: string|null }}
 */
export function parseProviderResponse(response) {
  if (!response || typeof response !== 'object') {
    return { reply: null, stop_reason: null, truncated: false, error: 'empty_provider_response' }
  }

  const stop_reason = typeof response.stop_reason === 'string' ? response.stop_reason : null
  const content = response.content

  if (!Array.isArray(content) || content.length === 0) {
    return { reply: null, stop_reason, truncated: false, error: 'empty_provider_response' }
  }

  // Collect every non-empty text block in order, skipping thinking blocks.
  const textParts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const trimmed = block.text.trim()
      if (trimmed) textParts.push(trimmed)
    }
  }

  if (textParts.length === 0) {
    return { reply: null, stop_reason, truncated: false, error: 'empty_provider_response' }
  }

  const reply = textParts.join('\n\n')
  const truncated = stop_reason === STOP_REASON.MAX_TOKENS

  return { reply, stop_reason, truncated, error: null }
}
