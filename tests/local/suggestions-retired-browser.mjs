#!/usr/bin/env node
// SUGGESTIONS IS RETIRED (Stage B), IN A REAL BROWSER - desktop (1366px) and phone (390px).
//
// What is REAL here: Postgres (the project's image, every migration applied), GoTrue (users
// created through its admin API, sign-in through the app's own form), PostgREST (every read
// is RLS-enforced), and a production build of this checkout driven in headless Chrome over the
// DevTools Protocol. The build sets VITE_OUTLOOK_REVIEW_ENABLED=true, as Production does, so
// the retirement is shown NOT to depend on that flag.
// Not involved: any Edge Function, Microsoft, Anthropic, Production or any third party. Test
// users and passwords are generated per run and never printed.
//
// It checks that no navigation entry, badge or Home entry for Suggestions exists, that
// /suggestions and /calendar-suggestions land on Home, that the rest of the app still works
// (including an accepted Outlook-sourced interaction), and that NO request reaches the
// suggestion tables or RPCs during the whole session, across one full former poll interval.
//
// RUN (from the repository root): node tests/local/suggestions-retired-browser.mjs [screenshot-dir]

import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { createServer as createHttp } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer as netCreateServer } from 'node:net'

const ROOT = join(import.meta.dirname, '..', '..')
const WORK = join(tmpdir(), 'funnl-suggestions-retired-browser')
const DIST = join(WORK, 'dist')
const SHOTS = process.argv[2] ?? null
const NET = 'funnl-sugret-net', PG = 'funnl-sugret-pg', AUTH = 'funnl-sugret-auth', REST = 'funnl-sugret-rest'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const AUTH_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.192.0'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const P = { rest: 54131, auth: 54132, gw: 54135 }
const GW = `http://127.0.0.1:${P.gw}`
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const JWT_SECRET = randomBytes(32).toString('hex')
const DB_PASSWORD = randomBytes(12).toString('hex')
const USER = { email: 'retired-user@example.test', password: randomBytes(12).toString('hex') }

let passed = 0, failed = 0
function check (name, cond, detail = '') {
  if (cond) { console.log(`  \u2713 ${name}`); passed++ } else { console.error(`  \u2717 ${name}`); if (detail) console.error(`    ${detail}`); failed++ }
}
const docker = (a) => execFileSync('docker', a, { encoding: 'utf8', stdio: 'pipe' })
const quiet = (a) => spawnSync('docker', a, { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const psql = (sql, { user = 'postgres' } = {}) => execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'], { input: sql, encoding: 'utf8', stdio: 'pipe' })
const one = (sql) => psql(sql).trim()
function waitForPg () {
  const deadline = Date.now() + 180000; let streak = 0
  while (Date.now() < deadline) {
    const r = spawnSync('docker', ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { input: 'CREATE TABLE public._p(i int); DROP TABLE public._p;', encoding: 'utf8' })
    if (r.status === 0) { if (++streak >= 3) return } else streak = 0
    spawnSync('node', ['-e', 'setTimeout(()=>{},1000)'], { stdio: 'ignore' })
  }
  throw new Error('Postgres never became stably DDL-ready')
}
async function waitHttp (url, ok, label) {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) { try { if (ok(await fetch(url))) return } catch { /* not up */ } await sleep(500) }
  throw new Error(`${label} never came up`)
}
function mintJwt (claims) {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const h = seg({ alg: 'HS256', typ: 'JWT' }), b = seg({ iat: now, exp: now + 3600, ...claims })
  return `${h}.${b}.${createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`
}
const ANON_KEY = mintJwt({ role: 'anon', iss: 'supabase' })
const SERVICE_KEY = mintJwt({ role: 'service_role', iss: 'supabase' })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' }
const gwLog = []
function startGateway () {
  const srv = createHttp(async (req, res) => {
    const path = req.url.split('?')[0]
    if (path.startsWith('/rest/v1/') || path.startsWith('/functions/v1/')) gwLog.push({ method: req.method, path })
    const chunks = []; for await (const c of req) chunks.push(c)
    let up = null
    if (path.startsWith('/auth/v1/')) up = `http://127.0.0.1:${P.auth}` + req.url.slice('/auth/v1'.length)
    else if (path.startsWith('/rest/v1/')) up = `http://127.0.0.1:${P.rest}` + req.url.slice('/rest/v1'.length)
    else if (path.startsWith('/functions/v1/')) { res.writeHead(404); return res.end('{}') }
    if (!up) {
      let file = join(DIST, path === '/' ? 'index.html' : path.replace(/^\//, ''))
      if (!existsSync(file) || path === '/') file = join(DIST, 'index.html')
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'text/html' }); return res.end(readFileSync(file))
    }
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) if (!['host', 'connection', 'content-length'].includes(k) && typeof v === 'string') headers[k] = v
    try {
      const r = await fetch(up, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
      const h = { 'Content-Type': r.headers.get('content-type') ?? 'application/json' }
      for (const k of ['content-range', 'location']) { const v = r.headers.get(k); if (v) h[k] = v }
      res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()))
    } catch (e) { res.writeHead(502); res.end(JSON.stringify({ message: e.message })) }
  })
  return new Promise((r) => srv.listen(P.gw, '0.0.0.0', () => r(srv)))
}

