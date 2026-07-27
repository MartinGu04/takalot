-- Tests for migration 0017 (Chapter 2, PR3): terminal-status compatibility
-- for 'cancelled', plus cancel_incident, add_incident_report,
-- set_incident_status_check, and their internal helper
-- assert_active_profile_if_set.
--
-- Covers: is_valid_transition truth table for terminal statuses;
-- create_incident's pre-cutover allowlist; terminal-guard rejection for
-- every existing incident-mutating RPC against an already-cancelled
-- incident; the admin_delete_user/admin_set_user_active/
-- prevent_deactivation_with_open_incidents regression (a user owning only a
-- cancelled incident must no longer be wrongly blocked); create_handover
-- excluding cancelled incidents; the complete_follow_up-after-cancellation
-- finding; cancel_incident's pre/post snapshot correctness, audit payload,
-- input validation, and mirrored status-check removal; add_incident_report's
-- full field-validation matrix and tombstoned/inactive performer rejection;
-- set_incident_status_check's full kind matrix including the
-- completed+nextDueAt compound case; and PUBLIC/anon/authenticated EXECUTE
-- absence via effective-ACL inspection.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000d1', 'admin@test', now()),
  ('00000000-0000-0000-0000-0000000000d2', 'tech-owner@test', now()),
  ('00000000-0000-0000-0000-0000000000d3', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000d4', 'viewer@test', now()),
  ('00000000-0000-0000-0000-0000000000d5', 'inactive-performer@test', now()),
  ('00000000-0000-0000-0000-0000000000d6', 'tombstoned-performer@test', now()),
  ('00000000-0000-0000-0000-0000000000d7', 'valid-performer@test', now()),
  ('00000000-0000-0000-0000-0000000000d8', 'cancelled-owner-1@test', now()),
  ('00000000-0000-0000-0000-0000000000d9', 'cancelled-owner-2@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000d1', 'Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000d2', 'Tech Owner', 'technician', true),
  ('00000000-0000-0000-0000-0000000000d3', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000d4', 'Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-0000000000d5', 'Inactive Performer', 'technician', false),
  ('00000000-0000-0000-0000-0000000000d7', 'Valid Performer', 'technician', true),
  ('00000000-0000-0000-0000-0000000000d8', 'Cancelled Owner One', 'technician', true),
  ('00000000-0000-0000-0000-0000000000d9', 'Cancelled Owner Two', 'technician', true);
-- Note: `profiles_deleted_implies_inactive` (0012) guarantees deleted_at is
-- never set while active = true -- a tombstoned profile is always inactive
-- at the schema level. This fixture matches that real, DB-enforced shape
-- (rather than an unreachable active=true + deleted_at-set combination) --
-- assert_active_profile_if_set's explicit `deleted_at is not null` check is
-- accordingly always redundant with its own `not active` check in practice,
-- exactly as it is for the pre-existing tombstone checks elsewhere in this
-- schema, but is kept as defensive, explicit belt-and-suspenders per the
-- approved scope.
insert into profiles (id, full_name, role, active, deleted_at, deleted_by) values
  ('00000000-0000-0000-0000-0000000000d6', 'Tombstoned Performer', 'technician', false, now(), '00000000-0000-0000-0000-0000000000d1');

insert into systems (id, name) values ('00000000-0000-0000-0000-00000000f401', 'Sys');
insert into locations (id, name) values ('00000000-0000-0000-0000-00000000f402', 'Loc');

-- f410: a normal open incident owned by d2, discovered 1 day ago -- the main
-- fixture for cancel_incident/add_incident_report/set_incident_status_check
-- happy paths.
-- updated_at/last_update_at are explicitly backdated to a fixed PAST literal
-- (not `now()`) because this whole suite runs inside one transaction, where
-- every `now()` call returns the identical, frozen transaction-start
-- instant -- comparing a post-RPC `updated_at` against a same-transaction
-- `created_at`/default-`now()` value could never distinguish "the RPC wrote
-- this column" from "it was never touched at all" (both would show the same
-- frozen timestamp). A fixed past literal makes the post-call comparison
-- meaningful.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       updated_at, last_update_at, next_update_due, version)
values ('00000000-0000-0000-0000-00000000f410', 'T-410',
        '00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000f402',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000d2', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
        '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
        now() + interval '4 hours', 1);

