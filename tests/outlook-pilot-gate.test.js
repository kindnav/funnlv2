// THE SINGLE-ACCOUNT PILOT GATE — the only thing that actually limits who can connect
// Outlook or be imported.
//
// WHY IT IS NEEDED, traced rather than assumed. Before this gate every server-side control
// on the Outlook path was all-or-nothing:
//   * `outlook-oauth-start` checked OUTLOOK_INTEGRATION_ENABLED, then an Authorization
//     header, then `getUser()` - and then minted a state for ANY authenticated Funnl user;
//   * `reserve_due_outlook_connection` selects on `c.status = 'active' AND needs_reauth IS
//     FALSE AND consented_at IS NOT NULL` with no user predicate, so it picks whichever
//     connection is DUE, for anyone.
// Neither of those can be narrowed to one person, and two things that look like controls
// are not:
//   * VITE_OUTLOOK_CONNECTION_ENABLED / SUGGESTION_REVIEW_ENABLED are client-side build
//     flags. They decide what a bundle renders; a flag in a browser cannot refuse a
//     request.
//   * invoking the worker by hand restricts nothing, because the RESERVATION chooses the
//     connection, not the caller.
//
// WHAT IS PROVEN HERE: the predicate, the import path refusing a second authenticated
// user, and that the refusal happens before any provider request or database write -
// including before the token refresh and rotation that loadRunContext performs.
//
// WHERE THE REST IS PROVEN, because a source assertion is not behavioural coverage:
//   * the OAuth start endpoint is EXECUTED against the real Deno handler in
//     tests/outlook-start-integration.test.js - 403 not_in_pilot for another
//     authenticated user with ZERO state inserts and no binding cookie, fail-closed
//     when the designation is unset or malformed, and one state minted for the
//     designated account (opt-in: FUNNL_EDGE_INTEGRATION=1);
//   * the RESERVATION narrowing is proved against a real Postgres in
//     tests/sql/outlook-pilot-reservation-runtime.sql, and over real HTTP through the
//     real worker handler in tests/local/outlook-worker-token-access.mjs.
// The structural checks below remain only for ORDERING, which no single request can
// show: that the configuration check precedes the reservation and the owner check
// precedes the context load.
//
// Run with: node tests/outlook-pilot-gate.test.js

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  PILOT_USER_ENV, PILOT_REFUSALS, checkPilotUser, summarizePilotDecision,
} from '../supabase/functions/shared/outlookPilotGate.js'
import {
  outlookPilotViewer, OUTLOOK_PILOT_VIEWER_ID,
} from '../src/lib/outlookConnection.js'
import {
  runOutlookImport, summarizeRun, RUN_OUTCOMES,
} from '../supabase/functions/shared/outlookImportRun.js'
import {
  REQUIRED_CONFIG, missingConfig, statusForOutcome, OK_OUTCOMES,
} from '../supabase/functions/outlook-import-worker/handler.js'
import { GRAPH_BASE } from '../supabase/functions/shared/outlookGraphTransport.js'
import { makeRoundStore } from './harness/outlookRoundStore.js'

let passed = 0, failed = 0
const pending = []
function test (name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { passed += 1; console.log(`  ✓ ${name}`) },
        (e) => { failed += 1; console.log(`  ✗ ${name}`); console.log(`    ${e.message}`) },
      ))
      return
    }
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
  }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
// The start endpoint carries one literal control byte where `\x00` was intended inside a
// regex class (behaviourally identical, but it makes the file binary to grep). Replaced on
// read so these scans are not at its mercy.
const START_SRC = read('supabase/functions/outlook-oauth-start/index.ts')
  .replace(new RegExp(String.fromCharCode(0), 'g'), 'CTRL')
const GATE_SRC = read('supabase/functions/shared/outlookPilotGate.js')
// Strips comments, for assertions about what the code DOES rather than what it explains -
// this gate's whole doc comment is about what is NOT a restriction, and names those things.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PILOT = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const CONN = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const RUN = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr'
const CONTACT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ME = 'student@getfunnl.test'
const OTHER_PARTY = 'ava@bank.test'

