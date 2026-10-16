#!/usr/bin/env node
// LOG AN INTERACTION, END TO END, IN A REAL BROWSER - desktop (1366px) and phone (390px).
//
// What is REAL here: Postgres (the project's image, every migration applied), GoTrue (users
// created through its admin API, sign-in through the app's own form), PostgREST (every read
// and write is RLS-enforced), and a production build of this checkout driven in headless
// Chrome over the DevTools Protocol with real mouse clicks and key presses.
// Not involved: any Edge Function, Anthropic, Production or any third party. Test users and
// passwords are generated per run and never printed.
//
// It checks that exactly ONE interaction form is live at each width (the desktop inline form
// or the phone sheet, never both), that keyboard focus behaves on both, that the
// "Create a follow-up" flow focuses a VISIBLE follow-up date, and that saving writes exactly
// one row with the right fields, outreach status included.
//
// RUN (from the repository root): node tests/local/log-interaction-browser.mjs [screenshot-dir]

import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { createServer as createHttp } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer as netCreateServer } from 'node:net'

const ROOT = join(import.meta.dirname, '..', '..')
const WORK = join(tmpdir(), 'funnl-log-interaction-browser')
const DIST = join(WORK, 'dist')
const SHOTS = process.argv[2] ?? null
const NET = 'funnl-logix-net', PG = 'funnl-logix-pg', AUTH = 'funnl-logix-auth', REST = 'funnl-logix-rest'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'
const AUTH_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.192.0'
const REST_IMAGE = 'public.ecr.aws/supabase/postgrest:v14.14'
const P = { rest: 54121, auth: 54122, gw: 54125 }
const GW = `http://127.0.0.1:${P.gw}`
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const JWT_SECRET = randomBytes(32).toString('hex')
const DB_PASSWORD = randomBytes(12).toString('hex')
const USER = { email: 'log-user@example.test', password: randomBytes(12).toString('hex') }

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
function startGateway () {
  const srv = createHttp(async (req, res) => {
    const path = req.url.split('?')[0]
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

// What the page looks like right now, from the browser's point of view.
const STATE = `
  const vis = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const forms = [...document.querySelectorAll('form')].filter(f => [...f.querySelectorAll('button[type=submit]')].some(b => /Save interaction|Saving/.test(b.innerText)));
  const a = document.activeElement;
  return {
    mounted: forms.length,
    visible: forms.filter(vis).length,
    sheet: !!document.querySelector('[role=dialog][aria-labelledby=log-sheet-title]'),
    activeVisible: vis(a),
    activeTag: a ? a.tagName : null,
    activeType: a ? a.getAttribute('type') : null,
    activeLabel: a && a.id ? (document.querySelector('label[for="' + a.id + '"]')?.innerText ?? null) : null,
    activeInForm: forms.some(f => f.contains(a)),
  }`

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
  console.log('\nbuilding the app (production build of this checkout)')
  execFileSync('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir'], { cwd: ROOT, stdio: 'pipe', shell: true, env: { ...process.env, VITE_SUPABASE_URL: GW, VITE_SUPABASE_ANON_KEY: ANON_KEY, VITE_POSTHOG_KEY: '' } })
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
  const ada = randomUUID(), ben = randomUUID(), cara = randomUUID()
  psql(`INSERT INTO public.contacts (id, user_id, name, company) VALUES ('${ada}','${U}','Ada Byron','Analytical Engines'), ('${ben}','${U}','Ben Okafor','Northwind'), ('${cara}','${U}','Cara Mendes','Brightline');
        INSERT INTO public.interactions (contact_id, user_id, type, interaction_date, notes) VALUES ('${ada}','${U}','Coffee chat', current_date - 7, 'First chat.');`)
  const rows = (cid) => psql(`SELECT type || '|' || coalesce(notes,'') || '|' || coalesce(follow_up_date::text,'') || '|' || coalesce(outreach_status,'') FROM public.interactions WHERE contact_id='${cid}' ORDER BY created_at`).trim().split('\n').filter(Boolean)

  const cdp = await freePort()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${join(WORK, `profile-${Date.now()}`)}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' })
  let ver = null
  for (let i = 0; i < 80 && !ver; i++) { try { const r = await fetch(`http://127.0.0.1:${cdp}/json/version`); if (r.ok) ver = await r.json() } catch { /* wait */ } if (!ver) await sleep(300) }
  if (!ver) throw new Error('Chrome devtools endpoint never came up')
  page = await Page.attach(ver.webSocketDebuggerUrl)
  await page.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' })
  await page.viewport(1366, 900)

  await page.goto(`${GW}/signin`)
  await page.waitFor('document.querySelector(\'input[type="email"]\')', 20000, 'sign-in form')
  await page.type('input[type="email"]', USER.email); await page.type('input[type="password"]', USER.password)
  await page.click('button[type="submit"]')
  await page.waitFor('!document.querySelector(\'input[type="password"]\')', 20000, 'app after sign-in')
  const state = () => page.eval(STATE)
  const openContact = async (id) => { await page.goto(`${GW}/contacts/${id}`); await page.waitFor('[...document.querySelectorAll("button")].some(b => b.getBoundingClientRect().width > 0 && /Log/.test(b.innerText))', 15000, 'contact page') }

  // ══ Desktop ══════════════════════════════════════════════════════════════
  console.log('\n1. Desktop (1366px): the inline form')
  await openContact(ada)
  await page.click('+ Log', { byText: true })
  await page.waitFor('document.querySelector("form textarea")', 5000, 'the form')
  await sleep(300)
  let s = await state()
  check('exactly one interaction form is mounted, and it is visible', s.mounted === 1 && s.visible === 1, JSON.stringify(s))
  check('the phone sheet is not mounted on desktop', !s.sheet, JSON.stringify(s))
  // Keyboard: Tab must move through the visible form.
  await page.click('form textarea')
  await page.tab()
  s = await state()
  check('Tab from Notes moves focus to the visible Follow-up date field', s.activeVisible && s.activeInForm && s.activeType === 'date', JSON.stringify(s))
  check('every field in the desktop form has a programmatic label', await page.eval(`const f=[...document.querySelectorAll('form')].find(f=>f.getBoundingClientRect().width>0 && f.querySelector('textarea'));
    return [...f.querySelectorAll('select,input,textarea')].filter(e=>e.type!=='checkbox').every(e=>e.id && document.querySelector('label[for="'+e.id+'"]'))`))
  await page.shot('01-desktop-inline-form')
  await page.escape()
  s = await state()
  check('Escape closes the desktop form (as before)', s.mounted === 0, JSON.stringify(s))
  // Save one, with outreach.
  await page.click('+ Log', { byText: true })
  await page.waitFor('document.querySelector("form textarea")', 5000, 'the form')
  await page.setValue('form select', 'Email')
  await page.click('This was outreach I sent', { byText: true })
  await page.type('form textarea', 'Desktop note.')
  await page.setValue('form input[type=date]:not([required])', '2031-01-15')
  await page.click('Save interaction', { byText: true })
  await page.waitFor('document.body.innerText.includes("Desktop note.")', 10000, 'saved row in history')
  const r1 = rows(ada)
  check('desktop save wrote exactly one row with type, note, follow-up and outreach status', r1.length === 2 && r1[1] === 'Email|Desktop note.|2031-01-15|awaiting_response', JSON.stringify(r1))

  // "Create a follow-up" from the Dashboard → picker → contact page with follow-up focus.
  console.log('2. Desktop: Create a follow-up flow focuses a visible field')
  await page.goto(`${GW}/`)
  await page.waitFor('[...document.querySelectorAll("button")].some(b => b.getBoundingClientRect().width > 0 && (b.innerText || "").includes("Create a follow-up"))', 15000, 'Dashboard quick actions')
  await page.click('Create a follow-up', { byText: true })
  await page.waitFor('document.querySelector("[role=dialog] input")', 8000, 'contact picker')
  await page.type('[role=dialog] input', 'Ben')
  await page.click('Ben Okafor', { byText: true, within: '[role=dialog]' })
  await page.waitFor('location.pathname.startsWith("/contacts/") && document.querySelector("form textarea")', 10000, 'contact page with form')
  await sleep(900)
  s = await state()
  check('the focused element is the VISIBLE follow-up date', s.activeVisible && s.activeType === 'date' && s.activeInForm, JSON.stringify(s))
  await page.shot('02-desktop-followup-focus')

  // ══ Phone ════════════════════════════════════════════════════════════════
  console.log('3. Phone (390px): the bottom sheet')
  await page.viewport(390, 844, true)
  await openContact(ben)
  await page.click('+ Log', { byText: true })
  await page.waitFor('document.querySelector("[role=dialog][aria-labelledby=log-sheet-title]")', 5000, 'the sheet')
  await sleep(300)
  s = await state()
  check('exactly one interaction form is mounted on a phone: the sheet', s.mounted === 1 && s.visible === 1 && s.sheet, JSON.stringify(s))
  check('the sheet opens with focus on Type', s.activeTag === 'SELECT' && s.activeVisible, JSON.stringify(s))
  for (let i = 0; i < 12; i++) await page.tab()
  s = await state()
  check('Tab stays trapped inside the sheet', s.activeVisible && s.activeInForm, JSON.stringify(s))
  await page.shot('03-phone-sheet')
  await page.escape()
  s = await state()
  check('Escape closes the sheet', s.mounted === 0 && !s.sheet, JSON.stringify(s))
  check('focus returns to a visible Log control', await page.eval('const a=document.activeElement; return !!a && a.getBoundingClientRect().width>0 && /Log/.test(a.innerText||"")'))
  await page.click('+ Log', { byText: true })
  await page.waitFor('document.querySelector("[role=dialog][aria-labelledby=log-sheet-title] textarea")', 5000, 'the sheet')
  await page.setValue('[role=dialog] select', 'Call')
  await page.setValue('[role=dialog] select#ls-outreach-status, [role=dialog] select[id$="outreach-status"]', 'responded')
  await page.type('[role=dialog] textarea', 'Phone note.')
  await page.click('Save interaction', { byText: true, within: '[role=dialog]' })
  await page.waitFor('document.body.innerText.includes("Phone note.") && !document.querySelector("[role=dialog][aria-labelledby=log-sheet-title]")', 10000, 'saved and closed')
  const r2 = rows(ben)
  check('phone save wrote exactly one row with type, note and outreach status', r2.length === 1 && r2[0] === 'Call|Phone note.||responded', JSON.stringify(r2))
  check('the user\u2019s interactions total 3 (no duplicate writes)', one(`SELECT count(*) FROM public.interactions WHERE user_id='${U}'`) === '3')

  // \u2550\u2550 Breakpoint change with an unsaved draft \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
  console.log('4. Unsaved draft across desktop -> phone -> desktop')
  // The draft as the VISIBLE form shows it (values only; nothing here is user data).
  const DRAFT = `
    const vis = e => !!e && e.getBoundingClientRect().width > 0;
    const f = [...document.querySelectorAll('form')].find(f => vis(f) && f.querySelector('textarea'));
    if (!f) return null;
    const q = s => f.querySelector(s);
    return {
      type: q('select').value,
      date: q('input[type=date][required]').value,
      notes: q('textarea').value,
      followUp: q('input[type=date]:not([required])').value,
      outreach: !!q('input[type=checkbox]')?.checked,
      status: q('select[aria-label="Outreach status"]')?.value ?? null,
      inSheet: !!f.closest('[role=dialog][aria-labelledby=log-sheet-title]'),
    }`
  const want = { type: 'Email', date: '2026-09-30', notes: 'Draft survives resize.', followUp: '2031-04-04', outreach: true, status: 'meeting_booked' }
  const same = (d) => !!d && Object.keys(want).every(k => d[k] === want[k])
  const bodyLock = () => page.eval('return document.body.style.overflow')

  await page.viewport(1366, 900)
  await openContact(cara)
  await page.click('+ Log', { byText: true })
  await page.waitFor('document.querySelector("form textarea")', 5000, 'the desktop form')
  await page.setValue('form select', 'Email')
  await page.click('This was outreach I sent', { byText: true })
  await page.setValue('select[aria-label="Outreach status"]', 'meeting_booked')
  await page.setValue('input[type=date][required]', '2026-09-30')
  await page.type('form textarea', 'Draft survives resize.')
  await page.setValue('input[type=date]:not([required])', '2031-04-04')
  let d = await page.eval(DRAFT)
  check('draft entered on desktop (note, date, follow-up, outreach on, status)', same(d) && !d.inSheet, JSON.stringify(d))

  await page.viewport(390, 844, true)
  await page.waitFor('document.querySelector("[role=dialog][aria-labelledby=log-sheet-title] textarea")', 5000, 'the sheet after shrinking')
  await sleep(300)
  s = await state(); d = await page.eval(DRAFT)
  check('at phone width: only the sheet is rendered', s.mounted === 1 && s.visible === 1 && s.sheet, JSON.stringify(s))
  check('at phone width: the unsaved draft is intact in the sheet', same(d) && d.inSheet, JSON.stringify(d))
  check('at phone width: the sheet locks page scroll', (await bodyLock()) === 'hidden')
  await page.shot('04-draft-after-shrink')

  await page.viewport(1366, 900)
  await page.waitFor('!document.querySelector("[role=dialog][aria-labelledby=log-sheet-title]") && document.querySelector("form textarea")', 5000, 'the inline form after widening')
  await sleep(300)
  s = await state(); d = await page.eval(DRAFT)
  check('back at desktop width: only the inline form is rendered', s.mounted === 1 && s.visible === 1 && !s.sheet, JSON.stringify(s))
  check('back at desktop width: the unsaved draft is intact', same(d) && !d.inSheet, JSON.stringify(d))
  check('back at desktop width: the scroll lock is cleared', (await bodyLock()) === '', JSON.stringify(await bodyLock()))
  await page.shot('05-draft-after-widen')

  const before = one(`SELECT count(*) FROM public.interactions WHERE user_id='${U}'`)
  await page.click('Save interaction', { byText: true })
  await page.waitFor('document.body.innerText.includes("Draft survives resize.") && !document.querySelector("form textarea")', 10000, 'saved')
  const r3 = rows(cara)
  check('saving after the resizes creates exactly one interaction with the draft\u2019s values',
    r3.length === 1 && r3[0] === 'Email|Draft survives resize.|2031-04-04|meeting_booked' &&
    one(`SELECT interaction_date::text FROM public.interactions WHERE contact_id='${cara}'`) === '2026-09-30' &&
    one(`SELECT count(*) FROM public.interactions WHERE user_id='${U}'`) === String(Number(before) + 1), JSON.stringify(r3))
  check('scroll lock still clear after saving', (await bodyLock()) === '')
}

let harnessError = null
try { await main() } catch (e) { harnessError = e; failed += 1; console.error(`\nHARNESS ERROR: ${e.message}\n${e.stack}`) } finally {
  await teardown()
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
  if (harnessError) console.error('FAILED: the harness threw before finishing; the run proves nothing.')
  if (failed > 0 || harnessError) process.exitCode = 1
}
