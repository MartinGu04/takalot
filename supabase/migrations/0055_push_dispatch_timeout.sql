-- AVARIA v1.5.0 -- Phase 5B hotfix: pg_net dispatch timeout was too
-- aggressive for real hosted latency.
--
-- The first real hosted smoke test of migration 0054's dispatch path
-- (Vault -> pg_net -> send-push-notification -> webhook-auth -> DB) showed
-- the 3-second `timeout_milliseconds` pg_net was given consistently timed
-- out ("Timeout of 3000 ms reached.", status_code null) against real
-- Supabase Edge Function cold-start/startup latency, while the identical
-- request with 15000ms succeeded end-to-end (status_code 200, {"result":
-- "not_found"} for a fabricated notification id -- i.e. webhook auth and
-- the Edge Function's own DB access already worked correctly; only the
-- timeout budget was wrong).
--
-- This migration ONLY widens that one timeout value, from 3000 to 15000
-- milliseconds, via `create or replace function` -- which keeps the
-- function's OID stable, so every grant/revoke and the
-- `comment on function` migration 0054 already applied stay attached
-- automatically and are NOT restated here. Nothing else about
-- dispatch_push_notification() changes: same trigger policy (the
-- trg_notifications_push_dispatch WHEN clause is untouched, since this
-- migration never touches the trigger object itself), same two Vault
-- entry names, same minimal {"notification_id": ...} request body, same
-- x-avaria-push-secret header, same SECURITY DEFINER / search_path =
-- public, same fail-safe exception handling (missing/blank Vault config,
-- or any other unexpected runtime error, still returns NEW without ever
-- failing the notification insert), same "no retry/backoff" scope. This
-- is a pure constant-value correction, not a behavior change.
--
-- Migration 0054 is immutable (already applied to hosted Supabase) and is
-- deliberately NOT edited -- this is the next sequential migration, exactly
-- like 0043/0044 or 0053/0054's own predecessors handled a later,
-- already-applied correction.

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
    --
    -- timeout_milliseconds: 15000 (was 3000 in migration 0054) -- see this
    -- migration's header comment. This bounds only how long pg_net will
    -- wait for the Edge Function's HTTP response before giving up; it is
    -- still a strictly bounded, non-retried, best-effort attempt -- never
    -- retry/backoff, and still fully decoupled from the surrounding
    -- transaction (the exception handler below still guarantees a
    -- pg_net-layer failure, including this exact timeout, can never fail
    -- the notification insert).
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('notification_id', new.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-avaria-push-secret', v_secret
      ),
      timeout_milliseconds := 15000
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
