-- מעקב תקלות — forward migration.
-- Linked-personnel management ceilings for the "כוח אדם" (personnel) page.
-- admin_set_user_role / admin_set_user_active were system_admin-only and,
-- even for system_admin, allowed a caller to change their OWN role or
-- deactivate themselves (only "another" system_admin was protected). This
-- migration replaces both bodies so that -- a STRICT hierarchy, not a
-- peer-level one:
--
--   * shift_supervisor      may manage technician, viewer;
--   * professional_manager  may manage shift_supervisor, technician, viewer;
--   * system_admin          may manage every role, including system_admin;
--   * technician / viewer   may manage nobody.
--
-- Neither non-admin rank may manage a PEER of its own rank: a
-- shift_supervisor may NOT manage another shift_supervisor, and a
-- professional_manager may NOT manage another professional_manager --
-- only system_admin reaches system_admin. 'viewer' is included as a
-- manageable lower role for both non-admin ranks (this replaces an
-- earlier revision of this migration, never applied to hosted, that
-- reused 0008's assignment ceiling directly -- which allowed
-- peer-management and excluded 'viewer' entirely; see role_ceiling_allows_manage
-- below, a NEW function dedicated to this policy).
--
-- role_ceiling_allows_manage is deliberately a SEPARATE function from
-- 0008's role_ceiling_allows_assign (which governs registering a NEW
-- pending-personnel entry), even though the two matrices are identical
-- today -- so the assignment policy and the linked-management policy can
-- diverge independently later without one edit silently affecting the
-- other.
--
--   * no caller may change their own role or deactivate themselves --
--     unconditionally, even system_admin;
--   * no caller may manage a profile whose CURRENT role, or the requested
--     NEW role, is above their own ceiling;
--   * the last remaining ACTIVE system_admin can be neither demoted nor
--     deactivated (by anyone, including another system_admin) -- there
--     must always be at least one way back into administration;
--   * every change is audited, exactly as before.
--
-- ===== Concurrency (revised) =====
-- The first version of this migration read the target profile with a
-- plain (unlocked) SELECT before checking the ceiling and writing the
-- change. That is a genuine TOCTOU: nothing stopped a second, concurrent
-- admin_set_user_role/admin_set_user_active call from changing the SAME
-- target's role between this transaction's read and its write, so the
-- ceiling check and the last-admin guard could both be evaluated against
-- data that was no longer true by the time the UPDATE ran -- e.g. a
-- shift_supervisor's ceiling check could pass while the target was still
-- a technician, and then, after a concurrent system_admin promotion the
-- shift_supervisor's transaction never re-observed, silently overwrite
-- that promotion with its own (in-ceiling-at-read-time) change. Locking
-- only the "active system_admin" row set (the first version's approach,
-- for the last-admin guard alone) does not close this: it does nothing
-- for non-admin targets, and for admin targets it introduces its OWN
-- hazard -- two administrators concurrently managing EACH OTHER each lock
-- their own target row first, then both try to additionally lock the
-- other's row as part of "all active admins", waiting on each other in
-- opposite order: a deadlock.
--
-- Both functions now acquire a single, always-identical advisory
-- transaction lock (pg_advisory_xact_lock) BEFORE reading the target row
-- at all, and hold it until commit. This closes the TOCTOU completely --
-- no second call to either function can run any part of its body while
-- this transaction holds the lock, so the target row this transaction
-- reads cannot change out from under it for the rest of the transaction
-- -- and it is structurally deadlock-free: there is exactly one lock
-- resource in this class, acquired before any row is touched, so two
-- concurrent callers can only ever be in "acquired" or "waiting for the
-- single lock" states, never each holding something the other needs
-- (the precondition for a deadlock). The tradeoff is that ALL personnel
-- role/activation writes serialize globally rather than only when their
-- targets conflict; this operation is low-frequency (administrator
-- action, not a request-path hot path), so that tradeoff is deliberate.
-- Both functions share the SAME lock key so a concurrent
-- admin_set_user_role and admin_set_user_active call also serialize
-- against each other, since the last-admin invariant spans both.
--
-- A SECOND, easy-to-miss instance of the same staleness class: the
-- caller's OWN role/active status must also be read AFTER acquiring the
-- lock, not before. A naive `v_actor_role := my_role()` in the DECLARE
-- section runs at function entry -- before this transaction even
-- attempts the lock -- so a session queued behind another one can be
-- unblocked holding a role snapshot from before it waited, including one
-- that no longer reflects reality (e.g. the very transaction it was
-- queued behind just deactivated IT). Concretely: with exactly two
-- active admins X and Y, X deactivates Y while Y concurrently
-- deactivates X -- if X's role were captured before the lock, X's
-- transaction (unblocked second, after Y already deactivated X) would
-- still believe it was an authorized active admin and complete the
-- deactivation of Y, leaving ZERO active admins. Both functions now
-- resolve v_actor_role via an explicit call AFTER the lock is held, so a
-- caller deactivated by the transaction it just waited behind correctly
-- loses authorization for its own still-pending call.
-- (Verified locally with real two- and three-session concurrent runs,
-- including the exactly-two-active-admins mutual-deactivation case that
-- exposed this second bug -- see the verification report.)
--
-- Grants for admin_set_user_role/admin_set_user_active are unchanged:
-- both were already granted to authenticated (0003, restated in 0007)
-- and CREATE OR REPLACE preserves existing grants for an unchanged
-- signature. role_ceiling_allows_manage is a NEW function added below and
-- is granted/revoked explicitly, mirroring role_ceiling_allows_assign in
-- 0008 (internal only -- no client role may call it directly).
--
-- 0001-0009 are untouched. This is an ADDITIVE migration. This file has
-- never been applied to any hosted database, so it is revised IN PLACE
-- rather than superseded by a new migration.

