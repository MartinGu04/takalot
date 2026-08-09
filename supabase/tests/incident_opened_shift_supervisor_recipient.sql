-- Focused verification for migration 0057: active shift_supervisor users
-- now receive the canonical incident_opened operational broadcast, exactly
-- like active professional_manager users already do -- while every other
-- notify_operational_recipients()-driven broadcast type (incident_updated,
-- incident_closed, incident_cancelled, incident_reopened) keeps its exact
-- existing recipient set. Runs in one transaction that rolls back at the
-- end; leaves the database unchanged.
\pset pager off
begin;

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.check_result(p_test text, p_ok boolean, p_detail text default '')
returns void language sql as $$
  insert into results (test, result, detail)
  values (p_test, case when p_ok then 'PASS' else 'FAIL' end, coalesce(p_detail, ''));
$$;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

-- =====================================================================
-- Fixtures: one actor (creates the incidents), one active
-- shift_supervisor recipient, one active professional_manager recipient
-- (regression control -- must keep receiving exactly as before), one
-- active system_admin with operational_notifications_enabled=true
-- (regression control), one INACTIVE shift_supervisor (must receive
-- nothing), and one active technician (never a recipient of this
-- broadcast, regardless of role changes here).
-- =====================================================================
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000006701', 'actor-6701@test', now()),
  ('00000000-0000-0000-0000-000000006702', 'supervisor-6702@test', now()),
  ('00000000-0000-0000-0000-000000006703', 'manager-6703@test', now()),
  ('00000000-0000-0000-0000-000000006704', 'admin-6704@test', now()),
  ('00000000-0000-0000-0000-000000006705', 'inactive-supervisor-6705@test', now()),
  ('00000000-0000-0000-0000-000000006706', 'technician-6706@test', now());
insert into profiles (id, full_name, role, active, operational_notifications_enabled) values
  ('00000000-0000-0000-0000-000000006701', 'Actor Person', 'professional_manager', true, false),
  ('00000000-0000-0000-0000-000000006702', 'Active Supervisor', 'shift_supervisor', true, false),
  ('00000000-0000-0000-0000-000000006703', 'Active Manager', 'professional_manager', true, false),
  ('00000000-0000-0000-0000-000000006704', 'Active Admin', 'system_admin', true, true),
  ('00000000-0000-0000-0000-000000006705', 'Inactive Supervisor', 'shift_supervisor', false, false),
  ('00000000-0000-0000-0000-000000006706', 'Active Technician', 'technician', true, false);
insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000e701', 'Sys 6701', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000e702', 'Loc 6701', 1);

select pg_temp.as_user('00000000-0000-0000-0000-000000006701');

-- =====================================================================
-- 1. incident_opened: active shift_supervisor DOES receive the broadcast,
--    same as active professional_manager and the enabled system_admin.
--    The inactive shift_supervisor and the technician receive nothing.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_has_supervisor boolean;
  v_has_manager boolean;
  v_has_admin boolean;
  v_has_inactive_supervisor boolean;
  v_has_technician boolean;
