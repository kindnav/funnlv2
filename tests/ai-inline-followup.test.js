/**
 * ai-inline-followup.test.js
 *
 * Tests for deriveAIContactActionEligibility() — determines whether an AI
 * contact reference should offer inline follow-up scheduling (validated
 * interaction available) or navigate to the contact detail page.
 *
 * Zero-dependency Node.js — run with: node tests/ai-inline-followup.test.js
 */
import assert from 'assert'
import { deriveAIContactActionEligibility } from '../src/lib/ai-history.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try { fn(); console.log('  ✓  ' + name); passed++ }
  catch (e) { console.error('  ✗  ' + name + ': ' + e.message); failed++ }
}

const CONTACT = { id: 'c1111111-0000-0000-0000-000000000001', name: 'Alice Smith' }
const INTERACTION = { id: 'i1111111-0000-0000-0000-000000000001', contact_id: 'c1111111-0000-0000-0000-000000000001' }
const INTERACTION_OTHER = { id: 'i2222222-0000-0000-0000-000000000001', contact_id: 'c9999999-0000-0000-0000-000000000001' }

// ── mode: none ─────────────────────────────────────────────────────────────────

console.log('\nderiveAIContactActionEligibility — mode: none\n')

test('returns none when validatedContact is null', () => {
  const result = deriveAIContactActionEligibility({}, null, null)
  assert.strictEqual(result.mode, 'none')
})

test('returns none when validatedContact is undefined', () => {
  const result = deriveAIContactActionEligibility({}, undefined, null)
  assert.strictEqual(result.mode, 'none')
})

test('returns none when validatedContact has no id', () => {
  assert.strictEqual(deriveAIContactActionEligibility({}, { name: 'Alice' }, null).mode, 'none')
})

test('returns none when validatedContact id is not a string', () => {
  assert.strictEqual(deriveAIContactActionEligibility({}, { id: 42 }, null).mode, 'none')
})

test('returns none when validatedContact is a string', () => {
  assert.strictEqual(deriveAIContactActionEligibility({}, 'contact-id', null).mode, 'none')
})

// ── mode: navigate ─────────────────────────────────────────────────────────────

console.log('\nderiveAIContactActionEligibility — mode: navigate\n')

test('returns navigate when contact is valid but interaction is null', () => {
  const result = deriveAIContactActionEligibility({}, CONTACT, null)
  assert.strictEqual(result.mode, 'navigate')
  assert.strictEqual(result.contactId, CONTACT.id)
})

test('returns navigate when contact is valid but interaction is undefined', () => {
  const result = deriveAIContactActionEligibility({}, CONTACT, undefined)
  assert.strictEqual(result.mode, 'navigate')
})

test('returns navigate when interaction has no id', () => {
  const noId = { contact_id: CONTACT.id }
  const result = deriveAIContactActionEligibility({}, CONTACT, noId)
  assert.strictEqual(result.mode, 'navigate')
})

test('returns navigate when interaction id is not a string', () => {
  const badId = { id: 42, contact_id: CONTACT.id }
  const result = deriveAIContactActionEligibility({}, CONTACT, badId)
  assert.strictEqual(result.mode, 'navigate')
})

test('returns navigate when interaction belongs to a different contact', () => {
  const result = deriveAIContactActionEligibility({}, CONTACT, INTERACTION_OTHER)
  assert.strictEqual(result.mode, 'navigate')
  assert.strictEqual(result.contactId, CONTACT.id)
})

test('navigate result does not include interactionId', () => {
  const result = deriveAIContactActionEligibility({}, CONTACT, null)
  assert.strictEqual(result.interactionId, undefined)
})

// ── mode: inline ───────────────────────────────────────────────────────────────

console.log('\nderiveAIContactActionEligibility — mode: inline\n')

test('returns inline when contact and interaction both match', () => {
  const result = deriveAIContactActionEligibility({}, CONTACT, INTERACTION)
  assert.strictEqual(result.mode, 'inline')
})

test('inline result includes contactId', () => {
  const result = deriveAIContactActionEligibility({}, CONTACT, INTERACTION)
  assert.strictEqual(result.contactId, CONTACT.id)
})

test('inline result includes interactionId', () => {
  const result = deriveAIContactActionEligibility({}, CONTACT, INTERACTION)
  assert.strictEqual(result.interactionId, INTERACTION.id)
})

test('reference argument is not used for eligibility decisions', () => {
  // The function determines eligibility from validatedContact/validatedInteraction only.
  // The reference parameter is structural (reserved for future use).
  const withRef    = deriveAIContactActionEligibility({ hint: 'follow-up' }, CONTACT, INTERACTION)
  const withoutRef = deriveAIContactActionEligibility(null,                  CONTACT, INTERACTION)
  assert.strictEqual(withRef.mode, withoutRef.mode)
  assert.strictEqual(withRef.contactId, withoutRef.contactId)
  assert.strictEqual(withRef.interactionId, withoutRef.interactionId)
})

// ── Interaction must belong to the specified contact ───────────────────────────

console.log('\nderiveAIContactActionEligibility — ownership enforcement\n')

test('interaction from a different contact forces navigate mode', () => {
  // Prevents arbitrary interaction IDs from being used with unrelated contacts.
  const result = deriveAIContactActionEligibility({}, CONTACT, INTERACTION_OTHER)
  assert.strictEqual(result.mode, 'navigate')
})

test('interaction with empty contact_id forces navigate mode', () => {
  const badOwnership = { id: INTERACTION.id, contact_id: '' }
  const result = deriveAIContactActionEligibility({}, CONTACT, badOwnership)
  assert.strictEqual(result.mode, 'navigate')
})

test('interaction with null contact_id forces navigate mode', () => {
  const noOwner = { id: INTERACTION.id, contact_id: null }
  const result = deriveAIContactActionEligibility({}, CONTACT, noOwner)
  assert.strictEqual(result.mode, 'navigate')
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + (passed + failed) + ' tests: ' + passed + ' passed, ' + failed + ' failed\n')
if (failed > 0) process.exit(1)
