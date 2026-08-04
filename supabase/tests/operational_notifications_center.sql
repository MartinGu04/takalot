-- Focused verification for migrations 0043/0044 (operational notifications
-- center): role-based professional_manager broadcasts alongside the
-- existing personal notifications, category classification, dedup/rollback
-- safety, and RLS. Runs only against the local scratch database created by
-- tests/run.sh, in one transaction that rolls back at the end.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000005201', 'ntf-pm-actor@test', now()),
  ('00000000-0000-0000-0000-000000005202', 'ntf-pm-one@test', now()),
  ('00000000-0000-0000-0000-000000005203', 'ntf-pm-two@test', now()),
  ('00000000-0000-0000-0000-000000005204', 'ntf-pm-inactive@test', now()),
  ('00000000-0000-0000-0000-000000005205', 'ntf-supervisor@test', now()),
  ('00000000-0000-0000-0000-000000005206', 'ntf-tech-owner@test', now()),
  ('00000000-0000-0000-0000-000000005207', 'ntf-viewer@test', now()),
  ('00000000-0000-0000-0000-000000005208', 'ntf-admin@test', now()),
  ('00000000-0000-0000-0000-000000005209', 'ntf-pm-owner@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000005201', 'PM Actor', 'professional_manager', true),
  ('00000000-0000-0000-0000-000000005202', 'PM One', 'professional_manager', true),
  ('00000000-0000-0000-0000-000000005203', 'PM Two', 'professional_manager', true),
  ('00000000-0000-0000-0000-000000005204', 'PM Inactive', 'professional_manager', false),
  ('00000000-0000-0000-0000-000000005205', 'Notif Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-000000005206', 'Tech Owner', 'technician', true),
  ('00000000-0000-0000-0000-000000005207', 'Notif Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-000000005208', 'Notif Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-000000005209', 'PM Owner', 'professional_manager', true);

insert into systems (id, name, display_order, category) values
  ('00000000-0000-0000-0000-000000005221', 'Notif Sys', 1, 'other');
insert into locations (id, name, display_order, category) values
  ('00000000-0000-0000-0000-000000005222', 'Notif Loc', 1, 'other');

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

create or replace function pg_temp.check_result(p_test text, p_ok boolean, p_detail text default '')
returns void language sql as $$
  insert into results (test, result, detail)
  values (p_test, case when p_ok then 'PASS' else 'FAIL' end, coalesce(p_detail, ''));
$$;
grant execute on function pg_temp.check_result(text, boolean, text) to authenticated;

-- Every PM broadcast recipient's notification count/category/type for a
-- given incident, in one place -- used repeatedly below.
create or replace function pg_temp.pm_count(p_user_id uuid, p_incident_id uuid, p_type notification_type)
returns int language sql as $$
  select count(*)::int from notifications
  where user_id = p_user_id and incident_id = p_incident_id and type = p_type;
$$;

create or replace function pg_temp.base_create_input(p_owner uuid, extra jsonb default '{}'::jsonb) returns jsonb
language sql as $$
  select jsonb_build_object(
    'description', 'Notif test incident', 'operationalImpact', 'Impact', 'actionsTaken', 'Initial actions',
    'severity', 'medium', 'status', 'in_progress',
    'systemId', '00000000-0000-0000-0000-000000005221', 'locationId', '00000000-0000-0000-0000-000000005222',
    'ownerUserId', p_owner, 'discoveredAt', now()::text,
    'reportedToOps', 'no', 'reportedToComms', 'false', 'wisdomReported', 'false'
  ) || extra;
$$;
grant execute on function pg_temp.base_create_input(uuid, jsonb) to authenticated;

do $$
declare
  v_incident incidents;
  v_incident2 incidents;
  v_incident3 incidents;
  v_version int;
  v_before int;
  v_after int;
