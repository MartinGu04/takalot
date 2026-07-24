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
