// Paste an email - company/role attribution when the quoted evidence OMITS the person's name.
//
// Run with: node tests/paste-email-adjacent-signature.test.js
//
// Reproduces one possible cause of the 2026-10-14 live Elena Ruiz result (the cause of that
// specific request is NOT verified - its model output was never recorded): the model quotes only
//   "Senior Consultant, Brightline Advisory"
// from a signature where that line sits directly beneath "Elena Ruiz". The quote does not name
// her, so the attribution check left company and role blank.
//
// The rule under test resolves such a quote from BOUNDED ADJACENT SOURCE LINES only:
//   * the quote must equal whole source lines exactly;
//   * look upward through the same contiguous block (a blank line ends it), with the quote and
//     the lines above it together at most EVIDENCE_MAX_LINES;
//   * the first line above that names a proposed person decides, and it must BEGIN with this
//     person's full name (a signature name line), not merely mention them;
//   * a line naming any other proposed person first means the detail is not this person's;
//   * when the quoted lines occur more than once, every occurrence must resolve to this person.
// Anything else stays blank for the reviewer.

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { validateContactFields, handlePasteEmail, buildContactRequest, contactFieldsSchema } from '../supabase/functions/shared/pasteEmail.js'
import { SYSTEM_CONTRACT } from '../supabase/functions/shared/outlookDraftContract.js'

const NL = String.fromCharCode(10)
const TITLE = 'Senior Consultant, Brightline Advisory'
const ELENA_EMAIL = [
  'From: Elena Ruiz <elena.ruiz@example.com>', 'To: You <you@example.org>', 'Date: Wed, 14 Oct 2026 10:15:00 -0400',
  'Subject: Great meeting you', '', 'Hi,', '',
  "It was great meeting you at the alumni panel yesterday. As promised, I'll send you the case-study prep guide by Friday, and I'm happy to do a mock interview with you before the end of the month. Could you send me your resume first?",
  '', 'Best,', 'Elena Ruiz', TITLE,
].join(NL)

const person = (name, over = {}) => ({ name, company: null, company_evidence: null, role: null, role_evidence: null, how_met: null, linkedin_url: null, linkedin_evidence: null, ...over })
const titleOnly = (name, company, role, quote) => person(name, { company, company_evidence: quote, role, role_evidence: quote })
const check = (people, text) => validateContactFields({ people }, text)
const fieldsOf = (v, i = 0) => [v.people[i].fields.company ?? null, v.people[i].fields.role ?? null]

// ── the live case ────────────────────────────────────────────────────────────

test('REPRODUCTION: a title-only quote directly beneath "Elena Ruiz" fills her company and role', async () => {
  const r = await handlePasteEmail({ text: ELENA_EMAIL }, {
    loadEntitlement: async () => ({ canUse: true }),
    callModel: async (b) => b.system === SYSTEM_CONTRACT
      ? { ok: true, parsed: { result: 'interaction_draft', summary: 'Elena offered a prep guide.', summary_evidence: 'explicit_body', follow_up: null, interaction_date: null } }
      : { ok: true, parsed: { people: [titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE)] } },
    log: () => {}, now: () => new Date('2026-10-14T16:00:00Z'),
  })
  const e = r.json.contact.people[0]
  assert.deepEqual([e.fields.company, e.fields.role], ['Brightline Advisory', 'Senior Consultant'], JSON.stringify(e))
  assert.deepEqual(e.dropped, [])
})

test('a quote that includes her name line keeps working exactly as before', () => {
  const v = check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', 'Elena Ruiz' + NL + TITLE)], ELENA_EMAIL)
  assert.deepEqual(fieldsOf(v), ['Brightline Advisory', 'Senior Consultant'])
})

test('quoted signatures (reply history with ">") resolve the same way', () => {
  const text = ['Thanks!', '', '> Best,', '> Elena Ruiz', '> ' + TITLE].join(NL)
  assert.deepEqual(fieldsOf(check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE)], text)), ['Brightline Advisory', 'Senior Consultant'])
  assert.deepEqual(fieldsOf(check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', '> ' + TITLE)], text)), ['Brightline Advisory', 'Senior Consultant'])
})

test('the same signature repeated in quoted history still resolves to her', () => {
  const text = [['Best,', 'Elena Ruiz', TITLE].join(NL), '', '> Best,', '> Elena Ruiz', '> ' + TITLE].join(NL)
  assert.deepEqual(fieldsOf(check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE)], text)), ['Brightline Advisory', 'Senior Consultant'])
})

// ── another person nearby ────────────────────────────────────────────────────

test("a title beneath ANOTHER proposed person's name is theirs, not hers", () => {
  const text = ['Best,', 'Sam Lee', TITLE].join(NL)
  const v = check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE), person('Sam Lee')], text + NL + 'Elena Ruiz')
  assert.deepEqual(fieldsOf(v, 0), [null, null])
  assert.equal(v.people[0].dropped.company, 'adjacent_name_is_another_person')
  const forSam = check([person('Elena Ruiz'), titleOnly('Sam Lee', 'Brightline Advisory', 'Senior Consultant', TITLE)], text + NL + 'Elena Ruiz')
  assert.deepEqual(fieldsOf(forSam, 1), ['Brightline Advisory', 'Senior Consultant'])
})

test('another proposed name between her name and the title blocks it', () => {
  const text = ['Elena Ruiz', 'Sam Lee', TITLE].join(NL)
  const v = check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE), person('Sam Lee')], text)
  assert.deepEqual(fieldsOf(v, 0), [null, null])
})

