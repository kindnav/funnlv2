/**
 * top-firm-metrics.test.js
 *
 * Tests for src/lib/firmMetrics.js — pure utilities only.
 * Source-contract assertions verify key structural invariants in DashboardPage,
 * SettingsPage, AddContactDrawer, and GlobalAddContactController
 * without executing React or Supabase.
 *
 * Zero-dependency Node.js — run with: node tests/top-firm-metrics.test.js
 */
import assert from 'assert'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import {
  normalizeCompanyForMatch,
  computeFirmMetrics,
  computeTopFirms,
} from '../src/lib/firmMetrics.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${e.message}`)
    failed++
  }
}

function readSrc(rel) {
  return readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')
}

// ── normalizeCompanyForMatch ──────────────────────────────────────────────────

console.log('\nnormalizeCompanyForMatch')

test('trims leading and trailing whitespace', () => {
  assert.strictEqual(normalizeCompanyForMatch('  Goldman Sachs  '), 'goldman sachs')
})

test('lowercases the result', () => {
  assert.strictEqual(normalizeCompanyForMatch('Goldman Sachs'), 'goldman sachs')
  assert.strictEqual(normalizeCompanyForMatch('MORGAN STANLEY'), 'morgan stanley')
})

test('collapses internal repeated whitespace to one space', () => {
  assert.strictEqual(normalizeCompanyForMatch('Bain   &  Company'), 'bain & company')
})

test('strips trailing period', () => {
  assert.strictEqual(normalizeCompanyForMatch('Inc.'), 'inc')
  assert.strictEqual(normalizeCompanyForMatch('McKinsey & Co.'), 'mckinsey & co')
})

test('strips trailing comma', () => {
  assert.strictEqual(normalizeCompanyForMatch('Acme,'), 'acme')
})

test('returns empty string for blank input', () => {
  assert.strictEqual(normalizeCompanyForMatch(''), '')
  assert.strictEqual(normalizeCompanyForMatch('   '), '')
})

test('returns empty string for null', () => {
  assert.strictEqual(normalizeCompanyForMatch(null), '')
})

test('returns empty string for undefined', () => {
  assert.strictEqual(normalizeCompanyForMatch(undefined), '')
})

test('does NOT expand abbreviations — no unsafe aliases', () => {
  // GS must NOT map to Goldman Sachs; they stay separate
  assert.notStrictEqual(normalizeCompanyForMatch('GS'), normalizeCompanyForMatch('Goldman Sachs'))
})

test('same firm with different original casing produces same key', () => {
  assert.strictEqual(
    normalizeCompanyForMatch('Goldman Sachs'),
    normalizeCompanyForMatch('goldman sachs')
  )
})

test('converts non-string number to string before processing', () => {
  // Numbers passed as company (edge case) should not throw
  const result = normalizeCompanyForMatch(42)
  assert.strictEqual(typeof result, 'string')
})

// ── computeFirmMetrics ────────────────────────────────────────────────────────

console.log('\ncomputeFirmMetrics')

test('returns empty array for no contacts', () => {
  const result = computeFirmMetrics([], [])
  assert.deepStrictEqual(result, [])
})

test('excludes contacts with no company', () => {
  const contacts = [
    { id: '1', company: '' },
    { id: '2', company: null },
    { id: '3', company: undefined },
  ]
  const result = computeFirmMetrics(contacts, [])
  assert.strictEqual(result.length, 0)
})

test('counts contacts per firm correctly', () => {
  const contacts = [
    { id: '1', company: 'Goldman Sachs' },
    { id: '2', company: 'Goldman Sachs' },
    { id: '3', company: 'McKinsey' },
  ]
  const result = computeFirmMetrics(contacts, [])
  const gs = result.find(r => r.firm === 'Goldman Sachs')
  const mc = result.find(r => r.firm === 'McKinsey')
  assert.strictEqual(gs.contactsCount, 2)
  assert.strictEqual(mc.contactsCount, 1)
})

test('groups contacts case-insensitively into same firm', () => {
  const contacts = [
    { id: '1', company: 'Goldman Sachs' },
    { id: '2', company: 'goldman sachs' },
    { id: '3', company: 'GOLDMAN SACHS' },
  ]
  const result = computeFirmMetrics(contacts, [])
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].contactsCount, 3)
})

test('spokenWithCount counts distinct contacts with at least one interaction', () => {
  const contacts = [
    { id: '1', company: 'Goldman Sachs' },
    { id: '2', company: 'Goldman Sachs' },
    { id: '3', company: 'Goldman Sachs' },
  ]
  // Only contacts 1 and 2 have interactions
  const interactions = [
    { contact_id: '1', interaction_date: '2024-01-01' },
    { contact_id: '2', interaction_date: '2024-01-02' },
    { contact_id: '1', interaction_date: '2024-01-03' },  // second interaction with contact 1
  ]
  const result = computeFirmMetrics(contacts, interactions)
  const gs = result[0]
  assert.strictEqual(gs.spokenWithCount, 2)  // 1 and 2, not 3
})

