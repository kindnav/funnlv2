// OWNER-RUN QUALITY CHECK for the detailed AI interaction note.
//
// WHY THIS EXISTS. Every automated test of the detailed-notes change uses a FIXTURE response,
// so it proves a detailed note survives the pipeline - never that the model writes a good one.
// That question is answerable before anything is applied, with real model calls against
// INVENTED exchanges, and this is the helper for it. The pilot mailbox is not involved and no
// Production state is touched; the owner reads the output and judges the writing.
//
// WHAT IT USES. This head's own builder, prompt, schema, response parser and independent
// validator, imported directly - not a copy, so what you judge is what the worker would send
// and accept. The transport is one deliberate `fetch` per exchange rather than
// callDraftModel's retrying loop, because a quality read wants exactly one sample per
// exchange and no retry traffic.
//
// SAFETY PROPERTIES, all deliberate:
//   * the API key is typed at a HIDDEN prompt, held in one local variable, sent only in the
//     x-api-key header, and never printed, logged, written to a file or passed as an argument;
//   * every request is size-checked against MAX_REQUEST_CHARS and run through the real
//     assertRequestMinimization before it is sent;
//   * the response is read with the bounded reader (256 KiB ceiling), then the real parser
//     and validator;
//   * NO RETRIES: one request per exchange, four in total;
//   * no mailbox, no database, no Supabase call, no pilot configuration, nothing written.
//
// USAGE
//   node scripts/outlook-note-quality-check.mjs --dry-run   # offline: builds and reports, no key, no network
//   node scripts/outlook-note-quality-check.mjs             # real model: prompts for the key, 4 requests
//
// The fixtures below are invented. No real person, company, address or message appears here.
import {
  buildDraftRequest, buildDraftHeaders, assertRequestMinimization, parseDraftPayload,
  validateDraftResponse, ANTHROPIC_MESSAGES_URL, MAX_REQUEST_CHARS, BOUNDS, DRAFT_MODEL,
  DRAFT_MAX_TOKENS, DRAFT_TIMEOUT_MS,
} from '../supabase/functions/shared/outlookDraftContract.js'
import { readJsonBounded, MAX_PROVIDER_BODY_BYTES } from '../supabase/functions/shared/boundedJson.js'

