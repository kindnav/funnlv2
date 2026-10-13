// THE COHORT RESERVATION, PROVEN AGAINST THE REAL FUNCTION ON A REAL DATABASE.
//
// Stands up this project's own Postgres image, applies EVERY migration in order - including
// 20261013120000, which is the one under test - and runs
// tests/sql/outlook-cohort-reservation-runtime.sql as `postgres`.
//
// WHY A DATABASE AND NOT A MOCK. The thing being changed is a SQL predicate inside a
// SECURITY DEFINER function, together with its grants and its interaction with the lease and
// backoff rules. A JavaScript double of that function would be a reading of the SQL, and
// this repository has already had a reading of SQL be confidently wrong - the episode-alias
// tombstone - in a way that hid a defect that lost mail. So the eligibility rule, the
// ordering, the fail-closed cases and the ACL are all asked of the function itself.
//
// WHAT IT DOES NOT COVER. The worker's own behaviour around the reservation lives in
// tests/outlook-pilot-gate.test.js and tests/outlook-two-sided-rounds.test.js, which drive
// the real handler. This file is about the database.
//
// NOT part of `npm test`: it needs Docker. RUN: node tests/local/outlook-cohort-reservation.mjs
// Teardown is unconditional, so a failure leaves no container behind.

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PG = 'funnl-cohort-pg'
const NET = 'funnl-cohort-net'
const PG_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.140'

function docker (args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', ...opts })
}
function quiet (args) { spawnSync('docker', args, { stdio: 'ignore' }) }

function psql (sql, { user = 'postgres', tuplesOnly = true } = {}) {
  const args = ['exec', '-i', PG, 'psql', '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q']
  if (tuplesOnly) args.push('-At')
  args.push('-f', '-')
  return execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: 'pipe' })
}
function psqlFile (path, user = 'postgres') {
  return psql(readFileSync(join(ROOT, path), 'utf8'), { user, tuplesOnly: false })
}

// The image restarts itself once during first-time initialisation, so a single successful
// probe is not readiness: three in a row is.
function waitForPg (timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  let last = 'never attempted'
  while (Date.now() < deadline) {
    const d = spawnSync('docker',
      ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'],
      { input: 'CREATE TABLE public._probe(i int); DROP TABLE public._probe;',
        encoding: 'utf8' })
    if (d.status === 0) {
      streak += 1
      if (streak >= 3) return
    } else {
      streak = 0
      last = (d.stderr || '').trim().split('\n').pop() || String(d.status)
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)'])
  }
  throw new Error(`postgres never became ready: ${last}`)
}

function teardown () {
  quiet(['rm', '-f', PG])
  quiet(['network', 'rm', NET])
}

let failed = false
try {
  console.log('\nbuilding a disposable database')
  teardown()
  quiet(['network', 'create', NET])
  docker(['run', '-d', '--name', PG, '--network', NET,
    '-e', 'POSTGRES_PASSWORD=disposable', PG_IMAGE])
  waitForPg()
  psqlFile('tests/sql/_bootstrap-disposable-db.sql', 'supabase_admin')
  const migrations = execFileSync('node', ['-e',
    "const {readdirSync}=require('fs');process.stdout.write(readdirSync('supabase/migrations')"
    + ".filter(f=>f.endsWith('.sql')).sort().join('\\n'))"],
    { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const m of migrations) psqlFile(`supabase/migrations/${m}`)
  console.log(`  applied ${migrations.length} migrations, none skipped`)
  const underTest = migrations.includes('20261013120000_outlook_cohort_reservation.sql')
  if (!underTest) throw new Error('the cohort migration was not applied - nothing was proven')
  console.log('  including 20261013120000_outlook_cohort_reservation.sql\n')

  // RAISE NOTICE goes to STDERR, so both streams are captured and counted: reading only
  // stdout once made a passing run report zero assertions, which is a green run proving
  // nothing - the failure mode this harness exists to avoid.
  const run = spawnSync('docker',
    ['exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-q', '-f', '-'],
    { input: readFileSync(join(ROOT, 'tests/sql/outlook-cohort-reservation-runtime.sql'), 'utf8'),
      encoding: 'utf8' })
  const out = `${run.stdout || ''}
${run.stderr || ''}`
  if (run.status !== 0) throw new Error(`the SQL proof failed:
${out.slice(-4000)}`)
  // Every assertion RAISES NOTICE on success and RAISES EXCEPTION on failure, so psql
  // exiting 0 with the notices present is the pass condition.
  process.stdout.write(out.split('\n').filter((l) => l.trim().length > 0).join('\n') + '\n')
  const oks = (out.match(/ok {3}/g) || []).length
  console.log(`\n${oks} database assertions passed, 0 failed\n`)
  if (oks < 20) throw new Error(`too few assertions ran (${oks}) - the proof is not complete`)
} catch (e) {
  failed = true
  console.error(`\nFAILED: ${e.message}`)
  if (e.stdout) console.error(String(e.stdout).slice(-4000))
  if (e.stderr) console.error(String(e.stderr).slice(-4000))
} finally {
  teardown()
  if (failed) process.exitCode = 1
}
