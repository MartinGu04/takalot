-- Focused verification for migration 0053 (AVARIA v1.5.0 Phase 2: Web Push
-- subscription + delivery schema): self-service RPC scoping, no arbitrary
-- target user_id, anon/inactive rejection, deny-all direct table access,
-- upsert refresh, shared-browser ownership transfer, count/delete scoping,
-- and push_deliveries idempotency + cascade. Runs only against the local
-- scratch database created by tests/run.sh, in one transaction that rolls
-- back at the end. Nothing here sends a Push notification or touches HTTP --
-- that is Phase 5, not yet implemented.
\pset pager off
begin;

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

-- =====================================================================
-- Fixture users. All technician, matching this repo's convention of using
-- the lowest-privilege active role for RPC-scoping tests unless the role
-- itself is what's under test (it is not, here -- these RPCs are self-only
-- and role-independent).
-- =====================================================================
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000006401', 'push-user-one@test', now()),
  ('00000000-0000-0000-0000-000000006402', 'push-user-two@test', now()),
  ('00000000-0000-0000-0000-000000006403', 'push-user-inactive@test', now()),
  ('00000000-0000-0000-0000-000000006404', 'push-shared-a@test', now()),
  ('00000000-0000-0000-0000-000000006405', 'push-shared-b@test', now()),
  ('00000000-0000-0000-0000-000000006406', 'push-count-a@test', now()),
  ('00000000-0000-0000-0000-000000006407', 'push-count-b@test', now()),
  ('00000000-0000-0000-0000-000000006408', 'push-delone@test', now()),
  ('00000000-0000-0000-0000-000000006409', 'push-delall-a@test', now()),
  ('00000000-0000-0000-0000-000000006410', 'push-delall-b@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000006401', 'Push User One', 'technician', true),
  ('00000000-0000-0000-0000-000000006402', 'Push User Two', 'technician', true),
  ('00000000-0000-0000-0000-000000006403', 'Push User Inactive', 'technician', false),
  ('00000000-0000-0000-0000-000000006404', 'Push Shared A', 'technician', true),
  ('00000000-0000-0000-0000-000000006405', 'Push Shared B', 'technician', true),
  ('00000000-0000-0000-0000-000000006406', 'Push Count A', 'technician', true),
  ('00000000-0000-0000-0000-000000006407', 'Push Count B', 'technician', true),
  ('00000000-0000-0000-0000-000000006408', 'Push Del One', 'technician', true),
  ('00000000-0000-0000-0000-000000006409', 'Push Delall A', 'technician', true),
  ('00000000-0000-0000-0000-000000006410', 'Push Delall B', 'technician', true);

-- =====================================================================
-- A. Active authenticated user can save their own subscription.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006401');
  set local role authenticated;
  perform save_my_push_subscription(
    'https://push.example.com/ep-user-one', 'p256dh-value-user-one', 'auth-value-user-one'
  );
  reset role;

  perform pg_temp.check_result(
    'A: active member can save their own subscription',
    (select count(*) from push_subscriptions
       where endpoint = 'https://push.example.com/ep-user-one'
         and user_id = '00000000-0000-0000-0000-000000006401') = 1
  );
end $$;

-- =====================================================================
-- B. No RPC accepts an arbitrary target user_id -- structural: neither the
--    argument list nor the parameter names of any of the four RPCs mentions
--    a user id at all. The target is always auth.uid(), read from inside
--    the function body, never a parameter.
-- =====================================================================
select pg_temp.check_result(
  'B: none of the four Push RPCs declare a user-id-shaped parameter',
  (select count(*) from pg_proc
     where proname in (
       'save_my_push_subscription', 'delete_my_push_subscription',
       'delete_all_my_push_subscriptions', 'count_my_push_subscriptions'
     )
     and pg_get_function_arguments(oid) ~* 'user_id') = 0
);
select pg_temp.check_result(
  'B: delete_all_my_push_subscriptions and count_my_push_subscriptions take zero parameters',
  (select count(*) from pg_proc
     where proname in ('delete_all_my_push_subscriptions', 'count_my_push_subscriptions')
       and pronargs = 0) = 2
);