// ── the four exchanges ──────────────────────────────────────────────────────────────────────
// Each declares what its own messages state, so coverage and attribution are checked against
// the source rather than against a hope. `mustMention` lists facts with acceptable wordings;
// `misattribution` lists claims that would reverse who said or offered something.
export const EXCHANGES = Object.freeze([
  {
    id: 'multi-topic-existing-contact',
    why: 'A referral conversation covering three subjects, an offer, concrete advice, two named dates and one open question.',
    mode: 'known_contact',
    displayName: 'Priya',
    subject: 'Summer analyst process',
    messages: [
      { direction: 'inbound', dateIso: '2026-10-06T09:12:00Z', signature: 'Priya Nair, Analyst Programme Team, Harbour Street Partners',
        text: 'Good to meet you at the info session. Two things. First, the internal deadline for '
          + 'the summer cohort is 24 October, which is three weeks earlier than the public one, so '
          + 'I would get the application in before that. Second, the first stage is a competency '
          + 'call, not a technical one - the panel scores examples of working to a deadline hardest, '
          + 'so prepare two of those. On the desk question, markets suits the modelling you '
          + 'described better than coverage; coverage intake is smaller this year anyway. I am happy '
          + 'to put your name in front of the programme lead once you send a CV. One thing I need to '
          + 'check: whether you can apply for the spring insight week in parallel, or whether that '
          + 'rules you out of the summer round. I will ask and come back to you.' },
      { direction: 'outbound', dateIso: '2026-10-06T18:40:00Z', signature: null,
        text: 'This is really helpful, thank you. I will send an updated CV before the weekend and '
          + 'go with markets. I will also prepare the two deadline examples. If you can find out '
          + 'about the insight week overlap that would be great.' },
    ],
    allowedDates: ['2026-10-06'],
    mustMention: [
      { label: 'the 24 October internal deadline', any: ['24 October', 'October 24', 'internal deadline'] },
      { label: 'the competency (not technical) first stage', any: ['competency'] },
      { label: 'the advice to prepare deadline examples', any: ['deadline example', 'examples of working', 'two examples'] },
      { label: 'markets over coverage', any: ['markets'] },
      { label: 'her offer to put the name to the programme lead', any: ['programme lead', 'put your name', 'forward'] },
      { label: 'the commitment to send a CV', any: ['CV'] },
      { label: 'the unresolved insight-week overlap', any: ['insight week', 'parallel', 'overlap'] },
    ],
    misattribution: [
      { claim: 'the OFFER came from her, not from the user', mustNotMatch: /you offered to (put|introduce|flag)/i },
      { claim: 'the CV commitment is the USER\'s, not hers', mustNotMatch: /she (will|agreed to) send (an? )?(updated )?CV/i },
    ],
  },
  {
    id: 'new-person-advice-offer-commitment',
    why: 'A first exchange with someone not yet in the network, carrying advice, an offer and a commitment.',
    mode: 'new_contact',
    displayName: 'Ben Okafor',
    subject: 'Growth fund - summer analyst',
    messages: [
      { direction: 'inbound', dateIso: '2026-10-07T11:02:00Z', signature: 'Ben Okafor, Investment Team, Northfield Growth',
        text: 'Thanks for reaching out after the panel. My honest advice is not to lead with the '
          + 'coursework - everyone has it. Lead with the one piece of work you did end to end and '
          + 'can defend for twenty minutes. We post the summer analyst role on 3 November; I will '
          + 'flag your application to the hiring manager when it goes up, provided you send me a '
          + 'one-page summary of that portfolio work first. I am away from 10 to 17 November, so '
          + 'anything that needs my sign-off has to be done before I go.' },
      { direction: 'outbound', dateIso: '2026-10-07T20:15:00Z', signature: null,
        text: 'Understood, and thank you - that is clearer than anything I have been told so far. '
          + 'I will send the one-pager by 28 October so it is well before your trip.' },
    ],
    allowedDates: ['2026-10-07'],
    mustMention: [
      { label: 'the advice to lead with one defensible piece of work', any: ['end to end', 'one piece of work', 'portfolio'] },
      { label: 'the 3 November posting date', any: ['3 November', 'November 3'] },
      { label: 'his offer to flag the application', any: ['flag', 'hiring manager'] },
      { label: 'the one-pager commitment and its 28 October date', any: ['one-page', 'one-pager', '28 October'] },
      { label: 'his absence 10-17 November', any: ['10 to 17', '10-17', 'away'] },
    ],
    misattribution: [
      { claim: 'the flagging offer is HIS, not the user\'s', mustNotMatch: /you (will )?flag (the|your) application/i },
      { claim: 'the one-pager is the USER\'s commitment', mustNotMatch: /(he|ben) (will )?send(s)? the one.?pag/i },
    ],
  },
  {
    id: 'dates-and-unresolved-questions',
    why: 'Dense with named dates and explicitly open questions - the two things a 200-character note always lost.',
    mode: 'known_contact',
    displayName: 'Mara',
    subject: 'Mentoring and the spring programme',
    messages: [
      { direction: 'inbound', dateIso: '2026-10-08T08:30:00Z', signature: null,
        text: 'Three dates for you. The mentoring scheme opens 1 November and closes 15 November. '
          + 'The spring programme assessment centre is 12 February, and if you are invited you will '
          + 'hear in the first week of January. What I do not know yet: whether the mentoring scheme '
          + 'counts as an internal application - I have asked HR twice and had no answer - and '
          + 'whether you would be assigned a mentor on the credit side or whether that is random. '
          + 'I would not plan around either until we know.' },
      { direction: 'outbound', dateIso: '2026-10-08T12:05:00Z', signature: null,
        text: 'Noted on all three dates. I will put the 15 November close in my calendar and wait '
          + 'on the HR answer before deciding whether to apply to both.' },
    ],
    allowedDates: ['2026-10-08'],
    mustMention: [
      { label: 'the 1 November opening', any: ['1 November', 'November 1'] },
      { label: 'the 15 November close', any: ['15 November', 'November 15'] },
      { label: 'the 12 February assessment centre', any: ['12 February', 'February 12'] },
      { label: 'the unresolved internal-application question', any: ['internal application', 'HR'] },
      { label: 'the unresolved mentor-assignment question', any: ['mentor', 'credit'] },
    ],
    misattribution: [
      { claim: 'the open questions are HERS, not answered facts', mustNotMatch: /(mentoring scheme (does|will) count|you will be assigned a mentor on the credit)/i },
    ],
  },
  {
    id: 'short-exchange',
    why: 'Two short messages. A good note here is one or two sentences; anything long is padding.',
    mode: 'known_contact',
    displayName: 'Ava',
    subject: 'Thanks',
    messages: [
      { direction: 'outbound', dateIso: '2026-10-09T07:45:00Z', signature: null,
        text: 'Thanks again for the coffee chat yesterday - it was genuinely useful.' },
      { direction: 'inbound', dateIso: '2026-10-09T09:10:00Z', signature: null,
        text: 'Glad it helped. Keep me posted on how it goes.' },
    ],
    allowedDates: ['2026-10-09'],
    mustMention: [
      { label: 'the coffee chat', any: ['coffee'] },
      { label: 'keeping her posted', any: ['posted', 'keep her', 'update'] },
    ],
    misattribution: [],
    expectShortNote: 320,
  },
])

