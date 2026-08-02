-- Tests for migration 0019: create_incident requires a valid, active
-- internal owner (בעל אחריות פנימי) and rejects external-owner-only (or
-- external-alongside-internal) creation. assert_owner_valid itself is
-- untouched.
--
-- As of migration 0032 (additive external handling party), the mandatory-
-- internal-owner rule was intentionally extended to update_incident (and
-- assign_incident/close_incident/reopen_incident) as well -- see test 14
-- below, which now asserts the *current* contract rather than the historical
-- isolation-to-create_incident-only behavior. The legacy `ownerExternalName`
-- payload key is tolerated but silently ignored by these RPCs; it is never
-- read, written, or used to clear `owner_external_name`. Full external-
-- handling-party coverage lives in chapter2_external_handling_party.sql.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000b1', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000b2', 'active-owner@test', now()),
  ('00000000-0000-0000-0000-0000000000b3', 'inactive-owner@test', now()),
  ('00000000-0000-0000-0000-0000000000b4', 'tombstoned-owner@test', now()),
  ('00000000-0000-0000-0000-0000000000b5', 'technician-actor@test', now()),
  ('00000000-0000-0000-0000-0000000000b6', 'viewer-actor@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000b1', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000b2', 'Active Owner', 'technician', true),
  ('00000000-0000-0000-0000-0000000000b3', 'Inactive Owner', 'technician', false),
  ('00000000-0000-0000-0000-0000000000b5', 'Technician Actor', 'technician', true),
  ('00000000-0000-0000-0000-0000000000b6', 'Viewer Actor', 'viewer', true);
-- Tombstoned: profiles_deleted_implies_inactive (0012) guarantees active =
-- false whenever deleted_at is set -- this fixture matches that real,
-- DB-enforced shape.
insert into profiles (id, full_name, role, active, deleted_at, deleted_by) values
  ('00000000-0000-0000-0000-0000000000b4', 'Tombstoned Owner', 'technician', false, now(), '00000000-0000-0000-0000-0000000000b1');

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000f601', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000f602', 'Loc', 1);

-- A HISTORICAL incident with external-owner-only, inserted directly (as any
-- pre-migration row would exist) -- must remain fully readable and
-- untouched by this migration and everything else in this test.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_external_name, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000f610', 'T-601',
        '00000000-0000-0000-0000-00000000f601', '00000000-0000-0000-0000-00000000f602',
        'historical external-owner incident', 'medium', 'in_progress', 'impact',
        'טכנאי מטעם ספק (היסטורי)', now() - interval '10 days',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1',
        now() + interval '4 hours', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

create or replace function pg_temp.base_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000f601', 'locationId', '00000000-0000-0000-0000-00000000f602',
    'description', 'תקלה לבדיקה', 'severity', 'low', 'operationalImpact', 'השפעה',
    'actionsTaken', 'נבדק', 'status', 'new', 'discoveredAt', now(),
    'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_input(jsonb) to authenticated;