console.log('\nthe predicate: fails CLOSED, and only on an exact designation')

test('an exact match is in the pilot; a different user is not', () => {
  assert.deepStrictEqual(checkPilotUser(PILOT, PILOT), { ok: true })
  assert.deepStrictEqual(checkPilotUser(PILOT, OTHER), { ok: false, reason: 'not_in_pilot' })
})

test('NOTHING is in the pilot when no account is designated', () => {
  // The security property: enabling Outlook without naming the pilot account must open it
  // to nobody, not to everybody. A gate that failed open here would make
  // OUTLOOK_INTEGRATION_ENABLED=true an all-users switch by omission.
  for (const absent of [undefined, null, '', '   ', 0, false, {}, []]) {
    assert.deepStrictEqual(checkPilotUser(absent, PILOT),
      { ok: false, reason: 'pilot_not_configured' }, JSON.stringify(absent))
  }
})

test('a designation that is not a uuid cannot read as "everyone"', () => {
  for (const sloppy of ['*', 'true', 'all', 'any', '%', PILOT.slice(0, 20),
    PILOT + 'x', 'not-a-uuid', '11111111_1111_1111_1111_111111111111']) {
    assert.deepStrictEqual(checkPilotUser(sloppy, PILOT),
      { ok: false, reason: 'pilot_not_configured' }, sloppy)
  }
})

test('the designation tolerates dashboard whitespace and casing, nothing else', () => {
  assert.strictEqual(checkPilotUser(` ${PILOT} `, PILOT).ok, true)
  assert.strictEqual(checkPilotUser(PILOT.toUpperCase(), PILOT).ok, true)
  assert.strictEqual(checkPilotUser(PILOT, PILOT.toUpperCase()).ok, true)
  // A candidate that is absent or empty is never in the pilot, whatever is configured.
  for (const absent of [undefined, null, '', '  ']) {
    assert.deepStrictEqual(checkPilotUser(PILOT, absent),
      { ok: false, reason: 'not_in_pilot' }, JSON.stringify(absent))
  }
})

test('a refusal log names neither the caller nor the designated account', () => {
  const blob = JSON.stringify(summarizePilotDecision(checkPilotUser(PILOT, OTHER)))
  assert.ok(!blob.includes(PILOT) && !blob.includes(OTHER),
    'an access-control log must not become a record of who tried')
  assert.deepStrictEqual(JSON.parse(blob), { in_pilot: false, reason: 'not_in_pilot' })
  assert.deepStrictEqual(summarizePilotDecision(checkPilotUser(PILOT, PILOT)),
    { in_pilot: true, reason: null })
  // An unknown reason is dropped rather than echoed.
  assert.strictEqual(summarizePilotDecision({ ok: false, reason: 'invented' }).reason, null)
  for (const r of PILOT_REFUSALS) assert.strictEqual(typeof r, 'string')
})

console.log('\nthe OAuth start endpoint refuses a second authenticated user')

test('the gate is applied AFTER authentication and BEFORE a state is minted', () => {
  // Order is the property: it must not be possible to learn the designated account by
  // probing unauthenticated, and no state row may exist for a refused caller.
  const auth = START_SRC.indexOf('auth.getUser()')
  const gate = START_SRC.indexOf('checkPilotUser(')
  const mint = START_SRC.indexOf(".from('microsoft_oauth_states').insert(")
  assert.ok(auth > 0 && gate > auth, 'the pilot gate must follow authentication')
  assert.ok(mint > gate, 'no state may be minted before the pilot gate')
  assert.ok(mint > 0, 'the persist statement must still be recognisable here')
})