test('multiple interactions with same contact count as 1 spokenWith', () => {
  const contacts = [{ id: '1', company: 'Acme' }]
  const interactions = [
    { contact_id: '1', interaction_date: '2024-01-01' },
    { contact_id: '1', interaction_date: '2024-01-05' },
    { contact_id: '1', interaction_date: '2024-01-10' },
  ]
  const result = computeFirmMetrics(contacts, interactions)
  assert.strictEqual(result[0].spokenWithCount, 1)
  assert.strictEqual(result[0].interactionCount, 3)
})

test('interactionCount counts all interactions across the firm', () => {
  const contacts = [
    { id: '1', company: 'Acme' },
    { id: '2', company: 'Acme' },
  ]
  const interactions = [
    { contact_id: '1', interaction_date: '2024-01-01' },
    { contact_id: '1', interaction_date: '2024-01-02' },
    { contact_id: '2', interaction_date: '2024-01-03' },
  ]
  const result = computeFirmMetrics(contacts, interactions)
  assert.strictEqual(result[0].interactionCount, 3)
})

test('lastTouch is the most recent interaction_date for the firm', () => {
  const contacts = [
    { id: '1', company: 'Acme' },
    { id: '2', company: 'Acme' },
  ]
  const interactions = [
    { contact_id: '1', interaction_date: '2024-01-01' },
    { contact_id: '2', interaction_date: '2024-03-15' },
    { contact_id: '1', interaction_date: '2024-02-10' },
  ]
  const result = computeFirmMetrics(contacts, interactions)
  assert.strictEqual(result[0].lastTouch, '2024-03-15')
})

test('lastTouch is null when no interactions exist for the firm', () => {
  const contacts = [{ id: '1', company: 'Acme' }]
  const result = computeFirmMetrics(contacts, [])
  assert.strictEqual(result[0].lastTouch, null)
})

test('interactions for contacts without a matching firm are ignored', () => {
  const contacts = [{ id: '1', company: 'Acme' }]
  const interactions = [
    { contact_id: 'unknown-id', interaction_date: '2024-01-01' },
  ]
  const result = computeFirmMetrics(contacts, interactions)
  assert.strictEqual(result[0].interactionCount, 0)
  assert.strictEqual(result[0].spokenWithCount, 0)
})

test('displayName uses the original casing from the first contact seen', () => {
  const contacts = [
    { id: '1', company: 'Goldman Sachs' },
    { id: '2', company: 'goldman sachs' },
  ]
  const result = computeFirmMetrics(contacts, [])
  // The display name should be preserved from the first contact
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].firm, 'Goldman Sachs')
})

test('produces correct shape for each firm row', () => {
  const contacts = [{ id: '1', company: 'Acme' }]
  const interactions = [{ contact_id: '1', interaction_date: '2024-01-01' }]
  const result = computeFirmMetrics(contacts, interactions)
  const row = result[0]
  assert.ok('firm' in row)
  assert.ok('contactsCount' in row)
  assert.ok('spokenWithCount' in row)
  assert.ok('interactionCount' in row)
  assert.ok('lastTouch' in row)
})

// ── computeTopFirms — ranking ─────────────────────────────────────────────────

console.log('\ncomputeTopFirms — ranking')

test('returns empty array when no contacts', () => {
  assert.deepStrictEqual(computeTopFirms([], []), [])
})

test('limits results to the given limit (default 5)', () => {
  const contacts = [
    { id: '1', company: 'A' },
    { id: '2', company: 'B' },
    { id: '3', company: 'C' },
    { id: '4', company: 'D' },
    { id: '5', company: 'E' },
    { id: '6', company: 'F' },
  ]
  const result = computeTopFirms(contacts, [])
  assert.strictEqual(result.length, 5)
})

test('custom limit is respected', () => {
  const contacts = [
    { id: '1', company: 'A' },
    { id: '2', company: 'B' },
    { id: '3', company: 'C' },
  ]
  const result = computeTopFirms(contacts, [], 2)
  assert.strictEqual(result.length, 2)
})

test('primary sort: spokenWithCount DESC', () => {
  const contacts = [
    { id: '1', company: 'Low' },   // 0 spoken
    { id: '2', company: 'High' },  // 1 spoken
    { id: '3', company: 'Mid' },   // 0 spoken, more contacts
    { id: '4', company: 'Mid' },
  ]
  const interactions = [
    { contact_id: '2', interaction_date: '2024-01-01' },
  ]
  const result = computeTopFirms(contacts, interactions, 10)
  assert.strictEqual(result[0].firm, 'High')
})

