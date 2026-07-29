#!/usr/bin/env bash
# Real two-session PostgreSQL verification for migration 0024 reference locks.
# Destructive only to one PID-scoped local scratch database. Never connects to
# hosted Supabase. Each holder transaction signals readiness with a transaction-
# scoped advisory lock after it has acquired the reference-data row lock.
set -euo pipefail
cd "$(dirname "$0")/../.."

PSQL=(sudo -u postgres psql)
DB="takalot_ref_concurrency_$$"
TMP_DIR="$(mktemp -d)"
HOLDER_PID=""

cleanup() {
  for job in $(jobs -pr); do
    kill "$job" >/dev/null 2>&1 || true
    wait "$job" >/dev/null 2>&1 || true
  done
  "${PSQL[@]}" -d postgres -c "drop database if exists ${DB};" >/dev/null 2>&1 || true
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

wait_for_signal() {
  local signal="$1"
  local held
  for _ in $(seq 1 50); do
    held="$("${PSQL[@]}" -d "$DB" -At -c "
      select exists (
        select 1 from pg_locks
        where locktype = 'advisory'
          and granted
          and classid = 240024
          and objid = ${signal}
      );
    ")"
    if [[ "$held" == "t" ]]; then
      return
    fi
    sleep 0.1
  done
  fail "holder session never signalled lock acquisition (${signal})"
}

wait_for_holder() {
  local output="$1"
  if ! wait "$HOLDER_PID"; then
    cat "$output" >&2
    fail "holder PostgreSQL session failed"
  fi
  HOLDER_PID=""
}

elapsed_ms_since() {
  local started_ns="$1"
  local finished_ns
  finished_ns="$(date +%s%N)"
  echo $(((finished_ns - started_ns) / 1000000))
}

incident_insert_sql() {
  local incident_id="$1"
  local number="$2"
  local system_id="$3"
  local location_id="$4"
  printf "%s" "
    insert into public.incidents (
      id, number, system_id, location_id, description, severity, status,
      operational_impact, owner_user_id, discovered_at, created_by, updated_by,
      next_update_due, version
    ) values (
      '${incident_id}', '${number}', '${system_id}', '${location_id}',
      'Concurrent reference-data test', 'medium', 'new', 'Test impact',
      '00000000-0000-0000-0000-00000000c002', now(),
      '00000000-0000-0000-0000-00000000c001',
      '00000000-0000-0000-0000-00000000c001',
      now() + interval '4 hours', 1
    );
  "
}

start_incident_holder() {
  local incident_id="$1"
  local number="$2"
  local system_id="$3"
  local location_id="$4"
  local signal="$5"
  local output="$6"
  local insert_sql
  insert_sql="$(incident_insert_sql "$incident_id" "$number" "$system_id" "$location_id")"
  "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -qAt -c "
    begin;
    set local statement_timeout = '10s';
    ${insert_sql}
    select pg_advisory_xact_lock(240024, ${signal});
    select pg_sleep(2);
    commit;
  " >"$output" 2>&1 &
  HOLDER_PID=$!
  wait_for_signal "$signal"
}

start_deactivation_holder() {
  local system_id="$1"
  local signal="$2"
  local output="$3"
  "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -qAt -c "
    begin;
    set local statement_timeout = '10s';
    select set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', '00000000-0000-0000-0000-00000000c001',
        'role', 'authenticated'
      )::text,
      true
    );
    set local role authenticated;
    select public.set_system_active('${system_id}', false);
    select pg_advisory_xact_lock(240024, ${signal});
    select pg_sleep(2);
    commit;
  " >"$output" 2>&1 &
  HOLDER_PID=$!
  wait_for_signal "$signal"
}

start_delete_holder() {
  local system_id="$1"
  local signal="$2"
  local output="$3"
  "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -qAt -c "
    begin;
    set local statement_timeout = '10s';
    select set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', '00000000-0000-0000-0000-00000000c001',
        'role', 'authenticated'
      )::text,
      true
    );
    set local role authenticated;
    select public.delete_system('${system_id}');
    select pg_advisory_xact_lock(240024, ${signal});
    select pg_sleep(2);
    commit;
  " >"$output" 2>&1 &
  HOLDER_PID=$!
  wait_for_signal "$signal"
}

