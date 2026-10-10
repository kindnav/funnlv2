// THE OWNER-RUN QUALITY CHECK, tested without invoking the provider.
//
// The helper's job is to let the owner judge the model's WRITING before any rollout, using this
// head's real builder, prompt, parser and validator over invented exchanges. This suite proves
// the parts that can be proven offline: the four exchanges are the ones that were asked for,
// each analysis function actually detects what it claims to, and the safety properties hold -
// one request per exchange, no retries, a bounded read, and a key that is never printed.
//
// Importing the module does NOT run it: it only calls main() when executed directly.
//
// Run with: node tests/outlook-note-quality-check.test.js
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  EXCHANGES, coverage, attribution, unsupportedWording, repetition, lengthReport,
  runOne, runSuite,
} from '../scripts/outlook-note-quality-check.mjs'
import { BOUNDS, buildDraftRequest, MAX_REQUEST_CHARS, assertRequestMinimization } from '../supabase/functions/shared/outlookDraftContract.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(ROOT, 'scripts/outlook-note-quality-check.mjs'), 'utf8').replace(/\r\n/g, '\n')
// Some assertions below are about the CODE, not the commentary. The script explains what it
// deliberately does NOT do - "no Supabase call", "not callDraftModel's retrying loop" - and a
// naive whole-file scan matched those very sentences. CODE strips comments first.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

let passed = 0, failed = 0
function test (name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}
// The request-path cases are asynchronous. They are queued and drained at the end so the tally
// below counts them.
const queued = []
function atest (name, fn) { queued.push([name, fn]) }

console.log('\nthe four exchanges are the ones the check needs')

test('a multi-topic existing-contact conversation, a new-person advice/offer/commitment exchange, a dates-and-open-questions exchange, and a short one', () => {
  assert.strictEqual(EXCHANGES.length, 4)
  const byId = Object.fromEntries(EXCHANGES.map((e) => [e.id, e]))
  assert.strictEqual(byId['multi-topic-existing-contact'].mode, 'known_contact')
  assert.strictEqual(byId['new-person-advice-offer-commitment'].mode, 'new_contact')
  assert.ok(byId['dates-and-unresolved-questions'])
  assert.ok(byId['short-exchange'].expectShortNote > 0, 'the short exchange declares the length it expects')
  for (const e of EXCHANGES) {
    assert.ok(e.messages.length >= 2, `${e.id} must be an EXCHANGE, not one message`)
    assert.ok(e.messages.some((m) => m.direction === 'inbound') && e.messages.some((m) => m.direction === 'outbound'),
      `${e.id} must have both sides`)
    assert.ok(e.mustMention.length >= 2 || e.id === 'short-exchange', `${e.id} must declare the facts to look for`)
    // Every declared fact must actually be stated in the exchange's own messages, or coverage
    // would be measured against a hope rather than against the source.
    const source = e.messages.map((m) => `${m.text} ${m.signature ?? ''}`).join(' ').toLowerCase()
    for (const f of e.mustMention) {
      assert.ok(f.any.some((alt) => source.includes(alt.toLowerCase())),
        `${e.id}: "${f.label}" is not stated in its own messages`)
    }
  }
})

test('the fixtures are invented and carry no address, so the privacy guard has nothing to withhold', () => {
  for (const e of EXCHANGES) {
    const text = e.messages.map((m) => `${m.text} ${m.signature ?? ''}`).join(' ')
    assert.ok(!/@/.test(text), `${e.id} must not contain an address`)
    assert.ok(!/https?:|www\./i.test(text), `${e.id} must not contain a URL`)
  }
})

test('every exchange builds a bounded request that passes the real minimization guard', () => {
  for (const e of EXCHANGES) {
    const body = buildDraftRequest({ mode: e.mode, displayName: e.displayName, subject: e.subject,
      messages: e.messages, allowedDates: e.allowedDates })
    const size = JSON.stringify(body).length
    assert.ok(size <= MAX_REQUEST_CHARS, `${e.id} serializes to ${size}`)
    const min = assertRequestMinimization(body, { addresses: ['pilot@example.test'], names: [], ids: [] })
    assert.ok(!min || min.ok !== false, `${e.id} was withheld: ${min && min.category}`)
  }
})

console.log('\neach check detects what it claims to')