// ── the mechanical checks. Hints for a human read, never a score ─────────────────────────────
const STOPWORDS = new Set(('a an and are as at be been but by for from had has have he her him his i if in into is it its me my '
  + 'no not of on or our she so that the their them then there these they this to up was we were what when which who will with would you your '
  + 'about after all also any because before both can could did do does during each few how more most other out over own same some such than '
  + 'through time too under very via while' ).split(' '))

const words = (t) => String(t).toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []
const contentWords = (t) => words(t).filter((w) => !STOPWORDS.has(w))

/** Facts the note mentions, and facts it dropped. */
export function coverage (note, mustMention) {
  const low = String(note).toLowerCase()
  const hit = [], miss = []
  for (const f of mustMention) {
    (f.any.some((alt) => low.includes(alt.toLowerCase())) ? hit : miss).push(f.label)
  }
  return { hit, miss }
}

/** Claims that would reverse who said, offered or committed to something. */
export function attribution (note, misattribution) {
  return (misattribution ?? []).filter((m) => m.mustNotMatch.test(String(note))).map((m) => m.claim)
}

/**
 * Content words in the note that appear nowhere in the source messages. A HINT, not a verdict:
 * a legitimate paraphrase introduces words too. It surfaces the invented-detail risk for a
 * human to read, which is the only thing that can judge it.
 */
export function unsupportedWording (note, messages) {
  // BOTH SIDES ARE STEMMED. An earlier version stemmed only the note's words, so "helpful"
  // never matched the source's "helped" and every ordinary paraphrase produced false alarms -
  // noise that would have made the hint useless to read.
  const root = (w) => w.replace(/(ings?|ed|es|s|ly|ful|ness|ment|ions?|ive|able)$/, '')
  const sourceRoots = new Set(contentWords(messages.map((m) => `${m.text} ${m.signature ?? ''}`).join(' ')).map(root))
  const out = new Set()
  for (const w of contentWords(note)) {
    const r = root(w)
    if (sourceRoots.has(r)) continue
    // a shared root of four or more characters is the same word family, not a new claim
    if (r.length >= 4 && [...sourceRoots].some((sr) => sr.startsWith(r) || (sr.length >= 4 && r.startsWith(sr)))) continue
    out.add(w)
  }
  return [...out]
}

