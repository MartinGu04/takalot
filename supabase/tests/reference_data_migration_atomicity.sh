#!/usr/bin/env bash
# Destructive only to two PID-scoped local scratch databases. Never connects
# to hosted Supabase. Verifies that migration 0024 rolls back completely when
# either its duplicate preflight or a deliberately injected late statement
# fails under the repository's normal psql -f + ON_ERROR_STOP runner.
set -euo pipefail
cd "$(dirname "$0")/../.."

PSQL=(sudo -u postgres psql)
MIGRATION="supabase/migrations/0024_reference_data_management.sql"
DUPLICATE_DB="takalot_ref_atomic_duplicate_$$"
LATE_DB="takalot_ref_atomic_late_$$"
TMP_DIR="$(mktemp -d)"

cleanup() {
  "${PSQL[@]}" -d postgres -c "drop database if exists ${DUPLICATE_DB};" >/dev/null 2>&1 || true
  "${PSQL[@]}" -d postgres -c "drop database if exists ${LATE_DB};" >/dev/null 2>&1 || true
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

initialize_through_0023() {
  local database="$1"
  "${PSQL[@]}" -d postgres -v ON_ERROR_STOP=1 -c "create database ${database} owner postgres;" >/dev/null
  "${PSQL[@]}" -d "$database" -v ON_ERROR_STOP=1 -f supabase/tests/harness/prelude.sql >/dev/null
  for migration in supabase/migrations/*.sql; do
    if [[ "$(basename "$migration")" == "0024_reference_data_management.sql" ]]; then
      break
    fi
    "${PSQL[@]}" -d "$database" -v ON_ERROR_STOP=1 -q -f "$migration"
  done
}

assert_no_0024_artifacts() {
  local database="$1"
  local result
  result="$("${PSQL[@]}" -d "$database" -v ON_ERROR_STOP=1 -At -c "
    select
      not exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name in ('systems', 'locations')
          and column_name = 'display_order'
      )
      and to_regclass('public.systems_name_normalized_unique') is null
      and to_regclass('public.locations_name_normalized_unique') is null
      and not exists (
        select 1 from pg_constraint
        where conname in ('systems_display_order_positive', 'locations_display_order_positive')
      )
      and not exists (
        select 1 from pg_trigger
        where tgrelid = 'public.incidents'::regclass
          and tgname = 'trg_incidents_active_reference_data'
          and not tgisinternal
      )
      and not exists (
        select 1
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname in (
            'require_reference_data_admin',
            'valid_reference_data_name',
            'assert_incident_reference_data_active',
            'create_system', 'rename_system', 'set_system_active', 'move_system', 'delete_system',
            'create_location', 'rename_location', 'set_location_active', 'move_location', 'delete_location'
          )
      )
      and (
        select count(*) = 4
        from pg_policies
        where schemaname = 'public'
          and policyname in (
            'systems_admin_insert', 'systems_admin_update',
            'locations_admin_insert', 'locations_admin_update'
          )
      )
      and has_table_privilege('authenticated', 'public.systems', 'INSERT')
      and has_table_privilege('authenticated', 'public.systems', 'UPDATE')
      and has_table_privilege('authenticated', 'public.systems', 'DELETE')
      and has_table_privilege('authenticated', 'public.locations', 'INSERT')
      and has_table_privilege('authenticated', 'public.locations', 'UPDATE')
      and has_table_privilege('authenticated', 'public.locations', 'DELETE');
  ")"
  [[ "$result" == "t" ]] || fail "0024 artifacts remained in ${database}"
}

"${PSQL[@]}" -d postgres -f supabase/tests/harness/roles.sql >/dev/null

# 1. Duplicate preflight failure: the two legacy rows and the complete
# migration-0023 schema/privilege state must remain unchanged.
initialize_through_0023 "$DUPLICATE_DB"
"${PSQL[@]}" -d "$DUPLICATE_DB" -v ON_ERROR_STOP=1 -c "
  insert into public.systems (name)
  values ('Atomic Duplicate'), ('  atomic duplicate  ');
" >/dev/null

DUPLICATE_OUTPUT="$TMP_DIR/duplicate-output.txt"
if "${PSQL[@]}" -d "$DUPLICATE_DB" -v ON_ERROR_STOP=1 -f "$MIGRATION" >"$DUPLICATE_OUTPUT" 2>&1; then
  fail "duplicate preflight unexpectedly succeeded"
fi
grep -q "migration_preflight: normalized reference-data duplicates detected" "$DUPLICATE_OUTPUT" \
  || fail "duplicate preflight did not return its controlled diagnostic"
assert_no_0024_artifacts "$DUPLICATE_DB"
DUPLICATE_ROWS="$("${PSQL[@]}" -d "$DUPLICATE_DB" -At -c "
  select count(*) from public.systems
  where lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = 'atomic duplicate';
")"
[[ "$DUPLICATE_ROWS" == "2" ]] || fail "duplicate preflight changed legacy duplicate rows"
echo "PASS: duplicate preflight rolled the complete migration back"

# 2. Late failure: create a temporary copy with a nonexistent function call
# immediately before COMMIT. Every earlier 0024 statement must roll back.
initialize_through_0023 "$LATE_DB"
LATE_COPY="$TMP_DIR/0024_reference_data_management_late_failure.sql"
awk '
  /^commit;[[:space:]]*$/ && !injected {
    print "select public.__reference_data_atomicity_late_failure__();"
    injected = 1
  }
  { print }
  END { if (!injected) exit 42 }
' "$MIGRATION" >"$LATE_COPY" || fail "could not build the temporary late-failure migration"

LATE_OUTPUT="$TMP_DIR/late-output.txt"
if "${PSQL[@]}" -d "$LATE_DB" -v ON_ERROR_STOP=1 -f "$LATE_COPY" >"$LATE_OUTPUT" 2>&1; then
  fail "deliberately introduced late failure unexpectedly succeeded"
fi
grep -q "__reference_data_atomicity_late_failure__" "$LATE_OUTPUT" \
  || fail "temporary migration did not reach the deliberate late failure"
assert_no_0024_artifacts "$LATE_DB"
echo "PASS: late statement failure rolled the complete migration back"
echo "ALL REFERENCE-DATA MIGRATION ATOMICITY CHECKS PASS"
