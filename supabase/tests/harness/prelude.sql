-- Per-database harness, applied BEFORE the migration chain.
--
-- 1. Hosted-like privilege baseline: on the Supabase platform, the public
--    schema is usable by the client roles and functions created by
--    postgres get EXECUTE granted to them via default ACLs. Migrations
--    0005-0007 exist precisely to close those broad grants, so the
--    simulation must START from the broad hosted state or the revocation
--    migrations would be verifying nothing.
-- 2. Minimal auth stub: the pieces of Supabase Auth the migrations
--    reference -- auth.users, auth.identities, and auth.uid() reading the
--    request JWT claims exactly like PostgREST sets them.
create extension if not exists pgcrypto;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;

create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  provider text not null,
  identity_data jsonb not null default '{}'::jsonb
);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