class Page {
  constructor (ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async attach (wsUrl) {
    const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    const p = new Page(ws)
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && p.pending.has(m.id)) { p.pending.get(m.id)(m); p.pending.delete(m.id) } }
    const { result: t } = await p.raw('Target.getTargets')
    const { result: a } = await p.raw('Target.attachToTarget', { targetId: t.targetInfos.find((x) => x.type === 'page').targetId, flatten: true })
    p.S = a.sessionId; await p.send('Runtime.enable'); await p.send('Page.enable'); return p
  }
  raw (method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`devtools timeout: ${method}`)) }, 30000)
      this.pending.set(id, (m) => { clearTimeout(timer); res(m) })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  async send (method, params = {}) { const m = await this.raw(method, params, this.S); if (m.error) throw new Error(`${method}: ${m.error.message}`); return m.result }
  async eval (expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    return r.result.value
  }
  async goto (url) { await this.send('Page.navigate', { url }); await this.waitFor('document.readyState === "complete"', 20000) }
  async waitFor (expr, ms = 15000, label = expr) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { let v = false; try { v = await this.eval(`return !!(${expr})`) } catch { /* retry */ } if (v) return; await sleep(150) }
    throw new Error(`timed out waiting for: ${label}`)
  }
  /** A real mouse click at the centre of the first VISIBLE match (by CSS, or by exact/leading text). */
  async click (target, { byText = false, within = null } = {}) {
    const root = within ? `document.querySelector(${JSON.stringify(within)})` : 'document'
    const pick = byText
      ? `(()=>{const els=[...scope.querySelectorAll('button,a,label,[role=option]')].filter(vis); return els.find(e=>(e.innerText||'').trim()===${JSON.stringify(target)}) || els.find(e=>(e.innerText||'').includes(${JSON.stringify(target)}))})()`
      : `[...scope.querySelectorAll(${JSON.stringify(target)})].find(vis)`
    const box = await this.eval(`const scope=${root}; if(!scope) return null;
      const vis=e=>{const r=e.getBoundingClientRect(); return r.width>0&&r.height>0};
      const el=${pick}; if(!el) return null; el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};`)
    if (!box) throw new Error(`no visible element for click: ${target}`)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(250)
  }
  async typeText (text) {
    for (const ch of text) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch }) }
  }
  async type (selector, text) { await this.click(selector); await this.typeText(text) }
  async key (key, code, vk, shift = false) {
    const modifiers = shift ? 8 : 0
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers })
    await sleep(200)
  }
  tab (shift = false) { return this.key('Tab', 'Tab', 9, shift) }
  escape () { return this.key('Escape', 'Escape', 27) }
  async setValue (selector, value) {
    const ok = await this.eval(`const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getBoundingClientRect().width>0); if(!el) return false;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return true`)
    if (!ok) throw new Error(`no visible element to set: ${selector}`)
    await sleep(200)
  }
  async viewport (width, height, mobile = false) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await sleep(300) }
  async shot (name) {
    if (!SHOTS) return
    await sleep(350)
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
  }
}

