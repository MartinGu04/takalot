-- Tests for migration 0020: update_incident / technician_update_incident
-- event-time integrity (מועד העדכון בפועל).
--
-- Covers: eventTime now mandatory on both RPCs; missing/JSON-null/empty/
-- whitespace-only rejected with a controlled validation error; malformed
-- non-empty values (invalid_datetime_format, datetime_field_overflow, AND
-- invalid_time_zone_displacement_value shapes -- the third was added after
-- a final review found an out-of-range UTC offset, e.g. "...+25:00", was
-- not yet caught) rejected as a controlled validation error, never a raw
-- Postgres cast error; lower bound (incident's own discovered_at) and upper bound
-- (now() + 5 minutes) enforced with INCLUSIVE boundaries on both RPCs;
-- everything untouched by this migration (permission checks, transition
-- validity, technician ownership restriction, expectedVersion/optimistic
-- concurrency, EXECUTE grants, server_time being independently
-- database-generated) still behaves exactly as before.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'owner-tech@test', now()),
  ('00000000-0000-0000-0000-0000000000e3', 'viewer@test', now()),
  ('00000000-0000-0000-0000-0000000000e4', 'other-tech@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000e2', 'Owner Technician', 'technician', true),
  ('00000000-0000-0000-0000-0000000000e3', 'Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-0000000000e4', 'Other Technician', 'technician', true);

insert into systems (id, name) values ('00000000-0000-0000-0000-00000000f701', 'Sys');
insert into locations (id, name) values ('00000000-0000-0000-0000-00000000f702', 'Loc');

