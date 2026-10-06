// REVIEWING A PROPOSED CONTACT AND ITS INTERACTION TOGETHER.
//
// WHAT IS EXERCISED HERE:
//   * src/lib/newContactReview.js, in full. Every validation bound, the exact RPC
//     argument shape, the result-code map, and the prefill rule - all pure, all
//     executed.
//   * A REAL React render of NewContactSuggestionCard, using the repo's own oxc
//     transform and react-dom/server, with a stubbed Supabase client. So the card's
//     markup - the read-only email, the "no summary" wording, the button label, the
//     editable fields - is produced, not grepped.
//   * THE CENTRAL CLAIM, executed: rendering the card and editing it issues NO rpc
//     call at all. The stub records every call, and the assertion is that the list is
//     empty after a full render.
//
// WHAT IS NOT:
//   renderToStaticMarkup dispatches no events and this repo carries no JSDOM, so
//   "pressing Save calls accept_new_contact_candidate with these arguments" is proven
//   at the data layer instead - the handler calls acceptArgs(), which is executed
//   here directly, and the RPC itself is proven against real Postgres by
//   tests/sql/outlook-content-slice-runtime.sql.
//
// NO REAL ADDRESS, NAME OR MESSAGE APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-new-contact-review.test.js

import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithOxc } from 'vite'
import {
  NCC_SELECT, NCC_INTERACTION_TYPES, RELATIONSHIP_TYPES, NCC_BOUNDS,
  parseTags, validateProposal, acceptArgs, acceptOutcome, dismissOutcome,
  ACCEPT_CODES, DISMISS_CODES, initialReviewState, proposalEdited,
  evidenceLabel, summaryPresent,
} from '../src/lib/newContactReview.js'

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
const CARD_SRC = read('src/components/NewContactSuggestionCard.jsx')
const PAGE_SRC = read('src/pages/SuggestionsPage.jsx')
const MIGRATION = read('supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql')
const codeOnly = (src) => src.split(String.fromCharCode(10))
  .filter((l) => !/^[ ]*([/][/]|[*]|[/][*])/.test(l)).join(String.fromCharCode(10))

// ── the recorded Supabase stub ──────────────────────────────────────────────
// Every rpc / from call is recorded so the test can assert that rendering makes none.
const calls = []
function supabaseStub () {
  const builder = {}
  for (const m of ['select', 'eq', 'order', 'limit']) {
    builder[m] = () => builder
  }
  builder.then = (res) => res({ data: [], error: null })
  return {
    rpc: (name, args) => { calls.push({ kind: 'rpc', name, args }); return Promise.resolve({ data: null, error: null }) },
    from: (table) => { calls.push({ kind: 'from', table }); return builder },
  }
}

/**
 * Load a JSX component with the repo's own transform, RECURSIVELY: the card imports
 * another .jsx file, and Node cannot import one directly, so each dependency is
 * transformed into its own data: module and the specifier is rewritten to point at
 * it. The two side-effecting imports (Supabase, analytics) are replaced with
 * recording stubs at the module boundary rather than mocked inside the component, so
 * the component under test stays byte-identical to the shipped one.
 *
 * Nothing under src/ is written.
 */
