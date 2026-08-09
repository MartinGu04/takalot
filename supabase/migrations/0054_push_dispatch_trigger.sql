-- AVARIA v1.5.0 -- Phase 5A: server-side Push dispatch trigger.
--
-- public.notifications remains the ONLY canonical notification source --
-- this migration adds nothing that writes a notification, and no existing
-- incident lifecycle RPC is modified. It attaches a narrow, fail-safe
-- AFTER INSERT trigger that fires a Web Push dispatch attempt for exactly
-- the notification rows the v1.5 policy approves, and nothing else.
--
-- ---------------------------------------------------------------------
-- Approved v1.5 send policy (FINAL -- see the trigger WHEN clause below,
-- which is the actual enforcement, re-checked again inside the Edge
-- Function as defense in depth):
--   SEND   category = 'action_required'                         (every type)
--   SEND   category = 'update' AND type = 'incident_opened'
--   SKIP   every other 'update' broadcast (incident_updated,
--          incident_closed, incident_cancelled, and the 'update'-category
--          half of incident_reopened -- notify_operational_recipients'
--          own broadcast, NOT the personal action_required notification a
--          reopened incident's owner also receives, which already matches
--          the first SEND rule above)
-- ---------------------------------------------------------------------
--
-- Architecture: AFTER INSERT ON public.notifications, filtered by a WHEN
-- condition (so a routine 'update'-category row for incident_updated/
-- incident_closed/incident_cancelled never even enters the trigger
-- function body, let alone invokes the Edge Function). The trigger reads
-- exactly two named Vault secrets at call time -- the dispatch URL and a
-- dedicated webhook secret -- and fires an asynchronous pg_net HTTP POST
-- carrying only `{"notification_id": "<uuid>"}`. The Edge Function
-- (supabase/functions/send-push-notification/) re-fetches the canonical
-- row itself and re-checks this exact same policy before ever attempting a
-- Web Push send; the payload leaving Postgres is deliberately minimal
-- (never notifications.text or anything else operational).
--
-- Fail-safe by construction, not by convention: dispatch_push_notification()
-- wraps its entire body in a plpgsql exception handler. Any failure --
-- missing/blank Vault configuration (the expected state until Phase 5B
-- completes hosted setup), a missing pg_net/vault schema, a malformed
-- secret, anything -- is caught, logged via RAISE WARNING, and the trigger
-- returns NEW normally. The notification INSERT, and whatever incident
-- lifecycle RPC produced it, can NEVER fail or roll back because of this
-- trigger. No HTTP request is made at all unless both Vault entries are
-- present and non-blank.
--
-- pg_net: enabled here (`create extension if not exists pg_net;`) exactly
-- as it would be against the real hosted platform extension -- idempotent,
-- safe to run whether or not the project has already enabled it via the
-- Database > Extensions UI. Vault is NOT created here: `vault.decrypted_secrets`/
-- `vault.create_secret` ship pre-installed on every hosted Supabase project
-- (see supabase/tests/harness/push_dispatch_stub.sql for this migration's
-- own local-only test double of that platform primitive, and
-- supabase/tests/harness/pg_net_stub/ for pg_net's).
--
-- Vault entry names (secret VALUES are configured later, in Phase 5B --
-- never in this migration, never in source control):
--   avaria_push_dispatch_url    -- the send-push-notification Edge
--                                   Function's invoke URL. Configuration,
--                                   not a secret in itself, but still kept
--                                   in Vault rather than a plaintext table
--                                   so its presence/absence is exactly what
--                                   drives the fail-safe check below.
--   avaria_push_webhook_secret  -- a dedicated shared secret, distinct from
--                                   the VAPID keypair, the anon/publishable
--                                   key, and any user JWT. The Edge
--                                   Function authenticates the inbound
--                                   webhook request against the SAME value,
--                                   configured there as PUSH_WEBHOOK_SECRET.
--
-- Explicit transaction (same reasoning as 0024/0035/0041/0042/0044): the
-- repository's psql -f runner uses autocommit, so this keeps a manual/
-- Supabase SQL editor application all-or-nothing.

begin;

-- =====================================================================
-- 1. pg_net: async outbound HTTP for the dispatch trigger below.
-- =====================================================================
create extension if not exists pg_net;

-- =====================================================================
-- 2. service_role read/write surface: the send-push-notification Edge
--    Function is the ONLY intended caller of these grants -- it always
--    authenticates with the service-role key (never exposed to a
--    browser), matching this repository's one existing Edge Function
--    (delete-user) and its own service-role-only convention. Scoped to
--    exactly what that function's documented processing flow needs:
--      - notifications: SELECT only, to re-fetch the canonical row by id
--        (the function never writes a notification -- that stays
--        exclusively the job of the lifecycle RPCs).
--      - profiles: SELECT only, to confirm the recipient is still active
--        immediately before sending (an inactive/deactivated profile must
--        get ZERO Push attempts, even if the row existed when the
--        trigger fired).
--      - push_subscriptions: SELECT (fetch the recipient's devices) and
--        DELETE (remove a definitively expired/invalid subscription, per
--        the Web Push provider's own 404/410-equivalent signal -- see
--        the Edge Function). Never INSERT/UPDATE: subscription
--        save/transfer stays exclusively the job of the Phase 2
--        self-service RPCs (save_my_push_subscription and friends),
--        which the browser calls directly, never through this function.
--      - push_deliveries: SELECT/INSERT/UPDATE for the idempotency claim
--        and outcome recording (see the trigger's own header comment and
--        the Edge Function for the exact claim protocol). Never DELETE --
--        a subscription's cascade-delete (0053) is the only removal path,
--        matching 0053's own "diagnostics only, no soft-delete" model.
--    Mirrors 0053's own reasoning for why service_role previously had
--    NO grant on push_subscriptions/push_deliveries at all ("there is no
--    Edge Function or server-side caller in this repo yet: that grant
--    belongs in the Phase 5 migration that actually introduces one") --
--    this is that migration.
-- =====================================================================
grant select on table public.notifications to service_role;
grant select on table public.profiles to service_role;
grant select, delete on table public.push_subscriptions to service_role;
grant select, insert, update on table public.push_deliveries to service_role;

-- Every one of these four tables was created by `postgres`, which (per
-- this repository's own default-ACL bootstrapping -- see
-- supabase/tests/harness/prelude.sql, modeling the hosted platform's
-- equivalent) grants service_role ALL privileges on a new table
-- automatically, not just the ones GRANTed above. The four REVOKEs below
-- make the "never INSERT/UPDATE/DELETE beyond what's granted above" intent
-- documented next to each GRANT literally true, rather than merely
-- aspirational -- the same explicit-over-implicit precision 0005 already
-- applies to service_role's function EXECUTE grants (or lack thereof).
revoke insert, update, delete on table public.notifications from service_role;
revoke insert, update, delete on table public.profiles from service_role;
revoke insert, update on table public.push_subscriptions from service_role;
revoke delete on table public.push_deliveries from service_role;

-- =====================================================================
-- 3. RLS policies for the same service_role surface. A table GRANT alone
--    is not sufficient -- every one of these four tables has RLS enabled
--    with policies scoped to the authenticated caller's OWN rows (or none
--    at all for push_subscriptions/push_deliveries, 0053), which would
--    otherwise leave service_role able to see nothing. This repository's
--    own local test harness deliberately does NOT model service_role's
--    hosted-platform RLS bypass (see supabase/tests/harness/roles.sql:
--    "tests never rely on its bypass") -- these explicit, narrowly-scoped
--    policies are what make the Edge Function's access verifiable locally
--    without depending on that platform behavior, and cost nothing extra
--    on the hosted database (redundant with the real bypass there, same
--    "belt and suspenders" reasoning 0053 itself uses for its table-grant
--    REVOKEs being redundant with RLS).
-- =====================================================================
create policy notifications_service_role_select on public.notifications
  for select to service_role using (true);

create policy profiles_service_role_select on public.profiles
  for select to service_role using (true);

create policy push_subscriptions_service_role_select on public.push_subscriptions
  for select to service_role using (true);
create policy push_subscriptions_service_role_delete on public.push_subscriptions
  for delete to service_role using (true);

create policy push_deliveries_service_role_select on public.push_deliveries
  for select to service_role using (true);
create policy push_deliveries_service_role_insert on public.push_deliveries
  for insert to service_role with check (true);
create policy push_deliveries_service_role_update on public.push_deliveries
  for update to service_role using (true) with check (true);

-- =====================================================================
-- 4. dispatch_push_notification(): the trigger function itself. SECURITY
--    DEFINER so it can read vault.decrypted_secrets regardless of who
--    (which role) performed the triggering INSERT -- every lifecycle RPC
--    already runs SECURITY DEFINER as this same owner, so this changes no
--    existing privilege boundary. Takes no arguments (trigger functions
--    never do) and is reachable ONLY as a trigger -- see the explicit
--    REVOKE below and the trigger definition after it.
-- =====================================================================
create or replace function public.dispatch_push_notification() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_secret text;
begin
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'avaria_push_dispatch_url' limit 1;
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'avaria_push_webhook_secret' limit 1;

    if v_url is null or length(trim(v_url)) = 0
       or v_secret is null or length(trim(v_secret)) = 0 then
      -- Fail SAFE: the expected state until Phase 5B completes hosted
      -- Vault configuration (and a valid, deliberate "Push dispatch is
      -- turned off" state afterward, if ever needed again). No HTTP
      -- request, no error -- the notification insert must succeed exactly
      -- as if this trigger did not exist.
      return new;
    end if;

    -- Fire-and-forget: pg_net queues the request asynchronously and
    -- returns immediately (a bigint request id, deliberately discarded
    -- via `perform`) -- incident lifecycle success can never depend on
    -- the Edge Function actually being reachable. No retry/backoff here
    -- by design (v1.5 scope) -- a failed delivery attempt is recorded by
    -- the Edge Function itself (push_deliveries.status = 'failed') for a
    -- possible future retry feature, not handled here.
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('notification_id', new.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-avaria-push-secret', v_secret
      ),
      timeout_milliseconds := 3000
    );
  exception
    when others then
      -- Never fails the surrounding transaction -- see this migration's
      -- header comment and section 11 of the Phase 5A implementation
      -- notes. Logged for operator visibility only; sqlerrm never
      -- contains v_secret (only Postgres/pg_net's own error text).
      raise warning 'dispatch_push_notification: dispatch attempt failed for notification %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

comment on function public.dispatch_push_notification() is
  'AFTER INSERT ON notifications trigger target. Reads avaria_push_dispatch_url/avaria_push_webhook_secret from Vault at call time and fires an async pg_net POST carrying only {"notification_id": ...} -- never notifications.text or any other operational field. Fails safe (no HTTP call, no error) when either Vault entry is missing/blank. Never reachable except as this trigger -- see the REVOKE below.';

revoke execute on function public.dispatch_push_notification() from public, anon, authenticated;

-- =====================================================================
-- 5. The trigger. WHEN filters at the database boundary so a routine
--    'update'-category row for incident_updated/incident_closed/
--    incident_cancelled (and the 'update'-category half of
--    incident_reopened's broadcast) never invokes this function at all --
--    only actually-qualifying rows do. The Edge Function re-checks this
--    exact same policy independently as defense in depth (it must never
--    trust that only qualifying rows can reach it, e.g. if this trigger
--    is ever manually re-created without the WHEN clause).
-- =====================================================================
create trigger trg_notifications_push_dispatch
  after insert on public.notifications
  for each row
  when (
    new.category = 'action_required'
    or (new.category = 'update' and new.type = 'incident_opened')
  )
  execute function public.dispatch_push_notification();

commit;
