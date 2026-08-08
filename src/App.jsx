import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { identifyUser, resetAnalytics } from './lib/analytics'
import LandingPage from './pages/LandingPage'
import SignInPage from './pages/SignInPage'
import DashboardPage from './pages/DashboardPage'
import ContactsPage from './pages/ContactsPage'
import ContactDetailPage from './pages/ContactDetailPage'
import FollowUpsPage from './pages/FollowUpsPage'
import FunnlAIPage from './pages/FunnlAIPage'
import WelcomePage from './pages/WelcomePage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import PrivacyPage from './pages/PrivacyPage'
import Sidebar from './components/Sidebar'
import BottomNav from './components/BottomNav'
import MobileAppBar from './components/MobileAppBar'
import CommandPalette from './components/CommandPalette'
import GlobalAddContactController from './components/GlobalAddContactController'
import SettingsPage from './pages/SettingsPage'
import { ProStatusProvider } from './lib/useProStatus'

function App() {
  const location = useLocation()
  const [session, setSession] = useState(null)
  const [checkingSession, setCheckingSession] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setCheckingSession(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session?.user) {
        identifyUser(session.user.id, session.user.email)
      } else {
        resetAnalytics()
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  if (checkingSession) {
    return <div className="min-h-screen bg-base"/>
  }

  // These pages always render full-screen without the app shell, regardless of session state.
  // WelcomePage calls signOut() itself; ResetPasswordPage checks for a recovery session internally.
  if (location.pathname === '/welcome' || location.pathname === '/reset-password') {
    return (
      <Routes>
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Routes>
    )
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/signup" element={<SignInPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="*" element={<Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />} />
      </Routes>
    )
  }

  return (
    // ProStatusProvider makes one RPC call and shares the result with all
    // shell components (BottomNav, CommandPalette, Dashboard modules, etc.)
    // so Pro status is fetched exactly once per app mount, not once per component.
    <ProStatusProvider>
      <div className="flex h-screen overflow-hidden bg-base">
        <Sidebar />
        {/* MobileAppBar: mobile-only fixed top bar with account/avatar menu.
            pt-[44px] md:pt-0 on main offsets content below the 44px bar height. */}
        <MobileAppBar />
        <main className="flex-1 overflow-y-auto bg-surface pt-[calc(44px_+_env(safe-area-inset-top,0px))] pb-[calc(4rem_+_env(safe-area-inset-bottom,0px))] md:pt-0 md:pb-0">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/contacts/:id" element={<ContactDetailPage />} />
            <Route path="/followups" element={<FollowUpsPage />} />
            <Route path="/ai" element={<FunnlAIPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/signin" element={<Navigate to="/" replace />} />
            <Route path="/signup" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <BottomNav />
        <CommandPalette />
        {/* Single global add-contact drawer — accessible from every authenticated route */}
        <GlobalAddContactController />
      </div>
    </ProStatusProvider>
  )
}

export default App
