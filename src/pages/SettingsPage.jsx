import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const iCls = 'w-full bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors'
const lCls = 'mb-[7px] block text-[12.5px] font-semibold text-mid'

function SettingsPage() {
  const [user, setUser] = useState(null)
  const [displayName, setDisplayName] = useState('')
  const [school, setSchool] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      setUser(user)
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('display_name, school')
          .eq('id', user.id)
          .maybeSingle()
        if (profile) {
          setDisplayName(profile.display_name || '')
          setSchool(profile.school || '')
        }
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
      school: school.trim() || null,
      updated_at: new Date().toISOString(),
    })
    setSaving(false)
    if (error) { setError(error.message); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
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

      {/* Back link */}
      <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-hi transition-colors no-underline mb-5">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6"/>
        </svg>
        Back
      </Link>

      <h1 className="font-display font-bold text-[28px] text-hi tracking-[-0.5px] mb-1">Settings</h1>
      <p className="text-[14.5px] text-muted mb-8">How you appear in Funnl.</p>

      {/* Profile section */}
      <div className="max-w-[480px]">
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-6 mb-4">
          <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono mb-5">Profile</p>
          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className={lCls}>Display name</label>
              <input
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Your name"
                className={iCls}
              />
            </div>
            <div>
              <label className={lCls}>
                School{' '}
                <span className="text-lower font-normal">— optional</span>
              </label>
              <input
                value={school}
                onChange={e => setSchool(e.target.value)}
                placeholder="e.g. NYU Stern"
                className={iCls}
              />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={saving}
                className="bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[14px] font-bold px-6 py-[11px] rounded-[11px] shadow-[0_6px_18px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              {saved && (
                <div className="flex items-center gap-1.5 text-success text-[13px] font-medium">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                  Saved
                </div>
              )}
            </div>
          </form>
        </div>

        {/* Account section */}
        <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5">
          <p className="text-[11.5px] font-bold tracking-[1px] text-lower uppercase font-mono mb-4">Account</p>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[13.5px] font-semibold text-hi">{user?.email}</p>
              <p className="text-[12px] text-low mt-0.5">Signed in</p>
            </div>
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
          </div>
        </div>
      </div>

    </div>
  )
}

export default SettingsPage
