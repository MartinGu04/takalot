-- Tests for migrations 0045-0047 (AVARIA structured incident lifecycle
-- classification): the new enums/tables, the versioned-RPC rollout
-- (create_incident/close_incident staying permissive forever vs.
-- create_incident_v2/close_incident_v2 always-enforcing), partial-vs-legacy
-- payload handling on the legacy entry point, resolution-attribution count
-- rules, the resolved_without_action -> no_action_taken same-table CHECK,
-- reopen's current_suspected_cause reset, event_time NULL-ness for
-- creation-time rows vs. populated for update/close-time rows, and the
-- create_incident_v2/close_incident_v2 grant matrix.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'admin-e1@test', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'tech-owner-e2@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Admin E1', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000e2', 'Tech Owner E2', 'technician', true);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000e401', 'Sys E', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000e402', 'Loc E', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

do $$
declare
  v_incident incidents;
  v_incident2 incidents;
  v_closed incidents;
  v_reopened incident_status;
  v_closure_count int;
  v_action_count int;
  v_assessment_count int;
  v_event_time timestamptz;
  v_action1_id uuid;
  v_action2_id uuid;
  v_closure_id uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');

  -- =====================================================================
  -- 1. create_incident (legacy, permissive) succeeds with NO reportedDomain
  --    at all -- a still-cached old client keeps working unchanged.
  -- =====================================================================
  begin
    v_incident := create_incident(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000e401', 'locationId', '00000000-0000-0000-0000-00000000e402',
      'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
      'discoveredAt', now(), 'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values
      ('create_incident (legacy) succeeds with reportedDomain omitted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('create_incident (legacy) succeeds with reportedDomain omitted', 'FAIL', sqlerrm);
  end;
  insert into results (test, result, detail) values
    ('create_incident (legacy): reported_domain stays NULL, not defaulted', 'FAIL', 'no incident row');
  update results set result = case when v_incident.reported_domain is null then 'PASS' else 'FAIL' end,
    detail = coalesce(v_incident.reported_domain::text, 'null')
    where test = 'create_incident (legacy): reported_domain stays NULL, not defaulted';

  -- =====================================================================
  -- 2. create_incident_v2 (always-enforcing) REJECTS the same omission.
  -- =====================================================================
  begin
    perform create_incident_v2(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000e401', 'locationId', '00000000-0000-0000-0000-00000000e402',
      'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
      'discoveredAt', now(), 'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values
      ('create_incident_v2 rejects reportedDomain omitted', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('create_incident_v2 rejects reportedDomain omitted',
        case when sqlerrm like 'validation:%תחום תקלה%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 3. create_incident_v2 succeeds with reportedDomain + an initial
  --    suspected cause + duplicate initial treatment actions, deduped
  --    within this one call; no dedicated cause_assessment_changed event
  --    is written for the initial assessment, and its event_time is NULL.
  -- =====================================================================
  begin
    v_incident2 := create_incident_v2(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000e401', 'locationId', '00000000-0000-0000-0000-00000000e402',
      'description', 'd2', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
      'discoveredAt', now(), 'reportedToOps', 'not_required',
      'reportedDomain', 'equipment', 'initialSuspectedCause', 'equipment',
      'initialTreatmentActions', jsonb_build_array(
        jsonb_build_object('actionType', 'diagnosis'),
        jsonb_build_object('actionType', 'diagnosis'),
        jsonb_build_object('actionType', 'reset_restart'))));
    insert into results (test, result, detail) values
      ('create_incident_v2 succeeds with reportedDomain supplied', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('create_incident_v2 succeeds with reportedDomain supplied', 'FAIL', sqlerrm);
  end;
  insert into results (test, result, detail) select
    'create_incident_v2: reported_domain persisted', case when v_incident2.reported_domain = 'equipment' then 'PASS' else 'FAIL' end,
    coalesce(v_incident2.reported_domain::text, 'null');
  insert into results (test, result, detail) select
    'create_incident_v2: current_suspected_cause set from initialSuspectedCause',
    case when v_incident2.current_suspected_cause = 'equipment' then 'PASS' else 'FAIL' end,
    coalesce(v_incident2.current_suspected_cause::text, 'null');

  select count(*) into v_action_count from incident_treatment_actions where incident_id = v_incident2.id;
  insert into results (test, result, detail) select
    'create_incident_v2: initialTreatmentActions deduped within one call (3 submitted, 2 distinct)',
    case when v_action_count = 2 then 'PASS' else 'FAIL' end, 'count=' || v_action_count;

  select count(*) into v_action_count from incident_treatment_actions
    where incident_id = v_incident2.id and event_time is null;
  insert into results (test, result, detail) select
    'create_incident_v2: creation-time treatment actions have event_time IS NULL', case when v_action_count = 2 then 'PASS' else 'FAIL' end,
    'null_event_time_count=' || v_action_count;

  select count(*) into v_assessment_count from incident_cause_assessments where incident_id = v_incident2.id;
  insert into results (test, result, detail) select
    'create_incident_v2: exactly one initial cause-assessment row written', case when v_assessment_count = 1 then 'PASS' else 'FAIL' end,
    'count=' || v_assessment_count;

  select count(*) into v_assessment_count from incident_cause_assessments
    where incident_id = v_incident2.id and event_time is null;
  insert into results (test, result, detail) select
    'create_incident_v2: initial cause-assessment event_time IS NULL', case when v_assessment_count = 1 then 'PASS' else 'FAIL' end,
    'null_event_time_count=' || v_assessment_count;

  select count(*) into v_assessment_count from incident_events
    where incident_id = v_incident2.id and type = 'cause_assessment_changed';
  insert into results (test, result, detail) select
    'create_incident_v2: NO dedicated cause_assessment_changed event for the initial assessment',
    case when v_assessment_count = 0 then 'PASS' else 'FAIL' end, 'count=' || v_assessment_count;

  -- =====================================================================
  -- 4. update_incident: a genuine suspected-cause change writes a history
  --    row + a cause_assessment_changed event with a real, non-NULL
  --    event_time; resubmitting the SAME value writes neither.
  -- =====================================================================
  declare
    v_before_events int;
    v_before_assessments int;
    v_after_events int;
    v_after_assessments int;
  begin
    select count(*) into v_before_events from incident_events where incident_id = v_incident2.id and type = 'cause_assessment_changed';
    select count(*) into v_before_assessments from incident_cause_assessments where incident_id = v_incident2.id;
    perform update_incident(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'actionsTaken', 'x',
      'status', 'in_progress', 'severity', 'low', 'operationalImpact', 'i',
      'ownerUserId', '00000000-0000-0000-0000-0000000000e2', 'reportedToOps', 'not_required',
      'suspectedCause', 'software'));
    select count(*) into v_after_events from incident_events where incident_id = v_incident2.id and type = 'cause_assessment_changed';
    select count(*) into v_after_assessments from incident_cause_assessments where incident_id = v_incident2.id;
    insert into results (test, result, detail) values
      ('update_incident: genuine cause change writes one cause_assessment_changed event',
        case when v_after_events = v_before_events + 1 then 'PASS' else 'FAIL' end,
        'before=' || v_before_events || ' after=' || v_after_events);
    insert into results (test, result, detail) values
      ('update_incident: genuine cause change writes one incident_cause_assessments row',
        case when v_after_assessments = v_before_assessments + 1 then 'PASS' else 'FAIL' end,
        'before=' || v_before_assessments || ' after=' || v_after_assessments);
  end;
  select event_time into v_event_time from incident_cause_assessments
    where incident_id = v_incident2.id and event_time is not null limit 1;
  insert into results (test, result, detail) select
    'update_incident: the change-driven cause-assessment row has a non-NULL event_time',
    case when v_event_time is not null then 'PASS' else 'FAIL' end, coalesce(v_event_time::text, 'null');

  select * into v_incident2 from incidents where id = v_incident2.id;
  declare
    v_before_events2 int;
    v_after_events2 int;
  begin
    select count(*) into v_before_events2 from incident_events where incident_id = v_incident2.id and type = 'cause_assessment_changed';
    perform update_incident(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'actionsTaken', 'x',
      'status', 'in_progress', 'severity', 'low', 'operationalImpact', 'i',
      'ownerUserId', '00000000-0000-0000-0000-0000000000e2', 'reportedToOps', 'not_required',
      'suspectedCause', 'software'));
    select count(*) into v_after_events2 from incident_events where incident_id = v_incident2.id and type = 'cause_assessment_changed';
    insert into results (test, result, detail) values
      ('update_incident: resubmitting the SAME suspected cause writes no new event',
        case when v_after_events2 = v_before_events2 then 'PASS' else 'FAIL' end,
        'before=' || v_before_events2 || ' after=' || v_after_events2);
  end;
  select * into v_incident2 from incidents where id = v_incident2.id;

  -- =====================================================================
  -- 5. close_incident (legacy): a genuinely legacy-shaped payload (no
  --    classification keys at all) still succeeds, writes NO
  --    incident_closures row.
  -- =====================================================================
  begin
    v_closed := close_incident(v_incident.id, jsonb_build_object(
      'expectedVersion', v_incident.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values
      ('close_incident (legacy) succeeds with classification entirely omitted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (legacy) succeeds with classification entirely omitted', 'FAIL', sqlerrm);
  end;
  select count(*) into v_closure_count from incident_closures where incident_id = v_incident.id;
  insert into results (test, result, detail) select
    'close_incident (legacy): no incident_closures row written for a legacy-shaped payload',
    case when v_closure_count = 0 then 'PASS' else 'FAIL' end, 'count=' || v_closure_count;

  -- =====================================================================
  -- 6. close_incident (legacy): a PARTIALLY-shaped payload (one of the
  --    three core keys present) is rejected -- distinct from the
  --    fully-absent case above -- and nothing is written; the incident
  --    stays open.
  -- =====================================================================
  begin
    v_incident2 := create_incident(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000e401', 'locationId', '00000000-0000-0000-0000-00000000e402',
      'description', 'd3', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
      'discoveredAt', now(), 'reportedToOps', 'not_required'));
  end;
  begin
    perform close_incident(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'equipment'));
    insert into results (test, result, detail) values
      ('close_incident (legacy) rejects a partially-shaped classification payload', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (legacy) rejects a partially-shaped classification payload',
        case when sqlerrm like 'validation:%סיווג סגירה מלא או להשמיטו לחלוטין%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  select status into v_reopened from incidents where id = v_incident2.id;
  insert into results (test, result, detail) select
    'close_incident (legacy): a rejected partial payload leaves the incident open (atomic rollback)',
    case when v_reopened = 'in_progress' then 'PASS' else 'FAIL' end, v_reopened::text;

  -- =====================================================================
  -- 7. close_incident_v2 REJECTS the classification-omitted case that the
  --    legacy entry point (step 5) accepted.
  -- =====================================================================
  begin
    perform close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values
      ('close_incident_v2 rejects classification omitted entirely', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident_v2 rejects classification omitted entirely',
        case when sqlerrm like 'validation:%סיווג סגירה מלא%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 8. close_incident_v2 succeeds with a full classification cluster,
  --    resolution_attribution = specific_action linked to exactly one
  --    action recorded inline via newTreatmentActions; incident_closures
  --    gets the SAME operation_id as the 'closed' event.
  -- =====================================================================
  begin
    v_closed := close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'equipment', 'treatmentOutcome', 'permanent_resolution',
      'resolutionAttribution', 'specific_action',
      'newTreatmentActions', jsonb_build_array(jsonb_build_object('actionType', 'equipment_replacement'))));
    insert into results (test, result, detail) values
      ('close_incident_v2 succeeds with a full classification + one inline action for specific_action', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident_v2 succeeds with a full classification + one inline action for specific_action', 'FAIL', sqlerrm);
  end;
  select count(*) into v_closure_count from incident_closures where incident_id = v_incident2.id;
  insert into results (test, result, detail) select
    'close_incident_v2: exactly one incident_closures row written', case when v_closure_count = 1 then 'PASS' else 'FAIL' end,
    'count=' || v_closure_count;

  select ic.operation_id, ie.operation_id into v_closure_id, v_action1_id
  from incident_closures ic
  join incident_events ie on ie.incident_id = ic.incident_id and ie.type = 'closed' and ie.ref_id = ic.id
  where ic.incident_id = v_incident2.id;
  insert into results (test, result, detail) select
    'close_incident_v2: incident_closures.operation_id matches the ''closed'' event''s operation_id (same unit)',
    case when v_closure_id = v_action1_id then 'PASS' else 'FAIL' end,
    'closure_op=' || v_closure_id || ' event_op=' || v_action1_id;

  -- =====================================================================
  -- 9. Resolution-attribution count rules, tested directly against
  --    close_incident_v2 on fresh incidents each time.
  -- =====================================================================
  -- 9a. specific_action with ZERO linked actions -> rejected.
  begin
    v_incident2 := create_incident(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000e401', 'locationId', '00000000-0000-0000-0000-00000000e402',
      'description', 'd4', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
      'discoveredAt', now(), 'reportedToOps', 'not_required'));
  end;
  begin
    perform close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'equipment', 'treatmentOutcome', 'permanent_resolution',
      'resolutionAttribution', 'specific_action'));
    insert into results (test, result, detail) values
      ('specific_action with zero linked actions is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('specific_action with zero linked actions is rejected',
        case when sqlerrm like 'validation:%פעולה מסוימת אחת בדיוק%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 9b. specific_action with TWO linked actions -> rejected (must be exactly one).
  begin
    perform close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'equipment', 'treatmentOutcome', 'permanent_resolution',
      'resolutionAttribution', 'specific_action',
      'newTreatmentActions', jsonb_build_array(
        jsonb_build_object('actionType', 'diagnosis'), jsonb_build_object('actionType', 'reset_restart'))));
    insert into results (test, result, detail) values
      ('specific_action with two linked actions is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('specific_action with two linked actions is rejected',
        case when sqlerrm like 'validation:%פעולה מסוימת אחת בדיוק%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 9c. combination_of_actions with only ONE linked action -> rejected (needs >= 2 distinct).
  begin
    perform close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'equipment', 'treatmentOutcome', 'permanent_resolution',
      'resolutionAttribution', 'combination_of_actions',
      'newTreatmentActions', jsonb_build_array(jsonb_build_object('actionType', 'diagnosis'))));
    insert into results (test, result, detail) values
      ('combination_of_actions with one linked action is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('combination_of_actions with one linked action is rejected',
        case when sqlerrm like 'validation:%לפחות שתי פעולות שונות%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 9d. combination_of_actions with TWO distinct linked actions -> succeeds.
  begin
    v_closed := close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'equipment', 'treatmentOutcome', 'permanent_resolution',
      'resolutionAttribution', 'combination_of_actions',
      'newTreatmentActions', jsonb_build_array(
        jsonb_build_object('actionType', 'diagnosis'), jsonb_build_object('actionType', 'reset_restart'))));
    insert into results (test, result, detail) values
      ('combination_of_actions with two distinct linked actions succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('combination_of_actions with two distinct linked actions succeeds', 'FAIL', sqlerrm);
  end;

  -- 9e. undetermined with a non-zero linked-action list -> rejected.
  begin
    v_incident2 := create_incident(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000e401', 'locationId', '00000000-0000-0000-0000-00000000e402',
      'description', 'd5', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
      'discoveredAt', now(), 'reportedToOps', 'not_required'));
  end;
  begin
    perform close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'undetermined', 'treatmentOutcome', 'not_reproduced',
      'resolutionAttribution', 'undetermined',
      'newTreatmentActions', jsonb_build_array(jsonb_build_object('actionType', 'diagnosis'))));
    insert into results (test, result, detail) values
      ('undetermined with a non-zero linked-action list is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('undetermined with a non-zero linked-action list is rejected',
        case when sqlerrm like 'validation:%לא ניתן לקשר פעולות%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  -- 9f. undetermined with zero linked actions -> succeeds.
  begin
    v_closed := close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'undetermined', 'treatmentOutcome', 'not_reproduced',
      'resolutionAttribution', 'undetermined'));
    insert into results (test, result, detail) values
      ('undetermined with zero linked actions succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('undetermined with zero linked actions succeeds', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 10. resolved_without_action forces resolution_attribution =
  --     no_action_taken -- both at the RPC level (clean Hebrew error) and
  --     as a same-table CHECK constraint (raw insert bypass).
  -- =====================================================================
  begin
    v_incident2 := create_incident(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000e401', 'locationId', '00000000-0000-0000-0000-00000000e402',
      'description', 'd6', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
      'discoveredAt', now(), 'reportedToOps', 'not_required'));
  end;
  begin
    perform close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'undetermined', 'treatmentOutcome', 'resolved_without_action',
      'resolutionAttribution', 'undetermined'));
    insert into results (test, result, detail) values
      ('resolved_without_action + a non-no_action_taken attribution is rejected by the RPC', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('resolved_without_action + a non-no_action_taken attribution is rejected by the RPC',
        case when sqlerrm like 'validation:%לא בוצעה פעולה%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    v_closed := close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'undetermined', 'treatmentOutcome', 'resolved_without_action',
      'resolutionAttribution', 'no_action_taken'));
    insert into results (test, result, detail) values
      ('resolved_without_action + no_action_taken succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('resolved_without_action + no_action_taken succeeds', 'FAIL', sqlerrm);
  end;
  -- Same-table CHECK constraint backstop, via a raw INSERT bypassing the RPC entirely.
  begin
    insert into incident_closures (
      incident_id, cycle_number, confirmed_cause, treatment_outcome, resolution_attribution, recorded_by, event_time
    ) values (
      v_incident2.id, 99, 'undetermined', 'resolved_without_action', 'undetermined',
      '00000000-0000-0000-0000-0000000000e1', now()
    );
    insert into results (test, result, detail) values
      ('incident_closures CHECK constraint rejects a raw resolved_without_action/non-no_action_taken row', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('incident_closures CHECK constraint rejects a raw resolved_without_action/non-no_action_taken row',
        case when sqlerrm like '%incident_closure_resolved_without_action_requires_no_action%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 11. Reopen resets current_suspected_cause to NULL -- never carries
  --     forward the prior cause or the just-superseded confirmed cause.
  --     Prior incident_cause_assessments/incident_closures rows survive
  --     untouched. Fresh incident, created WITH an initial suspected
  --     cause (via create_incident_v2) and closed with a DIFFERENT
  --     confirmed cause, so a wrongly-implemented reset that copied
  --     either the pre-reopen suspected cause or the confirmed cause
  --     forward would be caught.
  -- =====================================================================
  begin
    v_incident2 := create_incident_v2(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000e401', 'locationId', '00000000-0000-0000-0000-00000000e402',
      'description', 'd7', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
      'discoveredAt', now(), 'reportedToOps', 'not_required',
      'reportedDomain', 'equipment', 'initialSuspectedCause', 'equipment'));
    v_incident2 := close_incident_v2(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'eventTime', now(), 'rootCause', 'r', 'resolution', 's',
      'readiness', 'full', 'reportedToOps', 'not_required',
      'confirmedCause', 'software', 'treatmentOutcome', 'permanent_resolution',
      'resolutionAttribution', 'no_action_taken'));
  end;
  insert into results (test, result, detail) select
    'pre-reopen: the just-closed incident has a non-NULL current_suspected_cause (sanity check on the fixture)',
    case when v_incident2.current_suspected_cause is not null then 'PASS' else 'FAIL' end,
    coalesce(v_incident2.current_suspected_cause::text, 'null');
  begin
    v_incident2 := reopen_incident(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_incident2.version, 'reason', 'התקלה חזרה', 'ownerUserId', '00000000-0000-0000-0000-0000000000e2'));
    insert into results (test, result, detail) values
      ('reopen_incident succeeds on a closed incident', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('reopen_incident succeeds on a closed incident', 'FAIL', sqlerrm);
  end;
  insert into results (test, result, detail) select
    'reopen_incident resets current_suspected_cause to NULL (never carries the prior/confirmed cause forward)',
    case when v_incident2.current_suspected_cause is null and v_incident2.current_suspected_cause_other_detail is null
      then 'PASS' else 'FAIL' end,
    'cause=' || coalesce(v_incident2.current_suspected_cause::text, 'null');
  select count(*) into v_closure_count from incident_closures where incident_id = v_incident2.id;
  insert into results (test, result, detail) select
    'reopen_incident: the prior cycle''s incident_closures row is preserved untouched',
    case when v_closure_count >= 1 then 'PASS' else 'FAIL' end, 'count=' || v_closure_count;

  -- =====================================================================
  -- 12. anon/PUBLIC cannot execute create_incident_v2/close_incident_v2 --
  --     grant verification via effective-ACL inspection (aclexplode),
  --     mirroring the existing chapter2_pr3 suite's own pattern.
  -- =====================================================================
  insert into results (test, result, detail)
  select 'no PUBLIC EXECUTE on create_incident_v2/close_incident_v2/_impl helpers',
    case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_incident_v2', 'close_incident_v2', 'create_incident_impl', 'close_incident_impl')
    and exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'
    );

  insert into results (test, result, detail)
  select 'no anon EXECUTE on create_incident_v2/close_incident_v2/_impl helpers',
    case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_incident_v2', 'close_incident_v2', 'create_incident_impl', 'close_incident_impl')
    and exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE'
    );

  insert into results (test, result, detail)
  select 'authenticated EXECUTE granted on create_incident_v2 and close_incident_v2',
    case when count(*) = 2 then 'PASS' else 'FAIL' end, 'granted=' || count(*)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_incident_v2', 'close_incident_v2')
    and exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
    );

  insert into results (test, result, detail)
  select 'no authenticated EXECUTE on the internal _impl helpers',
    case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_incident_impl', 'close_incident_impl')
    and exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
    );

  -- create_incident/close_incident (legacy) keep whatever grant they
  -- already had before this feature (authenticated EXECUTE, unchanged) --
  -- confirmed here so a future edit cannot silently narrow the
  -- currently-deployed frontend's access.
  insert into results (test, result, detail)
  select 'authenticated EXECUTE still granted on legacy create_incident/close_incident (unchanged)',
    case when count(*) = 2 then 'PASS' else 'FAIL' end, 'granted=' || count(*)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_incident', 'close_incident')
    and exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
    );
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