test('it reads the designation from the FUNCTION ENVIRONMENT, not from the request', () => {
  assert.ok(START_SRC.includes(`Deno.env.get(PILOT_USER_ENV)`),
    'the designation must come from the environment')
  assert.strictEqual(PILOT_USER_ENV, 'OUTLOOK_PILOT_USER_ID')
  // Not from the caller: a body- or header-supplied pilot id would be no gate at all.
  assert.ok(!/pilot[A-Za-z]*\s*=\s*(body|req\.|headers)/i.test(START_SRC))
  assert.ok(START_SRC.includes("return json({ error: 'not_in_pilot' }, 403)"),
    'a refused caller gets a controlled 403')
})

test('the designation is never committed to the repo or shipped to a browser', () => {
  // The value belongs in the function environment only. A VITE_ prefix would put it in the
  // bundle, and a literal uuid in the gate would hard-code one tenant.
  // Its prose names VITE_OUTLOOK_CONNECTION_ENABLED to explain why a build flag is not
  // access control, so scan the CODE rather than the commentary.
  assert.ok(!code(GATE_SRC).includes('VITE_'),
    'the designation must not be a build flag')
  assert.ok(!code(GATE_SRC).includes('import.meta.env'))
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(GATE_SRC),
    'no uuid may be hard-coded in the gate')
  for (const f of ['supabase/config.toml', '.env.example']) {
    let src = ''
    try { src = read(f) } catch { continue }
    assert.ok(!src.includes('OUTLOOK_PILOT_USER_ID'),
      `${f} must not carry the designation`)
  }
})

console.log('\nthe import path refuses a connection owned by anyone else')

test('gating START is SUFFICIENT: the callback cannot invent an owner', () => {
  // Why one gate covers connecting at all. The callback never MINTS a state - it only
  // READS one - and finalize_microsoft_connection takes the new connection's owner from
  // the state row (v_uid := v_state.user_id), never from the request. The states table is
  // service_role-only with RLS on, so an authenticated user cannot insert one either.
  // The gated start endpoint is therefore the ONLY source of a state, and a refused user
  // has nothing for the callback to finalize.
  const cb = read('supabase/functions/outlook-oauth-callback/handler.js')
    .replace(new RegExp(String.fromCharCode(0), 'g'), 'CTRL')
  assert.ok(cb.includes("from('microsoft_oauth_states')"), 'the callback reads state')
  assert.ok(!/microsoft_oauth_states'\)[\s\S]{0,120}\.insert\(/.test(cb),
    'the callback must never mint a state - only the gated start endpoint may')

  const mig = read('supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql')
  assert.ok(mig.includes('v_uid := v_state.user_id;'),
    'the connection owner must come from the state row, not from a parameter')
  // And only service_role can reach that table.
  for (const line of [
    'REVOKE ALL ON TABLE public.microsoft_oauth_states FROM authenticated;',
    'REVOKE ALL ON TABLE public.microsoft_oauth_states FROM anon;',
    'ALTER TABLE public.microsoft_oauth_states ENABLE ROW LEVEL SECURITY;',
  ]) assert.ok(mig.includes(line), line)
})

