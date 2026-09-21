// Static invariants for the Outlook content-draft schema foundation (PR-A):
// supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql
//
// Source-scan assertions over the migration text. They pin the exact objects, the
// ownership / composite-FK / RLS / grant model, the SECURITY DEFINER hygiene, the
// field bounds and lifecycle invariants, the terminal-erasure sets, the atomic
// add-both acceptance, the lease fencing, the complete-run-only cursor rule, the
// bounded SKIP LOCKED expiry, the consent binding to the single-use OAuth state, the
// Microsoft permission contract (canonical scope allowlist), the accept-RPC argument
// ownership, the absence of Cron / provider calls / raw content, and that Gmail +
// Calendar behavior is unchanged (accept/dismiss differ from 20260907 ONLY by the
// additive erasure lines).
//
// Runtime behavior (real RPC calls as authenticated/service_role, two-user isolation,
// cross-user FK rejection, lease lifecycle, atomic add-both incl. a forced interaction
// failure, dismiss/defer, expiry, disconnect, cleanup, account-deletion cascade) is
// verified by tests/sql/outlook-content-draft-runtime.sql on a disposable local stack;
// the 8-session reservation race is run as parallel psql sessions against the same
// stack (exactly one 'reserved' per round).
//
// Run with: node tests/outlook-content-draft-migration.test.js
import assert from 'assert'
import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}`); console.error(`    ${e.message}`); failed++ }
}

const MIG_REL = 'supabase/migrations/20260921000000_add_outlook_content_draft_primitives.sql'
const SQL = read(MIG_REL)
const CODE = SQL.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')   // comment-stripped
const E2A = read('supabase/migrations/20260907000000_add_gmail_transport_foundation.sql')
const RUNTIME = read('tests/sql/outlook-content-draft-runtime.sql')

// Text of one CREATE TABLE statement.
function tableDdl(name) {
  const i = SQL.indexOf(`CREATE TABLE public.${name} (`)
  assert.ok(i !== -1, `missing CREATE TABLE ${name}`)
  return SQL.slice(i, SQL.indexOf('\n);', i) + 3)
}
// Text of one function (CREATE ... $$ ... $$;).
function fnBody(name) {
  const re = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\(`)
  const m = re.exec(SQL)
  assert.ok(m, `missing function ${name}`)
  const start = m.index
  const end = SQL.indexOf('\n$$;', start)
  return SQL.slice(start, end + 4)
}
// Statements following a table up to the next section header.
function tableSection(name) {
  const start = SQL.indexOf(`CREATE TABLE public.${name} (`)
  const next = SQL.indexOf('\n-- ══', start)
  return SQL.slice(start, next === -1 ? undefined : next)
}

const NEW_TABLES = ['microsoft_connections', 'microsoft_tokens', 'microsoft_oauth_states',
  'outlook_sync_state', 'new_contact_candidates', 'outlook_candidate_refs']
const NEW_FUNCTIONS = {
  finalize_microsoft_connection: 'text, uuid, text, text, text, text, text[], timestamptz, text, text, text, text, smallint',
  update_microsoft_connection_state: 'uuid, uuid, text, boolean, text',
  reserve_due_outlook_connection: 'integer, integer',
  renew_outlook_sync_lease: 'uuid, uuid, integer',
  release_outlook_sync_lease: 'uuid, uuid, text, text, boolean, text, text, text, text, smallint, boolean, integer',
  invalidate_outlook_candidates_by_fingerprint: 'uuid, uuid, text[]',
  accept_new_contact_candidate: 'uuid, text, text, text, text, text, text[], text, text, boolean, text, date, text, date',
  dismiss_new_contact_candidate: 'uuid',
  defer_candidate: 'text, uuid, timestamptz',
  disconnect_my_outlook: '',
  run_microsoft_local_cleanup: 'uuid',
  expire_pending_outlook_context: 'integer',
}
const SERVICE_ONLY = ['finalize_microsoft_connection', 'update_microsoft_connection_state', 'reserve_due_outlook_connection',
  'renew_outlook_sync_lease', 'release_outlook_sync_lease', 'invalidate_outlook_candidates_by_fingerprint',
  'run_microsoft_local_cleanup', 'expire_pending_outlook_context']
const USER_ONLY = ['accept_new_contact_candidate', 'dismiss_new_contact_candidate', 'defer_candidate', 'disconnect_my_outlook']

