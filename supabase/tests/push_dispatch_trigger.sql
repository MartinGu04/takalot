-- Focused verification for migration 0054 (AVARIA v1.5.0 Phase 5A: server
-- Push dispatch trigger): trigger existence/definition, the send policy's
-- include/exclude boundary (updated by migration 0058/v1.6.0 to key off
-- notifications.push_eligible instead of a hardcoded type comparison --
-- see section B/C below), fail-safe behavior with missing/blank Vault
-- configuration, no client EXECUTE/table access, and that no
-- secret/project-specific value is embedded anywhere reachable from SQL.
-- Runs only against the local scratch database created by tests/run.sh
-- (net.http_request_queue and vault.* here are this harness's own LOCAL
-- TEST DOUBLES -- see supabase/tests/harness/pg_net_stub/ and
-- push_dispatch_stub.sql -- never a real HTTP call or a real secret), in
-- one transaction that rolls back at the end.
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
-- Fixture: one active technician (Push doesn't care which role owns the
-- notification -- policy is purely category/type-based), one inactive
-- profile for the "inactive recipient" scenario, an incident to attach
-- notifications to.
-- =====================================================================
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000006501', 'dispatch-active@test', now()),
  ('00000000-0000-0000-0000-000000006502', 'dispatch-inactive@test', now());
insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000006501', 'Dispatch Active', 'technician', true),
  ('00000000-0000-0000-0000-000000006502', 'Dispatch Inactive', 'technician', false);

-- =====================================================================
-- A. The trigger exists on notifications, fires AFTER INSERT, FOR EACH ROW.
-- =====================================================================
select pg_temp.check_result(
  'A: trg_notifications_push_dispatch exists, AFTER INSERT, FOR EACH ROW, on public.notifications',
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

-- =====================================================================
-- B/C. Policy boundary, exercised end-to-end through real INSERTs (not
-- just reading the WHEN clause's text) -- Vault is configured with local
-- test-only fixture values (never anything resembling a real secret) so
-- qualifying rows are observable in net.http_request_queue, the pg_net
-- local test double's own queue table (see harness/pg_net_stub/).
-- =====================================================================
select vault.create_secret(
  'https://example.invalid/functions/v1/send-push-notification', 'avaria_push_dispatch_url'
);
select vault.create_secret('test-only-fixture-webhook-secret', 'avaria_push_webhook_secret');

do $$
declare
  v_before int;
  v_after int;
begin
  -- C: category = 'action_required' -- included, every type.
  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006501', 'incident_assigned', 'x', 'action_required');
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result('C: category=action_required (incident_assigned) queues a dispatch', v_after = v_before + 1);

  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006501', 'incident_reopened', 'x', 'action_required');
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result(
    'C: category=action_required (incident_reopened, personal) queues a dispatch',
    v_after = v_before + 1
  );

  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006501', 'handover_pending', 'x', 'action_required');
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result(
    'C: category=action_required (handover_pending) queues a dispatch at the TRIGGER boundary (incident_id absence is an Edge Function concern, not this trigger''s)',
    v_after = v_before + 1
  );

  -- C (v1.6, migration 0058): category = 'update' AND push_eligible = true
  -- -- included, REGARDLESS of type. push_eligible is what
  -- notify_operational_recipients() now stamps per-recipient at insert
  -- time (see operational_notification_preferences.sql for that
  -- resolution logic); this trigger-level test exercises the WHEN clause
  -- directly via raw inserts, exactly as it always has, just keyed to the
  -- new column instead of a hardcoded type comparison.
  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category, push_eligible)
    values ('00000000-0000-0000-0000-000000006501', 'incident_opened', 'x', 'update', true);
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result(
    'C: category=update AND push_eligible=true (incident_opened) queues a dispatch', v_after = v_before + 1
  );

  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category, push_eligible)
    values ('00000000-0000-0000-0000-000000006501', 'incident_updated', 'x', 'update', true);
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result(
    'C: category=update AND push_eligible=true (incident_updated -- a non-opened type with an explicit Push preference on) queues a dispatch',
    v_after = v_before + 1
  );

  -- B: category='update' AND push_eligible=false (the column's own
  -- default) -- excluded, never reach the trigger function at all (the
  -- WHEN clause itself blocks them, not the function body). Proves the
  -- v1.6 policy is driven by push_eligible, not type: even
  -- incident_opened (the one type that was UNCONDITIONALLY included under
  -- the old v1.5 hardcoded policy) is now excluded once its resolved
  -- per-recipient Push preference was off at creation time.
  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006501', 'incident_opened', 'x', 'update');
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result(
    'B: category=update AND push_eligible=false (incident_opened) is excluded -- v1.6 no longer hardcodes this type as always-on',
    v_after = v_before
  );

  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006501', 'incident_updated', 'x', 'update');
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result('B: category=update AND push_eligible=false (incident_updated) is excluded', v_after = v_before);

  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006501', 'incident_closed', 'x', 'update');
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result('B: category=update AND push_eligible=false (incident_closed) is excluded', v_after = v_before);

  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006501', 'incident_cancelled', 'x', 'update');
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result('B: category=update AND push_eligible=false (incident_cancelled) is excluded', v_after = v_before);

  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006501', 'incident_reopened', 'x', 'update');
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result(
    'B: category=update AND push_eligible=false (incident_reopened, the broadcast half, not the personal notification) is excluded',
    v_after = v_before
  );