-- f411: a partial_readiness incident with an outstanding follow-up (as
-- close_incident's incomplete-readiness branch would leave it), used to prove
-- complete_follow_up must reject it once cancelled.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       root_cause, resolution, follow_up_notes, follow_up_required,
                       no_deadline_reason, version)
values ('00000000-0000-0000-0000-00000000f411', 'T-411',
        '00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000f402',
        'desc', 'medium', 'partial_readiness', 'impact',
        '00000000-0000-0000-0000-0000000000d2', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
        'root', 'partial fix', 'follow up later', true,
        'ממתין להשלמה', 1);

-- f412: pre-set CANCELLED incident, owned by d8 -- the fixture for every
-- terminal-guard rejection test AND the admin_set_user_active/
-- admin_delete_user regression (d8 owns ONLY this cancelled incident).
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       cancelled_at, cancelled_by, cancellation_reason,
                       no_deadline_reason, version)
values ('00000000-0000-0000-0000-00000000f412', 'T-412',
        '00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000f402',
        'desc', 'low', 'cancelled', 'impact',
        '00000000-0000-0000-0000-0000000000d8', now() - interval '2 days',
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
        now() - interval '1 day', '00000000-0000-0000-0000-0000000000d1', 'not needed anymore',
        'התקלה בוטלה', 1);

-- f413: pre-set CANCELLED incident owned by d9 -- dedicated to the trigger
-- backstop test (raw UPDATE profiles, bypassing the RPC).
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       cancelled_at, cancelled_by, cancellation_reason,
                       no_deadline_reason, version)
values ('00000000-0000-0000-0000-00000000f413', 'T-413',
        '00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000f402',
        'desc', 'low', 'cancelled', 'impact',
        '00000000-0000-0000-0000-0000000000d9', now() - interval '2 days',
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
        now() - interval '1 day', '00000000-0000-0000-0000-0000000000d1', 'not needed anymore',
        'התקלה בוטלה', 1);

-- f414: an open incident owned by d2 with a scheduled status check, used to
-- prove cancel_incident mirrors the status-check removal into the timeline.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, status_check_due, version)
values ('00000000-0000-0000-0000-00000000f414', 'T-414',
        '00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000f402',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000d2', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
        now() + interval '4 hours', now() + interval '2 days', 1);
insert into incident_status_checks (incident_id, kind, due_at, recorded_by, event_time)
values ('00000000-0000-0000-0000-00000000f414', 'scheduled', now() + interval '2 days',
        '00000000-0000-0000-0000-0000000000d1', now() - interval '1 day');

