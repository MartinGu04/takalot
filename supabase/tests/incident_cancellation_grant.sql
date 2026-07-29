-- Tests for migration 0018: authenticated EXECUTE is granted on
-- cancel_incident ONLY -- add_incident_report and set_incident_status_check
-- must remain revoked. Also proves the EXECUTE grant alone does not widen
-- WHO may cancel an incident: cancel_incident's internal is_operational_role()
-- check still rejects a non-operational authenticated caller (technician).
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'technician@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Shift Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000e2', 'Technician', 'technician', true);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000f501', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000f502', 'Loc', 1);

insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000f510', 'T-501',
        '00000000-0000-0000-0000-00000000f501', '00000000-0000-0000-0000-00000000f502',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000e1', now() - interval '1 hour',
        '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
        now() + interval '4 hours', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

-- =====================================================================
-- 1. ACL-level: authenticated has EXECUTE on cancel_incident, and only it
--    -- effective-ACL inspection, same pattern as chapter2_pr3_incident_rpcs.
-- =====================================================================
insert into results (test, result, detail)
select 'authenticated has EXECUTE on cancel_incident',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'cancel_incident'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'add_incident_report and set_incident_status_check remain revoked from authenticated',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('add_incident_report', 'set_incident_status_check')
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'cancel_incident still has no PUBLIC or anon EXECUTE',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'cancel_incident'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where (a.grantee = 0 or a.grantee = 'anon'::regrole) and a.privilege_type = 'EXECUTE'
  );

-- =====================================================================
-- 2. Functional, AS the authenticated role (not the owning/postgres role):
--    an operational-role caller can now actually reach cancel_incident
--    end-to-end through the real EXECUTE boundary.
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
  set local role authenticated;
  begin
    v_incident := cancel_incident('00000000-0000-0000-0000-00000000f510',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'cancellationReason', 'נפתחה בטעות'));
    insert into results (test, result, detail) values
      ('operational-role authenticated caller can call cancel_incident through the real EXECUTE grant',
        case when v_incident.status = 'cancelled' then 'PASS' else 'FAIL' end, 'status=' || v_incident.status);
  exception when others then
    insert into results (test, result, detail) values
      ('operational-role authenticated caller can call cancel_incident through the real EXECUTE grant',
        'FAIL', sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 3. Functional, AS the authenticated role: a NON-operational caller
--    (technician) is still rejected -- by the function's OWN internal
--    is_operational_role() check, not by the EXECUTE grant (which is now
--    broad, by design, exactly like every other client-facing incident RPC).
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
  set local role authenticated;
  begin
    perform cancel_incident('00000000-0000-0000-0000-00000000f510',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'cancellationReason', 'נפתחה בטעות'));
    insert into results (test, result, detail) values
      ('non-operational authenticated caller (technician) is rejected by is_operational_role()', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('non-operational authenticated caller (technician) is rejected by is_operational_role()',
        case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 4. Functional, AS the authenticated role: add_incident_report and
--    set_incident_status_check are still unreachable by ANY authenticated
--    caller -- rejected before even entering the function body (insufficient
--    privilege at the EXECUTE boundary itself, not a raised exception).
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
  set local role authenticated;
  begin
    perform add_incident_report('00000000-0000-0000-0000-00000000f510',
      jsonb_build_object('expectedVersion', 1));
    insert into results (test, result, detail) values
      ('add_incident_report remains unreachable by an authenticated client', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('add_incident_report remains unreachable by an authenticated client',
        case when sqlstate = '42501' then 'PASS' else 'FAIL' end, sqlstate || ': ' || sqlerrm);
  end;
  begin
    perform set_incident_status_check('00000000-0000-0000-0000-00000000f510',
      jsonb_build_object('expectedVersion', 1));
    insert into results (test, result, detail) values
      ('set_incident_status_check remains unreachable by an authenticated client', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('set_incident_status_check remains unreachable by an authenticated client',
        case when sqlstate = '42501' then 'PASS' else 'FAIL' end, sqlstate || ': ' || sqlerrm);
  end;
  reset role;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
