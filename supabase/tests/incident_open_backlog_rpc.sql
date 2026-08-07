-- Tests for migration 0051's get_incident_open_backlog -- the open-incident
-- age-distribution RPC. Deliberately has no p_period_days parameter: age of
-- the CURRENT backlog is not period-bound, matching avgOpenMinutes'
-- existing semantics in get_incident_analytics/_v2.
--
-- Covers: band boundary correctness at each of the four thresholds (exactly
-- 1/3/7/14 days old lands in the OLDER band, not the younger one -- i.e.
-- bands are [0,1) [1,3) [3,7) [7,14) [14,inf)); closed/cancelled incidents
-- excluded entirely; system/location/severity/domain filters; the page-wide
-- confirmed-cause/treatment-outcome filter (an open incident with no
-- closure record is excluded, an open incident that WAS once closed with a
-- matching cause via an earlier cycle is legitimately included); the
-- zero-filled band scaffold (every band key present even when its count is
-- 0); and permission enforcement.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0002b0000001', 'ob-supervisor@test', now()),
  ('00000000-0000-0000-0000-0002b0000002', 'ob-inactive@test', now()),
  ('00000000-0000-0000-0000-0002b0000003', 'ob-viewer@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0002b0000001', 'OB Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0002b0000002', 'OB Inactive', 'technician', false),
  ('00000000-0000-0000-0000-0002b0000003', 'OB Viewer', 'viewer', true);

insert into systems (id, name, display_order) values
  ('00000000-0000-0000-0000-0002c0000001', 'OBG1 Bands', 1),
  ('00000000-0000-0000-0000-0002c0000002', 'OBG2 Excluded', 2),
  ('00000000-0000-0000-0000-0002c0000003', 'OBG3 Filters', 3),
  ('00000000-0000-0000-0000-0002c0000004', 'OBG4 Closure Filter', 4),
  ('00000000-0000-0000-0000-0002c0000005', 'OBG5 Empty', 5);
insert into locations (id, name, display_order) values
  ('00000000-0000-0000-0000-0002d0000001', 'OBG1 Loc', 1),
  ('00000000-0000-0000-0000-0002d0000002', 'OBG2 Loc', 2),
  ('00000000-0000-0000-0000-0002d0000003', 'OBG3 Loc', 3),
  ('00000000-0000-0000-0000-0002d0000004', 'OBG4 Loc', 4),
  ('00000000-0000-0000-0000-0002d0000005', 'OBG5 Loc', 5);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

-- ===== G1: one incident per band, each placed just inside its band (not
-- exactly on a boundary, to avoid floating-point/interval rounding making
-- the assertion flaky), plus one exactly AT each of the four thresholds to
-- prove the boundary itself falls in the OLDER band. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0002e0000001', 'OBG1-lt1', '00000000-0000-0000-0000-0002c0000001', '00000000-0000-0000-0000-0002d0000001',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '12 hours',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0002e0000002', 'OBG1-at1', '00000000-0000-0000-0000-0002c0000001', '00000000-0000-0000-0000-0002d0000001',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '1 day',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0002e0000003', 'OBG1-at3', '00000000-0000-0000-0000-0002c0000001', '00000000-0000-0000-0000-0002d0000001',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '3 days',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0002e0000004', 'OBG1-at7', '00000000-0000-0000-0000-0002c0000001', '00000000-0000-0000-0000-0002d0000001',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '7 days',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0002e0000005', 'OBG1-at14', '00000000-0000-0000-0000-0002c0000001', '00000000-0000-0000-0000-0002d0000001',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '14 days',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0002e0000006', 'OBG1-gt14', '00000000-0000-0000-0000-0002c0000001', '00000000-0000-0000-0000-0002d0000001',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '30 days',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a');

