-- Focused verification for migration 0042_system_audit_log.sql.
-- Runs only against the local scratch database created by tests/run.sh.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000004201', 'audit-admin@test', now()),
  ('00000000-0000-0000-0000-000000004202', 'audit-pm@test', now()),
  ('00000000-0000-0000-0000-000000004203', 'audit-supervisor@test', now()),
  ('00000000-0000-0000-0000-000000004204', 'audit-tech@test', now()),
  ('00000000-0000-0000-0000-000000004205', 'audit-viewer@test', now()),
  ('00000000-0000-0000-0000-000000004206', 'audit-role-target@test', now()),
  ('00000000-0000-0000-0000-000000004207', 'audit-active-target@test', now()),
  ('00000000-0000-0000-0000-000000004208', 'audit-delete-target@test', now()),
  ('00000000-0000-0000-0000-000000004209', 'audit-peer-target@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000004201', 'Audit Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-000000004202', 'Audit PM', 'professional_manager', true),
  ('00000000-0000-0000-0000-000000004203', 'Audit Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-000000004204', 'Audit Tech', 'technician', true),
  ('00000000-0000-0000-0000-000000004205', 'Audit Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-000000004206', 'Audit Role Target', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-000000004207', 'Audit Active Target', 'technician', true),
  ('00000000-0000-0000-0000-000000004208', 'Audit Delete Target', 'technician', true),
  ('00000000-0000-0000-0000-000000004209', 'Audit Peer Target', 'shift_supervisor', true);

insert into systems (id, name, display_order, category) values
  ('00000000-0000-0000-0000-000000004221', 'Audit Sys', 1, 'other');
insert into locations (id, name, display_order, category) values
  ('00000000-0000-0000-0000-000000004222', 'Audit Loc', 1, 'other');

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p_user_id uuid) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', p_user_id::text, false),
         set_config(
           'request.jwt.claims',
           json_build_object('sub', p_user_id, 'role', 'authenticated')::text,
           false
         );
$$;

create or replace function pg_temp.check_result(
  p_test text,
  p_ok boolean,
  p_detail text default ''
) returns void
language sql as $$
  insert into results (test, result, detail)
  values (p_test, case when p_ok then 'PASS' else 'FAIL' end, coalesce(p_detail, ''));
$$;
grant execute on function pg_temp.check_result(text, boolean, text) to authenticated;

-- =====================================================================
-- Section A: grants -- write_audit is unreachable directly; list_audit_events
-- is authenticated-only (its own internal role check does the real gating).
-- =====================================================================
select pg_temp.check_result(
  'write_audit is not directly executable by authenticated, anon, or PUBLIC',
  not has_function_privilege('authenticated',
    'public.write_audit(text,text,text,text,jsonb,jsonb,text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.write_audit(text,text,text,text,jsonb,jsonb,text,text,jsonb)', 'EXECUTE')
  and not exists (
    select 1
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace,
         aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
    where namespace.nspname = 'public'
      and procedure.proname = 'write_audit'
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  )
);

select pg_temp.check_result(
  'list_audit_events is executable by authenticated, not by anon',
  has_function_privilege('authenticated',
    'public.list_audit_events(int,int,timestamptz,timestamptz,uuid,text,text,text)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.list_audit_events(int,int,timestamptz,timestamptz,uuid,text,text,text)', 'EXECUTE')
);

