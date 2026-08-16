/**
 * Tests for src/lib/stripeUrl.js
 *
 * Zero dependencies — runs with: node tests/stripe-url.test.js
 */

import { isValidStripeUrl } from '../src/lib/stripeUrl.js'

// ── Minimal test runner ───────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    failed++
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'Assertion failed')
}

// ── checkout type ─────────────────────────────────────────────────────────────

console.log('\nisValidStripeUrl — checkout')

test('accepts a valid checkout.stripe.com HTTPS URL', () => {
  assert(isValidStripeUrl('https://checkout.stripe.com/c/pay/cs_test_abc123', 'checkout'))
})
test('accepts checkout URL with query string', () => {
  assert(isValidStripeUrl('https://checkout.stripe.com/c/pay/cs_test_abc?foo=bar', 'checkout'))
})
test('rejects http (non-HTTPS) checkout URL', () => {
  assert(!isValidStripeUrl('http://checkout.stripe.com/c/pay/cs_test_abc123', 'checkout'))
})
test('rejects billing.stripe.com for checkout type', () => {
  assert(!isValidStripeUrl('https://billing.stripe.com/session/xyz', 'checkout'))
})
test('rejects api.stripe.com for checkout type', () => {
  assert(!isValidStripeUrl('https://api.stripe.com/v1/something', 'checkout'))
})
test('rejects a non-Stripe HTTPS URL for checkout type', () => {
  assert(!isValidStripeUrl('https://evil.example.com/steal', 'checkout'))
})
test('rejects a subdomain of checkout.stripe.com', () => {
  assert(!isValidStripeUrl('https://sub.checkout.stripe.com/c/pay/cs_test', 'checkout'))
})

// ── portal type ───────────────────────────────────────────────────────────────

console.log('\nisValidStripeUrl — portal')

test('accepts a valid billing.stripe.com HTTPS URL', () => {
  assert(isValidStripeUrl('https://billing.stripe.com/p/session/test_abc', 'portal'))
})
test('accepts portal URL with path segments', () => {
  assert(isValidStripeUrl('https://billing.stripe.com/p/session/test_abc/manage', 'portal'))
})
test('rejects http (non-HTTPS) portal URL', () => {
  assert(!isValidStripeUrl('http://billing.stripe.com/p/session/test', 'portal'))
})
test('rejects checkout.stripe.com for portal type', () => {
  assert(!isValidStripeUrl('https://checkout.stripe.com/c/pay/cs_test', 'portal'))
})
test('rejects a non-Stripe HTTPS URL for portal type', () => {
  assert(!isValidStripeUrl('https://evil.example.com/phishing', 'portal'))
})
test('rejects a subdomain of billing.stripe.com', () => {
  assert(!isValidStripeUrl('https://evil.billing.stripe.com/p/session', 'portal'))
})

// ── invalid input ─────────────────────────────────────────────────────────────

console.log('\nisValidStripeUrl — invalid input')

test('rejects null', () => {
  assert(!isValidStripeUrl(null, 'checkout'))
})
test('rejects undefined', () => {
  assert(!isValidStripeUrl(undefined, 'checkout'))
})
test('rejects empty string', () => {
  assert(!isValidStripeUrl('', 'checkout'))
})
test('rejects a non-URL string', () => {
  assert(!isValidStripeUrl('not a url', 'checkout'))
})
test('rejects a number', () => {
  assert(!isValidStripeUrl(12345, 'checkout'))
})
test('rejects an object', () => {
  assert(!isValidStripeUrl({}, 'checkout'))
})
test('rejects a relative URL', () => {
  assert(!isValidStripeUrl('/c/pay/cs_test_abc', 'checkout'))
})
test('rejects data: URI', () => {
  assert(!isValidStripeUrl('data:text/html,<script>evil()</script>', 'checkout'))
})
test('rejects javascript: URI', () => {
  assert(!isValidStripeUrl('javascript:alert(1)', 'checkout'))
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