test('coverage separates the facts a note mentions from the ones it dropped', () => {
  const e = EXCHANGES.find((x) => x.id === 'new-person-advice-offer-commitment')
  const good = 'Ben advised leading with one piece of work you did end to end rather than coursework. '
    + 'The summer analyst role posts on 3 November and he offered to flag the application to the '
    + 'hiring manager once a one-page summary arrives, which you committed to send by 28 October. '
    + 'He is away from 10 to 17 November.'
  const cov = coverage(good, e.mustMention)
  assert.deepStrictEqual(cov.miss, [], JSON.stringify(cov))
  const thin = 'Ben replied about the summer analyst role.'
  assert.ok(coverage(thin, e.mustMention).miss.length >= 4, 'a thin note must report its misses')
})

test('attribution catches a reversed offer or commitment', () => {
  const e = EXCHANGES.find((x) => x.id === 'multi-topic-existing-contact')
  assert.deepStrictEqual(attribution('Priya offered to put your name forward and you agreed to send a CV.', e.misattribution), [])
  const reversed = attribution('You offered to put her name forward, and she will send an updated CV.', e.misattribution)
  assert.strictEqual(reversed.length, 2, JSON.stringify(reversed))
})

test('unsupported wording surfaces words the source never used, and tolerates inflections', () => {
  const e = EXCHANGES.find((x) => x.id === 'short-exchange')
  // "helped" is in the source; "helpful" stems to the same root and must not be flagged.
  assert.ok(!unsupportedWording('She was helpful about the coffee chat.', e.messages).includes('helpful'))
  const flagged = unsupportedWording('She is the firm\'s managing director and controls hiring.', e.messages)
  for (const invented of ['managing', 'director', 'controls', 'hiring']) {
    assert.ok(flagged.includes(invented), `${invented} should be surfaced`)
  }
})

test('repetition catches a repeated sentence and a repeated phrase', () => {
  const dup = 'She offered to flag the application. She offered to flag the application.'
  const r = repetition(dup)
  assert.ok(r.sentences.length >= 1 || r.phrases.length >= 1, JSON.stringify(r))
  assert.deepStrictEqual(repetition('One clean sentence about the credit desk and nothing else.'), { sentences: [], phrases: [] })
})

test('length flags a long note on a short exchange, and anything over the bound', () => {
  const short = EXCHANGES.find((x) => x.id === 'short-exchange')
  const ok = lengthReport('You thanked Ava for the coffee chat and she asked to be kept posted.', short)
  assert.deepStrictEqual(ok.verdicts, [], JSON.stringify(ok))
  const padded = lengthReport('x'.repeat(short.expectShortNote + 1), short)
  assert.ok(padded.verdicts.some((v) => /LONG FOR A SHORT EXCHANGE/.test(v)), JSON.stringify(padded))
  const over = lengthReport('y'.repeat(BOUNDS.summary + 1), EXCHANGES[0])
  assert.ok(over.verdicts.some((v) => /OVER THE BOUND/.test(v)))
})

console.log('\nthe safety properties hold')

test('it uses THIS head\'s real builder, prompt, parser and validator - not a copy', () => {
  assert.ok(/from '\.\.\/supabase\/functions\/shared\/outlookDraftContract\.js'/.test(SRC))
  for (const fn of ['buildDraftRequest', 'buildDraftHeaders', 'assertRequestMinimization', 'parseDraftPayload', 'validateDraftResponse']) {
    assert.ok(SRC.includes(fn), `must use the real ${fn}`)
  }
  assert.ok(!/SYSTEM_CONTRACT\s*=/.test(SRC), 'it must not restate the prompt')
})

