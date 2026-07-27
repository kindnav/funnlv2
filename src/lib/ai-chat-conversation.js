// Helpers for building and managing AI conversation state on the frontend.

/**
 * Builds the message array to send to the Edge Function.
 *
 * Filters out:
 * - Messages marked localOnly: true (e.g. INITIAL_MESSAGE — a frontend-only
 *   greeting that was never meant for the provider). The Edge Function rejects
 *   any leading assistant message, so these must be removed before invoking.
 * - Messages with an inline error field (failed, unretried turns — their content
 *   is excluded from provider history to avoid broken context sequences).
 *
 * @param {Array} msgs - The full messages array from component state
 * @returns {Array<{role: string, content: string}>}
 */
export function buildProviderMessages(msgs) {
  if (!Array.isArray(msgs)) return []
  return msgs
    .filter(m => !m.localOnly && !m.error)
    .map(m => ({ role: m.role, content: m.content }))
}

/**
 * Returns true if the failed message at the given index is eligible to retry.
 *
 * A retry is only safe when the failed message is the LAST message in the array.
 * This guarantees the provider receives a valid sequence: all prior turns are
 * clean successful exchanges, and the retry resends only the latest prompt.
 *
 * If any subsequent message exists after the failed one (even a successful
 * assistant reply), retrying the earlier failure would produce out-of-order
 * context — so it is not allowed. Dismiss is always available regardless.
 *
 * @param {Array}  messages - The full messages array from component state
 * @param {number} index    - Index of the message to check
 * @returns {boolean}
 */
export function isRetryEligible(messages, index) {
  if (!Array.isArray(messages)) return false
  if (index < 0 || index >= messages.length) return false
  const msg = messages[index]
  if (!msg?.error || msg.role !== 'user') return false
  // Non-retryable errors (invalid_request, prompt_too_long, pro_required, etc.)
  // must not show Retry — resending the identical request cannot succeed.
  if (!msg.error.retryable) return false
  // Only eligible when this is the very last message in the array — any subsequent
  // turn (successful or otherwise) makes the earlier failure ineligible for retry.
  return index === messages.length - 1
}
