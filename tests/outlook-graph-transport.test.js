// Outlook PR-B — bounded Graph transport invariants.
//
// ZERO NETWORK ACCESS: every test injects a fake `fetch`. The module has no default
// fetch, so a missing injection throws rather than silently reaching the internet.
// All identities are synthetic and use example.invalid.
//
// Run with: node tests/outlook-graph-transport.test.js
import assert from 'assert'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import {
  GRAPH_BASE, GRAPH_HOST, GRAPH_FOLDERS, GRAPH_MAIL_READ_SCOPE,
  ENVELOPE_SELECT, CONTENT_SELECT, PREFER_TEXT_BODY,
  MAX_PAGE_SIZE, MAX_PAGES_PER_RUN, MAX_MESSAGES_PER_RUN, MAX_RETRIES,
  MAX_RETRY_AFTER_MS, MAX_TOTAL_RETRY_DELAY_MS, MAX_RESPONSE_BYTES,
  buildFolderDeltaRequest, buildFollowLinkRequest, buildMessageContentRequest,
  validateGraphFollowLink, parseRetryAfterMs, backoffMs, planRetry, statusToCode,
  isRetryableStatus, executeGraphRequest, readDeltaPage, readMessageContent,
  checkRunCaps, checkResponseSize, isUsableGraphId, grantedScopesIncludeMailRead,
} from '../supabase/functions/shared/outlookGraphTransport.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '../supabase/functions/shared/outlookGraphTransport.js'), 'utf8')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

// Minimal fake Response.
function fakeRes(status, { json = {}, headers = {}, throwOnJson = false } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  return {
    status,
    headers: { get: (n) => (h.has(String(n).toLowerCase()) ? h.get(String(n).toLowerCase()) : null) },
    json: async () => { if (throwOnJson) throw new Error('bad json'); return json },
  }
}
const noSleep = async () => {}

// ── Scope and $select minimization ───────────────────────────────────────────
console.log('\nrequest minimization')

test('envelope $select carries NO body projection of any kind', () => {
  for (const forbidden of ['body', 'bodyPreview', 'uniqueBody', 'attachments', 'mimeContent']) {
    assert.ok(!ENVELOPE_SELECT.includes(forbidden), `envelope select must not request ${forbidden}`)
  }
  assert.ok(ENVELOPE_SELECT.includes('id') && ENVELOPE_SELECT.includes('conversationId'))
  assert.ok(ENVELOPE_SELECT.includes('from') && ENVELOPE_SELECT.includes('toRecipients') &&
            ENVELOPE_SELECT.includes('ccRecipients'), 'envelope needs the participant fields')
})

test('content $select is exactly id,body,uniqueBody — nothing re-requested', () => {
  assert.deepStrictEqual([...CONTENT_SELECT], ['id', 'body', 'uniqueBody'])
})

test('delta request targets only a well-known folder and sets a bounded page size', () => {
  for (const folder of GRAPH_FOLDERS) {
    const r = buildFolderDeltaRequest({ folder })
    assert.strictEqual(r.method, 'GET')
    assert.ok(r.url.startsWith(`${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta`))
    assert.strictEqual(r.headers.Prefer, `odata.maxpagesize=${MAX_PAGE_SIZE}`)
    assert.strictEqual(r.stage, 'envelope')
    assert.ok(!/\$select=[^&]*\bbody\b/.test(r.url), 'no body in the delta select')
  }
  assert.throws(() => buildFolderDeltaRequest({ folder: 'archive' }), /invalid_folder/)
  assert.throws(() => buildFolderDeltaRequest({ folder: 'drafts' }), /invalid_folder/)
})

test('page size is clamped in both directions', () => {
  assert.strictEqual(buildFolderDeltaRequest({ folder: 'inbox', pageSize: 9999 }).headers.Prefer,
    `odata.maxpagesize=${MAX_PAGE_SIZE}`)
  assert.strictEqual(buildFolderDeltaRequest({ folder: 'inbox', pageSize: 0 }).headers.Prefer,
    'odata.maxpagesize=1')
})

