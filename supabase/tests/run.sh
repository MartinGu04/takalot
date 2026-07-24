#!/usr/bin/env bash
# Local database security verification: fresh scratch database, harness,
# full migration chain, then every test suite. Fails on the first error or
# the first failing suite. Never touches a hosted database.
set -euo pipefail
cd "$(dirname "$0")/../.."

DB=takalot_migtest
PSQL="sudo -u postgres psql"

$PSQL -f supabase/tests/harness/roles.sql

$PSQL -c "drop database if exists ${DB};"
$PSQL -c "create database ${DB} owner postgres;"
$PSQL -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/harness/prelude.sql

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
