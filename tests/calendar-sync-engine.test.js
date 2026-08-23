// Phase C1 Calendar sync engine — pure helpers + full orchestration (mocked
// Google/token/DB boundaries; no live API, no Deno). Run:
//   node tests/calendar-sync-engine.test.js

import assert from 'assert'
import {
  WINDOW_DAYS, MAX_PAGES, MAX_RESULTS_PER_PAGE, SUMMARY_MAX, FALLBACK_SUMMARY,
  GOOGLE_CALENDAR_EVENTS_ENDPOINT,
  isRfc3339Utc, isValidPageToken, buildEventsListUrl, parseEventsPage, sanitizeSummary,
  shouldRefreshToken, validateRefreshResponse, buildOccurrencePlan, runCalendarSync,
  datePartOfRfc3339,
} from '../supabase/functions/shared/calendarSyncEngine.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}
const SUBTLE = globalThis.crypto.subtle
const NOW = new Date('2026-08-23T12:00:00.000Z')

// ── Pure validators / builders ────────────────────────────────────────────────
console.log('\nURL + token + page validators')

await test('isRfc3339Utc accepts our generated instants, rejects others', () => {
  assert.ok(isRfc3339Utc('2026-08-23T12:00:00.000Z'))
  assert.ok(isRfc3339Utc('2026-08-23T12:00:00Z'))
  assert.ok(!isRfc3339Utc('2026-08-23'))
  assert.ok(!isRfc3339Utc('2026-08-23T12:00:00+02:00'))
})
await test('isValidPageToken accepts opaque tokens, rejects whitespace/control/empty', () => {
  assert.ok(isValidPageToken('CigKGjBpN...=='))
  assert.ok(isValidPageToken('bad!token'))            // opaque: punctuation is fine (percent-encoded downstream)
  assert.ok(isValidPageToken('a.b-c_d=e~f:g'))        // broad printable charset not rejected
  assert.ok(!isValidPageToken('has space'))
  assert.ok(!isValidPageToken('tok\nnl'))             // control char rejected
  assert.ok(!isValidPageToken(''))
  assert.ok(!isValidPageToken(123))
  assert.ok(!isValidPageToken('x'.repeat(5000)))      // length bound
})
await test('datePartOfRfc3339 preserves the OFFSET-local date (no UTC shift)', () => {
  assert.strictEqual(datePartOfRfc3339('2026-08-01T23:00:00-04:00'), '2026-08-01') // UTC would be 08-02
  assert.strictEqual(datePartOfRfc3339('2026-08-02T01:00:00+05:30'), '2026-08-02')
  assert.strictEqual(datePartOfRfc3339('2026-08-01T15:00:00Z'), '2026-08-01')
  assert.strictEqual(datePartOfRfc3339('2026-08-01T15:00:00.500Z'), '2026-08-01')
  assert.strictEqual(datePartOfRfc3339('2026-08-01T15:00:00'), null)   // no offset → fail closed
  assert.strictEqual(datePartOfRfc3339('not-a-date'), null)
  assert.strictEqual(datePartOfRfc3339(null), null)
})
await test('buildEventsListUrl uses the FIXED C1 query and primary calendar', () => {
  const url = buildEventsListUrl({ timeMinIso: '2026-05-25T12:00:00.000Z', timeMaxIso: '2026-08-23T12:00:00.000Z', maxResults: 100, pageToken: null })
  assert.ok(url.startsWith(GOOGLE_CALENDAR_EVENTS_ENDPOINT + '?'))
  const q = new URL(url).searchParams
  assert.strictEqual(q.get('singleEvents'), 'true')
  assert.strictEqual(q.get('showDeleted'), 'true')
  assert.strictEqual(q.get('orderBy'), 'startTime')
  assert.strictEqual(q.get('maxResults'), '100')
  assert.strictEqual(q.get('timeMin'), '2026-05-25T12:00:00.000Z')
  assert.strictEqual(q.get('timeMax'), '2026-08-23T12:00:00.000Z')
  assert.strictEqual(q.get('pageToken'), null)
})
await test('buildEventsListUrl clamps maxResults and rejects bad token/window', () => {
  const url = buildEventsListUrl({ timeMinIso: '2026-05-25T12:00:00.000Z', timeMaxIso: '2026-08-23T12:00:00.000Z', maxResults: 99999, pageToken: 'tok2' })
  assert.strictEqual(new URL(url).searchParams.get('maxResults'), String(MAX_RESULTS_PER_PAGE))
  assert.strictEqual(new URL(url).searchParams.get('pageToken'), 'tok2')
  assert.throws(() => buildEventsListUrl({ timeMinIso: 'nope', timeMaxIso: '2026-08-23T12:00:00.000Z', maxResults: 100, pageToken: null }))
  assert.throws(() => buildEventsListUrl({ timeMinIso: '2026-05-25T12:00:00.000Z', timeMaxIso: '2026-08-23T12:00:00.000Z', maxResults: 100, pageToken: 'bad token' }))
})
await test('parseEventsPage fails closed on bad shapes', () => {
  assert.ok(!parseEventsPage(null).ok)
  assert.ok(!parseEventsPage([]).ok)
  assert.ok(!parseEventsPage({ items: 'nope' }).ok)
  assert.ok(!parseEventsPage({ items: [], nextPageToken: 'bad token!' }).ok)
  const ok = parseEventsPage({ items: [{ id: 'e' }], nextPageToken: 'tok2' })
  assert.ok(ok.ok && ok.items.length === 1 && ok.nextPageToken === 'tok2')
  assert.deepStrictEqual(parseEventsPage({}).items, [])   // items optional
})
await test('sanitizeSummary normalizes/caps and falls back neutrally', () => {
  assert.strictEqual(sanitizeSummary('  Coffee   with\nPriya  '), 'Coffee with Priya')
  assert.strictEqual(sanitizeSummary(''), FALLBACK_SUMMARY)
  assert.strictEqual(sanitizeSummary(undefined), FALLBACK_SUMMARY)
  assert.strictEqual(sanitizeSummary('x'.repeat(500)).length, SUMMARY_MAX)
})
await test('shouldRefreshToken: expired/near/unknown → refresh; healthy → no', () => {
  const n = NOW.getTime()
  assert.ok(shouldRefreshToken(null, n))
  assert.ok(shouldRefreshToken('garbage', n))
  assert.ok(shouldRefreshToken(new Date(n + 60_000).toISOString(), n))       // <2min
  assert.ok(!shouldRefreshToken(new Date(n + 3_600_000).toISOString(), n))   // 1h
})
await test('validateRefreshResponse strict; refresh_token optional', () => {
  assert.ok(!validateRefreshResponse(null).ok)
  assert.ok(!validateRefreshResponse({ access_token: '', expires_in: 3600 }).ok)
  assert.ok(!validateRefreshResponse({ access_token: 'a', expires_in: 0 }).ok)
  const a = validateRefreshResponse({ access_token: 'a', expires_in: 3600 })
  assert.ok(a.ok && a.refreshToken === null)
  const b = validateRefreshResponse({ access_token: 'a', expires_in: 3600, refresh_token: 'r' })
  assert.strictEqual(b.refreshToken, 'r')
})

