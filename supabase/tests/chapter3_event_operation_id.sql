-- Tests for migrations 0025 (incident_events.operation_id: nullable column +
-- partial index) and 0026 (every event-writing RPC stamps one shared
-- operation_id per call, plus event-time propagation to update_incident's
-- and create_incident's secondary rows).
--
-- Covers: one operation_id shared across every row a single RPC call
-- inserts, for all 14 touched functions, including the two multi-incident
-- loop cases (create_handover, accept_handover) where the id is allocated
-- ONCE outside the loop; two separate calls producing two DIFFERENT ids;
-- event-time propagation for update_incident's six conditional rows and
-- create_incident's two conditional rows; every other RPC's rows sharing an
-- id without needing propagation (no eventTime input, or already
-- propagated by 0017/0020); a directly-inserted historical row keeping
-- operation_id = NULL and remaining fully readable; reject_mutation()
-- still blocking UPDATE/DELETE via the new column; RLS unaffected; and an
-- explicit expected-contract verification of ACL / SECURITY DEFINER / owner
-- / signature / search_path for all 14 functions -- confirming 0026 widened,
-- narrowed, or otherwise touched none of them, including the two that are
-- deliberately still unreachable by authenticated (add_incident_report,
-- set_incident_status_check).
--
-- The ACL/security-metadata section is NOT a live before/after diff: by the
-- time any test file runs, 0025/0026 are already part of the applied chain
-- (this suite runs after the full migration sequence, exactly like every
-- other suite in this directory), so there is no "before" state available
-- inside the test transaction itself. What it checks instead is a fixed
-- expected-contract matrix, derived by reading every grant/revoke/ownership
-- statement across 0003, 0005-0009, 0013, 0017, 0018, and 0024 in migration
-- order (the only files that ever touch these 14 functions' privileges or
-- ownership) and independently re-verified against a live PostgreSQL 16
-- instance with the full chain applied, checked against each function's
-- actual, currently active definition. 0026 itself contains no grant,
-- revoke, or ownership statement, so this expected matrix describes both
-- the pre-0026 and the post-0026 state -- 0026 was never expected to change
-- it, and this section confirms it did not.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000b1', 'admin@test', now()),
  ('00000000-0000-0000-0000-0000000000b2', 'tech-owner@test', now()),
  ('00000000-0000-0000-0000-0000000000b3', 'incoming-supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000b4', 'second-incoming@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000b1', 'Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000b2', 'Tech Owner', 'technician', true),
  ('00000000-0000-0000-0000-0000000000b3', 'Incoming Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000b4', 'Second Incoming', 'shift_supervisor', true);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000fa01', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000fa02', 'Loc', 1);

-- fa10: update_incident -- all six protected fields changed in one call,
-- plus a SECOND update_incident call afterwards to prove two calls on the
-- SAME incident still get two DIFFERENT operation_ids.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, reported_to_ops, version)
values ('00000000-0000-0000-0000-00000000fa10', 'T-g10',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'in_progress', 'impact v1',
        '00000000-0000-0000-0000-0000000000b2', now() - interval '5 days',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 'no', 1);

-- fa11: technician_update_incident, single event.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000fa11', 'T-g11',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000b2', now() - interval '2 days',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 1);

-- fa12: close_incident, FULL readiness branch (2 events: closed + reported_to_ops_change).
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, reported_to_ops, version)
values ('00000000-0000-0000-0000-00000000fa12', 'T-g12',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 'no', 1);

-- fa13: close_incident, PARTIAL readiness branch (2 events: status_change +
-- reported_to_ops_change), then complete_follow_up on the SAME incident
-- (proving a second, later operation on the same row gets its own id).
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, reported_to_ops, version)
values ('00000000-0000-0000-0000-00000000fa13', 'T-g13',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 'no', 1);

-- fa14: set_incident_status_check 'scheduled', then cancel_incident (2
-- events: cancelled + status_check_changed removal) -- also proves
-- set_incident_status_check's operation_id differs from cancel_incident's.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000fa14', 'T-g14',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 1);

-- fa15: assign_incident, single event.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000fa15', 'T-g15',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 1);

