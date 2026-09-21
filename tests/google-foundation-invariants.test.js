// Structural invariants for the Google OAuth foundation (Phase 0A). These are
// source-scan assertions over the migration, config, and Edge Function files:
//   - google_tokens is unreadable by authenticated (RLS on, no grant, no policy)
//   - google_connections exposes SELECT-own only (two-user isolation)
//   - google_oauth_states has RLS on and no client policy
//   - one Google connection per user (unique user_id)
//   - the callback function is verify_jwt=false; start/disconnect are not
//   - delete-account is explicitly verify_jwt=true (browser calls carry the user's
//     session JWT) and the handler ALSO authorizes via auth.getUser() before deleting
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

// ── delete-account: platform JWT verification + handler-side authorization ────
// delete-account is invoked from the browser through supabase.functions.invoke,
// which sends the user's session JWT in Authorization. verify_jwt = true keeps the
// platform check in front of the handler; the handler's own auth.getUser() is the
// second, mandatory layer. Pin both, plus the ordering that makes deletion safe.
console.log('\ndelete-account authentication')
const deleteAccountSrc = read('supabase/functions/delete-account/index.ts')
const FUNCTION_JWT_SETTINGS = {
  'google-oauth-callback': 'false',
  'google-calendar-sync': 'true',
  'delete-account': 'true',
  'gmail-oauth-start': 'true',
  'gmail-sync-worker': 'false',
}
// Non-comment, non-blank settings lines of one [functions.<name>] section.
function functionSectionSettings(name) {
  const header = `[functions.${name}]`
  const start = config.indexOf(header)
  assert.ok(start !== -1, `missing ${header}`)
  const rest = config.slice(start + header.length)
  const next = rest.search(/^\[/m)
  return rest.slice(0, next === -1 ? undefined : next)
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
}
const functionHeaders = () => (config.match(/^\[functions\.[^\]]+\]\s*$/gm) || []).map(h => h.trim())

