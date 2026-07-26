-- מעקב תקלות — admin_delete_user (server-side user deletion, database half)
--
-- This RPC performs ONLY the database half of user deletion: tombstoning
-- the profile (deactivate + deleted_at/deleted_by), reusing the exact
-- authorization rules already proven for admin_set_user_role/
-- admin_set_user_active (0010) on top of the tombstone foundation from
-- 0012. It does NOT delete the Supabase Auth account -- that is a
-- separate, second step performed server-side by the delete-user Edge
-- Function (supabase/functions/delete-user/), using the service-role key,
-- which never reaches this database or the browser.
--
-- Because this RPC can only prove the PROFILE was tombstoned, never that
-- the Auth account was actually removed, its audit action is
-- 'user_tombstoned' -- not 'user_deleted'. A second, more complex
-- audit-completion mechanism proving both halves finished is explicitly
-- out of scope for this PR.
--
-- Idempotent, but ONLY after authorization is established: an
-- unauthenticated caller, a caller managing above their role ceiling, or
-- a caller targeting the last active system_admin is rejected regardless
-- of the target's current state -- probing a deleted user's id can never
-- leak a false "success" to someone who isn't allowed to manage it. Only
-- once every permission check has passed does an already-tombstoned
-- target short-circuit to a successful no-op. This is what lets the Edge
-- Function safely retry the WHOLE flow (this RPC, then the Auth-delete
-- step) if the Auth-delete step failed on a previous attempt, and what
-- makes two authorized deletion requests racing the same target safe: the
-- advisory lock below serializes them, and the second one to acquire it
-- simply finds the target already tombstoned and no-ops.
--
-- Open-incident guard: a deleted person may not remain the owner of an
-- open incident. Reassignment is NOT built here -- the caller must
-- reassign via the EXISTING assign_incident RPC first. Every actor who
-- can pass the role-ceiling check below is, by construction, one of
-- system_admin/professional_manager/shift_supervisor -- exactly
-- is_operational_role()'s set -- so anyone authorized to delete a target
-- is already authorized to call assign_incident on that target's
-- incidents; no permission gap exists between the two RPCs.
create or replace function public.admin_delete_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles;
  v_active_admins int;
  v_open_incidents int;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן למחוק את עצמך';
  end if;

  -- Same lock, same key, same ordering discipline as
  -- admin_set_user_role/admin_set_user_active: every personnel management
  -- write serializes here BEFORE resolving anything else, so a concurrent
  -- role change / (de)activation / delete against related targets can
  -- never race past each other.
  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  -- Resolve the CALLER's own authorization only after the lock is held.
  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  if not public.role_ceiling_allows_manage(v_actor_role, v_target.role) then
    raise exception 'permission: אין הרשאה למחוק משתמש בתפקיד זה';
  end if;

  -- Authorization is now fully established. Only now may an
  -- already-tombstoned target short-circuit to success (see header).
  if v_target.deleted_at is not null then
    return;
  end if;

  -- The last ACTIVE system_admin may not be deleted by anyone -- same
  -- protection admin_set_user_active applies to deactivation.
  if v_target.role = 'system_admin' and v_target.active then
    select count(*) into v_active_admins from public.profiles where role = 'system_admin' and active;
    if v_active_admins <= 1 then
      raise exception 'validation: לא ניתן למחוק את מנהל המערכת הפעיל האחרון';
    end if;
  end if;

  -- NULL-safe against a null status (incidents.status is NOT NULL today,
  -- but this is correct regardless).
  select count(*) into v_open_incidents
  from public.incidents where owner_user_id = p_user_id and status is distinct from 'closed';
  if v_open_incidents > 0 then
    raise exception 'validation: יש לשנות גורם מטפל בתקלות פתוחות לפני מחיקת המשתמש';
  end if;

  update public.profiles
    set active = false, deleted_at = now(), deleted_by = auth.uid()
    where id = p_user_id;

  perform public.write_audit('user_tombstoned', 'profile', p_user_id::text);
end;
$$;

revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;
