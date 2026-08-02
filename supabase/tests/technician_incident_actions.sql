-- Tests for migration 0037: an active technician gains create_incident,
-- close_incident (both readiness outcomes) and assign_incident -- entirely
-- independent of the incident's current owner, exactly like every other
-- operational role already behaves for these same three RPCs. is_operational_
-- role() itself is untouched; cancel_incident, reopen_incident, update_incident
-- (full/protected) and technician_update_incident's owner scoping are all
-- unaffected and re-verified as regressions here.
--
-- Also proves the NULL-safety fix is load-bearing: an authenticated identity
-- with no profiles row at all (my_role() = NULL, is_operational_role() = NULL)
-- must be REJECTED, not silently let through by a `if not (NULL)` no-op.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000d1', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000d2', 'technician-actor@test', now()),
  ('00000000-0000-0000-0000-0000000000d3', 'inactive-technician@test', now()),
  ('00000000-0000-0000-0000-0000000000d4', 'viewer-actor@test', now()),
  ('00000000-0000-0000-0000-0000000000d5', 'continuation-owner@test', now()),
  ('00000000-0000-0000-0000-0000000000d6', 'inactive-owner-target@test', now()),
  ('00000000-0000-0000-0000-0000000000d7', 'no-profile-identity@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000d1', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000d2', 'Technician Actor', 'technician', true),
  ('00000000-0000-0000-0000-0000000000d3', 'Inactive Technician', 'technician', false),
  ('00000000-0000-0000-0000-0000000000d4', 'Viewer Actor', 'viewer', true),
  ('00000000-0000-0000-0000-0000000000d5', 'Continuation Owner', 'technician', true),
  ('00000000-0000-0000-0000-0000000000d6', 'Inactive Owner Target', 'technician', false);
-- d7 deliberately has NO profiles row: an authenticated Supabase identity
-- (e.g. mid-provisioning, or a deactivated-and-later-deleted account) that
-- resolves to no profile at all. my_role() and is_operational_role() both
-- return NULL for this identity.

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000d101', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000d102', 'Loc', 1);

-- d201: reused across every REJECTED-call test below (permission checks
-- raise before any UPDATE runs, and each begin/exception block is its own
-- savepoint, so the row is provably untouched between tests).
-- d202: already CLOSED -- for terminal-incident rejection tests.
-- d203/d204/d205: one fresh incident per SUCCESSFUL mutation.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values
  ('00000000-0000-0000-0000-00000000d201', 'D-201', '00000000-0000-0000-0000-00000000d101',
   '00000000-0000-0000-0000-00000000d102', 'תקלה', 'medium', 'in_progress', 'השפעה',
   '00000000-0000-0000-0000-0000000000d1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
   now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000d203', 'D-203', '00000000-0000-0000-0000-00000000d101',
   '00000000-0000-0000-0000-00000000d102', 'תקלה', 'medium', 'in_progress', 'השפעה',
   '00000000-0000-0000-0000-0000000000d1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
   now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000d204', 'D-204', '00000000-0000-0000-0000-00000000d101',
   '00000000-0000-0000-0000-00000000d102', 'תקלה', 'medium', 'in_progress', 'השפעה',
   '00000000-0000-0000-0000-0000000000d1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
   now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000d205', 'D-205', '00000000-0000-0000-0000-00000000d101',
   '00000000-0000-0000-0000-00000000d102', 'תקלה', 'medium', 'in_progress', 'השפעה',
   '00000000-0000-0000-0000-0000000000d1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
   now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000d206', 'D-206', '00000000-0000-0000-0000-00000000d101',
   '00000000-0000-0000-0000-00000000d102', 'תקלה', 'medium', 'in_progress', 'השפעה',
   '00000000-0000-0000-0000-0000000000d1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
   now() + interval '4 hours', 1);

insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       closed_at, closed_by, root_cause, resolution, readiness_at_close, version)
values
  ('00000000-0000-0000-0000-00000000d202', 'D-202', '00000000-0000-0000-0000-00000000d101',
   '00000000-0000-0000-0000-00000000d102', 'תקלה סגורה', 'medium', 'closed', 'השפעה',
   '00000000-0000-0000-0000-0000000000d1', now() - interval '3 days',
   '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
   now() - interval '1 day', '00000000-0000-0000-0000-0000000000d1', 'סיבה', 'פתרון', 'full', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

create or replace function pg_temp.base_create_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000d101', 'locationId', '00000000-0000-0000-0000-00000000d102',
    'description', 'תקלה לבדיקה', 'severity', 'low', 'operationalImpact', 'השפעה',
    'actionsTaken', 'נבדק', 'status', 'new', 'discoveredAt', now(),
    'ownerUserId', '00000000-0000-0000-0000-0000000000d2',
    'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_create_input(jsonb) to authenticated;

create or replace function pg_temp.base_close_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'eventTime', now(), 'rootCause', 'סיבה', 'resolution', 'פתרון',
    'readiness', 'full', 'followUpNotes', '', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_close_input(jsonb) to authenticated;

create or replace function pg_temp.base_assign_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object('expectedVersion', 1) || extra;
$$;
grant execute on function pg_temp.base_assign_input(jsonb) to authenticated;

-- =====================================================================
-- 1. Active technician CAN create a valid incident.
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
  set local role authenticated;
  begin
    v_incident := create_incident(pg_temp.base_create_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('active technician can create_incident', case when v_incident.status = 'new' then 'PASS' else 'FAIL' end,
        'number=' || v_incident.number);
  exception when others then
    insert into results (test, result, detail) values ('active technician can create_incident', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 2. Active technician CAN close (full readiness) an incident owned by
--    someone else (d203 is owned by the supervisor, d1).
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
  set local role authenticated;
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000d203', pg_temp.base_close_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('active technician can close (full readiness) an incident owned by someone else',
        case when v_incident.status = 'closed' then 'PASS' else 'FAIL' end, 'status=' || v_incident.status);
  exception when others then
    insert into results (test, result, detail) values
      ('active technician can close (full readiness) an incident owned by someone else', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 3. Active technician CAN close (incomplete readiness) an incident owned
--    by someone else, WITH a valid continuation owner (d205) -- the
--    incident stays active as partial_readiness, never closed.
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
  set local role authenticated;
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000d204', pg_temp.base_close_input(
      jsonb_build_object('readiness', 'partial', 'followUpNotes', 'להשלים בהמשך',
        'ownerUserId', '00000000-0000-0000-0000-0000000000d5')));
    insert into results (test, result, detail) values
      ('active technician can close with incomplete readiness (valid continuation owner)',
        case when v_incident.status = 'partial_readiness' and v_incident.follow_up_required
          and v_incident.owner_user_id = '00000000-0000-0000-0000-0000000000d5' then 'PASS' else 'FAIL' end,
        'status=' || v_incident.status || ' owner=' || v_incident.owner_user_id);
  exception when others then
    insert into results (test, result, detail) values
      ('active technician can close with incomplete readiness (valid continuation owner)', 'FAIL', sqlerrm);
  end;

  -- 3b. Incomplete readiness WITHOUT a continuation owner is still rejected
  --     -- unchanged validation, reproduced here against the technician actor.
  begin
    perform close_incident('00000000-0000-0000-0000-00000000d201', pg_temp.base_close_input(
      jsonb_build_object('readiness', 'partial', 'followUpNotes', 'להשלים בהמשך')));
    insert into results (test, result, detail) values
      ('incomplete readiness without a continuation owner is still rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('incomplete readiness without a continuation owner is still rejected',
        case when sqlerrm = 'validation: כאשר הכשירות אינה מלאה יש לקבוע גורם מטפל אחראי המשך' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 4. Active technician CAN reassign (change handling party on) an incident
--    owned by someone else.
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
  set local role authenticated;
  begin
    v_incident := assign_incident('00000000-0000-0000-0000-00000000d205', pg_temp.base_assign_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000d5')));
    insert into results (test, result, detail) values
      ('active technician can reassign an incident owned by someone else',
        case when v_incident.owner_user_id = '00000000-0000-0000-0000-0000000000d5' then 'PASS' else 'FAIL' end,
        'owner=' || v_incident.owner_user_id);
  exception when others then
    insert into results (test, result, detail) values
      ('active technician can reassign an incident owned by someone else', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 5. Invalid/inactive owner targets remain rejected for a technician actor
--    (assert_owner_valid unchanged).
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
  set local role authenticated;
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000d201', pg_temp.base_assign_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000d6')));
    insert into results (test, result, detail) values
      ('technician reassigning to an inactive owner is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician reassigning to an inactive owner is rejected',
        case when sqlerrm = 'validation: הגורם המטפל שנבחר אינו פעיל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 6. Terminal incidents remain rejected for a technician actor (d202 is
--    already closed).
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
  set local role authenticated;
  begin
    perform close_incident('00000000-0000-0000-0000-00000000d202', pg_temp.base_close_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('technician closing an already-terminal incident is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician closing an already-terminal incident is rejected',
        case when sqlerrm = 'invalid_transition: התקלה כבר סגורה או מבוטלת' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000d202', pg_temp.base_assign_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000d5')));
    insert into results (test, result, detail) values
      ('technician reassigning an already-terminal incident is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician reassigning an already-terminal incident is rejected',
        case when sqlerrm = 'invalid_transition: לא ניתן לשנות גורם מטפל בתקלה סגורה או מבוטלת' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 7. Inactive technician rejected on all three RPCs (NULL-safety: my_role()
--    is NULL for an inactive profile -- must reject, never fail open).
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d3');
  set local role authenticated;
  begin
    perform create_incident(pg_temp.base_create_input('{}'::jsonb));
    insert into results (test, result, detail) values ('inactive technician rejected from create_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('inactive technician rejected from create_incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform close_incident('00000000-0000-0000-0000-00000000d201', pg_temp.base_close_input('{}'::jsonb));
    insert into results (test, result, detail) values ('inactive technician rejected from close_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('inactive technician rejected from close_incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000d201', pg_temp.base_assign_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000d5')));
    insert into results (test, result, detail) values ('inactive technician rejected from assign_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('inactive technician rejected from assign_incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 8. An authenticated identity with NO profiles row at all is rejected on
--    all three RPCs -- this is the exact case the NULL-safety fix targets:
--    my_role() and is_operational_role() both return NULL for this
--    identity, and a naive `if not (is_operational_role() or my_role() =
--    'technician')` would silently fail OPEN (the raise is skipped when
--    the condition is NULL). The explicit is_active_member() guard plus the
--    coalesce(..., false) wrap must reject it instead.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d7');
  set local role authenticated;
  begin
    perform create_incident(pg_temp.base_create_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('authenticated identity with no profile is rejected from create_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('authenticated identity with no profile is rejected from create_incident',
        case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform close_incident('00000000-0000-0000-0000-00000000d201', pg_temp.base_close_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('authenticated identity with no profile is rejected from close_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('authenticated identity with no profile is rejected from close_incident',
        case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000d201', pg_temp.base_assign_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000d5')));
    insert into results (test, result, detail) values
      ('authenticated identity with no profile is rejected from assign_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('authenticated identity with no profile is rejected from assign_incident',
        case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 9. Active viewer remains rejected on all three RPCs.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d4');
  set local role authenticated;
  begin
    perform create_incident(pg_temp.base_create_input('{}'::jsonb));
    insert into results (test, result, detail) values ('active viewer rejected from create_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('active viewer rejected from create_incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform close_incident('00000000-0000-0000-0000-00000000d201', pg_temp.base_close_input('{}'::jsonb));
    insert into results (test, result, detail) values ('active viewer rejected from close_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('active viewer rejected from close_incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000d201', pg_temp.base_assign_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000d5')));
    insert into results (test, result, detail) values ('active viewer rejected from assign_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('active viewer rejected from assign_incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 10. Untouched restrictions: an active technician still cannot
--     cancel_incident, reopen_incident, or update_incident (full/protected),
--     and technician_update_incident's owner scoping is unchanged.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d2');
  set local role authenticated;
  begin
    perform cancel_incident('00000000-0000-0000-0000-00000000d201',
      jsonb_build_object('expectedVersion', 1, 'eventTime', now(), 'cancellationReason', 'בדיקה'));
    insert into results (test, result, detail) values ('active technician still cannot cancel_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('active technician still cannot cancel_incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform reopen_incident('00000000-0000-0000-0000-00000000d202', jsonb_build_object(
      'expectedVersion', 1, 'reason', 'בדיקה', 'ownerUserId', '00000000-0000-0000-0000-0000000000d2'));
    insert into results (test, result, detail) values ('active technician still cannot reopen_incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('active technician still cannot reopen_incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform update_incident('00000000-0000-0000-0000-00000000d201', jsonb_build_object(
      'expectedVersion', 1, 'eventTime', now(), 'currentStatusText', 'בדיקה'));
    insert into results (test, result, detail) values
      ('active technician still cannot use update_incident (full/protected)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('active technician still cannot use update_incident (full/protected)',
        case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  -- technician_update_incident: d201 is owned by the supervisor (d1), not
  -- by this technician actor (d2) -- owner scoping is unaffected by 0037.
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000d201', jsonb_build_object(
      'expectedVersion', 1, 'eventTime', now(), 'actionsTaken', 'x', 'findings', 'x',
      'nextSteps', 'x', 'currentStatusText', 'x'));
    insert into results (test, result, detail) values
      ('technician_update_incident owner scoping unchanged (non-owner rejected)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician_update_incident owner scoping unchanged (non-owner rejected)',
        case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 11. Existing higher-role behavior remains intact: the supervisor (d1,
--     an operational role) can still create/close/assign exactly as before.
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
  set local role authenticated;
  begin
    v_incident := create_incident(pg_temp.base_create_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('operational role (shift_supervisor) can still create_incident', 'PASS', 'number=' || v_incident.number);
  exception when others then
    insert into results (test, result, detail) values
      ('operational role (shift_supervisor) can still create_incident', 'FAIL', sqlerrm);
  end;
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000d206', pg_temp.base_close_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('operational role (shift_supervisor) can still close_incident', case when v_incident.status = 'closed' then 'PASS' else 'FAIL' end,
        'status=' || v_incident.status);
  exception when others then
    insert into results (test, result, detail) values
      ('operational role (shift_supervisor) can still close_incident', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
