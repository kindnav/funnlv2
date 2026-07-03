import { useEffect, useState } from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import { supabase } from './lib/supabase'
import SignInPage from './pages/SignInPage'
import DashboardPage from './pages/DashboardPage'
import ContactsPage from './pages/ContactsPage'
import ContactDetailPage from './pages/ContactDetailPage'
import Sidebar from './components/Sidebar'

// Minimal placeholder for screens not yet built (Follow-ups = Layer 2, Funnl AI = Layer 3)
function ComingSoon({ title, subtitle }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-12">
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-[rgba(108,92,255,0.12)] border border-[rgba(139,124,255,0.25)] flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="#B4A8FF">
            <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
          </svg>
        </div>
        <h1 className="font-display text-2xl font-bold text-hi mb-2">{title}</h1>
        <p className="text-muted text-sm leading-relaxed mb-6">{subtitle}</p>
        <Link to="/" className="text-sm font-medium text-accent hover:text-tag no-underline">← Back to dashboard</Link>
      </div>
    </div>
  )
}

function App() {
  const [session, setSession] = useState(null)
  const [checkingSession, setCheckingSession] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setCheckingSession(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  if (checkingSession) {
    return <div className="min-h-screen bg-base"/>
  }

  if (!session) {
    return <SignInPage />
  }

  return (
    <div className="flex h-screen overflow-hidden bg-base">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-surface">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/contacts/:id" element={<ContactDetailPage />} />
          <Route
            path="/followups"
            element={
              <ComingSoon
                title="Follow-ups"
                subtitle="Smart reminders and relationship-going-cold alerts are coming in Layer 2. Log interactions with follow-up dates now and they'll appear here."
              />
            }
          />
          <Route
            path="/ai"
            element={
              <ComingSoon
                title="Funnl AI"
                subtitle="The AI assistant that reads your notes and answers questions like 'who do I know at Goldman' is coming in Layer 3. Keep logging interactions — that's the data it will use."
              />
            }
          />
        </Routes>
      </main>
    </div>
  )
}

export default App
