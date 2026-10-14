#!/usr/bin/env node
// PASTE AN EMAIL (Pro), END TO END, IN A REAL BROWSER.
//
// What is REAL here:
//   * Postgres - the project's own image with every migration in supabase/migrations applied.
//   * GoTrue - the real auth server. Users are created through its admin API, the browser signs
//     in through the app's own form, and the Edge Function's auth.getUser() is answered by it.
//   * PostgREST - every read and write the browser makes is an RLS-enforced request.
//   * The Edge Function - supabase/functions/ai-paste-email/index.ts, UNMODIFIED, served by
//     Supabase's own edge-runtime image, with its real import closure (Pro entitlement, the
//     Outlook redactor, minimization gate, drafting contract and bounded transport).
//   * The app - a production build of this checkout, driven in headless Chrome over the
//     DevTools Protocol with real mouse clicks, real keystrokes and real paste input.
//
// What is SIMULATED, and why:
//   * Anthropic. A local server answers the Messages API with scripted results. Inside the
//     edge-runtime container ONLY requests to https://api.anthropic.com are redirected to it
//     (a wrapper installed before the function module loads); nothing else is touched. This
//     proves the plumbing, validation and guards - NOT the real model's attribution quality.
//   * Kong. A local gateway routes /auth/v1, /rest/v1 and /functions/v1, serves the bundle,
//     and stands in for the platform's verify_jwt check on the function (HS256 signature and
//     expiry, as configured by [functions.ai-paste-email] verify_jwt = true). It can also
//     inject one failed or slowed write, for the retry and double-submission cases.
//
// Nothing here reaches Production, Anthropic or any third party. Test users and passwords
// are generated per run and never printed.
//
// RUN (from the repository root): node tests/local/paste-email-browser.mjs

import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { createServer as createHttp } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer as netCreateServer } from 'node:net'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const WORK = join(tmpdir(), 'funnl-paste-email-browser')
const DIST = join(WORK, 'dist')
const E2E = join(WORK, 'e2e')
const fwd = (p) => p.split('\\').join('/')

const NET = 'funnl-paste-net'
const PG = 'funnl-paste-pg'
const AUTH = 'funnl-paste-auth'
const REST = 'funnl-paste-rest'
const EDGE = 'funnl-paste-edge'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const AUTH_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.192.0'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const EDGE_IMAGE = 'public.ecr.aws/supabase/edge-runtime:v1.74.2'
const P = { rest: 54101, auth: 54102, edge: 54103, fake: 54104, gw: 54105 }
const GW = `http://127.0.0.1:${P.gw}`
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const JWT_SECRET = randomBytes(32).toString('hex')
const DB_PASSWORD = randomBytes(12).toString('hex')
const PRO = { email: 'pro-user@example.test', password: randomBytes(12).toString('hex') }
const FREE = { email: 'free-user@example.test', password: randomBytes(12).toString('hex') }
const MARK = 'ZQX-RAW-PASTE-MARKER'
const SUMMARY_MARK = 'QZ-MODEL-SUMMARY'

let passed = 0, failed = 0
const clicked = []
function check (name, cond, detail = '') {
  if (cond) { console.log(`  \u2713 ${name}`); passed++ }
  else { console.error(`  \u2717 ${name}`); if (detail) console.error(`    ${detail}`); failed++ }
}

// ── docker and Postgres ─────────────────────────────────────────────────────
const docker = (a, o = {}) => execFileSync('docker', a, { encoding: 'utf8', stdio: 'pipe', ...o })
const quiet = (a) => spawnSync('docker', a, { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function psql (sql, { user = 'postgres' } = {}) {
  return execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'],
    { input: sql, encoding: 'utf8', stdio: 'pipe' })
}
const one = (sql) => psql(sql).trim()
function waitForPg (timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline) {
    const r = spawnSync('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: 'CREATE TABLE public._p(i int); DROP TABLE public._p;', encoding: 'utf8' })
    if (r.status === 0) { streak += 1; if (streak >= 3) return } else { streak = 0 }
    spawnSync('node', ['-e', 'setTimeout(()=>{},1000)'], { stdio: 'ignore' })
  }
  throw new Error('Postgres never became stably DDL-ready')
}
async function waitHttp (url, ok, label, timeoutMs = 120000, init = undefined) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const r = await fetch(url, init); if (ok(r)) return } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error(`${label} never came up`)
}

function mintJwt (claims, secret = JWT_SECRET) {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = seg({ alg: 'HS256', typ: 'JWT' })
  const body = seg({ iat: now, exp: now + 3600, ...claims })
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
const ANON_KEY = mintJwt({ role: 'anon', iss: 'supabase' })
const SERVICE_KEY = mintJwt({ role: 'service_role', iss: 'supabase' })

/** The platform's verify_jwt, emulated: an HS256 token signed with the project secret, not expired. */
function verifyJwt (authHeader) {
  const m = /^Bearer (.+)$/.exec(authHeader ?? '')
  if (!m) return false
  const parts = m[1].split('.')
  if (parts.length !== 3) return false
  const sig = createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url')
  if (sig !== parts[2]) return false
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof claims.exp === 'number' && claims.exp > Date.now() / 1000
  } catch { return false }
}

// ── the simulated Anthropic Messages API ────────────────────────────────────
const fakeCalls = []
let fakeScript = null
function setFake (contact, note) { fakeScript = { contact, note } }
function startFake () {
  const srv = createHttp(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try { body = JSON.parse(raw) } catch { /* recorded as unparseable */ }
    const kind = body?.output_config?.format?.schema?.required?.includes('people') ? 'contact' : 'note'
    fakeCalls.push({ kind, raw, hasKey: req.headers['x-api-key'] === 'fake-key-not-a-secret', path: req.url })
    const r = fakeScript?.[kind] ?? { status: 500 }
    if (r.status) { res.writeHead(r.status, { 'Content-Type': 'application/json' }); return res.end('{"type":"error"}') }
    const text = r.text ?? JSON.stringify(r.value)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
  })
  return new Promise((r) => srv.listen(P.fake, '0.0.0.0', () => r(srv)))
}

// ── the gateway: bundle + /auth/v1 + /rest/v1 + /functions/v1 ───────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' }
const gwLog = []
const faults = { failNextInteractionInsert: false, slowContactInsertMs: 0 }
function startGateway () {
  const srv = createHttp(async (req, res) => {
    const path = req.url.split('?')[0]
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks)
    let upstream = null
    if (path.startsWith('/auth/v1/')) upstream = `http://127.0.0.1:${P.auth}` + req.url.slice('/auth/v1'.length)
    else if (path.startsWith('/rest/v1/')) upstream = `http://127.0.0.1:${P.rest}` + req.url.slice('/rest/v1'.length)
    else if (path.startsWith('/functions/v1/')) upstream = `http://127.0.0.1:${P.edge}` + req.url
    if (!upstream) {
      let file = join(DIST, path === '/' ? 'index.html' : path.replace(/^\//, ''))
      if (!existsSync(file) || path === '/') file = join(DIST, 'index.html')
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'text/html' })
      return res.end(readFileSync(file))
    }
    const entry = { method: req.method, path, status: null }
    gwLog.push(entry)
    if (path.startsWith('/functions/v1/') && req.method !== 'OPTIONS' && !verifyJwt(req.headers.authorization)) {
      entry.status = 401
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ code: 401, message: 'Invalid JWT' }))
    }
    if (req.method === 'POST' && path === '/rest/v1/interactions' && faults.failNextInteractionInsert) {
      faults.failNextInteractionInsert = false
      entry.status = 503; entry.injected = true
      res.writeHead(503, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ message: 'fixture: injected failure' }))
    }
    if (req.method === 'POST' && path === '/rest/v1/contacts' && faults.slowContactInsertMs > 0) await sleep(faults.slowContactInsertMs)
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length'].includes(k)) continue
      if (typeof v === 'string') headers[k] = v
    }
    let r
    try {
      r = await fetch(upstream, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw })
    } catch (e) {
      entry.status = 502
      res.writeHead(502, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ message: 'gateway: ' + e.message }))
    }
    entry.status = r.status
    const out = Buffer.from(await r.arrayBuffer())
    const h = { 'Content-Type': r.headers.get('content-type') ?? 'application/json' }
    for (const k of ['content-range', 'location', 'cache-control']) { const v = r.headers.get(k); if (v) h[k] = v }
    res.writeHead(r.status, h)
    res.end(out)
  })
  return new Promise((r) => srv.listen(P.gw, '0.0.0.0', () => r(srv)))
}
const TABLE_WRITE = /^\/rest\/v1\/(?!rpc\/)/
function tableWritesSince (i) {
  return gwLog.slice(i).filter((e) => TABLE_WRITE.test(e.path) && !['GET', 'HEAD', 'OPTIONS'].includes(e.method))
}

