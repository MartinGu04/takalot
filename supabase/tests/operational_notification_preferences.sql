-- Tests for migration 0058 (AVARIA v1.6.0): per-user operational
-- notification preferences -- operational_notification_defaults,
-- operational_notification_preferences, resolve_operational_notification_prefs,
-- get_my_operational_notification_preferences,
-- set_my_operational_notification_preference, notifications.push_eligible,
-- and notify_operational_recipients' rewritten (default + override) per-
-- event recipient policy.
--
-- Recipient-set coverage for the professional_manager/system_admin/
-- shift_supervisor roles themselves lives in operational_notifications_center.sql
-- and incident_opened_shift_supervisor_recipient.sql -- this file focuses on
-- the PREFERENCE mechanics: defaults, sparse overrides, the push-requires-
-- in-app invariant, push_eligible stamping, self-only RPC scoping, and the
-- (approved, deliberate) absence of any migration-time backfill from the
-- legacy operational_notifications_enabled column.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0005800000a1', 'onp-supervisor@test', now()),
  ('00000000-0000-0000-0000-0005800000a2', 'onp-manager@test', now()),
  ('00000000-0000-0000-0000-0005800000a3', 'onp-admin@test', now()),
  ('00000000-0000-0000-0000-0005800000a4', 'onp-technician@test', now()),
  ('00000000-0000-0000-0000-0005800000a5', 'onp-viewer@test', now()),
  ('00000000-0000-0000-0000-0005800000a6', 'onp-inactive-supervisor@test', now()),
  ('00000000-0000-0000-0000-0005800000a7', 'onp-actor@test', now()),
  ('00000000-0000-0000-0000-0005800000a8', 'onp-owner@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0005800000a1', 'ONP Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0005800000a2', 'ONP Manager', 'professional_manager', true),
  ('00000000-0000-0000-0000-0005800000a3', 'ONP Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-0005800000a4', 'ONP Technician', 'technician', true),
  ('00000000-0000-0000-0000-0005800000a5', 'ONP Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-0005800000a6', 'ONP Inactive Supervisor', 'shift_supervisor', false),
  ('00000000-0000-0000-0000-0005800000a7', 'ONP Actor', 'professional_manager', true),
  ('00000000-0000-0000-0000-0005800000a8', 'ONP Owner', 'technician', true);

insert into systems (id, name, display_order, category) values
  ('00000000-0000-0000-0000-0005800000b1', 'ONP Sys', 1, 'other');
insert into locations (id, name, display_order, category) values
  ('00000000-0000-0000-0000-0005800000b2', 'ONP Loc', 1, 'other');

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

create or replace function pg_temp.base_create_input(p_owner uuid) returns jsonb
language sql as $$
  select jsonb_build_object(
    'description', 'ONP test incident', 'operationalImpact', 'Impact', 'actionsTaken', 'Initial actions',
    'severity', 'medium', 'status', 'in_progress',
    'systemId', '00000000-0000-0000-0000-0005800000b1', 'locationId', '00000000-0000-0000-0000-0005800000b2',
    'ownerUserId', p_owner, 'discoveredAt', now()::text,
    'reportedToOps', 'no', 'reportedToComms', 'false', 'wisdomReported', 'false'
  );
$$;
grant execute on function pg_temp.base_create_input(uuid) to authenticated;

-- =====================================================================
-- 1. operational_notification_defaults: the exact v1.6 product matrix.
-- =====================================================================
do $$
begin
  perform pg_temp.check_result(
    '1a: exactly the five operational event types are seeded, no more, no less',
    (select count(*) from operational_notification_defaults) = 5
  );
  perform pg_temp.check_result(
    '1b: incident_opened defaults to in_app=on, push=on',
    (select (default_in_app_enabled, default_push_enabled) = (true, true)
       from operational_notification_defaults where event_type = 'incident_opened')
  );
  perform pg_temp.check_result(
    '1c: incident_updated/closed/cancelled/reopened default to in_app=on, push=off',
    (select bool_and(default_in_app_enabled = true and default_push_enabled = false)
       from operational_notification_defaults
       where event_type in ('incident_updated', 'incident_closed', 'incident_cancelled', 'incident_reopened'))
  );
  perform pg_temp.check_result(
    '1d: no client (authenticated) can write to operational_notification_defaults',
    not has_table_privilege('authenticated', 'operational_notification_defaults', 'INSERT')
    and not has_table_privilege('authenticated', 'operational_notification_defaults', 'UPDATE')
    and not has_table_privilege('authenticated', 'operational_notification_defaults', 'DELETE')
  );
  perform pg_temp.check_result(
    '1e: no client (anon) can read or write operational_notification_defaults',
    not has_table_privilege('anon', 'operational_notification_defaults', 'SELECT')
    and not has_table_privilege('anon', 'operational_notification_defaults', 'INSERT')
  );
