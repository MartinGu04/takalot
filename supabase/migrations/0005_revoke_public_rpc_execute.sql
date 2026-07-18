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
-- (the ones directly relevant to this PR's review), plus the future-object
-- default (section 4) which covers every function ANY later migration
-- creates as the same role. The same PUBLIC-grant gap almost certainly
-- affects every EXISTING function 0003 tried to restrict to `authenticated`
-- (acknowledge_incident, technician_update_incident, assign_incident,
-- reopen_incident, add_incident_correction, complete_follow_up,
-- create_handover, accept_handover, add_handover_addendum, record_export,
-- can_export, my_role, admin_set_user_role, admin_set_user_active,
-- admin_create_placeholder_profile) -- those pre-existing functions are
-- intentionally NOT touched here (out of scope for this PR's review) and
-- remain open; a follow-up migration should explicitly revoke PUBLIC/anon
-- on each of them individually, the same way section 1 below does for the
-- three in scope. Section 4 only prevents this from recurring going
-- forward -- it is not retroactive.

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

-- ===== 3. service_role: NOT granted -- no real use for it in this codebase =====
-- service_role is not a superuser, and BYPASSRLS only bypasses Row Level
-- Security -- not the ordinary GRANT/REVOKE privilege system -- so in
-- principle it would need its own EXECUTE grant like any other role, same
-- as authenticated above, REGARDLESS of whatever access it may already
-- have through Supabase's platform-level bootstrapping for `postgres`-
-- created functions (which is independent of, and unaffected by, the
-- PUBLIC/anon revokes in section 1).
--
-- Checked this codebase for an actual reason to grant it: there is no
-- `supabase/functions` directory (no Edge Functions), no server-side code
-- anywhere in this repo that authenticates as service_role, and
-- `src/data/supabase/supabaseRepository.ts` -- the only Supabase client in
-- the codebase -- is constructed with the anon key only (README.md is
-- explicit: "Never put a service-role key in client env vars"). There is
-- currently no real backend/admin use case that would call these RPCs as
-- service_role, so nothing is granted here. If a future Edge Function or
-- server-side admin task needs to call these RPCs directly (rather than
-- going through the normal authenticated user flow), that migration should
-- add the grant explicitly at that time, alongside the code that needs it.

-- ===== 4. Preventing the same default-PUBLIC-EXECUTE gap for FUTURE
-- functions =====
-- The schema-scoped form:
--   alter default privileges for role postgres in schema public
--     revoke execute on functions from public;
-- was tried first and verified empirically to be a NO-OP for this specific
-- case (revoking down to fully empty within an IN SCHEMA-scoped default ACL
-- produced zero rows in pg_default_acl, and a function created afterwards
-- still had has_function_privilege('public', ..., 'execute') = true).
--
-- The GLOBAL form below (no IN SCHEMA) is different and does work, as
-- documented behavior and as verified empirically here: it records a real
-- pg_default_acl row (namespace = NULL, i.e. applies regardless of schema)
-- whose ACL is exactly `{postgres=X/postgres}` -- owner only, no PUBLIC
-- entry -- and a function created afterwards correctly has
-- has_function_privilege('public', ..., 'execute') = false. Confirmed via
-- proacl on the new function directly (non-NULL, matching that same ACL,
-- not the hardcoded owner+PUBLIC default).
--
-- Scope: this affects every function subsequently created BY the
-- `postgres` role (confirmed via pg_get_userbyid(proowner) to be the actual
-- owner/creator of all three existing RPCs, and the role Supabase's
-- migration tooling runs as), in ANY schema (global, not just `public`,
-- since the working form has no IN SCHEMA clause -- Postgres does not offer
-- a schema-scoped variant that behaves this way for functions). It does
-- NOT retroactively change any existing function: the three RPCs in scope
-- are fixed explicitly in section 1, and every other pre-existing function
-- in this schema (listed at the top of this file) keeps its current PUBLIC
-- grant until a separate migration revokes it individually. It does not
-- affect tables or sequences. It does not affect any role other than
-- `postgres` -- if a future migration is ever applied under a different
-- role (e.g. `supabase_admin`), this rule will not apply to functions that
-- migration creates and would need to be restated for that role.
alter default privileges for role postgres
  revoke execute on functions from public;