-- ===== Role ceiling for MANAGEMENT (internal helper) =====
-- Who may edit the role of / activate / deactivate an ALREADY-LINKED
-- profile. See the header for the matrix and why this is a separate
-- function from 0008's role_ceiling_allows_assign.
create or replace function public.role_ceiling_allows_manage(p_actor public.app_role, p_target public.app_role) returns boolean
language sql immutable set search_path = '' as $$
  select case p_actor
    when 'system_admin' then true
    when 'professional_manager' then p_target in ('shift_supervisor', 'technician', 'viewer')
    when 'shift_supervisor' then p_target in ('technician', 'viewer')
    else false
  end;
$$;
revoke execute on function public.role_ceiling_allows_manage(public.app_role, public.app_role) from public, anon, authenticated;

create or replace function public.admin_set_user_role(p_user_id uuid, p_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles;
  v_active_admins int;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן לשנות את התפקיד של עצמך';
  end if;

  -- Serialize every personnel role/activation write on one lock, BEFORE
  -- reading anything -- see the header for why this closes the TOCTOU and
  -- cannot deadlock.
  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  -- Resolve the CALLER's own authorization only after the lock is held
  -- (see header) -- not in DECLARE, which would run before this
  -- transaction even attempts the lock.
  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  -- The ceiling must cover BOTH the profile's current role and the
  -- requested new role -- otherwise a lower manager could take over a
  -- profile above their reach, or hand it a role above their reach.
  if not public.role_ceiling_allows_manage(v_actor_role, v_target.role)
     or not public.role_ceiling_allows_manage(v_actor_role, p_role) then
    raise exception 'permission: אין הרשאה לנהל משתמש בתפקיד זה';
  end if;

  -- The last ACTIVE system_admin may not be demoted by anyone. Safe to
  -- count without an additional lock: the advisory lock above already
  -- guarantees no other call in this function class can be concurrently
  -- in flight.
  if v_target.role = 'system_admin' and v_target.active and p_role <> 'system_admin' then
    select count(*) into v_active_admins from public.profiles where role = 'system_admin' and active;
    if v_active_admins <= 1 then
      raise exception 'validation: לא ניתן להוריד בדרגה את מנהל המערכת הפעיל האחרון';
    end if;
  end if;

  update public.profiles set role = p_role where id = p_user_id;
  perform public.write_audit('user_role_changed', 'profile', p_user_id::text, null,
    jsonb_build_object('role', v_target.role), jsonb_build_object('role', p_role));
end;
$$;

create or replace function public.admin_set_user_active(p_user_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles;
  v_active_admins int;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן לשנות את הסטטוס של עצמך';
  end if;

  -- Same lock, same reasoning as admin_set_user_role -- and the SAME key,
  -- so a concurrent role change and activation change on related targets
  -- also serialize against each other.
  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  -- Resolve the CALLER's own authorization only after the lock is held --
  -- see admin_set_user_role and the header for why.
  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  if not public.role_ceiling_allows_manage(v_actor_role, v_target.role) then
    raise exception 'permission: אין הרשאה לנהל משתמש בתפקיד זה';
  end if;

  -- The last ACTIVE system_admin may not be deactivated by anyone.
  if not p_active and v_target.role = 'system_admin' and v_target.active then
    select count(*) into v_active_admins from public.profiles where role = 'system_admin' and active;
    if v_active_admins <= 1 then
      raise exception 'validation: לא ניתן להשבית את מנהל המערכת הפעיל האחרון';
    end if;
  end if;

  update public.profiles set active = p_active where id = p_user_id;
  perform public.write_audit(case when p_active then 'user_activated' else 'user_deactivated' end,
    'profile', p_user_id::text);
end;
$$;