-- f415: a fresh open incident owned by d2, used for the
-- set_incident_status_check full-kind-matrix walkthrough. updated_at/
-- last_update_at backdated for the same reason as f410 above.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       updated_at, last_update_at, next_update_due, version)
values ('00000000-0000-0000-0000-00000000f415', 'T-415',
        '00000000-0000-0000-0000-00000000f401', '00000000-0000-0000-0000-00000000f402',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000d2', now() - interval '1 day',
        '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
        '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
        now() + interval '4 hours', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

-- pg_temp functions cannot be granted EXECUTE and called under `set local
-- role authenticated` in the same way as public ones; the RPCs under test
-- are still owner-only (no authenticated grant), so every call in this suite
-- below is made as the DEFAULT connecting role (postgres/table owner) --
-- exactly like every migration application itself -- with auth.uid()
-- spoofed via as_user(). This is consistent with the harness: SECURITY
-- DEFINER functions run under their owner's privileges regardless of the
-- caller's own grants, so calling them as postgres (never as authenticated)
-- exercises the exact same code paths a granted authenticated caller would
-- exercise once the follow-up grant migration ships -- without requiring
-- that grant to exist yet, matching this PR's "ungranted" requirement.

do $$
declare
  v_incident incidents;
  v_before_incident incidents;
  v_count int;
  v_active boolean;
  v_deleted_at timestamptz;
  v_status_check_id uuid;
  v_event_old_value text;
  v_event_new_value text;
  v_event_ref_id uuid;
  v_audit_before jsonb;
  v_audit_after jsonb;
  v_report_id uuid;
  v_ref_ids_before uuid[];
  v_ref_ids_after uuid[];
  v_new_ref_ids uuid[];
begin
  -- =====================================================================
  -- 1. is_valid_transition -- terminal-aware on both sides
  -- =====================================================================
  insert into results (test, result, detail) values
    ('is_valid_transition(cancelled, cancelled) = false',
      case when is_valid_transition('cancelled', 'cancelled') = false then 'PASS' else 'FAIL' end, '');
  insert into results (test, result, detail) values
    ('is_valid_transition(cancelled, in_progress) = false',
      case when is_valid_transition('cancelled', 'in_progress') = false then 'PASS' else 'FAIL' end, '');
  insert into results (test, result, detail) values
    ('is_valid_transition(new, cancelled) = false',
      case when is_valid_transition('new', 'cancelled') = false then 'PASS' else 'FAIL' end, '');
  insert into results (test, result, detail) values
    ('is_valid_transition(in_progress, in_progress) = true (non-terminal self-transition still valid)',
      case when is_valid_transition('in_progress', 'in_progress') = true then 'PASS' else 'FAIL' end, '');

  -- =====================================================================
  -- 1b. is_incident_open must work when the CALLER's search_path is empty --
  --     this is the exact failure mode that broke admin_delete_user/
  --     prevent_deactivation_with_open_incidents/admin_set_user_active
  --     before this function was pinned to `set search_path = public`.
  --     `set local search_path` is scoped to this transaction and is reset
  --     immediately after, so it cannot affect anything else in this suite.
  -- =====================================================================
  set local search_path = '';
  insert into results (test, result, detail) values
    ('is_incident_open(in_progress) = true under an empty caller search_path',
      case when public.is_incident_open('in_progress') = true then 'PASS' else 'FAIL' end, '');
  insert into results (test, result, detail) values
    ('is_incident_open(monitoring) = true under an empty caller search_path (legacy-open status)',
      case when public.is_incident_open('monitoring') = true then 'PASS' else 'FAIL' end, '');
  insert into results (test, result, detail) values
    ('is_incident_open(closed) = false under an empty caller search_path',
      case when public.is_incident_open('closed') = false then 'PASS' else 'FAIL' end, '');
  insert into results (test, result, detail) values
    ('is_incident_open(cancelled) = false under an empty caller search_path',
      case when public.is_incident_open('cancelled') = false then 'PASS' else 'FAIL' end, '');
  reset search_path;

  -- =====================================================================
  -- 2. create_incident -- pre-cutover allowlist
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
  begin
    perform create_incident(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000f401', 'locationId', '00000000-0000-0000-0000-00000000f402',
      'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'waiting_equipment', 'ownerUserId', '00000000-0000-0000-0000-0000000000d2',
      'discoveredAt', now(), 'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values ('create_incident rejects waiting_equipment pre-cutover', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('create_incident rejects waiting_equipment pre-cutover',
      case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform create_incident(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000f401', 'locationId', '00000000-0000-0000-0000-00000000f402',
      'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'cancelled', 'ownerUserId', '00000000-0000-0000-0000-0000000000d2',
      'discoveredAt', now(), 'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values ('create_incident rejects cancelled as initial status', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('create_incident rejects cancelled as initial status',
      case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    v_incident := create_incident(jsonb_build_object(
      'systemId', '00000000-0000-0000-0000-00000000f401', 'locationId', '00000000-0000-0000-0000-00000000f402',
      'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
      'status', 'monitoring', 'ownerUserId', '00000000-0000-0000-0000-0000000000d2',
      'discoveredAt', now(), 'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values ('create_incident accepts allowlisted status (monitoring)', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('create_incident accepts allowlisted status (monitoring)', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 3. Terminal-guard rejection for every existing incident-mutating RPC,
  --    against f412 (already cancelled, owned by d8).
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f412',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'actionsTaken', 'x', 'status', 'cancelled',
        'severity', 'low', 'operationalImpact', 'impact', 'ownerUserId', '00000000-0000-0000-0000-0000000000d8',
        'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values ('update_incident rejects cancelled incident (self-transition)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('update_incident rejects cancelled incident (self-transition)',
      case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000f412',
      jsonb_build_object('expectedVersion', 1, 'ownerUserId', '00000000-0000-0000-0000-0000000000d2'));
    insert into results (test, result, detail) values ('assign_incident rejects cancelled incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('assign_incident rejects cancelled incident',
      case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform close_incident('00000000-0000-0000-0000-00000000f412',
      jsonb_build_object('expectedVersion', 1, 'rootCause', 'r', 'resolution', 's', 'readiness', 'full', 'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values ('close_incident rejects already-cancelled incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('close_incident rejects already-cancelled incident',
      case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform cancel_incident('00000000-0000-0000-0000-00000000f412',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'cancellationReason', 'again'));
    insert into results (test, result, detail) values ('cancel_incident rejects re-cancelling an already-cancelled incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('cancel_incident rejects re-cancelling an already-cancelled incident',
      case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform add_incident_report('00000000-0000-0000-0000-00000000f412',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'channel', 'ops_room', 'status', 'not_required'));
    insert into results (test, result, detail) values ('add_incident_report rejects cancelled incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('add_incident_report rejects cancelled incident',
      case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform set_incident_status_check('00000000-0000-0000-0000-00000000f412',
      jsonb_build_object('expectedVersion', 1, 'kind', 'scheduled', 'eventTime', now(), 'dueAt', now() + interval '1 day'));
    insert into results (test, result, detail) values ('set_incident_status_check rejects cancelled incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('set_incident_status_check rejects cancelled incident',
      case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000f412',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'actionsTaken', 'x'));
    insert into results (test, result, detail) values ('technician_update_incident rejects cancelled incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('technician_update_incident rejects cancelled incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 4. admin_set_user_active / admin_delete_user / trigger backstop --
  --    regression: a user owning only a CANCELLED incident must no longer
  --    be wrongly blocked (pre-fix, status <> 'closed' counted 'cancelled'
  --    as open).
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
  begin
    perform admin_set_user_active('00000000-0000-0000-0000-0000000000d8', false);
    insert into results (test, result, detail) values
      ('admin_set_user_active deactivates a user owning only a cancelled incident', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('admin_set_user_active deactivates a user owning only a cancelled incident', 'FAIL', sqlerrm);
  end;
  begin
    perform admin_delete_user('00000000-0000-0000-0000-0000000000d8');
    insert into results (test, result, detail) values
      ('admin_delete_user deletes a user owning only a cancelled incident', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('admin_delete_user deletes a user owning only a cancelled incident', 'FAIL', sqlerrm);
  end;

  -- Trigger backstop: raw UPDATE profiles bypassing admin_set_user_active entirely, on d9.
  begin
    update profiles set active = false where id = '00000000-0000-0000-0000-0000000000d9';
    insert into results (test, result, detail) values
      ('trigger backstop allows raw deactivation of a user owning only a cancelled incident', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('trigger backstop allows raw deactivation of a user owning only a cancelled incident', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 5. create_handover excludes cancelled incidents
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
  declare
    v_handover handovers;
    v_item_count int;
  begin
    v_handover := create_handover(jsonb_build_object('toUserId', '00000000-0000-0000-0000-0000000000d3', 'generalNote', 'n'));
    select count(*) into v_item_count from handover_items
      where handover_id = v_handover.id and incident_id = '00000000-0000-0000-0000-00000000f412';
    insert into results (test, result, detail) values
      ('create_handover excludes a cancelled incident from its item list', case when v_item_count = 0 then 'PASS' else 'FAIL' end,
       'items_for_f412=' || v_item_count);
  end;

  -- =====================================================================
  -- 6. complete_follow_up rejected after cancelling a partial_readiness
  --    incident that had inherited follow_up_required = true.
  -- =====================================================================
  perform cancel_incident('00000000-0000-0000-0000-00000000f411',
    jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'cancellationReason', 'no longer needed'));
  select follow_up_required into v_active from incidents where id = '00000000-0000-0000-0000-00000000f411';
  insert into results (test, result, detail) values
    ('cancel_incident clears follow_up_required on a partial_readiness incident',
      case when v_active = false then 'PASS' else 'FAIL' end, 'follow_up_required=' || v_active);
  begin
    perform complete_follow_up('00000000-0000-0000-0000-00000000f411', 'done');
    insert into results (test, result, detail) values
      ('complete_follow_up rejects a cancelled incident even with inherited follow_up_required', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('complete_follow_up rejects a cancelled incident even with inherited follow_up_required',
        case when sqlerrm like 'invalid_transition%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 7. cancel_incident -- happy path, snapshot correctness, validation,
  --    mirrored status-check removal
  -- =====================================================================
  begin
    perform cancel_incident('00000000-0000-0000-0000-00000000f410', jsonb_build_object('eventTime', now()));
    insert into results (test, result, detail) values ('cancel_incident rejects missing expectedVersion', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('cancel_incident rejects missing expectedVersion',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform cancel_incident('00000000-0000-0000-0000-00000000f410', jsonb_build_object('expectedVersion', 1));
    insert into results (test, result, detail) values ('cancel_incident rejects missing eventTime', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('cancel_incident rejects missing eventTime',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  select count(*) into v_count from audit_logs where action = 'incident_cancelled' and entity_id = '00000000-0000-0000-0000-00000000f410';
  v_incident := cancel_incident('00000000-0000-0000-0000-00000000f410',
    jsonb_build_object('expectedVersion', 1, 'eventTime', now() - interval '2 hours', 'cancellationReason', 'no longer relevant'));
  insert into results (test, result, detail) values
    ('cancel_incident: resulting status is cancelled and version incremented',
      case when v_incident.status = 'cancelled' and v_incident.version = 2 then 'PASS' else 'FAIL' end,
      'status=' || v_incident.status || ' version=' || v_incident.version);
  insert into results (test, result, detail) values
    ('cancel_incident: cancelled_at = validated eventTime, not now()',
      case when abs(extract(epoch from (v_incident.cancelled_at - (now() - interval '2 hours')))) < 1
        and abs(extract(epoch from (v_incident.cancelled_at - now()))) > 3600 then 'PASS' else 'FAIL' end,
      'cancelled_at=' || v_incident.cancelled_at || ' now=' || now());
  insert into results (test, result, detail) values
    ('cancel_incident: updated_at and last_update_at both advanced past the backdated fixture value',
      case when v_incident.updated_at > '2020-01-01T00:00:00Z'::timestamptz
        and v_incident.last_update_at > '2020-01-01T00:00:00Z'::timestamptz then 'PASS' else 'FAIL' end,
      'updated_at=' || v_incident.updated_at || ' last_update_at=' || v_incident.last_update_at);

  select old_value, new_value, ref_id into v_event_old_value, v_event_new_value, v_event_ref_id
    from incident_events where incident_id = '00000000-0000-0000-0000-00000000f410' and type = 'cancelled';
  insert into results (test, result, detail) values
    ('cancel_incident event: old_value is the PRE-cancel status (in_progress), not cancelled',
      case when v_event_old_value = 'in_progress' and v_event_new_value = 'cancelled' then 'PASS' else 'FAIL' end,
      'old_value=' || v_event_old_value || ' new_value=' || v_event_new_value);

  select before_data, after_data into v_audit_before, v_audit_after from audit_logs
    where action = 'incident_cancelled' and entity_id = '00000000-0000-0000-0000-00000000f410'
    order by created_at desc limit 1;
  insert into results (test, result, detail) values
    ('cancel_incident audit before_data reflects pre-cancel status (in_progress)',
      case when v_audit_before->>'status' = 'in_progress' then 'PASS' else 'FAIL' end, v_audit_before::text);
  insert into results (test, result, detail) values
    ('cancel_incident audit after_data reflects post-cancel status and reason',
      case when v_audit_after->>'status' = 'cancelled' and v_audit_after->>'cancellationReason' = 'no longer relevant' then 'PASS' else 'FAIL' end,
      v_audit_after::text);

  -- Mirrored status-check removal on f414 (had a pending scheduled check).
  select status_check_due into v_before_incident.status_check_due from incidents where id = '00000000-0000-0000-0000-00000000f414';
  v_incident := cancel_incident('00000000-0000-0000-0000-00000000f414',
    jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'cancellationReason', 'no longer needed'));
  insert into results (test, result, detail) values
    ('cancel_incident nulls status_check_due when cancelling an incident with a pending check',
      case when v_incident.status_check_due is null then 'PASS' else 'FAIL' end, '');
  select count(*) into v_count from incident_status_checks
    where incident_id = '00000000-0000-0000-0000-00000000f414' and kind = 'removed'
      and note = 'בדיקת הסטטוס הוסרה באופן אוטומטי עקב ביטול התקלה';
  insert into results (test, result, detail) values
    ('cancel_incident inserts a "removed" incident_status_checks row with the exact deterministic note',
      case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  select id into v_status_check_id from incident_status_checks
    where incident_id = '00000000-0000-0000-0000-00000000f414' and kind = 'removed';
  select count(*) into v_count from incident_events
    where incident_id = '00000000-0000-0000-0000-00000000f414' and type = 'status_check_changed'
      and ref_id = v_status_check_id and new_value is null
      and note = 'בדיקת הסטטוס הוסרה באופן אוטומטי עקב ביטול התקלה';
  insert into results (test, result, detail) values
    ('cancel_incident mirrors the removal into incident_events with matching ref_id and identical note',
      case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  -- =====================================================================
  -- 8. add_incident_report
  -- =====================================================================
  begin
    perform add_incident_report('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'channel', 'ops_room', 'status', 'yes'));
    insert into results (test, result, detail) values ('add_incident_report rejects status=yes without recipient/performer/reportedAt', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('add_incident_report rejects status=yes without recipient/performer/reportedAt',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform add_incident_report('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'channel', 'ops_room', 'status', 'no',
        'recipient', 'not applicable'));
    insert into results (test, result, detail) values ('add_incident_report rejects recipient supplied when status<>yes', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('add_incident_report rejects recipient supplied when status<>yes',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform add_incident_report('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'channel', 'ops_room', 'status', 'yes',
        'reportedAt', now(), 'recipient', 'ops room', 'reportedByUserId', '00000000-0000-0000-0000-0000000000d5'));
    insert into results (test, result, detail) values ('add_incident_report rejects an inactive performer', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('add_incident_report rejects an inactive performer',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform add_incident_report('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'channel', 'ops_room', 'status', 'yes',
        'reportedAt', now(), 'recipient', 'ops room', 'reportedByUserId', '00000000-0000-0000-0000-0000000000d6'));
    insert into results (test, result, detail) values ('add_incident_report rejects a tombstoned performer', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('add_incident_report rejects a tombstoned performer',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  select count(*) into v_count from audit_logs where action = 'incident_report_recorded' and entity_id = '00000000-0000-0000-0000-00000000f415';
  v_incident := add_incident_report('00000000-0000-0000-0000-00000000f415',
    jsonb_build_object('expectedVersion', 1, 'eventTime', now() - interval '1 hour', 'channel', 'ops_communications',
      'status', 'yes', 'reportedAt', now() - interval '50 minutes', 'recipient', 'ops comms desk',
      'reportedByUserId', '00000000-0000-0000-0000-0000000000d7', 'note', 'called and confirmed'));
  insert into results (test, result, detail) values
    ('add_incident_report: version incremented and updated_at/last_update_at advanced past the backdated fixture value',
      case when v_incident.version = 2 and v_incident.updated_at > '2020-01-01T00:00:00Z'::timestamptz
        and v_incident.last_update_at > '2020-01-01T00:00:00Z'::timestamptz then 'PASS' else 'FAIL' end,
      'version=' || v_incident.version);
  select id into v_report_id from incident_report_events where incident_id = '00000000-0000-0000-0000-00000000f415';
  select ref_id, note into v_event_ref_id, v_event_old_value from incident_events
    where incident_id = '00000000-0000-0000-0000-00000000f415' and type = 'reported_to_ops_communications';
  insert into results (test, result, detail) values
    ('add_incident_report: exactly one mirrored incident_events row, ref_id points at the report row',
      case when v_event_ref_id = v_report_id then 'PASS' else 'FAIL' end, '');
  insert into results (test, result, detail) values
    ('add_incident_report: event note is exactly the user-supplied note, nothing appended',
      case when v_event_old_value = 'called and confirmed' then 'PASS' else 'FAIL' end, 'note=' || v_event_old_value);
  select count(*) into v_count from audit_logs where action = 'incident_report_recorded' and entity_id = '00000000-0000-0000-0000-00000000f415';
  insert into results (test, result, detail) values
    ('add_incident_report writes exactly one audit_logs entry', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  -- =====================================================================
  -- 9. set_incident_status_check -- full kind matrix
  -- =====================================================================
  begin
    perform set_incident_status_check('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 2, 'kind', 'not_a_real_kind', 'eventTime', now(), 'dueAt', now() + interval '1 day'));
    insert into results (test, result, detail) values ('set_incident_status_check rejects an invalid kind cleanly', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('set_incident_status_check rejects an invalid kind cleanly',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform set_incident_status_check('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 2, 'eventTime', now(), 'dueAt', now() + interval '1 day'));
    insert into results (test, result, detail) values ('set_incident_status_check rejects a missing kind cleanly', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('set_incident_status_check rejects a missing kind cleanly',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform set_incident_status_check('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 2, 'kind', 'scheduled', 'eventTime', now(),
        'dueAt', now() + interval '1 day', 'performedByUserId', '00000000-0000-0000-0000-0000000000d7',
        'performedByExternalName', 'Someone External'));
    insert into results (test, result, detail) values ('set_incident_status_check rejects both performer fields set', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('set_incident_status_check rejects both performer fields set',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform set_incident_status_check('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 2, 'kind', 'scheduled', 'eventTime', now(),
        'dueAt', now() + interval '1 day', 'nextDueAt', now() + interval '2 days'));
    insert into results (test, result, detail) values ('set_incident_status_check rejects nextDueAt for kind=scheduled', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('set_incident_status_check rejects nextDueAt for kind=scheduled',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- scheduled: persists note + performer.
  v_incident := set_incident_status_check('00000000-0000-0000-0000-00000000f415',
    jsonb_build_object('expectedVersion', 2, 'kind', 'scheduled', 'eventTime', now(),
      'dueAt', now() + interval '3 days', 'performedByUserId', '00000000-0000-0000-0000-0000000000d7',
      'note', 'first check'));
  select note, performed_by_user_id into v_event_old_value, v_status_check_id from incident_status_checks
    where incident_id = '00000000-0000-0000-0000-00000000f415' and kind = 'scheduled';
  insert into results (test, result, detail) values
    ('set_incident_status_check(scheduled): note and performer persisted on the detail row',
      case when v_event_old_value = 'first check' and v_status_check_id = '00000000-0000-0000-0000-0000000000d7' then 'PASS' else 'FAIL' end, '');
  select count(*) into v_count from incident_events where incident_id = '00000000-0000-0000-0000-00000000f415' and type = 'status_check_changed';
  insert into results (test, result, detail) values
    ('set_incident_status_check(scheduled): exactly one mirrored timeline event', case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);

  begin
    perform set_incident_status_check('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 3, 'kind', 'scheduled', 'eventTime', now(), 'dueAt', now() + interval '1 day'));
    insert into results (test, result, detail) values ('set_incident_status_check rejects scheduling when one already pending', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('set_incident_status_check rejects scheduling when one already pending',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- rescheduled
  v_incident := set_incident_status_check('00000000-0000-0000-0000-00000000f415',
    jsonb_build_object('expectedVersion', 3, 'kind', 'rescheduled', 'eventTime', now(), 'dueAt', now() + interval '5 days'));
  select count(*) into v_count from incident_status_checks where incident_id = '00000000-0000-0000-0000-00000000f415' and kind = 'rescheduled';
  insert into results (test, result, detail) values
    ('set_incident_status_check(rescheduled): one detail row created', case when v_count = 1 then 'PASS' else 'FAIL' end, '');

  -- removed
  v_incident := set_incident_status_check('00000000-0000-0000-0000-00000000f415',
    jsonb_build_object('expectedVersion', 4, 'kind', 'removed', 'eventTime', now()));
  insert into results (test, result, detail) values
    ('set_incident_status_check(removed): incidents.status_check_due nulled',
      case when v_incident.status_check_due is null then 'PASS' else 'FAIL' end, '');

  -- completed WITHOUT nextDueAt: must first schedule one to complete.
  v_incident := set_incident_status_check('00000000-0000-0000-0000-00000000f415',
    jsonb_build_object('expectedVersion', 5, 'kind', 'scheduled', 'eventTime', now(), 'dueAt', now() + interval '1 day'));
  begin
    perform set_incident_status_check('00000000-0000-0000-0000-00000000f415',
      jsonb_build_object('expectedVersion', 6, 'kind', 'completed', 'eventTime', now()));
    insert into results (test, result, detail) values ('set_incident_status_check(completed) requires an explicit performer', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('set_incident_status_check(completed) requires an explicit performer',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  v_incident := set_incident_status_check('00000000-0000-0000-0000-00000000f415',
    jsonb_build_object('expectedVersion', 6, 'kind', 'completed', 'eventTime', now(),
      'performedByUserId', '00000000-0000-0000-0000-0000000000d7'));
  select count(*) into v_count from incident_status_checks
    where incident_id = '00000000-0000-0000-0000-00000000f415' and kind = 'completed';
  insert into results (test, result, detail) values
    ('set_incident_status_check(completed, no nextDueAt): exactly one completed row',
      case when v_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  insert into results (test, result, detail) values
    ('set_incident_status_check(completed, no nextDueAt): status_check_due nulled',
      case when v_incident.status_check_due is null then 'PASS' else 'FAIL' end, '');

  -- completed WITH nextDueAt (compound path): two detail rows, two events,
  -- with nextDueAt deliberately equal to what the removed-and-rescheduled
  -- flow above already produced, to prove distinct ref_ids regardless.
  v_incident := set_incident_status_check('00000000-0000-0000-0000-00000000f415',
    jsonb_build_object('expectedVersion', 7, 'kind', 'scheduled', 'eventTime', now(), 'dueAt', now() + interval '10 days'));
  select count(*) into v_count from incident_status_checks where incident_id = '00000000-0000-0000-0000-00000000f415';
  insert into results (test, result, detail) values
    ('fixture: 6 detail rows exist before the compound completed+nextDueAt call', case when v_count = 6 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
  -- Every `now()` call within this single transaction returns the SAME
  -- (transaction-start) instant, so event_time/created_at cannot be used to
  -- order-and-limit to "the last N rows" -- capture ref_ids by explicit
  -- before/after set difference instead.
  select coalesce(array_agg(ref_id), '{}') into v_ref_ids_before
    from incident_events where incident_id = '00000000-0000-0000-0000-00000000f415' and type = 'status_check_changed';
  v_incident := set_incident_status_check('00000000-0000-0000-0000-00000000f415',
    jsonb_build_object('expectedVersion', 8, 'kind', 'completed', 'eventTime', now(),
      'performedByUserId', '00000000-0000-0000-0000-0000000000d7', 'nextDueAt', now() + interval '10 days'));
  select coalesce(array_agg(ref_id), '{}') into v_ref_ids_after
    from incident_events where incident_id = '00000000-0000-0000-0000-00000000f415' and type = 'status_check_changed';
  select count(*) into v_count from incident_status_checks where incident_id = '00000000-0000-0000-0000-00000000f415';
  insert into results (test, result, detail) values
    ('set_incident_status_check(completed + nextDueAt): exactly TWO new detail rows inserted in one call',
      case when v_count = 8 then 'PASS' else 'FAIL' end, 'rows_after=' || v_count);
  insert into results (test, result, detail) values
    ('set_incident_status_check(completed + nextDueAt): status_check_due mirrors the next due date',
      case when v_incident.status_check_due is not null then 'PASS' else 'FAIL' end, '');
  select array(select unnest(v_ref_ids_after) except select unnest(v_ref_ids_before)) into v_new_ref_ids;
  insert into results (test, result, detail) values
    ('set_incident_status_check(completed + nextDueAt): exactly TWO new, mutually DISTINCT mirrored events created',
      case when array_length(v_new_ref_ids, 1) = 2 and v_new_ref_ids[1] <> v_new_ref_ids[2] then 'PASS' else 'FAIL' end,
      'new_ref_ids=' || v_new_ref_ids::text);

  select count(*) into v_count from audit_logs where action = 'incident_status_check_recorded' and entity_id = '00000000-0000-0000-0000-00000000f415';
  insert into results (test, result, detail) values
    ('set_incident_status_check writes one audit_logs entry per call (7 successful calls, incl. the compound one)',
      case when v_count = 7 then 'PASS' else 'FAIL' end, 'rows=' || v_count);
end $$;

-- =====================================================================
-- 10. PUBLIC / anon / authenticated EXECUTE absence -- effective-ACL
--     inspection (NOT has_function_privilege('public', ...), which cannot
--     test the PUBLIC pseudo-role; NOT bare aclexplode(proacl), which is
--     NULL -- and therefore matches nothing -- until an explicit GRANT/
--     REVOKE has touched the object).
-- =====================================================================
insert into results (test, result, detail)
select 'no PUBLIC EXECUTE on any of the 4 new/changed functions',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('cancel_incident', 'add_incident_report', 'set_incident_status_check', 'assert_active_profile_if_set')
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'no anon EXECUTE on any of the 4 new/changed functions',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('cancel_incident', 'add_incident_report', 'set_incident_status_check', 'assert_active_profile_if_set')
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'no authenticated EXECUTE on the 3 gated client RPCs (pre-frontend-cutover)',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('cancel_incident', 'add_incident_report', 'set_incident_status_check')
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'no authenticated EXECUTE on the internal helper',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'assert_active_profile_if_set'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