-- =====================================================================
-- Section B: direct table access is closed regardless of role, including
-- for an active system_admin -- append-only is enforced structurally, not
-- by role.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004201');
  set local role authenticated;
  begin
    insert into audit_logs (action, entity_type, entity_id)
    values ('forged_action', 'profile', '00000000-0000-0000-0000-000000004201');
    perform pg_temp.check_result('direct audit_logs INSERT is blocked (even for system_admin)', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'direct audit_logs INSERT is blocked (even for system_admin)', sqlstate = '42501', sqlerrm
    );
  end;
  begin
    update audit_logs set action = 'tampered' where true;
    perform pg_temp.check_result('direct audit_logs UPDATE is blocked (even for system_admin)', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'direct audit_logs UPDATE is blocked (even for system_admin)', sqlstate = '42501', sqlerrm
    );
  end;
  begin
    delete from audit_logs where true;
    perform pg_temp.check_result('direct audit_logs DELETE is blocked (even for system_admin)', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'direct audit_logs DELETE is blocked (even for system_admin)', sqlstate = '42501', sqlerrm
    );
  end;
  begin
    perform write_audit('forged_action', 'profile', '00000000-0000-0000-0000-000000004201');
    perform pg_temp.check_result('write_audit is not directly callable (even by system_admin)', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'write_audit is not directly callable (even by system_admin)', sqlstate = '42501', sqlerrm
    );
  end;
  reset role;
end;
$$;

-- =====================================================================
-- Section C: personnel actions -- representative mutations, entity_label,
-- before/after values, and a rejected mutation writing no event.
-- =====================================================================
do $$
declare
  v_before_count int;
  v_after_count int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004201');
  set local role authenticated;

  perform admin_set_user_role('00000000-0000-0000-0000-000000004206', 'technician');
  reset role;

  perform pg_temp.check_result(
    'admin_set_user_role writes exactly one event with correct before/after and entity_label',
    (
      select count(*) = 1 from audit_logs
      where action = 'user_role_changed'
        and entity_id = '00000000-0000-0000-0000-000000004206'
        and before_data = jsonb_build_object('role', 'shift_supervisor')
        and after_data = jsonb_build_object('role', 'technician')
        and entity_label = 'Audit Role Target'
        and actor_id = '00000000-0000-0000-0000-000000004201'
        and actor_display_name = 'Audit Admin'
        and actor_email = 'audit-admin@test'
    )
  );

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004201');
  set local role authenticated;
  perform admin_set_user_active('00000000-0000-0000-0000-000000004207', false);
  reset role;

  perform pg_temp.check_result(
    'admin_set_user_active(false) writes user_deactivated with entity_label',
    exists (
      select 1 from audit_logs
      where action = 'user_deactivated'
        and entity_id = '00000000-0000-0000-0000-000000004207'
        and entity_label = 'Audit Active Target'
        and after_data = jsonb_build_object('active', false)
    )
  );

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004201');
  set local role authenticated;
  perform admin_delete_user('00000000-0000-0000-0000-000000004208');
  reset role;

  perform pg_temp.check_result(
    'admin_delete_user writes user_tombstoned with entity_label',
    exists (
      select 1 from audit_logs
      where action = 'user_tombstoned'
        and entity_id = '00000000-0000-0000-0000-000000004208'
        and entity_label = 'Audit Delete Target'
    )
  );

  -- Rejected mutation: a shift_supervisor may not manage another
  -- shift_supervisor's role (role_ceiling_allows_manage excludes peers) --
  -- confirm zero new audit rows result from the rejected call.
  select count(*) into v_before_count from audit_logs;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004203');
  set local role authenticated;
  begin
    perform admin_set_user_role('00000000-0000-0000-0000-000000004209', 'viewer');
    perform pg_temp.check_result('rejected admin_set_user_role is actually rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'rejected admin_set_user_role is actually rejected', sqlerrm like 'permission:%', sqlerrm
    );
  end;
  reset role;
  select count(*) into v_after_count from audit_logs;
  perform pg_temp.check_result(
    'a rejected personnel mutation creates no audit event',
    v_before_count = v_after_count,
    format('before=%s after=%s', v_before_count, v_after_count)
  );
end;
$$;

