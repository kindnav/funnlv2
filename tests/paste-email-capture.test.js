// Paste an email (Pro) - browser-side decisions (src/lib/pasteEmailCapture.js), the drawer,
// its Pro-only entry points and the published privacy wording.
//
// Run with: node tests/paste-email-capture.test.js
//
// Covers: attribution is never assumed (ambiguous participants, a single exact match, a
// preselected contact whose address is absent), dates are prefilled only when clear,
// save-retry reuses the created contact and never makes a second one, double submission is
// blocked, the status says what was and was not saved, and the raw paste is cleared.

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import {
  requestPasteDraft, matchAddressesToContacts, initialAttribution, resolveInteractionDate,
  buildContactPayload, reviewErrors, createPasteSaver, messageForSave, messageForPasteCode,
  personOptions, applyPerson, draftNotices,
} from '../src/lib/pasteEmailCapture.js'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')

const CONTACTS = [
  { id: 'c1', name: 'Priya Shah', email: 'Priya.Shah@goldman.example' },
  { id: 'c2', name: 'Sam Lee', email: 'sam@club.example' },
  { id: 'c3', name: 'Sam Lee (old)', email: 'SAM@club.example' },
  { id: 'c4', name: 'No Email' },
]
const FOUND = [
  { address: 'me@school.edu', inHeader: true },
  { address: 'priya.shah@goldman.example', inHeader: true },
  { address: 'sam@club.example', inHeader: true },
]
const DATE_OK = '2026-10-13'
const NEW_DRAFT = { name: 'Priya Shah', company: 'Goldman', email: 'priya.shah@goldman.example', linkedin_url: 'linkedin.com/in/priya' }

// ── Attribution ────────────────────────────────────────────────────────────────

test('matching is case-insensitive and lists every contact sharing an address', () => {
  const m = matchAddressesToContacts(FOUND, CONTACTS)
  assert.deepEqual(m.map((x) => x.matches.map((c) => c.id)), [[], ['c1'], ['c2', 'c3']])
})

test('ambiguous participants: nothing is chosen, confirmation required', () => {
  const a = initialAttribution({ addresses: FOUND, contacts: CONTACTS })
  assert.equal(a.person, null)
  assert.equal(a.requireConfirmation, true)
  assert.equal(a.candidates.length, 3)
})

test('even a single exact match is only a suggestion, never preselected', () => {
  const a = initialAttribution({ addresses: [{ address: 'priya.shah@goldman.example', inHeader: true }], contacts: CONTACTS })
  assert.equal(a.person, null)
  assert.equal(a.requireConfirmation, true)
})

test('the login address is not treated as identity: nothing about "me" is special', () => {
  const a = initialAttribution({ addresses: [{ address: 'me@school.edu', inHeader: true }], contacts: CONTACTS })
  assert.equal(a.person, null)
  assert.deepEqual(a.candidates[0].matches, [])
})

test('capture from a contact page uses that contact, and warns if their address is absent', () => {
  const ok = initialAttribution({ preselectedContactId: 'c1', addresses: FOUND, contacts: CONTACTS })
  assert.deepEqual(ok.person, { kind: 'existing', contactId: 'c1' })
  assert.equal(ok.requireConfirmation, false)
  assert.equal(ok.warning, null)
  const absent = initialAttribution({ preselectedContactId: 'c2', addresses: [FOUND[1]], contacts: CONTACTS })
  assert.equal(absent.warning, 'preselected_not_in_paste')
  assert.deepEqual(absent.person, { kind: 'existing', contactId: 'c2' })
  assert.equal(initialAttribution({ preselectedContactId: 'c2', addresses: [], contacts: CONTACTS }).warning, null)
})

// ── Choosing which proposed person a new contact is ───────────────────────────

const PROPOSED = { people: [
  { fields: { name: 'Priya Shah', company: 'Goldman Sachs', role: 'Analyst' }, dropped: [], ambiguous_name: false },
  { fields: { name: 'Sam Lee', company: 'Finance Club', role: 'Treasurer' }, dropped: [], ambiguous_name: false },
] }

