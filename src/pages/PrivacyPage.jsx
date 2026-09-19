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
          <p className="text-[14px] text-low">Last updated: September 18, 2026</p>
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
            Funnl stores two categories of data:
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">Account information</strong> — your email address and your sign-in credentials. Authentication is managed by Supabase Auth; Funnl never stores your password in plain text.</li>
            <li><strong className="text-hi font-semibold">Your network data</strong> — the contacts, interactions, and notes you choose to log inside Funnl. You control what goes in, and you can delete it at any time.</li>
            <li><strong className="text-hi font-semibold">Connected-account authorization</strong> — if you connect Google Calendar or Gmail, Funnl stores the authorization (access tokens) Google issues so Funnl's servers can read the data you connected. These tokens are encrypted and are accessible only to Funnl's servers, never in your browser. Funnl never stores your Google password. Disconnecting the entire Google connection (from the Google Calendar card in Settings) or deleting your account removes this authorization from Funnl. Disconnecting Gmail alone disables Gmail processing but retains the shared Google authorization if Google Calendar remains connected; see the Gmail section below.</li>
            <li><strong className="text-hi font-semibold">Suggestions</strong> — if you connect a source such as Google Calendar or Gmail, Funnl may create a suggested interaction for you to review. A suggestion records which contact it is about, the date, the source it came from, and a short label so you can recognize it: a calendar event's title, or — for Gmail — a shortened subject line while the suggestion is pending (see the Gmail section below). Nothing is added to your network until you accept a suggestion.</li>
            <li><strong className="text-hi font-semibold">Connection bookkeeping</strong> — for a connected source, Funnl keeps the status of the connection, the position it has reached in that source (for Gmail, an internal history cursor), timestamps, retry state, and short result codes so background checks can resume safely. These records are used only by Funnl's servers.</li>
          </ul>
          <p>
            Funnl does not access Google Calendar or Gmail unless you explicitly connect them. Funnl also processes the limited account, usage, diagnostic, cookie, and hosting information described in this policy. Funnl does not read your LinkedIn. Funnl does not read your Gmail unless you explicitly connect it, and even then it reads only message headers, never the contents of your emails (described in the Gmail section below). If you choose to connect Google Calendar (described below), Funnl can read your calendar events on a read-only basis to help you log networking interactions — and only after you explicitly connect it. You can disconnect either source at any time.
          </p>
        </Section>

        <Section title="Third parties we share data with">
          <p>Funnl uses the following third-party services to run. Here's what each one receives and why:</p>

          <div className="space-y-5 mt-1">
            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Supabase — database and authentication</p>
              <p>All of your data (account info, contacts, interactions, suggestions) is stored in Supabase's PostgreSQL database and protected with row-level security so only your account can access your data. If you connect Google Calendar or Gmail, Supabase also processes and stores the limited connection data described below: encrypted Google authorization tokens, connection and capability status, the synchronization cursor and state, one-way fingerprints, suggestions, and any temporarily retained subject preview. Funnl's server-side functions that talk to Google also run on Supabase. Supabase also handles sign-in and password reset. <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Supabase privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Anthropic (Claude) — powers AI features</p>
              <p>When you use Funnl AI or the AI Fill feature, your contact and interaction data is sent to Anthropic's Claude API to generate responses. This means the content of your network — names, notes, interactions — is processed by Anthropic. Pending suggestions and any retained email subject line are not sent to Anthropic. When you accept a suggestion, the type, date, and note you reviewed become an ordinary interaction in your network, and if you later use Funnl AI those fields may be sent to Anthropic like any other interaction. Raw Gmail messages, headers, subject lines, message or thread identifiers, and Google tokens are never sent to Anthropic. Anthropic does not use API data to train their models. <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Anthropic privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">PostHog — product analytics and error reporting</p>
              <p>Funnl uses PostHog to understand how people use the product (for example, whether they add contacts, log interactions, or use certain features). To tie events to your account, PostHog receives your Funnl account identifier and your <strong className="text-hi font-semibold">account email address</strong>, together with controlled usage events — things like "a user logged an interaction" or "a user connected Gmail." It does not receive the content of your contacts — not names, companies, notes, contact email addresses, or anything you've typed — and Funnl does not send it Gmail message content, retained subject lines, mailbox or correspondence addresses, provider identifiers, tokens, or provider responses. Automatic capture of page interactions is disabled.</p>
              <p className="mt-2">When the application encounters an unexpected crash, Funnl also sends a diagnostic error report to PostHog. This report includes the technical error type, error message, JavaScript stack trace, and basic application context (such as browser and session information) used to diagnose the crash. Funnl does not intentionally attach contact names, notes, companies, or other CRM content to these reports. Error messages are generated by the application itself and may in rare cases reflect technical context from an in-progress operation. <a href="https://posthog.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">PostHog privacy policy →</a></p>
            </div>

            <div className="pl-4 border-l-2 border-[rgba(255,255,255,0.08)]">
              <p className="font-semibold text-hi mb-1">Resend — transactional email</p>
              <p>Resend sends account confirmation emails and password reset links on Funnl's behalf. Your Funnl account email address is passed to Resend to deliver these messages; no Gmail mailbox content or Gmail-derived suggestion data is ever sent to Resend. <a href="https://resend.com/privacy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Resend privacy policy →</a></p>
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
            <li><strong className="text-hi font-semibold">Disconnect and deletion</strong> — disconnecting Google Calendar from Settings revokes Funnl's Google authorization on a best-effort basis and immediately deletes the stored Google tokens and the Google connection from Funnl, together with the connection's capability, cursor, and reference records. Because Google issues one authorization for your whole Google account, this also ends any Gmail connection you had made. Funnl removes pending Gmail suggestions from your active Suggestions and erases their retained subject lines and context. The minimal terminal suggestion record and its one-way fingerprint remain only to prevent the same conversation from being suggested again, and are deleted when you delete the related contact or your account (see the Gmail section). Deleting your account removes all of your data.</li>
          </ul>
        </Section>

        <Section title="Gmail connection (optional)">
          <p>
            Gmail connection is an optional feature and is not yet available to all accounts. Nothing below happens unless you explicitly connect Gmail from Settings, and you can disconnect at any time.
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-hi font-semibold">Why Funnl asks for Gmail</strong> — to notice when you have actually exchanged emails with someone already in your contacts, and to suggest that conversation as an interaction you may want to log. Every match is a suggestion you review; Funnl never adds an interaction on its own, never sends email, and never changes anything in your mailbox.</li>
            <li><strong className="text-hi font-semibold">What Funnl processes while checking your mail</strong> — Funnl asks Google for messages in its metadata-only format and requests only these headers: the From, To, and Cc addresses, the Date, the Subject, the Message-ID, and a few headers that identify automated or bulk mail (Auto-Submitted, X-Auto-Response-Suppress, Precedence, List-Id, List-Unsubscribe). While a check runs, Funnl's servers also handle the Gmail message and conversation identifiers, message timestamps, the Gmail labels that tell it whether a message is in your inbox, sent mail, spam, or trash, the page cursors Gmail uses within that single check, the address of the connected mailbox, and the other response fields needed to keep each check bounded. This is transient processing on Funnl's servers and is discarded when the check finishes; the only position marker Funnl keeps between checks is the history cursor described under "What Funnl keeps".</li>
            <li><strong className="text-hi font-semibold">What Funnl does not read</strong> — Funnl never requests message bodies, HTML, attachments, images, or raw messages, and never stores them. Google may include a short preview ("snippet") in its metadata response; Funnl's code does not read, copy, use, display, store, or log it. Headers other than those listed above are discarded. If a response unexpectedly contains body content, Funnl rejects that message rather than process it.</li>
            <li><strong className="text-hi font-semibold">Only people you already track</strong> — headers are compared against the email addresses of your own contacts. Messages with people who are not in your contacts, messages where a contact is only copied, and automated or bulk mail are discarded without being recorded.</li>
            <li><strong className="text-hi font-semibold">How checks run</strong> — a private server process checks connected mailboxes automatically in the background. The first check looks back roughly 90 days; after that, Funnl processes only new and changed messages using Gmail's change history. Every check is limited in the number of pages, messages, conversations, and bytes it will read, how many requests it makes at once, and how long it may run. Nothing runs in your browser and there is nothing for you to trigger.</li>
            <li><strong className="text-hi font-semibold">What Funnl keeps</strong> — (1) your Google authorization tokens, encrypted at rest with AES-256-GCM and used only by Funnl's servers; (2) the status of your Gmail connection; (3) a persisted Gmail history cursor (Gmail's own position marker for your mailbox, not a message), plus timestamps, retry state, and short result codes, so the next check can pick up where the last one ended — this is different from the page cursors above, which live only for one check; (4) for each suggestion: the contact it concerns, the date, the type, the fact that it came from Gmail, and — while it is pending — the email's subject line shortened to at most 160 characters so you can recognize the conversation; (5) a one-way keyed fingerprint (HMAC-SHA256, with the version of the key used) of the conversation, so the same conversation is not suggested twice. Raw Gmail message and conversation identifiers are not stored in suggestions or in Funnl's email reference records. The history cursor and the fingerprints are used only by Funnl's servers and are never sent to your browser.</li>
            <li><strong className="text-hi font-semibold">Subject lines</strong> — a retained subject line is deleted when you accept or dismiss the suggestion, when Funnl learns the email was deleted or moved to spam or trash, when you disconnect Gmail from Settings, when you disconnect Google Calendar (which ends the whole Google connection), or when you delete your account. An accepted suggestion becomes an interaction that contains only the type, date, and note you reviewed; it never inherits the subject line or any other email content.</li>
            <li><strong className="text-hi font-semibold">Fingerprints and suggestion records</strong> — after you accept, dismiss, or Funnl invalidates a suggestion, its record (without the subject line) and its fingerprint remain so the conversation is not suggested again. They are deleted when you delete the contact they concern or delete your account.</li>
            <li><strong className="text-hi font-semibold">Where it is processed</strong> — Gmail header data is processed by Funnl's server-side functions and stored in Funnl's database, both hosted by Supabase, under the same row-level security as the rest of your data. Nothing Funnl derives from Gmail is used for advertising or sold to anyone.</li>
            <li><strong className="text-hi font-semibold">Disconnecting Gmail</strong> — disconnecting Gmail from Settings stops Funnl using your Gmail access immediately, turns off the Gmail connection, deletes Funnl's Gmail synchronization state and persisted history cursor, and removes every pending Gmail suggestion from your Suggestions and erases its subject line. As described under "Fingerprints and suggestion records", the minimal record and its fingerprint remain so the conversation is not suggested again. Interactions you already accepted stay, and Google Calendar is not affected.</li>
            <li><strong className="text-hi font-semibold">One Google authorization, two connections</strong> — Google issues a single authorization for your Google account that covers everything you have granted Funnl. Funnl therefore cannot withdraw Gmail access on Google's side without also disconnecting Google Calendar, so disconnecting Gmail alone stops Funnl using the access rather than revoking it at Google. To remove the authorization at Google as well, use your Google Account's third-party access page — doing so also disconnects Google Calendar. Disconnecting Google Calendar in Funnl, or deleting your account, revokes the combined authorization and removes both connections. Whichever way Gmail ends — Gmail-only disconnect or whole-Google disconnect — pending Gmail suggestions are removed from your Suggestions and their subject lines and context are erased, and only the minimal terminal record and fingerprint remain until you delete the related contact or your account.</li>
          </ul>
          <p>
            Funnl's use and transfer of information received from Google APIs adheres to the{' '}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-tag no-underline">Google API Services User Data Policy →</a>, including the Limited Use requirements. Specifically, Google Calendar and Gmail data is used only to provide the interaction-logging and suggestion features you can see and use in Funnl. It is <strong className="text-hi font-semibold">not sold</strong>, <strong className="text-hi font-semibold">not transferred to advertisers, data brokers, or information resellers</strong>, <strong className="text-hi font-semibold">not used for advertising or retargeting</strong>, <strong className="text-hi font-semibold">not used to determine creditworthiness or for lending</strong>, and <strong className="text-hi font-semibold">not used to train generalized or foundation AI models</strong>. Service providers process it only as necessary to provide those features. It is not read by a person at Funnl except with your explicit permission for a support request, for security investigation such as abuse or a suspected breach, or where the law requires it. You can disconnect either source from Settings, and delete your account from Settings, at any time.
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
            <li>PostHog knows which account did these things (your account identifier and account email) — it doesn't know anything you read or wrote in Gmail, or who you emailed.</li>
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