test('the same title under two different people cannot be placed from a title-only quote', () => {
  const text = ['Elena Ruiz', TITLE, '', 'Sam Lee', TITLE].join(NL)
  const v = check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE), person('Sam Lee')], text)
  assert.deepEqual(fieldsOf(v, 0), [null, null])
  // Quoting the name line, as the prompt asks, resolves both.
  const named = check([
    titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', 'Elena Ruiz' + NL + TITLE),
    titleOnly('Sam Lee', 'Brightline Advisory', 'Senior Consultant', 'Sam Lee' + NL + TITLE),
  ], text)
  assert.deepEqual([fieldsOf(named, 0), fieldsOf(named, 1)], [['Brightline Advisory', 'Senior Consultant'], ['Brightline Advisory', 'Senior Consultant']])
})

// ── not "any title near any name" ────────────────────────────────────────────

test('a title under someone who is not her (here, the user) stays blank', () => {
  const text = ['Elena Ruiz wrote:', '> thanks', '', 'Best,', 'Me Student', 'Treasurer, Finance Club'].join(NL)
  const v = check([titleOnly('Elena Ruiz', 'Finance Club', 'Treasurer', 'Treasurer, Finance Club')], text)
  assert.deepEqual(fieldsOf(v), [null, null])
  assert.equal(v.people[0].dropped.company, 'evidence_does_not_name_person')
})

test('a blank line between her name and the title ends the block', () => {
  const v = check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE)], ['Elena Ruiz', '', TITLE].join(NL))
  assert.deepEqual(fieldsOf(v), [null, null])
})

test('a sentence that merely mentions her is not a signature name line', () => {
  const v = check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE)], ['Thanks for introducing me to Elena Ruiz', TITLE].join(NL))
  assert.deepEqual(fieldsOf(v), [null, null])
})

test('the lookback is bounded: her name more than four lines up does not count', () => {
  const v = check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE)], ['Elena Ruiz', 'Line two', 'Line three', 'Line four', TITLE].join(NL))
  assert.deepEqual(fieldsOf(v), [null, null])
  const within = check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE)], ['Elena Ruiz', 'PhD', 'Office of Strategy', TITLE].join(NL))
  assert.deepEqual(fieldsOf(within), ['Brightline Advisory', 'Senior Consultant'])
})

test('the quote must be whole source lines, exactly as written', () => {
  // A fragment of a line cannot borrow a name from the line above.
  const frag = check([titleOnly('Elena Ruiz', 'Brightline Advisory', null, 'Brightline Advisory')], ELENA_EMAIL)
  assert.deepEqual(fieldsOf(frag), [null, null])
  // A paraphrase is not in the source at all.
  const para = check([titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', 'Senior Consultant at Brightline Advisory')], ELENA_EMAIL)
  assert.equal(para.people[0].dropped.company, 'evidence_not_in_text')
})

// ── shared employers and same-name participants ─────────────────────────────

test('a shared employer is kept for both when each title sits under their own name', () => {
  const text = ['Elena Ruiz', TITLE, '', 'Jamie Fox', 'Analyst, Brightline Advisory'].join(NL)
  const v = check([
    titleOnly('Elena Ruiz', 'Brightline Advisory', 'Senior Consultant', TITLE),
    titleOnly('Jamie Fox', 'Brightline Advisory', 'Analyst', 'Analyst, Brightline Advisory'),
  ], text)
  assert.deepEqual([fieldsOf(v, 0), fieldsOf(v, 1)], [['Brightline Advisory', 'Senior Consultant'], ['Brightline Advisory', 'Analyst']])
})

test('same-name participants: each keeps the title under their own block, and stays flagged', () => {
  const text = ['Alex Kim', 'Associate, Goldman Sachs', '', 'Alex Kim', 'Partner, Kestrel Partners'].join(NL)
  const v = check([
    titleOnly('Alex Kim', 'Goldman Sachs', 'Associate', 'Associate, Goldman Sachs'),
    titleOnly('Alex Kim', 'Kestrel Partners', 'Partner', 'Partner, Kestrel Partners'),
  ], text)
  assert.deepEqual([fieldsOf(v, 0), fieldsOf(v, 1)], [['Goldman Sachs', 'Associate'], ['Kestrel Partners', 'Partner']])
  assert.deepEqual(v.people.map((p) => p.ambiguousName), [true, true])
  // The SAME quote cited for both records still tells them apart for neither.
  const same = check([
    titleOnly('Alex Kim', 'Goldman Sachs', 'Associate', 'Associate, Goldman Sachs'),
    titleOnly('Alex Kim', 'Goldman Sachs', 'Associate', 'Associate, Goldman Sachs'),
  ], text)
  assert.deepEqual(same.people.map((p) => p.dropped.company), ['evidence_shared', 'evidence_shared'])
})

// ── the prompt asks for the name line with the signature lines ───────────────

test('the request asks for evidence INCLUDING the name line, for signatures the lines beneath it', () => {
  const content = buildContactRequest('x').messages[0].content
  assert.ok(content.includes("lines that state it INCLUDING the line with this person's name - for a signature, the name line"))
  assert.ok(content.includes('together with the title and company lines beneath it; for a sentence, the whole sentence.'))
  assert.ok(content.includes('Text elsewhere in the email is not evidence.'))
  const item = contactFieldsSchema().properties.people.items
  for (const k of ['company_evidence', 'role_evidence', 'linkedin_evidence']) {
    assert.ok(item.properties[k].description.includes("INCLUDING the line with this person's name: for a signature, the name line and the title or company lines beneath it"), k)
  }
})