let chrome = null, gw = null, page = null
async function teardown () {
  if (page) { try { await Promise.race([page.raw('Browser.close'), sleep(4000)]) } catch { /* gone */ } try { page.ws.close() } catch { /* closed */ } }
  if (chrome) {
    const deadline = Date.now() + 8000
    while (chrome.exitCode === null && chrome.signalCode === null && Date.now() < deadline) await sleep(150)
    if (chrome.exitCode === null && chrome.signalCode === null) { try { chrome.kill() } catch { /* ignore */ } await sleep(500) }
  }
  try { gw?.close() } catch { /* ignore */ }
  for (const c of [REST, AUTH, PG]) quiet(['rm', '-f', c])
  quiet(['network', 'rm', NET])
  try { for (const p of readdirSync(WORK)) if (p.startsWith('profile-')) rmSync(join(WORK, p), { recursive: true, force: true }) } catch { /* none */ }
}
async function freePort () {
  const srv = netCreateServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port; await new Promise((r) => srv.close(r)); return port
}
async function main () {
  mkdirSync(WORK, { recursive: true }); if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  await teardown()
  console.log('\nbuilding the app (production build of this checkout, Suggestions build flag ON as in Production)')
  execFileSync('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir'], { cwd: ROOT, stdio: 'pipe', shell: true, env: { ...process.env, VITE_SUPABASE_URL: GW, VITE_SUPABASE_ANON_KEY: ANON_KEY, VITE_POSTHOG_KEY: '', VITE_OUTLOOK_REVIEW_ENABLED: 'true' } })
  console.log('standing up Postgres + GoTrue + PostgREST')
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET, '-e', `POSTGRES_PASSWORD=${DB_PASSWORD}`, PG_IMAGE])
  waitForPg()
  psql(`ALTER ROLE supabase_auth_admin WITH PASSWORD '${DB_PASSWORD}'; ALTER ROLE authenticator WITH PASSWORD '${DB_PASSWORD}';`, { user: 'supabase_admin' })
  docker(['run', '-d', '--name', AUTH, '--network', NET, '-p', `${P.auth}:9999`, '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'GOTRUE_API_PORT=9999',
    '-e', `API_EXTERNAL_URL=${GW}/auth/v1`, '-e', 'GOTRUE_DB_DRIVER=postgres', '-e', `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', `GOTRUE_SITE_URL=${GW}`, '-e', `GOTRUE_JWT_SECRET=${JWT_SECRET}`, '-e', 'GOTRUE_JWT_EXP=3600', '-e', 'GOTRUE_JWT_AUD=authenticated',
    '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated', '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role', '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
    '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true', '-e', 'GOTRUE_DISABLE_SIGNUP=false', AUTH_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.auth}/health`, (r) => r.ok, 'GoTrue')
  const migrations = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
  for (const m of migrations) psql(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'))
  console.log(`  applied ${migrations.length} migrations after GoTrue's own`)
  docker(['run', '-d', '--name', REST, '--network', NET, '-p', `${P.rest}:3000`, '-e', `PGRST_DB_URI=postgres://authenticator:${DB_PASSWORD}@${PG}:5432/postgres`,
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`, REST_IMAGE])
  await waitHttp(`http://127.0.0.1:${P.rest}/`, (r) => r.status < 500, 'PostgREST')
  gw = await startGateway()

  const created = await fetch(`http://127.0.0.1:${P.auth}/admin/users`, { method: 'POST', headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...USER, email_confirm: true }) }).then((r) => r.json())
  const U = created.id
  check('user created by the real GoTrue', /^[0-9a-f-]{36}$/.test(U))
  psql(`UPDATE public.profiles SET activation_five_contacts_at = now(), activation_first_interaction_at = now(), activation_first_followup_at = now(), activation_completed_at = now() - interval '2 days' WHERE id = '${U}';`)
  const ada = randomUUID()
  psql(`INSERT INTO public.contacts (id, user_id, name, company) VALUES ('${ada}','${U}','Ada Byron','Analytical Engines');
        INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes, source, follow_up_date) VALUES ('${ada}','${U}','Email', current_date - 3, 'Accepted earlier from a suggestion.', 'outlook', current_date - 1);`)

  const cdp = await freePort()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${join(WORK, `profile-${Date.now()}`)}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' })
  let ver = null
  for (let i = 0; i < 80 && !ver; i++) { try { const r = await fetch(`http://127.0.0.1:${cdp}/json/version`); if (r.ok) ver = await r.json() } catch { /* wait */ } if (!ver) await sleep(300) }
  if (!ver) throw new Error('Chrome devtools endpoint never came up')
  page = await Page.attach(ver.webSocketDebuggerUrl)
  await page.viewport(1366, 900)

  await page.goto(`${GW}/signin`)
  await page.waitFor('document.querySelector(\'input[type="email"]\')', 20000, 'sign-in form')
  await page.type('input[type="email"]', USER.email); await page.type('input[type="password"]', USER.password)
  await page.click('button[type="submit"]')
  await page.waitFor('!document.querySelector(\'input[type="password"]\')', 20000, 'app after sign-in')
  const candidateRequests = () => gwLog.filter(e => /\/rest\/v1\/(interaction_candidates|new_contact_candidates)/.test(e.path) || /\/rest\/v1\/rpc\/[a-z_]*(candidate|suggestion)/.test(e.path))
  const visibleLinks = (sel) => page.eval(`return [...document.querySelectorAll(${JSON.stringify(sel)})].filter(a => a.getBoundingClientRect().width > 0).map(a => a.getAttribute('aria-label') || a.innerText.trim())`)

  // ══ Desktop ══════════════════════════════════════════════════════════════
  console.log('\n1. Desktop (1366px)')
  await page.goto(`${GW}/`)
  await page.waitFor('document.body.innerText.includes("Follow-ups due")', 20000, 'Home')
  const rail = await visibleLinks('a[href]')
  check('the rail has no Suggestions link', !(await page.eval('return !!document.querySelector(\'a[href="/suggestions"]\')')), JSON.stringify(rail))
  check('Home, Contacts, Follow-ups, Funnl AI and Settings are still in the rail', ['Home', 'Contacts', 'Follow-ups', 'Funnl AI', 'Settings'].every(l => rail.includes(l)), JSON.stringify(rail))
  check('no Suggestions badge', !(await page.eval('return !!document.querySelector(\'[data-testid^="suggestions-badge"]\')')))
  check('Home shows no Suggestions entry', !(await page.eval('return /suggestions? to review/i.test(document.body.innerText)')))
  check('the accepted (Outlook-sourced) interaction still shows on Home', await page.eval('return document.body.innerText.includes("Ada Byron")'))
  await page.shot('01-desktop-home')

  console.log('2. Direct Suggestions URLs')
  for (const url of ['/suggestions', '/calendar-suggestions', '/suggestions?x=1']) {
    await page.goto(`${GW}${url}`)
    let landed = true
    try { await page.waitFor('location.pathname === "/" && document.body.innerText.includes("Follow-ups due")', 15000, `redirect of ${url}`) } catch { landed = false }
    check(`${url} redirects to Home (/) and the page shows Home`, landed && (await page.eval('return location.pathname + location.search')) === '/', await page.eval('return location.pathname'))
    check(`${url} does not show the Suggestions page (no Suggestions heading)`, !(await page.eval("return [...document.querySelectorAll('h1')].some(h => /^suggestions$/i.test(h.innerText.trim()))")))
  }

  console.log('3. Other pages still work')
  await page.goto(`${GW}/contacts`)
  await page.waitFor('document.body.innerText.includes("Ada Byron")', 20000, 'Contacts')
  check('Contacts lists the contact', true)
  await page.goto(`${GW}/contacts/${ada}`)
  await page.waitFor('document.body.innerText.includes("Accepted earlier from a suggestion.")', 20000, 'contact history')
  check('the contact page shows the accepted interaction in its history', true)
  await page.goto(`${GW}/followups`)
  await page.waitFor('document.body.innerText.includes("Ada Byron")', 20000, 'Follow-ups')
  check('Follow-ups lists the due follow-up', true)
  await page.goto(`${GW}/settings`)
  await page.waitFor('/danger zone/i.test(document.body.innerText)', 20000, 'Settings')
  check('Settings renders (account deletion control present)', await page.eval('return /delete my account/i.test(document.body.innerText)'))

  // ══ Phone ════════════════════════════════════════════════════════════════
  console.log('4. Phone (390px)')
  await page.viewport(390, 844, true)
  await page.goto(`${GW}/`)
  await page.waitFor('document.body.innerText.includes("Follow-ups due")', 20000, 'Home (phone)')
  const tabs = await page.eval('return [...document.querySelectorAll("nav[aria-label=\'Main navigation\'] a, nav[aria-label=\'Main navigation\'] button")].filter(a=>a.getBoundingClientRect().width>0).map(a => a.getAttribute("aria-label"))')
  check('phone tabs have no Review/Suggestions tab', !tabs.some(t => /suggestion|review/i.test(t || '')), JSON.stringify(tabs))
  check('phone tabs: Home, Contacts, +, Follow-ups, Funnl AI', tabs.length === 5 && tabs[0] === 'Home' && tabs[1] === 'Contacts' && tabs[4] === 'Funnl AI', JSON.stringify(tabs))
  await page.shot('02-phone-home')
  await page.goto(`${GW}/suggestions`)
  let phoneLanded = true
  try { await page.waitFor('location.pathname === "/"', 15000, 'phone redirect') } catch { phoneLanded = false }
  check('phone: /suggestions redirects to Home', phoneLanded)

  // ══ No suggestion queries, including across a poll interval ════════════
  console.log('5. No Suggestions queries')
  await page.viewport(1366, 900)
  await page.goto(`${GW}/`)
  await page.waitFor('document.body.innerText.includes("Follow-ups due")', 20000, 'Home')
  await sleep(35000) // longer than the 30 s pending-count poll the badge used to run
  const reqs = candidateRequests()
  check('no request to interaction_candidates / new_contact_candidates or suggestion RPCs in the whole session', reqs.length === 0, JSON.stringify(reqs.slice(0, 5)))
  check('the session did make ordinary data requests (the log is live)', gwLog.some(e => e.path.startsWith('/rest/v1/contacts')))
}

let harnessError = null
try { await main() } catch (e) { harnessError = e; failed += 1; console.error(`\nHARNESS ERROR: ${e.message}\n${e.stack}`) } finally {
  await teardown()
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
  if (harnessError) console.error('FAILED: the harness threw before finishing; the run proves nothing.')
  if (failed > 0 || harnessError) process.exitCode = 1
}
