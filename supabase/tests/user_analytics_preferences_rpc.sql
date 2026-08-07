-- Tests for migration 0052: user_analytics_preferences +
-- set_my_analytics_visible_modules -- personalized analytics module
-- visibility ("התאמת התצוגה").
--
-- Covers: eligibility (shift_supervisor and above) is enforced at BOTH
-- layers, not merely UI-hidden -- a technician/viewer is rejected with a
-- controlled error on write, via is_operational_role(), and reads no row
-- via the RLS select policy even if one somehow existed; self-only
-- scoping (no user_id parameter exists for a client to target another
-- user); set/get roundtrip; reset-to-default (p_modules = null deletes the
-- row); unknown-module validation error; and ACL/grant-state assertions.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0004b0000001', 'up-supervisor@test', now()),
  ('00000000-0000-0000-0000-0004b0000002', 'up-manager@test', now()),
  ('00000000-0000-0000-0000-0004b0000003', 'up-technician@test', now()),
  ('00000000-0000-0000-0000-0004b0000004', 'up-viewer@test', now()),
  ('00000000-0000-0000-0000-0004b0000005', 'up-inactive-supervisor@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0004b0000001', 'UP Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0004b0000002', 'UP Manager', 'professional_manager', true),
  ('00000000-0000-0000-0000-0004b0000003', 'UP Technician', 'technician', true),
  ('00000000-0000-0000-0000-0004b0000004', 'UP Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-0004b0000005', 'UP Inactive Supervisor', 'shift_supervisor', false);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

do $$
declare
  v_row record;
  v_count int;
