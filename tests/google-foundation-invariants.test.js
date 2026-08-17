// Structural invariants for the Google OAuth foundation (Phase 0A). These are
// source-scan assertions over the migration, config, and Edge Function files:
//   - google_tokens is unreadable by authenticated (RLS on, no grant, no policy)
//   - google_connections exposes SELECT-own only (two-user isolation)
//   - google_oauth_states has RLS on and no client policy
//   - one Google connection per user (unique user_id)
//   - the callback function is verify_jwt=false; start/disconnect are not
//   - NO scope creep: no Gmail scope/API, no event fetching, no scheduler, no
//     Pub/Sub, no interaction candidates/source links, no auto-log, no AI here.
//
// Run with: node tests/google-foundation-invariants.test.js
import assert from 'assert'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

const migration = read('supabase/migrations/20260816000000_add_google_oauth_foundation.sql')
const config = read('supabase/config.toml')

// The migration text relevant to a table = its DDL + the following statements up
// to the next CREATE TABLE (covers ALTER/REVOKE/GRANT/POLICY for that table).
function tableSection(sql, name) {
  assert.ok(sql.indexOf(`CREATE TABLE public.${name}`) !== -1, `missing table ${name}`)
  const start = sql.indexOf(`CREATE TABLE public.${name}`)
  const after = sql.slice(start + 1)
  const nextCreate = after.indexOf('CREATE TABLE public.')
  return sql.slice(start, nextCreate === -1 ? undefined : start + 1 + nextCreate)
}

// ── google_tokens: unreadable by authenticated ────────────────────────────────
console.log('\ngoogle_tokens isolation')
const tokensSection = tableSection(migration, 'google_tokens')
test('google_tokens has RLS enabled', () => {
  assert.ok(/ALTER TABLE public\.google_tokens ENABLE ROW LEVEL SECURITY/.test(tokensSection))
})
test('google_tokens REVOKEs ALL from authenticated and does NOT grant it SELECT', () => {
  assert.ok(/REVOKE ALL ON TABLE public\.google_tokens FROM authenticated/.test(tokensSection))
  assert.ok(!/GRANT[^;]*ON TABLE public\.google_tokens TO authenticated/.test(tokensSection), 'no grant to authenticated')
})
test('google_tokens has NO RLS policy at all (service-role only)', () => {
  assert.ok(!/CREATE POLICY[^;]*ON public\.google_tokens/.test(tokensSection), 'no policy on google_tokens')
})
test('google_tokens grants ALL to service_role', () => {
  assert.ok(/GRANT ALL\s+ON TABLE public\.google_tokens TO service_role/.test(tokensSection))
})

// ── google_connections: SELECT-own only ───────────────────────────────────────
console.log('\ngoogle_connections isolation')
const connSection = tableSection(migration, 'google_connections')
test('RLS enabled', () => assert.ok(/ALTER TABLE public\.google_connections ENABLE ROW LEVEL SECURITY/.test(connSection)))
test('exactly a SELECT-own policy (two-user isolation)', () => {
  assert.ok(/CREATE POLICY "google_connections_select_own"[\s\S]*FOR SELECT[\s\S]*USING \(\(SELECT auth\.uid\(\)\) = user_id\)/.test(connSection))
})
test('no INSERT/UPDATE/DELETE policy for authenticated', () => {
  assert.ok(!/FOR (INSERT|UPDATE|DELETE)[\s\S]*public\.google_connections/.test(connSection))
})
test('one connection per user (unique user_id)', () => {
  assert.ok(/UNIQUE \(user_id\)/.test(connSection))
})