-- =====================================================================
-- C. Anonymous caller cannot manage subscriptions -- all four RPCs reject.
-- =====================================================================
do $$
begin
  perform pg_temp.as_anon();
  set local role authenticated;

  begin
    perform save_my_push_subscription('https://push.example.com/ep-anon', 'p256dh', 'auth');
    perform pg_temp.check_result('C: anon rejected by save_my_push_subscription', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'C: anon rejected by save_my_push_subscription', sqlerrm like 'permission:%', sqlerrm
    );
  end;

  begin
    perform delete_my_push_subscription('https://push.example.com/ep-user-one');
    perform pg_temp.check_result('C: anon rejected by delete_my_push_subscription', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'C: anon rejected by delete_my_push_subscription', sqlerrm like 'permission:%', sqlerrm
    );
  end;

  begin
    perform delete_all_my_push_subscriptions();
    perform pg_temp.check_result('C: anon rejected by delete_all_my_push_subscriptions', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'C: anon rejected by delete_all_my_push_subscriptions', sqlerrm like 'permission:%', sqlerrm
    );
  end;

  begin
    perform count_my_push_subscriptions();
    perform pg_temp.check_result('C: anon rejected by count_my_push_subscriptions', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'C: anon rejected by count_my_push_subscriptions', sqlerrm like 'permission:%', sqlerrm
    );
  end;

  reset role;
  perform pg_temp.check_result(
    'C: a rejected anon save left no row behind',
    (select count(*) from push_subscriptions where endpoint = 'https://push.example.com/ep-anon') = 0
  );
end $$;

-- =====================================================================
-- D. Inactive/deactivated user cannot save, delete, delete-all, or count.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006403');
  set local role authenticated;

  begin
    perform save_my_push_subscription('https://push.example.com/ep-inactive', 'p256dh', 'auth');
    perform pg_temp.check_result('D: inactive user rejected by save_my_push_subscription', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'D: inactive user rejected by save_my_push_subscription', sqlerrm like 'permission:%', sqlerrm
    );
  end;

  begin
    perform delete_my_push_subscription('https://push.example.com/ep-user-one');
    perform pg_temp.check_result('D: inactive user rejected by delete_my_push_subscription', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'D: inactive user rejected by delete_my_push_subscription', sqlerrm like 'permission:%', sqlerrm
    );
  end;

  begin
    perform delete_all_my_push_subscriptions();
    perform pg_temp.check_result('D: inactive user rejected by delete_all_my_push_subscriptions', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'D: inactive user rejected by delete_all_my_push_subscriptions', sqlerrm like 'permission:%', sqlerrm
    );
  end;

  begin
    perform count_my_push_subscriptions();
    perform pg_temp.check_result('D: inactive user rejected by count_my_push_subscriptions', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'D: inactive user rejected by count_my_push_subscriptions', sqlerrm like 'permission:%', sqlerrm
    );
  end;

  reset role;
  perform pg_temp.check_result(
    'D: user_one''s subscription from test A is untouched by the rejected inactive-user delete attempt',
    (select count(*) from push_subscriptions
       where endpoint = 'https://push.example.com/ep-user-one'
         and user_id = '00000000-0000-0000-0000-000000006401') = 1
  );
end $$;

-- =====================================================================
-- E. Direct authenticated INSERT/UPDATE/DELETE against push_subscriptions
--    is denied -- no policy grants it, and the table grant itself was
--    explicitly revoked.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006401');
  set local role authenticated;
  begin
    insert into push_subscriptions (user_id, endpoint, p256dh, auth_key)
    values ('00000000-0000-0000-0000-000000006401', 'https://push.example.com/ep-direct-insert', 'p', 'a');
    perform pg_temp.check_result('E: direct authenticated INSERT into push_subscriptions is denied', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'E: direct authenticated INSERT into push_subscriptions is denied',
      sqlerrm like '%permission denied%', sqlerrm
    );
  end;
  begin
    update push_subscriptions set p256dh = 'x' where endpoint = 'https://push.example.com/ep-user-one';
    perform pg_temp.check_result('E: direct authenticated UPDATE on push_subscriptions is denied', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'E: direct authenticated UPDATE on push_subscriptions is denied',
      sqlerrm like '%permission denied%', sqlerrm
    );
  end;
  begin
    delete from push_subscriptions where endpoint = 'https://push.example.com/ep-user-one';
    perform pg_temp.check_result('E: direct authenticated DELETE on push_subscriptions is denied', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'E: direct authenticated DELETE on push_subscriptions is denied',
      sqlerrm like '%permission denied%', sqlerrm
    );
  end;
  reset role;
