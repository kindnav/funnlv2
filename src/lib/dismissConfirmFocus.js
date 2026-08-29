// Pure focus-target decision for the inline dismiss-confirm flow on a Calendar review
// card (Phase B). No React/DOM imports — safe to unit-test in plain Node.
//
// Keyboard-focus contract:
//   'open'   → focus the confirmation's primary button ("Yes, dismiss")
//   'cancel' → restore focus to the initiating "Dismiss" button (Cancel clicked)
//   'escape' → restore focus to the initiating "Dismiss" button (Escape pressed)
//
// Regression guard: before this fix, cancelling the confirmation (Cancel OR Escape)
// left document.activeElement on <body>. Both cancel paths must resolve to 'dismiss'
// so the component restores focus to the button that opened the confirmation.
export function dismissConfirmFocusTarget(action) {
  switch (action) {
    case 'open':   return 'confirm'
    case 'cancel': return 'dismiss'
    case 'escape': return 'dismiss'
    default:       return null
  }
}