// ── Exact objects ─────────────────────────────────────────────────────────────
console.log('\nexact objects')
test('migration file exists with the reserved version and no sibling 20260921* file', () => {
  const files = readdirSync(join(root, 'supabase/migrations'))
  assert.deepStrictEqual(files.filter(f => f.startsWith('20260921')), ['20260921000000_add_outlook_content_draft_primitives.sql'])
  assert.ok(!files.some(f => f.startsWith('20260918000100')), 'the held-back Cron migration must not be on this branch')
})
test('exactly the six new tables are created', () => {
  const created = [...SQL.matchAll(/CREATE TABLE public\.(\w+)/g)].map(m => m[1]).sort()
  assert.deepStrictEqual(created, [...NEW_TABLES].sort())
})
test('exactly the twelve new functions are created (CREATE FUNCTION, never OR REPLACE) with one signature each', () => {
  const created = [...SQL.matchAll(/CREATE FUNCTION public\.(\w+)\(/g)].map(m => m[1]).sort()
  assert.deepStrictEqual(created, Object.keys(NEW_FUNCTIONS).sort())
  for (const [name, sig] of Object.entries(NEW_FUNCTIONS)) {
    const grants = [...SQL.matchAll(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(([^)]*)\\)`, 'g'))].map(m => m[1].replace(/\s+/g, ' ').trim())
    assert.deepStrictEqual(grants, [sig], `${name} grant signature`)
    assert.strictEqual((SQL.match(new RegExp(`FUNCTION public\\.${name}\\(`, 'g')) || []).length, 3, `${name}: create + revoke + grant exactly once`)
  }
})
test('only accept_/dismiss_interaction_candidate are CREATE OR REPLACEd; no DROP of anything', () => {
  const replaced = [...SQL.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(m => m[1]).sort()
  assert.deepStrictEqual(replaced, ['accept_interaction_candidate', 'dismiss_interaction_candidate'])
  assert.ok(!/\bDROP (TABLE|FUNCTION|COLUMN|POLICY|INDEX)\b/i.test(CODE), 'no destructive DROP')
  assert.ok(!/\bALTER TABLE public\.(?!interaction_candidates\b)\w+/.test(CODE.replace(/ENABLE ROW LEVEL SECURITY/g, '')) ||
            [...CODE.matchAll(/ALTER TABLE public\.(\w+)\s+(?!ENABLE ROW LEVEL SECURITY)/g)].every(m => m[1] === 'interaction_candidates' || NEW_TABLES.includes(m[1])),
            'only interaction_candidates (and new tables) are altered')
})
test('interaction_candidates gains exactly the five Outlook draft columns + composite key', () => {
  const add = SQL.slice(SQL.indexOf('ALTER TABLE public.interaction_candidates\n  ADD COLUMN'), SQL.indexOf(';', SQL.indexOf('ALTER TABLE public.interaction_candidates\n  ADD COLUMN')))
  const cols = [...add.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map(m => m[1])
  assert.deepStrictEqual(cols, ['draft_summary', 'draft_follow_up', 'summary_evidence', 'extraction_status', 'deferred_until'])
  assert.ok(/ADD CONSTRAINT interaction_candidates_id_user_key UNIQUE \(id, user_id\)/.test(SQL))
})
test('no Gmail / Calendar / Google table or RPC is referenced', () => {
  assert.ok(!/google_connections|google_tokens|google_oauth_states|google_connection_capabilities|gmail_sync_state|email_candidate_refs|google_calendar_/.test(CODE))
  // The only 'gmail' literal is the preserved source allowlist inside accept_interaction_candidate (20260907 body).
  assert.ok(!/gmail|calendar/i.test(CODE.replace(/'google_calendar', 'gmail', 'outlook'/g, '')), 'no gmail/calendar identifiers in code')
})
test('interactions source constraint (applied by 20260907) already admits outlook; not touched here', () => {
  assert.ok(/interactions_source_check[\s\S]*?CHECK \(source IN \('manual', 'google_calendar', 'gmail', 'outlook'\)\)/.test(E2A))
  assert.ok(!/interactions_source_check|interaction_candidates_source_check/.test(CODE))
})

// ── Ownership, composite FKs, RLS, grants ─────────────────────────────────────
console.log('\nownership, composite foreign keys, RLS, grants')
test('every new table references auth.users(id) ON DELETE CASCADE', () => {
  for (const t of NEW_TABLES) assert.ok(/user_id\s+uuid\s+NOT NULL REFERENCES auth\.users\(id\)\s+ON DELETE CASCADE/.test(tableDdl(t)), t)
})
test('dependent tables use composite (connection_id, user_id) FKs to microsoft_connections(id, user_id)', () => {
  for (const t of ['microsoft_tokens', 'outlook_sync_state', 'outlook_candidate_refs']) {
    assert.ok(/FOREIGN KEY \(connection_id, user_id\)\s+REFERENCES public\.microsoft_connections\(id, user_id\) ON DELETE CASCADE/.test(tableDdl(t)), t)
  }
  assert.ok(/CONSTRAINT microsoft_connections_id_user_key UNIQUE \(id, user_id\)/.test(tableDdl('microsoft_connections')))
})
test('candidate refs use composite (candidate_id, user_id) FKs to BOTH candidate tables and exactly one target', () => {
  const d = tableDdl('outlook_candidate_refs')
  assert.ok(/FOREIGN KEY \(interaction_candidate_id, user_id\)\s+REFERENCES public\.interaction_candidates\(id, user_id\) ON DELETE CASCADE/.test(d))
  assert.ok(/FOREIGN KEY \(new_contact_candidate_id, user_id\)\s+REFERENCES public\.new_contact_candidates\(id, user_id\) ON DELETE CASCADE/.test(d))
  assert.ok(/ocr_exactly_one_target CHECK \(\s*\(interaction_candidate_id IS NOT NULL AND new_contact_candidate_id IS NULL\)\s*OR \(interaction_candidate_id IS NULL AND new_contact_candidate_id IS NOT NULL\)\)/.test(d))
  assert.ok(/CONSTRAINT ncc_id_user_key UNIQUE \(id, user_id\)/.test(tableDdl('new_contact_candidates')))
})
test('RLS enabled on every new table', () => {
  for (const t of NEW_TABLES) assert.ok(SQL.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`), t)
})
test('every new table REVOKEs ALL from PUBLIC, anon and authenticated, then grants service_role', () => {
  for (const t of NEW_TABLES) {
    const s = tableSection(t)
    for (const role of ['PUBLIC', 'anon', 'authenticated']) assert.ok(s.includes(`REVOKE ALL ON TABLE public.${t} FROM ${role};`), `${t} revoke ${role}`)
    assert.ok(new RegExp(`GRANT ALL\\s+ON TABLE public\\.${t} TO service_role;`).test(s), `${t} service_role`)
    assert.ok(!new RegExp(`GRANT[^;]*public\\.${t}[^;]*TO anon`).test(s), `${t} anon grant`)
  }
})
test('tokens, oauth states, sync state and refs have NO authenticated grant and NO policy', () => {
  for (const t of ['microsoft_tokens', 'microsoft_oauth_states', 'outlook_sync_state', 'outlook_candidate_refs']) {
    const s = tableSection(t)
    assert.ok(!new RegExp(`GRANT[^;]*ON TABLE public\\.${t} TO authenticated`).test(s), `${t} authenticated grant`)
    assert.ok(!new RegExp(`CREATE POLICY[^;]*ON public\\.${t}`).test(s), `${t} policy`)
  }
})
test('browser-visible columns are an explicit allowlist that excludes every sensitive field', () => {
  const conn = /GRANT SELECT \(([^)]*)\) ON TABLE public\.microsoft_connections TO authenticated/.exec(SQL)[1].replace(/\s+/g, ' ')
  for (const c of ['id', 'user_id', 'ms_account_id', 'ms_tenant_id', 'token_expires_at']) assert.ok(!new RegExp(`\\b${c}\\b`).test(conn), `connections exposes ${c}`)
  const ncc = /GRANT SELECT \(([^)]*)\) ON TABLE public\.new_contact_candidates TO authenticated/.exec(SQL)[1].replace(/\s+/g, ' ')
  for (const c of ['user_id', 'person_fingerprint', 'episode_fingerprint', 'key_version', 'context_expires_at']) assert.ok(!new RegExp(`\\b${c}\\b`).test(ncc), `candidates expose ${c}`)
  for (const c of ['extraction_status', 'draft_summary', 'proposed_email', 'proposed_name_evidence', 'deferred_until']) assert.ok(new RegExp(`\\b${c}\\b`).test(ncc), `candidates must expose ${c} for review`)
  const ic = /GRANT SELECT \(([^)]*)\)\s+ON TABLE public\.interaction_candidates TO authenticated/.exec(SQL)[1].replace(/\s+/g, ' ')
  assert.strictEqual(ic, 'draft_summary, draft_follow_up, summary_evidence, extraction_status, deferred_until')
})
test('select-own policies use (SELECT auth.uid()) = user_id; no write policy exists', () => {
  for (const t of ['microsoft_connections', 'new_contact_candidates']) {
    assert.ok(new RegExp(`CREATE POLICY "${t}_select_own"\\s+ON public\\.${t}\\s+FOR SELECT\\s+TO authenticated\\s+USING \\(\\(SELECT auth\\.uid\\(\\)\\) = user_id\\)`).test(SQL), t)
  }
  assert.ok(!/FOR (INSERT|UPDATE|DELETE|ALL)\s+TO authenticated/.test(CODE))
})

