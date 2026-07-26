-- מעקב תקלות — personnel tombstone & FK safety (database foundation for a
-- future user-deletion feature). Adds NO new capability that mutates data
-- differently than today; only removes the structural FK obstacles that
-- would make a future permanent-deletion RPC either unsafe (cascading away
-- history) or impossible (blocked by NOT NULL/referential errors), and adds
-- the tombstone fields + protections the future RPC will rely on.
--
-- ===== Root problem =====
-- profiles.id references auth.users(id) ON DELETE CASCADE (0001). Deleting
-- the Supabase Auth user for anyone who has EVER used Nexus would silently
-- delete their profiles row -- and with it, every incident, update, event,
-- audit entry, and notification that references it would either violate a
-- NOT NULL FK (created_by, author_id, updated_by, ...) and block the Auth
-- deletion outright, or (for the few nullable FKs) go quietly orphaned.
-- Neither outcome is acceptable: Nexus requires that operational and audit
-- history survive forever, attributed by name, even after the person's
-- Auth account is gone.
--
-- pending_personnel.claimed_by and bootstrap_admin_config.consumed_by also
-- reference auth.users(id) (0008, 0009). These are NO ACTION (the default)
-- and would BLOCK deleting an Auth user who ever claimed a pending entry or
-- bootstrapped the first admin -- i.e. almost every real user, eventually.
--
-- ===== The model =====
-- profiles.id becomes the PERMANENT historical identity UUID, fully
-- decoupled from auth.users. A profile row is never hard-deleted (a
-- "tombstone"): a future delete-user RPC will set deleted_at/deleted_by and
-- deactivate it, then delete the Supabase Auth user server-side as a
-- SEPARATE step (Auth Admin API / Edge Function -- not built in this PR).
-- Because profiles rows live forever, every other profiles(id) FK in the
-- schema (already NO ACTION -- see the audit below) stays exactly as safe
-- as it is today, permanently: there is no hard-delete path left anywhere
-- that could ever cascade away incidents/updates/events/audit/notification
-- history.
--
-- This migration does NOT add a delete-user RPC, does not touch Supabase
-- Auth, and does not change any client-visible behavior for active users.

-- =====================================================================
-- 1. Sever the dangerous Auth cascade
-- =====================================================================
-- profiles.id keeps its NOT NULL uuid primary key; it simply no longer
-- references auth.users at all. Nothing else about the column changes.
-- (Authorization already depends on profiles.active via is_active_member()/
-- my_role(), never on auth.users directly, so removing this FK changes no
-- runtime authorization behavior.)
alter table public.profiles drop constraint profiles_id_fkey;

-- =====================================================================
-- 2. Remove the two remaining Auth-deletion blockers
-- =====================================================================
-- Both columns are nullable and, on every path that sets them to a
-- non-null value, the SAME transaction also creates (claimed_by) or has
-- already created (consumed_by) a public.profiles row for that identity
-- (see claim_pending_personnel/bootstrap_first_admin, 0008/0009) -- so
-- re-pointing the FK at public.profiles(id) preserves the exact historical
-- identity forever (profiles rows are never deleted), rather than losing
-- it to SET NULL. This is strictly more history-preserving than SET NULL
-- and, unlike SET NULL, requires no change to which value is stored.
--
-- claim_pending_personnel() sets claimed_by BEFORE inserting the profiles
-- row (0008's original comment: "the profile row is created inside the
-- same claiming transaction"), which is exactly why 0008 pointed this FK
-- at auth.users instead of profiles in the first place -- an immediate
-- (non-deferred) FK to profiles would fail mid-transaction on that
-- ordering. DEFERRABLE INITIALLY DEFERRED resolves that: the FK is only
-- checked at COMMIT, by which point the profiles row already exists in the
-- same transaction. No function body changes are required.
alter table public.pending_personnel drop constraint pending_personnel_claimed_by_fkey;
alter table public.pending_personnel
  add constraint pending_personnel_claimed_by_fkey
  foreign key (claimed_by) references public.profiles (id)
  deferrable initially deferred;

-- bootstrap_first_admin() already inserts the profiles row before updating
-- consumed_by, so this one has no ordering dependency -- deferrable is
-- added anyway for uniformity with the sibling FK above and as a
-- forward-compatible safeguard against reordering.
alter table public.bootstrap_admin_config drop constraint bootstrap_admin_config_consumed_by_fkey;
alter table public.bootstrap_admin_config
  add constraint bootstrap_admin_config_consumed_by_fkey
  foreign key (consumed_by) references public.profiles (id)
  deferrable initially deferred;

-- =====================================================================
-- 3. Tombstone fields on profiles
-- =====================================================================
-- deleted_by references profiles(id), never auth.users: the acting admin
-- is themselves a permanent profile, so this FK can never be blocked or
-- broken by anything this migration does. Nullable, for a possible future
-- system-initiated closure (mirroring bootstrap_admin_config's
-- consumed_by = null convention) -- no such path exists yet.
alter table public.profiles
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles (id);

-- Hard DB-level invariant, independent of and in addition to any RPC
-- check below: a tombstoned profile can never be active. This alone
-- already blocks any UPDATE (through any code path, present or future)
-- that would set active = true while deleted_at is still set.
alter table public.profiles
  add constraint profiles_deleted_implies_inactive check (deleted_at is null or not active);

-- =====================================================================
-- 4. Protect tombstoned profiles at the RPC level
-- =====================================================================
-- Same signatures, same grants (CREATE OR REPLACE preserves both). Only
-- change: a target with deleted_at set is rejected up front, before the
-- role-ceiling/last-admin checks, so a deleted profile can never be
-- reactivated, re-roled, or otherwise treated as manageable/active
-- personnel. The explicit checks below give a clean, translated error;
-- section 3's CHECK constraint is the unconditional backstop underneath
-- them.
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

  -- A tombstoned profile's role is permanent history, not an editable
  -- field: it cannot be re-roled back into active personnel.
  if v_target.deleted_at is not null then
    raise exception 'validation: לא ניתן לשנות תפקיד למשתמש שנמחק';
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
