import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

function WelcomePage() {
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = useState(false)

  async function handleContinue() {
    setSigningOut(true)
    // Sign out first — confirmation links auto-create a session; clear it so /signin renders
    // in the unauthenticated route tree. signOut() clears local storage regardless of server error.
    const { error } = await supabase.auth.signOut()
    if (error) console.error('Sign-out on welcome failed:', error.message)
    navigate('/signin')
  }

  return (
    <div className="min-h-screen bg-base flex items-center justify-center p-6">
      <div className="w-full max-w-[400px] text-center">

        {/* Logo mark */}
        <div className="w-[52px] h-[52px] rounded-[14px] bg-[#4B3AF0] flex items-center justify-center mx-auto mb-8 shadow-[0_6px_20px_rgba(75,58,240,0.35)]">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="white"/>
          </svg>
        </div>

        {/* Success icon */}
        <div className="w-[72px] h-[72px] rounded-full bg-[rgba(47,212,182,0.12)] border border-[rgba(47,212,182,0.28)] flex items-center justify-center mx-auto mb-6">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
        </div>

        {/* Heading */}
        <h1 className="font-display font-bold text-[28px] text-hi tracking-[-0.5px] mb-3">
          You're all set
        </h1>

        {/* Body */}
        <p className="text-[15px] text-muted leading-relaxed mb-8">
          Your email is confirmed.<br/>You can sign in now.
        </p>

        {/* Primary CTA */}
        <button
          onClick={handleContinue}
          disabled={signingOut}
          className="w-full bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold rounded-[12px] py-[14px] shadow-[0_6px_20px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {signingOut ? 'Signing out…' : 'Continue to sign in'}
        </button>

      </div>
    </div>
  )
}

export default WelcomePage
