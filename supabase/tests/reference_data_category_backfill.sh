#!/usr/bin/env bash
# Destructive only to one PID-scoped local scratch database. Never connects
# to hosted Supabase. Proves that migration 0041 backfills every system and
# location that existed BEFORE it ran to category = 'other', preserves their
# relative display_order, and never recreates or renumbers their ids -- the
# in-transaction tests in reference_data_categories.sql cannot exercise this
# because they run against a database where 0041 (and its 'other' column
# default) is already applied before any row exists.
set -euo pipefail
cd "$(dirname "$0")/../.."

PSQL=(sudo -u postgres psql)
MIGRATION="supabase/migrations/0041_reference_data_categories.sql"
DB="takalot_ref_category_backfill_$$"

cleanup() {
  "${PSQL[@]}" -d postgres -c "drop database if exists ${DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

"${PSQL[@]}" -d postgres -f supabase/tests/harness/roles.sql >/dev/null
"${PSQL[@]}" -d postgres -v ON_ERROR_STOP=1 -c "create database ${DB} owner postgres;" >/dev/null
"${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/harness/prelude.sql >/dev/null

for migration in supabase/migrations/*.sql; do
  if [[ "$(basename "$migration")" == "$(basename "$MIGRATION")" ]]; then
    break
  fi
  "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$migration"
done

# Pre-existing legacy data: no category column exists yet at this point in
# the migration chain, exactly like real rows created before this feature
# shipped. Deliberately non-contiguous display_order values (gaps/ties) to
# also prove the backfill does not silently renumber or reorder them.
LEGACY_SYSTEM_A="00000000-0000-0000-0000-0000000f0001"
LEGACY_SYSTEM_B="00000000-0000-0000-0000-0000000f0002"
LEGACY_LOCATION_A="00000000-0000-0000-0000-0000000f0011"
LEGACY_LOCATION_B="00000000-0000-0000-0000-0000000f0012"

"${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -c "
  insert into public.systems (id, name, archived, display_order) values
    ('${LEGACY_SYSTEM_A}', 'Legacy Backfill System A', false, 5),
    ('${LEGACY_SYSTEM_B}', 'Legacy Backfill System B', true, 12);
  insert into public.locations (id, name, archived, display_order) values
    ('${LEGACY_LOCATION_A}', 'Legacy Backfill Location A', false, 5),
    ('${LEGACY_LOCATION_B}', 'Legacy Backfill Location B', true, 12);
" >/dev/null

"${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$MIGRATION"

RESULT="$("${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -At -c "
  select
    (select category::text from public.systems where id = '${LEGACY_SYSTEM_A}') = 'other'
    and (select category::text from public.systems where id = '${LEGACY_SYSTEM_B}') = 'other'
    and (select category::text from public.locations where id = '${LEGACY_LOCATION_A}') = 'other'
    and (select category::text from public.locations where id = '${LEGACY_LOCATION_B}') = 'other'
    -- ids and display_order are exactly as before -- no renumbering, no
    -- recreation of any row.
    and (select display_order from public.systems where id = '${LEGACY_SYSTEM_A}') = 5
    and (select display_order from public.systems where id = '${LEGACY_SYSTEM_B}') = 12
    and (select display_order from public.locations where id = '${LEGACY_LOCATION_A}') = 5
    and (select display_order from public.locations where id = '${LEGACY_LOCATION_B}') = 12
    -- relative order (A before B) survives untouched.
    and (
      select array_agg(id order by display_order)
      from public.systems where id in ('${LEGACY_SYSTEM_A}', '${LEGACY_SYSTEM_B}')
    ) = array['${LEGACY_SYSTEM_A}'::uuid, '${LEGACY_SYSTEM_B}'::uuid]
    -- active/inactive state is unchanged.
    and not (select archived from public.systems where id = '${LEGACY_SYSTEM_A}')
    and (select archived from public.systems where id = '${LEGACY_SYSTEM_B}')
    and not (select archived from public.locations where id = '${LEGACY_LOCATION_A}')
    and (select archived from public.locations where id = '${LEGACY_LOCATION_B}')
    -- category is now required (NOT NULL) and backed by an enum type.
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'systems'
        and column_name = 'category' and is_nullable = 'NO' and udt_name = 'system_category'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'locations'
        and column_name = 'category' and is_nullable = 'NO' and udt_name = 'location_category'
    )
;
")"
[[ "$RESULT" == "t" ]] || fail "pre-existing rows were not correctly backfilled to 'other'"
echo "PASS: pre-existing systems/locations backfilled to 'other' with ids, order, and active state preserved"

# A NOT NULL enum column rejects an out-of-range value outright (proves
# "constrained to the permitted values" without relying on any RPC).
if "${PSQL[@]}" -d "$DB" -v ON_ERROR_STOP=1 -c "
  update public.systems set category = 'not_a_real_category' where id = '${LEGACY_SYSTEM_A}';
" >/dev/null 2>&1; then
  fail "an out-of-range category value was unexpectedly accepted"
fi
echo "PASS: category is constrained to the permitted enum values at the column level"

echo "ALL REFERENCE-DATA CATEGORY BACKFILL CHECKS PASS"
