// Connected status, and the user-controlled disconnect.
//
// WHAT THE BROWSER IS ALLOWED TO DO HERE
// Both calls are plain PostgREST RPCs made with the publishable anon key and
// the signed-in user's JWT. Neither function takes a user id: the database
// derives the caller from auth.uid(), so a request cannot name someone else's
// mailbox. No service-role key is involved, and none may ever reach this file -
// a service-role key in the browser would let any visitor read and delete every
// user's connection.
//
//   get_my_outlook_connection()   SECURITY DEFINER, STABLE, authenticated-only.
//                                 Returns only what the card displays; never a
//                                 token, ciphertext, nonce or connection id.
//   disconnect_my_outlook()       SECURITY DEFINER, authenticated-only, already
//                                 applied. Returns 'disconnected',
//                                 'not_connected' or 'unauthorized'.
//
// WHAT DISCONNECT ACTUALLY DOES - the wording below is not a summary, it is the
// verified behaviour of the applied RPC, proven on a disposable database by
// tests/sql/outlook-disconnect-runtime.sql. The three outcomes differ and the
// user is told which is which:
//
//   DELETED  the connection row, the encrypted access and refresh tokens, the
//            mailbox sync cursors and leases, any unconsumed OAuth state, and
//            the stored links from a suggestion back to a mail message.
//   EMPTIED  suggestions not yet reviewed. The rows remain, marked invalidated,
//            with every proposed field, draft and retained subject set to NULL.
//            They are NOT deleted, so this must not be described as deletion.
//   KEPT     contacts and interactions already saved. Disconnecting a mailbox
//            is not a request to delete the user's CRM.
//
// WHAT IT DOES NOT DO: it does not revoke Funnl's grant at Microsoft. No
// upstream revocation call exists in this codebase. Saying otherwise would tell
// users a permission had been withdrawn when it had not, so the copy below
// points them at their Microsoft account instead.

import { canStartOauthFrom } from './oauthStartEndpoint.js'

/**
 * The exact consequences shown in the confirmation, as data rather than markup
 * so a test can assert each one against the database behaviour it describes.
 * `effect` is the verified verb: deleted, emptied or kept.
 */
export const DISCONNECT_CONSEQUENCES = Object.freeze([
  Object.freeze({
    effect: 'deleted',
    text: 'The connection and the stored Microsoft authorisation are deleted, so Funnl can no longer reach your mailbox.',
  }),
  Object.freeze({
    effect: 'deleted',
    text: 'The mailbox synchronisation state is deleted, along with any unfinished sign-in request.',
  }),
  Object.freeze({
    effect: 'emptied',
    text: 'Suggestions you have not reviewed are emptied: each one is marked inactive and its proposed details, drafts and retained subject lines are removed. The empty record itself is kept.',
  }),
  Object.freeze({
    effect: 'kept',
    text: 'Contacts and interactions you already saved are kept. Disconnecting does not delete anything in your Funnl network.',
  }),
  Object.freeze({
    effect: 'upstream',
    text: 'This removes Funnl’s copy. It does not withdraw the permission at Microsoft — to do that, remove Funnl from the permissions page of your Microsoft account.',
  }),
])

/** Reconnecting is a fresh consent, so this is reversible without data loss of saved records. */
export const DISCONNECT_CONFIRM_LABEL = 'Yes, disconnect Outlook'

/**
 * Interpret get_my_outlook_connection(). Never throws.
 * @returns {{kind: 'connected'|'not_connected'|'signed_out'|'error', connection?: object}}
 */
export function classifyStatusResponse (error, data) {
  if (error) {
    // A missing grant or an expired session both surface as a PostgREST error.
    // Neither is a state the card can act on, so both read as "not signed in"
    // only when the RPC itself said so; anything else stays a generic failure.
    return { kind: 'error' }
  }
  const result = data && typeof data === 'object' ? data.result : null
  if (result === 'connected') {
    return {
      kind: 'connected',
      connection: {
        mailbox: typeof data.mailbox === 'string' ? data.mailbox : '',
        accountType: data.account_type === 'work' ? 'work' : 'personal',
        status: typeof data.status === 'string' ? data.status : '',
        needsReauth: data.needs_reauth === true,
        connectedAt: typeof data.connected_at === 'string' ? data.connected_at : '',
        consentVersion: typeof data.consent_policy_version === 'string'
          ? data.consent_policy_version
          : '',
        scopes: Array.isArray(data.scopes) ? data.scopes.filter((s) => typeof s === 'string') : [],
      },
    }
  }
  if (result === 'not_connected') return { kind: 'not_connected' }
  if (result === 'unauthorized') return { kind: 'signed_out' }
  return { kind: 'error' }
}

