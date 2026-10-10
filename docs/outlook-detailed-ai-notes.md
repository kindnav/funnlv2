# Detailed AI interaction notes

The product promise is that Outlook capture *reduces* manual entry. Until this change the
generated note was capped at 200 characters, which holds a label for an exchange — "She
replied about the insight week" — but not its substance. A user who wanted to remember the
advice, the offer, the commitment or the date had to retype it, so the capture saved them
almost nothing. This workstream raises the generated note to a practical bounded allowance and
tells the model to record what was actually said.

Nothing here is applied, deployed or published. The pilot stays on its current approved
configuration (worker flag present, `outlook-worker-tick` active, worker v49).

---

## 1. What the generated note should contain

One prose paragraph recording, **only where the selected messages state them**:

- what was discussed, and why it mattered;
- concrete advice given;
- offers made, and by whom;
- commitments either side made;
- named dates, deadlines and events;
- agreed next steps;
- questions left unresolved.

With the people, companies, roles, teams and programmes the messages name.

**Length follows the exchange.** Up to 2,000 characters are available; the prompt instructs the
model to use what the exchange supports and no more — a two-line thank-you is one sentence, a
multi-topic referral conversation is several. Padding, repetition, generic networking advice
and any detail the messages do not state are forbidden, and the pre-existing rules still
govern every sentence: report only what the text states explicitly, never infer from a domain
or a name, return `null` rather than guess, never emit an address or a URL, defer on sensitive
topics, paraphrase rather than quote, and every proposal is a draft a human reviews.

**Form.** One paragraph, no line breaks. The generated note stays plain prose because the
draft columns forbid control characters; the *reviewer's* own note has carried line breaks and
tabs since `20261010120000`, so structure is something the user adds while editing. Letting the
model emit line breaks would mean widening the control-character rule on two columns and in
both producers, which buys little and is deliberately out of scope here.

## 2. Why 2,000 characters

| Bound | Value | Why |
|---|---|---|
| Generated note | **2,000** | Holds the seven kinds of fact above for a bounded six-message exchange. Roughly 300 words — long enough to be useful, short enough that padding is obvious to a reviewer. |
| Reviewer's own note | 10,000 (unchanged) | Every generated draft therefore fits the editor and both acceptance paths with room to expand. |
| Next step | 160 (unchanged) | It is one action, not a paragraph. |
| Output budget | 2,048 tokens | A 2,000-character note is ~500 tokens; the budget must also carry the next step, the name triple, the evidence enums and the JSON envelope. Thinking stays disabled, so the whole allowance is visible output. |
| Request ceiling | 20,000 chars (unchanged) | The exchange sent to the model is already bounded at 4,000 characters per message and 12,000 per episode. |

A response cut off by the output budget now reports `model_truncated` rather than
`unparseable_json`: either way nothing is stored — a partial note is never a draft — but an
operator can tell a budget problem from a schema problem.

## 3. What changed, end to end

| Layer | File | Change |
|---|---|---|
| Prompt | `shared/outlookDraftContract.js` (`SYSTEM_CONTRACT`) | New sections: what the summary must record; length follows the exchange; form. All prior absolute rules unchanged. |
| Schema | same (both schemas) | The `summary` description asks for the detailed note, states the bound and repeats the no-padding rule. |
| Output budget | same (`DRAFT_MAX_TOKENS`) | 1,024 → 2,048. |
| Validator | same (`BOUNDS.summary`) | 200 → 2,000. Over-long is **refused**, never trimmed. Control characters, URLs and the sensitive-topic rule unchanged. |
| Diagnostic | same (`parseDraftPayload`) | `model_truncated` when unparseable JSON stopped on `max_tokens`. |
| Column CHECKs | `20261010180000` | `interaction_candidates_notes_len`, `interaction_candidates_draft_summary_bounds`, `ncc_summary_bounds`: 200 → 2,000. Control-character and URL rules kept. |
| Producer RPCs | `20261010180000` | `upsert_outlook_interaction_candidate` and `upsert_new_contact_candidate` re-issued with the note/summary bound at 2,000 inside a marked block; bodies otherwise byte-identical, signatures and worker-only grants restated. |
| Acceptance RPCs | — | **No change.** They already allow 10,000. |

Untouched: the sync architecture, consent gates, minimization and the address scan, the
two-sided qualification, fingerprints and deduplication, refresh and the reviewer's
edit protection, terminal erasure and cleanup, the follow-up and subject bounds, and the
`extraction_status` provenance.

## 4. Evidence — fixture versus model quality

**Demonstrated by fixtures and real code** (`tests/outlook-detailed-notes.test.js`, 14 checks):
concrete networking exchanges — a multi-topic referral conversation, an exchange of commitments
and named dates, a two-line thank-you, and an over-reaching note — carried through the real
prompt, request builder, parser and independent validator. A ~900-character multi-topic note
validates byte for byte; every date and commitment survives; a one-sentence note is valid
because the bound is a ceiling and not a target; 2,000 is accepted and 2,001 refused; a line
break, a URL and a sensitive inference are each refused under their own code; a truncated
response reports `model_truncated` and stores nothing.

**Demonstrated against a real database** (`tests/sql/outlook-detailed-notes-runtime.sql`): a
2,000-character note through both producer RPCs is stored whole in `proposed_notes` and
`draft_summary`; 2,001 is refused and leaves the stored note untouched; line breaks and URLs
are still refused; the follow-up bound still refuses 161; refresh updates the same row;
**both acceptance paths save the generated note untouched** when the reviewer overrides
nothing, and the reviewer's own longer multiline note still overrides it; terminal erasure,
the single overloads and the worker-only grants are unchanged.

