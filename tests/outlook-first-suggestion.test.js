// One reviewable Outlook suggestion: the run logic, the write contract, and the
// review surface.
//
// WHAT IS EXERCISED HERE, AND WHAT IS NOT - stated precisely, because the difference
// is the whole point of the slice.
//
//   EXERCISED, pure logic: runOutlookImport is driven end to end against a recording
//   fake RPC port, so the ORDER that matters is executed - suggestions written before
//   the cursor-advancing release, nothing written and no cursor supplied on an
//   incomplete pass, and a refused write downgrading the run to incomplete.
//
//   EXERCISED, real React render: InteractionSourceBadge is transformed with the
//   repo's own oxc transform (via vite, already a devDependency) and rendered with
//   react-dom/server. So "an Outlook suggestion is labelled Outlook, with an
//   accessible name, and a non-provider source renders no badge at all" is executed,
//   not scanned.
//
//   NOT EXERCISED - STRUCTURAL SCANS ONLY. renderToStaticMarkup produces markup and
//   dispatches no events, and this repo carries no JSDOM or React testing library. So
//   these remain source assertions:
//     * that SuggestionsPage renders the badge for a row,
//     * that its edit inputs are bound to the override fields it sends,
//     * that clicking Accept/Dismiss calls the RPCs.
//   The accept-with-edits ACTION is instead executed at the data layer, over real
//   HTTP through real PostgREST, by tests/local/outlook-first-suggestion.mjs - which
//   is where a click would end up anyway.
//
//   NOT COVERED AT ALL HERE: the database. Migration behaviour, lease fencing and
//   deduplication are proven against a real Postgres by that same harness.
//
// Run with: node tests/outlook-first-suggestion.test.js

import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithOxc } from 'vite'
import {
  SOURCE_PROVIDERS, getSourceProvider, isValidInteractionSource,
} from '../src/lib/interactionSource.js'
   // the version this fixture's connection consented under; injected as the background requirement

/**
 * Every run now reads and writes ROUND PROGRESS, so this suite's port is wrapped: the
 * round-progress RPCs answer from an in-memory mirror of migration 20261002000000 and
 * everything else falls through and is still recorded in `p.calls`. The mirror is a
 * convenience - the real SQL is exercised by tests/sql/outlook-durable-continuation-
 * runtime.sql and by the Docker harness.
 */

// `encryptCursor` in this suite wraps the link as CT(<link>); the decryptor undoes that,
// so a test can assert WHICH link a resumed request used.

let passed = 0, failed = 0
const pending = []
function test (name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { console.log(`  ✓ ${name}`); passed++ },
        (e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ },
      ))
    } else { console.log(`  ✓ ${name}`); passed++ }
  } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const MIGRATION = read('supabase/migrations/20260930000000_outlook_interaction_candidate_write.sql')
const BADGE_SRC = read('src/components/InteractionSourceBadge.jsx')

// ── a real JSX render, using the repo's own transform ─────────────────────────
// Bare and relative specifiers are rewritten to absolute URLs because a data: module
// cannot resolve either. No file is written and nothing in src/ is touched.
async function loadComponent (relPath) {
  const abs = resolve(dirname(fileURLToPath(import.meta.url)), '..', relPath)
  const out = await transformWithOxc(readFileSync(abs, 'utf8'), abs,
    { lang: 'jsx', jsx: { runtime: 'automatic' } })
  const code = out.code.replace(/(from\s*)"([^"]+)"/g, (m, kw, spec) => {
    if (spec.startsWith('.')) {
      let t = resolve(dirname(abs), spec)
      for (const ext of ['', '.js', '.jsx']) { if (existsSync(t + ext)) { t = t + ext; break } }
      return `${kw}"${pathToFileURL(t).href}"`
    }
    return `${kw}"${import.meta.resolve(spec)}"`
  })
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

// ── a recording RPC port ─────────────────────────────────────────────────────

// A real uuid, because microsoft_connections.user_id IS one and the pilot gate requires
// the designated account to be uuid-shaped - that shape check is what stops an empty
// string or a '*' reading as `everyone`.


