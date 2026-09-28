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
log, a screenshot, or a chat message.** Every step is designed to yield a yes/no answer
rather than a value. The local form file used in steps 3 and 5 is a blank template — the
state is pasted into the live page in browser memory and never saved.

### The one rule that governs the order

**Every authenticated start overwrites `__Host-fnl_oauth_bind`.** The cookie holds the
newest state and only the newest state. So the steps below are a single linear sequence
and must be run in order:

> **Start exactly twice, and only where a step says so.** One start before the S1 POST,
> one start after it. A third start — or a second start taken early "to save time" —
> rebinds the cookie to the newer state and makes the S1 positive control fail for a
> reason that has nothing to do with Vercel.

Before the S1 POST in step 3 there must be **no further start of any kind**: not a retry,
not a page reload that auto-triggers connect, not a second tab.

### What this check can and cannot tell you

Each step observes one **symptom**. None of them, on its own, identifies which layer
failed. Read the results as a gate first and a diagnosis second: any failure blocks the
rollout, and the "what to inspect next" notes are starting points, not conclusions.

### Step 1 — first start: mint S1, bind the cookie, and check the status code

In the **normal (non-private) browser**, signed in at `https://www.getfunnl.com`, with
DevTools open: trigger the Calendar connect action **once** (or issue the same
authenticated `POST /api/google-oauth-start` from the console).

This single action does three things at once — it mints **S1**, sets the browser's
binding cookie to S1, and gives the status code this step checks.

- **Expected: HTTP 200** with a JSON body containing a `url`. The state inside that URL
  is **S1**.
- **HTTP 401** is a failure of the gate and blocks the rollout. It is *consistent with*
  the rewrite not forwarding the `Authorization` or `apikey` header, because
  `google-oauth-start` runs with `verify_jwt = true` — but it is equally consistent with
  an expired session, a misconfigured function, or the function not being deployed. What
  to inspect next: whether the same request succeeds when sent directly to the Supabase
  functions host with identical headers. If direct succeeds and branded returns 401, the
  rewrite is the differing variable.

Record the outcome as `200` or `401`. Do not record the response body — it contains S1.

**Do not start again until step 4.**

### Step 2 — the cookie is stored for the right host, and S1 starts unconsumed

Two read-only observations. Neither involves a start.

**Cookie.** In DevTools → Application → Cookies, look at the entry for
`www.getfunnl.com`.

- **Expected:** a cookie named `__Host-fnl_oauth_bind` listed under host
  **`www.getfunnl.com`**, with `Path=/`, `Secure`, `HttpOnly`, `SameSite=None`. It holds
  S1, because step 1 was the most recent start.
- **Listed under `.supabase.co`** means the start call did not go through the branded
  path — check that the frontend used `/api/google-oauth-start` and that the rewrite
  exists.
- **Absent entirely** blocks the rollout. It is consistent with the rewrite dropping
  `Set-Cookie`, and also with the browser refusing the cookie: a `__Host-` cookie is
  rejected outright if it arrives without `Secure`, with a `Domain` attribute, or with a
  `Path` other than `/`. What to inspect next: the raw `Set-Cookie` header on the step-1
  response. If the header is present and well-formed but no cookie is stored, the browser
  rejected it; if the header is absent, look at the rewrite.

Record attribute presence only. Do not record the value.

**Starting condition.** Confirm **S1's `consumed_at` is null**. If it is already
non-null, you have read the wrong row — stop, and restart the sequence from step 1. Do
not proceed on a row whose starting condition you have not checked.

### Step 3 — positive control: does the binding reach the Edge callback?

This is the step a browser-only check cannot do. Steps 1 and 2 observe the browser; this
one observes the function.

Use a **synthetic refusal**: a cross-site, top-level form POST that mimics exactly what
Google sends when a user declines, without involving Google at all.

1. In the **same browser and session** as step 1 — whose cookie therefore still holds S1
   — open a local `file://` page holding a blank form template that POSTs `state` and
   `error=access_denied` to `https://www.getfunnl.com/api/google-oauth-callback`. Paste
   S1 into the live field in the page; do not save it into the file. A `file://` origin
   is cross-site relative to `www.getfunnl.com`, so this reproduces the
   `response_mode=form_post` condition — a cross-site top-level POST that only a
   `SameSite=None` cookie accompanies.
