-- Tests for migration 0014: an internal owner (גורם מטפל פנימי) of an open
-- incident can never be deactivated -- neither through admin_set_user_active
-- (clean, translated RPC error) nor through a raw UPDATE on profiles that
-- bypasses the RPC entirely (the trigger backstop). Reassigning the
-- incident away first (via the existing assign_incident RPC) must unblock
-- deactivation. A user who owns only closed incidents, or no incidents at
-- all, must be unaffected.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000c1', 'admin@test', now()),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-open@test', now()),
  ('00000000-0000-0000-0000-0000000000c3', 'owner-closed-only@test', now()),
  ('00000000-0000-0000-0000-0000000000c4', 'owner-none@test', now()),
  ('00000000-0000-0000-0000-0000000000c5', 'reassign-target@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000c1', 'Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000c2', 'Owner Of Open Incident', 'technician', true),
  ('00000000-0000-0000-0000-0000000000c3', 'Owner Of Closed Incident Only', 'technician', true),
  ('00000000-0000-0000-0000-0000000000c4', 'Owner Of Nothing', 'technician', true),
  ('00000000-0000-0000-0000-0000000000c5', 'Reassignment Target', 'shift_supervisor', true);

insert into systems (id, name) values ('00000000-0000-0000-0000-00000000f301', 'Sys');
insert into locations (id, name) values ('00000000-0000-0000-0000-00000000f302', 'Loc');

-- An OPEN incident owned by c2.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000f310', 'T-301',
        '00000000-0000-0000-0000-00000000f301', '00000000-0000-0000-0000-00000000f302',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000c2', now(),
        '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
        now() + interval '4 hours', 1);

-- A CLOSED incident owned by c3 -- must not block deactivation.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       closed_at, closed_by, root_cause, resolution, readiness_at_close, version)
values ('00000000-0000-0000-0000-00000000f311', 'T-302',
        '00000000-0000-0000-0000-00000000f301', '00000000-0000-0000-0000-00000000f302',
        'desc', 'low', 'closed', 'impact',
        '00000000-0000-0000-0000-0000000000c3', now() - interval '2 days',
        '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
        now(), '00000000-0000-0000-0000-0000000000c1', 'root', 'resolution', 'full', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

do $$
declare
  v_active boolean;
begin
  -- ===== 1. RPC-level: deactivating the open incident's internal owner is rejected =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform admin_set_user_active('00000000-0000-0000-0000-0000000000c2', false);
    insert into results (test, result, detail) values
      ('admin_set_user_active rejects deactivating the internal owner of an open incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('admin_set_user_active rejects deactivating the internal owner of an open incident',
        case when sqlerrm like 'validation%' and sqlerrm like '%גורם מטפל פנימי%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  select active into v_active from profiles where id = '00000000-0000-0000-0000-0000000000c2';
  insert into results (test, result, detail) values
    ('rejected target remains active', case when v_active then 'PASS' else 'FAIL' end, 'active=' || v_active);

  -- ===== 2. Reassign via the EXISTING assign_incident RPC, then deactivation succeeds =====
  perform assign_incident('00000000-0000-0000-0000-00000000f310',
    jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000c5', 'expectedVersion', 1));
  begin
    perform admin_set_user_active('00000000-0000-0000-0000-0000000000c2', false);
    insert into results (test, result, detail) values
      ('deactivation succeeds after reassigning the open incident', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('deactivation succeeds after reassigning the open incident', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 3. Trigger backstop: a RAW UPDATE bypassing the RPC is also rejected =====
  -- Simulates any future/administrative path that does not go through
  -- admin_set_user_active. c3 owns only a CLOSED incident and is a clean
  -- fixture for the positive case in step 4, so this uses c5 (the
  -- reassignment target from step 2, who now owns the open incident and
  -- has never been touched by any RPC in this test).
  begin
    update profiles set active = false where id = '00000000-0000-0000-0000-0000000000c5';
    insert into results (test, result, detail) values
      ('raw UPDATE bypassing the RPC is still rejected by the trigger backstop', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('raw UPDATE bypassing the RPC is still rejected by the trigger backstop',
        case when sqlerrm like 'validation%' and sqlerrm like '%גורם מטפל פנימי%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- ===== 4. Control: an owner of a CLOSED incident only can be deactivated =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform admin_set_user_active('00000000-0000-0000-0000-0000000000c3', false);
    insert into results (test, result, detail) values
      ('CONTROL: owner of a closed incident only can be deactivated', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('CONTROL: owner of a closed incident only can be deactivated', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 5. Control: an owner of nothing can be deactivated =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform admin_set_user_active('00000000-0000-0000-0000-0000000000c4', false);
    insert into results (test, result, detail) values
      ('CONTROL: owner of no incidents can be deactivated', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('CONTROL: owner of no incidents can be deactivated', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 6. Reversibility: reactivating the still-blocked-if-tried-again owner works normally =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform admin_set_user_active('00000000-0000-0000-0000-0000000000c2', true);
    insert into results (test, result, detail) values
      ('reactivating a deactivated (now unassigned) owner succeeds normally', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('reactivating a deactivated (now unassigned) owner succeeds normally', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
