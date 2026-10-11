// THE THREAD-SEGMENTS MIGRATION, read as text.
//
// The runtime behaviour is proven against a real database in
// tests/sql/outlook-thread-segments-runtime.sql. This file proves the things a runtime test
// cannot: that the two producers were re-issued with their bodies BYTE-IDENTICAL to the
// applied versions apart from the marked blocks, that the new functions carry the same
// security posture as the old ones, and that the acceptance path was not touched.
//
// Run with: node tests/outlook-thread-segments-migration.test.js
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WRITE_OK } from '../supabase/functions/shared/outlookImportRun.js'
import { MAX_SEGMENT_COVERAGE } from '../supabase/functions/shared/outlookThreadSegments.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const FORWARD = read('supabase/migrations/20261011000000_outlook_thread_segments.sql')
const PRIOR = read('supabase/migrations/20261010180000_detailed_ai_interaction_notes.sql')

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const fnText = (text, name) => {
  const i = text.indexOf(`FUNCTION public.${name}(`)
  assert.ok(i > 0, `${name} not found`)
  return text.slice(i, text.indexOf('$$;', i) + 3)
}
/** Remove every 20261011 marked block, so what remains must match the applied text exactly. */
const stripMarked = (s) => s.replace(/[ \t]*-- >>> 20261011[\s\S]*?-- <<< 20261011\n/g, '')

console.log('\nthe producers changed ONLY inside the marked blocks')

// THE ONE TOLERATED CHANGE OUTSIDE A MARKED BLOCK, and it is a single character: the last
// existing parameter needs a trailing comma for the new parameters to follow it. It is
// normalized here EXPLICITLY, named parameter by named parameter, rather than by widening
// the comparison - so nothing else can hide behind "formatting".
const COMMA_ONLY = [
  ['  p_extraction_status   text   DEFAULT NULL,\n', '  p_extraction_status   text   DEFAULT NULL\n'],
  ["  p_extraction_status   text   DEFAULT 'deterministic',\n", "  p_extraction_status   text   DEFAULT 'deterministic'\n"],
]
const normalize = (s) => COMMA_ONLY.reduce((acc, [a, b]) => acc.replace(a, b), s)

test('the interaction producer is byte-identical to the applied one once the marked blocks are removed', () => {
  const next = normalize(stripMarked(fnText(FORWARD, 'upsert_outlook_interaction_candidate')))
  const prev = fnText(PRIOR, 'upsert_outlook_interaction_candidate')
  assert.strictEqual(next, prev, 'an unmarked line of the interaction producer changed')
})

test('the new-contact producer is byte-identical to the applied one once the marked blocks are removed', () => {
  const next = normalize(stripMarked(fnText(FORWARD, 'upsert_new_contact_candidate')))
  const prev = fnText(PRIOR, 'upsert_new_contact_candidate')
  assert.strictEqual(next, prev, 'an unmarked line of the new-contact producer changed')
})

test('the only unmarked difference really is that trailing comma', () => {
  // Proven by reversing it: put the comma back and the comparison must FAIL, so the
  // normalization above cannot be masking anything.
  const raw = stripMarked(fnText(FORWARD, 'upsert_outlook_interaction_candidate'))
  assert.notStrictEqual(raw, fnText(PRIOR, 'upsert_outlook_interaction_candidate'),
    'without the normalization the texts differ')
  assert.strictEqual(raw.split('\n').length,
    fnText(PRIOR, 'upsert_outlook_interaction_candidate').split('\n').length,
    'and they differ in NO lines being added or removed, only that one line')
})

test('every marked block is closed, and nothing is marked with another migration\'s id', () => {
  const opens = (FORWARD.match(/-- >>> 20261011/g) || []).length
  const closes = (FORWARD.match(/-- <<< 20261011/g) || []).length
  assert.strictEqual(opens, closes, `${opens} opened, ${closes} closed`)
  assert.ok(opens >= 8, 'the blocks are where the change is, not one big block')
})

console.log('\nthe schema additions')

test('four columns, four CHECKs and one partial index, all guarded for re-application', () => {
  for (const c of ['conversation_fingerprint', 'covered_message_fingerprints',
                   'coverage_through_at', 'coverage_source']) {
    assert.ok(FORWARD.includes(`ADD COLUMN IF NOT EXISTS ${c}`), `${c} must be added idempotently`)
  }
  for (const k of ['ocr_conversation_fp_shape', 'ocr_coverage_shape',
                   'ocr_coverage_source_known', 'ocr_coverage_together']) {
    assert.ok(FORWARD.includes(k), `${k} must be declared`)
    assert.ok(new RegExp(`conname = '${k}'`).test(FORWARD), `${k} must be guarded by an existence check`)
  }
  assert.ok(/CREATE INDEX IF NOT EXISTS ocr_conversation_idx/.test(FORWARD))
  assert.ok(/WHERE conversation_fingerprint IS NOT NULL/.test(FORWARD), 'the index is partial')
})

