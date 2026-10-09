/**
 * The EXPLICIT choice a busy card offers when a background update to it is waiting: take the
 * newer draft (replacing the reviewer's values), or - when the suggestion was resolved from
 * elsewhere - remove it from the list. Nothing happens to the card until the button is pressed;
 * accepting or dismissing meanwhile uses the reviewer's values and clears the wait.
 */
export default function PendingUpdateNotice({ pendingUpdate, busy, onTake }) {
  if (!pendingUpdate) return null
  const refreshed = pendingUpdate.row !== null && pendingUpdate.row !== undefined
  return (
    <div role="status" data-testid="pending-update" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
      <span>{refreshed ? 'A newer draft of this suggestion arrived. Your edits are kept.' : 'This suggestion was handled elsewhere. Your edits are kept until you decide.'}</span>
      <button type="button" onClick={onTake} disabled={busy}
              className="text-accent hover:opacity-80 disabled:opacity-40">
        {refreshed ? 'Use newer draft' : 'Remove from list'}
      </button>
    </div>
  )
}
