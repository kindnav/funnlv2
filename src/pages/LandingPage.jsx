import { Link, useNavigate } from 'react-router-dom'
import { track } from '../lib/analytics'

function LandingPage() {
  const navigate = useNavigate()

  function handleStartFree(location) {
    track('landing_cta_clicked', { location })
    navigate('/signup')
  }

  return (
    <div className="relative bg-[#0A0910] text-[#F5F3FA] font-sans min-h-screen overflow-x-hidden">

      {/* Grain texture overlay */}
      <div
        className="fixed inset-0 z-[1] pointer-events-none"
        style={{
          opacity: 0.045,
          mixBlendMode: 'overlay',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* ── Nav ────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 bg-[rgba(10,9,16,0.75)] backdrop-blur-[14px] border-b border-[rgba(255,255,255,0.07)]">
        <div className="max-w-[1160px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-[9px]">
            <div className="w-[26px] h-[26px] rounded-[7px] bg-[#7C6BFF] flex items-center justify-center flex-none">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#0A0910"/>
              </svg>
            </div>
            <span className="font-display font-bold text-[17px] text-[#F5F3FA] tracking-[-0.2px]">Funnl</span>
          </div>
          <div className="flex items-center gap-[22px]">
            <Link to="/signin" className="text-[13px] font-medium text-[#9C97AC] hover:text-[#F5F3FA] transition-colors no-underline">
              Sign in
            </Link>
            <button
              onClick={() => handleStartFree('nav')}
              className="bg-[#F5F3FA] text-[#0A0910] text-[13px] font-bold rounded-full px-[18px] py-[9px] hover:bg-[#D6CFFF] transition-colors cursor-pointer border-0"
            >
              Start for free
            </button>
          </div>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative max-w-[1160px] mx-auto px-6 pt-[104px] pb-0 text-center">
        {/* Radial glow */}
        <div
          className="absolute top-5 left-1/2 -translate-x-1/2 w-[640px] h-[340px] rounded-full z-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse, rgba(124,107,255,0.22), transparent 70%)', filter: 'blur(40px)' }}
        />

        <div className="relative z-[2]">
          {/* Eyebrow */}
          <div className="inline-flex items-center gap-2 mb-7">
            <span className="w-[6px] h-[6px] rounded-full bg-[#7C6BFF] flex-none"/>
            <span className="font-mono text-[11.5px] font-semibold text-[#9C97AC] tracking-[1.2px] uppercase">
              Turn your network into outcomes
            </span>
          </div>

          {/* Headline */}
          <h1 className="font-display font-bold text-[38px] md:text-[68px] leading-[1.04] tracking-[-2px] text-[#F5F3FA] mb-[26px] mx-auto">
            Never let a warm<br/>
            <span className="relative inline-block">
              contact
              <span
                className="absolute left-[2%] right-[2%] bottom-[6px] h-[14px]"
                style={{ background: '#7C6BFF', opacity: 0.35, zIndex: -1, transform: 'skewX(-6deg)' }}
              />
            </span>{' '}go cold.
          </h1>

          {/* Subhead */}
          <p className="text-[17px] leading-[1.6] text-[#9C97AC] mx-auto mb-9 max-w-[480px]">
            Funnl helps students recruiting for competitive roles remember every coffee chat, follow up at the right moment, and keep a network that actually stays warm.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap items-center justify-center gap-[22px] mb-[60px]">
            <button
              onClick={() => handleStartFree('hero')}
              className="bg-[#7C6BFF] text-[#0A0910] text-[14.5px] font-bold rounded-full px-7 py-[15px] hover:bg-[#8F80FF] transition-colors inline-flex items-center gap-2 cursor-pointer border-0"
            >
              Start for free
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#0A0910" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6"/>
              </svg>
            </button>
            <a
              href="#how-it-works"
              className="text-[14.5px] font-semibold text-[#F5F3FA] hover:text-[#D6CFFF] transition-colors inline-flex items-center gap-[6px] no-underline"
            >
              See how it works
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6"/>
              </svg>
            </a>
          </div>
        </div>

        {/* Annotated product mock */}
        <div className="relative z-[2] max-w-[720px] mx-auto text-left">
          {/* Labels — hidden on mobile */}
          <div className="hidden md:block absolute top-[26px] left-[-30px] bg-[#141220] border border-[rgba(255,255,255,0.1)] rounded-[12px] px-[14px] py-[9px] shadow-[0_12px_28px_rgba(0,0,0,0.4)] z-[4] whitespace-nowrap">
            <span className="font-mono text-[11px] font-semibold text-[#D6CFFF]">tags by relationship →</span>
          </div>
          <div className="hidden md:block absolute top-[120px] right-[-30px] bg-[#141220] border border-[rgba(255,255,255,0.1)] rounded-[12px] px-[14px] py-[9px] shadow-[0_12px_28px_rgba(0,0,0,0.4)] z-[4] whitespace-nowrap">
            <span className="font-mono text-[11px] font-semibold text-[#FFC97A]">← follow-up reminders</span>
          </div>
          <div className="hidden md:block absolute bottom-[30px] left-[-26px] bg-[#141220] border border-[rgba(255,255,255,0.1)] rounded-[12px] px-[14px] py-[9px] shadow-[0_12px_28px_rgba(0,0,0,0.4)] z-[4] whitespace-nowrap">
            <span className="font-mono text-[11px] font-semibold text-[#7FE8D2]">conversation history →</span>
          </div>

          {/* Product card */}
          <div className="relative bg-[#141220] border border-[rgba(255,255,255,0.09)] rounded-[20px] p-[22px] shadow-[0_40px_90px_rgba(0,0,0,0.55)]">
            <div className="flex items-center justify-between mb-[18px]">
              <span className="font-display font-bold text-[15px] text-[#F5F3FA]">This week</span>
              <span className="font-mono text-[10.5px] font-bold text-[#FFC97A] bg-[rgba(255,184,77,0.14)] rounded-[6px] px-2 py-1 whitespace-nowrap">🔥 6-day streak</span>
            </div>
            <div className="flex flex-col gap-0.5 mb-4">
              <div className="flex items-center gap-3 py-[11px] border-b border-[rgba(255,255,255,0.07)]">
                <div className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-[12px] font-bold text-white flex-none" style={{ background: 'linear-gradient(135deg,#FF6B8A,#F0A020)' }}>PS</div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-[#F5F3FA] m-0">Priya Sharma</p>
                  <p className="text-[11.5px] text-[#635D74] m-0">Analyst · Goldman Sachs</p>
                </div>
                <span className="text-[9.5px] text-[#D6CFFF] bg-[rgba(124,107,255,0.14)] rounded-full px-2 py-[3px] flex-none">recruiter</span>
              </div>
              <div className="flex items-center gap-3 py-[11px]">
                <div className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-[12px] font-bold text-white flex-none" style={{ background: 'linear-gradient(135deg,#7C6BFF,#4B33E0)' }}>JK</div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-[#F5F3FA] m-0">James Kim</p>
                  <p className="text-[11.5px] text-[#635D74] m-0">Coffee chat · 2 weeks ago</p>
                </div>
                <span className="text-[10.5px] font-bold text-[#2FD4B6] bg-[rgba(47,212,182,0.15)] rounded-full px-[9px] py-[3px] flex-none whitespace-nowrap">On track</span>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-[6px]">
                <span className="text-[11.5px] font-semibold text-[#9C97AC]">Follow-ups on track</span>
                <span className="text-[11.5px] font-bold text-[#F5F3FA]">8/10</span>
              </div>
              <div className="w-full h-[7px] rounded-full bg-[rgba(255,255,255,0.08)] overflow-hidden">
                <div className="w-[80%] h-full rounded-full bg-[#7C6BFF]"/>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Marquee ticker ──────────────────────────────────────────────── */}
      <div className="relative z-[2] mt-[88px] border-t border-b border-[rgba(255,255,255,0.07)] bg-[#0F0D16] py-4 overflow-hidden">
        <div className="flex w-max animate-[funnl-marquee_26s_linear_infinite]">
          {[0, 1].map(i => (
            <div key={i} className="flex items-center gap-[14px] flex-none pr-[14px]">
              <span className="font-mono text-[12.5px] font-semibold text-[#9C97AC] tracking-[0.6px] whitespace-nowrap">REMEMBER EVERY CONVERSATION</span>
              <span className="text-[#7C6BFF]">✦</span>
              <span className="font-mono text-[12.5px] font-semibold text-[#9C97AC] tracking-[0.6px] whitespace-nowrap">NEVER MISS A FOLLOW-UP</span>
              <span className="text-[#7C6BFF]">✦</span>
              <span className="font-mono text-[12.5px] font-semibold text-[#9C97AC] tracking-[0.6px] whitespace-nowrap">KEEP YOUR NETWORK WARM</span>
              <span className="text-[#7C6BFF]">✦</span>
              <span className="font-mono text-[12.5px] font-semibold text-[#9C97AC] tracking-[0.6px] whitespace-nowrap">TURN CONNECTIONS INTO OUTCOMES</span>
              <span className="text-[#7C6BFF]">✦</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Problem statement ───────────────────────────────────────────── */}
      <section className="relative z-[2] max-w-[720px] mx-auto px-6 py-24 text-center">
        <p className="font-display font-medium text-[22px] leading-[1.6] text-[#D3CFE0] m-0 tracking-[-0.3px]">
          Most students track recruiting contacts in a spreadsheet — or nowhere at all. Conversations get forgotten, follow-ups get missed, and warm relationships go cold.
        </p>
      </section>

      {/* ── Feature spotlight ───────────────────────────────────────────── */}
      <section id="how-it-works" className="relative z-[2] max-w-[1000px] mx-auto px-6 pb-10">

        {/* Row 01 */}
        <div className="flex flex-col md:flex-row items-center gap-14 py-14 border-t border-[rgba(255,255,255,0.07)]">
          <div className="flex-1 w-full">
            <span className="font-mono text-[12px] font-bold text-[#635D74]">01</span>
            <h3 className="font-display font-bold text-[26px] tracking-[-0.5px] text-[#F5F3FA] mt-[10px] mb-3">Add a contact in seconds</h3>
            <p className="text-[14.5px] text-[#9C97AC] leading-[1.7] m-0 max-w-[360px]">Paste any text about a person or fill the form. Tag by relationship type so your network stays structured, not scattered.</p>
          </div>
          <div className="flex-1 w-full">
            <div className="bg-[#141220] border border-[rgba(255,255,255,0.09)] rounded-[16px] p-5 shadow-[0_20px_50px_rgba(0,0,0,0.4)]">
              <div className="flex items-start gap-3">
                <div className="w-[38px] h-[38px] rounded-[10px] bg-[rgba(124,107,255,0.18)] flex items-center justify-center flex-none">
                  <span className="font-display font-bold text-[12.5px] text-[#B4A8FF]">PS</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold text-[#F5F3FA] m-0">Priya Sharma</p>
                  <p className="text-[11.5px] text-[#635D74] m-0 mb-2">Analyst · Goldman Sachs</p>
                  <div className="flex gap-[6px] flex-wrap">
                    <span className="text-[10px] text-[#D6CFFF] bg-[rgba(124,107,255,0.12)] border border-[rgba(124,107,255,0.25)] rounded-full px-[9px] py-[3px] whitespace-nowrap flex-none">recruiter</span>
                    <span className="text-[10px] text-[#D6CFFF] bg-[rgba(124,107,255,0.12)] border border-[rgba(124,107,255,0.25)] rounded-full px-[9px] py-[3px] whitespace-nowrap flex-none">target firm</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Row 02 — reversed on desktop */}
        <div className="flex flex-col md:flex-row-reverse items-center gap-14 py-14 border-t border-[rgba(255,255,255,0.07)]">
          <div className="flex-1 w-full">
            <span className="font-mono text-[12px] font-bold text-[#635D74]">02</span>
            <h3 className="font-display font-bold text-[26px] tracking-[-0.5px] text-[#F5F3FA] mt-[10px] mb-3">Log the conversation</h3>
            <p className="text-[14.5px] text-[#9C97AC] leading-[1.7] m-0 max-w-[360px]">Write notes, set a follow-up date. The conversation lives with the contact, not buried in your notes app.</p>
          </div>
          <div className="flex-1 w-full">
            <div className="bg-[#141220] border border-[rgba(255,255,255,0.09)] rounded-[16px] p-5 shadow-[0_20px_50px_rgba(0,0,0,0.4)]">
              <div className="flex items-center justify-between mb-[10px]">
                <span className="text-[11px] font-semibold text-[#9C97AC] bg-[rgba(255,255,255,0.06)] rounded-full px-[10px] py-1">Coffee chat</span>
                <span className="text-[11px] text-[#635D74]">Jul 8, 2026</span>
              </div>
              <p className="text-[12.5px] text-[#9C97AC] leading-[1.6] m-0 mb-[10px]">Great conversation about the analyst program — she mentioned there are still open slots.</p>
              <div className="flex items-center gap-[7px]">
                <span className="w-[6px] h-[6px] rounded-full bg-[#FFB84D] flex-none"/>
                <span className="text-[11.5px] font-bold text-[#FFB84D]">Follow up Jul 22</span>
              </div>
            </div>
          </div>
        </div>

        {/* Row 03 */}
        <div className="flex flex-col md:flex-row items-center gap-14 py-14 border-t border-b border-[rgba(255,255,255,0.07)]">
          <div className="flex-1 w-full">
            <span className="font-mono text-[12px] font-bold text-[#635D74]">03</span>
            <h3 className="font-display font-bold text-[26px] tracking-[-0.5px] text-[#F5F3FA] mt-[10px] mb-3">Follow up on time</h3>
            <p className="text-[14.5px] text-[#9C97AC] leading-[1.7] m-0 max-w-[360px]">Your dashboard surfaces who's overdue and who's up next — no spreadsheet, no guessing.</p>
          </div>
          <div className="flex-1 w-full">
            <div className="bg-[#141220] border border-[rgba(255,255,255,0.09)] rounded-[16px] p-5 shadow-[0_20px_50px_rgba(0,0,0,0.4)]">
              <div className="flex items-center gap-[10px] py-[9px] border-b border-[rgba(255,255,255,0.07)]">
                <div className="w-[28px] h-[28px] rounded-full bg-[rgba(255,107,138,0.18)] flex items-center justify-center flex-none">
                  <span className="font-display font-bold text-[10px] text-[#FF8FA3]">JK</span>
                </div>
                <div>
                  <p className="text-[12px] font-semibold text-[#F5F3FA] m-0">James Kim</p>
                  <p className="text-[10.5px] text-[#FF8FA3] font-bold m-0">2 days overdue</p>
                </div>
              </div>
              <div className="flex items-center gap-[10px] py-[9px]">
                <div className="w-[28px] h-[28px] rounded-full bg-[rgba(240,160,32,0.2)] flex items-center justify-center flex-none">
                  <span className="font-display font-bold text-[10px] text-[#FFC15C]">PS</span>
                </div>
                <div>
                  <p className="text-[12px] font-semibold text-[#F5F3FA] m-0">Priya Sharma</p>
                  <p className="text-[10.5px] text-[#FFC15C] font-bold m-0">Today</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Funnl AI ────────────────────────────────────────────────────── */}
      <section className="relative z-[2] max-w-[1000px] mx-auto px-6 pb-24">
        <div
          className="border border-[rgba(124,107,255,0.3)] rounded-[22px] p-8 md:p-12 flex flex-col md:flex-row items-center gap-12"
          style={{ background: 'linear-gradient(160deg, rgba(124,107,255,0.09), rgba(20,18,32,0.5))', boxShadow: '0 0 60px rgba(124,107,255,0.08)' }}
        >
          {/* Left: copy */}
          <div className="flex-1 w-full">
            <div className="inline-flex items-center gap-[7px] mb-[18px]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#B4A8FF">
                <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"/>
              </svg>
              <span className="font-mono text-[11px] font-bold text-[#B4A8FF] tracking-[1.2px] uppercase">Funnl AI</span>
              <span className="font-mono text-[9.5px] font-bold text-[#0A0910] bg-[#FFC97A] rounded-[5px] px-[6px] py-[2px] whitespace-nowrap flex-none">PRO</span>
            </div>
            <h2 className="font-display font-bold text-[28px] tracking-[-0.5px] text-[#F5F3FA] m-0 mb-[14px] leading-[1.25]">Ask your network anything.</h2>
            <p className="text-[14.5px] text-[#9C97AC] leading-[1.7] m-0 mb-[22px] max-w-[380px]">Funnl AI reads your contacts and conversation history to answer questions in plain English — who's gone cold, who you know at a target firm, what to bring up in your next follow-up.</p>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-[10px]">
                <span className="text-[#7C6BFF] text-[13px] flex-none">✦</span>
                <span className="text-[13.5px] text-[#D3CFE0]">Surfaces contacts who are going cold</span>
              </div>
              <div className="flex items-center gap-[10px]">
                <span className="text-[#7C6BFF] text-[13px] flex-none">✦</span>
                <span className="text-[13.5px] text-[#D3CFE0]">Finds warm intros already in your network</span>
              </div>
              <div className="flex items-center gap-[10px]">
                <span className="text-[#7C6BFF] text-[13px] flex-none">✦</span>
                <span className="text-[13.5px] text-[#D3CFE0]">Suggests what to say in your next follow-up</span>
              </div>
            </div>
          </div>

          {/* Right: chat mock */}
          <div className="flex-1 w-full">
            <div className="bg-[#141220] border border-[rgba(255,255,255,0.09)] rounded-[16px] p-5 shadow-[0_20px_50px_rgba(0,0,0,0.4)]">
              <div className="flex justify-end mb-3">
                <div className="bg-[#7C6BFF] text-[#0A0910] text-[13px] font-semibold px-[14px] py-[10px] max-w-[80%]" style={{ borderRadius: '12px 12px 2px 12px' }}>
                  Who do I know at Goldman Sachs?
                </div>
              </div>
              <div className="flex justify-start mb-4">
                <div className="bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.08)] text-[#D3CFE0] text-[13px] leading-[1.6] px-[14px] py-3 max-w-[88%]" style={{ borderRadius: '12px 12px 12px 2px' }}>
                  <strong className="text-[#F5F3FA]">Priya Sharma</strong>, Analyst on the recruiting team — you had a coffee chat in June about the analyst program.
                </div>
              </div>
              <div className="flex justify-end mb-3">
                <div className="bg-[#7C6BFF] text-[#0A0910] text-[13px] font-semibold px-[14px] py-[10px] max-w-[80%]" style={{ borderRadius: '12px 12px 2px 12px' }}>
                  Who should I reach out to about biotech?
                </div>
              </div>
              <div className="flex justify-start">
                <div className="bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.08)] text-[#D3CFE0] text-[13px] leading-[1.6] px-[14px] py-3 max-w-[88%]" style={{ borderRadius: '12px 12px 12px 2px' }}>
                  <strong className="text-[#F5F3FA]">Alex Chen</strong> at Flagship Pioneering — you connected at the biotech career panel in May and haven't followed up yet.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Who it's for ────────────────────────────────────────────────── */}
      <section className="relative z-[2] max-w-[1000px] mx-auto px-6 pt-4 pb-24">
        <span className="font-mono text-[11px] font-bold text-[#7C6BFF] tracking-[1.5px] uppercase block mb-4">Who it's for</span>
        <h2 className="font-display font-bold text-[30px] tracking-[-0.5px] text-[#F5F3FA] m-0 mb-8 max-w-[520px] leading-[1.25]">Built for relationship-driven recruiting.</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            'Finance, consulting, VC, PE, and tech recruiting, where relationships close offers',
            'Students managing 20–100+ contacts across multiple firms and schools',
            "Anyone who's ever lost a warm contact because they forgot to follow up",
            'Recruiters tell you to stay in touch — Funnl makes that concrete',
          ].map((text, i) => (
            <div key={i} className="border border-[rgba(255,255,255,0.08)] rounded-[14px] px-[22px] py-5 flex items-start gap-3">
              <span className="font-mono text-[12px] text-[#635D74] flex-none mt-0.5">→</span>
              <span className="text-[14px] text-[#D3CFE0] leading-[1.6]">{text}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Comparison ──────────────────────────────────────────────────── */}
      <section className="relative z-[2] max-w-[1000px] mx-auto px-6 pb-24">
        <span className="font-mono text-[11px] font-bold text-[#7C6BFF] tracking-[1.5px] uppercase block mb-4">Why Funnl</span>
        <h2 className="font-display font-bold text-[30px] tracking-[-0.5px] text-[#F5F3FA] m-0 mb-8">Designed for this problem, not retrofitted.</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Spreadsheet */}
          <div className="border border-[rgba(255,255,255,0.08)] rounded-[18px] p-7 bg-[#0F0D16]">
            <p className="font-mono text-[11px] font-bold text-[#635D74] tracking-[1px] uppercase m-0 mb-5">Spreadsheet</p>
            <div className="flex flex-col gap-[14px]">
              {['Manual follow-up tracking', 'Notes scattered across cells', 'Tags need manual upkeep', 'No networking insights'].map(item => (
                <div key={item} className="flex items-center gap-[10px]">
                  <span className="text-[#635D74] text-[13px] flex-none">✕</span>
                  <span className="text-[13.5px] text-[#9C97AC]">{item}</span>
                </div>
              ))}
            </div>
          </div>
          {/* Funnl */}
          <div
            className="border border-[rgba(124,107,255,0.35)] rounded-[18px] p-7"
            style={{ background: 'linear-gradient(160deg, rgba(124,107,255,0.1), rgba(20,18,32,0.4))', boxShadow: '0 0 50px rgba(124,107,255,0.1)' }}
          >
            <p className="font-mono text-[11px] font-bold text-[#B4A8FF] tracking-[1px] uppercase m-0 mb-5">Funnl</p>
            <div className="flex flex-col gap-[14px]">
              {['Automatic follow-up visibility', 'Conversation history per contact', 'Tag and filter effortlessly', 'AI networking insights — Pro'].map(item => (
                <div key={item} className="flex items-center gap-[10px]">
                  <span className="text-[#2FD4B6] text-[13px] flex-none">✓</span>
                  <span className="text-[13.5px] text-[#F5F3FA]">{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Privacy & trust ─────────────────────────────────────────────── */}
      <section className="relative z-[2] max-w-[1000px] mx-auto px-6 pb-24">
        <div className="border border-[rgba(255,255,255,0.08)] rounded-[18px] px-9 py-8">
          <div className="flex items-center gap-[10px] mb-4">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#7C6BFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span className="font-display font-bold text-[15px] text-[#F5F3FA]">Privacy & trust</span>
          </div>
          <p className="text-[13.5px] text-[#9C97AC] leading-[1.75] m-0">
            Your network data is private to your account and is not sold. Funnl uses Supabase to store your information with per-user access controls. When you choose to use Funnl AI, the relevant network data is securely sent to Anthropic to generate your response. PostHog receives account identifiers and product-usage events, but never your contacts' names, companies, emails, notes, or conversation content.{' '}
            <Link to="/privacy" className="text-[#B4A8FF] hover:text-[#D6CFFF] transition-colors no-underline">Full privacy policy →</Link>
          </p>
        </div>
      </section>

      {/* ── Final CTA ───────────────────────────────────────────────────── */}
      <section className="relative z-[2] max-w-[1000px] mx-auto mb-24 px-6 text-center">
        <h2 className="font-display font-bold text-[32px] md:text-[46px] tracking-[-1px] text-[#F5F3FA] m-0 mb-7 leading-[1.15]">
          Stop losing track<br/>of your network.
        </h2>
        <button
          onClick={() => handleStartFree('bottom')}
          className="bg-[#7C6BFF] text-[#0A0910] text-[15px] font-bold rounded-full px-[34px] py-4 hover:bg-[#8F80FF] transition-colors cursor-pointer border-0"
        >
          Start for free
        </button>
        <p className="text-[12.5px] text-[#635D74] mt-5 m-0">Free to start · No credit card · 2 minutes to your first contact</p>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="relative z-[2] border-t border-[rgba(255,255,255,0.07)]">
        <div className="max-w-[1160px] mx-auto px-6 py-6 flex items-center justify-between gap-4 flex-wrap">
          <span className="text-[12.5px] text-[#635D74]">© 2026 Funnl</span>
          <Link to="/privacy" className="text-[12.5px] text-[#635D74] hover:text-[#9C97AC] transition-colors no-underline">
            Privacy Policy
          </Link>
        </div>
      </footer>

    </div>
  )
}

export default LandingPage
