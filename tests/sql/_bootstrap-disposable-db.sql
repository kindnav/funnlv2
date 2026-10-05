-- Bootstrap for a DISPOSABLE LOCAL verification database. NEVER run against
-- Production, and nothing here belongs in supabase/migrations/.
--
-- WHY THIS EXISTS
-- The SQL runtime tests in this directory need a database that behaves like the
-- project's: the real `anon`, `authenticated` and `service_role` roles, the real
-- `auth.uid()`, the real default privileges, and the repo's own migrations
-- applied in order. Running them against a plain `postgres` image with
-- hand-written stubs proves much less, because the roles and grants are the
-- thing under test.
--
-- HOW TO BUILD THE DATABASE (Docker; the image is the project's own)
--
--   docker network create funnl-net
--   docker run -d --name funnl-pg --network funnl-net \
--     -e POSTGRES_PASSWORD=disposable -p 55432:5432 \
--     public.ecr.aws/supabase/postgres:17.6.1.140
--
--   # 1. this file
--   docker exec -i funnl-pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f - < tests/sql/_bootstrap-disposable-db.sql
--
--   # 2. every migration, in filename order
--   for f in supabase/migrations/*.sql; do
--     docker exec -i funnl-pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < "$f"
--   done
--
--   # 3. any runtime test in this directory
--   docker exec -i funnl-pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f - < tests/sql/outlook-disconnect-runtime.sql
--
--   docker rm -f funnl-pg     # when finished
--
-- WHAT THIS SHIMS, AND WHY THAT IS HONEST TO DISCLOSE
-- The `supabase/postgres` image ships an older GoTrue `auth.users` that has
-- `confirmed_at` but not `email_confirmed_at`. Current GoTrue, and therefore the
-- real project, has `email_confirmed_at`, and migration 20260727000000
-- (`add_pro_trials`) reads it. One column is added below so that migration
-- applies. That is a shim for an image-version difference, not a schema change:
-- nothing in supabase/migrations/ is edited, and the column matches the name and
-- type the live schema uses.
--
-- WHAT IT DOES NOT AND CANNOT REPRODUCE
--   * GoTrue itself: no sign-up, no password, no session issuance.
--   * The exact `auth.uid()` body deployed in Production. This image's version
--     reads the SINGULAR legacy claim `request.jwt.claim.sub`; Production's reads
--     the JSON form, `request.jwt.claims ->> 'sub'`, which is what PostgREST v14
--     actually sets. Two remedies, and which one applies depends on the harness:
--       - a harness that issues its own SQL can set the claim in the form this
--         definition reads; see tests/local/outlook-rpc-postgrest.mjs, which states
--         that limit where it matters;
--       - a harness driven through a BROWSER cannot. supabase-js sends a JWT and
--         PostgREST decides the claim form, so there is no place to set the
--         singular one. Such a harness must instead REDEFINE auth.uid() to read
--         the JSON form, i.e. to match Production. Without that, auth.uid() is
--         NULL for every request, RLS hides every row, and the application renders
--         as though the session had expired - which looks like a product defect and
--         is not one. tests/local/outlook-pilot-browser.mjs does exactly this and
--         says so where it does it.
--   * Kong's `apikey` gateway check, and GoTrue's own session issuance - a browser
--     harness has to stand in a local sink for the `/auth/v1/*` endpoints.
--
-- A BROWSER PASS IS POSSIBLE AGAINST THIS BOOTSTRAP, with those two substitutions,
-- and tests/local/outlook-pilot-browser.mjs is one. What stays out of reach is
-- Production itself: the hosted GoTrue, Kong, and the deployed Edge Functions.

-- `auth.users` is owned by supabase_auth_admin, not postgres, in this image and
-- in a real project, and `postgres` may not SET ROLE to it. This file must
-- therefore be run as the superuser `supabase_admin` (see step 1 above); every
-- migration and every runtime test afterwards runs as `postgres`, as it would in
-- the real project.

-- ── the GoTrue column difference described above ─────────────────────────────
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;

-- ── two fixture users, referenced by every runtime test in this directory ────
-- The tests use these fixed ids so their assertions read clearly. Inserted
-- directly because GoTrue is not running; `instance_id` and `aud`/`role` carry
-- the values GoTrue would set.
INSERT INTO auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000',
   '11111111-1111-1111-1111-111111111111',
   'authenticated', 'authenticated', 'u1@example.test', now(), now(), now()),
  ('00000000-0000-0000-0000-000000000000',
   '22222222-2222-2222-2222-222222222222',
   'authenticated', 'authenticated', 'u2@example.test', now(), now(), now())
ON CONFLICT (id) DO NOTHING;
