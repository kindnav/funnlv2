/**
 * privacy-policy-retired-integrations.test.js — the CURRENT /privacy wording after Google Calendar, Gmail
 * and Outlook were retired, checked against the code and schema that make each claim true.
 *
 * What is pinned here is the present state. The records left from those connections were deleted on
 * 2026-10-19 by migration 20261019180000, so schema claims are checked against the schema the migrations
 * LEAVE BEHIND (every CREATE and DROP replayed in order), never against a historical CREATE TABLE alone.
 * The wording that applied while those connections were
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
// The public tables and functions the migrations leave behind, replaying every CREATE and DROP in order.
const MIGRATION_LINES = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  .flatMap((f) => read('supabase/migrations/' + f).split(String.fromCharCode(10)).map((l) => l.trim()))
function replay (createRe, dropRe) {
  const live = new Set()
  for (const line of MIGRATION_LINES) {
    const c = line.match(createRe); if (c) live.add(c[1])
    const d = line.match(dropRe); if (d) live.delete(d[1])
  }
  return live
}
const FINAL_TABLES = replay(/^CREATE TABLE (?:IF NOT EXISTS )?public[.]([a-z_]+)/i, /^DROP TABLE (?:IF EXISTS )?public[.]([a-z_]+)/i)
const FINAL_FUNCTIONS = replay(/^CREATE (?:OR REPLACE )?FUNCTION public[.]([a-z_]+)[(]/i, /^DROP FUNCTION (?:IF EXISTS )?public[.]([a-z_]+)[(]/i)
const APP_TABLES = ['account_deletion_fences', 'checkout_operations', 'checkout_session_history', 'checkout_unresolved_operations', 'contacts', 'interactions', 'pro_trials', 'profiles', 'stripe_webhook_events', 'subscriptions']
const RETIRED_TABLES = ['interaction_candidates', 'new_contact_candidates', 'microsoft_oauth_states', 'google_oauth_states', 'google_connections',
  'google_tokens', 'microsoft_connections', 'microsoft_tokens', 'outlook_sync_state', 'outlook_subscriptions', 'email_candidate_refs']
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

// One top-level bullet of the retired section, found by its bold label (nested lists included).
function bullet (label) {
  const at = RETIRED.indexOf(`<strong className="text-hi font-semibold">${label}</strong>`)
  assert.ok(at > 0, `bullet "${label}" exists`)
  const start = RETIRED.lastIndexOf('<li>', at)
  let depth = 0, i = start
  for (; i < RETIRED.length; i++) {
    if (RETIRED.startsWith('<li', i)) depth++
    else if (RETIRED.startsWith('</li>', i) && --depth === 0) break
  }
  return RETIRED.slice(start, i + 5).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}
const ANTHROPIC_BLOCK = (() => {
  const a = POLICY.indexOf('Anthropic (Claude) — powers AI features'), b = POLICY.indexOf('PostHog — product analytics and error reporting')
  assert.ok(a > 0 && b > a)
  return POLICY.slice(a, b).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
})()
const TERMS = (() => {
  const m = POLICY.match(/<p className="mt-2" data-testid="privacy-anthropic-terms">[\s\S]*?<[/]p>/)
  assert.ok(m, 'the Anthropic terms paragraph exists')
  return m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
})()

test('the records left from the retired connections are described as deleted, with their notes, and nothing as remaining', () => {
  const gone = bullet('The last records were deleted')
  assert.ok(gone.includes('on October 19, 2026, Funnl deleted the records that were left from these connections from its database'))
  assert.ok(gone.includes('the settled suggestion records, together with the notes they had proposed'))
  assert.ok(gone.includes("such as a calendar event's title or a drafted summary of an email exchange"))
  assert.ok(gone.includes('one expired Outlook sign-in attempt'))
  assert.ok(gone.includes('Funnl did not export or copy them first'))
  assert.ok(gone.includes("No suggestion, sign-in or connection records from these connections remain in Funnl's database, and none are waiting for a later cleanup"))
  assert.ok(!/key|backup/i.test(gone), 'keys and backups are stated separately, not as deleted')
  // Every stale "still held" passage is gone from what a reader sees.
  for (const stale of ['remain for now', 'Records that remain', 'records left from retired connections', 'records left from the retired connections',
    'are stored there too', 'what remains of either', 'intends to remove the rest', 'has not yet set a date.', 'can also still hold the note']) {
    assert.ok(!VISIBLE.includes(stale), 'stale wording left: ' + stale)
  }
  // Saved records stay ordinary records with their source label.
  const saved = bullet('What you saved stays yours')
  assert.ok(saved.includes('is an ordinary Funnl record') && saved.includes('"Google Calendar" or "Outlook" label'))
})

test('schema: the migrations leave no integration table or function, and keep the app tables and the source labels', () => {
  for (const t of RETIRED_TABLES) assert.ok(!FINAL_TABLES.has(t), t + ' still exists after the migrations')
  assert.deepStrictEqual([...FINAL_TABLES].sort(), APP_TABLES, 'exactly the application and billing tables remain')
  for (const fn of ['run_google_local_cleanup', 'outlook_sync_state_consume_wake', 'outlook_unpaired_valid', 'expire_pending_email_context', 'expire_pending_outlook_context']) {
    assert.ok(!FINAL_FUNCTIONS.has(fn), fn + ' still exists after the migrations')
  }
  // The drop migration refuses to run on pending or live state and never touches the saved-record label rule.
  const drop = read('supabase/migrations/20261019180000_drop_integration_tables.sql')
  assert.ok(drop.includes("status IN ('pending', 'deferred')") && drop.includes('expires_at > now()'))
  assert.ok(!/CASCADE;/.test(drop) && !/ALTER TABLE public[.]interactions/.test(drop), 'no cascade, and interactions is not altered')
  assert.ok(drop.includes("pg_get_constraintdef(oid) LIKE '%outlook%'") && drop.includes("LIKE '%google_calendar%'"), 'it verifies the source labels survive')
})

test('server keys are stated separately: shared, retained, and NOT removed by deleting an account', () => {
  const keys = bullet("Keys kept on Funnl's servers")
  assert.ok(keys.includes('shared server-side keys, not records in anyone') && keys.includes('deleting your account does not remove them'))
  assert.ok(!keys.includes('row-level') && !keys.includes('deletes yours'), 'no record-level protection or deletion claim for keys')
  assert.ok(VISIBLE.includes("It does not remove Funnl's shared server keys or any backup copies"), 'Your rights says the same')
})

test('backups are never claimed destroyed', () => {
  const backups = bullet('Backups')
  assert.ok(backups.includes("deleting your account removes your records from Funnl's database") && backups.includes('the deletion described above removed those records from it'))
  assert.ok(backups.includes('Neither removes copies that may exist in backups'))
  assert.ok(backups.includes('Funnl has not established whether any such copies exist or when they expire'))
  assert.ok(!/backups?[^.]{0,80}(destroyed|deleted|erased|purged)/i.test(VISIBLE.replace('Neither removes copies that may exist in backups', '')))
})

test('account deletion removes contacts and interactions; keys and backups are not claimed', () => {
  assert.ok(VISIBLE.includes('which removes your contacts and interactions, including any you saved from the retired connections'))
  assert.ok(VISIBLE.includes("It does not remove Funnl's shared server keys or any backup copies"))
  const del = read('supabase/functions/delete-account/index.ts')
  assert.ok(del.includes(".from('contacts')") && del.includes('admin.auth.admin.deleteUser(user.id)'))
  assert.ok(!del.includes('cleanupGoogle') && !del.includes('run_google_local_cleanup'))
  // Interactions go with their contact, and contacts with the account, in the schema left behind.
  assert.ok(FINAL_TABLES.has('contacts') && FINAL_TABLES.has('interactions'))
  const at = MIGRATIONS.indexOf('CREATE TABLE public.interactions'), ddl = MIGRATIONS.slice(at, MIGRATIONS.indexOf(');', at))
  assert.ok(/REFERENCES public[.]contacts[(]id[)] ON DELETE CASCADE/.test(ddl), 'interactions cascade from their contact')
})

test('the AI functions read only contacts and interactions, and no remaining-records claim is made', () => {
  assert.ok(!VISIBLE.includes('not sent to Anthropic'), 'no sentence about records that no longer exist')
  assert.ok(VISIBLE.includes('An interaction you accepted from a suggestion is an ordinary interaction, so if you use Funnl AI it may be sent to Anthropic like any other'))
  for (const dir of ['ai-chat', 'ai-paste-email', 'ai-parse-contact', 'ai-map-csv', 'ai-categorize-contacts']) {
    for (const f of readdirSync(join(ROOT, 'supabase/functions', dir))) {
      const src = read('supabase/functions/' + dir + '/' + f)
      assert.ok(!/interaction_candidates|new_contact_candidates|microsoft_|google_connections/.test(src), dir + '/' + f + ' reads an integration table')
    }
  }
})

test('paste-email and its AI processing are still described as supported', () => {
  assert.ok(POLICY.includes('data-testid="privacy-paste-email"'))
  assert.ok(VISIBLE.includes('If you paste an email into Funnl, the text you paste'))
  assert.ok(VISIBLE.includes('Funnl does not store the text you paste'))
  assert.ok(VISIBLE.includes('When you use Funnl AI or the AI Fill feature'))
})

test('training: "by default" wording only, with exceptions, and no claim that Funnl opted out', () => {
  assert.ok(TERMS.includes('by default Anthropic does not use inputs or outputs from its commercial products to train its models'))
  assert.ok(TERMS.includes('such as data explicitly reported to Anthropic as feedback'))
  assert.ok(!/does not use (API|your) data to train/i.test(VISIBLE), 'the absolute training statement is gone')
  assert.ok(!/opted out|opt-out|opt out|organi[sz]ation settings/i.test(VISIBLE), 'no unverified claim about Funnl settings')
  assert.ok(TERMS.includes('https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training') || POLICY.includes('href="https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training"'))
})

test('retention: complete for the API Funnl uses, with every documented exception and the current links', () => {
  for (const part of ['within 30 days of receiving or generating them', 'to enforce its Usage Policy',
    'inputs and outputs for up to 2 years', 'trust-and-safety classification scores for up to 7 years',
    'where the law requires it', 'where a customer has agreed different terms or uses a longer-retention service under its own control',
    'Funnl does not have a Zero Data Retention agreement', 'cannot have an individual API record deleted on request']) {
    assert.ok(TERMS.includes(part), part)
  }
  for (const href of ['https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data',
    'https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training']) {
    assert.strictEqual(POLICY.split(`href="${href}"`).length - 1, 1, `${href} linked once`)
  }
  assert.ok(!POLICY.includes('7996866-how-long-do-you-store-personal-data'), 'the superseded consumer-policy link is gone')
  // Each retention figure appears once on the page, so there is no second, Funnl-side 30-day promise.
  for (const fact of ['30 days', 'up to 2 years', 'up to 7 years']) assert.strictEqual(VISIBLE.split(fact).length - 1, 1, fact)
  // Evidence for "standard message API rather than a longer-retention service": the only Anthropic endpoint called.
  const fnSrc = readdirSync(join(ROOT, 'supabase/functions'), { recursive: true }).filter((f) => /[.](ts|js)$/.test(f))
    .map((f) => read(join('supabase/functions', f))).join('\n')
  const endpoints = [...new Set(fnSrc.match(/https:[/][/]api[.]anthropic[.]com[A-Za-z0-9/_.-]*/g))]
  assert.deepStrictEqual(endpoints, ['https://api.anthropic.com/v1/messages'])
  assert.ok(!/v1[/]files|anthropic-beta/i.test(fnSrc))
})