// ── buildOccurrencePlan (relevance + fingerprint integration) ─────────────────
console.log('\nbuildOccurrencePlan')

const contacts = [
  { id: 'c1', email: 'priya@goldman.com' },
  { id: 'c2', email: 'raj@jane.com' },
  { id: 'c3', email: 'sam@kkr.com' },
]
const connectedEmail = 'me@student.edu'
const planArgs = (event) => ({ event, connectedEmail, contacts, now: NOW, fallbackTimeZone: 'UTC', subtle: SUBTLE, googleSub: 'sub-1', connectionId: 'conn-1', runId: 'run-1', userId: 'u1', calendarId: 'primary' })
function timedEvent(o = {}) {
  return {
    id: 'evt-1', status: 'confirmed', summary: 'Coffee with Priya',
    start: { dateTime: '2026-08-01T15:00:00Z' }, end: { dateTime: '2026-08-01T16:00:00Z' },
    organizer: { email: 'me@student.edu' },
    attendees: [{ email: 'me@student.edu', self: true, responseStatus: 'accepted' }, { email: 'priya@goldman.com', responseStatus: 'accepted' }],
    ...o,
  }
}

await test('one matched contact → Coffee chat, one candidate + keep fp', async () => {
  const p = await buildOccurrencePlan(planArgs(timedEvent()))
  assert.strictEqual(p.candidates.length, 1)
  assert.strictEqual(p.candidates[0].p_proposed_type, 'Coffee chat')
  assert.strictEqual(p.candidates[0].p_contact_id, 'c1')
  assert.strictEqual(p.candidates[0].p_proposed_notes, 'Coffee with Priya')
  assert.strictEqual(p.candidates[0].p_source_last_state, 'active')
  assert.match(p.candidates[0].p_source_fingerprint, /^[0-9a-f]{64}$/)
  assert.strictEqual(p.keepFingerprints.length, 1)
  assert.ok(p.reconcile)
})
await test('multiple matched contacts → Event, one candidate each', async () => {
  const ev = timedEvent({ attendees: [
    { email: 'me@student.edu', self: true, responseStatus: 'accepted' },
    { email: 'priya@goldman.com', responseStatus: 'accepted' },
    { email: 'raj@jane.com', responseStatus: 'accepted' },
    { email: 'sam@kkr.com', responseStatus: 'accepted' },
  ] })
  const p = await buildOccurrencePlan(planArgs(ev))
  assert.strictEqual(p.candidates.length, 3)
  for (const c of p.candidates) assert.strictEqual(c.p_proposed_type, 'Event')
  assert.strictEqual(new Set(p.keepFingerprints).size, 3)
})
await test('ambiguous duplicate-email contact excluded → empty keep, reconcile', async () => {
  const dup = [{ id: 'a', email: 'dup@x.com' }, { id: 'b', email: 'dup@x.com' }]
  const ev = timedEvent({ attendees: [{ email: 'dup@x.com', responseStatus: 'accepted' }] })
  const p = await buildOccurrencePlan({ ...planArgs(ev), contacts: dup })
  assert.strictEqual(p.candidates.length, 0)
  assert.deepStrictEqual(p.keepFingerprints, [])
  assert.ok(p.reconcile)
})
await test('timed event with offset but no IANA zone → date from offset, not UTC', async () => {
  // 23:00-04:00 on 08-01 is 03:00Z on 08-02; the correct interaction date is 08-01.
  const ev = timedEvent({ start: { dateTime: '2026-08-01T23:00:00-04:00' }, end: { dateTime: '2026-08-01T23:30:00-04:00' } })
  const p = await buildOccurrencePlan(planArgs(ev))
  assert.strictEqual(p.candidates.length, 1)
  assert.strictEqual(p.candidates[0].p_proposed_interaction_date, '2026-08-01')
})
await test('timed event with naive dateTime (no offset) → skip (undeterminable date)', async () => {
  const ev = timedEvent({ start: { dateTime: '2026-08-01T15:00:00' }, end: { dateTime: '2026-08-01T16:00:00' } })
  const p = await buildOccurrencePlan(planArgs(ev))
  assert.ok(p.skip)
})
await test('all-day completed event → date occurrence + interaction date', async () => {
  const ev = { id: 'evt-ad', status: 'confirmed', summary: 'Conf', start: { date: '2026-08-01' }, end: { date: '2026-08-02' }, organizer: { email: 'me@student.edu' }, attendees: [{ email: 'priya@goldman.com', responseStatus: 'accepted' }] }
  const p = await buildOccurrencePlan(planArgs(ev))
  assert.strictEqual(p.candidates.length, 1)
  assert.strictEqual(p.candidates[0].p_original_occurrence_date, '2026-08-01')
  assert.strictEqual(p.candidates[0].p_original_occurrence_at, null)
  assert.strictEqual(p.candidates[0].p_proposed_interaction_date, '2026-08-01')
  assert.strictEqual(p.candidates[0].p_event_start_date, '2026-08-01')
})
await test('cancelled event → reconcile-only with empty keep-set', async () => {
  const ev = timedEvent({ status: 'cancelled', originalStartTime: { dateTime: '2026-08-01T15:00:00Z' } })
  const p = await buildOccurrencePlan(planArgs(ev))
  assert.strictEqual(p.candidates.length, 0)
  assert.deepStrictEqual(p.keepFingerprints, [])
  assert.ok(p.reconcile)
  assert.strictEqual(p.occurrence.value, '2026-08-01T15:00:00.000Z')
})
await test('cancelled event with no occurrence → skip', async () => {
  const p = await buildOccurrencePlan(planArgs({ id: 'evt-x', status: 'cancelled' }))
  assert.ok(p.skip)
})
await test('future / not-completed event → skip', async () => {
  const ev = timedEvent({ start: { dateTime: '2026-09-01T15:00:00Z' }, end: { dateTime: '2026-09-01T16:00:00Z' } })
  const p = await buildOccurrencePlan(planArgs(ev))
  assert.ok(p.skip); assert.strictEqual(p.reason, 'not_completed')
})
await test('user declined → completed but empty keep-set (reconcile)', async () => {
  const ev = timedEvent({ attendees: [{ email: 'me@student.edu', self: true, responseStatus: 'declined' }, { email: 'priya@goldman.com', responseStatus: 'accepted' }] })
  const p = await buildOccurrencePlan(planArgs(ev))
  assert.strictEqual(p.candidates.length, 0)
  assert.ok(p.reconcile)
})
await test('malformed event (no id) throws → caller skips', async () => {
  await assert.rejects(() => buildOccurrencePlan(planArgs({ status: 'confirmed', start: { dateTime: '2026-08-01T15:00:00Z' }, end: { dateTime: '2026-08-01T16:00:00Z' } })))
})
await test('recurring occurrence fingerprint stable through reschedule', async () => {
  const a = await buildOccurrencePlan(planArgs(timedEvent({ originalStartTime: { dateTime: '2026-08-01T15:00:00Z' }, start: { dateTime: '2026-08-01T15:00:00Z' } })))
  const b = await buildOccurrencePlan(planArgs(timedEvent({ originalStartTime: { dateTime: '2026-08-01T15:00:00Z' }, start: { dateTime: '2026-08-03T09:00:00Z' }, end: { dateTime: '2026-08-03T10:00:00Z' } })))
  assert.strictEqual(a.keepFingerprints[0], b.keepFingerprints[0])
})
await test('idempotent: same event yields identical fingerprint across runs', async () => {
  const a = await buildOccurrencePlan(planArgs(timedEvent()))
  const b = await buildOccurrencePlan(planArgs(timedEvent()))
  assert.strictEqual(a.keepFingerprints[0], b.keepFingerprints[0])
})
await test('no attendee emails / descriptions leak into candidate note', async () => {
  const ev = timedEvent({ summary: 'Chat', description: 'secret notes', location: 'Room 5', hangoutLink: 'https://meet' })
  const p = await buildOccurrencePlan(planArgs(ev))
  const c = p.candidates[0]
  const blob = JSON.stringify(c)
  assert.ok(!blob.includes('secret notes') && !blob.includes('Room 5') && !blob.includes('meet'))
  assert.ok(!blob.includes('priya@goldman.com'))   // attendee email never stored in candidate args? (email is not in args)
})