test('the coverage bound in SQL matches the bound the decision module enforces', () => {
  assert.strictEqual(MAX_SEGMENT_COVERAGE, 50)
  assert.ok(FORWARD.includes('BETWEEN 1 AND 50'), 'the CHECK carries the same ceiling')
  assert.strictEqual((FORWARD.match(/array_length\(p_covered_fingerprints, 1\) > 50/g) || []).length, 3,
    'both producers and the baseline refuse an oversized coverage set')
})

test('coverage is ALL OR NOTHING, and requires the thread it belongs to', () => {
  const chk = FORWARD.slice(FORWARD.indexOf('ocr_coverage_together'), FORWARD.indexOf('-- The one lookup'))
  for (const col of ['covered_message_fingerprints', 'coverage_through_at', 'coverage_source',
                     'conversation_fingerprint']) {
    assert.ok(chk.includes(col), `${col} must take part in the all-or-nothing rule`)
  }
})

console.log('\nsecurity posture, unchanged from the functions it joins')

test('both new functions are SECURITY DEFINER with an empty search_path and a lease fence', () => {
  for (const f of ['get_outlook_thread_coverage', 'baseline_outlook_thread_coverage']) {
    const body = FORWARD.slice(FORWARD.indexOf(`FUNCTION public.${f}(`))
    const end = body.indexOf('$fn$;') + 5
    const one = body.slice(0, end)
    assert.ok(/SECURITY DEFINER/.test(one), `${f} must be SECURITY DEFINER`)
    assert.ok(/SET search_path = ''/.test(one), `${f} must pin an empty search_path`)
    assert.ok(/sync_run_id = p_run_id/.test(one) && /sync_lease_until > now\(\)/.test(one),
      `${f} must be fenced on the live lease`)
    assert.ok(/count\(\*\) = 2/.test(one), `${f} must require BOTH folder rows, as the producers do`)
  }
})

test('anon and authenticated are revoked EXPLICITLY, not only PUBLIC', () => {
  // The disposable-database check proved why: this project's default privileges grant
  // EXECUTE on a new function in public to anon and authenticated, so CREATE OR REPLACE
  // after a DROP hands the producers back to every signed-in user.
  const revokes = FORWARD.match(/REVOKE ALL ON FUNCTION[\s\S]*?;/g) || []
  assert.strictEqual(revokes.length, 5, 'five functions are revoked')
  for (const r of revokes) {
    assert.ok(/FROM PUBLIC, anon, authenticated/.test(r), `a revoke misses anon/authenticated: ${r.slice(0, 70)}`)
  }
  assert.strictEqual((FORWARD.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role;/g) || []).length, 5,
    'and all five are granted to service_role only')
  // The hint TABLE is worker-only too, and carries no policy - a reader could otherwise learn
  // which threads have unresolved halves.
  assert.ok(/REVOKE ALL ON TABLE public\.outlook_thread_recovery FROM PUBLIC, anon, authenticated;/.test(FORWARD))
  assert.ok(/ALTER TABLE public\.outlook_thread_recovery ENABLE ROW LEVEL SECURITY;/.test(FORWARD))
  assert.ok(!/CREATE POLICY[\s\S]*outlook_thread_recovery/.test(FORWARD), 'and no policy on it')
})

test('the previous producer signatures are dropped, so exactly one overload survives', () => {
  assert.ok(FORWARD.includes('DROP FUNCTION IF EXISTS public.upsert_outlook_interaction_candidate(\n  uuid, uuid, uuid, text, text, smallint, text, date, text[], text, text, text, text)'),
    'the 13-argument interaction form must be dropped')
  assert.ok(FORWARD.includes('DROP FUNCTION IF EXISTS public.upsert_new_contact_candidate(\n  uuid, uuid, text, text, smallint, text, date, text, text, text, text, text, text, text)'),
    'the 14-argument new-contact form must be dropped')
})

console.log('\nwhat the migration must NOT do')

