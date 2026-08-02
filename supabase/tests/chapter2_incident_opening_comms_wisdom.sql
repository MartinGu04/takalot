-- Tests for migration 0021: incident-opening completion --
-- תקשוב למבצעים (reported_to_comms/reported_to_comms_recipient) and WISDOM
-- (wisdom_reported/wisdom_incident_number) on create_incident.
--
-- Covers: both questions default to "לא" and succeed with no dependent
-- value; "כן" without its dependent value is rejected (both at the RPC
-- validation layer AND, independently, by the table's own CHECK
-- constraints -- verified by attempting a direct INSERT bypassing the RPC
-- entirely); "כן" with a trimmed dependent value succeeds and is persisted
-- correctly; a direct RPC caller omitting the new keys entirely (mimicking
-- a pre-existing/older caller) still succeeds exactly as before; malformed
-- non-boolean-shaped values for the two questions are treated as "לא" (never
-- raise a raw cast error, since no cast is ever performed); the new
--'created' event note carries both answers; historical rows (inserted
-- directly, as any pre-migration row would be) remain fully readable and
-- unaffected; unrelated authorization/transition/grant behavior is
-- unchanged.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000c1', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-tech@test', now()),
  ('00000000-0000-0000-0000-0000000000c3', 'viewer@test', now()),
  ('00000000-0000-0000-0000-0000000000c4', 'technician-actor@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000c1', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000c2', 'Owner Technician', 'technician', true),
  ('00000000-0000-0000-0000-0000000000c3', 'Viewer', 'viewer', true),
  ('00000000-0000-0000-0000-0000000000c4', 'Technician Actor', 'technician', true);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000f801', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000f802', 'Loc', 1);

-- A HISTORICAL incident, inserted directly (as any pre-migration row would
-- exist) with no reported_to_comms/wisdom_reported values supplied at all --
-- must pick up the new columns' safe "לא" defaults and remain fully
-- readable, with no dependent value.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000f810', 'T-801',
        '00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000f802',
        'historical incident predating this migration', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000c2', now() - interval '10 days',
        '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1',
        now() + interval '4 hours', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

create or replace function pg_temp.base_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000f801', 'locationId', '00000000-0000-0000-0000-00000000f802',
    'description', 'תקלה לבדיקה', 'severity', 'low', 'operationalImpact', 'השפעה',
    'actionsTaken', 'נבדק', 'status', 'new', 'discoveredAt', now(),
    'ownerUserId', '00000000-0000-0000-0000-0000000000c2',
    'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_input(jsonb) to authenticated;

