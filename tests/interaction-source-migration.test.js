// Source-invariant tests for the interaction-source migration. Static scans only;
// runtime behavior (column/backfill/RPC) is validated by the disposable Docker suite.
// Run: node tests/interaction-source-migration.test.js

import assert from 'assert'
import { readFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIG_DIR = join(ROOT, 'supabase/migrations')
const FILE = readdirSync(MIG_DIR).find(f => /add_interaction_source\.sql$/.test(f))
const SQL = readFileSync(join(MIG_DIR, FILE), 'utf8')
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

console.log('\nsource column')
test('adds a NOT NULL source column defaulting to manual', () => {
  assert.ok(/ALTER TABLE public\.interactions\s+ADD COLUMN source text NOT NULL DEFAULT 'manual'/.test(CODE))
})
test('constrains source with a named CHECK (manual, google_calendar)', () => {
  assert.ok(/CONSTRAINT interactions_source_check\s+CHECK \(source IN \('manual', 'google_calendar'\)\)/.test(CODE))
})

console.log('\nbackfill')
test('backfill joins candidate.interaction_id, accepted + google_calendar, with ownership match', () => {
  assert.ok(/UPDATE public\.interactions AS i\s+SET source = 'google_calendar'/.test(CODE))
  assert.ok(/FROM public\.interaction_candidates AS c/.test(CODE))
  assert.ok(/c\.interaction_id = i\.id/.test(CODE))
  assert.ok(/c\.status\s*=\s*'accepted'/.test(CODE))
  assert.ok(/c\.source\s*=\s*'google_calendar'/.test(CODE))
  assert.ok(/c\.user_id\s*=\s*i\.user_id/.test(CODE), 'ownership consistency required')
})
test('backfill statement targets only interactions; migration performs no deletes', () => {
  assert.ok(!/DELETE FROM/.test(CODE), 'no deletes anywhere in the migration')
  // Isolate the backfill statement (UPDATE public.interactions AS i ... ;) and confirm
  // it only writes interactions and only reads interaction_candidates. The RPC body's
  // own UPDATE of interaction_candidates (the accept status write) is separate + expected.
  const backfill = CODE.match(/UPDATE public\.interactions AS i[\s\S]*?;/)[0]
  assert.ok(/SET source = 'google_calendar'/.test(backfill))
  assert.ok(/FROM public\.interaction_candidates AS c/.test(backfill))
  assert.ok(!/INSERT|DELETE/.test(backfill))
})

console.log('\naccept_interaction_candidate CREATE OR REPLACE')
test('the interaction INSERT now sets source = google_calendar', () => {
  assert.ok(/INSERT INTO public\.interactions \(contact_id, user_id, type, interaction_date, notes, source\)/.test(CODE))
  assert.ok(/VALUES \(v_cand\.contact_id, v_uid, v_type, v_date, v_notes, 'google_calendar'\)/.test(CODE))
})
test('RPC hardening preserved (SECURITY DEFINER, search_path, FOR UPDATE, FOR KEY SHARE, grants)', () => {
  assert.ok(/CREATE OR REPLACE FUNCTION public\.accept_interaction_candidate/.test(CODE))
  assert.ok(/SECURITY DEFINER/.test(CODE))
  assert.ok(/SET search_path = ''/.test(CODE))
  assert.ok(/WHERE id = p_candidate_id AND user_id = v_uid\s*FOR UPDATE/.test(CODE))
  assert.ok(/FOR KEY SHARE/.test(CODE))
  assert.ok(/REVOKE ALL ON FUNCTION public\.accept_interaction_candidate\(uuid, text, date, text\)\s*FROM PUBLIC, anon/.test(CODE))
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.accept_interaction_candidate\(uuid, text, date, text\)\s*TO authenticated, service_role/.test(CODE))
})
test('user_id still set explicitly; no caller-supplied user_id/contact_id', () => {
  assert.ok(!/p_user_id|p_contact_id/.test(CODE))
  assert.ok(/v_uid\s+uuid := \(SELECT auth\.uid\(\)\)/.test(CODE))
})

console.log('\ndoes not modify any previously applied migration')
test('the prior review-RPC migration is byte-identical to origin/main', () => {
  // A local edit to an already-applied migration would show up here.
  const diff = execSync(
    'git diff --name-only origin/main...HEAD -- supabase/migrations/20260825002308_add_calendar_candidate_review_rpcs.sql',
    { cwd: ROOT, encoding: 'utf8' },
  ).trim()
  assert.strictEqual(diff, '', 'the applied review-RPC migration must not be modified')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