// ── google_oauth_states: RLS on, no client policy ─────────────────────────────
console.log('\ngoogle_oauth_states isolation')
const stateSection = tableSection(migration, 'google_oauth_states')
test('RLS enabled + no policy + service-role only', () => {
  assert.ok(/ALTER TABLE public\.google_oauth_states ENABLE ROW LEVEL SECURITY/.test(stateSection))
  assert.ok(!/CREATE POLICY[^;]*ON public\.google_oauth_states/.test(stateSection))
  assert.ok(/GRANT ALL\s+ON TABLE public\.google_oauth_states TO service_role/.test(stateSection))
})
test('stores a state HASH column, never a raw state column', () => {
  assert.ok(/state_hash\s+text\s+NOT NULL/.test(stateSection))
  assert.ok(!/\braw_state\b/.test(stateSection))
})
test('PKCE verifier is stored as ciphertext + nonce (encrypted)', () => {
  assert.ok(/pkce_verifier_ciphertext/.test(stateSection) && /pkce_verifier_nonce/.test(stateSection))
})

// ── config.toml verify_jwt ─────────────────────────────────────────────────────
console.log('\nconfig.toml verify_jwt')
test('callback is verify_jwt=false', () => {
  assert.ok(/\[functions\.google-oauth-callback\][\s\S]*verify_jwt\s*=\s*false/.test(config))
})
test('start and disconnect are NOT set to verify_jwt=false', () => {
  assert.ok(!/\[functions\.google-oauth-start\]/.test(config))
  assert.ok(!/\[functions\.google-oauth-disconnect\]/.test(config))
})

// ── No scope creep across all Google function/shared/lib files ────────────────
console.log('\nno scope creep')
const googleSources = [
  'supabase/functions/google-oauth-start/index.ts',
  'supabase/functions/google-oauth-callback/index.ts',
  'supabase/functions/google-oauth-disconnect/index.ts',
  'supabase/functions/shared/googleOauthHelpers.js',
  'supabase/functions/shared/googleTokenCrypto.js',
  'supabase/functions/shared/googleCleanup.js',
  'src/components/GoogleConnectionCard.jsx',
  'src/lib/googleConnection.js',
  migrationRel(),
].map(rel => ({ rel, text: read(rel) }))

function migrationRel() { return 'supabase/migrations/20260816000000_add_google_oauth_foundation.sql' }

// Target actual out-of-scope SURFACES (scopes / APIs / infra), not the mere
// mention of a word in explanatory copy (e.g. "Gmail integration is planned").
const FORBIDDEN = [
  /auth\/gmail|gmail\.googleapis\.com|gmail\.(readonly|metadata|modify|send|compose|labels|insert)/i, // no Gmail scope/API
  /calendar\/v3|googleapis\.com\/calendar|events\.list|calendarList/i,  // no Calendar event fetching
  /pubsub|googleapis\.com\/.*watch/i,         // no Pub/Sub / watch
  /pg_cron|cron\.schedule/i,                  // no scheduler
  /interaction_candidate|interaction_source_link/i, // no candidates/source links
  /auto[_-]?log/i,                            // no auto-logging
  /api\.anthropic\.com/i,                      // no AI calls here
]
for (const { rel, text } of googleSources) {
  test(`${rel} introduces no out-of-scope surface`, () => {
    for (const re of FORBIDDEN) {
      assert.ok(!re.test(text), `${rel} matched forbidden pattern ${re}`)
    }
  })
}

// Sanity: the intended read-only Calendar scope IS present in the helper.
test('helper requests calendar.events.readonly (in-scope)', () => {
  assert.ok(/calendar\.events\.readonly/.test(read('supabase/functions/shared/googleOauthHelpers.js')))
})

// No stray extra Google tables/functions beyond Phase 0A were added.
test('exactly three google_* tables defined in the migration', () => {
  const tables = [...migration.matchAll(/CREATE TABLE public\.(google_\w+)/g)].map(m => m[1]).sort()
  assert.deepStrictEqual(tables, ['google_connections', 'google_oauth_states', 'google_tokens'])
})
test('only the three google-oauth-* edge functions exist', () => {
  const fns = readdirSync(join(root, 'supabase/functions')).filter(n => n.startsWith('google'))
  assert.deepStrictEqual(fns.sort(), ['google-oauth-callback', 'google-oauth-disconnect', 'google-oauth-start'])
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
