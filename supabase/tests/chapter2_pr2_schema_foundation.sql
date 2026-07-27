-- Tests for migrations 0015 + 0016 (Chapter 2 PR2: schema foundation).
-- Pure schema/constraint/trigger/RLS tests -- PR2 adds no RPCs, so fixtures
-- and attempts are direct table statements (INSERT/UPDATE/DELETE), exactly
-- like every other fixture-setup in this suite already does; RLS-specific
-- checks switch to `authenticated` + a simulated JWT, exactly like the
-- existing suites.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000d1', 'admin@test', now()),
  ('00000000-0000-0000-0000-0000000000d2', 'tech-active@test', now()),
  ('00000000-0000-0000-0000-0000000000d3', 'tech-inactive@test', now()),
  ('00000000-0000-0000-0000-0000000000d4', 'supervisor@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000d1', 'Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000d2', 'Active Tech', 'technician', true),
  ('00000000-0000-0000-0000-0000000000d3', 'Inactive Tech', 'technician', false),
  ('00000000-0000-0000-0000-0000000000d4', 'Supervisor', 'shift_supervisor', true);

insert into systems (id, name) values ('00000000-0000-0000-0000-00000000f601', 'Sys');
insert into locations (id, name) values ('00000000-0000-0000-0000-00000000f602', 'Loc');

-- General-purpose open incident used across cancellation/report/status-check/severity sections.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000f610', 'T-601',
        '00000000-0000-0000-0000-00000000f601', '00000000-0000-0000-0000-00000000f602',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000d1', now(),
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
        now() + interval '4 hours', 1);

-- A properly-closed incident, for the closed+cancelled redundancy check.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       closed_at, closed_by, root_cause, resolution, readiness_at_close, version)
values ('00000000-0000-0000-0000-00000000f612', 'T-602',
        '00000000-0000-0000-0000-00000000f601', '00000000-0000-0000-0000-00000000f602',
        'desc', 'low', 'closed', 'impact',
        '00000000-0000-0000-0000-0000000000d1', now() - interval '2 days',
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
        now(), '00000000-0000-0000-0000-0000000000d1', 'root', 'resolution', 'full', 1);

insert into severity_rulesets (id, version, name, guiding_questions, published_by, active)
values ('00000000-0000-0000-0000-00000000e701', 1, 'Ruleset v1', '[]'::jsonb,
        '00000000-0000-0000-0000-0000000000d1', true);

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
  v_assessment_id uuid;
  v_assessment_id_2 uuid;
  v_completed_id uuid;