async function loadModule (abs) {
  const src = readFileSync(abs, 'utf8')
  const out = /\.jsx$/.test(abs)
    ? await transformWithOxc(src, abs, { lang: 'jsx', jsx: { runtime: 'automatic' } })
    : { code: src }
  let code = out.code
  code = code.replace(/import\s*\{\s*supabase\s*\}\s*from\s*["'][^"']*supabase[^"']*["'];?/,
    'const supabase = globalThis.__supabaseStub;')
  code = code.replace(/import\s*\{\s*track\s*\}\s*from\s*["'][^"']*analytics[^"']*["'];?/,
    'const track = (...a) => globalThis.__tracked.push(a);')

  // Resolve each relative specifier, recursing into any .jsx dependency.
  const specs = [...code.matchAll(/(from\s*)["']([^"']+)["']/g)]
  const replacements = new Map()
  for (const [, , spec] of specs) {
    if (replacements.has(spec)) continue
    if (spec.startsWith('.')) {
      let t = resolve(dirname(abs), spec)
      for (const ext of ['', '.js', '.jsx']) { if (existsSync(t + ext)) { t = t + ext; break } }
      replacements.set(spec, /\.jsx$/.test(t)
        ? await loadModuleUrl(t)
        : pathToFileURL(t).href)
    } else {
      replacements.set(spec, import.meta.resolve(spec))
    }
  }
  code = code.replace(/(from\s*)["']([^"']+)["']/g,
    (m, kw, spec) => `${kw}"${replacements.get(spec) ?? spec}"`)
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

const moduleUrlCache = new Map()
async function loadModuleUrl (abs) {
  if (!moduleUrlCache.has(abs)) moduleUrlCache.set(abs, await loadModule(abs))
  return moduleUrlCache.get(abs)
}

async function loadCard () {
  const abs = resolve(dirname(new URL(import.meta.url).pathname.slice(1)), '..',
    'src/components/NewContactSuggestionCard.jsx')
  return import(await loadModule(abs))
}

// ── a fixture candidate row, as PostgREST would return it ───────────────────
const ROW = Object.freeze({
  id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  source: 'outlook',
  status: 'pending',
  proposed_email: 'priya.sharma@goldman.test',
  proposed_name: 'Priya Sharma',
  proposed_name_evidence: 'explicit_signature',
  proposed_name_confidence: 'high',
  draft_summary: 'Priya offered to put your application in front of the analyst '
    + 'programme lead and asked for an updated CV by Friday.',
  draft_follow_up: 'Send the updated CV before Friday.',
  proposed_interaction_date: '2026-09-22',
  proposed_type: 'Email',
  retained_subject: 'Summer analyst referral',
  extraction_status: 'ai_extracted',
  created_at: '2026-09-22T10:00:00Z',
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the selected columns, and what they must NOT include')

test('NCC_SELECT asks only for columns authenticated may read', () => {
  // The GRANT excludes user_id, both fingerprints, key_version and
  // context_expires_at. Asking for one would fail the WHOLE query, so this is not
  // cosmetic - it is the difference between a working queue and a broken one.
  for (const forbidden of ['user_id', 'person_fingerprint', 'episode_fingerprint',
    'key_version', 'context_expires_at', 'accepted_contact_id', 'accepted_interaction_id']) {
    assert.ok(!NCC_SELECT.includes(forbidden), `must not select ${forbidden}`)
  }
  // And every column it DOES ask for must be in the grant list.
  const grant = MIGRATION.slice(MIGRATION.indexOf('GRANT SELECT ('),
    MIGRATION.indexOf(') ON TABLE public.new_contact_candidates TO authenticated'))
  for (const col of NCC_SELECT.split(',').map((c) => c.trim())) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(grant), `${col} is not granted to authenticated`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the prefill: a reviewed draft, not an authoritative-looking guess')

test('only the name and the interaction are prefilled', () => {
  const s = initialReviewState(ROW)
  assert.strictEqual(s.name, 'Priya Sharma')
  assert.strictEqual(s.interactionType, 'Email')
  assert.strictEqual(s.interactionDate, '2026-09-22')
  assert.strictEqual(s.interactionNotes, ROW.draft_summary)
  assert.strictEqual(s.createInteraction, true)
  // BLANK, deliberately: nothing stored them, because the content pass drops them
  // rather than persist a value nobody reviewed.
  for (const k of ['company', 'role', 'howMet', 'linkedin', 'tags',
    'relationshipType', 'relationshipNote', 'followUpDate']) {
    assert.strictEqual(s[k], '', `${k} must start blank`)
  }
})

test('an unusable proposed type falls back to Email, never to the raw value', () => {
  assert.strictEqual(initialReviewState({ ...ROW, proposed_type: 'Telepathy' }).interactionType, 'Email')
  assert.strictEqual(initialReviewState({}).interactionType, 'Email')
  assert.strictEqual(initialReviewState({}).interactionDate, '')
  assert.strictEqual(initialReviewState({}).name, '')
})

test('a row with no summary prefills NO note', () => {
  const s = initialReviewState({ ...ROW, draft_summary: null })
  assert.strictEqual(s.interactionNotes, '', 'and emphatically not a placeholder')
  assert.strictEqual(summaryPresent({ ...ROW, draft_summary: null }), false)
  assert.strictEqual(summaryPresent({ ...ROW, draft_summary: '   ' }), false)
  assert.strictEqual(summaryPresent(ROW), true)
})

test('proposalEdited sees a real change and ignores a no-op', () => {
  const s = initialReviewState(ROW)
  assert.strictEqual(proposalEdited(ROW, s), false)
  assert.strictEqual(proposalEdited(ROW, { ...s, company: 'Goldman' }), true)
  assert.strictEqual(proposalEdited(ROW, { ...s, name: 'Priya S.' }), true)
  assert.strictEqual(proposalEdited(ROW, { ...s, createInteraction: false }), true)
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('validation mirrors the server, so a bound is caught before a round trip')

test('a name is required, and bounded', () => {
  const base = initialReviewState(ROW)
  assert.deepStrictEqual(validateProposal(base), { ok: true })
  assert.strictEqual(validateProposal({ ...base, name: '   ' }).code, 'invalid_name')
  assert.strictEqual(validateProposal({ ...base, name: 'x'.repeat(121) }).code, 'invalid_name')
  assert.deepStrictEqual(validateProposal({ ...base, name: 'x'.repeat(120) }), { ok: true })
  // A control character would be rejected by the server's own regex.
  assert.strictEqual(
    validateProposal({ ...base, name: 'Pri' + String.fromCharCode(9) + 'ya' }).code, 'invalid_name')
})

test('every optional contact field is bounded exactly as the RPC bounds it', () => {
  const base = initialReviewState(ROW)
  for (const [field, code, max] of [
    ['company', 'invalid_company', NCC_BOUNDS.company],
    ['role', 'invalid_role', NCC_BOUNDS.role],
    ['howMet', 'invalid_how_met', NCC_BOUNDS.howMet],
    ['relationshipNote', 'invalid_relationship_note', NCC_BOUNDS.relationshipNote],
  ]) {
    assert.deepStrictEqual(validateProposal({ ...base, [field]: 'x'.repeat(max) }), { ok: true }, field)
    assert.strictEqual(validateProposal({ ...base, [field]: 'x'.repeat(max + 1) }).code, code, field)
    // Blank is always fine: these are optional.
    assert.deepStrictEqual(validateProposal({ ...base, [field]: '  ' }), { ok: true }, field)
  }
  // And the bounds match the migration's own numbers.
  assert.ok(MIGRATION.includes('char_length(v_name) > 120'))
  assert.ok(MIGRATION.includes('char_length(p_relationship_note) > 500'))
})

test('a LinkedIn URL must be a LinkedIn profile URL', () => {
  const base = initialReviewState(ROW)
  assert.deepStrictEqual(
    validateProposal({ ...base, linkedin: 'https://www.linkedin.com/in/priya-sharma' }), { ok: true })
  assert.deepStrictEqual(
    validateProposal({ ...base, linkedin: 'https://linkedin.com/in/p_s.1/' }), { ok: true })
  for (const bad of ['linkedin.com/in/x', 'http://www.linkedin.com/in/x',
    'https://example.test/in/x', 'https://www.linkedin.com/company/x']) {
    assert.strictEqual(validateProposal({ ...base, linkedin: bad }).code,
      'invalid_linkedin_url', bad)
  }
})

test('tags are split, trimmed, bounded and counted', () => {
  assert.deepStrictEqual(parseTags('recruiter, target firm'), ['recruiter', 'target firm'])
  assert.deepStrictEqual(parseTags('a,,  ,b'), ['a', 'b'], 'empty entries are dropped')
  assert.deepStrictEqual(parseTags(''), [])
  assert.deepStrictEqual(parseTags(null), [])
  assert.deepStrictEqual(parseTags(['x ', ' y']), ['x', 'y'])
  const base = initialReviewState(ROW)
  assert.deepStrictEqual(validateProposal({
    ...base, tags: Array.from({ length: 20 }, (_, i) => `t${i}`).join(','),
  }), { ok: true })
  assert.strictEqual(validateProposal({
    ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`).join(','),
  }).code, 'invalid_tags')
  assert.strictEqual(validateProposal({ ...base, tags: 'x'.repeat(61) }).code, 'invalid_tags')
})

test('a relationship type must come from the list the form offers', () => {
  const base = initialReviewState(ROW)
  for (const t of RELATIONSHIP_TYPES) {
    assert.deepStrictEqual(validateProposal({ ...base, relationshipType: t }), { ok: true }, t)
  }
  assert.strictEqual(validateProposal({ ...base, relationshipType: 'Friend' }).code,
    'invalid_relationship_type')
  // And the list matches the database CHECK.
  for (const t of RELATIONSHIP_TYPES) assert.ok(MIGRATION.includes(`'${t}'`), t)
})

test('the INTERACTION is optional, and only checked when it is included', () => {
  const base = initialReviewState(ROW)
  // Left out entirely: its fields are not validated at all.
  assert.deepStrictEqual(validateProposal({
    ...base, createInteraction: false, interactionType: 'Nonsense', interactionDate: 'no',
  }), { ok: true })
  // Included: they are.
  assert.strictEqual(validateProposal({ ...base, interactionType: 'Nonsense' }).code, 'invalid_type')
  assert.strictEqual(validateProposal({ ...base, interactionDate: '22-09-2026' }).code, 'invalid_date')
  assert.strictEqual(validateProposal({ ...base, interactionDate: '' }).code, 'invalid_date')
  for (const t of NCC_INTERACTION_TYPES) {
    assert.deepStrictEqual(validateProposal({ ...base, interactionType: t }), { ok: true }, t)
  }
})

test('the interaction note is bounded at 200, matching the interaction column', () => {
  const base = initialReviewState(ROW)
  assert.strictEqual(NCC_BOUNDS.notes, 200)
  assert.deepStrictEqual(validateProposal({ ...base, interactionNotes: 'x'.repeat(200) }), { ok: true })
  assert.strictEqual(validateProposal({ ...base, interactionNotes: 'x'.repeat(201) }).code, 'invalid_notes')
  assert.ok(MIGRATION.includes('char_length(v_notes) > 200'),
    'and the server bounds it at the same number')
})

test('a follow-up date is optional but must be a date when given', () => {
  const base = initialReviewState(ROW)
  assert.deepStrictEqual(validateProposal({ ...base, followUpDate: '' }), { ok: true })
  assert.deepStrictEqual(validateProposal({ ...base, followUpDate: '2026-09-30' }), { ok: true })
  assert.strictEqual(validateProposal({ ...base, followUpDate: 'soon' }).code,
    'invalid_follow_up_date')
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the RPC arguments: the address is NOT among them')

test('acceptArgs sends no email, and no fingerprint', () => {
  const args = acceptArgs(ROW.id, initialReviewState(ROW))
  // THE ADDRESS IS READ FROM THE STORED ROW BY THE RPC. A caller value would be
  // ignored, so sending one would be a lie about what gets saved.
  assert.strictEqual(args.p_proposed_email, undefined)
  assert.ok(!Object.keys(args).some((k) => /email/i.test(k)), Object.keys(args).join(','))
  assert.ok(!JSON.stringify(args).includes('goldman.test'))
  assert.ok(!Object.keys(args).some((k) => /fingerprint/.test(k)))
  // And the RPC genuinely reads it from the candidate.
  assert.ok(MIGRATION.includes('v_email := pg_catalog.lower(pg_catalog.btrim(v_cand.proposed_email))'),
    'the server must take the address from the stored row')
})

test('acceptArgs matches the RPC signature parameter for parameter', () => {
  const args = acceptArgs(ROW.id, initialReviewState(ROW))
  // Bounded to the PARAMETER LIST only. An earlier version sliced on ')\nRETURNS',
  // which does not match a CRLF file, so the scan ran past the signature and picked
  // up `p_until` from a later function.
  const start = MIGRATION.indexOf('CREATE FUNCTION public.accept_new_contact_candidate(')
  assert.ok(start > 0, 'the function must be in the migration')
  const sig = MIGRATION.slice(start, MIGRATION.indexOf('RETURNS jsonb', start))
  const declared = [...sig.matchAll(/^\s*(p_[a-z_]+)\s/gm)].map((m) => m[1])
  assert.ok(declared.includes('p_candidate_id'), 'sanity: the scan found the parameters')
  assert.deepStrictEqual(Object.keys(args).sort(), declared.sort(),
    'every argument sent must be a declared parameter, and vice versa')
})

test('blank optional fields become NULL, not empty strings', () => {
  const args = acceptArgs(ROW.id, initialReviewState(ROW))
  for (const k of ['p_company', 'p_role', 'p_how_met', 'p_linkedin_url', 'p_tags',
    'p_relationship_type', 'p_relationship_note', 'p_follow_up_date']) {
    assert.strictEqual(args[k], null, `${k} must be null when blank`)
  }
  assert.strictEqual(args.p_name, 'Priya Sharma')
  assert.strictEqual(args.p_create_interaction, true)
  assert.strictEqual(args.p_interaction_notes, ROW.draft_summary)
})

test('USER EDITS ARE WHAT IS SENT, not the proposal', () => {
  const edited = {
    ...initialReviewState(ROW),
    name: 'Priya S',
    company: 'Goldman Sachs',
    role: 'Associate',
    howMet: 'Careers fair',
    linkedin: 'https://www.linkedin.com/in/priya-s',
    tags: 'recruiter, banking',
    relationshipType: 'Referral path',
    relationshipNote: 'Can introduce me to the analyst programme lead.',
    interactionType: 'Coffee chat',
    interactionDate: '2026-09-23',
    interactionNotes: 'She asked for my CV by Friday and wants my track preference.',
    followUpDate: '2026-09-26',
  }
  assert.deepStrictEqual(validateProposal(edited), { ok: true })
  const args = acceptArgs(ROW.id, edited)
  assert.strictEqual(args.p_name, 'Priya S')
  assert.strictEqual(args.p_company, 'Goldman Sachs')
  assert.strictEqual(args.p_role, 'Associate')
  assert.strictEqual(args.p_how_met, 'Careers fair')
  assert.strictEqual(args.p_linkedin_url, 'https://www.linkedin.com/in/priya-s')
  assert.deepStrictEqual(args.p_tags, ['recruiter', 'banking'])
  assert.strictEqual(args.p_relationship_type, 'Referral path')
  assert.strictEqual(args.p_interaction_type, 'Coffee chat')
  assert.strictEqual(args.p_interaction_date, '2026-09-23')
  assert.strictEqual(args.p_follow_up_date, '2026-09-26')
  assert.ok(args.p_interaction_notes.includes('track preference'))
  // The model's original summary is NOT what gets written once the user has changed it.
  assert.notStrictEqual(args.p_interaction_notes, ROW.draft_summary)
})

test('declining the interaction sends NO interaction fields', () => {
  const args = acceptArgs(ROW.id, { ...initialReviewState(ROW), createInteraction: false })
  assert.strictEqual(args.p_create_interaction, false)
  for (const k of ['p_interaction_type', 'p_interaction_date', 'p_interaction_notes',
    'p_follow_up_date']) {
    assert.strictEqual(args[k], null, k)
  }
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('every result code is mapped, and an unknown one never clears the queue')

test('the map covers every code the RPC can return', () => {
  const sig = MIGRATION.slice(
    MIGRATION.indexOf('CREATE FUNCTION public.accept_new_contact_candidate('),
    MIGRATION.indexOf('-- ── RPC 7'))
  const returned = [...new Set([...sig.matchAll(/'result',\s*'([a-z_]+)'/g)].map((m) => m[1]))]
  for (const code of returned) {
    assert.ok(ACCEPT_CODES.includes(code), `the UI has no message for '${code}'`)
  }
  assert.ok(returned.includes('accepted') && returned.includes('duplicate_email'),
    'sanity: the scan actually found codes')
})

test('an UNKNOWN code keeps the row and says nothing was created', () => {
  const o = acceptOutcome('something_new')
  assert.strictEqual(o.removeFromQueue, false)
  assert.ok(/[Nn]othing was created/.test(o.message), o.message)
  assert.strictEqual(dismissOutcome('something_new').removeFromQueue, false)
})

test('duplicate_email clears the queue: the question has been answered', () => {
  const o = acceptOutcome('duplicate_email')
  assert.strictEqual(o.removeFromQueue, true)
  assert.ok(/already have a contact/.test(o.message))
})

test('a write failure says plainly that nothing was created', () => {
  // The RPC rolls the contact insert back if the interaction insert fails, so
  // "partially saved" is not a state that exists - and the message must not imply it.
  assert.ok(/Nothing was created/.test(acceptOutcome('write_failed').message))
  assert.strictEqual(acceptOutcome('write_failed').removeFromQueue, false)
  assert.ok(MIGRATION.includes('WHEN OTHERS THEN'))
  assert.ok(/rolls back the\s*--\s*contact insert too/.test(MIGRATION)
    || MIGRATION.includes('rolls the whole function back'),
    'the migration must document the rollback this message relies on')
})

test('dismiss outcomes never report a creation', () => {
  for (const code of DISMISS_CODES) {
    const m = dismissOutcome(code).message
    assert.ok(!/saved\./.test(m) || code === 'accepted', `${code}: ${m}`)
  }
  assert.strictEqual(dismissOutcome('dismissed').removeFromQueue, true)
  assert.strictEqual(dismissOutcome('already_dismissed').removeFromQueue, true)
})

test('evidence is described in words a reviewer can act on', () => {
  assert.strictEqual(evidenceLabel('explicit_signature'), 'from their signature')
  assert.strictEqual(evidenceLabel('explicit_body'), 'from the message')
  // THE IMPORTANT ONE. A provider display name was not inferred from anything said,
  // and saying so is the difference between trusting it and checking it.
  assert.strictEqual(evidenceLabel('provider_metadata'), 'from the email account name')
  assert.strictEqual(evidenceLabel(null), null)
  assert.strictEqual(evidenceLabel('invented'), null)
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('a REAL render of the card')

test('the card shows the person, the exchange and the editable fields', async () => {
  globalThis.__supabaseStub = supabaseStub()
  globalThis.__tracked = []
  calls.length = 0
  const mod = await loadCard()
  const html = renderToStaticMarkup(createElement(mod.default, {
    candidate: ROW, onResolved: () => {},
  }))

  // THE CLAIM THAT MATTERS: rendering created nothing and queried nothing.
  assert.deepStrictEqual(calls, [], 'rendering the card must issue no call at all')
  assert.deepStrictEqual(globalThis.__tracked, [], 'and track no event')

  // The person.
  assert.ok(html.includes('New person'))
  assert.ok(html.includes('Priya Sharma'))
  assert.ok(html.includes('priya.sharma@goldman.test'), 'the envelope address is shown')
  assert.ok(html.includes('from their signature'), 'and how the name was arrived at')
  // The exchange, with the real summary.
  assert.ok(html.includes('analyst'), 'the summary is shown')
  assert.ok(html.includes('Send the updated CV before Friday.'))
  assert.ok(html.includes('2026-09-22'))
  // The editable fields, all of them.
  for (const label of ['Name', 'Company', 'Role', 'How you met', 'Relationship', 'Tags',
    'Interaction type', 'Date', 'Note', 'Follow up on']) {
    assert.ok(html.includes(label), `the card must offer ${label}`)
  }
  // And ONE explicit action that creates both.
  assert.ok(html.includes('Save contact &amp; interaction'), 'one explicit acceptance')
  assert.ok(html.includes('Dismiss'))
})

test('the email field is not editable, because the RPC would ignore an edit', async () => {
  globalThis.__supabaseStub = supabaseStub()
  globalThis.__tracked = []
  const mod = await loadCard()
  const html = renderToStaticMarkup(createElement(mod.default, {
    candidate: ROW, onResolved: () => {},
  }))
  // No input carries the address as a value.
  assert.ok(!/<input[^>]*value="priya\.sharma@goldman\.test"/.test(html),
    'the address must not appear as an editable value')
  assert.ok(!/<input[^>]*type="email"/.test(html))
})

test('NO SUMMARY renders the honest sentence, never a placeholder note', async () => {
  globalThis.__supabaseStub = supabaseStub()
  globalThis.__tracked = []
  const mod = await loadCard()
  const html = renderToStaticMarkup(createElement(mod.default, {
    candidate: { ...ROW, draft_summary: null, draft_follow_up: null },
    onResolved: () => {},
  }))
  assert.ok(html.includes('No summary was prepared'), html.slice(0, 200))
  assert.ok(html.includes('Add your own note'))
  // And the note field is EMPTY, not seeded with a subject or a count.
  assert.ok(!/Summer analyst referral/.test(html), 'the subject is not used as a note')
  const textarea = html.match(/<textarea[^>]*>([^<]*)<\/textarea>/)
  assert.ok(textarea === null || textarea[1].trim() === '', 'the note must start empty')
})

test('a name with no evidence renders no evidence claim', async () => {
  globalThis.__supabaseStub = supabaseStub()
  globalThis.__tracked = []
  const mod = await loadCard()
  const html = renderToStaticMarkup(createElement(mod.default, {
    candidate: { ...ROW, proposed_name_evidence: null }, onResolved: () => {},
  }))
  assert.ok(!html.includes('Name from'), 'no evidence means no claim about evidence')
})

test('the dismiss confirmation promises that nothing is created', async () => {
  // Rendered from the source, since the confirmation is behind state this render
  // cannot reach. Asserted on the string the component ships.
  assert.ok(/No contact or interaction will be created/.test(CARD_SRC),
    'the confirmation must say what dismissing does NOT do')
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('nothing is created by opening the queue, editing, or dismissing')

test('the card calls exactly TWO rpcs, and only one of them writes a network record', () => {
  const names = [...new Set([...codeOnly(CARD_SRC).matchAll(/supabase\.rpc\(\s*'([a-z_]+)'/g)]
    .map((m) => m[1]))].sort()
  assert.deepStrictEqual(names, ['accept_new_contact_candidate', 'dismiss_new_contact_candidate'])
  // No direct table write of any kind: every write goes through an RPC, and the table
  // grants `authenticated` no INSERT/UPDATE/DELETE anyway.
  for (const forbidden of ['.insert(', '.update(', '.upsert(', '.delete(']) {
    assert.ok(!codeOnly(CARD_SRC).includes(forbidden), `the card must not call ${forbidden}`)
  }
  assert.ok(MIGRATION.includes('No INSERT/UPDATE/DELETE for authenticated'))
})

test('the accept rpc is behind a button, not an effect', () => {
  const code = codeOnly(CARD_SRC)
  // The only call site is inside handleAccept, which is only referenced by onClick.
  const acceptIdx = code.indexOf("supabase.rpc(\n        'accept_new_contact_candidate'")
    + code.indexOf("'accept_new_contact_candidate'")
  assert.ok(acceptIdx > 0)
  const handler = code.slice(code.indexOf('async function handleAccept'),
    code.indexOf('async function handleDismiss'))
  assert.ok(handler.includes('accept_new_contact_candidate'),
    'the accept call must live in handleAccept')
  assert.ok(/onClick=\{handleAccept\}/.test(code), 'and be reached only by a click')
  // No useEffect may reference either write.
  for (const m of code.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)) {
    assert.ok(!/accept_new_contact_candidate|dismiss_new_contact_candidate/.test(m[1]),
      'no effect may write')
  }
})

test('a single-flight guard stops a double submission creating two contacts', () => {
  const code = codeOnly(CARD_SRC)
  const handler = code.slice(code.indexOf('async function handleAccept'),
    code.indexOf('async function handleDismiss'))
  assert.ok(/if \(busy\) return/.test(handler), 'accept must refuse while busy')
  assert.ok(/setBusy\(true\)/.test(handler))
  assert.ok(/disabled=\{busy\}/.test(code), 'and the button must be disabled')
})

test('the QUEUE only reads, and reads both tables', () => {
  const code = codeOnly(PAGE_SRC)
  assert.ok(code.includes("from('new_contact_candidates')"), 'the proposals must be listed')
  assert.ok(code.includes("from('interaction_candidates')"))
  assert.ok(code.includes('NCC_SELECT'))
  // Only pending rows, from both.
  assert.strictEqual([...code.matchAll(/\.eq\('status', 'pending'\)/g)].length, 2)
  // And no write of any kind on the page itself.
  for (const forbidden of ['.insert(', '.update(', '.upsert(', '.delete(',
    'accept_new_contact_candidate']) {
    assert.ok(!code.includes(forbidden), `the page must not ${forbidden}`)
  }
})

test('an empty interaction queue with a proposal waiting is NOT "all caught up"', () => {
  const code = codeOnly(PAGE_SRC)
  assert.ok(/const queueEmpty = items\.length === 0 && proposals\.length === 0/.test(code),
    'emptiness must span both queues')
  // AND neither queue may have anything past its own cursor. "All caught up" with
  // proposal 21 still in the database was the defect: the proposals queue had a bare
  // limit of 20 and no continuation at all, so draining the visible page ended the
  // review. Emptiness now requires both lists empty AND both cursors exhausted.
  assert.ok(/const anyMore = hasMore \|\| proposalsHaveMore/.test(code),
    'exhaustion must span both cursors')
  assert.ok(/status === 'ready' && queueEmpty && !anyMore/.test(code),
    'the "all caught up" state must be gated on both')
  assert.ok(!/items\.length === 0 && !hasMore/.test(code),
    'the old items-only emptiness test must be gone')
})

test('the proposals queue is keyset-paged, refilled, and single-flighted', () => {
  const code = codeOnly(PAGE_SRC)
  // Its OWN cursor, not a shared one: the two tables have independent id spaces.
  assert.ok(/proposalCursorRef/.test(code), 'the proposals queue needs its own cursor')
  assert.ok(/fetchProposals = useCallback\(async \(cursor\)/.test(code),
    'and the fetch must take one')
  assert.ok(/keysetFilter\(cursor\)/.test(code))
  // Reusing the existing helpers rather than a new pagination layer. Both queues are
  // ordered by the same pair, so the same keyset applies unchanged.
  assert.ok(/cursorFrom\(proposals\)/.test(code))
  assert.ok(/computeHasMore\(proposals\.length\)/.test(code))
  // A refill when the visible page drains but more remain.
  assert.ok(/proposals\.length === 0 && proposalsHaveMore/.test(code),
    'draining the visible proposals must pull the next page')
  // And a synchronous single-flight, so a refill and a Load more cannot race.
  assert.ok(/loadingProposalsRef/.test(code))
  // No bare limit without continuation anywhere in the proposals path.
  const fetchFn = code.slice(code.indexOf('const fetchProposals'),
    code.indexOf('const loadInitial'))
  assert.ok(/\.limit\(REVIEW_PAGE_SIZE\)/.test(fetchFn), 'still one bounded page at a time')
  assert.ok(/\.or\(filter\)/.test(fetchFn), 'with the keyset applied')
})

test('the page explains that nothing is saved until acceptance', () => {
  assert.ok(/Nothing is saved to your network until you\s*\n?\s*accept it/.test(PAGE_SRC)
    || /Nothing is saved to your network until you/.test(PAGE_SRC), 'the promise must be stated')
  assert.ok(/Dismissing a suggestion creates nothing/.test(PAGE_SRC))
})

test('analytics carry booleans and a controlled source, never content', () => {
  const code = codeOnly(CARD_SRC)
  const props = code.slice(code.indexOf('suggestionEventProps(candidate.source, {'),
    code.indexOf('window.dispatchEvent'))
  for (const leak of ['state.name', 'state.company', 'proposed_email', 'draft_summary',
    'state.interactionNotes', 'email']) {
    assert.ok(!props.includes(leak), `analytics must not carry ${leak}`)
  }
  assert.ok(props.includes('edited'))
  assert.ok(props.includes('proposed_contact: true'))
  assert.ok(props.includes('with_interaction'))
})

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('the source files are plain text, byte for byte')

test('NO RAW CONTROL BYTE is present in any file this slice added', () => {
  // REPRODUCED TWICE, including by this very test. src/lib/newContactReview.js was
  // written with a Unicode-escape character class over the control range, and the
  // editor materialized those escapes into three RAW CONTROL BYTES. The regex still worked - a literal control byte in a
  // character class matches itself - so every test passed while git reported the file
  // as binary and it appeared in no diff. Unreviewable code that passes its tests is
  // the worst of both, so the bytes are checked directly.
  //
  // And then THIS FILE did the same thing: the comment above originally spelled the
  // escape out, which materialized it here too, and this assertion caught its own
  // source. Hence the rule the fix encodes - describe such an escape, never write it.
  const FILES = [
    'src/lib/newContactReview.js',
    'src/components/NewContactSuggestionCard.jsx',
    'src/pages/SuggestionsPage.jsx',
    'supabase/functions/shared/outlookContentPass.js',
    'supabase/functions/shared/outlookContentStage.js',
    'supabase/functions/shared/outlookHandleProducer.js',
  ]
  for (const rel of FILES) {
    const buf = readFileSync(new URL(`../${rel}`, import.meta.url))
    const bad = []
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i]
      // Tab (9), LF (10) and CR (13) are legitimate; everything else below 32, plus
      // DEL (127), is not.
      if (b < 9 || (b >= 11 && b <= 12) || (b >= 14 && b <= 31) || b === 127) {
        bad.push([i, b])
      }
    }
    assert.deepStrictEqual(bad, [], `${rel} carries raw control bytes`)
  }
})

test('and the control-character check still rejects every control character', () => {
  // The point of building CONTROL_RE from char codes is that it behaves identically.
  for (const cc of [0, 9, 10, 13, 27, 31, 127]) {
    const r = validateProposal({
      name: 'A' + String.fromCharCode(cc) + 'B', createInteraction: false,
    })
    assert.strictEqual(r.ok, false, `char code ${cc} was accepted`)
    assert.strictEqual(r.code, 'invalid_name')
  }
  // Every field that uses it, not only the name.
  for (const field of ['company', 'role', 'howMet', 'relationshipNote']) {
    const r = validateProposal({
      name: 'Ok', createInteraction: false,
      [field]: 'A' + String.fromCharCode(0) + 'B',
    })
    assert.strictEqual(r.ok, false, `${field} accepted a NUL`)
  }
  assert.deepStrictEqual(
    validateProposal({ name: 'Priya Nair-Shah', createInteraction: false }), { ok: true })
})

await Promise.all(pending)
console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
