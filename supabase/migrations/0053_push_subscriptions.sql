-- AVARIA v1.5.0 — Phase 2: Web Push subscription + delivery schema.
--
-- Pure database foundation. Nothing in this migration sends a Push
-- notification, invokes HTTP, references VAPID, or depends on Vault/pg_net/
-- a database webhook -- those are Phase 5, deliberately deferred. At the end
-- of this migration the only live paths are:
--   authenticated browser -> save/delete/count RPCs (below) -> push_subscriptions
-- and a second flow that exists structurally but is NEVER executed by
-- anything yet:
--   notifications x push_subscriptions -> push_deliveries idempotency claim
--
-- ---------------------------------------------------------------------
-- 1. push_subscriptions: one durable row per browser/device PushSubscription.
--
-- endpoint is the real browser-issued Push endpoint URL and is GLOBALLY
-- UNIQUE (one browser subscription can never simultaneously back two AVARIA
-- device rows) -- but a shared browser/account-switch case is explicitly
-- supported: save_my_push_subscription() below reassigns an existing
-- endpoint's ownership to the current caller via ON CONFLICT DO UPDATE
-- rather than rejecting it or leaving it attached to the previous account.
-- That reassignment is reachable ONLY through that narrow, auth.uid()-only
-- RPC -- there is no INSERT/UPDATE policy on this table at all (see RLS
-- section below), so a client can never write user_id directly.
--
-- No device-name/browser-label column: the approved v1.5 UX discovers
-- current-device state from the browser's own PushSubscription object and
-- only needs an account-wide subscription COUNT from the server (see
-- count_my_push_subscriptions), so there is nothing for a label to serve
-- yet. updated_at (via the existing touch_updated_at() trigger, reused
-- as-is from profiles) already doubles as "last refreshed" -- a separate
-- last_seen_at column would carry the exact same meaning under a different
-- name, so it is deliberately not added.
-- ---------------------------------------------------------------------
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  -- Web Push endpoints vary by vendor (FCM/Mozilla/Apple/...); only the
  -- shape genuinely common to all of them -- non-empty, bounded, https -- is
  -- enforced here, so this never overfits to one provider's URL format.
  endpoint text not null unique check (length(endpoint) between 1 and 2048 and endpoint ~ '^https://'),
  p256dh text not null check (length(p256dh) between 1 and 512),
  auth_key text not null check (length(auth_key) between 1 and 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_push_subscriptions_user on push_subscriptions (user_id);

create trigger trg_push_subscriptions_touch before update on push_subscriptions
  for each row execute function touch_updated_at();

comment on table push_subscriptions is
  'One row per browser/device Web Push subscription. Written only by save_my_push_subscription/delete_my_push_subscription/delete_all_my_push_subscriptions (RLS: no client SELECT/INSERT/UPDATE/DELETE policy exists at all). endpoint is globally unique; a shared-browser ownership transfer happens by reassigning user_id on the existing row, never by a client-supplied target id.';

-- ---------------------------------------------------------------------
-- 2. push_deliveries: Phase 5's idempotency + outcome-tracking boundary.
--    NOT business/audit history -- notifications remains the durable
--    canonical record regardless of what happens here. Its only jobs:
--      - let a dispatch attempt atomically CLAIM one (notification,
--        subscription) pair by inserting a 'pending' row -- a concurrent or
--        retried claim on the same pair hits the unique constraint below
--        and backs off, so only the successful claimant ever calls Web Push
--      - record the outcome afterward (status/http_status/error/attempted_at)
--      - leave attempt_count in place so a future retry/backoff mechanism
--        can be added by evolving THIS table alone -- push_subscriptions
--        never needs to change for that.
--    A CHECK constraint (not a new enum) backs `status`, per this
--    migration's instructions and matching how e.g. incident_status's
--    narrower siblings (reported_to_ops, handover_status) are sometimes
--    modeled with enums but plenty of this schema's other bounded text
--    columns use a CHECK instead where no other column shares the domain.
-- ---------------------------------------------------------------------
create table push_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications (id) on delete cascade,
  subscription_id uuid not null references push_subscriptions (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'expired')),
  http_status int,
  error text check (error is null or length(error) <= 2000),
  attempt_count int not null default 1 check (attempt_count > 0),
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  -- The idempotency boundary itself: an insert attempting to claim a pair
  -- another invocation already claimed hits this constraint and fails.
  unique (notification_id, subscription_id)
);
create index idx_push_deliveries_notification on push_deliveries (notification_id);
create index idx_push_deliveries_subscription on push_deliveries (subscription_id);

