-- Tests for migration 0012 (personnel tombstone & FK safety):
--  1. A profile with incident/timeline history survives its Auth user's
--     deletion, and that history is untouched.
--  2. pending_personnel.claimed_by / bootstrap_admin_config.consumed_by no
--     longer block deleting the Auth user they refer to.
--  3. A tombstoned profile is inactive, cannot be reactivated or re-roled
--     through the management RPCs, and the DB-level CHECK backstops that
--     even against a raw UPDATE.
--  4. Active/unrelated users are unaffected.
--  5. No FK referencing auth.users(id) anywhere in the schema still
--     cascades.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@test', now()),   -- acting admin
  ('00000000-0000-0000-0000-0000000000a2', 'history@test', now()), -- will be deleted from auth.users
  ('00000000-0000-0000-0000-0000000000a3', 'control@test', now()); -- unaffected control user

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000a1', 'Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000a2', 'Departed Tech', 'technician', true),
  ('00000000-0000-0000-0000-0000000000a3', 'Control Tech', 'technician', true);

insert into systems (id, name) values ('00000000-0000-0000-0000-00000000f101', 'Sys');
insert into locations (id, name) values ('00000000-0000-0000-0000-00000000f102', 'Loc');

-- Incident + full timeline history attributed to the soon-to-depart user.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by, next_update_due)
values ('00000000-0000-0000-0000-00000000f110', 'T-101',
        '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000f102',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000a2', now(),
        '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2',
        now() + interval '4 hours');

insert into incident_updates (id, incident_id, author_id, event_time, actions_taken)
values ('00000000-0000-0000-0000-00000000f120', '00000000-0000-0000-0000-00000000f110',
        '00000000-0000-0000-0000-0000000000a2', now(), 'did things');

insert into incident_events (id, incident_id, type, actor_id, note)
values ('00000000-0000-0000-0000-00000000f121', '00000000-0000-0000-0000-00000000f110',
        'created', '00000000-0000-0000-0000-0000000000a2', 'created');

insert into notifications (id, user_id, type, incident_id, text)
values ('00000000-0000-0000-0000-00000000f122', '00000000-0000-0000-0000-0000000000a2',
        'incident_assigned', '00000000-0000-0000-0000-00000000f110', 'assigned to you');

insert into audit_logs (id, actor_id, action, entity_type, entity_id)
values ('00000000-0000-0000-0000-00000000f123', '00000000-0000-0000-0000-0000000000a2',
        'incident_created', 'incident', 'T-101');

-- A pending_personnel entry this same identity claimed in the past, and a
-- bootstrap_admin_config row it consumed -- both must not block Auth
-- deletion.
insert into pending_personnel (id, full_name, email, role, status, created_by, claimed_by, claimed_at)
values ('00000000-0000-0000-0000-00000000f130', 'Departed Tech', 'history@test', 'technician',
        'claimed', '00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-0000000000a2', now());

insert into bootstrap_admin_config (id, email, consumed_at, consumed_by, closed_reason)
values (true, 'history@test', now(), '00000000-0000-0000-0000-0000000000a2', 'bootstrap_completed');

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
  v_role text;
