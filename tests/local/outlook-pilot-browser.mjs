#!/usr/bin/env node
// THE FIRST-PILOT UI, DRIVEN IN A REAL BROWSER.
//
// Real Chrome over the DevTools Protocol (no automation framework; Node 24's global
// WebSocket is the only thing needed), serving the REAL built bundle over HTTPS on the
// canonical host, against the REAL PostgREST and a REAL Postgres with every migration.
//
// WHY THE CANONICAL HOST. resolveOauthStartUrl refuses any origin but
// https://www.getfunnl.com, because a binding cookie set elsewhere can never reach the
// branded callback. So the browser is told to resolve that host to this machine
// (--host-resolver-rules), and a local HTTPS server answers with a self-signed cert. The
// app's own origin guard is therefore SATISFIED, not bypassed.
//
// WHAT IS STUBBED, AND WHAT IS NOT:
//   * GoTrue is stubbed by a local sink - a real sign-in POST happens, and the session
//     supabase-js stores is a JWT minted with the PostgREST secret, so every later read
//     is a genuine RLS-enforced request.
//   * /rest/v1/* is PROXIED to the real PostgREST. Nothing about the data path is faked.
//   * /api/outlook-oauth-start is stubbed: the Edge Function is not deployed and must not
//     be. Its response is a Microsoft-SHAPED url, and the navigation to it is intercepted
//     and blocked, so nothing leaves this machine.
//
// Sections 7-9 cover the background-sync slice: the Suggestions navigation and its badge,
// the Settings sync status rendered from persisted rows, and a proposal that arrives while
// the queue is open. Microsoft and the worker are NOT run here; the rows they would leave
// are written directly, and the harness says so where it does it.
//
// RUN: node tests/local/outlook-pilot-browser.mjs

import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { createServer as createHttp } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { join, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createServer as netCreateServer } from 'node:net'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
// The self-signed cert and the two built bundles live OUTSIDE the repo: they are
// throwaway artefacts, and a minified bundle inside tests/ makes the linter report
// thousands of warnings in generated code.
const WORK = join(tmpdir(), 'funnl-pilot-browser')
const PG = 'funnl-pilot-browser-pg'
const REST = 'funnl-pilot-browser-rest'
const NET = 'funnl-pilot-browser-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const PGRST = 'http://127.0.0.1:53991'
const SINK = 53992
const APP_PORT = 443
// Chosen per run, never fixed. A fixed port is how a STALE browser gets attached to:
// chrome.kill() reaps the process we spawned, but --headless=new leaves the browser
// itself alive holding the port, so the next run connects to the PREVIOUS browser -
// complete with its localStorage session, silently skipping the sign-in this harness
// is meant to exercise. Found exactly that way: the click log came back with no
// sign-in entries. Teardown now closes the browser over CDP as well.
let CDP_PORT = 0
async function freePort () {
  const srv = netCreateServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const p = srv.address().port
  await new Promise((r) => srv.close(r))
  return p
}
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const ORIGIN = 'https://www.getfunnl.com'

const PILOT_USER = '11111111-1111-1111-1111-111111111111'
const PILOT_EMAIL = 'pilot@getfunnl.test'
const PASSWORD = 'pilot-password-not-a-secret'
const JWT_SECRET = randomBytes(32).toString('hex')

let passed = 0, failed = 0
const clicked = []
function check (name, cond, detail = '') {
  if (cond) { console.log(`  \u2713 ${name}`); passed++ }
  else { console.error(`  \u2717 ${name}`); if (detail) console.error(`    ${detail}`); failed++ }
}

// ── docker plumbing ─────────────────────────────────────────────────────────
const docker = (a, o = {}) => execFileSync('docker', a, { encoding: 'utf8', stdio: 'pipe', ...o })
const quiet = (a) => spawnSync('docker', a, { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function psql (sql, { user = 'postgres', tuplesOnly = true } = {}) {
  const args = ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q']
  if (tuplesOnly) args.push('-At')
  args.push('-f', '-')
  return execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: 'pipe' })
}
const one = (sql) => psql(sql).trim()

/**
 * Align auth.uid() with the PRODUCTION definition.
 *
 * This image defines it as `current_setting('request.jwt.claim.sub')` - the SINGULAR
 * legacy form. PostgREST v14 sets the JSON form, `request.jwt.claims`, so against this
 * image auth.uid() is NULL for every request and RLS hides everything. Production's
 * auth.uid() reads the JSON form, which is why Production works.
 *
 * tests/sql/_bootstrap-disposable-db.sql records this as a known non-reproduction and
 * tells a PostgREST-driving harness to set the claim in the form the definition reads.
 * A BROWSER cannot do that - supabase-js sends a JWT and PostgREST decides the form -
 * so the harness aligns the DEFINITION instead. This makes the local database behave
 * like Production; it does not change anything in the repo.
 */
function alignAuthUidWithProduction () {
  psql(`
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$f$;`, { user: 'supabase_admin', tuplesOnly: false })
}

function waitForPg (timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline) {
    const r = spawnSync('docker',
      ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: 'CREATE TABLE public._p(i int); DROP TABLE public._p;', encoding: 'utf8' })
    if (r.status === 0) { streak += 1; if (streak >= 3) return } else { streak = 0 }
    spawnSync('node', ['-e', 'setTimeout(()=>{},1000)'], { stdio: 'ignore' })
  }
  throw new Error('Postgres never became stably DDL-ready')
}

function mintJwt (claims) {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = seg({ alg: 'HS256', typ: 'JWT' })
  const body = seg({ ...claims, iat: now, exp: now + 3600 })
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

// ── the GoTrue sink + PostgREST proxy ───────────────────────────────────────
const sinkCalls = []
function startSink () {
  const srv = createHttp(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const bodyRaw = Buffer.concat(chunks).toString('utf8')
    const path = req.url.split('?')[0]
    const cors = {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Expose-Headers': 'content-range, content-location',
      'Access-Control-Allow-Credentials': 'true',
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
    sinkCalls.push({ method: req.method, path, url: req.url })

    const user = {
      id: PILOT_USER, aud: 'authenticated', role: 'authenticated', email: PILOT_EMAIL,
      app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
      email_confirmed_at: new Date().toISOString(),
    }
    if (path === '/auth/v1/token') {
      const access = mintJwt({ sub: PILOT_USER, role: 'authenticated', aud: 'authenticated',
        email: PILOT_EMAIL, session_id: 'sess-1' })
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        access_token: access, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh-not-a-secret', user,
      }))
    }
    if (path === '/auth/v1/user') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(user))
    }
    if (path === '/auth/v1/logout') { res.writeHead(204, cors); return res.end() }

    if (path.startsWith('/rest/v1/')) {
      const target = PGRST + path.slice('/rest/v1'.length) + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '')
      const headers = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (['host', 'connection', 'content-length', 'origin', 'referer'].includes(k)) continue
        if (typeof v === 'string') headers[k] = v
      }
      let r
      try {
        r = await fetch(target, {
          method: req.method, headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyRaw,
        })
      } catch (e) {
        res.writeHead(502, { ...cors, 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ message: 'proxy_failed: ' + e.message }))
      }
      const text = await r.text()
      const out = { ...cors, 'Content-Type': r.headers.get('content-type') ?? 'application/json' }
      const cr = r.headers.get('content-range')
      if (cr) out['content-range'] = cr
      res.writeHead(r.status, out)
      return res.end(text)
    }
    res.writeHead(404, cors); res.end('{}')
  })
  return new Promise((r) => srv.listen(SINK, '127.0.0.1', () => r(srv)))
}

// ── the app, served over HTTPS on the canonical host ────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2',
  '.png': 'image/png', '.ico': 'image/x-icon' }
let serveDir = null
const startCalls = []
let startResponse = null

function startApp () {
  const srv = createHttps({
    key: readFileSync(join(WORK, 'key.pem')),
    cert: readFileSync(join(WORK, 'cert.pem')),
  }, async (req, res) => {
    const path = req.url.split('?')[0]

    // The branded start endpoint. The Edge Function is NOT deployed and must not be.
    if (path === '/api/outlook-oauth-start') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* ignore */ }
      startCalls.push({
        method: req.method,
        hasBearer: typeof req.headers.authorization === 'string'
          && req.headers.authorization.startsWith('Bearer '),
        consentPolicyVersion: body?.consentPolicyVersion ?? null,
        returnOrigin: body?.returnOrigin ?? null,
      })
      const r = startResponse ?? { status: 503, json: { error: 'config_missing' } }
      res.writeHead(r.status, {
        'Content-Type': 'application/json',
        ...(r.cookie ? { 'Set-Cookie': r.cookie } : {}),
      })
      return res.end(JSON.stringify(r.json))
    }

    let file = join(serveDir, path === '/' ? 'index.html' : path.replace(/^\//, ''))
    if (!existsSync(file) || path === '/') file = join(serveDir, 'index.html')
    let stat = null
    try { stat = readFileSync(file) } catch { file = join(serveDir, 'index.html'); stat = readFileSync(file) }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'text/html' })
    res.end(stat)
  })
  return new Promise((r) => srv.listen(APP_PORT, '127.0.0.1', () => r(srv)))
}

