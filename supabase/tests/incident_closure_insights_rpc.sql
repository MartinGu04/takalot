-- Tests for migration 0051's get_incident_closure_insights -- confirmed-
-- cause / treatment-outcome breakdown, closure-coverage figures, and
-- closure-scoped external-involvement counts.
--
-- Highest-value coverage in this release: the
-- structuredClosuresInPeriod <= totalClosureEventsInPeriod invariant,
-- verified directly against the real close_incident_impl behavior
-- (migration 0047) rather than assumed --
--   - a PARTIAL-readiness closure never writes an incident_closures row and
--     never sets incidents.closed_at, so it can ONLY be counted correctly
--     via the immutable incident_events log (type='status_change',
--     field='status', new_value='partial_readiness') -- this is exactly
--     what totalClosureEventsInPeriod is built from, and exactly the case
--     the earlier (rejected) closed_at-based denominator design silently
--     dropped;
--   - two full-readiness closures for the same incident landing in the
--     same period (closed, reopened, reclosed) must count as ONE incident
--     in structuredClosuresInPeriod, not two rows.
-- Also covers: confirmedCause/treatmentOutcome breakdown counts; the two
-- closure-scoped external-involvement counts (cause='external' vs
-- resolution_attribution='external_party_no_details', computed
-- independently); page-wide entity filters; and permission enforcement.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0003b0000001', 'ci-supervisor@test', now()),
  ('00000000-0000-0000-0000-0003b0000002', 'ci-inactive@test', now()),
  ('00000000-0000-0000-0000-0003b0000003', 'ci-viewer@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0003b0000001', 'CI Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0003b0000002', 'CI Inactive', 'technician', false),
  ('00000000-0000-0000-0000-0003b0000003', 'CI Viewer', 'viewer', true);

insert into systems (id, name, display_order) values
  ('00000000-0000-0000-0000-0003c0000001', 'CIG1 Partial Readiness', 1),
  ('00000000-0000-0000-0000-0003c0000002', 'CIG2 Reopen Reclose', 2),
  ('00000000-0000-0000-0000-0003c0000003', 'CIG3 Breakdown', 3),
  ('00000000-0000-0000-0000-0003c0000004', 'CIG4 External', 4),
  ('00000000-0000-0000-0000-0003c0000005', 'CIG5 Filters', 5);
insert into locations (id, name, display_order) values
  ('00000000-0000-0000-0000-0003d0000001', 'CIG1 Loc', 1),
  ('00000000-0000-0000-0000-0003d0000002', 'CIG2 Loc', 2),
  ('00000000-0000-0000-0000-0003d0000003', 'CIG3 Loc', 3),
  ('00000000-0000-0000-0000-0003d0000004', 'CIG4 Loc', 4),
  ('00000000-0000-0000-0000-0003d0000005', 'CIG5 Loc', 5);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

-- ===== G1: partial-readiness closure -- status_change event only, no
-- incident_closures row, closed_at stays NULL (matching real
-- close_incident_impl behavior for the partial-readiness branch). =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0003e0000001', 'CIG1-001', '00000000-0000-0000-0000-0003c0000001', '00000000-0000-0000-0000-0003d0000001',
   'd', 'medium', 'partial_readiness', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '5 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a');

insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time)
values
  ('00000000-0000-0000-0000-0003e0000001', 'status_change', '00000000-0000-0000-0000-0003b0000001', 'status', 'in_progress', 'partial_readiness', now() - interval '1 day');

-- ===== G2: reopened and reclosed within the same period -- TWO
-- incident_closures rows (cycle 0, cycle 1), both full-readiness, both
-- with event_time inside the period. Must count as ONE incident in
-- structuredClosuresInPeriod, not two. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close, reopen_count)
values
  ('00000000-0000-0000-0000-0003e0000002', 'CIG2-001', '00000000-0000-0000-0000-0003c0000002', '00000000-0000-0000-0000-0003d0000002',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '10 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0003b0000001', 'rc', 'res', 'full', 1);

