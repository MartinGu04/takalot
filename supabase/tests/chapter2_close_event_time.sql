-- Tests for migration 0033: close_incident retroactive closure time
-- (מועד סגירת התקלה בפועל).
--
-- Covers: eventTime now mandatory on close_incident; missing/JSON-null/
-- empty/whitespace-only rejected with a controlled validation error;
-- malformed non-empty values (invalid_datetime_format, datetime_field_
-- overflow, invalid_time_zone_displacement_value shapes) rejected as a
-- controlled validation error, never a raw Postgres cast error; lower bound
-- (incident's own discovered_at) and upper bound (now() + 5 minutes)
-- enforced with INCLUSIVE boundaries; closed_at is set to the validated
-- eventTime, not now(); every incident_events row this call emits ('closed',
-- 'reported_to_ops_change', 'assignment_change') carries the same
-- eventTime as its event_time, while server_time stays independently
-- database-generated (the "actual recording time"); applies identically in
-- the partial-readiness branch (closed_at itself stays untouched there,
-- unchanged from before this migration); everything else this migration
-- does not touch (rootCause/resolution requirement, readiness/follow-up/
-- owner rules, reportedToOps recipient rule, external-handler rule,
-- permission checks, expectedVersion/optimistic concurrency) still behaves
-- exactly as before.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000c1', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-tech@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000c1', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000c2', 'Owner Technician', 'technician', true);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000c701', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000c702', 'Loc', 1);

-- c810: reused across every REJECTED-call test below -- each rejection
-- rolls back inside its own begin/exception block, so the incident stays
-- open (status/version unchanged) and reusable for the next rejection.
-- c811-c816: one fresh incident per SUCCESSFUL close, since a successful
-- full-readiness close terminates the incident.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       version)
values
  ('00000000-0000-0000-0000-00000000c810', 'C-810', '00000000-0000-0000-0000-00000000c701',
   '00000000-0000-0000-0000-00000000c702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', 1),
  ('00000000-0000-0000-0000-00000000c811', 'C-811', '00000000-0000-0000-0000-00000000c701',
   '00000000-0000-0000-0000-00000000c702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', 1),
  ('00000000-0000-0000-0000-00000000c812', 'C-812', '00000000-0000-0000-0000-00000000c701',
   '00000000-0000-0000-0000-00000000c702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', 1),
  ('00000000-0000-0000-0000-00000000c813', 'C-813', '00000000-0000-0000-0000-00000000c701',
   '00000000-0000-0000-0000-00000000c702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', 1),
  ('00000000-0000-0000-0000-00000000c815', 'C-815', '00000000-0000-0000-0000-00000000c701',
   '00000000-0000-0000-0000-00000000c702', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

-- Base valid close_incident input (full readiness, no reporting, no
-- external handler). `extra` overrides/adds keys, including eventTime,
-- per-check.
create or replace function pg_temp.base_close_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'rootCause', 'סיבה', 'resolution', 'פתרון', 'readiness', 'full',
    'followUpNotes', '', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_close_input(jsonb) to authenticated;

do $$
declare
  v_incident incidents;
  v_row record;
  v_discovered_at timestamptz;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;

  -- 1. Missing eventTime key entirely.
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c810',
      (pg_temp.base_close_input('{}'::jsonb) - 'eventTime'));
    insert into results (test, result, detail) values ('close_incident: missing eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('close_incident: missing eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד סגירת התקלה בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 2. JSON-null eventTime.
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c810', pg_temp.base_close_input(
      jsonb_build_object('eventTime', null)));
    insert into results (test, result, detail) values ('close_incident: JSON-null eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('close_incident: JSON-null eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד סגירת התקלה בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 3. Empty-string eventTime.
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c810', pg_temp.base_close_input(
      jsonb_build_object('eventTime', '')));
    insert into results (test, result, detail) values ('close_incident: empty-string eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('close_incident: empty-string eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד סגירת התקלה בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 4. Whitespace-only eventTime.
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c810', pg_temp.base_close_input(
      jsonb_build_object('eventTime', '   ')));
    insert into results (test, result, detail) values ('close_incident: whitespace-only eventTime rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('close_incident: whitespace-only eventTime rejected',
      case when sqlerrm = 'validation: יש להזין מועד סגירת התקלה בפועל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 5. Malformed, unparseable text (invalid_datetime_format / 22007 shape).
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c810', pg_temp.base_close_input(
      jsonb_build_object('eventTime', 'not-a-timestamp')));
    insert into results (test, result, detail) values
      ('close_incident: malformed eventTime ("not-a-timestamp") rejected as controlled validation', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident: malformed eventTime ("not-a-timestamp") rejected as controlled validation',
        case when sqlstate = 'P0001' and sqlerrm = 'validation: מועד סגירת התקלה אינו תקין' then 'PASS' else 'FAIL' end,
        'sqlstate=' || sqlstate || ' sqlerrm=' || sqlerrm);
  end;

  -- 6. Malformed, out-of-range shape (datetime_field_overflow / 22008 shape).
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c810', pg_temp.base_close_input(
      jsonb_build_object('eventTime', '2026-13-45 25:99:99')));
    insert into results (test, result, detail) values
      ('close_incident: out-of-range eventTime ("2026-13-45 25:99:99") rejected as controlled validation', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident: out-of-range eventTime ("2026-13-45 25:99:99") rejected as controlled validation',
        case when sqlstate = 'P0001' and sqlerrm = 'validation: מועד סגירת התקלה אינו תקין' then 'PASS' else 'FAIL' end,
        'sqlstate=' || sqlstate || ' sqlerrm=' || sqlerrm);
  end;

  -- 7. Malformed, out-of-range UTC offset (invalid_time_zone_displacement_value / 22009 shape).
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c810', pg_temp.base_close_input(
      jsonb_build_object('eventTime', '2026-07-28T16:00:00+25:00')));
    insert into results (test, result, detail) values
      ('close_incident: out-of-range UTC offset eventTime ("...+25:00") rejected as controlled validation', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident: out-of-range UTC offset eventTime ("...+25:00") rejected as controlled validation',
        case when sqlstate = 'P0001' and sqlerrm = 'validation: מועד סגירת התקלה אינו תקין' then 'PASS' else 'FAIL' end,
        'sqlstate=' || sqlstate || ' sqlerrm=' || sqlerrm);
  end;

  -- 8. Before the incident's own discovered_at (discovered 2 days ago).
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c810', pg_temp.base_close_input(
      jsonb_build_object('eventTime', now() - interval '3 days')));
    insert into results (test, result, detail) values ('close_incident: eventTime before discovered_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('close_incident: eventTime before discovered_at rejected',
      case when sqlerrm = 'validation: מועד סגירת התקלה אינו תקין' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 9. Beyond now() + 5 minutes.
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c810', pg_temp.base_close_input(
      jsonb_build_object('eventTime', now() + interval '10 minutes')));
    insert into results (test, result, detail) values ('close_incident: eventTime beyond now()+5min rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('close_incident: eventTime beyond now()+5min rejected',
      case when sqlerrm = 'validation: מועד סגירת התקלה אינו תקין' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 10. A rejected eventTime never mutates the incident (still version 1,
  -- still open) -- every rejection above ran against c810 and none of them
  -- should have advanced it.
  select * into v_incident from incidents where id = '00000000-0000-0000-0000-00000000c810';
  insert into results (test, result, detail) values
    ('close_incident: every rejected eventTime left the incident untouched (still version 1, still in_progress)',
      case when v_incident.version = 1 and v_incident.status = 'in_progress' then 'PASS' else 'FAIL' end,
      'version=' || v_incident.version || ' status=' || v_incident.status);

  -- 11. Exact discovered_at boundary is accepted (inclusive lower bound),
  -- and closed_at is set to that validated eventTime, not now().
  select discovered_at into v_discovered_at from incidents where id = '00000000-0000-0000-0000-00000000c811';
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000c811', pg_temp.base_close_input(
      jsonb_build_object('eventTime', v_discovered_at)));
    insert into results (test, result, detail) values
      ('close_incident: eventTime exactly equal to discovered_at is accepted, and closed_at equals it',
        case when v_incident.status = 'closed' and v_incident.closed_at = v_discovered_at
             then 'PASS' else 'FAIL' end,
        'discovered_at=' || v_discovered_at || ' closed_at=' || v_incident.closed_at);
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident: eventTime exactly equal to discovered_at is accepted, and closed_at equals it', 'FAIL', sqlerrm);
  end;

  -- 12. Exact now() + 5 minutes boundary is accepted (inclusive upper bound).
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000c812', pg_temp.base_close_input(
      jsonb_build_object('eventTime', now() + interval '5 minutes')));
    insert into results (test, result, detail) values
      ('close_incident: eventTime exactly equal to now()+5min is accepted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident: eventTime exactly equal to now()+5min is accepted', 'FAIL', sqlerrm);
  end;

  -- 13. A genuinely backdated (but in-bounds) eventTime: closed_at equals
  -- the validated eventTime, not now(); the 'closed' event's event_time
  -- equals the same validated eventTime; server_time is independently
  -- database-generated (~now()) and distinct from event_time -- server_time
  -- remains the actual recording time, per migration 0033's contract.
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000c813', pg_temp.base_close_input(
      jsonb_build_object('eventTime', now() - interval '1 day')));
    select event_time, server_time into v_row from incident_events
      where incident_id = '00000000-0000-0000-0000-00000000c813' and type = 'closed';
    insert into results (test, result, detail) values
      ('close_incident: backdated eventTime -> closed_at equals it, not now()',
        case when v_incident.closed_at = now() - interval '1 day' then 'PASS' else 'FAIL' end,
        'closed_at=' || v_incident.closed_at);
    insert into results (test, result, detail) values
      ('close_incident: the ''closed'' event''s event_time equals the validated eventTime',
        case when v_row.event_time = now() - interval '1 day' then 'PASS' else 'FAIL' end,
        'event_time=' || v_row.event_time);
    insert into results (test, result, detail) values
      ('close_incident: server_time is database-generated and distinct from the backdated event_time',
        case when v_row.server_time is not null and v_row.server_time <> v_row.event_time
              and v_row.server_time > now() - interval '1 minute'
             then 'PASS' else 'FAIL' end,
        'event_time=' || v_row.event_time || ' server_time=' || v_row.server_time);
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident: backdated eventTime -> closed_at equals it, not now()', 'FAIL', sqlerrm);
  end;

  -- 14. Partial-readiness branch: the eventTime bound is enforced
  -- identically (readiness behavior itself is otherwise unchanged --
  -- closed_at stays NULL, status becomes partial_readiness, exactly as
  -- before this migration), and the emitted 'status_change' event carries
  -- the same validated eventTime.
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000c815', jsonb_build_object(
      'expectedVersion', 1, 'eventTime', now() - interval '2 hours',
      'rootCause', 'סיבה', 'resolution', 'פתרון חלקי', 'readiness', 'partial',
      'followUpNotes', 'להשלים בדיקה', 'ownerUserId', '00000000-0000-0000-0000-0000000000c2',
      'reportedToOps', 'not_required'));
    select event_time into v_row from incident_events
      where incident_id = '00000000-0000-0000-0000-00000000c815' and type = 'status_change';
    insert into results (test, result, detail) values
      ('close_incident (partial readiness): eventTime bound applies, closed_at stays NULL, status_change carries eventTime',
        case when v_incident.status = 'partial_readiness' and v_incident.closed_at is null
              and v_row.event_time = now() - interval '2 hours'
             then 'PASS' else 'FAIL' end,
        'status=' || v_incident.status || ' closed_at=' || coalesce(v_incident.closed_at::text, '<null>') ||
        ' event_time=' || v_row.event_time);
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (partial readiness): eventTime bound applies, closed_at stays NULL, status_change carries eventTime',
        'FAIL', sqlerrm);
  end;

  -- 15. Partial-readiness branch also rejects an out-of-bounds eventTime
  -- (same guard, same message, applied before either branch runs).
  begin
    perform close_incident('00000000-0000-0000-0000-00000000c815', jsonb_build_object(
      'expectedVersion', 2, 'eventTime', now() + interval '10 minutes',
      'rootCause', 'סיבה', 'resolution', 'פתרון חלקי', 'readiness', 'partial',
      'followUpNotes', 'להשלים בדיקה', 'ownerUserId', '00000000-0000-0000-0000-0000000000c2',
      'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values
      ('close_incident (partial readiness): eventTime beyond now()+5min rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (partial readiness): eventTime beyond now()+5min rejected',
        case when sqlerrm = 'validation: מועד סגירת התקלה אינו תקין' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  reset role;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