comment on table push_deliveries is
  'Phase 5 Push delivery idempotency claims + outcomes, scoped to (notification_id, subscription_id). Diagnostics only, not audit history -- deleting a push_subscriptions row cascade-deletes its rows here (retention decision: no soft-delete). No client access whatsoever (RLS: zero policies); the future dispatch path is service-role-mediated and out of scope for this migration.';

-- ---------------------------------------------------------------------
-- 3. RLS: identical model to incident_sequences (0003) -- RLS enabled, ZERO
--    policies on either table. That alone denies every SELECT/INSERT/
--    UPDATE/DELETE to anon and authenticated; SECURITY DEFINER RPCs (owned
--    by postgres) reach the tables anyway since RLS does not apply to a
--    table's owner. The four REVOKEs restate that same "no direct access"
--    outcome at the table-grant level too -- redundant with RLS, but makes
--    the intended access model legible from this migration alone, the same
--    reasoning 0005 used for its own redundant anon revoke, rather than
--    depending on a reader already knowing that RLS-with-no-policies is
--    equivalent to a full revoke here. service_role is deliberately NOT
--    granted anything on push_deliveries here, mirroring 0005 section 3's
--    reasoning verbatim: there is no Edge Function or server-side caller in
--    this repo yet: that grant belongs in the Phase 5 migration that
--    actually introduces one.
-- ---------------------------------------------------------------------
alter table push_subscriptions enable row level security;
alter table push_deliveries enable row level security;