/** Repeated sentences and repeated six-word runs. */
export function repetition (note) {
  const sentences = String(note).split(/(?<=[.!?])\s+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 12)
  const seen = new Set(), dupSentences = new Set()
  for (const s of sentences) (seen.has(s) ? dupSentences : seen).add(s)
  const w = words(note)
  const shingles = new Set(), dupShingles = new Set()
  for (let i = 0; i + 6 <= w.length; i++) {
    const key = w.slice(i, i + 6).join(' ')
    ;(shingles.has(key) ? dupShingles : shingles).add(key)
  }
  return { sentences: [...dupSentences], phrases: [...dupShingles].slice(0, 5) }
}

/** Length, with the one band that can be judged mechanically: a short exchange must stay short. */
export function lengthReport (note, exchange) {
  const sourceChars = exchange.messages.reduce((n, m) => n + m.text.length, 0)
  const n = String(note).length
  const verdicts = []
  if (n > BOUNDS.summary) verdicts.push(`OVER THE BOUND (${n} > ${BOUNDS.summary})`)
  if (exchange.expectShortNote && n > exchange.expectShortNote) {
    verdicts.push(`LONG FOR A SHORT EXCHANGE (${n} chars from ${sourceChars} chars of source; expected under ${exchange.expectShortNote})`)
  }
  if (n > sourceChars) verdicts.push(`LONGER THAN ITS SOURCE (${n} > ${sourceChars}) - check for padding`)
  return { chars: n, sourceChars, verdicts }
}

// ── the key prompt: hidden, local, never printed ─────────────────────────────────────────────
async function readHiddenLine (prompt) {
  process.stdout.write(prompt)
  const { stdin } = process
  if (!stdin.isTTY) throw new Error('a terminal is required so the key is not echoed')
  stdin.setRawMode(true)
  stdin.resume()
  let out = ''
  await new Promise((resolve, reject) => {
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { cleanup(); resolve(); return }
        if (ch === '\u0003') { cleanup(); reject(new Error('cancelled')); return }
        if (ch === '\u007f' || ch === '\b') { out = out.slice(0, -1); continue }
        out += ch
      }
    }
    const cleanup = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n') }
    stdin.on('data', onData)
  })
  return out
}

