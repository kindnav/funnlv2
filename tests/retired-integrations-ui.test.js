/**
 * retired-integrations-ui.test.js — the Outlook and Google Calendar connection cards and the Suggestions
 * experience are retired from the frontend (Stage B hid them; Stage D removed the code, then the
 * integration backend and the review/consent helpers whose last consumers went with it). These
 * contracts keep them retired, keep account deletion reachable, and pin the frontend modules that are
 * deliberately KEPT because a retained check still depends on them.
 *
 * Integration tables remain until Stage F.
 *
 * Run with: node tests/retired-integrations-ui.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const DELETED = [
  'src/components/OutlookConnectionCard.jsx', 'src/components/OutlookSyncStatus.jsx',
  'src/lib/outlookSyncStatus.js', 'src/lib/outlookDisconnect.js',
  'src/pages/SuggestionsPage.jsx', 'src/components/SuggestionsEntry.jsx',
  'src/components/NewContactSuggestionCard.jsx', 'src/components/PendingUpdateNotice.jsx',
  'src/components/NoteCounter.jsx', 'src/lib/noteCounter.js', 'src/lib/dismissConfirmFocus.js',
  'src/lib/suggestionAnalytics.js', 'src/lib/usePendingSuggestionCount.js',
  'src/lib/pendingSuggestions.js', 'src/lib/suggestionReview.js',
  // Google Calendar connection UI (Stage D, after Outlook).
  'src/components/GoogleConnectionCard.jsx', 'src/lib/googleConnection.js',
  // Review and consent helpers whose last consumers (the integration functions, the acceptance
  // RPCs and their tests) were retired with the integration backend.
  'src/lib/calendarReview.js', 'src/lib/calendarIngestion.js', 'src/lib/newContactReview.js',
  'src/lib/outlookConnection.js', 'src/lib/oauthStartEndpoint.js',
]
// Kept on purpose: each still has a retained consumer.
const KEPT = {
  'src/lib/outlookDisclosure.js': 'the consent record; the privacy-policy and consent-wording tests check the published notice against it',
  'src/lib/sha256.js': 'used by outlookDisclosure.js',
}

const walk = (d, out = []) => { for (const e of readdirSync(join(ROOT, d))) { const p = `${d}/${e}`; statSync(join(ROOT, p)).isDirectory() ? walk(p, out) : /\.(jsx?|mjs)$/.test(e) && out.push(p) } return out }

test('the retired Outlook card, Google Calendar card and Suggestions modules are gone', () => {
  for (const f of DELETED) assert.ok(!existsSync(join(ROOT, f)), `${f} must stay deleted`)
})

test('no file under src/ imports a retired module', () => {
  const names = DELETED.map(f => f.split('/').pop().replace(/\.(jsx?|mjs)$/, ''))
  for (const f of walk('src')) {
    const src = read(f)
    for (const n of names) {
      assert.ok(!new RegExp(`from\\s+['"][^'"]*/${n}(\\.jsx?)?['"]`).test(src), `${f} imports retired ${n}`)
    }
  }
})

test('the deliberately kept modules are still present, each with a retained reason', () => {
  for (const [f, why] of Object.entries(KEPT)) assert.ok(existsSync(join(ROOT, f)), `${f} (${why})`)
})

test('old Suggestions URLs redirect to Home, independent of any build flag', () => {
  const app = read('src/App.jsx')
  assert.ok(app.includes('<Route path="/suggestions" element={<Navigate to="/" replace />} />'))
  assert.ok(app.includes('<Route path="/calendar-suggestions" element={<Navigate to="/" replace />} />'))
  assert.ok(!/SUGGESTION_REVIEW_ENABLED|SuggestionsPage/.test(app))
})

test('no navigation, badge or Home entry for Suggestions', () => {
  for (const f of ['src/components/Sidebar.jsx', 'src/components/BottomNav.jsx', 'src/pages/DashboardPage.jsx', 'src/components/CommandPalette.jsx']) {
    const src = read(f)
    for (const gone of ['to="/suggestions"', 'usePendingSuggestionCount', 'SuggestionsEntry', 'suggestions-badge', 'SUGGESTION_REVIEW_ENABLED']) {
      assert.ok(!src.includes(gone), `${f}: ${gone}`)
    }
  }
})

test('Settings has no Outlook card, Connect or Disconnect, and keeps account deletion', () => {
  const s = read('src/pages/SettingsPage.jsx')
  assert.ok(!/OutlookConnectionCard|outlookConnection|OUTLOOK_CONNECTION_ENABLED|Disconnect Outlook|Connect Outlook/.test(s))
  assert.ok(s.includes("supabase.functions.invoke('delete-account')"), 'account deletion still calls delete-account')
  assert.ok(s.includes('Delete my account'), 'the account-deletion control is still rendered')
})

test('Settings has no Google Calendar card or Connected accounts section', () => {
  const s = read('src/pages/SettingsPage.jsx')
  for (const gone of ['GoogleConnectionCard', 'googleConnection', 'CALENDAR_CONNECTION_ENABLED',
    'Connected accounts', 'Connect Google Calendar']) {
    assert.ok(!s.includes(gone), `Settings: ${gone}`)
  }
})

test('the frontend starts or disconnects no provider flow and names no OAuth start path', () => {
  for (const f of walk('src')) {
    const src = read(f)
    for (const gone of ["'google-oauth-", "'gmail-oauth-", "'outlook-oauth-", '/api/google-oauth',
      '/api/gmail-oauth', '/api/outlook-oauth', 'OAUTH_START_PATHS', 'resolveOauthStartUrl']) {
      assert.ok(!src.includes(gone), `${f}: ${gone}`)
    }
  }
})

test('the frontend calls none of the retired integration RPCs', () => {
  for (const f of walk('src')) {
    const src = read(f)
    for (const rpc of ['get_my_outlook_connection', 'get_my_outlook_sync_status', 'disconnect_my_outlook',
      'disconnect_my_gmail', 'accept_interaction_candidate', 'accept_new_contact_candidate',
      'dismiss_interaction_candidate', 'dismiss_new_contact_candidate', 'defer_candidate']) {
      assert.ok(!src.includes(`rpc('${rpc}'`), `${f} calls ${rpc}`)
    }
  }
})

test('no Calendar flag or Google credential material is read by the frontend', () => {
  for (const f of walk('src')) {
    const src = read(f)
    for (const banned of ['VITE_CALENDAR_CONNECTION_ENABLED', 'VITE_GOOGLE_', 'client_secret',
      'CLIENT_SECRET', 'ENCRYPTION_KEY', 'refresh_token']) {
      assert.ok(!src.includes(banned), `${f}: ${banned}`)
    }
  }
})