/** A complete, committable round for whichever owner the context reports. */
function harness ({ owner, pilotUserId, reportOwner = true }) {
  const store = makeRoundStore()
  const calls = []
  const graph = []
  const rpc = async (name, args) => {
    calls.push({ name, args })
    if (name === 'reserve_due_outlook_connection') {
      // The real RPC now narrows the selection with p_pilot_user_id and reports the
      // owner. This fixture does NOT apply the filter - it hands back whatever `owner`
      // says - so the run's own part-3 check is what is being exercised here. The
      // narrowing itself is proved against a real Postgres, in
      // tests/sql/outlook-pilot-reservation-runtime.sql and the local HTTP harness.
      return {
        data: {
          result: 'reserved',
          connection_id: CONN,
          ...(reportOwner ? { user_id: owner } : {}),
          run_id: RUN,
        },
        error: null,
      }
    }
    if (name === 'renew_outlook_sync_lease') return { data: true, error: null }
    if (name === 'upsert_outlook_interaction_candidate') {
      return { data: { result: 'created' }, error: null }
    }
    if (name === 'release_outlook_sync_lease') {
      if (args?.p_run_complete === true) store.commitRelease()
      return { data: true, error: null }
    }
    const s = await store.handle(name, args)
    return s === null ? { data: null, error: null } : s
  }
  const addr = (e) => ({ emailAddress: { address: e, name: 'x' } })
  const msg = (id, from, to, sent) => ({
    id, conversationId: 'c1', receivedDateTime: sent, sentDateTime: sent, isDraft: false,
    subject: 's', from: addr(from), sender: addr(from),
    toRecipients: to.map(addr), ccRecipients: [],
  })
  const fetchImpl = async (url) => {
    graph.push(url)
    const inbox = url.includes('/mailFolders/inbox/')
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        value: [inbox
          ? msg('in-1', OTHER_PARTY, [ME], '2026-09-20T14:00:00Z')
          : msg('out-1', ME, [OTHER_PARTY], '2026-09-21T09:00:00Z')],
        '@odata.deltaLink': `${GRAPH_BASE}/me/mailFolders/${inbox ? 'inbox' : 'sentitems'}/messages/delta?$deltatoken=D`,
      }),
    }
  }
  return {
    store, calls, graph,
    run: () => runOutlookImport({
      rpc,
      encryptCursor: async (l) => ({ ciphertext: `CT:${l}`, nonce: 'N', keyVersion: 1 }),
      decryptCursor: async (c) => String(c).replace(/^CT:/, ''),
      pilotUserId,
      loadRunContext: async () => ({
        primaryEmail: ME, userId: owner, timeZone: 'UTC',
        contacts: [{ id: CONTACT, user_id: owner, email: OTHER_PARTY }],
        cursors: {}, accessToken: 'tok',
        keyRing: { current: { keyBytes: new Uint8Array(32).fill(1), keyVersion: 1 } },
      }),
      deps: { fetchImpl },
    }),
  }
}

test('THE PILOT ACCOUNT imports normally, so the gate is not simply always-deny', async () => {
  const h = harness({ owner: PILOT, pilotUserId: PILOT })
  const r = await h.run()
  assert.strictEqual(r.outcome, 'committed', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.accepted, 1)
  assert.strictEqual(r.cursorsAdvanced, 2)
  assert.ok(h.graph.length > 0, 'the pilot account IS read')
})

test('A SECOND AUTHENTICATED USER cannot be imported, and nothing is touched', async () => {
  // The reservation handed the run someone else's connection - which is exactly what it
  // does, since it has no user predicate. The run must refuse it.
  const h = harness({ owner: OTHER, pilotUserId: PILOT })
  const r = await h.run()
  const s = summarizeRun(r)
  assert.strictEqual(r.outcome, 'not_in_pilot', JSON.stringify(s))
  assert.strictEqual(r.reason, 'not_in_pilot')
  // NO MAILBOX WAS READ.
  assert.strictEqual(h.graph.length, 0, 'not one Graph request may be made')
  // NOTHING was written and NO cursor advanced.
  assert.strictEqual(r.accepted, 0)
  assert.strictEqual(r.cursorsAdvanced, 0)
  assert.strictEqual(h.calls.filter((c) => c.name === 'upsert_outlook_interaction_candidate').length, 0)
  assert.strictEqual(h.calls.filter((c) => c.name === 'record_outlook_page_progress').length, 0,
    'no checkpoint may be written for a non-pilot connection')
  assert.strictEqual(h.store.conversations.size, 0)
  for (const f of ['inbox', 'sentitems']) {
    assert.strictEqual(h.store.folders[f].delta_link_ciphertext, null, f)
  }
  // And the lease is given back rather than held until it expires.
  const rel = h.calls.filter((c) => c.name === 'release_outlook_sync_lease')
  assert.strictEqual(rel.length, 1)
  assert.strictEqual(rel[0].args.p_run_complete, false)
  assert.strictEqual(rel[0].args.p_inbox_delta_ct, null)
})