-- =====================================================================
-- Section D: systems -- representative reference-data mutation, entity_label,
-- and a rejected mutation (duplicate name) writing no event.
-- =====================================================================
do $$
declare
  v_system systems;
  v_before_count int;
  v_after_count int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004201');
  set local role authenticated;
  select * into v_system from rename_system('00000000-0000-0000-0000-000000004221', 'Audit Sys Renamed');
  reset role;

  perform pg_temp.check_result(
    'rename_system writes system_renamed with entity_label = new name',
    exists (
      select 1 from audit_logs
      where action = 'system_renamed'
        and entity_id = '00000000-0000-0000-0000-000000004221'
        and entity_label = 'Audit Sys Renamed'
        and before_data = jsonb_build_object('name', 'Audit Sys')
        and after_data = jsonb_build_object('name', 'Audit Sys Renamed')
    )
  );

  select count(*) into v_before_count from audit_logs;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004201');
  set local role authenticated;
  begin
    perform rename_system('00000000-0000-0000-0000-000000004221', 'Audit Sys Renamed');
    reset role;
  exception when others then
    reset role;
  end;
  select count(*) into v_after_count from audit_logs;
  perform pg_temp.check_result(
    'renaming a system to its own current name is a no-op that writes no event',
    v_before_count = v_after_count
  );
end;
$$;

