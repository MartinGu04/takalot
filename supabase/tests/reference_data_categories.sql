-- Focused verification for migration 0041_reference_data_categories.sql.
-- Runs only against the local scratch database created by tests/run.sh.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000004101', 'cat-admin@test', now()),
  ('00000000-0000-0000-0000-000000004102', 'cat-supervisor@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000004101', 'Category Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-000000004102', 'Category Supervisor', 'shift_supervisor', true);

-- One system/location per category, plus a second "platforms" system used
-- for reorder/cross-category tests.
insert into systems (id, name, category, display_order) values
  ('00000000-0000-0000-0000-000000004111', 'Cat Sys Platforms A', 'platforms', 1),
  ('00000000-0000-0000-0000-000000004112', 'Cat Sys Platforms B', 'platforms', 2),
  ('00000000-0000-0000-0000-000000004113', 'Cat Sys Station', 'station_systems', 1),
  ('00000000-0000-0000-0000-000000004114', 'Cat Sys Computing', 'computing', 1),
  ('00000000-0000-0000-0000-000000004115', 'Cat Sys Infra', 'infrastructure', 1),
  ('00000000-0000-0000-0000-000000004116', 'Cat Sys Other', 'other', 1);

insert into locations (id, name, category, display_order) values
  ('00000000-0000-0000-0000-000000004121', 'Cat Loc Unit A', 'unit_internal', 1),
  ('00000000-0000-0000-0000-000000004122', 'Cat Loc Unit B', 'unit_internal', 2),
  ('00000000-0000-0000-0000-000000004123', 'Cat Loc Field', 'field_side', 1),
  ('00000000-0000-0000-0000-000000004124', 'Cat Loc External Base', 'external_bases', 1),
  ('00000000-0000-0000-0000-000000004125', 'Cat Loc External Site', 'external_sites', 1),
  ('00000000-0000-0000-0000-000000004126', 'Cat Loc Other', 'other', 1);

insert into incidents (
  id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by,
  next_update_due, version
) values (
  '00000000-0000-0000-0000-000000004131', 'T-041',
  '00000000-0000-0000-0000-000000004111',
  '00000000-0000-0000-0000-000000004121',
  'Category migration history', 'medium', 'in_progress', 'Impact',
  '00000000-0000-0000-0000-000000004102', now(),
  '00000000-0000-0000-0000-000000004101',
  '00000000-0000-0000-0000-000000004101',
  now() + interval '4 hours', 1
);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p_user_id uuid) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', p_user_id::text, false),
         set_config(
           'request.jwt.claims',
           json_build_object('sub', p_user_id, 'role', 'authenticated')::text,
           false
         );
$$;

create or replace function pg_temp.check_result(
  p_test text,
  p_ok boolean,
  p_detail text default ''
) returns void
language sql as $$
  insert into results (test, result, detail)
  values (p_test, case when p_ok then 'PASS' else 'FAIL' end, coalesce(p_detail, ''));
$$;
grant execute on function pg_temp.check_result(text, boolean, text) to authenticated;

-- ===== Column shape: NOT NULL, enum-constrained, default 'other' for a
-- direct (non-RPC) insert -- the mechanism that backfills every pre-existing
-- row. reference_data_category_backfill.sh separately proves this against
-- rows that existed BEFORE migration 0041 was applied. =====
select pg_temp.check_result(
  'systems.category is non-null with an enum type',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'systems'
      and column_name = 'category' and is_nullable = 'NO' and udt_name = 'system_category'
  )
);

select pg_temp.check_result(
  'locations.category is non-null with an enum type',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'locations'
      and column_name = 'category' and is_nullable = 'NO' and udt_name = 'location_category'
  )
);

with ins as (
  insert into systems (name, display_order) values ('Direct Insert No Category', 999) returning category
)
select pg_temp.check_result(
  'a direct system insert with no explicit category defaults to other',
  (select category from ins) = 'other'
);

with ins as (
  insert into locations (name, display_order) values ('Direct Insert No Category', 999) returning category
)
select pg_temp.check_result(
  'a direct location insert with no explicit category defaults to other',
  (select category from ins) = 'other'
);

-- ===== Grants for the new category-change RPCs mirror every other
-- reference-data RPC (authenticated only; anon/PUBLIC excluded) =====
select pg_temp.check_result(
  'authenticated can execute both set_*_category RPCs',
  has_function_privilege('authenticated', 'public.set_system_category(uuid,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_location_category(uuid,text)', 'EXECUTE')
);