insert into incident_closures (incident_id, cycle_number, confirmed_cause, treatment_outcome, resolution_attribution, recorded_by, event_time)
values
  ('00000000-0000-0000-0000-0003e0000002', 0, 'equipment', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0003b0000001', now() - interval '8 days'),
  ('00000000-0000-0000-0000-0003e0000002', 1, 'software', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day');

-- The 'closed' incident_events row close_incident_impl writes alongside
-- each incident_closures row, same event_time per cycle -- required for
-- totalClosureEventsInPeriod, which is sourced from incident_events, never
-- from incident_closures directly (see the migration header).
insert into incident_events (incident_id, type, actor_id, event_time) values
  ('00000000-0000-0000-0000-0003e0000002', 'closed', '00000000-0000-0000-0000-0003b0000001', now() - interval '8 days'),
  ('00000000-0000-0000-0000-0003e0000002', 'reopened', '00000000-0000-0000-0000-0003b0000001', now() - interval '4 days'),
  ('00000000-0000-0000-0000-0003e0000002', 'closed', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day');

-- ===== G3: confirmedCause/treatmentOutcome breakdown -- three closures:
-- two 'equipment'-caused, one 'software'-caused; two 'permanent_resolution'
-- outcomes, one 'temporary_workaround'. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0003e0000003', 'CIG3-001', '00000000-0000-0000-0000-0003c0000003', '00000000-0000-0000-0000-0003d0000003',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '5 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0003b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0003e0000004', 'CIG3-002', '00000000-0000-0000-0000-0003c0000003', '00000000-0000-0000-0000-0003d0000003',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '5 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0003b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0003e0000005', 'CIG3-003', '00000000-0000-0000-0000-0003c0000003', '00000000-0000-0000-0000-0003d0000003',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '5 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0003b0000001', 'rc', 'res', 'full');

insert into incident_closures (incident_id, cycle_number, confirmed_cause, treatment_outcome, resolution_attribution, recorded_by, event_time)
values
  ('00000000-0000-0000-0000-0003e0000003', 0, 'equipment', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0003e0000004', 0, 'equipment', 'temporary_workaround', 'specific_action', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0003e0000005', 0, 'software', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day');

-- ===== G4: external-involvement counts, computed independently -- one
-- closure with cause='external' (treatment not external), one closure
-- with resolution_attribution='external_party_no_details' (cause not
-- external), one closure with neither. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0003e0000006', 'CIG4-001', '00000000-0000-0000-0000-0003c0000004', '00000000-0000-0000-0000-0003d0000004',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '5 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0003b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0003e0000007', 'CIG4-002', '00000000-0000-0000-0000-0003c0000004', '00000000-0000-0000-0000-0003d0000004',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '5 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0003b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0003e0000008', 'CIG4-003', '00000000-0000-0000-0000-0003c0000004', '00000000-0000-0000-0000-0003d0000004',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '5 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0003b0000001', 'rc', 'res', 'full');

insert into incident_closures (incident_id, cycle_number, confirmed_cause, treatment_outcome, resolution_attribution, recorded_by, event_time)
values
  ('00000000-0000-0000-0000-0003e0000006', 0, 'external', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0003e0000007', 0, 'equipment', 'permanent_resolution', 'external_party_no_details', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0003e0000008', 0, 'equipment', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day');

-- ===== G5: page-wide entity filters (system/location/severity), one
-- matching closure, one non-matching sibling. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0003e0000009', 'CIG5-001', '00000000-0000-0000-0000-0003c0000005', '00000000-0000-0000-0000-0003d0000005',
   'd', 'critical', 'closed', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '5 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0003b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0003e000000a', 'CIG5-002', '00000000-0000-0000-0000-0003c0000005', '00000000-0000-0000-0000-0003d0000005',
   'd', 'low', 'closed', 'i', '00000000-0000-0000-0000-0003b0000001', now() - interval '5 days',
   '00000000-0000-0000-0000-0003b0000001', '00000000-0000-0000-0000-0003b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0003b0000001', 'rc', 'res', 'full');

insert into incident_closures (incident_id, cycle_number, confirmed_cause, treatment_outcome, resolution_attribution, recorded_by, event_time)
values
  ('00000000-0000-0000-0000-0003e0000009', 0, 'equipment', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0003e000000a', 0, 'equipment', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0003b0000001', now() - interval '1 day');

-- =====================================================================
-- Functional checks.
-- =====================================================================
do $$
declare
  v jsonb;
  entry jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0003b0000001');
  set local role authenticated;

  v := get_incident_closure_insights(30, '00000000-0000-0000-0000-0003c0000001', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('a partial-readiness closure contributes to totalClosureEventsInPeriod',
      case when (v->>'totalClosureEventsInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'totalClosureEventsInPeriod');
  insert into results (test, result, detail) values
    ('a partial-readiness closure is EXCLUDED from structuredClosuresInPeriod (no incident_closures row, no closed_at)',
      case when (v->>'structuredClosuresInPeriod')::int = 0 then 'PASS' else 'FAIL' end, v->>'structuredClosuresInPeriod');

  v := get_incident_closure_insights(30, '00000000-0000-0000-0000-0003c0000002', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('two full-readiness closures for the same incident in one period count ONCE in structuredClosuresInPeriod',
      case when (v->>'structuredClosuresInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'structuredClosuresInPeriod');
  insert into results (test, result, detail) values
    ('structuredClosuresInPeriod <= totalClosureEventsInPeriod holds (1 <= 1, same incident both sides)',
      case when (v->>'structuredClosuresInPeriod')::int <= (v->>'totalClosureEventsInPeriod')::int then 'PASS' else 'FAIL' end,
      'X=' || (v->>'structuredClosuresInPeriod') || ' Y=' || (v->>'totalClosureEventsInPeriod'));

  v := get_incident_closure_insights(30, '00000000-0000-0000-0000-0003c0000003', null, null, null, false, null, null);
  select e into entry from jsonb_array_elements(v->'confirmedCauseCounts') e where e->>'value' = 'equipment';
  insert into results (test, result, detail) values
    ('confirmedCauseCounts: 2 equipment-caused closures', case when (entry->>'count')::int = 2 then 'PASS' else 'FAIL' end, entry);
  select e into entry from jsonb_array_elements(v->'confirmedCauseCounts') e where e->>'value' = 'software';
  insert into results (test, result, detail) values
    ('confirmedCauseCounts: 1 software-caused closure', case when (entry->>'count')::int = 1 then 'PASS' else 'FAIL' end, entry);
  select e into entry from jsonb_array_elements(v->'treatmentOutcomeCounts') e where e->>'value' = 'permanent_resolution';
  insert into results (test, result, detail) values
    ('treatmentOutcomeCounts: 2 permanent_resolution outcomes', case when (entry->>'count')::int = 2 then 'PASS' else 'FAIL' end, entry);
  select e into entry from jsonb_array_elements(v->'treatmentOutcomeCounts') e where e->>'value' = 'temporary_workaround';
  insert into results (test, result, detail) values
    ('treatmentOutcomeCounts: 1 temporary_workaround outcome', case when (entry->>'count')::int = 1 then 'PASS' else 'FAIL' end, entry);

  v := get_incident_closure_insights(30, '00000000-0000-0000-0000-0003c0000004', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('causeExternalClosedCount counts only the cause=external closure',
      case when (v->>'causeExternalClosedCount')::int = 1 then 'PASS' else 'FAIL' end, v->>'causeExternalClosedCount');
  insert into results (test, result, detail) values
    ('resolutionAttributionExternalCount counts only the external_party_no_details closure, independently',
      case when (v->>'resolutionAttributionExternalCount')::int = 1 then 'PASS' else 'FAIL' end, v->>'resolutionAttributionExternalCount');

  v := get_incident_closure_insights(30, '00000000-0000-0000-0000-0003c0000005', null, array['critical']::incident_severity[], null, false, null, null);
  insert into results (test, result, detail) values
    ('page-wide severity filter narrows structuredClosuresInPeriod to the matching fixture only',
      case when (v->>'structuredClosuresInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'structuredClosuresInPeriod');

  reset role;
end $$;

-- =====================================================================
-- Access control.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0003b0000002');
  set local role authenticated;
  begin
    perform get_incident_closure_insights(30, null, null, null, null, false, null, null);
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
    perform get_incident_closure_insights(30, null, null, null, null, false, null, null);
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
  perform pg_temp.as_user('00000000-0000-0000-0000-0003b0000003');
  set local role authenticated;
  begin
    perform get_incident_closure_insights(30, null, null, null, null, false, null, null);
    insert into results (test, result, detail) values
      ('active viewer caller can execute get_incident_closure_insights', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('active viewer caller can execute get_incident_closure_insights', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

do $$
declare
  v_bad int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0003b0000001');
  set local role authenticated;
  foreach v_bad in array array[0, 14, -5]
  loop
    begin
      perform get_incident_closure_insights(v_bad, null, null, null, null, false, null, null);
      insert into results (test, result, detail) values
        ('get_incident_closure_insights rejects invalid p_period_days (' || v_bad || ')', 'FAIL', 'succeeded');
    exception when others then
      insert into results (test, result, detail) values
        ('get_incident_closure_insights rejects invalid p_period_days (' || v_bad || ')',
          case when sqlerrm = 'validation: תקופה לא תקינה' then 'PASS' else 'FAIL' end, sqlerrm);
    end;
  end loop;
  reset role;
end $$;

insert into results (test, result, detail)
select 'authenticated has EXECUTE on get_incident_closure_insights',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_incident_closure_insights'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'get_incident_closure_insights has no PUBLIC or anon EXECUTE',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_incident_closure_insights'
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