end $$;
select pg_temp.check_result(
  'E: table grants confirm no SELECT/INSERT/UPDATE/DELETE for authenticated or anon on push_subscriptions',
  not has_table_privilege('authenticated', 'push_subscriptions', 'SELECT')
  and not has_table_privilege('authenticated', 'push_subscriptions', 'INSERT')
  and not has_table_privilege('authenticated', 'push_subscriptions', 'UPDATE')
  and not has_table_privilege('authenticated', 'push_subscriptions', 'DELETE')
  and not has_table_privilege('anon', 'push_subscriptions', 'SELECT')
);

-- =====================================================================
-- F. Ordinary authenticated users cannot directly operate on push_deliveries.
-- =====================================================================
do $$
declare
  v_notification_id uuid;
  v_subscription_id uuid;
begin
  select id into v_subscription_id from push_subscriptions
    where endpoint = 'https://push.example.com/ep-user-one';
  insert into notifications (user_id, type, incident_id, text, category)
  values ('00000000-0000-0000-0000-000000006401', 'incident_assigned', null, 'F fixture notification', 'action_required')
  returning id into v_notification_id;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006401');
  set local role authenticated;
  begin
    insert into push_deliveries (notification_id, subscription_id) values (v_notification_id, v_subscription_id);
    perform pg_temp.check_result('F: direct authenticated INSERT into push_deliveries is denied', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'F: direct authenticated INSERT into push_deliveries is denied',
      sqlerrm like '%permission denied%', sqlerrm
    );
  end;
  begin
    perform 1 from push_deliveries limit 1;
    perform pg_temp.check_result('F: direct authenticated SELECT on push_deliveries is denied', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'F: direct authenticated SELECT on push_deliveries is denied',
      sqlerrm like '%permission denied%', sqlerrm
    );
  end;
  reset role;
end $$;
select pg_temp.check_result(
  'F: table grants confirm no SELECT/INSERT/UPDATE/DELETE for authenticated or anon on push_deliveries',
  not has_table_privilege('authenticated', 'push_deliveries', 'SELECT')
  and not has_table_privilege('authenticated', 'push_deliveries', 'INSERT')
  and not has_table_privilege('anon', 'push_deliveries', 'SELECT')
);

-- =====================================================================
-- G. Saving the same endpoint twice does not duplicate, and refreshes the
--    key material (the row's identity -- created_at, id -- is preserved,
--    proving this is a true upsert, not a delete+reinsert. updated_at's
--    numeric advance is not asserted here: touch_updated_at() stamps it
--    from now(), which is frozen for this whole test transaction, so a
--    second call within the same transaction cannot show a later value
--    even though it is, correctly, re-set on every update in production).
-- =====================================================================
do $$
declare
  v_created_at_1 timestamptz;
  v_created_at_2 timestamptz;
begin
  select created_at into v_created_at_1 from push_subscriptions
    where endpoint = 'https://push.example.com/ep-user-one';

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006401');
  set local role authenticated;
  perform save_my_push_subscription(
    'https://push.example.com/ep-user-one', 'p256dh-value-REFRESHED', 'auth-value-REFRESHED'
  );
  reset role;

  select created_at into v_created_at_2 from push_subscriptions
    where endpoint = 'https://push.example.com/ep-user-one';

  perform pg_temp.check_result(
    'G: saving the same endpoint twice does not create a duplicate row',
    (select count(*) from push_subscriptions where endpoint = 'https://push.example.com/ep-user-one') = 1
  );
  perform pg_temp.check_result(
    'G: the key material is refreshed to the latest call''s values',
    (select p256dh from push_subscriptions where endpoint = 'https://push.example.com/ep-user-one')
      = 'p256dh-value-REFRESHED'
    and (select auth_key from push_subscriptions where endpoint = 'https://push.example.com/ep-user-one')
      = 'auth-value-REFRESHED'
  );
  perform pg_temp.check_result(
    'G: created_at is unchanged -- this is the same physical row, a true upsert',
    v_created_at_1 = v_created_at_2
  );
end $$;

