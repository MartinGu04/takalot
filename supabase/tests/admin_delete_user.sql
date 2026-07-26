-- Tests for migration 0013 (admin_delete_user, the DB half of server-side
-- user deletion):
--  1. Happy path tombstones + deactivates + audits as 'user_tombstoned'.
--  2. Self-deletion blocked.
--  3. Role-ceiling enforcement (same matrix as admin_set_user_role/active).
--  4. Last-active-admin protection (the same reachable branch the
--     sibling admin_set_user_role/admin_set_user_active suite tests: two
--     admins, delete one, one remains).
--  5. Open-incident guard, cleared via the EXISTING assign_incident RPC
--     (no new reassignment mechanism).
--  6. Idempotent no-op re-call by an AUTHORIZED caller on an
--     already-tombstoned target (no duplicate audit entry).
--  7. An UNAUTHORIZED caller is still rejected against an
--     already-tombstoned target -- idempotency never leaks a false
--     success to someone who isn't allowed to manage that target.
--  8. A previously deactivated (but not yet tombstoned) profile can be
--     tombstoned normally through this RPC.
--  9. Grant matrix: anon has no execute; authenticated does.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000b1', 'admin1@test', now()),
  ('00000000-0000-0000-0000-0000000000b2', 'admin2@test', now()),
  ('00000000-0000-0000-0000-0000000000b3', 'manager@test', now()),
  ('00000000-0000-0000-0000-0000000000b4', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000b5', 'tech1@test', now()),
  ('00000000-0000-0000-0000-0000000000b6', 'tech2@test', now()),
  ('00000000-0000-0000-0000-0000000000b7', 'viewer@test', now()),
  ('00000000-0000-0000-0000-0000000000b8', 'tech3-preinactive@test', now()),
  ('00000000-0000-0000-0000-0000000000b9', 'ghost@test', now()), -- authenticated, no profile
  ('00000000-0000-0000-0000-000000000b10', 'viewer2@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000b1', 'Admin One', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000b2', 'Admin Two', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000b3', 'Manager', 'professional_manager', true),
  ('00000000-0000-0000-0000-0000000000b4', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000b5', 'Tech One', 'technician', true),
  ('00000000-0000-0000-0000-0000000000b6', 'Tech Two', 'technician', true),
  ('00000000-0000-0000-0000-0000000000b7', 'Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-0000000000b8', 'Tech Three Pre-Inactive', 'technician', false),
  ('00000000-0000-0000-0000-000000000b10', 'Viewer Two', 'viewer', true);

insert into systems (id, name) values ('00000000-0000-0000-0000-00000000f201', 'Sys');
insert into locations (id, name) values ('00000000-0000-0000-0000-00000000f202', 'Loc');

-- An OPEN incident owned by Tech Two, to exercise the guard.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by, next_update_due, version)
values ('00000000-0000-0000-0000-00000000f210', 'T-201',
        '00000000-0000-0000-0000-00000000f201', '00000000-0000-0000-0000-00000000f202',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000b6', now(),
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

do $$
declare
  v_count int;
  v_active boolean;
  v_deleted_at timestamptz;
  v_deleted_by uuid;
  v_audit_count int;
begin
  -- ===== 1. Happy path: admin deletes a technician =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b5');
    insert into results (test, result, detail) values ('admin deletes technician: succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('admin deletes technician: succeeds', 'FAIL', sqlerrm);
  end;
  reset role;

  select active, deleted_at, deleted_by into v_active, v_deleted_at, v_deleted_by
    from profiles where id = '00000000-0000-0000-0000-0000000000b5';
  insert into results (test, result, detail) values
    ('deleted technician is deactivated + tombstoned + deleted_by set',
      case when v_active = false and v_deleted_at is not null and v_deleted_by = '00000000-0000-0000-0000-0000000000b1'
        then 'PASS' else 'FAIL' end,
      'active=' || v_active || ' deleted_at_set=' || (v_deleted_at is not null) || ' deleted_by=' || v_deleted_by);

  select count(*) into v_audit_count from audit_logs
    where action = 'user_tombstoned' and entity_id = '00000000-0000-0000-0000-0000000000b5';
  insert into results (test, result, detail) values
    ('audit action is user_tombstoned, not user_deleted', case when v_audit_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_audit_count);

  -- ===== 2. Self-deletion blocked =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b1');
    insert into results (test, result, detail) values ('self-deletion blocked', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('self-deletion blocked',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 3. Role-ceiling enforcement =====
  -- shift_supervisor cannot delete a peer/above (professional_manager).
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b4');
  set local role authenticated;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b3');
    insert into results (test, result, detail) values ('shift_supervisor cannot delete professional_manager', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('shift_supervisor cannot delete professional_manager',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  -- shift_supervisor CAN delete a technician within ceiling.
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b7'); -- deletes the viewer instead, keep tech6 for guard test
    insert into results (test, result, detail) values ('shift_supervisor can delete viewer within ceiling', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('shift_supervisor can delete viewer within ceiling', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 4. Last-active-admin protection =====
  -- Only system_admin may manage a system_admin target at all (the
  -- ceiling matrix has no other role touching system_admin), and
  -- self-deletion is already blocked separately (step 2) -- so the only
  -- reachable case is the one every sibling RPC (admin_set_user_role/
  -- admin_set_user_active) is tested against: with two active admins,
  -- deleting one is allowed because one remains. (A DIFFERENT actor could
  -- never reach the "only one left" branch: passing the ceiling check
  -- requires the actor itself to be an active system_admin, so the count
  -- is always >= 2 whenever such an actor exists -- the guard is the same
  -- defensive backstop the sibling RPCs carry, not independently
  -- triggerable here either.)
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b2');
    insert into results (test, result, detail) values ('deleting a second admin (one remains) succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('deleting a second admin (one remains) succeeds', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 5. Open-incident guard, cleared via the EXISTING assign_incident =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b6'); -- Tech Two owns the open incident
    insert into results (test, result, detail) values ('delete blocked while target owns an open incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('delete blocked while target owns an open incident',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  -- Reassign via the existing RPC (no new mechanism), then delete succeeds.
  -- b5 (Tech One) was itself tombstoned in step 1, so reassign to b4
  -- (Supervisor), who is still active throughout this suite.
  perform assign_incident('00000000-0000-0000-0000-00000000f210',
    jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000b4', 'expectedVersion', 1));
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b6');
    insert into results (test, result, detail) values ('delete succeeds after reassigning the open incident', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('delete succeeds after reassigning the open incident', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 6. Idempotent no-op re-call by an AUTHORIZED caller =====
  select count(*) into v_audit_count from audit_logs
    where action = 'user_tombstoned' and entity_id = '00000000-0000-0000-0000-0000000000b6';
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b6'); -- already tombstoned above
    insert into results (test, result, detail) values ('authorized re-call on already-tombstoned target no-ops', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('authorized re-call on already-tombstoned target no-ops', 'FAIL', sqlerrm);
  end;
  reset role;
  select count(*) into v_count from audit_logs
    where action = 'user_tombstoned' and entity_id = '00000000-0000-0000-0000-0000000000b6';
  insert into results (test, result, detail) values
    ('idempotent re-call writes no duplicate audit entry', case when v_count = v_audit_count then 'PASS' else 'FAIL' end,
      'before=' || v_audit_count || ' after=' || v_count);

  -- ===== 7. An UNAUTHORIZED caller is still rejected against an
  -- already-tombstoned target (b6, tombstoned above). shift_supervisor
  -- (b4) cannot manage a technician outranking nobody here -- use a case
  -- that is genuinely out of ceiling: have the VIEWER identity attempt it
  -- (viewer's own profile b7 was itself deleted in step 3, so use the
  -- profile-less ghost b9, whose my_role() is NULL -- definitely
  -- unauthorized) against the already-tombstoned b6.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b9');
  set local role authenticated;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b6');
    insert into results (test, result, detail) values
      ('unauthorized (profile-less) caller rejected even against an already-tombstoned target', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('unauthorized (profile-less) caller rejected even against an already-tombstoned target',
        case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
  -- Same point, with a genuinely authenticated + active + role-bearing
  -- actor who is still out of ceiling for ANY target: role_ceiling_
  -- allows_manage returns false for a viewer actor regardless of the
  -- target's role. b10 is a dedicated, untouched active viewer, used
  -- only for this check, against the already-tombstoned b6.
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000b10');
  set local role authenticated;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b6');
    insert into results (test, result, detail) values
      ('out-of-ceiling active viewer rejected even against an already-tombstoned target', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('out-of-ceiling active viewer rejected even against an already-tombstoned target',
        case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 8. A previously deactivated (not yet tombstoned) profile can be
  -- tombstoned normally =====
  select active, deleted_at into v_active, v_deleted_at from profiles where id = '00000000-0000-0000-0000-0000000000b8';
  insert into results (test, result, detail) values
    ('fixture: pre-inactive technician starts inactive, not tombstoned',
      case when v_active = false and v_deleted_at is null then 'PASS' else 'FAIL' end,
      'active=' || v_active || ' deleted_at_set=' || (v_deleted_at is not null));
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000b8');
    insert into results (test, result, detail) values ('previously deactivated (not tombstoned) profile can be tombstoned', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('previously deactivated (not tombstoned) profile can be tombstoned', 'FAIL', sqlerrm);
  end;
  reset role;
  select deleted_at, deleted_by into v_deleted_at, v_deleted_by from profiles where id = '00000000-0000-0000-0000-0000000000b8';
  insert into results (test, result, detail) values
    ('previously-inactive profile now has deleted_at/deleted_by set',
      case when v_deleted_at is not null and v_deleted_by = '00000000-0000-0000-0000-0000000000b1' then 'PASS' else 'FAIL' end,
      'deleted_at_set=' || (v_deleted_at is not null) || ' deleted_by=' || v_deleted_by);

  -- ===== 9. Grant matrix =====
  insert into results (test, result, detail)
  select 'anon has no EXECUTE on admin_delete_user',
    case when not has_function_privilege('anon', 'admin_delete_user(uuid)', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
  insert into results (test, result, detail)
  select 'authenticated has EXECUTE on admin_delete_user',
    case when has_function_privilege('authenticated', 'admin_delete_user(uuid)', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
