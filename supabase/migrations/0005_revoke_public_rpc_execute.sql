-- מעקב תקלות — forward migration.
-- Closes a pre-existing gap surfaced by hosted verification of PR #3:
-- 0003_rls.sql's "revoke execute on all functions in schema public from
-- anon" never revoked the implicit EXECUTE-TO-PUBLIC grant Postgres adds by
-- default when a function is created -- so `anon` (and any unauthenticated
-- caller) has been able to invoke these write RPCs the whole time,
-- regardless of that revoke, because `anon` inherits execute through
-- membership in PUBLIC independent of any grant/revoke targeting it by
-- name. This predates PR #3 and is unrelated to its diff, but is fixed here
-- rather than merging PR #3 with it knowingly left open.
--
-- This is an ADDITIVE migration. 0001-0004 are untouched.
--
-- Scope note: this migration only touches the three write RPCs named below
-- (the ones directly relevant to this PR's review). The same PUBLIC-grant
-- gap almost certainly affects every other function 0003 tried to restrict
-- to `authenticated` (acknowledge_incident, technician_update_incident,
-- assign_incident, reopen_incident, add_incident_correction,
-- complete_follow_up, create_handover, accept_handover,
-- add_handover_addendum, record_export, can_export, my_role,
-- admin_set_user_role, admin_set_user_active,
-- admin_create_placeholder_profile) -- those are intentionally NOT touched
-- here and remain open; a follow-up migration should address them.

-- ===== 1. Revoke PUBLIC execute on the exact existing signatures =====
-- (anon is also revoked explicitly, redundantly with PUBLIC, purely so the
-- intended access model is legible from this migration without having to
-- know the PUBLIC-inheritance mechanics above.)
revoke execute on function public.create_incident(jsonb) from public;
revoke execute on function public.update_incident(uuid, jsonb) from public;
revoke execute on function public.close_incident(uuid, jsonb) from public;

revoke execute on function public.create_incident(jsonb) from anon;
revoke execute on function public.update_incident(uuid, jsonb) from anon;
revoke execute on function public.close_incident(uuid, jsonb) from anon;

-- ===== 2. Explicitly (re-)affirm authenticated access =====
-- 0003 already granted this, and CREATE OR REPLACE FUNCTION (used by 0004)
-- does not drop a function's existing grants -- so this was never actually
-- lost. Restated here anyway so the intended access model is fully visible
-- from this one migration, and so this remains correct even if a future
-- migration replaces these functions again.
grant execute on function public.create_incident(jsonb) to authenticated;
grant execute on function public.update_incident(uuid, jsonb) to authenticated;
grant execute on function public.close_incident(uuid, jsonb) to authenticated;

-- ===== 3. service_role: deliberately NOT granted here =====
-- service_role is not a superuser, and BYPASSRLS only bypasses Row Level
-- Security -- not the ordinary GRANT/REVOKE privilege system -- so in
-- principle it needs its own EXECUTE grant like any other role, same as
-- authenticated does above.
--
-- In practice, Supabase-hosted projects bootstrap `service_role` at the
-- platform level (outside this repo's migrations) with something
-- equivalent to:
--   alter default privileges for role postgres in schema public
--     grant all on functions to service_role;
-- which applies to every function `postgres` creates in `public` from then
-- on -- including these three, since 0002/0004 create them as `postgres`.
-- That grant is independent of, and unaffected by, the PUBLIC/anon revokes
-- in section 1 above.
--
-- Rather than assume this and grant redundantly (or assume it and grant
-- nothing, leaving a real gap if the assumption is wrong), this was left
-- for empirical verification: verify_grants_dashboard.sql's service_role
-- diagnostic rows report its actual current execute status and whether
-- that access is explicit/default-derived/absent. If those rows show
-- service_role does NOT already have execute after this migration applies,
-- a follow-up migration should add:
--   grant execute on function public.create_incident(jsonb) to service_role;
--   grant execute on function public.update_incident(uuid, jsonb) to service_role;
--   grant execute on function public.close_incident(uuid, jsonb) to service_role;

-- ===== 4. Preventing the same default-PUBLIC-EXECUTE gap for FUTURE
-- functions: investigated, and NOT applied here, because it does not work.
-- =====
-- The obvious approach --
--   alter default privileges for role postgres in schema public
--     revoke execute on functions from public;
-- -- was tried and then verified empirically (against a real local Postgres
-- 16 instance, not just read from docs) to have NO effect: a revoke that
-- reduces a role's default ACL for a given (role, schema, object type) down
-- to fully empty is not stored as an "empty" override -- Postgres deletes
-- the pg_default_acl row entirely instead, which makes it indistinguishable
-- from "no default privileges ever configured", so every subsequently
-- created function still falls back to Postgres's hardcoded initial
-- privilege rule for functions: owner gets everything, PUBLIC gets EXECUTE.
-- Confirmed three ways: `\ddp` / a direct `pg_default_acl` query showed
-- zero rows immediately after the REVOKE ran (no error, but nothing
-- persisted); a function created afterwards still had
-- has_function_privilege('public', ..., 'execute') = true; and the new
-- function's raw `proacl` was NULL (Postgres's marker for "use the
-- hardcoded default", not an empty/customized ACL).
--
-- ALTER DEFAULT PRIVILEGES can only ever ADD grantees beyond the hardcoded
-- default for functions -- it cannot be used to make the baseline more
-- restrictive than "PUBLIC has EXECUTE". There is no schema-level or
-- role-level Postgres setting that closes this for future objects.
--
-- The only reliable mitigation is a written convention, not a migration:
-- every future migration that defines a function not meant to be
-- universally callable must include its own explicit
-- `revoke execute on function <exact signature> from public;`
-- (and `from anon` for clarity, same as section 1 above) immediately after
-- defining it -- exactly the pattern this migration uses for the three RPCs
-- in scope, and the pattern 0003_rls.sql should have used from the start.
