import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getTheme, setTheme } from '../lib/theme'
import { useProStatus, useProRefresh } from '../lib/useProStatus'
import { classifyProStatus } from '../lib/pro-ui-status'
import {
  validateDisplayName,
  normalizeDisplayName,
  isDeleteAllConfirmEligible,
  isDeleteAccountConfirmEligible,
  formatJoined,
  formatTrialEnd,
  summarizeContactCount,
  DISPLAY_NAME_MAX_LENGTH,
} from '../lib/settingsHelpers'
import {
  moveThemeRadio,
  classifyDeleteAccountResponse,
  canCloseDialog,
  THEME_ORDER,
} from '../lib/settingsLifecycle'

// ── Shared style tokens ─────────────────────────────────────────────────────
const SECTION_LABEL =
  'block mb-[10px] font-mono text-[8.5px] font-semibold tracking-[1.5px] text-muted uppercase'
const CARD =
  'bg-card border border-line-1 rounded-xl p-[18px]'
const FOCUSABLE =
  'button:not([disabled]),input:not([disabled]),a[href],select,textarea,[tabindex]:not([tabindex="-1"])'

// Focus-trap keydown handler for modal containers.
// disabled flag prevents closing during a mutation (Escape while deleting is blocked).
function trapFocus(e, onEscape, disabled) {
  if (e.key === 'Escape' && !disabled) { onEscape(); return }
  if (e.key !== 'Tab') return
  const els = [...e.currentTarget.querySelectorAll(FOCUSABLE)]
  if (!els.length) { e.preventDefault(); return }
  const first = els[0]
  const last  = els[els.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus()
  }
}

