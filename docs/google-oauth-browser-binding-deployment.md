# Deploying the Google OAuth browser binding

Companion to the browser-binding fix (PR #53). The fix makes
`google-oauth-callback` refuse any completion that does not present the
`__Host-fnl_oauth_bind` cookie issued by `google-oauth-start`.

**The whole fix depends on one unproven assumption:** that Vercel's rewrite for the
`/api/...` paths forwards `Set-Cookie` back to the browser and forwards the browser's
`Cookie` header on to the Supabase Edge Function. Nothing in this repository can prove
that. Until the check below passes, **the Production issue is not fixed** — and worse,
a half-working rewrite would fail closed and break every Calendar connection.

---

## Why the obvious check is not good enough

An earlier version of this plan said: open DevTools, click Connect, and confirm the
browser sends `Cookie` to `/api/google-oauth-callback`.

That proves only what the **browser** does — that the cookie was stored with the right
scope and attached to a cross-site POST. It says nothing about what **Vercel** does
with that header afterwards. A rewrite that silently strips `Cookie` on the way to the
origin, or strips `Set-Cookie` on the way back, would look identical in the Network
panel and still leave the gate permanently unsatisfied.

The check therefore has to observe the **Edge Function's own behaviour**, not the
browser's.

---

## The controlled check

Run after an approved deployment, before enabling the Calendar rollout flag. No Google
account and no Google consent are required at any point.

Throughout: **never paste a state value, cookie value, JWT, or secret into a ticket, a
log, a screenshot, or a chat message.** Every step below is designed to yield a
yes/no answer rather than a value.

### Step 1 — the rewrite forwards `Authorization` and `apikey`

Signed in at `https://www.getfunnl.com`, with DevTools open, trigger the Calendar
connect action (or issue the same authenticated `POST /api/google-oauth-start` from the
console).

- **Expected: HTTP 200** with a JSON body containing a `url`.
- **HTTP 401** means the rewrite did not forward the bearer token or the `apikey`
  header, and the start path is broken. Stop here.

This step is the header-forwarding proof: `google-oauth-start` is deployed with
`verify_jwt = true`, so a 200 is only reachable when both headers survived the rewrite.

Record the outcome as `200` or `401`. Do not record the response body — it contains the
state inside the authorization URL.

### Step 2 — the cookie is stored for the right host with the right attributes

In DevTools → Application → Cookies, look at the entry for `www.getfunnl.com`.

- **Expected:** a cookie named `__Host-fnl_oauth_bind` listed under host
  **`www.getfunnl.com`**, with `Path=/`, `Secure`, `HttpOnly`, `SameSite=None`.
- If it is listed under `.supabase.co`, the start call did not go through the branded
  path and the callback will never receive it.
- If it is absent entirely, the rewrite stripped `Set-Cookie`. Stop here.

Record attribute presence only. Do not record the value.

### Step 3 — the Edge callback actually receives the binding

This is the step the earlier plan was missing. Steps 1 and 2 are browser-side; this one
observes the function.

Use a **synthetic refusal**: a cross-site, top-level form POST that mimics exactly what
Google sends when a user declines, without involving Google at all.

1. In the same browser and the same session as step 1, take the `state` from the
   authorization URL returned in step 1 — handle it in DevTools only; do not write it
   down.
2. Create a local `file://` page containing a form that POSTs
   `state=<that state>&error=access_denied` to
   `https://www.getfunnl.com/api/google-oauth-callback`, and submit it. A `file://`
   origin is cross-site relative to `www.getfunnl.com`, so this reproduces the
   `response_mode=form_post` condition — a cross-site top-level POST that only a
   `SameSite=None` cookie accompanies.
3. Observe the response: a **303** to `https://www.getfunnl.com/settings?google=error`
   in both the pass and fail cases, so the redirect alone tells you nothing.

**The signal is state consumption**, and it is unambiguous by design:

| Cookie reached the function? | Callback behaviour | Observable |
|---|---|---|
| **Yes** | binding satisfied → state consumed, then the refusal branch runs | that state row's `consumed_at` is **not null** |
| **No** | binding gate rejects **before any database access** | that state row's `consumed_at` is **still null** |

Confirm with one narrowly scoped, read-only query against that single row, returning a
boolean and nothing else — for example `consumed_at IS NOT NULL` for the one matching
`state_hash`. Do **not** select the hash, the PKCE ciphertext, the return origin, or
the user id, and do not print any of them. This query needs its own authorization as
Production database access; it is read-only and touches exactly one ephemeral row that
expires within ten minutes regardless.

- **`consumed_at` not null → PASS.** The cookie survived the rewrite and the gate
  accepted it.
- **`consumed_at` still null → FAIL.** The rewrite does not forward `Cookie`. The fix
  cannot work as designed and must move to a `binding_hash` column with a
  differently-delivered secret. Do not enable the Calendar flag.

An optional secondary confirmation is an Edge Function log line: the callback logs the
controlled reason code `binding_rejected` (and nothing else — no state, no cookie, no
provider text) when the gate refuses. Its **absence** on a passing run, and its
presence on a deliberately cookie-less run, corroborate the state-consumption result.

### Step 4 — the negative control

Repeat step 3 in a **private/incognito window** that never performed step 1, so no
binding cookie exists. The state row must remain unconsumed and `binding_rejected` must
appear. Without this control, a "PASS" in step 3 could just mean the state expired or
was consumed by something else.

---

## Deployment order and the transition window

Four artefacts ship separately: the Vercel build (frontend + `vercel.json` rewrites),
and three Edge Functions (`google-oauth-start`, `gmail-oauth-start`,
`google-oauth-callback`).

**Order: merge → deploy the two start functions → deploy the callback → run the check.**

Deploying the callback *last* matters. The callback is the component that starts
demanding a cookie; every start deployed before it merely adds a cookie that the old
callback ignores.

| Window | State | Effect on users |
|---|---|---|
| **A.** Merge lands; new frontend + rewrites live; all three functions still old | The new frontend calls `/api/google-oauth-start`, which the new rewrite forwards to the **old** start. It returns a URL but **no cookie**. The old callback does not ask for one. | Flows still complete. **Still vulnerable** — the fix is not active yet. Keep this window short. |
| **B.** Start functions deployed; callback still old | New flows carry a cookie; the old callback ignores it. | No change for users. Still vulnerable until the callback lands. |
| **C.** Callback deployed | The gate is live. | See below. |

**In-flight flows at the moment the callback is deployed.** An OAuth state lives ten
minutes. Anyone who started a flow before the callback deploy and completes consent
after it has no cookie (window A) or has one (window B):

- Started in window A → **fails closed**: one generic "couldn't complete the Google
  connection" banner. No partial connection, no token written, no state burned — the
  gate returns before any database access, so the user simply clicks Connect again and
  succeeds.
- Started in window B → completes normally.

**Stale browser bundles.** A user whose tab still holds the pre-merge SPA bundle will
keep calling `supabase.functions.invoke('google-oauth-start')` directly, which sets the
cookie on `supabase.co` where the callback can never see it. Those attempts fail closed
until the tab is reloaded and picks up the new bundle. The blast radius is small today
because `VITE_CALENDAR_CONNECTION_ENABLED` gates the Settings card, but it is a real
brief regression and should be expected rather than treated as a bug.

**Rollback.** Redeploy the previous `google-oauth-callback` from Supabase deployment
history; the gate disappears and flows complete as before — reinstating the
vulnerability, so treat it as an emergency measure only. The frontend and rewrites are
backward-compatible with the old functions and do not need reverting.

---

## Status

Until step 3 passes, the correct statement is: *a fix is written, reviewed and merged,
and its production mechanism is unverified.* It is not "resolved".
