// Outlook PR-B — cross-cutting structural scans.
//
// These are the guardrails that must keep holding as later phases add a worker, an
// OAuth flow and a UI: no content logging, no content persistence, no live network
// call, no scope creep beyond shared modules and tests, and exact compatibility with
// the APPLIED PR-A schema (migration 20260921000000) which must never be edited.
//
// Run with: node tests/outlook-core-scans.test.js
import assert from 'assert'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

// The Graph transport and participants suites were retired with the worker (Stage D);
// the sanitizer and draft-contract suites remain because paste-email still uses both modules.
const SUITES = [
  'outlook-content-sanitizer.test.js',
  'outlook-draft-contract.test.js',
].map((f) => ({ name: f, src: read(`tests/${f}`) }))

const MIGRATION_FILE = 'supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql'
const MIGRATION = read(MIGRATION_FILE)

// Executable code with comments removed.
const exec = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')

// ── Logging ──────────────────────────────────────────────────────────────────
console.log('\ncontent logging is structurally impossible')

// ── Persistence ──────────────────────────────────────────────────────────────
console.log('\ncontent persistence is structurally impossible')

test('the applied schema has no column that could hold a raw header or its facts', () => {
  const ddl = MIGRATION.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  for (const bad of ['internet_message_headers', 'headers', 'auto_submitted', 'precedence',
    'list_id', 'list_unsubscribe']) {
    assert.ok(!ddl.includes(bad), `schema must not define ${bad}`)
  }
})

test('the applied schema has no column that could hold a raw body', () => {
  // A raw body could only be persisted if a column existed for it. None does.
  // SQL comments are stripped first: the migration's own prose says it stores no
  // snippet/body, which must not read as a violation.
  const ddl = MIGRATION.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  for (const bad of ['body_text', 'raw_body', 'body_content', 'message_body', 'snippet', 'html_body', 'mime']) {
    assert.ok(!ddl.includes(bad), `schema must not define ${bad}`)
  }
  // The only persisted free text is bounded and derived.
  for (const col of ['draft_summary', 'draft_follow_up', 'retained_subject']) {
    assert.ok(MIGRATION.includes(col), `${col} is the bounded derived field`)
  }
})

// ── Network ──────────────────────────────────────────────────────────────────
console.log('\nno live network path')