test('people are offered by name, nothing preselected', () => {
  assert.deepEqual(personOptions(PROPOSED), [
    { index: 0, name: 'Priya Shah', label: 'Priya Shah', ambiguous: false },
    { index: 1, name: 'Sam Lee', label: 'Sam Lee', ambiguous: false },
  ])
  assert.deepEqual(personOptions(null), [])
  assert.deepEqual(personOptions({ people: [{ fields: {} }] }), [])
})

test('identical display names are both offered, labelled apart, and marked ambiguous', () => {
  const opts = personOptions({ people: [
    { fields: { name: 'Alex Kim', company: 'Goldman Sachs', role: 'Associate' }, ambiguous_name: true },
    { fields: { name: 'Alex Kim' }, ambiguous_name: true },
    { fields: { name: 'Jamie Fox', company: 'Goldman Sachs' }, ambiguous_name: false },
  ] })
  assert.deepEqual(opts.map((o) => o.label), ['Alex Kim (Goldman Sachs, Associate; 1 of 2)', 'Alex Kim (no details; 2 of 2)', 'Jamie Fox'])
  assert.deepEqual(opts.map((o) => o.ambiguous), [true, true, false])
})

test('picking a person fills ONLY that person\u2019s details; switching replaces them all', () => {
  const start = { name: '', email: 'sam@club.example', company: '', role: '', how_met: '', linkedin_url: '', tags: [], relationship_note: '' }
  const priya = applyPerson(start, PROPOSED.people[0])
  assert.deepEqual([priya.name, priya.company, priya.role], ['Priya Shah', 'Goldman Sachs', 'Analyst'])
  const sam = applyPerson(priya, PROPOSED.people[1])
  assert.deepEqual([sam.name, sam.company, sam.role], ['Sam Lee', 'Finance Club', 'Treasurer'])
  // fields the review step never shows are never filled in from the model
  const hidden = applyPerson(start, { fields: { name: 'X Y', tags: ['t'], relationship_note: 'n' } })
  assert.deepEqual([hidden.tags, hidden.relationship_note], [[], ''])
  assert.equal(sam.email, 'sam@club.example')
  const cleared = applyPerson(sam, null)
  assert.deepEqual([cleared.name, cleared.company, cleared.role], ['', '', ''])
})

test('a field the server left blank stays blank after picking that person', () => {
  const d = applyPerson({ company: 'typed earlier' }, { fields: { name: 'Priya Shah' } })
  assert.equal(d.company, '')
})

test('a partial draft is never silent', () => {
  assert.deepEqual(draftNotices({ note_code: 'ok', contact_code: 'ok' }), [])
  assert.equal(draftNotices({ note_code: 'note_provider_error', contact_code: 'ok' }).length, 1)
  assert.match(draftNotices({ note_code: 'note_defer', contact_code: 'ok' })[0], /did not find a conversation/)
  assert.match(draftNotices({ note_code: 'ok', contact_code: 'contact_no_people' })[0], /could not identify/)
})

// ── Dates ──────────────────────────────────────────────────────────────────────

test('a clear calendar date is prefilled as written', () => {
  assert.equal(resolveInteractionDate({ status: 'clear', kind: 'date', value: DATE_OK }, 'Asia/Tokyo').value, DATE_OK)
})

test('a clear instant becomes the reviewer’s own local day', () => {
  const d = { status: 'clear', kind: 'instant', value: '2026-10-14T02:30:00.000Z' }
  assert.equal(resolveInteractionDate(d, 'America/New_York').value, '2026-10-13')
  assert.equal(resolveInteractionDate(d, 'Asia/Tokyo').value, '2026-10-14')
  assert.equal(resolveInteractionDate(d, 'Not/AZone').value, '')
})

test('ambiguous or missing dates stay blank with a reason', () => {
  for (const reason of ['multiple_dates', 'quoted_history', 'no_timezone', 'numeric_format', 'invalid_date', 'unrecognised']) {
    const r = resolveInteractionDate({ status: 'ambiguous', reason }, 'UTC')
    assert.equal(r.value, '')
    assert.ok(r.note.length > 0)
  }
  assert.equal(resolveInteractionDate({ status: 'none' }, 'UTC').value, '')
  assert.equal(resolveInteractionDate({ status: 'clear', kind: 'date', value: '13/10/2026' }, 'UTC').value, '')
  assert.equal(resolveInteractionDate(undefined, 'UTC').value, '')
})

