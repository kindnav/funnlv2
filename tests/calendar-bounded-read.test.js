// Executable tests for readBoundedStream as used by google-calendar-sync for
// Calendar/token response bodies: honest incremental byte counting, dishonest/missing
// Content-Length, mid-stream cap cancel, invalid UTF-8, stream error. Pure Node
// (ReadableStream + TextDecoder are global in Node 20+). Run:
//   node tests/calendar-bounded-read.test.js

import assert from 'assert'
import { readBoundedStream } from '../supabase/functions/shared/googleOauthHelpers.js'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

// Build a ReadableStream that emits the given Uint8Array chunks; records cancellation.
function streamOf(chunks, rec = {}) {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
    cancel() { rec.cancelled = true },
  })
}
function streamThatThrows(rec = {}) {
  return new ReadableStream({
    pull() { throw new Error('boom') },
    cancel() { rec.cancelled = true },
  })
}
const enc = (s) => new TextEncoder().encode(s)

console.log('\nreadBoundedStream (Calendar/token body reader)')

await test('reads a small JSON body within cap', async () => {
  const r = await readBoundedStream(streamOf([enc('{"items":[]}')]), { maxBytes: 1000 })
  assert.ok(r.ok); assert.strictEqual(r.text, '{"items":[]}')
})
await test('honest incremental count: multi-chunk body under cap', async () => {
  const r = await readBoundedStream(streamOf([enc('{"a":'), enc('1}')]), { maxBytes: 1000 })
  assert.ok(r.ok); assert.strictEqual(r.text, '{"a":1}')
})
await test('dishonest Content-Length (understated) still bounded by ACTUAL bytes', async () => {
  const rec = {}
  const big = enc('x'.repeat(300))
  const r = await readBoundedStream(streamOf([big], rec), { maxBytes: 100, contentLength: '5' /* lies */ })
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'body_too_large')
  assert.ok(rec.cancelled, 'stream cancelled after exceeding cap')
})
await test('declared oversized Content-Length rejected BEFORE reading', async () => {
  const rec = {}
  const r = await readBoundedStream(streamOf([enc('x')], rec), { maxBytes: 100, contentLength: '999999' })
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'body_too_large')
})
await test('missing Content-Length remains bounded by actual bytes', async () => {
  const rec = {}
  const r = await readBoundedStream(streamOf([enc('y'.repeat(250))], rec), { maxBytes: 100 })
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'body_too_large')
  assert.ok(rec.cancelled)
})
await test('mid-stream cap: cancels as soon as cumulative bytes exceed cap', async () => {
  const rec = {}
  // three 60-byte chunks, cap 100 → exceeds on the second chunk
  const chunk = enc('z'.repeat(60))
  const r = await readBoundedStream(streamOf([chunk, chunk, chunk], rec), { maxBytes: 100 })
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'body_too_large')
  assert.ok(rec.cancelled)
})
await test('invalid UTF-8 fails closed (fatal decode)', async () => {
  const bad = new Uint8Array([0xff, 0xfe, 0xfd])
  const r = await readBoundedStream(streamOf([bad]), { maxBytes: 1000 })
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'invalid_encoding')
})
await test('stream read error returns controlled stream_error reason (no throw)', async () => {
  // A source that errors mid-read: readBoundedStream must fail closed with a controlled
  // reason and never surface the raw error. (An already-errored stream self-cancels;
  // the source cancel() is not re-invoked per the Streams spec, so we assert the reason.)
  const r = await readBoundedStream(streamThatThrows({}), { maxBytes: 1000 })
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'stream_error')
})
await test('missing body → controlled reason (no throw)', async () => {
  const r = await readBoundedStream(null, { maxBytes: 1000 })
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'missing_body')
})
await test('exactly-at-cap body is accepted (boundary)', async () => {
  const r = await readBoundedStream(streamOf([enc('a'.repeat(100))]), { maxBytes: 100 })
  assert.ok(r.ok); assert.strictEqual(r.text.length, 100)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