// ── Function hygiene ──────────────────────────────────────────────────────────
console.log('\nSECURITY DEFINER hygiene')
test('every function is SECURITY DEFINER with SET search_path = \'\' and plpgsql', () => {
  for (const name of [...Object.keys(NEW_FUNCTIONS), 'accept_interaction_candidate', 'dismiss_interaction_candidate']) {
    const b = fnBody(name)
    assert.ok(/LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = ''/.test(b), name)
  }
})
test('no dynamic SQL, no unqualified public objects, no owner change', () => {
  assert.ok(!/\bEXECUTE\s+(format|'|\$|v_|p_)/i.test(CODE), 'no EXECUTE of built strings')
  assert.ok(!/\bformat\s*\(/.test(CODE), 'no format()')
  assert.ok(!/\bALTER FUNCTION\b|\bOWNER TO\b/i.test(CODE))
  const bodies = [...Object.keys(NEW_FUNCTIONS), 'accept_interaction_candidate', 'dismiss_interaction_candidate'].map(fnBody).join('\n')
  // `FOR UPDATE SKIP LOCKED` and `UPDATE ... SET` are keywords, not object references.
  const refs = [...bodies.matchAll(/\b(?:FROM|JOIN|UPDATE|DELETE FROM|INSERT INTO)\s+(?!public\.|pg_catalog\.|auth\.|due\b|SET\b|SKIP\b)([A-Za-z_]+)/g)].map(m => m[1])
  assert.deepStrictEqual([...new Set(refs)], [], `unqualified references: ${refs.join(', ')}`)
})
test('service-only functions REVOKE from PUBLIC, anon, authenticated and GRANT only service_role', () => {
  for (const name of SERVICE_ONLY) {
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated;`).test(SQL.replace(/\n\s+/g, ' ')), `${name} revoke`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\)\\s+TO service_role;`).test(SQL.replace(/\n\s+/g, ' ')), `${name} grant`)
    assert.ok(!new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\)\\s+TO authenticated`).test(SQL.replace(/\n\s+/g, ' ')), `${name} must not be user-callable`)
  }
})
test('user-action functions REVOKE from PUBLIC, anon and GRANT only authenticated; derive the caller from auth.uid()', () => {
  for (const name of USER_ONLY) {
    const flat = SQL.replace(/\n\s+/g, ' ')
    assert.ok(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon;`).test(flat), `${name} revoke`)
    assert.ok(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO authenticated;`).test(flat), `${name} grant`)
    assert.ok(!new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role`).test(flat), `${name} service grant`)
    const b = fnBody(name)
    assert.ok(/v_uid\s+uuid := \(SELECT auth\.uid\(\)\)/.test(b), `${name} auth.uid()`)
    assert.ok(!/p_user_id/.test(b), `${name} must not accept a user id`)
    assert.ok(/IF v_uid IS NULL THEN RETURN jsonb_build_object\('result', 'unauth/.test(b), `${name} unauthenticated guard`)
  }
})
test('every ownership predicate in user functions is user_id = v_uid', () => {
  for (const name of USER_ONLY) {
    const b = fnBody(name)
    for (const m of b.matchAll(/WHERE id = p_candidate_id([^;]*)/g)) assert.ok(/user_id = v_uid/.test(m[0]), `${name}: ${m[0].slice(0, 60)}`)
  }
})
test('no function returns raw provider state (tokens, delta links, fingerprints, addresses) in JSON', () => {
  for (const name of Object.keys(NEW_FUNCTIONS)) {
    const returns = [...fnBody(name).matchAll(/jsonb_build_object\(([^;]*)\)/g)].map(m => m[1])
    // Controlled code literals (e.g. 'invalid_fingerprint') are fine; column references are not.
    for (const r of returns) assert.ok(!/ciphertext|nonce|delta_link|fingerprint|proposed_email|ms_account|ms_tenant|retained_subject|draft_summary|SQLERRM/.test(r.replace(/'[^']*'/g, '')), `${name} returns ${r.slice(0, 80)}`)
  }
  assert.ok(!/SQLERRM/.test(CODE), 'no database messages surfaced')
})

// ── Content and bounds ────────────────────────────────────────────────────────
console.log('\nno raw content, field bounds')
test('no column can hold raw content: no body/snippet/html/mime/attachment/header/prompt/output/message-id/plaintext delta link', () => {
  const cols = NEW_TABLES.flatMap(t => [...tableDdl(t).matchAll(/^\s{2}(\w+)\s+(?:uuid|text|text\[\]|boolean|smallint|integer|timestamptz|date)/gm)].map(m => m[1]))
  const bad = cols.filter(c => /body|snippet|html|mime|attachment|header|prompt|output|raw|message_id|conversation_id|graph_id|preview/i.test(c))
  assert.deepStrictEqual(bad, [])
  assert.ok(!/delta_link\s+text/.test(SQL), 'delta link only as ciphertext')
  assert.ok(/delta_link_ciphertext\s+text/.test(SQL) && /delta_link_nonce\s+text/.test(SQL) && /delta_key_version\s+smallint/.test(SQL))
})
test('draft_summary <= 200 chars, draft_follow_up <= 160, retained_subject <= 160, all control-free; no URL in plain-text fields', () => {
  for (const t of ['interaction_candidates', 'new_contact_candidates']) {
    const src = t === 'new_contact_candidates' ? tableDdl(t) : SQL
    assert.ok(/char_length\(draft_summary\) BETWEEN 1 AND 200\s+AND draft_summary !~ '\[\[:cntrl:\]\]' AND draft_summary !~\* '\(https\?:\|www\\\.\)'/.test(src), `${t} summary`)
    assert.ok(/char_length\(draft_follow_up\) BETWEEN 1 AND 160\s+AND draft_follow_up !~ '\[\[:cntrl:\]\]' AND draft_follow_up !~\* '\(https\?:\|www\\\.\)'/.test(src), `${t} follow-up`)
  }
  assert.ok(/char_length\(retained_subject\) <= 160 AND retained_subject !~ '\[\[:cntrl:\]\]'/.test(tableDdl('new_contact_candidates')))
  for (const f of ['proposed_name', 'proposed_company', 'proposed_role', 'proposed_how_met']) {
    assert.ok(new RegExp(`char_length\\(${f}\\) BETWEEN 1 AND 120 AND ${f} !~ '\\[\\[:cntrl:\\]\\]' AND ${f} !~\\* '\\(https\\?:\\|www\\\\\\.\\)'`).test(tableDdl('new_contact_candidates')), f)
  }
  assert.ok(/proposed_linkedin_url ~ '\^https:\/\/\(www\\\.\)\?linkedin\\\.com\/in\/\[A-Za-z0-9_%\.-\]\+\/\?\$'/.test(tableDdl('new_contact_candidates')), 'linkedin url shape')
  assert.ok(/proposed_email ~ '\^\[\^@\]\+@\[\^@\]\+\\\.\[\^@\]\+\$'/.test(tableDdl('new_contact_candidates')), 'email shape')
})
test('evidence + confidence codes are NULL-explicit and company/role/how_met/linkedin require explicit evidence (no domain inference)', () => {
  const d = tableDdl('new_contact_candidates')
  assert.ok(/proposed_name IS NOT NULL AND proposed_name_evidence IS NOT NULL AND proposed_name_confidence IS NOT NULL\s+AND proposed_name_evidence IN \('provider_metadata', 'explicit_signature', 'explicit_body'\)/.test(d))
  for (const f of ['company', 'role', 'how_met', 'linkedin_url']) {
    assert.ok(new RegExp(`proposed_${f} IS NOT NULL AND proposed_${f}_evidence IS NOT NULL AND proposed_${f}_confidence IS NOT NULL\\s+AND proposed_${f}_evidence IN \\('explicit_signature', 'explicit_body'\\)\\s+AND proposed_${f}_confidence IN \\('high', 'medium'\\)`).test(d), f)
  }
  assert.ok(!/'inferred'|'domain'/.test(d), 'no inferred/domain evidence code')
})
test('status enums, source fixed to outlook, type fixed to Email, fingerprints 64-hex, folders inbox|sentitems', () => {
  const d = tableDdl('new_contact_candidates')
  assert.ok(/ncc_status_check\s+CHECK \(status IN \('pending', 'accepted', 'dismissed', 'deferred', 'invalidated'\)\)/.test(d))
  assert.ok(/ncc_source_check\s+CHECK \(source = 'outlook'\)/.test(d) && /ncc_type_check\s+CHECK \(proposed_type = 'Email'\)/.test(d))
  assert.ok(/person_fingerprint\s+~ '\^\[0-9a-f\]\{64\}\$'/.test(d) && /episode_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/.test(d))
  assert.ok(/ncc_user_episode_unique UNIQUE \(user_id, episode_fingerprint\)/.test(d))
  assert.ok(/oss_folder_check\s+CHECK \(folder IN \('inbox', 'sentitems'\)\)/.test(tableDdl('outlook_sync_state')))
  assert.ok(/microsoft_connections_status_check\s+CHECK \(status IN \('active', 'needs_reauth', 'revoked', 'disabled'\)\)/.test(tableDdl('microsoft_connections')))
  assert.ok(/microsoft_oauth_states_integration_check CHECK \(integration_type IN \('outlook'\)\)/.test(tableDdl('microsoft_oauth_states')))
})
test('30-day context ceiling, open rows require context, deferral never outlives context (NULL-explicit)', () => {
  const d = tableDdl('new_contact_candidates')
  assert.ok(/ncc_context_ceiling CHECK \(context_expires_at IS NULL OR context_expires_at <= created_at \+ interval '30 days'\)/.test(d))
  assert.ok(/ncc_open_requires_context CHECK \(\s*status NOT IN \('pending', 'deferred'\)\s*OR \(proposed_email IS NOT NULL AND proposed_interaction_date IS NOT NULL AND context_expires_at IS NOT NULL\)\)/.test(d))
  assert.ok(/\(status = 'deferred' AND deferred_until IS NOT NULL AND context_expires_at IS NOT NULL AND deferred_until <= context_expires_at\)\s*OR \(status <> 'deferred' AND deferred_until IS NULL\)/.test(d))
  assert.ok(/interaction_candidates_deferred_within_context\s+CHECK \(deferred_until IS NULL OR \(context_expires_at IS NOT NULL AND deferred_until <= context_expires_at\)\)/.test(SQL))
  assert.ok(/IF p_until IS NOT NULL AND \(p_until <= now\(\) OR p_until > now\(\) \+ interval '30 days'\)/.test(fnBody('defer_candidate')))
  assert.ok((fnBody('defer_candidate').match(/'beyond_context'/g) || []).length === 2, 'both kinds refuse deferral beyond the context deadline')
})
test('terminal rows carry no provider-derived context (CHECK on both tables)', () => {
  assert.ok(/ncc_terminal_erased CHECK \(\s*status IN \('pending', 'deferred'\)\s*OR \(proposed_email IS NULL AND proposed_name IS NULL AND proposed_company IS NULL AND proposed_role IS NULL\s*AND proposed_how_met IS NULL AND proposed_linkedin_url IS NULL\s*AND draft_summary IS NULL AND draft_follow_up IS NULL AND retained_subject IS NULL\s*AND context_expires_at IS NULL AND deferred_until IS NULL\)\)/.test(tableDdl('new_contact_candidates')))
  assert.ok(/interaction_candidates_terminal_draft_erased\s+CHECK \(status = 'pending'\s+OR \(draft_summary IS NULL AND draft_follow_up IS NULL AND summary_evidence IS NULL\s+AND deferred_until IS NULL\)\)/.test(SQL))
  assert.ok(/interaction_candidates_outlook_draft_source_check\s+CHECK \(source = 'outlook'\s+OR \(draft_summary IS NULL AND draft_follow_up IS NULL AND summary_evidence IS NULL\s+AND extraction_status IS NULL AND deferred_until IS NULL\)\)/.test(SQL), 'draft columns only on outlook rows')
})

// ── Terminal erasure inside every RPC ─────────────────────────────────────────
console.log('\nterminal erasure')
const NCC_ERASE = ['proposed_email = NULL', 'proposed_name = NULL', 'proposed_name_evidence = NULL', 'proposed_name_confidence = NULL',
  'proposed_company = NULL', 'proposed_company_evidence = NULL', 'proposed_company_confidence = NULL',
  'proposed_role = NULL', 'proposed_role_evidence = NULL', 'proposed_role_confidence = NULL',
  'proposed_how_met = NULL', 'proposed_how_met_evidence = NULL', 'proposed_how_met_confidence = NULL',
  'proposed_linkedin_url = NULL', 'proposed_linkedin_url_evidence = NULL', 'proposed_linkedin_url_confidence = NULL',
  'draft_summary = NULL', 'draft_follow_up = NULL', 'retained_subject = NULL', 'context_expires_at = NULL', 'deferred_until = NULL']
const IC_ERASE = ['retained_subject = NULL', 'context_expires_at = NULL', 'draft_summary = NULL', 'draft_follow_up = NULL', 'summary_evidence = NULL', 'deferred_until = NULL']
test('accept/dismiss/invalidate/cleanup/expiry erase EVERY provider-derived new-contact field', () => {
  for (const name of ['accept_new_contact_candidate', 'dismiss_new_contact_candidate', 'invalidate_outlook_candidates_by_fingerprint', 'run_microsoft_local_cleanup', 'expire_pending_outlook_context']) {
    const b = fnBody(name)
    for (const e of NCC_ERASE) assert.ok(b.includes(e), `${name} misses ${e}`)
    assert.ok(!/person_fingerprint = NULL|episode_fingerprint = NULL/.test(b), `${name} must keep fingerprints`)
  }
})
test('accept/dismiss/invalidate/cleanup/expiry erase EVERY Outlook draft field on interaction candidates', () => {
  for (const name of ['accept_interaction_candidate', 'dismiss_interaction_candidate', 'invalidate_outlook_candidates_by_fingerprint', 'run_microsoft_local_cleanup', 'expire_pending_outlook_context']) {
    const b = fnBody(name)
    for (const e of IC_ERASE) assert.ok(b.includes(e), `${name} misses ${e}`)
    assert.ok(!/source_fingerprint = NULL/.test(b), `${name} must keep the fingerprint`)
    assert.ok(!/DELETE FROM public\.(interaction_candidates|new_contact_candidates)/.test(b), `${name} never deletes a candidate row`)
  }
})
test('tombstones persist: no function deletes candidate rows; only the connection/state rows are deleted on cleanup', () => {
  const deletes = [...CODE.matchAll(/DELETE FROM public\.(\w+)/g)].map(m => m[1]).sort()
  assert.deepStrictEqual(deletes, ['microsoft_connections', 'microsoft_oauth_states'])
})

// ── Atomic add-both + duplicate recheck ───────────────────────────────────────
console.log('\natomic acceptance')
test('accept_new_contact_candidate locks the candidate, requires open + unexpired, validates before writing', () => {
  const b = fnBody('accept_new_contact_candidate')
  assert.ok(/WHERE id = p_candidate_id AND user_id = v_uid\s+FOR UPDATE/.test(b))
  assert.ok(/IF v_cand\.context_expires_at IS NULL OR v_cand\.context_expires_at <= now\(\) THEN\s+RETURN jsonb_build_object\('result', 'expired'\)/.test(b))
  const firstWrite = b.indexOf('INSERT INTO public.contacts')
  for (const code of ['invalid_name', 'invalid_linkedin_url', 'invalid_type', 'invalid_date', 'invalid_notes', 'duplicate_email', 'expired']) {
    assert.ok(b.indexOf(`'${code}'`) < firstWrite, `${code} must be decided before any write`)
  }
})
test('duplicate email is re-checked under a per-(user,email) advisory lock immediately before the insert', () => {
  const b = fnBody('accept_new_contact_candidate')
  const lock = b.indexOf("pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text || ':' || v_email, 0))")
  const dup = b.indexOf("pg_catalog.lower(pg_catalog.btrim(c.email)) = v_email")
  const ins = b.indexOf('INSERT INTO public.contacts')
  assert.ok(lock !== -1 && dup !== -1 && lock < dup && dup < ins)
  assert.ok(/v_email := pg_catalog\.lower\(pg_catalog\.btrim\(v_cand\.proposed_email\)\)/.test(b), 'email comes from the candidate (provider metadata), never the caller')
  assert.ok(!/p_email/.test(b))
})
test('contact insert and interaction insert share one BEGIN block; any failure rolls both back with a controlled code', () => {
  const b = fnBody('accept_new_contact_candidate')
  const blk = b.slice(b.indexOf('  BEGIN\n    -- user_id is set explicitly'), b.indexOf('  END;', b.indexOf('  BEGIN\n    -- user_id is set explicitly')))
  assert.ok(/INSERT INTO public\.contacts/.test(blk) && /INSERT INTO public\.interactions/.test(blk) && /SET status = 'accepted'/.test(blk))
  assert.ok(/WHEN OTHERS THEN[\s\S]*'write_failed'/.test(blk) && /WHEN deadlock_detected OR serialization_failure THEN[\s\S]*'conflict'/.test(blk))
  assert.ok(/\(v_uid, v_name, p_company, p_role, p_how_met, v_email, p_linkedin_url, p_tags, p_relationship_type, p_relationship_note\)/.test(blk), 'contact uses only user-approved values + provider email + explicit user_id')
  assert.ok(/VALUES \(v_cid, v_uid, v_type, v_date, v_notes, p_follow_up_date, 'outlook'\)/.test(blk), 'interaction provenance outlook + explicit user_id')
  assert.ok(/accepted_contact_id = v_cid,\s+accepted_interaction_id = v_iid/.test(blk))
})
test('accept_/dismiss_interaction_candidate keep the 20260907 bodies exactly, plus only the additive erasure lines', () => {
  for (const name of ['accept_interaction_candidate', 'dismiss_interaction_candidate']) {
    const oldBody = (() => { const i = E2A.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); return E2A.slice(i, E2A.indexOf('\n$$;', i) + 4) })()
    const strip = (s) => s.split('\n').map(l => l.replace(/\s+--.*$/, '').replace(/^\s*--.*$/, '')).filter(l => l.trim() !== '')
    const oldLines = strip(oldBody), newLines = strip(fnBody(name))
    const extra = newLines.filter(l => !oldLines.includes(l))
    const missing = oldLines.filter(l => !newLines.includes(l))
    assert.deepStrictEqual(missing, [], `${name}: lines removed from the applied body`)
    assert.deepStrictEqual(extra.map(l => l.trim()), ['draft_summary = NULL, draft_follow_up = NULL, summary_evidence = NULL, deferred_until = NULL,'], `${name}: unexpected additions`)
  }
})

// ── Lease fencing and cursor rule ─────────────────────────────────────────────
console.log('\nlease fencing, complete-run-only cursor advancement')
test('reservation picks exactly one connection (LIMIT 1), claims both folders under one run id with a guarded upsert, and rolls back a partial claim', () => {
  const b = fnBody('reserve_due_outlook_connection')
  assert.strictEqual((b.match(/LIMIT 1/g) || []).length, 1)
  assert.ok(/\(v_conn, v_uid, 'inbox',\s+'running', v_run/.test(b) && /\(v_conn, v_uid, 'sentitems', 'running', v_run/.test(b))
  assert.ok(/ON CONFLICT \(connection_id, folder\) DO UPDATE[\s\S]*WHERE public\.outlook_sync_state\.sync_status <> 'running'\s+OR public\.outlook_sync_state\.sync_lease_until IS NULL\s+OR public\.outlook_sync_state\.sync_lease_until < now\(\)/.test(b))
  assert.ok(/IF v_n <> 2 THEN[\s\S]*RAISE EXCEPTION 'reservation_lost' USING ERRCODE = 'serialization_failure'/.test(b))
  assert.ok(/WHEN serialization_failure THEN\s+RETURN jsonb_build_object\('result', 'none_due'\)/.test(b))
  assert.ok(/c\.status = 'active'\s+AND c\.needs_reauth IS FALSE\s+AND c\.consented_at IS NOT NULL/.test(b), 'consent required to be due')
  assert.ok(/p_lease_seconds > 600/.test(b) && /p_due_after_seconds > 2592000/.test(b))
})
test('renew/release/invalidate are fenced on sync_run_id = p_run_id AND running AND live lease; renew/release require both rows', () => {
  for (const name of ['renew_outlook_sync_lease', 'release_outlook_sync_lease']) {
    const b = fnBody(name)
    assert.ok(/sync_run_id\s+= p_run_id/.test(b) && /sync_status\s+= 'running'/.test(b), name)
    assert.ok(/RETURN v_n = 2;/.test(b), `${name} both rows`)
    assert.ok(/IF p_run_id IS NULL THEN RETURN false; END IF;/.test(b), `${name} null run`)
  }
  assert.ok(/sync_lease_until > now\(\)/.test(fnBody('renew_outlook_sync_lease')))
  const inv = fnBody('invalidate_outlook_candidates_by_fingerprint')
  assert.ok(/FOR SHARE;/.test(inv) && /count\(\*\) = 2 AND bool_and\(s\.sync_run_id = p_run_id\s+AND s\.sync_status = 'running'\s+AND s\.sync_lease_until IS NOT NULL\s+AND s\.sync_lease_until > now\(\)\)/.test(inv))
  assert.ok(/'stale_run'/.test(inv) && /array_length\(p_fingerprints, 1\) > 500/.test(inv) && /f !~ '\^\[0-9a-f\]\{64\}\$'/.test(inv))
  assert.ok(/r\.episode_fingerprint = ANY \(p_fingerprints\)/.test(inv) && /ic\.status = 'pending'/.test(inv) && /nc\.status IN \('pending', 'deferred'\)/.test(inv), 'positive list, open rows only')
})
test('release advances the encrypted delta links ONLY on a complete run; incomplete/error runs hold the cursor and back off', () => {
  const b = fnBody('release_outlook_sync_lease')
  assert.ok(/v_complete boolean := COALESCE\(p_run_complete, false\)/.test(b))
  assert.ok(/WHEN v_complete AND s\.folder = 'inbox'\s+AND p_inbox_delta_ct\s+IS NOT NULL THEN p_inbox_delta_ct/.test(b))
  assert.ok(/WHEN v_complete AND s\.folder = 'sentitems' AND p_sentitems_delta_ct IS NOT NULL THEN p_sentitems_delta_ct/.test(b))
  assert.ok(/ELSE s\.delta_link_ciphertext END/.test(b) && /ELSE s\.delta_link_nonce END/.test(b))
  assert.ok(/initial_import_done = CASE WHEN v_complete AND COALESCE\(p_initial_done, false\) THEN true ELSE s\.initial_import_done END/.test(b))
  assert.ok(/retry_count\s+= CASE WHEN p_status = 'error' OR NOT v_complete THEN s\.retry_count \+ 1 ELSE 0 END/.test(b))
  assert.ok(/last_success_at\s+= CASE WHEN p_status = 'idle' AND v_complete THEN now\(\) ELSE s\.last_success_at END/.test(b))
  assert.ok(/RAISE EXCEPTION 'invalid_delta_pair'/.test(b) && /p_retry_backoff_seconds > 604800/.test(b))
})
test('outlook_sync_state: running requires run id + lease; one row per (connection, folder)', () => {
  const d = tableDdl('outlook_sync_state')
  assert.ok(/oss_running_requires_lease\s+CHECK \(sync_status <> 'running' OR \(sync_run_id IS NOT NULL AND sync_lease_until IS NOT NULL\)\)/.test(d))
  assert.ok(/oss_connection_folder_unique UNIQUE \(connection_id, folder\)/.test(d))
})

// ── Expiry, cleanup, disconnect ───────────────────────────────────────────────
console.log('\nbounded expiry, cleanup, disconnect')
test('expire_pending_outlook_context is bounded, oldest-first, SKIP LOCKED, shared batch bound, controlled result', () => {
  const b = fnBody('expire_pending_outlook_context')
  assert.ok(/p_batch_size integer DEFAULT 500/.test(b) && /p_batch_size < 1 OR p_batch_size > 5000/.test(b))
  assert.strictEqual((b.match(/ORDER BY context_expires_at, id\s+LIMIT [^\n]*\s+FOR UPDATE SKIP LOCKED/g) || []).length, 2)
  assert.ok(/LIMIT GREATEST\(p_batch_size - v_i, 0\)/.test(b))
  assert.ok(/source = 'outlook'\s+AND status = 'pending'\s+AND context_expires_at IS NOT NULL\s+AND context_expires_at <= now\(\)/.test(b), 'outlook interaction rows only')
  assert.ok(/status IN \('pending', 'deferred'\)\s+AND context_expires_at IS NOT NULL\s+AND context_expires_at <= now\(\)/.test(b))
  assert.ok(/'result', 'ok',\s+'expired', v_i \+ v_c,\s+'batch_size', p_batch_size,\s+'more', v_more/.test(b))
})
test('run_microsoft_local_cleanup scopes every statement to p_user_id and never touches Google, contacts or approved interactions', () => {
  const b = fnBody('run_microsoft_local_cleanup')
  const stmts = [...b.matchAll(/(UPDATE|DELETE FROM) public\.(\w+)[\s\S]*?;/g)]
  assert.deepStrictEqual(stmts.map(m => m[2]), ['interaction_candidates', 'new_contact_candidates', 'microsoft_oauth_states', 'microsoft_connections'])
  for (const m of stmts) assert.ok(/user_id = p_user_id/.test(m[0]), `unscoped: ${m[2]}`)
  assert.ok(/source\s+= 'outlook'\s+AND status\s+= 'pending'/.test(b), 'only pending outlook interaction candidates')
  assert.ok(!/contacts|interactions\b(?!_)/.test(b.replace(/interaction_candidates/g, '')), 'no contact / interaction writes')
})
test('disconnect_my_outlook takes no arguments, uses auth.uid(), delegates to the same cleanup, and is idempotent', () => {
  const b = fnBody('disconnect_my_outlook')
  assert.ok(/FUNCTION public\.disconnect_my_outlook\(\)/.test(b))
  assert.ok(/v_res := public\.run_microsoft_local_cleanup\(v_uid\)/.test(b) && /'not_connected'/.test(b) && /'disconnected'/.test(b))
  assert.ok(!/google|gmail|calendar/i.test(b))
})

// ── Dormancy and scope ────────────────────────────────────────────────────────
console.log('\ndormancy, scope, no provider calls')
test('no Cron, no pg_net, no extension, no scheduler, no DML on user rows, no secrets/flags/OAuth config', () => {
  assert.ok(!/cron\.|pg_cron|pg_net|CREATE EXTENSION|schedule\(/i.test(CODE))
  assert.ok(!/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+public\./m.test(CODE.replace(/CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\n\$\$;/g, '')), 'no apply-time DML outside function bodies')
  assert.ok(!/vault\.|secret_key|client_secret|VITE_|feature_flag/i.test(CODE))
})
test('no Anthropic / Graph / HTTP call and no provider-retention claim in the SQL', () => {
  // Code (comment-stripped) may not call any provider; the header's "NO Graph or Anthropic call" disclaimer is the only
  // Anthropic mention, and the Graph resource URI appears only as the scope-prefix normalization literal (LIKE / substr).
  assert.ok(!/anthropic|login\.microsoftonline|net\.http|http_post|http_get|pg_net|extensions\.http/i.test(CODE))
  assert.strictEqual((SQL.match(/anthropic/gi) || []).length, 1, 'only the header disclaimer mentions the provider')
  const graphLines = CODE.split('\n').filter(l => /graph\.microsoft\.com/.test(l))
  assert.deepStrictEqual(graphLines.map(l => l.trim()), [
    "IF v_norm LIKE 'https://graph.microsoft.com/%' THEN",
    "v_norm := pg_catalog.substr(v_norm, char_length('https://graph.microsoft.com/') + 1);",
  ])
  assert.ok(!/zero data retention|\bZDR\b|retention period|retains? (your|the) (data|content)/i.test(SQL))
  const urls = [...SQL.matchAll(/https?:\/\/[^\s']+/g)].map(m => m[0])
  assert.ok(urls.length > 0 && urls.every(u => u === 'https://%' || u.startsWith('https://(www\\.)?linkedin\\.com/in/') || u.startsWith('https://graph.microsoft.com/')), `unexpected URL: ${urls.join(' ')}`)
})
test('no real email addresses or PII in the migration (only pattern text)', () => {
  assert.ok(!/@(gmail|outlook|hotmail|yahoo|icloud|example\.com)/i.test(SQL))
  assert.ok(!/\b[\w.+-]+@[\w-]+\.(com|org|net|io|edu)\b/i.test(SQL))
})
test('runtime SQL companion covers the required scenarios and uses only example.invalid fixtures', () => {
  for (const s of ['Zero Outlook rows after a clean apply', 'CROSS-USER', 'anon', 'two-user isolation', 'ADD BOTH (atomic)', 'ADD CONTACT ONLY',
    'Consent binding, state lifecycle, permission contract', 'REPLAY', 'UNKNOWN / WRONG-INTEGRATION', 'EXPIRED state', 'WRONG USER',
    'PERMISSION CONTRACT', 'REAUTHORIZATION with a NEW state', 'FAILED FINALIZATION', 'Explicit grant matrix', 'has_column_privilege', 'has_function_privilege',
    'duplicate email refused', 'forced interaction failure', 'NO orphan contact', 'Dismiss / defer / idempotency', 'Lease lifecycle', 'stale run cannot renew',
    'INCOMPLETE release: cursor held', 'COMPLETE release: cursors advance', 'Bounded expiry', 'Outlook disconnect', 'run_microsoft_local_cleanup', 'account deletion',
    'Teardown']) {
    assert.ok(RUNTIME.includes(s), `runtime SQL missing scenario: ${s}`)
  }
  const addrs = [...RUNTIME.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]+/gi)].map(m => m[0])
  assert.ok(addrs.length > 0 && addrs.every(a => a.endsWith('@example.invalid')), `non-example.invalid address: ${addrs.filter(a => !a.endsWith('@example.invalid')).join(', ')}`)
  assert.ok(/RUN ONLY AGAINST A DISPOSABLE LOCAL SUPABASE STACK/.test(RUNTIME))
})
test('PR-A file scope: this migration, this suite, and the runtime SQL only (no function, src, config or policy change)', () => {
  // The suite cannot see git; it pins that the migration does not reference Edge Function or frontend artifacts.
  assert.ok(!/supabase\/functions|src\/|PrivacyPage|config\.toml|vercel\.json/.test(SQL))
})

// ── Consent binding, permission contract, accept-argument ownership ───────────
console.log('\nconsent binding to the OAuth state')
test('microsoft_oauth_states carries NOT NULL consented_at + bounded consent_policy_version, consent precedes expiry, single-use, PKCE-bound, outlook-only', () => {
  const d = tableDdl('microsoft_oauth_states')
  assert.ok(/consented_at\s+timestamptz NOT NULL/.test(d) && /consent_policy_version\s+text\s+NOT NULL/.test(d))
  assert.ok(/microsoft_oauth_states_policy_version_len\s+CHECK \(char_length\(consent_policy_version\) BETWEEN 1 AND 40 AND consent_policy_version !~ '\[\[:cntrl:\]\[:space:\]\]'\)/.test(d))
  assert.ok(/microsoft_oauth_states_consent_before_expiry CHECK \(consented_at <= expires_at\)/.test(d))
  assert.ok(/state_hash\s+text\s+NOT NULL UNIQUE/.test(d) && /consumed_at\s+timestamptz,/.test(d) && /expires_at\s+timestamptz NOT NULL/.test(d))
  assert.ok(/pkce_verifier_ciphertext text\s+NOT NULL/.test(d) && /pkce_verifier_nonce\s+text\s+NOT NULL/.test(d))
  assert.ok(/user_id\s+uuid\s+NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/.test(d))
  assert.ok(!/consent_text|disclosure_text|policy_text/.test(SQL), 'no raw consent text column')
})
test('finalize_microsoft_connection derives user, consent timestamp and version from the locked state — never from arguments', () => {
  const b = fnBody('finalize_microsoft_connection')
  const params = b.slice(0, b.indexOf('RETURNS')).match(/p_\w+/g)
  assert.deepStrictEqual(params, ['p_state_hash', 'p_expected_user_id', 'p_ms_account_id', 'p_ms_tenant_id', 'p_account_type', 'p_ms_email', 'p_scopes',
    'p_token_expires_at', 'p_access_ct', 'p_access_nonce', 'p_refresh_ct', 'p_refresh_nonce', 'p_key_version'])
  assert.ok(!/p_user_id|p_consented_at|p_consent_policy_version|p_status/.test(b), 'no caller-supplied ownership, consent or status')
  assert.ok(/WHERE state_hash = p_state_hash AND integration_type = 'outlook'\s+FOR UPDATE/.test(b), 'state locked, outlook only')
  assert.ok(/IF NOT FOUND THEN RETURN jsonb_build_object\('result', 'unknown_state'\)/.test(b))
  assert.ok(/IF v_state\.consumed_at IS NOT NULL THEN RETURN jsonb_build_object\('result', 'state_consumed'\)/.test(b), 'replay refused')
  assert.ok(/IF v_state\.expires_at <= now\(\) THEN RETURN jsonb_build_object\('result', 'state_expired'\)/.test(b))
  assert.ok(/IF p_expected_user_id IS NOT NULL AND p_expected_user_id <> v_state\.user_id THEN\s+RETURN jsonb_build_object\('result', 'state_user_mismatch'\)/.test(b))
  assert.ok(/v_uid := v_state\.user_id;/.test(b))
  assert.ok(/\(v_uid, p_ms_account_id, p_ms_tenant_id, p_account_type, p_ms_email, v_scopes, 'active',\s+false, v_state\.consented_at, v_state\.consent_policy_version, 'connected',/.test(b), 'consent copied from the state row')
  assert.ok(/consented_at\s+= EXCLUDED\.consented_at,\s+consent_policy_version = EXCLUDED\.consent_policy_version,/.test(b), 'reauth adopts the new state version')
})
test('state consumption happens only after the connection + token writes, in the same transaction, and a consume failure rolls everything back', () => {
  const b = fnBody('finalize_microsoft_connection')
  const conn = b.indexOf('INSERT INTO public.microsoft_connections'), tok = b.indexOf('INSERT INTO public.microsoft_tokens'), consume = b.indexOf('SET consumed_at = now()')
  assert.ok(conn !== -1 && tok !== -1 && consume !== -1 && conn < tok && tok < consume)
  assert.ok(/WHERE id = v_state\.id AND consumed_at IS NULL;\s+GET DIAGNOSTICS v_n = ROW_COUNT;\s+IF v_n <> 1 THEN\s+RAISE EXCEPTION 'state_consume_failed'/.test(b))
  assert.ok(!/EXCEPTION\s+WHEN/.test(b), 'no exception handler swallows a failed write (the whole call rolls back)')
  const firstWrite = b.indexOf('INSERT INTO')
  for (const code of ['invalid_state', 'unknown_state', 'state_consumed', 'state_expired', 'state_user_mismatch', 'consent_missing', 'invalid_account', 'invalid_account_type',
    'invalid_email', 'refresh_token_required', 'missing_mail_read', 'invalid_scopes', 'forbidden_scope', 'different_account']) {
    assert.ok(b.indexOf(`'${code}'`) !== -1 && b.indexOf(`'${code}'`) < firstWrite, `${code} decided before any write`)
  }
})

console.log('\nMicrosoft permission contract')
test('connections store only the canonical normalized scope allowlist; an active connection requires Mail.Read', () => {
  const d = tableDdl('microsoft_connections')
  assert.ok(/microsoft_connections_scopes_allowlist\s+CHECK \(pg_catalog\.array_length\(scopes, 1\) BETWEEN 1 AND 8\s+AND scopes <@ ARRAY\['Mail\.Read', 'offline_access', 'openid', 'email', 'profile'\]::text\[\]\)/.test(d))
  assert.ok(/microsoft_connections_active_requires_mail_read\s+CHECK \(status <> 'active' OR 'Mail\.Read' = ANY \(scopes\)\)/.test(d))
  assert.ok(!/ReadWrite|Mail\.Send|MailboxSettings|Files\.|Contacts\.|Calendars\.|\.default|\.All\b|ReadBasic/.test(d.replace(/--.*/g, '')), 'no broader scope named in the DDL')
})
test('finalization normalizes documented equivalent spellings and refuses everything outside the allowlist', () => {
  const b = fnBody('finalize_microsoft_connection')
  assert.ok(/v_norm := pg_catalog\.lower\(pg_catalog\.btrim\(v_raw\)\)/.test(b), 'trim + lowercase')
  assert.ok(/IF v_norm LIKE 'https:\/\/graph\.microsoft\.com\/%' THEN\s+v_norm := pg_catalog\.substr\(v_norm, char_length\('https:\/\/graph\.microsoft\.com\/'\) \+ 1\)/.test(b), 'resource-prefix normalization')
  const cases = [...b.matchAll(/WHEN '([a-z_.]+)'\s+THEN '([A-Za-z_.]+)'/g)].map(m => [m[1], m[2]])
  assert.deepStrictEqual(cases, [['mail.read', 'Mail.Read'], ['offline_access', 'offline_access'], ['openid', 'openid'], ['email', 'email'], ['profile', 'profile']])
  assert.ok(/ELSE NULL END;/.test(b) && /IF v_norm IS NULL THEN RETURN jsonb_build_object\('result', 'forbidden_scope'\)/.test(b), 'unknown → forbidden_scope')
  assert.ok(/IF NOT \('Mail\.Read' = ANY \(v_scopes\)\) THEN\s+RETURN jsonb_build_object\('result', 'missing_mail_read'\)/.test(b))
  assert.ok(/array_length\(p_scopes, 1\) > 16/.test(b) && /char_length\(v_norm\) > 200/.test(b), 'bounded input')
  assert.ok(!/SQLERRM|error_description|error_message/.test(b), 'no provider/db error text')
})

console.log('\naccept RPC argument ownership')
test('accept_new_contact_candidate accepts only user-editable values + the add-both choice; ownership, status, source, fingerprints, expiry, ids and evidence are never caller-controlled', () => {
  const b = fnBody('accept_new_contact_candidate')
  const params = b.slice(0, b.indexOf('RETURNS')).match(/p_\w+/g)
  assert.deepStrictEqual(params, ['p_candidate_id', 'p_name', 'p_company', 'p_role', 'p_how_met', 'p_linkedin_url', 'p_tags', 'p_relationship_type', 'p_relationship_note',
    'p_create_interaction', 'p_interaction_type', 'p_interaction_date', 'p_interaction_notes', 'p_follow_up_date'])
  for (const forbidden of ['p_user_id', 'p_email', 'p_status', 'p_source', 'p_fingerprint', 'p_person_fingerprint', 'p_episode_fingerprint', 'p_key_version',
    'p_context_expires_at', 'p_accepted_contact_id', 'p_accepted_interaction_id', 'p_ms_', 'p_evidence', 'p_confidence', 'p_extraction_status']) {
    assert.ok(!b.includes(forbidden), `${forbidden} must not be an argument`)
  }
  // Email decision: NOT editable at acceptance — the locked candidate value (Microsoft envelope metadata) is used.
  assert.ok(/v_email := pg_catalog\.lower\(pg_catalog\.btrim\(v_cand\.proposed_email\)\)/.test(b))
  assert.ok(/INSERT INTO public\.contacts\s+\(user_id, name, company, role, how_met, email, linkedin_url, tags, relationship_type, relationship_note\)\s+VALUES\s+\(v_uid, v_name, p_company, p_role, p_how_met, v_email, p_linkedin_url, p_tags, p_relationship_type, p_relationship_note\)/.test(b))
  assert.ok(/status = 'accepted',\s+accepted_contact_id = v_cid,\s+accepted_interaction_id = v_iid,/.test(b), 'status and ids set by the RPC only')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