test('config.toml declares exactly one [functions.delete-account] section', () => {
  const n = functionHeaders().filter(h => h === '[functions.delete-account]').length
  assert.strictEqual(n, 1, `found ${n} sections`)
})
test('the delete-account section has exactly one setting: verify_jwt = true', () => {
  assert.deepStrictEqual(functionSectionSettings('delete-account'), ['verify_jwt = true'])
})
test('config.toml has no duplicate [functions.*] section header', () => {
  const names = functionHeaders()
  assert.strictEqual(new Set(names).size, names.length, `duplicates among ${names.join(', ')}`)
})
test('every per-function verify_jwt setting is pinned (no other function sections exist)', () => {
  const names = functionHeaders().map(h => h.slice('[functions.'.length, -1)).sort()
  assert.deepStrictEqual(names, Object.keys(FUNCTION_JWT_SETTINGS).sort())
  for (const [name, value] of Object.entries(FUNCTION_JWT_SETTINGS)) {
    assert.deepStrictEqual(functionSectionSettings(name), [`verify_jwt = ${value}`], `${name} must be verify_jwt = ${value}`)
  }
})
test('handler reads the Authorization header and rejects its absence with 401', () => {
  assert.ok(deleteAccountSrc.includes("req.headers.get('Authorization')"))
  assert.ok(/if \(!authHeader\)[\s\S]*?status: 401/.test(deleteAccountSrc))
})
test('handler calls auth.getUser() and rejects failure with 401', () => {
  assert.ok(/await supabaseUser\.auth\.getUser\(\)/.test(deleteAccountSrc))
  assert.ok(/if \(authError \|\| !user\)[\s\S]*?status: 401/.test(deleteAccountSrc))
})
test('authentication precedes admin construction, cleanupGoogle, contact deletion, and deleteUser', () => {
  const at = (needle) => { const i = deleteAccountSrc.indexOf(needle); assert.ok(i !== -1, `missing ${needle}`); return i }
  const headerGuard = at('if (!authHeader)')
  const getUser = at('.auth.getUser()')
  const authGuard = at('if (authError || !user)')
  const adminClient = at('const admin = createClient(')
  const cleanup = at('await cleanupGoogle(admin, user.id)')
  const contacts = at(".from('contacts')")
  const deleteUser = at('.auth.admin.deleteUser(user.id)')
  assert.ok(headerGuard < getUser && getUser < authGuard, 'header guard → getUser → auth guard')
  assert.ok(authGuard < adminClient, 'admin client is constructed only after authentication')
  assert.ok(adminClient < cleanup && cleanup < contacts && contacts < deleteUser, 'admin → cleanup → contacts → deleteUser')
  // The user-scoped client exists only to verify the caller; it never deletes.
  assert.ok(!/supabaseUser\.(from|rpc)\(/.test(deleteAccountSrc), 'user-scoped client performs no data operations')
})
test('every destructive operation is scoped from the verified user.id', () => {
  assert.ok(/\.from\('contacts'\)\s*\.delete\(\)\s*\.eq\('user_id', user\.id\)/.test(deleteAccountSrc))
  assert.ok(/cleanupGoogle\(admin, user\.id\)/.test(deleteAccountSrc))
  assert.ok(/\.auth\.admin\.deleteUser\(user\.id\)/.test(deleteAccountSrc))
  assert.ok(!/deleteUser\((?!user\.id\))/.test(deleteAccountSrc), 'deleteUser only ever receives user.id')
  assert.ok(!/cleanupGoogle\(admin, (?!user\.id\))/.test(deleteAccountSrc), 'cleanupGoogle only ever receives user.id')
  assert.ok(!/\.delete\(\)(?![\s\S]{0,40}\.eq\('user_id', user\.id\))/.test(deleteAccountSrc), 'every delete is user_id-scoped')
})
test('no identity is accepted from body, query, custom headers, user_metadata, or app_metadata', () => {
  assert.ok(!/req\.json\(\)|req\.text\(\)|req\.formData\(\)|req\.body|req\.arrayBuffer\(\)/.test(deleteAccountSrc), 'no request body read')
  assert.ok(!/searchParams|new URL\(req\.url\)|req\.url/.test(deleteAccountSrc), 'no query-parameter read')
  const headerReads = deleteAccountSrc.match(/req\.headers\.get\([^)]*\)/g) || []
  assert.deepStrictEqual(headerReads, ["req.headers.get('Authorization')"], 'only the Authorization header is read')
  assert.ok(!/user_metadata|app_metadata/.test(deleteAccountSrc), 'no metadata-derived identity')
  assert.ok(!/\b(body|params|query)\s*[.[]\s*['"]?user_?id/i.test(deleteAccountSrc), 'no request-supplied user id')
})
test('the success response is unreachable until cleanup, contact deletion, and deleteUser complete', () => {
  const success = deleteAccountSrc.indexOf('success: true')
  assert.ok(success !== -1)
  const idx = (n) => deleteAccountSrc.indexOf(n)
  assert.ok(idx('await cleanupGoogle(admin, user.id)') < success)
  assert.ok(idx(".from('contacts')") < success && idx('if (contactsErr) throw') < success, 'contacts delete + error check before success')
  assert.ok(idx('.auth.admin.deleteUser(user.id)') < success && idx('if (deleteErr) throw') < success, 'deleteUser + error check before success')
  assert.strictEqual((deleteAccountSrc.match(/success: true/g) || []).length, 1, 'exactly one success path')
  assert.ok(/if \(deleteErr\) throw[\s\S]*?success: true/.test(deleteAccountSrc))
})
test('CORS preflight and error contract are unchanged', () => {
  assert.ok(/if \(req\.method === 'OPTIONS'\)[\s\S]*?return new Response\('ok', \{ headers: corsHeaders \}\)/.test(deleteAccountSrc))
  assert.ok(/'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'/.test(deleteAccountSrc))
  assert.ok(/catch \(err\)[\s\S]*?status: 500/.test(deleteAccountSrc))
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
  'supabase/functions/shared/googleConnect.js',
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
test('only the expected google-* edge functions exist', () => {
  // Phase 0A added the three google-oauth-* functions; Phase C1 adds the JWT-gated
  // google-calendar-sync engine. No other google-* function should exist.
  const fns = readdirSync(join(root, 'supabase/functions')).filter(n => n.startsWith('google'))
  assert.deepStrictEqual(fns.sort(), ['google-calendar-sync', 'google-oauth-callback', 'google-oauth-disconnect', 'google-oauth-start'])
})

// ── Atomic persistence RPC (hardening pass) ───────────────────────────────────
console.log('\natomic persistence RPC')
const helpers = read('supabase/functions/shared/googleOauthHelpers.js')
const callback = read('supabase/functions/google-oauth-callback/index.ts')

test('store_google_connection RPC exists, SECURITY DEFINER, empty search_path', () => {
  assert.ok(/CREATE OR REPLACE FUNCTION public\.store_google_connection\(/.test(migration))
  const fn = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.store_google_connection'))
  assert.ok(/SECURITY DEFINER/.test(fn))
  assert.ok(/SET search_path = ''/.test(fn))
  // Fully-qualified table references inside the function.
  assert.ok(/INSERT INTO public\.google_connections/.test(fn))
  assert.ok(/INSERT INTO public\.google_tokens/.test(fn))
})
test('RPC execution revoked from PUBLIC/anon/authenticated, granted only to service_role', () => {
  assert.ok(/REVOKE ALL ON FUNCTION public\.store_google_connection\([\s\S]*?\) FROM PUBLIC, anon, authenticated/.test(migration))
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.store_google_connection\([\s\S]*?\) TO service_role/.test(migration))
})
test('callback persists via the atomic RPC (not two separate table writes)', () => {
  assert.ok(callback.includes("admin.rpc('store_google_connection'"), 'callback must call the atomic RPC')
  assert.ok(!/\.from\('google_connections'\)[\s\S]*?\.upsert\(/.test(callback), 'no direct connection upsert')
  assert.ok(!/\.from\('google_tokens'\)[\s\S]*?\.upsert\(/.test(callback), 'no direct token upsert')
  assert.ok(callback.includes('finalizeGoogleConnection'), 'callback delegates to finalize')
})

// ── Lifecycle hardening invariants ────────────────────────────────────────────
console.log('\nlifecycle hardening')
test('auth URL requests offline access + re-consent + account selection', () => {
  assert.ok(/access_type:\s*'offline'/.test(helpers))
  assert.ok(/prompt:\s*'consent select_account'/.test(helpers))
})
test('identity validation requires email_verified === true', () => {
  assert.ok(/email_verified !== true/.test(helpers), 'must reject unverified email')
})
test('refresh preservation is account-scoped (sameSub) — never cross-account', () => {
  assert.ok(/sameSub === true/.test(helpers), 'preserve only for same account')
})
test('start performs bounded best-effort stale-state cleanup', () => {
  const start = read('supabase/functions/google-oauth-start/index.ts')
  assert.ok(/google_oauth_states'\)\.delete\(\)\.lt\('created_at'/.test(start))
})

// ── Correction round 2: callback fail-closed, headers, method, JSON, disconnect ─
console.log('\ncallback fail-closed on lookups')
const startSrc = read('supabase/functions/google-oauth-start/index.ts')
const disconnectSrc = read('supabase/functions/google-oauth-disconnect/index.ts')

test('callback inspects BOTH lookup errors and returns before persistence', () => {
  assert.ok(/error:\s*connLookupErr[\s\S]*?if \(connLookupErr\)[\s\S]*?return redirect/.test(callback),
    'connection lookup error must fail closed')
  assert.ok(/error:\s*tokenLookupErr[\s\S]*?if \(tokenLookupErr\)[\s\S]*?return redirect/.test(callback),
    'token lookup error must fail closed')
})
test('callback does NOT revoke on an unresolved lookup failure', () => {
  // The lookup-error branches return the error redirect without a revokeToken call.
  const connBranch = callback.slice(callback.indexOf('if (connLookupErr)'), callback.indexOf('if (connLookupErr)') + 160)
  assert.ok(!/revokeToken/.test(connBranch), 'no blind revoke on connection lookup failure')
})

console.log('\nOAuth security headers + method')
test('callback is POST-only (form_post); non-POST → 405 without processing', () => {
  assert.ok(/req\.method !== 'POST'[\s\S]*?status: 405/.test(callback), 'must reject non-POST with 405')
  assert.ok(!/req\.method !== 'GET'/.test(callback), 'must NOT gate on GET anymore')
})
test('callback processes the form_post body, never GET query params (no URL-log re-entry)', () => {
  assert.ok(callback.includes('parseCallbackFormBody('), 'must parse the form body')
  assert.ok(callback.includes('readBoundedStream(req.body'), 'must read the request body (bounded)')
  assert.ok(!/searchParams/.test(callback), 'no query-parameter reading remains')
  assert.ok(!/new URL\(req\.url\)/.test(callback), 'no request-URL parsing remains (no GET fallback)')
})
test('auth URL requests response_mode=form_post', () => {
  assert.ok(/response_mode:\s*'form_post'/.test(helpers))
})
test('callback redirects use 303 See Other (never 301/302/307/308)', () => {
  const fn = callback.slice(callback.indexOf('function redirect('), callback.indexOf('function redirect(') + 220)
  assert.ok(/status:\s*303/.test(fn), 'redirect helper must use 303')
  assert.ok(!/status:\s*30[1278]/.test(fn), 'no 301/302/307/308')
})
test('callback uses a bounded streaming read, not an unbounded req.text()', () => {
  assert.ok(callback.includes('readBoundedStream(req.body'), 'must use the bounded reader')
  assert.ok(!/await req\.text\(\)/.test(callback), 'no unbounded req.text() body read')
})
test('callback + start set no-store / no-referrer / nosniff security headers', () => {
  for (const [name, src] of [['callback', callback], ['start', startSrc]]) {
    assert.ok(/'Cache-Control':\s*'no-store'/.test(src), `${name} Cache-Control`)
    assert.ok(/'Referrer-Policy':\s*'no-referrer'/.test(src), `${name} Referrer-Policy`)
    assert.ok(/'X-Content-Type-Options':\s*'nosniff'/.test(src), `${name} nosniff`)
    assert.ok(/'Pragma':\s*'no-cache'/.test(src), `${name} Pragma`)
  }
})

console.log('\nmalformed provider JSON')
test('callback guards token + userinfo .json() parsing', () => {
  assert.ok(/tokenData = await tokenRes\.json\(\)[\s\S]*?catch[\s\S]*?token_json_malformed/.test(callback))
  assert.ok(/identity = await userinfoRes\.json\(\)[\s\S]*?catch[\s\S]*?userinfo_json_malformed/.test(callback))
})

console.log('\ndisconnect requires the atomic local cleanup to succeed')
test('disconnect returns 500 when the atomic local cleanup RPC errors', () => {
  assert.ok(/if \(localCleanupError\)[\s\S]*?internal_error[\s\S]*?500/.test(disconnectSrc))
  assert.ok(!/oauthStateDeleteError|connectionDeleteError/.test(disconnectSrc), 'the two-call contract is gone')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