do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;

  -- =====================================================================
  -- 1. A valid active internal owner succeeds.
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000b2')));
    insert into results (test, result, detail) values
      ('valid active internal owner succeeds',
        case when v_incident.owner_user_id = '00000000-0000-0000-0000-0000000000b2'
              and v_incident.owner_external_name is null
             then 'PASS' else 'FAIL' end,
        'owner_user_id=' || v_incident.owner_user_id || ' owner_external_name=' || coalesce(v_incident.owner_external_name, '<null>'));
  exception when others then
    insert into results (test, result, detail) values ('valid active internal owner succeeds', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 2. Missing ownerUserId key entirely is rejected.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input('{}'::jsonb) - 'ownerUserId');
    insert into results (test, result, detail) values ('missing ownerUserId key is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('missing ownerUserId key is rejected',
      case when sqlerrm = 'validation: יש לבחור בעל אחריות פנימי' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 3. JSON-null ownerUserId is rejected.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('ownerUserId', null)));
    insert into results (test, result, detail) values ('JSON-null ownerUserId is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('JSON-null ownerUserId is rejected',
      case when sqlerrm = 'validation: יש לבחור בעל אחריות פנימי' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 4. Empty / whitespace-only ownerUserId is rejected with a controlled
  --    validation error, NOT a raw UUID-cast error.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('ownerUserId', '')));
    insert into results (test, result, detail) values ('empty-string ownerUserId is rejected cleanly', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('empty-string ownerUserId is rejected cleanly',
      case when sqlerrm = 'validation: יש לבחור בעל אחריות פנימי' then 'PASS' else 'FAIL' end, sqlstate || ': ' || sqlerrm);
  end;
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('ownerUserId', '   ')));
    insert into results (test, result, detail) values ('whitespace-only ownerUserId is rejected cleanly', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('whitespace-only ownerUserId is rejected cleanly',
      case when sqlerrm = 'validation: יש לבחור בעל אחריות פנימי' then 'PASS' else 'FAIL' end, sqlstate || ': ' || sqlerrm);
  end;

  -- =====================================================================
  -- 4b. A non-empty but malformed UUID (e.g. "not-a-uuid") must be
  --     rejected as a controlled validation error -- SQLSTATE P0001 (the
  --     project's own raise-exception convention), NEVER 22P02
  --     (invalid_text_representation, PostgreSQL's raw UUID-parser error).
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('ownerUserId', 'not-a-uuid')));
    insert into results (test, result, detail) values ('malformed (non-UUID) ownerUserId is rejected cleanly', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('malformed (non-UUID) ownerUserId is rejected cleanly',
      case when sqlstate = 'P0001'
            and sqlerrm = 'validation: בעל האחריות הפנימי שנבחר אינו תקין'
           then 'PASS' else 'FAIL' end,
      sqlstate || ': ' || sqlerrm);
  end;
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('ownerUserId', '12345')));
    insert into results (test, result, detail) values ('another malformed ownerUserId shape is rejected cleanly, not as a raw cast error', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('another malformed ownerUserId shape is rejected cleanly, not as a raw cast error',
      case when sqlstate = 'P0001' and sqlstate <> '22P02' then 'PASS' else 'FAIL' end,
      sqlstate || ': ' || sqlerrm);
  end;

  -- =====================================================================
  -- 5. External-owner-only creation is rejected (caught by the
  --    owner-required check first, before the external-name check).
  -- =====================================================================
  begin
    perform create_incident((pg_temp.base_input(
      jsonb_build_object('ownerExternalName', 'טכנאי מטעם ספק')) - 'ownerUserId'));
    insert into results (test, result, detail) values ('external-owner-only creation is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('external-owner-only creation is rejected',
      case when sqlerrm like 'validation:%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 6. Both an internal AND external owner supplied together is rejected.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object(
      'ownerUserId', '00000000-0000-0000-0000-0000000000b2', 'ownerExternalName', 'טכנאי מטעם ספק')));
    insert into results (test, result, detail) values ('internal + external owner together is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('internal + external owner together is rejected',
      case when sqlerrm = 'validation: לא ניתן לקבוע גורם חיצוני כבעל אחריות בעת פתיחת תקלה' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 7. Inactive owner is rejected.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000b3')));
    insert into results (test, result, detail) values ('inactive owner is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('inactive owner is rejected',
      case when sqlerrm = 'validation: הגורם המטפל שנבחר אינו פעיל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 8. Deleted / tombstoned owner is rejected.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000b4')));
    insert into results (test, result, detail) values ('tombstoned owner is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('tombstoned owner is rejected',
      case when sqlerrm = 'validation: הגורם המטפל שנבחר אינו פעיל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 9. Unknown (syntactically valid, nonexistent) UUID is rejected.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-000000000000')));
    insert into results (test, result, detail) values ('unknown owner UUID is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('unknown owner UUID is rejected',
      case when sqlerrm = 'validation: הגורם המטפל שנבחר אינו פעיל' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 10. Authorized operational role (shift_supervisor, already the actor
  --     above) succeeded in test 1 -- this reconfirms with a valid input
  --     one more time to isolate it from the owner-rule tests around it.
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000b2')));
    insert into results (test, result, detail) values
      ('authorized operational role can still create incidents', 'PASS', 'number=' || v_incident.number);
  exception when others then
    insert into results (test, result, detail) values
      ('authorized operational role can still create incidents', 'FAIL', sqlerrm);
  end;

  reset role;
end $$;

-- =====================================================================
-- 11. Migration 0037: an active technician may now create an incident too
--     -- viewer remains rejected.
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b5');
  set local role authenticated;
  begin
    v_incident := create_incident(pg_temp.base_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000b2')));
    insert into results (test, result, detail) values
      ('active technician can create an incident (0037)', 'PASS', 'number=' || v_incident.number);
  exception when others then
    insert into results (test, result, detail) values
      ('active technician can create an incident (0037)', 'FAIL', sqlerrm);
  end;
  reset role;
end $$;

do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b6');
  set local role authenticated;
  begin
    perform create_incident(pg_temp.base_input(
      jsonb_build_object('ownerUserId', '00000000-0000-0000-0000-0000000000b2')));
    insert into results (test, result, detail) values ('viewer cannot create an incident', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('viewer cannot create an incident',
      case when sqlerrm = 'permission: אין הרשאה לפתוח תקלה' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 12. The historical external-owner-only incident remains readable and
--     completely unchanged after this migration and every test above.
-- =====================================================================
insert into results (test, result, detail)
select 'historical external-owner incident remains readable and unchanged',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from incidents
where id = '00000000-0000-0000-0000-00000000f610'
  and owner_user_id is null
  and owner_external_name = 'טכנאי מטעם ספק (היסטורי)'
  and version = 1;

-- =====================================================================
-- 13. create_incident's EXECUTE grants are unchanged: authenticated has
--     it, public/anon do not (same as every prior migration).
-- =====================================================================
insert into results (test, result, detail)
select 'authenticated retains EXECUTE on create_incident',
  case when count(*) = 1 then 'PASS' else 'FAIL' end, 'rows=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'create_incident'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE'
  );

insert into results (test, result, detail)
select 'create_incident still has no PUBLIC or anon EXECUTE',
  case when count(*) = 0 then 'PASS' else 'FAIL' end, 'violations=' || count(*)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'create_incident'
  and exists (
    select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where (a.grantee = 0 or a.grantee = 'anon'::regrole) and a.privilege_type = 'EXECUTE'
  );

-- =====================================================================
-- 14. Post-0032: update_incident now ALSO requires a valid internal owner
--     on every call (the mandatory-owner rule was intentionally extended
--     beyond create_incident by migration 0032). Supplying only a legacy
--     ownerExternalName, with no ownerUserId, is rejected with the same
--     controlled error create_incident uses.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;
  begin
    perform update_incident('00000000-0000-0000-0000-00000000f610', jsonb_build_object(
      'expectedVersion', 1, 'eventTime', now(), 'actionsTaken', 'עדכון בדיקה',
      'status', 'in_progress', 'severity', 'medium',
      'ownerExternalName', 'טכנאי מטעם ספק (מעודכן)',
      'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values
      ('update_incident now requires an internal owner too -- external-only is rejected',
        'FAIL', 'expected rejection, call unexpectedly succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident now requires an internal owner too -- external-only is rejected',
        case when sqlerrm = 'validation: יש לבחור בעל אחריות פנימי' then 'PASS' else 'FAIL' end,
        sqlerrm);
  end;
  reset role;
end $$;

-- =====================================================================
-- 14b. Legacy ownerExternalName is tolerated but ignored once a valid
--      internal owner is supplied: the historical external-owner-only
--      incident's owner_external_name column survives byte-identical --
--      neither overwritten with the supplied value nor cleared.
-- =====================================================================
do $$
declare
  v_updated incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  set local role authenticated;
  begin
    v_updated := update_incident('00000000-0000-0000-0000-00000000f610', jsonb_build_object(
      'expectedVersion', 1, 'eventTime', now(), 'actionsTaken', 'עדכון בדיקה',
      'status', 'in_progress', 'severity', 'medium',
      'ownerUserId', '00000000-0000-0000-0000-0000000000b2',
      'ownerExternalName', 'טכנאי מטעם ספק (מעודכן)',
      'reportedToOps', 'not_required'));
    insert into results (test, result, detail) values
      ('legacy ownerExternalName is tolerated but ignored -- owner_external_name untouched',
        case when v_updated.owner_user_id::text = '00000000-0000-0000-0000-0000000000b2'
              and v_updated.owner_external_name = 'טכנאי מטעם ספק (היסטורי)'
             then 'PASS' else 'FAIL' end,
        'owner_user_id=' || coalesce(v_updated.owner_user_id::text, '<null>')
        || ' owner_external_name=' || coalesce(v_updated.owner_external_name, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('legacy ownerExternalName is tolerated but ignored -- owner_external_name untouched',
        'FAIL', sqlerrm);
  end;
  reset role;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
