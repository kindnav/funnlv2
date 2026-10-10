/**
 * Pure text for the reviewed-note character counter (shared by both suggestion editors and
 * their tests). Over the limit it says so and by how much; the editors never truncate.
 */
export const NOTE_OVER_LIMIT_PREFIX = 'Over the'

export function noteCounterText (length, max) {
  const n = Number.isInteger(length) ? length : 0
  const m = Number.isInteger(max) ? max : 0
  const fmt = (v) => v.toLocaleString('en-US')
  if (n > m) {
    return `${NOTE_OVER_LIMIT_PREFIX} ${fmt(m)}-character limit by ${fmt(n - m)}. Shorten the note to accept.`
  }
  return `${fmt(n)} / ${fmt(m)} characters`
}
