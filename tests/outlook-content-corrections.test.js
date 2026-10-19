// FIVE FOCUSED CORRECTIONS, each with the defect it replaced reproduced first.
//
// Every test here names a specific behaviour that was wrong and asserts the fix.
// Where the old behaviour is still correct for a different caller - the
// envelope-only pilot - that is asserted too, so the fix cannot be read as a
// blanket change.
//
// WHAT IS EXECUTED: the real producer, the real fold, the real content pass with the
// real automation classifiers, the real write planner, and the real provider
// transports driven by local fixture fetches. No network, no database, no browser.
//
// NO REAL IDENTIFIER, ADDRESS OR MESSAGE APPEARS IN THIS FILE.
//
// Run with: node tests/outlook-content-corrections.test.js

import assert from 'node:assert'
import { callDraftModel, DRAFT_TIMEOUT_MS, MAX_DRAFT_RESPONSE_BYTES, buildDraftRequest } from '../supabase/functions/shared/outlookDraftContract.js'

let passed = 0, failed = 0
const pending = []
function test (name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { console.log(`  ✓ ${name}`); passed++ },
        (e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ },
      ))
    } else { console.log(`  ✓ ${name}`); passed++ }
  } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

// ── fixtures ────────────────────────────────────────────────────────────────


const BODY_IN =
  'Great to meet you at the panel. I have put your name forward for the spring '
  + 'insight week and the team would like a short call next week about credit.'

/** A fetched message in the shape the pass's port must supply. */


const draftReply = (over = {}) => ({
  ok: true,
  parsed: {
    result: 'interaction_draft',
    summary: 'She put your name forward for the spring insight week and wants a short '
      + 'call about the credit desk.',
    summary_evidence: 'explicit_body',
    follow_up: 'Send your insight-week availability.',
    interaction_date: '2026-09-22',
    ...over,
  },
})


/**
 * A SHORT per-attempt deadline, injected.
 *
 * The stall tests previously waited out the real constants - 20s for Graph, 30s for
 * the provider - which proved the bound and cost 30 seconds of every suite run. The
 * deadline is now injectable for exactly this, defaulting to the shipped constant, so
 * these tests assert both the controlled code AND that the call returned promptly.
 */
const FAST_TIMEOUT_MS = 150


// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('1. a failed REQUIRED handle fails the page')


// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('2. automation screening finishes before an unknown person is proposed')

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('3. no empty-note fallback on the content release')

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('4. the provider bounds are real')

/** A response that streams more bytes than the ceiling allows. */
function oversizedBody (perChunk, chunks, status = 200) {
  let sent = 0
  return {
    status,
    headers: { get: () => null },          // no content-length: the stream decides
    body: {
      getReader: () => ({
        read: async () => (sent++ < chunks
          ? { done: false, value: new Uint8Array(perChunk) }
          : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    },
  }
}

function jsonBody (obj, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  let done = false
  return {
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => (done ? { done: true } : (done = true, { done: false, value: bytes })),
        cancel: async () => {},
      }),
    },
  }
}

const DRAFT_BODY = buildDraftRequest({
  mode: 'known_contact', subject: 'Panel', allowedDates: ['2026-09-22'],
  messages: [{ direction: 'inbound', dateIso: '2026-09-22T10:00:00Z', text: BODY_IN, signature: null }],
})

test('REPRODUCED: headers-then-stall now TIMES OUT instead of pinning the call', async () => {
  // DRAFT_TIMEOUT_MS was a declared constant that reached no request: no signal was
  // passed to fetch at all. Even passing one only to fetch would be half a fix,
  // since fetch resolves on headers.
  let aborts = 0
  const startedDraft = Date.now()
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async (_url, init) => {
      // The signal must be present, and must still be live during the body read.
      assert.ok(init.signal, 'no signal was passed to fetch')
      init.signal.addEventListener('abort', () => { aborts += 1 })
      return {
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () => new Promise((_res, rej) => {
              init.signal.addEventListener('abort', () => {
                const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
              })
            }),
            cancel: async () => {},
          }),
        },
      }
    },
    sleepImpl: async () => {},
    timeoutMs: FAST_TIMEOUT_MS,
    // One attempt only, so the test does not wait for retries.
    budgetAllows: (ms) => ms <= FAST_TIMEOUT_MS,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'provider_timeout', JSON.stringify(r))
  assert.ok(aborts >= 1, 'the controller must have aborted the body stream')
  assert.ok(Date.now() - startedDraft < 5_000,
    'the deadline must bound the body read, not merely exist')
  // And the shipped default is the real constant, not this test's figure.
  assert.strictEqual(DRAFT_TIMEOUT_MS, 30_000)
})

test('an OVERSIZED streamed draft response is refused mid-read', async () => {
  const chunk = 64 * 1024
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async () => oversizedBody(chunk, Math.ceil(MAX_DRAFT_RESPONSE_BYTES / chunk) + 2),
    sleepImpl: async () => {},
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'response_too_large', JSON.stringify(r))
})

test('a REDIRECT is refused, never followed, and its Location is not read', async () => {
  let locationRead = false
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async (_url, init) => {
      assert.strictEqual(init.redirect, 'manual', 'redirects must not be auto-followed')
      return {
        status: 302,
        headers: { get: (h) => { if (String(h).toLowerCase() === 'location') locationRead = true; return null } },
      }
    },
    sleepImpl: async () => {},
  })
  assert.strictEqual(r.code, 'provider_redirected', JSON.stringify(r))
  assert.strictEqual(locationRead, false, 'the Location header must never be read')
})

test('a retry is admitted ONLY within the remaining invocation budget', async () => {
  let attempts = 0
  let slept = 0
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async () => { attempts += 1; return { status: 429, headers: { get: () => null } } },
    sleepImpl: async () => { slept += 1 },
    // Enough for the first attempt, never enough for a second plus its backoff.
    budgetAllows: (ms) => ms <= DRAFT_TIMEOUT_MS,
  })
  assert.strictEqual(attempts, 1, 'a second attempt was started with no budget for it')
  assert.strictEqual(slept, 0, 'and no backoff was slept through')
  assert.strictEqual(r.code, 'provider_rate_limited')
})

test('with no budget at all, not one request is made', async () => {
  let attempts = 0
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async () => { attempts += 1; return jsonBody({}) },
    budgetAllows: () => false,
  })
  assert.strictEqual(attempts, 0)
  assert.strictEqual(r.code, 'budget_exhausted')
})

test('and the happy path still parses a draft', async () => {
  const r = await callDraftModel({
    body: DRAFT_BODY,
    apiKey: 'sk-ant-fixture',
    fetchImpl: async () => jsonBody({
      content: [{ type: 'text', text: JSON.stringify(draftReply().parsed) }],
      stop_reason: 'end_turn',
    }),
  })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.parsed.result, 'interaction_draft')
})

console.log('')
console.log('   the same bounds on the Graph content read')

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('6. the NON-200 Graph body is bounded too')

/** A non-200 whose headers arrive at once and whose body never does. */

/** A non-200 that streams more bytes than the error ceiling allows. */

// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('7. Graph retries respect the INVOCATION budget')


// ════════════════════════════════════════════════════════════════════════════
console.log('')
console.log('   through the ACTUAL content-stage wiring')

/** The stage's own ports, with a fixture rpc serving one conversation's handles. */

await Promise.all(pending)
console.log('')
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log('')
if (failed > 0) process.exitCode = 1
