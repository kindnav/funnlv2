// The ONE finalize refusal the callback reports with its own value.
//
// Kept in the callback's own folder on purpose. `buildOutlookSettingsRedirect` in
// shared/microsoftOauthHelpers.js is imported by every Outlook function (start, callback,
// notifications and the worker), so changing it would change all four deployed bundles for a
// behaviour only this callback has. Here, only outlook-oauth-callback's import closure moves.
//
// `account_in_use` (migration 20261014000000): the Microsoft account the person has just
// signed in to is already connected to a DIFFERENT Funnl account, so
// finalize_microsoft_connection refused it and wrote nothing. The redirect says only that.
// It never names, counts or identifies the other Funnl account.

/** The finalize result this module maps. Every other non-'stored' result stays the generic error. */
export const ACCOUNT_IN_USE_RESULT = 'account_in_use'

/**
 * The Settings redirect for a refusal, or null when the generic error redirect applies.
 *
 * Only an exact `account_in_use` from the RPC, and only with an origin the caller has already
 * validated (the state row's server-validated return origin). Anything else returns null.
 *
 * @param {string|null|undefined} trustedOrigin
 * @param {unknown} result  finalize_microsoft_connection's `result`
 * @returns {string|null}
 */
export function refusalRedirect (trustedOrigin, result) {
  if (result !== ACCOUNT_IN_USE_RESULT) return null
  if (typeof trustedOrigin !== 'string' || trustedOrigin.length === 0) return null
  return `${trustedOrigin}/settings?outlook=in_use`
}