end $$;

-- Exactly the minimal payload shape reached net.http_post -- never
-- notifications.text or any other operational field, and the request
-- carries the dedicated webhook secret header, never a VAPID/anon/service
-- credential.
select pg_temp.check_result(
  'C: the queued request body is exactly {"notification_id": ...} -- no other field',
  (select body ? 'notification_id' from net.http_request_queue order by id desc limit 1)
  and (
    select count(*) = 1 from jsonb_object_keys(
      (select body from net.http_request_queue order by id desc limit 1)
    )
  )
);
select pg_temp.check_result(
  'C: the queued request carries the dispatch webhook secret header, not a VAPID/anon/service credential',
  (select headers ->> 'x-avaria-push-secret' from net.http_request_queue order by id desc limit 1) = 'test-only-fixture-webhook-secret'
);

-- =====================================================================
-- E. Fail-safe: with Vault configuration missing/blank, a qualifying
--    notification insert still succeeds (no exception), and queues NO
--    dispatch request at all.
-- =====================================================================
do $$
declare
  v_before int;
  v_after int;
  v_insert_failed boolean := false;
begin
  delete from vault.secrets where name in ('avaria_push_dispatch_url', 'avaria_push_webhook_secret');

  select count(*) into v_before from net.http_request_queue;
  begin
    insert into notifications (user_id, type, text, category)
      values ('00000000-0000-0000-0000-000000006501', 'incident_assigned', 'x', 'action_required');
  exception when others then
    v_insert_failed := true;
  end;
  select count(*) into v_after from net.http_request_queue;

  perform pg_temp.check_result('E: a qualifying notification insert never fails when Vault config is missing', not v_insert_failed);
  perform pg_temp.check_result('E: no dispatch is queued when Vault config is missing', v_after = v_before);

  -- Blank (not merely absent) values fail safe identically.
  perform vault.create_secret('   ', 'avaria_push_dispatch_url');
  perform vault.create_secret('   ', 'avaria_push_webhook_secret');
  select count(*) into v_before from net.http_request_queue;
  insert into notifications (user_id, type, text, category)
    values ('00000000-0000-0000-0000-000000006501', 'incident_assigned', 'x', 'action_required');
  select count(*) into v_after from net.http_request_queue;
  perform pg_temp.check_result('E: blank (whitespace-only) Vault values also fail safe -- no dispatch queued', v_after = v_before);

  -- Restore valid config for the remaining checks below.
  delete from vault.secrets where name in ('avaria_push_dispatch_url', 'avaria_push_webhook_secret');
  perform vault.create_secret(
    'https://example.invalid/functions/v1/send-push-notification', 'avaria_push_dispatch_url'
  );
  perform vault.create_secret('test-only-fixture-webhook-secret', 'avaria_push_webhook_secret');