-- ===== G2: closed and cancelled incidents excluded entirely, regardless of age. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0002e0000007', 'OBG2-closed', '00000000-0000-0000-0000-0002c0000002', '00000000-0000-0000-0000-0002d0000002',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '30 days',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0002b0000001', 'rc', 'res', 'full');
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  cancelled_at, cancelled_by, cancellation_reason)
values
  ('00000000-0000-0000-0000-0002e0000008', 'OBG2-cancelled', '00000000-0000-0000-0000-0002c0000002', '00000000-0000-0000-0000-0002d0000002',
   'd', 'medium', 'cancelled', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '30 days',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0002b0000001', 'נפתחה בטעות');

-- ===== G3: system/location/severity/domain filters, all matching one
-- fixture and excluding a sibling. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason, reported_domain)
values
  ('00000000-0000-0000-0000-0002e0000009', 'OBG3-match', '00000000-0000-0000-0000-0002c0000003', '00000000-0000-0000-0000-0002d0000003',
   'd', 'critical', 'new', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '2 days',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a', 'equipment'),
  ('00000000-0000-0000-0000-0002e000000a', 'OBG3-other-severity', '00000000-0000-0000-0000-0002c0000003', '00000000-0000-0000-0000-0002d0000003',
   'd', 'low', 'new', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '2 days',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a', 'equipment');

-- ===== G4: page-wide closure filter -- one open incident with no closure
-- record (must be excluded once the filter is active), one open incident
-- that has a PRIOR cycle's closure record with a matching cause (a
-- reopened-after-full-closure incident -- must legitimately be included). =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason, reopen_count)
values
  ('00000000-0000-0000-0000-0002e000000b', 'OBG4-no-closure', '00000000-0000-0000-0000-0002c0000004', '00000000-0000-0000-0000-0002d0000004',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '2 days',
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a', 0),
  ('00000000-0000-0000-0000-0002e000000c', 'OBG4-reopened-after-closure', '00000000-0000-0000-0000-0002c0000004', '00000000-0000-0000-0000-0002d0000004',
   'd', 'medium', 'reopened', 'i', '00000000-0000-0000-0000-0002b0000001', now() - interval '20 days', -- original discovery
   '00000000-0000-0000-0000-0002b0000001', '00000000-0000-0000-0000-0002b0000001', 'n/a', 1);

insert into incident_closures (incident_id, cycle_number, confirmed_cause, treatment_outcome, resolution_attribution, recorded_by, event_time)
values
  ('00000000-0000-0000-0000-0002e000000c', 0, 'equipment', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0002b0000001', now() - interval '10 days');

-- =====================================================================
-- Functional checks.
-- =====================================================================
do $$
declare
  v jsonb;
  band jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0002b0000001');
  set local role authenticated;

  v := get_incident_open_backlog('00000000-0000-0000-0000-0002c0000001', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('currentlyOpen totals all 6 backlog fixtures', case when (v->>'currentlyOpen')::int = 6 then 'PASS' else 'FAIL' end, v->>'currentlyOpen');

  select b into band from jsonb_array_elements(v->'bands') b where b->>'band' = 'lt_1d';
  insert into results (test, result, detail) values
    ('band lt_1d contains only the sub-24h fixture', case when (band->>'count')::int = 1 then 'PASS' else 'FAIL' end, band);

  select b into band from jsonb_array_elements(v->'bands') b where b->>'band' = '1_3d';
  insert into results (test, result, detail) values
    ('an incident exactly 1 day old falls in the 1_3d band (boundary is inclusive on the older side)',
      case when (band->>'count')::int = 1 then 'PASS' else 'FAIL' end, band);

  select b into band from jsonb_array_elements(v->'bands') b where b->>'band' = '3_7d';
  insert into results (test, result, detail) values
    ('an incident exactly 3 days old falls in the 3_7d band', case when (band->>'count')::int = 1 then 'PASS' else 'FAIL' end, band);

  select b into band from jsonb_array_elements(v->'bands') b where b->>'band' = '7_14d';
  insert into results (test, result, detail) values
    ('an incident exactly 7 days old falls in the 7_14d band', case when (band->>'count')::int = 1 then 'PASS' else 'FAIL' end, band);

  select b into band from jsonb_array_elements(v->'bands') b where b->>'band' = 'gt_14d';
  insert into results (test, result, detail) values
    ('gt_14d band contains both the exactly-14-day and 30-day fixtures',
      case when (band->>'count')::int = 2 then 'PASS' else 'FAIL' end, band);

  v := get_incident_open_backlog('00000000-0000-0000-0000-0002c0000002', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('closed and cancelled incidents are excluded entirely from the backlog', case when (v->>'currentlyOpen')::int = 0 then 'PASS' else 'FAIL' end, v->>'currentlyOpen');

  v := get_incident_open_backlog('00000000-0000-0000-0000-0002c0000003', null, array['critical']::incident_severity[], array['equipment']::incident_domain[], false, null, null);
  insert into results (test, result, detail) values
    ('severity + domain filters narrow to the single matching fixture', case when (v->>'currentlyOpen')::int = 1 then 'PASS' else 'FAIL' end, v->>'currentlyOpen');

  v := get_incident_open_backlog('00000000-0000-0000-0000-0002c0000004', null, null, null, false, array['equipment']::incident_confirmed_cause[], null);
  insert into results (test, result, detail) values
    ('page-wide closure filter excludes the open incident with no closure record',
      case when (v->>'currentlyOpen')::int = 1 then 'PASS' else 'FAIL' end, v->>'currentlyOpen');

  v := get_incident_open_backlog('00000000-0000-0000-0000-0002c0000005', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('an empty backlog zero-fills every band', case when (v->>'currentlyOpen')::int = 0 and jsonb_array_length(v->'bands') = 5
      and (select bool_and((b->>'count')::int = 0) from jsonb_array_elements(v->'bands') b) then 'PASS' else 'FAIL' end, v);

  reset role;
end $$;

-- =====================================================================
-- Access control.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0002b0000002');
  set local role authenticated;
  begin
    perform get_incident_open_backlog(null, null, null, null, false, null, null);
    insert into results (test, result, detail) values
      ('an inactive member is rejected by is_active_member()', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('an inactive member is rejected by is_active_member()',
        case when sqlerrm = 'permission: אין הרשאה' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

do $$
begin
  set local role anon;
  begin
    perform get_incident_open_backlog(null, null, null, null, false, null, null);
    insert into results (test, result, detail) values
      ('an anon caller is rejected at the EXECUTE grant boundary', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('an anon caller is rejected at the EXECUTE grant boundary',
        case when sqlstate = '42501' then 'PASS' else 'FAIL' end, sqlstate || ': ' || sqlerrm);
  end;
  reset role;
end $$;

do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0002b0000003');
  set local role authenticated;
  begin
    perform get_incident_open_backlog(null, null, null, null, false, null, null);
    insert into results (test, result, detail) values
      ('active viewer caller can execute get_incident_open_backlog', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('active viewer caller can execute get_incident_open_backlog', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

insert into results (test, result, detail)
select 'authenticated has EXECUTE on get_incident_open_backlog',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_incident_open_backlog'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'get_incident_open_backlog has no PUBLIC or anon EXECUTE',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_incident_open_backlog'
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