test('the terms apply to every AI feature (including paste-email), and current terms are kept apart from historical requests', () => {
  assert.ok(ANTHROPIC_BLOCK.includes('How Anthropic handles this data'), 'the terms sit in the Anthropic section, not only in the retired one')
  assert.ok(TERMS.includes('Every AI request Funnl makes — Funnl AI, AI Fill, smart CSV import and pasting an email — goes to Anthropic'))
  assert.ok(TERMS.includes("These are Anthropic's terms as published when this policy was last updated, and Anthropic can change them; earlier requests were handled under the terms in effect when they were sent"))
  const extracts = bullet('Email extracts sent to Anthropic before retirement')
  assert.ok(extracts.includes('handled under Anthropic') && extracts.includes('terms in effect when they were sent'))
  assert.ok(extracts.includes("the terms described above are Anthropic's current ones"))
  assert.ok(!/30 days|2 years|7 years/.test(extracts), 'historical extracts are not given the current figures as if they governed them')
  // Every AI function named really calls Anthropic.
  for (const dir of ['ai-chat', 'ai-parse-contact', 'ai-map-csv', 'ai-categorize-contacts', 'ai-paste-email']) {
    assert.ok(existsSync(join(ROOT, 'supabase/functions', dir, 'index.ts')), `${dir} exists`)
  }
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

test('the earlier erasure-wording discrepancy stays recorded, and the schema history still supports it', () => {
  const record = read('docs/stage-f-integration-tables.md')
  assert.ok(record.includes('The prior erasure discrepancy'), 'the discrepancy record is kept')
  assert.ok(record.includes('was never erased by accept, dismiss or invalidate'))
  // What it records: no migration ever cleared proposed_notes; subjects and next steps were cleared on settlement.
  assert.ok(/CHECK [(]proposed_notes IS NULL OR char_length[(]proposed_notes[)] <= 2000[)]/.test(MIGRATIONS))
  assert.ok(!/proposed_notes *= *NULL/.test(MIGRATIONS))
  assert.ok(/retained_subject *= *NULL/.test(MIGRATIONS) && /draft_follow_up *= *NULL/.test(MIGRATIONS))
})

test('the historical Outlook consent record is retained, unchanged in shape, and no longer quoted as current policy', () => {
  assert.ok(/^ol-disc-[0-9a-f]{32}$/.test(OUTLOOK_DISCLOSURE_VERSION))
  assert.ok(OUTLOOK_DISCLOSURE_PARAGRAPHS.length > 0)
  // A sentence that only exists in that record must not reappear as if it were current policy.
  const sample = OUTLOOK_DISCLOSURE_PARAGRAPHS.find((p) => p.length > 80)
  assert.ok(sample && !VISIBLE.includes(sample.slice(0, 80)))
})
