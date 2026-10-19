/**
 * privacy-policy-retired-integrations.test.js — the CURRENT /privacy wording after Google Calendar, Gmail
 * and Outlook were retired, checked against the code and schema that make each claim true.
 *
 * What is pinned here is the present state. The wording that applied while those connections were
 * available is in git history, and the Outlook consent record (src/lib/outlookDisclosure.js) is kept as
 * historical evidence - its own integrity is checked by tests/outlook-consent-ui.test.js and
 * tests/outlook-admin-consent-wording.test.js, not re-derived here.
 *
 * Run with: node tests/privacy-policy-retired-integrations.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { OUTLOOK_DISCLOSURE_VERSION, OUTLOOK_DISCLOSURE_PARAGRAPHS } from '../src/lib/outlookDisclosure.js'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const POLICY = read('src/pages/PrivacyPage.jsx')
// What a reader sees: the JSX with comments removed and whitespace collapsed.
const VISIBLE = POLICY.replace(/[{][/][*][\s\S]*?[*][/][}]/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const MIGRATIONS = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => read(`supabase/migrations/${f}`)).join('\n')
const RETIRED_START = '<Section title="Retired connections: Google Calendar, Gmail and Outlook">'
const RETIRED = (() => {
  const a = POLICY.indexOf(RETIRED_START), b = POLICY.indexOf('<Section title="Analytics: behavior, not content">')
  assert.ok(a > 0 && b > a, 'the retired-connections section exists and precedes Analytics')
  return POLICY.slice(a, b).replace(/\s+/g, ' ')
})()

test('the draft date is the day it was prepared, with the instruction to change it if published later', () => {
  assert.ok(POLICY.includes('Last updated: October 19, 2026'))
  assert.ok(/If it is published on a later day,\s+change this date in the same commit that publishes it/.test(POLICY))
})

test('the old connection sections are gone and nothing offers to connect or disconnect a retired source', () => {
  for (const gone of ['<Section title="Google Calendar connection">', '<Section title="Gmail connection (optional)">',
    '<Section title="Outlook connection (invited accounts only)">']) assert.ok(!POLICY.includes(gone), gone)
  for (const promise of ['connect Outlook from Settings', 'connect Gmail from Settings', 'disconnecting Google Calendar from Settings',
    'You can disconnect either source', 'invited accounts only', 'is not yet available to all accounts', 'disconnect Google Calendar or Gmail from Settings']) {
    assert.ok(!VISIBLE.includes(promise), `present-tense promise left: ${promise}`)
  }
})

test('the retired section says the connections are retired, cannot be connected, and no longer read anything', () => {
  assert.ok(RETIRED.includes('These connections have been') && RETIRED.includes('retired'))
  assert.ok(RETIRED.includes('Funnl no longer offers them, and they cannot be connected'))
  assert.ok(RETIRED.includes('Funnl no longer reads any calendar or mailbox'))
  assert.ok(RETIRED.includes('the server functions that connected to Google and Microsoft have been removed'))
  // Implementation: no integration function or Settings control remains.
  for (const fn of ['outlook-import-worker', 'outlook-oauth-start', 'google-oauth-start', 'google-calendar-sync', 'gmail-oauth-start']) {
    assert.ok(!existsSync(join(ROOT, 'supabase/functions', fn)), `${fn} still exists`)
  }
  assert.ok(!/OutlookConnectionCard|GoogleConnectionCard/.test(read('src/pages/SettingsPage.jsx')))
})

test('authorization: deleted from Funnl, with no claim that access was revoked at Google or Microsoft', () => {
  assert.ok(RETIRED.includes('Funnl deleted the connection records and the encrypted authorization tokens it held'))
  assert.ok(RETIRED.includes('does not necessarily remove Funnl from the list of apps connected to your Google or Microsoft account'))
  assert.ok(RETIRED.includes('https://myaccount.google.com/permissions') && RETIRED.includes('https://account.live.com/consent/Manage'))
  assert.ok(!/revoked/i.test(RETIRED), 'the section must not claim a revocation it cannot show')
})

test('remaining records are stated precisely, including the notes that were never erased', () => {
  assert.ok(RETIRED.includes('settled suggestion records'))
  assert.ok(RETIRED.includes('for Google Calendar, the event') && RETIRED.includes('(up to 200 characters)'))
  assert.ok(RETIRED.includes('for Outlook, a drafted summary of the email exchange (up to 2,000 characters)'))
  assert.ok(RETIRED.includes('one expired Outlook sign-in attempt'))
  assert.ok(RETIRED.includes('the keys') && RETIRED.includes("which Funnl's servers still hold"))
  assert.ok(RETIRED.includes('has not yet set a date'), 'no invented deletion date')
  assert.ok(RETIRED.includes('does not remove copies that may exist in backups'), 'backups are not claimed destroyed')
  // Schema evidence: the proposed note is bounded at 2,000 and NO migration ever clears it, while the
  // subject line and next step ARE cleared on settlement and new-contact proposals must be erased.
  assert.ok(/CHECK \(proposed_notes IS NULL OR char_length\(proposed_notes\) <= 2000\)/.test(MIGRATIONS))
  assert.ok(!/proposed_notes\s*=\s*NULL/.test(MIGRATIONS), 'if a migration starts clearing proposed_notes, update the policy')
  assert.ok(/retained_subject\s*=\s*NULL/.test(MIGRATIONS) && /draft_follow_up\s*=\s*NULL/.test(MIGRATIONS))
  assert.ok(MIGRATIONS.includes('CONSTRAINT ncc_terminal_erased CHECK ('))
})

test('account deletion still removes the remaining records (cascade from the account)', () => {
  assert.ok(/delete my account|Delete your account/i.test(VISIBLE))
  assert.ok(VISIBLE.includes('removes your contacts, interactions, and any records left from the retired connections'))
  const del = read('supabase/functions/delete-account/index.ts')
  assert.ok(del.includes('cleanupGoogle(admin, user.id)') && del.includes('admin.auth.admin.deleteUser(user.id)'))
  for (const table of ['interaction_candidates', 'new_contact_candidates', 'microsoft_oauth_states']) {
    const at = MIGRATIONS.indexOf(`CREATE TABLE public.${table}`)
    assert.ok(at >= 0, `${table} defined`)
    const ddl = MIGRATIONS.slice(at, MIGRATIONS.indexOf(');', at))
    assert.ok(/user_id\s+uuid\s+NOT NULL\s+REFERENCES auth[.]users\(id\)\s+ON DELETE CASCADE/.test(ddl), `${table} cascades from the account`)
  }
})

test('remaining records are not sent to Anthropic: the AI functions read only contacts and interactions', () => {
  assert.ok(VISIBLE.includes('The records left from retired connections are not sent to Anthropic'))
  for (const dir of ['ai-chat', 'ai-paste-email', 'ai-parse-contact', 'ai-map-csv', 'ai-categorize-contacts']) {
    for (const f of readdirSync(join(ROOT, 'supabase/functions', dir))) {
      const src = read(`supabase/functions/${dir}/${f}`)
      assert.ok(!/interaction_candidates|new_contact_candidates|microsoft_|google_connections/.test(src), `${dir}/${f} reads an integration table`)
    }
  }
})

test('paste-email and its AI processing are still described as supported', () => {
  assert.ok(POLICY.includes('data-testid="privacy-paste-email"'))
  assert.ok(VISIBLE.includes('If you paste an email into Funnl, the text you paste'))
  assert.ok(VISIBLE.includes('Funnl does not store the text you paste'))
  assert.ok(VISIBLE.includes('When you use Funnl AI or the AI Fill feature'))
})

test("Anthropic's terms for extracts sent before retirement are stated once, and are the only 30-day figure", () => {
  for (const fact of ['within 30 days', 'up to 2 years', 'up to 7 years', 'Zero Data Retention agreement',
    'cannot have an individual API record deleted on request']) {
    assert.strictEqual(VISIBLE.split(fact).length - 1, 1, `${fact} must appear exactly once`)
  }
  assert.strictEqual(VISIBLE.split('30 days').length - 1, 1, 'no Funnl-side 30-day promise anywhere')
  assert.ok(RETIRED.includes('https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-personal-data'))
})

test('the Limited Use statement is kept, in the past tense, with every required disclosure', () => {
  assert.ok(RETIRED.includes('https://developers.google.com/terms/api-services-user-data-policy'))
  assert.ok(RETIRED.includes('including the Limited Use requirements'))
  for (const need of ['sold', 'transferred to advertisers, data brokers, or information resellers', 'used for advertising or retargeting',
    'used to determine creditworthiness or for lending', 'used to train generalized or foundation AI models']) {
    assert.ok(RETIRED.includes(need), need)
  }
})

test('the page exposes no internal stage names, project identifiers or pilot details', () => {
  for (const internal of ['Stage ', 'Packet', 'jzybxhvgnksrwxfivdwt', 'pilot', 'migration', 'cron', 'Vault', 'HMAC']) {
    assert.ok(!VISIBLE.includes(internal), `visible text mentions ${internal}`)
  }
})

test('the historical Outlook consent record is retained, unchanged in shape, and no longer quoted as current policy', () => {
  assert.ok(/^ol-disc-[0-9a-f]{32}$/.test(OUTLOOK_DISCLOSURE_VERSION))
  assert.ok(OUTLOOK_DISCLOSURE_PARAGRAPHS.length > 0)
  // A sentence that only exists in that record must not reappear as if it were current policy.
  const sample = OUTLOOK_DISCLOSURE_PARAGRAPHS.find((p) => p.length > 80)
  assert.ok(sample && !VISIBLE.includes(sample.slice(0, 80)))
})
