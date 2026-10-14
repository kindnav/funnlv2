// Contacts - the optional School field, end to end in code.
//
// Run with: node tests/contact-school.test.js
//
// One nullable `school` column on contacts, shown and edited like company and role, searchable,
// a sortable table column, mappable from a CSV, extracted by AI Fill and Paste email (Paste email
// with the same evidence rules as company and role), and visible to Funnl AI chat.

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { searchDirectory } from '../src/lib/contactDirectoryUtils.js'
import { buildInitialAssignment, HEADER_MAP, normalizeHeader } from '../src/lib/csvHeaderDetect.js'
import { applyPerson, buildContactPayload } from '../src/lib/pasteEmailCapture.js'
import { validateContactFields, contactFieldsSchema, AI_FILL_INSTRUCTIONS, SCHOOL_MAX } from '../supabase/functions/shared/pasteEmail.js'
import { formatNetworkContext } from '../supabase/functions/ai-chat/helpers.js'

const NL = String.fromCharCode(10)
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')

// ── the column ────────────────────────────────────────────────────────────────

test('the migration adds one nullable text column and nothing else', () => {
  const sql = read('../supabase/migrations/20261015000000_add_contact_school.sql')
  const statements = sql.split('\n').filter((l) => !l.startsWith('--') && l.trim()).join(' ')
  assert.ok(statements.includes('ALTER TABLE public.contacts ADD COLUMN school text;'))
  for (const bad of ['DROP', 'DEFAULT', 'NOT NULL', 'UPDATE ', 'DELETE', 'POLICY', 'GRANT', 'REVOKE']) {
    assert.equal(statements.toUpperCase().includes(bad), false, bad)
  }
})

// ── where it shows ────────────────────────────────────────────────────────────

test('the contact form edits it, saves it trimmed or null, and AI Fill can fill it', () => {
  const src = read('../src/components/AddContactDrawer.jsx')
  assert.ok(src.includes("useState(contact?.school              ?? '')"))
  assert.ok(src.includes('school:            school.trim() || null,'))
  assert.ok(src.includes("if (parsed.school)            { setSchool(parsed.school);                      filled.add('school') }"))
  assert.ok(src.includes('<label className={lCls}>School</label>'))
})

test('the contact page shows it, and the table has a sortable School column', () => {
  const detail = read('../src/pages/ContactDetailPage.jsx')
  assert.ok(detail.includes('<p className="text-[11.5px] text-low mb-0.5">School</p>'))
  assert.ok(detail.includes('contact.how_met || contact.school ||'))
  const page = read('../src/pages/ContactsPage.jsx')
  assert.ok(page.includes("{ key: 'school',            label: 'School',       sortable: true },"))
  assert.ok(page.includes('{entry.school || <span className="text-lower">—</span>}'))
})

test('search finds contacts by school, case-insensitively', () => {
  const entries = [{ name: 'Priya Shah', school: 'Indiana University' }, { name: 'Sam Lee', school: 'Purdue University' }, { name: 'Jo Kim' }]
  assert.deepEqual(searchDirectory(entries, 'indiana').map((e) => e.name), ['Priya Shah'])
  assert.deepEqual(searchDirectory(entries, 'UNIVERSITY').map((e) => e.name), ['Priya Shah', 'Sam Lee'])
})

// ── CSV import ────────────────────────────────────────────────────────────────

test('CSV headers like School, University, College and Alma Mater map to School', () => {
  for (const h of ['School', 'school_name', 'University', 'College', 'College Name', 'Alma Mater']) {
    assert.equal(HEADER_MAP[normalizeHeader(h)], 'school', h)
  }
  assert.equal(HEADER_MAP[normalizeHeader('Education')], undefined, '"Education" often holds a degree; not mapped')
  const a = buildInitialAssignment(['Name', 'Company', 'University'])
  assert.deepEqual(a.school, ['University'])
})

