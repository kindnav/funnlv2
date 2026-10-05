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
// tests/sql/outlook-disconnect-runtime.sql and over real HTTP through PostgREST
// by tests/local/outlook-rpc-postgrest.mjs. The outcomes differ, and the user is
// told which is which:
//
//   DELETED  the connection row, the encrypted access and refresh tokens, the
//            mailbox sync cursors and leases, any unconsumed OAuth state, and
//            the stored links from a suggestion back to a mail message.
//   INVALIDATED
//            suggestions not yet reviewed. The rows REMAIN, marked invalidated, with
//            every proposed field, draft and retained subject set to NULL - but they
//            still carry contact_id, the proposed date and the episode fingerprint
//            (measured: tests/sql/outlook-pilot-retention-runtime.sql case 3c). So
//            this must not be described as deletion, and not as emptying either:
//            what is left identifies a contact and a date. It is deleted when the
//            user deletes that contact or their account.
//   KEPT     contacts and interactions already saved. Disconnecting a mailbox
//            is not a request to delete the user's CRM.
//
// TWO THINGS IT CANNOT DO, AND MUST NOT PROMISE.
//
//   1. It does not revoke Funnl's grant at Microsoft. No upstream revocation
//      call exists in this codebase, so a deleted refresh token stays valid at
//      Microsoft until it expires or the user removes Funnl from their account.
//
//   2. It does not stop work already in flight. The RPC deletes rows; it cannot
//      reach inside a request that is already running and already holds an
//      access token it fetched earlier. What it guarantees is that nothing can
//      obtain a NEW token or start a NEW read. So the copy says Funnl 'has no
//      credential left and cannot start a new read', never that access has
//      already stopped everywhere at that instant.

import { canStartOauthFrom } from './oauthStartEndpoint.js'

/**
 * The exact consequences shown in the confirmation, as data rather than markup
 * so a test can assert each one against the database behaviour it describes.
 * `effect` is the verified verb: deleted, invalidated, kept, in_flight or
 * upstream. `emptied` was removed deliberately - tests/sql/outlook-pilot-retention-runtime.sql
 * shows the retained suggestion row still carries its contact, proposed date and
 * episode fingerprint after a disconnect, so calling it empty was false.
 */
export const DISCONNECT_CONSEQUENCES = Object.freeze([
  Object.freeze({
    effect: 'deleted',
    text: 'The connection and the stored Microsoft authorisation are deleted, so Funnl has no credential left and cannot start a new read of your mailbox.',
  }),
  Object.freeze({
    effect: 'in_flight',
    // Deliberately not an absolute promise. The RPC deletes Funnl's stored
    // credentials; it cannot reach inside a request that is already running and
    // already holds an access token it obtained earlier.
    text: 'A read that is already under way may finish using access it had already obtained. It has no way to obtain more.',
  }),
  Object.freeze({
    effect: 'deleted',
    text: 'The mailbox synchronisation state is deleted, along with any unfinished sign-in request.',
  }),
  Object.freeze({
    effect: 'invalidated',
    // MEASURED, not described: run_microsoft_local_cleanup sets status 'invalidated'
    // and nulls the proposed values, and the ROW REMAINS - with contact_id, the
    // proposed date and the episode fingerprint intact. See
    // tests/sql/outlook-pilot-retention-runtime.sql case 3c.
    text: 'Suggestions you have not reviewed are invalidated: each is marked inactive and its proposed details, drafts and retained subject lines are cleared. The record itself is kept, still holding the contact it was about, the proposed date and a one-way fingerprint of the exchange, so the same conversation is not suggested again. It is deleted when you delete that contact or your Funnl account.',
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
      return 'Outlook is disconnected. Funnl has no stored credential left and cannot start a new read of your mailbox.'
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