test('content request asks for text bodies with the exact documented Prefer value', () => {
  const r = buildMessageContentRequest({ messageId: 'AAMkAGI1AAAoZCfHAAA=' })
  assert.strictEqual(r.headers.Prefer, 'outlook.body-content-type="text"')
  assert.strictEqual(PREFER_TEXT_BODY, 'outlook.body-content-type="text"')
  assert.ok(r.url.startsWith(`${GRAPH_BASE}/me/messages/`))
  assert.ok(r.url.includes('$select=id,body,uniqueBody'))
  assert.strictEqual(r.stage, 'content')
})

test('message ids are shape-checked; traversal and injection are refused', () => {
  assert.ok(isUsableGraphId('AAMkAGI1AAAoZCfHAAA='))
  for (const bad of ['', '../../me/messages', 'a b', 'id\nX', 'x'.repeat(1025), 'a/../b', '<script>']) {
    assert.ok(!isUsableGraphId(bad), `must reject: ${JSON.stringify(bad).slice(0, 30)}`)
  }
  assert.throws(() => buildMessageContentRequest({ messageId: '../users/other' }), /invalid_message_id/)
})

test('only Mail.Read is required and only /me paths are ever built', () => {
  assert.strictEqual(GRAPH_MAIL_READ_SCOPE, 'Mail.Read')
  assert.ok(grantedScopesIncludeMailRead(['Mail.Read', 'offline_access']))
  assert.ok(grantedScopesIncludeMailRead('openid Mail.Read'))
  assert.ok(!grantedScopesIncludeMailRead(['Mail.ReadBasic']))
  assert.ok(!grantedScopesIncludeMailRead([]))
})

// ── Structural: no write or out-of-scope endpoint exists at all ──────────────
console.log('\nread-only surface')

// Executable code only: comments are stripped, and the two DENYLIST regexes are
// removed as well — they must name the forbidden paths in order to refuse them, so
// scanning them would be self-defeating.
const EXEC = SRC
  // Drop the two path denylist/allowlist declarations INCLUDING their continuation
  // lines: they must spell out the forbidden paths in order to refuse them.
  .replace(/^const (FORBIDDEN_PATH_FRAGMENT_RE|ALLOWED_PATH_RE)\s*=[\s\S]*?\/[gimsuy]*\s*$/gm, '')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

