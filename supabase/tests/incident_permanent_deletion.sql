-- Tests for migration 0059 (AVARIA v1.7.0): admin_purge_incident() and the
-- reject_mutation() transaction-local bypass (avaria.incident_purge_in_progress).
--
-- Covers: authorization (every role, inactive admin, unauthenticated, auth
-- checked before existence), non-terminal rejection (every active status),
-- terminal acceptance (closed AND cancelled), complete dependency-graph
-- cleanup (every table identified during inspection, including the
-- indirect incident_closure_resolution_actions junction and the reverse
-- current_severity_assessment_id FK), that a shared handover/relation only
-- loses the ONE row scoped to the deleted incident, push_deliveries
-- cascading through notifications, incident_sequences staying byte-for-byte
-- unchanged, historical audit_logs rows surviving untouched, exactly one
-- minimal tombstone row with no operational payload, and that
-- reject_mutation() still blocks a plain direct mutation on every guarded
-- table OUTSIDE the purge transaction (proving the bypass is genuinely
-- scoped, not a global weakening).
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- =====================================================================
-- Fixtures
-- =====================================================================
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000059001', 'purge-admin@test', now()),
  ('00000000-0000-0000-0000-000000059002', 'purge-admin-inactive@test', now()),
  ('00000000-0000-0000-0000-000000059003', 'purge-manager@test', now()),
  ('00000000-0000-0000-0000-000000059004', 'purge-supervisor@test', now()),
  ('00000000-0000-0000-0000-000000059005', 'purge-tech@test', now()),
  ('00000000-0000-0000-0000-000000059006', 'purge-viewer@test', now()),
  ('00000000-0000-0000-0000-000000059007', 'purge-owner@test', now()),
  ('00000000-0000-0000-0000-000000059008', 'purge-recipient2@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000059001', 'Purge Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-000000059002', 'Purge Admin Inactive', 'system_admin', false),
  ('00000000-0000-0000-0000-000000059003', 'Purge Manager', 'professional_manager', true),
  ('00000000-0000-0000-0000-000000059004', 'Purge Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-000000059005', 'Purge Tech', 'technician', true),
  ('00000000-0000-0000-0000-000000059006', 'Purge Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-000000059007', 'Purge Owner', 'technician', true),
  ('00000000-0000-0000-0000-000000059008', 'Purge Recipient2', 'professional_manager', true);

insert into systems (id, name, display_order) values
  ('00000000-0000-0000-0000-000000059101', 'Purge Sys', 1);