// ── one exchange, one request ────────────────────────────────────────────────────────────────
export async function runOne (exchange, apiKey, { dryRun, fetchImpl, timeoutMs } = {}) {
  // INJECTABLE ONLY FOR TESTS. A behavioural test has to drive this real request path -
  // header builder, bounded read, parser, validator - without a provider call, and the
  // deadline has to be provable in milliseconds rather than by waiting out 30 seconds.
  // Both default to what a real run uses; the owner-facing run injects neither.
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch
  const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DRAFT_TIMEOUT_MS
  const body = buildDraftRequest({
    mode: exchange.mode, displayName: exchange.displayName, subject: exchange.subject,
    messages: exchange.messages, allowedDates: exchange.allowedDates,
  })
  const size = JSON.stringify(body).length
  if (size > MAX_REQUEST_CHARS) throw new Error(`request ${size} over the ${MAX_REQUEST_CHARS} ceiling`)
  // The real privacy guard, on the real body, before anything leaves.
  const min = assertRequestMinimization(body, {
    addresses: ['pilot@example.test'], names: [], ids: [],
  })
  if (min && min.ok === false) throw new Error(`minimization withheld the request: ${min.category ?? 'unknown'}`)

  if (dryRun) return { body, size, note: null, dry: true }

  // ONE request. No retry, no loop.
  //
  // ONE CONTROLLER FOR THE WHOLE EXCHANGE - headers AND body. The declared timeout used to
  // reach no request at all: no signal was passed, so DRAFT_TIMEOUT_MS bounded nothing and a
  // silent provider would have hung this run indefinitely. Passing it only to fetch would be
  // half a fix, because fetch settles when the HEADERS arrive - a provider that answers
  // promptly and then trickles the body forever would still pin the run. The controller
  // therefore stays alive through readJsonBounded, which aborts the underlying stream, and is
  // cleared in `finally` so a finished exchange leaves no pending timer behind.
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch { /* already gone */ } }, deadlineMs)
  let res, read
  try {
    res = await doFetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST', headers: buildDraftHeaders(apiKey), body: JSON.stringify(body),
      redirect: 'error', signal: controller.signal,
    })
    // STILL INSIDE THE DEADLINE, deliberately.
    read = await readJsonBounded(res, MAX_PROVIDER_BODY_BYTES)
  } catch (e) {
    // This script's own words. The provider's message, the response body, the request content
    // and the key never reach the output.
    const timedOut = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
    throw new Error(timedOut
      ? `no response within ${deadlineMs}ms`
      : 'the request failed before a response arrived')
  } finally {
    clearTimeout(timer)
  }
  if (!read.ok) {
    throw new Error(read.reason === 'response_body_timeout'
      ? `the response body stalled past ${deadlineMs}ms`
      : `bounded read failed: ${read.reason}`)
  }
  if (res.status !== 200) throw new Error(`provider status ${res.status}`)
  // readJsonBounded returns { ok, value }. This read `read.json` - undefined on every reply -
  // so the real parser refused every valid 200 as `malformed_response` and the check could
  // never have produced a note to judge.
  const parsed = parseDraftPayload(read.value)
  if (!parsed.ok) throw new Error(`parser refused the response: ${parsed.code}`)
  const checked = validateDraftResponse(parsed.parsed, { mode: exchange.mode, allowedDates: exchange.allowedDates })
  if (checked.ok !== true) throw new Error(`validator refused the draft: ${checked.code}`)
  if (checked.kind === 'ignore' || checked.kind === 'defer') {
    return { body, size, note: null, kind: checked.kind, stopReason: parsed.stopReason }
  }
  const draft = checked.draft ?? checked.suggestion
  return { body, size, note: draft.summary, followUp: draft.follow_up, name: draft.name ?? null,
           evidence: draft.summary_evidence, kind: checked.kind, stopReason: parsed.stopReason }
}

function report (exchange, result) {
  const line = '─'.repeat(78)
  console.log(`\n${line}\n${exchange.id}\n  ${exchange.why}\n${line}`)
  console.log('SOURCE MESSAGES')
  for (const m of exchange.messages) {
    console.log(`  [${m.direction === 'inbound' ? 'THEM' : 'YOU  '}] ${m.text}`)
    if (m.signature) console.log(`         (signature: ${m.signature})`)
  }
  console.log(`\nREQUEST  ${result.size} chars / ${MAX_REQUEST_CHARS} ceiling, model ${DRAFT_MODEL}, max_tokens ${DRAFT_MAX_TOKENS}`)
  if (result.dry) { console.log('DRY RUN  request built and minimization-checked; no provider call made'); return true }
  if (!result.note) { console.log(`RESULT   the model returned "${result.kind}" - no note to judge`); return true }

  console.log(`\nGENERATED NOTE (${result.note.length} chars, evidence ${result.evidence}${result.stopReason ? `, stop ${result.stopReason}` : ''})`)
  console.log(`  ${result.note}`)
  if (result.name) console.log(`  proposed name: ${result.name}`)
  if (result.followUp) console.log(`  next step: ${result.followUp}`)

  const cov = coverage(result.note, exchange.mustMention)
  const att = attribution(result.note, exchange.misattribution)
  const uns = unsupportedWording(result.note, exchange.messages)
  const rep = repetition(result.note)
  const len = lengthReport(result.note, exchange)

  console.log('\nCHECKS')
  console.log(`  coverage      ${cov.hit.length}/${exchange.mustMention.length} facts mentioned`)
  for (const m of cov.miss) console.log(`    MISSED      ${m}`)
  console.log(`  attribution   ${att.length === 0 ? 'no reversed attribution detected' : 'PROBLEMS:'}`)
  for (const a of att) console.log(`    REVERSED    ${a}`)
  console.log(`  length        ${len.chars} chars from ${len.sourceChars} chars of source${len.verdicts.length ? '' : ' - within expectations'}`)
  for (const v of len.verdicts) console.log(`    ${v}`)
  console.log(`  repetition    ${rep.sentences.length === 0 && rep.phrases.length === 0 ? 'none detected' : 'PROBLEMS:'}`)
  for (const d of rep.sentences) console.log(`    REPEATED SENTENCE  ${d.slice(0, 70)}`)
  for (const d of rep.phrases) console.log(`    REPEATED PHRASE    ${d}`)
  console.log(`  wording not in the source (${uns.length}) - a HINT for your read, not a verdict:`)
  if (uns.length) console.log(`    ${uns.join(', ')}`)

  return cov.miss.length === 0 && att.length === 0 && len.verdicts.length === 0
    && rep.sentences.length === 0 && rep.phrases.length === 0
}