begin
  v_incident := create_incident(jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000e701', 'locationId', '00000000-0000-0000-0000-00000000e702',
    'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
    'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-000000006706',
    'discoveredAt', now(), 'reportedToOps', 'not_required'));

  select exists(select 1 from notifications where incident_id = v_incident.id and type = 'incident_opened'
    and user_id = '00000000-0000-0000-0000-000000006702') into v_has_supervisor;
  perform pg_temp.check_result(
    '1: incident_opened -- active shift_supervisor receives the canonical broadcast', v_has_supervisor);

  select exists(select 1 from notifications where incident_id = v_incident.id and type = 'incident_opened'
    and user_id = '00000000-0000-0000-0000-000000006703') into v_has_manager;
  perform pg_temp.check_result(
    '1b: incident_opened -- active professional_manager still receives it (regression)', v_has_manager);

  select exists(select 1 from notifications where incident_id = v_incident.id and type = 'incident_opened'
    and user_id = '00000000-0000-0000-0000-000000006704') into v_has_admin;
  perform pg_temp.check_result(
    '1c: incident_opened -- enabled active system_admin still receives it (regression)', v_has_admin);

  select exists(select 1 from notifications where incident_id = v_incident.id and type = 'incident_opened'
    and user_id = '00000000-0000-0000-0000-000000006705') into v_has_inactive_supervisor;
  perform pg_temp.check_result(
    '1d: incident_opened -- INACTIVE shift_supervisor receives nothing', not v_has_inactive_supervisor);

  select exists(select 1 from notifications where incident_id = v_incident.id and type = 'incident_opened'
    and user_id = '00000000-0000-0000-0000-000000006706') into v_has_technician;
  perform pg_temp.check_result(
    '1e: incident_opened -- technician is still never a recipient of this broadcast', not v_has_technician);
end $$;

-- =====================================================================
-- 2. The actor is still excluded from their own incident_opened
--    broadcast, even when the actor IS a shift_supervisor.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_has_self boolean;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006702');
  v_incident := create_incident(jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000e701', 'locationId', '00000000-0000-0000-0000-00000000e702',
    'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
    'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-000000006706',
    'discoveredAt', now(), 'reportedToOps', 'not_required'));

  select exists(select 1 from notifications where incident_id = v_incident.id and type = 'incident_opened'
    and user_id = '00000000-0000-0000-0000-000000006702') into v_has_self;
  perform pg_temp.check_result(
    '2: a shift_supervisor actor is still excluded from their own incident_opened broadcast', not v_has_self);

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006701');
end $$;

-- =====================================================================
-- 3. Duplicate suppression (dedupe_key ON CONFLICT DO NOTHING) remains
--    intact: calling notify_operational_recipients twice for the exact
--    same operation_id inserts the shift_supervisor row only once.
-- =====================================================================
do $$
declare
  v_op_id uuid := gen_random_uuid();
  v_incident_id uuid := '00000000-0000-0000-0000-00000000e703';
  v_count int;
begin
  insert into incidents (id, number, system_id, location_id, description, severity, status,
                         operational_impact, owner_user_id, discovered_at, created_by, updated_by, next_update_due, version)
  values (v_incident_id, 'E-703', '00000000-0000-0000-0000-00000000e701', '00000000-0000-0000-0000-00000000e702',
          'תקלה', 'low', 'in_progress', 'i', '00000000-0000-0000-0000-000000006706', now(),
          '00000000-0000-0000-0000-000000006701', '00000000-0000-0000-0000-000000006701', now() + interval '4 hours', 1);

  perform notify_operational_recipients('incident_opened', 'update', v_incident_id, 'x', v_op_id, '{}'::uuid[]);
  perform notify_operational_recipients('incident_opened', 'update', v_incident_id, 'x', v_op_id, '{}'::uuid[]);

  select count(*) into v_count from notifications
    where incident_id = v_incident_id and type = 'incident_opened' and user_id = '00000000-0000-0000-0000-000000006702';
  perform pg_temp.check_result(
    '3: duplicate suppression (dedupe_key) still prevents a second shift_supervisor row for the same operation',
    v_count = 1, 'count=' || v_count);
end $$;

-- =====================================================================
-- 4. Routine broadcast types (incident_updated, incident_closed,
--    incident_cancelled, incident_reopened) are COMPLETELY UNCHANGED --
--    an active shift_supervisor still receives NONE of them, exactly as
--    before this migration.
-- =====================================================================
do $$
declare
  v_incident_id uuid := '00000000-0000-0000-0000-00000000e704';
  v_op_id uuid;
  v_has_supervisor boolean;
