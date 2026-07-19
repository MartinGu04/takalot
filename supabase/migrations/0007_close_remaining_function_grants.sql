-- מעקב תקלות — forward migration.
-- Completes the work 0005 scoped out: 0005 fixed the three write RPCs it
-- reviewed (create_incident/update_incident/close_incident) and explicitly
-- noted that every OTHER function 0003 meant to restrict "remains open; a
-- follow-up migration should address them individually." This is that
-- migration, required for the production transition: with real
-- unauthenticated visitors, `anon` must be rejected at the privilege
-- boundary -- not merely by the in-function role checks -- and helper
-- functions like write_audit (SECURITY DEFINER: it inserts audit rows as
-- the definer, bypassing RLS) must not be callable by anon at all, or an
-- unauthenticated caller could pollute the append-only audit log directly.
--
-- 0001-0006 are untouched. This is an ADDITIVE migration.
--
-- Each revoke targets BOTH `public` and `anon` on the exact existing
-- signature: depending on the default ACL in force when each function was
-- created, its executable-by-unauthenticated status may come from the
-- implicit PUBLIC grant, from an explicit anon grant, or both -- revoking
-- both covers every case, and revoking a grant that does not exist is a
-- harmless no-op.

-- ===== 1. Lifecycle / handover / export / admin RPCs (the API surface
-- 0003 granted to authenticated; the three from 0005 are already done) =====
revoke execute on function public.acknowledge_incident(uuid, int) from public, anon;
revoke execute on function public.technician_update_incident(uuid, jsonb) from public, anon;
revoke execute on function public.assign_incident(uuid, jsonb) from public, anon;
revoke execute on function public.reopen_incident(uuid, jsonb) from public, anon;
revoke execute on function public.add_incident_correction(uuid, jsonb) from public, anon;
revoke execute on function public.complete_follow_up(uuid, text) from public, anon;
revoke execute on function public.create_handover(jsonb) from public, anon;
revoke execute on function public.accept_handover(uuid) from public, anon;
revoke execute on function public.add_handover_addendum(uuid, text) from public, anon;
revoke execute on function public.record_export(text, text) from public, anon;
revoke execute on function public.can_export() from public, anon;
revoke execute on function public.my_role() from public, anon;
revoke execute on function public.admin_set_user_role(uuid, app_role) from public, anon;
revoke execute on function public.admin_set_user_active(uuid, boolean) from public, anon;
revoke execute on function public.admin_create_placeholder_profile(text, app_role) from public, anon;

-- ===== 2. Internal helpers -- never part of the client API at all =====
-- write_audit is the critical one (SECURITY DEFINER insert into the
-- append-only audit log); the rest are defense-in-depth. They are all
-- invoked either inside SECURITY DEFINER RPC bodies (which execute as the
-- function owner, who always retains EXECUTE on own functions) or by RLS
-- policies (see section 3), so nothing legitimate needs a broad grant.
-- `authenticated` is revoked here too: depending on the default ACL in
-- force at each function's creation, authenticated may hold an EXPLICIT
-- grant on these internals -- a signed-in user must not be able to call
-- write_audit or the locking/numbering helpers directly any more than an
-- anonymous one. The one internal helper signed-in users genuinely need
-- (is_active_member, evaluated inside RLS policy expressions with the
-- querying user's privileges) is explicitly re-granted in section 3.
revoke execute on function public.current_role_of(uuid) from public, anon, authenticated;
revoke execute on function public.is_operational_role() from public, anon, authenticated;
revoke execute on function public.write_audit(text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.allocate_incident_number() from public, anon, authenticated;
revoke execute on function public.is_valid_transition(incident_status, incident_status) from public, anon, authenticated;
revoke execute on function public.assert_owner_valid(uuid) from public, anon, authenticated;
revoke execute on function public.lock_incident_checked(uuid, int) from public, anon, authenticated;
revoke execute on function public.is_active_member() from public, anon, authenticated;

-- Trigger/housekeeping functions: triggers fire without an EXECUTE check on
-- the invoking user, so revoking breaks nothing while removing the ability
-- to call them directly.
revoke execute on function public.reject_mutation() from public, anon, authenticated;
revoke execute on function public.protect_accepted_handover() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.refresh_incident_search_text() from public, anon, authenticated;

-- ===== 3. Authenticated grants: restated in full =====
-- The complete intended API surface for signed-in users (0003's list; the
-- three 0005 RPCs are restated in 0005 itself). Idempotent where a grant
-- already exists.
grant execute on function public.acknowledge_incident(uuid, int) to authenticated;
grant execute on function public.technician_update_incident(uuid, jsonb) to authenticated;
grant execute on function public.assign_incident(uuid, jsonb) to authenticated;
grant execute on function public.reopen_incident(uuid, jsonb) to authenticated;
grant execute on function public.add_incident_correction(uuid, jsonb) to authenticated;
grant execute on function public.complete_follow_up(uuid, text) to authenticated;
grant execute on function public.create_handover(jsonb) to authenticated;
grant execute on function public.accept_handover(uuid) to authenticated;
grant execute on function public.add_handover_addendum(uuid, text) to authenticated;
grant execute on function public.record_export(text, text) to authenticated;
grant execute on function public.can_export() to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.admin_set_user_role(uuid, app_role) to authenticated;
grant execute on function public.admin_set_user_active(uuid, boolean) to authenticated;
grant execute on function public.admin_create_placeholder_profile(text, app_role) to authenticated;

-- CRITICAL, easy to miss: is_active_member() and my_role() are evaluated
-- INSIDE row-level-security policy expressions, and policy expressions run
-- with the privileges of the QUERYING user -- not the table owner. Until
-- now authenticated users could call is_active_member() only through the
-- broad grants this migration removes; without this explicit grant, every
-- SELECT on profiles/incidents/handovers/etc. would fail with
-- "permission denied for function is_active_member" for every signed-in
-- user. (my_role() is likewise used by the audit/app_policy/config
-- policies and is restated above.)
grant execute on function public.is_active_member() to authenticated;

-- anon deliberately ends with NO function grants in this schema: an
-- unauthenticated session has no legitimate database call to make. Note
-- this also means anon table reads now fail at the policy expression
-- (permission denied on is_active_member) instead of returning zero rows
-- -- fail-closed, and the client makes no unauthenticated queries.
--
-- service_role is deliberately not granted anything here either, for the
-- reason established in 0005 section 3: this codebase has no server-side
-- component that calls these RPCs as service_role. If one is added later,
-- that change should bring its own explicit grants.