// ── Review and payloads ────────────────────────────────────────────────────────

test('review requires a person, a new contact name and a date', () => {
  assert.ok(reviewErrors({ person: null, contactDraft: {}, interaction: { date: DATE_OK } }).length === 1)
  assert.ok(reviewErrors({ person: { kind: 'new' }, contactDraft: { name: ' ' }, interaction: { date: DATE_OK } }).length === 1)
  assert.ok(reviewErrors({ person: { kind: 'existing', contactId: 'c1' }, contactDraft: {}, interaction: { date: '' } }).length === 1)
  assert.deepEqual(reviewErrors({ person: { kind: 'existing', contactId: 'c1' }, contactDraft: {}, interaction: { date: DATE_OK, notes: 'x' } }), [])
})

test('contact payload has AddContactDrawer’s shape and never sets a relationship type', () => {
  const p = buildContactPayload({ ...NEW_DRAFT, tags: ['finance', ' '], relationship_note: '' })
  assert.deepEqual(p, { name: 'Priya Shah', company: 'Goldman', role: null, school: null, how_met: null, email: 'priya.shah@goldman.example', linkedin_url: 'https://linkedin.com/in/priya', tags: ['finance'], relationship_type: null, relationship_note: null })
})

// ── Saving and retries ─────────────────────────────────────────────────────────

function fakeDb ({ contactFails = 0, interactionFails = 0, delay = 0 } = {}) {
  const db = { contacts: [], interactions: [] }
  const wait = () => new Promise((r) => setTimeout(r, delay))
  return {
    db,
    insertContact: async (payload) => {
      await wait()
      if (contactFails > 0) { contactFails--; return { error: true } }
      const id = `new${db.contacts.length + 1}`
      db.contacts.push({ id, ...payload })
      return { id }
    },
    insertInteraction: async (payload) => {
      await wait()
      if (interactionFails > 0) { interactionFails--; return { error: true } }
      db.interactions.push(payload)
      return { ok: true }
    },
  }
}
const NEW_REVIEW = { person: { kind: 'new' }, contactDraft: NEW_DRAFT, interaction: { date: DATE_OK, notes: ' Coffee chat. ', followUpDate: '' } }

test('new contact + interaction save together', async () => {
  const f = fakeDb()
  const s = createPasteSaver(f)
  const r = await s.save(NEW_REVIEW)
  assert.equal(r.status, 'saved')
  assert.equal(f.db.contacts.length, 1)
  assert.deepEqual(f.db.interactions, [{ contact_id: 'new1', type: 'Email', interaction_date: DATE_OK, notes: 'Coffee chat.', follow_up_date: null }])
  assert.match(messageForSave(r), /new contact and the interaction/)
})

test('partial save: contact kept, interaction failed; retry reuses the SAME contact', async () => {
  const f = fakeDb({ interactionFails: 2 })
  const s = createPasteSaver(f)
  const r1 = await s.save(NEW_REVIEW)
  assert.equal(r1.status, 'interaction_failed')
  assert.equal(r1.contactSaved, true)
  assert.equal(r1.interactionSaved, false)
  assert.match(messageForSave(r1), /contact was saved, but the interaction was not/)
  assert.match(messageForSave(r1), /another contact will not be created/)

  const r2 = await s.save(NEW_REVIEW)
  assert.equal(r2.status, 'interaction_failed')
  const r3 = await s.save(NEW_REVIEW)
  assert.equal(r3.status, 'saved')
  assert.equal(f.db.contacts.length, 1)
  assert.deepEqual(f.db.interactions.map((i) => i.contact_id), ['new1'])
  assert.equal((await s.save(NEW_REVIEW)).status, 'already_saved')
  assert.equal(f.db.interactions.length, 1)
})

test('after a contact is created, a changed person choice cannot redirect or duplicate it', async () => {
  const f = fakeDb({ interactionFails: 1 })
  const s = createPasteSaver(f)
  await s.save(NEW_REVIEW)
  const r = await s.save({ ...NEW_REVIEW, person: { kind: 'existing', contactId: 'c2' } })
  assert.equal(r.status, 'saved')
  assert.equal(f.db.contacts.length, 1)
  assert.equal(f.db.interactions[0].contact_id, 'new1')
})

