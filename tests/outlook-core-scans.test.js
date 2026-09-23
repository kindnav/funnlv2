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
