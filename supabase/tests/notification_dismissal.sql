-- Focused verification for migration 0048 (notification dismissal /
-- clear_my_notifications, "נקה הכל"): self-scoping, no destructive delete,
-- default-list exclusion, and grants. Runs only against the local scratch
-- database created by tests/run.sh, in one transaction that rolls back at
-- the end.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000006201', 'dismiss-user-one@test', now()),
  ('00000000-0000-0000-0000-000000006202', 'dismiss-user-two@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000006201', 'Dismiss User One', 'technician', true),
  ('00000000-0000-0000-0000-000000006202', 'Dismiss User Two', 'technician', true);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p_user_id uuid) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', p_user_id::text, false),
         set_config(
           'request.jwt.claims',
           json_build_object('sub', p_user_id, 'role', 'authenticated')::text,
           false
         );
$$;

create or replace function pg_temp.as_anon() returns void
language sql as $$
  select set_config('request.jwt.claim.sub', '', false),
         set_config('request.jwt.claims', '', false);
$$;

create or replace function pg_temp.check_result(p_test text, p_ok boolean, p_detail text default '')
returns void language sql as $$
  insert into results (test, result, detail)
  values (p_test, case when p_ok then 'PASS' else 'FAIL' end, coalesce(p_detail, ''));
$$;
grant execute on function pg_temp.check_result(text, boolean, text) to authenticated;

-- Seed two active notifications for user one and one for user two, inserted
-- directly as postgres (bypassing the RPC-only insert restriction, since
-- this fixture only needs rows to exist -- not to exercise how they were
-- created).
insert into notifications (id, user_id, type, incident_id, text, category) values
  ('00000000-0000-0000-0000-000000006301', '00000000-0000-0000-0000-000000006201',
   'incident_assigned', null, 'Notification one for user one', 'action_required'),
  ('00000000-0000-0000-0000-000000006302', '00000000-0000-0000-0000-000000006201',
   'incident_opened', null, 'Notification two for user one', 'update'),
  ('00000000-0000-0000-0000-000000006303', '00000000-0000-0000-0000-000000006202',
   'incident_assigned', null, 'Notification for user two', 'action_required');

-- =====================================================================
-- 1. clear_my_notifications() dismisses exactly the caller's own active
--    rows -- never another user's -- and never deletes anything (row count
--    is unchanged, only dismissed_at is set).
-- =====================================================================
do $$
declare
  v_count_before int;
  v_count_after int;
begin
  select count(*) into v_count_before from notifications;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006201');
  set local role authenticated;
  perform clear_my_notifications();
  reset role;

  select count(*) into v_count_after from notifications;
  perform pg_temp.check_result(
    'clear_my_notifications never deletes rows -- total count is unchanged',
    v_count_before = v_count_after, format('before=%s after=%s', v_count_before, v_count_after)
  );

  perform pg_temp.check_result(
    'both of the caller''s own notifications are now dismissed',
    (select count(*) from notifications where user_id = '00000000-0000-0000-0000-000000006201'
       and dismissed_at is not null) = 2
  );
  perform pg_temp.check_result(
    'a different user''s notification is completely untouched (still active)',
    (select dismissed_at from notifications where id = '00000000-0000-0000-0000-000000006303') is null
  );
end $$;

-- =====================================================================
-- 2. Idempotent / re-run safety: calling it again with nothing new to
--    dismiss is a harmless no-op (no error, no change to already-dismissed
--    rows' timestamps forced backwards, etc.).
-- =====================================================================
do $$
declare
  v_first_dismissed_at timestamptz;
  v_second_dismissed_at timestamptz;
begin
  select dismissed_at into v_first_dismissed_at from notifications
    where id = '00000000-0000-0000-0000-000000006301';

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006201');
  set local role authenticated;
  perform clear_my_notifications();
  reset role;

  select dismissed_at into v_second_dismissed_at from notifications
    where id = '00000000-0000-0000-0000-000000006301';
  perform pg_temp.check_result(
    'calling clear_my_notifications again with nothing new to dismiss changes nothing',
    v_first_dismissed_at = v_second_dismissed_at
  );
end $$;

-- =====================================================================
-- 3. A fresh notification created after clearing is unaffected (active).
-- =====================================================================
insert into notifications (id, user_id, type, incident_id, text, category) values
  ('00000000-0000-0000-0000-000000006304', '00000000-0000-0000-0000-000000006201',
   'incident_updated', null, 'A brand new notification after clearing', 'update');
select pg_temp.check_result(
  'a notification created after clearing is active (dismissed_at is null)',
  (select dismissed_at from notifications where id = '00000000-0000-0000-0000-000000006304') is null
);

-- =====================================================================
-- 4. Authorization: an unauthenticated caller is rejected, and no
--    notification is altered by the rejected call.
-- =====================================================================
do $$
declare
  v_before int;
  v_after int;
begin
  select count(*) filter (where dismissed_at is not null) into v_before from notifications;
  perform pg_temp.as_anon();
  set local role authenticated;
  begin
    perform clear_my_notifications();
    perform pg_temp.check_result('an unauthenticated caller is rejected by clear_my_notifications', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'an unauthenticated caller is rejected by clear_my_notifications', sqlerrm like 'permission:%', sqlerrm
    );
  end;
  reset role;
  select count(*) filter (where dismissed_at is not null) into v_after from notifications;
  perform pg_temp.check_result(
    'a rejected unauthenticated call dismisses nothing',
    v_before = v_after
  );
end $$;

-- =====================================================================
-- 5. Structural: no user-id parameter exists to pass -- "dismiss someone
--    else's notifications" is not an input this RPC can even express.
-- =====================================================================
select pg_temp.check_result(
  'clear_my_notifications has no parameters (no target user id accepted)',
  (select pronargs from pg_proc where proname = 'clear_my_notifications') = 0
);

-- =====================================================================
-- 6. Grants: anon and PUBLIC cannot execute it; authenticated can.
-- =====================================================================
select pg_temp.check_result(
  'clear_my_notifications is not executable by anon or PUBLIC',
  not has_function_privilege('anon', 'public.clear_my_notifications()', 'EXECUTE')
  and not has_function_privilege('public', 'public.clear_my_notifications()', 'EXECUTE')
);
select pg_temp.check_result(
  'clear_my_notifications IS executable by authenticated',
  has_function_privilege('authenticated', 'public.clear_my_notifications()', 'EXECUTE')
);

-- =====================================================================
-- 7. The default list-query shape (mirrors SupabaseRepository.
--    listNotifications) excludes dismissed rows and keeps active ones.
-- =====================================================================
select pg_temp.check_result(
  'the default active-list query shape excludes dismissed rows for the clearing user',
  (select count(*) from notifications
     where user_id = '00000000-0000-0000-0000-000000006201' and dismissed_at is null) = 1 -- only row 6304
);
select pg_temp.check_result(
  'the default active-list query shape still returns the untouched other user''s notification',
  (select count(*) from notifications
     where user_id = '00000000-0000-0000-0000-000000006202' and dismissed_at is null) = 1
);

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
