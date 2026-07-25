// Tests for the ai-chat Edge Function's pure helper functions.
// Imports directly from the production helpers.js — no copied implementations.
//
// Run with: node tests/ai-chat.test.js

import assert from 'assert'
import { formatNetworkContext, getLocalToday } from '../supabase/functions/ai-chat/helpers.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗  ${name}`)
    console.log(`       ${e.message}`)
    failed++
  }
}

// ── getLocalToday ─────────────────────────────────────────────────────────────
console.log('\ngetLocalToday')

test('returns YYYY-MM-DD format', () => {
  const today = getLocalToday()
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/)
})

test('month is zero-padded to two digits', () => {
  const [, month] = getLocalToday().split('-')
  assert.strictEqual(month.length, 2)
})

test('day is zero-padded to two digits', () => {
  const [,, day] = getLocalToday().split('-')
  assert.strictEqual(day.length, 2)
})

test('returned date is today (same calendar day)', () => {
  const result = getLocalToday()
  const d = new Date()
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  assert.strictEqual(result, expected)
})

// ── formatNetworkContext — empty network ──────────────────────────────────────
console.log('\nformatNetworkContext — empty network')

test('returns no-contacts message for empty contacts array', () => {
  const result = formatNetworkContext([], [], '2026-07-25')
  assert.ok(result.includes('No contacts have been logged yet'), `got: ${result}`)
})

// ── formatNetworkContext — contact header ─────────────────────────────────────
console.log('\nformatNetworkContext — contact header')

const BASE_CONTACT = { id: 'c1', name: 'Priya Sharma' }

test('includes total contact count in header', () => {
  const result = formatNetworkContext([BASE_CONTACT], [], '2026-07-25')
  assert.ok(result.includes('CONTACTS (1 total)'), `got: ${result}`)
})

test('shows correct count for multiple contacts', () => {
  const c2 = { id: 'c2', name: 'James Chen' }
  const result = formatNetworkContext([BASE_CONTACT, c2], [], '2026-07-25')
  assert.ok(result.includes('CONTACTS (2 total)'))
})

test('indexes contacts starting at 1', () => {
  const result = formatNetworkContext([BASE_CONTACT], [], '2026-07-25')
  assert.ok(result.includes('[1] Priya Sharma'))
})

test('indexes multiple contacts sequentially', () => {
  const c2 = { id: 'c2', name: 'James Chen' }
  const result = formatNetworkContext([BASE_CONTACT, c2], [], '2026-07-25')
  assert.ok(result.includes('[1] Priya Sharma'))
  assert.ok(result.includes('[2] James Chen'))
})

// ── formatNetworkContext — optional contact fields ────────────────────────────
console.log('\nformatNetworkContext — optional contact fields')

test('includes company when present', () => {
  const c = { ...BASE_CONTACT, company: 'Goldman Sachs' }
  assert.ok(formatNetworkContext([c], [], '2026-07-25').includes('Company: Goldman Sachs'))
})

test('includes role when present', () => {
  const c = { ...BASE_CONTACT, role: 'Summer Analyst' }
  assert.ok(formatNetworkContext([c], [], '2026-07-25').includes('Role: Summer Analyst'))
})

test('includes how_met when present', () => {
  const c = { ...BASE_CONTACT, how_met: 'Career fair' }
  assert.ok(formatNetworkContext([c], [], '2026-07-25').includes('How met: Career fair'))
})

test('includes relationship_type when present', () => {
  const c = { ...BASE_CONTACT, relationship_type: 'Mentor' }
  assert.ok(formatNetworkContext([c], [], '2026-07-25').includes('Relationship type: Mentor'))
})

test('includes tags joined by comma when present', () => {
  const c = { ...BASE_CONTACT, tags: ['recruiter', 'target firm'] }
  assert.ok(formatNetworkContext([c], [], '2026-07-25').includes('Tags: recruiter, target firm'))
})

test('includes relationship_note when present', () => {
  const c = { ...BASE_CONTACT, relationship_note: 'Can refer to PE team' }
  assert.ok(formatNetworkContext([c], [], '2026-07-25').includes('Relationship note: Can refer to PE team'))
})

test('includes email when present', () => {
  const c = { ...BASE_CONTACT, email: 'priya@gs.com' }
  assert.ok(formatNetworkContext([c], [], '2026-07-25').includes('Email: priya@gs.com'))
})

test('omits company label when field is absent', () => {
  const result = formatNetworkContext([BASE_CONTACT], [], '2026-07-25')
  assert.ok(!result.includes('Company:'))
})

test('omits tags label when field is absent', () => {
  const result = formatNetworkContext([BASE_CONTACT], [], '2026-07-25')
  assert.ok(!result.includes('Tags:'))
})

test('omits email label when field is absent', () => {
  const result = formatNetworkContext([BASE_CONTACT], [], '2026-07-25')
  assert.ok(!result.includes('Email:'))
})

test('joins multiple meta fields with pipe separator', () => {
  const c = { ...BASE_CONTACT, company: 'Acme', role: 'Intern' }
  assert.ok(formatNetworkContext([c], [], '2026-07-25').includes('Company: Acme | Role: Intern'))
})

