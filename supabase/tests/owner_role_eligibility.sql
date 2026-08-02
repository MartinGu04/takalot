-- Tests for migration 0039: assert_owner_valid now rejects an internal
-- owner whose role is not eligible (system_admin, professional_manager,
-- shift_supervisor, technician) -- a viewer is rejected even when active,
-- regardless of which RPC is called directly. Confirms every eligible role
-- remains assignable, the pre-existing "inactive owner" rejection and its
-- exact message are unchanged, and unrelated lifecycle behavior (terminal-
-- state guard, partial-readiness continuation-owner requirement) is
-- unaffected.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000c1', 'supervisor-actor@test', now()),
  ('00000000-0000-0000-0000-0000000000c2', 'viewer-target@test', now()),
  ('00000000-0000-0000-0000-0000000000c3', 'technician-target@test', now()),
  ('00000000-0000-0000-0000-0000000000c4', 'admin-target@test', now()),
  ('00000000-0000-0000-0000-0000000000c5', 'manager-target@test', now()),
  ('00000000-0000-0000-0000-0000000000c6', 'supervisor-target@test', now()),
  ('00000000-0000-0000-0000-0000000000c7', 'inactive-technician-target@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000c1', 'Supervisor Actor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000c2', 'Viewer Target', 'viewer', true),
  ('00000000-0000-0000-0000-0000000000c3', 'Technician Target', 'technician', true),
  ('00000000-0000-0000-0000-0000000000c4', 'Admin Target', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000c5', 'Manager Target', 'professional_manager', true),
  ('00000000-0000-0000-0000-0000000000c6', 'Supervisor Target', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000c7', 'Inactive Technician Target', 'technician', false);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000c101', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000c102', 'Loc', 1);

insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values
  -- h901: reused across every REJECTED assign_incident call (each
  -- rejection rolls back inside its own begin/exception savepoint).
  ('00000000-0000-0000-0000-00000000c901', 'H-901', '00000000-0000-0000-0000-00000000c101',
   '00000000-0000-0000-0000-00000000c102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
   now() + interval '4 hours', 1),
  -- h902-h905: one fresh incident per SUCCESSFUL assign_incident, one per
  -- eligible role.
  ('00000000-0000-0000-0000-00000000c902', 'H-902', '00000000-0000-0000-0000-00000000c101',
   '00000000-0000-0000-0000-00000000c102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
   now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000c903', 'H-903', '00000000-0000-0000-0000-00000000c101',
   '00000000-0000-0000-0000-00000000c102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
   now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000c904', 'H-904', '00000000-0000-0000-0000-00000000c101',
   '00000000-0000-0000-0000-00000000c102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
   now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000c905', 'H-905', '00000000-0000-0000-0000-00000000c101',
   '00000000-0000-0000-0000-00000000c102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
   now() + interval '4 hours', 1),
  -- h908/h909: close_incident, incomplete readiness (continuation owner).
  ('00000000-0000-0000-0000-00000000c908', 'H-908', '00000000-0000-0000-0000-00000000c101',
   '00000000-0000-0000-0000-00000000c102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
   now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000c909', 'H-909', '00000000-0000-0000-0000-00000000c101',
   '00000000-0000-0000-0000-00000000c102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
   now() + interval '4 hours', 1);

-- h910: already closed -- for the terminal-state regression check.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       closed_at, closed_by, root_cause, resolution, readiness_at_close, version)
values
  ('00000000-0000-0000-0000-00000000c910', 'H-910', '00000000-0000-0000-0000-00000000c101',
   '00000000-0000-0000-0000-00000000c102', 'd', 'medium', 'closed', 'i',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '3 days',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
   now() - interval '1 day', '00000000-0000-0000-0000-0000000000c1', 'סיבה', 'פתרון', 'full', 1);

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
    'systemId', '00000000-0000-0000-0000-00000000c101', 'locationId', '00000000-0000-0000-0000-00000000c102',
    'description', 'תקלה לבדיקה', 'severity', 'low', 'operationalImpact', 'השפעה',
    'actionsTaken', 'נבדק', 'status', 'new', 'discoveredAt', now(),
    'ownerUserId', '00000000-0000-0000-0000-0000000000c3',
    'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_create_input(jsonb) to authenticated;

create or replace function pg_temp.base_assign_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object('expectedVersion', 1) || extra;
$$;
grant execute on function pg_temp.base_assign_input(jsonb) to authenticated;

create or replace function pg_temp.base_close_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'eventTime', now(), 'rootCause', 'סיבה', 'resolution', 'פתרון', 'readiness', 'full',
    'followUpNotes', '', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_close_input(jsonb) to authenticated;

-- =====================================================================
-- 1. A viewer is rejected as the new owner on a direct assign_incident
--    call, even though the viewer profile itself is active.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000c901', pg_temp.base_assign_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000c2')));
    insert into results (test, result, detail) values
      ('assign_incident: active viewer rejected as new owner', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('assign_incident: active viewer rejected as new owner',
        case when sqlerrm = 'validation: הגורם המטפל שנבחר אינו זכאי לשמש כבעל אחריות' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 2. Regression: an inactive (but role-eligible) owner is still rejected,
--    with its own unchanged "not active" message -- distinct from the new
--    role-eligibility message above.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000c901', pg_temp.base_assign_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000c7')));
    insert into results (test, result, detail) values
      ('assign_incident: inactive technician still rejected (unchanged message)', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('assign_incident: inactive technician still rejected (unchanged message)',
        case when sqlerrm = 'validation: הגורם המטפל שנבחר אינו פעיל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 3. Every eligible active role can still be assigned as owner --
--    system_admin, professional_manager, shift_supervisor, technician.
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;

  v_incident := assign_incident('00000000-0000-0000-0000-00000000c902', pg_temp.base_assign_input(
    jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000c3')));
  insert into results (test, result, detail) values
    ('assign_incident: active technician remains assignable',
      case when v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000c3' then 'PASS' else 'FAIL' end, '');

  v_incident := assign_incident('00000000-0000-0000-0000-00000000c903', pg_temp.base_assign_input(
    jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000c4')));
  insert into results (test, result, detail) values
    ('assign_incident: active system_admin remains assignable',
      case when v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000c4' then 'PASS' else 'FAIL' end, '');

  v_incident := assign_incident('00000000-0000-0000-0000-00000000c904', pg_temp.base_assign_input(
    jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000c5')));
  insert into results (test, result, detail) values
    ('assign_incident: active professional_manager remains assignable',
      case when v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000c5' then 'PASS' else 'FAIL' end, '');

  v_incident := assign_incident('00000000-0000-0000-0000-00000000c905', pg_temp.base_assign_input(
    jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000c6')));
  insert into results (test, result, detail) values
    ('assign_incident: active shift_supervisor remains assignable',
      case when v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000c6' then 'PASS' else 'FAIL' end, '');

  reset role;
end $$;

-- =====================================================================
-- 4. create_incident also rejects a viewer as the internal owner.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform create_incident(pg_temp.base_create_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000c2')));
    insert into results (test, result, detail) values
      ('create_incident: active viewer rejected as internal owner', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('create_incident: active viewer rejected as internal owner',
        case when sqlerrm = 'validation: הגורם המטפל שנבחר אינו זכאי לשמש כבעל אחריות' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- Regression: an eligible active owner still opens an incident normally.
  declare
    v_incident incidents;
  begin
    v_incident := create_incident(pg_temp.base_create_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('create_incident: active technician owner still accepted', case when v_incident.status = 'new' then 'PASS' else 'FAIL' end, '');
  end;
  reset role;
end $$;

-- =====================================================================
-- 5. close_incident (incomplete readiness): the continuation owner is
--    also subject to the role check -- a viewer is rejected, an eligible
--    active owner still succeeds. Terminal-state guard unaffected.
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;

  begin
    perform close_incident('00000000-0000-0000-0000-00000000c908', pg_temp.base_close_input(
      jsonb_build_object('readiness', 'partial', 'followUpNotes', 'להשלים בהמשך',
        'ownerUserId', '00000000-0000-0000-0000-0000000000c2')));
    insert into results (test, result, detail) values
      ('close_incident (partial): active viewer rejected as continuation owner', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (partial): active viewer rejected as continuation owner',
        case when sqlerrm = 'validation: הגורם המטפל שנבחר אינו זכאי לשמש כבעל אחריות' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  v_incident := close_incident('00000000-0000-0000-0000-00000000c909', pg_temp.base_close_input(
    jsonb_build_object('readiness', 'partial', 'followUpNotes', 'להשלים בהמשך',
      'ownerUserId', '00000000-0000-0000-0000-0000000000c3')));
  insert into results (test, result, detail) values
    ('close_incident (partial): active technician still accepted as continuation owner, incident stays active',
      case when v_incident.status = 'partial_readiness' and v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000c3'
        then 'PASS' else 'FAIL' end, v_incident.status::text);

  -- Regression: terminal-state guard is unaffected by this migration.
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000c910', pg_temp.base_assign_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000c3')));
    insert into results (test, result, detail) values
      ('regression: assign_incident still rejects a terminal (closed) incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('regression: assign_incident still rejects a terminal (closed) incident',
        case when sqlerrm = 'invalid_transition: לא ניתן לשנות גורם מטפל בתקלה סגורה או מבוטלת' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  reset role;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