begin
  -- ===== Eligible role (shift_supervisor): set, read back, roundtrip. =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0004b0000001');
  set local role authenticated;

  perform set_my_analytics_visible_modules(array['trend', 'ageDistribution']);
  select visible_modules into v_row from user_analytics_preferences where user_id = '00000000-0000-0000-0000-0004b0000001';
  insert into results (test, result, detail) values
    ('shift_supervisor can set and read back their own preferences',
      case when v_row.visible_modules = array['trend', 'ageDistribution'] then 'PASS' else 'FAIL' end,
      array_to_string(v_row.visible_modules, ','));

  -- Update (roundtrip) to a different set -- on_conflict do update path.
  perform set_my_analytics_visible_modules(array['closures', 'externalInvolvement', 'topSystems']);
  select visible_modules into v_row from user_analytics_preferences where user_id = '00000000-0000-0000-0000-0004b0000001';
  insert into results (test, result, detail) values
    ('a second call updates (not duplicates) the existing row',
      case when v_row.visible_modules = array['closures', 'externalInvolvement', 'topSystems'] then 'PASS' else 'FAIL' end,
      array_to_string(v_row.visible_modules, ','));
  select count(*) into v_count from user_analytics_preferences where user_id = '00000000-0000-0000-0000-0004b0000001';
  insert into results (test, result, detail) values
    ('exactly one row exists per user after multiple writes',
      case when v_count = 1 then 'PASS' else 'FAIL' end, v_count);

  -- Reset to default: p_modules = null deletes the row.
  perform set_my_analytics_visible_modules(null);
  select count(*) into v_count from user_analytics_preferences where user_id = '00000000-0000-0000-0000-0004b0000001';
  insert into results (test, result, detail) values
    ('reset (p_modules = null) deletes the stored row',
      case when v_count = 0 then 'PASS' else 'FAIL' end, v_count);

  -- Unknown module value is rejected, and nothing is written.
  begin
    perform set_my_analytics_visible_modules(array['trend', 'notARealModule']);
    insert into results (test, result, detail) values
      ('an unknown module key is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('an unknown module key is rejected',
        case when sqlerrm = 'validation: מודול לא מוכר' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  select count(*) into v_count from user_analytics_preferences where user_id = '00000000-0000-0000-0000-0004b0000001';
  insert into results (test, result, detail) values
    ('a rejected unknown-module call writes no row',
      case when v_count = 0 then 'PASS' else 'FAIL' end, v_count);

  -- ===== Eligible role (professional_manager): also succeeds. =====
  reset role;
  perform pg_temp.as_user('00000000-0000-0000-0000-0004b0000002');
  set local role authenticated;
  begin
    perform set_my_analytics_visible_modules(array['closures']);
    insert into results (test, result, detail) values
      ('professional_manager can set their own preferences', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('professional_manager can set their own preferences', 'FAIL', sqlerrm);
  end;

  reset role;
end $$;

-- =====================================================================
-- Eligibility enforcement -- server-side, not merely UI-hidden.
-- =====================================================================
do $$
declare
  v_count int;
begin
  -- A technician is authenticated and active, but NOT operational-role
  -- eligible -- being authenticated must not be sufficient.
  perform pg_temp.as_user('00000000-0000-0000-0000-0004b0000003');
  set local role authenticated;
  begin
    perform set_my_analytics_visible_modules(array['trend']);
    insert into results (test, result, detail) values
      ('technician is rejected from writing preferences (authenticated is not sufficient)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician is rejected from writing preferences (authenticated is not sufficient)',
        case when sqlerrm = 'permission: אין הרשאה' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  select count(*) into v_count from user_analytics_preferences where user_id = '00000000-0000-0000-0000-0004b0000003';
  insert into results (test, result, detail) values
    ('the rejected technician write left no row behind',
      case when v_count = 0 then 'PASS' else 'FAIL' end, v_count);
  reset role;
end $$;

do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0004b0000004');
  set local role authenticated;
  begin
    perform set_my_analytics_visible_modules(array['trend']);
    insert into results (test, result, detail) values
      ('viewer is rejected from writing preferences', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('viewer is rejected from writing preferences',
        case when sqlerrm = 'permission: אין הרשאה' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

do $$
begin
  -- Inactive shift_supervisor: is_operational_role() reads my_role(), which
  -- itself requires profiles.active -- an inactive supervisor must be
  -- rejected exactly like an active ineligible role, not treated as
  -- eligible just because their stored role value is shift_supervisor.
  perform pg_temp.as_user('00000000-0000-0000-0000-0004b0000005');
  set local role authenticated;
  begin
    perform set_my_analytics_visible_modules(array['trend']);
    insert into results (test, result, detail) values
      ('an inactive shift_supervisor is rejected (active is required, not just the role value)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('an inactive shift_supervisor is rejected (active is required, not just the role value)',
        case when sqlerrm = 'permission: אין הרשאה' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- ===== RLS read-side: even a row that somehow exists is never visible to
-- an ineligible role (defense in depth, per the migration's own design). =====
do $$
declare
  v_count int;
begin
  -- Insert a row directly as postgres (bypassing RLS entirely, simulating
  -- "a row somehow exists" -- e.g. a role downgrade after the preference
  -- was set while still eligible).
  insert into user_analytics_preferences (user_id, visible_modules)
  values ('00000000-0000-0000-0000-0004b0000003', array['trend']);

  perform pg_temp.as_user('00000000-0000-0000-0000-0004b0000003');
  set local role authenticated;
  select count(*) into v_count from user_analytics_preferences where user_id = '00000000-0000-0000-0000-0004b0000003';
  insert into results (test, result, detail) values
    ('a technician can never read a preferences row, even one that exists (RLS defense in depth)',
      case when v_count = 0 then 'PASS' else 'FAIL' end, v_count);
  reset role;
end $$;

-- ===== Self-only scoping: no user_id parameter exists on the write RPC at
-- all, so eligible User A''s write can only ever affect User A''s own row --
-- confirmed structurally (function signature) rather than by a runtime
-- probe, since there is no argument to even attempt targeting another user. =====
insert into results (test, result, detail)
select 'set_my_analytics_visible_modules has no user_id parameter (self-only by construction)',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'set_my_analytics_visible_modules'
  and pg_get_function_identity_arguments(p.oid) = 'p_modules text[]';

-- =====================================================================
-- ACL-level checks.
-- =====================================================================
insert into results (test, result, detail)
select 'authenticated has EXECUTE on set_my_analytics_visible_modules',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'set_my_analytics_visible_modules'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'set_my_analytics_visible_modules has no PUBLIC or anon EXECUTE',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'set_my_analytics_visible_modules'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where (a.grantee = 0 or a.grantee = 'anon'::regrole) and a.privilege_type = 'EXECUTE'
  );

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
