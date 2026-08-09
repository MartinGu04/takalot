-- LOCAL TEST DOUBLE for Supabase's pg_net extension. See pg_net--0.1.control
-- and supabase/tests/README.md. Mirrors the real net.http_post/net.http_get
-- call signatures closely enough for a trigger written against the real
-- extension to run unmodified here -- but instead of performing a real
-- asynchronous HTTP request (pg_net's actual Rust/libcurl background
-- worker, not reproducible outside the hosted Supabase Postgres image),
-- every call is recorded as a row in net.http_request_queue so a test can
-- assert "was net.http_post invoked, with this url/body" without ever
-- reaching the network. Real pg_net also returns a bigint request id and
-- eventually stores a response in its own internal response table; nothing
-- here does that, since migration 0054's trigger never reads a pg_net
-- response (the dispatch is genuinely fire-and-forget).
\echo Use "CREATE EXTENSION pg_net" to load this file. \quit

create table net.http_request_queue (
  id bigint generated always as identity primary key,
  method text not null,
  url text not null,
  headers jsonb not null default '{}'::jsonb,
  body jsonb,
  timeout_milliseconds integer not null default 5000,
  created_at timestamptz not null default now()
);

create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language plpgsql as $$
declare
  v_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, body, timeout_milliseconds)
  returning id into v_id;
  return v_id;
end;
$$;

create function net.http_get(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language plpgsql as $$
declare
  v_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, timeout_milliseconds)
  values ('GET', url, headers, timeout_milliseconds)
  returning id into v_id;
  return v_id;
end;
$$;

-- Real pg_net grants net.http_post/http_get to `postgres` and (on the
-- hosted platform) to `supabase_functions_admin`/service-role-adjacent
-- roles as the platform sees fit -- this local double simply leaves the
-- default PUBLIC EXECUTE new functions get in Postgres, since verifying
-- pg_net's own internal grant model is out of scope for AVARIA's tests
-- (only migration 0054's OWN objects are asserted on).
