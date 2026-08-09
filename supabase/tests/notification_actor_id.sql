-- Focused verification for migration 0056 (AVARIA v1.5.0 Push actor name
-- polish, data layer): notifications.actor_id exists, is populated with
-- auth.uid() by every notification-producing call site this migration
-- touches, stays NULL for the one deliberately-untouched call site
-- (create_handover's handover_pending notification, out of scope for this
-- change), and is never populated with anything other than the true actor
-- (never the recipient, never a bystander). Runs in one transaction that
-- rolls back at the end; leaves the database unchanged.
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
-- Fixtures: two operational actors (one creates/assigns/reopens, one is
-- the recipient/owner throughout -- so "actor" and "recipient" are never
-- accidentally the same row, which would mask a mix-up between the two).
-- =====================================================================
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000006601', 'actor-6601@test', now()),
  ('00000000-0000-0000-0000-000000006602', 'owner-6602@test', now()),
  ('00000000-0000-0000-0000-000000006603', 'broadcast-recipient-6603@test', now());
insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000006601', 'Actor Person', 'professional_manager', true),
  ('00000000-0000-0000-0000-000000006602', 'Owner Person', 'technician', true),
  ('00000000-0000-0000-0000-000000006603', 'Broadcast Recipient', 'professional_manager', true);
insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000e601', 'Sys 6601', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000e602', 'Loc 6601', 1);

select pg_temp.as_user('00000000-0000-0000-0000-000000006601');

-- =====================================================================
-- 1. notifications.actor_id exists and references profiles.
-- =====================================================================
select pg_temp.check_result(
  '1: notifications.actor_id exists as a nullable uuid column',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications'
      and column_name = 'actor_id' and data_type = 'uuid' and is_nullable = 'YES'
  )
);
select pg_temp.check_result(
  '1: notifications.actor_id has a foreign key to profiles(id)',
  exists (
    select 1
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu using (constraint_name, table_schema)
    join information_schema.constraint_column_usage ccu using (constraint_name, table_schema)
    where tc.table_schema = 'public' and tc.table_name = 'notifications'
      and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'actor_id'
      and ccu.table_name = 'profiles' and ccu.column_name = 'id'
  )
);

-- =====================================================================
-- 2. create_incident_impl: the personal incident_assigned notification
--    (owner set to a different person at creation time) carries the
--    creating actor, never the recipient/owner.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_actor_id uuid;
  v_broadcast_actor_id uuid;
begin
  v_incident := create_incident(jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000e601', 'locationId', '00000000-0000-0000-0000-00000000e602',
    'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
    'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-000000006602',
    'discoveredAt', now(), 'reportedToOps', 'not_required'));

  select actor_id into v_actor_id from notifications
    where incident_id = v_incident.id and type = 'incident_assigned' and user_id = '00000000-0000-0000-0000-000000006602';
  perform pg_temp.check_result(
    '2: create_incident_impl -- incident_assigned notification.actor_id = the creating actor',
    v_actor_id = '00000000-0000-0000-0000-000000006601', coalesce(v_actor_id::text, 'null'));

  select actor_id into v_broadcast_actor_id from notifications
    where incident_id = v_incident.id and type = 'incident_opened' and user_id = '00000000-0000-0000-0000-000000006603';
  perform pg_temp.check_result(
    '2b: create_incident_impl -- via notify_operational_recipients, the incident_opened broadcast also carries the actor',
    v_broadcast_actor_id = '00000000-0000-0000-0000-000000006601', coalesce(v_broadcast_actor_id::text, 'null'));
end $$;

-- =====================================================================
-- 3. assign_incident: reassigning ownership carries the assigning actor.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_actor_id uuid;
begin
  v_incident := create_incident(jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000e601', 'locationId', '00000000-0000-0000-0000-00000000e602',
    'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
    'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-000000006601',
    'discoveredAt', now(), 'reportedToOps', 'not_required'));

  v_incident := assign_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_incident.version, 'ownerUserId', '00000000-0000-0000-0000-000000006602'));

  select actor_id into v_actor_id from notifications
    where incident_id = v_incident.id and type = 'incident_assigned' and user_id = '00000000-0000-0000-0000-000000006602';
  perform pg_temp.check_result(
    '3: assign_incident -- incident_assigned notification.actor_id = the assigning actor',
    v_actor_id = '00000000-0000-0000-0000-000000006601', coalesce(v_actor_id::text, 'null'));