-- =====================================================================
-- Section E: incidents -- created / status-changed / severity-changed /
-- material-field-updated / no-op-gated / external-handler-changed /
-- assigned / closed / reopened / cancelled, plus a rejected mutation.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_incident2 incidents;
  v_version int;
  v_before_count int;
  v_after_count int;
  v_base jsonb := jsonb_build_object(
    'description', 'Audit test incident',
    'operationalImpact', 'Original impact',
    'actionsTaken', 'Initial actions',
    'severity', 'medium',
    'status', 'in_progress',
    'systemId', '00000000-0000-0000-0000-000000004221',
    'locationId', '00000000-0000-0000-0000-000000004222',
    'ownerUserId', '00000000-0000-0000-0000-000000004201',
    'discoveredAt', now()::text,
    'reportedToOps', 'no',
    'reportedToComms', 'false',
    'wisdomReported', 'false'
  );
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004201');
  set local role authenticated;

  select * into v_incident from create_incident(v_base);
  v_version := v_incident.version;

  perform pg_temp.check_result(
    'create_incident writes exactly one incident_created event with entity_label = number',
    (
      select count(*) = 1 from audit_logs
      where action = 'incident_created' and entity_id = v_incident.id::text and entity_label = v_incident.number
    )
  );

  -- #1: status change only (in_progress -> waiting_test).
  select * into v_incident from update_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'eventTime', now()::text,
    'status', 'waiting_test', 'severity', 'medium', 'ownerUserId', '00000000-0000-0000-0000-000000004201',
    'operationalImpact', 'Original impact', 'actionsTaken', 'moving to waiting_test', 'changeReason', 'testing'
  ));
  v_version := v_incident.version;
  perform pg_temp.check_result(
    'a structured status change writes a dedicated incident_status_changed event',
    exists (
      select 1 from audit_logs
      where action = 'incident_status_changed' and entity_id = v_incident.id::text
        and before_data = jsonb_build_object('status', 'in_progress')
        and after_data = jsonb_build_object('status', 'waiting_test')
    )
  );
  perform pg_temp.check_result(
    'a status-only update writes no generic incident_updated event',
    not exists (select 1 from audit_logs where action = 'incident_updated' and entity_id = v_incident.id::text)
  );

  -- #2: severity change only.
  select * into v_incident from update_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'eventTime', now()::text,
    'status', 'waiting_test', 'severity', 'high', 'ownerUserId', '00000000-0000-0000-0000-000000004201',
    'operationalImpact', 'Original impact', 'actionsTaken', 'severity bump'
  ));
  v_version := v_incident.version;
  perform pg_temp.check_result(
    'a severity change writes incident_severity_changed with correct before/after',
    exists (
      select 1 from audit_logs
      where action = 'incident_severity_changed' and entity_id = v_incident.id::text
        and before_data = jsonb_build_object('severity', 'medium')
        and after_data = jsonb_build_object('severity', 'high')
    )
  );

  -- #3: operational_impact change only -- the "other material field" path.
  select * into v_incident from update_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'eventTime', now()::text,
    'status', 'waiting_test', 'severity', 'high', 'ownerUserId', '00000000-0000-0000-0000-000000004201',
    'operationalImpact', 'New impact text', 'actionsTaken', 'impact update'
  ));
  v_version := v_incident.version;
  perform pg_temp.check_result(
    'an operational-impact-only change writes exactly one incident_updated event scoped to that field',
    (
      select count(*) = 1 from audit_logs
      where action = 'incident_updated' and entity_id = v_incident.id::text
        and before_data = jsonb_build_object('operationalImpact', 'Original impact')
        and after_data = jsonb_build_object('operationalImpact', 'New impact text')
    )
  );

  -- #4: true no-op -- identical status/severity/owner/impact/due/external
  -- handler, only new treatment-update content. Must write zero new rows.
  select count(*) into v_before_count from audit_logs where entity_id = v_incident.id::text;
  select * into v_incident from update_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'eventTime', now()::text,
    'status', 'waiting_test', 'severity', 'high', 'ownerUserId', '00000000-0000-0000-0000-000000004201',
    'operationalImpact', 'New impact text', 'actionsTaken', 'no material change, just a progress note'
  ));
  v_version := v_incident.version;
  select count(*) into v_after_count from audit_logs where entity_id = v_incident.id::text;
  perform pg_temp.check_result(
    'a no-op update (no material field changed) writes zero audit events',
    v_before_count = v_after_count,
    format('before=%s after=%s', v_before_count, v_after_count)
  );

  -- #5: external handler change only.
  select * into v_incident from update_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'eventTime', now()::text,
    'status', 'waiting_test', 'severity', 'high', 'ownerUserId', '00000000-0000-0000-0000-000000004201',
    'operationalImpact', 'New impact text', 'actionsTaken', 'external handler noted',
    'externalHandlerName', 'Acme Corp'
  ));
  v_version := v_incident.version;
  perform pg_temp.check_result(
    'an external-handler change writes a dedicated incident_external_handler_changed event',
    exists (
      select 1 from audit_logs
      where action = 'incident_external_handler_changed' and entity_id = v_incident.id::text
        and after_data ->> 'externalHandlerName' = 'Acme Corp'
    )
  );

  -- #6: owner reassignment via assign_incident (external handler unchanged
  -- -- must not fabricate a second external-handler-changed event).
  select count(*) into v_before_count from audit_logs
    where entity_id = v_incident.id::text and action = 'incident_external_handler_changed';
  select * into v_incident from assign_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'ownerUserId', '00000000-0000-0000-0000-000000004202'
  ));
  v_version := v_incident.version;
  select count(*) into v_after_count from audit_logs
    where entity_id = v_incident.id::text and action = 'incident_external_handler_changed';
  perform pg_temp.check_result(
    'assign_incident (owner-only change) writes incident_assigned and no extra external-handler event',
    exists (
      select 1 from audit_logs
      where action = 'incident_assigned' and entity_id = v_incident.id::text
        and after_data ->> 'owner' = 'Audit PM'
    )
    and v_before_count = v_after_count
  );

  -- #7: assign_incident with the SAME owner but a changed external handler
  -- -- must not fabricate a second incident_assigned event.
  select count(*) into v_before_count from audit_logs
    where entity_id = v_incident.id::text and action = 'incident_assigned';
  select * into v_incident from assign_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'ownerUserId', '00000000-0000-0000-0000-000000004202',
    'externalHandlerName', 'Acme Corp v2'
  ));
  v_version := v_incident.version;
  select count(*) into v_after_count from audit_logs
    where entity_id = v_incident.id::text and action = 'incident_assigned';
  perform pg_temp.check_result(
    'assign_incident (external-handler-only change) writes no extra incident_assigned event',
    v_before_count = v_after_count
    and exists (
      select 1 from audit_logs
      where action = 'incident_external_handler_changed' and entity_id = v_incident.id::text
        and after_data ->> 'externalHandlerName' = 'Acme Corp v2'
    )
  );

  -- #8: close (full readiness).
  select * into v_incident from close_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'eventTime', now()::text,
    'readiness', 'full', 'rootCause', 'Root cause text', 'resolution', 'Resolution text',
    'reportedToOps', 'no'
  ));
  v_version := v_incident.version;
  perform pg_temp.check_result(
    'close_incident writes incident_closed with previous and new status',
    exists (
      select 1 from audit_logs
      where action = 'incident_closed' and entity_id = v_incident.id::text
        and before_data = jsonb_build_object('status', 'waiting_test')
        and after_data = jsonb_build_object('status', 'closed', 'readiness', 'full')
    )
  );

  -- #9: reopen.
  select * into v_incident from reopen_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'reason', 'Needs more work',
    'ownerUserId', '00000000-0000-0000-0000-000000004202'
  ));
  v_version := v_incident.version;
  perform pg_temp.check_result(
    'reopen_incident writes incident_reopened with the reason as summary',
    exists (
      select 1 from audit_logs
      where action = 'incident_reopened' and entity_id = v_incident.id::text and summary = 'Needs more work'
    )
  );

  -- #10: rejected mutation (direct transition to 'closed' via update_incident,
  -- only permitted through the dedicated close_incident flow) writes no event.
  select count(*) into v_before_count from audit_logs where entity_id = v_incident.id::text;
  begin
    perform update_incident(v_incident.id, jsonb_build_object(
      'expectedVersion', v_version, 'eventTime', now()::text,
      'status', 'closed', 'severity', 'high', 'ownerUserId', '00000000-0000-0000-0000-000000004202',
      'operationalImpact', 'New impact text', 'actionsTaken', 'invalid transition attempt'
    ));
    perform pg_temp.check_result('an invalid status transition is actually rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'an invalid status transition is actually rejected', sqlerrm like 'invalid_transition:%', sqlerrm
    );
  end;
  select count(*) into v_after_count from audit_logs where entity_id = v_incident.id::text;
  perform pg_temp.check_result(
    'a rejected incident mutation creates no audit event',
    v_before_count = v_after_count,
    format('before=%s after=%s', v_before_count, v_after_count)
  );

  -- Second incident: cancel_incident, on a fresh non-terminal incident.
  select * into v_incident2 from create_incident(v_base);
  select * into v_incident2 from cancel_incident(v_incident2.id, jsonb_build_object(
    'expectedVersion', v_incident2.version, 'eventTime', now()::text,
    'cancellationReason', 'Duplicate report'
  ));
  perform pg_temp.check_result(
    'cancel_incident writes incident_cancelled with the reason as summary',
    exists (
      select 1 from audit_logs
      where action = 'incident_cancelled' and entity_id = v_incident2.id::text
        and summary = 'Duplicate report'
        and before_data = jsonb_build_object('status', 'in_progress')
        and after_data ->> 'status' = 'cancelled'
    )
  );

  reset role;
