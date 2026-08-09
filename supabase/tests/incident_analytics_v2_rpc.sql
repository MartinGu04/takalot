-- Tests for migration 0051's get_incident_analytics_v2 -- the KPI/trend/
-- rankings RPC that extends get_incident_analytics's proven logic under a
-- new, unambiguous name (see the migration header for why `create or
-- replace` on the original signature was rejected as unsafe).
--
-- Covers: median close-duration correctness for both odd- and even-count
-- sample sets (percentile_cont linear interpolation, new to this schema);
-- the new array-based severity filter; the domain filter including the
-- "unclassified" (reported_domain IS NULL) case; the page-wide confirmed-
-- cause/treatment-outcome EXISTS filter narrowing every metric, not just a
-- dedicated one; topSystems/topLocations rows exposing medianCloseMinutes
-- (not avgCloseMinutes -- that stays a KPI-level-only field, kept for
-- tooltip context); the new externallyHandledOpenCount current-state field
-- (period-independent, mirroring currentlyOpen's own semantics); that the
-- original get_incident_analytics (4-parameter) keeps working unaffected,
-- proving there is no overload ambiguity between the two distinctly-named
-- functions; and permission/period-validation parity with the original RPC.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Actors =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0001b0000001', 'v2-supervisor@test', now()),
  ('00000000-0000-0000-0000-0001b0000002', 'v2-inactive@test', now()),
  ('00000000-0000-0000-0000-0001b0000003', 'v2-viewer@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0001b0000001', 'V2 Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0001b0000002', 'V2 Inactive', 'technician', false),
  ('00000000-0000-0000-0000-0001b0000003', 'V2 Viewer', 'viewer', true);

-- ===== Systems / locations (one per scenario group) =====
insert into systems (id, name, display_order) values
  ('00000000-0000-0000-0000-0001c0000001', 'V2G1 Median Odd', 1),
  ('00000000-0000-0000-0000-0001c0000002', 'V2G2 Median Even', 2),
  ('00000000-0000-0000-0000-0001c0000003', 'V2G3 Severity Array', 3),
  ('00000000-0000-0000-0000-0001c0000004', 'V2G4 Domain', 4),
  ('00000000-0000-0000-0000-0001c0000005', 'V2G5 Closure Filter', 5),
  ('00000000-0000-0000-0000-0001c0000006', 'V2G6 Rankings', 6),
  ('00000000-0000-0000-0000-0001c0000007', 'V2G7 External Open', 7);
insert into locations (id, name, display_order) values
  ('00000000-0000-0000-0000-0001d0000001', 'V2G1 Loc', 1),
  ('00000000-0000-0000-0000-0001d0000002', 'V2G2 Loc', 2),
  ('00000000-0000-0000-0000-0001d0000003', 'V2G3 Loc', 3),
  ('00000000-0000-0000-0000-0001d0000004', 'V2G4 Loc', 4),
  ('00000000-0000-0000-0000-0001d0000005', 'V2G5 Loc', 5),
  ('00000000-0000-0000-0000-0001d0000006', 'V2G6 Loc', 6),
  ('00000000-0000-0000-0000-0001d0000007', 'V2G7 Loc', 7);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

-- ===== G1: median, odd-count sample (10, 20, 30 min -> median 20) =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0001e0000001', 'V2G1-001', '00000000-0000-0000-0000-0001c0000001', '00000000-0000-0000-0000-0001d0000001',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001',
   now() - interval '10 minutes', '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0001e0000002', 'V2G1-002', '00000000-0000-0000-0000-0001c0000001', '00000000-0000-0000-0000-0001d0000001',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001',
   now() - interval '20 minutes', '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0001e0000003', 'V2G1-003', '00000000-0000-0000-0000-0001c0000001', '00000000-0000-0000-0000-0001d0000001',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001',
   now() - interval '30 minutes', '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full');