test('no request-building code constructs a write or out-of-scope mail endpoint', () => {
  for (const bad of [
    'sendMail', 'createReply', 'createForward', "'POST'", '"POST"', "method: 'PATCH'",
    "method: 'DELETE'", "'PUT'", '/attachments', '$value', 'mailboxSettings',
    '/contacts', '/calendars', '/events', '/drive', '/onenote',
  ]) {
    assert.ok(!EXEC.includes(bad), `executable code must not contain ${bad}`)
  }
  assert.ok(/method:\s*'GET'/.test(EXEC), 'the executor must pin GET')
  // Only two URL templates exist, and both are rooted at the /me base.
  const templates = [...SRC.matchAll(/`\$\{GRAPH_BASE\}([^`]*)`/g)].map((m) => m[1])
  assert.ok(templates.length > 0, 'expected URL templates')
  for (const t of templates) assert.ok(t.startsWith('/me/'), `template must be /me-rooted: ${t}`)
})

test('no console logging anywhere in the module', () => {
  assert.ok(!/console\s*\./.test(EXEC), 'transport must never log')
})

// ── Follow-link validation ───────────────────────────────────────────────────
console.log('\nnextLink / deltaLink validation')

const GOOD_NEXT = `https://${GRAPH_HOST}/v1.0/me/mailfolders('AQMkADNkNAAAgEMAAAA')/messages/delta?$skiptoken=GwcBoTmPuoTQWfcsAbkYM`
const GOOD_DELTA = `https://${GRAPH_HOST}/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=P4lmXpjPRrjB6ha`

test('accepts both documented Graph path spellings verbatim', () => {
  const a = validateGraphFollowLink(GOOD_NEXT)
  assert.ok(a.ok && a.url === GOOD_NEXT, 'quoted-folder form is accepted and unmodified')
  const b = validateGraphFollowLink(GOOD_DELTA)
  assert.ok(b.ok && b.url === GOOD_DELTA, 'path-segment form is accepted and unmodified')
})

test('rejects every cross-origin / malicious link shape', () => {
  const cases = {
    'http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=a': 'not_https',
    'https://evil.example.invalid/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=a': 'wrong_host',
    'https://graph.microsoft.com.evil.invalid/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=a': 'wrong_host',
    'https://user:pass@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=a': 'credentials_present',
    'https://graph.microsoft.com:8443/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=a': 'explicit_port',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=a#frag': 'fragment_present',
    'https://graph.microsoft.com/v1.0/me/messages/AAA/$value?$deltatoken=a': 'forbidden_path',
    'https://graph.microsoft.com/v1.0/me/messages/AAA/attachments?$deltatoken=a': 'forbidden_path',
    'https://graph.microsoft.com/v1.0/users/victim@example.invalid/messages/delta?$deltatoken=a': 'forbidden_path',
    'https://graph.microsoft.com/v1.0/me/contacts?$deltatoken=a': 'forbidden_path',
    'https://graph.microsoft.com/v1.0/me/calendar/events/delta?$deltatoken=a': 'forbidden_path',
    'https://graph.microsoft.com/beta/me/mailFolders/inbox/messages/delta?$deltatoken=a': 'unexpected_path',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$deltatoken=a': 'unexpected_path',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta': 'missing_state_token',
    'not-a-url': 'unparseable',
    '': 'not_a_string',
  }
  for (const [link, code] of Object.entries(cases)) {
    const r = validateGraphFollowLink(link)
    assert.ok(!r.ok, `must reject: ${link.slice(0, 60)}`)
    assert.strictEqual(r.code, code, `${link.slice(0, 60)} -> ${r.code}`)
  }
})

test('rejects oversized links and links carrying control characters', () => {
  const long = `https://${GRAPH_HOST}/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=${'a'.repeat(9000)}`
  assert.strictEqual(validateGraphFollowLink(long).code, 'too_long')
  assert.strictEqual(validateGraphFollowLink(`https://${GRAPH_HOST}/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=a\nX`).code, 'illegal_characters')
  assert.strictEqual(validateGraphFollowLink(`https://${GRAPH_HOST}/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=a b`).code, 'illegal_characters')
})

test('a rejected link is never echoed back in the failure result', () => {
  const secret = `https://evil.example.invalid/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=SECRETSTATE`
  const r = validateGraphFollowLink(secret)
  assert.ok(!r.ok)
  assert.deepStrictEqual(Object.keys(r).sort(), ['code', 'ok'])
  assert.ok(!JSON.stringify(r).includes('SECRETSTATE'), 'state token must not appear in the result')
})

test('buildFollowLinkRequest refuses an invalid link rather than following it', () => {
  assert.throws(() => buildFollowLinkRequest({ link: 'https://evil.example.invalid/x' }), /invalid_link/)
  const r = buildFollowLinkRequest({ link: GOOD_NEXT })
  assert.strictEqual(r.url, GOOD_NEXT, 'validated links pass through opaquely, unrewritten')
})

// ── Retry / pagination bounds ────────────────────────────────────────────────
console.log('\nbounds and retry policy')

test('only 429 and transient 5xx are retryable', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.ok(isRetryableStatus(s), `${s} retryable`)
  for (const s of [200, 400, 401, 403, 404, 410, 422]) assert.ok(!isRetryableStatus(s), `${s} not retryable`)
})

test('Retry-After is parsed as seconds and clamped', () => {
  assert.strictEqual(parseRetryAfterMs('10'), 10_000)
  assert.strictEqual(parseRetryAfterMs(3), 3000)
  assert.strictEqual(parseRetryAfterMs('99999'), MAX_RETRY_AFTER_MS, 'clamped to the ceiling')
  for (const bad of ['Wed, 21 Oct 2015 07:28:00 GMT', '-5', 'soon', '', null, undefined, '1.5']) {
    assert.strictEqual(parseRetryAfterMs(bad), null, `unusable: ${bad}`)
  }
})

test('backoff is exponential, deterministic and capped', () => {
  assert.strictEqual(backoffMs(0), 1000)
  assert.strictEqual(backoffMs(1), 2000)
  assert.strictEqual(backoffMs(2), 4000)
  assert.ok(backoffMs(50) <= MAX_RETRY_AFTER_MS, 'never exceeds the ceiling')
})

test('attempt cap and cumulative-delay cap both terminate a hostile retry loop', () => {
  assert.deepStrictEqual(planRetry({ status: 429, retryAfterHeader: '5', attempt: 0, elapsedRetryMs: 0 }),
    { retry: true, delayMs: 5000 })
  // Exhaustion still names the provider condition, plus an explicit `exhausted` flag.
  assert.deepStrictEqual(planRetry({ status: 429, retryAfterHeader: '5', attempt: MAX_RETRIES, elapsedRetryMs: 0 }),
    { retry: false, code: 'throttled', exhausted: true }, 'attempt cap')
  assert.deepStrictEqual(
    planRetry({ status: 429, retryAfterHeader: '30', attempt: 1, elapsedRetryMs: MAX_TOTAL_RETRY_DELAY_MS - 1000 }),
    { retry: false, code: 'throttled', exhausted: true }, 'cumulative delay cap')
  assert.deepStrictEqual(planRetry({ status: 503, retryAfterHeader: null, attempt: MAX_RETRIES, elapsedRetryMs: 0 }),
    { retry: false, code: 'server_error', exhausted: true }, '5xx exhaustion keeps its own code')
  assert.deepStrictEqual(planRetry({ status: 403, retryAfterHeader: null, attempt: 0, elapsedRetryMs: 0 }),
    { retry: false, code: 'forbidden' }, 'non-retryable short-circuits')
})

test('status codes map to controlled codes with no provider text', () => {
  assert.strictEqual(statusToCode(401), 'unauthorized')
  assert.strictEqual(statusToCode(403), 'forbidden')
  assert.strictEqual(statusToCode(404), 'not_found')
  assert.strictEqual(statusToCode(410), 'resync_required')
  assert.strictEqual(statusToCode(429), 'throttled')
  assert.strictEqual(statusToCode(500), 'server_error')
  assert.strictEqual(statusToCode(418), 'transport_failure')
})

test('run caps are enforced for pages, messages and content fetches', () => {
  assert.strictEqual(checkRunCaps({ pages: 1, messages: 1, contentFetches: 1 }), null)
  assert.strictEqual(checkRunCaps({ pages: MAX_PAGES_PER_RUN + 1 }), 'max_pages_exceeded')
  assert.strictEqual(checkRunCaps({ messages: MAX_MESSAGES_PER_RUN + 1 }), 'max_messages_exceeded')
  assert.strictEqual(checkRunCaps({ contentFetches: 100000 }), 'max_content_fetches_exceeded')
})

test('an over-large response is refused before it is parsed', () => {
  assert.strictEqual(checkResponseSize(fakeRes(200, { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } })),
    'response_too_large')
  assert.strictEqual(checkResponseSize(fakeRes(200, { headers: { 'content-length': '100' } })), null)
})