test('ONE request per exchange, no retry loop, and a bounded read', () => {
  assert.strictEqual((CODE.match(/await doFetch\(/g) || []).length, 1, 'exactly one request call site')
  // Injectable ONLY so the behavioural cases below can drive this path offline. A real
  // run passes nothing and gets the global fetch.
  assert.ok(CODE.includes("typeof fetchImpl === 'function' ? fetchImpl : fetch"),
    'the default transport is the global fetch')
  assert.ok(!/for\s*\(.*attempt|while\s*\(.*attempt|DRAFT_MAX_RETRIES|callDraftModel\(/.test(CODE), 'no retry loop and no retrying transport')
  assert.ok(/readJsonBounded\(res, MAX_PROVIDER_BODY_BYTES\)/.test(SRC), 'the response is read with the bounded reader')
  assert.ok(/redirect: 'error'/.test(SRC), 'redirects are refused, not followed')
})

test('the declared deadline reaches the request, spans the body read, and is cleared', () => {
  assert.ok(CODE.includes('DRAFT_TIMEOUT_MS'), 'the shipped constant is the default deadline')
  assert.ok(CODE.includes('new AbortController()'), 'a controller is created')
  assert.ok(CODE.includes('signal: controller.signal'), 'and its signal reaches the request')
  assert.ok(CODE.includes('clearTimeout(timer)'), 'and the timer is cleared')
  // The body read must sit INSIDE the guarded region, above the clear - a deadline that ends
  // when the headers arrive bounds nothing against a provider that trickles the body.
  const guarded = CODE.slice(CODE.indexOf('const controller ='), CODE.indexOf('clearTimeout(timer)'))
  assert.ok(guarded.includes('readJsonBounded(res, MAX_PROVIDER_BODY_BYTES)'),
    'the bounded read happens while the deadline is still live')
  assert.ok(CODE.includes('} finally {'), 'and the clear is in a finally')
})

test('the parser is handed the shape the bounded reader returns', () => {
  // This was the defect: readJsonBounded returns { ok, value } and the helper read read.json,
  // so the real parser refused every valid 200 as `malformed_response`.
  assert.ok(CODE.includes('parseDraftPayload(read.value)'), 'read.value, not read.json')
  assert.ok(!CODE.includes('read.json'), 'and read.json appears nowhere in the code')
})

test('a failure stops the run rather than sending the next request', () => {
  assert.ok(CODE.includes('STOPPED. No further requests were sent.'), 'the run says it stopped')
  assert.ok(CODE.includes('return { clean: false, stoppedAt: exchange.id, completed }'),
    'and returns instead of continuing')
  const loop = CODE.slice(CODE.indexOf('export async function runSuite'), CODE.indexOf('async function main'))
  assert.ok(!loop.includes('continue'), 'no continue-on-failure remains in the run loop')
})

test('the key is read hidden, never echoed and never logged', () => {
  assert.ok(/setRawMode\(true\)/.test(SRC), 'raw mode, so the key is not echoed')
  assert.ok(/not echoed/.test(SRC), 'and the prompt says so')
  // The key must never reach a console call, and must be cleared after use.
  for (const m of SRC.match(/console\.(log|error)\([^\n]*/g) || []) {
    assert.ok(!/apiKey/.test(m), `a console call references the key: ${m.slice(0, 60)}`)
  }
  assert.ok(/apiKey = ''/.test(SRC), 'the key is cleared when the run ends')
  assert.ok(SRC.includes('buildDraftHeaders(apiKey)'), 'it travels only in the real header builder')
})

test('a dry run exists, needs no key and makes no call; nothing is ever written or applied', () => {
  assert.ok(/--dry-run/.test(SRC) && /if \(dryRun\) return/.test(SRC))
  assert.ok(!/postgres|psql|createClient|INSERT |UPDATE |ALTER |service_role/i.test(CODE),
    'no database or Production surface in the code')
  // The only Supabase paths the code may name are the shared modules it imports.
  for (const m of CODE.match(/supabase[^'"\s]*/gi) || []) {
    assert.ok(m.startsWith('supabase/functions/shared/'), `unexpected Supabase surface: ${m}`)
  }
  assert.ok(!/writeFileSync|appendFileSync|createWriteStream/.test(SRC), 'it writes no file')
})

// -- THE REAL REQUEST PATH, driven offline with an injected fetch ----------------------------
// The scans above cannot tell whether the path WORKS, and it did not: a valid HTTP 200 was
// refused as `malformed_response` because the helper read `read.json` while the bounded reader
// returns `{ ok, value }`. Every real run would have failed on its first exchange with no note
// to judge, and a source-only suite could not see it. These cases drive runOne's own request
// path - real header builder, real bounded reader, real parser, real validator - with an
// injected fetch. No provider is called.
const KNOWN = EXCHANGES.find((e) => e.id === 'multi-topic-existing-contact')
const NEW_PERSON = EXCHANGES.find((e) => e.id === 'new-person-advice-offer-commitment')

const envelope = (payload) =>
  ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] })
const interactionReply = (e) => envelope({
  result: 'interaction_draft',
  summary: 'Priya offered to put the application in front of the programme lead before the '
    + '24 October internal deadline, and advised preparing two examples of working to a '
    + 'deadline because the first stage is competency-based.',
  summary_evidence: 'explicit_body',
  follow_up: 'Send the updated CV before the weekend.',
  interaction_date: e.allowedDates[0],
})
const suggestionReply = (e) => envelope({
  result: 'new_contact_suggestion', name: 'Ben Adeyemi',
  name_evidence: 'explicit_signature', name_confidence: 'high',
  summary: 'Ben advised leading with one piece of work taken end to end rather than coursework, '
    + 'said the summer analyst role posts on 3 November, and offered to flag the application '
    + 'once a one-page summary arrives.',
  summary_evidence: 'explicit_body',
  follow_up: 'Send the one-page summary by 28 October.',
  interaction_date: e.allowedDates[0],
})

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
// A body delivered as a stream, the way a real provider answers.
const streamed = (obj, status = 200) => ({
  status,
  headers: new Headers(),
  body: {
    getReader () {
      let sent = false
      return {
        read: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: new TextEncoder().encode(JSON.stringify(obj)) }
        },
        cancel: async () => {},
      }
    },
  },
})
// ...and one with no stream, which the bounded reader serves from .json().
const whole = (obj, status = 200) => ({ status, headers: new Headers(), body: null, json: async () => obj })

function spyFetch (handler) {
  const calls = []
  const fn = async (url, opts) => { calls.push({ url, opts }); return handler(calls.length, opts) }
  fn.calls = calls
  return fn
}
// Headers that never arrive: only the deadline ends this.
const stallHeaders = (_n, opts) => new Promise((_resolve, reject) => {
  opts.signal.addEventListener('abort', () => reject(abortError()), { once: true })
})
// Headers at once, then a body that never arrives - precisely what a deadline passed only to
// fetch would fail to bound.
const stallBody = (_n, opts) => ({
  status: 200,
  headers: new Headers(),
  body: {
    getReader: () => ({
      read: () => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(abortError()), { once: true })
      }),
      cancel: async () => {},
    }),
  },
})