test('the acceptance RPCs are not re-issued and keep their reviewed-note allowance', () => {
  assert.ok(!FORWARD.includes('FUNCTION public.accept_interaction_candidate('),
    'acceptance must not be re-issued here')
  assert.ok(!FORWARD.includes('FUNCTION public.accept_new_contact_candidate('))
  // The acceptance path is not this migration's business at all: it is named only in the
  // closing comment that says so. (An earlier version of this control scanned for "10000"
  // and matched incidentally inside the migration id 20260921000000.)
  assert.strictEqual((FORWARD.match(/accept_interaction_candidate/g) || []).length, 0)
  assert.strictEqual((FORWARD.match(/CREATE OR REPLACE FUNCTION/g) || []).length, 6,
    'six functions: the two producers, the three worker RPCs, and the jsonb shape validator')
  // The validator exists because a CHECK may not contain a subquery, and it must be IMMUTABLE
  // to be usable in one at all.
  const val = FORWARD.slice(FORWARD.indexOf('FUNCTION public.outlook_unpaired_valid('))
  assert.ok(/IMMUTABLE/.test(val.slice(0, 400)), 'the validator is IMMUTABLE')
  assert.ok(/SET search_path = ''/.test(val.slice(0, 400)), 'and pins an empty search_path')
})

test('no column is narrowed, nothing is deleted, and no row is rewritten AT MIGRATION TIME', () => {
  assert.ok(!/DROP COLUMN|DROP TABLE|TRUNCATE/.test(FORWARD),
    'the migration must not remove a column or a table')
  // Function BODIES legitimately update candidates - that is what a producer does. The
  // claim is about statements the migration itself runs, so the bodies are removed first.
  const topLevel = FORWARD
    .replace(/AS [$]fn[$][\s\S]*?[$]fn[$];/g, 'AS <body>;')
    .replace(/AS [$][$][\s\S]*?[$][$];/g, 'AS <body>;')
    .replace(/DO [$]mig[$][\s\S]*?[$]mig[$];/g, 'DO <block>;')
  assert.ok(!/UPDATE public\.|DELETE FROM public\./.test(topLevel),
    'the migration itself rewrites no row: ' + (topLevel.match(/UPDATE public\.[a-z_]*/) || [''])[0])
  assert.ok(/ADD COLUMN IF NOT EXISTS/.test(topLevel), 'the sanity of the strip: the ALTER survived')
})

test('coverage is never decided from a date anywhere in the migration', () => {
  // The legacy path is explicitly forward-only, and nothing may read
  // proposed_interaction_date to infer what was summarized.
  assert.ok(!/proposed_interaction_date\s*(<|>|<=|>=)/.test(FORWARD),
    'the reviewer\'s date must never be compared to decide coverage')
  assert.ok(FORWARD.includes("coverage_source              = 'legacy_baseline'"),
    'a baseline is recorded as such')
})

console.log('\nwhat this amendment added')

test('the recovery hint is a bounded per-thread row, lowering only, and fenced', () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS public\.outlook_thread_recovery/.test(FORWARD))
  assert.ok(/PRIMARY KEY \(connection_id, conversation_fingerprint\)/.test(FORWARD),
    'one row per thread per connection, not one per message or per round')
  assert.ok(/earliest_unpaired_at     timestamptz NOT NULL/.test(FORWARD))
  // THE LIFECYCLE, not just the floor. An earlier revision only ever LOWERED the hint, and
  // that was reproduced as harmful: once the half was covered the window still reached back
  // over settled history, the single bounded page overflowed and the thread was abandoned
  // `recovery_truncated`. So the hint records WHICH messages are unpaired...
  assert.ok(/unpaired                 jsonb       NOT NULL/.test(FORWARD),
    'the hint records which messages are unpaired, not only an instant')
  assert.ok(/public\.outlook_unpaired_valid\(unpaired\)/.test(FORWARD), 'with a checked shape')
  // ...is merged keeping the EARLIEST instant per fingerprint while a half is unresolved...
  assert.ok(/min\(e->>'at'\) OVER \(PARTITION BY e->>'fp'\)/.test(FORWARD),
    'merging keeps the earliest instant for each unpaired message')
  // ...and is RESOLVED by the coverage write, in the same transaction, deleting before
  // updating because the shape constraint requires at least one pair.
  assert.strictEqual((FORWARD.match(/RESOLVE THE RECOVERY HINT/g) || []).length, 4,
    'all four write paths of both producers resolve the hint')
  const firstResolve = FORWARD.indexOf('RESOLVE THE RECOVERY HINT')
  const window = FORWARD.slice(firstResolve, firstResolve + 1800)
  assert.ok(window.indexOf('DELETE FROM public.outlook_thread_recovery')
            < window.indexOf('UPDATE public.outlook_thread_recovery'),
    'the fully resolved row is deleted BEFORE the partial one is trimmed')
  assert.ok(/WHERE NOT \(e->>'fp' = ANY \(v_seg_cov\)\)/.test(FORWARD),
    'and a pair survives only while the claim does not cover it')
  assert.ok(/ON DELETE CASCADE/.test(FORWARD.slice(FORWARD.indexOf('outlook_thread_recovery'))),
    'and it goes when the connection goes')
  const fn = FORWARD.slice(FORWARD.indexOf('FUNCTION public.record_outlook_thread_recovery('))
  const one = fn.slice(0, fn.indexOf('$fn$;') + 5)
  assert.ok(/sync_run_id = p_run_id/.test(one) && /count\(\*\) = 2/.test(one),
    'fenced on the live lease, both folders, like every other worker RPC')
})