begin
  -- ===== 1/2. Delete the Auth user; confirm it succeeds and history stays =====
  begin
    delete from auth.users where id = '00000000-0000-0000-0000-0000000000a2';
    insert into results (test, result, detail) values
      ('Auth user with full history + pending_personnel.claimed_by + bootstrap_admin_config.consumed_by can be deleted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('Auth user with full history + pending_personnel.claimed_by + bootstrap_admin_config.consumed_by can be deleted', 'FAIL', sqlerrm);
  end;

  select count(*) into v_count from profiles where id = '00000000-0000-0000-0000-0000000000a2';
  insert into results (test, result, detail) values
    ('profile row survives Auth user deletion', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  select count(*) into v_count from incidents where id = '00000000-0000-0000-0000-00000000f110';
  insert into results (test, result, detail) values
    ('incident survives Auth user deletion', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  select count(*) into v_count from incident_updates where id = '00000000-0000-0000-0000-00000000f120';
  insert into results (test, result, detail) values
    ('incident_updates survives Auth user deletion', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  select count(*) into v_count from incident_events where id = '00000000-0000-0000-0000-00000000f121';
  insert into results (test, result, detail) values
    ('incident_events survives Auth user deletion', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  select count(*) into v_count from notifications where id = '00000000-0000-0000-0000-00000000f122';
  insert into results (test, result, detail) values
    ('notifications survives Auth user deletion', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  select count(*) into v_count from audit_logs where id = '00000000-0000-0000-0000-00000000f123';
  insert into results (test, result, detail) values
    ('audit_logs survives Auth user deletion', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  select count(*) into v_count from pending_personnel
    where id = '00000000-0000-0000-0000-00000000f130' and claimed_by = '00000000-0000-0000-0000-0000000000a2';
  insert into results (test, result, detail) values
    ('pending_personnel.claimed_by preserved after Auth user deletion', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  select count(*) into v_count from bootstrap_admin_config
    where id = true and consumed_by = '00000000-0000-0000-0000-0000000000a2';
  insert into results (test, result, detail) values
    ('bootstrap_admin_config.consumed_by preserved after Auth user deletion', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  -- ===== 3. Tombstone the (now Auth-less) profile =====
  update profiles set deleted_at = now(), deleted_by = '00000000-0000-0000-0000-0000000000a1', active = false
    where id = '00000000-0000-0000-0000-0000000000a2';

  select active into v_active from profiles where id = '00000000-0000-0000-0000-0000000000a2';
  insert into results (test, result, detail) values
    ('tombstoned profile is inactive', case when v_active = false then 'PASS' else 'FAIL' end, 'active=' || v_active);

  -- DB-level CHECK backstop: a raw UPDATE cannot reactivate a tombstoned row.
  begin
    update profiles set active = true where id = '00000000-0000-0000-0000-0000000000a2';
    insert into results (test, result, detail) values
      ('CHECK constraint blocks raw reactivation of a tombstoned profile', 'FAIL', 'update succeeded');
  exception when check_violation then
    insert into results (test, result, detail) values
      ('CHECK constraint blocks raw reactivation of a tombstoned profile', 'PASS', sqlerrm);
  end;

  -- RPC-level: admin cannot reactivate a tombstoned profile.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
  set local role authenticated;
  begin
    perform admin_set_user_active('00000000-0000-0000-0000-0000000000a2', true);
    insert into results (test, result, detail) values
      ('admin_set_user_active rejects a tombstoned target', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('admin_set_user_active rejects a tombstoned target',
        case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- RPC-level: admin cannot re-role a tombstoned profile.
  begin
    perform admin_set_user_role('00000000-0000-0000-0000-0000000000a2', 'system_admin');
    insert into results (test, result, detail) values
      ('admin_set_user_role rejects a tombstoned target', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('admin_set_user_role rejects a tombstoned target',
        case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- ===== 4. Control: an unrelated active user is unaffected =====
  begin
    perform admin_set_user_role('00000000-0000-0000-0000-0000000000a3', 'shift_supervisor');
    insert into results (test, result, detail) values ('CONTROL: active unrelated user can still be re-roled', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('CONTROL: active unrelated user can still be re-roled', 'FAIL', sqlerrm);
  end;
  begin
    perform admin_set_user_active('00000000-0000-0000-0000-0000000000a3', false);
    perform admin_set_user_active('00000000-0000-0000-0000-0000000000a3', true);
    insert into results (test, result, detail) values ('CONTROL: active unrelated user can still be (de)activated', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('CONTROL: active unrelated user can still be (de)activated', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 5. No remaining cascade path from auth.users =====
  select count(*) into v_count
  from pg_constraint
  where confrelid = 'auth.users'::regclass and confdeltype = 'c';
  insert into results (test, result, detail) values
    ('no ON DELETE CASCADE remains anywhere referencing auth.users', case when v_count = 0 then 'PASS' else 'FAIL' end, 'cascades=' || v_count);

  select count(*) into v_count
  from pg_constraint
  where conrelid = 'public.profiles'::regclass and confrelid = 'auth.users'::regclass;
  insert into results (test, result, detail) values
    ('profiles no longer has any FK to auth.users', case when v_count = 0 then 'PASS' else 'FAIL' end, 'remaining=' || v_count);

  select count(*) into v_count
  from pg_constraint
  where conname in ('pending_personnel_claimed_by_fkey', 'bootstrap_admin_config_consumed_by_fkey')
    and confrelid = 'public.profiles'::regclass;
  insert into results (test, result, detail) values
    ('claimed_by/consumed_by now reference profiles, not auth.users', case when v_count = 2 then 'PASS' else 'FAIL' end, 'matching=' || v_count);
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
