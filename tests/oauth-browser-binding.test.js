// Browser-binding tests for the Google OAuth flow.
//
// The bug: google-oauth-start records the INITIATING Funnl user in an OAuth state
// row; the shared callback took the user id from that row without proving the
// browser completing consent was the browser that started. An attacker could send
// their own authorization URL to a victim and capture the victim's Google account
// under the attacker's Funnl account.
//
// These tests exercise the real exported functions and a faithful in-memory model
// of the callback's decision order. They are deliberately NOT source-string scans,
// except where a scan is the only way to assert an ordering property.
//
// Run: node tests/oauth-browser-binding.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  BINDING_COOKIE_NAME,
  BINDING_COOKIE_MAX_AGE_S,
  buildBindingCookie,
  buildClearedBindingCookie,
  isCookieSafeValue,
  readBindingCookie,
  timingSafeEqualStrings,
  verifyBrowserBinding,
} from '../supabase/functions/shared/oauthBrowserBinding.js'
import { resolveOauthStartUrl, canStartOauthFrom, CANONICAL_OAUTH_ORIGIN } from '../src/lib/oauthStartEndpoint.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8')

let passed = 0, failed = 0

// Async tests must be awaited before the summary is printed and before the process
// exits. An earlier version called fn() and counted a pass immediately: a rejected
// Promise from an async test was never observed, so assertions that ran after an
// `await` could not fail the run. Synchronous tests still report in place; async
// ones are collected here and settled by finish() below.
const pendingTests = []
function test (name, fn) {
  const pass = () => { console.log(`  ✓ ${name}`); passed++ }
  const fail = (e) => {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e && e.message ? e.message : e}`)
    failed++
  }
  let result
  try {
    result = fn()
  } catch (e) {
    fail(e)
    return
  }
  if (result && typeof result.then === 'function') {
    pendingTests.push(result.then(pass, fail))
    return
  }
  pass()
}

/** Settles every async test, then prints the summary and sets the exit code. */
async function finish () {
  await Promise.all(pendingTests)
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}

// ─────────────────────────────────────────────────────────────────────────────
// A faithful model of the callback's ORDER of operations. Every side effect is
// recorded so a test can assert that nothing happened before the binding check.
// ─────────────────────────────────────────────────────────────────────────────
function makeCallback (stateRows) {
  const effects = []
  return {
    effects,
    /**
     * @param {{ cookieHeader: string|null, body: { state?: string, code?: string, error?: string } }} req
     */
    handle (req) {
      const { state, code, error } = req.body
      if (typeof state !== 'string' || state.length === 0) {
        return { outcome: 'error', reason: 'bad_request' }
      }

      // THE GATE — before any database access or token exchange.
      const binding = verifyBrowserBinding(req.cookieHeader, state)
      if (!binding.ok) return { outcome: 'error', reason: binding.reason }

      // Everything below is the pre-existing behaviour, unchanged.
      effects.push('db_consume_state')
      const row = stateRows.get(state)
      if (!row || row.consumed || row.expiresAt <= Date.now()) {
        return { outcome: 'error', reason: 'invalid_state' }
      }
      row.consumed = true
      if (error || !code) return { outcome: 'error', reason: 'provider_error_or_no_code' }

      effects.push('token_exchange')
      const googleAccount = req.googleAccount ?? 'google-of-initiator'
      effects.push('persist_tokens')
      return { outcome: 'connected', funnlUser: row.userId, googleAccount }
    },
  }
}

function freshState (userId, value, ttlMs = 600000) {
  return [value, { userId, consumed: false, expiresAt: Date.now() + ttlMs }]
}

// ── 1. The attack ────────────────────────────────────────────────────────────
console.log('\nattacker A starts, victim B completes')

test('BEFORE the fix the victim\'s Google account would land on the attacker\'s Funnl account', () => {
  // Model the old callback: no binding check at all.
  const rows = new Map([freshState('user-A', 'state-A')])
  const row = rows.get('state-A')
  row.consumed = true
  const ownerWithoutBinding = row.userId       // exactly what the old code used
  assert.strictEqual(ownerWithoutBinding, 'user-A',
    'the state row names the initiator, so B\'s Google account attaches to A')
})

test('victim B completing attacker A\'s link is refused, with no DB write and no token exchange', () => {
  const rows = new Map([freshState('user-A', 'state-A')])
  const cb = makeCallback(rows)
  // B's browser: never visited A's start call, so it carries no binding cookie.
  const res = cb.handle({ cookieHeader: null, body: { state: 'state-A', code: 'code-from-B' } })
  assert.strictEqual(res.outcome, 'error')
  assert.strictEqual(res.reason, 'no_cookie_header')
  assert.deepStrictEqual(cb.effects, [], 'nothing ran: no state consume, no exchange, no persist')
  assert.strictEqual(rows.get('state-A').consumed, false, 'A\'s state is not burned by an unbound caller')
})

test('B carrying an unrelated binding cookie of their own is still refused', () => {
  const rows = new Map([freshState('user-A', 'state-A'), freshState('user-B', 'state-B')])
  const cb = makeCallback(rows)
  const res = cb.handle({
    cookieHeader: `${BINDING_COOKIE_NAME}=state-B`,
    body: { state: 'state-A', code: 'code-from-B' },
  })
  assert.strictEqual(res.reason, 'binding_mismatch')
  assert.deepStrictEqual(cb.effects, [])
})

test('the attacker completing in their OWN browser only ever links their own account', () => {
  const rows = new Map([freshState('user-A', 'state-A')])
  const cb = makeCallback(rows)
  const res = cb.handle({
    cookieHeader: `${BINDING_COOKIE_NAME}=state-A`,
    body: { state: 'state-A', code: 'code-from-A' },
    googleAccount: 'google-of-A',
  })
  assert.strictEqual(res.outcome, 'connected')
  assert.strictEqual(res.funnlUser, 'user-A')
  assert.strictEqual(res.googleAccount, 'google-of-A')
})

// ── 2. Missing / mismatched / malformed binding ──────────────────────────────
console.log('\nmissing or mismatched browser binding')

test('no Cookie header at all', () => {
  assert.deepStrictEqual(verifyBrowserBinding(null, 's'), { ok: false, reason: 'no_cookie_header' })
  assert.deepStrictEqual(verifyBrowserBinding('', 's'), { ok: false, reason: 'no_cookie_header' })
})

test('cookies present but ours absent', () => {
  const r = verifyBrowserBinding('other=1; sb-access-token=xyz', 's')
  assert.deepStrictEqual(r, { ok: false, reason: 'binding_absent' })
})

test('a cookie with a confusable name does not satisfy the check', () => {
  for (const header of [
    'fnl_oauth_bind=s',                      // missing the __Host- prefix
    '__host-fnl_oauth_bind=s',               // wrong case: cookie names are case-sensitive
    'x__Host-fnl_oauth_bind=s',              // suffix of another name
    '__Host-fnl_oauth_bind_extra=s',
  ]) {
    const r = verifyBrowserBinding(header, 's')
    assert.strictEqual(r.ok, false, `must not accept: ${header}`)
    assert.strictEqual(r.reason, 'binding_absent')
  }
})

test('a duplicated binding cookie is refused rather than guessed', () => {
  const r = verifyBrowserBinding(`${BINDING_COOKIE_NAME}=aaa; ${BINDING_COOKIE_NAME}=bbb`, 'aaa')
  assert.deepStrictEqual(r, { ok: false, reason: 'binding_duplicated' })
})

test('an empty binding value is refused', () => {
  assert.strictEqual(verifyBrowserBinding(`${BINDING_COOKIE_NAME}=`, 's').reason, 'binding_empty')
  assert.strictEqual(verifyBrowserBinding(`${BINDING_COOKIE_NAME}=   `, 's').reason, 'binding_empty')
})

test('parsing is unambiguous: whitespace, ordering and base64url padding survive', () => {
  const v = 'AbC-_0123456789xyz'
  assert.deepStrictEqual(readBindingCookie(`a=1;  ${BINDING_COOKIE_NAME}=${v} ; z=2`), { ok: true, value: v })
  assert.deepStrictEqual(readBindingCookie(`${BINDING_COOKIE_NAME}=${v}`), { ok: true, value: v })
})

test('only the first = splits name from value, so a value containing = is preserved', () => {
  assert.deepStrictEqual(readBindingCookie(`${BINDING_COOKIE_NAME}=a=b=c`), { ok: true, value: 'a=b=c' })
})

test('an oversized Cookie header is refused outright', () => {
  const r = readBindingCookie(`${BINDING_COOKIE_NAME}=x;`.padEnd(9000, ' '))
  assert.deepStrictEqual(r, { ok: false, reason: 'cookie_header_too_large' })
})

test('a missing submitted state is refused before the cookie is even read', () => {
  assert.deepStrictEqual(verifyBrowserBinding(`${BINDING_COOKIE_NAME}=x`, ''), { ok: false, reason: 'state_missing' })
  assert.deepStrictEqual(verifyBrowserBinding(`${BINDING_COOKIE_NAME}=x`, undefined), { ok: false, reason: 'state_missing' })
})

test('comparison rejects prefixes and length differences', () => {
  assert.strictEqual(timingSafeEqualStrings('abcd', 'abcd'), true)
  assert.strictEqual(timingSafeEqualStrings('abcd', 'abc'), false)
  assert.strictEqual(timingSafeEqualStrings('abc', 'abcd'), false)
  assert.strictEqual(timingSafeEqualStrings('abcd', 'abce'), false)
})

// ── 3. Cookie attributes ─────────────────────────────────────────────────────
console.log('\ncookie attributes')

test('__Host- prefix requires Path=/, Secure and NO Domain — all satisfied', () => {
  const c = buildBindingCookie('tok123')
  assert.ok(c.startsWith('__Host-'), 'prefix present')
  assert.ok(/;\s*Path=\/(;|$)/.test(c), 'Path=/ exactly — a narrower path would void the prefix')
  assert.ok(/;\s*Secure(;|$)/.test(c), 'Secure')
  assert.ok(!/Domain=/i.test(c), '__Host- forbids Domain')
})

test('SameSite=None and HttpOnly are set (form_post is a cross-site POST)', () => {
  const c = buildBindingCookie('tok123')
  assert.ok(/;\s*SameSite=None(;|$)/.test(c), 'Lax/Strict would drop the cookie on Google\'s cross-site POST')
  assert.ok(/;\s*HttpOnly(;|$)/.test(c), 'HttpOnly')
})

test('cookie lifetime matches the 10-minute state TTL', () => {
  assert.strictEqual(BINDING_COOKIE_MAX_AGE_S, 600)
  assert.ok(buildBindingCookie('t').includes('Max-Age=600'))
  const startTtl = /const STATE_TTL_MS = (\d+) \* (\d+) \* (\d+)/.exec(read('supabase/functions/google-oauth-start/index.ts'))
  assert.ok(startTtl, 'start declares a TTL')
  assert.strictEqual(Number(startTtl[1]) * Number(startTtl[2]) * Number(startTtl[3]), BINDING_COOKIE_MAX_AGE_S * 1000)
})

test('the cleared cookie expires immediately and keeps the same scope', () => {
  const c = buildClearedBindingCookie()
  assert.ok(c.startsWith(`${BINDING_COOKIE_NAME}=;`))
  assert.ok(c.includes('Max-Age=0'))
  assert.ok(/;\s*Path=\/(;|$)/.test(c) && /Secure/.test(c) && !/Domain=/i.test(c))
})

test('unsafe values can never be emitted into a Set-Cookie', () => {
  for (const bad of ['a;b', 'a,b', 'a b', 'a"b', 'a\\b', 'a\nb', '']) {
    assert.throws(() => buildBindingCookie(bad), /binding_state_(required|unsafe)/, `must reject ${JSON.stringify(bad)}`)
  }
  assert.ok(isCookieSafeValue('AbC-_09'), 'base64url is safe')
})

// ── 4. Overlapping attempts ──────────────────────────────────────────────────
console.log('\noverlapping connection attempts')

test('a second start overwrites the first binding: last start wins, first fails closed', () => {
  // One fixed cookie name ⇒ the browser keeps one value. Model that.
  let jar = null
  const setCookie = (c) => { jar = /^[^=]+=([^;]*)/.exec(c)[1] }
  setCookie(buildBindingCookie('state-1'))
  setCookie(buildBindingCookie('state-2'))
  const header = () => `${BINDING_COOKIE_NAME}=${jar}`
  assert.strictEqual(verifyBrowserBinding(header(), 'state-2').ok, true, 'newest flow completes')
  assert.strictEqual(verifyBrowserBinding(header(), 'state-1').reason, 'binding_mismatch',
    'the abandoned flow fails closed rather than completing')
})

// ── 5. Refusal, expiry, replay ───────────────────────────────────────────────
console.log('\nrefusal, expiry and replay')

test('user refusal (access_denied) still consumes the state and connects nothing', () => {
  const rows = new Map([freshState('user-A', 'state-A')])
  const cb = makeCallback(rows)
  const res = cb.handle({
    cookieHeader: `${BINDING_COOKIE_NAME}=state-A`,
    body: { state: 'state-A', error: 'access_denied' },
  })
  assert.strictEqual(res.outcome, 'error')
  assert.strictEqual(res.reason, 'provider_error_or_no_code')
  assert.ok(cb.effects.includes('db_consume_state'))
  assert.ok(!cb.effects.includes('token_exchange'), 'never exchanges on a refusal')
  assert.strictEqual(rows.get('state-A').consumed, true)
})

test('an expired state is refused even with a matching cookie', () => {
  const rows = new Map([freshState('user-A', 'state-A', -1)])
  const cb = makeCallback(rows)
  const res = cb.handle({ cookieHeader: `${BINDING_COOKIE_NAME}=state-A`, body: { state: 'state-A', code: 'c' } })
  assert.strictEqual(res.reason, 'invalid_state')
  assert.ok(!cb.effects.includes('token_exchange'))
})

test('replay of a consumed state is refused even with a matching cookie', () => {
  const rows = new Map([freshState('user-A', 'state-A')])
  const cb = makeCallback(rows)
  const first = cb.handle({ cookieHeader: `${BINDING_COOKIE_NAME}=state-A`, body: { state: 'state-A', code: 'c' } })
  assert.strictEqual(first.outcome, 'connected')
  const second = cb.handle({ cookieHeader: `${BINDING_COOKIE_NAME}=state-A`, body: { state: 'state-A', code: 'c' } })
  assert.strictEqual(second.reason, 'invalid_state')
  assert.strictEqual(cb.effects.filter((e) => e === 'persist_tokens').length, 1, 'persisted exactly once')
})

// ── 6. Where a flow may start (apex vs www) ──────────────────────────────────
console.log('\nstart endpoint resolution (apex vs www)')

test('the canonical www origin yields a same-origin relative path', () => {
  assert.deepStrictEqual(resolveOauthStartUrl('https://www.getfunnl.com', 'calendar'),
    { ok: true, url: '/api/google-oauth-start' })
  assert.deepStrictEqual(resolveOauthStartUrl('https://www.getfunnl.com', 'gmail'),
    { ok: true, url: '/api/gmail-oauth-start' })
})

test('apex, previews and localhost are refused rather than starting an uncompletable flow', () => {
  for (const origin of [
    'https://getfunnl.com',
    'https://funnlv2-abc123-funnlv2.vercel.app',
    'http://localhost:5173',
    'https://evil.example',
  ]) {
    const r = resolveOauthStartUrl(origin, 'calendar')
    assert.strictEqual(r.ok, false, `must refuse ${origin}`)
    assert.strictEqual(r.reason, 'non_canonical_origin')
    assert.strictEqual(canStartOauthFrom(origin), false)
  }
  assert.strictEqual(canStartOauthFrom(CANONICAL_OAUTH_ORIGIN), true)
})

test('the canonical origin matches the callback host the server enforces', () => {
  const helpers = read('supabase/functions/shared/googleOauthHelpers.js')
  const m = /EXPECTED_GOOGLE_CALLBACK_URL = '([^']+)'/.exec(helpers)
  assert.ok(m, 'server constant found')
  assert.ok(m[1].startsWith(CANONICAL_OAUTH_ORIGIN + '/'),
    `cookie host ${CANONICAL_OAUTH_ORIGIN} must be the callback host ${m[1]}`)
})

test('vercel.json routes every branded path used by the client', () => {
  const vercel = JSON.parse(read('vercel.json'))
  const sources = vercel.rewrites.map((r) => r.source)
  for (const p of ['/api/google-oauth-callback', '/api/google-oauth-start', '/api/gmail-oauth-start']) {
    assert.ok(sources.includes(p), `rewrite missing: ${p}`)
    const dest = vercel.rewrites.find((r) => r.source === p).destination
    assert.ok(/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\//.test(dest), `bad destination for ${p}`)
  }
  assert.strictEqual(sources[sources.length - 1], '/(.*)', 'SPA catch-all stays last')
})

// ── 7. Wiring and ordering proofs ────────────────────────────────────────────
console.log('\nwiring and ordering')

test('both start functions set the binding cookie on their success response', () => {
  for (const f of ['supabase/functions/google-oauth-start/index.ts',
                   'supabase/functions/gmail-oauth-start/index.ts']) {
    const src = read(f)
    assert.ok(src.includes("from '../shared/oauthBrowserBinding.js'"), `${f} imports the helper`)
    assert.ok(/return json\(\{ url \}, 200, \{ 'Set-Cookie': buildBindingCookie\(state\) \}\)/.test(src),
      `${f} returns the cookie with the authorization URL`)
  }
})

test('the callback checks the binding BEFORE the state consume, the exchange and any persist', () => {
  const whole = read('supabase/functions/google-oauth-callback/index.ts')
  // Compare positions inside the REQUEST HANDLER only: the import block naturally
  // names these symbols earlier in the file, which says nothing about run order.
  const bodyStart = whole.indexOf('Deno.serve(')
  assert.ok(bodyStart > 0, 'handler found')
  const src = whole.slice(bodyStart)
  const gate = src.indexOf('verifyBrowserBinding(')
  assert.ok(gate > 0, 'gate present inside the handler')
  for (const later of ['createClient(', 'google_oauth_states', 'finalizeGoogleConnection(', '/token']) {
    const at = src.indexOf(later)
    if (at === -1) continue
    assert.ok(gate < at, `binding gate must precede ${later} (gate ${gate}, ${later} ${at})`)
  }
  // Nothing with a side effect may sit between the parsed body and the gate.
  const parsedAt = src.indexOf('const state       = parsed.state')
  assert.ok(parsedAt > 0 && parsedAt < gate, 'gate follows the body parse')
  const between = src.slice(parsedAt, gate)
  for (const effect of ['await ', 'createClient(', '.from(', 'fetch(']) {
    assert.ok(!between.includes(effect), `no ${effect} may run before the binding gate`)
  }
})

test('every callback response clears the binding cookie', () => {
  const src = read('supabase/functions/google-oauth-callback/index.ts')
  assert.ok(/function redirect\([\s\S]{0,400}buildClearedBindingCookie\(\)/.test(src),
    'the single redirect helper clears it, so every terminal path does')
})

test('the frontend no longer starts Calendar OAuth via a direct Supabase invoke', () => {
  const card = read('src/components/GoogleConnectionCard.jsx')
  assert.ok(!/functions\.invoke\('google-oauth-start'/.test(card),
    'a direct invoke would set the cookie on supabase.co and the callback would reject every completion')
  assert.ok(/resolveOauthStartUrl\(window\.location\.origin, 'calendar'\)/.test(card))
  assert.ok(/credentials: 'same-origin'/.test(card), 'Set-Cookie must be honoured')
})

test('Gmail stays fail-closed behind its server-side flag', () => {
  const src = read('supabase/functions/gmail-oauth-start/index.ts')
  assert.ok(/GMAIL_INTEGRATION_ENABLED'\) \?\? ''\) !== 'true'/.test(src), 'still gated')
  const flagAt = src.indexOf('GMAIL_INTEGRATION_ENABLED')
  const cookieAt = src.indexOf('buildBindingCookie')
  assert.ok(flagAt < cookieAt, 'the flag is checked before a cookie is ever minted')
  assert.ok(!/gmail-oauth-start/.test(read('src/components/GoogleConnectionCard.jsx')), 'no Gmail UI wired')
})

// ── 8. Bounded bodies are unchanged ──────────────────────────────────────────
console.log('\nbounded callback bodies (unchanged behaviour)')

test('the body cap and its Content-Length handling are untouched by this change', async () => {
  const { readBoundedStream, CALLBACK_MAX_BODY_BYTES } =
    await import('../supabase/functions/shared/googleOauthHelpers.js')
  assert.strictEqual(CALLBACK_MAX_BODY_BYTES, 8192)

  const streamOf = (text) => new ReadableStream({
    start (c) { c.enqueue(new TextEncoder().encode(text)); c.close() },
  })
  const small = 'state=abc&code=def'

  let r = await readBoundedStream(streamOf(small), { contentLength: String(small.length), maxBytes: 8192 })
  assert.strictEqual(r.ok, true, 'honest Content-Length')
  r = await readBoundedStream(streamOf(small), { contentLength: null, maxBytes: 8192 })
  assert.strictEqual(r.ok, true, 'absent Content-Length still read')
  r = await readBoundedStream(streamOf('x'.repeat(9000)), { contentLength: null, maxBytes: 8192 })
  assert.strictEqual(r.ok, false, 'oversized body rejected without a Content-Length')
  r = await readBoundedStream(streamOf(small), { contentLength: '99999', maxBytes: 8192 })
  assert.strictEqual(r.ok, false, 'dishonest oversized Content-Length rejected up front')
  r = await readBoundedStream(streamOf(small), { contentLength: 'abc', maxBytes: 8192 })
  assert.strictEqual(r.ok, false, 'non-integer Content-Length rejected')
})

await finish()
