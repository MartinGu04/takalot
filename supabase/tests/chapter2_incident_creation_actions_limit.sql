-- Tests for migration 0023: incident-creation required-ness + 600-character
-- limit on פעולות שבוצעו עד כה (actionsTaken).
--
-- Covers: missing key / explicit JSON null / empty string / whitespace-only
-- are ALL rejected with the same clean, controlled Hebrew "שדה חובה"
-- message, and specifically NEVER with a raw SQLSTATE (there was previously
-- no table-level backstop for actionsTaken at all -- a missing/blank value
-- silently succeeded); exactly 600 characters succeeds (boundary, not
-- off-by-one); 601 is rejected with the exact Hebrew message; the stored
-- note is trimmed consistently; migration 0022's own description/
-- operationalImpact behavior is unaffected (re-verified by the existing
-- chapter2_incident_creation_text_limits.sql suite passing unchanged
-- against this new create_incident body); unrelated authorization/grant
-- behavior is unchanged.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000f1', 'supervisor-actions@test', now()),
  ('00000000-0000-0000-0000-0000000000f2', 'owner-actions@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000f1', 'Supervisor Actions', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000f2', 'Owner Actions', 'technician', true);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000fa01', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000fa02', 'Loc', 1);

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
    'systemId', '00000000-0000-0000-0000-00000000fa01', 'locationId', '00000000-0000-0000-0000-00000000fa02',
    'description', 'תקלה לבדיקה', 'severity', 'low', 'operationalImpact', 'השפעה',
    'actionsTaken', 'נבדק', 'status', 'new', 'discoveredAt', now(),
    'ownerUserId', '00000000-0000-0000-0000-0000000000f2',
    'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_input(jsonb) to authenticated;

do $$
declare
  v_incident incidents;
  v_note text;
  v_state text;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  set local role authenticated;

  -- =====================================================================
  -- 1. Exactly 600 characters (the boundary itself, not 599) succeeds.
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(jsonb_build_object('actionsTaken', repeat('א', 600))));
    select note into v_note from incident_events where incident_id = v_incident.id and type = 'created';
    insert into results (test, result, detail) values
      ('actionsTaken at exactly 600 characters succeeds',
        case when v_note like 'פעולות שבוצעו עד כה: ' || repeat('א', 600) || E'\n%' then 'PASS' else 'FAIL' end,
        'note_len=' || length(v_note));
  exception when others then
    insert into results (test, result, detail) values
      ('actionsTaken at exactly 600 characters succeeds', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 2. 601 characters is rejected with the exact Hebrew message.
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('actionsTaken', repeat('א', 601))));
    insert into results (test, result, detail) values ('actionsTaken at 601 characters rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('actionsTaken at 601 characters rejected',
      case when sqlerrm = 'validation: פעולות שבוצעו עד כה: עד 600 תווים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 3. Trimmed padded value is stored trimmed in the timeline note.
  -- =====================================================================
  begin
    v_incident := create_incident(pg_temp.base_input(jsonb_build_object('actionsTaken', '  נבדק עם רווחים  ')));
    select note into v_note from incident_events where incident_id = v_incident.id and type = 'created';
    insert into results (test, result, detail) values
      ('actionsTaken is trimmed consistently before being stored',
        case when v_note like 'פעולות שבוצעו עד כה: נבדק עם רווחים' || E'\n%'
              and v_note not like '%  נבדק%' and v_note not like '%רווחים  %'
             then 'PASS' else 'FAIL' end, coalesce(v_note, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('actionsTaken is trimmed consistently before being stored', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- 4. missing key / explicit JSON null / empty string / whitespace-only
  --    are ALL rejected with the SAME clean, controlled Hebrew "שדה חובה"
  --    message -- and specifically with NO raw SQLSTATE (there was
  --    previously no backstop at all for this field: a blank value used to
  --    succeed silently).
  -- =====================================================================
  begin
    perform create_incident(pg_temp.base_input('{}'::jsonb) - 'actionsTaken');
    insert into results (test, result, detail) values ('actionsTaken missing key: rejected cleanly, no raw SQLSTATE', 'FAIL', 'succeeded');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    insert into results (test, result, detail) values ('actionsTaken missing key: rejected cleanly, no raw SQLSTATE',
      case when sqlerrm = 'validation: פעולות שבוצעו עד כה: שדה חובה' and v_state not in ('23502', '23514') then 'PASS' else 'FAIL' end,
      'sqlstate=' || v_state || ' msg=' || sqlerrm);
  end;

  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('actionsTaken', null)));
    insert into results (test, result, detail) values ('actionsTaken explicit JSON null: rejected cleanly, no raw SQLSTATE', 'FAIL', 'succeeded');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    insert into results (test, result, detail) values ('actionsTaken explicit JSON null: rejected cleanly, no raw SQLSTATE',
      case when sqlerrm = 'validation: פעולות שבוצעו עד כה: שדה חובה' and v_state not in ('23502', '23514') then 'PASS' else 'FAIL' end,
      'sqlstate=' || v_state || ' msg=' || sqlerrm);
  end;

  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('actionsTaken', '')));
    insert into results (test, result, detail) values ('actionsTaken empty string: rejected cleanly, no raw SQLSTATE', 'FAIL', 'succeeded');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    insert into results (test, result, detail) values ('actionsTaken empty string: rejected cleanly, no raw SQLSTATE',
      case when sqlerrm = 'validation: פעולות שבוצעו עד כה: שדה חובה' and v_state not in ('23502', '23514') then 'PASS' else 'FAIL' end,
      'sqlstate=' || v_state || ' msg=' || sqlerrm);
  end;

  begin
    perform create_incident(pg_temp.base_input(jsonb_build_object('actionsTaken', '   ')));
    insert into results (test, result, detail) values ('actionsTaken whitespace-only: rejected cleanly, no raw SQLSTATE', 'FAIL', 'succeeded');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    insert into results (test, result, detail) values ('actionsTaken whitespace-only: rejected cleanly, no raw SQLSTATE',
      case when sqlerrm = 'validation: פעולות שבוצעו עד כה: שדה חובה' and v_state not in ('23502', '23514') then 'PASS' else 'FAIL' end,
      'sqlstate=' || v_state || ' msg=' || sqlerrm);
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
-- 6. EXECUTE grants on create_incident are unchanged by this migration.
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
