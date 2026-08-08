/**
 * GlobalAddContactController
 *
 * Shell-level controller that provides one shared AddContactDrawer for add
 * mode, accessible from every authenticated route.
 *
 * Mounted once in App.jsx inside the authenticated shell alongside
 * BottomNav and CommandPalette. Listens for the established global event:
 *
 *   window.dispatchEvent(new CustomEvent('funnl:open-add-contact'))
 *
 * dispatched by: BottomNav, CommandPalette, and all direct Add contact CTAs
 * that previously had page-local drawers (Dashboard, Contacts).
 *
 * On open:
 *   - Captures the element that had focus (for keyboard restoration)
 *   - Fetches the user's contact list (id, name, company) for duplicate detection
 *   - Renders a single AddContactDrawer in add mode
 *
 * On close (cancel):
 *   - Restores focus to the element that had focus when the drawer opened
 *
 * On success (contact saved):
 *   - First contact → navigates to /contacts/:id with openInteractionForm
 *   - Later contact → dispatches funnl:contacts-changed; stays on current route
 *   - Restores focus in both cases
 *
 * Guards:
 *   - Ignores open events while the drawer is already open (no stacking)
 *   - Single listener registered once on mount, removed on unmount
 *   - Edit mode is never triggered — ContactDetailPage handles its own edit drawer
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AddContactDrawer from './AddContactDrawer'
import { resolveAddResult, shouldOpenDrawer } from '../lib/globalAddContactUtils'

export default function GlobalAddContactController() {
  const [open, setOpen] = useState(false)
  const [contacts, setContacts] = useState([])
  const [prefillName, setPrefillName] = useState(null)
  // openKey forces a fresh AddContactDrawer mount on every open so the
  // useState initializer for `name` (which reads initialName) re-executes.
  // Without this, switching from remount → conditional-render strategies
  // would silently break the initialName lifecycle.
  const [openKey, setOpenKey] = useState(0)
  const navigate = useNavigate()

  // Ref tracks the current open state so the event handler (registered once)
  // can read it without needing to be re-registered on every state change.
  const openRef = useRef(false)
  useEffect(() => { openRef.current = open }, [open])

  // The DOM element that had focus when the drawer opened — restored on close.
  const focusRestoreRef = useRef(null)

  // Register one global listener on mount; clean up on unmount.
  useEffect(() => {
    function handler(e) {
      if (!shouldOpenDrawer(openRef.current)) return  // already open — no stacking
      focusRestoreRef.current = document.activeElement
      // Read optional name prefill from CommandPalette "Add X as contact" action.
      const name = e?.detail?.prefillName ?? null
      setPrefillName(typeof name === 'string' && name.trim() ? name.trim() : null)
      // Increment openKey to guarantee AddContactDrawer remounts on every open,
      // so the useState initializer for the name field always reads initialName fresh.
      setOpenKey(k => k + 1)
      // Lightweight fetch: id + name + company only — used for duplicate detection.
      supabase
        .from('contacts')
        .select('id, name, company')
        .then(({ data }) => setContacts(data || []))
      setOpen(true)
      openRef.current = true
    }
    window.addEventListener('funnl:open-add-contact', handler)
    return () => window.removeEventListener('funnl:open-add-contact', handler)
  }, [])  // empty — register once

  function restoreFocus() {
    const el = focusRestoreRef.current
    focusRestoreRef.current = null
    setTimeout(() => { try { el?.focus() } catch (_) {} }, 0)
  }

  const handleClose = useCallback(() => {
    setOpen(false)
    restoreFocus()
  }, [])

  const handleSuccess = useCallback(({ id, isFirstContact }) => {
    setOpen(false)
    restoreFocus()
    const result = resolveAddResult({ id, isFirstContact })
    if (result.action === 'navigate-first') {
      navigate(result.path, { state: result.state })
    } else if (result.action === 'emit-changed') {
      window.dispatchEvent(new CustomEvent('funnl:contacts-changed'))
    }
  }, [navigate])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(20,17,15,0.45)', animation: 'fade-in 0.2s ease-out' }}
        onClick={handleClose}
      />
      <AddContactDrawer
        key={openKey}
        contacts={contacts}
        onClose={handleClose}
        onSuccess={handleSuccess}
        initialName={prefillName}
      />
    </>
  )
}