insert into locations (id, name, display_order) values
  ('00000000-0000-0000-0000-000000059102', 'Purge Loc', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.check_result(p_test text, p_ok boolean, p_detail text default '')
returns void language sql as $$
  insert into results (test, result, detail)
  values (p_test, case when p_ok then 'PASS' else 'FAIL' end, coalesce(p_detail, ''));
$$;
grant execute on function pg_temp.check_result(text, boolean, text) to authenticated;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', false),
         set_config('request.jwt.claims', '', false);
$$;
grant execute on function pg_temp.as_anon() to authenticated;

-- One fully-loaded "target" incident (TGT) with at least one row in EVERY
-- table identified during inspection, plus two other incidents used to
-- prove shared/unrelated data survives: OTHER (shares a handover and an
-- incident_relations link with TGT) and THIRD (linked only to OTHER, must
-- stay completely untouched by TGT's purge).
insert into incidents (
  id, number, system_id, location_id, description, severity, status, operational_impact,
  owner_user_id, discovered_at, created_by, updated_by, next_update_due, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close, version
) values (
  '00000000-0000-0000-0000-000000059201', '2059-901',
  '00000000-0000-0000-0000-000000059101', '00000000-0000-0000-0000-000000059102',
  'Target incident for purge test', 'medium', 'closed', 'impact',
  '00000000-0000-0000-0000-000000059007', now() - interval '3 hours',
  '00000000-0000-0000-0000-000000059003', '00000000-0000-0000-0000-000000059003',
  null, 'closed',
  now() - interval '1 hour', '00000000-0000-0000-0000-000000059003', 'root cause', 'resolution', 'full', 1
);
insert into incidents (
  id, number, system_id, location_id, description, severity, status, operational_impact,
  owner_user_id, discovered_at, created_by, updated_by, next_update_due, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close, version
) values (
  '00000000-0000-0000-0000-000000059202', '2059-902',
  '00000000-0000-0000-0000-000000059101', '00000000-0000-0000-0000-000000059102',
  'Other incident, shares a handover/relation with TGT', 'low', 'closed', 'impact',
  '00000000-0000-0000-0000-000000059007', now() - interval '3 hours',
  '00000000-0000-0000-0000-000000059003', '00000000-0000-0000-0000-000000059003',
  null, 'closed',
  now() - interval '1 hour', '00000000-0000-0000-0000-000000059003', 'root cause', 'resolution', 'full', 1
);
insert into incidents (
  id, number, system_id, location_id, description, severity, status, operational_impact,
  owner_user_id, discovered_at, created_by, updated_by, next_update_due, no_deadline_reason,
  closed_at, closed_by, root_cause, resolution, readiness_at_close, version
) values (
  '00000000-0000-0000-0000-000000059203', '2059-903',
  '00000000-0000-0000-0000-000000059101', '00000000-0000-0000-0000-000000059102',
  'Third incident, related only to OTHER -- must survive untouched', 'low', 'closed', 'impact',
  '00000000-0000-0000-0000-000000059007', now() - interval '3 hours',
  '00000000-0000-0000-0000-000000059003', '00000000-0000-0000-0000-000000059003',
  null, 'closed',
  now() - interval '1 hour', '00000000-0000-0000-0000-000000059003', 'root cause', 'resolution', 'full', 1
);

-- incident_updates + incident_events for TGT.
insert into incident_updates (id, incident_id, author_id, event_time, actions_taken)
values ('00000000-0000-0000-0000-000000059301', '00000000-0000-0000-0000-000000059201',
        '00000000-0000-0000-0000-000000059003', now() - interval '2 hours', 'initial actions');
insert into incident_events (id, incident_id, type, actor_id, event_time)
values
  ('00000000-0000-0000-0000-000000059311', '00000000-0000-0000-0000-000000059201', 'created',
   '00000000-0000-0000-0000-000000059003', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-000000059312', '00000000-0000-0000-0000-000000059201', 'closed',
   '00000000-0000-0000-0000-000000059003', now() - interval '1 hour');

-- incident_cause_assessments + incident_treatment_actions for TGT.
insert into incident_cause_assessments (id, incident_id, cause, cycle_number, recorded_by)
values ('00000000-0000-0000-0000-000000059321', '00000000-0000-0000-0000-000000059201',
        'equipment', 0, '00000000-0000-0000-0000-000000059003');
insert into incident_treatment_actions (id, incident_id, action_type, cycle_number, recorded_by)
values ('00000000-0000-0000-0000-000000059331', '00000000-0000-0000-0000-000000059201',
        'diagnosis', 0, '00000000-0000-0000-0000-000000059003');

-- incident_closures + incident_closure_resolution_actions (the indirect
-- junction dependency) for TGT.
insert into incident_closures (
  id, incident_id, cycle_number, confirmed_cause, treatment_outcome, resolution_attribution,
  recorded_by, event_time
) values (
  '00000000-0000-0000-0000-000000059341', '00000000-0000-0000-0000-000000059201', 0,
  'equipment', 'permanent_resolution', 'specific_action',
  '00000000-0000-0000-0000-000000059003', now() - interval '1 hour'
);
insert into incident_closure_resolution_actions (closure_id, treatment_action_id)
values ('00000000-0000-0000-0000-000000059341', '00000000-0000-0000-0000-000000059331');

-- incident_status_checks + incident_report_events for TGT (both currently
-- dormant in production but schema-reachable -- see migration 0059's header).
insert into incident_status_checks (id, incident_id, kind, due_at, recorded_by)
values ('00000000-0000-0000-0000-000000059351', '00000000-0000-0000-0000-000000059201',
        'scheduled', now() + interval '1 day', '00000000-0000-0000-0000-000000059003');
insert into incident_report_events (id, incident_id, channel, status, recorded_by)
values ('00000000-0000-0000-0000-000000059361', '00000000-0000-0000-0000-000000059201',
        'ops_room', 'not_required', '00000000-0000-0000-0000-000000059003');

-- incident_severity_assessments + the reverse composite FK from incidents.
insert into severity_rulesets (id, version, name, guiding_questions, published_by)
values ('00000000-0000-0000-0000-000000059371', 590, 'Purge Test Ruleset', '[]'::jsonb,
        '00000000-0000-0000-0000-000000059001');
insert into incident_severity_assessments (
  id, incident_id, ruleset_version, answers, recommended_severity,
  recommendation_reasons, chosen_severity, assessed_by, recorded_by
) values (
  '00000000-0000-0000-0000-000000059381', '00000000-0000-0000-0000-000000059201', 590,
  '{}'::jsonb, 'medium', '[]'::jsonb, 'medium',
  '00000000-0000-0000-0000-000000059003', '00000000-0000-0000-0000-000000059003'
);
update incidents set
  current_severity_assessment_id = '00000000-0000-0000-0000-000000059381',
  severity_ruleset_version = 590,
  severity_recommended = 'medium'
where id = '00000000-0000-0000-0000-000000059201';

-- handovers/handover_items: ONE handover with items for BOTH TGT and
-- OTHER -- the handover and OTHER's item must survive; only TGT's item
-- may be removed.
insert into handovers (id, created_by, to_user_id)
values ('00000000-0000-0000-0000-000000059391', '00000000-0000-0000-0000-000000059003',
        '00000000-0000-0000-0000-000000059004');
insert into handover_items (id, handover_id, incident_id, snapshot_number, snapshot_status, snapshot_severity)
values
  ('00000000-0000-0000-0000-0000000593a1', '00000000-0000-0000-0000-000000059391',
   '00000000-0000-0000-0000-000000059201', '2059-901', 'closed', 'medium'),
  ('00000000-0000-0000-0000-0000000593a2', '00000000-0000-0000-0000-000000059391',
   '00000000-0000-0000-0000-000000059202', '2059-902', 'closed', 'low');

-- incident_relations: TGT<->OTHER and OTHER<->THIRD (the latter must
-- survive completely untouched by TGT's purge).
insert into incident_relations (incident_a_id, incident_b_id, created_by, operation_id)
values (
  least('00000000-0000-0000-0000-000000059201'::uuid, '00000000-0000-0000-0000-000000059202'::uuid),
  greatest('00000000-0000-0000-0000-000000059201'::uuid, '00000000-0000-0000-0000-000000059202'::uuid),
  '00000000-0000-0000-0000-000000059003', gen_random_uuid()
);
insert into incident_relations (incident_a_id, incident_b_id, created_by, operation_id)
values (
  least('00000000-0000-0000-0000-000000059202'::uuid, '00000000-0000-0000-0000-000000059203'::uuid),
  greatest('00000000-0000-0000-0000-000000059202'::uuid, '00000000-0000-0000-0000-000000059203'::uuid),
  '00000000-0000-0000-0000-000000059003', gen_random_uuid()
);

-- notifications (two recipients, one action_required + one update) + a
-- push_subscription + push_deliveries row to prove the cascade.
insert into notifications (id, user_id, type, category, incident_id, text, push_eligible)
values
  ('00000000-0000-0000-0000-0000000593b1', '00000000-0000-0000-0000-000000059007',
   'incident_assigned', 'action_required', '00000000-0000-0000-0000-000000059201', 'x', true),
  ('00000000-0000-0000-0000-0000000593b2', '00000000-0000-0000-0000-000000059008',
   'incident_closed', 'update', '00000000-0000-0000-0000-000000059201', 'x', false);
insert into push_subscriptions (id, user_id, endpoint, p256dh, auth_key)
values ('00000000-0000-0000-0000-0000000593c1', '00000000-0000-0000-0000-000000059007',
        'https://push.example.invalid/purge-test', 'fake-p256dh-not-real', 'fake-auth-not-real');
insert into push_deliveries (notification_id, subscription_id, status)
values ('00000000-0000-0000-0000-0000000593b1', '00000000-0000-0000-0000-0000000593c1', 'sent');

-- Historical audit_logs rows for TGT, simulating a normal lifecycle --
-- these must ALL survive the purge untouched, including their
-- before_data/after_data payload. write_audit() itself is revoked from
-- authenticated (internal-only, callable only from inside another
-- SECURITY DEFINER function's body -- see 0042), so these historical rows
-- are seeded with a direct INSERT, exactly like every other fixture row
-- in this file.
insert into audit_logs (actor_id, actor_display_name, action, entity_type, entity_id, incident_number, entity_label, before_data, after_data)
values
  ('00000000-0000-0000-0000-000000059003', 'Purge Manager', 'incident_created', 'incident',
   '00000000-0000-0000-0000-000000059201', '2059-901', '2059-901', null,
   jsonb_build_object('severity', 'medium', 'status', 'new')),
  ('00000000-0000-0000-0000-000000059003', 'Purge Manager', 'incident_closed', 'incident',
   '00000000-0000-0000-0000-000000059201', '2059-901', '2059-901',
   jsonb_build_object('status', 'in_progress'), jsonb_build_object('status', 'closed'));

-- =====================================================================
-- 1. Baseline: reject_mutation() still blocks a plain direct mutation on
--    every guarded table BEFORE any admin_purge_incident call has ever
--    run in this session -- run first, deliberately, before anything else
--    in this file touches the bypass flag.
-- =====================================================================
do $$
begin
  begin
    delete from incident_updates where id = '00000000-0000-0000-0000-000000059301';
    perform pg_temp.check_result('1a: incident_updates DELETE is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('1a: incident_updates DELETE is blocked', sqlerrm like 'append_only:%', sqlerrm);
  end;
  begin
    delete from incident_events where id = '00000000-0000-0000-0000-000000059311';
    perform pg_temp.check_result('1b: incident_events DELETE is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('1b: incident_events DELETE is blocked', sqlerrm like 'append_only:%', sqlerrm);
  end;
  begin
    delete from handover_items where id = '00000000-0000-0000-0000-0000000593a1';
    perform pg_temp.check_result('1c: handover_items DELETE is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('1c: handover_items DELETE is blocked', sqlerrm like 'append_only:%', sqlerrm);
  end;
  begin
    delete from incident_closures where id = '00000000-0000-0000-0000-000000059341';
    perform pg_temp.check_result('1d: incident_closures DELETE is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('1d: incident_closures DELETE is blocked', sqlerrm like 'append_only:%', sqlerrm);
  end;
  begin
    delete from incidents where id = '00000000-0000-0000-0000-000000059201';
    perform pg_temp.check_result('1e: incidents DELETE is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('1e: incidents DELETE is blocked', sqlerrm like 'append_only:%', sqlerrm);
  end;
  perform pg_temp.check_result(
    '1f: the bypass flag itself is unset in this ordinary session/transaction',
    current_setting('avaria.incident_purge_in_progress', true) is distinct from 'on'
  );
end $$;

-- =====================================================================
-- 2. GUC scoping mechanism, tested directly and in isolation: proves the
--    exact safety property admin_purge_incident's bypass depends on --
--    set_config(..., true) (is_local = true) is undone by a rollback of
--    the transaction/subtransaction it was set in, exactly like a
--    PostgREST request's own transaction would undo it at end-of-request
--    in real usage. Deliberately NOT tested by calling
--    admin_purge_incident itself here: this whole test file runs inside
--    ONE outer transaction (script-level BEGIN/ROLLBACK, for isolation),
--    so two separate admin_purge_incident calls later in this same file
--    inherently share that one outer transaction -- exactly as two
--    separate PostgREST requests never would in production. Proving the
--    underlying set_config/current_setting mechanism directly, via an
--    explicit SAVEPOINT boundary, is what actually verifies the safety
--    property without that test-harness artifact.
-- =====================================================================
do $$
begin
  perform pg_temp.check_result(
    '2a: unset before this test touches it',
    current_setting('avaria.incident_purge_in_progress', true) is distinct from 'on'
  );
end $$;

-- \gset captures the observed value into a CLIENT-side psql variable
-- BEFORE the rollback below -- a check_result() INSERT issued while still
-- inside the savepoint would itself be undone by ROLLBACK TO SAVEPOINT
-- (it rolls back every change made since the savepoint, including that
-- INSERT), so the assertion is recorded afterward, from the captured value.
savepoint guc_scope_probe;
select case when set_config('avaria.incident_purge_in_progress', 'on', true) = 'on' then 'true' else 'false' end
  as during_savepoint \gset
rollback to savepoint guc_scope_probe;

select pg_temp.check_result(
  '2b: reads back ''on'' immediately after set_config(..., true) inside a subtransaction',
  :during_savepoint
);

do $$
begin
  perform pg_temp.check_result(
    '2c: reverts to unset once the subtransaction that set it is rolled back -- the exact mechanism admin_purge_incident''s bypass relies on',
    current_setting('avaria.incident_purge_in_progress', true) is distinct from 'on'
  );
end $$;

-- =====================================================================
-- 3. Authorization: every role, inactive admin, unauthenticated. Checked
--    against a SEPARATE, never-purged incident (OTHER) so a rejected call
--    can never accidentally be the thing that deletes TGT out from under
--    the later dependency-cleanup tests.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000059003'); -- professional_manager
  set local role authenticated;
  begin
    perform admin_purge_incident('00000000-0000-0000-0000-000000059202');
    perform pg_temp.check_result('3a: professional_manager is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('3a: professional_manager is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000059004'); -- shift_supervisor
  set local role authenticated;
  begin
    perform admin_purge_incident('00000000-0000-0000-0000-000000059202');
    perform pg_temp.check_result('3b: shift_supervisor is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('3b: shift_supervisor is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000059005'); -- technician
  set local role authenticated;
  begin
    perform admin_purge_incident('00000000-0000-0000-0000-000000059202');
    perform pg_temp.check_result('3c: technician is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('3c: technician is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000059006'); -- viewer
  set local role authenticated;
  begin
    perform admin_purge_incident('00000000-0000-0000-0000-000000059202');
    perform pg_temp.check_result('3d: viewer is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('3d: viewer is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000059002'); -- inactive system_admin
  set local role authenticated;
  begin
    perform admin_purge_incident('00000000-0000-0000-0000-000000059202');
    perform pg_temp.check_result('3e: inactive system_admin is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('3e: inactive system_admin is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_anon(); -- unauthenticated
  set local role authenticated;
  begin
    perform admin_purge_incident('00000000-0000-0000-0000-000000059202');
    perform pg_temp.check_result('3f: unauthenticated caller is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('3f: unauthenticated caller is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  -- 1g/1h: auth is checked BEFORE existence -- a rejected non-admin call
  -- against a NONEXISTENT incident id gets the exact same permission
  -- error, never not_found (which would leak that the id doesn't exist to
  -- an unauthorized caller).
  perform pg_temp.as_user('00000000-0000-0000-0000-000000059005'); -- technician
  set local role authenticated;
  begin
    perform admin_purge_incident('00000000-0000-0000-0000-000000059999');
    perform pg_temp.check_result('3g: auth check runs before existence check (nonexistent id, unauthorized role)', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      '3g: auth check runs before existence check (nonexistent id, unauthorized role)',
      sqlerrm like 'permission:%', sqlerrm
    );
  end;
  reset role;
end $$;

-- =====================================================================
-- 4. Nonexistent incident -> not_found, for an AUTHORIZED admin.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000059001'); -- system_admin
  set local role authenticated;
  begin
    perform admin_purge_incident('00000000-0000-0000-0000-000000059999');
    perform pg_temp.check_result('4: nonexistent incident -> not_found for an authorized admin', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('4: nonexistent incident -> not_found for an authorized admin', sqlerrm like 'not_found:%', sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 5. Every non-terminal status is rejected; closed AND cancelled are both
--    accepted (verified by successfully purging two throwaway incidents,
--    one of each terminal outcome, each with only a minimal footprint).
-- =====================================================================
do $$
declare
  v_status text;
  v_incident_id uuid;
  v_nonterminal_statuses text[] := array[
    'new', 'acknowledged', 'in_progress', 'waiting_external', 'waiting_test',
    'monitoring', 'partial_readiness', 'resolved_pending_close', 'reopened',
    'waiting_equipment', 'waiting_information', 'waiting_validation'
  ];
begin
  foreach v_status in array v_nonterminal_statuses loop
    v_incident_id := gen_random_uuid();
    insert into incidents (
      id, number, system_id, location_id, description, severity, status, operational_impact,
      owner_user_id, discovered_at, created_by, updated_by, next_update_due
    ) values (
      v_incident_id, 'NT-' || v_status, '00000000-0000-0000-0000-000000059101',
      '00000000-0000-0000-0000-000000059102', 'non-terminal fixture', 'low', v_status::incident_status, 'impact',
      '00000000-0000-0000-0000-000000059007', now(), '00000000-0000-0000-0000-000000059003',
      '00000000-0000-0000-0000-000000059003', now() + interval '4 hours'
    );
    perform pg_temp.as_user('00000000-0000-0000-0000-000000059001');
    set local role authenticated;
    begin
      perform admin_purge_incident(v_incident_id);
      perform pg_temp.check_result('5: status=' || v_status || ' is rejected (not terminal)', false, 'succeeded');
    exception when others then
      perform pg_temp.check_result('5: status=' || v_status || ' is rejected (not terminal)', sqlerrm like 'invalid_transition:%', sqlerrm);
    end;
    reset role;
    perform pg_temp.check_result(
      '5: the rejected non-terminal incident (' || v_status || ') still exists',
      exists (select 1 from incidents where id = v_incident_id)
    );
  end loop;
end $$;

do $$
declare
  v_closed_id uuid := gen_random_uuid();
  v_cancelled_id uuid := gen_random_uuid();
begin
  insert into incidents (
    id, number, system_id, location_id, description, severity, status, operational_impact,
    owner_user_id, discovered_at, created_by, updated_by, next_update_due, no_deadline_reason,
    closed_at, closed_by, root_cause, resolution, readiness_at_close
  ) values (
    v_closed_id, 'CLOSED-OK', '00000000-0000-0000-0000-000000059101', '00000000-0000-0000-0000-000000059102',
    'closed fixture', 'low', 'closed', 'impact', '00000000-0000-0000-0000-000000059007', now(),
    '00000000-0000-0000-0000-000000059003', '00000000-0000-0000-0000-000000059003', null, 'closed',
    now(), '00000000-0000-0000-0000-000000059003', 'rc', 'res', 'full'
  );
  insert into incidents (
    id, number, system_id, location_id, description, severity, status, operational_impact,
    owner_user_id, discovered_at, created_by, updated_by, next_update_due, no_deadline_reason,
    cancelled_at, cancelled_by, cancellation_reason
  ) values (
    v_cancelled_id, 'CANCELLED-OK', '00000000-0000-0000-0000-000000059101', '00000000-0000-0000-0000-000000059102',
    'cancelled fixture', 'low', 'cancelled', 'impact', '00000000-0000-0000-0000-000000059007', now(),
    '00000000-0000-0000-0000-000000059003', '00000000-0000-0000-0000-000000059003', null, 'cancelled',
    now(), '00000000-0000-0000-0000-000000059003', 'duplicate report'
  );

  perform pg_temp.as_user('00000000-0000-0000-0000-000000059001');
  set local role authenticated;
  perform admin_purge_incident(v_closed_id);
  perform admin_purge_incident(v_cancelled_id);
  reset role;

  perform pg_temp.check_result('5: a closed incident is accepted and purged', not exists (select 1 from incidents where id = v_closed_id));
  perform pg_temp.check_result('5: a cancelled incident is accepted and purged', not exists (select 1 from incidents where id = v_cancelled_id));
end $$;


-- =====================================================================
-- 6. The real purge of TGT: full dependency-graph cleanup, sequence
--    untouched, shared/unrelated data survives, audit history preserved,
--    exactly one minimal tombstone written.
-- =====================================================================
do $$
declare
  v_before_last_number int;
  v_after_last_number int;
  v_audit_count_before int;
  v_year int := extract(year from now())::int;
begin
  select last_number into v_before_last_number from incident_sequences where year = v_year;
  select count(*) into v_audit_count_before from audit_logs where incident_number = '2059-901';

  perform pg_temp.as_user('00000000-0000-0000-0000-000000059001'); -- system_admin
  set local role authenticated;
  perform admin_purge_incident('00000000-0000-0000-0000-000000059201');
  reset role;

  -- ----- incidents itself -----
  perform pg_temp.check_result('6a: the target incident row is gone', not exists (
    select 1 from incidents where id = '00000000-0000-0000-0000-000000059201'
  ));

  -- ----- full dependency graph, every table -----
  perform pg_temp.check_result('6b: incident_updates cleaned', not exists (
    select 1 from incident_updates where incident_id = '00000000-0000-0000-0000-000000059201'
  ));
  perform pg_temp.check_result('6c: incident_events cleaned', not exists (
    select 1 from incident_events where incident_id = '00000000-0000-0000-0000-000000059201'
  ));
  perform pg_temp.check_result('6d: incident_cause_assessments cleaned', not exists (
    select 1 from incident_cause_assessments where incident_id = '00000000-0000-0000-0000-000000059201'
  ));
  perform pg_temp.check_result('6e: incident_treatment_actions cleaned', not exists (
    select 1 from incident_treatment_actions where incident_id = '00000000-0000-0000-0000-000000059201'
  ));
  perform pg_temp.check_result('6f: incident_closures cleaned', not exists (
    select 1 from incident_closures where incident_id = '00000000-0000-0000-0000-000000059201'
  ));
  perform pg_temp.check_result('6g: incident_closure_resolution_actions (indirect junction) cleaned', not exists (
    select 1 from incident_closure_resolution_actions where closure_id = '00000000-0000-0000-0000-000000059341'
  ));
  perform pg_temp.check_result('6h: incident_status_checks cleaned', not exists (
    select 1 from incident_status_checks where incident_id = '00000000-0000-0000-0000-000000059201'
  ));
  perform pg_temp.check_result('6i: incident_report_events cleaned', not exists (
    select 1 from incident_report_events where incident_id = '00000000-0000-0000-0000-000000059201'
  ));
  perform pg_temp.check_result('6j: incident_severity_assessments cleaned (reverse FK handled safely)', not exists (
    select 1 from incident_severity_assessments where incident_id = '00000000-0000-0000-0000-000000059201'
  ));
  perform pg_temp.check_result('6k: notifications for the target incident cleaned', not exists (
    select 1 from notifications where incident_id = '00000000-0000-0000-0000-000000059201'
  ));
  perform pg_temp.check_result(
    '6l: push_deliveries cascaded away through the notification delete (never touched directly)',
    not exists (select 1 from push_deliveries where subscription_id = '00000000-0000-0000-0000-0000000593c1')
  );
  perform pg_temp.check_result(
    '6m: the push_subscription itself (owned by a still-active user) is untouched',
    exists (select 1 from push_subscriptions where id = '00000000-0000-0000-0000-0000000593c1')
  );

  -- ----- shared handover: only TGT's item removed, handover + OTHER's item survive -----
  perform pg_temp.check_result('6n: only the target incident''s handover_items row is removed', not exists (
    select 1 from handover_items where id = '00000000-0000-0000-0000-0000000593a1'
  ));
  perform pg_temp.check_result('6o: the shared handover itself survives', exists (
    select 1 from handovers where id = '00000000-0000-0000-0000-000000059391'
  ));
  perform pg_temp.check_result('6p: OTHER''s own handover_items row survives untouched', exists (
    select 1 from handover_items where id = '00000000-0000-0000-0000-0000000593a2'
  ));

  -- ----- incident_relations: removed from either side, unrelated pair untouched -----
  perform pg_temp.check_result('6q: the TGT<->OTHER relation is removed', not exists (
    select 1 from incident_relations
    where '00000000-0000-0000-0000-000000059201' in (incident_a_id, incident_b_id)
  ));
  perform pg_temp.check_result('6r: the unrelated OTHER<->THIRD relation survives untouched', exists (
    select 1 from incident_relations
    where '00000000-0000-0000-0000-000000059202' in (incident_a_id, incident_b_id)
      and '00000000-0000-0000-0000-000000059203' in (incident_a_id, incident_b_id)
  ));

  -- ----- unrelated incidents completely untouched -----
  perform pg_temp.check_result('6s: OTHER incident itself is untouched', exists (
    select 1 from incidents where id = '00000000-0000-0000-0000-000000059202'
  ));
  perform pg_temp.check_result('6t: THIRD incident itself is untouched', exists (
    select 1 from incidents where id = '00000000-0000-0000-0000-000000059203'
  ));

  -- ----- incident_sequences byte-for-byte unchanged -----
  select last_number into v_after_last_number from incident_sequences where year = v_year;
  perform pg_temp.check_result(
    '6u: incident_sequences.last_number is exactly unchanged by the purge',
    v_before_last_number is not distinct from v_after_last_number,
    format('before=%s after=%s', v_before_last_number, v_after_last_number)
  );

  -- ----- historical audit_logs preserved untouched -----
  perform pg_temp.check_result(
    '6v: every pre-existing historical audit_logs row for this incident_number still exists',
    (select count(*) from audit_logs where incident_number = '2059-901' and action <> 'incident_permanently_deleted')
      = v_audit_count_before
  );
  perform pg_temp.check_result(
    '6w: a historical audit row''s before/after payload is byte-for-byte unchanged',
    (select after_data from audit_logs where incident_number = '2059-901' and action = 'incident_created')
      = jsonb_build_object('severity', 'medium', 'status', 'new')
  );

  -- ----- exactly one minimal tombstone -----
  perform pg_temp.check_result(
    '6x: exactly one incident_permanently_deleted tombstone row was written',
    (select count(*) from audit_logs
       where action = 'incident_permanently_deleted'
         and entity_type = 'incident'
         and entity_id = '00000000-0000-0000-0000-000000059201'
         and incident_number = '2059-901') = 1
  );
  perform pg_temp.check_result(
    '6y: the tombstone carries no operational before/after/summary/metadata payload',
    (select before_data is null and after_data is null and summary is null and metadata is null
       from audit_logs
       where action = 'incident_permanently_deleted' and entity_id = '00000000-0000-0000-0000-000000059201')
  );
  perform pg_temp.check_result(
    '6z: the tombstone correctly attributes the acting admin',
    (select actor_id from audit_logs
       where action = 'incident_permanently_deleted' and entity_id = '00000000-0000-0000-0000-000000059201')
      = '00000000-0000-0000-0000-000000059001'
  );
end $$;

-- =====================================================================
-- 7. Grants: admin_purge_incident has no PUBLIC/anon EXECUTE -- the
--    function body's own role check is the real boundary, not the grant.
-- =====================================================================
select pg_temp.check_result(
  '7: admin_purge_incident has no PUBLIC or anon EXECUTE',
  not has_function_privilege('anon', 'public.admin_purge_incident(uuid)', 'EXECUTE')
  and not has_function_privilege('public', 'public.admin_purge_incident(uuid)', 'EXECUTE')
);
select pg_temp.check_result(
  '7b: authenticated has EXECUTE on admin_purge_incident (the function body enforces system_admin-only, not the grant)',
  has_function_privilege('authenticated', 'public.admin_purge_incident(uuid)', 'EXECUTE')
);

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
