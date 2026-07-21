// Lightweight tests for CSV header detection utilities.
// No framework — just Node's built-in assert.
// Run with:  node tests/csv-header-detect.test.js

import assert from 'assert'
import {
  normalizeHeader,
  detectHeaderRow,
  isLinkedInExport,
  buildInitialAssignment,
} from '../src/lib/csvHeaderDetect.js'

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

// ── normalizeHeader ──────────────────────────────────────────────────────────
console.log('\nnormalizeHeader')
test('lowercases', () => assert.strictEqual(normalizeHeader('Email'), 'email'))
test('trims whitespace', () => assert.strictEqual(normalizeHeader('  Name  '), 'name'))
test('underscore → space', () => assert.strictEqual(normalizeHeader('first_name'), 'first name'))
test('hyphen → space (e-mail)', () => assert.strictEqual(normalizeHeader('e-mail'), 'e mail'))
test('dot → space', () => assert.strictEqual(normalizeHeader('first.name'), 'first name'))
test('collapses multiple spaces', () => assert.strictEqual(normalizeHeader('Company  Name'), 'company name'))
test('empty string → empty string', () => assert.strictEqual(normalizeHeader(''), ''))
test('null-safe', () => assert.strictEqual(normalizeHeader(null), ''))

// ── detectHeaderRow ──────────────────────────────────────────────────────────
console.log('\ndetectHeaderRow')

// Fixture A — LinkedIn export with preamble
const FIXTURE_A = [
  ['Notes:'],
  ['When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address.'],
  ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On'],
  ['Alex', 'Jordan', 'https://www.linkedin.com/in/alex-jordan', '', 'Example Capital', 'Investment Analyst', '19 Jul 2026'],
  ['Taylor', 'Lee', 'https://www.linkedin.com/in/taylor-lee', 'taylor@example.com', 'Example Company, LLC', 'Strategy Intern', '18 Jul 2026'],
]

test('Fixture A: preamble skipped — header detected at row 2', () => {
  assert.strictEqual(detectHeaderRow(FIXTURE_A), 2)
})

test('Fixture A: rows before header are preamble (not contacts)', () => {
  const idx = detectHeaderRow(FIXTURE_A)
  assert.ok(idx > 0, 'header is not the first row')
  const dataRows = FIXTURE_A.slice(idx + 1)
  assert.strictEqual(dataRows.length, 2)
  assert.strictEqual(dataRows[0][0], 'Alex')
})

// Fixture B — ordinary clean CSV (header on first row)
const FIXTURE_B = [
  ['Name', 'Company', 'Role', 'Email', 'LinkedIn URL'],
  ['Alex Jordan', 'Example Capital', 'Analyst', 'alex@example.com', 'https://www.linkedin.com/in/alex-jordan'],
]

test('Fixture B: clean CSV — header at row 0', () => {
  assert.strictEqual(detectHeaderRow(FIXTURE_B), 0)
})

// Fixture C — BOM on first cell + blank rows before header
const FIXTURE_C = [
  ['﻿'],   // BOM-only cell (blank row after BOM)
  [],
  ['First Name', 'Last Name', 'Email Address', 'Company', 'Position', 'Connected On'],
  ['Sam', 'Doe', 'sam@example.com', 'Acme Corp', 'Analyst', '01 Jan 2026'],
]

test('Fixture C: BOM + blank lines — header still detected', () => {
  const idx = detectHeaderRow(FIXTURE_C)
  assert.strictEqual(idx, 2)
})

// Fixture D — misleading preamble: mentions contact-ish words but not a valid multi-column header
const FIXTURE_D = [
  ['Please fill in the notes and description columns carefully.'],  // single cell with 'notes'
  ['First Name', 'Last Name', 'Email Address', 'Company', 'Position'],
  ['Jamie', 'Rivera', 'jamie@example.com', 'Acme Corp', 'Associate'],
]

test('Fixture D: single-cell preamble rejected — actual header wins', () => {
  assert.strictEqual(detectHeaderRow(FIXTURE_D), 1)
})