end;
$$;

-- =====================================================================
-- Section F: read access -- system_admin and professional_manager only,
-- with professional_manager reaching FULL parity (not restricted to a
-- subset of entity types).
-- =====================================================================
do $$
declare
  v_count int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004201');
  set local role authenticated;
  select count(*) into v_count from audit_logs;
  reset role;
  perform pg_temp.check_result('system_admin can read the audit log directly', v_count > 0, v_count::text);

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004202');
  set local role authenticated;
  select count(*) into v_count from audit_logs;
  reset role;
  perform pg_temp.check_result('professional_manager can read the audit log directly', v_count > 0, v_count::text);

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004202');
  set local role authenticated;
  select count(*) into v_count from audit_logs where entity_type = 'profile';
  reset role;
  perform pg_temp.check_result(
    'professional_manager reads non-incident entity types too (full parity, not a subset)', v_count > 0, v_count::text
  );

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004203');
  set local role authenticated;
  select count(*) into v_count from audit_logs;
  reset role;
  perform pg_temp.check_result('shift_supervisor cannot read the audit log', v_count = 0, v_count::text);

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004204');
  set local role authenticated;
  select count(*) into v_count from audit_logs;
  reset role;
  perform pg_temp.check_result('technician cannot read the audit log', v_count = 0, v_count::text);

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004205');
  set local role authenticated;
  select count(*) into v_count from audit_logs;
  reset role;
  perform pg_temp.check_result('viewer cannot read the audit log', v_count = 0, v_count::text);