-- fa16: add_incident_report, single event.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000fa16', 'T-g16',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 1);

-- fa17: set_incident_status_check 'completed' + nextDueAt (2 NEW rows in
-- one call), after a prior 'scheduled' call to have a due date to complete.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000fa17', 'T-g17',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 1);

-- fa18/fa19: two open incidents used by create_handover (twice, to two
-- different recipients) and by accept_handover.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values
  ('00000000-0000-0000-0000-00000000fa18', 'T-g18',
    '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
    'desc', 'medium', 'in_progress', 'impact',
    '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day',
    '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
    now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000fa19', 'T-g19',
    '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
    'desc', 'medium', 'in_progress', 'impact',
    '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day',
    '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
    now() + interval '4 hours', 1);

-- fa20: closed already, for reopen_incident (single event).
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       root_cause, resolution, readiness_at_close, closed_at, closed_by,
                       no_deadline_reason, version)
values ('00000000-0000-0000-0000-00000000fa20', 'T-g20',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'closed', 'impact',
        '00000000-0000-0000-0000-0000000000b1', now() - interval '3 days',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        'root', 'resolution', 'full', now() - interval '1 hour', '00000000-0000-0000-0000-0000000000b1',
        'התקלה נסגרה', 1);

-- fa21: status = 'new', for acknowledge_incident (single event).
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000fa21', 'T-g21',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'new', 'impact',
        '00000000-0000-0000-0000-0000000000b1', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 1);

-- ===== Historical row, inserted directly, exactly as a pre-0025 row would
-- exist: no operation_id supplied at all. =====
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000fa22', 'T-g22',
        '00000000-0000-0000-0000-00000000fa01', '00000000-0000-0000-0000-00000000fa02',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000b1', now() - interval '10 days',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 1);
insert into incident_events (incident_id, type, actor_id, note)
values ('00000000-0000-0000-0000-00000000fa22', 'update', '00000000-0000-0000-0000-0000000000b1', 'רישום היסטורי');

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

-- Every call below runs as the connecting (table-owner) role with auth.uid()
-- spoofed via as_user(), exactly like chapter2_pr3_incident_rpcs.sql --
-- add_incident_report and set_incident_status_check remain callable this
-- way despite having no `authenticated` EXECUTE grant, since SECURITY
-- DEFINER functions run under their owner's privileges regardless of the
-- caller's own grants when invoked by the owning/superuser role directly.
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');

do $$
declare
  v_incident incidents;
  v_handover1 handovers;
  v_handover2 handovers;
  v_op_count int;
  v_distinct_ops int;
  v_op_a uuid;
  v_op_b uuid;
  v_bool boolean;
  v_op_update1 uuid;
  v_op_update2 uuid;
  v_op_scheduled uuid;
  v_op_cancel uuid;
  v_op_close uuid;
  v_op_followup uuid;
  v_op_report uuid;
  v_op_complete1 uuid;
  v_op_complete2 uuid;
  v_ops uuid[];
  v_row_count int;