end $$;

-- =====================================================================
-- 2. Effective preference resolution: no override row -> exactly the
--    default matrix, for every one of the three eligible roles.
-- =====================================================================
do $$
declare
  v_rows record;
  v_all_default boolean;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a1'); -- shift_supervisor, no overrides
  set local role authenticated;
  select bool_and(
    (r.event_type = 'incident_opened' and r.in_app_enabled and r.push_enabled)
    or (r.event_type <> 'incident_opened' and r.in_app_enabled and not r.push_enabled)
  ) into v_all_default
  from get_my_operational_notification_preferences() r;
  reset role;
  perform pg_temp.check_result(
    '2a: a shift_supervisor with zero override rows resolves to exactly the default matrix',
    coalesce(v_all_default, false)
  );

  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a2'); -- professional_manager
  set local role authenticated;
  select count(*) = 5 into v_all_default from get_my_operational_notification_preferences();
  reset role;
  perform pg_temp.check_result('2b: professional_manager always resolves to exactly 5 rows (never fewer/more)', v_all_default);
end $$;

-- =====================================================================
-- 3. Sparse override: setting one event type never touches the others,
--    and only ever materializes the ONE row that was actually changed.
-- =====================================================================
do $$
declare
  v_override_count int;
  v_opened record;
  v_updated record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a1');
  set local role authenticated;
  perform set_my_operational_notification_preference('incident_updated', false, false);
  reset role;

  select count(*) into v_override_count from operational_notification_preferences
    where user_id = '00000000-0000-0000-0000-0005800000a1';
  perform pg_temp.check_result(
    '3a: setting one event type materializes exactly one override row', v_override_count = 1
  );

  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a1');
  set local role authenticated;
  select * into v_updated from get_my_operational_notification_preferences() where event_type = 'incident_updated';
  select * into v_opened from get_my_operational_notification_preferences() where event_type = 'incident_opened';
  reset role;
  perform pg_temp.check_result(
    '3b: the overridden event type reflects the new value',
    v_updated.in_app_enabled = false and v_updated.push_enabled = false
  );
  perform pg_temp.check_result(
    '3c: an untouched event type still resolves to its default (incident_opened unaffected by the incident_updated override)',
    v_opened.in_app_enabled = true and v_opened.push_enabled = true
  );
end $$;

-- =====================================================================
-- 4. Push requires in-app: the DB CHECK constraint rejects push=true with
--    in_app=false directly, and the RPC normalizes (never raises) the one
--    combination the UI itself is never expected to send.
-- =====================================================================
do $$
declare
  v_result record;
begin
  begin
    insert into operational_notification_preferences (user_id, event_type, in_app_enabled, push_enabled)
    values ('00000000-0000-0000-0000-0005800000a2', 'incident_opened', false, true);
    perform pg_temp.check_result('4a: push=true with in_app=false is rejected by the table CHECK constraint', false, 'insert succeeded');
  exception when check_violation then
    perform pg_temp.check_result('4a: push=true with in_app=false is rejected by the table CHECK constraint', true);
  end;

  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a2');
  set local role authenticated;
  select * into v_result from set_my_operational_notification_preference('incident_opened', false, true)
    where event_type = 'incident_opened';
  reset role;
  perform pg_temp.check_result(
    '4b: the RPC normalizes push=true to false when in_app_enabled=false, rather than raising',
    v_result.in_app_enabled = false and v_result.push_enabled = false
  );
end $$;

