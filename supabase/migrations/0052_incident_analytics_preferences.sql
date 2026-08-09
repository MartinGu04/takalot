-- AVARIA — ניתוחים v1.4.0: personalized analytics module visibility
-- ("התאמת התצוגה" / "איפוס תצוגה לברירת מחדל").
--
-- Self-only persistence, mirroring notifications.dismissed_at +
-- clear_my_notifications() (migration 0048): the write RPC takes no user_id
-- parameter, always targets auth.uid(), so there is no argument a client
-- could pass to touch another user's preferences.
--
-- Eligibility (shift_supervisor and above only) is enforced at BOTH layers,
-- not merely hidden in the UI:
--   - the RLS select policy requires is_operational_role() in addition to
--     user_id = auth.uid(), so even a direct read can never return a row for
--     a technician/viewer;
--   - the write RPC raises the same controlled 'permission: אין הרשאה' every
--     other role-gated RPC in this schema raises when is_operational_role()
--     is false -- being authenticated is explicitly not sufficient.
-- is_operational_role() (0002_functions.sql) is already defined as exactly
-- {system_admin, professional_manager, shift_supervisor}, a precise match for
-- the personalization eligibility set -- no new role-check helper is needed.
--
-- visible_modules is a plain text[] with a CHECK constraint against the
-- known module set, not a Postgres enum: enum values cannot be added and
-- referenced in the same transaction (the exact friction migration 0045
-- worked around once already), so a future 7th personalizable module is a
-- one-line `create or replace` of the constraint instead of a new
-- enum-value migration.
--
-- Which modules a shift_supervisor vs. professional_manager START with by
-- default is a frontend-only concern (src/domain/analyticsPreferences.ts) --
-- a pure starting-state convenience with no security implication, since
-- every eligible role may already toggle to any accepted module combination.
-- This migration only establishes eligibility and storage, not defaults.
--
-- Explicit transaction, matching this schema's convention for
-- multi-statement feature migrations (e.g. 0016/0024/0035/0041/0042/0044/
-- 0048) -- the repository's psql -f runner uses autocommit otherwise.

begin;

create table user_analytics_preferences (
  user_id         uuid primary key references profiles (id),
  visible_modules text[] not null,
  updated_at      timestamptz not null default now(),

  constraint user_analytics_preferences_modules_known
    check (visible_modules <@ array[
      'trend', 'ageDistribution', 'topSystems', 'topLocations', 'closures', 'externalInvolvement'
    ]::text[])
);

comment on table user_analytics_preferences is
  'Per-user visible-module selection for the ניתוחים (analytics) page personalization feature ("התאמת התצוגה"). One row per user who has customized their view away from their role default; absence of a row means "use the role default" -- see src/domain/analyticsPreferences.ts.';

alter table user_analytics_preferences enable row level security;

-- Scoped to both self AND eligibility -- see header comment above. No
-- insert/update/delete policy: writes are RPC-only (SECURITY DEFINER
-- bypasses RLS internally), matching every other table in this schema.
--
-- Deliberately NO reject_mutation() immutability trigger here, unlike the
-- append-only lifecycle tables (incident_events, incident_closures, etc.):
-- this table is genuinely mutable, one row per user, updated in place on
-- every preference change and deleted entirely on reset -- the same shape as
-- `notifications` (which is also plain-mutable, no immutability trigger),
-- not the shape of an audit/history log. reject_mutation() raises
-- unconditionally on every UPDATE/DELETE regardless of caller, which would
-- break this table's own upsert/reset RPC below.
create policy user_analytics_preferences_select on user_analytics_preferences
  for select using (user_id = auth.uid() and is_operational_role());

-- CRITICAL, easy to miss (same reasoning migration 0007 already documented
-- for is_active_member()/my_role()): RLS policy expressions run with the
-- privileges of the QUERYING user, not the table owner. is_operational_role()
-- had its EXECUTE revoked from authenticated in 0007 (it was, until now, an
-- internal helper only ever called from inside other SECURITY DEFINER
-- functions, which run as their owner and so never needed a direct grant).
-- This is the first RLS policy in the schema to evaluate it directly, so
-- without this explicit grant every SELECT on user_analytics_preferences
-- would fail with "permission denied for function is_operational_role" for
-- every signed-in user, eligible or not.
grant execute on function public.is_operational_role() to authenticated;

-- set_my_analytics_visible_modules(p_modules): upsert-or-reset RPC.
-- p_modules = null (the default) means "reset to default": deletes the
-- stored row, so a subsequent read returns no row and the frontend falls
-- back to the role default -- this directly backs "איפוס תצוגה לברירת מחדל".
--
-- NULL-safety (the exact footgun migration 0037 already documented and
-- worked around): my_role(), and therefore is_operational_role(), returns
-- NULL -- not false -- for an inactive or profile-less authenticated
-- identity, since `role from profiles where id = auth.uid() and active`
-- matches no row. `if not (NULL)` in PL/pgSQL treats the condition as false
-- and silently skips the raise, i.e. fails OPEN -- an inactive
-- shift_supervisor would otherwise slip through. is_active_member() is
-- checked explicitly FIRST (it depends only on row existence + active, never
-- returns NULL), and only then is the narrower role check evaluated, wrapped
-- in coalesce(..., false) as a second, defense-in-depth guard -- the same
-- two-layer pattern 0037/0038/0042/0044/0047 already use everywhere
-- is_operational_role() is the ONLY role gate on a function (as opposed to
-- functions where it's OR'd with other conditions after an unconditional
-- is_active_member() check already ran).
create or replace function set_my_analytics_visible_modules(p_modules text[] default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if not coalesce(is_operational_role(), false) then
    raise exception 'permission: אין הרשאה';
  end if;

  if p_modules is null then
    delete from user_analytics_preferences where user_id = auth.uid();
    return;
  end if;

  if not (p_modules <@ array['trend', 'ageDistribution', 'topSystems', 'topLocations', 'closures', 'externalInvolvement']::text[]) then
    raise exception 'validation: מודול לא מוכר';
  end if;

  insert into user_analytics_preferences (user_id, visible_modules)
  values (auth.uid(), p_modules)
  on conflict (user_id) do update set visible_modules = excluded.visible_modules, updated_at = now();
end;
$$;

revoke execute on function public.set_my_analytics_visible_modules(text[]) from public, anon;
grant execute on function public.set_my_analytics_visible_modules(text[]) to authenticated;

commit;