// ── CDP ─────────────────────────────────────────────────────────────────────
class Page {
  constructor (ws, sessionId) { this.ws = ws; this.S = sessionId; this.id = 0; this.pending = new Map(); this.events = [] }
  static async attach (wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    const p = new Page(ws, null)
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id) }
      else if (m.method) p.events.push(m)
    }
    const { result: t } = await p.raw('Target.getTargets')
    const page = t.targetInfos.find((x) => x.type === 'page')
    const { result: a } = await p.raw('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    p.S = a.sessionId
    await p.send('Runtime.enable')
    await p.send('Page.enable')
    await p.send('DOM.enable')
    await p.send('Network.enable')
    return p
  }
  raw (method, params = {}, sessionId) {
    return new Promise((res) => {
      const myId = ++this.id
      this.pending.set(myId, res)
      this.ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  async send (method, params = {}) {
    const m = await this.raw(method, params, this.S)
    if (m.error) throw new Error(`${method}: ${m.error.message}`)
    return m.result
  }
  async eval (expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`, returnByValue: true, awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error('page threw: ' + (r.exceptionDetails.exception?.description
        ?? r.exceptionDetails.text))
    }
    return r.result.value
  }
  async goto (url) {
    await this.send('Page.navigate', { url })
    await this.waitFor('document.readyState === "complete"', 20000)
  }
  async waitFor (expr, timeoutMs = 15000, label = expr) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      let v = false
      try { v = await this.eval(`return !!(${expr})`) } catch { v = false }
      if (v) return true
      await sleep(150)
    }
    throw new Error(`timed out waiting for: ${label}`)
  }
  /** A REAL mouse click at the element's centre, not a dispatched DOM event. */
  async click (selectorOrText, { byText = false } = {}) {
    const expr = byText
      ? `const els=[...document.querySelectorAll('button,a,label,input')];
         const el=els.find(e=>(e.innerText||e.value||'').trim().includes(${JSON.stringify(selectorOrText)}));
         if(!el) return null; el.scrollIntoView({block:'center'});
         const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,tag:el.tagName};`
      : `const el=document.querySelector(${JSON.stringify(selectorOrText)});
         if(!el) return null; el.scrollIntoView({block:'center'});
         const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,tag:el.tagName};`
    const box = await this.eval(expr)
    if (!box) throw new Error(`no element for click: ${selectorOrText}`)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    clicked.push(`${byText ? 'text' : 'css'}:${selectorOrText} (<${box.tag.toLowerCase()}>)`)
    await sleep(250)
    return box
  }
  async type (selector, text) {
    await this.click(selector)
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
    }
    await sleep(100)
  }
  /** Real keystrokes into whatever already has focus - used after a programmatic select(). */
  async typeKeys (text) {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
    }
    await sleep(100)
  }
  /** A real Backspace keystroke, `n` times. */
  async backspace (n = 1) {
    for (let i = 0; i < n; i++) {
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    }
    await sleep(100)
  }
}

function setServeDir (d) { serveDir = d }
function setStartResponse (r) { startResponse = r }

// ── the cert for the canonical host, generated on first run ───────────────
function ensureCert () {
  mkdirSync(WORK, { recursive: true })
  if (existsSync(join(WORK, 'cert.pem')) && existsSync(join(WORK, 'key.pem'))) return
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(WORK, 'key.pem'), '-out', join(WORK, 'cert.pem'),
    '-days', '2', '-subj', '/CN=www.getfunnl.com',
    '-addext', 'subjectAltName=DNS:www.getfunnl.com',
  ], { stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
}

const DIST_OFF = join(WORK, 'dist-off')
const DIST_ON = join(WORK, 'dist-on')

function buildApp (outDir, env) {
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: ROOT, encoding: 'utf8', stdio: 'pipe', shell: true,
    env: { ...process.env, ...env },
  })
}

let chrome = null, sink = null, app = null, page = null
/**
 * Shut everything down, in the one order that actually works.
 *
 * THE BUG THIS REPLACES: it closed page.ws FIRST and only then called
 * page.raw('Browser.close') - over a socket that was already closing - and did not
 * await the returned promise. So the close command was never reliably delivered, and
 * --headless=new survived holding its debug port. That is how an earlier run attached
 * to a PREVIOUS browser, inherited its session, and silently skipped the sign-in.
 *
 * Order now: Browser.close over the OPEN socket, awaited -> close the socket -> wait a
 * bounded time for the process to actually exit, killing it if it will not -> remove
 * the profile directory, which cannot be deleted while Chrome holds it.
 */
async function teardown () {
  if (page) {
    try {
      await Promise.race([
        page.raw('Browser.close'),
        new Promise((r) => setTimeout(r, 4000)),
      ])
    } catch { /* the browser may already be gone */ }
    try { page.ws.close() } catch { /* already closed */ }
  }
  if (chrome) {
    const deadline = Date.now() + 8000
    while (chrome.exitCode === null && chrome.signalCode === null && Date.now() < deadline) {
      await sleep(150)
    }
    if (chrome.exitCode === null && chrome.signalCode === null) {
      try { chrome.kill() } catch { /* ignore */ }
      await sleep(500)
    }
  }
  try { if (sink) sink.close() } catch { /* ignore */ }
  try { if (app) app.close() } catch { /* ignore */ }
  quiet(['rm', '-f', REST]); quiet(['rm', '-f', PG]); quiet(['network', 'rm', NET])
  // Only now can the profile go: Chrome holds open handles inside it until it exits.
  try {
    for (const p of readdirSync(WORK)) {
      if (p.startsWith('profile-')) rmSync(join(WORK, p), { recursive: true, force: true })
    }
  } catch { /* nothing to clean */ }
}

async function main () {
  console.log('\nbuilding the two real bundles (flags off, flags on)')
  const common = {
    VITE_SUPABASE_URL: `http://127.0.0.1:${SINK}`,
    VITE_SUPABASE_ANON_KEY: 'local-anon-key-not-a-secret',
  }
  buildApp(DIST_OFF, common)
  buildApp(DIST_ON, {
    ...common,
    VITE_OUTLOOK_CONNECTION_ENABLED: 'true',
    VITE_OUTLOOK_PILOT_USER_ID: PILOT_USER,
    VITE_OUTLOOK_REVIEW_ENABLED: 'true',
  })
  console.log('  two bundles built')

  console.log('\nbuilding a disposable Postgres + PostgREST')
  // Awaited: teardown is async, and this pre-run sweep must finish removing any container
  // or network left by a previous run BEFORE the next `network create` and `docker run`.
  // Unawaited, the sweep raced the setup below it.
  await teardown()
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', 'POSTGRES_PASSWORD=disposable', PG_IMAGE])
  waitForPg()
  psql(readFileSync(join(ROOT, 'tests/sql/_bootstrap-disposable-db.sql'), 'utf8'),
    { user: 'supabase_admin', tuplesOnly: false })
  const migrations = execFileSync('node', ['-e',
    `const fs=require('fs');console.log(fs.readdirSync(${JSON.stringify(join(ROOT, 'supabase/migrations'))}).filter(f=>f.endsWith('.sql')).sort().join('\\n'))`],
    { encoding: 'utf8' }).trim().split('\n')
  for (const m of migrations) {
    psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'), { tuplesOnly: false })
  }
  console.log(`  applied ${migrations.length} migrations`)
  alignAuthUidWithProduction()
  console.log('  auth.uid() aligned with the Production definition (JSON claims)')

  psql(`ALTER ROLE authenticator WITH PASSWORD 'disposable';`, { user: 'supabase_admin', tuplesOnly: false })
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', '53991:3000',
    '-e', `PGRST_DB_URI=postgres://authenticator:disposable@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:53991/'); if (r.status < 500) break } catch { /* wait */ }
    await sleep(400)
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  const CONTACT_NAME = 'Ava Recruiter'
  psql(`
UPDATE auth.users SET email = '${PILOT_EMAIL}' WHERE id = '${PILOT_USER}';
INSERT INTO public.profiles (id, email, ai_enabled)
VALUES ('${PILOT_USER}', '${PILOT_EMAIL}', false)
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
DELETE FROM public.interaction_candidates WHERE user_id = '${PILOT_USER}';
DELETE FROM public.interactions WHERE user_id = '${PILOT_USER}';
DELETE FROM public.contacts WHERE user_id = '${PILOT_USER}';
INSERT INTO public.contacts (user_id, name, email)
VALUES ('${PILOT_USER}', '${CONTACT_NAME}', 'ava@bank.test');
INSERT INTO public.interaction_candidates
  (user_id, contact_id, source, source_fingerprint, proposed_type,
   proposed_interaction_date, status, source_last_state, context_expires_at,
   proposed_notes, draft_summary, draft_follow_up, summary_evidence, extraction_status)
SELECT '${PILOT_USER}', c.id, 'outlook', repeat('e',64), 'Email',
       current_date - 1, 'pending', 'active', now() + interval '30 days',
       'They offered a short call next week about the credit desk.',
       'They offered a short call next week about the credit desk.',
       'Send your availability for next week.', 'explicit_body', 'ai_extracted'
  FROM public.contacts c WHERE c.user_id = '${PILOT_USER}' LIMIT 1;`,
  { tuplesOnly: false })
  console.log('  seeded: 1 contact, 1 PENDING Outlook suggestion WITH a drafted next step, 0 interactions')

  ensureCert()
  sink = await startSink()
  app = await startApp()
  console.log(`  sink on ${SINK}; app served over HTTPS as ${ORIGIN}`)

  // ── Chrome, resolving the canonical host to this machine ──────────────────
  // A UNIQUE profile per run. Deleting a shared one is not reliable on Windows while
  // a previous Chrome may still hold a handle, and an inherited profile carries an
  // inherited localStorage session - which silently skips the sign-in this harness is
  // supposed to exercise. A fresh directory cannot be inherited.
  CDP_PORT = await freePort()
  const PROFILE = join(WORK, `profile-${Date.now()}`)
  rmSync(PROFILE, { recursive: true, force: true })
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--host-resolver-rules=MAP www.getfunnl.com 127.0.0.1:443',
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1280,1100', 'about:blank',
  ], { stdio: 'ignore' })
  let ver = null
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { ver = await r.json(); break } }
    catch { /* wait */ }
    await sleep(300)
  }
  if (!ver) throw new Error('Chrome devtools endpoint never came up')
  console.log(`  ${ver.Browser}, resolving www.getfunnl.com -> 127.0.0.1:443`)
  // Logged so a caller can verify afterwards that nothing was left holding the port.
  console.log(`  devtools port ${CDP_PORT}, profile ${PROFILE}\n`)
  page = await Page.attach(ver.webSocketDebuggerUrl)

  // Idempotent: the session lives in localStorage on this origin, so it survives a
  // bundle swap and App.jsx then redirects /signin away. Sign in only when needed.
  const signIn = async () => {
    await page.goto(`${ORIGIN}/`)
    await sleep(600)
    const already = await page.eval(
      'return /Settings/.test(document.body.innerText)'
      + ' && !document.querySelector(\'input[type="password"]\')')
    if (already) return 'already'
    await page.goto(`${ORIGIN}/signin`)
    await page.waitFor('document.querySelector(\'input[type="email"]\')', 20000,
      'the sign-in form')
    await page.type('input[type="email"]', PILOT_EMAIL)
    await page.type('input[type="password"]', PASSWORD)
    await page.click('Sign in', { byText: true })
    await page.waitFor('!document.querySelector(\'input[type="password"]\')', 20000,
      'the app shell after sign-in')
    return 'signed-in'
  }

  // ══ 1. flags off ═════════════════════════════════════════════════════════
  console.log('1. with flags off, neither card is in the UI')
  setServeDir(DIST_OFF)
  const firstSignIn = await signIn()
  console.log(`      sign-in path: ${firstSignIn}`)
  check('the FIRST sign-in used the real form, not an inherited session',
    firstSignIn === 'signed-in', `signIn() returned ${firstSignIn}`)
  await page.goto(`${ORIGIN}/settings`)
  await page.waitFor('/PROFILE/.test(document.body.innerText)', 20000,
    'the Settings page')
  const off = await page.eval(`
    const t = document.body.innerText
    return { outlook: /Outlook/i.test(t), calendar: /Google Calendar/i.test(t),
             connected: /Connected accounts/i.test(t), len: t.length }`)
  check('Settings renders, and Outlook is ABSENT', off.len > 100 && !off.outlook,
    JSON.stringify(off))
  check('Google Calendar is ABSENT', !off.calendar, JSON.stringify(off))
  check('no "Connected accounts" section at all', !off.connected, JSON.stringify(off))
  const navOff = await page.eval(`return document.body.innerText`)
  check('no Suggestions entry in the nav', !/Suggestions/i.test(navOff),
    'suggestions surface is off with the review flag unset')

  // ══ 2. flags on: the real disclosure ═════════════════════════════════════
  console.log('\n2. with pilot flags on, the card renders the shipped disclosure')
  setServeDir(DIST_ON)
  await signIn()
  await page.goto(`${ORIGIN}/settings`)
  await page.waitFor('/Outlook/i.test(document.body.innerText)', 20000, 'the Outlook card')

  const mod = await import(pathToFileURL(join(ROOT, 'src/lib/outlookDisclosure.js')).href)
  const shipped = mod.OUTLOOK_DISCLOSURE_PARAGRAPHS
  const rendered = await page.eval(`
    const t = document.body.innerText
    return { text: t, version: (t.match(/ol-disc-[0-9a-f]{32}/) || [null])[0] }`)
  const missing = shipped.filter((p) => !rendered.text.includes(p))
  check(`all ${shipped.length} shipped paragraphs are rendered verbatim`,
    missing.length === 0, missing.length ? `missing: ${missing[0].slice(0, 70)}...` : '')
  check('the rendered version is the current derived one',
    rendered.version === mod.OUTLOOK_DISCLOSURE_VERSION,
    `rendered=${rendered.version} derived=${mod.OUTLOOK_DISCLOSURE_VERSION}`)

  const box0 = await page.eval(`
    const b = document.querySelector('input[type="checkbox"]')
    const btn = [...document.querySelectorAll('button')].find(e=>/Connect Outlook/i.test(e.innerText))
    return { checked: b ? b.checked : null, disabled: btn ? btn.disabled : null }`)
  check('the acknowledgement starts UNCHECKED', box0.checked === false, JSON.stringify(box0))
  check('Connect is disabled while unacknowledged', box0.disabled === true, JSON.stringify(box0))

  // A REAL mouse press on Connect while the box is unchecked. The control is disabled,
  // so the browser itself swallows the press - which is exactly the user-level fact
  // worth proving: pressing it does nothing and sends nothing.
  startCalls.length = 0
  await page.click('Connect Outlook', { byText: true })
  await sleep(500)
  check('a real mouse press on Connect while UNCHECKED sends no start request',
    startCalls.length === 0, `startCalls=${startCalls.length}`)
  const stillUnchecked = await page.eval(
    'return document.querySelector(\'input[type="checkbox"]\').checked')
  check('and the box is still unchecked afterwards', stillUnchecked === false)

  // ── stale version -> 409 withdraws the acknowledgement ──────────────────
  await page.click('input[type="checkbox"]')
  const acked = await page.eval(`
    const b=document.querySelector('input[type="checkbox"]')
    const btn=[...document.querySelectorAll('button')].find(e=>/Connect Outlook/i.test(e.innerText))
    return { checked: b.checked, disabled: btn ? btn.disabled : null }`)
  check('clicking the box acknowledges, enabling Connect',
    acked.checked === true && acked.disabled === false, JSON.stringify(acked))

  startCalls.length = 0
  setStartResponse({ status: 409, json: { error: 'consent_version_mismatch' } })
  await page.click('Connect Outlook', { byText: true })
  await sleep(700)
  const after409 = await page.eval(`
    const b=document.querySelector('input[type="checkbox"]')
    return { checked: b.checked, text: document.body.innerText }`)
  check('a stale-version 409 made exactly one request', startCalls.length === 1,
    `startCalls=${startCalls.length}`)
  check('the 409 WITHDRAWS the acknowledgement (box back to unchecked)',
    after409.checked === false, `checked=${after409.checked}`)
  check('the user is told, without a raw server message',
    /updated|again|changed/i.test(after409.text), 'a message is shown')

  // ══ 3. a stubbed successful start ════════════════════════════════════════
  console.log('\n3. an acknowledged click makes ONE request and navigates ONCE')
  const PROVIDER = 'https://login.microsoftonline.test/common/oauth2/v2.0/authorize?x=1'
  await page.send('Page.setInterceptFileChooserDialog', {}).catch(() => {})
  await page.send('Network.setRequestInterception', { patterns: [{ urlPattern: '*microsoftonline*' }] })
    .catch(() => {})
  const navAttempts = []
  page.events.length = 0
  startCalls.length = 0
  setStartResponse({
    status: 200,
    json: { url: PROVIDER },
    cookie: '__Host-fnl_ms_oauth_bind=state-not-a-secret; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=None',
  })
  await page.click('input[type="checkbox"]')
  await page.click('Connect Outlook', { byText: true })
  await sleep(1500)
  // Tally PER EVENT METHOD. `new Set(urls).size === 1` only showed that one distinct
  // URL was involved - it would read the same for one attempt or for five retries of
  // the same URL. So count each method separately and assert on ONE of them.
  const navByMethod = {}
  for (const e of page.events) {
    const url = e.params?.request?.url ?? e.params?.url ?? e.params?.documentURL ?? ''
    if (!/microsoftonline/.test(url)) continue
    navByMethod[e.method] = (navByMethod[e.method] ?? 0) + 1
    navAttempts.push(url)
  }
  console.log(`      provider events by method: ${JSON.stringify(navByMethod)}`)
  const loc = await page.eval(`return location.href`).catch(() => 'navigated-away')
  check('exactly ONE start request was made', startCalls.length === 1,
    `startCalls=${startCalls.length}`)
  check('it carried a bearer token and the shipped disclosure version',
    startCalls[0]?.hasBearer === true
    && startCalls[0]?.consentPolicyVersion === mod.OUTLOOK_DISCLOSURE_VERSION,
    JSON.stringify(startCalls[0]))
  check('it declared the canonical return origin', startCalls[0]?.returnOrigin === ORIGIN,
    JSON.stringify(startCalls[0]))
  // ONE event method, counted. Measured shape for this flow:
  //   Page.frameRequestedNavigation 1 | Page.frameScheduledNavigation 1
  //   Page.frameStartedNavigating   2 | Network.requestWillBeSent     2
  // frameRequestedNavigation is the one that means `the page asked to go here`, and
  // it fires ONCE. The two that fire twice are Chrome retrying the transport because
  // the .test host does not resolve - a browser retry, not a second navigation the
  // application asked for. The claim is scoped to what the APP did, and the retry is
  // reported rather than hidden.
  check('the APP requested the provider navigation exactly once',
    navByMethod['Page.frameRequestedNavigation'] === 1,
    `Page.frameRequestedNavigation=${navByMethod['Page.frameRequestedNavigation']} `
    + `(all methods: ${JSON.stringify(navByMethod)})`)
  check('every provider URL Chrome touched was the .test sink, never Microsoft',
    navAttempts.length > 0 && navAttempts.every((u) => /\.test\//.test(u)),
    JSON.stringify([...new Set(navAttempts)]))
  check('exactly one distinct provider URL was involved',
    new Set(navAttempts).size === 1, JSON.stringify([...new Set(navAttempts)]))
  console.log(`      transport attempts (Chrome retries an unresolvable host): `
    + `${navByMethod['Network.requestWillBeSent'] ?? 0}`)
  console.log(`      navigation observed: ${navAttempts[0] ?? '(none captured)'} | now at ${loc}`)

  // ══ 4. the suggestion queue ══════════════════════════════════════════════
  console.log('\n4. one pending suggestion: edit+accept, then dismiss')
  setStartResponse(null)
  await signIn()
  const before = {
    interactions: one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`),
    pending: one(`SELECT count(*) FROM public.interaction_candidates
      WHERE user_id='${PILOT_USER}' AND status='pending';`),
  }
  await page.goto(`${ORIGIN}/suggestions`)
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(CONTACT_NAME)})`,
    20000, 'the suggestion for the seeded contact')
  const afterView = one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`)
  check('opening the queue saved NOTHING',
    afterView === before.interactions && before.interactions === '0',
    `before=${before.interactions} afterView=${afterView}`)
  check('the pending suggestion is visible', before.pending === '1', `pending=${before.pending}`)

  // The drafted next step and the AI provenance line are visible BEFORE editing.
  const cardText = await page.eval('return document.body.innerText')
  check('the drafted next step is shown on the card', /Suggested next step: Send your availability for next week\./.test(cardText))
  check('the card says the note was drafted by AI', /Drafted by AI from the message text/.test(cardText))
  // The note field sits behind the card's own "Edit details" toggle, so this is the
  // real two-step a user performs: reveal the fields, type, then accept.
  const EDIT = 'Edited in the browser before accepting.'
  const EDITED_STEP = 'Chase them on Friday if nothing has arrived.'
  const CHOSEN_DATE = '2026-10-21'
  await page.click('Edit details', { byText: true })
  await page.waitFor('document.querySelector(\'textarea\')', 8000, 'the note field')
  // The note: real click, real keystrokes. The seeded note is selected first so the
  // keystrokes replace it rather than append.
  await page.eval('const el=document.querySelector(\'textarea\'); el.focus(); el.select(); return true')
  await page.typeKeys(EDIT)
  const typed = await page.eval('return document.querySelector(\'textarea\').value')
  check('the note field accepted browser keystrokes', typed === EDIT,
    `textarea=${JSON.stringify(typed)}`)
  // THE NEXT STEP: prefilled from the draft, then EDITED with real keystrokes.
  const stepBefore = await page.eval('return document.querySelector(\'input[name="nextStep"]\').value')
  check('the next-step field is prefilled with the drafted step', stepBefore === 'Send your availability for next week.',
    `nextStep=${JSON.stringify(stepBefore)}`)
  await page.eval('const el=document.querySelector(\'input[name="nextStep"]\'); el.focus(); el.select(); return true')
  await page.typeKeys(EDITED_STEP)
  const stepTyped = await page.eval('return document.querySelector(\'input[name="nextStep"]\').value')
  check('the next-step field accepted browser keystrokes', stepTyped === EDITED_STEP, `nextStep=${JSON.stringify(stepTyped)}`)
  // THE FOLLOW-UP DATE starts empty - never derived from the step - and is the reviewer's
  // choice. A date input does not take locale-free keystrokes reliably, so the value is set
  // through the native setter and an input event, which is how React sees a user's change;
  // that part is programmatic, and said so here.
  const dateBefore = await page.eval('return document.querySelector(\'input[name="followUpDate"]\').value')
  check('the follow-up date starts EMPTY', dateBefore === '', `followUpDate=${JSON.stringify(dateBefore)}`)
  await page.eval(`const el=document.querySelector('input[name="followUpDate"]');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(el, ${JSON.stringify(CHOSEN_DATE)}); el.dispatchEvent(new Event('input', {bubbles:true})); return true`)
  const dateSet = await page.eval('return document.querySelector(\'input[name="followUpDate"]\').value')
  check('the follow-up date took the chosen value', dateSet === CHOSEN_DATE, `followUpDate=${JSON.stringify(dateSet)}`)
  await page.click('Accept', { byText: true })
  await sleep(1200)
  const saved = psql(`SELECT count(*), coalesce(max(notes),'NULL'), coalesce(max(type),'NULL'),
      coalesce(max(follow_up_date)::text,'NULL')
    FROM public.interactions WHERE user_id='${PILOT_USER}';`).trim().split('|')
  check('exactly ONE interaction was saved', saved[0] === '1', `rows=${saved[0]}`)
  check('it is typed Email', saved[2] === 'Email', `type=${saved[2]}`)
  check('it carries the note typed IN THE BROWSER with the EDITED next step after it',
    saved[1] === EDIT + '\n\nNext step: ' + EDITED_STEP,
    `notes=${JSON.stringify(saved[1])}`)
  check('and the follow-up date the reviewer CHOSE', saved[3] === CHOSEN_DATE, `follow_up_date=${saved[3]}`)
  check('the candidate is no longer pending',
    one(`SELECT count(*) FROM public.interaction_candidates
      WHERE user_id='${PILOT_USER}' AND status='pending';`) === '0')
  check('the candidate\'s draft columns are erased at acceptance',
    one(`SELECT count(*) FROM public.interaction_candidates
      WHERE user_id='${PILOT_USER}' AND source_fingerprint=repeat('e',64)
        AND draft_follow_up IS NULL AND draft_summary IS NULL AND summary_evidence IS NULL;`) === '1')
  // ── a second suggestion: the reviewer CLEARS the drafted step, picks no date ──
  psql(`INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, status, source_last_state, context_expires_at,
     proposed_notes, draft_summary, draft_follow_up, summary_evidence, extraction_status)
  SELECT '${PILOT_USER}', c.id, 'outlook', repeat('f',64), 'Email',
         current_date - 3, 'pending', 'active', now() + interval '30 days',
         'They confirmed Thursday for the call.', 'They confirmed Thursday for the call.',
         'Prepare three questions before Thursday.', 'explicit_body', 'ai_extracted'
    FROM public.contacts c WHERE c.user_id='${PILOT_USER}' LIMIT 1;`, { tuplesOnly: false })
  await page.goto(`${ORIGIN}/suggestions`)
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(CONTACT_NAME)})`, 20000)
  await page.click('Edit details', { byText: true })
  await page.waitFor('document.querySelector(\'input[name="nextStep"]\')', 8000, 'the next-step field')
  const prefilled = await page.eval('return document.querySelector(\'input[name="nextStep"]\').value')
  check('the second card is prefilled with its own drafted step', prefilled === 'Prepare three questions before Thursday.',
    `nextStep=${JSON.stringify(prefilled)}`)
  await page.eval('const el=document.querySelector(\'input[name="nextStep"]\'); el.focus(); el.select(); return true')
  await page.backspace(1)
  const cleared = await page.eval('return document.querySelector(\'input[name="nextStep"]\').value')
  check('a real Backspace cleared the step', cleared === '', `nextStep=${JSON.stringify(cleared)}`)
  await page.click('Accept', { byText: true })
  await sleep(1200)
  const second = psql(`SELECT coalesce(notes,'NULL'), coalesce(follow_up_date::text,'NULL')
    FROM public.interactions WHERE user_id='${PILOT_USER}'
    ORDER BY created_at DESC LIMIT 1;`).trim().split('|')
  check('two interactions now', one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`) === '2')
  check('a cleared step saves the note ALONE', second[0] === 'They confirmed Thursday for the call.',
    `notes=${JSON.stringify(second[0])}`)
  check('and no date was invented', second[1] === 'NULL', `follow_up_date=${second[1]}`)

  // Dismiss a second one.
  psql(`INSERT INTO public.interaction_candidates
    (user_id, contact_id, source, source_fingerprint, proposed_type,
     proposed_interaction_date, status, source_last_state, context_expires_at)
  SELECT '${PILOT_USER}', c.id, 'outlook', repeat('d',64), 'Email',
         current_date - 2, 'pending', 'active', now() + interval '30 days'
    FROM public.contacts c WHERE c.user_id='${PILOT_USER}' LIMIT 1;`, { tuplesOnly: false })
  await page.goto(`${ORIGIN}/suggestions`)
  await page.waitFor(`document.body.innerText.includes(${JSON.stringify(CONTACT_NAME)})`, 20000)
  const beforeDismiss = one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`)
  // Dismiss is two-step by design: the first click only opens a confirmation.
  await page.click('Dismiss', { byText: true })
  await sleep(400)
  const confirmShown = await page.eval(
    'return /Dismiss this suggestion\\?/.test(document.body.innerText)')
  check('the first Dismiss click only opens a confirmation', confirmShown === true)
  const midDismiss = one(`SELECT count(*) FROM public.interaction_candidates
    WHERE user_id='${PILOT_USER}' AND source_fingerprint=repeat('d',64) AND status='pending';`)
  check('and dismisses nothing yet', midDismiss === '1', `pending=${midDismiss}`)
  await page.click('Yes, dismiss', { byText: true })
  await sleep(1400)
  check('dismissing saved NO interaction',
    one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`) === beforeDismiss,
    `before=${beforeDismiss}`)
  check('the dismissed candidate is terminal, not pending',
    one(`SELECT count(*) FROM public.interaction_candidates
      WHERE user_id='${PILOT_USER}' AND source_fingerprint=repeat('d',64)
        AND status='dismissed';`) === '1')

  // ══ 5. the disconnect confirmation ═══════════════════════════════════════
  // ══ 4b. THE NEW-CONTACT CARD, in the browser ══════════════════════════════
  // The card that proposes someone not yet in Funnl, driven with real clicks and
  // real keystrokes: edit then accept, the dismiss confirmation and its cancel, and
  // reaching a proposal past the first page.
  console.log('\n4b. the new-contact card: edit+accept, cancel, dismiss, and proposal 21')

  // 21 proposals, so the LAST one is unreachable without continuation. Each carries a
  // distinct address so the 21st can be recognised on screen; all invented.
  psql(`
DELETE FROM public.outlook_candidate_refs WHERE user_id = '${PILOT_USER}';
DELETE FROM public.new_contact_candidates WHERE user_id = '${PILOT_USER}';
INSERT INTO public.new_contact_candidates
  (user_id, source, status, person_fingerprint, episode_fingerprint, key_version,
   proposed_email, proposed_name, proposed_name_evidence, proposed_name_confidence,
   draft_summary, draft_follow_up, proposed_interaction_date, proposed_type,
   retained_subject, extraction_status, context_expires_at)
SELECT '${PILOT_USER}', 'outlook', 'pending',
       lpad(g::text, 64, 'a'), lpad(g::text, 64, 'b'), 1,
       'person' || lpad(g::text, 2, '0') || '@fund.test',
       'Proposed Person ' || lpad(g::text, 2, '0'),
       'explicit_signature', 'high',
       'She offered to review your application and asked for a CV by Friday.',
       'Send the CV before Friday.',
       current_date - g, 'Email', 'Summer analyst referral', 'ai_extracted',
       now() + interval '30 days'
  FROM generate_series(1, 21) AS gs(g);`, { tuplesOnly: false })
  console.log('  seeded: 21 PENDING new-contact proposals')

  const nccBefore = {
    contacts: one(`SELECT count(*) FROM public.contacts WHERE user_id='${PILOT_USER}';`),
    interactions: one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`),
  }

  await page.goto(`${ORIGIN}/suggestions`)
  try {
    await page.waitFor('/new person/i.test(document.body.innerText)', 20000,
      'the new-contact card')
  } catch (e) {
    // Say what the page ACTUALLY shows rather than only that it timed out: a
    // refused column, a render crash and an empty queue look identical otherwise.
    const body = await page.eval('return document.body.innerText.slice(0, 600)')
    const errs = await page.eval(
      'return (window.__restErrors || []).slice(0, 4)')
    throw new Error(`${e.message}
    BODY: ${String(body).replace(/\s+/g, ' ')}`
      + `
    REST: ${JSON.stringify(errs)}`)
  }

  // ── opening the queue creates nothing ────────────────────────────────────
  check('opening the proposals queue created NO contact',
    one(`SELECT count(*) FROM public.contacts WHERE user_id='${PILOT_USER}';`) === nccBefore.contacts,
    `before=${nccBefore.contacts}`)
  check('and NO interaction',
    one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`)
      === nccBefore.interactions)

  // ── only ONE PAGE renders, and the 21st is NOT on it ─────────────────────
  const proposalCards = await page.eval(
    'return (document.body.innerText.match(/new person/gi) || []).length')
  check('exactly one page of proposals renders', proposalCards === 20,
    `rendered=${proposalCards}`)
  // Ordered by date DESC, so g=1 (yesterday) is first and g=21 (21 days ago) is last.
  const has21Initially = await page.eval(
    'return document.body.innerText.includes("Proposed Person 21")')
  check('proposal 21 is NOT on the first page', has21Initially === false)
  const loadMoreShown = await page.eval(
    'return [...document.querySelectorAll("button")].some(b => /Load more/.test(b.innerText))')
  check('and a Load more control is offered', loadMoreShown === true)

  // ── EDIT THEN ACCEPT the first card ──────────────────────────────────────
  // The fields are always visible on this card - a proposal is a draft, so there is
  // no "Edit details" toggle to find first.
  const NEW_NAME = 'Priya Nair-Shah'
  const NEW_COMPANY = 'Northfield Capital'
  const NEW_NOTE = 'Typed in the browser before accepting.'
  const nameSel = 'input[type="text"]'
  await page.eval(`const i=document.querySelector(${JSON.stringify(nameSel)});
    i.focus(); i.setSelectionRange(0, i.value.length); return true;`)
  // Clear by selecting all and typing over it, the way a person would.
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace',
    code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace',
    code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await page.type(nameSel, NEW_NAME)
  const typedName = await page.eval(
    `return document.querySelector(${JSON.stringify(nameSel)}).value`)
  check('the name field accepted browser keystrokes', typedName.includes(NEW_NAME),
    `name=${JSON.stringify(typedName)}`)

  // The company field is the SECOND text input on the card.
  await page.eval(`const all=[...document.querySelectorAll('input[type="text"]')];
    all[1].focus(); return true;`)
  const companySel = 'input[type="text"]:nth-of-type(1)'
  await page.eval(`const all=[...document.querySelectorAll('input[type="text"]')];
    const i=all[1]; const r=i.getBoundingClientRect();
    window.__companyBox={x:r.x+r.width/2,y:r.y+r.height/2}; return true;`)
  const cBox = await page.eval('return window.__companyBox')
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cBox.x, y: cBox.y, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cBox.x, y: cBox.y, button: 'left', clickCount: 1 })
  for (const ch of NEW_COMPANY) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
  }
  void companySel

  // The note is the card's only textarea.
  await page.click('textarea')
  await page.eval(`const t=document.querySelector('textarea');
    t.focus(); t.setSelectionRange(0, t.value.length); return true;`)
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace',
    code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace',
    code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  for (const ch of NEW_NOTE) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
  }
  const typedNote = await page.eval("return document.querySelector('textarea').value")
  check('the note field accepted browser keystrokes', typedNote.includes(NEW_NOTE),
    `note=${JSON.stringify(typedNote)}`)

  // STILL nothing created, after every edit.
  check('EDITING created no contact and no interaction',
    one(`SELECT count(*) FROM public.contacts WHERE user_id='${PILOT_USER}';`) === nccBefore.contacts
    && one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`)
       === nccBefore.interactions)

  await page.click('Save contact & interaction', { byText: true })
  await sleep(1800)

  const savedContact = psql(`SELECT name, coalesce(company,'NULL'), email
    FROM public.contacts WHERE user_id='${PILOT_USER}' AND email LIKE 'person%@fund.test';`)
    .trim().split('|')
  check('ONE contact was created', savedContact.length === 3, `row=${savedContact.join('|')}`)
  check('with the name typed IN THE BROWSER', savedContact[0] === NEW_NAME,
    `name=${savedContact[0]}`)
  check('and the company typed in the browser', savedContact[1] === NEW_COMPANY,
    `company=${savedContact[1]}`)
  check('and the address from the proposal, which the UI cannot edit',
    savedContact[2] === 'person01@fund.test', `email=${savedContact[2]}`)

  const savedInteraction = psql(`SELECT i.type, i.notes, i.source
    FROM public.interactions i JOIN public.contacts c ON c.id = i.contact_id
    WHERE i.user_id='${PILOT_USER}' AND c.email='person01@fund.test';`).trim().split('|')
  check('and the interaction was created WITH it', savedInteraction.length === 3,
    `row=${savedInteraction.join('|')}`)
  check('carrying the note typed in the browser', savedInteraction[1] === NEW_NOTE,
    `notes=${JSON.stringify(savedInteraction[1])}`)
  check('and attributed to outlook', savedInteraction[2] === 'outlook')
  check('the accepted proposal is no longer pending',
    one(`SELECT status FROM public.new_contact_candidates
         WHERE person_fingerprint=lpad('1',64,'a');`) === 'accepted')
  check('and its draft was erased on acceptance',
    one(`SELECT coalesce(draft_summary,'NULL') FROM public.new_contact_candidates
         WHERE person_fingerprint=lpad('1',64,'a');`) === 'NULL')

  // ── THE DISMISS CONFIRMATION, AND ITS CANCEL ─────────────────────────────
  await page.waitFor('/new person/i.test(document.body.innerText)', 15000)
  const beforeCancel = one(`SELECT count(*) FROM public.new_contact_candidates
    WHERE user_id='${PILOT_USER}' AND status='pending';`)
  await page.click('Dismiss', { byText: true })
  await sleep(400)
  const confirmText = await page.eval(
    'return /No contact or interaction will be created/.test(document.body.innerText)')
  check('the first Dismiss click opens a confirmation that promises nothing is created',
    confirmText === true)
  check('and dismisses nothing yet',
    one(`SELECT count(*) FROM public.new_contact_candidates
         WHERE user_id='${PILOT_USER}' AND status='pending';`) === beforeCancel,
    `pending=${beforeCancel}`)

  // CANCEL: the card returns, and nothing at all has happened.
  await page.click('Cancel', { byText: true })
  await sleep(400)
  const cancelled = await page.eval(
    'return !/No contact or interaction will be created/.test(document.body.innerText)'
    + ' && [...document.querySelectorAll("button")].some(b => /^Dismiss$/.test(b.innerText.trim()))')
  check('Cancel closes the confirmation and restores the card', cancelled === true)
  check('and cancelling dismissed nothing',
    one(`SELECT count(*) FROM public.new_contact_candidates
         WHERE user_id='${PILOT_USER}' AND status='pending';`) === beforeCancel)

  // Now actually dismiss it.
  const contactsBeforeDismiss = one(
    `SELECT count(*) FROM public.contacts WHERE user_id='${PILOT_USER}';`)
  await page.click('Dismiss', { byText: true })
  await sleep(300)
  await page.click('Yes, dismiss', { byText: true })
  await sleep(1500)
  check('dismissing created NO contact',
    one(`SELECT count(*) FROM public.contacts WHERE user_id='${PILOT_USER}';`)
      === contactsBeforeDismiss, `before=${contactsBeforeDismiss}`)
  check('and the proposal is terminal',
    one(`SELECT count(*) FROM public.new_contact_candidates
         WHERE user_id='${PILOT_USER}' AND status='dismissed';`) === '1')

  // ── REACHING PROPOSAL 21 ─────────────────────────────────────────────────
  // 19 proposals remain on the rendered page and 1 sits past the cursor. Draining the
  // visible page through the UI must REFILL it, not say "all caught up" - which is
  // exactly what happened when this queue had a bare limit of 20 and no continuation.
  let guard = 0
  for (;;) {
    guard += 1
    if (guard > 40) throw new Error('the proposals queue never drained')
    const stillThere = await page.eval(
      'return [...document.querySelectorAll("button")].some(b => /^Dismiss$/.test(b.innerText.trim()))')
    if (!stillThere) break
    const reached21 = await page.eval(
      'return document.body.innerText.includes("Proposed Person 21")')
    if (reached21) break
    await page.click('Dismiss', { byText: true })
    await sleep(200)
    await page.click('Yes, dismiss', { byText: true })
    await sleep(700)
  }

  const saw21 = await page.eval(
    'return document.body.innerText.includes("Proposed Person 21")')
  check('PROPOSAL 21 BECAME REACHABLE after the visible page drained', saw21 === true,
    `dismissals=${guard}, body=${(await page.eval(
      'return document.body.innerText.slice(0, 300)')).replace(/\s+/g, ' ')}`)
  const caughtUpWrongly = await page.eval(
    'return /You.{0,3}re all caught up/.test(document.body.innerText)')
  check('and the page did NOT claim "all caught up" while it remained',
    caughtUpWrongly === false)

  // The explicit approval boundary, measured across the whole section: exactly ONE
  // contact and ONE interaction exist, from the single Save that was pressed.
  check('across every edit, cancel and dismissal, exactly ONE contact was created',
    one(`SELECT count(*) FROM public.contacts WHERE user_id='${PILOT_USER}'
          AND email LIKE 'person%@fund.test';`) === '1')
  check('and exactly ONE interaction, from the single Save pressed',
    one(`SELECT count(*) FROM public.interactions i JOIN public.contacts c
          ON c.id = i.contact_id
         WHERE i.user_id='${PILOT_USER}' AND c.email LIKE 'person%@fund.test';`) === '1')

  // ── LEAVE THE STATE THIS SECTION FOUND ───────────────────────────────────
  // Section 5 asserts that the ONE interaction accepted in section 4 survives the
  // disconnect, by exact count. The contact and interaction this section created are
  // therefore removed - every claim about them has already been checked above, and a
  // section that leaves state behind makes a later one's count a moving target. The
  // contact delete cascades to its interaction.
  psql(`DELETE FROM public.outlook_candidate_refs WHERE user_id = '${PILOT_USER}';
        DELETE FROM public.new_contact_candidates WHERE user_id = '${PILOT_USER}';
        DELETE FROM public.contacts
         WHERE user_id = '${PILOT_USER}' AND email LIKE 'person%@fund.test';`,
  { tuplesOnly: false })
  // Relative to what this section FOUND (section 4 now leaves two accepted interactions,
  // one with an edited next step and one with the step cleared), not a fixed count.
  check('this section left exactly the interaction count it found',
    one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`) === nccBefore.interactions,
    `found=${nccBefore.interactions}`)

  console.log('\n5. the disconnect confirmation, as rendered')
  psql(`
INSERT INTO public.microsoft_connections
  (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
   status, consented_at, consent_policy_version)
VALUES ('${PILOT_USER}','acct-1','consumers','personal','${PILOT_EMAIL}',
        ARRAY['Mail.Read','User.Read','offline_access'],'active',now(),
        '${mod.OUTLOOK_DISCLOSURE_VERSION}')
ON CONFLICT DO NOTHING;`, { tuplesOnly: false })
  await page.goto(`${ORIGIN}/settings`)
  await page.waitFor('/Disconnect/i.test(document.body.innerText)', 20000, 'the connected card')
  await page.click('Disconnect', { byText: true })
  await sleep(500)
  const panel = await page.eval(`return document.body.innerText`)
  const discMod = await import(pathToFileURL(join(ROOT, 'src/lib/outlookDisconnect.js')).href)
  const missingCons = discMod.DISCONNECT_CONSEQUENCES.filter((c) => !panel.includes(c.text))
  check('every shipped consequence is rendered verbatim', missingCons.length === 0,
    missingCons.length ? `missing: ${missingCons[0].text.slice(0, 80)}...` : '')
  // Each consequence carries a short effect label. EFFECT_LABEL in the card is keyed by
  // the effect name, so renaming an effect without updating the map renders a BLANK
  // label - which is exactly what `invalidated` did until this was asserted.
  const labels = await page.eval(`
    const li = [...document.querySelectorAll('li')]
      .filter((e) => /invalidated|is deleted|are kept|already under way|at Microsoft/i.test(e.innerText))
    return li.map((e) => (e.querySelector('span') ? e.querySelector('span').innerText.trim() : ''))`)
  // Compared case-insensitively: the card styles these labels `uppercase`, and innerText
  // returns the CSS-transformed text, so the DOM says INVALIDATED for 'Invalidated'.
  check('the retained-suggestion consequence is labelled "Invalidated"',
    labels.some((l) => l.toLowerCase() === 'invalidated'),
    `rendered labels: ${JSON.stringify(labels)}`)
  check('and no label is the superseded "Emptied"',
    !labels.some((l) => /^empt/i.test(l)), `rendered labels: ${JSON.stringify(labels)}`)
  check('no consequence renders a BLANK effect label',
    labels.length > 0 && labels.every((l) => l.length > 0),
    `rendered labels: ${JSON.stringify(labels)}`)
  check('the rendered panel does NOT call the retained row empty',
    !/empt(y|ied|ies)/i.test(panel), 'no "empty" in the rendered confirmation')
  check('it states the record is kept with its contact, date and fingerprint',
    /The record itself is kept/.test(panel)
    && /still holding the contact it was about, the proposed date and a one-way fingerprint/.test(panel),
    'retained-row wording present')
  check('it does not promise upstream revocation',
    /does not withdraw the permission at Microsoft/.test(panel))

  // Cancel: no RPC.
  // Count the RPC itself, not only its database effect: a Cancel that quietly fired
  // the call and failed would otherwise look identical to a Cancel that fired nothing.
  const DISCONNECT_RPC = '/rest/v1/rpc/disconnect_my_outlook'
  const rpcCount = () => sinkCalls.filter((c) => c.path === DISCONNECT_RPC).length
  const rpcBeforeCancel = rpcCount()
  const rpcBefore = one(`SELECT count(*) FROM public.microsoft_connections WHERE user_id='${PILOT_USER}';`)
  await page.click('Cancel', { byText: true })
  await sleep(700)
  const afterCancel = rpcCount()
  check('CANCEL sent ZERO disconnect_my_outlook requests',
    afterCancel - rpcBeforeCancel === 0,
    `${DISCONNECT_RPC} count went ${rpcBeforeCancel} -> ${afterCancel}`)
  check('and the connection is still there',
    one(`SELECT count(*) FROM public.microsoft_connections WHERE user_id='${PILOT_USER}';`) === rpcBefore
    && rpcBefore === '1', `connections=${rpcBefore}`)

  // Confirm: exactly one RPC, and it takes effect.
  await page.click('Disconnect', { byText: true })
  await sleep(400)
  // The accepted interactions are the user's records, not working state: whatever number
  // exists before the disconnect must exist after it.
  const interactionsBeforeDisconnect = one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`)
  await page.click(discMod.DISCONNECT_CONFIRM_LABEL, { byText: true })
  await sleep(1500)
  const afterConfirm = rpcCount()
  check('CONFIRM sent EXACTLY ONE disconnect_my_outlook request',
    afterConfirm - afterCancel === 1,
    `${DISCONNECT_RPC} count went ${afterCancel} -> ${afterConfirm}`)
  check('and the connection is gone',
    one(`SELECT count(*) FROM public.microsoft_connections WHERE user_id='${PILOT_USER}';`) === '0')
  check('and the accepted interactions SURVIVED the disconnect',
    one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}';`) === interactionsBeforeDisconnect
    && Number(interactionsBeforeDisconnect) >= 2,
    `before=${interactionsBeforeDisconnect}`)

  // == 6. the post-OAuth return to Settings ==================================
  // The callback redirects to /settings?outlook=error on EVERY failing path, and
  // until now nothing read that parameter - so a refused connection returned to a
  // page indistinguishable from one where nothing was attempted. That is the
  // silence the first live pilot consent landed in.
  console.log('\n6. ?outlook=error shows a generic notice, and a confirmed connection suppresses it')
  const connMod = await import(pathToFileURL(join(ROOT, 'src/lib/outlookConnection.js')).href)
  const NOTICE = connMod.messageForOutcome('callback_failed')

  // Section 5 just disconnected, so the database says NOT connected.
  check('the account is disconnected before this scenario',
    one(`SELECT count(*) FROM public.microsoft_connections WHERE user_id='${PILOT_USER}';`) === '0')

  // A control first: with NO parameter there must be no notice, so its later
  // presence is caused by the parameter and not by the page itself.
  await page.goto(`${ORIGIN}/settings`)
  await page.waitFor('/Connect Outlook/.test(document.body.innerText)', 20000,
    'the not-connected Outlook card')
  const plain = await page.eval(
    `return document.body.innerText.includes(${JSON.stringify(NOTICE)})`)
  check('plain /settings shows NO connection-failure notice', plain === false)

  await page.goto(`${ORIGIN}/settings?outlook=error`)
  await page.waitFor('/Connect Outlook/.test(document.body.innerText)', 20000,
    'the not-connected Outlook card')
  // Found by its announced role, then matched on the shipped copy - so this
  // asserts the real element, not merely that the string appears somewhere.
  const notice = await page.eval(`
    const el = [...document.querySelectorAll('[role="status"]')]
      .find((e) => (e.innerText || '').includes(${JSON.stringify(NOTICE)}))
    if (!el) return null
    const cs = getComputedStyle(el)
    return { text: el.innerText.trim(), live: el.getAttribute('aria-live'),
             shown: !!(el.offsetWidth || el.offsetHeight),
             hidden: cs.display === 'none' || cs.visibility === 'hidden' }`)
  check('?outlook=error DISPLAYS the generic notice while disconnected',
    notice !== null && notice.shown === true && notice.hidden === false,
    JSON.stringify(notice))
  check('it is the shipped copy, verbatim', notice?.text === NOTICE,
    `rendered=${JSON.stringify(notice?.text)}`)
  check('it is announced politely to assistive technology',
    notice?.live === 'polite', `aria-live=${notice?.live}`)
  // Scoped to the NOTICE, not the page: the disclosure legitimately names
  // Microsoft and Outlook, but the failure notice must stay generic.
  const leaks = ['graph', 'oid', 'tenant', 'token', 'scope', 'mismatch',
    'identity', 'entra', 'rpc', 'finalize', '401', '403', '500']
    .filter((w) => (notice?.text ?? '').toLowerCase().includes(w))
  check('the notice reveals no provider detail',
    notice !== null && leaks.length === 0,
    notice === null ? 'no notice was rendered, so this proves nothing'
      : `leaked: ${JSON.stringify(leaks)}`)
  // The card still offers the retry path rather than dead-ending.
  check('the Connect control is still offered alongside the notice',
    await page.eval('return /Connect Outlook/.test(document.body.innerText)') === true)

  // Now a CONFIRMED connection, with the stale parameter still in the address bar.
  psql(`
INSERT INTO public.microsoft_connections
  (user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes,
   status, consented_at, consent_policy_version)
VALUES ('${PILOT_USER}','acct-2','consumers','personal','${PILOT_EMAIL}',
        ARRAY['Mail.Read','User.Read','offline_access'],'active',now(),
        '${mod.OUTLOOK_DISCLOSURE_VERSION}');`, { tuplesOnly: false })
  check('a connection row now exists',
    one(`SELECT count(*) FROM public.microsoft_connections WHERE user_id='${PILOT_USER}';`) === '1')

  await page.goto(`${ORIGIN}/settings?outlook=error`)
  await page.waitFor('/Disconnect Outlook/.test(document.body.innerText)', 20000,
    'the connected Outlook card')
  const whenConnected = await page.eval(`
    const t = document.body.innerText
    return { notice: t.includes(${JSON.stringify(NOTICE)}),
             connected: /Connected to/.test(t),
             url: location.search }`)
  check('the stale ?outlook=error parameter is still in the URL',
    whenConnected.url.includes('outlook=error'), `search=${whenConnected.url}`)
  check('a CONFIRMED connected status SUPPRESSES the stale error notice',
    whenConnected.notice === false, JSON.stringify(whenConnected))
  check('and the connected state is what is shown instead',
    whenConnected.connected === true, JSON.stringify(whenConnected))

  // Leave no row behind for anything added after this.
  psql(`DELETE FROM public.microsoft_connections WHERE user_id='${PILOT_USER}';`,
    { tuplesOnly: false })

  // ══ 7. Suggestions is reachable from the navigation, with the pending count ═══
  // The queue used to be reachable only by URL or from a Dashboard entry that renders
  // only when something is pending. A proposal written while Funnl was closed has to be
  // discoverable: a rail item on desktop, a tab on mobile, both gated like the route.
  console.log('\n7. Suggestions is reachable from the navigation, with the pending count')
  const pendingMod = await import(pathToFileURL(join(ROOT, 'src/lib/pendingSuggestions.js')).href)
  const pendingNow = () => Number(one(`SELECT (SELECT count(*) FROM public.interaction_candidates
      WHERE user_id='${PILOT_USER}' AND status='pending')
    + (SELECT count(*) FROM public.new_contact_candidates WHERE user_id='${PILOT_USER}' AND status='pending');`))
  await page.goto(`${ORIGIN}/`)
  await page.waitFor('!!document.querySelector(\'a[aria-label="Suggestions"]\')', 20000, 'the Suggestions rail item')
  await sleep(800)   // the badge count is a separate RLS-scoped head request
  const rail = await page.eval(`
    const a = document.querySelector('a[aria-label="Suggestions"]')
    const badge = a ? a.querySelector('[data-testid="suggestions-badge"]') : null
    const all = [...document.querySelectorAll('a[href="/suggestions"]')]
    const mobile = document.querySelector('nav[aria-label="Main navigation"] a[href="/suggestions"]')
    return { href: a && a.getAttribute('href'), badge: badge ? badge.innerText.trim() : null,
             links: all.length, mobileLabel: mobile ? mobile.getAttribute('aria-label') : null,
             mobileHidden: mobile ? mobile.getClientRects().length === 0 : null }`)
  check('the rail item links to /suggestions', rail.href === '/suggestions', JSON.stringify(rail))
  const expectedBadge = pendingMod.badgeLabel(pendingNow())
  check('its badge shows the pending count across BOTH queues (' + pendingNow() + ')', rail.badge === expectedBadge,
    `badge=${rail.badge} expected=${expectedBadge}`)
  check('the mobile Review tab is rendered too, hidden at desktop width by CSS',
    rail.links >= 2 && typeof rail.mobileLabel === 'string' && rail.mobileLabel.startsWith('Suggestions') && rail.mobileHidden === true,
    JSON.stringify(rail))
  await page.click('a[aria-label="Suggestions"]')
  await page.waitFor('location.pathname === "/suggestions"', 10000, 'navigation to the queue')
  check('a real click on the rail item opens the queue - no direct URL needed',
    await page.eval('return location.pathname') === '/suggestions')

  // ══ 8. Settings shows the sync status from PERSISTED state ═══════════════
  // Every line comes from a row: the sync state, the retry state, the connection flags,
  // the subscription record. The rows are written here directly, which is exactly what the
  // worker would leave behind; the worker itself is not run by this harness.
  console.log('\n8. Settings shows the Outlook sync status from persisted state')
  const CONN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  psql(`
INSERT INTO public.microsoft_connections
  (id, user_id, ms_account_id, ms_tenant_id, account_type, ms_email, scopes, status, consented_at, consent_policy_version)
VALUES ('${CONN_ID}', '${PILOT_USER}', 'acct-3', 'consumers', 'personal', '${PILOT_EMAIL}',
        ARRAY['Mail.Read','User.Read','offline_access'], 'active', now(), '${mod.OUTLOOK_DISCLOSURE_VERSION}');
INSERT INTO public.outlook_sync_state
  (connection_id, user_id, folder, sync_status, initial_import_done, last_success_at, last_attempt_at, last_run_complete)
VALUES ('${CONN_ID}', '${PILOT_USER}', 'inbox',     'idle', true, now() - interval '5 minutes', now() - interval '5 minutes', true),
       ('${CONN_ID}', '${PILOT_USER}', 'sentitems', 'idle', true, now() - interval '5 minutes', now() - interval '5 minutes', true);
INSERT INTO public.outlook_subscriptions
  (connection_id, user_id, subscription_id, client_state_hash, status, expires_at, last_notification_at)
VALUES ('${CONN_ID}', '${PILOT_USER}', 'sub-browser', repeat('a', 64), 'active', now() + interval '2 days', now() - interval '5 minutes');`,
  { tuplesOnly: false })
  const statusBlock = async (expect, label) => {
    await page.goto(`${ORIGIN}/settings`)
    try {
      await page.waitFor(`(() => { const el = document.querySelector('[data-testid="outlook-sync-status"]');
        return !!el && new RegExp(${JSON.stringify(expect)}).test(el.innerText) })()`, 20000, label)
    } catch (e) {
      const diag = await page.eval(`const el = document.querySelector('[data-testid="outlook-sync-status"]');
        return { block: el ? el.innerText : null, card: (document.body.innerText.match(/Outlook[^]*?(Disconnect Outlook|Connect Outlook)/) || [''])[0].slice(0, 600) }`)
      console.error('    status block diagnostics: ' + JSON.stringify(diag))
      throw e
    }
    return page.eval(`const el = document.querySelector('[data-testid="outlook-sync-status"]');
      return { text: el.innerText, tone: el.getAttribute('data-tone'), live: el.getAttribute('aria-live') }`)
  }
  let st = await statusBlock('Up to date', 'the up-to-date status')
  check('idle after a complete run reads "Up to date" (ok tone)', st.tone === 'ok', JSON.stringify(st))
  check('it names the last successful sync FROM THE ROW: 5 minutes ago', /Last successful sync 5 minutes ago\./.test(st.text), st.text)
  check('it says Funnl is listening for new mail, with the renewal from the subscription row',
    /Listening for new mail \(renews in 2 days\)\./.test(st.text), st.text)
  check('the status is announced politely', st.live === 'polite', JSON.stringify(st))
  // A failed check with a scheduled retry: warn, with the code and the timing, still from rows.
  psql(`UPDATE public.outlook_sync_state SET sync_status = 'error', last_error_code = 'graph_failed',
          next_retry_at = now() + interval '20 minutes'
        WHERE connection_id = '${CONN_ID}' AND folder = 'inbox';`, { tuplesOnly: false })
  st = await statusBlock('did not finish', 'the retry status')
  check('a scheduled retry is reported with its code and timing (warn tone)',
    st.tone === 'warn' && /try again in 20 minutes \(graph_failed\)\./.test(st.text), JSON.stringify(st))
  // The connection needs permission again: error tone, with the actionable instruction.
  psql(`UPDATE public.microsoft_connections SET needs_reauth = true WHERE id = '${CONN_ID}';`, { tuplesOnly: false })
  st = await statusBlock('Needs your permission again', 'the reauth status')
  check('needs_reauth reads "Needs your permission again" (error tone) with the reconnect instruction',
    st.tone === 'error' && /Disconnect Outlook/.test(st.text), JSON.stringify(st))
  // New mail signalled, nothing running yet: the queued check is said, and nothing else is claimed.
  psql(`UPDATE public.microsoft_connections SET needs_reauth = false, wake_requested_at = now(), wake_source = 'change',
          wake_count = 1, last_wake_at = now() WHERE id = '${CONN_ID}';
        UPDATE public.outlook_sync_state SET sync_status = 'idle', last_error_code = NULL, next_retry_at = NULL
        WHERE connection_id = '${CONN_ID}';`, { tuplesOnly: false })
  st = await statusBlock('a check is queued', 'the queued status')
  check('a pending wake-up reads "New mail was signalled; a check is queued."',
    /New mail was signalled; a check is queued\./.test(st.text) && st.tone === 'ok', JSON.stringify(st))
  const leaksSt = ['token', 'ciphertext', 'nonce', 'service_role', 'rpc', 'sub-browser', 'aaaaaaaa']
    .filter((w) => st.text.toLowerCase().includes(w))
  check('the status block reveals no identifier, hash or secret', leaksSt.length === 0, JSON.stringify(leaksSt))

  // ══ 9. a proposal that ARRIVES while the queue is open becomes visible ════
  // SIMULATED ARRIVAL: the background worker is not run here. The row it would write is
  // inserted directly while the page is open; the page's bounded head-count poll (every
  // 30 s while visible) must notice it, reload, announce it, and raise the badge.
  console.log('\n9. a proposal arriving while the queue is open becomes visible without a reload')
  await page.goto(`${ORIGIN}/suggestions`)
  await page.waitFor('/Suggestions/.test(document.body.innerText)', 20000, 'the queue')
  await sleep(1500)   // let the first poll record the baseline count
  const ARRIVAL = 'Priya Arrival'
  check('the arriving contact is not shown yet',
    (await page.eval(`return document.body.innerText.includes(${JSON.stringify(ARRIVAL)})`)) === false)
  const badgeBefore = pendingNow()
  psql(`
INSERT INTO public.contacts (user_id, name, email) VALUES ('${PILOT_USER}', '${ARRIVAL}', 'priya@fund.test');
INSERT INTO public.interaction_candidates
  (user_id, contact_id, source, source_fingerprint, proposed_type, proposed_interaction_date, status,
   source_last_state, context_expires_at, proposed_notes, draft_summary, summary_evidence, extraction_status)
SELECT '${PILOT_USER}', c.id, 'outlook', repeat('9', 63) || 'a', 'Email', current_date, 'pending', 'active',
       now() + interval '30 days', 'Arrived while the queue was open.', 'Arrived while the queue was open.',
       'explicit_body', 'ai_extracted'
  FROM public.contacts c WHERE c.user_id = '${PILOT_USER}' AND c.name = '${ARRIVAL}';`, { tuplesOnly: false })
  const t0 = Date.now()
  let arrived = false
  try {
    await page.waitFor(`document.body.innerText.includes(${JSON.stringify(ARRIVAL)})`, 75000, 'the arrived proposal')
    arrived = true
  } catch { /* recorded below */ }
  const waitedMs = Date.now() - t0
  check('the new proposal appeared WITHOUT navigation or reload', arrived, `${waitedMs} ms`)
  check('within one poll interval plus a margin (< 45 s)', arrived && waitedMs < 45000, `${waitedMs} ms`)
  check('the page announced the arrival in its status banner',
    await page.eval(`return document.body.innerText.includes(${JSON.stringify(pendingMod.NEW_SUGGESTIONS_MESSAGE)})`))
  await sleep(600)
  const badgeAfter = await page.eval(`const b = document.querySelector('[data-testid="suggestions-badge"]'); return b ? b.innerText.trim() : null`)
  check('and the rail badge rose with it', badgeAfter === pendingMod.badgeLabel(badgeBefore + 1),
    `badge=${badgeAfter} expected=${pendingMod.badgeLabel(badgeBefore + 1)}`)
  check('seeing the arrival saved NOTHING: no interaction exists for the arrived contact',
    one(`SELECT count(*) FROM public.interactions WHERE user_id='${PILOT_USER}'
      AND contact_id = (SELECT id FROM public.contacts WHERE user_id='${PILOT_USER}' AND name='${ARRIVAL}');`) === '0')
  check('the arrived proposal is still pending, awaiting the user',
    one(`SELECT count(*) FROM public.interaction_candidates WHERE user_id='${PILOT_USER}' AND source_fingerprint = repeat('9', 63) || 'a' AND status='pending';`) === '1')
  // Leave no row behind.
  psql(`DELETE FROM public.interaction_candidates WHERE user_id='${PILOT_USER}' AND source_fingerprint = repeat('9', 63) || 'a';
        DELETE FROM public.contacts WHERE user_id='${PILOT_USER}' AND name='${ARRIVAL}';
        DELETE FROM public.microsoft_connections WHERE id='${CONN_ID}';`, { tuplesOnly: false })
  check('disconnect-style cleanup took the subscription record with the connection',
    one(`SELECT count(*) FROM public.outlook_subscriptions WHERE connection_id='${CONN_ID}';`) === '0')

  console.log('\n── what was actually CLICKED in the browser ──')
  for (const c of clicked) console.log(`   ${c}`)
}

// A THROWN setup or browser error must fail the command, even when no check has
// recorded a failure yet. Without this the harness could time out standing the stack
// up, print `0 checks: 0 passed, 0 failed`, and exit 0 - a green run that proved
// nothing. The error is counted as a failure in its own right.
let harnessError = null
try {
  await main()
} catch (e) {
  harnessError = e
  failed += 1
  console.error(`\nHARNESS ERROR: ${e.message}\n${e.stack}`)
} finally {
  await teardown()
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
  if (harnessError) {
    console.error('FAILED: the harness threw before finishing; the run proves nothing.')
  }
  if (failed > 0 || harnessError) process.exitCode = 1
}
