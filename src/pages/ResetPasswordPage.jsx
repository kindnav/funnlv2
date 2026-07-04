import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const iCls = 'w-full bg-input border border-[rgba(255,255,255,0.09)] rounded-xl px-[13px] py-[11px] text-[13.5px] text-hi placeholder-[#54545E] outline-none focus:border-[rgba(139,124,255,0.5)] transition-colors'
const lCls = 'mb-[7px] block text-[12.5px] font-semibold text-mid'

function ResetPasswordPage() {
  const navigate = useNavigate()
  const [pageState, setPageState] = useState('loading') // 'loading' | 'form' | 'no-session'
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setPageState(data.session ? 'form' : 'no-session')
    })
  }, [])

  async function handleUpdatePassword(e) {
    e.preventDefault()
    setError('')
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return }
    if (newPassword.length < 6) { setError('Password must be at least 6 characters.'); return }
    setSubmitting(true)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) { setError(error.message); setSubmitting(false); return }
    // Navigate to sign-in with success state, then clear the recovery session
    navigate('/', { state: { passwordReset: true } })
    supabase.auth.signOut()
  }

  const logoMark = (
    <div
      className="w-[52px] h-[52px] rounded-[14px] flex items-center justify-center mx-auto mb-8"
      style={{ background: 'linear-gradient(135deg,#8B7CFF,#5B45F0)' }}
    >
      <span className="font-display font-bold text-[22px] text-white">F</span>
    </div>
  )

  // ── Loading ──────────────────────────────────────────────────────────────
  if (pageState === 'loading') {
    return (
      <div className="min-h-screen bg-base flex items-center justify-center">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    )
  }

  // ── Expired / no recovery session ────────────────────────────────────────
  if (pageState === 'no-session') {
    return (
      <div className="min-h-screen bg-base flex items-center justify-center p-6">
        <div className="w-full max-w-[400px] text-center">
          {logoMark}
          <div className="w-[72px] h-[72px] rounded-full bg-[rgba(255,107,138,0.1)] border border-[rgba(255,107,138,0.2)] flex items-center justify-center mx-auto mb-6">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FF6B8A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>
            </svg>
          </div>
          <h1 className="font-display font-bold text-[24px] text-hi tracking-[-0.3px] mb-3">Link expired</h1>
          <p className="text-[14.5px] text-muted leading-relaxed mb-8">
            This reset link has already been used or has expired. Request a new one from the sign-in page.
          </p>
          <button
            onClick={() => navigate('/')}
            className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold rounded-[12px] py-[14px] shadow-[0_6px_20px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity"
          >
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  // ── New password form ─────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-base flex items-center justify-center p-6">
      <div className="w-full max-w-[400px]">
        {logoMark}
        <h1 className="font-display font-bold text-[28px] text-hi tracking-[-0.5px] mb-2 text-center">Set a new password</h1>
        <p className="text-[14.5px] text-muted text-center mb-8">Choose a strong password — at least 6 characters.</p>

        <form onSubmit={handleUpdatePassword} className="space-y-4">
          <div>
            <label className={lCls}>New password</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              autoFocus
              placeholder="At least 6 characters"
              className={iCls}
            />
          </div>
          <div>
            <label className={lCls}>Confirm new password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
              placeholder="Re-enter your password"
              className={iCls}
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold rounded-[12px] py-[14px] shadow-[0_6px_20px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {submitting ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default ResetPasswordPage
