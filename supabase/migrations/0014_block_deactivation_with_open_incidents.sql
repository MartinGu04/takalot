-- מעקב תקלות — forward migration.
-- Chapter 2, PR1: an active incident may never remain assigned to a
-- deactivated internal owner (גורם מטפל פנימי). Today "open" means
-- "status <> 'closed'" -- the only terminal status that exists yet. Once
-- Chapter 2 introduces additional terminal statuses, the guard below is
-- expected to be swapped to whatever helper generalizes "open" at that
-- point; it is written against today's schema deliberately, not against
-- concepts that do not exist yet.
--
-- Two layers, both checking the exact same condition:
--   1. admin_set_user_active() -- the only client-facing path that flips
--      profiles.active today -- gets an explicit, translated check for a
--      clean error before any UPDATE is attempted.
--   2. A BEFORE UPDATE trigger on profiles is the unconditional backstop:
--      it fires on ANY statement that would deactivate a profile
--      (including a future RPC, a direct administrative UPDATE, or a
--      migration), not only on calls that go through the RPC above.
--
-- admin_delete_user() (0013) already independently guards this exact
-- scenario (it blocks deletion while the target owns an open incident,
-- before ever reaching the UPDATE that sets active = false) -- so the new
-- trigger is a no-op there, never double-blocking that RPC's own callers.
--
-- This migration adds no enum values, no new tables, and touches no
-- incident-lifecycle RPC. It is purely a new invariant on profiles.

-- ===== 1. Trigger backstop =====
-- Fully schema-qualified and pinned to an empty search_path: this trigger
-- fires on UPDATEs issued from inside admin_set_user_active, which itself
-- runs under `set search_path = ''` (0012/0013 convention) -- an
-- unqualified "incidents"/"profiles" reference would resolve against
-- whatever search_path is ambient AT THE TIME the triggering statement
-- runs, not a path of this function's own choosing, unless pinned here too.
create or replace function public.prevent_deactivation_with_open_incidents() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.active and not new.active and exists (
    select 1 from public.incidents where owner_user_id = old.id and status <> 'closed'
  ) then
    raise exception 'validation: לא ניתן להשבית משתמש המשמש כגורם מטפל פנימי בתקלה פעילה — יש להעביר את הטיפול לגורם מטפל פנימי אחר לפני ההשבתה';
  end if;
  return new;
end;
$$;

create trigger trg_profiles_block_deactivation_with_open_incidents
  before update on public.profiles
  for each row execute function public.prevent_deactivation_with_open_incidents();

-- ===== 2. Clean, translated RPC-level error (same condition, checked first) =====
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

  -- A tombstoned profile is not personnel to manage: it cannot be
  -- reactivated, and there is nothing left to deactivate.
  if v_target.deleted_at is not null then
    raise exception 'validation: לא ניתן לשנות סטטוס למשתמש שנמחק';
  end if;

  if not public.role_ceiling_allows_manage(v_actor_role, v_target.role) then
    raise exception 'permission: אין הרשאה לנהל משתמש בתפקיד זה';
  end if;

  -- Internal-owner invariant (Chapter 2, PR1): a currently-active internal
  -- owner (גורם מטפל פנימי) of an open incident can never be deactivated
  -- until that incident is reassigned. Checked here, on top of the target
  -- still being currently active, for a clean, translated error; the
  -- trigger above is the unconditional backstop for every other path.
  if not p_active and v_target.active and exists (
    select 1 from public.incidents where owner_user_id = p_user_id and status <> 'closed'
  ) then
    raise exception 'validation: לא ניתן להשבית משתמש המשמש כגורם מטפל פנימי בתקלה פעילה — יש להעביר את הטיפול לגורם מטפל פנימי אחר לפני ההשבתה';
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