expect_controlled_insert_failure() {
  local incident_id="$1"
  local number="$2"
  local system_id="$3"
  local location_id="$4"
  local output="$5"
  local insert_sql
  local started_ns
  local elapsed
  insert_sql="$(incident_insert_sql "$incident_id" "$number" "$system_id" "$location_id")"
  started_ns="$(date +%s%N)"
  if "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -c "
    set statement_timeout = '10s';
    ${insert_sql}
  " >"$output" 2>&1; then
    fail "incident insert unexpectedly succeeded against an inactive/deleted system"
  fi
  elapsed="$(elapsed_ms_since "$started_ns")"
  ((elapsed >= 1000)) || fail "incident insert did not wait for the competing row lock (${elapsed}ms)"
  grep -q "validation: יש לבחור מערכת / עמדה פעילה" "$output" \
    || fail "incident insert did not return the controlled active-system validation error"
}

"${PSQL[@]}" -d postgres -f supabase/tests/harness/roles.sql >/dev/null
"${PSQL[@]}" -d postgres -v ON_ERROR_STOP=1 -c "create database ${DB} owner postgres;" >/dev/null
"${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/harness/prelude.sql >/dev/null
for migration in supabase/migrations/*.sql; do
  "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$migration"
done

"${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -q -c "
  insert into auth.users (id, email, email_confirmed_at) values
    ('00000000-0000-0000-0000-00000000c001', 'reference-admin@test', now()),
    ('00000000-0000-0000-0000-00000000c002', 'reference-owner@test', now());
  insert into public.profiles (id, full_name, role, active) values
    ('00000000-0000-0000-0000-00000000c001', 'Reference Admin', 'system_admin', true),
    ('00000000-0000-0000-0000-00000000c002', 'Reference Owner', 'shift_supervisor', true);
  insert into public.systems (id, name, archived, display_order, created_by) values
    ('00000000-0000-0000-0000-00000000c101', 'Concurrency system A', false, 1, '00000000-0000-0000-0000-00000000c001'),
    ('00000000-0000-0000-0000-00000000c102', 'Concurrency system B', false, 2, '00000000-0000-0000-0000-00000000c001'),
    ('00000000-0000-0000-0000-00000000c103', 'Concurrency system C', false, 3, '00000000-0000-0000-0000-00000000c001'),
    ('00000000-0000-0000-0000-00000000c104', 'Concurrency system D', false, 4, '00000000-0000-0000-0000-00000000c001');
  insert into public.locations (id, name, archived, display_order, created_by) values
    ('00000000-0000-0000-0000-00000000c201', 'Concurrency location A', false, 1, '00000000-0000-0000-0000-00000000c001'),
    ('00000000-0000-0000-0000-00000000c202', 'Concurrency location B', false, 2, '00000000-0000-0000-0000-00000000c001'),
    ('00000000-0000-0000-0000-00000000c203', 'Concurrency location C', false, 3, '00000000-0000-0000-0000-00000000c001'),
    ('00000000-0000-0000-0000-00000000c204', 'Concurrency location D', false, 4, '00000000-0000-0000-0000-00000000c001');
"

# Incident wins, then deactivation waits for its FOR SHARE lock and succeeds
# only after the incident commits.
OUTPUT_A="$TMP_DIR/create-wins-deactivate-holder.txt"
start_incident_holder \
  '00000000-0000-0000-0000-00000000c301' 'ATOMIC-C1' \
  '00000000-0000-0000-0000-00000000c101' '00000000-0000-0000-0000-00000000c201' \
  1 "$OUTPUT_A"
STARTED_NS="$(date +%s%N)"
"${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -qAt -c "
  begin;
  set local statement_timeout = '10s';
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-00000000c001', 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
  select public.set_system_active('00000000-0000-0000-0000-00000000c101', false);
  commit;
" >"$TMP_DIR/create-wins-deactivate-contender.txt" 2>&1
ELAPSED="$(elapsed_ms_since "$STARTED_NS")"
((ELAPSED >= 1000)) || fail "deactivation did not wait for incident creation (${ELAPSED}ms)"
wait_for_holder "$OUTPUT_A"
RESULT="$("${PSQL[@]}" -d "$DB" -At -c "
  select exists (
    select 1 from public.incidents where id = '00000000-0000-0000-0000-00000000c301'
  ) and exists (
    select 1 from public.systems
    where id = '00000000-0000-0000-0000-00000000c101' and archived
  );
")"
[[ "$RESULT" == "t" ]] || fail "create-wins/deactivate outcome was incorrect"
echo "PASS: incident creation serializes before deactivation"

# Deactivation wins first; the waiting incident must receive the controlled
# active-reference validation error and must not be inserted.
OUTPUT_B="$TMP_DIR/deactivate-wins-holder.txt"
start_deactivation_holder '00000000-0000-0000-0000-00000000c102' 2 "$OUTPUT_B"
expect_controlled_insert_failure \
  '00000000-0000-0000-0000-00000000c302' 'ATOMIC-C2' \
  '00000000-0000-0000-0000-00000000c102' '00000000-0000-0000-0000-00000000c202' \
  "$TMP_DIR/deactivate-wins-insert.txt"
wait_for_holder "$OUTPUT_B"
echo "PASS: deactivation serializes before incident creation with a controlled error"

# Incident wins, then safe deletion waits, observes the committed reference,
# and archives instead of physically deleting.
OUTPUT_C="$TMP_DIR/create-wins-delete-holder.txt"
start_incident_holder \
  '00000000-0000-0000-0000-00000000c303' 'ATOMIC-C3' \
  '00000000-0000-0000-0000-00000000c103' '00000000-0000-0000-0000-00000000c203' \
  3 "$OUTPUT_C"
STARTED_NS="$(date +%s%N)"
"${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -qAt -c "
  begin;
  set local statement_timeout = '10s';
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', '00000000-0000-0000-0000-00000000c001', 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
  select public.delete_system('00000000-0000-0000-0000-00000000c103');
  commit;
" >"$TMP_DIR/create-wins-delete-contender.txt" 2>&1
ELAPSED="$(elapsed_ms_since "$STARTED_NS")"
((ELAPSED >= 1000)) || fail "safe deletion did not wait for incident creation (${ELAPSED}ms)"
wait_for_holder "$OUTPUT_C"
grep -q "^archived$" "$TMP_DIR/create-wins-delete-contender.txt" \
  || fail "safe deletion did not report the archived outcome"
RESULT="$("${PSQL[@]}" -d "$DB" -At -c "
  select exists (
    select 1 from public.systems
    where id = '00000000-0000-0000-0000-00000000c103' and archived
  );
")"
[[ "$RESULT" == "t" ]] || fail "create-wins/delete did not preserve the referenced system"
echo "PASS: incident creation forces later safe deletion to archive"

# Physical deletion wins first; the waiting insert must fail in the trigger
# with the controlled validation error, never at the foreign-key layer.
OUTPUT_D="$TMP_DIR/delete-wins-holder.txt"
start_delete_holder '00000000-0000-0000-0000-00000000c104' 4 "$OUTPUT_D"
expect_controlled_insert_failure \
  '00000000-0000-0000-0000-00000000c304' 'ATOMIC-C4' \
  '00000000-0000-0000-0000-00000000c104' '00000000-0000-0000-0000-00000000c204' \
  "$TMP_DIR/delete-wins-insert.txt"
wait_for_holder "$OUTPUT_D"
grep -q "^deleted$" "$OUTPUT_D" || fail "safe deletion did not physically delete the unused system"
echo "PASS: safe deletion serializes before incident creation with a controlled error"

echo "ALL REFERENCE-DATA CONCURRENCY CHECKS PASS"
