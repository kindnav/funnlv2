/**
 * The character counter under a reviewed interaction note.
 *
 * It states the count against the limit at all times, and when the note is over the limit it
 * says so plainly and by how much - because the editors no longer truncate: a pasted note that
 * runs past the limit is kept exactly as typed, shown as over, and refused on accept until the
 * reviewer shortens it. Nothing is cut silently.
 */
import { noteCounterText } from '../lib/noteCounter.js'

export default function NoteCounter ({ length, max }) {
  const over = Number.isInteger(length) && Number.isInteger(max) && length > max
  return (
    <div data-testid="note-counter" data-over={over ? 'true' : 'false'} role="status" aria-live="polite"
         className={`mt-1 text-[11px] ${over ? 'text-danger' : 'text-lower'}`}>
      {noteCounterText(length, max)}
    </div>
  )
}
