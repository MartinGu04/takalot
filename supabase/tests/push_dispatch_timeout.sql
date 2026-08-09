-- Focused verification for migration 0055 (AVARIA v1.5.0 Phase 5B hotfix):
-- proves the EFFECTIVE public.dispatch_push_notification() -- after the
-- full migration chain, i.e. post-0055 -- passes timeout_milliseconds =
-- 15000 to net.http_post, not migration 0054's original 3000, and that
-- nothing else about the function/trigger/grants changed. Runs only
-- against the local scratch database created by tests/run.sh (net.* here
-- is the pg_net LOCAL TEST DOUBLE -- see harness/pg_net_stub/), in one
-- transaction that rolls back at the end.
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

-- =====================================================================
-- A. Static: the effective function source uses 15000, not 3000.
-- =====================================================================
select pg_temp.check_result(
  'A: dispatch_push_notification uses timeout_milliseconds := 15000',
  (select prosrc from pg_proc where proname = 'dispatch_push_notification' and pronamespace = 'public'::regnamespace)
    ~ 'timeout_milliseconds\s*:=\s*15000'
  and (select prosrc from pg_proc where proname = 'dispatch_push_notification' and pronamespace = 'public'::regnamespace)
    !~ 'timeout_milliseconds\s*:=\s*3000'
);

-- =====================================================================
-- B. Behavioral: end-to-end through a real qualifying notification
--    insert, confirming the queued pg_net request actually carries the
--    new timeout value.
-- =====================================================================
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000006601', 'dispatch-timeout@test', now());
insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000006601', 'Dispatch Timeout', 'technician', true);
select vault.create_secret(
  'https://example.invalid/functions/v1/send-push-notification', 'avaria_push_dispatch_url'
);
select vault.create_secret('test-only-fixture-webhook-secret', 'avaria_push_webhook_secret');

insert into notifications (user_id, type, text, category)
  values ('00000000-0000-0000-0000-000000006601', 'incident_assigned', 'x', 'action_required');

select pg_temp.check_result(
  'B: the queued dispatch request carries timeout_milliseconds = 15000',
  (select timeout_milliseconds from net.http_request_queue order by id desc limit 1) = 15000
);

-- =====================================================================
-- C. Everything else about the function is unchanged: same trigger, same
--    grants/revokes, same comment -- migration 0055 touched nothing but
--    the one constant (create or replace keeps the function's OID, so
--    0054's REVOKE/comment stayed attached automatically).
-- =====================================================================
select pg_temp.check_result(
  'C: trg_notifications_push_dispatch still exists, AFTER INSERT, FOR EACH ROW, unchanged by 0055',
  exists (
    select 1 from information_schema.triggers
    where trigger_name = 'trg_notifications_push_dispatch'
      and event_object_schema = 'public'
      and event_object_table = 'notifications'
      and action_timing = 'AFTER'
      and event_manipulation = 'INSERT'
      and action_orientation = 'ROW'
  )
);
select pg_temp.check_result(
  'C: dispatch_push_notification still has no EXECUTE for anon/authenticated/PUBLIC',
  not has_function_privilege('anon', 'public.dispatch_push_notification()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.dispatch_push_notification()', 'EXECUTE')
  and not has_function_privilege('public', 'public.dispatch_push_notification()', 'EXECUTE')
);
select pg_temp.check_result(
  'C: service_role still has exactly the read/write it needs, unchanged by 0055',
  has_table_privilege('service_role', 'public.push_subscriptions', 'SELECT')
  and has_table_privilege('service_role', 'public.push_subscriptions', 'DELETE')
  and has_table_privilege('service_role', 'public.push_deliveries', 'SELECT')
  and has_table_privilege('service_role', 'public.push_deliveries', 'INSERT')
  and has_table_privilege('service_role', 'public.push_deliveries', 'UPDATE')
  and has_table_privilege('service_role', 'public.notifications', 'SELECT')
  and has_table_privilege('service_role', 'public.profiles', 'SELECT')
);
select pg_temp.check_result(
  'C: dispatch_push_notification''s comment (set in 0054) survived create or replace in 0055',
  coalesce(obj_description('public.dispatch_push_notification()'::regprocedure, 'pg_proc'), '') like 'AFTER INSERT ON notifications trigger target.%'
);

-- =====================================================================
-- D. Fail-safe behavior still intact: missing Vault config still never
--    fails the notification insert.
-- =====================================================================
do $$
declare
  v_insert_failed boolean := false;
begin
  delete from vault.secrets where name in ('avaria_push_dispatch_url', 'avaria_push_webhook_secret');
  begin
    insert into notifications (user_id, type, text, category)
      values ('00000000-0000-0000-0000-000000006601', 'incident_assigned', 'x', 'action_required');
  exception when others then
    v_insert_failed := true;
  end;
  perform pg_temp.check_result(
    'D: fail-safe (missing Vault config) still never fails the notification insert',
    not v_insert_failed
  );
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
