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
  assert.strictEqual((SRC.match(/await fetch\(/g) || []).length, 1, 'exactly one fetch call site')
  assert.ok(!/for\s*\(.*attempt|while\s*\(.*attempt|DRAFT_MAX_RETRIES|callDraftModel\(/.test(CODE), 'no retry loop and no retrying transport')
  assert.ok(/readJsonBounded\(res, MAX_PROVIDER_BODY_BYTES\)/.test(SRC), 'the response is read with the bounded reader')
  assert.ok(/redirect: 'error'/.test(SRC), 'redirects are refused, not followed')
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

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
