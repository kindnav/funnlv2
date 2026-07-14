import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const iCls = 'flex-1 bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors'
const lCls = 'mb-[7px] block text-[12.5px] font-semibold text-mid'

function SettingsPage() {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      setUser(user)
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('id', user.id)
          .maybeSingle()
        if (profile) setDisplayName(profile.display_name || '')
      }
      setLoading(false)
    }
    load()
  }, [])

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.from('profiles').upsert({
      id: user.id,
      display_name: displayName.trim() || null,
      updated_at: new Date().toISOString(),
    })
    setSaving(false)
    if (error) { setError(error.message); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  async function handleDeleteAccount() {
    setDeleting(true)
    setDeleteError('')
    const { data, error } = await supabase.functions.invoke('delete-account')
    if (error || !data?.success) {
      setDeleteError('Something went wrong. Please try again.')
      setDeleting(false)
      return
    }
    await supabase.auth.signOut()
    navigate('/signup', { replace: true })
  }

  function formatJoined(ts) {
    if (!ts) return '—'
    return 'Joined ' + new Date(ts).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface px-4 py-6 md:px-9 md:py-8">

      <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-hi transition-colors no-underline mb-5">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6"/>
        </svg>
        Back
      </Link>

      <h1 className="font-display font-bold text-[28px] text-hi tracking-[-0.5px] mb-1">Settings</h1>
      <p className="text-[14.5px] text-muted mb-8">Manage your account.</p>

      <div className="max-w-[480px]">

        {/* Combined account card */}
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl overflow-hidden mb-5">

          {/* Profile section */}
          <div className="p-6">
            <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono mb-5">Profile</p>
            <form onSubmit={handleSave}>
              <label className={lCls}>Display name</label>
              <div className="flex gap-2">
                <input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="Your name"
                  className={iCls}
                />
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-none bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[13.5px] font-bold px-5 rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-40 whitespace-nowrap"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
              {error && <p className="text-sm text-danger mt-2">{error}</p>}
              {saved && (
                <div className="flex items-center gap-1.5 text-success text-[13px] font-medium mt-3">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                  Saved ✓
                </div>
              )}
            </form>
          </div>

          <div className="h-px bg-[rgba(255,255,255,0.06)]"/>

          {/* Account info — read-only */}
          <div className="p-6">
            <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono mb-4">Your account</p>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <span className="text-[13px] text-low flex-none">Email</span>
                <span className="text-[13.5px] font-medium text-hi truncate">{user?.email}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[13px] text-low flex-none">Joined</span>
                <span className="text-[13.5px] font-medium text-hi">{formatJoined(user?.created_at)}</span>
              </div>
            </div>
          </div>

        </div>

        {/* Sign out */}
        <button
          onClick={() => supabase.auth.signOut()}
          className="flex items-center gap-2 text-[13.5px] font-semibold text-danger hover:opacity-80 transition-opacity"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Sign out
        </button>

        <Link to="/privacy" className="text-[12px] text-lower hover:text-muted transition-colors no-underline mt-1">
          Privacy Policy
        </Link>

        {/* Danger zone */}
        <div className="mt-10 pt-8 border-t border-[rgba(255,255,255,0.06)]">
          <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono mb-3">Danger zone</p>
          <p className="text-[13px] text-muted mb-4 leading-relaxed">
            Permanently delete your account and all of your contacts, interactions, and notes. This cannot be undone.
          </p>
          <button
            onClick={() => { setShowDeleteModal(true); setDeleteError('') }}
            className="text-[13.5px] font-semibold text-danger border border-[rgba(255,107,138,0.3)] rounded-xl px-4 py-2.5 hover:bg-[rgba(255,107,138,0.08)] transition-colors"
          >
            Delete my account
          </button>
        </div>

      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => !deleting && setShowDeleteModal(false)}
          />
          <div className="relative bg-card border border-[rgba(255,255,255,0.09)] rounded-2xl p-6 w-full max-w-[380px] shadow-2xl">
            <div className="w-10 h-10 rounded-[11px] bg-[rgba(255,107,138,0.12)] flex items-center justify-center mb-4">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </div>

            <h2 className="font-display font-bold text-[19px] text-hi mb-2 tracking-[-0.3px]">Delete account?</h2>
            <p className="text-[13.5px] text-muted leading-relaxed mb-5">
              This permanently deletes your account and all contacts, interactions, and notes. There is no way to recover your data after this.
            </p>

            {deleteError && (
              <p className="text-[13px] text-danger mb-4">{deleteError}</p>
            )}

            <div className="flex gap-2.5">
              <button
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl border border-[rgba(255,255,255,0.09)] bg-elevated text-[14px] font-semibold text-mid hover:text-hi transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl bg-danger text-[14px] font-bold text-white hover:opacity-90 transition-opacity disabled:opacity-50"
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