test('coverage carries BOTH ends of its span, and the span is ordered', () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS coverage_from_at/.test(FORWARD))
  const chk = FORWARD.slice(FORWARD.indexOf('ocr_coverage_together'), FORWARD.indexOf('-- The one lookup'))
  assert.ok(chk.includes('coverage_from_at IS NOT NULL'), 'the span start is part of all-or-nothing')
  assert.ok(chk.includes('coverage_from_at <= coverage_through_at'), 'and it cannot be after the end')
})

test('ROTATION: the thread is matched on ring variants and migrated forward on touch', () => {
  // Rotation changes the conversation fingerprint too, so equality on the current value would
  // miss a row written under a retired key - and the thread would duplicate its own segment.
  assert.ok(/p_conversation_lookup_fingerprints text\[\] DEFAULT NULL/.test(FORWARD),
    'both producers take the thread ring variants')
  assert.strictEqual((FORWARD.match(/r\.conversation_fingerprint = ANY \(v_cfps\)/g) || []).length >= 4, true,
    'and every thread lookup uses them')
  assert.ok(/conversation_fingerprint IS DISTINCT FROM p_conversation_fingerprint/.test(FORWARD),
    'a row found under an old variant is rewritten to the current value')
  assert.ok(/r\.conversation_fingerprint = ANY \(w\.cfps\)/.test(FORWARD),
    'and the reader matches variants too')
  assert.ok(/'matched_conversation_fingerprint'/.test(FORWARD),
    'the reader says WHICH variant it found, so the worker can pass it back')
  // Coverage needs no variant PARAMETER: a flat set cannot answer a per-message question, so
  // the worker resolves each message to the value it is already stored under instead.
  assert.ok(!/p_covered_lookup_fingerprints/.test(FORWARD),
    'and coverage is resolved by the worker, not by a flat lookup set')
})

test('the NEW-CONTACT producer has the same two safeguards as the interaction one', () => {
  const nc = FORWARD.slice(FORWARD.indexOf('FUNCTION public.upsert_new_contact_candidate('))
  const one = nc.slice(0, nc.indexOf('$$;') + 3)
  assert.ok(/nc\.status IN \('pending', 'deferred'\)/.test(one),
    'an OPEN proposal pins identity, and deferred counts as open')
  assert.ok(/coverage_uninitialized/.test(one), 'a legacy thread refuses to guess here too')
  assert.ok(/coverage_moved/.test(one), 'and a concurrent decision is refused, not written around')
  assert.ok(/exists_terminal/.test(one), 'and a dismissed unknown-person exchange stays settled')
})

console.log('\nthe worker contract')

test('the two new refusal codes are NOT in WRITE_OK, so they forfeit the cursor', () => {
  // This is what makes the concurrent-decision case safe: a refused write stops the loop
  // and the next round re-reads the conversation instead of skipping it.
  assert.deepStrictEqual([...WRITE_OK], ['created', 'refreshed', 'exists_terminal'])
  for (const code of ['coverage_moved', 'coverage_uninitialized']) {
    assert.ok(!WRITE_OK.includes(code), `${code} must never be treated as a successful write`)
    assert.ok(FORWARD.includes(`'${code}'`), `${code} must be returned by the migration`)
  }
})

test('the producer passes coverage through the pure plan builder, defaulting to null', () => {
  const stage = read('supabase/functions/shared/outlookContentStage.js')
  for (const a of ['p_conversation_fingerprint', 'p_covered_fingerprints', 'p_coverage_through_at']) {
    assert.ok(stage.includes(a), `planContentWrite must pass ${a}`)
  }
  assert.ok(stage.includes('entry?.conversationFingerprint ?? null'),
    'the thread comes from the entry the round already builds')
  assert.ok(/segmentCoverage\?\.fingerprints/.test(stage), 'and the coverage from segmentCoverage')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