/** A fake port that records every call and answers from a script. */

/**
 * runOutlookImport calls runOutlookMetadataPass directly, so the pass is driven with a
 * fixture fetch serving one two-sided exchange. That keeps the module under test
 * unmodified rather than adding a seam only a test would use.
 */

/** Three distinct two-sided episodes, so three writes are intended. */



console.log('\nthe run writes the suggestion BEFORE it advances the cursor')




console.log('\nan incomplete pass writes nothing and advances nothing')








console.log('\nonly an existing contact can become a suggestion')



test('the migration refuses a contactless write rather than inventing a person', () => {
  assert.ok(/p_contact_id IS NULL/.test(MIGRATION))
  assert.ok(/'contact_required'/.test(MIGRATION))
  assert.ok(/contact_not_owned/.test(MIGRATION), 'and refuses a contact owned by someone else')
})

console.log('\nthe write path is Outlook-specific and lease-fenced')

test('the migration fences on outlook_sync_state, never on the Gmail tables', () => {
  assert.ok(/FROM public\.outlook_sync_state s/.test(MIGRATION))
  assert.ok(/FROM public\.microsoft_connections c WHERE c\.id = p_connection_id/.test(MIGRATION),
    'the owner comes from the Microsoft connection')
  // The fence requires BOTH folder rows to belong to the same live run, matching
  // reserve_due_outlook_connection and invalidate_outlook_candidates_by_fingerprint.
  assert.ok(/count\(\*\) = 2 AND bool_and\(s\.sync_run_id = p_run_id/.test(MIGRATION),
    'one folder lease must not be enough')
  assert.ok(!/AND s\.folder = 'inbox'/.test(MIGRATION),
    'the single-folder fence must be gone')
  // Both state rows locked FOR SHARE first, as the invalidation RPC does. Checked as
  // substrings rather than one multi-line pattern, which is easy to get wrong.
  assert.ok(MIGRATION.includes('PERFORM 1 FROM public.outlook_sync_state s'))
  assert.ok(MIGRATION.includes('WHERE s.connection_id = p_connection_id FOR SHARE;'),
    'the lock must cover BOTH folder rows, not one named row')
  assert.ok(/sync_lease_until > now\(\)/.test(MIGRATION))
  assert.ok(/'stale_run'/.test(MIGRATION))
  const code = MIGRATION.split(String.fromCharCode(10))
    .filter((l) => !/^\s*--/.test(l)).join(String.fromCharCode(10))
  for (const gmail of ['gmail_sync_state', 'google_connections', 'email_candidate_refs']) {
    assert.ok(!code.includes(gmail), `a Microsoft connection must not touch ${gmail}`)
  }
})


test('the write RPC is service_role only, so a user cannot manufacture a suggestion', () => {
  assert.ok(/REVOKE ALL ON FUNCTION public\.upsert_outlook_interaction_candidate\([\s\S]*?\)\s*FROM PUBLIC, anon, authenticated;/.test(MIGRATION))
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.upsert_outlook_interaction_candidate\([\s\S]*?\)\s*TO service_role;/.test(MIGRATION))
  assert.ok(/SECURITY DEFINER/.test(MIGRATION) && /SET search_path = ''/.test(MIGRATION))
  assert.ok(/NOT APPLIED/.test(MIGRATION))
})

test('the migration creates no interaction and touches no contact', () => {
  const code = MIGRATION.split(String.fromCharCode(10))
    .filter((l) => !/^\s*--/.test(l)).join(String.fromCharCode(10))
  assert.ok(!/INSERT INTO public\.interactions/.test(code),
    'only the user\'s accept RPC may create an interaction')
  assert.ok(!/UPDATE public\.contacts/.test(code))
  assert.ok(!/DELETE FROM public\.contacts/.test(code))
  // It writes exactly two tables.
  const inserts = [...code.matchAll(/INSERT INTO public\.([a-z_]+)/g)].map((m) => m[1]).sort()
  assert.deepStrictEqual(inserts, ['interaction_candidates', 'outlook_candidate_refs'])
})

