-- Negative authorization tests for migration 0011: a DEACTIVATED (or
-- never-provisioned) authenticated identity must be blocked on the three
-- paths that previously did not re-check activeness -- accept_handover,
-- add_incident_correction (author branch), and notifications RLS -- and
-- an ACTIVE user must remain able to do all of them (controls), with
-- reactivation restoring access (deactivation is reversible revocation).
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures (inserted as superuser/table owner; RLS not forced) =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'admin@test', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'sup1@test', now()),
  ('00000000-0000-0000-0000-0000000000e3', 'sup2@test', now()),
  ('00000000-0000-0000-0000-0000000000e4', 'tech@test', now()),
  ('00000000-0000-0000-0000-0000000000e9', 'ghost@test', now()); -- authenticated, NO profile

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000e2', 'Sup One', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000e3', 'Sup Two', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000e4', 'Tech', 'technician', true);

insert into systems (id, name) values ('00000000-0000-0000-0000-00000000f001', 'Sys');
insert into locations (id, name) values ('00000000-0000-0000-0000-00000000f002', 'Loc');

insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by, next_update_due)
values ('00000000-0000-0000-0000-00000000f010', 'T-001',
        '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f002',
        'desc', 'medium', 'in_progress', 'impact',
        '00000000-0000-0000-0000-0000000000e4', now(),
        '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e2',
        now() + interval '4 hours');

-- An update AUTHORED BY the technician (the correction author branch).
insert into incident_updates (id, incident_id, author_id, event_time, actions_taken)
values ('00000000-0000-0000-0000-00000000f020', '00000000-0000-0000-0000-00000000f010',
        '00000000-0000-0000-0000-0000000000e4', now(), 'did things');

-- Two pending handovers addressed to Sup Two: h1 for the active control,
-- h2 for the deactivated / reactivated cases.
insert into handovers (id, created_by, to_user_id, general_note) values
  ('00000000-0000-0000-0000-00000000f031', '00000000-0000-0000-0000-0000000000e2',
   '00000000-0000-0000-0000-0000000000e3', 'h1'),
  ('00000000-0000-0000-0000-00000000f032', '00000000-0000-0000-0000-0000000000e2',
   '00000000-0000-0000-0000-0000000000e3', 'h2');

insert into notifications (user_id, type, incident_id, text) values
  ('00000000-0000-0000-0000-0000000000e3', 'handover_pending',
   '00000000-0000-0000-0000-00000000f010', 'notification for sup2'),
  ('00000000-0000-0000-0000-0000000000e4', 'incident_assigned',
   '00000000-0000-0000-0000-00000000f010', 'notification for tech');

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

do $$
declare
  v_count int;
begin
  -- ===== Controls: everything works while ACTIVE =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e4');
  set local role authenticated;
  begin
    perform add_incident_correction('00000000-0000-0000-0000-00000000f010',
      jsonb_build_object('refId', '00000000-0000-0000-0000-00000000f020', 'text', 'fix'));
    insert into results (test, result, detail) values ('CONTROL: active author adds a correction', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('CONTROL: active author adds a correction', 'FAIL', sqlerrm);
  end;
  select count(*) into v_count from notifications;
  insert into results (test, result, detail)
    values ('CONTROL: active user reads own notifications', case when v_count = 1 then 'PASS' else 'FAIL' end, 'visible=' || v_count);
  update notifications set read = true where read = false;
  get diagnostics v_count = row_count;
  insert into results (test, result, detail)
    values ('CONTROL: active user marks own notification read', case when v_count = 1 then 'PASS' else 'FAIL' end, 'updated=' || v_count);
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e3');
  set local role authenticated;
  begin
    perform accept_handover('00000000-0000-0000-0000-00000000f031');
    insert into results (test, result, detail) values ('CONTROL: active target accepts a handover', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('CONTROL: active target accepts a handover', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== Deactivate both users (as an admin would) =====
  -- e4 owns the open incident f010; migration 0014 now blocks deactivating
  -- the internal owner of an open incident (unrelated to what this suite
  -- tests), so reassign it away first -- to e1, who is untouched by this
  -- test -- before the raw deactivation below.
  update incidents set owner_user_id = '00000000-0000-0000-0000-0000000000e1'
    where id = '00000000-0000-0000-0000-00000000f010';
  update profiles set active = false
    where id in ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000e4');

  -- ===== Deactivated technician (past author) =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e4');
  set local role authenticated;
  begin
    perform add_incident_correction('00000000-0000-0000-0000-00000000f010',
      jsonb_build_object('refId', '00000000-0000-0000-0000-00000000f020', 'text', 'sneaky'));
    insert into results (test, result, detail) values ('deactivated author cannot add a correction', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('deactivated author cannot add a correction',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  select count(*) into v_count from notifications;
  insert into results (test, result, detail)
    values ('deactivated user reads zero notifications', case when v_count = 0 then 'PASS' else 'FAIL' end, 'visible=' || v_count);
  update notifications set read = true;
  get diagnostics v_count = row_count;
  insert into results (test, result, detail)
    values ('deactivated user cannot mark notifications read', case when v_count = 0 then 'PASS' else 'FAIL' end, 'updated=' || v_count);
  reset role;

  -- ===== Deactivated handover target =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e3');
  set local role authenticated;
  begin
    perform accept_handover('00000000-0000-0000-0000-00000000f032');
    insert into results (test, result, detail) values ('deactivated target cannot accept a handover', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('deactivated target cannot accept a handover',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== Authenticated identity with NO profile at all =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e9');
  set local role authenticated;
  begin
    perform accept_handover('00000000-0000-0000-0000-00000000f032');
    insert into results (test, result, detail) values ('profile-less identity cannot accept a handover', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('profile-less identity cannot accept a handover',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform add_incident_correction('00000000-0000-0000-0000-00000000f010',
      jsonb_build_object('refId', '00000000-0000-0000-0000-00000000f020', 'text', 'x'));
    insert into results (test, result, detail) values ('profile-less identity cannot add a correction', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('profile-less identity cannot add a correction',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  select count(*) into v_count from notifications;
  insert into results (test, result, detail)
    values ('profile-less identity reads zero notifications', case when v_count = 0 then 'PASS' else 'FAIL' end, 'visible=' || v_count);
  reset role;

  -- ===== Reversibility: reactivation restores exactly the same access =====
  update profiles set active = true where id = '00000000-0000-0000-0000-0000000000e3';
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000e3');
  set local role authenticated;
  begin
    perform accept_handover('00000000-0000-0000-0000-00000000f032');
    insert into results (test, result, detail) values ('reactivated target accepts the same handover', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('reactivated target accepts the same handover', 'FAIL', sqlerrm);
  end;
  select count(*) into v_count from notifications;
  insert into results (test, result, detail)
    values ('reactivated user reads own notifications again', case when v_count >= 1 then 'PASS' else 'FAIL' end, 'visible=' || v_count);
  reset role;

  -- ===== Policy-definition assertion: activeness is IN the policy =====
  insert into results (test, result, detail)
  select 'notifications policies embed is_active_member()',
    case when count(*) = 2 then 'PASS' else 'FAIL' end,
    'matching policies=' || count(*)
  from pg_policies
  where schemaname = 'public' and tablename = 'notifications'
    and qual like '%is_active_member%';
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