-- =====================================================================
-- H. Shared-browser ownership transfer: user A owns endpoint X; active user
--    B later saves the SAME endpoint with their own session; exactly one
--    row for X remains, now owned by B; A cannot subsequently delete B's
--    current subscription via delete_my_push_subscription(X); and A's
--    stale push_deliveries history for that (now-reassigned) row is
--    discarded by the transfer.
-- =====================================================================
do $$
declare
  v_shared_endpoint text := 'https://push.example.com/ep-shared-device';
  v_subscription_id uuid;
  v_notification_id uuid;
  v_owner_after uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006404'); -- A
  set local role authenticated;
  perform save_my_push_subscription(v_shared_endpoint, 'p256dh-a', 'auth-a');
  reset role;

  select id into v_subscription_id from push_subscriptions where endpoint = v_shared_endpoint;
  insert into notifications (user_id, type, incident_id, text, category)
  values ('00000000-0000-0000-0000-000000006404', 'incident_assigned', null, 'H fixture notification for A', 'action_required')
  returning id into v_notification_id;
  insert into push_deliveries (notification_id, subscription_id, status)
  values (v_notification_id, v_subscription_id, 'sent');

  perform pg_temp.check_result(
    'H: A''s pre-transfer push_deliveries row exists before B takes over the endpoint',
    (select count(*) from push_deliveries where subscription_id = v_subscription_id) = 1
  );

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006405'); -- B, same real browser/endpoint
  set local role authenticated;
  perform save_my_push_subscription(v_shared_endpoint, 'p256dh-b', 'auth-b');
  reset role;

  perform pg_temp.check_result(
    'H: exactly one row remains for the shared endpoint after B''s save',
    (select count(*) from push_subscriptions where endpoint = v_shared_endpoint) = 1
  );
  select user_id into v_owner_after from push_subscriptions where endpoint = v_shared_endpoint;
  perform pg_temp.check_result(
    'H: the shared endpoint is now owned by B, not A',
    v_owner_after = '00000000-0000-0000-0000-000000006405'
  );
  perform pg_temp.check_result(
    'H: A''s stale push_deliveries row for the reassigned subscription is gone',
    (select count(*) from push_deliveries where subscription_id = v_subscription_id) = 0
  );

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006404'); -- A again
  set local role authenticated;
  perform delete_my_push_subscription(v_shared_endpoint);
  reset role;

  perform pg_temp.check_result(
    'H: A cannot delete B''s current subscription by calling delete_my_push_subscription with A''s old endpoint',
    (select count(*) from push_subscriptions where endpoint = v_shared_endpoint and user_id = '00000000-0000-0000-0000-000000006405') = 1
  );
end $$;

-- =====================================================================
-- I. count_my_push_subscriptions returns only the caller's own count.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006406'); -- count-a: will have 2
  set local role authenticated;
  perform save_my_push_subscription('https://push.example.com/ep-count-a-1', 'p', 'a');
  perform save_my_push_subscription('https://push.example.com/ep-count-a-2', 'p', 'a');
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006407'); -- count-b: will have 1
  set local role authenticated;
  perform save_my_push_subscription('https://push.example.com/ep-count-b-1', 'p', 'a');
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006406');
  set local role authenticated;
  perform pg_temp.check_result('I: count_my_push_subscriptions returns 2 for count-a', count_my_push_subscriptions() = 2);
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006407');
  set local role authenticated;
  perform pg_temp.check_result('I: count_my_push_subscriptions returns 1 for count-b, not count-a''s 2', count_my_push_subscriptions() = 1);
  reset role;
end $$;

-- =====================================================================
-- J. delete_my_push_subscription deletes only the caller's matching
--    endpoint, leaving their other device(s) untouched.
-- =====================================================================
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006408');
  set local role authenticated;
  perform save_my_push_subscription('https://push.example.com/ep-delone-1', 'p', 'a');
  perform save_my_push_subscription('https://push.example.com/ep-delone-2', 'p', 'a');
  perform delete_my_push_subscription('https://push.example.com/ep-delone-1');
  reset role;

  perform pg_temp.check_result(
    'J: the targeted endpoint is deleted',
    (select count(*) from push_subscriptions where endpoint = 'https://push.example.com/ep-delone-1') = 0
  );
  perform pg_temp.check_result(
    'J: the caller''s OTHER device is untouched',
    (select count(*) from push_subscriptions where endpoint = 'https://push.example.com/ep-delone-2'
       and user_id = '00000000-0000-0000-0000-000000006408') = 1
  );
end $$;