**Demonstrated end to end** (`tests/local/outlook-content-flow.mjs`, disposable Postgres +
PostgREST + the real run): both fixture model replies now return detailed multi-topic notes,
and the harness asserts the stored draft is the model's note byte for byte — through the
validator, the pass, the producer RPC and the column CHECK — and that acceptance preserves it.

**Not demonstrated, and not claimed.** Nothing here measures what the model actually writes.
Every note above is a fixture chosen to exercise the pipeline, so this PR is evidence that a
detailed note *survives the whole path intact*, not that the model produces a good one. Note
quality — does it capture the advice and the commitment, does it stay inside what the messages
say, does a short exchange really get a short note — can only be judged on live exchanges from
the pilot mailbox, after the rollout below. Until then the honest statement is: the ceiling and
the instructions changed; the writing has not been observed.

## 5. Disclosure — wording prepared, not published

The published policy currently says, under "What Funnl would keep":

> for a draft about someone already in your contacts: a summary of **at most 200 characters**, an
> optional suggested next step of at most 160 characters, …

That sentence becomes wrong the moment the migration is applied, so publication and the
migration are sequenced together in section 6. Two insertions, for owner approval:

### 5a. Replace the two length clauses (both bullets in "What Funnl would keep")

> for a draft about someone already in your contacts: a summary of at most 2,000 characters, an
> optional suggested next step of at most 160 characters, a code saying whether the summary came
> from the message body or only the subject, a code saying whether the draft was produced
> deterministically or with AI, and review state;

and, in the suggested-new-contact bullet, the same change where it says "the same summary and
next-step fields".

### 5b. One added sentence, after the summary bullet

> The drafted summary records what the exchange was about — the topics, any advice or offer, the
> commitments and dates either side named, the agreed next step and anything left unresolved —
> in Funnl's own words, drawn only from the messages it read. It is a draft: you can edit every
> word of it before anything is saved, and your own version may be longer.

### 5c. For the owner to confirm

| Question | Recommendation |
|---|---|
| Does the longer note need its own disclosure, or only the number? | **Only the number, plus 5b.** No new category of data is read or stored — the same field, from the same messages, under the same consent. 5b is included because "a summary" and "a detailed record of what was said" are different things to a reader, and the honest description is the longer one. |
| Does this change what reaches Anthropic? | **No.** The request is unchanged: the same bounded message text, the same minimization and address scan. Only the response may be longer. The existing paragraph about what Anthropic receives stays exactly as published. |
| Retention | Unchanged. The draft is erased on dismissal and on terminal states exactly as today. |

The notice paragraphs rendered at consent time do not state the 200-character number, so
**whether this requires a new disclosure version is the owner's call**: if 5a and 5b change only
`/privacy` and not `src/lib/outlookDisclosure.js`, the derived consent version does not move and
no re-consent is needed. If the owner wants 5b in the just-in-time notice too, then the notice
text changes, the version moves, and the full three-way cutover plus pilot re-consent applies —
exactly as in `docs/outlook-background-activation-packet.md` steps 4–6. **Recommendation:
policy page only, no version change, no re-consent**, because the consent the pilot gave already
covers reading these messages and writing a summary from them.

## 6. Ordered rollout (owner-authorized; nothing done here)

| # | Step | Gate before the next |
|---|---|---|
| 1 | Owner approves section 5 wording and decides the version question | Sign-off on the exact text |
| 2 | Publish the policy change (5a + 5b) and merge it | `/privacy` live with the new number; if the owner chose the notice route instead, the version cutover from the activation packet runs here first |
| 3 | Apply `20261010180000` | Ledger shows it applied; three CHECKs read 2,000; both producers one overload, worker-only, `SECURITY DEFINER`, empty search path, bodies otherwise unchanged; the acceptance RPCs untouched |
| 4 | Merge this PR pinned, let Vercel deploy | No frontend behaviour depends on it — the editors already accept 10,000 — so this is a no-op for the UI |
| 5 | Deploy **only** `outlook-import-worker` from merged main | Downloaded closure byte-identical; the worker now sends the new prompt and budget |
| 6 | Observe the next real exchanges | **The model-quality evidence this PR does not have:** read the first live detailed notes against the messages they came from, and check a short exchange produced a short note |

Order matters in one direction only: **the migration must precede the worker deploy**, or the
worker will send a prompt inviting a 2,000-character note into columns that still refuse one,
and every such draft would be refused with `invalid_notes` — the run would complete and write
nothing. Publishing before applying (steps 2 → 3) keeps the policy true at every moment.

**Rollback.** Re-apply the previous bounds (a one-line reverse migration restoring 200 in the
three CHECKs and both producers) and redeploy the worker from the reverted source. Stored notes
already longer than 200 would then violate the restored CHECK, so a rollback after live traffic
must either keep the wider column bound while reverting only the prompt and the validator — the
safer order — or shorten the affected rows first. Reverting the prompt and `BOUNDS.summary`
alone needs no migration and is the recommended rollback.

## 7. What this does not deliver

Still separate workstreams, unchanged by this PR: **evidence-backed metadata** (company, role,
how-met proposed only with an evidence code and confidence), **School / Education**, and **later
interactions within an accepted thread**. The reviewer-facing editor work is already done
(`20261010120000`): this PR is about what the model is asked to write, not about what the user
can write.
