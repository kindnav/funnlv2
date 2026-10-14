# Paste an email (Pro) — rollout

Owner packet for Draft PR #101. Nothing here has been run against Production. Each step needs its
own approval, in this order.

## What ships

| Part | What it is | How it reaches users |
|---|---|---|
| `ai-paste-email` Edge Function | New. Pro-only. Masks addresses, runs the minimization gate, drafts contact fields and a note, validates both. Saves nothing. | Deployed by hand (step 1). Nothing calls it until step 3. |
| Frontend | `PasteEmailDrawer`, a Pro-only "Paste email" button on Contacts and on a contact's page, and one paragraph in `/privacy`. | Merging the PR to `main` (Vercel deploys `main` only). |

There is no database change. Saved rows are ordinary `contacts` and `interactions` rows (`source` keeps its
default, `manual`). No Outlook file changes, and the Outlook consent version stays
`ol-disc-1b6906af498ccff0f1e3292027ca0539`: this is a separate feature with its own disclosure.

## The function

- **JWT:** `supabase/config.toml` has `[functions.ai-paste-email]` with `verify_jwt = true`; this is pinned
  by `tests/google-foundation-invariants.test.js`. The handler also calls `auth.getUser()` and then the
  shared Pro entitlement check before anything else.
- **Secrets:** `ANTHROPIC_API_KEY` (already set for the other AI functions). `SUPABASE_URL`,
  `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform. No new secret.
- **Import closure:** 6 files, SHA-256 over LF-normalised text, at the PR's pinned head:

  | File | SHA-256 |
  |---|---|
  | `ai-paste-email/index.ts` | `3958232d0c1b2ad0…` |
  | `shared/boundedJson.js` | `8575249c5c905456…` (unchanged from `main`) |
  | `shared/outlookContentSanitizer.js` | `fefd6a7acfb62233…` (unchanged from `main`) |
  | `shared/outlookDraftContract.js` | `5dc7756258ab38b6…` (unchanged from `main`) |
  | `shared/pasteEmail.js` | `dabaa735d799060a…` |
  | `shared/pro-entitlement.js` | `3f9015b99d476a82…` (unchanged from `main`) |

  Recompute these after any further change to the PR. **Every one of the 15 existing functions has an
  import closure byte-identical to `main` (`d670bfb`)**, the four Outlook functions included. Deploying
  this function therefore changes no other function.

## Order and steps

### 1. Deploy the function (owner approval)

From a clean checkout of the PR's pinned head:

```
npx supabase functions deploy ai-paste-email --project-ref jzybxhvgnksrwxfivdwt --use-api
```

Verify:

- The function list shows `ai-paste-email` with `verify_jwt = true`.
- Download it (`npx supabase functions download ai-paste-email --project-ref jzybxhvgnksrwxfivdwt`) and
  recompute the closure. It must match the table above byte for byte.
- An unauthenticated `POST` returns **401**. No session token is needed for this check, and none
  should be pasted anywhere.
- No other function's version changed.

Nothing user-visible changes yet: no page calls the function.

**Rollback:** delete the function (`npx supabase functions delete ai-paste-email --project-ref …`), or
leave it in place. It is unreachable from the app before step 3, and is JWT- and Pro-gated.

### 2. Set the publication date (with step 3's approval)

`/privacy` currently reads "Last updated: October 13, 2026". In the same commit that publishes, change it
to the **actual New York date of the merge**, and update the date pinned by the privacy tests
(`tests/privacy-policy-outlook.test.js` and any other test that asserts it). Run `npm test`.

### 3. Publish the frontend (owner approval)

Merge PR #101 at its pinned head. Vercel builds `main`.

Verify:

- The Vercel production deployment for the merge commit is READY.
- The served bundle contains the drawer ("Paste an email") and `/privacy` shows the approved paragraph
  and the new date.
- A non-Pro account sees no "Paste email" button.

**Rollback:** revert the merge commit on `main`; Vercel redeploys within minutes. The revert removes
the buttons and the privacy paragraph together. Contacts and interactions already saved stay; they
are ordinary rows the user reviewed. The function can stay deployed (unreachable) or be deleted as
in step 1.

### 4. Live acceptance (owner, after step 3)

Use **made-up emails** written for the test, not someone's real mail. In a Pro account:

1. From a contact's page, paste a short email with one clear `Date:` line and an offset. The review
   shows that contact, the date as your local day, and a drafted note. Save. One Email interaction
   is added; no contact is created.
2. On Contacts, paste a thread with **two other people who have different names, companies and
   roles**. Choose "A new contact", then pick each person in turn. Only that person's details
   appear; anything the email does not state about them stays blank. Save one.
3. Paste a thread with quoted history (`On … wrote:`). The date is left blank with a reason.
4. Paste text containing `Bearer` followed by a long random string. The request is refused with
   the access-token message.
5. In the Supabase function logs, `paste_email` lines carry only codes and counts.

Step 2 of this acceptance is the first test with the **real model**. Everything before it used a
simulated model (see Evidence below).

## Evidence before rollout

- `npm test`: unit tests for the server module (`tests/paste-email.test.js`) and the browser logic
  (`tests/paste-email-capture.test.js`).
- `tests/local/paste-email-browser.mjs`, run on demand (not part of `npm test`). It stands up:
  - real Postgres with every migration, real GoTrue, and real PostgREST;
  - the unmodified function in Supabase's edge-runtime;
  - a production build driven in headless Chrome.

  Anthropic is simulated. Kong's `verify_jwt` is emulated by the harness's gateway.

  It proves the paste, review and save flow, the guards, partial-save retry, double submission,
  clearing the paste, the failure paths, minimization refusal, input bounds, and Pro and auth
  enforcement. It also proves that the function's logs carry no paste text or model output.

  It does **not** prove the real model's attribution quality. The deterministic guards limit what a
  wrong attribution can do:
  - a name, company or role that does not appear in the email is dropped;
  - a duplicate name is dropped;
  - a company or role given to two people is removed from both;
  - nothing fills a new contact until the reviewer picks the person.

## Known limits

- Spelled-out addresses (`name [at] domain [dot] com`) are not recognised as addresses. They are
  neither masked nor refused. The published wording covers this ("the email addresses it
  recognises").
- Names, employers and phone numbers in the paste reach Anthropic, as disclosed.
- A role the model paraphrases rather than copies is left blank, because it is not found in the email.