// Fixture E — first/last whitespace in values (assignment / transform handles this).
// Needs ≥2 non-name recognized columns (Company + Email) to pass the score≥3 threshold.
const FIXTURE_E = [
  ['First Name', 'Last Name', 'Company', 'Email'],
  [' Manav ', ' Johar ', ' Example Co ', ''],
]

test('Fixture E: header detects fine regardless of value whitespace', () => {
  assert.strictEqual(detectHeaderRow(FIXTURE_E), 0)
})

// Fixture F — completely unrecognizable file
const FIXTURE_F = [
  ['This is explanatory prose with no table structure.'],
  ['Here is another line of text.'],
  ['And one more line before nothing useful follows.'],
]

test('Fixture F: no valid header → returns -1', () => {
  assert.strictEqual(detectHeaderRow(FIXTURE_F), -1)
})

// Higher-scoring row wins over earlier row
const FIXTURE_MULTI = [
  ['Name', 'Notes'],    // only 1 other field — fails the ≥2 threshold → score 0
  ['First Name', 'Last Name', 'Email Address', 'Company', 'Position', 'Connected On'],
]

test('higher-scoring later row beats lower-scoring earlier row', () => {
  assert.strictEqual(detectHeaderRow(FIXTURE_MULTI), 1)
})

// ── isLinkedInExport ─────────────────────────────────────────────────────────
console.log('\nisLinkedInExport')

test('recognizes standard LinkedIn header', () => {
  const row = ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On']
  assert.strictEqual(isLinkedInExport(row), true)
})

test('rejects header without Connected On', () => {
  const row = ['First Name', 'Last Name', 'Email Address', 'Company', 'Role']
  assert.strictEqual(isLinkedInExport(row), false)
})

test('accepts trailing/leading whitespace on cells', () => {
  const row = [' First Name ', ' Last Name ', 'Email Address', 'Company', 'Connected On']
  assert.strictEqual(isLinkedInExport(row), true)
})

test('rejects a row with no first name', () => {
  const row = ['Name', 'Email', 'Company', 'Connected On']
  assert.strictEqual(isLinkedInExport(row), false)
})

// ── buildInitialAssignment ───────────────────────────────────────────────────
console.log('\nbuildInitialAssignment')

test('LinkedIn headers: First Name + Last Name → name; Position → role; URL left unassigned', () => {
  const headers = ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On']
  const a = buildInitialAssignment(headers)
  // First Name and Last Name both map to name, in file order
  assert.deepStrictEqual(a.name, ['First Name', 'Last Name'])
  assert.deepStrictEqual(a.email, ['Email Address'])
  assert.deepStrictEqual(a.company, ['Company'])
  assert.deepStrictEqual(a.role, ['Position'])
  // URL alone is not in HEADER_MAP (too ambiguous) — handled by value-sniffing in caller
  assert.deepStrictEqual(a.linkedin_url, [])
  // Connected On has no Funnl field — stays unassigned
  assert.deepStrictEqual(a.how_met, [])
})

test('standard Funnl-export headers map fully', () => {
  const headers = ['Name', 'Company', 'Role', 'Email', 'LinkedIn URL', 'How met', 'Tags']
  const a = buildInitialAssignment(headers)
  assert.deepStrictEqual(a.name,        ['Name'])
  assert.deepStrictEqual(a.company,     ['Company'])
  assert.deepStrictEqual(a.role,        ['Role'])
  assert.deepStrictEqual(a.email,       ['Email'])
  assert.deepStrictEqual(a.linkedin_url, ['LinkedIn URL'])
  assert.deepStrictEqual(a.how_met,     ['How met'])
  assert.deepStrictEqual(a.tags,        ['Tags'])
})

test('file order is preserved: First Name before Last Name', () => {
  const a = buildInitialAssignment(['First Name', 'Last Name', 'Company'])
  assert.deepStrictEqual(a.name, ['First Name', 'Last Name'])
})