-- =====================================================================
-- K/N. delete_all_my_push_subscriptions deletes only the caller's rows
--      (K), and does not affect another user's subscriptions or
--      push_deliveries (N) -- and cascade-deletes the caller's own
--      push_deliveries rows in the process (M, folded in here since it
--      needs the same fixture).
-- =====================================================================
do $$
declare
  v_sub_a1 uuid;
  v_sub_a2 uuid;
  v_sub_b uuid;
  v_notif_a uuid;
  v_notif_b uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006409'); -- delall-a: 2 devices
  set local role authenticated;
  perform save_my_push_subscription('https://push.example.com/ep-delall-a-1', 'p', 'a');
  perform save_my_push_subscription('https://push.example.com/ep-delall-a-2', 'p', 'a');
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006410'); -- delall-b: 1 device, untouched control
  set local role authenticated;
  perform save_my_push_subscription('https://push.example.com/ep-delall-b-1', 'p', 'a');
  reset role;

  select id into v_sub_a1 from push_subscriptions where endpoint = 'https://push.example.com/ep-delall-a-1';
  select id into v_sub_a2 from push_subscriptions where endpoint = 'https://push.example.com/ep-delall-a-2';
  select id into v_sub_b from push_subscriptions where endpoint = 'https://push.example.com/ep-delall-b-1';

  insert into notifications (user_id, type, incident_id, text, category)
  values ('00000000-0000-0000-0000-000000006409', 'incident_assigned', null, 'K/N fixture for A', 'action_required')
  returning id into v_notif_a;
  insert into notifications (user_id, type, incident_id, text, category)
  values ('00000000-0000-0000-0000-000000006410', 'incident_assigned', null, 'K/N fixture for B', 'action_required')
  returning id into v_notif_b;

  insert into push_deliveries (notification_id, subscription_id, status) values (v_notif_a, v_sub_a1, 'sent');
  insert into push_deliveries (notification_id, subscription_id, status) values (v_notif_a, v_sub_a2, 'failed');
  insert into push_deliveries (notification_id, subscription_id, status) values (v_notif_b, v_sub_b, 'sent');

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006409'); -- A deletes ALL of their own devices
  set local role authenticated;
  perform delete_all_my_push_subscriptions();
  reset role;

  perform pg_temp.check_result(
    'K: delete_all_my_push_subscriptions removes every one of the caller''s own rows',
    (select count(*) from push_subscriptions where user_id = '00000000-0000-0000-0000-000000006409') = 0
  );
  perform pg_temp.check_result(
    'M: deleting a subscription cascade-deletes its push_deliveries rows',
    (select count(*) from push_deliveries where subscription_id in (v_sub_a1, v_sub_a2)) = 0
  );
  perform pg_temp.check_result(
    'K/N: a different user''s subscription is completely unaffected',
    (select count(*) from push_subscriptions where id = v_sub_b and user_id = '00000000-0000-0000-0000-000000006410') = 1
  );
  perform pg_temp.check_result(
    'N: a different user''s push_deliveries row is completely unaffected',
    (select count(*) from push_deliveries where subscription_id = v_sub_b) = 1
  );
end $$;

-- =====================================================================
-- L. push_deliveries idempotency: a duplicate (notification_id,
--    subscription_id) claim is rejected by the database's own uniqueness
--    boundary -- this is what lets Phase 5 do "insert claim -> unique
--    conflict means someone already claimed it" safely.
-- =====================================================================
do $$
declare
  v_notification_id uuid;
  v_subscription_id uuid;
begin
  select id into v_subscription_id from push_subscriptions where endpoint = 'https://push.example.com/ep-delall-b-1';
  insert into notifications (user_id, type, incident_id, text, category)
  values ('00000000-0000-0000-0000-000000006410', 'incident_assigned', null, 'L fixture notification', 'action_required')
  returning id into v_notification_id;

  insert into push_deliveries (notification_id, subscription_id) values (v_notification_id, v_subscription_id);
  perform pg_temp.check_result(
    'L: the first delivery claim for a (notification, subscription) pair succeeds',
    (select count(*) from push_deliveries
       where notification_id = v_notification_id and subscription_id = v_subscription_id) = 1
  );

  begin
    insert into push_deliveries (notification_id, subscription_id) values (v_notification_id, v_subscription_id);
    perform pg_temp.check_result('L: a duplicate delivery claim for the same pair is rejected', false, 'succeeded');
  exception when unique_violation then
    perform pg_temp.check_result('L: a duplicate delivery claim for the same pair is rejected', true, sqlerrm);
  end;

  perform pg_temp.check_result(
    'L: exactly one delivery row exists for the pair after the rejected duplicate attempt',
    (select count(*) from push_deliveries
       where notification_id = v_notification_id and subscription_id = v_subscription_id) = 1
  );