// ── CDP ─────────────────────────────────────────────────────────────────────
class Page {
  constructor (ws) { this.ws = ws; this.S = null; this.id = 0; this.pending = new Map() }
  static async attach (wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    const p = new Page(ws)
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id) }
    }
    const { result: t } = await p.raw('Target.getTargets')
    const page = t.targetInfos.find((x) => x.type === 'page')
    const { result: a } = await p.raw('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    p.S = a.sessionId
    await p.send('Runtime.enable'); await p.send('Page.enable')
    return p
  }
  // Every DevTools command is bounded: a command that never answers fails the run with its
  // name, instead of hanging it.
  raw (method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const myId = ++this.id
      const timer = setTimeout(() => { this.pending.delete(myId); rej(new Error(`devtools timeout: ${method}`)) }, 30000)
      this.pending.set(myId, (m) => { clearTimeout(timer); res(m) })
      this.ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  async send (method, params = {}) {
    const m = await this.raw(method, params, this.S)
    if (m.error) throw new Error(`${method}: ${m.error.message}`)
    return m.result
  }
  async eval (expression) {
    const r = await this.send('Runtime.evaluate', { expression: `(() => { ${expression} })()`, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    return r.result.value
  }
  async goto (url) { await this.send('Page.navigate', { url }); await this.waitFor('document.readyState === "complete"', 20000) }
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
  /** A REAL mouse click at the element's centre. */
  async click (target, { byText = false, within = null } = {}) {
    const root = within ? `document.querySelector(${JSON.stringify(within)})` : 'document'
    const expr = byText
      ? `const scope=${root}; if(!scope) return null;
         const els=[...scope.querySelectorAll('button,a,label')];
         const el=els.find(e=>(e.innerText||'').trim()===${JSON.stringify(target)}) || els.find(e=>(e.innerText||'').trim().includes(${JSON.stringify(target)}));
         if(!el) return null; el.scrollIntoView({block:'center'});
         const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,tag:el.tagName};`
      : `const el=${root}.querySelector(${JSON.stringify(target)});
         if(!el) return null; el.scrollIntoView({block:'center'});
         const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,tag:el.tagName};`
    const box = await this.eval(expr)
    if (!box) throw new Error(`no element for click: ${target}`)
    await this.mouse(box)
    clicked.push(`${byText ? 'text' : 'css'}:${target} (<${box.tag.toLowerCase()}>)`)
    await sleep(200)
    return box
  }
  async mouse (box) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  async type (selector, text) {
    await this.click(selector)
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
    }
  }
  /** Text arriving the way a paste does: one input event, newlines intact. */
  async paste (selector, text) { await this.click(selector); await this.send('Input.insertText', { text }); await sleep(150) }
  async escape () {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(250)
  }
  /** A <select> or date input changed the way React observes it (native setter + event). */
  async setValue (selector, value) {
    const ok = await this.eval(`const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return true`)
    if (!ok) throw new Error(`no element to set: ${selector}`)
    clicked.push(`set:${selector}`)
    await sleep(200)
  }
}

/** Every hook value held by the mounted PasteEmailDrawer, read from React's CURRENT fiber tree. */
const DRAWER_STATE = `
  const dlg = document.querySelector('[role=dialog][aria-label="Paste an email"]'); if (!dlg) return null;
  const c = document.getElementById('root'); const ck = Object.keys(c).find(k => k.startsWith('__reactContainer$'));
  const root = c[ck].stateNode.current; const stack = [[root, null]]; let found = null;
  while (stack.length) { const [f, fn] = stack.pop(); const near = typeof f.type === 'function' ? f : fn;
    if (f.stateNode === dlg) { found = near; break }
    if (f.sibling) stack.push([f.sibling, fn]); if (f.child) stack.push([f.child, near]) }
  if (!found) return 'not_found';
  const states = []; let h = found.memoizedState; while (h) { states.push(h.memoizedState); h = h.next }
  const seen = new WeakSet();
  return JSON.stringify(states, (k, v) => { if (typeof v === 'object' && v !== null) { if (seen.has(v)) return; seen.add(v); if (v instanceof Node) return '[node]' } return v });`
const STORAGE_HAS = (s) => `const j = JSON.stringify({...localStorage}) + JSON.stringify({...sessionStorage}); return j.includes(${JSON.stringify(s)})`
const DOM_HAS = (s) => `return document.documentElement.outerHTML.includes(${JSON.stringify(s)}) || [...document.querySelectorAll('textarea,input')].some(e => (e.value||'').includes(${JSON.stringify(s)}))`

// ── fixtures ────────────────────────────────────────────────────────────────
const NL = String.fromCharCode(10)
// One counterpart, one clear date header with an offset: 01:30Z on the 14th is the 13th in New York.
const SINGLE = [
  'From: Priya Shah <priya.shah@goldman.example>',
  'To: Me <me@school.example>',
  'Date: Tue, 13 Oct 2026 21:30:00 -0400',
  'Subject: Following up',
  '',
  `Thanks for the coffee chat yesterday. ${MARK}`,
  'Priya Shah | Analyst | Goldman Sachs',
].join(NL)
// Two counterparts with different names, companies and roles, plus quoted history.
const THREAD = [
  'From: Me <me@school.example>',
  'To: Marcus Bell <marcus.bell@northwind.example>',
  'Cc: Dana Whitfield <dana@kestrel.example>',
  'Date: Tue, 13 Oct 2026 21:30:00 -0400',
  'Subject: Re: Intro',
  '',
  `Marcus, Dana - thank you both for the call. ${MARK}`,
  '',
  'On Mon, Oct 12, 2026 at 9:00 AM Marcus Bell <marcus.bell@northwind.example> wrote:',
  '> Happy to chat. I lead recruiting at Northwind Capital as Head of Talent.',
  '> Dana Whitfield is a Senior Associate at Kestrel Partners and will join.',
].join(NL)
// Several participants, one of them an existing contact; no date header at all.
const GROUP = [
  'From: Sam Okafor <sam@club.example>',
  'To: Priya Shah <priya.shah@goldman.example>, Me <me@school.example>',
  'Subject: Panel follow-up',
  '',
  `Priya, thanks for joining the panel. ${MARK}`,
].join(NL)
const LENA = [
  'From: Lena Ortiz <lena@harbor.example>',
  'Date: 2026-10-12',
  '',
  `Lena Ortiz, Product Manager at Harbor Labs, here - good to meet you. ${MARK}`,
].join(NL)

const NOTE_OK = (summary) => ({ value: { result: 'interaction_draft', summary, summary_evidence: 'explicit_body', follow_up: 'Send a thank-you note', interaction_date: null } })
const PEOPLE = (people) => ({ value: { people: people.map((p) => ({ company: null, company_evidence: null, role: null, role_evidence: null, how_met: null, linkedin_url: null, linkedin_evidence: null, ...p })) } })
// Evidence lines, as they appear in the MASKED text the model is given.
const MARCUS_EV = ['On Mon, Oct 12, 2026 at 9:00 AM Marcus Bell <[email removed]> wrote:', '> Happy to chat. I lead recruiting at Northwind Capital as Head of Talent.'].join(NL)
const DANA_EV = '> Dana Whitfield is a Senior Associate at Kestrel Partners and will join.'
const SAME = [
  'From: Me <me@school.example>',
  'To: Alex Kim <alex.kim@goldman.example>, Alex Kim <akim@kestrel.example>, Jamie Fox <jamie@goldman.example>',
  'Date: 2026-10-12',
  'Subject: Panel',
  '',
  `Thanks all for the panel. ${MARK}`,
  '',
  'Alex Kim | Associate | Goldman Sachs',
  'Alex Kim | Partner | Kestrel Partners',
  'Jamie Fox | Analyst | Goldman Sachs',
].join(NL)

let chrome = null, gw = null, fake = null, page = null
async function teardown () {
  if (page) {
    try { await Promise.race([page.raw('Browser.close'), sleep(4000)]) } catch { /* gone */ }
    try { page.ws.close() } catch { /* closed */ }
  }
  if (chrome) {
    const deadline = Date.now() + 8000
    while (chrome.exitCode === null && chrome.signalCode === null && Date.now() < deadline) await sleep(150)
    if (chrome.exitCode === null && chrome.signalCode === null) { try { chrome.kill() } catch { /* ignore */ } await sleep(500) }
  }
  try { gw?.close() } catch { /* ignore */ }
  try { fake?.close() } catch { /* ignore */ }
  for (const c of [EDGE, REST, AUTH, PG]) quiet(['rm', '-f', c])
  quiet(['network', 'rm', NET])
  try { for (const p of readdirSync(WORK)) if (p.startsWith('profile-')) rmSync(join(WORK, p), { recursive: true, force: true }) } catch { /* none */ }
}
async function freePort () {
  const srv = netCreateServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

async function main () {
  mkdirSync(WORK, { recursive: true })
  await teardown()

  console.log('\nbuilding the app (production build of this checkout)')
  execFileSync('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir'], {
    cwd: ROOT, stdio: 'pipe', shell: true,
    env: { ...process.env, VITE_SUPABASE_URL: GW, VITE_SUPABASE_ANON_KEY: ANON_KEY, VITE_POSTHOG_KEY: '' },
  })

  console.log('standing up Postgres + GoTrue + PostgREST + edge-runtime')
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', `POSTGRES_PASSWORD=${DB_PASSWORD}`, PG_IMAGE])
  waitForPg()
  psql(`ALTER ROLE supabase_auth_admin WITH PASSWORD '${DB_PASSWORD}'; ALTER ROLE authenticator WITH PASSWORD '${DB_PASSWORD}';`, { user: 'supabase_admin' })

  // GoTrue first: it migrates the auth schema to the current shape, as on a real project.
  docker(['run', '-d', '--name', AUTH, '--network', NET, '-p', `${P.auth}:9999`,
    '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'GOTRUE_API_PORT=9999', '-e', `API_EXTERNAL_URL=${GW}/auth/v1`,
    '-e', 'GOTRUE_DB_DRIVER=postgres', '-e', `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', `GOTRUE_SITE_URL=${GW}`, '-e', `GOTRUE_JWT_SECRET=${JWT_SECRET}`, '-e', 'GOTRUE_JWT_EXP=3600',
    '-e', 'GOTRUE_JWT_AUD=authenticated', '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
    '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role', '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
    '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true', '-e', 'GOTRUE_DISABLE_SIGNUP=false', AUTH_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.auth}/health`, (r) => r.ok, 'GoTrue')

  const migrations = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  for (const m of migrations) psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'))
  console.log(`  applied ${migrations.length} migrations after GoTrue's own`)

  docker(['run', '-d', '--name', REST, '--network', NET, '-p', `${P.rest}:3000`,
    '-e', `PGRST_DB_URI=postgres://authenticator:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.rest}/`, (r) => r.status < 500, 'PostgREST')

  fake = await startFake()
  gw = await startGateway()

  // The function, unmodified. The entry below only redirects Anthropic, then loads it.
  mkdirSync(E2E, { recursive: true })
  writeFileSync(join(E2E, 'index.ts'), [
    '// Test entry: ONLY https://api.anthropic.com is redirected to the local simulation.',
    'const realFetch = globalThis.fetch',
    "const FAKE = Deno.env.get('FAKE_ANTHROPIC_URL')",
    'globalThis.fetch = (input: any, init?: any) => {',
    "  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)",
    "  if (url.startsWith('https://api.anthropic.com/')) return realFetch(FAKE + url.slice('https://api.anthropic.com'.length), init)",
    '  return realFetch(input, init)',
    '}',
    "await import('../functions/ai-paste-email/index.ts')",
    '',
  ].join(NL))
  docker(['run', '-d', '--name', EDGE, '--network', NET, '-p', `${P.edge}:9000`, '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${fwd(join(ROOT, 'supabase/functions'))}:/home/deno/functions:ro`, '-v', `${fwd(E2E)}:/home/deno/e2e:ro`,
    '-e', `SUPABASE_URL=http://host.docker.internal:${P.gw}`, '-e', `SUPABASE_ANON_KEY=${ANON_KEY}`,
    '-e', `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}`, '-e', 'ANTHROPIC_API_KEY=fake-key-not-a-secret',
    '-e', `FAKE_ANTHROPIC_URL=http://host.docker.internal:${P.fake}`,
    EDGE_IMAGE, 'start', '--main-service', '/home/deno/e2e', '-p', '9000'])
  await waitHttp(`http://127.0.0.1:${P.edge}/functions/v1/ai-paste-email`, (r) => r.status === 401, 'the Edge Function', 180000, { method: 'POST' })
  console.log('  ai-paste-email answering (unauthenticated POST -> 401)')

  // ── users, through GoTrue's admin API ──
  const admin = (body) => fetch(`http://127.0.0.1:${P.auth}/admin/users`, {
    method: 'POST', headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, email_confirm: true }),
  }).then((r) => r.json())
  const proUser = await admin(PRO)
  const freeUser = await admin(FREE)
  const A = proUser.id, B = freeUser.id
  check('two users created by the real GoTrue', /^[0-9a-f-]{36}$/.test(A) && /^[0-9a-f-]{36}$/.test(B))
  check('the signup trigger created both profile rows', one(`SELECT count(*) FROM public.profiles WHERE id IN ('${A}','${B}')`) === '2')
  psql(`UPDATE public.profiles SET ai_enabled = true WHERE id = '${A}';
        UPDATE public.pro_trials SET started_at = now() - interval '10 days', ends_at = now() - interval '3 days' WHERE user_id = '${B}';`)
  const priyaId = randomUUID(), jordanId = randomUUID()
  psql(`INSERT INTO public.contacts (id, user_id, name, email, company) VALUES
          ('${priyaId}', '${A}', 'Priya Shah', 'Priya.Shah@goldman.example', 'Goldman Sachs'),
          ('${jordanId}', '${A}', 'Jordan Park', NULL, NULL);`)
  const counts = () => ({
    contacts: Number(one(`SELECT count(*) FROM public.contacts WHERE user_id='${A}'`)),
    interactions: Number(one(`SELECT count(*) FROM public.interactions WHERE user_id='${A}'`)),
  })

  // ── Chrome ──
  const cdp = await freePort()
  const PROFILE = join(WORK, `profile-${Date.now()}`)
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,1100', 'about:blank'], { stdio: 'ignore' })
  let ver = null
  for (let i = 0; i < 80 && !ver; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdp}/json/version`); if (r.ok) ver = await r.json() } catch { /* wait */ }
    if (!ver) await sleep(300)
  }
  if (!ver) throw new Error('Chrome devtools endpoint never came up')
  page = await Page.attach(ver.webSocketDebuggerUrl)
  await page.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' })
  console.log(`  ${ver.Browser}, time zone America/New_York\n`)

  const signIn = async (u) => {
    await page.goto(`${GW}/signin`)
    await page.waitFor('document.querySelector(\'input[type="email"]\')', 20000, 'the sign-in form')
    await page.type('input[type="email"]', u.email)
    await page.type('input[type="password"]', u.password)
    await page.click('button[type="submit"]')
    await page.waitFor('!document.querySelector(\'input[type="password"]\')', 20000, 'the app after sign-in')
  }
  const openDrawerOn = async (url) => {
    await page.goto(url)
    await page.waitFor('document.querySelector(\'button[title="Paste an email (Pro)"]\')', 20000, 'the Paste email button')
    await page.click('button[title="Paste an email (Pro)"]')
    await page.waitFor('document.querySelector("#paste-email-text")', 5000, 'the paste box')
  }
  const draftFrom = async (text) => {
    await page.paste('#paste-email-text', text)
    await page.click('Draft from email', { byText: true, within: '[role=dialog]' })
  }
  const toReview = () => page.waitFor('document.body.innerText.includes("Who is this email with?")', 20000, 'the review step')
  const dlgText = () => page.eval('return document.querySelector("[role=dialog]")?.innerText ?? ""')
  const saveDisabled = () => page.eval('const b=[...document.querySelectorAll("[role=dialog] button")].find(b=>/^Save/.test(b.innerText.trim())); return b ? b.disabled : null')

  // ══ 1. sign-in and the entry points ═══════════════════════════════════════
  console.log('1. sign-in through the real GoTrue, and the Pro-only entry points')
  await signIn(PRO)
  check('the Pro user signed in through the app form', gwLog.some((e) => e.path === '/auth/v1/token' && e.status === 200))
  await page.goto(`${GW}/contacts`)
  await page.waitFor('document.querySelector(\'button[title="Paste an email (Pro)"]\')', 20000, 'Paste email on Contacts')
  check('Contacts shows "Paste email" for a Pro user', true)

  // ══ 2. an EXISTING contact, from their page ═══════════════════════════════
  console.log('2. existing contact, from their page: clear date, nothing written before Save')
  await openDrawerOn(`${GW}/contacts/${priyaId}`)
  const explainVisible = await page.eval('return !!document.querySelector("[data-testid=paste-email-explanation]") && !!document.querySelector("[role=dialog] a[href=\'/privacy\']")')
  check('the explanation and privacy link are shown before anything is submitted', explainVisible)
  const before2 = counts(); const log2 = gwLog.length; const fake2 = fakeCalls.length
  setFake(PEOPLE([{ name: 'Priya Shah', company: 'Goldman Sachs', company_evidence: 'Priya Shah | Analyst | Goldman Sachs', role: 'Analyst', role_evidence: 'Priya Shah | Analyst | Goldman Sachs' }]), NOTE_OK(`Priya thanked the user for the coffee chat. ${SUMMARY_MARK}`))
  await draftFrom(SINGLE)
  await toReview()
  const fnCall = gwLog.slice(log2).find((e) => e.path === '/functions/v1/ai-paste-email')
  check('the browser called the real function through the gateway and got 200', fnCall?.method === 'POST' && fnCall?.status === 200, JSON.stringify(fnCall))
  check('two model requests were made (contact + note)', fakeCalls.length - fake2 === 2)
  check('NO table write and NO row change before Save', tableWritesSince(log2).length === 0 && JSON.stringify(counts()) === JSON.stringify(before2),
    JSON.stringify({ writes: tableWritesSince(log2), counts: counts() }))
  const date2 = await page.eval('return document.querySelector("#paste-email-date").value')
  check('the clear, zoned date is prefilled as the reviewer\u2019s local day (01:30Z -> Oct 13 in New York)', date2 === '2026-10-13', date2)
  const t2 = await dlgText()
  check('capture from the contact page names that contact and asks nothing', t2.includes('Priya Shah') && !t2.includes('A new contact'))
  const held2 = await page.eval(DRAWER_STATE)
  check('positive control: before Save the drawer still holds the raw paste', typeof held2 === 'string' && held2.includes(MARK))
  await page.click('Save', { byText: true, within: '[role=dialog]' })
  await page.waitFor('document.querySelector("[data-testid=paste-email-save-status]")', 10000, 'the save status')
  const after2 = counts()
  const row2 = one(`SELECT contact_id || '|' || type || '|' || interaction_date || '|' || (notes LIKE '%${SUMMARY_MARK}%') FROM public.interactions WHERE user_id='${A}' ORDER BY created_at DESC LIMIT 1`)
  check('one Email interaction saved on Priya, with the drafted note and the local date', row2 === `${priyaId}|Email|2026-10-13|true`, row2)
  check('no contact was created or changed', after2.contacts === before2.contacts && after2.interactions === before2.interactions + 1)
  check('the status says only the interaction was saved', (await dlgText()).includes('Saved: the interaction.'))
  const state2 = await page.eval(DRAWER_STATE)
  check('successful completion CLEARED the raw paste from the drawer state', typeof state2 === 'string' && state2.length > 0 && !state2.includes(MARK))
  check('the raw paste is in neither localStorage nor sessionStorage', !(await page.eval(STORAGE_HAS(MARK))))
  check('the raw paste is nowhere in the page', !(await page.eval(DOM_HAS(MARK))))
  await page.click('Close', { byText: true, within: '[role=dialog]' })

  // ══ 3. several participants, one an existing contact; no date ═════════════
  console.log('3. several participants on the Contacts page: nothing chosen for the reviewer')
  await openDrawerOn(`${GW}/contacts`)
  setFake(PEOPLE([{ name: 'Sam Okafor' }, { name: 'Priya Shah' }]), NOTE_OK('Sam thanked Priya for joining the panel.'))
  const before3 = counts(); const log3 = gwLog.length
  await draftFrom(GROUP)
  await toReview()
  const t3 = await dlgText()
  check('the matched contact is offered as a choice, with its address', t3.includes('Priya Shah') && t3.includes('(priya.shah@goldman.example)'), JSON.stringify(t3.slice(0, 600)))
  const radios3 = await page.eval('return [...document.querySelectorAll("[role=dialog] input[name=paste-person]")].filter(r=>r.checked).length')
  check('no person is preselected, and Save is disabled until one is chosen', radios3 === 0 && (await saveDisabled()) === true)
  check('with no date in the email the date is blank and required', (await page.eval('return document.querySelector("#paste-email-date").value')) === '' && t3.includes('Choose the date of this conversation.'))
  const radio3 = await page.eval('const l=[...document.querySelectorAll("[role=dialog] label")].find(l=>l.innerText.includes("priya.shah@goldman.example")); const r=l?.querySelector("input"); if(!r) return null; const b=r.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}')
  if (!radio3) throw new Error('no radio for the matched contact')
  await page.mouse(radio3); await sleep(200); clicked.push('radio: Priya Shah (matched by address)')
  await page.setValue('#paste-email-date', '2026-10-11')
  check('choosing a person and a date enables Save', (await saveDisabled()) === false)
  check('no table write before Save', tableWritesSince(log3).length === 0)
  await page.click('Save', { byText: true, within: '[role=dialog]' })
  await page.waitFor('document.body.innerText.includes("Saved: the interaction.")', 10000, 'saved')
  const after3 = counts()
  check('the interaction went to the CHOSEN existing contact; no contact was created',
    after3.contacts === before3.contacts && one(`SELECT contact_id || '|' || interaction_date FROM public.interactions WHERE user_id='${A}' ORDER BY created_at DESC LIMIT 1`) === `${priyaId}|2026-10-11`)
  await page.click('Close', { byText: true, within: '[role=dialog]' })

  // ══ 4. a NEW contact from a two-person thread; quoted date; failed then retried ══
  console.log('4. new contact from a two-person thread: attribution, quoted date, partial save and retry')
  await openDrawerOn(`${GW}/contacts`)
  setFake(PEOPLE([
    { name: 'Marcus Bell', company: 'Northwind Capital', company_evidence: MARCUS_EV, role: 'Head of Talent', role_evidence: MARCUS_EV, how_met: 'Intro call' },
    // SWAPPED: Marcus's company offered for Dana, citing Marcus's lines; her own role is evidenced.
    { name: 'Dana Whitfield', company: 'Northwind Capital', company_evidence: MARCUS_EV, role: 'Senior Associate', role_evidence: DANA_EV },
    { name: 'Ghost Invented', company: 'Nowhere Inc' },
  ]), NOTE_OK(`Marcus and Dana agreed to a follow-up call. ${SUMMARY_MARK}`))
  const before4 = counts(); const log4 = gwLog.length
  await draftFrom(THREAD)
  await toReview()
  const date4 = await page.eval('return { v: document.querySelector("#paste-email-date").value, note: document.querySelector("[data-testid=paste-email-date-note]")?.innerText }')
  check('quoted history: the date is NOT prefilled, and the reason is shown', date4.v === '' && /earlier or forwarded messages/.test(date4.note ?? ''), JSON.stringify(date4))
  await page.click('A new contact', { byText: true, within: '[role=dialog]' })
  const blank4 = await page.eval('return ["#paste-email-name","#paste-email-company","#paste-email-role"].map(s=>document.querySelector(s).value)')
  check('choosing "A new contact" fills NOTHING in by itself', blank4.every((v) => v === ''), JSON.stringify(blank4))
  const opts4 = await page.eval('return [...document.querySelectorAll("#paste-email-ai-person option")].map(o=>o.textContent)')
  check('the picker offers the two real people and not the invented one',
    JSON.stringify(opts4) === JSON.stringify(['Choose a person…', 'Marcus Bell', 'Dana Whitfield', 'Someone not listed']), JSON.stringify(opts4))
  await page.setValue('#paste-email-ai-person', '1')
  const dana = await page.eval('return ["#paste-email-name","#paste-email-company","#paste-email-role"].map(s=>document.querySelector(s).value)')
  check('SWAPPED company: Dana gets her own evidenced role, and Marcus\u2019s company is left blank', JSON.stringify(dana) === JSON.stringify(['Dana Whitfield', '', 'Senior Associate']), JSON.stringify(dana))
  await page.setValue('#paste-email-ai-person', '0')
  const marcus = await page.eval('return ["#paste-email-name","#paste-email-company","#paste-email-role","#paste-email-how-met"].map(s=>document.querySelector(s).value)')
  check('picking Marcus fills ONLY Marcus\u2019s name, company and role', JSON.stringify(marcus) === JSON.stringify(['Marcus Bell', 'Northwind Capital', 'Head of Talent', 'Intro call']), JSON.stringify(marcus))
  await page.setValue('#paste-email-ai-person', 'not_listed')
  const cleared4 = await page.eval('return ["#paste-email-name","#paste-email-company","#paste-email-role"].map(s=>document.querySelector(s).value)')
  check('"Someone not listed" clears every AI field', cleared4.every((v) => v === ''))
  await page.setValue('#paste-email-ai-person', '0')
  const addr4 = await page.eval('return [...document.querySelectorAll("#paste-email-address option")].map(o=>o.value)')
  check('the email is the reviewer\u2019s own choice: blank by default, every found address offered',
    (await page.eval('return document.querySelector("#paste-email-address").value')) === '' && addr4.includes('marcus.bell@northwind.example') && addr4.includes('dana@kestrel.example') && addr4.includes('me@school.example'), JSON.stringify(addr4))
  await page.setValue('#paste-email-address', 'marcus.bell@northwind.example')
  check('Save stays disabled while the date is missing', (await saveDisabled()) === true)
  await page.setValue('#paste-email-date', '2026-10-13')
  check('no table write before Save', tableWritesSince(log4).length === 0)
  faults.failNextInteractionInsert = true
  await page.click('Save', { byText: true, within: '[role=dialog]' })
  await page.waitFor('document.body.innerText.includes("interaction was not")', 10000, 'the partial-save status')
  const mid4 = counts()
  check('partial save: the contact was saved, the interaction was not, and the status says so',
    mid4.contacts === before4.contacts + 1 && mid4.interactions === before4.interactions && (await dlgText()).includes('Contact: saved · Interaction: not saved'))
  check('Back to email is withdrawn once a contact exists', !(await dlgText()).includes('Back to email'))
  const marcusId = one(`SELECT id FROM public.contacts WHERE user_id='${A}' AND name='Marcus Bell'`)
  await page.click('Save interaction', { byText: true, within: '[role=dialog]' })
  await page.waitFor('document.body.innerText.includes("Saved: the new contact and the interaction.")', 10000, 'saved after retry')
  const after4 = counts()
  check('retry used the SAVED contact: still one Marcus, interaction attached to him',
    after4.contacts === before4.contacts + 1 && after4.interactions === before4.interactions + 1
      && one(`SELECT count(*) FROM public.contacts WHERE user_id='${A}' AND name='Marcus Bell'`) === '1'
      && one(`SELECT contact_id FROM public.interactions WHERE user_id='${A}' ORDER BY created_at DESC LIMIT 1`) === marcusId)
  const saved4 = one(`SELECT name||'|'||coalesce(company,'')||'|'||coalesce(role,'')||'|'||coalesce(email,'') FROM public.contacts WHERE id='${marcusId}'`)
  check('the saved contact carries Marcus\u2019s own details and the chosen address (none of Dana\u2019s)',
    saved4 === 'Marcus Bell|Northwind Capital|Head of Talent|marcus.bell@northwind.example', saved4)
  check('exactly two contact/interaction POSTs reached the database path in total (1 contact, 1 failed + 1 interaction)',
    tableWritesSince(log4).map((e) => `${e.method} ${e.path} ${e.status}`).join(',') === 'POST /rest/v1/contacts 201,POST /rest/v1/interactions 503,POST /rest/v1/interactions 201',
    JSON.stringify(tableWritesSince(log4)))
  await page.click('Close', { byText: true, within: '[role=dialog]' })

  // ══ 4b. shared employer and identical display names ════════════════════════
  console.log('4b. a shared employer is kept; two people with the same name are both offered')
  await openDrawerOn(`${GW}/contacts`)
  setFake(PEOPLE([
    { name: 'Alex Kim', company: 'Goldman Sachs', company_evidence: 'Alex Kim | Associate | Goldman Sachs', role: 'Associate', role_evidence: 'Alex Kim | Associate | Goldman Sachs' },
    { name: 'Alex Kim', company: 'Kestrel Partners', company_evidence: 'Alex Kim | Partner | Kestrel Partners', role: 'Partner', role_evidence: 'Alex Kim | Partner | Kestrel Partners' },
    { name: 'Jamie Fox', company: 'Goldman Sachs', company_evidence: 'Jamie Fox | Analyst | Goldman Sachs', role: 'Analyst', role_evidence: 'Jamie Fox | Analyst | Goldman Sachs' },
  ]), NOTE_OK('Thanked the panel.'))
  const before4b = counts()
  await draftFrom(SAME)
  await toReview()
  await page.click('A new contact', { byText: true, within: '[role=dialog]' })
  const opts4b = await page.eval('return [...document.querySelectorAll("#paste-email-ai-person option")].map(o=>o.textContent)')
  check('both people named Alex Kim are offered, labelled apart',
    JSON.stringify(opts4b) === JSON.stringify(['Choose a person…', 'Alex Kim (Goldman Sachs, Associate; 1 of 2)', 'Alex Kim (Kestrel Partners, Partner; 2 of 2)', 'Jamie Fox', 'Someone not listed']), JSON.stringify(opts4b))
  await page.setValue('#paste-email-ai-person', '1')
  const alex2 = await page.eval('return { f: ["#paste-email-name","#paste-email-company","#paste-email-role"].map(s=>document.querySelector(s).value), warn: document.querySelector("[data-testid=paste-email-ambiguous-name]")?.innerText ?? "" }')
  check('picking the second Alex Kim fills that person\u2019s own details and warns the name is shared',
    JSON.stringify(alex2.f) === JSON.stringify(['Alex Kim', 'Kestrel Partners', 'Partner']) && alex2.warn.includes('More than one person in this email is named Alex Kim'), JSON.stringify(alex2))
  await page.setValue('#paste-email-ai-person', '2')
  const jamie = await page.eval('return { f: ["#paste-email-name","#paste-email-company","#paste-email-role"].map(s=>document.querySelector(s).value), warn: !!document.querySelector("[data-testid=paste-email-ambiguous-name]") }')
  check('SHARED employer: Jamie keeps Goldman Sachs (Alex Kim also has it), with no warning',
    JSON.stringify(jamie.f) === JSON.stringify(['Jamie Fox', 'Goldman Sachs', 'Analyst']) && jamie.warn === false, JSON.stringify(jamie))
  await page.setValue('#paste-email-address', 'jamie@goldman.example')
  await page.click('Save', { byText: true, within: '[role=dialog]' })
  await page.waitFor('document.body.innerText.includes("Saved: the new contact and the interaction.")', 10000, 'saved')
  const saved4b = one(`SELECT name||'|'||coalesce(company,'')||'|'||coalesce(role,'')||'|'||coalesce(email,'')||'|'||coalesce(array_to_string(tags,','),'')||'|'||coalesce(relationship_note,'') FROM public.contacts WHERE user_id='${A}' AND name='Jamie Fox'`)
  check('saved: Jamie Fox with the shared employer, her role and chosen address, and no unseen fields',
    saved4b === 'Jamie Fox|Goldman Sachs|Analyst|jamie@goldman.example||' && counts().contacts === before4b.contacts + 1, saved4b)
  await page.click('Close', { byText: true, within: '[role=dialog]' })

  // ══ 4c. the Elena signature: the model quotes ONLY the title line ════════════
  // One possible cause of the 2026-10-14 live blank fields (that request's cause is unverified).
  console.log('4c. a title-only quote directly beneath the name line is attributed; nothing is saved')
  await openDrawerOn(`${GW}/contacts`)
  const ELENA_TITLE = 'Senior Consultant, Brightline Advisory'
  setFake(PEOPLE([{ name: 'Elena Ruiz', company: 'Brightline Advisory', company_evidence: ELENA_TITLE, role: 'Senior Consultant', role_evidence: ELENA_TITLE }]),
    NOTE_OK('Elena offered to send the case-study prep guide by Friday.'))
  const before4c = counts(); const log4c = gwLog.length
  await draftFrom([
    'From: Elena Ruiz <elena.ruiz@example.com>', 'To: You <you@example.org>', 'Date: Wed, 14 Oct 2026 10:15:00 -0400',
    'Subject: Great meeting you', '', 'Hi,', '',
    "It was great meeting you at the alumni panel yesterday. As promised, I'll send you the case-study prep guide by Friday, and I'm happy to do a mock interview with you before the end of the month. Could you send me your resume first?",
    '', 'Best,', 'Elena Ruiz', ELENA_TITLE, MARK,
  ].join(NL))
  await toReview()
  await page.click('A new contact', { byText: true, within: '[role=dialog]' })
  await page.setValue('#paste-email-ai-person', '0')
  const elena = await page.eval('return ["#paste-email-name","#paste-email-company","#paste-email-role"].map(s=>document.querySelector(s).value)')
  check('Elena: the title line under her name fills company and role', JSON.stringify(elena) === JSON.stringify(['Elena Ruiz', 'Brightline Advisory', 'Senior Consultant']), JSON.stringify(elena))
  await page.click('Cancel', { byText: true, within: '[role=dialog]' })
  check('nothing was saved', tableWritesSince(log4c).length === 0 && JSON.stringify(counts()) === JSON.stringify(before4c))

  // ══ 5. double submission ══════════════════════════════════════════════════
  console.log('5. double submission creates no extra records')
  await openDrawerOn(`${GW}/contacts`)
  const LENA_EV = `Lena Ortiz, Product Manager at Harbor Labs, here - good to meet you. ${MARK}`
  setFake(PEOPLE([{ name: 'Lena Ortiz', company: 'Harbor Labs', company_evidence: LENA_EV, role: 'Product Manager', role_evidence: LENA_EV }]), NOTE_OK('Lena introduced herself.'))
  const before5 = counts(); const log5 = gwLog.length
  await draftFrom(LENA)
  await toReview()
  check('an ISO date header is prefilled as written', (await page.eval('return document.querySelector("#paste-email-date").value')) === '2026-10-12')
  await page.click('A new contact', { byText: true, within: '[role=dialog]' })
  await page.setValue('#paste-email-ai-person', '0')
  faults.slowContactInsertMs = 1500
  const box5 = await page.click('Save', { byText: true, within: '[role=dialog]' })
  await sleep(150); await page.mouse(box5); await sleep(150); await page.mouse(box5)
  await page.eval('[...document.querySelectorAll("[role=dialog] button")].find(b=>/^Sav/.test(b.innerText.trim()))?.click(); return true')
  await page.waitFor('document.body.innerText.includes("Saved: the new contact and the interaction.")', 10000, 'saved')
  faults.slowContactInsertMs = 0
  const after5 = counts()
  check('three extra clicks while saving made no extra records (exactly +1 contact, +1 interaction)',
    after5.contacts === before5.contacts + 1 && after5.interactions === before5.interactions + 1, JSON.stringify({ before5, after5 }))
  check('and exactly one insert of each reached the database path',
    tableWritesSince(log5).map((e) => `${e.method} ${e.path}`).join(',') === 'POST /rest/v1/contacts,POST /rest/v1/interactions', JSON.stringify(tableWritesSince(log5)))
  await page.click('Close', { byText: true, within: '[role=dialog]' })

  // ══ 6. Cancel and Escape clear the paste ══════════════════════════════════
  console.log('6. Cancel and Escape clear the raw paste')
  const before6 = counts(); const log6 = gwLog.length
  await openDrawerOn(`${GW}/contacts`)
  await page.paste('#paste-email-text', SINGLE)
  await page.click('Cancel', { byText: true, within: '[role=dialog]' })
  check('Cancel closes the drawer', !(await page.eval('return !!document.querySelector("[role=dialog]")')))
  check('after Cancel the paste is nowhere in the page or browser storage', !(await page.eval(DOM_HAS(MARK))) && !(await page.eval(STORAGE_HAS(MARK))))
  await page.click('button[title="Paste an email (Pro)"]')
  check('reopening starts empty', (await page.eval('return document.querySelector("#paste-email-text").value')) === '')
  await page.paste('#paste-email-text', SINGLE)
  await page.escape()
  check('Escape closes the drawer', !(await page.eval('return !!document.querySelector("[role=dialog]")')))
  check('after Escape the paste is nowhere in the page or browser storage', !(await page.eval(DOM_HAS(MARK))) && !(await page.eval(STORAGE_HAS(MARK))))
  setFake(PEOPLE([{ name: 'Priya Shah' }]), NOTE_OK('A note.'))
  await page.click('button[title="Paste an email (Pro)"]')
  await draftFrom(SINGLE); await toReview()
  await page.escape()
  check('Escape from the REVIEW step closes it too, leaving no trace of the paste', !(await page.eval('return !!document.querySelector("[role=dialog]")')) && !(await page.eval(DOM_HAS(MARK))))
  check('nothing was written by any of this', tableWritesSince(log6).length === 0 && JSON.stringify(counts()) === JSON.stringify(before6))

  // ══ 7. failures give a retry path and save nothing ════════════════════════
  console.log('7. failed and partial drafts: understandable, retryable, nothing saved silently')
  const before7 = counts(); const log7 = gwLog.length
  await openDrawerOn(`${GW}/contacts`)
  setFake({ status: 500 }, { status: 500 })
  await draftFrom(SINGLE)
  await page.waitFor('document.querySelector("[data-testid=paste-email-error]")', 30000, 'the drafting error')
  check('both halves failing shows a plain retry message', (await page.eval('return document.querySelector("[data-testid=paste-email-error]").innerText')).includes('could not draft anything from this email. Try again'))
  check('the paste is KEPT so the reviewer can retry', (await page.eval('return document.querySelector("#paste-email-text").value')).includes(MARK))
  setFake({ text: 'not json at all' }, { value: { result: 'interaction_draft' } })
  await page.click('Draft from email', { byText: true, within: '[role=dialog]' })
  await page.waitFor('document.querySelector("[data-testid=paste-email-error]")?.innerText.includes("could not draft")', 30000, 'the invalid-output error')
  check('unparseable and invalid model output is refused, not shown', !(await dlgText()).includes('Who is this email with?'))
  setFake(PEOPLE([{ name: 'Priya Shah' }]), { value: { result: 'interaction_draft', summary: 'x', extra_field: true } })
  await page.click('Draft from email', { byText: true, within: '[role=dialog]' })
  await toReview()
  const n7 = await page.eval('return document.querySelector("[data-testid=paste-email-notices]")?.innerText ?? ""')
  check('a half that failed validation is named in the review, not silently empty', n7.includes('could not draft the note'), n7)
  check('the invalid note did not reach the editor', (await page.eval('return document.querySelector("#paste-email-notes").value')) === '')
  await page.click('Back to email', { byText: true, within: '[role=dialog]' })
  check('Back to email returns to the kept paste', (await page.eval('return document.querySelector("#paste-email-text")?.value ?? ""')).includes(MARK))
  check('nothing was saved by any failed or partial draft', tableWritesSince(log7).length === 0 && JSON.stringify(counts()) === JSON.stringify(before7))
  await page.click('Cancel', { byText: true, within: '[role=dialog]' })

  // ══ 8. minimization refusal before any model call ═════════════════════════
  console.log('8. minimization refusal: a token in the paste is refused with no model call')
  await openDrawerOn(`${GW}/contacts`)
  const fake8 = fakeCalls.length
  setFake(PEOPLE([{ name: 'Priya Shah' }]), NOTE_OK('should never be requested'))
  await draftFrom(SINGLE + NL + 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789')
  await page.waitFor('document.querySelector("[data-testid=paste-email-error]")', 15000, 'the refusal')
  check('the reviewer is told what to remove', (await page.eval('return document.querySelector("[data-testid=paste-email-error]").innerText')).includes('access token'))
  check('the model was NOT called', fakeCalls.length === fake8)
  const refusal = gwLog.filter((e) => e.path === '/functions/v1/ai-paste-email').at(-1)
  check('the function answered 422', refusal?.status === 422, JSON.stringify(refusal))
  await page.click('Cancel', { byText: true, within: '[role=dialog]' })

  // ══ 9. input bounds ═══════════════════════════════════════════════════════
  console.log('9. input bounds')
  await openDrawerOn(`${GW}/contacts`)
  await page.paste('#paste-email-text', 'x'.repeat(12001))
  const bound9 = await page.eval('return { len: document.querySelector("#paste-email-text").value.length, count: document.querySelector("[data-testid=paste-email-count]").innerText, disabled: [...document.querySelectorAll("[role=dialog] button")].find(b=>b.innerText.includes("Draft from email")).disabled }')
  check('an over-long paste is kept whole (not silently cut), flagged, and cannot be sent', bound9.len === 12001 && bound9.count.includes('too long') && bound9.disabled === true, JSON.stringify(bound9))
  await page.click('Cancel', { byText: true, within: '[role=dialog]' })
  const tokenFor = async (u) => (await (await fetch(`${GW}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON_KEY }, body: JSON.stringify(u),
  })).json()).access_token
  const proToken = await tokenFor(PRO)
  const call = (token, body, raw = false) => fetch(`${GW}/functions/v1/ai-paste-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ? body : JSON.stringify(body),
  })
  const fake9 = fakeCalls.length
  const r1 = await call(proToken, { text: 'x'.repeat(12001) })
  const r2 = await call(proToken, { text: 42 })
  const r3 = await call(proToken, { text: '   ' })
  const r4 = await call(proToken, 'x'.repeat(12000 * 6 + 2000), true)
  const r5 = await call(proToken, '{not json', true)
  const codes9 = [r1, r2, r3, r4, r5].map((r) => r.status)
  check('API: 12,001 chars -> 413, non-text -> 400, blank -> 400, oversized body -> 413, bad JSON -> 400',
    JSON.stringify(codes9) === JSON.stringify([413, 400, 400, 413, 400]), JSON.stringify(codes9))
  check('none of those reached the model', fakeCalls.length === fake9)

  // ══ 10. server-side Pro and authentication ════════════════════════════════
  console.log('10. Pro and authentication are enforced by the server')
  const freeToken = await tokenFor(FREE)
  const fake10 = fakeCalls.length
  const rFree = await call(freeToken, { text: SINGLE })
  check('a signed-in NON-Pro user gets 403 pro_required from the function', rFree.status === 403 && (await rFree.json()).code === 'pro_required')
  check('and the model was not called', fakeCalls.length === fake10)
  const rNone = await call(null, { text: SINGLE })
  const forged = mintJwt({ sub: A, role: 'authenticated', aud: 'authenticated' }, 'not-the-project-secret')
  const rForged = await call(forged, { text: SINGLE })
  check('no token or a forged token is refused at the gateway (verify_jwt) with 401', rNone.status === 401 && rForged.status === 401)
  const direct = await fetch(`http://127.0.0.1:${P.edge}/functions/v1/ai-paste-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${forged}` }, body: JSON.stringify({ text: SINGLE }),
  })
  check('bypassing the gateway, the FUNCTION itself refuses a forged token (GoTrue getUser) with 401', direct.status === 401 && (await direct.json()).code === 'not_authenticated')
  check('none of these reached the model', fakeCalls.length === fake10)
  await page.eval('localStorage.clear(); sessionStorage.clear(); return true')
  await signIn(FREE)
  await page.goto(`${GW}/contacts`)
  await page.waitFor('document.body.innerText.includes("Contacts")', 15000, 'Contacts as the free user')
  await sleep(1500)
  check('the non-Pro user sees no "Paste email" button', !(await page.eval('return !!document.querySelector(\'button[title="Paste an email (Pro)"]\')')))

  // ══ 10b. subscription-based Pro (PR #24's policy: active and past_due grant) ══
  console.log('10b. subscriptions: granted statuses are admitted; others and foreign rows are refused before the model')
  const mk = async (label) => { const u = { email: `${label}@example.test`, password: randomBytes(12).toString('hex') }; return { ...u, id: (await admin(u)).id } }
  const SUB = await mk('sub-active'), PD = await mk('sub-past-due'), CAN = await mk('sub-canceled'), TRI = await mk('sub-trialing'), FOREIGN = await mk('no-own-sub')
  const subUsers = [SUB, PD, CAN, TRI, FOREIGN]
  // Every one is Pro ONLY through a subscription, if at all: no permanent flag, trial expired.
  psql(`UPDATE public.pro_trials SET started_at = now() - interval '10 days', ends_at = now() - interval '3 days' WHERE user_id IN (${subUsers.map((u) => `'${u.id}'`).join(',')});
        UPDATE public.profiles SET ai_enabled = false WHERE id IN (${subUsers.map((u) => `'${u.id}'`).join(',')});
        INSERT INTO public.subscriptions (user_id, stripe_customer_id, status, current_period_end, cancel_at_period_end) VALUES
          ('${SUB.id}', 'cus_fixture_1', 'active', now() + interval '20 days', false),
          ('${PD.id}',  'cus_fixture_2', 'past_due', now() + interval '20 days', false),
          ('${CAN.id}', 'cus_fixture_3', 'canceled', now() - interval '1 day', true),
          ('${TRI.id}', 'cus_fixture_4', 'trialing', now() + interval '20 days', false);`)
  check('fixtures: four subscription rows, and FOREIGN has none of its own while another user is active',
    one(`SELECT count(*) FROM public.subscriptions WHERE user_id IN (${subUsers.map((u) => `'${u.id}'`).join(',')})`) === '4'
      && one(`SELECT count(*) FROM public.subscriptions WHERE user_id = '${FOREIGN.id}'`) === '0')
  const rpcFor = async (u) => {
    const t = await tokenFor(u)
    const r = await fetch(`${GW}/rest/v1/rpc/get_my_pro_access_status`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: '{}' })
    return { token: t, status: await r.json() }
  }
  setFake(PEOPLE([{ name: 'Priya Shah' }]), NOTE_OK('A note.'))
  for (const [u, label, admitted] of [[SUB, 'active', true], [PD, 'past_due', true], [CAN, 'canceled', false], [TRI, 'trialing', false], [FOREIGN, 'no own row (another user is active)', false]]) {
    const { token, status } = await rpcFor(u)
    const before = fakeCalls.length
    const r = await call(token, { text: SINGLE })
    const body = await r.json()
    const modelCalls = fakeCalls.length - before
    check(`subscription ${label}: the database says can_use_pro=${status.can_use_pro}, and the function ${admitted ? 'ADMITS (200, model called)' : 'REFUSES (403 pro_required, no model call)'}`,
      status.can_use_pro === admitted && (admitted ? (r.status === 200 && body.code === 'ok' && modelCalls === 2) : (r.status === 403 && body.code === 'pro_required' && modelCalls === 0)),
      JSON.stringify({ can_use_pro: status.can_use_pro, http: r.status, code: body.code, modelCalls }))
  }
  await page.eval('localStorage.clear(); sessionStorage.clear(); return true')
  await signIn(SUB)
  await page.goto(`${GW}/contacts`)
  await page.waitFor("document.querySelector('button[title=\"Paste an email (Pro)\"]')", 20000, 'Paste email for the subscriber')
  check('the subscription-only user SEES "Paste email" (browser and server agree)', true)
  await page.goto(`${GW}/settings`)
  await page.waitFor('document.body.innerText.includes("Funnl Pro")', 20000, 'the Pro line in Settings')
  check('Settings labels the subscriber correctly', await page.eval('return document.body.innerText.includes("Funnl Pro · subscription")'))
  await page.eval('localStorage.clear(); sessionStorage.clear(); return true')
  await signIn(CAN)
  await page.goto(`${GW}/contacts`)
  await page.waitFor('document.body.innerText.includes("Contacts")', 15000, 'Contacts as the canceled user')
  await sleep(1500)
  check('the canceled subscriber sees no "Paste email" button', !(await page.eval("return !!document.querySelector('button[title=\"Paste an email (Pro)\"]')")))

  // ══ 11. what the model received, and what the logs hold ═══════════════════
  console.log('11. the model saw no addresses; no log holds the paste or the model output')
  const addresses = ['priya.shah@goldman.example', 'me@school.example', 'marcus.bell@northwind.example', 'dana@kestrel.example', 'sam@club.example', 'lena@harbor.example']
  const sentRaw = fakeCalls.map((c) => c.raw.toLowerCase()).join(NL)
  check('no request to the model contained any address from the pastes', addresses.every((a) => !sentRaw.includes(a)) && !sentRaw.includes('@goldman') && !sentRaw.includes('@northwind'))
  check('every request carried the untrusted-content markers and the API key header', fakeCalls.every((c) => c.raw.includes('=== BEGIN UNTRUSTED EMAIL CONTENT ===') && c.hasKey))
  const edgeLogs = spawnSync('docker', ['logs', EDGE], { encoding: 'utf8' })
  const logs = `${edgeLogs.stdout}${edgeLogs.stderr}`
  const pasteLines = logs.split(NL).filter((l) => l.includes('paste_email'))
  check('the function logged its outcomes', pasteLines.length >= 8, `lines: ${pasteLines.length}`)
  const leaks = [MARK, SUMMARY_MARK, 'Marcus', 'Northwind', 'Head of Talent', 'abcdefghij', ...addresses].filter((s) => logs.includes(s))
  check('the function\u2019s logs contain no paste text, model output, name, address or token', leaks.length === 0, JSON.stringify(leaks))
  console.log('    sample log lines:')
  for (const l of [...new Set(pasteLines.map((l) => l.replace(/^.*?(paste_email)/, '$1')))].slice(0, 6)) console.log(`      ${l}`)

  console.log('\n── what was actually CLICKED or set in the browser ──')
  for (const c of clicked) console.log(`   ${c}`)
}

let harnessError = null
try {
  await main()
} catch (e) {
  harnessError = e
  failed += 1
  console.error(`\nHARNESS ERROR: ${e.message}\n${e.stack}`)
  try { const l = spawnSync('docker', ['logs', '--tail', '40', EDGE], { encoding: 'utf8' }); console.error('edge tail:', (l.stdout + l.stderr).slice(-3000)) } catch { /* none */ }
} finally {
  await teardown()
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
  if (harnessError) console.error('FAILED: the harness threw before finishing; the run proves nothing.')
  if (failed > 0 || harnessError) process.exitCode = 1
}
