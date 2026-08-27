-- Tests for migration 0060 (personnel invitation-email tracking):
--  1. New pending entries default to invitation_status = 'not_sent'.
--  2. get_pending_personnel_invitation_target: happy path returns the row.
--  3. get_pending_personnel_invitation_target: role-ceiling enforcement
--     (same matrix as create_pending_personnel).
--  4. get_pending_personnel_invitation_target: rejects a non-pending
--     (cancelled) entry.
--  5. get_pending_personnel_invitation_target: not_found for a missing id.
--  6. record_pending_personnel_invitation_result: success path sets
--     invitation_status/sent_at, clears any prior error, and audits
--     'personnel_invitation_sent'.
--  7. record_pending_personnel_invitation_result: failure path sets
--     invitation_status/last_error, leaves invitation_sent_at from an
--     earlier success untouched, and audits 'personnel_invitation_failed'.
--  8. record_pending_personnel_invitation_result: rejects p_status =
--     'not_sent'.
--  9. record_pending_personnel_invitation_result: role-ceiling enforcement.
--  10. list_personnel() surfaces invitation_status for pending rows and
--      null for linked rows.
--  11. Grant matrix: anon has no execute on either new RPC.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000c1', 'admin@test', now()),
  ('00000000-0000-0000-0000-0000000000c2', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000c3', 'viewer@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000c1', 'Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000c2', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000c3', 'Viewer', 'viewer', true);

