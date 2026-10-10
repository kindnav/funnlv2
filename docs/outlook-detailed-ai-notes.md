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

One prose paragraph recording the following — **instructed to use only what the selected
messages state**:

- what was discussed, and why it mattered;
- concrete advice given;
- offers made, and by whom;
- commitments either side made;
- named dates, deadlines and events;
- agreed next steps;
- questions left unresolved.

With the people, companies, roles, teams and programmes the messages name.

**What "grounded" means here, precisely.** Staying inside what the messages say is an
*instruction to the model* plus a *reviewer responsibility* — it is not a guarantee the system
can make. The code enforces what code can see: length, control characters, URLs and addresses,
the date allowlist, the evidence pairing, and the sensitive-topic rule, each refusing the whole
draft rather than trimming it. It cannot detect a fluent, plausible sentence that the messages
do not support; `tests/outlook-detailed-notes.test.js` asserts exactly that limit rather than
implying otherwise. Two things reduce the risk: the prompt forbids it in specific terms, and
every note reaches the user as an editable draft that nothing saves until they accept it. The
honest claim is "instructed and reviewable", never "verified true".

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
| Request ceiling | 20,000 → **24,000** chars | It had to move: the longer instructions and schema descriptions are *fixed* overhead in every request, and at the sanitizer's worst case the body measured 20,853 characters. **The mailbox content sent is unchanged** — still bounded at 4,000 characters per message and 12,000 per episode, with the same minimization and address scan. What grew is Funnl's own instructions, not the amount of the user's mail. |
| Response ceiling | **15,680** chars, derived | Counts *serialized* characters, so it is sized for JSON escaping: the field bounds (2,000 + 160 + 120) times the six characters a fully-escaped `\uXXXX` sequence costs, plus an envelope allowance. Derived from the bounds so it cannot drift from them. The *decoded* field limits are unchanged. |

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

**Not demonstrated by any of the above.** Nothing in the three paragraphs above measures what
the model actually writes. Every note in them is a fixture chosen to exercise the pipeline, so
they are evidence that a detailed note *survives the whole path intact*, not that the model
produces a good one.

**How the writing gets assessed, and when.** Not "only after rollout" — that was wrong. There
are two distinct questions, and they are answered at different times:

1. **Does the model write well?** Answerable *now*, before anything is applied, with real model
   calls against synthetic exchanges. `scripts/outlook-note-quality-check.mjs` is the
   owner-run helper for exactly that: it drives this head's real builder, prompt, parser and
   validator over four invented exchanges — a multi-topic existing-contact conversation, a
   new-person exchange carrying advice, an offer and a commitment, one dense with named dates
   and unresolved questions, and a short exchange — then prints each generated note beside its
   source messages with mechanical checks for coverage, attribution, unsupported wording,
   repetition and length. No mailbox, no pilot data, no Production change. The owner reads the
   output and judges the writing. **This is a gate before rollout, not after it** (section 6,
   step 1).
2. **Does it behave on real mail?** Only the pilot can answer that: real threads are messier
   than any fixture — forwarded chains, mixed languages, partial quoting, signatures, exchanges
   that are half logistics. That verification is step 7, after rollout.

Until the helper has been run the honest statement is: the ceiling and the instructions changed,
and the writing has not been observed *yet* — not that it cannot be.

## 4a. The quality check, in practice

```
node scripts/outlook-note-quality-check.mjs --dry-run   # offline: builds all four requests, no key, no network
node scripts/outlook-note-quality-check.mjs             # real model: hidden key prompt, four requests
```

**What it does.** For each of the four invented exchanges it builds the request with this head's
own `buildDraftRequest`, checks the size against `MAX_REQUEST_CHARS`, runs the real
`assertRequestMinimization`, sends **one** request (no retries), reads the response with the
bounded reader, and runs the real `parseDraftPayload` and `validateDraftResponse`. Then it
prints the source messages, the generated note, and five mechanical checks.

| Check | What it reports |
|---|---|
| coverage | Which facts stated in the exchange's own messages the note mentions, and which it dropped. Each fixture declares its facts, and a test asserts every declared fact really is stated in that exchange. |
| attribution | Whether the note reverses who offered or committed to something — the error a reader cannot detect without the source. |
| length | Characters against the bound, against the source's own size, and for the short exchange against the length a one-or-two-sentence note should not exceed. |
| repetition | Repeated sentences and repeated six-word runs. |
| wording not in the source | Content words with no root in the messages. A **hint**, printed for a human to read: a legitimate paraphrase introduces words too. |

**What it cannot do.** It cannot tell you whether the note is *good*. Coverage counts phrases,
not understanding; the wording hint flags novelty, not falsehood. The checks exist to direct
attention — read each note against the messages above it and decide. If the notes pad, repeat,
misattribute or assert something the messages do not, revise the prompt in
`SYSTEM_CONTRACT` and run it again. That loop is the point of having this before rollout.

**What it never touches.** No mailbox, no pilot data, no database, no Supabase call, no file
written. The key is typed at a hidden prompt, travels only in the real header builder, is never
printed or logged, and is cleared when the run ends. `tests/outlook-note-quality-check.test.js`
asserts those properties, and the dry run exercises the whole report path offline.

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
> in Funnl's own words, written from the messages it read. Funnl instructs the AI to use only
> what those messages say, and checks the draft automatically for things it can check, but an
> AI can still get a detail wrong: the summary is a draft, you can edit every word of it before
> anything is saved, and nothing is added to your network until you accept it.

### 5c. For the owner to confirm

| Question | Recommendation |
|---|---|
| Does the longer note need its own disclosure, or only the number? | **Only the number, plus 5b.** No new category of data is read or stored — the same field, from the same messages, under the same consent. 5b is included because "a summary" and "a detailed record of what was said" are different things to a reader, and the honest description is the longer one. |
| Does this change what reaches Anthropic? | **No new mailbox content.** What is sent *from your mail* is unchanged: the same bounded message text and signature, under the same minimization and address scan. The request is larger, but only because Funnl's own instructions to the AI are longer; the response may be longer too. The published paragraph describing what Anthropic receives stays exactly as it is, because what it describes has not changed. |
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
| 1 | **Run the quality check** — `node scripts/outlook-note-quality-check.mjs`, owner-run, real model, synthetic exchanges, no mailbox | The owner has read four real generated notes beside their source messages and accepts the writing. If it pads, repeats, misattributes or invents, the prompt is revised and this step repeats — *before* anything is applied |
| 2 | Owner approves section 5 wording and decides the version question | Sign-off on the exact text |
| 3 | Publish the policy change (5a + 5b) and merge it | `/privacy` live with the new number; if the owner chose the notice route instead, the version cutover from the activation packet runs here first |
| 4 | Apply `20261010180000` | Ledger shows it applied; three CHECKs read 2,000; both producers one overload, worker-only, `SECURITY DEFINER`, empty search path, bodies otherwise unchanged; the acceptance RPCs untouched |
| 5 | Merge this PR pinned, let Vercel deploy | No frontend behaviour depends on it — the editors already accept 10,000 — so this is a no-op for the UI |
| 6 | Deploy **only** `outlook-import-worker` from merged main | Downloaded closure byte-identical; the worker now sends the new prompt and budget |
| 7 | Observe the next real exchanges | **Real-mail behaviour**, which no fixture and no synthetic check can establish: read the first live notes against the threads they came from, and check a short exchange produced a short note |

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