function SettingsPage() {
  const navigate     = useNavigate()
  const location     = useLocation()
  // Shared Pro status - a single RPC shared across all authenticated surfaces.
  const rawProStatus = useProStatus()
  // Shared refresh - re-runs the RPC and updates rawProStatus for all consumers.
  // Use proRefresh() in retry handlers; never call the access-status RPC directly.
  const proRefresh   = useProRefresh()

  // ── Unmount protection ────────────────────────────────────────────────────
  // Prevents state updates on async handlers that complete after unmount.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  // ── UID-scoped request generation ─────────────────────────────────────────
  // Incremented on every authenticated-UID change. Captured at the start of
  // each async operation and checked after every await; prevents a User A
  // response from updating User B's UI after an account switch.
  const accountGenRef = useRef(0)
  const currentUidRef = useRef(null)

  // ── Page load ─────────────────────────────────────────────────────────────
  const [loading,    setLoading]    = useState(true)
  const [user,       setUser]       = useState(null)
  const [contactCount, setContactCount] = useState(null)  // null until loaded
  // loadKey triggers the load effect to re-run (incremented on account switch).
  const [loadKey, setLoadKey] = useState(0)

  // ── Display name ──────────────────────────────────────────────────────────
  const [displayName,      setDisplayName]      = useState('')
  const [savedDisplayName, setSavedDisplayName] = useState('')
  const [saving,    setSaving]    = useState(false)
  const [saveBanner, setSaveBanner] = useState(false)
  const [saveError,  setSaveError]  = useState('')

  // ── Pro status ─────────────────────────────────────────────────────────────
  // proStatus comes entirely from the shared provider - no local override.
  // Retry calls proRefresh() which updates the provider state for all consumers.
  const proStatus  = rawProStatus
  const [retrying, setRetrying] = useState(false)

  // ── Stripe Checkout ────────────────────────────────────────────────────────
  // checkoutBanner: computed once from URL on mount ('success', 'cancelled', null).
  // subscribing: true while the create-checkout-session call is in flight.
  const [checkoutBanner, setCheckoutBanner] = useState(() => {
    const p = new URLSearchParams(location.search)
    return p.get('checkout')  // 'success' | 'cancelled' | null
  })
  const [subscribing,    setSubscribing]    = useState(false)
  const [subscribeError, setSubscribeError] = useState('')

  // ── Theme ─────────────────────────────────────────────────────────────────
  const [currentTheme, setCurrentTheme] = useState(() => getTheme())

  // ── Sign out ──────────────────────────────────────────────────────────────
  const [signingOut,   setSigningOut]   = useState(false)
  const [signOutError, setSignOutError] = useState('')

  // ── Delete-all contacts ───────────────────────────────────────────────────
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false)
  const [deleteAllInput,     setDeleteAllInput]     = useState('')
  const [deletingAll,        setDeletingAll]        = useState(false)
  const [deleteAllError,     setDeleteAllError]     = useState('')
  const deleteAllInputRef = useRef(null)

  // ── Delete account ────────────────────────────────────────────────────────
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteInput,     setDeleteInput]     = useState('')
  const [deleting,        setDeleting]        = useState(false)
  const [deleteError,     setDeleteError]     = useState('')
  const deleteInputRef = useRef(null)

  // ── Load ──────────────────────────────────────────────────────────────────
  // Runs on mount and whenever loadKey increments (account switch).
  useEffect(() => {
    const capturedGen = accountGenRef.current
    setLoading(true)

    async function load() {
      try {
        const { data: { user: u } } = await supabase.auth.getUser()
        if (!mountedRef.current || accountGenRef.current !== capturedGen) return
        const capturedUid = u?.id ?? null
        currentUidRef.current = capturedUid
        setUser(u)
        if (u) {
          const [profileResult, countResult] = await Promise.all([
            supabase
              .from('profiles')
              .select('display_name')
              .eq('id', u.id)
              .maybeSingle()
              .catch(() => ({ data: null })),
            supabase
              .from('contacts')
              .select('id', { count: 'exact', head: true })
              .eq('user_id', u.id)
              .catch(() => ({ count: 0 })),
          ])
          if (!mountedRef.current || accountGenRef.current !== capturedGen) return
          if (profileResult.data) {
            const name = profileResult.data.display_name || ''
            setDisplayName(name)
            setSavedDisplayName(name)
          }
          setContactCount(countResult.count ?? 0)
        }
      } catch {
        // Unexpected failure - page renders with defaults.
      } finally {
        if (mountedRef.current && accountGenRef.current === capturedGen) setLoading(false)
      }
    }
    load()
  }, [loadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Account-switch reset ──────────────────────────────────────────────────
  // When the authenticated UID changes (account switch in another tab),
  // immediately invalidate in-flight requests, clear all user-scoped state,
  // and restart the fetch for the new user.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        const newUid = session?.user?.id ?? null
        // Only act if we have a loaded user and the UID has changed.
        if (!user?.id || newUid === user.id) return
        // New generation: all in-flight requests for the previous user will bail.
        accountGenRef.current++
        currentUidRef.current = null
        // Clear all user-scoped state, including flags that could block the new user's UI.
        setLoading(true)
        setUser(null)
        setDisplayName('')
        setSavedDisplayName('')
        setSaveBanner(false)
        setSaveError('')
        setSaving(false)
        setContactCount(null)
        setSignOutError('')
        setSigningOut(false)
        setRetrying(false)
        setSubscribing(false)
        setSubscribeError('')
        setCheckoutBanner(null)
        setShowDeleteAllModal(false)
        setDeleteAllInput('')
        setDeleteAllError('')
        setDeletingAll(false)
        setShowDeleteModal(false)
        setDeleteInput('')
        setDeleteError('')
        setDeleting(false)
        // Restart fetch for the new user.
        setLoadKey(k => k + 1)
      }
    )
    return () => subscription.unsubscribe()
  }, [user?.id])

  // ── Contact count refresh listener ────────────────────────────────────────
  // Updates the displayed contact count when other pages add/delete contacts,
  // without a full re-fetch. Stale UID results are silently discarded.
  useEffect(() => {
    async function refreshCount() {
      if (!user?.id) return
      const capturedGen = accountGenRef.current
      const { count } = await supabase
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .catch(() => ({ count: null }))
      if (!mountedRef.current || accountGenRef.current !== capturedGen) return
      if (count !== null) setContactCount(count)
    }
    window.addEventListener('funnl:contacts-changed', refreshCount)
    return () => window.removeEventListener('funnl:contacts-changed', refreshCount)
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus modal inputs when they open.
  useEffect(() => {
    if (showDeleteAllModal && deleteAllInputRef.current) deleteAllInputRef.current.focus()
  }, [showDeleteAllModal])
  useEffect(() => {
    if (showDeleteModal && deleteInputRef.current) deleteInputRef.current.focus()
  }, [showDeleteModal])

  // ── Display-name save ─────────────────────────────────────────────────────
  async function handleSave(e) {
    e.preventDefault()
    const capturedGen = accountGenRef.current
    const validation = validateDisplayName(displayName)
    if (!validation.valid) { setSaveError(validation.message); return }
    const normalized = normalizeDisplayName(displayName)
    if (normalized === savedDisplayName) return
    setSaving(true)
    setSaveError('')
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: normalized || null, updated_at: new Date().toISOString() })
      .eq('id', user.id)
    if (!mountedRef.current || accountGenRef.current !== capturedGen) return
    setSaving(false)
    if (error) { setSaveError('Could not save. Please try again.'); return }
    setDisplayName(normalized)
    setSavedDisplayName(normalized)
    setSaveBanner(true)
    setTimeout(() => { if (mountedRef.current && accountGenRef.current === capturedGen) setSaveBanner(false) }, 3000)
    // Notify Sidebar and other consumers so the displayed name updates without reload.
    window.dispatchEvent(new Event('funnl:profile-changed'))
  }

  // ── Pro-status retry ──────────────────────────────────────────────────────
  // Delegates to the shared provider - updates proStatus for ALL consumers.
  async function handleProRetry() {
    if (retrying) return
    const capturedGen = accountGenRef.current
    setRetrying(true)
    await proRefresh()
    if (!mountedRef.current || accountGenRef.current !== capturedGen) return
    setRetrying(false)
  }

  // ── Sign out ──────────────────────────────────────────────────────────────
  async function handleSignOut() {
    if (signingOut) return
    const capturedGen = accountGenRef.current
    setSigningOut(true)
    setSignOutError('')
    const { error } = await supabase.auth.signOut()
    if (!mountedRef.current || accountGenRef.current !== capturedGen) return
    if (error) {
      setSigningOut(false)
      setSignOutError('Could not sign out. Please try again.')
      return
    }
    navigate('/signin', { replace: true })
  }

  // ── Delete-all contacts ───────────────────────────────────────────────────
  function openDeleteAllModal() {
    setShowDeleteModal(false)   // no simultaneous alertdialogs
    setDeleteAllInput('')
    setDeleteAllError('')
    setShowDeleteAllModal(true)
  }
  function closeDeleteAllModal() {
    if (!canCloseDialog(deletingAll)) return
    setShowDeleteAllModal(false)
  }
  async function handleDeleteAll() {
    if (!isDeleteAllConfirmEligible(deleteAllInput) || deletingAll) return
    const capturedGen = accountGenRef.current
    setDeletingAll(true)
    setDeleteAllError('')
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('user_id', user.id)
    if (!mountedRef.current || accountGenRef.current !== capturedGen) return
    if (error) {
      setDeleteAllError('Could not delete. Please try again.')
      setDeletingAll(false)
      return
    }
    setContactCount(0)
    setDeleteAllInput('')   // clear confirmation phrase after success
    setDeletingAll(false)
    setShowDeleteAllModal(false)
    // Notify other pages so their contact lists and dashboard stats refresh.
    window.dispatchEvent(new Event('funnl:contacts-changed'))
    // Notify Sidebar/BottomNav so their follow-up badge clears (cascaded interactions deleted).
    window.dispatchEvent(new Event('funnl:followups-changed'))
  }

  // ── Delete account ────────────────────────────────────────────────────────
  // PARTIAL-FAILURE NOTE: deletion is not atomic across Supabase Auth and Postgres.
  // Order: (1) verify JWT, (2) delete contacts, (3) delete auth user.
  // If step 2 succeeds and step 3 fails, contacts are gone but the account remains.
  // Retry is safe: deleting 0 contact rows succeeds; deleteUser on a confirmed user
  // re-attempts auth deletion. The failure is reported to the user as retryable.
  function openDeleteModal() {
    setShowDeleteAllModal(false)   // no simultaneous alertdialogs
    setDeleteInput('')
    setDeleteError('')
    setShowDeleteModal(true)
  }
  function closeDeleteModal() {
    if (!canCloseDialog(deleting)) return
    setShowDeleteModal(false)
  }
  async function handleDeleteAccount() {
    if (!isDeleteAccountConfirmEligible(deleteInput) || deleting) return
    const capturedGen = accountGenRef.current
    setDeleting(true)
    setDeleteError('')
    const { data, error } = await supabase.functions.invoke('delete-account')
    if (!mountedRef.current || accountGenRef.current !== capturedGen) return
    const result = classifyDeleteAccountResponse(error, data)
    if (!result.ok) {
      setDeleteError('Something went wrong. Please try again.')
      setDeleting(false)
      return
    }
    await supabase.auth.signOut()
    navigate('/signup', { replace: true })
  }

  // ── Theme keyboard navigation ─────────────────────────────────────────────
  // W3C radiogroup pattern: Arrow keys move selection with wrapping, Home/End jump
  // to first/last. Focus follows selection. IME composition is guarded.
  function handleThemeKeyDown(e) {
    if (e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229) return
    const next = moveThemeRadio(THEME_ORDER, currentTheme, e.key)
    if (next === null) return
    e.preventDefault()
    setCurrentTheme(next)
    setTheme(next)
    // Move DOM focus to the newly selected radio button after React re-renders.
    const group = e.currentTarget
    requestAnimationFrame(() => {
      group.querySelector(`[data-theme-option="${next}"]`)?.focus()
    })
  }

  // ── Checkout return: clean up URL and refresh Pro status ─────────────────
  // checkoutBanner is set from the URL on mount. Navigate immediately to /settings
  // to remove the ?checkout= param from the address bar, then refresh Pro status
  // so the card reflects the new subscription (the webhook may have already fired).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!checkoutBanner) return
    navigate('/settings', { replace: true })
    if (checkoutBanner === 'success') {
      proRefresh()
      const t = setTimeout(() => proRefresh(), 3000)
      return () => clearTimeout(t)
    }
  }, []) // intentionally runs only on mount

  // ── Stripe Checkout: create session and redirect ──────────────────────────
  async function handleSubscribe() {
    if (subscribing) return
    const capturedGen = accountGenRef.current
    setSubscribing(true)
    setSubscribeError('')
    const { data, error } = await supabase.functions.invoke('create-checkout-session')
    if (!mountedRef.current || accountGenRef.current !== capturedGen) return
    setSubscribing(false)
    if (error || !data?.url) {
      setSubscribeError('Could not start checkout. Please try again.')
      return
    }
    window.location.href = data.url
  }

  // ── Pro-status classification ─────────────────────────────────────────────
  const proLoading = proStatus === null
  const proFailed  = !proLoading && proStatus === 'error'
  const proClass   = (proLoading || proFailed) ? null : classifyProStatus(proStatus)

  // ── Render ────────────────────────────────────────────────────────────────
  // The page shell renders immediately. Sign out, Appearance, and Pro Access
  // are all available before the profile/count fetch completes. The Profile
  // card shows per-field loading states while `loading` is true.
  return (
    <div className="min-h-screen bg-surface px-4 py-6 md:px-10 md:py-8">
      <div className="max-w-[540px]">

        <h1 className="font-display font-bold text-[22px] text-hi tracking-[-0.5px] mb-6">Settings</h1>

        {/* ── Profile ─────────────────────────────────────────────────────── */}
        <div className={`${CARD} mb-[14px]`}>
          <span className={SECTION_LABEL}>Profile</span>

          <form onSubmit={handleSave}>
            <p className="text-[11px] font-semibold text-mid mb-[5px]">Display name</p>
            <div className="flex gap-2 mb-[7px]">
              <input
                value={displayName}
                onChange={e => { setDisplayName(e.target.value); setSaveError('') }}
                placeholder="Your name"
                maxLength={DISPLAY_NAME_MAX_LENGTH + 1}
                className="flex-1 bg-input border border-line-3 rounded-[9px] px-3 py-2 text-[12.5px] text-hi placeholder-[color:var(--color-low)] outline-none focus:border-accent/40 transition-colors motion-reduce:transition-none"
              />
              <button
                type="submit"
                disabled={saving || loading}
                className="flex-none bg-hi text-surface text-[12px] font-bold px-[18px] rounded-[9px] disabled:opacity-40 hover:opacity-85 transition-opacity motion-reduce:transition-none whitespace-nowrap"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {saveBanner && (
              <p role="status" aria-live="polite" className="text-[10.5px] font-semibold text-success mb-[3px]">
                &#x2713; Saved
              </p>
            )}
            {saveError && (
              <p className="text-[10.5px] text-danger">{saveError}</p>
            )}
          </form>

          <div className="border-t border-line-1 mt-[14px] pt-3 flex flex-col gap-[7px]">
            <div className="flex justify-between">
              <span className="text-[11.5px] text-low">Email</span>
              <span className="text-[11.5px] font-semibold text-hi truncate max-w-[260px]">
                {loading ? <span className="text-low animate-pulse motion-reduce:animate-none">-</span> : (user?.email || '-')}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[11.5px] text-low">Joined</span>
              <span className="text-[11.5px] font-semibold text-hi">
                {loading ? <span className="text-low animate-pulse motion-reduce:animate-none">-</span> : formatJoined(user?.created_at)}
              </span>
            </div>
          </div>
        </div>

        {/* ── Pro Access (always rendered - six states) ────────────────────── */}
        <div className={`${CARD} mb-[14px]`}>
          <span className={SECTION_LABEL}>Pro Access</span>

          {/* Checkout return banners */}
          {checkoutBanner === 'success' && (
            <p role="status" aria-live="polite" className="text-[11.5px] font-semibold text-success mb-2">
              &#x2713; You're on Funnl Pro — welcome!
            </p>
          )}
          {checkoutBanner === 'cancelled' && (
            <p className="text-[11.5px] text-muted mb-2">Checkout cancelled — you weren't charged.</p>
          )}

          {proLoading ? (
            <p className="text-[12px] text-low animate-pulse motion-reduce:animate-none">Loading…</p>
          ) : proFailed ? (
            <div className="flex items-center gap-3">
              <p className="text-[12px] text-muted flex-1">Pro status temporarily unavailable.</p>
              <button
                onClick={handleProRetry}
                disabled={retrying}
                aria-label={retrying ? 'Retrying Pro status' : 'Retry loading Pro status'}
                className="text-[11px] font-semibold text-accent hover:opacity-80 transition-opacity motion-reduce:transition-none disabled:opacity-40 flex-none"
              >
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          ) : proClass === 'permanent' ? (
            <div className="flex items-center gap-[8px]">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#FF4423"/>
              </svg>
              <span className="text-[12px] font-semibold text-hi">Funnl Pro · permanent access</span>
            </div>
          ) : proClass === 'subscribed' ? (
            <div>
              <div className="flex items-center gap-[8px]">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#FF4423"/>
                </svg>
                <span className="text-[12px] font-semibold text-hi">Funnl Pro · subscribed</span>
              </div>
              {proStatus.cancel_at_period_end && proStatus.subscription_period_end && (
                <p className="text-[10.5px] text-warning mt-[3px] ml-[21px]">
                  Cancels {formatTrialEnd(proStatus.subscription_period_end)}
                </p>
              )}
              {!proStatus.cancel_at_period_end && proStatus.subscription_period_end && (
                <p className="text-[10.5px] text-low mt-[3px] ml-[21px]">
                  Renews {formatTrialEnd(proStatus.subscription_period_end)}
                </p>
              )}
            </div>
          ) : proClass === 'trial' ? (
            <div>
              <div className="flex items-center gap-[8px]">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#FF4423"/>
                </svg>
                <span className="text-[12px] font-semibold text-hi">
                  {proStatus.days_remaining === 1
                    ? '1 day left in your trial'
                    : `${Math.max(0, proStatus.days_remaining)} days left in your trial`}
                </span>
              </div>
              {proStatus.ends_at && (
                <p className="text-[10.5px] text-low mt-[3px] ml-[21px]">
                  Ends {formatTrialEnd(proStatus.ends_at)}
                </p>
              )}
            </div>
          ) : proClass === 'expired' ? (
            <div>
              <p className="text-[12px] text-low mb-2">
                Trial ended{proStatus.ends_at ? ' ' + formatTrialEnd(proStatus.ends_at) : ''}.
                {' '}Subscribe to continue with Funnl Pro.
              </p>
              {subscribeError && (
                <p className="text-[10.5px] text-danger mb-2">{subscribeError}</p>
              )}
              <button
                onClick={handleSubscribe}
                disabled={subscribing}
                className="text-[12px] font-bold text-white px-4 py-[9px] rounded-[9px] disabled:opacity-40 hover:opacity-90 transition-opacity motion-reduce:transition-none"
                style={{ background: 'linear-gradient(135deg,#8B7CFF,#5B45F0)' }}
              >
                {subscribing ? 'Loading…' : 'Subscribe — $7.99/month'}
              </button>
            </div>
          ) : (
            // non_pro: no trial, no subscription
            <div>
              <p className="text-[12px] text-low mb-2">No active Pro access.</p>
              {subscribeError && (
                <p className="text-[10.5px] text-danger mb-2">{subscribeError}</p>
              )}
              <button
                onClick={handleSubscribe}
                disabled={subscribing}
                className="text-[12px] font-bold text-white px-4 py-[9px] rounded-[9px] disabled:opacity-40 hover:opacity-90 transition-opacity motion-reduce:transition-none"
                style={{ background: 'linear-gradient(135deg,#8B7CFF,#5B45F0)' }}
              >
                {subscribing ? 'Loading…' : 'Subscribe — $7.99/month'}
              </button>
            </div>
          )}
        </div>

        {/* ── Appearance ─────────────────────────────────────────────────── */}
        <div className={`${CARD} mb-[14px]`}>
          <span className={SECTION_LABEL}>Appearance</span>
          {/*
            W3C radiogroup pattern: roving tabIndex (selected = 0, others = -1).
            Arrow keys move selection + focus; Home/End jump to first/last.
            IME composition guarded in handleThemeKeyDown.
          */}
          <div
            role="radiogroup"
            aria-label="Color theme"
            className="flex gap-2"
            onKeyDown={handleThemeKeyDown}
          >
            {THEME_ORDER.map(value => {
              const label = value === 'light' ? 'Light' : value === 'dark' ? 'Dark' : 'System'
              return (
                <button
                  key={value}
                  role="radio"
                  aria-checked={currentTheme === value}
                  tabIndex={currentTheme === value ? 0 : -1}
                  data-theme-option={value}
                  onClick={() => { setCurrentTheme(value); setTheme(value) }}
                  className={`flex-1 py-2 rounded-[9px] text-[11.5px] font-semibold transition-colors motion-reduce:transition-none ${
                    currentTheme === value
                      ? 'bg-hi text-surface'
                      : 'border border-line-3 text-mid hover:text-hi'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-[10.5px] text-low leading-relaxed">
            Dark = the Night Ledger ink theme. System follows the device.
          </p>
        </div>

        {/* ── Data & Imports ─────────────────────────────────────────────── */}
        <div className={`${CARD} mb-[14px]`}>
          <span className={SECTION_LABEL}>Data &amp; Imports</span>

          <div className="flex justify-between items-center mb-[10px]">
            <span className="text-[11.5px] text-hi">Import contacts from CSV</span>
            <button
              onClick={() => navigate('/contacts?import=1')}
              className="text-[11px] font-semibold text-accent hover:opacity-80 transition-opacity motion-reduce:transition-none"
            >
              Open import →
            </button>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-[11.5px] text-hi">
              Delete all contacts{' '}
              {contactCount !== null && contactCount > 0 && (
                <span className="text-[10px] text-low">({contactCount})</span>
              )}
            </span>
            {contactCount !== null && contactCount > 0 ? (
              <button
                onClick={openDeleteAllModal}
                className="text-[11px] font-semibold text-danger hover:opacity-80 transition-opacity motion-reduce:transition-none"
              >
                Delete…
              </button>
            ) : (
              <span className="text-[11px] text-low">No contacts</span>
            )}
          </div>
        </div>

        {/* ── Account links ───────────────────────────────────────────────── */}
        <div className="flex items-center gap-[16px] px-1 mb-[4px]">
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="text-[11.5px] font-semibold text-mid hover:text-hi transition-colors motion-reduce:transition-none disabled:opacity-40"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
          <Link
            to="/privacy"
            className="text-[10.5px] text-accent hover:opacity-80 transition-opacity motion-reduce:transition-none no-underline"
          >
            Privacy Policy
          </Link>
        </div>
        {signOutError && (
          <p className="text-[11.5px] text-danger px-1 mb-2">{signOutError}</p>
        )}

        {/* ── Danger Zone ─────────────────────────────────────────────────── */}
        <div className="mt-[20px] border-t border-[rgba(194,51,77,0.2)] pt-[14px]">
          <span className="block mb-[7px] font-mono text-[8.5px] font-semibold tracking-[1.5px] text-danger uppercase">
            Danger Zone
          </span>
          <p className="text-[11px] text-muted leading-[1.55] mb-[10px]">
            Permanently delete your account and all contacts, interactions, and notes. Cannot be undone.
          </p>
          <button
            onClick={openDeleteModal}
            className="text-[11.5px] font-semibold text-danger border border-[rgba(194,51,77,0.4)] rounded-[9px] px-[14px] py-2 hover:bg-[rgba(194,51,77,0.06)] transition-colors motion-reduce:transition-none"
          >
            Delete my account…
          </button>
        </div>

      </div>

      {/* ── Delete-all contacts dialog ───────────────────────────────────── */}
      {showDeleteAllModal && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-all-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div
            className="absolute inset-0 backdrop-blur-sm" style={{ background: 'var(--color-backdrop)' }}
            onClick={closeDeleteAllModal}
          />
          <div
            className="relative bg-card border border-line-2 rounded-[14px] p-6 w-full max-w-[360px] shadow-2xl"
            onKeyDown={e => trapFocus(e, closeDeleteAllModal, deletingAll)}
          >
            <h2
              id="delete-all-title"
              className="font-display font-bold text-[17px] text-hi tracking-[-0.4px] mb-[6px]"
            >
              Delete all contacts?
            </h2>
            <p className="text-[11.5px] text-muted leading-[1.55] mb-3">
              This permanently deletes {summarizeContactCount(contactCount)} and all their interactions.
              There is no recovery.
            </p>
            {deletingAll && (
              <p role="status" aria-live="assertive" className="sr-only">Deleting all contacts…</p>
            )}
            <p className="text-[10.5px] font-semibold text-mid mb-[5px]">
              Type <span className="font-mono">delete all contacts</span> to confirm
            </p>
            <input
              ref={deleteAllInputRef}
              type="text"
              value={deleteAllInput}
              onChange={e => setDeleteAllInput(e.target.value)}
              placeholder="delete all contacts"
              className="w-full border border-[rgba(194,51,77,0.35)] rounded-[9px] px-3 py-2 text-[12px] text-hi bg-input mb-3 outline-none focus:border-[rgba(194,51,77,0.6)] transition-colors motion-reduce:transition-none"
            />
            {deleteAllError && (
              <p className="text-[12px] text-danger mb-3">{deleteAllError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={closeDeleteAllModal}
                disabled={deletingAll}
                className="flex-1 py-2.5 rounded-[9px] border border-line-3 text-[11.5px] font-semibold text-mid hover:text-hi transition-colors motion-reduce:transition-none disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAll}
                disabled={!isDeleteAllConfirmEligible(deleteAllInput) || deletingAll}
                className="flex-1 py-2.5 rounded-[9px] bg-danger text-[11.5px] font-bold text-surface disabled:opacity-40 hover:opacity-90 transition-opacity motion-reduce:transition-none"
              >
                {deletingAll ? 'Deleting…' : 'Delete all'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete-account dialog ────────────────────────────────────────── */}
      {showDeleteModal && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-account-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div
            className="absolute inset-0 backdrop-blur-sm" style={{ background: 'var(--color-backdrop)' }}
            onClick={closeDeleteModal}
          />
          <div
            className="relative bg-card border border-line-2 rounded-[14px] p-6 w-full max-w-[360px] shadow-2xl"
            onKeyDown={e => trapFocus(e, closeDeleteModal, deleting)}
          >
            <h2
              id="delete-account-title"
              className="font-display font-bold text-[17px] text-hi tracking-[-0.4px] mb-[6px]"
            >
              Delete account?
            </h2>
            <p className="text-[11.5px] text-muted leading-[1.55] mb-3">
              This permanently deletes your account, {summarizeContactCount(contactCount)}, and all
              interactions and notes. There is no recovery.
            </p>
            {deleting && (
              <p role="status" aria-live="assertive" className="sr-only">Deleting account…</p>
            )}
            <p className="text-[10.5px] font-semibold text-mid mb-[5px]">
              Type <span className="font-mono">delete my account</span> to confirm
            </p>
            <input
              ref={deleteInputRef}
              type="text"
              value={deleteInput}
              onChange={e => setDeleteInput(e.target.value)}
              placeholder="delete my account"
              className="w-full border border-[rgba(194,51,77,0.35)] rounded-[9px] px-3 py-2 text-[12px] text-hi bg-input mb-3 outline-none focus:border-[rgba(194,51,77,0.6)] transition-colors motion-reduce:transition-none"
            />
            {deleteError && (
              <p className="text-[12px] text-danger mb-3">{deleteError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={closeDeleteModal}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-[9px] border border-line-3 text-[11.5px] font-semibold text-mid hover:text-hi transition-colors motion-reduce:transition-none disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={!isDeleteAccountConfirmEligible(deleteInput) || deleting}
                className="flex-1 py-2.5 rounded-[9px] bg-danger text-[11.5px] font-bold text-surface disabled:opacity-40 hover:opacity-90 transition-opacity motion-reduce:transition-none"
              >
                {deleting ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

export default SettingsPage