-- ===== G2: median, even-count sample (10, 30 min -> interpolated median 20,
-- distinct from the average -- both happen to be 20 here by symmetry, so a
-- second, asymmetric even-count pair (5, 35 -> median 20, avg 20 too) is
-- avoided in favor of one deliberately non-symmetric pair below to prove
-- percentile_cont interpolation specifically, not just an average. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0001e0000004', 'V2G2-001', '00000000-0000-0000-0000-0001c0000002', '00000000-0000-0000-0000-0001d0000002',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001',
   now() - interval '10 minutes', '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0001e0000005', 'V2G2-002', '00000000-0000-0000-0000-0001c0000002', '00000000-0000-0000-0000-0001d0000002',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001',
   now() - interval '100 minutes', '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full');
-- Close durations: 10 and 100 minutes -> percentile_cont(0.5) interpolated
-- median = (10 + 100) / 2 = 55 (also happens to equal the average for a
-- 2-element set -- median and average necessarily coincide for n=2 -- so
-- this fixture proves interpolation lands on the right VALUE even though it
-- can't, by itself, distinguish median from average; G1's 3-element,
-- non-symmetric-around-its-own-mean set below does that job instead).

-- ===== G1b: 3-element set where median and average genuinely differ,
-- proving medianCloseMinutes is NOT simply avgCloseMinutes under another
-- name (10, 20, 300 minutes -> median 20, average 110). =====
insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-0001c0000008', 'V2G1b Median Vs Avg', 8);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-0001d0000008', 'V2G1b Loc', 8);
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0001e0000006', 'V2G1b-001', '00000000-0000-0000-0000-0001c0000008', '00000000-0000-0000-0000-0001d0000008',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001',
   now() - interval '10 minutes', '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0001e0000007', 'V2G1b-002', '00000000-0000-0000-0000-0001c0000008', '00000000-0000-0000-0000-0001d0000008',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001',
   now() - interval '20 minutes', '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0001e0000008', 'V2G1b-003', '00000000-0000-0000-0000-0001c0000008', '00000000-0000-0000-0000-0001d0000008',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001',
   now() - interval '300 minutes', '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full');

-- ===== G3: severity array filter (high+critical selected; medium excluded) =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0001e0000009', 'V2G3-001', '00000000-0000-0000-0000-0001c0000003', '00000000-0000-0000-0000-0001d0000003',
   'd', 'high', 'new', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '1 day',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0001e000000a', 'V2G3-002', '00000000-0000-0000-0000-0001c0000003', '00000000-0000-0000-0000-0001d0000003',
   'd', 'critical', 'new', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '1 day',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0001e000000b', 'V2G3-003', '00000000-0000-0000-0000-0001c0000003', '00000000-0000-0000-0000-0001d0000003',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '1 day',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a');