// ── Orchestration (runCalendarSync) with mocked deps ──────────────────────────
console.log('\nrunCalendarSync orchestration')

function makeDeps(over = {}) {
  const rec = { upserts: [], reconciles: [], releases: [], renews: 0, claims: 0, markReauth: 0, stores: [], logs: [], urls: [], refreshCalls: 0 }
  const pages = over.pages ?? [{ status: 200, json: { items: [timedEvent()] } }]
  let pageIdx = 0
  const deps = {
    method: over.method ?? 'POST',
    now: () => over.now ?? NOW,
    subtle: SUBTLE,
    log: (o) => rec.logs.push(o),
    getUser: over.getUser ?? (async () => ({ userId: 'u1' })),
    loadConnection: over.loadConnection ?? (async () => ({
      connection: { id: 'conn-1', google_sub: 'sub-1', google_email: connectedEmail, status: 'active', token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString() },
      tokenRow: { access_token_ciphertext: 'ACT', access_token_nonce: 'AN', refresh_token_ciphertext: 'RCT', refresh_token_nonce: 'RN' },
    })),
    loadContacts: over.loadContacts ?? (async () => contacts),
    decrypt: over.decrypt ?? (async (ct) => (ct === 'RCT' ? 'REFRESH' : 'ACCESS')),
    encrypt: over.encrypt ?? (async (p) => ({ ciphertext: `E(${p})`, nonce: `N(${p})` })),
    refreshAccessToken: over.refreshAccessToken ?? (async () => { rec.refreshCalls++; return { status: 200, json: { access_token: 'NEWACC', expires_in: 3600 } } }),
    fetchEventsPage: over.fetchEventsPage ?? (async ({ url }) => { rec.urls.push(url); const p = pages[pageIdx] ?? { status: 200, json: { items: [] } }; pageIdx++; return p }),
    rpc: {
      claimLease: over.claimLease ?? (async () => { rec.claims++; return 'run-1' }),
      renewLease: over.renewLease ?? (async () => { rec.renews++; return true }),
      releaseLease: async (c, r, status, err, complete) => { rec.releases.push({ status, err, complete }); return over.releaseLeaseResult !== undefined ? over.releaseLeaseResult : true },
      upsertCandidate: over.upsertCandidate ?? (async (a) => { rec.upserts.push(a); return 'cand' }),
      reconcileOccurrence: over.reconcileOccurrence ?? (async (a) => { rec.reconciles.push(a); return 0 }),
      storeRefreshedToken: over.storeRefreshedToken ?? (async (a) => { rec.stores.push(a); return true }),
      markNeedsReauth: over.markNeedsReauth ?? (async () => { rec.markReauth++; return true }),
    },
  }
  return { deps, rec }
}