test('with NO designation, NOBODY is imported - including the pilot account', async () => {
  for (const absent of [undefined, '', '*', 'true']) {
    const h = harness({ owner: PILOT, pilotUserId: absent })
    const r = await h.run()
    assert.strictEqual(r.outcome, 'not_in_pilot', JSON.stringify(absent))
    assert.strictEqual(r.reason, 'pilot_not_configured', JSON.stringify(absent))
    assert.strictEqual(h.graph.length, 0, 'not one Graph request may be made')
    assert.strictEqual(r.cursorsAdvanced, 0)
  }
})

test('the gate is applied in FOUR places, and the first three precede the token path',
  () => {
    // Ordering, by source position, because that is the property: the context load
    // refreshes an expired access token at Microsoft and persists it through
    // rotate_microsoft_access_token. Anything that decides access must come first.
    const run = read('supabase/functions/shared/outlookImportRun.js')
    const p1 = run.indexOf('PILOT GATE, PART 1')
    const reserve = run.indexOf("rpc('reserve_due_outlook_connection'")
    const p3 = run.indexOf('PILOT GATE, PART 3')
    const load = run.indexOf('await loadRunContext(')
    const p4 = run.indexOf('PILOT GATE, PART 4')
    for (const [name, at] of Object.entries({ p1, reserve, p3, load, p4 })) {
      assert.ok(at > 0, `landmark missing: ${name}`)
    }
    assert.ok(p1 < reserve, 'the configuration check must precede the reservation')
    assert.ok(reserve < p3 && p3 < load,
      'the owner check must follow the reservation and precede the context load')
    assert.ok(load < p4, 'part 4 is the post-load backstop')
    // And the loader really is the thing with the side effects, so the ordering matters.
    const ctx = read('supabase/functions/shared/outlookRunContext.js')
    assert.ok(ctx.includes('refreshAccessToken(') &&
      ctx.includes("rpc('rotate_microsoft_access_token'"),
    'loadRunContext must still be the module that refreshes and rotates')
  })

test('the DESIGNATION is passed to the reservation, so it can narrow', async () => {
  // The run must not rely on filtering after the fact: the reservation is what chooses
  // the connection, so it is what has to be told. Without this the excluded account is
  // leased, its token refreshed at Microsoft and the rotation stored before any refusal.
  const h = harness({ owner: PILOT, pilotUserId: PILOT })
  await h.run()
  const res = h.calls.find((c) => c.name === 'reserve_due_outlook_connection')
  assert.strictEqual(res.args.p_pilot_user_id, PILOT)
  // Normalized, not passed through raw: a designation is lower-cased and trimmed, and a
  // malformed one never reaches the call at all (it would fail on a uuid cast).
  const h2 = harness({ owner: PILOT, pilotUserId: ` ${PILOT.toUpperCase()} ` })
  await h2.run()
  assert.strictEqual(
    h2.calls.find((c) => c.name === 'reserve_due_outlook_connection').args.p_pilot_user_id,
    PILOT)
})

test('a reservation that does NOT report an owner is refused', async () => {
  // An older deployed reserve_due_outlook_connection returns no user_id. Treating that
  // as "no objection" would silently reinstate the all-users behaviour, so it fails
  // closed - and still before the context load, so no token is refreshed.
  const h = harness({ owner: PILOT, pilotUserId: PILOT, reportOwner: false })
  const r = await h.run()
  assert.strictEqual(r.outcome, 'not_in_pilot', JSON.stringify(summarizeRun(r)))
  assert.strictEqual(r.reason, 'not_in_pilot')
  assert.strictEqual(h.graph.length, 0)
  assert.deepStrictEqual(h.calls.map((c) => c.name),
    ['reserve_due_outlook_connection', 'release_outlook_sync_lease'])
})