-- Reject-only fixtures (version never advances -- expectedVersion=1 is
-- reusable across every rejected attempt against them).
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values
  ('00000000-0000-0000-0000-00000000f710', 'T-710', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', 1),
  ('00000000-0000-0000-0000-00000000f722', 'T-722', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', 1),
  ('00000000-0000-0000-0000-00000000f721', 'T-721', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', 1);

-- Success fixtures (each mutated by exactly one successful call, so each
-- gets its own row to keep expectedVersion arithmetic trivial).
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values
  ('00000000-0000-0000-0000-00000000f711', 'T-711', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', 1),
  ('00000000-0000-0000-0000-00000000f712', 'T-712', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', 1),
  ('00000000-0000-0000-0000-00000000f713', 'T-713', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', 1),
  ('00000000-0000-0000-0000-00000000f714', 'T-714', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', 1),
  ('00000000-0000-0000-0000-00000000f720', 'T-720', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', 1),
  ('00000000-0000-0000-0000-00000000f723', 'T-723', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
-- Needed because this suite switches actors mid-block, i.e. calls as_user
-- again AFTER `set local role authenticated` has already taken effect.
grant execute on function pg_temp.as_user(uuid) to authenticated;

-- Base valid update_incident input (full/protected fields). `extra`
-- overrides/adds keys, including eventTime, per-check.
create or replace function pg_temp.base_update_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'actionsTaken', 'בוצעה בדיקה', 'findings', '', 'nextSteps', '',
    'status', 'in_progress', 'severity', 'medium', 'operationalImpact', 'i', 'changeReason', '',
    'ownerUserId', '00000000-0000-0000-0000-0000000000e2', 'ownerExternalName', null,
    'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_update_input(jsonb) to authenticated;

-- Base valid technician_update_incident input (content-only fields).
create or replace function pg_temp.base_tech_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'actionsTaken', 'בוצעה בדיקה טכנית', 'findings', '', 'nextSteps', ''
  ) || extra;
$$;
grant execute on function pg_temp.base_tech_input(jsonb) to authenticated;

do $$
declare
  v_incident incidents;
  v_row record;
begin
  -- =====================================================================
  -- PART A: update_incident
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
  set local role authenticated;

  -- 1/9. A valid, recent (but not "now", to make server_time distinguishable
  -- below), in-bounds eventTime succeeds, and the allowed transition
  -- in_progress -> monitoring still applies correctly.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f711', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '1 hour', 'status', 'monitoring')));
    insert into results (test, result, detail) values
      ('update_incident: valid in-bounds eventTime succeeds and applies the status transition',
        case when v_incident.status = 'monitoring' and v_incident.version = 2 then 'PASS' else 'FAIL' end,
        'status=' || v_incident.status || ' version=' || v_incident.version);
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: valid in-bounds eventTime succeeds and applies the status transition', 'FAIL', sqlerrm);
  end;

  -- 16. server_time is independently database-recorded and distinct from
  -- the user-supplied event_time (set 1 hour in the past above).
  select event_time, server_time into v_row from incident_updates
    where incident_id = '00000000-0000-0000-0000-00000000f711' order by created_at desc limit 1;
  insert into results (test, result, detail) values
    ('update_incident: server_time is database-generated and distinct from event_time',
      case when v_row.server_time is not null and v_row.server_time <> v_row.event_time then 'PASS' else 'FAIL' end,
      'event_time=' || v_row.event_time || ' server_time=' || v_row.server_time);

  -- 2. Missing eventTime key entirely.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710',
      (pg_temp.base_update_input('{}'::jsonb) - 'eventTime'));
    insert into results (test, result, detail) values ('update_incident: missing eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: missing eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד עדכון בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 3. JSON-null eventTime.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', null)));
    insert into results (test, result, detail) values ('update_incident: JSON-null eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: JSON-null eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד עדכון בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 4. Empty-string eventTime.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', '')));
    insert into results (test, result, detail) values ('update_incident: empty-string eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: empty-string eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד עדכון בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 5. Whitespace-only eventTime.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', '   ')));
    insert into results (test, result, detail) values ('update_incident: whitespace-only eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: whitespace-only eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד עדכון בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 5b. Malformed, unparseable text (invalid_datetime_format / 22007 shape).
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', 'not-a-timestamp')));
    insert into results (test, result, detail) values
      ('update_incident: malformed eventTime ("not-a-timestamp") rejected as controlled validation', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: malformed eventTime ("not-a-timestamp") rejected as controlled validation',
        case when sqlstate = 'P0001' and sqlerrm = 'validation: מועד העדכון בפועל אינו תקין' then 'PASS' else 'FAIL' end,
        'sqlstate=' || sqlstate || ' sqlerrm=' || sqlerrm);
  end;

  -- 5c. Malformed, out-of-range shape (datetime_field_overflow / 22008 shape).
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', '2026-13-45 25:99:99')));
    insert into results (test, result, detail) values
      ('update_incident: out-of-range eventTime ("2026-13-45 25:99:99") rejected as controlled validation', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: out-of-range eventTime ("2026-13-45 25:99:99") rejected as controlled validation',
        case when sqlstate = 'P0001' and sqlerrm = 'validation: מועד העדכון בפועל אינו תקין' then 'PASS' else 'FAIL' end,
        'sqlstate=' || sqlstate || ' sqlerrm=' || sqlerrm);
  end;

  -- 5d. Malformed, out-of-range UTC offset (invalid_time_zone_displacement_value / 22009 shape).
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', '2026-07-28T16:00:00+25:00')));
    insert into results (test, result, detail) values
      ('update_incident: out-of-range UTC offset eventTime ("...+25:00") rejected as controlled validation', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: out-of-range UTC offset eventTime ("...+25:00") rejected as controlled validation',
        case when sqlstate = 'P0001' and sqlerrm = 'validation: מועד העדכון בפועל אינו תקין' then 'PASS' else 'FAIL' end,
        'sqlstate=' || sqlstate || ' sqlerrm=' || sqlerrm);
  end;

  -- 6. Before the incident's own discovered_at (discovered 2 days ago).
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '3 days')));
    insert into results (test, result, detail) values ('update_incident: eventTime before discovered_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: eventTime before discovered_at rejected',
      case when sqlerrm = 'validation: מועד העדכון בפועל אינו תקין' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 7. Beyond now() + 5 minutes.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() + interval '10 minutes')));
    insert into results (test, result, detail) values ('update_incident: eventTime beyond now()+5min rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: eventTime beyond now()+5min rejected',
      case when sqlerrm = 'validation: מועד העדכון בפועל אינו תקין' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 8. Exact discovered_at boundary is accepted (inclusive lower bound).
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f712', pg_temp.base_update_input(
      jsonb_build_object('eventTime', (select discovered_at from incidents where id = '00000000-0000-0000-0000-00000000f712'))));
    insert into results (test, result, detail) values
      ('update_incident: eventTime exactly equal to discovered_at is accepted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: eventTime exactly equal to discovered_at is accepted', 'FAIL', sqlerrm);
  end;

  -- Exact now() + 5 minutes boundary is accepted (inclusive upper bound).
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f713', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() + interval '5 minutes')));
    insert into results (test, result, detail) values
      ('update_incident: eventTime exactly equal to now()+5min is accepted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: eventTime exactly equal to now()+5min is accepted', 'FAIL', sqlerrm);
  end;

  -- 10. expectedVersion / optimistic concurrency unchanged: a stale version
  -- is rejected exactly as before, independent of eventTime validity.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f714', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '1 hour')));
  exception when others then
    insert into results (test, result, detail) values ('update_incident: setup for stale-version check failed', 'FAIL', sqlerrm);
  end;
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f714', pg_temp.base_update_input(
      jsonb_build_object('expectedVersion', 1, 'eventTime', now() - interval '1 hour')));
    insert into results (test, result, detail) values ('update_incident: stale expectedVersion still rejected (version_conflict)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: stale expectedVersion still rejected (version_conflict)',
      case when sqlerrm like 'version_conflict%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 11. An invalid transition is still rejected on its own terms (before
  -- eventTime is even reached), independent of this migration.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '1 hour', 'status', 'closed')));
    insert into results (test, result, detail) values ('update_incident: invalid transition (to closed) still rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: invalid transition (to closed) still rejected',
      case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 12. Unauthorized role (viewer) still rejected, independent of eventTime.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e3');
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now())));
    insert into results (test, result, detail) values ('update_incident: viewer role still rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: viewer role still rejected',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 13. Technician (no full_update capability) still rejected from update_incident.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now())));
    insert into results (test, result, detail) values ('update_incident: technician role still rejected (no full_update)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident: technician role still rejected (no full_update)',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- PART B: technician_update_incident
  -- =====================================================================

  -- Success: owning technician, in-bounds eventTime.
  begin
    v_incident := technician_update_incident('00000000-0000-0000-0000-00000000f720', pg_temp.base_tech_input(
      jsonb_build_object('eventTime', now() - interval '1 hour')));
    insert into results (test, result, detail) values
      ('technician_update_incident: owning technician with valid in-bounds eventTime succeeds',
        case when v_incident.version = 2 then 'PASS' else 'FAIL' end, 'version=' || v_incident.version);
  exception when others then
    insert into results (test, result, detail) values
      ('technician_update_incident: owning technician with valid in-bounds eventTime succeeds', 'FAIL', sqlerrm);
  end;

  -- Ownership restriction unchanged: a different technician, not the owner,
  -- is rejected regardless of eventTime validity.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e4');
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000f721', pg_temp.base_tech_input(
      jsonb_build_object('eventTime', now())));
    insert into results (test, result, detail) values
      ('technician_update_incident: non-owning technician still rejected (ownership restriction unchanged)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician_update_incident: non-owning technician still rejected (ownership restriction unchanged)',
        case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');

  -- Missing eventTime.
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000f722',
      (pg_temp.base_tech_input('{}'::jsonb) - 'eventTime'));
    insert into results (test, result, detail) values ('technician_update_incident: missing eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('technician_update_incident: missing eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד עדכון בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- JSON-null / empty / whitespace-only eventTime.
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000f722', pg_temp.base_tech_input(
      jsonb_build_object('eventTime', null)));
    insert into results (test, result, detail) values ('technician_update_incident: JSON-null eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('technician_update_incident: JSON-null eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד עדכון בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000f722', pg_temp.base_tech_input(
      jsonb_build_object('eventTime', '   ')));
    insert into results (test, result, detail) values ('technician_update_incident: whitespace-only eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('technician_update_incident: whitespace-only eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד עדכון בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- Malformed (unparseable) eventTime -> controlled validation, not a raw cast error.
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000f722', pg_temp.base_tech_input(
      jsonb_build_object('eventTime', 'abc123')));
    insert into results (test, result, detail) values
      ('technician_update_incident: malformed eventTime rejected as controlled validation', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician_update_incident: malformed eventTime rejected as controlled validation',
        case when sqlstate = 'P0001' and sqlerrm = 'validation: מועד העדכון בפועל אינו תקין' then 'PASS' else 'FAIL' end,
        'sqlstate=' || sqlstate || ' sqlerrm=' || sqlerrm);
  end;

  -- Malformed, out-of-range UTC offset (invalid_time_zone_displacement_value / 22009 shape).
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000f722', pg_temp.base_tech_input(
      jsonb_build_object('eventTime', '2026-07-28T16:00:00+25:00')));
    insert into results (test, result, detail) values
      ('technician_update_incident: out-of-range UTC offset eventTime ("...+25:00") rejected as controlled validation', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician_update_incident: out-of-range UTC offset eventTime ("...+25:00") rejected as controlled validation',
        case when sqlstate = 'P0001' and sqlerrm = 'validation: מועד העדכון בפועל אינו תקין' then 'PASS' else 'FAIL' end,
        'sqlstate=' || sqlstate || ' sqlerrm=' || sqlerrm);
  end;

  -- Before discovered_at / beyond now()+5min.
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000f722', pg_temp.base_tech_input(
      jsonb_build_object('eventTime', now() - interval '3 days')));
    insert into results (test, result, detail) values ('technician_update_incident: eventTime before discovered_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('technician_update_incident: eventTime before discovered_at rejected',
      case when sqlerrm = 'validation: מועד העדכון בפועל אינו תקין' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000f722', pg_temp.base_tech_input(
      jsonb_build_object('eventTime', now() + interval '10 minutes')));
    insert into results (test, result, detail) values ('technician_update_incident: eventTime beyond now()+5min rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('technician_update_incident: eventTime beyond now()+5min rejected',
      case when sqlerrm = 'validation: מועד העדכון בפועל אינו תקין' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- Exact discovered_at boundary accepted (inclusive).
  begin
    v_incident := technician_update_incident('00000000-0000-0000-0000-00000000f723', pg_temp.base_tech_input(
      jsonb_build_object('eventTime', (select discovered_at from incidents where id = '00000000-0000-0000-0000-00000000f723'))));
    insert into results (test, result, detail) values
      ('technician_update_incident: eventTime exactly equal to discovered_at is accepted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('technician_update_incident: eventTime exactly equal to discovered_at is accepted', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- EXECUTE grants unchanged (neither RPC's signature changed -- CREATE OR
  -- REPLACE preserves grants -- verified via effective-ACL inspection).
  -- =====================================================================
  insert into results (test, result, detail)
  select 'update_incident: authenticated retains EXECUTE',
    case when exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
           aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname = 'public' and p.proname = 'update_incident'
        and a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
    ) then 'PASS' else 'FAIL' end, '';
  insert into results (test, result, detail)
  select 'update_incident: no PUBLIC/anon EXECUTE',
    case when not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
           aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname = 'public' and p.proname = 'update_incident'
        and (a.grantee = 0 or a.grantee = 'anon'::regrole) and a.privilege_type = 'EXECUTE'
    ) then 'PASS' else 'FAIL' end, '';
  insert into results (test, result, detail)
  select 'technician_update_incident: authenticated retains EXECUTE',
    case when exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
           aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname = 'public' and p.proname = 'technician_update_incident'
        and a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
    ) then 'PASS' else 'FAIL' end, '';
  insert into results (test, result, detail)
  select 'technician_update_incident: no PUBLIC/anon EXECUTE',
    case when not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
           aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname = 'public' and p.proname = 'technician_update_incident'
        and (a.grantee = 0 or a.grantee = 'anon'::regrole) and a.privilege_type = 'EXECUTE'
    ) then 'PASS' else 'FAIL' end, '';

  reset role;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
