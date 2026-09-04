// Tests for reason-coded automation / bulk-list classification. Synthetic only.
// Run: node tests/email-automation.test.js

import assert from 'assert'
import { bulkListReason, nonHumanReason, isBulkOrList, isNonHuman } from '../supabase/functions/shared/emailAutomation.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

const base = {
  provider: 'gmail', providerMessageKey: 'm1', providerConversationKey: 't1',
  timestampIso: '2026-01-01T00:00:00Z', fromAddress: 'a@example.com',
  toAddresses: ['b@example.com'], ccAddresses: [], subject: 'hi',
  automation: { autoSubmitted: 'no', precedence: null, hasListId: false, hasListUnsubscribe: false, hasAutoResponseSuppress: false },
  folderHint: 'inbox',
}
const withAuto = (a, over = {}) => ({ ...base, ...over, automation: { ...base.automation, ...a } })

console.log('\nbulkListReason (episode hard-reject)')
test('List-ID / List-Unsubscribe / Precedence bulk|list|junk', () => {
  assert.strictEqual(bulkListReason(withAuto({ hasListId: true })), 'list_id')
  assert.strictEqual(bulkListReason(withAuto({ hasListUnsubscribe: true })), 'list_unsubscribe')
  assert.strictEqual(bulkListReason(withAuto({ precedence: 'bulk' })), 'precedence_bulk')
  assert.strictEqual(bulkListReason(withAuto({ precedence: 'list' })), 'precedence_bulk')
  assert.strictEqual(bulkListReason(withAuto({ precedence: 'junk' })), 'precedence_bulk')
  assert.strictEqual(bulkListReason(base), null)
  assert.ok(isBulkOrList(withAuto({ hasListId: true })) && !isBulkOrList(base))
})

console.log('\nnonHumanReason (exclude from human count)')
test('Auto-Submitted != no', () => {
  assert.strictEqual(nonHumanReason(withAuto({ autoSubmitted: 'auto-generated' })), 'auto_submitted')
  assert.strictEqual(nonHumanReason(withAuto({ autoSubmitted: 'auto-replied' })), 'auto_submitted')
  assert.strictEqual(nonHumanReason(withAuto({ autoSubmitted: 'no' })), null)
})
test('X-Auto-Response-Suppress present', () => {
  assert.strictEqual(nonHumanReason(withAuto({ hasAutoResponseSuppress: true })), 'auto_response_suppress')
})
test('no-reply / mailer-daemon sender (local part)', () => {
  assert.strictEqual(nonHumanReason({ ...base, fromAddress: 'no-reply@example.com' }), 'no_reply_sender')
  assert.strictEqual(nonHumanReason({ ...base, fromAddress: 'noreply@example.com' }), 'no_reply_sender')
  assert.strictEqual(nonHumanReason({ ...base, fromAddress: 'mailer-daemon@example.com' }), 'no_reply_sender')
  assert.strictEqual(nonHumanReason({ ...base, fromAddress: 'notifications@example.com' }), 'no_reply_sender')
})
test('no-reply / bounce domain label (per-label, does not over-match human aliases)', () => {
  assert.strictEqual(nonHumanReason({ ...base, fromAddress: 'hi@no-reply.example.com' }), 'no_reply_sender')
  assert.strictEqual(nonHumanReason({ ...base, fromAddress: 'x@bounces.example.com' }), 'no_reply_sender')
  // "reply" / "notify" as a company subdomain label is NOT treated as automated.
  assert.strictEqual(nonHumanReason({ ...base, fromAddress: 'jordan@reply.example.com' }), null)
  assert.strictEqual(nonHumanReason({ ...base, fromAddress: 'jordan@team.example.com' }), null)
})
test('calendar notification sender or invitation subject', () => {
  assert.strictEqual(nonHumanReason({ ...base, fromAddress: 'calendar-notification@google.com' }), 'calendar_notification')
  assert.strictEqual(nonHumanReason({ ...base, subject: 'Invitation: Sync @ 3pm' }), 'calendar_notification')
})
test('delivery failure + out-of-office subjects', () => {
  assert.strictEqual(nonHumanReason({ ...base, subject: 'Undeliverable: message' }), 'delivery_failure')
  assert.strictEqual(nonHumanReason({ ...base, subject: 'Automatic reply: away' }), 'out_of_office')
})
test('plain human message -> null; isNonHuman false', () => {
  assert.strictEqual(nonHumanReason(base), null)
  assert.ok(!isNonHuman(base) && isNonHuman(withAuto({ hasListId: false, autoSubmitted: 'auto-generated' })))
})
test('unusable input fails closed to non-human', () => {
  assert.strictEqual(nonHumanReason(null), 'no_reply_sender')
})

console.log('\nreason codes are controlled (never leak header/address/subject)')
test('all returned codes are from the controlled set', () => {
  const allowedBulk = new Set([null, 'list_id', 'list_unsubscribe', 'precedence_bulk'])
  const allowedNon = new Set([null, 'auto_submitted', 'auto_response_suppress', 'no_reply_sender', 'calendar_notification', 'out_of_office', 'delivery_failure'])
  const samples = [base, withAuto({ hasListId: true }), { ...base, fromAddress: 'no-reply@secret-domain.example', subject: 'Undeliverable' }]
  for (const s of samples) {
    assert.ok(allowedBulk.has(bulkListReason(s)))
    assert.ok(allowedNon.has(nonHumanReason(s)))
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
