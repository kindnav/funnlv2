// Source-invariant tests for the Phase B review RPCs migration + a scope-creep guard
// over all Phase B files. STATIC SOURCE SCANS ONLY (runtime behavior is validated by
// the disposable local Docker suite). Run: node tests/calendar-review-migration.test.js

import assert from 'assert'
import { readFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIG_FILE = readdirSync(join(ROOT, 'supabase/migrations')).find(f => /add_calendar_candidate_review_rpcs\.sql$/.test(f))
const MIG = readFileSync(join(ROOT, 'supabase/migrations', MIG_FILE), 'utf8')
const PAGE = readFileSync(join(ROOT, 'src/pages/SuggestionsPage.jsx'), 'utf8')
const ENTRY = readFileSync(join(ROOT, 'src/components/SuggestionsEntry.jsx'), 'utf8')
const LIB = readFileSync(join(ROOT, 'src/lib/calendarReview.js'), 'utf8')

function stripSql(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ') }
function stripJs(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1') }
const MIG_CODE = stripSql(MIG)
const FRONT_CODE = stripJs(PAGE) + '\n' + stripJs(ENTRY) + '\n' + stripJs(LIB)

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}
const accept = MIG_CODE.match(/FUNCTION public\.accept_interaction_candidate[\s\S]*?\$\$;/)[0]
const dismiss = MIG_CODE.match(/FUNCTION public\.dismiss_interaction_candidate[\s\S]*?\$\$;/)[0]

console.log('\nRPC hardening (source)')
test('both RPCs SECURITY DEFINER + empty search_path', () => {
  assert.strictEqual((MIG_CODE.match(/SECURITY DEFINER/g) || []).length, 2)
  assert.strictEqual((MIG_CODE.match(/SET search_path = ''/g) || []).length, 2)
})
test('exactly the two review RPCs; no others', () => {
  const fns = (MIG_CODE.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) || []).map(m => m.split('.')[1]).sort()
  assert.deepStrictEqual(fns, ['accept_interaction_candidate', 'dismiss_interaction_candidate'])
})
test('EXECUTE revoked from PUBLIC/anon, granted to authenticated + service_role only', () => {
  for (const fn of ['accept_interaction_candidate', 'dismiss_interaction_candidate']) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\)\\s*FROM PUBLIC, anon`).test(MIG_CODE), `${fn} revoke`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]*?\\)\\s*TO authenticated, service_role`).test(MIG_CODE), `${fn} grant`)
  }
  assert.ok(!/GRANT EXECUTE[^;]*TO [^;]*\banon\b/.test(MIG_CODE), 'anon never granted EXECUTE')
})
test('user derived from auth.uid(); never a user_id parameter', () => {
  assert.ok(/v_uid\s+uuid := \(SELECT auth\.uid\(\)\)/.test(accept))
  assert.ok(/v_uid\s+uuid := \(SELECT auth\.uid\(\)\)/.test(dismiss))
  assert.ok(!/p_user_id|p_uid|p_user\b/.test(MIG_CODE), 'no user_id parameter accepted')
  assert.ok(/IF v_uid IS NULL THEN[\s\S]*?'unauthenticated'/.test(accept) && /IF v_uid IS NULL THEN[\s\S]*?'unauthenticated'/.test(dismiss))
})
test('candidate locked FOR UPDATE and scoped to user_id = auth.uid()', () => {
  assert.ok(/WHERE id = p_candidate_id AND user_id = v_uid\s*FOR UPDATE/.test(accept))
  assert.ok(/WHERE id = p_candidate_id AND user_id = v_uid\s*FOR UPDATE/.test(dismiss))
})
test('missing/foreign candidate returns the same not_found', () => {
  assert.ok(/IF NOT FOUND THEN[\s\S]*?'not_found'/.test(accept))
  assert.ok(/IF NOT FOUND THEN[\s\S]*?'not_found'/.test(dismiss))
})
test('accept: contact ownership re-checked (locked FOR KEY SHARE); never accepts contact_id/user_id from caller', () => {
  assert.ok(/FROM public\.contacts\s+WHERE id = v_cand\.contact_id AND user_id = v_uid\s+FOR KEY SHARE/.test(accept))
  assert.ok(!/p_contact_id/.test(MIG_CODE))
  // interaction insert uses the candidate's contact + v_uid, never a caller value
  assert.ok(/INSERT INTO public\.interactions \(contact_id, user_id, type, interaction_date, notes\)[\s\S]*?VALUES \(v_cand\.contact_id, v_uid,/.test(accept))
})
test('accept: only pending+active source creates an interaction; type/date/notes validated at schema bound (200)', () => {
  assert.ok(/v_cand\.source_last_state <> 'active'[\s\S]*?'invalidated'/.test(accept))
  assert.ok(/v_type NOT IN \('Coffee chat', 'Email', 'Event', 'Call', 'Message', 'Other'\)[\s\S]*?'invalid_type'/.test(accept))
  assert.ok(/v_date IS NULL[\s\S]*?'invalid_date'/.test(accept))
  assert.ok(/char_length\(v_notes\) > 200[\s\S]*?'invalid_notes'/.test(accept))
  assert.ok(!/> 2000/.test(accept), 'stale 2000 bound must be gone')
})
test('accept: concurrent-delete / lock-cycle mapped to controlled codes, never a raw SQL error', () => {
  // ownership lock + write are wrapped so FK/deadlock/serialization become result codes
  assert.ok(/BEGIN[\s\S]*?EXCEPTION[\s\S]*?END;/.test(accept), 'mutation wrapped in an exception block')
  assert.ok(/WHEN foreign_key_violation THEN[\s\S]*?'not_found'/.test(accept))
  assert.ok(/WHEN deadlock_detected OR serialization_failure THEN[\s\S]*?'conflict'/.test(accept))
})
test('accept: state machine — accepted+id idempotent, accepted+NULL tombstone, dismissed/invalidated conflicts', () => {
  assert.ok(/status = 'accepted'[\s\S]*?interaction_id IS NOT NULL[\s\S]*?'already_accepted'/.test(accept))
  assert.ok(/interaction_previously_deleted/.test(accept))
  assert.ok(/status = 'dismissed'[\s\S]*?'dismissed'/.test(accept))
  assert.ok(/status = 'invalidated'[\s\S]*?'invalidated'/.test(accept))
})
test('accept: creates interaction + marks accepted with interaction_id (one transaction)', () => {
  assert.ok(/RETURNING id INTO v_iid/.test(accept))
  assert.ok(/UPDATE public\.interaction_candidates\s*SET status = 'accepted', interaction_id = v_iid/.test(accept))
})
test('dismiss: pending->dismissed; idempotent; accepted/invalidated controlled; never deletes', () => {
  assert.ok(/v_status = 'pending'[\s\S]*?SET status = 'dismissed'[\s\S]*?'dismissed'/.test(dismiss))
  assert.ok(/v_status = 'dismissed'[\s\S]*?'already_dismissed'/.test(dismiss))
  assert.ok(/v_status = 'accepted'[\s\S]*?'already_accepted'/.test(dismiss))
  assert.ok(!/DELETE/.test(dismiss), 'dismiss never deletes')
})
test('no dynamic SQL in either RPC body', () => {
  // scan the function bodies (not the GRANT EXECUTE statements outside them)
  for (const body of [accept, dismiss]) {
    assert.ok(!/\bEXECUTE\b\s*['"$]|format\(|quote_ident|quote_literal/i.test(body), 'no dynamic EXECUTE')
  }
})
test('never touches contacts/refs/tokens/connections destructively', () => {
  assert.ok(!/DELETE FROM public\.(contacts|google_|interactions|interaction_candidates)/.test(MIG_CODE))
  assert.ok(!/UPDATE public\.(contacts|google_)/.test(MIG_CODE))
})

console.log('\nReview UI (source)')
test('review page + entry are flag-gated (CALENDAR_INGESTION_ENABLED)', () => {
  assert.ok(/CALENDAR_INGESTION_ENABLED/.test(PAGE) && /if \(!CALENDAR_INGESTION_ENABLED\) return/.test(PAGE))
  assert.ok(/CALENDAR_INGESTION_ENABLED/.test(ENTRY) && /if \(!CALENDAR_INGESTION_ENABLED\) return/.test(ENTRY))
})
test('review UI never renders provider/sensitive fields', () => {
  for (const bad of ['source_fingerprint', 'google_sub', 'connection_id', 'event_id', 'ical', 'interaction_id', 'ciphertext', 'nonce', 'refresh_token', 'access_token']) {
    assert.ok(!FRONT_CODE.includes(bad), `UI must not reference ${bad}`)
  }
})
test('accept/dismiss are single-flight (busy guard) + dismiss confirmation', () => {
  assert.ok(/if \(busy\) return/.test(PAGE), 'single-flight guard')
  assert.ok(/confirmDismiss/.test(PAGE), 'dismiss confirmation state')
  assert.ok(/loadInitial|Try again/.test(PAGE), 'error retry present')
})
test('no production "Run sync" button; no direct sync invocation in UI', () => {
  assert.ok(!/Run.{0,4}Sync|Run Calendar Sync/i.test(FRONT_CODE))
  assert.ok(!/functions\.invoke\(\s*'google-calendar-sync'/.test(FRONT_CODE))
})

console.log('\nPhase B scope guard')
test('no scheduler/cron/webhook/Gmail/AI/incremental/auto-accept', () => {
  const all = MIG_CODE + '\n' + FRONT_CODE
  assert.ok(!/pg_cron|\bcron\b|webhook|x-goog|pub\/?sub/i.test(all))
  assert.ok(!/gmail|mail\.google/i.test(all))
  assert.ok(!/anthropic|claude|openai|\bLLM\b/i.test(all))
  assert.ok(!/synctoken|incremental sync/i.test(all))
  // no automatic acceptance: accept only runs from an explicit handler, never on mount
  assert.ok(!/useEffect\([\s\S]{0,120}accept_interaction_candidate/.test(PAGE))
})
test('analytics events carry no identifiers', () => {
  // only the three privacy-safe events, and accepted carries at most { edited: bool }
  assert.ok(/track\('calendar_review_viewed'\)/.test(PAGE))
  assert.ok(/track\('calendar_candidate_accepted', \{ edited: /.test(PAGE))
  assert.ok(/track\('calendar_candidate_dismissed'\)/.test(PAGE))
  assert.ok(!/track\([^)]*candidate\.id|track\([^)]*\.name|track\([^)]*email/.test(PAGE))
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