select pg_temp.check_result(
  'anon cannot execute either set_*_category RPC',
  not has_function_privilege('anon', 'public.set_system_category(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_location_category(uuid,text)', 'EXECUTE')
);

select pg_temp.check_result(
  'PUBLIC has no set_*_category execute grants',
  not exists (
    select 1
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace,
         aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
    where namespace.nspname = 'public'
      and procedure.proname in ('set_system_category', 'set_location_category')
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  )
);

-- ===== create_system/create_location: every allowed category is accepted,
-- an invalid or missing category is a controlled validation error =====
-- ===== Reordering is scoped to one category =====
-- Runs BEFORE the create_system/create_location category-acceptance loop
-- below: that loop deliberately adds one new record to every category
-- (including 'platforms' and 'computing', used here), which would change
-- the exact category membership counts this block depends on.
do $$
declare
  v_other_order integer;
  v_computing_order integer;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004101');
  set local role authenticated;

  select display_order into v_other_order from systems where id = '00000000-0000-0000-0000-000000004116';
  select display_order into v_computing_order from systems where id = '00000000-0000-0000-0000-000000004114';

  perform reorder_systems(array[
    '00000000-0000-0000-0000-000000004112',
    '00000000-0000-0000-0000-000000004111'
  ]::uuid[]);
  perform pg_temp.check_result(
    'reordering within one category succeeds',
    (select display_order from systems where id = '00000000-0000-0000-0000-000000004112') <
    (select display_order from systems where id = '00000000-0000-0000-0000-000000004111')
  );

  perform pg_temp.check_result(
    'reordering one category leaves another category''s display_order untouched',
    (select display_order from systems where id = '00000000-0000-0000-0000-000000004116') = v_other_order
    and (select display_order from systems where id = '00000000-0000-0000-0000-000000004114') = v_computing_order
  );

  begin
    perform reorder_systems(array[
      '00000000-0000-0000-0000-000000004111',
      '00000000-0000-0000-0000-000000004112',
      '00000000-0000-0000-0000-000000004114'
    ]::uuid[]);
    perform pg_temp.check_result('cross-category reorder attempt is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'cross-category reorder attempt is rejected', sqlerrm like 'validation:%', sqlerrm
    );
  end;

  perform pg_temp.check_result(
    'a rejected cross-category reorder cannot smuggle a category change',
    (select category from systems where id = '00000000-0000-0000-0000-000000004114') = 'computing'
    and (select display_order from systems where id = '00000000-0000-0000-0000-000000004114') = v_computing_order
  );

  reset role;
end;
$$;

