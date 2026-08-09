#!/usr/bin/env bash
# Local database security verification: fresh scratch database, harness,
# full migration chain, then every test suite. Fails on the first error or
# the first failing suite. Never touches a hosted database.
set -euo pipefail
cd "$(dirname "$0")/../.."

DB=takalot_migtest
PSQL="sudo -u postgres psql"

# LOCAL TEST DOUBLE for pg_net (see harness/pg_net_stub/) -- installed as a
# real Postgres extension so migration 0054's own
# `create extension if not exists pg_net;` runs unmodified. NEVER installed
# outside this scratch/CI verification flow; the real hosted Supabase
# Postgres image ships the genuine pg_net extension already.
PG_EXTDIR="$(pg_config --sharedir)/extension"
sudo install -m 644 supabase/tests/harness/pg_net_stub/pg_net.control "$PG_EXTDIR/"
sudo install -m 644 supabase/tests/harness/pg_net_stub/pg_net--0.1.sql "$PG_EXTDIR/"

$PSQL -f supabase/tests/harness/roles.sql

$PSQL -c "drop database if exists ${DB};"
$PSQL -c "create database ${DB} owner postgres;"
$PSQL -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/harness/prelude.sql
$PSQL -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/harness/push_dispatch_stub.sql

for f in supabase/migrations/*.sql; do
  echo "== applying $f"
  $PSQL -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done

fail=0
for f in supabase/tests/*.sql; do
  echo "== running $f"
  out=$($PSQL -d "$DB" -v ON_ERROR_STOP=1 -f "$f")
  echo "$out" | tail -30
  if ! echo "$out" | grep -q "ALL .* CHECKS PASS"; then
    echo "!! SUITE FAILED: $f"
    fail=1
  fi
done

exit $fail