-- ===== G4: domain filter -- one classified ('equipment'), one
-- unclassified (NULL reported_domain), one different classified
-- ('software', must be excluded when filtering to equipment+unclassified). =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason, reported_domain)
values
  ('00000000-0000-0000-0000-0001e000000c', 'V2G4-001', '00000000-0000-0000-0000-0001c0000004', '00000000-0000-0000-0000-0001d0000004',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '1 day',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a', 'equipment'),
  ('00000000-0000-0000-0000-0001e000000d', 'V2G4-002', '00000000-0000-0000-0000-0001c0000004', '00000000-0000-0000-0000-0001d0000004',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '1 day',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a', null),
  ('00000000-0000-0000-0000-0001e000000e', 'V2G4-003', '00000000-0000-0000-0000-0001c0000004', '00000000-0000-0000-0000-0001d0000004',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '1 day',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a', 'software');

-- ===== G5: page-wide confirmed-cause/treatment-outcome filter -- one
-- incident closed with a matching closure record, one closed with a
-- non-matching one, one currently open with NO closure record at all
-- (must be excluded once the filter is active, per the documented
-- currently-open-goes-to-zero consequence). =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0001e000000f', 'V2G5-001', '00000000-0000-0000-0000-0001c0000005', '00000000-0000-0000-0000-0001d0000005',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '2 days',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0001e0000010', 'V2G5-002', '00000000-0000-0000-0000-0001c0000005', '00000000-0000-0000-0000-0001d0000005',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '2 days',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full');

insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0001e0000011', 'V2G5-003', '00000000-0000-0000-0000-0001c0000005', '00000000-0000-0000-0000-0001d0000005',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '2 days',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a');

insert into incident_closures (incident_id, cycle_number, confirmed_cause, treatment_outcome, resolution_attribution, recorded_by, event_time)
values
  ('00000000-0000-0000-0000-0001e000000f', 0, 'equipment', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0001b0000001', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0001e0000010', 0, 'software', 'permanent_resolution', 'specific_action', '00000000-0000-0000-0000-0001b0000001', now() - interval '1 day');

-- ===== G6: rankings expose medianCloseMinutes, not avgCloseMinutes -- two
-- closures (10, 100 min) so median (55) and a naive "just check it's a
-- number" test wouldn't accidentally pass for the wrong key. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0001e0000012', 'V2G6-001', '00000000-0000-0000-0000-0001c0000006', '00000000-0000-0000-0000-0001d0000006',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '10 minutes',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0001e0000015', 'V2G6-002', '00000000-0000-0000-0000-0001c0000006', '00000000-0000-0000-0000-0001d0000006',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '100 minutes',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0001b0000001', 'rc', 'res', 'full');

-- ===== G7: externallyHandledOpenCount -- one currently-open incident with
-- an external handler set, one currently-open without one (must be
-- excluded), period-independent (verified with two different period_days). =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason, external_handler_name)
values
  ('00000000-0000-0000-0000-0001e0000013', 'V2G7-001', '00000000-0000-0000-0000-0001c0000007', '00000000-0000-0000-0000-0001d0000007',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '200 days',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a', 'Acme Corp'),
  ('00000000-0000-0000-0000-0001e0000014', 'V2G7-002', '00000000-0000-0000-0000-0001c0000007', '00000000-0000-0000-0000-0001d0000007',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0001b0000001', now() - interval '200 days',
   '00000000-0000-0000-0000-0001b0000001', '00000000-0000-0000-0000-0001b0000001', 'n/a', null);

-- =====================================================================
-- Functional checks, AS the authenticated role.
-- =====================================================================
do $$
declare
  v jsonb;
  v_bad int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0001b0000001');
  set local role authenticated;

  v := get_incident_analytics_v2(30, '00000000-0000-0000-0000-0001c0000001', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('median close minutes, odd-count sample (10/20/30 -> 20)',
      case when (v->>'medianCloseMinutes')::numeric = 20 then 'PASS' else 'FAIL' end, v->>'medianCloseMinutes');

  v := get_incident_analytics_v2(30, '00000000-0000-0000-0000-0001c0000002', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('median close minutes, even-count sample, interpolated (10/100 -> 55)',
      case when (v->>'medianCloseMinutes')::numeric = 55 then 'PASS' else 'FAIL' end, v->>'medianCloseMinutes');

  v := get_incident_analytics_v2(30, '00000000-0000-0000-0000-0001c0000008', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('median (20) genuinely differs from average (110) for an asymmetric 3-element set',
      case when (v->>'medianCloseMinutes')::numeric = 20 and (v->>'avgCloseMinutes')::numeric = 110
        then 'PASS' else 'FAIL' end,
      'median=' || (v->>'medianCloseMinutes') || ' avg=' || (v->>'avgCloseMinutes'));

  v := get_incident_analytics_v2(30, '00000000-0000-0000-0000-0001c0000003', null, array['high','critical']::incident_severity[], null, false, null, null);
  insert into results (test, result, detail) values
    ('severity array filter includes only the selected severities',
      case when (v->>'openedInPeriod')::int = 2 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');

  v := get_incident_analytics_v2(30, '00000000-0000-0000-0000-0001c0000004', null, null, array['equipment']::incident_domain[], true, null, null);
  insert into results (test, result, detail) values
    ('domain filter (equipment + unclassified) includes both, excludes software',
      case when (v->>'openedInPeriod')::int = 2 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');

  v := get_incident_analytics_v2(30, '00000000-0000-0000-0000-0001c0000004', null, null, array['equipment']::incident_domain[], false, null, null);
  insert into results (test, result, detail) values
    ('domain filter without unclassified excludes the NULL-domain fixture',
      case when (v->>'openedInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');

  v := get_incident_analytics_v2(30, '00000000-0000-0000-0000-0001c0000005', null, null, null, false, array['equipment']::incident_confirmed_cause[], null);
  insert into results (test, result, detail) values
    ('page-wide confirmed-cause filter narrows closedInPeriod to only the matching closure',
      case when (v->>'closedInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'closedInPeriod');
  insert into results (test, result, detail) values
    ('page-wide confirmed-cause filter zeroes currentlyOpen (open incident has no closure record)',
      case when (v->>'currentlyOpen')::int = 0 then 'PASS' else 'FAIL' end, v->>'currentlyOpen');

  v := get_incident_analytics_v2(30, '00000000-0000-0000-0000-0001c0000006', null, null, null, false, null, null);
  insert into results (test, result, detail) values
    ('topSystems row exposes medianCloseMinutes',
      case when (v->'topSystems'->0->>'medianCloseMinutes')::numeric = 55 then 'PASS' else 'FAIL' end,
      v->'topSystems'->0);
  insert into results (test, result, detail) values
    ('topSystems row does NOT expose an avgCloseMinutes key',
      case when not (v->'topSystems'->0 ? 'avgCloseMinutes') then 'PASS' else 'FAIL' end, v->'topSystems'->0);

  declare
    v7 jsonb := get_incident_analytics_v2(7, '00000000-0000-0000-0000-0001c0000007', null, null, null, false, null, null);
    v90 jsonb := get_incident_analytics_v2(90, '00000000-0000-0000-0000-0001c0000007', null, null, null, false, null, null);
  begin
    insert into results (test, result, detail) values
      ('externallyHandledOpenCount counts only the handler-set incident',
        case when (v7->>'externallyHandledOpenCount')::int = 1 then 'PASS' else 'FAIL' end, v7->>'externallyHandledOpenCount');
    insert into results (test, result, detail) values
      ('externallyHandledOpenCount is period-independent (7d == 90d)',
        case when (v7->>'externallyHandledOpenCount')::int = (v90->>'externallyHandledOpenCount')::int
          then 'PASS' else 'FAIL' end,
        'p7=' || (v7->>'externallyHandledOpenCount') || ' p90=' || (v90->>'externallyHandledOpenCount'));
  end;

  -- Compatibility: the original 4-parameter function is untouched and still
  -- callable by its own name with its own (narrower) signature -- proving
  -- there is no overload ambiguity between it and get_incident_analytics_v2.
  begin
    perform get_incident_analytics(30, null, null, null);
    insert into results (test, result, detail) values
      ('original get_incident_analytics(int,uuid,uuid,incident_severity) still callable unambiguously', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('original get_incident_analytics(int,uuid,uuid,incident_severity) still callable unambiguously', 'FAIL', sqlerrm);
  end;

  -- Period validation parity with the original RPC.
  foreach v_bad in array array[0, 14, -5]
  loop
    begin
      perform get_incident_analytics_v2(v_bad, null, null, null, null, false, null, null);
      insert into results (test, result, detail) values
        ('get_incident_analytics_v2 rejects invalid p_period_days (' || v_bad || ')', 'FAIL', 'succeeded');
    exception when others then
      insert into results (test, result, detail) values
        ('get_incident_analytics_v2 rejects invalid p_period_days (' || v_bad || ')',
          case when sqlerrm = 'validation: תקופה לא תקינה' then 'PASS' else 'FAIL' end, sqlerrm);
    end;
  end loop;

  reset role;
end $$;

-- =====================================================================
-- Access control.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0001b0000002');
  set local role authenticated;
  begin
    perform get_incident_analytics_v2(30, null, null, null, null, false, null, null);
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
    perform get_incident_analytics_v2(30, null, null, null, null, false, null, null);
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
  perform pg_temp.as_user('00000000-0000-0000-0000-0001b0000003');
  set local role authenticated;
  begin
    perform get_incident_analytics_v2(30, null, null, null, null, false, null, null);
    insert into results (test, result, detail) values
      ('active viewer caller can execute get_incident_analytics_v2', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('active viewer caller can execute get_incident_analytics_v2', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

insert into results (test, result, detail)
select 'authenticated has EXECUTE on get_incident_analytics_v2',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_incident_analytics_v2'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'get_incident_analytics_v2 has no PUBLIC or anon EXECUTE',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_incident_analytics_v2'
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