// ── Executor ─────────────────────────────────────────────────────────────────
console.log('\nexecutor (injected fetch only)')

await atest('there is no default fetch — a missing injection throws, never calls out', async () => {
  await assert.rejects(
    () => executeGraphRequest({ request: buildFolderDeltaRequest({ folder: 'inbox' }), accessToken: 't' }),
    /fetch_not_injected/)
})

await atest('the executor refuses a URL outside the Graph /me origin', async () => {
  await assert.rejects(() => executeGraphRequest({
    request: { method: 'GET', url: 'https://evil.example.invalid/x', headers: {} },
    accessToken: 't', fetchImpl: async () => fakeRes(200),
  }), /forbidden_request_url/)
})

await atest('a 200 returns parsed JSON and the bearer token is sent but never returned', async () => {
  let sawAuth = null
  const res = await executeGraphRequest({
    request: buildFolderDeltaRequest({ folder: 'inbox' }),
    accessToken: 'SECRET-TOKEN-VALUE',
    fetchImpl: async (_url, init) => { sawAuth = init.headers.Authorization; return fakeRes(200, { json: { value: [] } }) },
  })
  assert.ok(res.ok && Array.isArray(res.json.value))
  assert.strictEqual(sawAuth, 'Bearer SECRET-TOKEN-VALUE')
  assert.ok(!JSON.stringify(res).includes('SECRET-TOKEN-VALUE'), 'token must never appear in the result')
})