test('secondary sort: contactsCount DESC when spokenWithCount tied', () => {
  const contacts = [
    { id: '1', company: 'Small' },   // 1 contact, 0 spoken
    { id: '2', company: 'Large' },   // 2 contacts, 0 spoken
    { id: '3', company: 'Large' },
  ]
  const result = computeTopFirms(contacts, [], 10)
  assert.strictEqual(result[0].firm, 'Large')
  assert.strictEqual(result[1].firm, 'Small')
})

test('tertiary sort: interactionCount DESC when contactsCount tied', () => {
  const contacts = [
    { id: '1', company: 'Few' },    // 1 contact, 1 interaction
    { id: '2', company: 'Many' },   // 1 contact, 3 interactions
  ]
  const interactions = [
    { contact_id: '1', interaction_date: '2024-01-01' },
    { contact_id: '2', interaction_date: '2024-01-01' },
    { contact_id: '2', interaction_date: '2024-01-02' },
    { contact_id: '2', interaction_date: '2024-01-03' },
  ]
  const result = computeTopFirms(contacts, interactions, 10)
  assert.strictEqual(result[0].firm, 'Many')
})

test('quaternary sort: lastTouch DESC (newer first) when interactionCount tied', () => {
  const contacts = [
    { id: '1', company: 'Old' },
    { id: '2', company: 'New' },
  ]
  const interactions = [
    { contact_id: '1', interaction_date: '2024-01-01' },
    { contact_id: '2', interaction_date: '2024-06-15' },
  ]
  const result = computeTopFirms(contacts, interactions, 10)
  assert.strictEqual(result[0].firm, 'New')
})

test('quinary sort: firm name ASC as final tie-breaker', () => {
  const contacts = [
    { id: '1', company: 'Zebra' },
    { id: '2', company: 'Apple' },
  ]
  // Both have identical metrics (no interactions)
  const result = computeTopFirms(contacts, [], 10)
  assert.strictEqual(result[0].firm, 'Apple')
  assert.strictEqual(result[1].firm, 'Zebra')
})

test('null lastTouch sorts after a firm with a lastTouch date', () => {
  const contacts = [
    { id: '1', company: 'HasDate' },
    { id: '2', company: 'NoDate' },
  ]
  const interactions = [
    { contact_id: '1', interaction_date: '2020-01-01' },
    { contact_id: '2', interaction_date: null },
  ]
  const result = computeTopFirms(contacts, interactions, 10)
  // Both have interactionCount=1, contactsCount=1, spokenWithCount=1.
  // HasDate has lastTouch='2020-01-01'; NoDate has lastTouch=null → sorts last.
  assert.strictEqual(result[0].firm, 'HasDate')
})

// ── Source contracts: DashboardPage ──────────────────────────────────────────

console.log('\nSource contracts: DashboardPage')

const dashboard = readSrc('src/pages/DashboardPage.jsx')

test('imports computeTopFirms from firmMetrics', () => {
  assert.ok(
    dashboard.includes("from '../lib/firmMetrics'"),
    'DashboardPage must import from firmMetrics'
  )
})

test('does NOT import from targetFirmUtils', () => {
  assert.ok(
    !dashboard.includes('targetFirmUtils'),
    'DashboardPage must not reference targetFirmUtils'
  )
})

test('TopFirmsCard component is defined', () => {
  assert.ok(
    dashboard.includes('function TopFirmsCard'),
    'DashboardPage must define TopFirmsCard'
  )
})

test('TopFirmsCard is rendered in JSX', () => {
  assert.ok(
    dashboard.includes('<TopFirmsCard'),
    'DashboardPage must render TopFirmsCard'
  )
})

test('does NOT render TargetFirmCoverageCard', () => {
  assert.ok(
    !dashboard.includes('TargetFirmCoverageCard'),
    'DashboardPage must not render TargetFirmCoverageCard'
  )
})

test('profile select does NOT include target_firms', () => {
  assert.ok(
    !dashboard.includes('target_firms'),
    'DashboardPage profile query must not select target_firms'
  )
})

test('does NOT listen for funnl:profile-changed', () => {
  assert.ok(
    !dashboard.includes('funnl:profile-changed'),
    'DashboardPage must not listen for funnl:profile-changed (feature-added, not baseline)'
  )
})

test('TopFirmsCard receives firms prop', () => {
  assert.ok(
    dashboard.includes('<TopFirmsCard firms='),
    'TopFirmsCard must receive firms prop'
  )
})