// ── the run: every exchange, and it STOPS at the first failure ───────────────────────────────
// A transport, HTTP, read, parser or validator failure is a problem with the key, the contract
// or the provider - not with one exchange. Three further requests cannot diagnose it, so the
// run stops and says where. `reportFn` is injectable so a test can assert the stop without the
// report's output; a mechanical check FINDING is not a failure and does not stop anything,
// because the point of the run is to read all four notes.
export async function runSuite (opts = {}) {
  const { apiKey = '', dryRun = false, fetchImpl, timeoutMs } = opts
  const exchanges = Array.isArray(opts.exchanges) ? opts.exchanges : EXCHANGES
  const reportFn = typeof opts.reportFn === 'function' ? opts.reportFn : report
  let clean = true
  let completed = 0
  for (const exchange of exchanges) {
    let result
    try {
      result = await runOne(exchange, apiKey, { dryRun, fetchImpl, timeoutMs })
    } catch (e) {
      // The message is this script's own; provider bodies, request content and the key never
      // reach it.
      console.error(`\n${exchange.id}: FAILED - ${e.message}`)
      console.error('STOPPED. No further requests were sent.')
      return { clean: false, stoppedAt: exchange.id, completed }
    }
    completed++
    if (!reportFn(exchange, result)) clean = false
  }
  return { clean, stoppedAt: null, completed }
}

async function main () {
  const dryRun = process.argv.includes('--dry-run')
  console.log(dryRun
    ? 'DRY RUN: building and checking every request offline. No key is read and no provider call is made.'
    : `Real-model quality check: ${EXCHANGES.length} exchanges, ONE request each, no retries.`)
  let apiKey = ''
  if (!dryRun) {
    apiKey = (await readHiddenLine('Anthropic API key (not echoed): ')).trim()
    if (!apiKey) { console.error('no key entered; nothing was sent'); process.exit(2) }
  }
  let outcome
  try {
    outcome = await runSuite({ apiKey, dryRun })
  } finally {
    apiKey = ''
  }
  console.log(`\n${'─'.repeat(78)}`)
  if (outcome.stoppedAt) {
    console.log(`Stopped at ${outcome.stoppedAt} after ${outcome.completed} of ${EXCHANGES.length} exchanges. Nothing further was sent; fix the cause and run again.`)
  } else {
    console.log(dryRun
      ? 'Dry run complete: all four requests build, fit the ceiling and pass minimization.'
      : `Mechanical checks ${outcome.clean ? 'raised nothing' : 'raised something above'}. The writing is YOUR judgement: read each note against its source messages before approving the rollout.`)
  }
  process.exit(outcome.clean ? 0 : 1)
}

// Importable for tests without running anything.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('outlook-note-quality-check.mjs')
if (invokedDirectly) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
