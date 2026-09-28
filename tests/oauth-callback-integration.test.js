// Integration test against the REAL google-oauth-callback request handler.
//
// Every other test in oauth-browser-binding.test.js exercises the exported helpers
// or a model of the callback's decision order. This one runs the actual
// supabase/functions/google-oauth-callback/index.ts under Deno and drives it over
// HTTP, so the assertion "the unbound path returns before any database call" is
// measured rather than modelled.
//
// How the database claim is measured: the container's SUPABASE_URL points at a
// local sink server, so ANY attempt by the handler to reach PostgREST is recorded.
// The unbound cases must produce zero recorded calls. A bound POSITIVE CONTROL must
// produce at least one — without it, "zero" could simply mean the sink never works.
//
// OPT-IN. This needs Docker and network access to esm.sh, which the rest of the
// suite deliberately does not, so `npm test` stays hermetic and deterministic.
// Enable it with:
//
//   FUNNL_EDGE_INTEGRATION=1 node tests/oauth-callback-integration.test.js
//
// Without the flag (or without Docker) it reports SKIPPED and exits 0.

import assert from 'assert'
import http from 'node:http'
import { once } from 'node:events'
import { execFileSync, execFile } from 'node:child_process'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const COOKIE = '__Host-fnl_oauth_bind'
const STATE = 'INTEGRATION-STATE-000000000000'
const CONTAINER = 'funnl-oauth-callback-itest'
const HANDLER_PORT = 9987
const SINK_PORT = 9988

let passed = 0, failed = 0
function check (name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++ }
  else { console.error(`  ✗ ${name}`); if (detail) console.error(`    ${detail}`); failed++ }
}

function skip (why) {
  console.log(`\nSKIPPED: ${why}`)
  console.log('  Enable with FUNNL_EDGE_INTEGRATION=1 and a running Docker daemon.')
  console.log('\n0 tests: 0 passed, 0 failed\n')
  process.exitCode = 0
}

if (process.env.FUNNL_EDGE_INTEGRATION !== '1') {
  skip('opt-in Edge integration test not enabled')
} else {
  let dockerOk = true
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }) } catch { dockerOk = false }
  if (!dockerOk) {
    skip('Docker daemon not available')
  } else {
    await run()
  }
}

async function run () {
  console.log('\nreal google-oauth-callback handler (Deno, containerised)')

  let sinkHits = []
  const sink = http.createServer((req, res) => {
    sinkHits.push(`${req.method} ${req.url.split('?')[0]}`)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end('{"message":"sink"}')
  })
  sink.listen(SINK_PORT, '0.0.0.0')
  await once(sink, 'listening')

  try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) } catch { /* not running */ }
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER,
    '-p', `${HANDLER_PORT}:8000`,
    '-v', `${join(ROOT, 'supabase', 'functions')}:/app:ro`,
    '-w', '/app',
    // Points the handler's database client at the local sink, never at Production.
    '-e', `SUPABASE_URL=http://host.docker.internal:${SINK_PORT}`,
    '-e', 'SUPABASE_SERVICE_ROLE_KEY=integration-test-not-a-real-key',
    'denoland/deno:alpine',
    'run', '--allow-net', '--allow-env', '--allow-read', 'google-oauth-callback/index.ts',
  ], { stdio: 'ignore' })

  try {
    // Wait for the handler to finish importing its dependencies and bind.
    let up = false
    for (let i = 0; i < 90 && !up; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${HANDLER_PORT}/`, { method: 'GET', redirect: 'manual' })
        up = r.status === 405            // its own POST-only guard
      } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 1000))
    }
    assert.ok(up, 'the containerised handler never started listening')
    check('the real handler rejects GET with 405 (its own method guard)', up)

    const post = async (cookie, body) => {
      sinkHits = []
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
      if (cookie) headers.Cookie = cookie
      const res = await fetch(`http://127.0.0.1:${HANDLER_PORT}/`,
        { method: 'POST', headers, body, redirect: 'manual' })
      await new Promise((r) => setTimeout(r, 1200))   // let any outbound call land
      return {
        status: res.status,
        location: res.headers.get('location'),
        setCookie: res.headers.getSetCookie?.().join(' | ') ?? res.headers.get('set-cookie'),
        hits: [...sinkHits],
      }
    }

    const form = new URLSearchParams({ state: STATE, code: 'INTEGRATION-CODE' }).toString()
    const refusal = new URLSearchParams({ state: STATE, error: 'access_denied' }).toString()

    // ── the victim's browser: no binding cookie ──────────────────────────────
    let r = await post(null, form)
    check('unbound POST returns 303', r.status === 303, `status=${r.status}`)
    check('unbound POST redirects to the canonical error page',
      String(r.location).startsWith('https://www.getfunnl.com/settings?google=error'), String(r.location))
    check('unbound POST makes ZERO database calls', r.hits.length === 0, JSON.stringify(r.hits))
    check('unbound POST clears the binding cookie',
      String(r.setCookie).includes(COOKIE) && String(r.setCookie).includes('Max-Age=0'), String(r.setCookie))

    // ── a different browser's binding ────────────────────────────────────────
    r = await post(`${COOKIE}=A-DIFFERENT-BROWSERS-STATE-00`, form)
    check('mismatched-cookie POST returns 303', r.status === 303, `status=${r.status}`)
    check('mismatched-cookie POST makes ZERO database calls', r.hits.length === 0, JSON.stringify(r.hits))

    // ── a refusal from an unbound browser is stopped at the gate too ─────────
    r = await post(null, refusal)
    check('unbound refusal makes ZERO database calls', r.hits.length === 0, JSON.stringify(r.hits))

    // ── POSITIVE CONTROL: the gate is not simply rejecting everything ────────
    r = await post(`${COOKIE}=${STATE}`, form)
    check('bound POST passes the gate and DOES reach the database',
      r.hits.length > 0 && r.hits.some((h) => h.includes('google_oauth_states')), JSON.stringify(r.hits))
    check('bound POST with an unknown state still ends in a safe redirect',
      r.status === 303, `status=${r.status}`)
  } finally {
    try { execFile('docker', ['rm', '-f', CONTAINER], () => {}) } catch { /* best effort */ }
    sink.close()
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
