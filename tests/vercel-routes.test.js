/**
 * vercel-routes.test.js — STATIC checks of vercel.json after the integration retirement (Stage D).
 *
 * The five branded OAuth rewrites (/api/{google,gmail,outlook}-oauth-*) pointed at Edge Functions that
 * were undeployed on 2026-10-19 and are gone. The SPA catch-all now excludes the /api namespace, so
 * nothing in this file serves /api or /api/...: the platform's own 404 answers them.
 *
 * WHAT THIS IS NOT. The resolver below is a small model of these rules (a literal path or a
 * parenthesised regex group), checked against this file only. It is not Vercel's router. The pattern was
 * separately validated with Vercel's own routing library (@vercel/routing-utils, schema + route
 * compilation, recorded in docs/stage-d-backend-retirement.md), and the hosted response can only be
 * confirmed after a deployment.
 *
 * Run with: node tests/vercel-routes.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const vercel = JSON.parse(read('vercel.json'))

const SPA_SOURCE = '/((?!api(?:/|$)).*)'
const RETIRED = ['/api/google-oauth-callback', '/api/google-oauth-start', '/api/gmail-oauth-start',
  '/api/outlook-oauth-callback', '/api/outlook-oauth-start']
const API_NAMESPACE = ['/api', '/api/', '/api/unknown-route', '/api/nested/unknown']
const APP_PATHS = ['/', '/signin', '/signup', '/welcome', '/settings', '/privacy', '/contacts',
  '/contacts/3f2b8c1e-0000-4000-8000-000000000000', '/followups', '/ai', '/suggestions', '/apiary', '/reset-password']

// Model: a literal path, or a parenthesised regex group such as "/(.*)"; anything else is refused.
function sourceToRegExp (source) {
  let out = '^', i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '(') {
      let depth = 0, j = i
      for (; j < source.length; j++) { if (source[j] === '(') depth++; else if (source[j] === ')' && --depth === 0) break }
      if (depth !== 0) throw new Error(`unbalanced group in ${source}`)
      out += source.slice(i, j + 1); i = j + 1
    } else if (':*?+{}[]'.includes(ch)) {
      throw new Error(`unsupported source syntax "${ch}" in ${source}; extend the model before relying on it`)
    } else {
      out += /[A-Za-z0-9/_-]/.test(ch) ? ch : '[' + ch + ']'; i++
    }
  }
  return new RegExp(out + '$')
}
// Rewrite sources are matched against the path; the query string is not part of it.
const resolve = (url) => { const p = url.split('?')[0]; return vercel.rewrites.find((r) => sourceToRegExp(r.source).test(p)) ?? null }

test('the deployment setting and the file shape are unchanged: git.deploymentEnabled and rewrites only', () => {
  assert.deepStrictEqual(Object.keys(vercel).sort(), ['git', 'rewrites'])
  assert.deepStrictEqual(vercel.git, { deploymentEnabled: { main: true, '*': false } })
})

test('the only rewrite is the SPA fallback to /index.html, with /api excluded from its source', () => {
  assert.deepStrictEqual(vercel.rewrites, [{ source: SPA_SOURCE, destination: '/index.html' }])
})

test('nothing in vercel.json reaches a Supabase Edge Function', () => {
  for (const r of vercel.rewrites) {
    assert.ok(!/supabase[.]co/.test(r.destination) && !r.destination.includes('/functions/v1/'), `${r.source} -> ${r.destination}`)
  }
})

test('all five retired OAuth addresses match no rule, with or without a query string', () => {
  for (const p of RETIRED) {
    for (const url of [p, `${p}?code=x&state=y`, `${p}?x=1`]) assert.strictEqual(resolve(url), null, url)
  }
})

test('/api, /api/ and unknown /api/... paths match no rule (so the SPA never serves them)', () => {
  for (const p of [...API_NAMESPACE, '/api?x=1']) assert.strictEqual(resolve(p), null, p)
})

test('every app path still reaches the SPA, including /suggestions (an in-app redirect) and /apiary', () => {
  for (const p of APP_PATHS) assert.strictEqual(resolve(p)?.destination, '/index.html', p)
  assert.strictEqual(resolve('/contacts?tag=recruiter')?.destination, '/index.html')
})

test('built and public static files are outside the excluded namespace (the platform serves files before rewrites)', () => {
  const pub = existsSync(join(ROOT, 'public')) ? readdirSync(join(ROOT, 'public')) : []
  for (const f of pub) assert.ok(!/^api$/i.test(f), `public/${f} would sit in /api`)
  for (const p of ['/assets/index-abc123.js', '/assets/index-abc123.css', '/favicon.svg', ...pub.map((f) => '/' + f)]) {
    assert.ok(sourceToRegExp(SPA_SOURCE).test(p), `${p} must not be in the excluded /api namespace`)
  }
})

test('account deletion and paste-email call Supabase functions directly, never an /api/ address', () => {
  const settings = read('src/pages/SettingsPage.jsx'), paste = read('src/lib/pasteEmailCapture.js')
  assert.ok(settings.includes("supabase.functions.invoke('delete-account')"), 'account deletion invokes delete-account')
  assert.ok(/functions[.]invoke[(]PASTE_FUNCTION/.test(paste), 'paste-email invokes its function')
  assert.ok(/PASTE_FUNCTION = 'ai-paste-email'/.test(paste) || /PASTE_FUNCTION = "ai-paste-email"/.test(paste), 'and that function is ai-paste-email')
  const walk = (d, out = []) => {
    for (const e of readdirSync(join(ROOT, d))) {
      const p = `${d}/${e}`
      if (statSync(join(ROOT, p)).isDirectory()) walk(p, out)
      else out.push(p)
    }
    return out
  }
  for (const f of walk('src')) {
    const src = read(f)
    assert.ok(!src.includes("'/api/") && !src.includes('"/api/') && !src.includes('`/api/'), `${f} calls an /api/ address`)
  }
})

test('the model refuses syntax it does not implement', () => {
  assert.throws(() => sourceToRegExp('/api/:slug'), /unsupported/)
  assert.throws(() => sourceToRegExp('/(.*'), /unbalanced/)
})
