-- מעקב תקלות — forward migration.
-- Linked-personnel management ceilings for the "כוח אדם" (personnel) page.
-- admin_set_user_role / admin_set_user_active were system_admin-only and,
-- even for system_admin, allowed a caller to change their OWN role or
-- deactivate themselves (only "another" system_admin was protected). This
-- migration replaces both bodies so that:
--
--   * shift_supervisor      may manage technician, shift_supervisor;
--   * professional_manager  may manage technician, shift_supervisor,
--                           professional_manager;
--   * system_admin          may manage every role, including system_admin;
--   * technician / viewer   may manage nobody.
--
-- (Reuses role_ceiling_allows from 0008 -- the SAME ceiling table already
-- governing pending-personnel creation now governs linked-profile
-- management too, so there is exactly one ceiling definition in the
-- database.) On top of the ceiling:
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
-- On the self-block alone, a single request can never legally reduce the
-- active-admin count to zero: acting on someone else requires the caller
-- to themselves be an active system_admin, so target+caller are already
-- two distinct active-admin rows whenever the guard could matter. The
-- real exposure is TWO CONCURRENT requests deactivating/demoting two
-- DIFFERENT admins at once (A deactivates B while, simultaneously, B
-- deactivates A) -- both could observe count=2 before either commits and
-- both proceed, leaving zero. The count is therefore taken under
-- `for update` on the matching rows first, so the second transaction
-- blocks until the first commits and then re-observes the now-smaller
-- count. (Verified locally with two concurrent sessions -- see the
-- verification report.)
--
-- Grants are unchanged: both functions were already granted to
-- authenticated (0003, restated in 0007) and CREATE OR REPLACE preserves
-- existing grants for an unchanged signature, so no grant statements are
-- required here.
--
-- 0001-0009 are untouched. This is an ADDITIVE migration.

create or replace function public.admin_set_user_role(p_user_id uuid, p_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role := public.my_role();
  v_target public.profiles;
  v_active_admins int;
begin
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן לשנות את התפקיד של עצמך';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  -- The ceiling must cover BOTH the profile's current role and the
  -- requested new role -- otherwise a lower manager could take over a
  -- profile above their reach, or hand it a role above their reach.
  if not public.role_ceiling_allows(v_actor_role, v_target.role)
     or not public.role_ceiling_allows(v_actor_role, p_role) then
    raise exception 'permission: אין הרשאה לנהל משתמש בתפקיד זה';
  end if;

  -- The last ACTIVE system_admin may not be demoted by anyone. Lock the
  -- active-admin row set BEFORE counting (see header) so a concurrent
  -- demotion/deactivation of a different admin cannot race past this check.
  if v_target.role = 'system_admin' and v_target.active and p_role <> 'system_admin' then
    perform 1 from public.profiles where role = 'system_admin' and active for update;
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
  v_actor_role public.app_role := public.my_role();
  v_target public.profiles;
  v_active_admins int;
begin
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן לשנות את הסטטוס של עצמך';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  if not public.role_ceiling_allows(v_actor_role, v_target.role) then
    raise exception 'permission: אין הרשאה לנהל משתמש בתפקיד זה';
  end if;

  -- The last ACTIVE system_admin may not be deactivated by anyone. Same
  -- lock-before-count pattern as above, for the same concurrent-race reason.
  if not p_active and v_target.role = 'system_admin' and v_target.active then
    perform 1 from public.profiles where role = 'system_admin' and active for update;
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