test('Top Firms rows link to /contacts?search= for drill-down', () => {
  assert.ok(
    dashboard.includes('/contacts?search='),
    'TopFirmRow must link to /contacts?search= for drill-down'
  )
})

test('TopFirmsCard slices to 3 firms for Dashboard display', () => {
  assert.ok(
    dashboard.includes('slice(0, 3)'),
    'TopFirmsCard must slice firms to 3 for Dashboard display'
  )
})

test('View contacts link goes to /contacts (not Manage)', () => {
  assert.ok(
    dashboard.includes('View contacts') && !dashboard.includes('>Manage<'),
    'Top Firms header must have "View contacts" link, not "Manage"'
  )
})

test('TopFirmsCard does NOT render rank numbers', () => {
  // rank prop or numbered circles should not exist in the compact card
  assert.ok(
    !dashboard.includes('rank={i + 1}') && !dashboard.includes('rank={'),
    'TopFirmsCard must not render rank numbers'
  )
})

test('Dashboard does not show interaction count in Top Firms rows', () => {
  // The compact row uses spokenWithCount / contactsCount only; interactionCount
  // must not be referenced inside the TopFirmsCard JSX block
  const cardStart = dashboard.indexOf('function TopFirmsCard')
  const cardEnd   = dashboard.indexOf('\n// ──', cardStart + 1)
  const cardBody  = dashboard.slice(cardStart, cardEnd > cardStart ? cardEnd : undefined)
  assert.ok(
    !cardBody.includes('interactionCount'),
    'TopFirmsCard must not render interactionCount'
  )
})

test('TopFirmsCard is placed in the right rail (after Follow-ups due)', () => {
  const followupsPos = dashboard.indexOf('Follow-ups due')
  const topFirmsPos  = dashboard.indexOf('Top firms —')
  assert.ok(
    followupsPos > 0 && topFirmsPos > followupsPos,
    'Top Firms must appear after Follow-ups due in the right rail'
  )
})

// ── Source contracts: SettingsPage ────────────────────────────────────────────

console.log('\nSource contracts: SettingsPage')

const settings = readSrc('src/pages/SettingsPage.jsx')

test('does NOT import from targetFirmUtils', () => {
  assert.ok(
    !settings.includes('targetFirmUtils'),
    'SettingsPage must not import from targetFirmUtils'
  )
})

test('Target Firms section is absent from JSX', () => {
  assert.ok(
    !settings.includes('id="target-firms"'),
    'SettingsPage must not contain id="target-firms"'
  )
})

test('target_firms state is absent', () => {
  assert.ok(
    !settings.includes('targetFirms'),
    'SettingsPage must not reference targetFirms state'
  )
})

test('profile select uses only display_name', () => {
  assert.ok(
    settings.includes(".select('display_name')"),
    'SettingsPage profile query must select only display_name'
  )
})

test('KEEPS funnl:profile-changed dispatch (baseline: notifies Sidebar of name change)', () => {
  assert.ok(
    settings.includes('funnl:profile-changed'),
    'SettingsPage must still dispatch funnl:profile-changed in handleSave'
  )
})

test('display name input is still present', () => {
  assert.ok(
    settings.includes('displayName') && settings.includes('setDisplayName'),
    'SettingsPage must still have display name state'
  )
})

// ── Source contracts: prefillCompany removed ──────────────────────────────────

console.log('\nSource contracts: prefillCompany removed')

const drawer = readSrc('src/components/AddContactDrawer.jsx')
const controller = readSrc('src/components/GlobalAddContactController.jsx')

test('AddContactDrawer function signature has no initialCompany parameter', () => {
  // The default parameter initialCompany = '' should be gone
  assert.ok(
    !drawer.includes('initialCompany'),
    'AddContactDrawer must not have initialCompany parameter'
  )
})

test('AddContactDrawer still has initialName parameter', () => {
  assert.ok(
    drawer.includes('initialName'),
    'AddContactDrawer must still accept initialName'
  )
})

test('GlobalAddContactController does not set prefillCompany state', () => {
  assert.ok(
    !controller.includes('prefillCompany'),
    'GlobalAddContactController must not reference prefillCompany'
  )
})

test('GlobalAddContactController still sets prefillName', () => {
  assert.ok(
    controller.includes('prefillName'),
    'GlobalAddContactController must still handle prefillName'
  )
})

// ── Source contracts: ContactsPage ?search= still works ───────────────────────

console.log('\nSource contracts: ContactsPage ?search=')

const contacts = readSrc('src/pages/ContactsPage.jsx')

test('ContactsPage reads ?search= URL param', () => {
  assert.ok(
    contacts.includes('search') && contacts.includes('searchParams'),
    'ContactsPage must use searchParams to read search param'
  )
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
