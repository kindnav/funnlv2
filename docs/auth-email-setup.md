# Auth email setup — Funnl

Operational guide for configuring Supabase auth emails, Resend SMTP, DNS, and deliverability.
Not a code guide — these are Supabase dashboard + DNS steps.

---

## Overview of what's in play

| Layer | What it does | Where to configure |
|---|---|---|
| Supabase auth | Issues confirmation and password-reset emails | Supabase dashboard → Auth |
| Resend (SMTP) | Delivers the emails from noreply@getfunnl.com | Supabase → Auth → SMTP + Resend dashboard |
| Cloudflare DNS | SPF/DKIM/DMARC records that prevent spam classification | Cloudflare → getfunnl.com DNS |
| Email template | HTML rendered inside the confirmation email | `supabase/templates/confirm-signup.html` → pasted into Supabase |
| Redirect URL | Where the confirmation link sends the user | Supabase → Auth → URL Configuration |
| Leaked password check | Refuses passwords found in data breaches | Supabase → Auth → Password Protection |

---

## Part 1 — Resend SMTP setup

Resend must be connected to Supabase so outgoing auth emails use getfunnl.com as the sender address, not Supabase's shared sending pool.

**In Resend dashboard (resend.com):**
1. Verify domain `getfunnl.com` — add the DNS records it requests (SPF, DKIM). Already done; verify the green check marks are still present.
2. Create an API key with "Sending access" only. Copy it immediately (shown once).

**In Supabase → Authentication → SMTP Settings:**
1. Enable Custom SMTP.
2. Host: `smtp.resend.com`
3. Port: `465` (SSL) — preferred; or `587` with STARTTLS.
4. Username: `resend`
5. Password: the Resend API key from above.
6. Sender email: `noreply@getfunnl.com`
7. Sender name: `Funnl`
8. Save.

**Test it:**
Trigger a confirmation email to a personal Gmail address. Check Resend dashboard → Logs for delivery status. If it bounces or lands in spam, see Part 3.

---

## Part 2 — Cloudflare DNS records

Three DNS TXT records are required for proper email authentication. All are set on `getfunnl.com` in Cloudflare.

### SPF (already set; verify)
```
Type: TXT
Name: @
Value: v=spf1 include:_spf.resend.com -all
```
Tells receiving servers that only Resend's infrastructure is authorized to send mail for getfunnl.com.

### DKIM (already set; verify)
Resend provides a CNAME record during domain verification. Should already be present — check that the green check is still showing in the Resend dashboard.

### DMARC (critical — add if not present)
```
Type: TXT
Name: _dmarc
Value: v=DMARC1; p=none; rua=mailto:navbir12345@gmail.com
```
`p=none` is monitoring mode — it collects reports but does not reject or quarantine mail.
After 2–4 weeks of clean reports, change to `p=quarantine`, and eventually `p=reject`.

**In Cloudflare:** DNS → Add record → TXT, name `_dmarc`, value as above. Proxy: DNS-only (grey cloud).

Propagation takes up to 48 hours but usually under 30 minutes.

---

## Part 3 — Email template

The custom HTML template at `supabase/templates/confirm-signup.html` should be pasted into:

**Supabase → Authentication → Email Templates → Confirm signup**

1. Open `supabase/templates/confirm-signup.html` in a text editor.
2. Select all, copy.
3. In Supabase: Authentication → Email Templates → "Confirm signup" → paste into the HTML editor.
4. Subject line: `Confirm your Funnl account`
5. Save.

The template uses `{{ .ConfirmationURL }}` — Supabase replaces this with the real confirmation link before sending.

**Do not** remove the `{{ .ConfirmationURL }}` variable or the fallback plain-text URL — both are required.

---

## Part 4 — URL configuration

These settings control where auth emails redirect the user.

**Supabase → Authentication → URL Configuration:**

| Setting | Value |
|---|---|
| Site URL | `https://www.getfunnl.com` |
| Redirect URLs | `https://www.getfunnl.com/welcome` |
| Redirect URLs | `https://www.getfunnl.com/**` |
| Redirect URLs | `https://getfunnl.com/**` (apex fallback) |