do $$
declare
  v_incident incidents;
  v_note text;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;

  -- =====================================================================
  -- 1. Both questions "לא" (explicit false) succeeds with no dependent value.
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(
      jsonb_build_object('reportedToComms', false, 'wisdomReported', false)));
    insert into results (test, result, detail) values
      ('both לא: succeeds with no dependent value stored',
        case when v_incident.reported_to_comms = false and v_incident.reported_to_comms_recipient is null
              and v_incident.wisdom_reported = false and v_incident.wisdom_incident_number is null
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values ('both לא: succeeds with no dependent value stored', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 2. A direct caller OMITTING the two new keys entirely (mimicking an
  --    older/pre-existing caller) still succeeds -- both read as "לא".
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('omitting reportedToComms/wisdomReported entirely still succeeds, reading as לא',
        case when v_incident.reported_to_comms = false and v_incident.wisdom_reported = false then 'PASS' else 'FAIL' end,
        'reported_to_comms=' || v_incident.reported_to_comms || ' wisdom_reported=' || v_incident.wisdom_reported);
  exception when others then
    insert into results (test, result, detail) values
      ('omitting reportedToComms/wisdomReported entirely still succeeds, reading as לא', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 3. תקשוב למבצעים כן WITHOUT למי דווח is rejected (RPC layer).
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('reportedToComms', true)));
    insert into results (test, result, detail) values ('comms: כן without recipient rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('comms: כן without recipient rejected',
      case when sqlerrm = 'validation: יש להזין למי דווח בתקשוב למבצעים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- Whitespace-only recipient is treated the same as absent.
  begin
    perform create_incident(pg_temp.base_input(
      jsonb_build_object('reportedToComms', true, 'reportedToCommsRecipient', '   ')));
    insert into results (test, result, detail) values ('comms: כן with whitespace-only recipient rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('comms: כן with whitespace-only recipient rejected',
      case when sqlerrm = 'validation: יש להזין למי דווח בתקשוב למבצעים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 4. תקשוב למבצעים כן WITH a (padded) recipient succeeds, trimmed.
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(
      jsonb_build_object('reportedToComms', true, 'reportedToCommsRecipient', '  אחמ"ש תקשוב  ')));
    insert into results (test, result, detail) values
      ('comms: כן with a trimmed recipient succeeds and is persisted trimmed',
        case when v_incident.reported_to_comms = true and v_incident.reported_to_comms_recipient = 'אחמ"ש תקשוב'
             then 'PASS' else 'FAIL' end, 'recipient=' || coalesce(v_incident.reported_to_comms_recipient, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('comms: כן with a trimmed recipient succeeds and is persisted trimmed', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 5. WISDOM כן WITHOUT a number is rejected (RPC layer).
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('wisdomReported', true)));
    insert into results (test, result, detail) values ('wisdom: כן without incident number rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('wisdom: כן without incident number rejected',
      case when sqlerrm = 'validation: יש להזין מספר תקלה ב-WISDOM' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 6. WISDOM כן WITH a number succeeds, trimmed, kept as a plain string
  --    (no invented numeric format).
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(
      jsonb_build_object('wisdomReported', true, 'wisdomIncidentNumber', '  WISDOM-INC-004521  ')));
    insert into results (test, result, detail) values
      ('wisdom: כן with a trimmed incident number succeeds and is persisted trimmed as text',
        case when v_incident.wisdom_reported = true and v_incident.wisdom_incident_number = 'WISDOM-INC-004521'
             then 'PASS' else 'FAIL' end, 'number=' || coalesce(v_incident.wisdom_incident_number, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('wisdom: כן with a trimmed incident number succeeds and is persisted trimmed as text', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 7. Both כן together (independent, not mutually exclusive) succeeds, and
  --    the 'created' event's note carries both answers.
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(jsonb_build_object(
      'reportedToComms', true, 'reportedToCommsRecipient', 'תקשוב מוקד',
      'wisdomReported', true, 'wisdomIncidentNumber', 'W-1')));
    select note into v_note from incident_events where incident_id = v_incident.id and type = 'created';
    insert into results (test, result, detail) values
      ('both כן together: succeeds, and the created event note carries both answers',
        case when v_note like '%תקשוב למבצעים: כן (דווח ל: תקשוב מוקד)%'
              and v_note like '%WISDOM: כן (מספר תקלה: W-1)%'
             then 'PASS' else 'FAIL' end, coalesce(v_note, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('both כן together: succeeds, and the created event note carries both answers', 'FAIL', sqlerrm);
  end;

  -- No separate reported_to_comms_change/wisdom_change event type exists --
  -- confirms the deliberate "fold into the created note, no new event type" choice.
  begin
    perform 1 from incident_events where incident_id = v_incident.id and type::text like '%comms%';
    insert into results (test, result, detail) values
      ('no separate comms/wisdom-specific event type was created', case when not found then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('no separate comms/wisdom-specific event type was created', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 8. Malformed (non-boolean-shaped) values for either question are simply
  --    treated as "לא" -- never a raw cast error, since no cast is performed.
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(
      jsonb_build_object('reportedToComms', 'not-a-boolean', 'wisdomReported', 12345)));
    insert into results (test, result, detail) values
      ('malformed non-boolean-shaped values read as לא, never a raw cast error',
        case when v_incident.reported_to_comms = false and v_incident.wisdom_reported = false then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('malformed non-boolean-shaped values read as לא, never a raw cast error', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 9. Unrelated authorization: viewer still cannot create_incident at all,
  --    regardless of these new fields. Migration 0037 lets an active
  --    technician create incidents too -- confirm that still works
  --    alongside the comms/WISDOM fields from this migration.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('reportedToComms', true, 'reportedToCommsRecipient', 'x')));
    insert into results (test, result, detail) values ('viewer still cannot create an incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('viewer still cannot create an incident',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c4');
  begin
    v_incident := create_incident(pg_temp.base_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('active technician can create an incident (0037)', 'PASS', 'number=' || v_incident.number);
  exception when others then
    insert into results (test, result, detail) values
      ('active technician can create an incident (0037)', 'FAIL', sqlerrm);
  end;

  reset role;
end $$;

-- =====================================================================
-- 10. A direct INSERT bypassing create_incident entirely cannot violate
--     either bidirectional constraint pair -- the database, not just the
--     RPC, is the final boundary.
-- =====================================================================
do $$
begin
  begin
    insert into incidents (number, system_id, location_id, description, severity, status, operational_impact,
                           owner_user_id, discovered_at, created_by, updated_by, next_update_due,
                           reported_to_comms, reported_to_comms_recipient)
    values ('T-DIRECT-1', '00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000f802',
            'd', 'low', 'in_progress', 'i', '00000000-0000-0000-0000-0000000000c2', now(),
            '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', now() + interval '1 day',
            true, null);
    insert into results (test, result, detail) values
      ('direct INSERT: comms=true with a null recipient is rejected by the CHECK constraint', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('direct INSERT: comms=true with a null recipient is rejected by the CHECK constraint',
        case when sqlstate = '23514' then 'PASS' else 'FAIL' end, 'sqlstate=' || sqlstate);
  end;
  begin
    insert into incidents (number, system_id, location_id, description, severity, status, operational_impact,
                           owner_user_id, discovered_at, created_by, updated_by, next_update_due,
                           reported_to_comms, reported_to_comms_recipient)
    values ('T-DIRECT-2', '00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000f802',
            'd', 'low', 'in_progress', 'i', '00000000-0000-0000-0000-0000000000c2', now(),
            '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', now() + interval '1 day',
            false, 'stale value');
    insert into results (test, result, detail) values
      ('direct INSERT: comms=false with a non-null recipient is rejected by the CHECK constraint', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('direct INSERT: comms=false with a non-null recipient is rejected by the CHECK constraint',
        case when sqlstate = '23514' then 'PASS' else 'FAIL' end, 'sqlstate=' || sqlstate);
  end;
  begin
    insert into incidents (number, system_id, location_id, description, severity, status, operational_impact,
                           owner_user_id, discovered_at, created_by, updated_by, next_update_due,
                           wisdom_reported, wisdom_incident_number)
    values ('T-DIRECT-3', '00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000f802',
            'd', 'low', 'in_progress', 'i', '00000000-0000-0000-0000-0000000000c2', now(),
            '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', now() + interval '1 day',
            true, '   ');
    insert into results (test, result, detail) values
      ('direct INSERT: wisdom_reported=true with a whitespace-only number is rejected by the CHECK constraint', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('direct INSERT: wisdom_reported=true with a whitespace-only number is rejected by the CHECK constraint',
        case when sqlstate = '23514' then 'PASS' else 'FAIL' end, 'sqlstate=' || sqlstate);
  end;
end $$;

-- =====================================================================
-- 11. Historical incident (inserted before this migration's columns were
--     ever populated) reads back with the safe לא defaults, unchanged.
-- =====================================================================
insert into results (test, result, detail)
select 'historical incident: reported_to_comms/wisdom_reported default safely to לא with no dependent value',
  case when reported_to_comms = false and reported_to_comms_recipient is null
        and wisdom_reported = false and wisdom_incident_number is null
       then 'PASS' else 'FAIL' end,
  'reported_to_comms=' || reported_to_comms || ' wisdom_reported=' || wisdom_reported
from incidents where id = '00000000-0000-0000-0000-00000000f810';

-- =====================================================================
-- 12. EXECUTE grants on create_incident are unchanged by this migration.
-- =====================================================================
insert into results (test, result, detail)
select 'create_incident: authenticated retains EXECUTE',
  case when exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'public' and p.proname = 'create_incident'
      and a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  ) then 'PASS' else 'FAIL' end, '';
insert into results (test, result, detail)
select 'create_incident: no PUBLIC/anon EXECUTE',
  case when not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'public' and p.proname = 'create_incident'
      and (a.grantee = 0 or a.grantee = 'anon'::regrole) and a.privilege_type = 'EXECUTE'
  ) then 'PASS' else 'FAIL' end, '';

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