begin
  -- =====================================================================
  -- 1. create_incident: every active professional_manager except the actor
  --    is notified ('incident_opened', category 'update'); the inactive PM
  --    is excluded; the non-PM owner instead gets a personal, action_required
  --    'incident_assigned' notification, and never a duplicate broadcast row.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005205'); -- actor: shift_supervisor (not a PM)
  set local role authenticated;
  select * into v_incident from create_incident(
    pg_temp.base_create_input('00000000-0000-0000-0000-000000005206')); -- owner: technician
  reset role;

  perform pg_temp.check_result(
    'create_incident notifies every active professional_manager except the actor',
    pg_temp.pm_count('00000000-0000-0000-0000-000000005201', v_incident.id, 'incident_opened') = 1
    and pg_temp.pm_count('00000000-0000-0000-0000-000000005202', v_incident.id, 'incident_opened') = 1
    and pg_temp.pm_count('00000000-0000-0000-0000-000000005203', v_incident.id, 'incident_opened') = 1
    and pg_temp.pm_count('00000000-0000-0000-0000-000000005209', v_incident.id, 'incident_opened') = 1
  );
  perform pg_temp.check_result(
    'create_incident excludes an inactive professional_manager',
    pg_temp.pm_count('00000000-0000-0000-0000-000000005204', v_incident.id, 'incident_opened') = 0
  );
  perform pg_temp.check_result(
    'create_incident excludes non-professional_manager roles (supervisor actor, viewer, system_admin)',
    (select count(*) from notifications where incident_id = v_incident.id
       and user_id in ('00000000-0000-0000-0000-000000005205', '00000000-0000-0000-0000-000000005207',
                        '00000000-0000-0000-0000-000000005208')) = 0
  );
  perform pg_temp.check_result(
    'create_incident: the operational broadcast text carries the incident number, system, and location',
    exists (
      select 1 from notifications
      where user_id = '00000000-0000-0000-0000-000000005202' and incident_id = v_incident.id
        and type = 'incident_opened'
        and text = 'נפתחה תקלה ' || v_incident.number || ' · Notif Sys · Notif Loc'
    )
  );
  perform pg_temp.check_result(
    'create_incident: the non-PM owner gets a personal, action_required incident_assigned notification',
    exists (
      select 1 from notifications
      where user_id = '00000000-0000-0000-0000-000000005206' and incident_id = v_incident.id
        and type = 'incident_assigned' and category = 'action_required'
    )
  );
  perform pg_temp.check_result(
    'every professional-manager operational notification just created is category=update',
    not exists (
      select 1 from notifications
      where incident_id = v_incident.id and type = 'incident_opened' and category <> 'update'
    )
  );

  -- =====================================================================
  -- 2. create_incident with a PM owner: the owner gets ONLY the personal
  --    incident_assigned notification, never also the generic broadcast --
  --    the personal notification takes precedence (no duplicate for the
  --    same operation).
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005205');
  set local role authenticated;
  select * into v_incident2 from create_incident(
    pg_temp.base_create_input('00000000-0000-0000-0000-000000005209')); -- owner: PM Owner
  reset role;

  perform pg_temp.check_result(
    'a professional-manager owner gets the personal notification, not also the operational one, for the same create',
    pg_temp.pm_count('00000000-0000-0000-0000-000000005209', v_incident2.id, 'incident_assigned') = 1
    and pg_temp.pm_count('00000000-0000-0000-0000-000000005209', v_incident2.id, 'incident_opened') = 0
  );
  perform pg_temp.check_result(
    'other active professional managers still get the operational broadcast for that same creation',
    pg_temp.pm_count('00000000-0000-0000-0000-000000005201', v_incident2.id, 'incident_opened') = 1
    and pg_temp.pm_count('00000000-0000-0000-0000-000000005202', v_incident2.id, 'incident_opened') = 1
    and pg_temp.pm_count('00000000-0000-0000-0000-000000005203', v_incident2.id, 'incident_opened') = 1
  );
  perform pg_temp.check_result(
    'the personal notification received by the professional-manager owner is action_required',
    exists (
      select 1 from notifications where user_id = '00000000-0000-0000-0000-000000005209'
        and incident_id = v_incident2.id and type = 'incident_assigned' and category = 'action_required'
    )
  );

  -- =====================================================================
  -- 3. update_incident (operational flow): every successful call notifies
  --    active professional managers with 'incident_updated'/'update',
  --    unconditionally (a treatment update was added).
  -- =====================================================================
  v_version := v_incident.version;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005205');
  set local role authenticated;
  select * into v_incident from update_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'eventTime', now()::text,
    'status', 'in_progress', 'severity', 'medium', 'ownerUserId', '00000000-0000-0000-0000-000000005206',
    'operationalImpact', 'Impact', 'actionsTaken', 'progress note'
  ));
  reset role;
  v_version := v_incident.version;

  perform pg_temp.check_result(
    'update_incident (operational flow) notifies active professional managers with incident_updated/update',
    pg_temp.pm_count('00000000-0000-0000-0000-000000005202', v_incident.id, 'incident_updated') = 1
    and exists (
      select 1 from notifications where user_id = '00000000-0000-0000-0000-000000005202'
        and incident_id = v_incident.id and type = 'incident_updated' and category = 'update'
        and text = 'נוסף עדכון לתקלה ' || v_incident.number || ' על ידי Notif Supervisor'
    )
  );
  perform pg_temp.check_result(
    'update_incident (operational flow) still excludes the inactive professional manager',
    pg_temp.pm_count('00000000-0000-0000-0000-000000005204', v_incident.id, 'incident_updated') = 0
  );

  -- =====================================================================
  -- 4. technician_update_incident: same broadcast, from the technician
  --    update flow.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005206'); -- Tech Owner, owns v_incident
  set local role authenticated;
  select * into v_incident from technician_update_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'eventTime', now()::text,
    'actionsTaken', 'technician actions', 'findings', 'f', 'nextSteps', 'n', 'currentStatusText', 'ok'
  ));
  reset role;
  v_version := v_incident.version;

  perform pg_temp.check_result(
    'technician_update_incident notifies active professional managers with incident_updated/update',
    pg_temp.pm_count('00000000-0000-0000-0000-000000005202', v_incident.id, 'incident_updated') = 2 -- one from #3, one from this call
    and exists (
      select 1 from notifications where user_id = '00000000-0000-0000-0000-000000005203'
        and incident_id = v_incident.id and type = 'incident_updated' and category = 'update'
        and text = 'נוסף עדכון לתקלה ' || v_incident.number || ' על ידי Tech Owner'
    )
  );

  -- =====================================================================
  -- 5. close_incident (full readiness): notifies professional managers with
  --    incident_closed/update. The incomplete-readiness (partial_readiness)
  --    branch, exercised on a second incident, must NOT broadcast at all --
  --    the incident never actually closes.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005205');
  set local role authenticated;
  select * into v_incident from close_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'eventTime', now()::text,
    'readiness', 'full', 'rootCause', 'Root cause', 'resolution', 'Resolution', 'reportedToOps', 'no'
  ));
  reset role;
  v_version := v_incident.version;

  perform pg_temp.check_result(
    'close_incident (full readiness) notifies active professional managers with incident_closed/update',
    exists (
      select 1 from notifications where user_id = '00000000-0000-0000-0000-000000005202'
        and incident_id = v_incident.id and type = 'incident_closed' and category = 'update'
        and text = 'תקלה ' || v_incident.number || ' נסגרה על ידי Notif Supervisor'
    )
  );

  perform pg_temp.as_user('00000000-0000-0000-0000-000000005205');
  set local role authenticated;
  select * into v_incident2 from create_incident(
    pg_temp.base_create_input('00000000-0000-0000-0000-000000005206'));
  select * into v_incident2 from close_incident(v_incident2.id, jsonb_build_object(
    'expectedVersion', v_incident2.version, 'eventTime', now()::text,
    'readiness', 'partial', 'rootCause', 'Root cause', 'resolution', 'Resolution',
    'followUpNotes', 'follow up', 'ownerUserId', '00000000-0000-0000-0000-000000005206',
    'reportedToOps', 'no'
  ));
  reset role;
  perform pg_temp.check_result(
    'close_incident with incomplete readiness (the incident stays open) does NOT broadcast incident_closed',
    v_incident2.status = 'partial_readiness'
    and (select count(*) from notifications where incident_id = v_incident2.id and type = 'incident_closed') = 0
  );

  -- =====================================================================
  -- 6. reopen_incident: personal notification (action_required) to a
  --    non-PM owner, PLUS the operational broadcast (update) to other
  --    active professional managers; a professional-manager owner gets
  --    only the personal one, exactly like create_incident.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005201'); -- actor: PM Actor
  set local role authenticated;
  select * into v_incident from reopen_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_version, 'reason', 'Needs more work',
    'ownerUserId', '00000000-0000-0000-0000-000000005206'
  ));
  reset role;
  v_version := v_incident.version;

  perform pg_temp.check_result(
    'reopen_incident notifies the non-PM owner personally (action_required) and broadcasts to other active PMs (update)',
    exists (
      select 1 from notifications where user_id = '00000000-0000-0000-0000-000000005206'
        and incident_id = v_incident.id and type = 'incident_reopened' and category = 'action_required'
        and text = 'תקלה ' || v_incident.number || ' נפתחה מחדש והוקצתה אליך.'
    )
    and exists (
      select 1 from notifications where user_id = '00000000-0000-0000-0000-000000005202'
        and incident_id = v_incident.id and type = 'incident_reopened' and category = 'update'
        and text = 'תקלה ' || v_incident.number || ' נפתחה מחדש'
    )
    and pg_temp.pm_count('00000000-0000-0000-0000-000000005201', v_incident.id, 'incident_reopened') = 0 -- actor never self-notifies
  );

  -- Fresh incident, closed then reopened straight to a PM owner: dedup --
  -- only the personal row. A fresh incident (never touched by the earlier
  -- reopen above) is used deliberately, so this PM owner has no prior
  -- 'incident_reopened' broadcast row from a DIFFERENT reopen of the same
  -- incident to confuse the count. Reopening requires system_admin/
  -- professional_manager (or a supervisor only when allow_supervisor_reopen
  -- is on, which it is not by default) -- use the PM actor for the reopen.
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005205');
  set local role authenticated;
  select * into v_incident3 from create_incident(
    pg_temp.base_create_input('00000000-0000-0000-0000-000000005206'));
  select * into v_incident3 from close_incident(v_incident3.id, jsonb_build_object(
    'expectedVersion', v_incident3.version, 'eventTime', now()::text,
    'readiness', 'full', 'rootCause', 'Root cause 3', 'resolution', 'Resolution 3', 'reportedToOps', 'no'
  ));
  reset role;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005201'); -- PM Actor
  set local role authenticated;
  select * into v_incident3 from reopen_incident(v_incident3.id, jsonb_build_object(
    'expectedVersion', v_incident3.version, 'reason', 'Straight to a PM owner',
    'ownerUserId', '00000000-0000-0000-0000-000000005209' -- PM Owner
  ));
  reset role;

  perform pg_temp.check_result(
    'a professional-manager owner reopened-and-assigned gets only the personal notification, never also the operational one',
    pg_temp.pm_count('00000000-0000-0000-0000-000000005209', v_incident3.id, 'incident_reopened') = 1
    and (select category from notifications where user_id = '00000000-0000-0000-0000-000000005209'
           and incident_id = v_incident3.id and type = 'incident_reopened') = 'action_required'
  );

  -- =====================================================================
  -- 7. cancel_incident: broadcasts incident_cancelled/update to active PMs.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005205');
  set local role authenticated;
  select * into v_incident2 from create_incident(
    pg_temp.base_create_input('00000000-0000-0000-0000-000000005206'));
  select * into v_incident2 from cancel_incident(v_incident2.id, jsonb_build_object(
    'expectedVersion', v_incident2.version, 'eventTime', now()::text,
    'cancellationReason', 'Duplicate report'
  ));
  reset role;

  perform pg_temp.check_result(
    'cancel_incident notifies active professional managers with incident_cancelled/update',
    exists (
      select 1 from notifications where user_id = '00000000-0000-0000-0000-000000005202'
        and incident_id = v_incident2.id and type = 'incident_cancelled' and category = 'update'
        and text = 'תקלה ' || v_incident2.number || ' בוטלה'
    )
    and pg_temp.pm_count('00000000-0000-0000-0000-000000005204', v_incident2.id, 'incident_cancelled') = 0
  );

  -- =====================================================================
  -- 8. A rejected/rolled-back operation leaves no notification behind.
  -- =====================================================================
  select count(*) into v_before from notifications;
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005205');
  set local role authenticated;
  begin
    -- Wrong expectedVersion -> version_conflict, whole transaction's worth
    -- of statements inside this RPC call never commits.
    perform update_incident(v_incident2.id, jsonb_build_object(
      'expectedVersion', 999999, 'eventTime', now()::text,
      'status', 'in_progress', 'severity', 'high', 'ownerUserId', '00000000-0000-0000-0000-000000005206',
      'operationalImpact', 'x', 'actionsTaken', 'should never persist'
    ));
  exception when others then
    null; -- expected
  end;
  reset role;
  select count(*) into v_after from notifications;
  perform pg_temp.check_result(
    'a rejected/rolled-back lifecycle operation creates no notifications at all',
    v_before = v_after, format('before=%s after=%s', v_before, v_after)
  );

  -- =====================================================================
  -- 9. Duplicate/retried operations do not duplicate notifications: a
  --    genuine retry of an already-applied call reuses the same (now
  --    stale) expectedVersion and is rejected by the SAME version check,
  --    so it can never re-run the broadcast a second time. Verified here
  --    against reopen_incident (also proves the personal notification's
  --    dedupe_key already in place since 0001 still holds for a same-
  --    key resubmission).
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005205');
  set local role authenticated;
  select * into v_incident2 from create_incident(
    pg_temp.base_create_input('00000000-0000-0000-0000-000000005206'));
  select * into v_incident2 from close_incident(v_incident2.id, jsonb_build_object(
    'expectedVersion', v_incident2.version, 'eventTime', now()::text,
    'readiness', 'full', 'rootCause', 'rc', 'resolution', 'res', 'reportedToOps', 'no'
  ));
  reset role;
  v_version := v_incident2.version;
  -- Reopening requires system_admin/professional_manager (or a supervisor
  -- only with the allow_supervisor_reopen policy flag on, which is not the
  -- default) -- switch to a PM actor for both reopen calls below.
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005201'); -- PM Actor
  set local role authenticated;
  select * into v_incident2 from reopen_incident(v_incident2.id, jsonb_build_object(
    'expectedVersion', v_version, 'reason', 'first reopen',
    'ownerUserId', '00000000-0000-0000-0000-000000005206'
  ));
  reset role;
  -- Counted as postgres (not RLS-scoped to the acting PM's own rows) --
  -- this asserts the true total across every recipient, not just the actor's.
  select count(*) into v_before from notifications where incident_id = v_incident2.id and type = 'incident_reopened';
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005201');
  set local role authenticated;
  begin
    -- Retried with the SAME (now stale) expectedVersion -> rejected.
    perform reopen_incident(v_incident2.id, jsonb_build_object(
      'expectedVersion', v_version, 'reason', 'retried reopen',
      'ownerUserId', '00000000-0000-0000-0000-000000005206'
    ));
    perform pg_temp.check_result('a retried reopen_incident call with a stale expectedVersion is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'a retried reopen_incident call with a stale expectedVersion is rejected',
      sqlerrm like 'not_found:%' or sqlerrm like 'version_conflict:%' or sqlerrm like 'invalid_transition:%', sqlerrm
    );
  end;
  reset role;
  select count(*) into v_after from notifications where incident_id = v_incident2.id and type = 'incident_reopened';
  perform pg_temp.check_result(
    'the rejected retry did not duplicate the incident_reopened notification(s)',
    v_before = v_after, format('before=%s after=%s', v_before, v_after)
  );
end $$;

-- =====================================================================
-- 10. RLS: a user reads and marks only their own notifications; a client
--     cannot directly forge a notification for another user (or at all --
--     insert is RPC-only, per the 0044 revoke).
-- =====================================================================
do $$
declare
  v_own_count int;
  v_other_count int;
  v_updated int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000005202'); -- PM One
  set local role authenticated;

  select count(*) into v_own_count from notifications where user_id = '00000000-0000-0000-0000-000000005202';
  select count(*) into v_other_count from notifications where user_id = '00000000-0000-0000-0000-000000005203'; -- PM Two
  perform pg_temp.check_result(
    'a user reads their own notifications but not another user''s, via RLS',
    v_own_count > 0 and v_other_count = 0
  );

  -- Attempting to mark ANOTHER user's notification as read affects zero
  -- rows (RLS-filtered), never an error and never someone else's row.
  update notifications set read = true
  where user_id = '00000000-0000-0000-0000-000000005203' and read = false;
  get diagnostics v_updated = row_count;
  perform pg_temp.check_result(
    'a user cannot mark another user''s notification as read (RLS-filtered, zero rows affected)',
    v_updated = 0
  );

  begin
    insert into notifications (user_id, type, incident_id, text, category)
    values ('00000000-0000-0000-0000-000000005202', 'incident_opened', null, 'forged', 'update');
    perform pg_temp.check_result('a client cannot directly INSERT a notification (RPC-only)', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('a client cannot directly INSERT a notification (RPC-only)', true, sqlerrm);
  end;

  begin
    insert into notifications (user_id, type, incident_id, text, category)
    values ('00000000-0000-0000-0000-000000005203', 'incident_opened', null, 'forged for someone else', 'update');
    perform pg_temp.check_result('a client cannot forge a notification for another user', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('a client cannot forge a notification for another user', true, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 11. Legacy 'update_overdue' rows: the 0044 migration deletes every
--     existing one outright, and no RPC in this codebase ever writes a new
--     one -- so none should exist post-migration, in this fixture or
--     otherwise.
-- =====================================================================
select pg_temp.check_result(
  'no update_overdue notification rows remain active after the 0044 migration',
  (select count(*) from notifications where type = 'update_overdue') = 0
);

-- =====================================================================
-- 12. Grants: notify_professional_managers is unreachable directly by any
--     client role -- only from inside another SECURITY DEFINER RPC body.
-- =====================================================================
select pg_temp.check_result(
  'notify_professional_managers is not directly executable by authenticated, anon, or PUBLIC',
  not has_function_privilege('authenticated',
    'public.notify_professional_managers(notification_type,notification_category,uuid,text,uuid,uuid[])', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.notify_professional_managers(notification_type,notification_category,uuid,text,uuid,uuid[])', 'EXECUTE')
);

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
