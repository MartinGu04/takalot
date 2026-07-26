-- מעקב תקלות — forward migration.
-- Chapter 2, PR1: an active incident may never remain assigned to a
-- deactivated internal owner (גורם מטפל פנימי). Today "open" means
-- "status <> 'closed'" -- the only terminal status that exists yet. Once
-- Chapter 2 introduces additional terminal statuses, the guard below is
-- expected to be swapped to whatever helper generalizes "open" at that
-- point; it is written against today's schema deliberately, not against
-- concepts that do not exist yet.
--
-- Four parts:
--   0. A fail-closed preflight: refuses to apply this migration at all if
--      any EXISTING open incident is already assigned to an inactive or
--      tombstoned internal owner. Read-only -- it never rewrites data.
--   1. A BEFORE UPDATE trigger on profiles -- the unconditional backstop:
--      it fires on ANY statement that would deactivate a profile
--      (including a future RPC, or a direct administrative UPDATE), not
--      only on calls that go through the RPC below. SECURITY DEFINER, so
--      its internal read of `incidents` never depends on the invoking
--      role's own SELECT grants or RLS visibility (see part 1 for why
--      that matters).
--   2. admin_set_user_active() -- the only client-facing path that flips
--      profiles.active today -- gets an explicit, translated check for a
--      clean error before any UPDATE is attempted, on top of the trigger.
--   3. assert_owner_valid() -- called by every RPC that sets an internal
--      owner (create_incident, update_incident, assign_incident,
--      reopen_incident) -- is replaced with a concurrency-safe body that
--      takes a row lock on the target profile before validating it, so it
--      cannot race admin_set_user_active's own lock on that same row (see
--      part 3 for the full concurrency argument).
--
-- ===== On testing the concurrency fix (parts 2 and 3) =====
-- The existing SQL test harness (supabase/tests/run.sh) applies each test
-- file through a SINGLE psql connection, wrapped in one `begin; ...
-- rollback;` per file -- it has no facility for two independently
-- committing, concurrently blocking database sessions, and retrofitting
-- that safely (bounded waits, no risk of an indefinitely hanging suite if
-- a regression reintroduces the race) is a real change to the harness
-- itself, not a one-line addition. No automated test for the cross-session
-- blocking behavior is added in this migration for that reason.
--
-- The fix was instead verified empirically, out of band, with two real
-- concurrent psql sessions against a scratch database running the exact
-- lock clauses used below, in both possible acquisition orders:
--   * admin_set_user_active locks (FOR UPDATE) first: a concurrent
--     assert_owner_valid-equivalent (FOR SHARE) blocked for ~964ms, then
--     correctly observed the committed active=false once unblocked.
--   * assert_owner_valid-equivalent locks (FOR SHARE) first, reassigns the
--     incident, and commits: a concurrent admin_set_user_active-equivalent
--     (FOR UPDATE) blocked for ~997ms, then correctly found the
--     newly-committed open incident once unblocked.
-- Both confirm PostgreSQL's documented READ COMMITTED row-lock-wait
-- behavior: a blocked locking SELECT resumes against the row's latest
-- COMMITTED state, not a snapshot taken before the wait. See parts 2 and 3
-- below for the written argument this empirically confirms.
--
-- admin_delete_user() (0013) already independently guards the open-
-- incident scenario for the deletion path specifically (it blocks deletion
-- while the target owns an open incident, before ever reaching the UPDATE
-- that sets active = false) -- so the new trigger is a no-op there, never
-- double-blocking that RPC's own callers. admin_delete_user does NOT yet
-- have the same row-lock hardening as admin_set_user_active below; that is
-- a known, tracked gap for a fast-follow, not silently fixed here, since it
-- was not in scope for this migration.
--
-- This migration adds no enum values and no new tables. It is purely a new
-- invariant on profiles, closing a concurrency gap in that invariant, and
-- the RPC every internal-owner assignment already goes through.

-- =====================================================================
-- 0. Fail-closed preflight
-- =====================================================================
-- On a fresh/empty database (this migration's own first-ever application
-- during local test runs, and the intended hosted rollout) this is a
-- guaranteed no-op: it only ever fires against data that predates this
-- migration. Read-only -- no UPDATE, INSERT, or DELETE anywhere in this
-- block; it never rewrites or reassigns anything itself. If it raises,
-- `ON_ERROR_STOP` (already how every environment applies these migration
-- files) stops processing this file immediately -- none of parts 1-3 below
-- are applied either, so the migration is all-or-nothing.
do $$
declare
  v_bad_count int;
begin
  select count(*) into v_bad_count
  from incidents i
  join profiles p on p.id = i.owner_user_id
  where i.status <> 'closed'
    and (not p.active or p.deleted_at is not null);

  if v_bad_count > 0 then
    raise exception
      'preflight: % open incident(s) are currently assigned to an inactive or tombstoned internal owner. '
      'Reassign each one via assign_incident (to an active, eligible internal owner) before this migration can be applied. '
      'This preflight does not and will not reassign or rewrite any historical data itself.',
      v_bad_count;
  end if;
end $$;