// ── formatNetworkContext — interactions ───────────────────────────────────────
console.log('\nformatNetworkContext — interactions')

const TODAY = '2026-07-25'
const BASE_IX = {
  id: 'i1', contact_id: 'c1', type: 'Coffee chat',
  interaction_date: '2026-07-20', notes: null, follow_up_date: null,
}

test('shows "No interactions logged" when none exist', () => {
  assert.ok(formatNetworkContext([BASE_CONTACT], [], TODAY).includes('No interactions logged'))
})

test('shows interaction count header', () => {
  assert.ok(formatNetworkContext([BASE_CONTACT], [BASE_IX], TODAY).includes('Interactions (1):'))
})

test('includes interaction date and type', () => {
  assert.ok(formatNetworkContext([BASE_CONTACT], [BASE_IX], TODAY).includes('2026-07-20 Coffee chat'))
})

test('omits notes dash when notes is null', () => {
  const result = formatNetworkContext([BASE_CONTACT], [BASE_IX], TODAY)
  // The bullet line for this interaction should not have " — " since there are no notes
  const line = result.split('\n').find(l => l.includes('Coffee chat'))
  assert.ok(line && !line.includes(' — '), `unexpected dash in: ${line}`)
})

test('includes notes inline when present', () => {
  const ix = { ...BASE_IX, notes: 'Talked about PE recruiting' }
  assert.ok(formatNetworkContext([BASE_CONTACT], [ix], TODAY).includes(' — Talked about PE recruiting'))
})

test('truncates notes at 300 characters and adds ellipsis', () => {
  const ix = { ...BASE_IX, notes: 'x'.repeat(350) }
  const result = formatNetworkContext([BASE_CONTACT], [ix], TODAY)
  assert.ok(result.includes('…'), 'missing ellipsis')
  assert.ok(!result.includes('x'.repeat(301)), 'note not truncated')
})

test('does not truncate notes exactly 300 characters', () => {
  const ix = { ...BASE_IX, notes: 'y'.repeat(300) }
  const result = formatNetworkContext([BASE_CONTACT], [ix], TODAY)
  assert.ok(!result.includes('…'), 'unexpected ellipsis on 300-char note')
})

test('shows multiple interactions for one contact', () => {
  const ix2 = { ...BASE_IX, id: 'i2', type: 'Email', interaction_date: '2026-07-22' }
  const result = formatNetworkContext([BASE_CONTACT], [BASE_IX, ix2], TODAY)
  assert.ok(result.includes('Interactions (2):'))
  assert.ok(result.includes('2026-07-20 Coffee chat'))
  assert.ok(result.includes('2026-07-22 Email'))
})

// ── formatNetworkContext — follow-up flags ────────────────────────────────────
console.log('\nformatNetworkContext — follow-up flags')

test('shows follow-up date when set', () => {
  const ix = { ...BASE_IX, follow_up_date: '2026-08-01' }
  assert.ok(formatNetworkContext([BASE_CONTACT], [ix], TODAY).includes('[Follow up: 2026-08-01]'))
})

test('marks past follow-up as OVERDUE', () => {
  const ix = { ...BASE_IX, follow_up_date: '2026-07-10' }
  assert.ok(formatNetworkContext([BASE_CONTACT], [ix], TODAY).includes('— OVERDUE'))
})

test('does not mark future follow-up as OVERDUE', () => {
  const ix = { ...BASE_IX, follow_up_date: '2026-07-30' }
  assert.ok(!formatNetworkContext([BASE_CONTACT], [ix], TODAY).includes('OVERDUE'))
})

test('does not mark same-day follow-up as OVERDUE', () => {
  const ix = { ...BASE_IX, follow_up_date: TODAY }
  assert.ok(!formatNetworkContext([BASE_CONTACT], [ix], TODAY).includes('OVERDUE'))
})

test('omits follow-up bracket when follow_up_date is null', () => {
  const result = formatNetworkContext([BASE_CONTACT], [BASE_IX], TODAY)
  assert.ok(!result.includes('[Follow up:'))
})

// ── formatNetworkContext — multi-contact interaction routing ──────────────────
console.log('\nformatNetworkContext — multi-contact interaction routing')

test('routes interaction to correct contact, not to others', () => {
  const c2 = { id: 'c2', name: 'James Chen' }
  const ix = { ...BASE_IX, contact_id: 'c2', notes: 'Only for James' }
  const result = formatNetworkContext([BASE_CONTACT, c2], [ix], TODAY)
  const [priyaSection, jamesSection] = result.split('[2]')
  assert.ok(priyaSection.includes('No interactions logged'), 'Priya should have no interactions')
  assert.ok(jamesSection.includes('Only for James'), 'James should have the interaction')
})

test('contact with no interactions still shows "No interactions logged"', () => {
  const c2 = { id: 'c2', name: 'James Chen' }
  const ix = { ...BASE_IX, contact_id: 'c1' } // only Priya has an interaction
  const result = formatNetworkContext([BASE_CONTACT, c2], [ix], TODAY)
  const jamesSection = result.split('[2]')[1]
  assert.ok(jamesSection.includes('No interactions logged'))
})

// ── results ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
