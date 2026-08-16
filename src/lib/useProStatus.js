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
import { proStatusTransition, shouldApplyProStatusResult } from './proStatusGeneration'

// Context shape: { status: null | 'error' | object, refresh: () => Promise<...> }
// Default refresh is a no-op so consumers outside the provider never throw.
const ProStatusContext = createContext({ status: null, refresh: async () => {} })

export function ProStatusProvider({ children }) {
  // null = loading/unavailable-after-switch; 'error' = RPC failed; object = loaded status.
  const [proStatus, setProStatus] = useState(null)

  // The UID whose status is currently loaded, and a request generation that is bumped
  // on every account change/refresh. An async result may only be applied when BOTH the
  // captured UID and generation still match — see shouldApplyProStatusResult.
  const currentUidRef = useRef(null)
  const genRef        = useRef(0)
  const activeRef     = useRef(true)

  // Account-aware load: subscribe to auth changes (supabase-js emits INITIAL_SESSION on
  // subscribe, so the initial load happens here too). On a genuine UID change we
  // synchronously invalidate the previous generation, clear the previous status (so the
  // old account's can_use_pro can never leak), and fetch the new user's status. On
  // sign-out we clear and do NOT fetch. A same-UID event (e.g. token refresh) is ignored
  // so valid state is not needlessly discarded.
  useEffect(() => {
    activeRef.current = true
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const newUid = session?.user?.id ?? null
      const action = proStatusTransition(currentUidRef.current, newUid)
      if (action === 'ignore') return

      currentUidRef.current = newUid
      const gen = ++genRef.current   // invalidate any in-flight fetch/refresh
      setProStatus(null)             // fail-closed: cannot grant Pro during transition

      if (action === 'clear') return // signed out — no fetch

      getProAccessStatus().then(status => {
        if (!activeRef.current) return
        if (!shouldApplyProStatusResult(newUid, gen, currentUidRef.current, genRef.current)) return
        setProStatus(status ?? 'error')
      })
    })
    return () => {
      activeRef.current = false
      subscription?.unsubscribe?.()
    }
  }, [])

  // Stable refresh: captures the current UID + generation and discards its result if
  // either changed (account switch or a newer request superseded it). Returns the
  // fetched status for callers that need it (e.g. checkout polling), or 'error' when the
  // result is stale so any caller that reads it fails closed.
  const refresh = useCallback(async () => {
    const uidAtStart = currentUidRef.current
    const genAtStart = genRef.current
    const status = await getProAccessStatus()
    const normalized = status ?? 'error'
    if (!activeRef.current) return normalized
    if (!shouldApplyProStatusResult(uidAtStart, genAtStart, currentUidRef.current, genRef.current)) {
      return 'error'   // stale — do not overwrite the newer account's state; fail closed
    }
    setProStatus(normalized)
    return normalized
  }, [])

  // No JSX in .js files — use createElement directly.
  return createElement(ProStatusContext.Provider, { value: { status: proStatus, refresh } }, children)
}

/**
 * Returns the current Pro status from context.
 * Must be used inside <ProStatusProvider>.
 * Returns null before the RPC resolves (loading state).
 */
export function useProStatus() {
  return useContext(ProStatusContext).status
}

/**
 * Returns the shared refresh function from context.
 * Calling refresh() re-runs getProAccessStatus() and updates the provider state,
 * so every consumer of useProStatus() receives the fresh value.
 * Must be used inside <ProStatusProvider>.
 */
export function useProRefresh() {
  return useContext(ProStatusContext).refresh
}
