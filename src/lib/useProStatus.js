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
 *   object         → 'permanent' | 'trial' | 'expired' | 'non_pro'
 *
 * Usage:
 *   Wrap the authenticated shell in <ProStatusProvider>.
 *   Consume with:  const proStatus = useProStatus()
 *   Classify with: const displayStatus = classifyProStatus(proStatus)
 *   Gate AI with:  const canUsePro = displayStatus === 'permanent' || displayStatus === 'trial'
 */
import { createContext, createElement, useCallback, useContext, useEffect, useState } from 'react'
import { getProAccessStatus } from './pro-access-status'

// Context shape: { status: null | 'error' | object, refresh: () => Promise<void> }
// Default refresh is a no-op so consumers outside the provider never throw.
const ProStatusContext = createContext({ status: null, refresh: async () => {} })

export function ProStatusProvider({ children }) {
  // null = loading; 'error' = RPC failed/unavailable; object = loaded status
  const [proStatus, setProStatus] = useState(null)

  // Initial load — runs once on mount.
  useEffect(() => {
    let active = true
    getProAccessStatus().then(status => {
      if (!active) return
      // null from RPC means "unavailable" — store 'error' to distinguish from loading null
      setProStatus(status ?? 'error')
    })
    return () => { active = false }
  }, [])

  // Stable refresh function — stable reference across renders so consumers do not
  // re-render from a changing callback reference. Calls the RPC and updates the
  // shared provider state so every consumer (Sidebar, FunnlAIPage, Settings…) sees
  // the fresh result without a per-component RPC call.
  const refresh = useCallback(async () => {
    const status = await getProAccessStatus()
    setProStatus(status ?? 'error')
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
