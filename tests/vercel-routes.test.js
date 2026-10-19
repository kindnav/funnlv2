/**
 * vercel-routes.test.js — STATIC validation of vercel.json after the integration retirement (Stage D).
 *
 * The five branded OAuth rewrites (/api/{google,gmail,outlook}-oauth-*) pointed at Edge Functions that
 * were undeployed on 2026-10-19. This pins what the file now contains and how its rewrite rules resolve
 * a path. It is a model of the rules in this file only: it cannot prove what the hosted platform
 * returns, which is checked after deployment.
 *
 * Run with: node tests/vercel-routes.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'))

const RETIRED = ['/api/google-oauth-callback', '/api/google-oauth-start', '/api/gmail-oauth-start',
  '/api/outlook-oauth-callback', '/api/outlook-oauth-start']

// Vercel matches rewrite sources with path-to-regexp. This file only uses two forms - a literal path and
// a parenthesised regex group such as "/(.*)" - so the model supports exactly those and refuses any other
// syntax rather than guessing at it.
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
// The first rewrite whose source matches (only after no static file matched - none of these paths is a file).
const resolve = (path) => vercel.rewrites.find((r) => sourceToRegExp(r.source).test(path)) ?? null

test('the deployment setting and the file shape are unchanged: git.deploymentEnabled and rewrites only', () => {
  assert.deepStrictEqual(Object.keys(vercel).sort(), ['git', 'rewrites'])
  assert.deepStrictEqual(vercel.git, { deploymentEnabled: { main: true, '*': false } })
})

test('none of the five retired OAuth addresses has a rewrite any more', () => {
  const sources = vercel.rewrites.map((r) => r.source)
  for (const p of RETIRED) assert.ok(!sources.includes(p), `${p} is still rewritten`)
})

test('nothing in vercel.json reaches a Supabase Edge Function', () => {
  for (const r of vercel.rewrites) {
    assert.ok(!/supabase[.]co/.test(r.destination) && !r.destination.includes('/functions/v1/'), `${r.source} -> ${r.destination}`)
  }
})

test('the SPA catch-all is unchanged and is the only rewrite', () => {
  assert.deepStrictEqual(vercel.rewrites, [{ source: '/(.*)', destination: '/index.html' }])
})

test('app routes still resolve to the SPA', () => {
  for (const p of ['/', '/signin', '/signup', '/welcome', '/contacts', '/contacts/abc', '/followups', '/ai', '/settings', '/privacy', '/reset-password']) {
    assert.strictEqual(resolve(p)?.destination, '/index.html', p)
  }
})

test('MODEL RESULT: each retired /api path now falls through to the SPA catch-all (the HTML shell), not to a function', () => {
  // This is what the rules in this file do. It is NOT an API retirement response: the hosted result
  // for these paths would be the app's HTML with status 200 unless the catch-all excludes /api/.
  for (const p of RETIRED) assert.strictEqual(resolve(p)?.destination, '/index.html', p)
})

test('the model refuses syntax it does not implement', () => {
  assert.throws(() => sourceToRegExp('/api/:slug'), /unsupported/)
  assert.throws(() => sourceToRegExp('/(.*'), /unbalanced/)
  assert.ok(sourceToRegExp('/((?!api/).*)').test('/contacts') && !sourceToRegExp('/((?!api/).*)').test('/api/x'),
    'a negative-lookahead group is modelled as the regex it is')
})
