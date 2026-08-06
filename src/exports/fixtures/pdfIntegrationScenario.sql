-- Fixture for incidentPdfSupabaseIntegration.test.ts: drives the REAL RPCs
-- (create_incident_v2/update_incident/close_incident_v2/reopen_incident)
-- against a local Postgres instance running the actual migration chain,
-- then dumps every relevant row as one JSON object on stdout -- so the
-- Node-side test can run the exact same SupabaseRepository row mappers
-- against real RPC-produced rows, not a hand-written fixture guess.
--
-- Must be run with `psql -t -A` (tuples-only, unaligned) against a
-- database that already has the harness + full migration chain applied;
-- the ONLY statement that produces output is the final SELECT.
\pset pager off
\set ON_ERROR_STOP on

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000f1', 'admin-f1@test', now()),
  ('00000000-0000-0000-0000-0000000000f2', 'tech-f2@test', now())
on conflict (id) do nothing;

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000f1', 'Admin F1', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000f2', 'Tech F2', 'technician', true)
on conflict (id) do nothing;

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000f901', 'Sys F', 1)
on conflict (id) do nothing;
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000f902', 'Loc F', 1)
on conflict (id) do nothing;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

create temp table pdf_integration_incident (id uuid);

do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');

  -- 1. Creation: reported domain + initial suspected cause + initial action.
  v_incident := create_incident_v2(jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000f901', 'locationId', '00000000-0000-0000-0000-00000000f902',
    'description', 'PDF integration test incident', 'severity', 'high', 'operationalImpact', 'impact',
    'actionsTaken', 'initial check', 'status', 'in_progress',
    'ownerUserId', '00000000-0000-0000-0000-0000000000f2', 'discoveredAt', now(), 'reportedToOps', 'not_required',
    'reportedDomain', 'infrastructure', 'initialSuspectedCause', 'equipment',
    'initialTreatmentActions', jsonb_build_array(jsonb_build_object('actionType', 'diagnosis'))));

  -- 2. Update: cause change + one structured treatment action.
  perform update_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_incident.version, 'eventTime', now(), 'actionsTaken', 'more checks',
    'status', 'in_progress', 'severity', 'high', 'operationalImpact', 'impact',
    'ownerUserId', '00000000-0000-0000-0000-0000000000f2', 'reportedToOps', 'not_required',
    'suspectedCause', 'software',
    'treatmentActions', jsonb_build_array(jsonb_build_object('actionType', 'software_fix'))));
  select * into v_incident from incidents where id = v_incident.id;

  -- 3. Close: full classification, one linked new action.
  v_incident := close_incident_v2(v_incident.id, jsonb_build_object(
    'expectedVersion', v_incident.version, 'eventTime', now(), 'rootCause', 'root cause text',
    'resolution', 'resolution text', 'readiness', 'full', 'reportedToOps', 'not_required',
    'confirmedCause', 'software', 'treatmentOutcome', 'permanent_resolution',
    'resolutionAttribution', 'specific_action',
    'newTreatmentActions', jsonb_build_array(jsonb_build_object('actionType', 'config_change'))));

  -- 4. Reopen -- current_suspected_cause must reset to null (see
  --    reopen_incident, migration 0047); the historical closure above must
  --    remain untouched and fully classified.
  v_incident := reopen_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_incident.version, 'reason', 'issue recurred',
    'ownerUserId', '00000000-0000-0000-0000-0000000000f2'));

  insert into pdf_integration_incident (id) values (v_incident.id);
end $$;

select jsonb_build_object(
  'incident', (select row_to_json(i) from incidents i where i.id = (select id from pdf_integration_incident)),
  'events', (select coalesce(jsonb_agg(row_to_json(e) order by e.event_time), '[]'::jsonb)
             from incident_events e where e.incident_id = (select id from pdf_integration_incident)),
  'updates', (select coalesce(jsonb_agg(row_to_json(u) order by u.event_time), '[]'::jsonb)
              from incident_updates u where u.incident_id = (select id from pdf_integration_incident)),
  'causeAssessments', (select coalesce(jsonb_agg(row_to_json(c) order by c.recorded_at), '[]'::jsonb)
                        from incident_cause_assessments c where c.incident_id = (select id from pdf_integration_incident)),
  'treatmentActions', (select coalesce(jsonb_agg(row_to_json(t) order by t.recorded_at), '[]'::jsonb)
                        from incident_treatment_actions t where t.incident_id = (select id from pdf_integration_incident)),
  'closures', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', cl.id, 'incident_id', cl.incident_id, 'cycle_number', cl.cycle_number, 'operation_id', cl.operation_id,
      'confirmed_cause', cl.confirmed_cause, 'confirmed_cause_other_detail', cl.confirmed_cause_other_detail,
      'treatment_outcome', cl.treatment_outcome, 'treatment_outcome_other_detail', cl.treatment_outcome_other_detail,
      'resolution_attribution', cl.resolution_attribution,
      'resolution_attribution_other_detail', cl.resolution_attribution_other_detail,
      'recorded_by', cl.recorded_by, 'event_time', cl.event_time, 'recorded_at', cl.recorded_at, 'created_at', cl.created_at,
      'incident_closure_resolution_actions', (
        select coalesce(jsonb_agg(jsonb_build_object('treatment_action_id', j.treatment_action_id)), '[]'::jsonb)
        from incident_closure_resolution_actions j where j.closure_id = cl.id
      )
    ) order by cl.event_time), '[]'::jsonb)
    from incident_closures cl where cl.incident_id = (select id from pdf_integration_incident)),
  'profiles', (select coalesce(jsonb_agg(row_to_json(p)), '[]'::jsonb) from profiles p),
  'systems', (select coalesce(jsonb_agg(row_to_json(s)), '[]'::jsonb) from systems s),
  'locations', (select coalesce(jsonb_agg(row_to_json(l)), '[]'::jsonb) from locations l)
);
