-- Tests for migration 0022: incident-creation 400-character limits on
-- תיאור התקלה (description) and השפעה מבצעית (operational_impact).
--
-- Covers: exactly-400 succeeds (boundary, not off-by-one); 401 is rejected
-- with the exact Hebrew message for both fields; a missing key still hits
-- the pre-existing "required" validation, not a spurious length error; a
-- direct INSERT with a description/operational_impact far longer than 400
-- characters still succeeds (proving there is deliberately NO table CHECK
-- constraint, so historical/long-text rows are never blocked or rewritten);
-- such a historical row remains fully readable; unrelated
-- authorization/validation/grant behavior is unchanged.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'supervisor-limits@test', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'owner-limits@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Supervisor Limits', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000e2', 'Owner Limits', 'technician', true);

insert into systems (id, name) values ('00000000-0000-0000-0000-00000000f901', 'Sys');
insert into locations (id, name) values ('00000000-0000-0000-0000-00000000f902', 'Loc');

-- A HISTORICAL incident, inserted directly with a description/impact far
-- longer than 400 characters (as any pre-migration row created under the
-- old 4000/1000-character limits could be) -- must remain fully insertable
-- and readable, proving no CHECK constraint was added.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values ('00000000-0000-0000-0000-00000000f910', 'T-901',
        '00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000f902',
        repeat('א', 1500), 'medium', 'in_progress', repeat('ב', 800),
        '00000000-0000-0000-0000-0000000000e2', now() - interval '10 days',
        '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1',
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
    'systemId', '00000000-0000-0000-0000-00000000f901', 'locationId', '00000000-0000-0000-0000-00000000f902',
    'description', 'תקלה לבדיקה', 'severity', 'low', 'operationalImpact', 'השפעה',
    'actionsTaken', 'נבדק', 'status', 'new', 'discoveredAt', now(),
    'ownerUserId', '00000000-0000-0000-0000-0000000000e2',
    'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_input(jsonb) to authenticated;

do $$
declare
  v_incident incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
  set local role authenticated;

  -- =====================================================================
  -- 1. Exactly 400 characters (the boundary itself, not 399) succeeds for
  --    both fields.
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(jsonb_build_object(
      'description', repeat('א', 400), 'operationalImpact', repeat('ב', 400))));
    insert into results (test, result, detail) values
      ('description/operationalImpact at exactly 400 characters succeeds',
        case when length(v_incident.description) = 400 and length(v_incident.operational_impact) = 400
             then 'PASS' else 'FAIL' end,
        'desc_len=' || length(v_incident.description) || ' impact_len=' || length(v_incident.operational_impact));
  exception when others then
    insert into results (test, result, detail) values
      ('description/operationalImpact at exactly 400 characters succeeds', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 2. 401 characters is rejected for description, with the exact Hebrew
  --    message (matching Zod's own nonBlank(400, ...) message format).
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('description', repeat('א', 401))));
    insert into results (test, result, detail) values ('description at 401 characters rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('description at 401 characters rejected',
      case when sqlerrm = 'validation: תיאור התקלה: עד 400 תווים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 3. 401 characters is rejected for operationalImpact, with the exact
  --    Hebrew message.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('operationalImpact', repeat('ב', 401))));
    insert into results (test, result, detail) values ('operationalImpact at 401 characters rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('operationalImpact at 401 characters rejected',
      case when sqlerrm = 'validation: השפעה מבצעית: עד 400 תווים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 4. A missing description key still hits the PRE-EXISTING "required"
  --    validation (raised by the not-null insert/trim path further down),
  --    never the new length check -- a missing key must never itself look
  --    like a length violation.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input('{"description": null}'::jsonb));
    insert into results (test, result, detail) values ('a null description is never treated as a length violation', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('a null description is never treated as a length violation',
      case when sqlerrm <> 'validation: תיאור התקלה: עד 400 תווים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 5. CONTROL: unrelated validation (missing owner) is completely
  --    unaffected by this migration.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input('{"ownerUserId": ""}'::jsonb));
    insert into results (test, result, detail) values ('CONTROL: missing owner still rejected as before', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('CONTROL: missing owner still rejected as before',
      case when sqlerrm = 'validation: יש לבחור בעל אחריות פנימי' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  reset role;
end $$;

-- =====================================================================
-- 6. A direct INSERT with a description/operational_impact longer than 400
--    characters (but within the PRE-EXISTING, unrelated table CHECK
--    constraints from migration 0001 -- description up to 4000,
--    operational_impact up to 1000, both unchanged by this migration)
--    still succeeds: this migration adds NO new table CHECK constraint of
--    its own, since one would either reject or forbid re-saving
--    pre-existing historical rows already longer than 400 characters.
-- =====================================================================
do $$
declare
  v_id uuid;
begin
  insert into incidents (number, system_id, location_id, description, severity, status, operational_impact,
                         owner_user_id, discovered_at, created_by, updated_by, next_update_due)
  values ('T-DIRECT-LONG', '00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000f902',
          repeat('ג', 2000), 'low', 'in_progress', repeat('ד', 900),
          '00000000-0000-0000-0000-0000000000e2', now(),
          '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1', now() + interval '1 day')
  returning id into v_id;
  insert into results (test, result, detail) values
    ('direct INSERT: no NEW CHECK constraint blocks a >400-character description/operational_impact',
      case when v_id is not null then 'PASS' else 'FAIL' end, '');
exception when others then
  insert into results (test, result, detail) values
    ('direct INSERT: no NEW CHECK constraint blocks a >400-character description/operational_impact', 'FAIL', sqlerrm);
end $$;

-- =====================================================================
-- 7. Historical incident (inserted directly, description/impact far over
--    400 characters, as any pre-0022 row could be) reads back unchanged.
-- =====================================================================
insert into results (test, result, detail)
select 'historical long incident remains fully readable, text untouched',
  case when length(description) = 1500 and length(operational_impact) = 800 then 'PASS' else 'FAIL' end,
  'desc_len=' || length(description) || ' impact_len=' || length(operational_impact)
from incidents where id = '00000000-0000-0000-0000-00000000f910';

-- =====================================================================
-- 8. EXECUTE grants on create_incident are unchanged by this migration.
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