do $$
declare
  v_system systems;
  v_location locations;
  v_category text;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004101');
  set local role authenticated;

  foreach v_category in array array['platforms','station_systems','computing','infrastructure','other']
  loop
    select * into v_system from create_system('New ' || v_category || ' system', v_category);
    perform pg_temp.check_result(
      format('create_system accepts allowed category %s', v_category),
      v_system.category::text = v_category,
      row_to_json(v_system)::text
    );
  end loop;

  foreach v_category in array array['unit_internal','field_side','external_bases','external_sites','other']
  loop
    select * into v_location from create_location('New ' || v_category || ' location', v_category);
    perform pg_temp.check_result(
      format('create_location accepts allowed category %s', v_category),
      v_location.category::text = v_category,
      row_to_json(v_location)::text
    );
  end loop;

  begin
    perform create_system('Bad category system', 'not_a_real_category');
    perform pg_temp.check_result('create_system rejects an invalid category', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('create_system rejects an invalid category', sqlerrm like 'validation:%', sqlerrm);
  end;

  begin
    perform create_location('Bad category location', 'not_a_real_category');
    perform pg_temp.check_result('create_location rejects an invalid category', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('create_location rejects an invalid category', sqlerrm like 'validation:%', sqlerrm);
  end;

  begin
    perform create_system('Missing category system', null);
    perform pg_temp.check_result('create_system rejects a missing category', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('create_system rejects a missing category', sqlerrm like 'validation:%', sqlerrm);
  end;

  begin
    perform create_location('Missing category location', null);
    perform pg_temp.check_result('create_location rejects a missing category', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('create_location rejects a missing category', sqlerrm like 'validation:%', sqlerrm);
  end;

  reset role;
end;
$$;

-- ===== Category change: transactional move, append-to-end, id/incident
-- references preserved, source category gaps normalized, no-op on same
-- category, and authorization enforced =====
do $$
declare
  v_before_category text;
  v_after public.systems;
  v_max_infra_order integer;
  v_remaining_platform_orders integer[];
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004102');
  set local role authenticated;
  begin
    perform set_system_category('00000000-0000-0000-0000-000000004111', 'infrastructure');
    perform pg_temp.check_result('non-admin category change is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('non-admin category change is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000004101');
  set local role authenticated;

  select category::text into v_before_category
  from systems where id = '00000000-0000-0000-0000-000000004111';
  select coalesce(max(display_order), 0) into v_max_infra_order
  from systems where category = 'infrastructure';

  select * into v_after from set_system_category('00000000-0000-0000-0000-000000004111', 'infrastructure');
  perform pg_temp.check_result(
    'changing category moves the record and appends it to the destination''s end',
    v_after.id = '00000000-0000-0000-0000-000000004111'
      and v_after.category = 'infrastructure'
      and v_after.display_order = v_max_infra_order + 1,
    row_to_json(v_after)::text
  );

  perform pg_temp.check_result(
    'changing category preserves the record id and existing incident references',
    exists (
      select 1 from incidents
      where id = '00000000-0000-0000-0000-000000004131'
        and system_id = '00000000-0000-0000-0000-000000004111'
    )
  );

  select array_agg(display_order order by display_order) into v_remaining_platform_orders
  from systems where category = 'platforms';
  perform pg_temp.check_result(
    'the source category''s remaining records keep a contiguous, deterministic order',
    v_remaining_platform_orders = (
      select array_agg(expected order by expected)
      from generate_series(1, coalesce(array_length(v_remaining_platform_orders, 1), 0)) as expected
    ),
    v_remaining_platform_orders::text
  );

  perform pg_temp.check_result(
    'category change is audited',
    exists (
      select 1 from audit_logs
      where action = 'system_category_changed'
        and entity_id = '00000000-0000-0000-0000-000000004111'
    )
  );

  -- No-op: changing to the current category makes no further change and no
  -- additional audit entry is written.
  perform set_system_category('00000000-0000-0000-0000-000000004111', 'infrastructure');
  perform pg_temp.check_result(
    'changing to the current category is a no-op',
    (select display_order from systems where id = '00000000-0000-0000-0000-000000004111') = v_max_infra_order + 1
    and (
      select count(*) from audit_logs
      where action = 'system_category_changed'
        and entity_id = '00000000-0000-0000-0000-000000004111'
    ) = 1
  );

  begin
    perform set_system_category('00000000-0000-0000-0000-000000004111', 'not_a_real_category');
    perform pg_temp.check_result('category change rejects an invalid destination category', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'category change rejects an invalid destination category', sqlerrm like 'validation:%', sqlerrm
    );
  end;

  -- Same coverage for locations, using the location fixtures.
  perform set_location_category('00000000-0000-0000-0000-000000004121', 'external_sites');
  perform pg_temp.check_result(
    'location category change moves the record and preserves its id/incident reference',
    exists (
      select 1 from locations
      where id = '00000000-0000-0000-0000-000000004121' and category = 'external_sites'
    )
    and exists (
      select 1 from incidents
      where id = '00000000-0000-0000-0000-000000004131'
        and location_id = '00000000-0000-0000-0000-000000004121'
    )
  );

  reset role;
end;
$$;

-- ===== Deletion/activation protections still work once categories exist =====
do $$
declare
  v_result text;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000004101');
  set local role authenticated;

  v_result := delete_system('00000000-0000-0000-0000-000000004111');
  perform pg_temp.check_result(
    'a system referenced by an incident still archives instead of deleting, category notwithstanding',
    v_result = 'archived'
      and exists (select 1 from systems where id = '00000000-0000-0000-0000-000000004111' and archived)
  );

  perform set_system_active('00000000-0000-0000-0000-000000004116', false);
  perform pg_temp.check_result(
    'deactivation still works once the record carries a category',
    (select archived from systems where id = '00000000-0000-0000-0000-000000004116')
  );
  perform set_system_active('00000000-0000-0000-0000-000000004116', true);
  perform pg_temp.check_result(
    'reactivation still works once the record carries a category',
    not (select archived from systems where id = '00000000-0000-0000-0000-000000004116')
  );

  reset role;
end;
$$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