revoke select, insert, update, delete on table push_subscriptions from anon, authenticated;
revoke select, insert, update, delete on table push_deliveries from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. save_my_push_subscription(): self-service upsert. auth.uid() is the
--    only source of ownership -- there is no user_id parameter, so there is
--    no argument a client could pass to attach a subscription to anyone
--    else. Requires is_active_member() (existing helper, 0003) exactly like
--    every other self-service write RPC in this schema, so an inactive or
--    unauthenticated caller is rejected before anything is touched.
--
--    Shared-browser reassignment: if the real browser endpoint already
--    belongs to a DIFFERENT AVARIA account (the previous person on this
--    shared device), that old row's push_deliveries history is discarded
--    first -- it describes deliveries for the previous owner's
--    notifications, not the new caller's, and would otherwise persist
--    attached to a subscription that now belongs to someone else. The
--    upsert itself (ON CONFLICT DO UPDATE on the unique endpoint) then
--    reassigns user_id and refreshes the key material in one statement;
--    touch_updated_at() (already firing on this table, section 1) stamps
--    updated_at on that UPDATE exactly as it would on any other.
-- ---------------------------------------------------------------------
create or replace function public.save_my_push_subscription(
  p_endpoint text, p_p256dh text, p_auth_key text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_endpoint text := trim(coalesce(p_endpoint, ''));
  v_p256dh text := trim(coalesce(p_p256dh, ''));
  v_auth_key text := trim(coalesce(p_auth_key, ''));
  v_existing_id uuid;
  v_existing_owner uuid;
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if v_endpoint = '' or length(v_endpoint) > 2048 or v_endpoint !~ '^https://' then
    raise exception 'validation: כתובת המנוי אינה תקינה';
  end if;
  if v_p256dh = '' or length(v_p256dh) > 512 then
    raise exception 'validation: מפתח ההצפנה (p256dh) אינו תקין';
  end if;
  if v_auth_key = '' or length(v_auth_key) > 512 then
    raise exception 'validation: מפתח האימות (auth) אינו תקין';
  end if;

  select ps.id, ps.user_id into v_existing_id, v_existing_owner
    from push_subscriptions ps where ps.endpoint = v_endpoint;

  if v_existing_id is not null and v_existing_owner is distinct from auth.uid() then
    delete from push_deliveries where subscription_id = v_existing_id;
  end if;

  insert into push_subscriptions (user_id, endpoint, p256dh, auth_key)
  values (auth.uid(), v_endpoint, v_p256dh, v_auth_key)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth_key = excluded.auth_key;
end;
$$;

revoke execute on function public.save_my_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_my_push_subscription(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. delete_my_push_subscription(): deletes at most one row -- the caller's
--    own, matching the given endpoint. The WHERE clause's user_id =
--    auth.uid() makes "delete someone else's current subscription" a
--    structurally impossible zero-row no-op, not merely a code convention:
--    even the exact endpoint string previously (or currently) owned by
--    another account matches nothing here once it is not this caller's row.
-- ---------------------------------------------------------------------
create or replace function public.delete_my_push_subscription(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_push_subscription(text) from public, anon;
grant execute on function public.delete_my_push_subscription(text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. delete_all_my_push_subscriptions(): backs "נתק את כל המכשירים". No
--    parameters -- always auth.uid() -- so this can only ever remove the
--    caller's own rows. push_deliveries cascade-deletes via the FK in
--    section 2; no explicit cleanup statement is needed here.
-- ---------------------------------------------------------------------
create or replace function public.delete_all_my_push_subscriptions() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  delete from push_subscriptions where user_id = auth.uid();
end;
$$;

revoke execute on function public.delete_all_my_push_subscriptions() from public, anon;
grant execute on function public.delete_all_my_push_subscriptions() to authenticated;

-- ---------------------------------------------------------------------
-- 7. count_my_push_subscriptions(): the only read this phase exposes, and
--    only a count -- never endpoints or key material, and never another
--    user's count. Raises the same 'permission:' error as the write RPCs
--    for an inactive/unauthenticated caller (fails closed, does not
--    silently answer 0 -- "you are not allowed to know" is a different
--    outcome from "you truthfully have zero devices").
-- ---------------------------------------------------------------------
create or replace function public.count_my_push_subscriptions() returns int
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  return (select count(*)::int from push_subscriptions where user_id = auth.uid());
end;
$$;

revoke execute on function public.count_my_push_subscriptions() from public, anon;
grant execute on function public.count_my_push_subscriptions() to authenticated;

-- ---------------------------------------------------------------------
-- 8. is_my_push_subscription(): added after initial Phase 2 review. This
--    file is still entirely unreleased (never applied to a hosted
--    database), so the addition is folded in here rather than a follow-up
--    migration, the same way 0044 amended itself in place -- see that
--    file's own header comment for the identical reasoning.
--
--    The gap this closes: browser PushSubscription state alone cannot tell
--    Phase 4 whether the endpoint it holds is registered to the CURRENTLY
--    authenticated AVARIA user, only that some subscription exists at that
--    endpoint. On a shared browser, if a failed logout left user A's
--    push_subscriptions row in place and user B now signs in, the browser's
--    PushManager can still return that same endpoint -- without this check,
--    the UI would have no safe way to avoid presenting Push as "enabled"
--    for B when the row underneath still belongs to A. Same endpoint
--    validation as save_my_push_subscription (section 4) -- a malformed
--    endpoint is a validation error here too, not silently false, since a
--    shape that could never have been saved is a caller bug, not a "no"
--    answer. Returns a bare boolean: never the owner, never any other
--    subscription column -- there is nothing in the response to leak.
-- ---------------------------------------------------------------------
create or replace function public.is_my_push_subscription(p_endpoint text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_endpoint text := trim(coalesce(p_endpoint, ''));
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if v_endpoint = '' or length(v_endpoint) > 2048 or v_endpoint !~ '^https://' then
    raise exception 'validation: כתובת המנוי אינה תקינה';
  end if;
  return exists (
    select 1 from push_subscriptions where endpoint = v_endpoint and user_id = auth.uid()
  );
end;
$$;

revoke execute on function public.is_my_push_subscription(text) from public, anon;
grant execute on function public.is_my_push_subscription(text) to authenticated;