/** Interpret disconnect_my_outlook(). Never throws. */
export function classifyDisconnectResponse (error, data) {
  if (error) return { kind: 'error' }
  const result = data && typeof data === 'object' ? data.result : null
  if (result === 'disconnected') return { kind: 'disconnected' }
  // Already gone - another tab, or a connection that had been revoked. The
  // user's intent is satisfied either way, so this is not an error to them.
  if (result === 'not_connected') return { kind: 'already_disconnected' }
  if (result === 'unauthorized') return { kind: 'signed_out' }
  return { kind: 'error' }
}

/** User-facing copy. Never echoes a database or PostgREST message. */
export function messageForDisconnect (kind) {
  switch (kind) {
    case 'disconnected':
      return 'Outlook is disconnected. Funnl can no longer reach your mailbox.'
    case 'already_disconnected':
      return 'Outlook was already disconnected.'
    case 'signed_out':
      return 'Your session has expired. Sign in again and retry.'
    case 'not_confirmed':
      return 'Please confirm before disconnecting.'
    case 'non_canonical_origin':
      return 'Please continue at www.getfunnl.com.'
    default:
      return 'Could not disconnect Outlook. Please try again.'
  }
}

/** Copy for the status area when the connection is not usable as-is. */
export function messageForStatus (kind) {
  switch (kind) {
    case 'signed_out':
      return 'Your session has expired. Sign in again to see your Outlook connection.'
    case 'error':
      return 'Could not check your Outlook connection.'
    default:
      return ''
  }
}

/**
 * Read the connection status. Injectable so the whole flow can be driven in a
 * test without a browser or a database.
 *
 * @param {object} p
 * @param {() => Promise<{data: any, error: any}>} p.rpc calls get_my_outlook_connection
 */
export async function loadOutlookStatus ({ rpc }) {
  let res
  try {
    res = await rpc()
  } catch {
    return { kind: 'error', message: messageForStatus('error') }
  }
  const out = classifyStatusResponse(res?.error, res?.data)
  return { ...out, message: messageForStatus(out.kind) }
}

/**
 * Disconnect, but only after an explicit confirmation.
 *
 * `confirmed` is the second step of a two-step control, not the button press
 * itself: the card opens a panel listing exactly what happens, and only the
 * button inside that panel sets this true. An unconfirmed call performs NO RPC
 * at all, which is the property worth testing.
 *
 * Returns { kind, message, disconnected } and never throws.
 *
 * @param {object} p
 * @param {boolean} p.confirmed
 * @param {boolean} p.disconnecting  a request is already in flight
 * @param {string}  p.pageOrigin
 * @param {() => Promise<string|null>} p.getBearer
 * @param {() => Promise<{data: any, error: any}>} p.rpc calls disconnect_my_outlook
 * @param {(name: string, props?: object) => void} [p.trackImpl]
 */
export async function runOutlookDisconnect ({
  confirmed, disconnecting, pageOrigin,
  getBearer, rpc, trackImpl = () => {},
}) {
  if (confirmed !== true || disconnecting === true) {
    return { kind: 'not_confirmed', message: messageForDisconnect('not_confirmed'), disconnected: false }
  }
  if (!canStartOauthFrom(pageOrigin)) {
    return { kind: 'non_canonical_origin', message: messageForDisconnect('non_canonical_origin'), disconnected: false }
  }

  // The database is the authority - it refuses an unauthenticated caller. This
  // check only avoids a pointless round trip and gives a clearer message.
  let bearer = null
  try {
    bearer = await getBearer()
  } catch {
    bearer = null
  }
  if (!bearer) {
    return { kind: 'signed_out', message: messageForDisconnect('signed_out'), disconnected: false }
  }

  let res
  try {
    res = await rpc()
  } catch {
    return { kind: 'error', message: messageForDisconnect('error'), disconnected: false }
  }
  const out = classifyDisconnectResponse(res?.error, res?.data)
  const disconnected = out.kind === 'disconnected' || out.kind === 'already_disconnected'
  if (out.kind === 'disconnected') {
    trackImpl('outlook_disconnected', { provider: 'outlook' })
  }
  return { kind: out.kind, message: messageForDisconnect(out.kind), disconnected }
}
