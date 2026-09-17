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
          <p className="text-[14px] text-low">Last updated: September 2026</p>
          <div className="mt-4 px-4 py-3 bg-elevated border border-line-1 rounded-xl">
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
            <li><strong className="text-hi font-semibold">Connected-account authorization</strong> — if you connect Google Calendar or Gmail, Funnl stores the authorization (access tokens) Google issues so Funnl's servers can read the data you connected. These tokens are encrypted and are accessible only to Funnl's servers, never in your browser. Funnl never stores your Google password. Disconnecting, or deleting your account, removes this authorization from Funnl.</li>
            <li><strong className="text-hi font-semibold">Suggestions</strong> — if you connect a source such as Google Calendar or Gmail, Funnl may create a suggested interaction for you to review. A suggestion records which contact it is about, the date, the source it came from, and a short label so you can recognize it: a calendar event's title, or — for Gmail — the email's subject line for a limited time (see the Gmail section below). Nothing is added to your network until you accept a suggestion.</li>
          </ul>
          <p>
            Funnl does not collect data about you beyond what you explicitly enter or explicitly connect. Funnl does not read your LinkedIn. Funnl does not read your Gmail unless you explicitly connect it, and even then it reads only message headers, never the contents of your emails (described in the Gmail section below). If you choose to connect Google Calendar (described below), Funnl can read your calendar events on a read-only basis to help you log networking interactions — and only after you explicitly connect it. You can disconnect either source at any time.
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
              <p>When you use Funnl AI or the AI Fill feature, your contact and interaction data is sent to Anthropic's Claude API to generate responses. This means the content of your network — names, notes, interactions — is processed by Anthropic. Gmail data is never sent to Anthropic: suggestions that have not been accepted, and any retained email subject line, stay out of the AI features, and an accepted suggestion carries only the note you wrote yourself. Anthropic does not use API data to train their models. <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Anthropic privacy policy →</a></p>
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

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Google — optional Calendar and Gmail connections</p>
              <p>If, and only if, you choose to connect Google Calendar, Funnl uses Google's OAuth service to obtain read-only access to your calendar events. If, and only if, you choose to connect Gmail, Funnl separately asks Google for read-only Gmail access and uses it solely to read message headers, as described in the Gmail section below. Each is requested only when you start that connection; connecting one never silently adds the other. Your Google authorization tokens are stored encrypted on Funnl's servers and are never exposed to the browser. <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Google privacy policy →</a></p>
            </div>
          </div>
        </Section>

        <Section title="Google Calendar connection">
          <p>
            Connecting Google Calendar is entirely optional. Nothing is accessed until you explicitly connect it from Settings, and you can disconnect at any time.
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">What is accessed</strong> — read-only access to your Google Calendar events. Connecting Calendar does <strong className="text-hi font-semibold">not</strong> request or read Gmail; Gmail is a separate, optional connection described below.</li>
            <li><strong className="text-hi font-semibold">Why</strong> — to help you remember and log your networking interactions (for example, suggesting a meeting you had as an interaction to record). Funnl does not modify your calendar.</li>
            <li><strong className="text-hi font-semibold">How authorization is stored</strong> — the tokens Google issues are encrypted at rest. Authorization tokens are never exposed to your browser or unrelated third parties. They are used only by Funnl's servers when communicating with Google's authorization and Calendar APIs.</li>
            <li><strong className="text-hi font-semibold">Disconnect and deletion</strong> — disconnecting Google Calendar from Settings revokes Funnl's Google authorization on a best-effort basis and immediately deletes the stored Google tokens and connection from Funnl. Because Google issues one authorization for your whole Google account, disconnecting Calendar also removes any Gmail connection you had made. Deleting your account does the same and removes all of your data.</li>
          </ul>
        </Section>

        <Section title="Gmail connection (optional)">
          <p>
            Gmail connection is an optional feature and is not yet available to all accounts. Nothing below happens unless you explicitly connect Gmail from Settings, and you can disconnect at any time.
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">Why Funnl asks for Gmail</strong> — to notice when you have actually exchanged emails with someone already in your contacts, and to suggest that conversation as an interaction you may want to log. Every match is a suggestion you review; Funnl never adds an interaction on its own, never sends email, and never changes anything in your mailbox.</li>
            <li><strong className="text-hi font-semibold">What Funnl reads</strong> — only message <strong className="text-hi font-semibold">headers</strong>: the From, To, and Cc addresses, the date, the subject line, the message identifier, and a few headers that identify automated or bulk mail (such as List-Id and Auto-Submitted) so newsletters and notifications can be ignored. Funnl requests messages in Google's metadata-only format.</li>
            <li><strong className="text-hi font-semibold">What Funnl never reads or stores</strong> — the body or text of your emails, previews or snippets, HTML, attachments, images, raw message files, or any headers beyond the list above. Funnl's servers reject any message that arrives with body content rather than process it.</li>
            <li><strong className="text-hi font-semibold">Only people you already track</strong> — headers are compared against the email addresses of your own contacts. Messages with people who are not in your contacts, messages where a contact is only copied, and automated or bulk mail are discarded without being recorded.</li>
            <li><strong className="text-hi font-semibold">What is kept, and for how long</strong> — for a suggestion, Funnl stores the contact it concerns, the date, and the email's subject line (trimmed to 160 characters) so you can recognize the conversation. The subject line is deleted when you accept or dismiss the suggestion, when Funnl learns the email was deleted or moved to spam or trash, when you disconnect Gmail, or automatically after 30 days — whichever comes first. An accepted suggestion becomes an interaction that contains only the note you wrote; it never inherits the subject line or any other email content.</li>
            <li><strong className="text-hi font-semibold">No message identifiers are stored</strong> — to avoid suggesting the same conversation twice, Funnl keeps a one-way keyed fingerprint (HMAC-SHA256) of the conversation. It cannot be turned back into a message, thread, address, or subject.</li>
            <li><strong className="text-hi font-semibold">How it runs</strong> — a private server process checks connected mailboxes automatically in the background, reads a bounded amount of recent header data each time (it starts with roughly the last 90 days and then only changes), and stops when its limits are reached. Nothing runs in your browser and there is nothing for you to trigger.</li>
            <li><strong className="text-hi font-semibold">Where it is processed</strong> — Gmail header data is processed on Funnl's servers (Supabase Edge Functions) and the suggestion record is stored in Funnl's Supabase database under the same row-level security as the rest of your data. Gmail data is never sent to Anthropic, PostHog, Resend, or any advertising or analytics service.</li>
            <li><strong className="text-hi font-semibold">Authorization and encryption</strong> — the tokens Google issues are encrypted at rest (AES-256-GCM) and used only by Funnl's servers when talking to Google. They are never exposed to your browser.</li>
            <li><strong className="text-hi font-semibold">Disconnecting Gmail</strong> — disconnecting Gmail from Settings stops Funnl reading your mail immediately, deletes every Gmail suggestion you have not acted on together with its subject line, and discards Funnl's place in your mailbox history. Interactions you already accepted stay, and Google Calendar is not affected.</li>
            <li><strong className="text-hi font-semibold">One Google authorization, two connections</strong> — Google issues a single authorization for your Google account that covers everything you have granted Funnl. Funnl therefore cannot withdraw Gmail access on Google's side without also disconnecting Google Calendar, so disconnecting Gmail alone stops Funnl using the access rather than revoking it at Google. To remove the authorization at Google as well, use your Google Account's third-party access page — doing so also disconnects Google Calendar. Disconnecting Google Calendar in Funnl, or deleting your account, revokes the combined authorization and removes both connections.</li>
          </ul>
          <p>
            Funnl's use of information received from Google APIs adheres to the{' '}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Google API Services User Data Policy →</a>, including the Limited Use requirements. Google Calendar and Gmail data is used only to provide the interaction-logging and suggestion features you request. It is <strong className="text-hi font-semibold">not sold</strong>, <strong className="text-hi font-semibold">not transferred to advertisers, data brokers, or information resellers</strong>, <strong className="text-hi font-semibold">not used for advertising</strong>, <strong className="text-hi font-semibold">not used to train generalized or foundation AI models</strong>, and not read by a human at Funnl except with your explicit permission for a support request, for security investigation, or where the law requires it.
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
          </ul>
          <p>
            This data helps us understand which features are useful and where people get stuck, so we can improve the product.
          </p>
        </Section>

        <Section title="Your rights">
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">Delete your contacts</strong> — you can delete any contact or interaction from inside the app at any time.</li>
            <li><strong className="text-hi font-semibold">Disconnect a source</strong> — you can disconnect Google Calendar or Gmail from Settings at any time.</li>
            <li><strong className="text-hi font-semibold">Delete your account</strong> — you can delete your account from Settings, which removes your contacts, interactions, suggestions, and any Google authorization. You can also email <a href="mailto:navbir12345@gmail.com" className="text-accent hover:text-tag no-underline">navbir12345@gmail.com</a> and we'll delete it for you.</li>
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
