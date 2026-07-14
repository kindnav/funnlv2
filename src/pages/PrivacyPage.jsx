import { Link } from 'react-router-dom'

function Section({ title, children }) {
  return (
    <section className="mb-9">
      <h2 className="font-display text-[18px] font-bold text-hi mb-3">{title}</h2>
      <div className="text-[14.5px] text-muted leading-[1.75] space-y-3">{children}</div>
    </section>
  )
}

function PrivacyPage() {
  return (
    <div className="min-h-screen bg-base flex flex-col items-center px-5 py-12">

      {/* Back link */}
      <div className="w-full max-w-[680px] mb-8">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-hi transition-colors no-underline">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
          Back
        </Link>
      </div>

      <div className="w-full max-w-[680px]">

        {/* Header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-[10px] bg-[#4B3AF0] flex items-center justify-center flex-none shadow-[0_4px_14px_rgba(75,58,240,0.4)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="white"/>
              </svg>
            </div>
            <span className="font-display font-bold text-[20px] text-hi">Funnl</span>
          </div>
          <h1 className="font-display text-[32px] font-bold text-hi tracking-[-0.5px] mb-3">Privacy Policy</h1>
          <p className="text-[14px] text-low">Last updated: July 2026</p>
          <div className="mt-4 px-4 py-3 bg-[rgba(139,124,255,0.07)] border border-[rgba(139,124,255,0.18)] rounded-xl">
            <p className="text-[13.5px] text-muted leading-relaxed">
              This is a plain-language privacy policy written in good faith. It is not a legal document drafted by a lawyer.
              If you have questions, email <a href="mailto:navbir12345@gmail.com" className="text-accent hover:text-tag no-underline">navbir12345@gmail.com</a>.
            </p>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-[rgba(255,255,255,0.06)] mb-9"/>

        <Section title="What Funnl stores">
          <p>
            Funnl stores two categories of data:
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">Account information</strong> — your email address and password (encrypted). This is used to sign you in.</li>
            <li><strong className="text-hi font-semibold">Your network data</strong> — the contacts, interactions, and notes you choose to log inside Funnl. You control what goes in, and you can delete it at any time.</li>
          </ul>
          <p>
            Funnl does not collect any data about you beyond what you explicitly enter. We don't read your email inbox, LinkedIn, or any other account.
          </p>
        </Section>

        <Section title="Third parties we share data with">
          <p>Funnl uses the following third-party services to run. Here's what each one receives and why:</p>

          <div className="space-y-5 mt-1">
            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Supabase — database and authentication</p>
              <p>All of your data (account info, contacts, interactions) is stored in Supabase's PostgreSQL database and protected with row-level security so only your account can access your data. Supabase also handles sign-in and password reset. <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Supabase privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Anthropic (Claude) — powers AI features</p>
              <p>When you use Funnl AI or the AI Fill feature, your contact and interaction data is sent to Anthropic's Claude API to generate responses. This means the content of your network — names, notes, interactions — is processed by Anthropic. Anthropic does not use API data to train their models. <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Anthropic privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">PostHog — product analytics and error reporting</p>
              <p>Funnl uses PostHog to understand how people use the product (for example, whether they add contacts, log interactions, or use certain features). PostHog receives <strong className="text-hi font-semibold">usage behavior only</strong> — things like "a user logged an interaction." It never receives the content of your contacts — not names, companies, notes, emails, or anything you've typed.</p>
              <p className="mt-2">When the application encounters an unexpected crash, Funnl also sends a diagnostic error report to PostHog. This report includes the technical error type, error message, JavaScript stack trace, and basic application context (such as browser and session information) used to diagnose the crash. Funnl does not intentionally attach contact names, notes, companies, or other CRM content to these reports. Error messages are generated by the application itself and may in rare cases reflect technical context from an in-progress operation. <a href="https://posthog.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">PostHog privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Resend — transactional email</p>
              <p>Resend sends account confirmation emails and password reset links on Funnl's behalf. Your email address is passed to Resend to deliver these messages. <a href="https://resend.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Resend privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Vercel — web hosting</p>
              <p>Vercel serves the Funnl web application. Standard server logs (IP address, browser type, request details) may be retained briefly by Vercel as part of normal hosting operations. <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Vercel privacy policy →</a></p>
            </div>
          </div>
        </Section>

        <Section title="Analytics: behavior, not content">
          <p>
            PostHog sees <em>what you do</em> in Funnl, never <em>what your contacts say</em>. For example:
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>PostHog knows that you logged an interaction — it doesn't know what was said or who it was with.</li>
            <li>PostHog knows that you added a contact — it doesn't know their name, company, or any detail about them.</li>
            <li>PostHog knows that you used the AI chat feature — it doesn't know what you asked or what the response was.</li>
          </ul>
          <p>
            This data helps us understand which features are useful and where people get stuck, so we can improve the product.
          </p>
        </Section>

        <Section title="Your rights">
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">Delete your contacts</strong> — you can delete any contact or interaction from inside the app at any time.</li>
            <li><strong className="text-hi font-semibold">Delete your account</strong> — email <a href="mailto:navbir12345@gmail.com" className="text-accent hover:text-tag no-underline">navbir12345@gmail.com</a> and we'll delete your account and all associated data.</li>
            <li><strong className="text-hi font-semibold">Questions</strong> — email <a href="mailto:navbir12345@gmail.com" className="text-accent hover:text-tag no-underline">navbir12345@gmail.com</a> with any privacy questions.</li>
          </ul>
        </Section>

        <Section title="Cookies and local storage">
          <p>
            Funnl uses browser local storage and cookies to keep you signed in (via Supabase) and to run analytics (via PostHog). No advertising cookies are used.
          </p>
        </Section>

        {/* Footer */}
        <div className="h-px bg-[rgba(255,255,255,0.06)] mt-4 mb-8"/>
        <p className="text-[13px] text-lower text-center pb-8">
          Funnl · Questions? <a href="mailto:navbir12345@gmail.com" className="text-muted hover:text-hi transition-colors no-underline">navbir12345@gmail.com</a>
        </p>

      </div>
    </div>
  )
}

export default PrivacyPage
