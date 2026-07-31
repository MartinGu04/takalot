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
-- PART C/D/E (added for 0030): the next-update-ETA concept was removed from
-- the active product (creation, full update, reopen). update_incident and
-- reopen_incident now treat nextUpdateDue/noDeadlineReason as OPTIONAL
-- legacy-compatibility keys: when a key is present in p_input (an old
-- client still sending it during the compatibility window) its value is
-- honored exactly as before; when the key is absent (the new frontend's
-- contract) the incident's own current value carries forward unchanged --
-- never silently cleared. create_incident needs no such logic: a new
-- incident has no prior value to preserve, so omitting both keys simply
-- stores NULL/NULL, which is legal now that incident_deadline_or_reason
-- (0001) has been dropped.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'owner-tech@test', now()),
  ('00000000-0000-0000-0000-0000000000e3', 'viewer@test', now()),
  ('00000000-0000-0000-0000-0000000000e4', 'other-tech@test', now()),
  ('00000000-0000-0000-0000-0000000000e5', 'admin@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000e2', 'Owner Technician', 'technician', true),
  ('00000000-0000-0000-0000-0000000000e3', 'Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-0000000000e4', 'Other Technician', 'technician', true),
  ('00000000-0000-0000-0000-0000000000e5', 'Admin', 'system_admin', true);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000f701', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000f702', 'Loc', 1);

-- f730: open, has an existing non-null next_update_due -- proves
-- update_incident omitting the key preserves it.
-- f731: open, next_update_due already NULL with a pre-set no_deadline_reason
-- -- proves the reason side is preserved the same way.
-- f732: open, fresh -- proves a legacy call supplying both keys explicitly
-- is still honored.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, no_deadline_reason, version)
values
  ('00000000-0000-0000-0000-00000000f730', 'T-730', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '3 hours', null, 1),
  ('00000000-0000-0000-0000-00000000f731', 'T-731', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   null, 'ממתין לאישור מוקדם יותר', 1),
  ('00000000-0000-0000-0000-00000000f732', 'T-732', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   null, null, 1),
  -- f735: open, a distinctive operational_impact (unlike base_update_input's
  -- own default of 'i', so a call that OMITS the key can be proven to
  -- preserve this exact value) -- used for the operationalImpact
  -- legacy-compatibility pair below.
  ('00000000-0000-0000-0000-00000000f735', 'T-735', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'ההשפעה המקורית בעת הפתיחה',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() + interval '1 day', null, 1);

-- f736/f737/f738: fresh open incidents for update-specific reporting
-- (migration 0031) coverage. f736's incident-level reported_to_ops/
-- reported_to_ops_recipient are explicitly set to a distinctive
-- 'yes'/recipient pair at OPENING -- proves update_incident's new
-- update-specific reporting additions never touch these opening-time
-- columns, even when a legacy reportedToOps/reportedToOpsRecipient payload
-- key is also supplied on the same call.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       reported_to_ops, reported_to_ops_recipient, version)
values
  ('00000000-0000-0000-0000-00000000f736', 'T-736', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   'yes', 'ההשפעה המקורית בעת הפתיחה -- מוקד מבצעים', 1),
  ('00000000-0000-0000-0000-00000000f737', 'T-737', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   'no', null, 1),
  ('00000000-0000-0000-0000-00000000f738', 'T-738', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   'no', null, 1);

-- f740: CLOSED, with a pre-set next_update_due/no_deadline_reason pair (as
-- close_incident would typically leave them) -- proves reopen_incident
-- omitting the keys preserves them.
-- f741: CLOSED, fresh -- proves a legacy reopen call explicitly supplying
-- nextUpdateDue is still honored.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       closed_at, closed_by, root_cause, resolution, readiness_at_close,
                       next_update_due, no_deadline_reason, version)
values
  ('00000000-0000-0000-0000-00000000f740', 'T-740', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'closed', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '3 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() - interval '1 hour', '00000000-0000-0000-0000-0000000000e1',
   'root', 'fix', 'full', null, 'התקלה נסגרה', 1),
  ('00000000-0000-0000-0000-00000000f741', 'T-741', '00000000-0000-0000-0000-00000000f701',
   '00000000-0000-0000-0000-00000000f702', 'd', 'medium', 'closed', 'i',
   '00000000-0000-0000-0000-0000000000e2', now() - interval '3 days',
   '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
   now() - interval '1 hour', '00000000-0000-0000-0000-0000000000e1',
   'root', 'fix', 'full', null, 'התקלה נסגרה', 1);

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