Apex (`getfunnl.com`) should not be removed — Cloudflare forwards apex to www, but adding it here handles any edge cases where Supabase resolves the redirect before the HTTP redirect fires.

**How the redirect URL reaches Supabase:**

Since `@supabase/supabase-js` v2.108+, `signUp()` explicitly passes `emailRedirectTo`:

```js
supabase.auth.signUp({
  email,
  password,
  options: { emailRedirectTo: 'https://www.getfunnl.com/welcome' },
})
```

This is set in `src/pages/SignInPage.jsx` via the module-level `welcomeRedirectUrl` constant, which uses `import.meta.env.PROD` to switch between the production URL and `window.location.origin` in dev.

---

## Part 5 — Deliverability verification

After completing Parts 1–4, run a full end-to-end test:

1. Sign up with a fresh Gmail address at `https://www.getfunnl.com/signup`.
2. Check the inbox. The email should arrive within 30 seconds.
3. Check that it's **not** in spam. If it is:
   - Open the email, click "Not spam" in Gmail to train the filter.
   - Check Resend dashboard → Logs for any DMARC/DKIM/SPF failures.
   - Verify the DNS records are correctly propagated using [mxtoolbox.com](https://mxtoolbox.com/).
4. Click the confirmation link. It should redirect to `https://www.getfunnl.com/welcome`.
5. On the welcome page, the `WelcomePage` component signs the session out, then shows "You're all set — continue to sign in."

Tools for verifying DNS:
- `dig txt _dmarc.getfunnl.com` — check DMARC record
- `dig txt getfunnl.com` — check SPF record
- [mail-tester.com](https://www.mail-tester.com/) — send a test email and get a spam score (use the provided address as the test signup email)

---

## Part 6 — Leaked password protection

Supabase can refuse passwords that appear in data breach databases (Have I Been Pwned).

**Supabase → Authentication → Password Protection:**
- Enable "Check passwords against known breached passwords"

This reduces the risk of account takeover from credential stuffing. No code changes needed — Supabase enforces this server-side.

---

## Security: handle_new_user trigger

`handle_new_user()` is a `SECURITY DEFINER` PostgreSQL function that runs as the function owner (superuser level) whenever a new auth user is created. This elevated privilege is intentional — the trigger needs to INSERT into `profiles`, bypassing RLS.

However, the function's EXECUTE permission should be restricted so it can only be called by the trigger (via the `postgres` superuser role), not by API roles (`anon`, `authenticated`, `PUBLIC`).

**Migration file:** `supabase/migrations/YYYYMMDDHHMMSS_harden_handle_new_user.sql`

```sql
-- Prevent API roles from calling handle_new_user() directly.
-- The trigger still fires correctly (SECURITY DEFINER runs as function owner,
-- not as the calling role; the trigger fires via the superuser Postgres role).
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
```

**How to apply:** run in Supabase SQL Editor once this migration is reviewed and approved.

**Verification query (run before applying):**
```sql
SELECT
  p.proname AS function_name,
  r.rolname AS grantee,
  has_function_privilege(r.oid, p.oid, 'execute') AS has_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN pg_roles r
WHERE p.proname = 'handle_new_user'
  AND n.nspname = 'public'
  AND r.rolname IN ('anon', 'authenticated', 'public')
ORDER BY r.rolname;
```

Expected output after migration: `has_execute = false` for all three roles.

---

## Checklist before inviting students

- [ ] Resend domain verification shows green in Resend dashboard
- [ ] SMTP settings saved in Supabase, test email delivered to inbox (not spam)
- [ ] DMARC record added in Cloudflare
- [ ] Email template pasted into Supabase → Email Templates → Confirm signup
- [ ] Site URL = `https://www.getfunnl.com` in Supabase URL Configuration
- [ ] Redirect URLs include `https://www.getfunnl.com/welcome` and `https://www.getfunnl.com/**`
- [ ] Leaked password protection enabled
- [ ] End-to-end test: sign up → inbox → confirm → /welcome → sign in → dashboard