2. Submit. The response is a **303** to `https://www.getfunnl.com/settings?google=error`
   whether it passed or failed, so the redirect alone tells you nothing.
3. Re-read S1's `consumed_at`.

| S1 after the POST | What is established | What it does **not** establish |
|---|---|---|
| `consumed_at` **not null** | The binding check passed under this run: the cookie reached the function and the gate accepted it. **Step 3 PASSES.** | — |
| `consumed_at` **still null** | The binding check did **not** pass under this run. **Step 3 FAILS and blocks the rollout.** | It does *not* by itself prove Vercel stripped `Cookie`. It is equally consistent with the cookie never having been stored (step 2), with the browser declining to send it on a cross-site POST, with an extra start having rebound the cookie to a newer state, or with the wrong state having been pasted. |

If step 3 fails, inspect in this order: whether any additional start happened between
steps 1 and 3 (the commonest cause, and entirely self-inflicted); the request's own
`Cookie` header in the submitting browser's network panel (did the browser send it at
all?); then the Edge Function log for the controlled reason code — the callback logs
`binding_rejected` with a short reason such as `no_cookie_header` versus
`binding_mismatch`, and nothing else, no state, no cookie, no provider text.
`no_cookie_header` observed while the browser demonstrably sent `Cookie` is the specific
combination that points at the rewrite.

### Step 4 — second start: mint S2

**Only now**, with S1 already consumed, return to the normal browser and trigger the
Calendar connect action a **second** time. This mints **S2** and rebinds the cookie to
S2, which is harmless because S1's control is already finished.

Confirm **S2's `consumed_at` is null**. S2 must be a different row from S1. Never reuse
S1 for step 5: S1 was consumed in step 3, so reusing it would read a non-null
`consumed_at` regardless of the cookie and would silently invert the result.

### Step 5 — negative control: an unbound browser must be refused

Without this, a step-3 pass could mean something other than the binding working.

1. Open the same blank local form in a **private/incognito window** that has never
   visited the site in this session, so it carries **no** binding cookie. Paste S2 in.
2. Submit, then re-read S2's `consumed_at`.

> **Do not submit S2 from the normal browser.** After step 4 that browser holds a cookie
> bound to S2, so it would consume the row and produce a false failure of this control.
> The S2 POST must come from the private window only.

| S2 after the POST | Meaning |
|---|---|
| `consumed_at` **still null** | **PASSES.** An unbound browser was refused before the state was touched — which is also direct evidence that the gate runs before any database write. |
| `consumed_at` **not null** | **FAILS and blocks the rollout.** The callback consumed a state for a browser with no binding, so the gate is not effective in Production. Inspect whether the private window in fact carried a cookie, whether the POST was accidentally sent from the normal browser, and whether the deployed callback is the reviewed build. |

Both controls must give their expected result. A step-3 pass with a step-5 pass is the
gate; either alone is not.

### Verifying `consumed_at`

For each of the two rows, one narrowly scoped, read-only query returning a boolean and
nothing else — for example `consumed_at IS NOT NULL` for the single matching
`state_hash`. Do **not** select the hash, the PKCE ciphertext, the return origin, or the
user id, and do not print any of them. Each row is read twice: once before its POST to
establish the starting condition, once after. This query needs its own authorization as
Production database access; it is read-only and touches two ephemeral rows that expire
within ten minutes regardless.

### Sequence at a glance

| After | Starts so far | Cookie holds | S1 | S2 |
|---|---|---|---|---|
| Step 1 | 1 | S1 | unconsumed | not minted |
| Step 2 | 1 | S1 | unconsumed (confirmed) | not minted |
| Step 3 | 1 | S1 | **consumed** (pass) | not minted |
| Step 4 | 2 | S2 | consumed | unconsumed (confirmed) |
| Step 5 | 2 | S2 (normal browser, unused) | consumed | **still unconsumed** (pass) |

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

Until **both** controls pass — step 3 on S1 and step 5 on a second, fresh S2 — the
correct statement is: *a fix is written, reviewed and merged, and its production
mechanism is unverified.* It is not "resolved".

A step-3 pass on its own is not enough: it shows a bound browser can consume a state,
but not that an unbound one is refused. A step-5 pass on its own is not enough either:
an endpoint that consumed nothing at all would also produce it. The gate is the pair.
