# Outlook committed delta cursor recovery

Funnl must resume automatic networking capture when Microsoft invalidates a saved
committed sync token. The webhook, durable wake-up and scheduled fallback design stays
in place; this change closes a specific failure-recovery gap before pilot activation.

## Failure and resulting behavior

Microsoft documents that a delta token can expire or be invalidated and require a fresh
synchronization. The old worker recognized `cursor_invalid` but only reset a rejected
saved nextLink. A rejected committed deltaLink remained stored, so subsequent attempts
could repeatedly request the same invalid token and return `incomplete`.

Controlled tests reproduce 410/resyncRequired and 400/syncStateNotFound. This is fixture
evidence, not a claim that the pilot's current cursors have expired.

On an explicit committed-token rejection the worker now:

1. Calls the existing `reset_outlook_round` with `committed_delta_rejected` under the
   two-folder live-run lease fence. This discards both committed tokens and the shared
   partial round atomically. Ordinary saved-nextLink and round-expiry resets still keep
   valid committed tokens. The cursor key version and initial-import history remain.
2. Releases incomplete, reports `restart_required` and the controlled reason, and uses
   the existing 15-second continuation backoff. The next scheduled tick can reserve it.
   A reset refusal or error reports `committed_delta_reset_failed` and does not write.
3. Starts from the normal Graph folder-delta request builder; it does not follow a
   provider Location header. Existing page, round, body, model and consent limits apply.
   A large catch-up checkpoints and continues across invocations.
4. Keeps canonical thread recovery on for a previously imported mailbox even while its
   cursor is temporarily absent, using the reservation's existing initial-import flags.
   Existing fingerprints refresh pending suggestions and preserve terminal decisions.

Candidate drafts, contacts, accepted interactions and dedup references survive the reset.
An unread wake-up is not consumed by resetting or releasing an incomplete run. No new
recognition store, queue, scheduler, disclosure version or model change is introduced.

## Verification

- Real run: both explicit rejection shapes, failed reset, ordinary provider failure,
  multi-invocation catch-up and no cursor commit until complete.
- Real handler with injected Graph/Anthropic: known and unknown people, pending and
  decided exchanges; catch-up refreshes or returns exists_terminal under the same key.
- Disposable PostgreSQL runtime: stale run, null run, one expired lease, ordinary resets,
  atomic cursor clearing, preservation of drafts/accepted records/references, retained
  wake-up, actual producer replay, signature, SECURITY DEFINER, search_path and grants.
- A source equality check strips the one marked added SQL block and compares the reset
  function with its applied body. Historical migration files are unchanged.

The SQL proof can also run in embedded PostgreSQL (PGlite). For that environment the
harness supplies auth/catalog fixtures and omits pg_cron/pg_net scheduling; it proves the
reset and producer bodies, not the hosted scheduler or Supabase authentication gateway.
The seven UI-render checks repaired in this PR used a Windows-only URL path conversion;
fileURLToPath makes them run on Linux and Windows, with their assertions unchanged.

## Controlled rollout

1. Keep the worker flag absent and the cron job inactive while applying
   `20261010050349_recover_rejected_outlook_delta_cursors.sql`.
2. Verify one reset overload, service_role-only execution and the explicit conditional
   committed-token clearing. Applying this migration itself resets no pilot state.
3. Merge the reviewed head, deploy only outlook-import-worker from merged main, and
   compare its complete import closure against the deployed source. Migration first is
   mandatory: an older reset body would acknowledge a reset without clearing the token.
4. Continue the owner's approved pilot activation: worker flag on, then cron active;
   verify the scheduled request and completed folder state. No manual token corruption
   or production reset is required to test this fix.
5. Prove a fresh two-way unknown-person exchange produces an editable proposal while
   Funnl is closed, then review and accept it. Trigger checks alone are not that proof.

The separate product work remains: later episodes in accepted threads, richer contextual
notes, evidence-backed metadata, and School/Education. This recovery change does not
claim those are delivered.

Microsoft primary reference: https://learn.microsoft.com/en-us/graph/delta-query-overview
(Synchronization reset, Token duration, Combine delta query and change notifications).
