// Source-invariant tests for the source-neutral "Suggestions" IA redesign.
// Static scans only. Run: node tests/suggestions-ia.test.js

import assert from 'assert'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const ENTRY = read('src/components/SuggestionsEntry.jsx')
const PAGE = read('src/pages/SuggestionsPage.jsx')
const APP = read('src/App.jsx')
const BADGE = read('src/components/InteractionSourceBadge.jsx')
const REVIEW = read('src/lib/calendarReview.js')
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

console.log('\nrename + files')
test('renamed components exist; old names are gone', () => {
  assert.ok(existsSync(join(ROOT, 'src/components/SuggestionsEntry.jsx')))
  assert.ok(existsSync(join(ROOT, 'src/pages/SuggestionsPage.jsx')))
  assert.ok(!existsSync(join(ROOT, 'src/components/CalendarSuggestionsEntry.jsx')))
  assert.ok(!existsSync(join(ROOT, 'src/pages/CalendarSuggestionsPage.jsx')))
  assert.ok(/export default function SuggestionsEntry/.test(ENTRY))
  assert.ok(/export default function SuggestionsPage/.test(PAGE))
})

console.log('\ncanonical route + redirect compatibility')
test('/suggestions is canonical; /calendar-suggestions redirects to it; both flag-gated', () => {
  assert.ok(/import SuggestionsPage from '\.\/pages\/SuggestionsPage'/.test(APP))
  assert.ok(/CALENDAR_INGESTION_ENABLED &&[\s\S]*?path="\/suggestions" element=\{<SuggestionsPage \/>\}/.test(APP))
  assert.ok(/CALENDAR_INGESTION_ENABLED &&[\s\S]*?path="\/calendar-suggestions" element=\{<Navigate to="\/suggestions" replace \/>\}/.test(APP))
  assert.ok(!/CalendarSuggestionsPage/.test(APP), 'old page name must be gone from App')
})

console.log('\nsource-neutral copy')
test('entry: "Suggestions" title + connected-sources copy + /suggestions link', () => {
  assert.ok(/Suggestions<\/span>/.test(ENTRY))
  assert.ok(/to review from your connected sources/.test(ENTRY))
  assert.ok(/to="\/suggestions"/.test(ENTRY))
})
test('page: "Suggestions" title + connected-sources description', () => {
  assert.ok(/TopBar title="Suggestions"/.test(PAGE))
  assert.ok(/Review people from your connected sources and add them as interactions/.test(PAGE))
})
test('user-facing copy is not calendar-centric', () => {
  const copy = stripJs(ENTRY) + '\n' + stripJs(PAGE)
  assert.ok(!/Calendar suggestions/i.test(copy), 'no "Calendar suggestions" workflow name in UI copy')
  assert.ok(!/from your calendar/i.test(copy), 'no "from your calendar" phrasing')
})

console.log('\nflag gating (off = no entry/page/query/RPC)')
test('entry + page gate on CALENDAR_INGESTION_ENABLED', () => {
  assert.ok(/if \(!CALENDAR_INGESTION_ENABLED\) return null/.test(ENTRY))
  assert.ok(/if \(!CALENDAR_INGESTION_ENABLED\) return null/.test(PAGE))
  assert.ok(/if \(!CALENDAR_INGESTION_ENABLED\) return/.test(PAGE)) // effect guard: no query
})

console.log('\nno nonfunctional Gmail/Outlook UI exposed')
test('entry/page expose no Gmail/Outlook tabs or coming-soon controls', () => {
  const ui = stripJs(ENTRY) + '\n' + stripJs(PAGE)
  assert.ok(!/gmail/i.test(ui))
  assert.ok(!/outlook/i.test(ui))
  assert.ok(!/coming soon/i.test(ui))
})

console.log('\nprovenance badge on suggestion cards (provider-aware, privacy-safe)')
test('page shows the source badge from candidate.source; select adds source only', () => {
  assert.ok(/<InteractionSourceBadge source=\{candidate\.source\} \/>/.test(PAGE))
  assert.ok(/id, source, proposed_type/.test(REVIEW), 'CANDIDATE_SELECT includes source')
  for (const bad of ['source_fingerprint', 'user_id', 'interaction_id', 'google_', 'event_id', 'connection_id']) {
    assert.ok(!REVIEW.match(new RegExp(`CANDIDATE_SELECT[\\s\\S]{0,200}${bad}`)), `CANDIDATE_SELECT must not select ${bad}`)
  }
})

console.log('\nneutral, unofficial glyph (documented temporary)')
test('badge documents the glyph is temporary + unofficial and imitates no Google identity', () => {
  assert.ok(/TEMPORARY ICON/.test(BADGE))
  assert.ok(/NOT the official Google Calendar product icon/.test(BADGE))
  // The explicit text label is provider-driven: the badge renders {provider.label},
  // and the google_calendar provider's label is exactly "Google Calendar".
  assert.ok(/<span>\{provider\.label\}<\/span>/.test(BADGE), 'badge renders the provider label')
  assert.ok(/label: 'Google Calendar'/.test(read('src/lib/interactionSource.js')), 'provider label is "Google Calendar"')
  // No imitation of Google product-icon brand colors.
  for (const hex of ['#4285F4', '#EA4335', '#FBBC05', '#34A853', '#1a73e8']) {
    assert.ok(!BADGE.toUpperCase().includes(hex.toUpperCase()), `must not use Google brand color ${hex}`)
  }
  assert.ok(/currentColor/.test(BADGE), 'glyph inherits currentColor (neutral)')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