atest('a valid 200 reaches the real parser and validator - known_contact', async () => {
  const f = spyFetch(() => whole(interactionReply(KNOWN)))
  const r = await runOne(KNOWN, 'test-key', { fetchImpl: f, timeoutMs: 2000 })
  assert.strictEqual(f.calls.length, 1, 'exactly one request')
  assert.strictEqual(r.kind, 'interaction_draft')
  assert.ok(r.note.includes('24 October'), `the note did not survive: ${JSON.stringify(r.note)}`)
  assert.strictEqual(r.evidence, 'explicit_body')
  assert.strictEqual(r.followUp, 'Send the updated CV before the weekend.')
  // The key travelled in the real header builder and nowhere else.
  assert.strictEqual(f.calls[0].opts.headers['x-api-key'], 'test-key')
  assert.strictEqual(f.calls[0].opts.redirect, 'error')
})

atest('a valid 200 reaches the real parser and validator - new_contact', async () => {
  const f = spyFetch(() => whole(suggestionReply(NEW_PERSON)))
  const r = await runOne(NEW_PERSON, 'test-key', { fetchImpl: f, timeoutMs: 2000 })
  assert.strictEqual(r.kind, 'new_contact_suggestion')
  assert.strictEqual(r.name, 'Ben Adeyemi', 'the proposed name reaches the report')
  assert.ok(r.note.includes('3 November'))
})

atest('a streamed body - what a real provider sends - is read and parsed', async () => {
  const f = spyFetch(() => streamed(interactionReply(KNOWN)))
  const r = await runOne(KNOWN, 'test-key', { fetchImpl: f, timeoutMs: 2000 })
  assert.ok(r.note && r.note.length > 100, 'the streamed note parsed and validated')
})

