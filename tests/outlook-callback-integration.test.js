// Integration test against the REAL outlook-oauth-callback request handler.
//
// The unit tests exercise exported helpers. This one runs the actual
// supabase/functions/outlook-oauth-callback/index.ts under Deno and drives it
// over HTTP, so "the unbound path returns before any database call" is measured
// rather than modelled.
//
// How the database claim is measured: the container's SUPABASE_URL points at a
// local sink server, so ANY attempt to reach PostgREST is recorded. Every case
// here must produce zero recorded calls — while dormant the handler must not
// touch the database at all, and with the flag on an unbound POST must be
// refused before any row is read.
//
// OPT-IN. Needs Docker and network access to esm.sh, which the rest of the suite
// deliberately does not, so `npm test` stays hermetic. Enable with:
//
//   FUNNL_EDGE_INTEGRATION=1 node tests/outlook-callback-integration.test.js
//
// Without the flag (or without Docker) it reports SKIPPED and exits 0.

import http from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const COOKIE = '__Host-fnl_ms_oauth_bind'
const STATE = 'INTEGRATION-OUTLOOK-STATE-0000'
const CONTAINER = 'funnl-outlook-callback-itest'
const HANDLER_PORT = 9997
const SINK_PORT = 9998

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
  if (!dockerOk) skip('Docker daemon not available')
  else await run()
}

async function startHandler (enabled) {
  try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) } catch { /* not running */ }
  const env = [
    '-e', `SUPABASE_URL=http://host.docker.internal:${SINK_PORT}`,
    '-e', 'SUPABASE_SERVICE_ROLE_KEY=integration-test-not-a-real-key',
  ]
  if (enabled) env.push('-e', 'OUTLOOK_INTEGRATION_ENABLED=true')
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER,
    '-p', `${HANDLER_PORT}:8000`,
    '-v', `${join(ROOT, 'supabase', 'functions')}:/app:ro`,
    '-w', '/app',
    ...env,
    'denoland/deno:alpine',
    'run', '--allow-net', '--allow-env', '--allow-read', 'outlook-oauth-callback/index.ts',
  ], { stdio: 'ignore' })

  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${HANDLER_PORT}/`, { method: 'GET', redirect: 'manual' })
      if (r.status === 405 || r.status === 303) return r.status
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('the containerised handler never started listening')
}

// Synchronous on purpose: an async teardown races the next `docker run` and
// fails it with "name already in use" (exit 125).
function stopHandler () {
  try { execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }) } catch { /* not running */ }
}

async function run () {
  console.log('\nreal outlook-oauth-callback handler (Deno, containerised)')

  let sinkHits = []
  const sink = http.createServer((req, res) => {
    sinkHits.push(`${req.method} ${req.url.split('?')[0]}`)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end('{"message":"sink"}')
  })
  sink.listen(SINK_PORT, '0.0.0.0')
  await once(sink, 'listening')

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

  try {
    // ── DORMANT: flag absent ────────────────────────────────────────────────
    await startHandler(false)
    let r = await post(`${COOKIE}=${STATE}`, form)
    check('dormant: even a BOUND POST makes ZERO database calls',
      r.hits.length === 0, JSON.stringify(r.hits))
    check('dormant: responds 303 to the canonical error page',
      r.status === 303 && String(r.location).startsWith('https://www.getfunnl.com/settings?outlook=error'),
      `${r.status} ${r.location}`)
    check('dormant: clears the binding cookie',
      String(r.setCookie).includes(COOKIE) && String(r.setCookie).includes('Max-Age=0'),
      String(r.setCookie))
    stopHandler()

    // ── ENABLED: the gate must still refuse an unbound browser ──────────────
    const upStatus = await startHandler(true)
    check('enabled: rejects GET with 405 (its own method guard)', upStatus === 405, `status=${upStatus}`)

    r = await post(null, form)
    check('unbound POST returns 303', r.status === 303, `status=${r.status}`)
    check('unbound POST redirects to the canonical error page',
      String(r.location).startsWith('https://www.getfunnl.com/settings?outlook=error'), String(r.location))
    check('unbound POST makes ZERO database calls', r.hits.length === 0, JSON.stringify(r.hits))
    check('unbound POST clears the binding cookie',
      String(r.setCookie).includes(COOKIE) && String(r.setCookie).includes('Max-Age=0'), String(r.setCookie))

    r = await post(`${COOKIE}=A-DIFFERENT-BROWSERS-STATE-00`, form)
    check('mismatched-cookie POST returns 303', r.status === 303, `status=${r.status}`)
    check('mismatched-cookie POST makes ZERO database calls', r.hits.length === 0, JSON.stringify(r.hits))

    r = await post(null, refusal)
    check('unbound refusal makes ZERO database calls', r.hits.length === 0, JSON.stringify(r.hits))

    // A Google binding cookie must not satisfy the Outlook gate.
    r = await post(`__Host-fnl_oauth_bind=${STATE}`, form)
    check('a GOOGLE binding cookie does not satisfy the Outlook gate',
      r.hits.length === 0, JSON.stringify(r.hits))

    // Bound, flag on: the gate passes, and this slice stops before any exchange.
    // It must still make zero database calls, because token exchange and the
    // finalize RPC are deliberately not implemented yet.
    r = await post(`${COOKIE}=${STATE}`, form)
    check('bound POST passes the gate and still ends in a safe 303',
      r.status === 303 && String(r.location).startsWith('https://www.getfunnl.com/settings?outlook=error'),
      `${r.status} ${r.location}`)
    check('bound POST makes zero database calls in this slice (exchange not implemented)',
      r.hits.length === 0, JSON.stringify(r.hits))
  } finally {
    stopHandler()
    sink.close()
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}