test('a failed contact insert saves nothing and can be retried', async () => {
  const f = fakeDb({ contactFails: 1 })
  const s = createPasteSaver(f)
  const r1 = await s.save(NEW_REVIEW)
  assert.equal(r1.status, 'contact_failed')
  assert.equal(r1.contactSaved, false)
  assert.equal(f.db.interactions.length, 0)
  assert.match(messageForSave(r1), /contact was not saved, so the interaction was not saved either/)
  assert.equal((await s.save(NEW_REVIEW)).status, 'saved')
  assert.equal(f.db.contacts.length, 1)
})

test('a thrown insert is reported, not swallowed into success', async () => {
  const s = createPasteSaver({ insertContact: async () => { throw new Error('x') }, insertInteraction: async () => ({ ok: true }) })
  assert.equal((await s.save(NEW_REVIEW)).status, 'contact_failed')
})

test('double submission: a second Save while one is in flight touches nothing', async () => {
  const f = fakeDb({ delay: 10 })
  const s = createPasteSaver(f)
  const [a, b] = await Promise.all([s.save(NEW_REVIEW), s.save(NEW_REVIEW)])
  assert.deepEqual([a.status, b.status].sort(), ['busy', 'saved'])
  assert.equal(f.db.contacts.length, 1)
  assert.equal(f.db.interactions.length, 1)
})

test('an existing contact is never inserted or edited; only the interaction is written', async () => {
  let contactCalls = 0
  const f = fakeDb()
  const s = createPasteSaver({ ...f, insertContact: async (p) => { contactCalls++; return f.insertContact(p) } })
  const r = await s.save({ person: { kind: 'existing', contactId: 'c1' }, contactDraft: NEW_DRAFT, interaction: { date: DATE_OK, notes: '', followUpDate: '2026-10-20' } })
  assert.equal(r.status, 'saved')
  assert.equal(r.contactSaved, false)
  assert.equal(contactCalls, 0)
  assert.deepEqual(f.db.interactions, [{ contact_id: 'c1', type: 'Email', interaction_date: DATE_OK, notes: null, follow_up_date: '2026-10-20' }])
  assert.equal(messageForSave(r), 'Saved: the interaction.')
})

test('an incomplete review is refused before any write', async () => {
  const f = fakeDb()
  const s = createPasteSaver(f)
  assert.equal((await s.save({ ...NEW_REVIEW, person: null })).status, 'invalid')
  assert.equal((await s.save({ ...NEW_REVIEW, interaction: { date: '' } })).status, 'invalid')
  assert.equal(f.db.contacts.length + f.db.interactions.length, 0)
})

// ── Calling the function ───────────────────────────────────────────────────────

test('requestPasteDraft returns only codes on failure', async () => {
  const errClient = { functions: { invoke: async () => ({ error: { context: { json: async () => ({ code: 'pro_required' }) } } }) } }
  assert.deepEqual(await requestPasteDraft(errClient, 'x'), { ok: false, code: 'pro_required' })
  const throwClient = { functions: { invoke: async () => { throw new Error('offline') } } }
  assert.deepEqual(await requestPasteDraft(throwClient, 'x'), { ok: false, code: 'network' })
  const okClient = { functions: { invoke: async (name, { body }) => ({ data: { code: 'ok', echo: name, got: typeof body.text } }) } }
  assert.equal((await requestPasteDraft(okClient, 'x')).data.echo, 'ai-paste-email')
  assert.match(messageForPasteCode('minimization_refused'), /access token/)
  assert.match(messageForPasteCode('pro_required'), /Pro/)
})

// ── The drawer and its entry points ────────────────────────────────────────────

test('drawer: explanation and privacy link appear before submission', () => {
  const src = read('../src/components/PasteEmailDrawer.jsx')
  const explain = src.indexOf('data-testid="paste-email-explanation"')
  assert.ok(explain > 0 && explain < src.indexOf('Draft from email'))
  assert.ok(src.includes('sends the email you paste to Anthropic'))
  assert.ok(src.includes('<Link to="/privacy"'))
})

