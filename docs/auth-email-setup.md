# Auth email setup — Funnl

Operational guide for auditing and improving the existing Resend.com + Supabase Auth email workflow,
diagnosing why confirmation emails land in Junk, and applying the pending security migration safely.

**Important:** Resend.com is Funnl's existing transactional email provider. This guide documents
how to audit, verify, and improve the existing setup. Do not install a second email provider or SDK.

---

## Overview

The confirmation email flow is:

```
User signs up → Supabase Auth issues a confirmation → Resend delivers the email → User clicks link → /welcome
```

**Deliverability status (as of 2026-07-13):**
- Resend domain `getfunnl.com` is **Verified** in Resend.com → Domains
- DKIM TXT verified at `resend._domainkey.getfunnl.com`
- SPF and return-path MX verified at `send.getfunnl.com` (custom return-path subdomain)
- Sender: `Funnl <team@getfunnl.com>`
- Email template saved in Supabase → Auth → Email Templates
- Gmail delivery: reaches **Primary inbox** ✓
- iCloud delivery: **lands in Junk** — unresolved (not a DNS failure; SPF/DKIM pass)
- Outlook: not yet tested

The remaining item before inviting students is resolving the iCloud Junk placement and completing the Outlook test.

---

## Part 1 — Audit the existing Resend.com configuration

Before changing anything, establish what is actually configured.

**In Resend.com → Domains:**
1. Open the Domains list.
2. Identify which domain is currently configured as the Funnl sending domain.
3. Note whether Resend shows it as **Verified**.
4. If it shows as Unverified or Pending, DNS records are missing or incorrect.