test('the import screen offers School and maps the same aliases; the AI column-mapper is unchanged', () => {
  const modal = read('../src/components/ImportContactsModal.jsx')
  assert.ok(modal.includes("{ value: 'school',            label: 'School' },"))
  for (const alias of ["'school': 'school'", "'university': 'school'", "'college': 'school'", "'alma mater': 'school'"]) assert.ok(modal.includes(alias), alias)
  assert.ok(modal.includes('how_met: [], school: [], tags: []'))
  assert.equal(read('../supabase/functions/ai-map-csv/index.ts').includes("'school'"), false)
})

// ── AI Fill and Paste email ───────────────────────────────────────────────────

test('AI Fill asks for a school, and Paste email carries the identical instruction', () => {
  const line = '- school (string) — the school, college or university they attend or attended'
  assert.ok(read('../supabase/functions/ai-parse-contact/index.ts').includes(line))
  assert.ok(AI_FILL_INSTRUCTIONS.includes(line))
})

test('Paste email asks for school with its own evidence, like company and role', () => {
  const item = contactFieldsSchema().properties.people.items
  assert.ok(item.properties.school && item.properties.school_evidence)
  assert.ok(item.properties.school_evidence.description.includes("INCLUDING the line with this person's name"))
})

const SIG = ['Best,', 'Ravi Patel', 'MBA Candidate, Kelley School of Business', 'Indiana University'].join(NL)

test('a school stated in the person’s signature is kept, with or without the name line quoted', () => {
  const named = validateContactFields({ people: [{ name: 'Ravi Patel', school: 'Indiana University', school_evidence: 'Ravi Patel' + NL + 'MBA Candidate, Kelley School of Business' + NL + 'Indiana University' }] }, SIG)
  assert.equal(named.people[0].fields.school, 'Indiana University')
  const adjacent = validateContactFields({ people: [{ name: 'Ravi Patel', school: 'Indiana University', school_evidence: 'Indiana University' }] }, SIG)
  assert.equal(adjacent.people[0].fields.school, 'Indiana University')
})

test('a school without evidence for THAT person stays blank', () => {
  const text = SIG + NL + NL + 'Sam Lee' + NL + 'Purdue University'
  const none = validateContactFields({ people: [{ name: 'Ravi Patel', school: 'Purdue University' }, { name: 'Sam Lee' }] }, text)
  assert.equal(none.people[0].dropped.school, 'no_evidence')
  const swapped = validateContactFields({ people: [{ name: 'Ravi Patel', school: 'Purdue University', school_evidence: 'Purdue University' }, { name: 'Sam Lee' }] }, text)
  assert.equal(swapped.people[0].fields.school, undefined)
  assert.equal(swapped.people[0].dropped.school, 'adjacent_name_is_another_person')
  const long = validateContactFields({ people: [{ name: 'Ravi Patel', school: 'x'.repeat(SCHOOL_MAX + 1) }] }, SIG)
  assert.equal(long.people[0].dropped.school, 'too_long')
})

test('picking the person fills School in the review form, and the save carries it', () => {
  const draft = applyPerson({ email: '' }, { fields: { name: 'Ravi Patel', school: 'Indiana University' } })
  assert.equal(draft.school, 'Indiana University')
  assert.equal(applyPerson(draft, null).school, '')
  assert.equal(buildContactPayload({ name: 'Ravi Patel', school: '  Indiana University ' }).school, 'Indiana University')
  assert.equal(buildContactPayload({ name: 'Ravi Patel' }).school, null)
  assert.ok(read('../src/components/PasteEmailDrawer.jsx').includes('<label htmlFor="paste-email-school" className={labelClass}>School</label>'))
})

// ── Funnl AI chat ─────────────────────────────────────────────────────────────

test('Funnl AI chat loads the school and includes it in the network context', () => {
  assert.ok(read('../supabase/functions/ai-chat/index.ts').includes(".select('id, name, company, role, school, how_met,"))
  const ctx = formatNetworkContext([{ id: 'c1', name: 'Priya Shah', company: 'Goldman Sachs', role: 'Analyst', school: 'Indiana University' }], [], '2026-10-14')
  assert.ok(ctx.context.includes('School: Indiana University'), ctx.context)
  const none = formatNetworkContext([{ id: 'c2', name: 'Jo Kim' }], [], '2026-10-14')
  assert.equal(none.context.includes('School:'), false)
})