-- Base valid reopen_incident input. Deliberately has NO nextUpdateDue/
-- noDeadlineReason key by default -- that's exactly the new frontend's
-- contract (0030); `extra` can add either back to simulate a legacy caller.
create or replace function pg_temp.base_reopen_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'reason', 'התברר שהתקלה חוזרת',
    'ownerUserId', '00000000-0000-0000-0000-0000000000e2', 'ownerExternalName', null
  ) || extra;
$$;
grant execute on function pg_temp.base_reopen_input(jsonb) to authenticated;

do $$
declare
  v_incident incidents;
  v_row record;
  v_incident2 incidents;
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
  -- PART C: update_incident -- next-update-ETA compatibility (0030)
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');

  -- Omitting nextUpdateDue (and noDeadlineReason, never sent by
  -- base_update_input in the first place) on an incident with an existing
  -- non-null next_update_due preserves it byte-identical (the fixture set
  -- it to exactly now()+3h, and this whole suite runs in one transaction
  -- where now() is frozen, so the comparison below is exact, not
  -- approximate), and no deadline_change event fires (nothing changed).
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f730',
      (pg_temp.base_update_input(jsonb_build_object('eventTime', now() - interval '1 hour')) - 'nextUpdateDue'));
    insert into results (test, result, detail) values
      ('update_incident: omitting nextUpdateDue preserves the incident''s existing next_update_due exactly',
        case when v_incident.next_update_due = now() + interval '3 hours' then 'PASS' else 'FAIL' end,
        'stored=' || v_incident.next_update_due);
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: omitting nextUpdateDue preserves the incident''s existing next_update_due exactly', 'FAIL', sqlerrm);
  end;
  insert into results (test, result, detail)
  select 'update_incident: omitting nextUpdateDue -> no deadline_change event fires',
    case when not exists (
      select 1 from incident_events where incident_id = '00000000-0000-0000-0000-00000000f730' and type = 'deadline_change'
    ) then 'PASS' else 'FAIL' end, '';

  -- Same, but the incident's existing value is NULL/reason-only -- proves
  -- the reason side is preserved too, independently of the date side.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f731',
      ((pg_temp.base_update_input(jsonb_build_object('eventTime', now() - interval '1 hour')) - 'nextUpdateDue')
        || jsonb_build_object('nextUpdateDue', null)));
    insert into results (test, result, detail) values
      ('update_incident: omitting nextUpdateDue on a reason-only incident leaves both columns untouched',
        case when v_incident.next_update_due is null
          and v_incident.no_deadline_reason = 'ממתין לאישור מוקדם יותר' then 'PASS' else 'FAIL' end,
        'due=' || v_incident.next_update_due || ' reason=' || v_incident.no_deadline_reason);
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: omitting nextUpdateDue on a reason-only incident leaves both columns untouched', 'FAIL', sqlerrm);
  end;

  -- A legacy caller that still explicitly supplies both keys is honored
  -- exactly as supplied -- no meaningfulness check is applied to whatever
  -- string is given (that validation was evaluated and cancelled).
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f732', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '1 hour', 'nextUpdateDue', null, 'noDeadlineReason', 'ללא')));
    insert into results (test, result, detail) values
      ('update_incident: legacy caller explicitly supplying noDeadlineReason="ללא" is honored verbatim, no validation applied',
        case when v_incident.no_deadline_reason = 'ללא' then 'PASS' else 'FAIL' end, v_incident.no_deadline_reason);
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: legacy caller explicitly supplying noDeadlineReason="ללא" is honored verbatim, no validation applied', 'FAIL', sqlerrm);
  end;

  -- Omitting BOTH keys with no prior constraint no longer raises -- proves
  -- the incident_deadline_or_reason constraint (0001) is actually gone.
  -- (f732 was already updated once above, hence expectedVersion from the
  -- previous call's result rather than base_update_input's default of 1.)
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f732',
      (pg_temp.base_update_input(jsonb_build_object('eventTime', now(), 'expectedVersion', v_incident.version)) - 'nextUpdateDue'));
    insert into results (test, result, detail) values
      ('update_incident: omitting both deadline keys on an already-both-NULL incident succeeds (constraint dropped)',
        'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: omitting both deadline keys on an already-both-NULL incident succeeds (constraint dropped)',
        'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- PART C2: update_incident -- operationalImpact legacy compatibility
  -- (0029/0030): the new frontend never sends this key (operational-impact
  -- editing moved out of the update flow entirely), but a legacy client
  -- bundle still sends it on every call, so the RPC must keep honoring an
  -- explicit, genuinely different value rather than silently discarding it.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');

  -- Omitting operationalImpact (the new frontend's contract) preserves the
  -- incident's existing opening value exactly, and emits no impact_change event.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f735',
      (pg_temp.base_update_input(jsonb_build_object('eventTime', now() - interval '1 hour')) - 'operationalImpact'));
    insert into results (test, result, detail) values
      ('update_incident: omitting operationalImpact preserves the incident''s existing value exactly',
        case when v_incident.operational_impact = 'ההשפעה המקורית בעת הפתיחה' then 'PASS' else 'FAIL' end,
        'stored=' || v_incident.operational_impact);
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: omitting operationalImpact preserves the incident''s existing value exactly', 'FAIL', sqlerrm);
  end;
  insert into results (test, result, detail)
  select 'update_incident: omitting operationalImpact -> no impact_change event fires',
    case when not exists (
      select 1 from incident_events where incident_id = '00000000-0000-0000-0000-00000000f735' and type = 'impact_change'
    ) then 'PASS' else 'FAIL' end, '';

  -- A legacy caller that still explicitly supplies a genuinely different
  -- operationalImpact is honored: persisted, and an impact_change event is
  -- emitted carrying the submitted eventTime and the call's shared operation_id.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f735', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '30 minutes', 'expectedVersion', v_incident.version,
        'operationalImpact', 'השפעה חדשה שדווחה על ידי לקוח ישן')));
    insert into results (test, result, detail) values
      ('update_incident: legacy caller explicitly changing operationalImpact is persisted',
        case when v_incident.operational_impact = 'השפעה חדשה שדווחה על ידי לקוח ישן' then 'PASS' else 'FAIL' end,
        v_incident.operational_impact);
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: legacy caller explicitly changing operationalImpact is persisted', 'FAIL', sqlerrm);
  end;
  insert into results (test, result, detail)
  select 'update_incident: legacy operationalImpact change emits impact_change with the submitted eventTime and the shared operation_id',
    case when exists (
      select 1
      from incident_events u
      join incident_events ic on ic.operation_id = u.operation_id
      where u.incident_id = '00000000-0000-0000-0000-00000000f735' and u.type = 'update'
        and ic.incident_id = '00000000-0000-0000-0000-00000000f735' and ic.type = 'impact_change'
        and ic.event_time = (now() - interval '30 minutes')
        and u.event_time = (now() - interval '30 minutes')
    ) then 'PASS' else 'FAIL' end, '';

  -- =====================================================================
  -- PART C3: update_incident -- update-specific reporting (0031): three
  -- fresh per-update questions, stored on the incident_updates row itself,
  -- never on the incident's own opening-time reported_to_ops/
  -- reported_to_ops_recipient/reported_to_comms/wisdom_reported columns,
  -- and never emitting the (now-removed) reported_to_ops_change event.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');

  -- A fully-answered payload persists all three answers on the
  -- incident_updates row this call inserts.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f736', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '1 hour', 'expectedVersion', 1,
        'updateReportedToOps', 'yes', 'updateReportedToOpsRecipient', 'יוסי מהמוקד',
        'updateReportedToComms', 'yes', 'updateReportedToCommsRecipient', 'דנה מהתקשוב',
        'updateWisdomReported', 'yes')));
    select * into v_row from incident_updates where incident_id = '00000000-0000-0000-0000-00000000f736'
      order by created_at desc limit 1;
    insert into results (test, result, detail) values
      ('update_incident: fully-answered update-specific reporting persists all three answers on incident_updates',
        case when v_row.update_reported_to_ops = 'yes'
          and v_row.update_reported_to_ops_recipient = 'יוסי מהמוקד'
          and v_row.update_reported_to_comms = true
          and v_row.update_reported_to_comms_recipient = 'דנה מהתקשוב'
          and v_row.update_wisdom_reported = true
        then 'PASS' else 'FAIL' end,
        format('ops=%s ops_recip=%s comms=%s comms_recip=%s wisdom=%s',
          v_row.update_reported_to_ops, v_row.update_reported_to_ops_recipient,
          v_row.update_reported_to_comms, v_row.update_reported_to_comms_recipient,
          v_row.update_wisdom_reported));
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: fully-answered update-specific reporting persists all three answers on incident_updates', 'FAIL', sqlerrm);
  end;

  -- Opening-time reported_to_ops/reported_to_ops_recipient are provably
  -- untouched by the call above, despite it answering the new
  -- update-specific ops question with a "yes" of its own.
  insert into results (test, result, detail)
  select 'update_incident: incidents.reported_to_ops/reported_to_ops_recipient (opening facts) remain unchanged after an update-specific "yes" answer',
    case when i.reported_to_ops = 'yes' and i.reported_to_ops_recipient = 'ההשפעה המקורית בעת הפתיחה -- מוקד מבצעים'
      then 'PASS' else 'FAIL' end,
    format('reported_to_ops=%s recipient=%s', i.reported_to_ops, i.reported_to_ops_recipient)
  from incidents i where i.id = '00000000-0000-0000-0000-00000000f736';

  -- No reported_to_ops_change event is ever emitted by update_incident
  -- anymore -- the concept this event described (update_incident mutating
  -- the incident-level reported_to_ops pair) no longer exists.
  insert into results (test, result, detail)
  select 'update_incident: no reported_to_ops_change event is emitted',
    case when not exists (
      select 1 from incident_events where incident_id = '00000000-0000-0000-0000-00000000f736' and type = 'reported_to_ops_change'
    ) then 'PASS' else 'FAIL' end, '';

  -- Omitting all three update-specific reporting keys entirely (old-client
  -- compatibility: base_update_input never sends them) stores NULL for all
  -- five new columns, and does not raise.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f737',
      pg_temp.base_update_input(jsonb_build_object('eventTime', now() - interval '1 hour', 'expectedVersion', 1)));
    select * into v_row from incident_updates where incident_id = '00000000-0000-0000-0000-00000000f737'
      order by created_at desc limit 1;
    insert into results (test, result, detail) values
      ('update_incident: omitting all three update-specific reporting keys stores NULL for all five columns',
        case when v_row.update_reported_to_ops is null and v_row.update_reported_to_ops_recipient is null
          and v_row.update_reported_to_comms is null and v_row.update_reported_to_comms_recipient is null
          and v_row.update_wisdom_reported is null
        then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: omitting all three update-specific reporting keys stores NULL for all five columns', 'FAIL', sqlerrm);
  end;

  -- A legacy reportedToOps/reportedToOpsRecipient payload key (still sent by
  -- base_update_input's own default, and here explicitly overridden to
  -- "yes" with a recipient to simulate an old client bundle at its most
  -- assertive) is tolerated but not read as an answer to the new
  -- update-specific question, and does not touch the opening-time columns.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000f738', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '1 hour', 'expectedVersion', 1,
        'reportedToOps', 'yes', 'reportedToOpsRecipient', 'ערך מלקוח ישן',
        'updateReportedToOps', 'not_required', 'updateReportedToComms', 'no', 'updateWisdomReported', 'no')));
    select * into v_row from incident_updates where incident_id = '00000000-0000-0000-0000-00000000f738'
      order by created_at desc limit 1;
    insert into results (test, result, detail) values
      ('update_incident: a legacy reportedToOps/reportedToOpsRecipient key is tolerated but not read as update-specific reporting, and does not touch incidents.reported_to_ops',
        case when v_incident.reported_to_ops = 'no' and v_incident.reported_to_ops_recipient is null
          and v_row.update_reported_to_ops = 'not_required'
        then 'PASS' else 'FAIL' end,
        format('incident.reported_to_ops=%s incident.recipient=%s row.update_reported_to_ops=%s',
          v_incident.reported_to_ops, v_incident.reported_to_ops_recipient, v_row.update_reported_to_ops));
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: a legacy reportedToOps/reportedToOpsRecipient key is tolerated but not read as update-specific reporting, and does not touch incidents.reported_to_ops',
        'FAIL', sqlerrm);
  end;

  -- updateReportedToOps='yes' without a recipient is rejected with a
  -- controlled validation error, not a raw CHECK-constraint SQLSTATE.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f710', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '1 hour', 'updateReportedToOps', 'yes')));
    insert into results (test, result, detail) values
      ('update_incident: updateReportedToOps=''yes'' without a recipient is rejected', 'FAIL', 'no exception raised');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: updateReportedToOps=''yes'' without a recipient is rejected',
        case when sqlerrm like 'validation:%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- updateReportedToComms='yes' without a recipient is likewise rejected
  -- with a controlled validation error.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f722', pg_temp.base_update_input(
      jsonb_build_object('eventTime', now() - interval '1 hour', 'updateReportedToComms', 'yes')));
    insert into results (test, result, detail) values
      ('update_incident: updateReportedToComms=''yes'' without a recipient is rejected', 'FAIL', 'no exception raised');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: updateReportedToComms=''yes'' without a recipient is rejected',
        case when sqlerrm like 'validation:%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- PART D: create_incident -- next-update-ETA compatibility (0030)
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
  begin
    v_incident := create_incident(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000f701', 'locationId', '00000000-0000-0000-0000-00000000f702',
      'description', 'd', 'severity', 'medium', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
      'discoveredAt', now(), 'reportedToOps', 'not_required'
      -- nextUpdateDue / noDeadlineReason deliberately omitted entirely.
    ));
    insert into results (test, result, detail) values
      ('create_incident: omitting both deadline keys succeeds and stores NULL/NULL',
        case when v_incident.next_update_due is null and v_incident.no_deadline_reason is null
          then 'PASS' else 'FAIL' end,
        'due=' || v_incident.next_update_due || ' reason=' || v_incident.no_deadline_reason);
  exception when others then
    insert into results (test, result, detail) values
      ('create_incident: omitting both deadline keys succeeds and stores NULL/NULL', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- PART E: reopen_incident -- next-update-ETA compatibility (0030)
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e5'); -- system_admin

  -- Omitting nextUpdateDue on a closed incident with a pre-set legacy pair
  -- preserves both columns exactly through the reopen.
  begin
    v_incident := reopen_incident('00000000-0000-0000-0000-00000000f740', pg_temp.base_reopen_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('reopen_incident: omitting nextUpdateDue preserves the incident''s existing next_update_due/no_deadline_reason',
        case when v_incident.next_update_due is null and v_incident.no_deadline_reason = 'התקלה נסגרה'
          then 'PASS' else 'FAIL' end,
        'due=' || v_incident.next_update_due || ' reason=' || v_incident.no_deadline_reason);
  exception when others then
    insert into results (test, result, detail) values
      ('reopen_incident: omitting nextUpdateDue preserves the incident''s existing next_update_due/no_deadline_reason', 'FAIL', sqlerrm);
  end;
  insert into results (test, result, detail) values
    ('reopen_incident: succeeds without a nextUpdateDue key at all (no longer a required field)',
      case when v_incident.status = 'reopened' then 'PASS' else 'FAIL' end, 'status=' || v_incident.status);

  -- A legacy caller that still explicitly supplies nextUpdateDue is honored.
  begin
    v_incident2 := reopen_incident('00000000-0000-0000-0000-00000000f741', pg_temp.base_reopen_input(
      jsonb_build_object('nextUpdateDue', now() + interval '2 hours')));
    insert into results (test, result, detail) values
      ('reopen_incident: legacy caller explicitly supplying nextUpdateDue is honored',
        case when v_incident2.next_update_due is not null then 'PASS' else 'FAIL' end,
        'due=' || v_incident2.next_update_due);
  exception when others then
    insert into results (test, result, detail) values
      ('reopen_incident: legacy caller explicitly supplying nextUpdateDue is honored', 'FAIL', sqlerrm);
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