-- A pending technician entry (within the supervisor's ceiling), created by
-- the admin so created_by's own ceiling is never what's under test.
insert into pending_personnel (id, full_name, email, role, status, created_by) values
  ('00000000-0000-0000-0000-0000000000c4', 'Tech Invitee', 'tech-invitee@test', 'technician', 'pending',
    '00000000-0000-0000-0000-0000000000c1');

-- A pending professional_manager entry -- above the supervisor's ceiling.
insert into pending_personnel (id, full_name, email, role, status, created_by) values
  ('00000000-0000-0000-0000-0000000000c5', 'Manager Invitee', 'manager-invitee@test', 'professional_manager', 'pending',
    '00000000-0000-0000-0000-0000000000c1');

-- A cancelled entry -- must never be a valid invitation target.
insert into pending_personnel (id, full_name, email, role, status, created_by, cancelled_by, cancelled_at) values
  ('00000000-0000-0000-0000-0000000000c6', 'Cancelled Invitee', 'cancelled-invitee@test', 'technician', 'cancelled',
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c1', now());

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

do $$
declare
  v_status public.pending_personnel_invitation_status;
  v_sent_at timestamptz;
  v_last_error text;
  v_audit_count int;
  v_row record;
begin
  -- ===== 1. Default invitation_status on a fresh pending row =====
  select invitation_status, invitation_sent_at, invitation_last_error
    into v_status, v_sent_at, v_last_error
    from pending_personnel where id = '00000000-0000-0000-0000-0000000000c4';
  insert into results (test, result, detail) values
    ('fresh pending entry defaults to not_sent, no timestamps',
      case when v_status = 'not_sent' and v_sent_at is null and v_last_error is null then 'PASS' else 'FAIL' end,
      'status=' || v_status);

  -- ===== 2. Happy path read =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    select * into v_row from get_pending_personnel_invitation_target('00000000-0000-0000-0000-0000000000c4');
    insert into results (test, result, detail) values
      ('admin reads invitation target: succeeds and returns the row',
        case when v_row.email = 'tech-invitee@test' then 'PASS' else 'FAIL' end, coalesce(v_row.email, 'null'));
  exception when others then
    insert into results (test, result, detail) values ('admin reads invitation target: succeeds and returns the row', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 3. Role-ceiling enforcement on the read step =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c2');
  set local role authenticated;
  begin
    perform get_pending_personnel_invitation_target('00000000-0000-0000-0000-0000000000c5'); -- professional_manager target
    insert into results (test, result, detail) values ('shift_supervisor cannot read a professional_manager invitation target', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('shift_supervisor cannot read a professional_manager invitation target',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform get_pending_personnel_invitation_target('00000000-0000-0000-0000-0000000000c4'); -- technician target, within ceiling
    insert into results (test, result, detail) values ('shift_supervisor can read a technician invitation target within ceiling', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('shift_supervisor can read a technician invitation target within ceiling', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 4. Non-pending (cancelled) entry rejected =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform get_pending_personnel_invitation_target('00000000-0000-0000-0000-0000000000c6');
    insert into results (test, result, detail) values ('cancelled entry is not a valid invitation target', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('cancelled entry is not a valid invitation target',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- ===== 5. Missing id =====
  begin
    perform get_pending_personnel_invitation_target('00000000-0000-0000-0000-000000000fff');
    insert into results (test, result, detail) values ('missing id is not_found', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('missing id is not_found',
      case when sqlerrm like 'not_found%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 6. Record success =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform record_pending_personnel_invitation_result('00000000-0000-0000-0000-0000000000c4', 'sent', null);
    insert into results (test, result, detail) values ('recording a successful send succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('recording a successful send succeeds', 'FAIL', sqlerrm);
  end;
  reset role;
  select invitation_status, invitation_sent_at, invitation_last_error
    into v_status, v_sent_at, v_last_error
    from pending_personnel where id = '00000000-0000-0000-0000-0000000000c4';
  insert into results (test, result, detail) values
    ('successful send sets status=sent and sent_at, clears error',
      case when v_status = 'sent' and v_sent_at is not null and v_last_error is null then 'PASS' else 'FAIL' end,
      'status=' || v_status || ' sent_at_set=' || (v_sent_at is not null));
  select count(*) into v_audit_count from audit_logs
    where action = 'personnel_invitation_sent' and entity_id = '00000000-0000-0000-0000-0000000000c4';
  insert into results (test, result, detail) values
    ('successful send writes personnel_invitation_sent audit row', case when v_audit_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_audit_count);

  -- ===== 7. Record failure after a prior success: sent_at untouched =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform record_pending_personnel_invitation_result('00000000-0000-0000-0000-0000000000c4', 'failed', 'ספק הדוא"ל אינו זמין');
    insert into results (test, result, detail) values ('recording a failed resend attempt succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('recording a failed resend attempt succeeds', 'FAIL', sqlerrm);
  end;
  reset role;
  select invitation_status, invitation_sent_at, invitation_last_error
    into v_status, v_sent_at, v_last_error
    from pending_personnel where id = '00000000-0000-0000-0000-0000000000c4';
  insert into results (test, result, detail) values
    ('failed resend sets status=failed, keeps last successful sent_at, records error',
      case when v_status = 'failed' and v_sent_at is not null and v_last_error = 'ספק הדוא"ל אינו זמין' then 'PASS' else 'FAIL' end,
      'status=' || v_status || ' sent_at_kept=' || (v_sent_at is not null) || ' error=' || coalesce(v_last_error, 'null'));
  select count(*) into v_audit_count from audit_logs
    where action = 'personnel_invitation_failed' and entity_id = '00000000-0000-0000-0000-0000000000c4';
  insert into results (test, result, detail) values
    ('failed send writes personnel_invitation_failed audit row', case when v_audit_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_audit_count);

  -- ===== 8. p_status = 'not_sent' rejected =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform record_pending_personnel_invitation_result('00000000-0000-0000-0000-0000000000c4', 'not_sent', null);
    insert into results (test, result, detail) values ('recording status=not_sent is rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('recording status=not_sent is rejected',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 9. Role-ceiling enforcement on the write step =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c2');
  set local role authenticated;
  begin
    perform record_pending_personnel_invitation_result('00000000-0000-0000-0000-0000000000c5', 'sent', null); -- professional_manager target
    insert into results (test, result, detail) values ('shift_supervisor cannot record a result for a professional_manager target', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('shift_supervisor cannot record a result for a professional_manager target',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c3');
  set local role authenticated;
  begin
    perform record_pending_personnel_invitation_result('00000000-0000-0000-0000-0000000000c4', 'sent', null);
    insert into results (test, result, detail) values ('viewer cannot record an invitation result for anyone', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('viewer cannot record an invitation result for anyone',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 10. list_personnel() surfaces invitation_status =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  select invitation_status into v_status from list_personnel()
    where kind = 'pending' and id = '00000000-0000-0000-0000-0000000000c4';
  insert into results (test, result, detail) values
    ('list_personnel reports invitation_status for a pending row', case when v_status = 'failed' then 'PASS' else 'FAIL' end, 'status=' || v_status);
  select count(*) into v_audit_count from list_personnel() where kind = 'linked' and invitation_status is not null;
  insert into results (test, result, detail) values
    ('list_personnel reports null invitation_status for every linked row', case when v_audit_count = 0 then 'PASS' else 'FAIL' end, 'non-null count=' || v_audit_count);
  reset role;

  -- ===== 11. Grant matrix =====
  insert into results (test, result, detail)
  select 'anon has no EXECUTE on get_pending_personnel_invitation_target',
    case when not has_function_privilege('anon', 'get_pending_personnel_invitation_target(uuid)', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
  insert into results (test, result, detail)
  select 'anon has no EXECUTE on record_pending_personnel_invitation_result',
    case when not has_function_privilege(
      'anon', 'record_pending_personnel_invitation_result(uuid, pending_personnel_invitation_status, text)', 'EXECUTE'
    ) then 'PASS' else 'FAIL' end, '';
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