end $$;

-- =====================================================================
-- 4. update_incident: reassigning ownership during an update carries the
--    updating actor.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_actor_id uuid;
begin
  v_incident := create_incident(jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000e601', 'locationId', '00000000-0000-0000-0000-00000000e602',
    'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
    'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-000000006601',
    'discoveredAt', now(), 'reportedToOps', 'not_required'));

  v_incident := update_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_incident.version, 'eventTime', now(), 'actionsTaken', 'a2', 'findings', '', 'nextSteps', '',
    'status', 'in_progress', 'severity', 'low', 'operationalImpact', 'i', 'changeReason', '',
    'ownerUserId', '00000000-0000-0000-0000-000000006602', 'nextUpdateDue', now() + interval '1 day',
    'reportedToOps', 'not_required'));

  select actor_id into v_actor_id from notifications
    where incident_id = v_incident.id and type = 'incident_assigned' and user_id = '00000000-0000-0000-0000-000000006602';
  perform pg_temp.check_result(
    '4: update_incident -- incident_assigned notification.actor_id = the updating actor',
    v_actor_id = '00000000-0000-0000-0000-000000006601', coalesce(v_actor_id::text, 'null'));
end $$;

-- =====================================================================
-- 5. reopen_incident: the personal incident_reopened notification (to the
--    responsible owner) carries the reopening actor.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_actor_id uuid;
begin
  v_incident := create_incident(jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000e601', 'locationId', '00000000-0000-0000-0000-00000000e602',
    'description', 'd', 'severity', 'low', 'operationalImpact', 'i', 'actionsTaken', 'a',
    'status', 'in_progress', 'ownerUserId', '00000000-0000-0000-0000-000000006601',
    'discoveredAt', now(), 'reportedToOps', 'not_required'));
  v_incident := close_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_incident.version, 'eventTime', now(), 'rootCause', 'c', 'resolution', 'r',
    'readiness', 'full', 'followUpNotes', '', 'reportedToOps', 'not_required'));

  v_incident := reopen_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_incident.version, 'reason', 'חזרה', 'ownerUserId', '00000000-0000-0000-0000-000000006602'));

  select actor_id into v_actor_id from notifications
    where incident_id = v_incident.id and type = 'incident_reopened' and user_id = '00000000-0000-0000-0000-000000006602';
  perform pg_temp.check_result(
    '5: reopen_incident -- incident_reopened notification.actor_id = the reopening actor',
    v_actor_id = '00000000-0000-0000-0000-000000006601', coalesce(v_actor_id::text, 'null'));
end $$;

-- =====================================================================
-- 6. create_handover's handover_pending notification is DELIBERATELY
--    untouched by this migration -- its actor_id stays NULL. This locks
--    in the declared scope boundary: only the three approved Push copy
--    variants gain an actor.
-- =====================================================================
do $$
declare
  v_handover handovers;
  v_actor_id uuid;
  v_has_row boolean;
begin
  v_handover := create_handover(jsonb_build_object('toUserId', '00000000-0000-0000-0000-000000006602'));

  select actor_id, true into v_actor_id, v_has_row from notifications
    where handover_id = v_handover.id and type = 'handover_pending';
  perform pg_temp.check_result(
    '6: create_handover -- handover_pending notification exists for this scenario',
    coalesce(v_has_row, false));
  perform pg_temp.check_result(
    '6b: create_handover -- handover_pending notification.actor_id stays NULL (out of this change''s scope)',
    v_actor_id is null, coalesce(v_actor_id::text, 'null'));
end $$;

-- =====================================================================
-- 7. A notification inserted with no actor_id at all (legacy shape, or
--    any future caller that omits the column) remains a normal NULL row
--    -- never an error, never defaulted to anything.
-- =====================================================================
do $$
declare
  v_actor_id uuid;
  v_had_error boolean := false;
begin
  begin
    insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006602', 'incident_assigned', 'legacy shape', 'action_required');
  exception when others then
    v_had_error := true;
  end;
  perform pg_temp.check_result('7: an actor_id-omitting insert still succeeds (column is optional, not required)', not v_had_error);

  select actor_id into v_actor_id from notifications
    where user_id = '00000000-0000-0000-0000-000000006602' and text = 'legacy shape';
  perform pg_temp.check_result(
    '7b: an actor_id-omitting insert leaves actor_id NULL, not defaulted',
    v_actor_id is null, coalesce(v_actor_id::text, 'null'));
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
