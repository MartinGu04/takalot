# Database security verification suite

Repeatable, local verification of the authorization rules that the
migrations enforce — RLS policies, SECURITY DEFINER RPC checks, and grant
boundaries. These tests run against a **real local PostgreSQL 16** with a
minimal `auth` schema stub (mirroring the parts of Supabase Auth the
migrations touch: `auth.users`, `auth.identities`, `auth.uid()`), the
`anon` / `authenticated` / `service_role` roles, and hosted-like default
function ACLs — so what passes here exercises the same objects, policies
and grants the hosted database runs.

They are **never** run against the hosted database and touch no real data.

## Layout

- `harness/roles.sql` — idempotent creation of the Supabase client roles
  (cluster-level; run once per cluster).
- `harness/prelude.sql` — per-database setup applied **before** the
  migration chain: hosted-like schema grants + default ACLs, and the
  `auth` stub.
- `harness/pg_net_stub/` — a LOCAL TEST DOUBLE for Supabase's real `pg_net`
  extension (not installable outside the hosted Supabase Postgres image).
  `run.sh` installs it as an actual Postgres extension named `pg_net`
  before the migration chain runs, so migration 0054's own
  `create extension if not exists pg_net;` and its `net.http_post(...)`
  call run completely unmodified. Requests are recorded in
  `net.http_request_queue` instead of ever performing a real HTTP call —
  see that directory's `pg_net--0.1.sql` for exactly what is/isn't
  reproduced. Never installed anywhere outside this local/CI verification
  flow.
- `harness/push_dispatch_stub.sql` — a LOCAL TEST DOUBLE for Supabase
  Vault (the `vault` schema), applied **before** the migration chain
  alongside `prelude.sql`. Real Vault ships pre-installed on every hosted
  Supabase project (migrations only ever read/write it, never create it);
  this stub reproduces `vault.decrypted_secrets` and `vault.create_secret`
  with NO real encryption — it must never hold anything resembling an
  actual secret.
- `deactivated_user_enforcement.sql` — negative tests proving a
  DEACTIVATED user is blocked on every path hardened in 0011 (accept a
  handover, add a correction as a past author, read notifications, mark
  notifications read), plus control cases proving the same operations
  succeed for active users.

Each test file uses a temporary `results` table and finishes with a
single `ALL n CHECKS PASS` / `k FAILURES OF n` summary row, then rolls
back — the database is left unchanged.

## Running

Requires local PostgreSQL 16 with superuser access (`sudo -u postgres`).

```sh
./supabase/tests/run.sh
```

The runner drops and recreates a scratch database (`takalot_migtest`),
applies the harness, applies every migration in `supabase/migrations/` in
order with `ON_ERROR_STOP`, then executes each test file and fails on the
first failing suite.