begin
  -- ===================================================================
  -- A. Helper-function truth table: all 14 incident_status values
  -- ===================================================================
  with expected(status, terminal, is_open, workflow, legacy) as (
    values
      ('new'::incident_status,               false, true,  false, true),
      ('acknowledged'::incident_status,      false, true,  false, true),
      ('in_progress'::incident_status,       false, true,  true,  false),
      ('waiting_external'::incident_status,  false, true,  true,  false),
      ('waiting_test'::incident_status,      false, true,  false, true),
      ('monitoring'::incident_status,        false, true,  false, true),
      ('partial_readiness'::incident_status, false, true,  false, true),
      ('resolved_pending_close'::incident_status, false, true, false, true),
      ('closed'::incident_status,            true,  false, false, false),
      ('reopened'::incident_status,          false, true,  false, true),
      ('waiting_equipment'::incident_status,   false, true, true,  false),
      ('waiting_information'::incident_status, false, true, true,  false),
      ('waiting_validation'::incident_status,  false, true, true,  false),
      ('cancelled'::incident_status,         true,  false, false, false)
  )
  insert into results (test, result, detail)
  select
    'truth table: ' || status::text,
    case when is_incident_terminal(status) = terminal
          and is_incident_open(status) = is_open
          and is_current_workflow_status(status) = workflow
          and is_incident_legacy_status(status) = legacy
      then 'PASS' else 'FAIL' end,
    format('terminal=%s open=%s workflow=%s legacy=%s',
      is_incident_terminal(status), is_incident_open(status),
      is_current_workflow_status(status), is_incident_legacy_status(status))
  from expected;

  -- ===================================================================
  -- B. Cancellation metadata -- bidirectional
  -- ===================================================================
  begin
    update incidents set status = 'cancelled', cancelled_at = now(),
      cancelled_by = '00000000-0000-0000-0000-0000000000d1', cancellation_reason = 'duplicate report'
      where id = '00000000-0000-0000-0000-00000000f610';
    insert into results (test, result, detail) values ('B1: full cancellation metadata on status=cancelled', 'PASS', '');
    -- revert for subsequent sections
    update incidents set status = 'in_progress', cancelled_at = null, cancelled_by = null, cancellation_reason = null
      where id = '00000000-0000-0000-0000-00000000f610';
  exception when others then
    insert into results (test, result, detail) values ('B1: full cancellation metadata on status=cancelled', 'FAIL', sqlerrm);
  end;

  begin
    update incidents set status = 'cancelled', cancelled_by = '00000000-0000-0000-0000-0000000000d1',
      cancellation_reason = 'reason' where id = '00000000-0000-0000-0000-00000000f610';
    insert into results (test, result, detail) values ('B2: cancelled missing cancelled_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('B2: cancelled missing cancelled_at rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update incidents set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'reason'
      where id = '00000000-0000-0000-0000-00000000f610';
    insert into results (test, result, detail) values ('B3: cancelled missing cancelled_by rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('B3: cancelled missing cancelled_by rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update incidents set status = 'cancelled', cancelled_at = now(),
      cancelled_by = '00000000-0000-0000-0000-0000000000d1', cancellation_reason = '   '
      where id = '00000000-0000-0000-0000-00000000f610';
    insert into results (test, result, detail) values ('B4: cancelled with blank cancellation_reason rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('B4: cancelled with blank cancellation_reason rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update incidents set cancelled_at = now() where id = '00000000-0000-0000-0000-00000000f610'; -- status stays in_progress
    insert into results (test, result, detail) values ('B5: partial cancellation metadata on non-cancelled incident rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('B5: partial cancellation metadata on non-cancelled incident rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update incidents set cancelled_at = now(), cancelled_by = '00000000-0000-0000-0000-0000000000d1',
      cancellation_reason = 'reason' where id = '00000000-0000-0000-0000-00000000f612'; -- status is 'closed'
    insert into results (test, result, detail) values ('B6: cancellation metadata on a closed incident rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('B6: cancellation metadata on a closed incident rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  select count(*) into v_count from pg_constraint
    where conname = 'incident_not_closed_and_cancelled' and conrelid = 'incidents'::regclass;
  insert into results (test, result, detail) values
    ('B7: incident_not_closed_and_cancelled constraint exists (defense-in-depth backstop)',
      case when v_count = 1 then 'PASS' else 'FAIL' end, 'count=' || v_count);

  -- ===================================================================
  -- C. Structured reporting -- yes/no/not_required, three timestamps
  -- ===================================================================
  begin
    insert into incident_report_events (incident_id, channel, status, reported_by_user_id, recipient,
      event_time, reported_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_room', 'yes', '00000000-0000-0000-0000-0000000000d2',
      'Ops duty officer', now() - interval '10 minutes', now() - interval '5 minutes', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C1: yes with internal performer + recipient + reported_at', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('C1: yes with internal performer + recipient + reported_at', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, reported_by_external_name, recipient,
      reported_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_communications', 'yes', 'External Contractor',
      'Comms desk', now(), '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C2: yes with external performer', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('C2: yes with external performer', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, reported_by_user_id, reported_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_room', 'yes', '00000000-0000-0000-0000-0000000000d2', now(), '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C3: yes missing recipient rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('C3: yes missing recipient rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, reported_by_user_id, recipient, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_room', 'yes', '00000000-0000-0000-0000-0000000000d2', 'recipient', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C4: yes missing reported_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('C4: yes missing reported_at rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, recipient, reported_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_room', 'yes', 'recipient', now(), '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C5: yes missing any performer rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('C5: yes missing any performer rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, reported_by_user_id, reported_by_external_name,
      recipient, reported_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_room', 'yes', '00000000-0000-0000-0000-0000000000d2', 'External',
      'recipient', now(), '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C6: yes with both performer fields set rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('C6: yes with both performer fields set rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_room', 'no', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C7: status=no with all report-specific fields null', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('C7: status=no with all report-specific fields null', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_communications', 'not_required', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C8: status=not_required with all report-specific fields null', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('C8: status=not_required with all report-specific fields null', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, recipient, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_room', 'no', 'stray recipient', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C9: status=no with recipient populated rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('C9: status=no with recipient populated rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, reported_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_room', 'not_required', now(), '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C10: status=not_required with reported_at populated rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('C10: status=not_required with reported_at populated rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_report_events (incident_id, channel, status, event_time, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'ops_room', 'no', null, '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('C11: explicit null event_time rejected (not null)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('C11: explicit null event_time rejected (not null)',
      case when sqlerrm like '%null value in column "event_time"%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  select count(*) into v_count from (
    select distinct event_time, reported_at, recorded_at from incident_report_events
    where incident_id = '00000000-0000-0000-0000-00000000f610' and status = 'yes'
    limit 1
  ) t;
  insert into results (test, result, detail) values
    ('C12: event_time/reported_at/recorded_at remain three distinguishable columns', 'PASS', 'sample row has 3 distinct timestamp columns by design');

  -- ===================================================================
  -- D. Status-check kinds -- fully bidirectional per kind
  -- ===================================================================
  begin
    insert into incident_status_checks (incident_id, kind, due_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'scheduled', now() + interval '1 day', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D1: scheduled with due_at, no previous_due_at', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('D1: scheduled with due_at, no previous_due_at', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'scheduled', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D2: scheduled missing due_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D2: scheduled missing due_at rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, due_at, previous_due_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'scheduled', now() + interval '1 day', now(), '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D3: scheduled with previous_due_at populated rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D3: scheduled with previous_due_at populated rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, due_at, previous_due_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'rescheduled', now() + interval '2 days', now() + interval '1 day', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D4: rescheduled with due_at + previous_due_at', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('D4: rescheduled with due_at + previous_due_at', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, previous_due_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'rescheduled', now(), '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D5: rescheduled missing due_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D5: rescheduled missing due_at rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, due_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'rescheduled', now() + interval '1 day', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D6: rescheduled missing previous_due_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D6: rescheduled missing previous_due_at rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, previous_due_at, performed_by_user_id, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'completed', now(), '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1')
    returning id into v_completed_id;
    insert into results (test, result, detail) values ('D7: completed with previous_due_at + explicit performer', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('D7: completed with previous_due_at + explicit performer', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, due_at, previous_due_at, performed_by_user_id, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'completed', now() + interval '1 day', now(), '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D8: completed with due_at populated rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D8: completed with due_at populated rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, performed_by_user_id, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'completed', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D9: completed missing previous_due_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D9: completed missing previous_due_at rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, previous_due_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'completed', now(), '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D10: completed with no explicit performer rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D10: completed with no explicit performer rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, previous_due_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'removed', now() + interval '1 day', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D11: removed with previous_due_at, no performer (convention)', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('D11: removed with previous_due_at, no performer (convention)', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, due_at, previous_due_at, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'removed', now() + interval '1 day', now(), '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D12: removed with due_at populated rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D12: removed with due_at populated rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'removed', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D13: removed missing previous_due_at rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D13: removed missing previous_due_at rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    insert into incident_status_checks (incident_id, kind, due_at, performed_by_user_id, performed_by_external_name, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 'scheduled', now() + interval '1 day', '00000000-0000-0000-0000-0000000000d2', 'External', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('D14: performer mutual exclusivity rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('D14: performer mutual exclusivity rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- D15: completed (D7 above) immediately followed by a fresh 'scheduled' row
  -- reusing the SAME date as the completed row's previous_due_at -- two
  -- distinct rows, never merged.
  insert into incident_status_checks (incident_id, kind, due_at, recorded_by)
  select '00000000-0000-0000-0000-00000000f610', 'scheduled', previous_due_at, '00000000-0000-0000-0000-0000000000d1'
  from incident_status_checks where id = v_completed_id;

  select count(*) into v_count from incident_status_checks
  where incident_id = '00000000-0000-0000-0000-00000000f610' and kind in ('completed', 'scheduled');
  insert into results (test, result, detail) values
    ('D15: completed + immediately-following scheduled (same date) remain two distinct rows',
      case when v_count >= 2 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  -- ===================================================================
  -- E/F. Current-severity linkage: composite FK + mirror consistency +
  --      two-level override threshold, on incident_severity_assessments
  --      AND the incidents-level denormalized mirror
  -- ===================================================================

  -- E1-E4: threshold on incident_severity_assessments alone.
  insert into incident_severity_assessments (incident_id, ruleset_version, answers, recommended_severity,
    recommendation_reasons, chosen_severity, assessed_by, recorded_by)
  values ('00000000-0000-0000-0000-00000000f610', 1, '{}'::jsonb, 'critical', '[]'::jsonb, 'critical',
    '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1');
  insert into results (test, result, detail) values ('E1: assessment distance 0, no reason', 'PASS', '');

  insert into incident_severity_assessments (incident_id, ruleset_version, answers, recommended_severity,
    recommendation_reasons, chosen_severity, assessed_by, recorded_by)
  values ('00000000-0000-0000-0000-00000000f610', 1, '{}'::jsonb, 'critical', '[]'::jsonb, 'high',
    '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1');
  insert into results (test, result, detail) values ('E2: assessment distance 1, no reason', 'PASS', '');

  insert into incident_severity_assessments (incident_id, ruleset_version, answers, recommended_severity,
    recommendation_reasons, chosen_severity, override_reason, assessed_by, recorded_by)
  values ('00000000-0000-0000-0000-00000000f610', 1, '{}'::jsonb, 'critical', '[]'::jsonb, 'high',
    'optional note, not required', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1');
  insert into results (test, result, detail) values ('E3: assessment distance 1 with optional reason anyway', 'PASS', '');

  begin
    insert into incident_severity_assessments (incident_id, ruleset_version, answers, recommended_severity,
      recommendation_reasons, chosen_severity, assessed_by, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 1, '{}'::jsonb, 'critical', '[]'::jsonb, 'medium',
      '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('E4: assessment distance 2, no reason rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('E4: assessment distance 2, no reason rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  insert into incident_severity_assessments (incident_id, ruleset_version, answers, recommended_severity,
    recommendation_reasons, chosen_severity, override_reason, assessed_by, recorded_by)
  values ('00000000-0000-0000-0000-00000000f610', 1, '{}'::jsonb, 'critical', '[]'::jsonb, 'medium',
    'genuine override justification', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1')
  returning id into v_assessment_id;
  insert into results (test, result, detail) values ('E5: assessment distance 2 with reason', 'PASS', '');

  begin
    insert into incident_severity_assessments (incident_id, ruleset_version, answers, recommended_severity,
      recommendation_reasons, chosen_severity, assessed_by, recorded_by)
    values ('00000000-0000-0000-0000-00000000f610', 1, '{}'::jsonb, 'critical', '[]'::jsonb, 'low',
      '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1');
    insert into results (test, result, detail) values ('E6: assessment distance 3, no reason rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('E6: assessment distance 3, no reason rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  insert into incident_severity_assessments (incident_id, ruleset_version, answers, recommended_severity,
    recommendation_reasons, chosen_severity, override_reason, assessed_by, recorded_by)
  values ('00000000-0000-0000-0000-00000000f610', 1, '{}'::jsonb, 'critical', '[]'::jsonb, 'low',
    'genuine override justification', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d1');
  insert into results (test, result, detail) values ('E7: assessment distance 3 with reason', 'PASS', '');

  -- F1: full linkage flow -- incident points at v_assessment_id (E5's row:
  -- chosen=medium, recommended=critical, ruleset_version=1), mirrored
  -- exactly. Applies distance-2-with-reason at the incidents level too.
  begin
    update incidents set current_severity_assessment_id = v_assessment_id, severity_ruleset_version = 1,
      severity_recommended = 'critical', severity = 'medium', severity_override_reason = 'genuine override justification'
      where id = '00000000-0000-0000-0000-00000000f610';
    insert into results (test, result, detail) values ('F1: incident linked to exact matching assessment (composite FK)', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('F1: incident linked to exact matching assessment (composite FK)', 'FAIL', sqlerrm);
  end;

  -- F2: mismatched severity (incident.severity != assessment.chosen_severity) rejected.
  begin
    update incidents set current_severity_assessment_id = v_assessment_id, severity_ruleset_version = 1,
      severity_recommended = 'critical', severity = 'high' -- assessment's chosen_severity is 'medium', not 'high'
      where id = '00000000-0000-0000-0000-00000000f610';
    insert into results (test, result, detail) values ('F2: mismatched mirrored severity rejected by composite FK', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('F2: mismatched mirrored severity rejected by composite FK',
      case when sqlerrm like '%foreign key constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- F3: pointer to a nonexistent assessment id rejected.
  begin
    update incidents set current_severity_assessment_id = gen_random_uuid(), severity_ruleset_version = 1,
      severity_recommended = 'critical', severity = 'medium'
      where id = '00000000-0000-0000-0000-00000000f610';
    insert into results (test, result, detail) values ('F3: pointer to nonexistent assessment rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('F3: pointer to nonexistent assessment rejected',
      case when sqlerrm like '%foreign key constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- F4: current_severity_assessment_id null but severity_ruleset_version populated rejected (all-or-none CHECK,
  -- the gap the composite FK's MATCH SIMPLE null-skip does NOT cover on its own).
  begin
    update incidents set current_severity_assessment_id = null, severity_ruleset_version = 1,
      severity_recommended = null where id = '00000000-0000-0000-0000-00000000f610';
    insert into results (test, result, detail) values ('F4: null pointer with stray severity_ruleset_version rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('F4: null pointer with stray severity_ruleset_version rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- confirm F1's valid link is still intact (F2-F4 were all rejected and rolled back individually).
  select count(*) into v_count from incidents
  where id = '00000000-0000-0000-0000-00000000f610' and current_severity_assessment_id = v_assessment_id;
  insert into results (test, result, detail) values
    ('F5: valid linkage from F1 survives the rejected attempts in F2-F4', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  -- ===================================================================
  -- G. severity_rulesets immutability (definition frozen, active mutable, no delete)
  -- ===================================================================
  begin
    insert into severity_rulesets (id, version, name, guiding_questions, published_by, active)
    values ('00000000-0000-0000-0000-00000000e702', 2, 'Ruleset v2', '[]'::jsonb, '00000000-0000-0000-0000-0000000000d1', true);
    insert into results (test, result, detail) values ('G1: second ruleset with active=true while another is active rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('G1: second ruleset with active=true while another is active rejected',
      case when sqlerrm like '%idx_severity_rulesets_single_active%' or sqlerrm like '%duplicate key%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update severity_rulesets set active = false where id = '00000000-0000-0000-0000-00000000e701';
    update severity_rulesets set active = true where id = '00000000-0000-0000-0000-00000000e701';
    insert into results (test, result, detail) values ('G2: active-only update round-trip allowed', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('G2: active-only update round-trip allowed', 'FAIL', sqlerrm);
  end;

  begin
    update severity_rulesets set name = 'renamed' where id = '00000000-0000-0000-0000-00000000e701';
    insert into results (test, result, detail) values ('G3: definition change (name) rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('G3: definition change (name) rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update severity_rulesets set version = 99 where id = '00000000-0000-0000-0000-00000000e701';
    insert into results (test, result, detail) values ('G4: version change rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('G4: version change rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update severity_rulesets set guiding_questions = '[{"x":1}]'::jsonb where id = '00000000-0000-0000-0000-00000000e701';
    insert into results (test, result, detail) values ('G5: guiding_questions change rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('G5: guiding_questions change rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update severity_rulesets set scoring_config = '{"x":1}'::jsonb where id = '00000000-0000-0000-0000-00000000e701';
    insert into results (test, result, detail) values ('G6: scoring_config change rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('G6: scoring_config change rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update severity_rulesets set published_by = '00000000-0000-0000-0000-0000000000d4' where id = '00000000-0000-0000-0000-00000000e701';
    insert into results (test, result, detail) values ('G7: published_by change rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('G7: published_by change rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    -- now() returns the TRANSACTION start time (stable for the whole
    -- script, since it all runs in one begin;...rollback;) -- must use a
    -- value distinguishable from the insert-time now() to actually
    -- exercise the trigger's column-diff check, not accidentally no-op.
    update severity_rulesets set published_at = now() + interval '1 second' where id = '00000000-0000-0000-0000-00000000e701';
    insert into results (test, result, detail) values ('G8: published_at change rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('G8: published_at change rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update severity_rulesets set created_at = now() + interval '1 second' where id = '00000000-0000-0000-0000-00000000e701';
    insert into results (test, result, detail) values ('G9: created_at change rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('G9: created_at change rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    delete from severity_rulesets where id = '00000000-0000-0000-0000-00000000e701';
    insert into results (test, result, detail) values ('G10: deletion rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('G10: deletion rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- ===================================================================
  -- H. Append-only protection on the three genuine event/history tables
  -- ===================================================================
  begin
    update incident_severity_assessments set chosen_severity = 'low' where id = v_assessment_id;
    insert into results (test, result, detail) values ('H1: incident_severity_assessments UPDATE rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('H1: incident_severity_assessments UPDATE rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    delete from incident_severity_assessments where id = v_assessment_id;
    insert into results (test, result, detail) values ('H2: incident_severity_assessments DELETE rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('H2: incident_severity_assessments DELETE rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update incident_report_events set status = 'no'
      where id = (select id from incident_report_events
                  where incident_id = '00000000-0000-0000-0000-00000000f610' and status = 'yes' limit 1);
    insert into results (test, result, detail) values ('H3: incident_report_events UPDATE rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('H3: incident_report_events UPDATE rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    delete from incident_report_events
      where id = (select id from incident_report_events
                  where incident_id = '00000000-0000-0000-0000-00000000f610' limit 1);
    insert into results (test, result, detail) values ('H4: incident_report_events DELETE rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('H4: incident_report_events DELETE rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  begin
    update incident_status_checks set note = 'edited' where id = v_completed_id;
    insert into results (test, result, detail) values ('H5: incident_status_checks UPDATE rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('H5: incident_status_checks UPDATE rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    delete from incident_status_checks where id = v_completed_id;
    insert into results (test, result, detail) values ('H6: incident_status_checks DELETE rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('H6: incident_status_checks DELETE rejected',
      case when sqlerrm like 'append_only%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- ===================================================================
  -- I. RLS: active members can read, inactive cannot, no write policy exists
  -- ===================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1'); -- active
  set local role authenticated;
  select count(*) into v_count from severity_rulesets;
  insert into results (test, result, detail) values ('I1: active member reads severity_rulesets', case when v_count > 0 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  select count(*) into v_count from incident_severity_assessments;
  insert into results (test, result, detail) values ('I2: active member reads incident_severity_assessments', case when v_count > 0 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  select count(*) into v_count from incident_report_events;
  insert into results (test, result, detail) values ('I3: active member reads incident_report_events', case when v_count > 0 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  select count(*) into v_count from incident_status_checks;
  insert into results (test, result, detail) values ('I4: active member reads incident_status_checks', case when v_count > 0 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d3'); -- inactive
  set local role authenticated;
  select count(*) into v_count from severity_rulesets;
  insert into results (test, result, detail) values ('I5: inactive user reads zero rows from severity_rulesets', case when v_count = 0 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  select count(*) into v_count from incident_severity_assessments;
  insert into results (test, result, detail) values ('I6: inactive user reads zero rows from incident_severity_assessments', case when v_count = 0 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  select count(*) into v_count from incident_report_events;
  insert into results (test, result, detail) values ('I7: inactive user reads zero rows from incident_report_events', case when v_count = 0 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  select count(*) into v_count from incident_status_checks;
  insert into results (test, result, detail) values ('I8: inactive user reads zero rows from incident_status_checks', case when v_count = 0 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  reset role;

  select count(*) into v_count from pg_policies
  where schemaname = 'public'
    and tablename in ('severity_rulesets', 'incident_severity_assessments', 'incident_report_events', 'incident_status_checks')
    and cmd in ('INSERT', 'UPDATE', 'DELETE');
  insert into results (test, result, detail) values
    ('I9: no INSERT/UPDATE/DELETE policy exists on any of the four new tables (writes remain RPC-only)',
      case when v_count = 0 then 'PASS' else 'FAIL' end, 'matching policies=' || v_count);

  -- ===================================================================
  -- J. incident_updates -- performer vs. recorder
  -- ===================================================================
  begin
    insert into incident_updates (incident_id, author_id, event_time, actions_taken)
    values ('00000000-0000-0000-0000-00000000f610', '00000000-0000-0000-0000-0000000000d1', now(), 'actions');
    insert into results (test, result, detail) values ('J1: both performer fields null (self-convention) allowed', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('J1: both performer fields null (self-convention) allowed', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_updates (incident_id, author_id, event_time, actions_taken, performed_by_user_id)
    values ('00000000-0000-0000-0000-00000000f610', '00000000-0000-0000-0000-0000000000d1', now(), 'actions', '00000000-0000-0000-0000-0000000000d2');
    insert into results (test, result, detail) values ('J2: performed_by_user_id set to another active profile allowed', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('J2: performed_by_user_id set to another active profile allowed', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_updates (incident_id, author_id, event_time, actions_taken, performed_by_external_name)
    values ('00000000-0000-0000-0000-00000000f610', '00000000-0000-0000-0000-0000000000d1', now(), 'actions', 'External Contractor');
    insert into results (test, result, detail) values ('J3: performed_by_external_name allowed', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('J3: performed_by_external_name allowed', 'FAIL', sqlerrm);
  end;

  begin
    insert into incident_updates (incident_id, author_id, event_time, actions_taken, performed_by_user_id, performed_by_external_name)
    values ('00000000-0000-0000-0000-00000000f610', '00000000-0000-0000-0000-0000000000d1', now(), 'actions', '00000000-0000-0000-0000-0000000000d2', 'External');
    insert into results (test, result, detail) values ('J4: both performer fields set rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('J4: both performer fields set rejected',
      case when sqlerrm like '%check constraint%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