test('drawer: the raw paste is cleared on cancel, Escape and successful save, and never persisted', () => {
  const src = read('../src/components/PasteEmailDrawer.jsx')
  const cancel = src.slice(src.indexOf('function cancel'), src.indexOf('function cancel') + 120)
  assert.ok(cancel.includes("setText('')"))
  assert.ok(src.includes("if (e.key === 'Escape' && !saving) { setText('')"))
  const save = src.slice(src.indexOf('async function save'), src.indexOf('const locked'))
  assert.ok(/status === 'saved'[^]*setText\(''\)/.test(save))
  for (const bad of ['localStorage', 'sessionStorage', 'console.', 'track(\'paste']) assert.equal(src.includes(bad), false, bad)
})

test('drawer: Save is disabled while saving; AI fields fill a NEW contact only from the picked person', () => {
  const src = read('../src/components/PasteEmailDrawer.jsx')
  assert.ok(src.includes('disabled={saving || errors.length > 0}'))
  const choose = src.slice(src.indexOf('function choose'), src.indexOf('function chooseAiPerson'))
  assert.equal(choose.includes('applyPerson'), false)
  assert.ok(choose.includes('createdContactId) return'))
  const pick = src.slice(src.indexOf('function chooseAiPerson'), src.indexOf('async function save'))
  assert.ok(pick.includes('applyPerson(cur, picked)'))
  assert.ok(src.includes("person?.kind === 'new' && !preselectedContact"))
})

test('drawer: the paste and the note are never silently truncated', () => {
  const src = read('../src/components/PasteEmailDrawer.jsx')
  assert.equal(src.includes('.slice(0, MAX_PASTE_CHARS)'), false)
  assert.equal(/maxLength=/.test(src), false)
  assert.ok(src.includes('disabled={drafting || !text.trim() || overLimit}'))
})

test('drawer: a failed draft keeps the paste for retry; Back returns to it before any save', () => {
  const src = read('../src/components/PasteEmailDrawer.jsx')
  const draft = src.slice(src.indexOf('async function draft'), src.indexOf('const d = r.data'))
  assert.ok(draft.includes("if (!r.ok) { setError(messageForPasteCode(r.code)); return }"))
  assert.equal(draft.includes("setText('')"), false)
  const back = src.slice(src.indexOf('function backToPaste'), src.indexOf('function choose'))
  assert.ok(back.includes('saveResult?.contactSaved || saveResult?.interactionSaved) return'))
  assert.equal(back.includes("setText('')"), false)
})

test('entry points are Pro-only; the contact page preselects its contact', () => {
  for (const f of ['../src/pages/ContactsPage.jsx', '../src/pages/ContactDetailPage.jsx']) {
    const src = read(f)
    assert.ok(src.includes('const canPasteEmail = hasProAccess(useProStatus())'), f)
    assert.ok(src.includes('{canPasteEmail && ('), f)
    assert.ok(src.includes('{pasteOpen && canPasteEmail &&'), f)
  }
  assert.ok(read('../src/pages/ContactDetailPage.jsx').includes('preselectedContact={contact}'))
  assert.equal(read('../src/pages/ContactsPage.jsx').includes('preselectedContact='), false)
})

// ── Published wording ──────────────────────────────────────────────────────────

test('privacy policy carries the approved paste-email paragraph verbatim', () => {
  const src = read('../src/pages/PrivacyPage.jsx')
  const approved = 'If you paste an email into Funnl, the text you paste — which can include what the other person wrote, names, employers and phone numbers — is sent to Anthropic to draft a contact and an interaction note for you to review. Before sending it, Funnl replaces the email addresses it recognises with a placeholder and withholds the request if anything still looks like an email address or an access token; Funnl cannot guarantee that every identifying detail is removed. The email addresses Funnl finds stay within Funnl: they are used only to match the email to your contacts and, if you choose, to fill in a new contact’s email. Funnl does not store the text you paste; only the contact and interaction you review and save are kept.'
  const asWritten = approved.replace('contact’s', "contact's")
  assert.ok(src.includes('Paste an email (Pro).</strong> ' + asWritten))
})