test('reversed order preserved: Last Name before First Name', () => {
  const a = buildInitialAssignment(['Last Name', 'First Name', 'Company'])
  assert.deepStrictEqual(a.name, ['Last Name', 'First Name'])
})

test('duplicate header skipped (only first occurrence kept)', () => {
  const a = buildInitialAssignment(['Name', 'Name', 'Company'])
  assert.deepStrictEqual(a.name, ['Name'])
})

test('Connected On produces no assignment (not a Funnl field)', () => {
  const a = buildInitialAssignment(['First Name', 'Last Name', 'Connected On', 'Company', 'Position'])
  assert.strictEqual(Object.values(a).flat().includes('Connected On'), false)
})

// ── Whitespace trim in transformRow (simulated) ──────────────────────────────
// transformRow lives in ImportContactsModal and isn't exported, but we can verify
// that buildInitialAssignment gives the right column names for trimmed headers.
console.log('\nHeader-trim integration')

test('trimmed header cells produce correct assignment', () => {
  const rawCells = [' First Name ', ' Last Name ', ' Company ']
  const trimmed  = rawCells.map(h => h.trim())
  const a = buildInitialAssignment(trimmed)
  assert.deepStrictEqual(a.name, ['First Name', 'Last Name'])
  assert.deepStrictEqual(a.company, ['Company'])
})

// ── New alias coverage ────────────────────────────────────────────────────────
console.log('\nNew alias coverage')

test('"title" maps to role (Salesforce/HubSpot)', () => {
  const a = buildInitialAssignment(['First Name', 'Last Name', 'Title', 'Company'])
  assert.deepStrictEqual(a.role, ['Title'])
})

test('"display name" maps to name (Zoom/Teams)', () => {
  const a = buildInitialAssignment(['Display Name', 'Email', 'Company', 'Role'])
  assert.ok(a.name.includes('Display Name'))
})

test('"categories" maps to tags (Outlook)', () => {
  const a = buildInitialAssignment(['Name', 'Email', 'Categories', 'Company'])
  assert.deepStrictEqual(a.tags, ['Categories'])
})

test('"groups" maps to tags (Google Contacts)', () => {
  const a = buildInitialAssignment(['Name', 'Email', 'Groups', 'Company'])
  assert.deepStrictEqual(a.tags, ['Groups'])
})

test('"profile link" maps to linkedin_url', () => {
  const a = buildInitialAssignment(['Name', 'Email', 'Profile Link', 'Company'])
  assert.deepStrictEqual(a.linkedin_url, ['Profile Link'])
})

test('"current employer" maps to company', () => {
  const a = buildInitialAssignment(['Name', 'Current Employer', 'Title', 'Email'])
  assert.deepStrictEqual(a.company, ['Current Employer'])
})

test('__parsed_extra column produces no assignment', () => {
  const headers = ['First Name', 'Last Name', 'Company', '__parsed_extra']
  const a = buildInitialAssignment(headers)
  const allAssigned = Object.values(a).flat()
  assert.ok(!allAssigned.includes('__parsed_extra'), '__parsed_extra should not be assigned')
})

test('location/twitter/city columns score-recognized but not assigned', () => {
  // These help scoring but should not appear in any field assignment
  const headers = ['First Name', 'Last Name', 'Email', 'Company', 'Twitter', 'City']
  const a = buildInitialAssignment(headers)
  const allAssigned = Object.values(a).flat()
  assert.ok(!allAssigned.includes('Twitter'))
  assert.ok(!allAssigned.includes('City'))
})

// Fixture G — ragged rows (data rows have fewer cells than headers)
const FIXTURE_G = [
  ['Name', 'Company', 'Role', 'Email', 'LinkedIn URL'],
  ['Alex Jordan', 'Example Capital', 'Analyst'],        // only 3 cells
  ['Sam Doe', 'Acme', 'Engineer', 'sam@example.com'],   // 4 cells
]

test('Fixture G: ragged rows — header still detected at row 0', () => {
  assert.strictEqual(detectHeaderRow(FIXTURE_G), 0)
})

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
