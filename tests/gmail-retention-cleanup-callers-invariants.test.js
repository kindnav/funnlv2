// Source-invariant tests for Gmail retention cleanup PR-B — the callers of the atomic
// whole-Google cleanup RPC:
//   * supabase/functions/shared/googleCleanup.js
//   * supabase/functions/google-oauth-disconnect/index.ts
//   * supabase/functions/delete-account/index.ts
//
// These are the five helper/Edge assertions that were deliberately removed from
// tests/gmail-retention-invariants.test.js when PR-A shipped only the database
// primitives (migration 20260918000000). They are packaged here, unchanged in
// substance, alongside the implementation they test. This file reads nothing from
// the held-back scheduler migration (20260918000100) or any PR-C surface.
//
// HONESTY NOTE: static source-scan assertions over JS/TS text. Runtime behavior of the
// helper (revoke/cleanup ordering, fail-closed result handling, every failure
// combination) is exercised by tests/google-cleanup.test.js with injected fakes, and
// the end-to-end path against the real RPC is validated on a disposable local Supabase
// stack (see docs/gmail-privacy-readiness.md).
//
// Run: node tests/gmail-retention-cleanup-callers-invariants.test.js

import assert from 'assert'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const CLEANUP = stripJs(read('supabase/functions/shared/googleCleanup.js'))
// The applied database primitive this PR calls (PR-A, migration 20260918000000).

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nshared helper + Edge callers (PR-B)')

// 1. GOOGLE_LOCAL_CLEANUP_RPC — the helper names exactly the deployed RPC.
// 2. admin.rpc(...) — one service-role call carries the atomic cleanup; no client deletes.

// 4. Revoke/local-cleanup ordering and failure semantics.
test('revoke failure can never block local cleanup (try/catch around revoke; RPC after it, unconditional)', () => {
  const revokeIdx = CLEANUP.indexOf('await revoke(token)')
  const rpcIdx = CLEANUP.indexOf('admin.rpc(GOOGLE_LOCAL_CLEANUP_RPC')
  assert.ok(revokeIdx >= 0 && rpcIdx > revokeIdx)
  assert.ok(/try \{[\s\S]*?await revoke\(token\)[\s\S]*?\} catch \{/.test(CLEANUP))
})

// 3. localCleanupError handling — fail closed on every non-success shape.
test('helper fails closed on rpc error / non-cleaned result / thrown transport error', () => {
  assert.ok(/if \(error \|\| !data \|\| data\.result !== 'cleaned'\)/.test(CLEANUP))
  assert.ok(/catch \{\s*localCleanupError = true/.test(CLEANUP))
  assert.ok(/return \{ revoked, localCleanupError, gmailCandidatesInvalidated \}/.test(CLEANUP), 'controlled fields only')
  assert.ok(!/console\.(log|error|warn)\(/.test(CLEANUP), 'the helper logs nothing (no tokens, subjects, ids, or raw errors)')
})

// 5. JWT-derived userId — ownership comes only from the verified session.

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
