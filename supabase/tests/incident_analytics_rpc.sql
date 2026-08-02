-- Tests for migration 0036 (get_incident_analytics, the RPC backing the
-- ניתוחים analytics page's first vertical slice) and migration 0040 (adds
-- topLocations to the same RPC's payload, mirroring topSystems exactly).
--
-- Every fixture group below uses its OWN dedicated system (and usually its
-- own dedicated location) so each scenario can be asserted precisely via a
-- p_system_id (and, for the top-systems ordering group, p_location_id)
-- filter, without needing to hand-count interactions across unrelated
-- fixtures sharing the same incidents table.
--
-- Covers: opened counts use discovered_at, not created_at; closed counts
-- use the effective CURRENT/final closed_at (never an earlier, superseded
-- closure); cancelled incidents are excluded from closed/avg-close;
-- a currently reopened incident (status='reopened', closed_at null) is
-- never counted as closed; an incident reopened more than once in the
-- period is counted once, not once per event; currently-open metrics are
-- period-independent; system/location/severity filters narrow every
-- metric individually and in combination; avg close duration (including
-- the null-when-empty case); avg current-open duration (including the
-- null-when-empty case and the clock-skew non-negative clamp); daily and
-- weekly zero-filled buckets; the first/last (possibly partial) bucket
-- boundary is governed by an explicit period filter, not just the
-- date_trunc+scaffold join (verified via a calendar-independent
-- sum(buckets) == period-scalar invariant, since whether the natural
-- weekly boundary is actually partial depends on which day of week the
-- suite happens to run); that individual bucket LABELS are Jerusalem-local
-- calendar dates, not UTC dates (fixtures placed in the 00:00-02:59
-- Jerusalem window via pg_temp.jerusalem_local(), where a UTC-date bug
-- would shift the label by exactly one day -- the earlier sum/length
-- checks alone would not catch this, since a uniform shift preserves both);
-- top-systems ordering (opened desc, currently-open desc, name asc),
-- exclusion of a system with zero incidents opened in the period, and
-- inclusion of a system/location/severity filter combination that matches
-- on all three dimensions at once (not just the negative non-matching
-- case); top-locations ordering/exclusion/avgCloseMinutes, mirroring
-- top-systems exactly (opened desc, currently-open desc, location name asc,
-- exclusion of a location with zero incidents opened in the period even if
-- currently open, and a ranking row's own avgCloseMinutes reflecting only
-- closures within the selected period); and permission enforcement
-- (inactive member rejected, anon rejected at the grant boundary, any
-- active role including viewer accepted) plus period-days validation.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Actors =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000b0000001', 'active-supervisor@test', now()),
  ('00000000-0000-0000-0000-0000b0000002', 'inactive-tech@test', now()),
  ('00000000-0000-0000-0000-0000b0000003', 'active-viewer@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000b0000001', 'Active Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000b0000002', 'Inactive Technician', 'technician', false),
  ('00000000-0000-0000-0000-0000b0000003', 'Active Viewer', 'viewer', true);

-- ===== Systems (one per scenario group, for clean isolation) =====
insert into systems (id, name, display_order) values
  ('00000000-0000-0000-0000-0000c0000001', 'G1 Discover-vs-Created', 1),
  ('00000000-0000-0000-0000-0000c0000002', 'G2 Closure Effective', 2),
  ('00000000-0000-0000-0000-0000c0000003', 'G3 Currently Reopened', 3),
  ('00000000-0000-0000-0000-0000c0000004', 'G4 Cancelled', 4),
  ('00000000-0000-0000-0000-0000c0000005', 'G5 Period Independence', 5),
  ('00000000-0000-0000-0000-0000c0000006', 'G6 Filters', 6),
  ('00000000-0000-0000-0000-0000c0000007', 'G7 Avg Close', 7),
  ('00000000-0000-0000-0000-0000c0000008', 'G7 Avg Close Null', 8),
  ('00000000-0000-0000-0000-0000c0000009', 'G8 Avg Open Clamp', 9),
  ('00000000-0000-0000-0000-0000c000000a', 'G8 Avg Open Null', 10),
  ('00000000-0000-0000-0000-0000c000000b', 'G9 Empty Buckets', 11),
  ('00000000-0000-0000-0000-0000c000000c', 'G9 Boundary', 12),
  ('00000000-0000-0000-0000-0000c000000d', 'Rank-A-System', 13),
  ('00000000-0000-0000-0000-0000c000000e', 'Rank-C-System', 14),
  ('00000000-0000-0000-0000-0000c000000f', 'Zulu-Rank-D-System', 15),
  ('00000000-0000-0000-0000-0000c0000010', 'Alpha-Rank-System', 16),
  ('00000000-0000-0000-0000-0000c0000011', 'Bravo-Rank-System', 17),
  ('00000000-0000-0000-0000-0000c0000012', 'G10 Bucket Date Label', 18),
  ('00000000-0000-0000-0000-0000c0000013', 'G11 Loc Exclusion System', 19),
  ('00000000-0000-0000-0000-0000c0000014', 'Rank System (for locations)', 20),
  ('00000000-0000-0000-0000-0000c0000015', 'G12 Avg Close System (locations)', 21);

-- ===== Locations =====
insert into locations (id, name, display_order) values
  ('00000000-0000-0000-0000-0000d0000001', 'G1 Loc', 1),
  ('00000000-0000-0000-0000-0000d0000002', 'G2 Loc', 2),
  ('00000000-0000-0000-0000-0000d0000003', 'G3 Loc', 3),
  ('00000000-0000-0000-0000-0000d0000004', 'G4 Loc', 4),
  ('00000000-0000-0000-0000-0000d0000005', 'G5 Loc', 5),
  ('00000000-0000-0000-0000-0000d0000006', 'G6 Loc A', 6),
  ('00000000-0000-0000-0000-0000d0000007', 'G6 Loc B', 7),
  ('00000000-0000-0000-0000-0000d0000008', 'G7 Loc', 8),
  ('00000000-0000-0000-0000-0000d0000009', 'G7 Loc Null', 9),
  ('00000000-0000-0000-0000-0000d000000a', 'G8 Loc', 10),
  ('00000000-0000-0000-0000-0000d000000b', 'G8 Loc Null', 11),
  ('00000000-0000-0000-0000-0000d000000c', 'G9 Loc Empty', 12),
  ('00000000-0000-0000-0000-0000d000000d', 'G9 Loc Boundary', 13),
  ('00000000-0000-0000-0000-0000d000000e', 'Rank Loc', 14),
  ('00000000-0000-0000-0000-0000d000000f', 'G10 Loc Date Label', 15),
  ('00000000-0000-0000-0000-0000d0000010', 'G11 Loc Exclusion', 16),
  ('00000000-0000-0000-0000-0000d0000011', 'Rank-A-Location', 17),
  ('00000000-0000-0000-0000-0000d0000012', 'Rank-C-Location', 18),
  ('00000000-0000-0000-0000-0000d0000013', 'Zulu-Rank-D-Location', 19),
  ('00000000-0000-0000-0000-0000d0000014', 'Alpha-Rank-Location', 20),
  ('00000000-0000-0000-0000-0000d0000015', 'Bravo-Rank-Location', 21),
  ('00000000-0000-0000-0000-0000d0000016', 'G12 Avg Close Location', 22);

-- ===== Helpers (same shape as chapter2_close_event_time.sql /
-- incident_cancellation_grant.sql: as_user() stamps the JWT claims a real
-- PostgREST request would carry, period_start_90() replicates the RPC's
-- own Asia/Jerusalem 90-day boundary formula so boundary fixtures line up
-- exactly with what the function under test will compute). =====
create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

create or replace function pg_temp.period_start_90() returns timestamptz language sql as $$
  select (((now() at time zone 'Asia/Jerusalem')::date - 89))::timestamp at time zone 'Asia/Jerusalem';
$$;
grant execute on function pg_temp.period_start_90() to authenticated, anon;

-- Constructs an Asia/Jerusalem-local instant at (today + p_days_offset),
-- p_hour:p_minute local time -- used to place bucket-date-label fixtures
-- deliberately in the 00:00-02:59 Jerusalem window, where the UTC instant
-- is still on the PREVIOUS UTC calendar date (Jerusalem is UTC+2/+3, so
-- its calendar day starts before UTC's does). A bucketing bug that used
-- the UTC date instead of converting to Jerusalem first would misfile a
-- fixture placed here by exactly one day, while a fixture placed at
-- Jerusalem noon would not expose that bug (noon Jerusalem and its UTC
-- instant always share the same calendar date, given only a 2-3 hour
-- offset). p_hour/p_minute are never 0:00 -- deliberately away from the
-- midnight instant itself, per the review's "safely away from midnight"
-- requirement, while staying inside the disagreement window.
create or replace function pg_temp.jerusalem_local(p_days_offset int, p_hour int, p_minute int) returns timestamptz language sql as $$
  select (
    (((now() at time zone 'Asia/Jerusalem')::date + p_days_offset)::timestamp)
    + make_interval(hours => p_hour, mins => p_minute)
  ) at time zone 'Asia/Jerusalem';
$$;
grant execute on function pg_temp.jerusalem_local(int, int, int) to authenticated, anon;

-- ===== Fixture incidents =====
-- G1: discovered_at vs created_at (#1). inc_1a has a recent created_at but
-- an old discovered_at -- must NOT count as opened-in-period. inc_1b is
-- the inverse -- must count.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000001', 'G1-001', '00000000-0000-0000-0000-0000c0000001', '00000000-0000-0000-0000-0000d0000001',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '400 days', now() - interval '1 day',
   '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000002', 'G1-002', '00000000-0000-0000-0000-0000c0000001', '00000000-0000-0000-0000-0000d0000001',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0000b0000001',
   now(), now() - interval '400 days',
   '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

-- G2: closure keys off the effective/final closed_at (#2), and an
-- incident that was reopened-then-reclosed still counts once toward
-- reopened_in_period via its (single) reopened event (#5 sibling check).
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close, reopen_count)
values
  ('00000000-0000-0000-0000-0000e0000003', 'G2-001', '00000000-0000-0000-0000-0000c0000002', '00000000-0000-0000-0000-0000d0000002',
   'd', 'high', 'closed', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '10 days', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', 'rc', 'res', 'full', 1);

insert into incident_events (incident_id, type, actor_id, event_time) values
  ('00000000-0000-0000-0000-0000e0000003', 'closed', '00000000-0000-0000-0000-0000b0000001', now() - interval '9 days'),
  ('00000000-0000-0000-0000-0000e0000003', 'reopened', '00000000-0000-0000-0000-0000b0000001', now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000e0000003', 'closed', '00000000-0000-0000-0000-0000b0000001', now() - interval '1 day');

-- G3: currently reopened is never counted as closed (#4), and an incident
-- reopened twice in-period is still counted ONCE (#5).
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000004', 'G3-001', '00000000-0000-0000-0000-0000c0000003', '00000000-0000-0000-0000-0000d0000003',
   'd', 'low', 'reopened', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '20 days', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

insert into incident_events (incident_id, type, actor_id, event_time) values
  ('00000000-0000-0000-0000-0000e0000004', 'reopened', '00000000-0000-0000-0000-0000b0000001', now() - interval '15 days'),
  ('00000000-0000-0000-0000-0000e0000004', 'reopened', '00000000-0000-0000-0000-0000b0000001', now() - interval '3 days');

-- G4: cancelled incidents are excluded from closed/avg-close, but still
-- count toward opened-in-period, and are excluded from currently-open (#3).
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  cancelled_at, cancelled_by, cancellation_reason)
values
  ('00000000-0000-0000-0000-0000e0000005', 'G4-001', '00000000-0000-0000-0000-0000c0000004', '00000000-0000-0000-0000-0000d0000004',
   'd', 'critical', 'cancelled', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '10 days', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a',
   now() - interval '2 days', '00000000-0000-0000-0000-0000b0000001', 'נפתחה בטעות');

-- G5: currently-open metrics are period-independent (#6), and a system
-- with a currently-open incident opened LONG before any tested period is
-- excluded from top_systems entirely (#14 sibling check).
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000006', 'G5-001', '00000000-0000-0000-0000-0000c0000005', '00000000-0000-0000-0000-0000d0000005',
   'd', 'medium', 'waiting_information', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '200 days', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

-- G6: system/location/severity filters narrow independently and combined (#7).
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000007', 'G6-001', '00000000-0000-0000-0000-0000c0000006', '00000000-0000-0000-0000-0000d0000006',
   'd', 'critical', 'new', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000008', 'G6-002', '00000000-0000-0000-0000-0000c0000006', '00000000-0000-0000-0000-0000d0000007',
   'd', 'low', 'new', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

-- G7: avg close duration, exact value (#8), plus a null-when-empty sibling.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0000e0000009', 'G7-001', '00000000-0000-0000-0000-0000c0000007', '00000000-0000-0000-0000-0000d0000008',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '6 days', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a',
   now() - interval '2 days', '00000000-0000-0000-0000-0000b0000001', 'rc', 'res', 'full'),
  ('00000000-0000-0000-0000-0000e000000a', 'G7-002', '00000000-0000-0000-0000-0000c0000007', '00000000-0000-0000-0000-0000d0000008',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '6 days', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a',
   now() - interval '4 days', '00000000-0000-0000-0000-0000b0000001', 'rc', 'res', 'full');

insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e000000b', 'G7N-001', '00000000-0000-0000-0000-0000c0000008', '00000000-0000-0000-0000-0000d0000009',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

-- G8: avg open duration is exact, and clamped to a non-negative value for
-- a discovered_at a few minutes in the future (clock-skew tolerance) (#9).
-- G8-null: a system with zero incidents -- avgOpenMinutes must be null,
-- currentlyOpen must be 0 (no rows inserted for it at all).
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e000000c', 'G8-001', '00000000-0000-0000-0000-0000c0000009', '00000000-0000-0000-0000-0000d000000a',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now(), '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e000000d', 'G8-002', '00000000-0000-0000-0000-0000c0000009', '00000000-0000-0000-0000-0000d000000a',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() + interval '2 minutes', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

-- G9 boundary: an event just before the 90-day period start (must be
-- EXCLUDED), one exactly at the inclusive lower bound, and one exactly at
-- the inclusive upper bound (now()) (#12).
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e000000e', 'G9-001', '00000000-0000-0000-0000-0000c000000c', '00000000-0000-0000-0000-0000d000000d',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0000b0000001',
   pg_temp.period_start_90() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e000000f', 'G9-002', '00000000-0000-0000-0000-0000c000000c', '00000000-0000-0000-0000-0000d000000d',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0000b0000001',
   pg_temp.period_start_90(), '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000010', 'G9-003', '00000000-0000-0000-0000-0000c000000c', '00000000-0000-0000-0000-0000d000000d',
   'd', 'medium', 'new', 'i', '00000000-0000-0000-0000-0000b0000001',
   now(), '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

-- G10: bucket date labels are Jerusalem-local, not UTC. Both fixtures sit
-- at 01:30/02:15 Jerusalem local time -- inside the UTC-disagreement
-- window described on pg_temp.jerusalem_local() above, and away from the
-- midnight instant itself. discovered_at lands 3 days back, closed_at
-- lands 2 days back -- distinct calendar dates, so the opened-series and
-- closed-series bucket labels are each verified independently.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0000e0000020', 'G10-001', '00000000-0000-0000-0000-0000c0000012', '00000000-0000-0000-0000-0000d000000f',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0000b0000001',
   pg_temp.jerusalem_local(-3, 1, 30), '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a',
   pg_temp.jerusalem_local(-2, 2, 15), '00000000-0000-0000-0000-0000b0000001', 'rc', 'res', 'full');

-- G11: mirrors G5's exclusion sibling check (#14), for LOCATIONS instead of
-- systems -- a location whose only incident was opened long before any
-- tested period (but is still currently open) must be excluded from
-- topLocations entirely, even though it has a currently-open incident.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000021', 'G11-001', '00000000-0000-0000-0000-0000c0000013', '00000000-0000-0000-0000-0000d0000010',
   'd', 'medium', 'waiting_information', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '200 days', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

-- Top-locations ordering (#13-loc): five locations, all at the SAME
-- dedicated system (Rank System (for locations)) so the ordering assertion
-- can filter to exactly this fixture set via p_system_id, immune to any
-- other group's counts. Mirrors the top-systems ordering group below
-- exactly, inverted (system fixed, location varies).
-- Rank-A-Location: opened=3, open=3 -- unambiguous #1 by opened count alone.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000022', 'RAL-001', '00000000-0000-0000-0000-0000c0000014', '00000000-0000-0000-0000-0000d0000011',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000023', 'RAL-002', '00000000-0000-0000-0000-0000c0000014', '00000000-0000-0000-0000-0000d0000011',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000024', 'RAL-003', '00000000-0000-0000-0000-0000c0000014', '00000000-0000-0000-0000-0000d0000011',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');
-- Rank-C-Location: opened=2, open=2 -- #2 (beats Rank-D's opened=2/open=1
-- on the currently-open tiebreak).
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000025', 'RCL-001', '00000000-0000-0000-0000-0000c0000014', '00000000-0000-0000-0000-0000d0000012',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000026', 'RCL-002', '00000000-0000-0000-0000-0000c0000014', '00000000-0000-0000-0000-0000d0000012',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');
-- Zulu-Rank-D-Location (named to also help prove name isn't used
-- prematurely): opened=2, open=1 -- #3.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000027', 'RDL-001', '00000000-0000-0000-0000-0000c0000014', '00000000-0000-0000-0000-0000d0000013',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  cancelled_at, cancelled_by, cancellation_reason)
values
  ('00000000-0000-0000-0000-0000e0000028', 'RDL-002', '00000000-0000-0000-0000-0000c0000014', '00000000-0000-0000-0000-0000d0000013',
   'd', 'medium', 'cancelled', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0000b0000001', 'נפתחה בטעות');
-- Alpha-Rank-Location and Bravo-Rank-Location: both opened=1, open=1 --
-- exact tie on every numeric ranking signal, resolved only by location name
-- ascending -- #4/#5, Alpha before Bravo.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000029', 'RALPHAL-001', '00000000-0000-0000-0000-0000c0000014', '00000000-0000-0000-0000-0000d0000014',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e000002a', 'RBRAVOL-001', '00000000-0000-0000-0000-0000c0000014', '00000000-0000-0000-0000-0000d0000015',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

-- G12: a topLocations row's own avgCloseMinutes reflects the persisted
-- effective closure time, and only closures within the selected period --
-- mirrors G7 (#8), asserted at the ranking-row level rather than the
-- top-level scalar this time.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close)
values
  ('00000000-0000-0000-0000-0000e000002b', 'G12-001', '00000000-0000-0000-0000-0000c0000015', '00000000-0000-0000-0000-0000d0000016',
   'd', 'medium', 'closed', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '6 days', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a',
   now() - interval '2 days', '00000000-0000-0000-0000-0000b0000001', 'rc', 'res', 'full');

-- Top-systems ordering (#13): five systems, all at the SAME dedicated
-- location (locRankTest) so the ordering assertion can filter to exactly
-- this fixture set via p_location_id, immune to any other group's counts.
-- Rank-A: opened=3, open=3 -- unambiguous #1 by opened count alone.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000011', 'RA-001', '00000000-0000-0000-0000-0000c000000d', '00000000-0000-0000-0000-0000d000000e',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000012', 'RA-002', '00000000-0000-0000-0000-0000c000000d', '00000000-0000-0000-0000-0000d000000e',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000013', 'RA-003', '00000000-0000-0000-0000-0000c000000d', '00000000-0000-0000-0000-0000d000000e',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');
-- Rank-C: opened=2, open=2 -- #2 (beats Rank-D's opened=2/open=1 on the
-- currently-open tiebreak).
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000014', 'RC-001', '00000000-0000-0000-0000-0000c000000e', '00000000-0000-0000-0000-0000d000000e',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000015', 'RC-002', '00000000-0000-0000-0000-0000c000000e', '00000000-0000-0000-0000-0000d000000e',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');
-- Rank-D (named "Zulu..." to also help prove name isn't used prematurely):
-- opened=2, open=1 -- #3.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000016', 'RD-001', '00000000-0000-0000-0000-0000c000000f', '00000000-0000-0000-0000-0000d000000e',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason,
  cancelled_at, cancelled_by, cancellation_reason)
values
  ('00000000-0000-0000-0000-0000e0000017', 'RD-002', '00000000-0000-0000-0000-0000c000000f', '00000000-0000-0000-0000-0000d000000e',
   'd', 'medium', 'cancelled', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a',
   now(), '00000000-0000-0000-0000-0000b0000001', 'נפתחה בטעות');
-- Alpha-Rank-System and Bravo-Rank-System: both opened=1, open=1 -- exact
-- tie on every numeric ranking signal, resolved only by system name
-- ascending -- #4/#5, Alpha before Bravo.
insert into incidents (id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by, no_deadline_reason)
values
  ('00000000-0000-0000-0000-0000e0000018', 'RALPHA-001', '00000000-0000-0000-0000-0000c0000010', '00000000-0000-0000-0000-0000d000000e',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a'),
  ('00000000-0000-0000-0000-0000e0000019', 'RBRAVO-001', '00000000-0000-0000-0000-0000c0000011', '00000000-0000-0000-0000-0000d000000e',
   'd', 'medium', 'in_progress', 'i', '00000000-0000-0000-0000-0000b0000001',
   now() - interval '1 day', '00000000-0000-0000-0000-0000b0000001', '00000000-0000-0000-0000-0000b0000001', 'n/a');

-- =====================================================================
-- Functional checks, AS the authenticated role.
-- =====================================================================
do $$
declare
  v jsonb;
  v_bad int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000b0000001');
  set local role authenticated;

  -- #1: discovered_at, not created_at, drives opened-in-period.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000001', null, null);
  insert into results (test, result, detail) values
    ('openedInPeriod uses discovered_at, not created_at',
      case when (v->>'openedInPeriod')::int = 1 then 'PASS' else 'FAIL' end,
      v->>'openedInPeriod');

  -- #2: closed_in_period/avg counts the effective (final) closed_at once,
  -- and #5-sibling: a reopened-then-reclosed incident still counts once
  -- toward reopenedInPeriod via its single reopened event.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000002', null, null);
  insert into results (test, result, detail) values
    ('closedInPeriod counts the effective/final closed_at once',
      case when (v->>'closedInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'closedInPeriod');
  insert into results (test, result, detail) values
    ('avgCloseMinutes uses discovered_at -> final closed_at (9 days = 12960 min)',
      case when (v->>'avgCloseMinutes')::numeric = 12960 then 'PASS' else 'FAIL' end, v->>'avgCloseMinutes');
  insert into results (test, result, detail) values
    ('an incident reopened then reclosed still counts once toward reopenedInPeriod',
      case when (v->>'reopenedInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'reopenedInPeriod');

  -- #4 + #5: currently reopened incident is not closed; two reopen events
  -- in-period on the SAME incident count once.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000003', null, null);
  insert into results (test, result, detail) values
    ('a currently reopened incident is not counted as closed',
      case when (v->>'closedInPeriod')::int = 0 then 'PASS' else 'FAIL' end, v->>'closedInPeriod');
  insert into results (test, result, detail) values
    ('a currently reopened incident counts toward currentlyOpen',
      case when (v->>'currentlyOpen')::int = 1 then 'PASS' else 'FAIL' end, v->>'currentlyOpen');
  insert into results (test, result, detail) values
    ('an incident reopened twice in-period is counted once, not twice',
      case when (v->>'reopenedInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'reopenedInPeriod');

  -- #3: cancelled incidents count as opened, never as closed, never as open.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000004', null, null);
  insert into results (test, result, detail) values
    ('a cancelled incident still counts toward openedInPeriod',
      case when (v->>'openedInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');
  insert into results (test, result, detail) values
    ('a cancelled incident is excluded from closedInPeriod',
      case when (v->>'closedInPeriod')::int = 0 then 'PASS' else 'FAIL' end, v->>'closedInPeriod');
  insert into results (test, result, detail) values
    ('a cancelled incident is excluded from currentlyOpen',
      case when (v->>'currentlyOpen')::int = 0 then 'PASS' else 'FAIL' end, v->>'currentlyOpen');

  -- #6: currentlyOpen / avgOpenMinutes are identical regardless of period.
  declare
    v7 jsonb := get_incident_analytics(7, '00000000-0000-0000-0000-0000c0000005', null, null);
    v90 jsonb := get_incident_analytics(90, '00000000-0000-0000-0000-0000c0000005', null, null);
  begin
    insert into results (test, result, detail) values
      ('currentlyOpen is identical for a 7-day and 90-day period (period-independent)',
        case when (v7->>'currentlyOpen')::int = 1 and (v7->>'currentlyOpen')::int = (v90->>'currentlyOpen')::int
          then 'PASS' else 'FAIL' end,
        'p7=' || (v7->>'currentlyOpen') || ' p90=' || (v90->>'currentlyOpen'));
  end;

  -- #14: a system whose only incidents were opened long before the period
  -- (but are still currently open) is excluded from topSystems entirely.
  v := get_incident_analytics(90, '00000000-0000-0000-0000-0000c0000005', null, null);
  insert into results (test, result, detail) values
    ('a system with zero incidents opened in the period is excluded from topSystems, even if currently open',
      case when v->'topSystems' = '[]'::jsonb then 'PASS' else 'FAIL' end, v->>'topSystems');

  -- #7: system/location/severity filters, individually and combined.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000006', null, null);
  insert into results (test, result, detail) values
    ('system filter alone includes both fixtures',
      case when (v->>'openedInPeriod')::int = 2 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000006', '00000000-0000-0000-0000-0000d0000006', null);
  insert into results (test, result, detail) values
    ('system + location filter narrows to the matching fixture only',
      case when (v->>'openedInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000006', null, 'low');
  insert into results (test, result, detail) values
    ('severity filter narrows to the matching fixture only',
      case when (v->>'openedInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000006', '00000000-0000-0000-0000-0000d0000007', 'critical');
  insert into results (test, result, detail) values
    ('system + location + severity filters combine as AND, matching nothing here',
      case when (v->>'openedInPeriod')::int = 0 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');
  -- Positive counterpart: a fixture matching ALL THREE filters simultaneously
  -- (inc_6a is system=sysFilter, location=locFilterA, severity=critical) must
  -- be included, not just correctly excluded when mismatched.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000006', '00000000-0000-0000-0000-0000d0000006', 'critical');
  insert into results (test, result, detail) values
    ('system + location + severity filters combine as AND, including a fixture matching all three',
      case when (v->>'openedInPeriod')::int = 1 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');

  -- #8: avg close duration, exact, and null when nothing closed.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000007', null, null);
  insert into results (test, result, detail) values
    ('avgCloseMinutes averages correctly over two closed incidents (4320 min)',
      case when (v->>'avgCloseMinutes')::numeric = 4320 then 'PASS' else 'FAIL' end, v->>'avgCloseMinutes');
  insert into results (test, result, detail) values
    ('closedInPeriod counts both closures',
      case when (v->>'closedInPeriod')::int = 2 then 'PASS' else 'FAIL' end, v->>'closedInPeriod');
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000008', null, null);
  insert into results (test, result, detail) values
    ('avgCloseMinutes is null (not 0) when nothing closed in the period',
      case when v->'avgCloseMinutes' = 'null'::jsonb then 'PASS' else 'FAIL' end, v->>'avgCloseMinutes');

  -- #9: avg open duration, exact, clamped to non-negative for clock skew,
  -- and null when the open set is empty.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000009', null, null);
  insert into results (test, result, detail) values
    ('avgOpenMinutes clamps a future (clock-skew) discovered_at to 0, never negative',
      case when (v->>'avgOpenMinutes')::numeric = 0 then 'PASS' else 'FAIL' end, v->>'avgOpenMinutes');
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c000000a', null, null);
  insert into results (test, result, detail) values
    ('avgOpenMinutes is null (not 0) when the currently-open set is empty',
      case when v->'avgOpenMinutes' = 'null'::jsonb and (v->>'currentlyOpen')::int = 0 then 'PASS' else 'FAIL' end,
      v->>'avgOpenMinutes');

  -- #10 / #11: zero-filled daily and weekly buckets over a system with no
  -- incidents at all.
  v := get_incident_analytics(7, '00000000-0000-0000-0000-0000c000000b', null, null);
  insert into results (test, result, detail) values
    ('7-day period yields exactly 7 daily buckets, all zero',
      case when jsonb_array_length(v->'buckets') = 7
        and not exists (select 1 from jsonb_array_elements(v->'buckets') b
                         where (b->>'opened')::int <> 0 or (b->>'closed')::int <> 0)
        then 'PASS' else 'FAIL' end, v->>'buckets');
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c000000b', null, null);
  insert into results (test, result, detail) values
    ('30-day period yields exactly 30 daily buckets, all zero',
      case when jsonb_array_length(v->'buckets') = 30
        and not exists (select 1 from jsonb_array_elements(v->'buckets') b
                         where (b->>'opened')::int <> 0 or (b->>'closed')::int <> 0)
        then 'PASS' else 'FAIL' end, v->>'buckets');
  declare
    v90b jsonb := get_incident_analytics(90, '00000000-0000-0000-0000-0000c000000b', null, null);
    v_expected_weeks int := (
      extract(epoch from (
        date_trunc('week', (now() at time zone 'Asia/Jerusalem'))
        - date_trunc('week', (pg_temp.period_start_90() at time zone 'Asia/Jerusalem'))
      )) / (7 * 86400)
    )::int + 1;
  begin
    insert into results (test, result, detail) values
      ('90-day period yields the expected number of weekly buckets, all zero',
        case when jsonb_array_length(v90b->'buckets') = v_expected_weeks
          and not exists (select 1 from jsonb_array_elements(v90b->'buckets') b
                           where (b->>'opened')::int <> 0 or (b->>'closed')::int <> 0)
          then 'PASS' else 'FAIL' end,
        'expected=' || v_expected_weeks || ' actual=' || jsonb_array_length(v90b->'buckets'));
  end;

  -- #12: the first/last (possibly partial) weekly bucket boundary is
  -- governed by an explicit period filter. Calendar-independent check: an
  -- event just before period_start must be excluded from openedInPeriod
  -- AND from every bucket's opened sum -- if the RPC relied only on
  -- date_trunc(week)+scaffold join, that pre-period event could leak into
  -- the first bucket whenever period_start does not fall on a Monday.
  v := get_incident_analytics(90, '00000000-0000-0000-0000-0000c000000c', null, null);
  insert into results (test, result, detail) values
    ('an event one day before period_start is excluded from openedInPeriod',
      case when (v->>'openedInPeriod')::int = 2 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');
  insert into results (test, result, detail) values
    ('an event exactly at period_start (inclusive lower bound) and one exactly at now() (inclusive upper bound) are both counted',
      case when (v->>'openedInPeriod')::int = 2 then 'PASS' else 'FAIL' end, v->>'openedInPeriod');
  insert into results (test, result, detail) values
    ('sum of bucketed opened counts equals openedInPeriod (no pre-period leakage into the first partial bucket)',
      case when (select coalesce(sum((b->>'opened')::int), 0) from jsonb_array_elements(v->'buckets') b)
             = (v->>'openedInPeriod')::int
        then 'PASS' else 'FAIL' end,
      'bucketSum=' || (select coalesce(sum((b->>'opened')::int), 0) from jsonb_array_elements(v->'buckets') b)
        || ' openedInPeriod=' || (v->>'openedInPeriod'));

  -- Bucket date labels are Jerusalem-local, not UTC. Both fixtures are
  -- placed by pg_temp.jerusalem_local() in the 00:00-02:59 Jerusalem
  -- window where the UTC instant is still on the previous UTC date -- a
  -- bug that bucketed by UTC date instead of converting to Jerusalem first
  -- would shift these into the wrong bucket by exactly one day. The
  -- expected dates below are derived independently via plain date
  -- arithmetic on today's Jerusalem date, not by reusing the RPC's own
  -- date_trunc/bucketing expression.
  v := get_incident_analytics(7, '00000000-0000-0000-0000-0000c0000012', null, null);
  insert into results (test, result, detail) values
    ('opened bucket lands on the correct Jerusalem-local calendar date, not the UTC-shifted one',
      case when v->'buckets' @> jsonb_build_array(jsonb_build_object(
             'bucketStart', to_char(((now() at time zone 'Asia/Jerusalem')::date - 3), 'YYYY-MM-DD'),
             'opened', 1
           ))
        then 'PASS' else 'FAIL' end,
      'expected=' || to_char(((now() at time zone 'Asia/Jerusalem')::date - 3), 'YYYY-MM-DD') || ' buckets=' || (v->>'buckets'));
  insert into results (test, result, detail) values
    ('closed bucket lands on the correct Jerusalem-local calendar date, not the UTC-shifted one',
      case when v->'buckets' @> jsonb_build_array(jsonb_build_object(
             'bucketStart', to_char(((now() at time zone 'Asia/Jerusalem')::date - 2), 'YYYY-MM-DD'),
             'closed', 1
           ))
        then 'PASS' else 'FAIL' end,
      'expected=' || to_char(((now() at time zone 'Asia/Jerusalem')::date - 2), 'YYYY-MM-DD') || ' buckets=' || (v->>'buckets'));
  insert into results (test, result, detail) values
    ('no bucket other than the expected Jerusalem-local date shows nonzero opened (rules out a shifted, not just missing, label)',
      case when not exists (
        select 1 from jsonb_array_elements(v->'buckets') b
        where b->>'bucketStart' <> to_char(((now() at time zone 'Asia/Jerusalem')::date - 3), 'YYYY-MM-DD')
          and (b->>'opened')::int > 0
      ) then 'PASS' else 'FAIL' end,
      v->>'buckets');

  -- #13: top-systems ordering -- opened desc, currentlyOpen desc tiebreak,
  -- system name asc final tiebreak. Scoped to the shared ranking location
  -- so no other fixture group can interfere.
  v := get_incident_analytics(30, null, '00000000-0000-0000-0000-0000d000000e', null);
  insert into results (test, result, detail) values
    ('top systems ranked opened desc / currentlyOpen desc / name asc, exact expected order',
      case when v->'topSystems' = (
        '[' ||
        '{"systemId":"00000000-0000-0000-0000-0000c000000d","systemName":"Rank-A-System","openedInPeriod":3,"currentlyOpen":3,"avgCloseMinutes":null},' ||
        '{"systemId":"00000000-0000-0000-0000-0000c000000e","systemName":"Rank-C-System","openedInPeriod":2,"currentlyOpen":2,"avgCloseMinutes":null},' ||
        '{"systemId":"00000000-0000-0000-0000-0000c000000f","systemName":"Zulu-Rank-D-System","openedInPeriod":2,"currentlyOpen":1,"avgCloseMinutes":null},' ||
        '{"systemId":"00000000-0000-0000-0000-0000c0000010","systemName":"Alpha-Rank-System","openedInPeriod":1,"currentlyOpen":1,"avgCloseMinutes":null},' ||
        '{"systemId":"00000000-0000-0000-0000-0000c0000011","systemName":"Bravo-Rank-System","openedInPeriod":1,"currentlyOpen":1,"avgCloseMinutes":null}' ||
        ']'
      )::jsonb then 'PASS' else 'FAIL' end,
      v->>'topSystems');

  -- topLocations exclusion (mirrors #14, for locations): a location whose
  -- only incident was opened long before the period (but is still
  -- currently open) is excluded from topLocations entirely.
  v := get_incident_analytics(90, null, '00000000-0000-0000-0000-0000d0000010', null);
  insert into results (test, result, detail) values
    ('a location with zero incidents opened in the period is excluded from topLocations, even if currently open',
      case when v->'topLocations' = '[]'::jsonb then 'PASS' else 'FAIL' end, v->>'topLocations');

  -- topLocations ordering (mirrors #13, for locations): opened desc,
  -- currentlyOpen desc tiebreak, location name asc final tiebreak. Scoped
  -- to the shared ranking system so no other fixture group can interfere.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000014', null, null);
  insert into results (test, result, detail) values
    ('top locations ranked opened desc / currentlyOpen desc / name asc, exact expected order',
      case when v->'topLocations' = (
        '[' ||
        '{"locationId":"00000000-0000-0000-0000-0000d0000011","locationName":"Rank-A-Location","openedInPeriod":3,"currentlyOpen":3,"avgCloseMinutes":null},' ||
        '{"locationId":"00000000-0000-0000-0000-0000d0000012","locationName":"Rank-C-Location","openedInPeriod":2,"currentlyOpen":2,"avgCloseMinutes":null},' ||
        '{"locationId":"00000000-0000-0000-0000-0000d0000013","locationName":"Zulu-Rank-D-Location","openedInPeriod":2,"currentlyOpen":1,"avgCloseMinutes":null},' ||
        '{"locationId":"00000000-0000-0000-0000-0000d0000014","locationName":"Alpha-Rank-Location","openedInPeriod":1,"currentlyOpen":1,"avgCloseMinutes":null},' ||
        '{"locationId":"00000000-0000-0000-0000-0000d0000015","locationName":"Bravo-Rank-Location","openedInPeriod":1,"currentlyOpen":1,"avgCloseMinutes":null}' ||
        ']'
      )::jsonb then 'PASS' else 'FAIL' end,
      v->>'topLocations');

  -- topLocations avgCloseMinutes (mirrors #8, at the ranking-row level): the
  -- persisted effective closure time, only within the selected period.
  v := get_incident_analytics(30, '00000000-0000-0000-0000-0000c0000015', null, null);
  insert into results (test, result, detail) values
    ('a topLocations row reports avgCloseMinutes from the persisted discovered_at -> closed_at (4 days = 5760 min), scoped to the selected period',
      case when v->'topLocations' = (
        '[{"locationId":"00000000-0000-0000-0000-0000d0000016","locationName":"G12 Avg Close Location","openedInPeriod":1,"currentlyOpen":0,"avgCloseMinutes":5760}]'
      )::jsonb then 'PASS' else 'FAIL' end,
      v->>'topLocations');

  -- #17: invalid p_period_days is rejected with the controlled validation error.
  for v_bad in select unnest(array[14, 0, -5]) loop
    begin
      perform get_incident_analytics(v_bad, null, null, null);
      insert into results (test, result, detail) values
        ('invalid p_period_days (' || v_bad || ') is rejected', 'FAIL', 'succeeded');
    exception when others then
      insert into results (test, result, detail) values
        ('invalid p_period_days (' || v_bad || ') is rejected',
          case when sqlerrm = 'validation: תקופה לא תקינה' then 'PASS' else 'FAIL' end, sqlerrm);
    end;
  end loop;

  -- #16: any active authenticated role, including viewer, can execute the RPC.
  begin
    perform get_incident_analytics(30, null, null, null);
    insert into results (test, result, detail) values
      ('active shift_supervisor caller can execute the RPC', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('active shift_supervisor caller can execute the RPC', 'FAIL', sqlerrm);
  end;

  reset role;
end $$;

-- =====================================================================
-- Access control, AS the affected roles.
-- =====================================================================
do $$
begin
  -- #15: an inactive member (authenticated, has EXECUTE, but fails our own
  -- is_active_member() guard) is rejected with the controlled permission error.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000b0000002');
  set local role authenticated;
  begin
    perform get_incident_analytics(30, null, null, null);
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
  -- #15 (other half): an unauthenticated/anon caller has no EXECUTE grant
  -- at all and is rejected at the ACL boundary, before the function body
  -- even runs.
  set local role anon;
  begin
    perform get_incident_analytics(30, null, null, null);
    insert into results (test, result, detail) values
      ('an anon (unauthenticated) caller is rejected at the EXECUTE grant boundary', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('an anon (unauthenticated) caller is rejected at the EXECUTE grant boundary',
        case when sqlstate = '42501' then 'PASS' else 'FAIL' end, sqlstate || ': ' || sqlerrm);
  end;
  reset role;
end $$;

do $$
begin
  -- #16: an active viewer (the lowest-privilege role, no capability gate
  -- on this page) can still execute the RPC.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000b0000003');
  set local role authenticated;
  begin
    perform get_incident_analytics(30, null, null, null);
    insert into results (test, result, detail) values
      ('active viewer caller can execute the RPC', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('active viewer caller can execute the RPC', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- ACL-level checks -- same aclexplode(proacl) pattern as
-- incident_cancellation_grant.sql: prove the grant STATE, not just its
-- functional effect.
-- =====================================================================
insert into results (test, result, detail)
select 'authenticated has EXECUTE on get_incident_analytics',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_incident_analytics'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'get_incident_analytics has no PUBLIC or anon EXECUTE',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_incident_analytics'
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
