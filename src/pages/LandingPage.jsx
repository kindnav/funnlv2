import { Link, useNavigate } from 'react-router-dom'
import { track } from '../lib/analytics'

function LandingPage() {
  const navigate = useNavigate()

  function handleStartFree(location) {
    track('landing_cta_clicked', { location })
    navigate('/signup')
  }

  const logoMark = (
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-[9px] bg-[#4B3AF0] flex items-center justify-center shadow-[0_4px_14px_rgba(75,58,240,0.4)] flex-none">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="white"/>
        </svg>
      </div>
      <span className="font-display font-bold text-[20px] text-hi tracking-[-0.3px]">Funnl</span>
    </div>
  )

  return (
    <div className="min-h-screen bg-base">

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 border-b border-[rgba(255,255,255,0.06)] bg-[rgba(6,6,8,0.85)] backdrop-blur-md">
        <div className="max-w-[1080px] mx-auto px-5 md:px-8 h-[60px] flex items-center justify-between">
          {logoMark}
          <div className="flex items-center gap-3">
            <Link to="/signin" className="text-[13.5px] font-semibold text-mid hover:text-hi transition-colors no-underline px-4 py-2">
              Sign in
            </Link>
            <button
              onClick={() => handleStartFree('nav')}
              className="bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[13.5px] font-bold rounded-[10px] px-4 py-[9px] shadow-[0_4px_16px_rgba(91,69,240,0.35)] hover:opacity-90 transition-opacity"
            >
              Start for free
            </button>
          </div>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="max-w-[1080px] mx-auto px-5 md:px-8 pt-20 pb-24 md:pt-28 md:pb-32 text-center">
        <div className="inline-flex items-center gap-2 bg-[rgba(139,124,255,0.1)] border border-[rgba(139,124,255,0.2)] rounded-full px-3.5 py-1.5 mb-8">
          <div className="w-1.5 h-1.5 rounded-full bg-accent"/>
          <span className="font-mono text-[11.5px] font-semibold text-tag tracking-wide uppercase">Built for recruiting season</span>
        </div>
        <h1 className="font-display font-bold text-[40px] md:text-[56px] text-hi leading-[1.15] tracking-[-1px] md:tracking-[-1.5px] mb-6 max-w-[760px] mx-auto">
          Turn networking conversations into follow-ups that lead somewhere.
        </h1>
        <p className="text-[16px] md:text-[18px] text-muted leading-[1.65] mb-10 max-w-[540px] mx-auto">
          Funnl helps students recruiting for competitive roles remember every conversation, follow up at the right time, and see who to contact next.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={() => handleStartFree('hero')}
            className="w-full sm:w-auto bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold rounded-[12px] px-8 py-[14px] shadow-[0_8px_28px_rgba(91,69,240,0.4)] hover:opacity-90 transition-opacity"
          >
            Start for free — no credit card
          </button>
          <Link to="/signin" className="w-full sm:w-auto text-[15px] font-semibold text-mid hover:text-hi transition-colors no-underline border border-[rgba(255,255,255,0.09)] rounded-[12px] px-8 py-[14px] text-center">
            Sign in
          </Link>
        </div>
      </section>

      {/* ── Problem statement ───────────────────────────────────────────── */}
      <section className="border-t border-[rgba(255,255,255,0.06)] bg-surface">
        <div className="max-w-[1080px] mx-auto px-5 md:px-8 py-16 md:py-20">
          <p className="text-[17px] md:text-[19px] text-mid leading-[1.7] max-w-[700px] mx-auto text-center">
            Most students track recruiting contacts in a spreadsheet or nothing at all.
            Conversations are forgotten, follow-ups are missed, and relationships go cold.
            Funnl keeps every contact, note, and next step in one place.
          </p>
        </div>
      </section>

      {/* ── Core benefits ───────────────────────────────────────────────── */}
      <section className="max-w-[1080px] mx-auto px-5 md:px-8 py-16 md:py-20">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">

          <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-7">
            <div className="w-10 h-10 rounded-[11px] bg-[rgba(139,124,255,0.15)] flex items-center justify-center mb-5">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
            </div>
            <h3 className="font-display font-bold text-[17px] text-hi mb-2">Remember every conversation</h3>
            <p className="text-[14px] text-muted leading-relaxed">Log notes after every coffee chat, email, or call — so nothing slips through the cracks.</p>
          </div>

          <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-7">
            <div className="w-10 h-10 rounded-[11px] bg-[rgba(47,212,182,0.12)] flex items-center justify-center mb-5">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="8.5"/>
                <path d="M12 7.5V12l3 2"/>
              </svg>
            </div>
            <h3 className="font-display font-bold text-[17px] text-hi mb-2">Know who needs a follow-up</h3>
            <p className="text-[14px] text-muted leading-relaxed">See overdue and upcoming contacts at a glance — before relationships go cold.</p>
          </div>

          <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-7">
            <div className="w-10 h-10 rounded-[11px] bg-[rgba(255,184,77,0.12)] flex items-center justify-center mb-5">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFB84D" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                <line x1="7" y1="7" x2="7.01" y2="7"/>
              </svg>
            </div>
            <h3 className="font-display font-bold text-[17px] text-hi mb-2">Stay organized by relationship</h3>
            <p className="text-[14px] text-muted leading-relaxed">Tag recruiters, alumni, mentors, and referrals so your network stays structured.</p>
          </div>

        </div>
      </section>

      {/* ── Who it's for ────────────────────────────────────────────────── */}
      <section className="border-t border-[rgba(255,255,255,0.06)] bg-surface">
        <div className="max-w-[1080px] mx-auto px-5 md:px-8 py-16 md:py-20">
          <div className="max-w-[680px] mx-auto">
            <span className="font-mono text-[11px] font-semibold text-accent tracking-widest uppercase mb-4 block">Who Funnl is for</span>
            <h2 className="font-display font-bold text-[30px] md:text-[34px] text-hi tracking-[-0.5px] mb-6 leading-[1.2]">
              Built for relationship-driven recruiting
            </h2>
            <p className="text-[15px] text-muted leading-relaxed mb-7">
              Funnl is for students doing the hard work of competitive recruiting — not just applying online, but building real relationships. That means coffee chats with alumni, recruiter outreach, informational interviews, and follow-ups that take weeks or months to pay off.
            </p>
            <ul className="space-y-3">
              {[
                'Finance, consulting, VC, PE, and tech recruiting where relationships close offers',
                'Students managing 20–100+ contacts across multiple firms and schools',
                'Anyone who has lost a warm contact because they forgot to follow up',
                'Recruiters tell you to stay in touch — Funnl makes that concrete',
              ].map((item, i) => (
                <li key={i} className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-[rgba(139,124,255,0.15)] flex items-center justify-center flex-none mt-0.5">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                  </div>
                  <span className="text-[14.5px] text-mid leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────────────── */}
      <section className="max-w-[1080px] mx-auto px-5 md:px-8 py-16 md:py-20">
        <div className="text-center mb-12">
          <span className="font-mono text-[11px] font-semibold text-accent tracking-widest uppercase mb-4 block">How it works</span>
          <h2 className="font-display font-bold text-[30px] md:text-[34px] text-hi tracking-[-0.5px]">Three steps to a warmer network</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

          {/* Step 1 */}
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-[rgba(139,124,255,0.15)] border border-[rgba(139,124,255,0.25)] flex items-center justify-center flex-none">
                <span className="font-mono text-[12px] font-bold text-accent">1</span>
              </div>
              <h3 className="font-display font-bold text-[16px] text-hi">Add a contact</h3>
            </div>
            <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5 flex-1">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-[10px] bg-[rgba(139,124,255,0.22)] flex items-center justify-center flex-none">
                  <span className="font-display font-bold text-[13px] text-accent">PS</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-[14px] text-hi">Priya Sharma</p>
                  <p className="text-[12px] text-muted">Analyst · Goldman Sachs</p>
                  <div className="flex gap-1.5 mt-2 flex-wrap">
                    <span className="font-mono text-[10.5px] text-tag bg-[rgba(139,124,255,0.1)] border border-[rgba(139,124,255,0.18)] rounded-full px-2.5 py-0.5">recruiter</span>
                    <span className="font-mono text-[10.5px] text-tag bg-[rgba(139,124,255,0.1)] border border-[rgba(139,124,255,0.18)] rounded-full px-2.5 py-0.5">target firm</span>
                  </div>
                </div>
              </div>
            </div>
            <p className="text-[13.5px] text-muted leading-relaxed">Paste any text about a person or fill the form. Tag by relationship type.</p>
          </div>

          {/* Step 2 */}
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-[rgba(47,212,182,0.12)] border border-[rgba(47,212,182,0.25)] flex items-center justify-center flex-none">
                <span className="font-mono text-[12px] font-bold text-success">2</span>
              </div>
              <h3 className="font-display font-bold text-[16px] text-hi">Log the conversation</h3>
            </div>
            <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5 flex-1">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-semibold text-mid bg-[rgba(255,255,255,0.05)] rounded-full px-2.5 py-1">Coffee chat</span>
                  <span className="text-[11.5px] text-low">Jul 8, 2026</span>
                </div>
                <p className="text-[12.5px] text-muted leading-relaxed">Great conversation about the investment banking analyst program. She mentioned there are still open slots.</p>
                <div className="flex items-center gap-1.5 pt-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-warning"/>
                  <span className="text-[11.5px] text-warning font-semibold">Follow up Jul 22</span>
                </div>
              </div>
            </div>
            <p className="text-[13.5px] text-muted leading-relaxed">Write notes, set a follow-up date. The conversation lives with the contact.</p>
          </div>

          {/* Step 3 */}
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-[rgba(255,184,77,0.12)] border border-[rgba(255,184,77,0.25)] flex items-center justify-center flex-none">
                <span className="font-mono text-[12px] font-bold text-warning">3</span>
              </div>
              <h3 className="font-display font-bold text-[16px] text-hi">Follow up at the right time</h3>
            </div>
            <div className="bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-5 flex-1">
              <div className="space-y-2">
                <div className="flex items-center gap-2.5 py-2 border-b border-[rgba(255,255,255,0.05)]">
                  <div className="w-7 h-7 rounded-full bg-[rgba(255,107,138,0.15)] flex items-center justify-center flex-none">
                    <span className="font-display font-bold text-[10px] text-danger">JK</span>
                  </div>
                  <div>
                    <p className="text-[12px] font-semibold text-hi">James Kim</p>
                    <p className="text-[11px] text-danger font-semibold">2 days overdue</p>
                  </div>
                </div>
                <div className="flex items-center gap-2.5 py-2">
                  <div className="w-7 h-7 rounded-full bg-[rgba(255,184,77,0.15)] flex items-center justify-center flex-none">
                    <span className="font-display font-bold text-[10px] text-warning">PS</span>
                  </div>
                  <div>
                    <p className="text-[12px] font-semibold text-hi">Priya Sharma</p>
                    <p className="text-[11px] text-warning font-semibold">Today</p>
                  </div>
                </div>
              </div>
            </div>
            <p className="text-[13.5px] text-muted leading-relaxed">Your follow-up dashboard surfaces who's overdue and who's up next.</p>
          </div>

        </div>
      </section>

      {/* ── Comparison table ────────────────────────────────────────────── */}
      <section className="border-t border-[rgba(255,255,255,0.06)] bg-surface">
        <div className="max-w-[1080px] mx-auto px-5 md:px-8 py-16 md:py-20">
          <div className="text-center mb-10">
            <span className="font-mono text-[11px] font-semibold text-accent tracking-widest uppercase mb-4 block">Why Funnl</span>
            <h2 className="font-display font-bold text-[30px] md:text-[34px] text-hi tracking-[-0.5px]">Designed for this problem</h2>
          </div>

          <div className="max-w-[640px] mx-auto overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[rgba(255,255,255,0.08)]">
                  <th className="pb-4 text-[12px] font-semibold text-low font-mono uppercase tracking-wide w-[45%]">Feature</th>
                  <th className="pb-4 text-[12px] font-semibold text-low font-mono uppercase tracking-wide text-center">Spreadsheet</th>
                  <th className="pb-4 text-[12px] font-semibold text-accent font-mono uppercase tracking-wide text-center">Funnl</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgba(255,255,255,0.05)]">
                {[
                  ['Follow-up visibility',    'Manual setup',           true],
                  ['Conversation history',    'Scattered across cells', 'Attached to each contact'],
                  ['Tag and filter contacts', 'Manual upkeep',          true],
                  ['Import existing contacts','Manual cleanup',          'Guided CSV import'],
                  ['AI networking insights',  'Not built in',           'Pro'],
                ].map(([feature, spreadsheet, funnl]) => (
                  <tr key={feature}>
                    <td className="py-4 text-[14px] text-mid">{feature}</td>
                    <td className="py-4 text-center">
                      <span className="text-[13px] text-muted">{spreadsheet}</span>
                    </td>
                    <td className="py-4 text-center">
                      {funnl === true
                        ? <svg className="mx-auto" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2FD4B6" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                        : <span className={`text-[13px] font-semibold ${funnl === 'Pro' ? 'text-accent' : 'text-success'}`}>{funnl}</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Privacy & trust ─────────────────────────────────────────────── */}
      <section className="max-w-[1080px] mx-auto px-5 md:px-8 py-16 md:py-20">
        <div className="max-w-[640px] mx-auto bg-card border border-[rgba(255,255,255,0.07)] rounded-2xl p-8 md:p-10">
          <div className="flex items-center gap-2.5 mb-5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8B7CFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span className="font-display font-bold text-[16px] text-hi">Privacy & trust</span>
          </div>
          <p className="text-[14.5px] text-muted leading-[1.75]">
            Your network data is private to your account and is not sold. Funnl uses Supabase to store your information with per-user access controls.
            When you choose to use Funnl AI, the relevant network data is securely sent to Anthropic to generate your response.
            PostHog receives account identifiers and product-usage events, but never your contacts' names, companies, emails, notes, or conversation content.{' '}
            <Link to="/privacy" className="text-accent hover:text-tag transition-colors no-underline">Full privacy policy →</Link>
          </p>
        </div>
      </section>

      {/* ── Final CTA ───────────────────────────────────────────────────── */}
      <section className="border-t border-[rgba(255,255,255,0.06)]" style={{ background: 'linear-gradient(180deg,#0B0B0E,#0D0B18)' }}>
        <div className="max-w-[1080px] mx-auto px-5 md:px-8 py-20 md:py-28 text-center">
          <h2 className="font-display font-bold text-[32px] md:text-[42px] text-hi tracking-[-0.8px] mb-4 leading-[1.2]">
            Ready to stop losing track of your network?
          </h2>
          <p className="text-[15px] text-muted mb-10 max-w-[440px] mx-auto leading-relaxed">
            Free to start. No credit card. Add your first contact in under two minutes.
          </p>
          <button
            onClick={() => handleStartFree('bottom')}
            className="bg-[linear-gradient(135deg,#8B7CFF,#5B45F0)] text-white text-[15px] font-bold rounded-[12px] px-10 py-[14px] shadow-[0_8px_28px_rgba(91,69,240,0.4)] hover:opacity-90 transition-opacity"
          >
            Start for free
          </button>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-[rgba(255,255,255,0.06)] bg-base">
        <div className="max-w-[1080px] mx-auto px-5 md:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-[13px] text-low">© 2026 Funnl</span>
          <Link to="/privacy" className="text-[13px] text-low hover:text-mid transition-colors no-underline">
            Privacy Policy
          </Link>
        </div>
      </footer>

    </div>
  )
}

export default LandingPage
