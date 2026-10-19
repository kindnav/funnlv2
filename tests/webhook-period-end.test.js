/**
 * Tests for extractProSubscriptionSnapshot (R3) in
 * supabase/functions/stripe-webhook/webhookHelpers.js — modern item-level billing
 * period extraction with legacy top-level fallback, fail-closed for bad shapes.
 *
 * Zero deps — runs with: node tests/webhook-period-end.test.js
 */
import { extractProSubscriptionSnapshot } from '../supabase/functions/stripe-webhook/webhookHelpers.js'

let passed = 0, failed = 0
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++ } catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ } }
function assert(c, m) { if (!c) throw new Error(m ?? 'Assertion failed') }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const PRICE = 'price_pro'
const ITEM_PE   = 1_704_067_200   // 2024-01-01T00:00:00Z
const LEGACY_PE = 1_701_388_800   // 2023-12-01T00:00:00Z

function subWith({ itemPe, legacyPe, price = PRICE, items } = {}) {
  const data = items ?? [{
    price: { id: price },
    ...(itemPe !== undefined ? { current_period_end: itemPe } : {}),
  }]
  const sub = { items: { data } }
  if (legacyPe !== undefined) sub.current_period_end = legacyPe
  return sub
}

test('modern item-level period end → source item', () => {
  const r = extractProSubscriptionSnapshot(subWith({ itemPe: ITEM_PE }), PRICE)
  assert(r.ok)
  assertEqual(r.source, 'item')
  assertEqual(r.priceId, PRICE)
  assertEqual(r.periodEndIso, new Date(ITEM_PE * 1000).toISOString())
})

test('legacy top-level fallback when item has no period end → source legacy', () => {
  const r = extractProSubscriptionSnapshot(subWith({ legacyPe: LEGACY_PE }), PRICE)
  assert(r.ok)
  assertEqual(r.source, 'legacy')
  assertEqual(r.periodEndIso, new Date(LEGACY_PE * 1000).toISOString())
})

test('item-level preferred over legacy when both present', () => {
  const r = extractProSubscriptionSnapshot(subWith({ itemPe: ITEM_PE, legacyPe: LEGACY_PE }), PRICE)
  assert(r.ok)
  assertEqual(r.source, 'item')
  assertEqual(r.periodEndIso, new Date(ITEM_PE * 1000).toISOString())
})

test('correct configured price matches', () => {
  assert(extractProSubscriptionSnapshot(subWith({ itemPe: ITEM_PE }), PRICE).ok)
})

test('wrong price → no_matching_item', () => {
  const r = extractProSubscriptionSnapshot(subWith({ itemPe: ITEM_PE, price: 'price_other' }), PRICE)
  assertEqual(r.ok, false)
  assertEqual(r.reason, 'no_matching_item')
})

test('no items (empty array) → no_items', () => {
  assertEqual(extractProSubscriptionSnapshot({ items: { data: [] } }, PRICE).reason, 'no_items')
})

test('no items (missing) → no_items', () => {
  assertEqual(extractProSubscriptionSnapshot({}, PRICE).reason, 'no_items')
})

test('malformed items (not array) → malformed_items', () => {
  assertEqual(extractProSubscriptionSnapshot({ items: { data: 'nope' } }, PRICE).reason, 'malformed_items')
})

test('multiple items (mixed config) → unsupported_item_configuration', () => {
  const items = [
    { price: { id: PRICE }, current_period_end: ITEM_PE },
    { price: { id: 'price_other' }, current_period_end: ITEM_PE },
  ]
  assertEqual(extractProSubscriptionSnapshot(subWith({ items }), PRICE).reason, 'unsupported_item_configuration')
})

test('multiple items matching the price → multiple_matching_items', () => {
  const items = [
    { price: { id: PRICE }, current_period_end: ITEM_PE },
    { price: { id: PRICE }, current_period_end: ITEM_PE },
  ]
  assertEqual(extractProSubscriptionSnapshot(subWith({ items }), PRICE).reason, 'multiple_matching_items')
})

test('missing period end (no item pe, no legacy) → no_period_end', () => {
  assertEqual(extractProSubscriptionSnapshot(subWith({}), PRICE).reason, 'no_period_end')
})

test('invalid period timestamp (0 / negative / NaN) → no_period_end', () => {
  assertEqual(extractProSubscriptionSnapshot(subWith({ itemPe: 0 }), PRICE).reason, 'no_period_end')
  assertEqual(extractProSubscriptionSnapshot(subWith({ itemPe: -5 }), PRICE).reason, 'no_period_end')
  assertEqual(extractProSubscriptionSnapshot(subWith({ itemPe: NaN }), PRICE).reason, 'no_period_end')
})

test('price not configured → price_not_configured', () => {
  assertEqual(extractProSubscriptionSnapshot(subWith({ itemPe: ITEM_PE }), '').reason, 'price_not_configured')
})

test('resulting snapshot carries the exact ISO period end', () => {
  const r = extractProSubscriptionSnapshot(subWith({ itemPe: ITEM_PE }), PRICE)
  assertEqual(r.periodEndIso, '2024-01-01T00:00:00.000Z')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