test('a MALFORMED designation reserves NOTHING - not one database call', async () => {
  // Part 1 of the gate. Previously a run with no usable designation still reserved a
  // connection, loaded its context, refreshed an expired token at Microsoft and stored
  // the rotation before refusing. Now it never calls the database at all.
  for (const absent of [undefined, '', '   ', '*', 'true', 'all', PILOT.slice(0, 20)]) {
    const h = harness({ owner: PILOT, pilotUserId: absent })
    const r = await h.run()
    assert.strictEqual(r.outcome, 'not_in_pilot', JSON.stringify(absent))
    assert.strictEqual(r.reason, 'pilot_not_configured', JSON.stringify(absent))
    assert.deepStrictEqual(h.calls, [], `${JSON.stringify(absent)} still called the database`)
    assert.strictEqual(h.graph.length, 0)
  }
})

test('the refusal is BEFORE the round progress is read, not after', async () => {
  // Checked by call order rather than by outcome: a gate that ran after the progress read
  // would already have touched the round of an account it is about to refuse.
  const h = harness({ owner: OTHER, pilotUserId: PILOT })
  await h.run()
  const names = h.calls.map((c) => c.name)
  assert.deepStrictEqual(names, ['reserve_due_outlook_connection', 'release_outlook_sync_lease'],
    `only reserve and release may happen: ${JSON.stringify(names)}`)
})

console.log('\nthe worker refuses to run at all without a designation')

test('the DENO ENTRY actually reads the designation from the environment', () => {
  // The handler tests hand it a config object, so they cannot see whether anything
  // populates that object. This is the gap that check: pilotUserId was required by the
  // handler while index.ts never read OUTLOOK_PILOT_USER_ID, which would have refused a
  // deployed worker `config_missing` for ever - fail-closed, but impossible to ENABLE.
  const entry = read('supabase/functions/outlook-import-worker/index.ts')
  assert.ok(entry.includes('Deno.env.get(PILOT_USER_ENV)'),
    'index.ts must read the pilot designation from the environment')
  // And every other required key is sourced too, so this stays true as the list grows.
  const sources = {
    clientId: 'MICROSOFT_CLIENT_ID',
    clientSecret: 'MICROSOFT_CLIENT_SECRET',
    tokenKeyB64: 'MICROSOFT_TOKEN_ENCRYPTION_KEY_V1',
    fingerprintKey: 'OUTLOOK_FINGERPRINT_HMAC_KEY_V1',
    pilotUserId: 'PILOT_USER_ENV',
  }
  for (const key of REQUIRED_CONFIG) {
    const env = sources[key]
    assert.ok(env, `REQUIRED_CONFIG gained ${key} with no known environment source`)
    assert.ok(entry.includes("Deno.env.get('" + env + "')")
      || entry.includes('Deno.env.get(' + env + ')'),
    `index.ts must read ${env} for ${key}`)
  }
})

test('pilotUserId is REQUIRED configuration, refused with the other secrets', async () => {
  assert.ok(REQUIRED_CONFIG.includes('pilotUserId'))
  assert.deepStrictEqual(missingConfig({
    clientId: 'c', clientSecret: 's', tokenKeyB64: 'k', fingerprintKey: {},
  }), ['pilotUserId'])
  // And it is reported like any other absent key - a name, never a value.
  assert.deepStrictEqual(missingConfig({}), [...REQUIRED_CONFIG])
})

test('not_in_pilot is a controlled outcome and NOT a success', () => {
  assert.ok(RUN_OUTCOMES.includes('not_in_pilot'))
  assert.ok(!OK_OUTCOMES.includes('not_in_pilot'),
    'a refused account must not answer 200')
  assert.strictEqual(statusForOutcome('not_in_pilot'), 503)
  // The summary carries the code and no identity.
  const s = summarizeRun({ outcome: 'not_in_pilot', reason: 'not_in_pilot' })
  assert.strictEqual(s.outcome, 'not_in_pilot')
  assert.ok(!JSON.stringify(s).includes(PILOT))
})

console.log('\nwhat this gate is NOT')