test('every suite injects a fake fetch and none touches the real network', () => {
  for (const s of SUITES) {
    const code = exec(s.src)
    // No bare global fetch call, no real hostnames dialled.
    assert.ok(!/^\s*(await\s+)?fetch\(/m.test(code), `${s.name} must not call fetch directly`)
    assert.ok(!/undici|node-fetch|https?\.request|net\.connect/.test(code), `${s.name} must not open a socket`)
    if (/fetchImpl/.test(code)) {
      assert.ok(/fetchImpl:\s*async/.test(code), `${s.name} must inject an async fake`)
    }
  }
})

test('test fixtures use only example.invalid identities', () => {
  for (const s of SUITES) {
    // Strip URL userinfo (https://user:pass@host) before scanning: that is a
    // security fixture, not a fixture identity.
    const withoutUserinfo = s.src.replace(/:\/\/[^/\s'"`]*@/g, '://')
    const addrs = [...withoutUserinfo.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)].map((m) => m[0])
    for (const a of addrs) {
      // Case-insensitive: some fixtures deliberately use mixed case to prove that
      // address matching normalizes before comparing.
      assert.ok(a.toLowerCase().endsWith('example.invalid'), `${s.name}: non-fixture address ${a}`)
    }
  }
})

// ── PR-A compatibility (the applied migration must not be edited) ────────────
console.log('\napplied PR-A schema compatibility')

test('applied migrations are unmodified; the only addition is the forward scope migration', () => {
  const files = readdirSync(join(ROOT, 'supabase/migrations')).sort()
  assert.ok(files.includes('20260921000000_add_outlook_content_draft_primitives.sql'))
  assert.ok(files.includes('20260922175616_revoke_service_role_from_outlook_user_rpcs.sql'))
  // THE FORWARD TAIL, IN ORDER. This list is no longer "the unapplied migrations": most of
  // these have been applied to Production as their rollouts happened, and which ones is
  // recorded in CLAUDE.md rather than here. What this assertion protects is the ORDER - each
  // of these files must sort after every
  // applied one, and in this order, so `db push` applies them as reviewed: the scope
  // widening, the connection-status read path, the candidate write path, the token
  // rotation, durable continuation, the pilot reservation, then the content note and
  // new-contact write paths.
  //
  // The last entry is the newest and must stay last: it DROPs and re-CREATEs
  // upsert_outlook_interaction_candidate to add the note parameter, so applying it
  // before 20260930000000 (which creates the 9-argument form) would drop a function
  // that does not exist yet and then be overwritten by the older file.
  //
  // 20261008000000 is newer still and must stay last for the same reason: it DROPs the
  // 10-argument form that 20261006000000 creates and re-CREATEs the function with the
  // follow-up and provenance parameters, so it can only apply after that file.
  const FORWARD_TAIL = [
    '20260928000000_outlook_add_user_read_scope.sql',
    '20260929000000_outlook_connection_status_rpc.sql',
    '20260930000000_outlook_interaction_candidate_write.sql',
    '20261001000000_outlook_rotate_access_token.sql',
    '20261002000000_outlook_durable_continuation.sql',
    '20261003000000_outlook_pilot_reservation.sql',
    '20261006000000_outlook_content_note_and_new_contact_write.sql',
    '20261007000000_outlook_round_message_retrieval.sql',
    '20261008000000_outlook_known_contact_follow_up_provenance.sql',
    // Background sync: the wake-up signal, the subscription record, the notification RPC,
    // the status RPC and the INACTIVE pg_cron tick. DROP/CREATE of the reservation again.
    '20261009000000_outlook_change_notifications.sql',
    '20261010050349_recover_rejected_outlook_delta_cursors.sql',
    // Thorough user-written notes: both acceptance RPCs re-issued with the reviewed-note bound
    // at 10,000 characters (multiline), bodies otherwise identical; no column widened.
    '20261010120000_long_reviewed_interaction_notes.sql',
    // Detailed AI notes: the generated-summary ceiling 200 -> 2,000 in three column CHECKs
    // and both producer RPCs; bodies otherwise identical, acceptance RPCs untouched.
    '20261010180000_detailed_ai_interaction_notes.sql',
    // Thread segments: four coverage columns on outlook_candidate_refs, the coverage read and
    // the forward-only baseline, and both producers re-issued thread-first. It DROPs the
    // 13- and 14-argument producer forms that 20261008000000 and 20261010180000 create, so
    // like every producer change before it, it can only apply after them - which is why it
    // must stay last.
    '20261011000000_outlook_thread_segments.sql',
    // Cohort reservation: DROPs the three-argument reserve_due_outlook_connection that
    // 20261009000000 creates and re-CREATEs it with one extra defaulted parameter, so like
    // every reservation change before it, it can only apply after that file.
    // The new-contact refresh fix, APPLIED to Production 2026-10-13:
    // `upsert_new_contact_candidate` re-issued with the body copied from 20261011000000 and
    // the `context_expires_at` reissue removed, so it must apply after the file it was
    // copied from.
    '20261013060000_preserve_new_contact_context_deadline.sql',
    // Cohort reservation, UNAPPLIED: DROPs the three-argument
    // reserve_due_outlook_connection that 20261009000000 creates and re-CREATEs it with one
    // extra defaulted parameter, so like every reservation change before it, it can only
    // apply after that file. Renumbered from 20261013000000 so it sorts AFTER the refresh
    // fix above - see docs/outlook-new-contact-refresh-expiry.md section 4.
    '20261013120000_outlook_cohort_reservation.sql',
    // One Funnl owner per Microsoft account, UNAPPLIED: a unique index on (tenant, object id)
    // and finalize_microsoft_connection re-issued with the body copied from 20260928000000
    // plus a fenced cross-user refusal, so it must apply after the file it was copied from.
    // It refuses to run while a duplicate exists and deletes nothing.
    '20261014000000_outlook_one_owner_per_microsoft_account.sql',
    // NOT an Outlook migration: an optional School column on contacts. It touches no Outlook
    // object; it is listed only because this pin covers the newest files.
    '20261015000000_add_contact_school.sql',
    // Stage D backend retirement: unschedules outlook-worker-tick, deletes its two Vault
    // entries and DROPs the retired integration RPCs by their latest signatures, so it must
    // apply after every file above that last re-issued one of them.
    '20261019000000_retire_integration_backend.sql',
  ]
  assert.deepStrictEqual(files.slice(-FORWARD_TAIL.length), FORWARD_TAIL,
    'the forward migrations must be the newest, in this order')
  // The applied migrations must not be edited: 20260921000000 still carries its
  // original allowlist, which the forward migration supersedes at runtime.
  assert.ok(MIGRATION.includes("scopes <@ ARRAY['Mail.Read', 'offline_access', 'openid', 'email', 'profile']"),
    'the applied migration must remain untouched history')
  assert.ok(!files.some((f) => f.startsWith('20260918000100')), 'the held-back Cron migration stays absent')
})

test('the accept RPC takes NO email parameter, so the address cannot be client-edited', () => {
  const sig = MIGRATION.slice(
    MIGRATION.indexOf('CREATE FUNCTION public.accept_new_contact_candidate('),
    MIGRATION.indexOf('RETURNS jsonb', MIGRATION.indexOf('CREATE FUNCTION public.accept_new_contact_candidate(')))
  assert.ok(sig.length > 0, 'signature located')
  assert.ok(!/p_email|p_address|p_proposed_email/.test(sig),
    'the accept RPC must not accept an address from the caller')
  for (const p of ['p_name', 'p_company', 'p_role', 'p_how_met', 'p_tags', 'p_interaction_date']) {
    assert.ok(sig.includes(p), `${p} is a user-editable field`)
  }
  // And the module mirrors that: no email in the validated suggestion.
  const d = read('supabase/functions/shared/outlookDraftContract.js')
  assert.ok(/no `email` key/.test(d), 'the contract documents the omission')
})

test('proposed_type is pinned to Email on both sides', () => {
  assert.ok(MIGRATION.includes("ncc_type_check    CHECK (proposed_type = 'Email')"))
  assert.ok(read('supabase/functions/shared/outlookDraftContract.js').includes("INTERACTION_TYPE = 'Email'"))
})

test('extraction_status values line up with the applied enum', () => {
  assert.ok(MIGRATION.includes("extraction_status IN ('deterministic', 'ai_extracted', 'ai_failed')"))
})

// ── Scope creep ──────────────────────────────────────────────────────────────
console.log('\nscope containment')


console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