end $$;

-- =====================================================================
-- E2. Fail-safe against an UNEXPECTED runtime pg_net/Vault failure, not
--    merely missing/blank config -- Vault IS validly configured for this
--    block (restored just above), yet net.http_post itself is made to
--    raise, simulating a genuine pg_net-layer runtime error (a real
--    extension bug, a queue-table constraint violation, anything). The
--    notification insert must still succeed, proving
--    dispatch_push_notification()'s exception handler wraps the Vault
--    reads AND the net.http_post call itself -- not just the
--    missing-config short-circuit above it.
--
-- Implemented by temporarily attaching a trigger to the pg_net LOCAL TEST
-- DOUBLE's own queue table (net.http_request_queue -- see
-- harness/pg_net_stub/) that unconditionally raises; both the trigger and
-- its function are pg_temp (session-scoped) and vanish when this whole
-- test file's own transaction rolls back at the end, so nothing here
-- permanently modifies the shared local pg_net stub for later test files.
-- =====================================================================
do $$
declare
  v_insert_failed boolean := false;
  v_new_id uuid;
begin
  create function pg_temp.simulate_net_failure() returns trigger language plpgsql as $inner$
  begin
    raise exception 'simulated pg_net internal failure for testing';
  end;
  $inner$;
  create trigger simulate_net_failure_trigger
    before insert on net.http_request_queue
    for each row execute function pg_temp.simulate_net_failure();

  begin
    insert into notifications (user_id, type, text, category)
      values ('00000000-0000-0000-0000-000000006501', 'incident_assigned', 'x', 'action_required')
      returning id into v_new_id;
  exception when others then
    v_insert_failed := true;
  end;

  perform pg_temp.check_result(
    'E2: an unexpected pg_net-layer runtime error (net.http_post itself raising, not merely missing config) never fails the notification insert',
    not v_insert_failed
  );

  drop trigger simulate_net_failure_trigger on net.http_request_queue;
end $$;

-- =====================================================================
-- D. No ordinary client role can invoke the trigger function directly, or
--    reach push_deliveries/push_subscriptions/notifications/profiles
--    through the service_role surface this migration adds.
-- =====================================================================
select pg_temp.check_result(
  'D: dispatch_push_notification has no EXECUTE for anon/authenticated/PUBLIC',
  not has_function_privilege('anon', 'public.dispatch_push_notification()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.dispatch_push_notification()', 'EXECUTE')
  and not has_function_privilege('public', 'public.dispatch_push_notification()', 'EXECUTE')
);
select pg_temp.check_result(
  'D: authenticated cannot INSERT/SELECT/UPDATE push_deliveries directly',
  not has_table_privilege('authenticated', 'public.push_deliveries', 'INSERT')
  and not has_table_privilege('authenticated', 'public.push_deliveries', 'SELECT')
  and not has_table_privilege('authenticated', 'public.push_deliveries', 'UPDATE')
);
select pg_temp.check_result(
  'D: anon cannot INSERT/SELECT/UPDATE push_deliveries directly',
  not has_table_privilege('anon', 'public.push_deliveries', 'INSERT')
  and not has_table_privilege('anon', 'public.push_deliveries', 'SELECT')
  and not has_table_privilege('anon', 'public.push_deliveries', 'UPDATE')
);
select pg_temp.check_result(
  'D: authenticated/anon cannot read vault.decrypted_secrets (no grant on the vault schema/view at all)',
  not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT')
  and not has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT')
);
select pg_temp.check_result(
  'D: service_role''s new grants are exactly what this migration documents -- no DELETE on push_deliveries, no INSERT/UPDATE on push_subscriptions, no write on notifications/profiles',
  not has_table_privilege('service_role', 'public.push_deliveries', 'DELETE')
  and not has_table_privilege('service_role', 'public.push_subscriptions', 'INSERT')
  and not has_table_privilege('service_role', 'public.push_subscriptions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.notifications', 'INSERT')
  and not has_table_privilege('service_role', 'public.notifications', 'UPDATE')
  and not has_table_privilege('service_role', 'public.notifications', 'DELETE')
  and not has_table_privilege('service_role', 'public.profiles', 'INSERT')
  and not has_table_privilege('service_role', 'public.profiles', 'UPDATE')
  and not has_table_privilege('service_role', 'public.profiles', 'DELETE')
);
select pg_temp.check_result(
  'D: service_role has exactly the read/write it needs (push_subscriptions select+delete, push_deliveries select+insert+update, notifications+profiles select)',
  has_table_privilege('service_role', 'public.push_subscriptions', 'SELECT')
  and has_table_privilege('service_role', 'public.push_subscriptions', 'DELETE')
  and has_table_privilege('service_role', 'public.push_deliveries', 'SELECT')
  and has_table_privilege('service_role', 'public.push_deliveries', 'INSERT')
  and has_table_privilege('service_role', 'public.push_deliveries', 'UPDATE')
  and has_table_privilege('service_role', 'public.notifications', 'SELECT')
  and has_table_privilege('service_role', 'public.profiles', 'SELECT')
);

