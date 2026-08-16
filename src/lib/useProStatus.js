/**
 * Shared Pro-status context for the authenticated shell.
 *
 * ProStatusProvider makes one getProAccessStatus() RPC call per app mount and
 * broadcasts the result to all descendants. This replaces per-component fetches
 * in BottomNav, CommandPalette, and future Dashboard modules — preventing N
 * identical RPCs on every page load.
 *
 * useProStatus() returns:
 *   null      — initial; RPC not yet resolved (loading)
 *   'error'   — RPC returned null (network, auth, DB failure) — status unavailable
 *   object    — successful get_my_pro_access_status() response
 *
 * Classification (via classifyProStatus from pro-ui-status.js):
 *   null / 'error' → 'unavailable' → canUsePro = false  (fail closed, no flash)
 *   object         → 'permanent' | 'subscribed' | 'trial' | 'expired' | 'non_pro'
 *
 * Usage:
 *   Wrap the authenticated shell in <ProStatusProvider>.
 *   Consume with:  const proStatus = useProStatus()
 *   Gate AI with:  const canUsePro = hasProAccess(proStatus)   // from pro-ui-status.js
 *   Badge display: const displayStatus = classifyProStatus(proStatus)
 */
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { getProAccessStatus } from './pro-access-status'
import { supabase } from './supabase'
import { createProStatusController } from './proStatusController'

// Context shape:
//   { status, refresh, authUserId, accountGeneration }
// authUserId / accountGeneration expose the AUTHORITATIVE authenticated identity so
// consumers (e.g. Settings checkout polling) do not depend on a separately-loaded
// profile/user object. Defaults are safe no-ops for consumers outside the provider.
const ProStatusContext = createContext({
  status: null,
  refresh: async () => 'error',
  authUserId: null,
  accountGeneration: 0,
})

export function ProStatusProvider({ children }) {
  // null = loading/unavailable-after-switch; 'error' = RPC failed; object = loaded status.
  const [proStatus, setProStatus] = useState(null)
  // Authoritative auth identity mirrored into React state so consumers re-render.
  const [authUserId, setAuthUserId] = useState(null)
  const [accountGeneration, setAccountGeneration] = useState(0)

  // One production request-sequencing controller owns "may this result apply?".
  const ctlRef = useRef(null)
  if (!ctlRef.current) ctlRef.current = createProStatusController()
  const ctl = ctlRef.current

  // Account-aware load: subscribe to auth changes (supabase-js emits INITIAL_SESSION on
  // subscribe, so the initial load happens here too). onAuth decides ignore / clear /
  // fetch and mints a fresh request token that invalidates all prior in-flight requests.
  useEffect(() => {
    ctl.activate()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const { action, token, uid } = ctl.onAuth(session?.user?.id ?? null)
      if (action === 'ignore') return   // same UID (e.g. token refresh) — keep valid state

      setAuthUserId(uid)
      setAccountGeneration(ctl.accountGeneration)
      setProStatus(null)                // fail-closed: cannot grant Pro during a transition

      if (action === 'clear') return    // signed out — no fetch

      getProAccessStatus().then(status => {
        if (!ctl.canApply(token, uid)) return   // stale (superseded / switched / unmounted)
        setProStatus(status ?? 'error')
      })
    })
    return () => {
      ctl.deactivate()
      subscription?.unsubscribe?.()
    }
  }, [ctl])

  // Stable refresh: mints a NEW request token so an older same-UID refresh is superseded.
  // Discards its result (returns 'error', a non-granting sentinel) if it is no longer the
  // newest request for the current UID, was switched away, or the provider unmounted.
  const refresh = useCallback(async () => {
    const { token, uid } = ctl.beginRefresh()
    const status = await getProAccessStatus()
    const normalized = status ?? 'error'
    if (!ctl.canApply(token, uid)) {
      return 'error'   // stale — do not overwrite newer state; fail closed for the caller
    }
    setProStatus(normalized)
    return normalized
  }, [ctl])

  // No JSX in .js files — use createElement directly.
  return createElement(
    ProStatusContext.Provider,
    { value: { status: proStatus, refresh, authUserId, accountGeneration } },
    children,
  )
}

/**
 * Returns the current Pro status from context.
 * Returns null before the RPC resolves (loading state).
 */
export function useProStatus() {
  return useContext(ProStatusContext).status
}

/**
 * Returns the shared refresh function from context. refresh() re-runs
 * getProAccessStatus(), updates shared state when it is the newest request, and returns
 * the fetched status (or 'error' when stale/failed).
 */
export function useProRefresh() {
  return useContext(ProStatusContext).refresh
}

/**
 * Returns the authoritative authenticated user id (null until auth resolves / after
 * sign-out). Consumers that must not act until the UID is known should wait for a
 * non-null value.
 */
export function useProAuthUserId() {
  return useContext(ProStatusContext).authUserId
}

/**
 * Returns the account generation — a counter bumped ONLY on account transitions (real
 * UID change or sign-out), not on ordinary refreshes. Use with authUserId to detect an
 * account switch during a long-running operation.
 */
export function useProAccountGeneration() {
  return useContext(ProStatusContext).accountGeneration
}