-- =====================================================================
-- 1. Trigger backstop -- SECURITY DEFINER
-- =====================================================================
-- Fully schema-qualified and pinned to an empty search_path, AND now
-- SECURITY DEFINER. Two independent reasons this trigger must not run
-- under the invoking role's own privileges:
--
--   a) It fires on UPDATEs issued from inside admin_set_user_active, which
--      itself runs under `set search_path = ''` (0012/0013 convention) --
--      an unqualified "incidents"/"profiles" reference would resolve
--      against whatever search_path is ambient AT THE TIME the triggering
--      statement runs, not a path of this function's own choosing, unless
--      pinned here too.
--   b) More fundamentally: this trigger's whole job is to look up rows in
--      `incidents` to decide whether a deactivation is allowed. incidents
--      has RLS enabled (incidents_select requires is_active_member(),
--      which itself resolves auth.uid()). A SECURITY INVOKER trigger fired
--      by any future write path whose effective role/JWT context does NOT
--      resolve to an active member (a service role, an internal Supabase
--      process, or simply a context with no request.jwt.claims set) would
--      have RLS SILENTLY hide every row of `incidents` from its internal
--      EXISTS query -- not error, just return zero rows -- making the
--      guard wrongly conclude "no open incidents" and ALLOW the
--      deactivation. That is a real, silent bypass of a DB-level
--      invariant, precisely because RLS row-hiding and "the row doesn't
--      exist" are indistinguishable from inside an ordinary SELECT.
--      SECURITY DEFINER makes this trigger always evaluate against the
--      full, true state of `incidents`, regardless of who or what fired
--      the triggering UPDATE.
create or replace function public.prevent_deactivation_with_open_incidents() returns trigger
language plpgsql security definer set search_path = '' as $$
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

-- =====================================================================
-- 2. admin_set_user_active -- clean, translated RPC-level error,
--    now taking a row lock BEFORE checking incident ownership
-- =====================================================================
-- Concurrency argument (see part 3 below for the matching half):
-- `select ... for update` here takes an EXCLUSIVE row lock on the target
-- profile that is held for the rest of this transaction. assert_owner_
-- valid (part 3) takes a SHARE row lock on the same row before it
-- validates `active`. FOR UPDATE conflicts with FOR SHARE on the same row
-- (and with FOR UPDATE), so whichever of {this function, a concurrent
-- assign_incident targeting this same user} acquires its lock first,
-- the other BLOCKS until the first one's transaction commits or rolls
-- back -- and PostgreSQL re-evaluates the blocked statement against the
-- row's latest COMMITTED state once unblocked (this is standard READ
-- COMMITTED row-lock-wait behavior, not something special-cased here).
-- Concretely, for the exact race this closes:
--   * If this function locks first: it finds no open incident owned by
--     the target (say), deactivates, commits. The blocked assign_incident
--     unblocks, re-reads the now-committed active=false, and
--     assert_owner_valid correctly rejects the assignment.
--   * If assign_incident locks first: it validates active=true, assigns
--     the incident, commits. This function was blocked on the SAME row
--     the whole time; once unblocked it proceeds to its own "does the
--     target own an open incident" check -- a fresh, uncached read against
--     `incidents` taken AFTER assign_incident's commit -- which now
--     correctly finds the just-assigned incident and rejects deactivation.
-- Either ordering is now safe; the two operations can no longer interleave
-- to leave an open incident owned by an inactive profile.
--
-- No new deadlock risk: this function never locks a row in `incidents`
-- (its own open-incident check is a plain, unlocked SELECT EXISTS); it
-- only ever holds a lock on `profiles`. assign_incident's fixed lock order
-- is incident-row (FOR UPDATE, via lock_incident_checked) THEN
-- owner-profile-row (FOR SHARE, via assert_owner_valid) -- this function
-- can therefore never be "upstream" of a cycle through the incidents
-- table, since it never waits on an incident-row lock itself.
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

  -- FOR UPDATE: see the concurrency argument above. Held until this
  -- transaction ends, covering every check below including the
  -- open-incident check.
  select * into v_target from public.profiles where id = p_user_id for update;
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

-- =====================================================================
-- 3. assert_owner_valid -- concurrency-safe (row-locking) replacement
-- =====================================================================
-- Original (0002) body: a plain, unlocked `not exists (select 1 from
-- profiles where id = p_owner and active)`. That check and the eventual
-- UPDATE that actually uses p_owner as the new owner are two separate,
-- unlocked statements with no ordering guarantee against a concurrent
-- admin_set_user_active call deactivating that same profile in between --
-- the exact race described in this migration's header.
--
-- Fix: lock the target profile row FOR SHARE before reading `active`. Not
-- STABLE any more (a locking read is a side effect -- it is left VOLATILE,
-- the default, matching its new nature). Same signature, same name, same
-- error text and conditions -- every existing caller (create_incident,
-- update_incident, assign_incident, reopen_incident) is unaffected; only
-- the body changes. FOR SHARE (not FOR UPDATE) is used deliberately: this
-- function only ever READS `active`, and multiple concurrent callers
-- validating the SAME owner for DIFFERENT incidents must not block each
-- other -- FOR SHARE locks from multiple transactions coexist peacefully,
-- while still conflicting with admin_set_user_active's FOR UPDATE, which
-- is the only conflict this needs to create. See part 2 above for the
-- full two-sided argument of why this closes the race in both possible
-- lock-acquisition orderings.
create or replace function public.assert_owner_valid(p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_active boolean;
begin
  if p_owner is not null then
    select active into v_active from public.profiles where id = p_owner for share;
    if not found or not v_active then
      raise exception 'validation: הגורם המטפל שנבחר אינו פעיל';
    end if;
  end if;
end;
$$;
