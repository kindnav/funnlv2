import { useEffect, useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import { supabase } from './lib/supabase'
import SignInPage from './pages/SignInPage'
import DashboardPage from './pages/DashboardPage'
import ContactsPage from './pages/ContactsPage'
import ContactDetailPage from './pages/ContactDetailPage'
import FollowUpsPage from './pages/FollowUpsPage'
import FunnlAIPage from './pages/FunnlAIPage'
import WelcomePage from './pages/WelcomePage'
import Sidebar from './components/Sidebar'

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
    return (
      <Routes>
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="*" element={<SignInPage />} />
      </Routes>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-base">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-surface">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/contacts/:id" element={<ContactDetailPage />} />
          <Route path="/followups" element={<FollowUpsPage />} />
          <Route path="/ai" element={<FunnlAIPage />} />
          <Route path="/welcome" element={<WelcomePage />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
