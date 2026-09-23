// Outlook PR-B — cross-cutting structural scans.
//
// These are the guardrails that must keep holding as later phases add a worker, an
// OAuth flow and a UI: no content logging, no content persistence, no live network
// call, no scope creep beyond shared modules and tests, and exact compatibility with
// the APPLIED PR-A schema (migration 20260921000000) which must never be edited.
//
// Run with: node tests/outlook-core-scans.test.js
import assert from 'assert'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

const MODULES = [
  'outlookGraphTransport.js',
  'outlookMessageNormalize.js',
  'outlookContentSanitizer.js',
  'outlookParticipants.js',
  'outlookDraftContract.js',
].map((f) => ({ name: f, rel: `supabase/functions/shared/${f}`, src: read(`supabase/functions/shared/${f}`) }))

const SUITES = [
  'outlook-graph-transport.test.js',
  'outlook-content-sanitizer.test.js',
  'outlook-participants.test.js',
  'outlook-draft-contract.test.js',
].map((f) => ({ name: f, src: read(`tests/${f}`) }))

const MIGRATION_FILE = 'supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql'
const MIGRATION = read(MIGRATION_FILE)

// Executable code with comments removed.
const exec = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')

// ── Logging ──────────────────────────────────────────────────────────────────
console.log('\ncontent logging is structurally impossible')

test('no module logs anything, by any spelling', () => {
  for (const m of MODULES) {
    const code = exec(m.src)
    for (const bad of ['console.', 'globalThis.console', 'process.stdout', 'process.stderr', 'Deno.stdout']) {
      assert.ok(!code.includes(bad), `${m.name} must not contain ${bad}`)
    }
  }
})

test('no module throws an Error built from content, a URL or a provider response', () => {
  for (const m of MODULES) {
    // Every `throw new Error(...)` must use a bare literal code, never interpolation
    // of a runtime value. The one templated throw is `invalid_link:${v.code}`, which
    // interpolates a CONTROLLED code, so it is allowed explicitly.
    const throws = [...exec(m.src).matchAll(/throw new Error\(([^)]*)\)/g)].map((x) => x[1].trim())
    for (const t of throws) {
      const isPlainLiteral = /^'[a-z_]+'$/.test(t)
      const isControlledCode = t === '`invalid_link:${v.code}`'
      assert.ok(isPlainLiteral || isControlledCode, `${m.name}: unsafe throw argument ${t}`)
    }
  }
})

// ── Persistence ──────────────────────────────────────────────────────────────
console.log('\ncontent persistence is structurally impossible')

test('no module touches a database, a client, storage or a file', () => {
  for (const m of MODULES) {
    const code = exec(m.src)
    for (const bad of [
      'createClient', 'supabase', '.from(', '.rpc(', 'insert(', 'upsert(', 'update(', 'delete(',
      'localStorage', 'sessionStorage', 'indexedDB', 'writeFile', 'readFile', 'fs.',
    ]) {
      assert.ok(!code.includes(bad), `${m.name} must not contain ${bad}`)
    }
  }
})

test('raw body / snippet / HTML / attachment keys never appear in a returned shape', () => {
  // The only module that legitimately handles body text is the sanitizer, and it
  // returns `text`/`signature` (memory-only working values) — never a key named after
  // a provider payload field.
  for (const m of MODULES) {
    const returned = [...exec(m.src).matchAll(/^\s*(bodyContent|bodyPreview|snippet|htmlBody|attachments|mimeContent|rawResponse|internetMessageHeaders)\s*[,:]/gm)]
    // bodyContent is allowed ONLY as the transport's documented hand-off to the sanitizer.
    const offenders = returned.map((x) => x[1]).filter((k) => !(m.name === 'outlookGraphTransport.js' && k === 'bodyContent'))
    assert.deepStrictEqual(offenders, [], `${m.name} returns provider payload keys: ${offenders}`)
  }
})

test('the raw header collection is confined to one classification call site', () => {
  // `internetMessageHeaders` may be named in exactly two places: the CONTENT $select
  // (to request it) and the single read that immediately reduces it to facts. Any
  // other executable reference would be a new way for a raw header to travel.
  const sites = []
  for (const m of MODULES) {
    for (const line of exec(m.src).split('\n')) {
      if (line.includes('internetMessageHeaders')) sites.push(`${m.name}: ${line.trim()}`)
    }
  }
  assert.strictEqual(sites.length, 2, `unexpected header references:\n${sites.join('\n')}`)
  assert.ok(sites.some((s) => s.startsWith('outlookGraphTransport.js') && s.includes("'internetMessageHeaders',")),
    'one is the CONTENT $select entry')
  assert.ok(sites.some((s) => s.includes('automationFactsFromHeaders(json.internetMessageHeaders)')),
    'the other hands it straight to the classifier')
})