await atest('429 with Retry-After is honored once, then succeeds', async () => {
  const waits = []
  let calls = 0
  const res = await executeGraphRequest({
    request: buildFolderDeltaRequest({ folder: 'inbox' }),
    accessToken: 't',
    fetchImpl: async () => { calls += 1; return calls === 1 ? fakeRes(429, { headers: { 'retry-after': '7' } }) : fakeRes(200, { json: { value: [] } }) },
    sleepImpl: async (ms) => { waits.push(ms) },
  })
  assert.ok(res.ok)
  assert.strictEqual(calls, 2)
  assert.deepStrictEqual(waits, [7000], 'the documented Retry-After delay is used verbatim')
})

await atest('persistent throttling terminates with a controlled code and a bounded call count', async () => {
  let calls = 0
  const res = await executeGraphRequest({
    request: buildFolderDeltaRequest({ folder: 'inbox' }),
    accessToken: 't',
    fetchImpl: async () => { calls += 1; return fakeRes(429, { headers: { 'retry-after': '1' } }) },
    sleepImpl: noSleep,
  })
  assert.ok(!res.ok)
  assert.strictEqual(res.code, 'throttled')
  assert.ok(calls <= MAX_RETRIES + 1, `bounded attempts, saw ${calls}`)
})

await atest('401/403/404 are returned immediately without a retry', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found']]) {
    let calls = 0
    const res = await executeGraphRequest({
      request: buildFolderDeltaRequest({ folder: 'inbox' }),
      accessToken: 't',
      fetchImpl: async () => { calls += 1; return fakeRes(status) },
      sleepImpl: noSleep,
    })
    assert.strictEqual(res.code, code)
    assert.strictEqual(calls, 1, `${status} must not retry`)
  }
})

await atest('an expired deltaLink surfaces as resync_required, not as a silent success', async () => {
  const res = await executeGraphRequest({
    request: buildFolderDeltaRequest({ folder: 'inbox' }),
    accessToken: 't',
    fetchImpl: async () => fakeRes(410),
    sleepImpl: noSleep,
  })
  assert.strictEqual(res.code, 'resync_required')
})

await atest('a thrown transport error never leaks the URL or the message', async () => {
  const res = await executeGraphRequest({
    request: buildFolderDeltaRequest({ folder: 'inbox' }),
    accessToken: 't',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED https://graph.microsoft.com/v1.0/me/secret') },
    sleepImpl: noSleep,
  })
  assert.ok(!res.ok)
  assert.strictEqual(res.code, 'transport_failure')
  const s = JSON.stringify(res)
  assert.ok(!s.includes('graph.microsoft.com') && !s.includes('ECONNREFUSED'), 'no provider detail in the result')
})