end;
$$;

-- =====================================================================
-- Section G: list_audit_events -- role gating, bounded pagination, filters,
-- and search.
-- =====================================================================
do $$
declare
  v_real_total bigint;
  v_row record;
  v_count int;
begin
  select count(*) into v_real_total from audit_logs;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004201');
  set local role authenticated;

  select * into v_row from list_audit_events(p_limit => 1, p_offset => 0) limit 1;
  perform pg_temp.check_result(
    'list_audit_events reports the true total_count even when the page is small',
    v_row.total_count = v_real_total,
    format('total_count=%s real=%s', v_row.total_count, v_real_total)
  );

  perform pg_temp.check_result(
    'list_audit_events with p_limit=1 returns exactly one row',
    (select count(*) from list_audit_events(p_limit => 1, p_offset => 0)) = 1
  );

  perform pg_temp.check_result(
    'list_audit_events clamps a below-minimum limit up to 1, never to 0 or unbounded',
    (select count(*) from list_audit_events(p_limit => 0, p_offset => 0)) = 1
  );

  perform pg_temp.check_result(
    'list_audit_events clamps an excessive limit request without erroring',
    (select count(*) from list_audit_events(p_limit => 999999, p_offset => 0)) <= 100
  );

  select count(*) into v_count from list_audit_events(p_limit => 100, p_entity_type => 'incident');
  perform pg_temp.check_result(
    'list_audit_events entity_type filter returns only matching rows',
    v_count > 0
    and not exists (
      select 1 from list_audit_events(p_limit => 100, p_entity_type => 'incident') r where r.entity_type <> 'incident'
    )
  );

  perform pg_temp.check_result(
    'list_audit_events action filter returns only matching rows',
    (
      select count(*) from list_audit_events(p_limit => 100, p_action => 'user_role_changed')
      where action <> 'user_role_changed'
    ) = 0
    and (select count(*) from list_audit_events(p_limit => 100, p_action => 'user_role_changed')) >= 1
  );

  perform pg_temp.check_result(
    'list_audit_events actor filter returns only that actor''s rows',
    (
      select count(*) from list_audit_events(p_limit => 100, p_actor_id => '00000000-0000-0000-0000-000000004201')
      where actor_id <> '00000000-0000-0000-0000-000000004201'
    ) = 0
  );

  perform pg_temp.check_result(
    'list_audit_events search matches entity_label',
    exists (
      select 1 from list_audit_events(p_limit => 100, p_search => 'Audit Sys Renamed')
      where entity_label = 'Audit Sys Renamed'
    )
  );

  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004205');
  set local role authenticated;
  begin
    perform count(*) from list_audit_events(p_limit => 10);
    perform pg_temp.check_result('viewer is rejected by list_audit_events', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('viewer is rejected by list_audit_events', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004204');
  set local role authenticated;
  begin
    perform count(*) from list_audit_events(p_limit => 10);
    perform pg_temp.check_result('technician is rejected by list_audit_events', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('technician is rejected by list_audit_events', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004203');
  set local role authenticated;
  begin
    perform count(*) from list_audit_events(p_limit => 10);
    perform pg_temp.check_result('shift_supervisor is rejected by list_audit_events', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('shift_supervisor is rejected by list_audit_events', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;
end;
$$;

select
  id, test, result, detail
from results
order by id;

select
  case when count(*) filter (where result = 'FAIL') = 0
    then format('ALL %s CHECKS PASS', count(*))
    else format('%s FAILURES OF %s', count(*) filter (where result = 'FAIL'), count(*))
  end as summary
from results;

rollback;