await test('method gate: non-POST → 405', async () => {
  const { deps } = makeDeps({ method: 'GET' })
  assert.strictEqual((await runCalendarSync(deps)).status, 405)
})
await test('auth gate: no user → 401, no lease claimed', async () => {
  const { deps, rec } = makeDeps({ getUser: async () => null })
  assert.strictEqual((await runCalendarSync(deps)).status, 401)
  assert.strictEqual(rec.claims, 0)
})
await test('not connected → 409, no lease', async () => {
  const { deps, rec } = makeDeps({ loadConnection: async () => null })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'not_connected'); assert.strictEqual(rec.claims, 0)
})
await test('needs_reauth connection → 409 reauth_required', async () => {
  const { deps } = makeDeps({ loadConnection: async () => ({ connection: { id: 'conn-1', google_sub: 'sub-1', google_email: connectedEmail, status: 'needs_reauth', token_expires_at: null }, tokenRow: {} }) })
  const r = await runCalendarSync(deps); assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'reauth_required')
})
await test('held lease → 409 sync_in_progress, no release', async () => {
  const { deps, rec } = makeDeps({ claimLease: async () => null })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'sync_in_progress'); assert.strictEqual(rec.releases.length, 0)
})
await test('happy path: active token, 1 candidate, released idle/complete', async () => {
  const { deps, rec } = makeDeps()
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, 'completed')
  assert.strictEqual(r.body.candidates_written, 1)
  assert.strictEqual(rec.upserts.length, 1)
  assert.strictEqual(rec.reconciles.length, 1)
  assert.deepStrictEqual(rec.releases, [{ status: 'idle', err: null, complete: true }])
  assert.strictEqual(rec.refreshCalls, 0)   // healthy token → no refresh
})
await test('fixed window/query: timeMin=now-90d, timeMax=now, no caller control', async () => {
  const { deps, rec } = makeDeps()
  await runCalendarSync(deps)
  const q = new URL(rec.urls[0]).searchParams
  assert.strictEqual(q.get('timeMax'), NOW.toISOString())
  assert.strictEqual(q.get('timeMin'), new Date(NOW.getTime() - WINDOW_DAYS * 86_400_000).toISOString())
  assert.strictEqual(q.get('singleEvents'), 'true')
  assert.strictEqual(q.get('showDeleted'), 'true')
})
await test('near-expiry → refresh path, store called, refresh preserved when omitted', async () => {
  const { deps, rec } = makeDeps({
    loadConnection: async () => ({ connection: { id: 'conn-1', google_sub: 'sub-1', google_email: connectedEmail, status: 'active', token_expires_at: new Date(NOW.getTime() + 30_000).toISOString() }, tokenRow: { access_token_ciphertext: 'ACT', access_token_nonce: 'AN', refresh_token_ciphertext: 'RCT', refresh_token_nonce: 'RN' } }),
    refreshAccessToken: async () => ({ status: 200, json: { access_token: 'NEWACC', expires_in: 3600 } }),  // no refresh_token
  })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(rec.stores.length, 1)
  assert.strictEqual(rec.stores[0].refreshCt, null)   // omitted → null → RPC preserves existing
  assert.strictEqual(rec.stores[0].expectedGoogleSub, 'sub-1')
})
await test('refresh returns a replacement refresh token → stored', async () => {
  const { deps, rec } = makeDeps({
    loadConnection: async () => ({ connection: { id: 'conn-1', google_sub: 'sub-1', google_email: connectedEmail, status: 'active', token_expires_at: null }, tokenRow: { access_token_ciphertext: 'ACT', access_token_nonce: 'AN', refresh_token_ciphertext: 'RCT', refresh_token_nonce: 'RN' } }),
    refreshAccessToken: async () => ({ status: 200, json: { access_token: 'A', expires_in: 3600, refresh_token: 'NEWREFRESH' } }),
  })
  await runCalendarSync(deps)
  assert.strictEqual(rec.stores[0].refreshCt, 'E(NEWREFRESH)')
})
await test('invalid_grant on refresh → markNeedsReauth + 409 + release error', async () => {
  const { deps, rec } = makeDeps({
    loadConnection: async () => ({ connection: { id: 'conn-1', google_sub: 'sub-1', google_email: connectedEmail, status: 'active', token_expires_at: null }, tokenRow: { access_token_ciphertext: 'ACT', access_token_nonce: 'AN', refresh_token_ciphertext: 'RCT', refresh_token_nonce: 'RN' } }),
    refreshAccessToken: async () => ({ status: 400, json: { error: 'invalid_grant' } }),
  })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'reauth_required')
  assert.strictEqual(rec.markReauth, 1)
  assert.strictEqual(rec.releases[0].status, 'error')
})
await test('transient refresh failure (500) → 503, NOT needs_reauth', async () => {
  const { deps, rec } = makeDeps({
    loadConnection: async () => ({ connection: { id: 'conn-1', google_sub: 'sub-1', google_email: connectedEmail, status: 'active', token_expires_at: null }, tokenRow: { access_token_ciphertext: 'ACT', access_token_nonce: 'AN', refresh_token_ciphertext: 'RCT', refresh_token_nonce: 'RN' } }),
    refreshAccessToken: async () => ({ status: 503, json: null }),
  })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 503); assert.strictEqual(rec.markReauth, 0)
})
await test('missing refresh token on near-expiry → needs_reauth', async () => {
  const { deps, rec } = makeDeps({
    loadConnection: async () => ({ connection: { id: 'conn-1', google_sub: 'sub-1', google_email: connectedEmail, status: 'active', token_expires_at: null }, tokenRow: { access_token_ciphertext: 'ACT', access_token_nonce: 'AN', refresh_token_ciphertext: null, refresh_token_nonce: null } }),
  })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'reauth_required'); assert.strictEqual(rec.markReauth, 1)
})
await test('Calendar 401 → one refresh+retry, then success', async () => {
  let call = 0
  const { deps, rec } = makeDeps({
    fetchEventsPage: async () => { call++; return call === 1 ? { status: 401, json: null } : { status: 200, json: { items: [timedEvent()] } } },
  })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 200)
  assert.strictEqual(rec.refreshCalls, 1)
  assert.strictEqual(call, 2)
})
await test('Calendar 401 twice → markNeedsReauth + 409', async () => {
  const { deps, rec } = makeDeps({ fetchEventsPage: async () => ({ status: 401, json: null }) })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'reauth_required'); assert.strictEqual(rec.markReauth, 1)
})
await test('Calendar 429 → 429 provider_rate_limited + release error', async () => {
  const { deps, rec } = makeDeps({ fetchEventsPage: async () => ({ status: 429, json: null }) })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.status, 429); assert.strictEqual(rec.releases[0].status, 'error')
})
await test('Calendar 5xx → 503 provider_unavailable', async () => {
  const { deps } = makeDeps({ fetchEventsPage: async () => ({ status: 500, json: null }) })
  assert.strictEqual((await runCalendarSync(deps)).status, 503)
})
await test('malformed JSON page → 502 provider_error', async () => {
  const { deps } = makeDeps({ fetchEventsPage: async () => ({ status: 200, json: null }) })
  assert.strictEqual((await runCalendarSync(deps)).status, 502)
})
await test('malformed items collection → 502', async () => {
  const { deps } = makeDeps({ fetchEventsPage: async () => ({ status: 200, json: { items: 'nope' } }) })
  assert.strictEqual((await runCalendarSync(deps)).status, 502)
})
await test('pagination preserves window; renews lease between pages', async () => {
  let i = 0
  const { deps, rec } = makeDeps({
    fetchEventsPage: async ({ url }) => { rec.urls.push(url); i++; return i === 1 ? { status: 200, json: { items: [timedEvent()], nextPageToken: 'TOK2' } } : { status: 200, json: { items: [timedEvent({ id: 'evt-2' })] } } },
  })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.body.pages, 2)
  assert.strictEqual(rec.renews, 1)
  const q1 = new URL(rec.urls[0]).searchParams, q2 = new URL(rec.urls[1]).searchParams
  assert.strictEqual(q1.get('timeMin'), q2.get('timeMin'))
  assert.strictEqual(q1.get('timeMax'), q2.get('timeMax'))
  assert.strictEqual(q1.get('pageToken'), null)
  assert.strictEqual(q2.get('pageToken'), 'TOK2')
})
await test('repeated page token → incomplete (no loop)', async () => {
  const { deps, rec } = makeDeps({ fetchEventsPage: async () => ({ status: 200, json: { items: [], nextPageToken: 'SAMETOKEN' } }) })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.body.status, 'incomplete')
  assert.ok(rec.urls.length <= 2)   // first page + one follow of SAMETOKEN, then repeat detected
  assert.strictEqual(rec.releases[0].complete, false)
})
await test('final release failure (lease reclaimed → false) → incomplete, not completed', async () => {
  const { deps } = makeDeps({ releaseLeaseResult: false })   // run-ID fence: 0 rows updated
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.body.status, 'incomplete')
})
await test('MAX_PAGES cap → incomplete (released error)', async () => {
  const { deps, rec } = makeDeps({ fetchEventsPage: async () => ({ status: 200, json: { items: [], nextPageToken: 'MORE' } }) })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.body.status, 'incomplete')
  assert.ok(rec.urls.length <= MAX_PAGES)
  assert.strictEqual(rec.releases[0].complete, false)
})
await test('malformed single event skipped → run is INCOMPLETE (honest), not completed', async () => {
  const { deps, rec } = makeDeps({ fetchEventsPage: async () => ({ status: 200, json: { items: [{ status: 'confirmed', start: { dateTime: '2026-08-01T15:00:00Z' }, end: { dateTime: '2026-08-01T16:00:00Z' } }, timedEvent()] } }) })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.body.status, 'incomplete')   // a skipped/unparseable event cannot claim complete
  assert.strictEqual(r.body.events_skipped, 1)
  assert.strictEqual(r.body.candidates_written, 1)
  assert.strictEqual(rec.releases[0].complete, false)   // completion metadata not advanced
})
await test('candidate write failure → incomplete, release error, no success', async () => {
  const { deps, rec } = makeDeps({ upsertCandidate: async () => { throw new Error('db') } })
  const r = await runCalendarSync(deps)
  assert.strictEqual(r.body.status, 'incomplete')
  assert.strictEqual(rec.releases[0].complete, false)
})
await test('reconcile called once per processed occurrence with keep-set', async () => {
  const { deps, rec } = makeDeps()
  await runCalendarSync(deps)
  assert.strictEqual(rec.reconciles.length, 1)
  assert.strictEqual(rec.reconciles[0].p_keep_fingerprints.length, 1)
  assert.strictEqual(rec.reconciles[0].p_run_id, 'run-1')
})
await test('cancelled event in scan → reconcile with empty keep-set (invalidation path)', async () => {
  const { deps, rec } = makeDeps({ fetchEventsPage: async () => ({ status: 200, json: { items: [timedEvent({ status: 'cancelled', originalStartTime: { dateTime: '2026-08-01T15:00:00Z' } })] } }) })
  await runCalendarSync(deps)
  assert.strictEqual(rec.upserts.length, 0)
  assert.strictEqual(rec.reconciles.length, 1)
  assert.deepStrictEqual(rec.reconciles[0].p_keep_fingerprints, [])
})
await test('no sensitive data in response body or logs', async () => {
  const { deps, rec } = makeDeps()
  const r = await runCalendarSync(deps)
  const blob = JSON.stringify(r.body) + JSON.stringify(rec.logs)
  for (const s of ['priya@goldman.com', 'me@student.edu', 'sub-1', 'ACCESS', 'REFRESH', 'evt-1', 'conn-1', 'run-1', 'Coffee with Priya', 'RCT']) {
    assert.ok(!blob.includes(s), `leaked: ${s}`)
  }
})
await test('sync_token is never referenced in engine CODE (only in comments; deferred in C1)', async () => {
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('../supabase/functions/shared/calendarSyncEngine.js', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.ok(!/sync_token/.test(code), 'sync_token must not appear in engine code')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