-- Client roles cannot read other users' subscriptions -- unchanged from
-- 0053 (this migration adds no policy for anon/authenticated on
-- push_subscriptions at all).
select pg_temp.check_result(
  'D: 0053''s deny-all for anon/authenticated on push_subscriptions is unweakened by this migration',
  not has_table_privilege('authenticated', 'public.push_subscriptions', 'SELECT')
  and not has_table_privilege('anon', 'public.push_subscriptions', 'SELECT')
);

-- =====================================================================
-- F. No secret/project-specific value is embedded anywhere reachable from
--    SQL -- the trigger function's source text (what `\sf`/pg_proc.prosrc
--    exposes) contains only the two Vault entry NAMES, never a URL host
--    beyond the Vault lookup itself, never anything resembling a JWT/key.
-- =====================================================================
select pg_temp.check_result(
  'F: dispatch_push_notification source references only the two named Vault entries -- no embedded URL/secret literal',
  (select prosrc from pg_proc where proname = 'dispatch_push_notification' and pronamespace = 'public'::regnamespace) ~ 'avaria_push_dispatch_url'
  and (select prosrc from pg_proc where proname = 'dispatch_push_notification' and pronamespace = 'public'::regnamespace) ~ 'avaria_push_webhook_secret'
  and (select prosrc from pg_proc where proname = 'dispatch_push_notification' and pronamespace = 'public'::regnamespace) !~ 'https?://[a-zA-Z0-9.-]+\.supabase\.'
  and (select prosrc from pg_proc where proname = 'dispatch_push_notification' and pronamespace = 'public'::regnamespace) !~ 'eyJ'
);

-- The RAISE WARNING on failure (fired by both E2 above and any real
-- unexpected pg_net/Vault error) must interpolate only new.id and sqlerrm
-- -- never v_secret. Checked structurally against the actual source text
-- rather than by scraping server logs (RAISE WARNING output isn't
-- queryable SQL): the exact line is `raise warning '...: %', new.id,
-- sqlerrm;` with no other identifier in its argument list.
select pg_temp.check_result(
  'F: the RAISE WARNING on a failed dispatch attempt never interpolates v_secret (only new.id and sqlerrm)',
  (select prosrc from pg_proc where proname = 'dispatch_push_notification' and pronamespace = 'public'::regnamespace)
    ~ 'raise warning[^;]*new\.id,\s*sqlerrm;'
  and (select prosrc from pg_proc where proname = 'dispatch_push_notification' and pronamespace = 'public'::regnamespace)
    !~ 'raise warning[^;]*v_secret'
);

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
