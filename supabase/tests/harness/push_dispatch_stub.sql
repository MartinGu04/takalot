-- LOCAL TEST DOUBLE for Supabase Vault, applied BEFORE the migration chain
-- (same "platform primitive stub" pattern as this harness's own `auth`
-- schema in prelude.sql). Real Supabase Vault (the `vault` schema,
-- `vault.secrets`/`vault.decrypted_secrets`, pgsodium-backed encryption at
-- rest) ships pre-installed on every hosted Supabase project -- migrations
-- never create it themselves, they only read/write it, exactly like
-- migration 0054's dispatch_push_notification() trigger function does. This
-- stub reproduces just enough of that surface for local verification:
-- `vault.decrypted_secrets` as a plain passthrough view (NO real encryption
-- -- this must never hold anything resembling a real secret) and
-- `vault.create_secret` with the real function's own signature, so test
-- fixture setup reads the same as real Vault usage would.
--
-- pg_net's `net` schema is NOT created here -- see
-- supabase/tests/harness/pg_net_stub/, installed as a real (local-only)
-- Postgres extension and enabled by migration 0054's own
-- `create extension if not exists pg_net;`, exactly as it would run against
-- the real hosted extension.
create schema if not exists vault;

create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Real Vault's view additionally exposes key_id/nonce/the still-encrypted
-- `secret` column; this stub never encrypts anything (there is nothing
-- real to protect locally), so `decrypted_secret` is simply `secret`.
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at
  from vault.secrets;

create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into vault.secrets (name, description, secret)
  values (new_name, coalesce(new_description, ''), new_secret)
  returning id into v_id;
  return v_id;
end;
$$;
