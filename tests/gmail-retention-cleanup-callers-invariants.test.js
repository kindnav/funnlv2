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
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

const CLEANUP = stripJs(read('supabase/functions/shared/googleCleanup.js'))
const DISCONNECT = stripJs(read('supabase/functions/google-oauth-disconnect/index.ts'))
const DELETE_ACCOUNT = stripJs(read('supabase/functions/delete-account/index.ts'))
// The applied database primitive this PR calls (PR-A, migration 20260918000000).
const RET = stripSql(read('supabase/migrations/20260918000000_add_gmail_retention_cleanup.sql'))

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); passed++ }
  catch (e) { console.log(`  ✗  ${name}`); console.log(`       ${e.message}`); failed++ }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nshared helper + Edge callers (PR-B)')

// 1. GOOGLE_LOCAL_CLEANUP_RPC — the helper names exactly the deployed RPC.
// 2. admin.rpc(...) — one service-role call carries the atomic cleanup; no client deletes.
test('googleCleanup.js calls the RPC by name with p_user_id and issues NO client-side deletes', () => {
  assert.ok(/GOOGLE_LOCAL_CLEANUP_RPC = 'run_google_local_cleanup'/.test(CLEANUP))
  assert.ok(/admin\.rpc\(GOOGLE_LOCAL_CLEANUP_RPC, \{ p_user_id: userId \}\)/.test(CLEANUP))
  assert.ok(!/\.delete\(\)/.test(CLEANUP), 'no independent client deletes remain')
  assert.ok(!/\.from\('interaction_candidates'\)/.test(CLEANUP), 'the helper never touches candidates directly')
  // The RPC signature the helper targets exists in the applied migration with exactly one uuid arg.
  assert.ok(/CREATE FUNCTION public\.run_google_local_cleanup\(p_user_id uuid\)/.test(RET))
  assert.ok(!/expire_pending_email_context/.test(CLEANUP + DISCONNECT + DELETE_ACCOUNT), 'callers never invoke the expiry')
})

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

test('google-oauth-disconnect returns a controlled 500 only on localCleanupError; delete-account keeps best-effort semantics', () => {
  assert.ok(/const \{ localCleanupError \} = await runGoogleLocalCleanup\(/.test(DISCONNECT))
  assert.ok(/if \(localCleanupError\) \{[\s\S]*?internal_error[\s\S]*?500/.test(DISCONNECT))
  assert.ok(!/gmail_candidates_invalidated|gmailCandidatesInvalidated/.test(DISCONNECT), 'no count leaks to the browser')
  assert.ok(/await runGoogleLocalCleanup\(\{ admin: adminClient, userId, resolveToken, revoke \}\)/.test(DELETE_ACCOUNT))
  assert.ok(/catch \{[\s\S]*?google_cleanup_skipped/.test(DELETE_ACCOUNT), 'delete-account never blocks on Google cleanup')
})

// 5. JWT-derived userId — ownership comes only from the verified session.
test('userId reaches the helper only from auth.getUser() (never from a request body)', () => {
  for (const [name, src] of [['disconnect', DISCONNECT], ['delete-account', DELETE_ACCOUNT]]) {
    assert.ok(/await supabaseUser\.auth\.getUser\(\)/.test(src), `${name} verifies the JWT`)
    assert.ok(/userId: user\.id|cleanupGoogle\(admin, user\.id\)/.test(src), `${name} passes the verified id`)
    assert.ok(!/req\.json\(\)|body\.user_id|userId: body/.test(src), `${name} takes no client user id`)
  }
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
