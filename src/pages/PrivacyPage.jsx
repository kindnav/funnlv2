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
            <div className="w-9 h-9 rounded-[10px] bg-ember flex items-center justify-center flex-none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M3 4H21L15 12.5V20H9V12.5Z" fill="white"/>
              </svg>
            </div>
            <span className="font-display font-bold text-[20px] text-hi">Funnl</span>
          </div>
          <h1 className="font-display text-[32px] font-bold text-hi tracking-[-0.5px] mb-3">Privacy Policy</h1>
          {/* DRAFT DATE: October 19, 2026 (the day this revision was prepared). If it is published on a later day,
              change this date in the same commit that publishes it. */}
          <p className="text-[14px] text-low">Last updated: October 19, 2026</p>
          <div className="mt-4 px-4 py-3 bg-elevated border border-line-1 rounded-xl">
            <p className="text-[13.5px] text-muted leading-relaxed">
              This policy explains, in plain language, what Funnl collects, how it is used, who processes it, and how to remove it.
              If you have questions, email <a href="mailto:navbir12345@gmail.com" className="text-accent hover:text-tag no-underline">navbir12345@gmail.com</a>.
            </p>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-[rgba(255,255,255,0.06)] mb-9"/>

        <Section title="What Funnl stores">
          <p>
            Funnl stores the following:
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">Account information</strong> — your email address and your sign-in credentials. Authentication is managed by Supabase Auth; Funnl never stores your password in plain text.</li>
            <li><strong className="text-hi font-semibold">Your network data</strong> — the contacts, interactions, and notes you choose to log inside Funnl, including anything you saved from a pasted email or accepted from a suggestion while Funnl's calendar and email connections were available. You control what goes in, and you can delete it at any time.</li>
            <li><strong className="text-hi font-semibold">Records left from retired connections</strong> — Funnl's Google Calendar, Gmail and Outlook connections have been retired. A small number of records from them remain for now; they are described under "Retired connections" below.</li>
          </ul>
          <p>
            Funnl does not connect to Google Calendar, Gmail or Outlook, and it does not read your calendar, your mailbox or your LinkedIn. Funnl also processes the limited account, usage, diagnostic, cookie, and hosting information described in this policy.
          </p>
        </Section>

        <Section title="Third parties we share data with">
          <p>Funnl uses the following third-party services to run. Here's what each one receives and why:</p>

          <div className="space-y-5 mt-1">
            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Supabase — database and authentication</p>
              <p>All of your data (account information, contacts, interactions) is stored in Supabase's PostgreSQL database and protected with row-level security so only your account can access your data. The records left from retired connections, described below, are stored there too. Funnl's server-side functions, including the ones behind Funnl AI, pasting an email, and account deletion, also run on Supabase. Supabase also handles sign-in and password reset. <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Supabase privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Anthropic (Claude) — powers AI features</p>
              <p>When you use Funnl AI or the AI Fill feature, your contact and interaction data is sent to Anthropic's Claude API to generate responses. This means the content of your network — names, notes, interactions — is processed by Anthropic. An interaction you accepted from a suggestion is an ordinary interaction, so if you use Funnl AI it may be sent to Anthropic like any other. The records left from retired connections are not sent to Anthropic. <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Anthropic privacy policy →</a></p>
              <p className="mt-2" data-testid="privacy-paste-email"><strong className="text-hi font-semibold">Paste an email (Pro).</strong> If you paste an email into Funnl, the text you paste — which can include what the other person wrote, names, employers and phone numbers — is sent to Anthropic to draft a contact and an interaction note for you to review. Before sending it, Funnl replaces the email addresses it recognises with a placeholder and withholds the request if anything still looks like an email address or an access token; Funnl cannot guarantee that every identifying detail is removed. The email addresses Funnl finds stay within Funnl: they are used only to match the email to your contacts and, if you choose, to fill in a new contact's email. Funnl does not store the text you paste; only the contact and interaction you review and save are kept.</p>
              <p className="mt-2" data-testid="privacy-anthropic-terms"><strong className="text-hi font-semibold">How Anthropic handles this data.</strong> Every AI request Funnl makes — Funnl AI, AI Fill, smart CSV import and pasting an email — goes to Anthropic's commercial API. Under Anthropic's current published terms, <strong className="text-hi font-semibold">by default</strong> Anthropic does not use inputs or outputs from its commercial products to train its models; its policy describes exceptions, such as data explicitly reported to Anthropic as feedback. Anthropic deletes API inputs and outputs within <strong className="text-hi font-semibold">30 days</strong> of receiving or generating them, except where it keeps them longer to enforce its Usage Policy — inputs and outputs for <strong className="text-hi font-semibold">up to 2 years</strong>, and trust-and-safety classification scores for <strong className="text-hi font-semibold">up to 7 years</strong> — where the law requires it, or where a customer has agreed different terms or uses a longer-retention service under its own control. Funnl does not have a Zero Data Retention agreement with Anthropic, uses only Anthropic's standard message API rather than a longer-retention service, and cannot have an individual API record deleted on request. These are Anthropic's terms as published when this policy was last updated, and Anthropic can change them; earlier requests were handled under the terms in effect when they were sent.{' '}
                <a href="https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Anthropic: how long data is stored →</a>{' '}
                <a href="https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Anthropic: model training →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">PostHog — product analytics and error reporting</p>
              <p>Funnl uses PostHog to understand how people use the product (for example, whether they add contacts, log interactions, or use certain features). To tie events to your account, PostHog receives your Funnl account identifier and your <strong className="text-hi font-semibold">account email address</strong>, together with controlled usage events — things like "a user logged an interaction" or "a user added a contact." It does not receive the content of your contacts — not names, companies, notes, contact email addresses, or anything you've typed — and Funnl does not send it the text of an email you paste, the addresses of people you correspond with, or any content, provider identifier or token from the retired connections. Automatic capture of page interactions is disabled.</p>
              <p className="mt-2">When the application encounters an unexpected crash, Funnl also sends a diagnostic error report to PostHog. This report includes the technical error type, error message, JavaScript stack trace, and basic application context (such as browser and session information) used to diagnose the crash. Funnl does not intentionally attach contact names, notes, companies, or other CRM content to these reports. Error messages are generated by the application itself and may in rare cases reflect technical context from an in-progress operation. <a href="https://posthog.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">PostHog privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Resend — transactional email</p>
              <p>Resend sends account confirmation emails and password reset links on Funnl's behalf. Your Funnl account email address is passed to Resend to deliver these messages; no email you paste and no data from the retired connections is sent to Resend. <a href="https://resend.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Resend privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Vercel — web hosting</p>
              <p>Vercel serves the Funnl web application. Standard server logs (IP address, browser type, request details) may be retained briefly by Vercel as part of normal hosting operations. <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Vercel privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Google and Microsoft — retired connections</p>
              <p>Funnl used Google's and Microsoft's sign-in services for its optional Google Calendar, Gmail and Outlook connections. Those connections have been retired: Funnl no longer asks Google or Microsoft for access and no longer stores authorization tokens from either. See "Retired connections" below. <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Google privacy policy →</a> <a href="https://privacy.microsoft.com/privacystatement" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Microsoft privacy statement →</a></p>
            </div>
          </div>
        </Section>

        {/* ── Retired connections ──────────────────────────────────────────────────────────────
            Google Calendar, Gmail and Outlook were retired in October 2026. This section describes
            the CURRENT state only. The wording that applied while those connections were available
            is in this file's git history, and the Outlook consent record (src/lib/outlookDisclosure.js,
            with its version identifiers) is kept unchanged as evidence of what was agreed to.
            Each claim here is pinned by tests/privacy-policy-retired-integrations.test.js. Do not
            say provider access was revoked everywhere, that every record was erased, or that backups
            were destroyed - none of those is established. ─────────────────────────────────────── */}
        <Section title="Retired connections: Google Calendar, Gmail and Outlook">
          <p>
            Funnl used to offer optional connections to Google Calendar, Gmail and Outlook that could suggest interactions for you to review. These connections have been <strong className="text-hi font-semibold">retired</strong>. Funnl no longer offers them, and they cannot be connected.
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">Nothing is read any more</strong> — Funnl no longer reads any calendar or mailbox. The automatic background processing has stopped, and the server functions that connected to Google and Microsoft have been removed.</li>
            <li><strong className="text-hi font-semibold">Stored authorization was deleted</strong> — Funnl deleted the connection records and the encrypted authorization tokens it held, so it can no longer use Google or Microsoft access. Deleting them from Funnl does not necessarily remove Funnl from the list of apps connected to your Google or Microsoft account. If Funnl still appears there, you can remove it yourself: in your <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Google Account's third-party access page</a>, or in your <a href="https://account.live.com/consent/Manage" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Microsoft account's app permissions</a> (for a work or school account, your organisation's <a href="https://myapps.microsoft.com" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">My Apps</a> page or administrator).</li>
            <li><strong className="text-hi font-semibold">What you saved stays yours</strong> — if you accepted a suggestion, the contact or interaction you saved is an ordinary Funnl record. It stays in your network, may show a small "Google Calendar" or "Outlook" label saying where it came from, and you can edit or delete it like anything else.</li>
            <li><strong className="text-hi font-semibold">Records that remain for now</strong> — some records from these connections, each belonging to the account that used them, are still in Funnl's database:
              <ul className="list-disc pl-5 space-y-1 mt-2">
                <li><strong className="text-hi font-semibold">settled suggestion records</strong> — suggestions that were accepted, dismissed, or withdrawn by Funnl. Each keeps the contact it was about, the date, the interaction type, which connection it came from, and a one-way fingerprint that cannot be turned back into an email or an event. A suggested interaction can also still hold the note it proposed: for Google Calendar, the event's title (up to 200 characters); for Outlook, a drafted summary of the email exchange (up to 2,000 characters). Email subject lines, suggested next steps, and the details proposed for a new contact were erased when each suggestion was settled. No suggestion is still waiting for review;</li>
                <li><strong className="text-hi font-semibold">one expired Outlook sign-in attempt</strong>, which can no longer be used.</li>
              </ul>
              These records are not used for anything and are never shown in the app. Row-level security means no other account can read them, and deleting your account deletes yours. Funnl intends to remove the rest in a later cleanup and has not yet set a date.</li>
            <li><strong className="text-hi font-semibold">Keys kept on Funnl's servers</strong> — separately, Funnl's servers still hold the keys that were used to encrypt the authorization tokens and to create the fingerprints. They are shared server-side keys, not records in anyone's account, so deleting your account does not remove them. They are no longer used, and Funnl has not yet set a date for destroying them.</li>
            <li><strong className="text-hi font-semibold">Backups</strong> — deleting your account, or any of the records above, removes it from Funnl's database. It does not remove copies that may exist in backups kept by Funnl's database provider.</li>
            <li><strong className="text-hi font-semibold">Email extracts sent to Anthropic before retirement</strong> — while Outlook was available to invited accounts, Funnl sent Anthropic (Claude) a minimized extract of selected email exchanges to draft suggestions, through the same commercial API described under "How Anthropic handles this data" above. Those requests were handled under Anthropic's terms in effect when they were sent; the terms described above are Anthropic's current ones.</li>
          </ul>
          <p>
            Funnl's use and transfer of information received from Google APIs adhered to the{' '}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Google API Services User Data Policy →</a>, including the Limited Use requirements. Google Calendar and Gmail data was used only to provide the interaction-logging and suggestion features you could see and use in Funnl. Neither it nor the Outlook data Funnl received, nor what remains of either, is <strong className="text-hi font-semibold">sold</strong>, <strong className="text-hi font-semibold">transferred to advertisers, data brokers, or information resellers</strong>, <strong className="text-hi font-semibold">used for advertising or retargeting</strong>, <strong className="text-hi font-semibold">used to determine creditworthiness or for lending</strong>, or <strong className="text-hi font-semibold">used to train generalized or foundation AI models</strong>. It is not read by a person at Funnl except with your explicit permission for a support request, for a security investigation such as abuse or a suspected breach, or where the law requires it.
          </p>
        </Section>

        <Section title="Analytics: behavior, not content">
          <p>
            PostHog sees <em>what you do</em> in Funnl, never <em>what your contacts say</em>. For example:
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>PostHog knows that you logged an interaction — it doesn't know what was said or who it was with.</li>
            <li>PostHog knows that you added a contact — it doesn't know their name, company, or any detail about them.</li>
            <li>PostHog knows that you used the AI chat feature — it doesn't know what you asked or what the response was.</li>
            <li>PostHog knows which account did these things (your account identifier and account email) — it doesn't know what is in your network or in any email you paste.</li>
          </ul>
          <p>
            This data helps us understand which features are useful and where people get stuck, so we can improve the product.
          </p>
        </Section>

        <Section title="Your rights">
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">Delete your contacts</strong> — you can delete any contact or interaction from inside the app at any time.</li>
            <li><strong className="text-hi font-semibold">Remove Funnl from Google or Microsoft</strong> — Funnl's connections are retired, so there is nothing left to disconnect inside Funnl. If Funnl still appears in your Google or Microsoft account's list of connected apps, you can remove it there (see "Retired connections").</li>
            <li><strong className="text-hi font-semibold">Delete your account</strong> — you can delete your account from Settings, which removes your contacts, interactions, and your records left from the retired connections. It does not remove Funnl's shared server keys or any backup copies (see "Retired connections"). You can also email <a href="mailto:navbir12345@gmail.com" className="text-accent hover:text-tag no-underline">navbir12345@gmail.com</a> and we'll delete it for you.</li>
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