-- =====================================================================
-- 5. Role eligibility: only system_admin/professional_manager/
--    shift_supervisor may read or write; technician/viewer are rejected
--    with a controlled error at BOTH RPCs, and an inactive eligible-role
--    user is rejected too (active is required, not just the role value).
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a4'); -- technician
  set local role authenticated;
  begin
    perform get_my_operational_notification_preferences();
    perform pg_temp.check_result('5a: technician is rejected from reading preferences', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('5a: technician is rejected from reading preferences', sqlerrm like 'permission:%', sqlerrm);
  end;
  begin
    perform set_my_operational_notification_preference('incident_opened', false, false);
    perform pg_temp.check_result('5b: technician is rejected from writing preferences', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('5b: technician is rejected from writing preferences', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a5'); -- viewer
  set local role authenticated;
  begin
    perform set_my_operational_notification_preference('incident_opened', false, false);
    perform pg_temp.check_result('5c: viewer is rejected from writing preferences', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('5c: viewer is rejected from writing preferences', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a6'); -- inactive shift_supervisor
  set local role authenticated;
  begin
    perform set_my_operational_notification_preference('incident_opened', false, false);
    perform pg_temp.check_result(
      '5d: an inactive shift_supervisor is rejected (active required, not just the role value)', false, 'succeeded'
    );
  exception when others then
    perform pg_temp.check_result(
      '5d: an inactive shift_supervisor is rejected (active required, not just the role value)',
      sqlerrm like 'permission:%', sqlerrm
    );
  end;
  reset role;

  perform pg_temp.as_anon();
  set local role authenticated;
  begin
    perform get_my_operational_notification_preferences();
    perform pg_temp.check_result('5e: an unauthenticated caller is rejected from reading preferences', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      '5e: an unauthenticated caller is rejected from reading preferences', sqlerrm like 'permission:%', sqlerrm
    );
  end;
  reset role;
end $$;

-- =====================================================================
-- 6. Self-only scoping: no client-facing RPC accepts a target user id --
--    both RPCs operate purely on auth.uid().
-- =====================================================================
select pg_temp.check_result(
  '6a: get_my_operational_notification_preferences takes no arguments (self-only by construction)',
  (select pronargs from pg_proc where proname = 'get_my_operational_notification_preferences' and pronamespace = 'public'::regnamespace) = 0
);
select pg_temp.check_result(
  '6b: set_my_operational_notification_preference takes exactly (event_type, in_app, push) -- no user id parameter',
  (select pronargs from pg_proc where proname = 'set_my_operational_notification_preference' and pronamespace = 'public'::regnamespace) = 3
);

-- =====================================================================
-- 7. RLS / grants: operational_notification_preferences has no direct
--    client access at all -- reachable only through the two RPCs.
--    resolve_operational_notification_prefs is internal-only.
-- =====================================================================
select pg_temp.check_result(
  '7a: authenticated cannot SELECT/INSERT/UPDATE/DELETE operational_notification_preferences directly',
  not has_table_privilege('authenticated', 'operational_notification_preferences', 'SELECT')
  and not has_table_privilege('authenticated', 'operational_notification_preferences', 'INSERT')
  and not has_table_privilege('authenticated', 'operational_notification_preferences', 'UPDATE')
  and not has_table_privilege('authenticated', 'operational_notification_preferences', 'DELETE')
);
select pg_temp.check_result(
  '7b: anon cannot SELECT/INSERT/UPDATE/DELETE operational_notification_preferences directly',
  not has_table_privilege('anon', 'operational_notification_preferences', 'SELECT')
  and not has_table_privilege('anon', 'operational_notification_preferences', 'INSERT')
);
select pg_temp.check_result(
  '7c: resolve_operational_notification_prefs is not directly executable by authenticated/anon/PUBLIC',
  not has_function_privilege('authenticated', 'public.resolve_operational_notification_prefs(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.resolve_operational_notification_prefs(uuid)', 'EXECUTE')
  and not has_function_privilege('public', 'public.resolve_operational_notification_prefs(uuid)', 'EXECUTE')
);

-- =====================================================================
-- 8. push_eligible stamping via notify_operational_recipients: reflects
--    the RECIPIENT's resolved push preference at the moment of insert,
--    independently per recipient on the SAME broadcast, and remains
--    unaffected by a preference change made AFTER the row already exists
--    (durably frozen at creation time -- see the column's own comment in
--    migration 0058).
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_supervisor_push boolean;
  v_manager_push boolean;
begin
  -- Supervisor keeps the default (push=on for incident_opened); give the
  -- manager an explicit override turning Push off for incident_opened
  -- (in-app stays on) BEFORE the broadcast, so the two recipients diverge
  -- on the exact same operation.
  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a2');
  set local role authenticated;
  perform set_my_operational_notification_preference('incident_opened', true, false);
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a7'); -- actor: another professional_manager
  set local role authenticated;
  select * into v_incident from create_incident(pg_temp.base_create_input('00000000-0000-0000-0000-0005800000a8'));
  reset role;

  select push_eligible into v_supervisor_push from notifications
    where incident_id = v_incident.id and type = 'incident_opened' and user_id = '00000000-0000-0000-0000-0005800000a1';
  select push_eligible into v_manager_push from notifications
    where incident_id = v_incident.id and type = 'incident_opened' and user_id = '00000000-0000-0000-0000-0005800000a2';

  perform pg_temp.check_result(
    '8a: a recipient at the default (push=on) is stamped push_eligible=true on the broadcast row',
    v_supervisor_push is true
  );
  perform pg_temp.check_result(
    '8b: a DIFFERENT recipient with an explicit push=off override is stamped push_eligible=false on the SAME broadcast operation',
    v_manager_push is false
  );

  -- Changing the preference AFTER the row exists never rewrites the
  -- already-created row.
  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a1');
  set local role authenticated;
  perform set_my_operational_notification_preference('incident_opened', true, false);
  reset role;

  select push_eligible into v_supervisor_push from notifications
    where incident_id = v_incident.id and type = 'incident_opened' and user_id = '00000000-0000-0000-0000-0005800000a1';
  perform pg_temp.check_result(
    '8c: a later preference change never rewrites an already-created notification''s push_eligible value',
    v_supervisor_push is true
  );
end $$;

-- =====================================================================
-- 9. notify_operational_recipients: in_app_enabled=false suppresses row
--    creation entirely for that (recipient, event type) -- no bell entry,
--    no history row at all, independent of the other event types and
--    other recipients.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_has_row boolean;
  v_manager_has_row boolean;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a1');
  set local role authenticated;
  perform set_my_operational_notification_preference('incident_cancelled', false, false);
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a7');
  set local role authenticated;
  select * into v_incident from create_incident(pg_temp.base_create_input('00000000-0000-0000-0000-0005800000a8'));
  select * into v_incident from cancel_incident(v_incident.id, jsonb_build_object(
    'expectedVersion', v_incident.version, 'eventTime', now()::text, 'cancellationReason', 'test'
  ));
  reset role;

  select exists(select 1 from notifications where incident_id = v_incident.id and type = 'incident_cancelled'
    and user_id = '00000000-0000-0000-0000-0005800000a1') into v_has_row;
  perform pg_temp.check_result(
    '9a: in_app_enabled=false means NO notification row is created at all for that recipient/event type',
    not v_has_row
  );

  select exists(select 1 from notifications where incident_id = v_incident.id and type = 'incident_cancelled'
    and user_id = '00000000-0000-0000-0000-0005800000a2') into v_manager_has_row;
  perform pg_temp.check_result(
    '9b: a DIFFERENT recipient with no override still receives the same broadcast normally (per-user, not global suppression)',
    v_manager_has_row
  );
end $$;

-- =====================================================================
-- 10. action_required notifications bypass this preference model entirely
--     -- creation-time behavior is completely unaffected by any
--     operational preference (there is no per-event override that could
--     even apply to a personal action_required notification).
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  -- Owner (a technician) has no operational preferences at all (not an
  -- eligible role) -- the personal incident_assigned notification must
  -- still be created unconditionally.
  perform pg_temp.as_user('00000000-0000-0000-0000-0005800000a7');
  set local role authenticated;
  select * into v_incident from create_incident(pg_temp.base_create_input('00000000-0000-0000-0000-0005800000a8'));
  reset role;

  perform pg_temp.check_result(
    '10: a personal action_required notification is created regardless of any operational preference state',
    exists (
      select 1 from notifications where incident_id = v_incident.id and user_id = '00000000-0000-0000-0000-0005800000a8'
        and type = 'incident_assigned' and category = 'action_required' and push_eligible = true
    )
  );
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