begin
  insert into incidents (id, number, system_id, location_id, description, severity, status,
                         operational_impact, owner_user_id, discovered_at, created_by, updated_by, next_update_due, version)
  values (v_incident_id, 'E-704', '00000000-0000-0000-0000-00000000e701', '00000000-0000-0000-0000-00000000e702',
          'תקלה', 'low', 'in_progress', 'i', '00000000-0000-0000-0000-000000006706', now(),
          '00000000-0000-0000-0000-000000006701', '00000000-0000-0000-0000-000000006701', now() + interval '4 hours', 1);

  v_op_id := gen_random_uuid();
  perform notify_operational_recipients('incident_updated', 'update', v_incident_id, 'x', v_op_id, '{}'::uuid[]);
  select exists(select 1 from notifications where incident_id = v_incident_id and type = 'incident_updated'
    and user_id = '00000000-0000-0000-0000-000000006702') into v_has_supervisor;
  perform pg_temp.check_result('4a: incident_updated -- shift_supervisor still receives nothing (unchanged)', not v_has_supervisor);

  v_op_id := gen_random_uuid();
  perform notify_operational_recipients('incident_closed', 'update', v_incident_id, 'x', v_op_id, '{}'::uuid[]);
  select exists(select 1 from notifications where incident_id = v_incident_id and type = 'incident_closed'
    and user_id = '00000000-0000-0000-0000-000000006702') into v_has_supervisor;
  perform pg_temp.check_result('4b: incident_closed -- shift_supervisor still receives nothing (unchanged)', not v_has_supervisor);

  v_op_id := gen_random_uuid();
  perform notify_operational_recipients('incident_cancelled', 'update', v_incident_id, 'x', v_op_id, '{}'::uuid[]);
  select exists(select 1 from notifications where incident_id = v_incident_id and type = 'incident_cancelled'
    and user_id = '00000000-0000-0000-0000-000000006702') into v_has_supervisor;
  perform pg_temp.check_result('4c: incident_cancelled -- shift_supervisor still receives nothing (unchanged)', not v_has_supervisor);

  v_op_id := gen_random_uuid();
  perform notify_operational_recipients('incident_reopened', 'update', v_incident_id, 'x', v_op_id, '{}'::uuid[]);
  select exists(select 1 from notifications where incident_id = v_incident_id and type = 'incident_reopened'
    and user_id = '00000000-0000-0000-0000-000000006702') into v_has_supervisor;
  perform pg_temp.check_result('4d: incident_reopened (broadcast) -- shift_supervisor still receives nothing (unchanged)', not v_has_supervisor);

  -- Regression control: professional_manager and enabled system_admin
  -- still receive these routine broadcasts exactly as before.
  select exists(select 1 from notifications where incident_id = v_incident_id and type = 'incident_reopened'
    and user_id = '00000000-0000-0000-0000-000000006703') into v_has_supervisor;
  perform pg_temp.check_result('4e: incident_reopened (broadcast) -- professional_manager still receives it (regression)', v_has_supervisor);
end $$;

-- =====================================================================
-- 5. notify_operational_recipients' signature is unchanged (same OID,
--    same grants) -- this was a body-only CREATE OR REPLACE.
-- =====================================================================
select pg_temp.check_result(
  '5: notify_operational_recipients still has exactly its original 6-argument signature',
  exists (
    select 1 from pg_proc
    where proname = 'notify_operational_recipients' and pronamespace = 'public'::regnamespace
      and pronargs = 6
  )
);
select pg_temp.check_result(
  '5b: notify_operational_recipients remains internal-only -- no PUBLIC/anon/authenticated EXECUTE',
  not has_function_privilege('anon', 'public.notify_operational_recipients(notification_type, notification_category, uuid, text, uuid, uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.notify_operational_recipients(notification_type, notification_category, uuid, text, uuid, uuid[])', 'EXECUTE')
  and not has_function_privilege('public', 'public.notify_operational_recipients(notification_type, notification_category, uuid, text, uuid, uuid[])', 'EXECUTE')
);

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