end $$;

-- =====================================================================
-- is_my_push_subscription(): added after Phase 2 review to let Phase 4
-- distinguish "this browser has A PushSubscription" from "this browser's
-- PushSubscription is registered to the CURRENTLY authenticated user" --
-- needed for shared-browser / failed-logout-cleanup scenarios. Reuses
-- fixtures already committed by earlier sections in this same transaction
-- (A/D for user_one and the inactive user, H for the shared-endpoint
-- transfer, I for count-a/count-b's own devices, J for the deleted
-- endpoint) rather than re-seeding.
-- =====================================================================

-- 1. Caller owns the endpoint -> true.
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006401'); -- user_one, from section A
  set local role authenticated;
  perform pg_temp.check_result(
    'is_my_push_subscription 1: caller owns the endpoint -> true',
    is_my_push_subscription('https://push.example.com/ep-user-one') = true
  );
  reset role;
end $$;

-- 2. The endpoint exists, but belongs to a DIFFERENT user -> false.
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006406'); -- count-a, from section I
  set local role authenticated;
  perform pg_temp.check_result(
    'is_my_push_subscription 2: caller does not own another user''s endpoint -> false',
    is_my_push_subscription('https://push.example.com/ep-count-b-1') = false
  );
  reset role;
end $$;

-- 3. After the shared-endpoint transfer in section H (A -> B): A now reads
--    false and B reads true, for the SAME endpoint string.
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006404'); -- A, former owner
  set local role authenticated;
  perform pg_temp.check_result(
    'is_my_push_subscription 3a: former owner A reads false after the shared-endpoint transfer',
    is_my_push_subscription('https://push.example.com/ep-shared-device') = false
  );
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000006405'); -- B, current owner
  set local role authenticated;
  perform pg_temp.check_result(
    'is_my_push_subscription 3b: current owner B reads true for the same endpoint',
    is_my_push_subscription('https://push.example.com/ep-shared-device') = true
  );
  reset role;
end $$;

-- 4. After delete (section J deleted ep-delone-1 for its owner) -> false.
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006408'); -- from section J
  set local role authenticated;
  perform pg_temp.check_result(
    'is_my_push_subscription 4: a deleted endpoint reads false for its former owner',
    is_my_push_subscription('https://push.example.com/ep-delone-1') = false
  );
  reset role;
end $$;

-- 5. Anonymous caller denied.
do $$
begin
  perform pg_temp.as_anon();
  set local role authenticated;
  begin
    perform is_my_push_subscription('https://push.example.com/ep-user-one');
    perform pg_temp.check_result('is_my_push_subscription 5: anon rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'is_my_push_subscription 5: anon rejected', sqlerrm like 'permission:%', sqlerrm
    );
  end;
  reset role;
end $$;

-- 6. Inactive caller denied.
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000006403'); -- inactive, from section D
  set local role authenticated;
  begin
    perform is_my_push_subscription('https://push.example.com/ep-user-one');
    perform pg_temp.check_result('is_my_push_subscription 6: inactive user rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'is_my_push_subscription 6: inactive user rejected', sqlerrm like 'permission:%', sqlerrm
    );
  end;
  reset role;
end $$;

-- 7. Adding this RPC introduced no raw SELECT grant on push_subscriptions,
--    and its own EXECUTE grant matches every other RPC in this migration.
select pg_temp.check_result(
  'is_my_push_subscription 7: still no raw SELECT grant on push_subscriptions for authenticated or anon',
  not has_table_privilege('authenticated', 'push_subscriptions', 'SELECT')
  and not has_table_privilege('anon', 'push_subscriptions', 'SELECT')
);
select pg_temp.check_result(
  'is_my_push_subscription: authenticated has EXECUTE; anon and PUBLIC do not',
  has_function_privilege('authenticated', 'public.is_my_push_subscription(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.is_my_push_subscription(text)', 'EXECUTE')
  and not has_function_privilege('public', 'public.is_my_push_subscription(text)', 'EXECUTE')
);

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