test('it is one variable and one predicate, not a feature-flag framework', () => {
  // No registry, no generic resolver, no per-feature table. Two call sites, named.
  assert.ok(!/register|registry|FEATURE_FLAGS|flagFor|getFlag/i.test(code(GATE_SRC)))
  const callers = ['supabase/functions/outlook-oauth-start/index.ts',
    'supabase/functions/shared/outlookImportRun.js']
  for (const f of callers) {
    assert.ok(read(f).includes('checkPilotUser'), `${f} must use the gate`)
  }
  // And nothing else does, so the surface cannot drift without this test noticing.
  const all = ['supabase/functions/outlook-import-worker/handler.js',
    'supabase/functions/outlook-oauth-callback/handler.js']
  for (const f of all) {
    let src = ''
    try { src = read(f) } catch { continue }
    assert.ok(!src.includes('checkPilotUser('),
      `${f} must not add a third call site without updating this test`)
  }
})

test('the UI pilot check hides a dead end, and decides nothing', () => {
  // VITE_OUTLOOK_CONNECTION_ENABLED is global, so turning it on would offer the
  // Connect card to EVERY signed-in user and refuse all but one of them with 403
  // not_in_pilot. The viewer check hides that dead end. It is presentation only.
  assert.strictEqual(outlookPilotViewer(PILOT, PILOT), true)
  assert.strictEqual(outlookPilotViewer(PILOT, OTHER), false)
  // Fails closed in BOTH directions: no designation shows it to nobody, and no
  // viewer (still loading, or signed out) shows nothing.
  for (const absent of [undefined, null, '', '  ', '*', 'true', 'all',
    PILOT.slice(0, 20), 0, false, {}]) {
    assert.strictEqual(outlookPilotViewer(absent, PILOT), false, JSON.stringify(absent))
  }
  for (const absent of [undefined, null, '', '  ']) {
    assert.strictEqual(outlookPilotViewer(PILOT, absent), false, JSON.stringify(absent))
  }
  // Dashboard whitespace and casing tolerated, as on the server.
  assert.strictEqual(outlookPilotViewer(` ${PILOT.toUpperCase()} `, PILOT), true)
  // Outside Vite there is no import.meta.env, so the shipped constant is inert.
  assert.strictEqual(OUTLOOK_PILOT_VIEWER_ID, null)
  assert.strictEqual(outlookPilotViewer(OUTLOOK_PILOT_VIEWER_ID, PILOT), false)
})

test('the SERVER designation is never read from a VITE_ name', () => {
  // Everything VITE_ is compiled into a public bundle, so the authoritative value
  // must not come from one. The browser check deliberately uses its OWN variable,
  // VITE_OUTLOOK_PILOT_USER_ID, whose only job is hiding a control.
  const files = [
    'supabase/functions/shared/outlookPilotGate.js',
    'supabase/functions/outlook-oauth-start/index.ts',
    'supabase/functions/outlook-import-worker/index.ts',
    'supabase/functions/shared/outlookImportRun.js',
  ]
  for (const f of files) {
    const src = read(f).replace(new RegExp(String.fromCharCode(0), 'g'), 'CTRL')
    assert.ok(!code(src).includes('VITE_'), `${f} must not read a build-time flag`)
    assert.ok(!code(src).includes('import.meta.env'), f)
  }
  // And the browser side must not pretend to BE the gate: the authoritative name
  // may appear in src/ only with the VITE_ prefix.
  const ui = code(read('src/lib/outlookConnection.js'))
  const bare = ui.split(PILOT_USER_ENV).length - 1
  const prefixed = ui.split(`VITE_${PILOT_USER_ENV}`).length - 1
  assert.strictEqual(bare, prefixed,
    'src/ reads the server-side designation name without the VITE_ prefix')
  assert.ok(prefixed >= 1, 'the browser check must have its own variable')
})

test('the review flag is still a plain build flag, and names no account', () => {
  const gate = read('src/lib/suggestionReview.js')
  assert.ok(gate.includes('import.meta.env'), 'it is a build-time flag')
  assert.ok(!gate.includes('PILOT'), 'the review flag is not per-account')
})
await Promise.all(pending)
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