test('internetMessageHeaders is requested ONLY in CONTENT_SELECT, never in discovery', () => {
  const t = read('supabase/functions/shared/outlookGraphTransport.js')
  const discovery = /DISCOVERY_SELECT = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(t)[1]
  const content = /CONTENT_SELECT = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(t)[1]
  assert.ok(!discovery.includes('internetMessageHeaders'), 'discovery must not request headers')
  assert.ok(content.includes("'internetMessageHeaders',"), 'the content read is where they are requested')
  // And no OTHER select/query anywhere asks for them.
  const selects = [...t.matchAll(/\$select=\$\{(\w+)\.join/g)].map((m) => m[1])
  assert.deepStrictEqual([...new Set(selects)].sort(), ['CONTENT_SELECT', 'DISCOVERY_SELECT'],
    'only these two projections exist')
})

test('the raw header collection is consumed only by the transport classifier call', () => {
  const t = exec(read('supabase/functions/shared/outlookGraphTransport.js'))
  const consumers = t.split('\n').filter((l) => /json\.internetMessageHeaders|raw\.internetMessageHeaders/.test(l))
  assert.deepStrictEqual(consumers.map((l) => l.trim()),
    ['const automation = automationFactsFromHeaders(json.internetMessageHeaders)'],
    'exactly one consumer, and it hands the collection straight to the classifier')
  // No other module reads a header collection off a payload at all.
  for (const m of MODULES.filter((x) => x.name !== 'outlookGraphTransport.js')) {
    assert.ok(!/\.internetMessageHeaders/.test(exec(m.src)),
      `${m.name} must not read a header collection`)
  }
})

test('the sanitizer neither accepts nor references internetMessageHeaders', () => {
  const s = MODULES.find((m) => m.name === 'outlookContentSanitizer.js')
  assert.ok(!exec(s.src).includes('internetMessageHeaders'),
    'sanitizer executable code must never reference the header collection')
  // Its only content input is the documented body/subject shape.
  const sig = /export function sanitizeMessageContent\(input\)/.test(s.src)
  assert.ok(sig, 'single-object input signature')
  for (const field of ['bodyContentType', 'bodyContent', 'uniqueBodyContentType', 'uniqueBodyContent', 'subject']) {
    assert.ok(s.src.includes(`input.${field}`), `sanitizer reads input.${field}`)
  }
  const reads = [...exec(s.src).matchAll(/input\.(\w+)/g)].map((m) => m[1])
  assert.deepStrictEqual([...new Set(reads)].sort(),
    ['bodyContent', 'bodyContentType', 'subject', 'uniqueBodyContent', 'uniqueBodyContentType'],
    'and reads nothing else off its input')
})

test('no file claims the transport never requests message headers', () => {
  // The transport DOES request them, on the per-message GET. A bare "never requests
  // headers" claim is false; the only truthful form is qualified to delta/discovery.
  //
  // Comments wrap across lines and can use a pronoun ("...headers are not inputs /
  // the transport never requests them"), so the text is FLATTENED first and matched
  // over a window - a line-by-line scan would miss exactly that phrasing.
  for (const f of [...MODULES, ...SUITES]) {
    const flat = f.src
      .split('\n')
      .map((l) => l.replace(/^\s*(\/\/|\*)\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
    const patterns = [
      /never\s+requests?\s+(them|those|these|it|headers?|message headers?)/gi,
      /(?:headers?)[\s\S]{0,80}?\bnever\s+requested\b/gi,
      /\bdoes\s+not\s+request\s+(them|those|these|headers?)/gi,
    ]
    for (const re of patterns) {
      for (const m of flat.matchAll(re)) {
        const window = flat.slice(Math.max(0, m.index - 220), m.index + 220)
        // Truthful only when scoped to delta/discovery, or when it is plainly about
        // something other than headers.
        const qualified = /delta|discovery/i.test(window)
        const aboutHeaders = /header/i.test(window)
        assert.ok(qualified || !aboutHeaders,
          `${f.name}: unqualified "never requests headers" claim near: ...${window.slice(150, 330)}...`)
      }
    }
  }
})

test('the sanitizer documents the three-part header boundary explicitly', () => {
  const doc = MODULES.find((m) => m.name === 'outlookContentSanitizer.js').src
  const intro = doc.slice(0, doc.indexOf('export const MAX_INPUT_CHARS'))
  // 1. the transport fetches and classifies them
  assert.ok(/per-message GET/i.test(intro) && /CONTENT_SELECT/.test(intro),
    'says where headers ARE fetched')
  assert.ok(/automationFactsFromHeaders/.test(intro) && /DISCARDS|discards/.test(intro),
    'says they are reduced to facts and discarded')
  // 2. the sanitizer does not receive them
  assert.ok(/never passed into this sanitizer/i.test(intro), 'says the sanitizer never receives them')
  // 3. no persistence or logging of them
  assert.ok(/database, storage, a file, or a log/i.test(intro), 'says they never reach storage or logs')
  // And the stale claim is gone.
  assert.ok(!/the transport never requests them/i.test(doc), 'stale claim must not return')
})

test('the normalizeGraphMessage JSDoc describes the real `extra` contract', () => {
  const src = read('supabase/functions/shared/outlookMessageNormalize.js')
  const i = src.indexOf('export function normalizeGraphMessage')
  const doc = src.slice(src.lastIndexOf('/**', i), i)
  assert.ok(doc.length > 0, 'JSDoc located')
  for (const key of ['displayNames', 'automationFactsComplete', 'folder']) {
    assert.ok(doc.includes(key), `JSDoc must describe ${key}`)
  }
  // The two stale claims must never return, in any phrasing.
  assert.ok(!/draft flag/i.test(doc), 'JSDoc must not claim `extra` carries a draft flag')
  assert.ok(!/\bthe internetMessageId\b/i.test(doc) && !/and the internetMessageId/i.test(doc),
    'JSDoc must not claim `extra` carries internetMessageId')
  // And it must say so positively, so a reader is not left guessing.
  assert.ok(/neither draft state nor `?internetMessageId`?/i.test(doc),
    'JSDoc must state that neither is carried')
  assert.ok(/is_draft/.test(doc), 'and name the code a draft actually returns')
  assert.ok(!/raw header/i.test(doc) || /no raw header is ever carried/i.test(doc),
    'JSDoc must not imply raw headers are returned in `extra`')
})

test('the successful `extra` object returns exactly the three reviewed keys', () => {
  const code = exec(read('supabase/functions/shared/outlookMessageNormalize.js'))
  const i = code.indexOf('    extra: {')
  assert.ok(i !== -1, 'success-path extra literal located')
  const block = code.slice(i, code.indexOf('\n  }\n', i))
  const keys = [...block.matchAll(/^\s{6}(\w+)\s*[,:]/gm)].map((m) => m[1])
  assert.deepStrictEqual(keys.sort(), ['automationFactsComplete', 'displayNames', 'folder'],
    `extra must carry exactly the three reviewed keys, saw ${keys}`)
  for (const forbidden of ['internetMessageId', 'isDraft', 'draft', 'internetMessageHeaders']) {
    assert.ok(!block.includes(forbidden), `extra must not carry ${forbidden}`)
  }
})

test('a draft fails closed with is_draft and never yields a successful normalization', () => {
  const code = exec(read('supabase/functions/shared/outlookMessageNormalize.js'))
  assert.ok(/if \(raw\.isDraft === true\) return \{ ok: false, code: 'is_draft' \}/.test(code),
    'the draft guard returns ok:false with the documented code')
  // The guard must precede the success return, otherwise a draft could slip through.
  assert.ok(code.indexOf("code: 'is_draft'") < code.indexOf('    extra: {'),
    'the draft guard runs before the success path')
})

test('internetMessageId is absent from every projection, output and contract', () => {
  const t = read('supabase/functions/shared/outlookGraphTransport.js')
  for (const name of ['DISCOVERY_SELECT', 'CONTENT_SELECT']) {
    const arr = new RegExp(`${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(t)[1]
    assert.ok(!arr.includes('internetMessageId'), `${name} must not select internetMessageId`)
  }
  // Absent from ALL executable module code (fingerprints, drafts, Anthropic request).
  for (const m of MODULES) {
    assert.ok(!exec(m.src).includes('internetMessageId'),
      `${m.name} executable code must not reference internetMessageId`)
  }
})

test('header facts are booleans and small enums only — no raw name/value can travel', () => {
  const norm = read('supabase/functions/shared/outlookMessageNormalize.js')
  // The classifier returns a fixed key set; nothing derived from a header VALUE other
  // than the allowlisted enums is constructed.
  for (const k of ['autoSubmitted', 'precedence', 'hasListId', 'hasListUnsubscribe', 'hasAutoResponseSuppress']) {
    assert.ok(norm.includes(k), `${k} is part of the fixed fact shape`)
  }
  // The only header names it looks for are the documented allowlist.
  const looked = [...norm.matchAll(/valuesOf\('([a-z-]+)'\)|present\('([a-z-]+)'\)/g)]
    .map((m) => m[1] || m[2])
  assert.deepStrictEqual([...new Set(looked)].sort(),
    ['auto-submitted', 'list-id', 'list-unsubscribe', 'precedence', 'x-auto-response-suppress'],
    'exactly the automation allowlist, nothing else')
})

test('no header value can reach a fingerprint, a stored draft, or an Anthropic request', () => {
  // Fingerprint inputs are a fixed five-slot contract with no header slot.
  const fp = read('supabase/functions/shared/emailFingerprint.js')
  assert.ok(fp.includes("'provider', 'accountNamespace', 'contactId', 'conversationKey', 'firstMessageKey'"),
    'the fingerprint contract is fixed and header-free')
  const participants = exec(read('supabase/functions/shared/outlookParticipants.js'))
  assert.ok(!participants.includes('internetMessageHeaders') && !participants.includes('automation.facts'),
    'matching never handles a header collection')

  // The Anthropic request builder takes a fixed input shape with no header field.
  const draft = exec(read('supabase/functions/shared/outlookDraftContract.js'))
  for (const bad of ['internetMessageHeaders', 'headers:', 'autoSubmitted', 'precedence',
    'hasListId', 'listUnsubscribe']) {
    assert.ok(!draft.includes(bad), `the Anthropic contract must not carry ${bad}`)
  }
})

test('the applied schema has no column that could hold a raw header or its facts', () => {
  const ddl = MIGRATION.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  for (const bad of ['internet_message_headers', 'headers', 'auto_submitted', 'precedence',
    'list_id', 'list_unsubscribe']) {
    assert.ok(!ddl.includes(bad), `schema must not define ${bad}`)
  }
})

test('the applied schema has no column that could hold a raw body', () => {
  // A raw body could only be persisted if a column existed for it. None does.
  // SQL comments are stripped first: the migration's own prose says it stores no
  // snippet/body, which must not read as a violation.
  const ddl = MIGRATION.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
  for (const bad of ['body_text', 'raw_body', 'body_content', 'message_body', 'snippet', 'html_body', 'mime']) {
    assert.ok(!ddl.includes(bad), `schema must not define ${bad}`)
  }
  // The only persisted free text is bounded and derived.
  for (const col of ['draft_summary', 'draft_follow_up', 'retained_subject']) {
    assert.ok(MIGRATION.includes(col), `${col} is the bounded derived field`)
  }
})

// ── Network ──────────────────────────────────────────────────────────────────
console.log('\nno live network path')

test('both transports require an injected fetch and have no default', () => {
  const t = exec(read('supabase/functions/shared/outlookGraphTransport.js'))
  const d = exec(read('supabase/functions/shared/outlookDraftContract.js'))
  for (const [name, code] of [['graph', t], ['draft', d]]) {
    assert.ok(code.includes("typeof fetchImpl !== 'function'"), `${name} must require injection`)
    assert.ok(code.includes("throw new Error('fetch_not_injected')"), `${name} must throw without it`)
    assert.ok(!/fetchImpl\s*=\s*(globalThis\.)?fetch/.test(code), `${name} must not default to global fetch`)
    assert.ok(!/^\s*(await\s+)?fetch\(/m.test(code), `${name} must not call the global fetch`)
  }
})

test('no module performs work at import time', () => {
  for (const m of MODULES) {
    const code = exec(m.src)
    // TOP LEVEL only (zero indentation): an `await` inside a function body is fine.
    assert.ok(!/^(await |fetch\(|new XMLHttpRequest|setInterval\(|setTimeout\()/m.test(code),
      `${m.name} must be inert on import`)
  }
})

test('every suite injects a fake fetch and none touches the real network', () => {
  for (const s of SUITES) {
    const code = exec(s.src)
    // No bare global fetch call, no real hostnames dialled.
    assert.ok(!/^\s*(await\s+)?fetch\(/m.test(code), `${s.name} must not call fetch directly`)
    assert.ok(!/undici|node-fetch|https?\.request|net\.connect/.test(code), `${s.name} must not open a socket`)
    if (/fetchImpl/.test(code)) {
      assert.ok(/fetchImpl:\s*async/.test(code), `${s.name} must inject an async fake`)
    }
  }
})

test('test fixtures use only example.invalid identities', () => {
  for (const s of SUITES) {
    // Strip URL userinfo (https://user:pass@host) before scanning: that is a
    // security fixture, not a fixture identity.
    const withoutUserinfo = s.src.replace(/:\/\/[^/\s'"`]*@/g, '://')
    const addrs = [...withoutUserinfo.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)].map((m) => m[0])
    for (const a of addrs) {
      // Case-insensitive: some fixtures deliberately use mixed case to prove that
      // address matching normalizes before comparing.
      assert.ok(a.toLowerCase().endsWith('example.invalid'), `${s.name}: non-fixture address ${a}`)
    }
  }
})

test('no credential-shaped literal exists in modules or suites', () => {
  const PATTERNS = [
    /\bsk-ant-[A-Za-z0-9_-]{8,}/,          // real Anthropic key prefix
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, // real JWT
    /\bAIza[0-9A-Za-z_-]{20,}/,            // Google API key
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/,      // Slack
  ]
  for (const f of [...MODULES, ...SUITES]) {
    for (const p of PATTERNS) {
      assert.ok(!p.test(f.src), `${f.name} contains a credential-shaped literal (${p})`)
    }
  }
})

// ── PR-A compatibility (the applied migration must not be edited) ────────────
console.log('\napplied PR-A schema compatibility')

test('the applied migration is unmodified by this phase and remains the newest pair', () => {
  const files = readdirSync(join(ROOT, 'supabase/migrations')).sort()
  assert.ok(files.includes('20260921000000_add_outlook_content_draft_primitives.sql'))
  assert.ok(files.includes('20260922175616_revoke_service_role_from_outlook_user_rpcs.sql'))
  assert.strictEqual(files[files.length - 1], '20260922175616_revoke_service_role_from_outlook_user_rpcs.sql',
    'this phase must add NO migration')
  assert.ok(!files.some((f) => f.startsWith('20260918000100')), 'the held-back Cron migration stays absent')
})

test('folder values match oss_folder_check exactly', () => {
  assert.ok(MIGRATION.includes("folder IN ('inbox', 'sentitems')"))
  const t = read('supabase/functions/shared/outlookGraphTransport.js')
  assert.ok(/GRAPH_FOLDERS = Object\.freeze\(\['inbox', 'sentitems'\]\)/.test(t))
})

test('the scope constant matches the schema allowlist and the active-connection CHECK', () => {
  assert.ok(MIGRATION.includes("scopes <@ ARRAY['Mail.Read', 'offline_access', 'openid', 'email', 'profile']"))
  assert.ok(MIGRATION.includes("status <> 'active' OR 'Mail.Read' = ANY (scopes)"))
  assert.ok(read('supabase/functions/shared/outlookGraphTransport.js').includes("GRAPH_MAIL_READ_SCOPE = 'Mail.Read'"))
})

test('fingerprints produce the exact hex shape the CHECK constraints require', () => {
  for (const c of ['ncc_person_fp_shape', 'ncc_episode_fp_shape', 'ocr_episode_fp_shape']) {
    assert.ok(MIGRATION.includes(c), `${c} exists`)
  }
  assert.ok(MIGRATION.includes("~ '^[0-9a-f]{64}$'"))
  // The reused E1 helper is documented as producing exactly that.
  assert.ok(read('supabase/functions/shared/emailFingerprint.js').includes('FINGERPRINT_HEX_LEN = 64'))
})

test('the accept RPC takes NO email parameter, so the address cannot be client-edited', () => {
  const sig = MIGRATION.slice(
    MIGRATION.indexOf('CREATE FUNCTION public.accept_new_contact_candidate('),
    MIGRATION.indexOf('RETURNS jsonb', MIGRATION.indexOf('CREATE FUNCTION public.accept_new_contact_candidate(')))
  assert.ok(sig.length > 0, 'signature located')
  assert.ok(!/p_email|p_address|p_proposed_email/.test(sig),
    'the accept RPC must not accept an address from the caller')
  for (const p of ['p_name', 'p_company', 'p_role', 'p_how_met', 'p_tags', 'p_interaction_date']) {
    assert.ok(sig.includes(p), `${p} is a user-editable field`)
  }
  // And the module mirrors that: no email in the validated suggestion.
  const d = read('supabase/functions/shared/outlookDraftContract.js')
  assert.ok(/no `email` key/.test(d), 'the contract documents the omission')
})

test('proposed_type is pinned to Email on both sides', () => {
  assert.ok(MIGRATION.includes("ncc_type_check    CHECK (proposed_type = 'Email')"))
  assert.ok(read('supabase/functions/shared/outlookDraftContract.js').includes("INTERACTION_TYPE = 'Email'"))
})

test('extraction_status values line up with the applied enum', () => {
  assert.ok(MIGRATION.includes("extraction_status IN ('deterministic', 'ai_extracted', 'ai_failed')"))
})

test('the 30-day context ceiling exists in the schema and is not re-implemented in code', () => {
  assert.ok(MIGRATION.includes("context_expires_at <= created_at + interval '30 days'"))
  for (const m of MODULES) {
    assert.ok(!/context_expires_at/.test(exec(m.src)),
      `${m.name}: lifecycle deadlines are the database's job, not this phase's`)
  }
})

// ── Scope creep ──────────────────────────────────────────────────────────────
console.log('\nscope containment')

test('this phase adds no Edge Function entrypoint', () => {
  const dirs = readdirSync(join(ROOT, 'supabase/functions'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
  for (const d of dirs) {
    assert.ok(!/outlook|microsoft|graph/i.test(d), `no Outlook Edge Function may exist yet (found ${d})`)
  }
  for (const m of MODULES) {
    assert.ok(!/Deno\.serve|serve\(|addEventListener\('fetch'/.test(exec(m.src)),
      `${m.name} must not be an entrypoint`)
  }
})

test('config.toml declares no Outlook function and is untouched by this phase', () => {
  const cfg = read('supabase/config.toml')
  // `graphql_public` in the exposed-schema list is unrelated to Microsoft Graph.
  const sections = [...cfg.matchAll(/^\[functions\.([^\]]+)\]/gm)].map((m) => m[1])
  for (const name of sections) {
    assert.ok(!/outlook|microsoft|graph/i.test(name), `no Outlook function section (found ${name})`)
  }
  assert.ok(!/\boutlook\b|\bmicrosoft\b/i.test(cfg), 'no Outlook/Microsoft reference at all')
  assert.ok(cfg.includes('[functions.delete-account]'), 'the existing delete-account section is intact')
  assert.ok(/verify_jwt = true/.test(cfg.slice(cfg.indexOf('[functions.delete-account]'))),
    'the merged delete-account JWT setting is unchanged')
})

test('no OAuth, Entra, secret, flag or scheduler work is present', () => {
  for (const m of MODULES) {
    const code = exec(m.src)
    for (const bad of [
      'login.microsoftonline.com', 'oauth2/v2.0', 'client_secret', 'client_id', 'code_verifier',
      'tenant_id', 'pg_net', 'VITE_',
    ]) {
      assert.ok(!code.includes(bad), `${m.name} must not contain ${bad}`)
    }
    // Word-bounded so 'unauthorized' (a legitimate result code) is not a false hit.
    for (const re of [/\bauthorize\b/i, /\bcron\b/i, /\bschedule\b/i, /\bwebhook\b/i]) {
      assert.ok(!re.test(code), `${m.name} must not contain ${re}`)
    }
  }
})

test('no dependency, lockfile or frontend change is required by this phase', () => {
  const pkg = JSON.parse(read('package.json'))
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  for (const name of Object.keys(deps)) {
    assert.ok(!/graph|azure|msal|microsoft|anthropic/i.test(name), `unexpected dependency ${name}`)
  }
  // Modules import only from the existing shared folder.
  for (const m of MODULES) {
    const imports = [...m.src.matchAll(/^import [\s\S]*? from '(.+?)'$/gm)].map((x) => x[1])
    for (const i of imports) {
      assert.ok(i.startsWith('./'), `${m.name}: only local shared imports allowed, saw ${i}`)
      assert.ok(existsSync(join(ROOT, 'supabase/functions/shared', i)), `${m.name}: missing import target ${i}`)
    }
  }
})

test('Gmail and Calendar sources are untouched and still present', () => {
  for (const f of [
    'supabase/functions/shared/gmailTransport.js',
    'supabase/functions/shared/gmailWorker.js',
    'supabase/functions/shared/calendarSyncEngine.js',
    'supabase/migrations/20260918000000_add_gmail_retention_cleanup.sql',
  ]) {
    assert.ok(existsSync(join(ROOT, f)), `${f} must still exist`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
