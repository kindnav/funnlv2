/**
 * useContactPicker — shared data hook for contact-picker surfaces.
 *
 * Fetches all contacts once on mount (id, name, company, role), then filters
 * client-side as the user types. Matching: name OR company OR role,
 * case-insensitive. Max 20 results returned in `filtered`.
 *
 * Pass `preloadedContacts` to skip the Supabase fetch (e.g., when the parent
 * page has already loaded contacts). The hook filters client-side from that
 * array; no network request is made.
 *
 * Returns:
 *   query       — current search string
 *   setQuery    — update the search string
 *   contacts    — all loaded contacts (unfiltered, empty array while loading)
 *   filtered    — filtered + capped at 20
 *   loading     — true while the initial fetch is in progress
 *   error       — Error | null
 *   retry       — fn() re-triggers the fetch (clears error, resets loading)
 */
import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { filterContacts } from './contactPickerUtils'

// Re-export so callers can import from one place.
export { filterContacts, buildPickerNavigationState } from './contactPickerUtils'

export function useContactPicker({ preloadedContacts } = {}) {
  const hasPreloaded = Array.isArray(preloadedContacts)

  const [allContacts, setAllContacts] = useState(hasPreloaded ? preloadedContacts : null)
  const [loading, setLoading]         = useState(!hasPreloaded)
  const [error, setError]             = useState(null)
  const [query, setQuery]             = useState('')

  const fetchContacts = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('contacts')
      .select('id, name, company, role')
      .order('created_at', { ascending: false })
    if (err) {
      setError(err)
    } else {
      setAllContacts(data || [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (hasPreloaded) return
    fetchContacts()
  }, [hasPreloaded, fetchContacts])

  const contacts = allContacts ?? []
  const filtered = filterContacts(contacts, query)

  return {
    query,
    setQuery,
    contacts,   // all loaded, unfiltered — used by results component for empty-state check
    filtered,   // filtered + capped at 20
    loading,
    error,
    retry: fetchContacts,
  }
}