begin
  -- =====================================================================
  -- 1. update_incident: all six protected fields changed in one call ->
  --    exactly 7 rows (1 'update' + 6 conditional) sharing ONE operation_id,
  --    and ALL 7 carrying the submitted (backdated) eventTime.
  -- =====================================================================
  v_incident := update_incident('00000000-0000-0000-0000-00000000fa10', jsonb_build_object(
    'expectedVersion', 1,
    'eventTime', (now() - interval '3 days')::text,
    'actionsTaken', 'בוצעה בדיקה', 'findings', '', 'nextSteps', '',
    'status', 'monitoring', 'severity', 'high',
    'operationalImpact', 'impact v2',
    'ownerUserId', '00000000-0000-0000-0000-0000000000b1', 'ownerExternalName', null,
    'nextUpdateDue', (now() + interval '6 hours')::text, 'noDeadlineReason', null,
    'reportedToOps', 'yes', 'reportedToOpsRecipient', 'יוסי מהמוקד'
  ));

  select count(*), count(distinct operation_id) into v_op_count, v_distinct_ops
  from incident_events where incident_id = '00000000-0000-0000-0000-00000000fa10';
  insert into results (test, result, detail) values
    ('update_incident (6 field changes): exactly 7 rows share exactly 1 operation_id',
      case when v_op_count = 7 and v_distinct_ops = 1 then 'PASS' else 'FAIL' end,
      'rows=' || v_op_count || ' distinct_ops=' || v_distinct_ops);

  select count(*) into v_row_count from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa10'
    and event_time <> (now() - interval '3 days');
  insert into results (test, result, detail) values
    ('update_incident: all 7 rows (not just the update row) carry the submitted backdated eventTime',
      case when v_row_count = 0 then 'PASS' else 'FAIL' end, 'mismatched_rows=' || v_row_count);

  select operation_id into v_op_update1 from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa10' and type = 'update';

  -- Second call on the SAME incident: a further, later operation must get a
  -- DIFFERENT operation_id from the first.
  v_incident := update_incident('00000000-0000-0000-0000-00000000fa10', jsonb_build_object(
    'expectedVersion', v_incident.version,
    'eventTime', now()::text,
    'actionsTaken', 'המשך בדיקה', 'findings', '', 'nextSteps', '',
    'status', 'waiting_test', 'severity', 'high',
    'operationalImpact', 'impact v2',
    'ownerUserId', '00000000-0000-0000-0000-0000000000b1', 'ownerExternalName', null,
    'nextUpdateDue', (now() + interval '6 hours')::text, 'noDeadlineReason', null,
    'reportedToOps', 'yes', 'reportedToOpsRecipient', 'יוסי מהמוקד'
  ));
  select operation_id into v_op_update2 from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa10' and type = 'update'
    and operation_id <> v_op_update1;
  insert into results (test, result, detail) values
    ('two separate update_incident calls on the same incident get two DIFFERENT operation_ids',
      case when v_op_update1 is not null and v_op_update2 is not null and v_op_update1 <> v_op_update2
        then 'PASS' else 'FAIL' end,
      'op1=' || v_op_update1 || ' op2=' || v_op_update2);

  -- =====================================================================
  -- 2. technician_update_incident: single event, still stamped.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
  perform technician_update_incident('00000000-0000-0000-0000-00000000fa11', jsonb_build_object(
    'expectedVersion', 1, 'eventTime', now()::text,
    'actionsTaken', 'בדיקה טכנית', 'findings', '', 'nextSteps', ''
  ));
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  select operation_id is not null into v_bool from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa11' and type = 'update';
  insert into results (test, result, detail) values
    ('technician_update_incident: single event still gets a non-null operation_id',
      case when v_bool then 'PASS' else 'FAIL' end, '');

  -- =====================================================================
  -- 3. create_incident: backdated discoveredAt -> 3 rows (created,
  --    status_change since status <> 'new', reported_to_ops_change) all
  --    sharing one operation_id, and the two conditional rows carrying
  --    discoveredAt (not now()).
  -- =====================================================================
  v_incident := create_incident(jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000fa01',
    'locationId', '00000000-0000-0000-0000-00000000fa02',
    'discoveredAt', (now() - interval '10 hours')::text,
    'description', 'תקלה חדשה',
    'severity', 'high',
    'operationalImpact', 'השפעה',
    'actionsTaken', 'נבדק',
    'status', 'in_progress',
    'ownerUserId', '00000000-0000-0000-0000-0000000000b1', 'ownerExternalName', null,
    'nextUpdateDue', (now() + interval '4 hours')::text, 'noDeadlineReason', null,
    'reportedToOps', 'yes', 'reportedToOpsRecipient', 'יוסי מהמוקד',
    'reportedToComms', false, 'reportedToCommsRecipient', null,
    'wisdomReported', false, 'wisdomIncidentNumber', null
  ));
  select count(*), count(distinct operation_id) into v_op_count, v_distinct_ops
  from incident_events where incident_id = v_incident.id;
  insert into results (test, result, detail) values
    ('create_incident (opens non-new + reported): exactly 3 rows share exactly 1 operation_id',
      case when v_op_count = 3 and v_distinct_ops = 1 then 'PASS' else 'FAIL' end,
      'rows=' || v_op_count || ' distinct_ops=' || v_distinct_ops);
  select count(*) into v_row_count from incident_events
  where incident_id = v_incident.id and event_time <> v_incident.discovered_at;
  insert into results (test, result, detail) values
    ('create_incident: all 3 rows carry discovered_at as their event_time',
      case when v_row_count = 0 then 'PASS' else 'FAIL' end, 'mismatched_rows=' || v_row_count);

  -- =====================================================================
  -- 4. close_incident, FULL readiness: 2 rows (closed + reported_to_ops_change)
  --    share one operation_id.
  -- =====================================================================
  perform close_incident('00000000-0000-0000-0000-00000000fa12', jsonb_build_object(
    'expectedVersion', 1, 'rootCause', 'תקלת חומרה', 'resolution', 'הוחלף רכיב',
    'readiness', 'full', 'followUpNotes', '',
    'reportedToOps', 'yes', 'reportedToOpsRecipient', 'יוסי מהמוקד'
  ));
  select count(*), count(distinct operation_id) into v_op_count, v_distinct_ops
  from incident_events where incident_id = '00000000-0000-0000-0000-00000000fa12';
  insert into results (test, result, detail) values
    ('close_incident (full readiness, reporting changed): 2 rows share 1 operation_id',
      case when v_op_count = 2 and v_distinct_ops = 1 then 'PASS' else 'FAIL' end,
      'rows=' || v_op_count || ' distinct_ops=' || v_distinct_ops);

  -- =====================================================================
  -- 5. close_incident, PARTIAL readiness: 2 rows share 1 operation_id, then
  --    complete_follow_up on the SAME incident gets its OWN, different id.
  -- =====================================================================
  perform close_incident('00000000-0000-0000-0000-00000000fa13', jsonb_build_object(
    'expectedVersion', 1, 'rootCause', 'תקלת חומרה', 'resolution', 'תוקן חלקית',
    'readiness', 'partial', 'followUpNotes', 'יש להשלים בדיקה נוספת',
    'ownerUserId', '00000000-0000-0000-0000-0000000000b2', 'ownerExternalName', null,
    'reportedToOps', 'yes', 'reportedToOpsRecipient', 'יוסי מהמוקד'
  ));
  select count(*), count(distinct operation_id) into v_op_count, v_distinct_ops
  from incident_events where incident_id = '00000000-0000-0000-0000-00000000fa13';
  insert into results (test, result, detail) values
    ('close_incident (partial readiness, reporting changed): 2 rows share 1 operation_id',
      case when v_op_count = 2 and v_distinct_ops = 1 then 'PASS' else 'FAIL' end,
      'rows=' || v_op_count || ' distinct_ops=' || v_distinct_ops);
  select operation_id into v_op_close from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa13' and type = 'status_change';

  perform complete_follow_up('00000000-0000-0000-0000-00000000fa13', 'הבדיקה הנוספת בוצעה');
  select operation_id into v_op_followup from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa13' and type = 'follow_up_completed';
  insert into results (test, result, detail) values
    ('complete_follow_up gets a non-null operation_id DIFFERENT from the earlier close_incident call',
      case when v_op_followup is not null and v_op_followup <> v_op_close then 'PASS' else 'FAIL' end,
      'close_op=' || v_op_close || ' followup_op=' || v_op_followup);

  -- =====================================================================
  -- 6. set_incident_status_check 'scheduled', then cancel_incident: 2
  --    events (cancelled + status_check_changed removal) share 1
  --    operation_id, DIFFERENT from the scheduling call's own id.
  -- =====================================================================
  perform set_incident_status_check('00000000-0000-0000-0000-00000000fa14', jsonb_build_object(
    'expectedVersion', 1, 'kind', 'scheduled', 'eventTime', now()::text,
    'dueAt', (now() + interval '2 hours')::text
  ));
  select operation_id into v_op_scheduled from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa14' and type = 'status_check_changed';

  perform cancel_incident('00000000-0000-0000-0000-00000000fa14', jsonb_build_object(
    'expectedVersion', 2, 'eventTime', now()::text, 'cancellationReason', 'נפתחה בטעות'
  ));
  select count(*), count(distinct operation_id) into v_op_count, v_distinct_ops
  from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa14' and type in ('cancelled', 'status_check_changed')
    and operation_id <> v_op_scheduled;
  insert into results (test, result, detail) values
    ('cancel_incident (with a pending status check to remove): 2 new rows share 1 operation_id, distinct from set_incident_status_check''s',
      case when v_op_count = 2 and v_distinct_ops = 1 then 'PASS' else 'FAIL' end,
      'rows=' || v_op_count || ' distinct_ops=' || v_distinct_ops);

  select operation_id into v_op_cancel from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa14' and type = 'cancelled';
  select count(*) into v_row_count from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa14' and type in ('cancelled', 'status_check_changed')
    and operation_id <> v_op_cancel and type = 'cancelled';
  -- (already asserted distinctness above; this block intentionally left
  -- without an extra insert to avoid a redundant result row)

  -- =====================================================================
  -- 7. assign_incident: single event.
  -- =====================================================================
  perform assign_incident('00000000-0000-0000-0000-00000000fa15', jsonb_build_object(
    'expectedVersion', 1, 'ownerUserId', '00000000-0000-0000-0000-0000000000b2', 'ownerExternalName', null, 'note', ''
  ));
  select operation_id is not null into v_bool from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa15' and type = 'assignment_change';
  insert into results (test, result, detail) values
    ('assign_incident: single event gets a non-null operation_id',
      case when v_bool then 'PASS' else 'FAIL' end, '');

  -- =====================================================================
  -- 8. add_incident_report: single event.
  -- =====================================================================
  perform add_incident_report('00000000-0000-0000-0000-00000000fa16', jsonb_build_object(
    'expectedVersion', 1, 'eventTime', now()::text, 'channel', 'ops_communications', 'status', 'no'
  ));
  select operation_id is not null into v_bool from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa16' and type = 'reported_to_ops_communications';
  insert into results (test, result, detail) values
    ('add_incident_report: single event gets a non-null operation_id',
      case when v_bool then 'PASS' else 'FAIL' end, '');

  -- =====================================================================
  -- 9. set_incident_status_check 'completed' + nextDueAt: exactly 2 NEW
  --    rows in one call share one operation_id, distinct from the prior
  --    'scheduled' call.
  -- =====================================================================
  perform set_incident_status_check('00000000-0000-0000-0000-00000000fa17', jsonb_build_object(
    'expectedVersion', 1, 'kind', 'scheduled', 'eventTime', now()::text,
    'dueAt', (now() + interval '2 hours')::text
  ));
  select array_agg(operation_id) into v_ops from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa17';

  perform set_incident_status_check('00000000-0000-0000-0000-00000000fa17', jsonb_build_object(
    'expectedVersion', 2, 'kind', 'completed', 'eventTime', now()::text,
    'nextDueAt', (now() + interval '1 day')::text,
    'performedByUserId', '00000000-0000-0000-0000-0000000000b1'
  ));
  select count(*), count(distinct operation_id) into v_op_count, v_distinct_ops
  from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa17' and not (operation_id = any(v_ops));
  insert into results (test, result, detail) values
    ('set_incident_status_check (completed + nextDueAt): exactly 2 new rows share exactly 1 operation_id',
      case when v_op_count = 2 and v_distinct_ops = 1 then 'PASS' else 'FAIL' end,
      'rows=' || v_op_count || ' distinct_ops=' || v_distinct_ops);

  -- =====================================================================
  -- 10. create_handover: id allocated ONCE, shared across BOTH included
  --     incidents' event rows in a single call; a SECOND call gets a
  --     DIFFERENT id.
  -- =====================================================================
  v_handover1 := create_handover(jsonb_build_object(
    'toUserId', '00000000-0000-0000-0000-0000000000b3', 'generalNote', '', 'itemNotes', '{}'::jsonb
  ));
  select count(*), count(distinct operation_id) into v_op_count, v_distinct_ops
  from incident_events
  where type = 'handover_included' and incident_id in
    ('00000000-0000-0000-0000-00000000fa18', '00000000-0000-0000-0000-00000000fa19');
  insert into results (test, result, detail) values
    ('create_handover: handover_included rows for BOTH incidents share exactly 1 operation_id',
      case when v_op_count = 2 and v_distinct_ops = 1 then 'PASS' else 'FAIL' end,
      'rows=' || v_op_count || ' distinct_ops=' || v_distinct_ops);
  select operation_id into v_op_a from incident_events
  where type = 'handover_included' and incident_id = '00000000-0000-0000-0000-00000000fa18' limit 1;

  v_handover2 := create_handover(jsonb_build_object(
    'toUserId', '00000000-0000-0000-0000-0000000000b4', 'generalNote', '', 'itemNotes', '{}'::jsonb
  ));
  select operation_id into v_op_b from incident_events
  where type = 'handover_included' and incident_id = '00000000-0000-0000-0000-00000000fa18'
    and ref_id = v_handover2.id;
  insert into results (test, result, detail) values
    ('a second, separate create_handover call gets a DIFFERENT operation_id from the first',
      case when v_op_a is not null and v_op_b is not null and v_op_a <> v_op_b then 'PASS' else 'FAIL' end,
      'first=' || v_op_a || ' second=' || v_op_b);

  -- =====================================================================
  -- 11. accept_handover: id allocated ONCE, shared across every incident in
  --     the loop, distinct from create_handover's own id.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b3');
  perform accept_handover(v_handover1.id);
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  select count(*), count(distinct operation_id) into v_op_count, v_distinct_ops
  from incident_events
  where type = 'handover_accepted' and incident_id in
    ('00000000-0000-0000-0000-00000000fa18', '00000000-0000-0000-0000-00000000fa19');
  insert into results (test, result, detail) values
    ('accept_handover: handover_accepted rows for BOTH incidents share exactly 1 operation_id, distinct from creation',
      case when v_op_count = 2 and v_distinct_ops = 1 and not (v_op_a = any(array(
        select operation_id from incident_events where type = 'handover_accepted'
        and incident_id = '00000000-0000-0000-0000-00000000fa18')))
      then 'PASS' else 'FAIL' end, 'rows=' || v_op_count || ' distinct_ops=' || v_distinct_ops);

  -- =====================================================================
  -- 12. reopen_incident: single event.
  -- =====================================================================
  perform reopen_incident('00000000-0000-0000-0000-00000000fa20', jsonb_build_object(
    'expectedVersion', 1, 'reason', 'התקלה חזרה', 'nextUpdateDue', (now() + interval '2 hours')::text,
    'ownerUserId', '00000000-0000-0000-0000-0000000000b1', 'ownerExternalName', null
  ));
  select operation_id is not null into v_bool from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa20' and type = 'reopened';
  insert into results (test, result, detail) values
    ('reopen_incident: single event gets a non-null operation_id',
      case when v_bool then 'PASS' else 'FAIL' end, '');

  -- =====================================================================
  -- 13. acknowledge_incident: single event.
  -- =====================================================================
  perform acknowledge_incident('00000000-0000-0000-0000-00000000fa21', 1);
  select operation_id is not null into v_bool from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa21' and type = 'acknowledged';
  insert into results (test, result, detail) values
    ('acknowledge_incident: single event gets a non-null operation_id',
      case when v_bool then 'PASS' else 'FAIL' end, '');

  -- =====================================================================
  -- 14. add_incident_correction: single event, referencing an earlier row.
  -- =====================================================================
  perform add_incident_correction('00000000-0000-0000-0000-00000000fa15', jsonb_build_object(
    'refId', (select id from incident_events where incident_id = '00000000-0000-0000-0000-00000000fa15' and type = 'assignment_change'),
    'text', 'תיקון לרישום הקודם'
  ));
  select operation_id is not null into v_bool from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa15' and type = 'correction';
  insert into results (test, result, detail) values
    ('add_incident_correction: single event gets a non-null operation_id',
      case when v_bool then 'PASS' else 'FAIL' end, '');

  -- =====================================================================
  -- 15. A directly-inserted historical row (fa22, no operation_id column
  --     supplied at all, mimicking any pre-0025 row) reads back with
  --     operation_id NULL and every other column intact.
  -- =====================================================================
  insert into results (test, result, detail)
  select 'historical event row: operation_id is NULL and the row remains fully readable',
    case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
  from incident_events
  where incident_id = '00000000-0000-0000-0000-00000000fa22'
    and type = 'update' and note = 'רישום היסטורי' and operation_id is null and actor_id is not null;

  -- =====================================================================
  -- 16. reject_mutation() still blocks UPDATE on incident_events even when
  --     only operation_id is targeted -- the new column is not a carve-out.
  -- =====================================================================
  begin
    update incident_events set operation_id = gen_random_uuid()
    where incident_id = '00000000-0000-0000-0000-00000000fa22';
    insert into results (test, result, detail) values
      ('reject_mutation() still blocks UPDATE of operation_id on an existing row', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('reject_mutation() still blocks UPDATE of operation_id on an existing row',
        case when sqlerrm = 'append_only: incident_events rows cannot be modified or deleted' then 'PASS' else 'FAIL' end,
        sqlerrm);
  end;
end $$;

-- =====================================================================
-- 17. RLS unaffected: an inactive member still reads zero incident_events
--     rows (same policy, same predicate, new column changes nothing).
-- =====================================================================
do $$
declare
  v_count int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    ('00000000-0000-0000-0000-0000000000b9', 'inactive@test', now());
  insert into profiles (id, full_name, role, active) values
    ('00000000-0000-0000-0000-0000000000b9', 'Inactive', 'technician', false);

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b9');
  set local role authenticated;
  select count(*) into v_count from incident_events where incident_id = '00000000-0000-0000-0000-00000000fa10';
  reset role;
  insert into results (test, result, detail) values
    ('RLS: an inactive member still reads zero incident_events rows',
      case when v_count = 0 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');

-- =====================================================================
-- 18. Expected-contract verification of ACL / SECURITY DEFINER / owner /
--     signature / search_path, for all 14 functions this migration's 0026
--     half touches. This is NOT a before/after diff (see this file's own
--     header) -- it checks each function's actual, currently active
--     definition against a fixed expected matrix derived from the complete
--     grant/revoke/ownership history (0003, 0005-0009, 0013, 0017, 0018,
--     0024) and from each function's own `create or replace function`
--     header (search_path/SECURITY DEFINER are restated there, not
--     automatically carried over -- see 0026's own header for why).
-- =====================================================================
create temp table expected_rpc_metadata (
  proname text primary key,
  identity_args text,
  search_path text,
  authenticated_execute boolean
);
insert into expected_rpc_metadata (proname, identity_args, search_path, authenticated_execute) values
  ('create_incident',              'p_input jsonb',                                  'public', true),
  ('update_incident',              'p_incident_id uuid, p_input jsonb',               'public', true),
  ('technician_update_incident',   'p_incident_id uuid, p_input jsonb',               'public', true),
  ('close_incident',               'p_incident_id uuid, p_input jsonb',               'public', true),
  ('cancel_incident',              'p_incident_id uuid, p_input jsonb',               '',       true),
  ('assign_incident',              'p_incident_id uuid, p_input jsonb',               'public', true),
  ('complete_follow_up',           'p_incident_id uuid, p_note text',                 'public', true),
  ('add_incident_report',          'p_incident_id uuid, p_input jsonb',               '',       false),
  ('set_incident_status_check',    'p_incident_id uuid, p_input jsonb',               '',       false),
  ('create_handover',              'p_input jsonb',                                  'public', true),
  ('reopen_incident',              'p_incident_id uuid, p_input jsonb',               'public', true),
  ('acknowledge_incident',         'p_incident_id uuid, p_expected_version integer',  'public', true),
  ('add_incident_correction',      'p_incident_id uuid, p_input jsonb',               'public', true),
  ('accept_handover',              'p_handover_id uuid',                             'public', true);

-- Signature: the same name and argument list as before means CREATE OR
-- REPLACE updated the same catalog row rather than creating a new function
-- (see below) -- checked here against the expected contract, not against a
-- live "before" capture.
insert into results (test, result, detail)
select 'signature matches expected contract: ' || e.proname,
  case when p.proname is not null and pg_get_function_identity_arguments(p.oid) = e.identity_args
    then 'PASS' else 'FAIL' end,
  coalesce(pg_get_function_identity_arguments(p.oid), '<missing>') || ' vs expected ' || e.identity_args
from expected_rpc_metadata e
left join pg_proc p on p.proname = e.proname
  and p.pronamespace = (select oid from pg_namespace where nspname = 'public');

-- SECURITY DEFINER is NOT automatically carried over by CREATE OR REPLACE --
-- it is restated in every function body in 0026 (see that migration's own
-- header). This checks the restatement actually took effect.
insert into results (test, result, detail)
select 'SECURITY DEFINER matches expected contract: ' || e.proname,
  case when p.prosecdef then 'PASS' else 'FAIL' end, 'prosecdef=' || coalesce(p.prosecdef::text, '<missing>')
from expected_rpc_metadata e
join pg_proc p on p.proname = e.proname
  and p.pronamespace = (select oid from pg_namespace where nspname = 'public');

-- Owner: CREATE OR REPLACE FUNCTION updates the same catalog row and never
-- reassigns ownership on its own, and no ALTER OWNER statement appears
-- anywhere in 0026, so every function's owner is expected to still equal
-- the CURRENT session's own role -- the role that ran every migration in
-- this suite, including 0026 -- with no hardcoded role name. Checked here
-- against that expectation, not derived from a captured "before" value.
insert into results (test, result, detail)
select 'owner matches expected contract (still the migration-applying role): ' || e.proname,
  case when p.proowner = (select oid from pg_roles where rolname = current_user) then 'PASS' else 'FAIL' end,
  'owner=' || p.proowner::regrole::text || ' current_user=' || current_user
from expected_rpc_metadata e
join pg_proc p on p.proname = e.proname
  and p.pronamespace = (select oid from pg_namespace where nspname = 'public');

-- search_path is NOT automatically carried over by CREATE OR REPLACE either
-- -- like SECURITY DEFINER, it is restated in every function body in 0026.
-- This checks the restatement matches each function's expected value.
insert into results (test, result, detail)
select 'search_path matches expected contract: ' || e.proname,
  case when coalesce(
    (select split_part(cfg, '=', 2) from unnest(p.proconfig) cfg where cfg like 'search_path=%'),
    ''
  ) = case when e.search_path = '' then '""' else e.search_path end
  then 'PASS' else 'FAIL' end,
  'actual=' || coalesce(array_to_string(p.proconfig, ','), '<none>') || ' expected search_path=' || e.search_path
from expected_rpc_metadata e
join pg_proc p on p.proname = e.proname
  and p.pronamespace = (select oid from pg_namespace where nspname = 'public');

insert into results (test, result, detail)
select 'authenticated EXECUTE matches expected (' || e.authenticated_execute || '): ' || e.proname,
  case when exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  ) = e.authenticated_execute then 'PASS' else 'FAIL' end,
  ''
from expected_rpc_metadata e
join pg_proc p on p.proname = e.proname
  and p.pronamespace = (select oid from pg_namespace where nspname = 'public');

insert into results (test, result, detail)
select 'no PUBLIC or anon EXECUTE (per expected contract): ' || e.proname,
  case when not exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where (a.grantee = 0 or a.grantee = 'anon'::regrole) and a.privilege_type = 'EXECUTE'
  ) then 'PASS' else 'FAIL' end,
  ''
from expected_rpc_metadata e
join pg_proc p on p.proname = e.proname
  and p.pronamespace = (select oid from pg_namespace where nspname = 'public');

-- =====================================================================
-- 19. Schema-level checks for 0025 itself: nullable column, partial index.
-- =====================================================================
insert into results (test, result, detail)
select 'incident_events.operation_id is nullable (no NOT NULL constraint added)',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_attribute a
join pg_class c on c.oid = a.attrelid
where c.relname = 'incident_events' and a.attname = 'operation_id' and a.attnotnull;

insert into results (test, result, detail)
select 'idx_incident_events_operation exists as a partial index (operation_id is not null)',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from pg_indexes
where tablename = 'incident_events' and indexname = 'idx_incident_events_operation'
  and indexdef like '%WHERE (operation_id IS NOT NULL)%';

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