await atest('unparseable JSON fails closed as malformed_response', async () => {
  const res = await executeGraphRequest({
    request: buildFolderDeltaRequest({ folder: 'inbox' }),
    accessToken: 't',
    fetchImpl: async () => fakeRes(200, { throwOnJson: true }),
    sleepImpl: noSleep,
  })
  assert.strictEqual(res.code, 'malformed_response')
})

// ── Page + content readers ───────────────────────────────────────────────────
console.log('\npage and content readers')

test('a delta page with a valid nextLink is accepted and marked incomplete', () => {
  const r = readDeltaPage({ value: [{ id: 'a' }], '@odata.nextLink': GOOD_NEXT })
  assert.ok(r.ok)
  assert.strictEqual(r.nextLink, GOOD_NEXT)
  assert.strictEqual(r.deltaLink, null)
  assert.strictEqual(r.complete, false)
})

test('a delta page with a deltaLink completes the round', () => {
  const r = readDeltaPage({ value: [], '@odata.deltaLink': GOOD_DELTA })
  assert.ok(r.ok && r.complete === true && r.deltaLink === GOOD_DELTA)
})

test('a poisoned nextLink invalidates the whole page', () => {
  const r = readDeltaPage({ value: [], '@odata.nextLink': 'https://evil.example.invalid/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=a' })
  assert.ok(!r.ok && r.code === 'invalid_link')
})

test('malformed pages and oversized pages fail closed', () => {
  assert.strictEqual(readDeltaPage(null).code, 'malformed_response')
  assert.strictEqual(readDeltaPage({}).code, 'malformed_response')
  assert.strictEqual(readDeltaPage({ value: 'nope' }).code, 'malformed_response')
  assert.strictEqual(readDeltaPage({ value: new Array(MAX_PAGE_SIZE + 1).fill({ id: 'x' }) }).code, 'response_too_large')
  assert.strictEqual(readDeltaPage({ value: [], '@odata.nextLink': GOOD_NEXT, '@odata.deltaLink': GOOD_DELTA }).code,
    'malformed_response', 'a page cannot be both continued and complete')
})

test('content is bound to the requested message id', () => {
  const ok = readMessageContent({ id: 'M1', body: { contentType: 'text', content: 'hello' }, uniqueBody: { contentType: 'text', content: 'hello' } }, 'M1')
  assert.ok(ok.ok && ok.bodyContent === 'hello' && ok.uniqueBodyContent === 'hello')
  const mismatch = readMessageContent({ id: 'OTHER', body: { contentType: 'text', content: 'x' } }, 'M1')
  assert.strictEqual(mismatch.code, 'malformed_response', 'a response for a different message is refused')
})

test('content reader rejects empty and oversized bodies', () => {
  assert.strictEqual(readMessageContent({ id: 'M1', body: { contentType: 'text', content: '' } }, 'M1').code, 'empty_content')
  assert.strictEqual(
    readMessageContent({ id: 'M1', body: { contentType: 'text', content: 'x'.repeat(300_000) } }, 'M1').code,
    'response_too_large')
})

test('content reader keeps ONLY the two body projections', () => {
  const r = readMessageContent({
    id: 'M1',
    body: { contentType: 'html', content: '<p>hi</p>' },
    uniqueBody: { contentType: 'html', content: '<p>hi</p>' },
    hasAttachments: true,
    attachments: [{ name: 'secret.pdf', contentBytes: 'AAAA' }],
    internetMessageHeaders: [{ name: 'X-Secret', value: 'leak' }],
    from: { emailAddress: { address: 'someone@example.invalid' } },
  }, 'M1')
  assert.ok(r.ok)
  assert.deepStrictEqual(Object.keys(r).sort(),
    ['bodyContent', 'bodyContentType', 'ok', 'uniqueBodyContent', 'uniqueBodyContentType'])
  const s = JSON.stringify(r)
  assert.ok(!s.includes('secret.pdf') && !s.includes('leak') && !s.includes('example.invalid'),
    'attachments, headers and addresses must not survive the content read')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