**In Supabase → Authentication → SMTP Settings:**
1. Confirm Custom SMTP is enabled (not Supabase's shared pool).
2. Record the exact Host, Port, Username, Sender email, and Sender name currently configured.
3. Confirm the Sender email uses the same domain that Resend shows as Verified.

**Record what you find before making any changes.** The existing configuration may already be
partially or fully correct — changing it without auditing first could make delivery worse.

---

## Part 2 — DNS audit for email authentication

DNS authentication records (SPF, DKIM, DMARC) help receiving mail servers verify that Resend is
authorized to send email on behalf of getfunnl.com. Correct DNS records authenticate the sender
and improve deliverability — they do not guarantee inbox placement.

**Resend.com is the authoritative source for the exact DNS record values required for your account
and domain.** Do not use values from any other source, including this document. Resend generates
the specific record names and values; copying them from elsewhere risks mismatches.

### Process

1. Open the existing domain in Resend.com → Domains → click the domain.
2. Resend lists every required DNS record with its type, name, and value.
3. Copy each record exactly as shown by Resend.
4. Open Cloudflare → DNS → getfunnl.com.
5. Compare each Resend-required record against what is currently in Cloudflare.
6. Add or update only the records that are missing or mismatched.

### Safety rules

- **SPF**: Do not create two TXT records beginning with `v=spf1` at the same hostname. If one
  already exists for another provider, merge the include statements into a single record.
- **DKIM**: Resend may require a CNAME record, not a TXT record. Copy the exact type from Resend.
- **MX**: Do not replace or remove root-domain MX records. Do not add MX records for a sending
  subdomain unless Resend specifically requires it.
- **Other records**: Do not delete records used by another email provider or Cloudflare service.
- DNS propagation can take up to 48 hours; most records propagate within 30 minutes.

### DMARC

1. Check whether a DMARC record (`_dmarc.getfunnl.com` TXT) already exists in Cloudflare.
2. Review the current policy before adding or changing a DMARC record.
3. Start with `p=none` (monitoring mode) before enforcing quarantine or reject.
4. If aggregate reports are wanted, use a dedicated monitoring mailbox or a legitimate DMARC
   reporting service — not a personal email address.
5. Do not add a subdomain DMARC policy without first understanding the root DMARC policy.
6. Do not weaken an existing working DMARC policy from quarantine or reject to none without
   understanding why it was configured.

### Verification

DNS is correct when Resend.com → Domains shows the domain as **Verified** with all records
passing. The Resend dashboard is the authoritative check — third-party tools are supplementary only.

### Verified sending configuration (2026-07-13)

Resend's registered sending domain for Funnl is **`getfunnl.com`** (the root domain). `send.getfunnl.com`
is the custom return-path subdomain Resend uses for SPF and bounce handling — it is not the Resend
sending domain itself.

- **DKIM**: TXT record at `resend._domainkey.getfunnl.com` — verified
- **SPF**: verified at `send.getfunnl.com` (custom return-path subdomain)
- **Return-path MX**: verified at `send.getfunnl.com` (custom return-path subdomain)
- **No root SPF record exists or is needed** — Resend's SPF lives on `send.getfunnl.com`; adding a
  root SPF record would have no effect on Resend's sending path and could interfere with other mail

The sender From address is `Funnl <team@getfunnl.com>`. Do not add a root SPF record or change
the Resend domain configuration.

---

## Part 3 — Email template

The source template is at `supabase/templates/confirm-signup.html`.

**Status: template saved in Supabase → Auth → Email Templates → Confirm signup (2026-07-13).
Subject line is set. Do not re-apply unless the template source changes.**

**This file is version-controlled source code. Committing it to the repository does NOT
automatically update the Supabase email template.** It must be copied into the Supabase
dashboard editor manually.

### To apply the template (if re-applying after changes)

1. Open `supabase/templates/confirm-signup.html` in a text editor.
2. Select all and copy the complete HTML.
3. Open Supabase → Authentication → Email Templates → Confirm signup.
4. Paste the copied HTML into the template editor, replacing the existing content.
5. Set the Subject line to:

   ```
   Confirm your email to start using Funnl
   ```

6. Save.
7. Test by completing the real signup flow (not the dashboard "Send test email" button, which
   uses a different code path).
8. Confirm the confirmation link in the received email reaches:

   ```
   https://www.getfunnl.com/welcome
   ```

The template uses `{{ .ConfirmationURL }}` — Supabase replaces this with the real signed URL
before sending. Do not remove this variable.

---

## Part 4 — Supabase URL configuration

These settings control where auth emails redirect the user. They are configured in the Supabase
dashboard — not in code.

**Supabase → Authentication → URL Configuration:**

| Setting | Required value |
|---|---|
| Site URL | `https://www.getfunnl.com` |
| Redirect URLs | `https://www.getfunnl.com/welcome` |
| Redirect URLs | `https://www.getfunnl.com/**` |
| Redirect URLs | `https://getfunnl.com/**` |

The apex (`getfunnl.com`) fallback is included because Cloudflare forwards apex to www, but
adding it avoids any edge case where Supabase validates the redirect before that HTTP redirect fires.

**What the code does (already in place):**

`handleSignUp` in `src/pages/SignInPage.jsx` passes:
- Production: `emailRedirectTo: 'https://www.getfunnl.com/welcome'`
- Local dev: `emailRedirectTo: window.location.origin + '/welcome'` (e.g. `http://localhost:5173/welcome`)

The production values must appear in the Supabase Redirect URLs allowlist or Supabase will
reject them.

**Local development testing against the linked Supabase project:**

Testing the confirmation and password-reset flows locally requires the exact localhost URLs to be
allowlisted in the same Supabase project. Add only the URLs for the port you use for auth testing,
for example:

```
http://localhost:5173/welcome
http://localhost:5173/reset-password
```

Use a stable port for auth testing — if the port changes, the new origin must be added. After
testing, unused localhost URLs can be removed from the allowlist. Do not add an unrestricted
wildcard that would cover arbitrary domains.

`handleForgotPassword` uses:
- Production: `redirectTo: 'https://www.getfunnl.com/reset-password'`
- Local dev: `window.location.origin + '/reset-password'`

---

## Part 5 — Deliverability diagnosis

**"Delivered" in Resend means the receiving mail server accepted the message. It does not mean
the message reached the inbox.**

The spam problem requires active testing to diagnose. Correct DNS records reduce the probability
of landing in spam but do not guarantee it.

### Test procedure

1. Create a fresh test account using a **Gmail address** you control.
2. Create a second test account using an **Outlook address** you control.
3. After each signup, allow several minutes for delivery before checking.
4. Check all folders:
   - **Gmail**: Inbox, Promotions, Spam
   - **Outlook**: Inbox, Other, Junk

### Inspecting the email headers in Gmail

1. Open the received email (or find it in Spam).
2. Click ⋮ → **Show original**.
3. Record:
   - **SPF**: pass, neutral, fail, or softfail
   - **DKIM**: pass or fail
   - **DMARC**: pass or fail
   - **From**: the visible sender address
   - **Return-Path**: the bounce address domain (should belong to Resend)
   - **Message-ID**: the domain in the message ID

4. Confirm the From address matches the brand and the verified Resend domain.
5. Confirm the link in the email uses `https://www.getfunnl.com/welcome` — not a localhost URL,
   Vercel preview URL, or apex URL without the www.

### Cross-reference with Resend logs

1. Open Resend.com → **Logs**.
2. Find the same message by recipient and timestamp.
3. Confirm the status: **accepted**, **delivered**, **delayed**, **bounced**, or **complained**.
4. "Delivered" in Resend logs means accepted by the receiving server, not inbox placement.

### Rendering and functional test

1. Open the email on mobile — confirm layout is readable.
2. Enable OS dark mode and open the email — confirm text is still readable.
3. Click the **Confirm email** button — confirm it reaches `/welcome`.
4. Click the **fallback URL** at the bottom — confirm it also reaches `/welcome`.
5. On the `/signup` page, complete signup and test the **Resend confirmation email** button:
   - confirm it shows "Sending…"
   - confirm it shows the 60-second countdown
   - confirm a second email arrives
6. Test password-reset delivery after any SMTP or DNS changes.

**Do not consider the spam problem fixed until real Gmail and Outlook inbox tests pass.**

---

## Part 6 — Leaked password protection

Supabase can refuse passwords that appear in known breach databases (Have I Been Pwned).

**Supabase → Authentication → Password Protection:**
- Enable "Check passwords against known breached passwords".

This is enforced server-side and requires no code changes.

**Status: this setting requires the Supabase Pro plan.** Open Supabase → Authentication → Password Protection. If the toggle is present, confirm it is enabled. If the toggle is absent entirely, the current plan does not include this feature — upgrade to Pro or leave it undone and note it as a known gap.

---

## Part 7 — Security migration (handle_new_user hardening)

The migration `supabase/migrations/20260713185900_harden_handle_new_user.sql` revokes direct
EXECUTE access on `public.handle_new_user()` from `PUBLIC`, `anon`, and `authenticated`.

**Status: applied to production 2026-07-13 via `supabase db push`. Verified.**

Post-migration verification confirmed:
- `PUBLIC` absent from explicit ACL on `handle_new_user()`
- `anon` and `authenticated` effective execute = `false`
- `on_auth_user_created` trigger still enabled
- Function owner, `SECURITY DEFINER`, and `search_path` unchanged

`handle_new_user()` is a `SECURITY DEFINER` function that runs with its owner's privileges.
It auto-creates a `profiles` row on user signup. It should only be invoked by the database
trigger (`on_auth_user_created`) — broad EXECUTE grants to API-accessible roles are unnecessary.

### Application workflow

Do not paste the migration SQL directly into the Supabase SQL Editor. Running migrations through
the SQL Editor does not record them in Supabase's migration history table, which would leave
`supabase migration list` and `supabase db push` out of sync.

Use the Supabase CLI instead:

1. Run `supabase migration list` — confirm the migration appears locally but not remotely.
2. Run `supabase db push --dry-run` — preview what would be applied without making changes.
3. Confirm the only pending migration is `20260713185900_harden_handle_new_user.sql`.
4. Obtain explicit approval to proceed.
5. Run `supabase db push` to apply.
6. Re-run `supabase migration list` — verify local and remote history now match.

### Post-application verification queries

Run these in Supabase SQL Editor after applying, not before.

```sql
-- 1. Inspect explicit ACL grants (grantee IS NULL = the PUBLIC pseudo-role)
SELECT
  p.proname AS function_name,
  CASE WHEN r.oid IS NULL THEN 'PUBLIC' ELSE r.rolname END AS grantee,
  e.privilege_type,
  e.is_grantable
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(
  COALESCE(p.proacl, acldefault('f'::"char", p.proowner))
) e
LEFT JOIN pg_roles r ON r.oid = e.grantee
WHERE p.proname = 'handle_new_user'
  AND n.nspname = 'public';
```

After applying, `PUBLIC` should not appear as a grantee in this result.

```sql
-- 2. Confirm effective execute permission for API roles
SELECT
  r.rolname,
  has_function_privilege(r.oid, p.oid, 'execute') AS has_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN pg_roles r
WHERE p.proname = 'handle_new_user'
  AND n.nspname = 'public'
  AND r.rolname IN ('anon', 'authenticated')
ORDER BY r.rolname;
```

Expected after migration: `has_execute = false` for both `anon` and `authenticated`.

### Required functional test

After applying the migration, create a new test account through the real signup flow and confirm:
- The `profiles` table contains a new row for the test user.
- The `ai_enabled` column is `false`.
- The `email` column is populated.

This confirms the `on_auth_user_created` trigger still fires correctly. The trigger is expected
to be unaffected because `handle_new_user()` is `SECURITY DEFINER` and runs with its owner's
privileges — but a real test is required to confirm before any production traffic depends on it.

**Do not apply the migration, run these commands, or run verification queries until the workflow
above has been followed and approval has been obtained.**

---

## Checklist (before inviting real students)

### Resend.com
- [x] Domain `getfunnl.com` shows **Verified** in Resend.com → Domains
- [x] Sender `Funnl <team@getfunnl.com>` confirmed; Supabase SMTP aligned
- [x] Recent confirmation emails in Resend Logs show `delivered`

### Cloudflare DNS
- [x] SPF verified at `send.getfunnl.com` (custom return-path subdomain — no root SPF record needed or present)
- [x] DKIM TXT verified at `resend._domainkey.getfunnl.com`
- [x] Return-path MX verified at `send.getfunnl.com`
- [x] DMARC record present at `_dmarc.getfunnl.com` with `p=none` and reporting address
- [x] Resend.com → Domains shows all records as passing

### Supabase
- [x] Custom SMTP enabled with Resend
- [x] Site URL = `https://www.getfunnl.com`
- [x] Redirect URLs include `https://www.getfunnl.com/welcome` and `https://www.getfunnl.com/**`
- [x] Confirm signup template saved — `supabase/templates/confirm-signup.html` applied 2026-07-13
- [x] Subject set to: Confirm your email to start using Funnl
- [ ] Leaked password protection: confirm enabled in Supabase → Auth → Password Protection

### End-to-end delivery tests
- [x] Gmail test: confirmation email arrives in **Primary inbox** — SPF, DKIM, DMARC pass
- [ ] iCloud test: currently **lands in Junk** — unresolved (DNS is not the cause)
- [ ] Outlook test: not yet tested
- [x] Confirmation link in email reaches `https://www.getfunnl.com/welcome`
- [x] Resend confirmation button shows 60-second countdown

### Routing (code)
- [x] `/welcome` and `/reset-password` always render full-screen, outside the Sidebar/BottomNav shell — fixed in App.jsx 2026-07-13
- [x] `emailRedirectTo: welcomeRedirectUrl` in both `handleSignUp` and `handleResend`

### Security migration
- [x] `supabase db push` applied 2026-07-13
- [x] Privilege verification: `has_execute = false` for `anon` and `authenticated`; `PUBLIC` absent from ACL
- [ ] New signup test after migration: confirm `profiles` row created with correct fields