test('the suggestion is created with every content column left NULL', () => {
  const insert = MIGRATION.slice(MIGRATION.indexOf('INSERT INTO public.interaction_candidates'))
    .slice(0, 600)
  for (const col of ['proposed_notes', 'retained_subject', 'draft_summary',
    'draft_follow_up', 'summary_evidence', 'extraction_status']) {
    assert.ok(!insert.includes(col), `${col} must not be written by a metadata pass`)
  }
  assert.ok(insert.includes("'pending'"))
  assert.ok(insert.includes("'outlook'"))
})

console.log('\nthe log summary carries no identifier or fingerprint')



console.log('\nthe review surface: EXERCISED by a real render')

test('an Outlook suggestion renders an Outlook badge with an accessible name', async () => {
  const mod = await loadComponent('src/components/InteractionSourceBadge.jsx')
  const html = renderToStaticMarkup(createElement(mod.default, { source: 'outlook' }))
  assert.ok(html.includes('>Outlook<'), `visible label missing: ${html.slice(0, 160)}`)
  assert.ok(html.includes('aria-label="Source: Outlook"'))
  assert.ok(html.includes('data-source="outlook"'))
  assert.ok(html.includes('<svg'), 'the glyph must render')
  assert.ok(html.includes('aria-hidden="true"'), 'and be hidden from assistive tech')
})

test('a non-provider source renders NO badge at all', async () => {
  const mod = await loadComponent('src/components/InteractionSourceBadge.jsx')
  for (const s of ['manual', 'gmail', 'Outlook', ' outlook', '', undefined, null]) {
    assert.strictEqual(renderToStaticMarkup(createElement(mod.default, { source: s })), '',
      `${JSON.stringify(s)} must render nothing`)
  }
})

test('the calendar badge is unchanged by the Outlook addition', async () => {
  const mod = await loadComponent('src/components/InteractionSourceBadge.jsx')
  const html = renderToStaticMarkup(createElement(mod.default, { source: 'google_calendar' }))
  assert.ok(html.includes('>Google Calendar<'))
  assert.ok(html.includes('aria-label="Source: Google Calendar"'))
})

test('the Outlook glyph claims no Microsoft branding', () => {
  assert.ok(/NOT Microsoft's Outlook product icon/.test(BADGE_SRC),
    'the temporary-glyph rule must be recorded, as it is for the calendar mark')
  assert.ok(/brand guidelines/.test(BADGE_SRC))
  const provider = SOURCE_PROVIDERS.outlook
  for (const s of [provider.label, provider.ariaLabel, provider.title]) {
    assert.ok(!/Microsoft 365|Office 365|®|™/.test(s), s)
  }
  // The registry is what the badge reads, so assert the resolution too.
  assert.strictEqual(getSourceProvider('outlook').label, 'Outlook')
  assert.strictEqual(getSourceProvider('gmail'), null, 'gmail is valid but not presented')
  assert.strictEqual(isValidInteractionSource('outlook'), true,
    'an accepted Outlook suggestion writes interactions.source = outlook')
})

console.log('\nthe review surface: the gate, and what stays a source scan')








console.log('\nno Anthropic, no body, no scheduling in this slice')


test('no file under src/ mentions a service-role key', () => {
  for (const f of ['src/lib/interactionSource.js', 'src/components/InteractionSourceBadge.jsx']) {
    assert.ok(!/service_role|SERVICE_ROLE|serviceRoleKey/.test(read(f)), f)
  }
})

console.log('')
console.log('COMMITTED requires the release RPC to confirm success')





console.log('')
console.log('a thrown write or encryption is an error release, never a commit')




console.log('')
console.log('partial writes are reported, not erased')





console.log('')
console.log('the review analytics are source-correct')





console.log('')
console.log('the entry count does not call an interaction a person')



async function finish () {
  await Promise.all(pending)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
await finish()
