// Paste an email (Pro) - the note prompt's VOICE, and only that.
//
// Run with: node tests/paste-email-note-voice.test.js
//
// A live test (2026-10-14) produced an accurate note that kept calling the owner "the user". The
// fix is wording in the paste-email note prompt alone. These checks pin that wording AND pin that
// nothing else moved: the shared Outlook contract, the schema, the untrusted-content wrapping and
// the contact-details request. There is deliberately no output validator for this: the voice is an
// instruction, not something a checker can verify.

import { strict as assert } from 'assert'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { buildNoteRequest, buildContactRequest, NOTE_VOICE } from '../supabase/functions/shared/pasteEmail.js'
import { SYSTEM_CONTRACT, interactionDraftSchema } from '../supabase/functions/shared/outlookDraftContract.js'

const NL = String.fromCharCode(10)
const MASKED = 'From: A Person <[email removed]>' + NL + 'Hello.'
const DATE = '2026-10-14'
const note = () => buildNoteRequest(MASKED, DATE)
const content = () => note().messages[0].content
const sha = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex')

test('the note is asked for in the owner’s own voice, never "the user"', () => {
  assert.ok(NOTE_VOICE.includes('my own personal CRM'))
  assert.ok(NOTE_VOICE.includes('Refer to me as "I", "me" or "my", or leave me out'))
  assert.ok(NOTE_VOICE.includes('Never write' + NL + '"the user".'))
})

test('outside that prohibition, the paste-email note prompt never itself says "the user"', () => {
  const own = content().split('=== BEGIN UNTRUSTED EMAIL CONTENT ===')[0]
  assert.equal((own.match(/the user/gi) || []).length, 1, 'only the prohibition may name it')
  assert.ok(own.includes('I pasted the email exchange below into Funnl. It may include my own messages,'))
})

test('who offered what, and stating only what the email says, are kept explicitly', () => {
  assert.ok(NOTE_VOICE.includes('Keep every offer, request and commitment attached to the person' + NL + 'who made it'))
  assert.ok(NOTE_VOICE.includes('record only' + NL + 'what the exchange states.'))
  assert.ok(NOTE_VOICE.includes('The voice changes nothing else.'))
})

test('the shared Outlook contract, the schema and the transport settings are unchanged', () => {
  const n = note()
  assert.equal(n.system, SYSTEM_CONTRACT)
  assert.deepEqual(n.output_config, { format: { type: 'json_schema', schema: interactionDraftSchema([DATE]) } })
  assert.deepEqual(Object.keys(n).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking'])
  assert.equal(n.messages.length, 1)
})

test('the pasted text is still wrapped as untrusted data, after every instruction', () => {
  const c = content()
  const begin = c.indexOf('=== BEGIN UNTRUSTED EMAIL CONTENT ===')
  assert.ok(begin > c.indexOf('Never write') && begin > c.indexOf('I pasted the email'))
  assert.ok(c.indexOf(MASKED) > begin && c.indexOf(MASKED) < c.indexOf('=== END UNTRUSTED EMAIL CONTENT ==='))
})

test('the contact-details request is pinned (the note voice never changes it)', () => {
  // sha256 of buildContactRequest(MASKED). Was 63f5bad0... at main 8d41302; moved ONLY by the
  // evidence-wording change (ask for the name line with the signature lines) in
  // fix/paste-email-adjacent-signature. A future change must move this pin deliberately.
  assert.equal(sha(buildContactRequest(MASKED)), '5b9fa33a1f31a254b53c6cb3feebca326b5d9628f6d10792655e79f745744110')
})