atest('headers that never arrive are aborted at the deadline', async () => {
  const f = spyFetch(stallHeaders)
  const started = Date.now()
  await assert.rejects(
    () => runOne(KNOWN, 'test-key', { fetchImpl: f, timeoutMs: 60 }),
    (e) => /no response within 60ms/.test(e.message),
    'a silent provider must not hang the run',
  )
  assert.ok(Date.now() - started < 5000, 'it ended at the deadline, not on its own')
})

atest('a body that never arrives is aborted too - the deadline spans the read', async () => {
  const f = spyFetch(stallBody)
  await assert.rejects(
    () => runOne(KNOWN, 'test-key', { fetchImpl: f, timeoutMs: 60 }),
    (e) => /response body stalled past 60ms/.test(e.message),
    'the controller must still be live during readJsonBounded',
  )
})

atest('a finished exchange leaves no pending abort behind', async () => {
  const f = spyFetch(() => whole(interactionReply(KNOWN)))
  const r = await runOne(KNOWN, 'test-key', { fetchImpl: f, timeoutMs: 40 })
  assert.ok(r.note, 'it succeeded')
  // If the timer were not cleared in `finally`, it would fire after the deadline elapsed.
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.strictEqual(f.calls[0].opts.signal.aborted, false, 'the timer was cleared')
})

atest('a transport failure stops the run: no further request is sent', async () => {
  const f = spyFetch(() => { throw new Error('socket closed') })
  const out = await runSuite({ apiKey: 'test-key', fetchImpl: f, timeoutMs: 2000, reportFn: () => true })
  assert.strictEqual(f.calls.length, 1, `a second request was sent after a failure (${f.calls.length} total)`)
  assert.strictEqual(out.stoppedAt, EXCHANGES[0].id)
  assert.strictEqual(out.clean, false)
  assert.strictEqual(out.completed, 0)
})

atest('an HTTP failure stops the run, and the status is not taken for a body', async () => {
  const f = spyFetch(() => whole({ error: { message: 'overloaded' } }, 529))
  const out = await runSuite({ apiKey: 'test-key', fetchImpl: f, timeoutMs: 2000, reportFn: () => true })
  assert.strictEqual(f.calls.length, 1)
  assert.strictEqual(out.stoppedAt, EXCHANGES[0].id)
})

atest('a parser failure stops the run', async () => {
  const f = spyFetch(() => whole({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }))
  const out = await runSuite({ apiKey: 'test-key', fetchImpl: f, timeoutMs: 2000, reportFn: () => true })
  assert.strictEqual(f.calls.length, 1)
  assert.strictEqual(out.clean, false)
})

atest('a validator failure stops the run', async () => {
  // A note over the field bound: parsed, then refused by the real validator.
  const f = spyFetch(() => envelopeOversized())
  const out = await runSuite({ apiKey: 'test-key', fetchImpl: f, timeoutMs: 2000, reportFn: () => true })
  assert.strictEqual(f.calls.length, 1, 'a validator refusal must stop the run too')
  assert.strictEqual(out.clean, false)
})
function envelopeOversized () {
  return whole(envelope({
    result: 'interaction_draft', summary: 'y'.repeat(BOUNDS.summary + 1),
    summary_evidence: 'explicit_body', follow_up: null,
    interaction_date: KNOWN.allowedDates[0],
  }))
}

atest('with every exchange answered, all four run and nothing stops', async () => {
  const f = spyFetch((n, opts) => {
    const e = EXCHANGES[n - 1]
    assert.ok(opts.signal, 'every request carries the deadline')
    return whole(e.mode === 'new_contact' ? suggestionReply(e) : interactionReply(e))
  })
  const out = await runSuite({ apiKey: 'test-key', fetchImpl: f, timeoutMs: 2000, reportFn: () => true })
  assert.strictEqual(f.calls.length, EXCHANGES.length, 'one request per exchange')
  assert.strictEqual(out.stoppedAt, null)
  assert.strictEqual(out.completed, EXCHANGES.length)
})

atest('a dry run sends nothing at all', async () => {
  const f = spyFetch(() => { throw new Error('a dry run must not reach the transport') })
  const out = await runSuite({ dryRun: true, fetchImpl: f, reportFn: () => true })
  assert.strictEqual(f.calls.length, 0)
  assert.strictEqual(out.completed, EXCHANGES.length)
  assert.strictEqual(out.clean, true)
})

console.log('\nthe real request path, with an injected fetch')
for (const [name, fn] of queued) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
