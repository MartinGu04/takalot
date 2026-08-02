-- Focused verification for migration 0024_reference_data_management.sql.
-- Runs only against the local scratch database created by tests/run.sh.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000241', 'ref-admin@test', now()),
  ('00000000-0000-0000-0000-000000000242', 'ref-inactive-admin@test', now()),
  ('00000000-0000-0000-0000-000000000243', 'ref-supervisor@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000000241', 'Reference Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-000000000242', 'Inactive Reference Admin', 'system_admin', false),
  ('00000000-0000-0000-0000-000000000243', 'Reference Supervisor', 'shift_supervisor', true);

insert into systems (id, name, display_order) values
  ('00000000-0000-0000-0000-000000002401', 'Sys Ref', 1),
  ('00000000-0000-0000-0000-000000002402', 'Sys Second', 2);
insert into locations (id, name, display_order) values
  ('00000000-0000-0000-0000-000000002411', 'Loc Ref', 1),
  ('00000000-0000-0000-0000-000000002412', 'Loc Second', 2);

insert into incidents (
  id, number, system_id, location_id, description, severity, status,
  operational_impact, owner_user_id, discovered_at, created_by, updated_by,
  next_update_due, version
) values (
  '00000000-0000-0000-0000-000000002421', 'T-024',
  '00000000-0000-0000-0000-000000002401',
  '00000000-0000-0000-0000-000000002411',
  'Reference-data history', 'medium', 'in_progress', 'Impact',
  '00000000-0000-0000-0000-000000000243', now(),
  '00000000-0000-0000-0000-000000000241',
  '00000000-0000-0000-0000-000000000241',
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

-- ===== Schema, indexes, trigger, policies, and grants =====
select pg_temp.check_result(
  'systems.display_order is non-null with a positive check',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'systems'
      and column_name = 'display_order' and is_nullable = 'NO'
  )
  and exists (
    select 1 from pg_constraint
    where conrelid = 'public.systems'::regclass
      and conname = 'systems_display_order_positive'
  )
);

select pg_temp.check_result(
  'locations.display_order is non-null with a positive check',
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'locations'
      and column_name = 'display_order' and is_nullable = 'NO'
  )
  and exists (
    select 1 from pg_constraint
    where conrelid = 'public.locations'::regclass
      and conname = 'locations_display_order_positive'
  )
);

select pg_temp.check_result(
  'systems normalized-name unique index exists',
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'systems'
      and indexname = 'systems_name_normalized_unique'
      and indexdef like '%lower(regexp_replace(name%'
  )
);

select pg_temp.check_result(
  'locations normalized-name unique index exists',
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'locations'
      and indexname = 'locations_name_normalized_unique'
      and indexdef like '%lower(regexp_replace(name%'
  )
);

select pg_temp.check_result(
  'incident active-reference-data trigger exists and is enabled',
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.incidents'::regclass
      and tgname = 'trg_incidents_active_reference_data'
      and not tgisinternal
      and tgenabled <> 'D'
  )
);

select pg_temp.check_result(
  'incident reference trigger locks system then location rows FOR SHARE',
  (
    select
      position('from public.systems' in definition) > 0
      and position('from public.locations' in definition) > position('from public.systems' in definition)
      and position('for share' in definition) > 0
    from (
      select lower(
        pg_get_functiondef('public.assert_incident_reference_data_active()'::regprocedure)
      ) as definition
    ) function_source
  )
);

select pg_temp.check_result(
  'legacy direct mutation RLS policies are removed',
  not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and policyname in (
        'systems_admin_insert', 'systems_admin_update',
        'locations_admin_insert', 'locations_admin_update'
      )
  )
);

select pg_temp.check_result(
  'authenticated has no direct systems mutations',
  not has_table_privilege('authenticated', 'public.systems', 'INSERT')
  and not has_table_privilege('authenticated', 'public.systems', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.systems', 'DELETE')
);

select pg_temp.check_result(
  'authenticated has no direct locations mutations',
  not has_table_privilege('authenticated', 'public.locations', 'INSERT')
  and not has_table_privilege('authenticated', 'public.locations', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.locations', 'DELETE')
);

select pg_temp.check_result(
  'authenticated can execute all ten reference-data RPCs',
  has_function_privilege('authenticated', 'public.create_system(text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.rename_system(uuid,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_system_active(uuid,boolean)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.move_system(uuid,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.delete_system(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.create_location(text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.rename_location(uuid,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_location_active(uuid,boolean)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.move_location(uuid,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.delete_location(uuid)', 'EXECUTE')
);

select pg_temp.check_result(
  'anon cannot execute any reference-data RPC',
  not has_function_privilege('anon', 'public.create_system(text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.rename_system(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_system_active(uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.move_system(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.delete_system(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_location(text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.rename_location(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_location_active(uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.move_location(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.delete_location(uuid)', 'EXECUTE')
);

select pg_temp.check_result(
  'PUBLIC has no reference-data RPC execute grants',
  not exists (
    select 1
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace,
         aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
    where namespace.nspname = 'public'
      and procedure.proname in (
        'create_system', 'rename_system', 'set_system_active', 'move_system', 'delete_system',
        'create_location', 'rename_location', 'set_location_active', 'move_location', 'delete_location'
      )
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  )
);

select pg_temp.check_result(
  'internal reference-data helpers are not executable by authenticated clients',
  not has_function_privilege('authenticated', 'public.require_reference_data_admin()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.valid_reference_data_name(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.assert_incident_reference_data_active()', 'EXECUTE')
);

-- ===== Direct table paths are closed even for an active administrator =====
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000241');
  set local role authenticated;
  begin
    insert into systems (name, display_order) values ('Bypass system', 99);
    perform pg_temp.check_result('direct systems INSERT is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('direct systems INSERT is blocked', sqlstate = '42501', sqlerrm);
  end;
  begin
    update systems set name = 'Bypass rename' where id = '00000000-0000-0000-0000-000000002401';
    perform pg_temp.check_result('direct systems UPDATE is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('direct systems UPDATE is blocked', sqlstate = '42501', sqlerrm);
  end;
  begin
    delete from systems where id = '00000000-0000-0000-0000-000000002402';
    perform pg_temp.check_result('direct systems DELETE is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('direct systems DELETE is blocked', sqlstate = '42501', sqlerrm);
  end;
  begin
    insert into locations (name, display_order) values ('Bypass location', 99);
    perform pg_temp.check_result('direct locations INSERT is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('direct locations INSERT is blocked', sqlstate = '42501', sqlerrm);
  end;
  begin
    update locations set name = 'Bypass rename' where id = '00000000-0000-0000-0000-000000002411';
    perform pg_temp.check_result('direct locations UPDATE is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('direct locations UPDATE is blocked', sqlstate = '42501', sqlerrm);
  end;
  begin
    delete from locations where id = '00000000-0000-0000-0000-000000002412';
    perform pg_temp.check_result('direct locations DELETE is blocked', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('direct locations DELETE is blocked', sqlstate = '42501', sqlerrm);
  end;
  reset role;
end;
$$;

-- ===== Authorization and input validation =====
do $$
declare
  v_system systems;
  v_location locations;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000243');
  set local role authenticated;
  begin
    perform create_system('Forbidden', 'other');
    perform pg_temp.check_result('non-admin system creation is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('non-admin system creation is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  begin
    perform create_location('Forbidden', 'other');
    perform pg_temp.check_result('non-admin location creation is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('non-admin location creation is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000000242');
  set local role authenticated;
  begin
    perform create_system('Inactive forbidden', 'other');
    perform pg_temp.check_result('inactive administrator is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('inactive administrator is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000000241');
  set local role authenticated;
  begin
    select * into v_system from create_system('   ', 'other');
    perform pg_temp.check_result('whitespace-only system name is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('whitespace-only system name is rejected', sqlerrm like 'validation:%', sqlerrm);
  end;
  begin
    select * into v_location from create_location('', 'other');
    perform pg_temp.check_result('empty location name is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('empty location name is rejected', sqlerrm like 'validation:%', sqlerrm);
  end;
  begin
    perform create_system(repeat('א', 121), 'other');
    perform pg_temp.check_result('system maximum length is enforced', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('system maximum length is enforced', sqlerrm like 'validation:%120%', sqlerrm);
  end;
  begin
    perform create_location(repeat('א', 121), 'other');
    perform pg_temp.check_result('location maximum length is enforced', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('location maximum length is enforced', sqlerrm like 'validation:%120%', sqlerrm);
  end;
  reset role;
end;
$$;

-- ===== Create, reserve names, rename, and audit =====
do $$
declare
  v_system systems;
  v_location locations;
  v_system_id uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000241');
  set local role authenticated;

  select * into v_system from create_system('  Control Alpha  ', 'other');
  perform pg_temp.check_result(
    'authorized system creation trims and stores the name',
    v_system.name = 'Control Alpha' and not v_system.archived and v_system.display_order > 2,
    row_to_json(v_system)::text
  );
  v_system_id := v_system.id;

  select * into v_location from create_location('  Control Alpha  ', 'other');
  perform pg_temp.check_result(
    'systems and locations use separate name namespaces',
    v_location.name = 'Control Alpha' and not v_location.archived,
    row_to_json(v_location)::text
  );
  begin
    perform create_location(' control alpha ', 'other');
    perform pg_temp.check_result('normalized location name is reserved within its namespace', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'normalized location name is reserved within its namespace',
      sqlerrm like 'conflict:%להפעיל מחדש%',
      sqlerrm
    );
  end;

  perform set_system_active(v_system.id, false);
  begin
    perform create_system('  control alpha ', 'other');
    perform pg_temp.check_result('inactive system name remains globally reserved', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'inactive system name remains globally reserved',
      sqlerrm like 'conflict:%להפעיל מחדש%',
      sqlerrm
    );
  end;
  perform set_system_active(v_system.id, true);

  select * into v_system from rename_system(v_system.id, '  Renamed Control  ');
  perform pg_temp.check_result(
    'rename trims and preserves the stable system id',
    v_system.id = v_system_id and v_system.name = 'Renamed Control',
    row_to_json(v_system)::text
  );

  begin
    perform rename_system(v_system.id, ' sys ref ');
    perform pg_temp.check_result('rename rejects a normalized duplicate', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('rename rejects a normalized duplicate', sqlerrm like 'conflict:%', sqlerrm);
  end;

  begin
    perform rename_location('00000000-0000-0000-0000-000000009999', 'Missing');
    perform pg_temp.check_result('rename returns a controlled not-found error', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('rename returns a controlled not-found error', sqlerrm like 'not_found:%', sqlerrm);
  end;

  reset role;

  perform pg_temp.check_result(
    'create and rename mutations write meaningful audit actions',
    exists (select 1 from audit_logs where action = 'system_created' and entity_id = v_system_id::text)
    and exists (select 1 from audit_logs where action = 'system_renamed' and entity_id = v_system_id::text)
    and exists (select 1 from audit_logs where action = 'location_created' and entity_id = v_location.id::text)
  );
end;
$$;

-- ===== Deterministic ordering, equal-value normalization, and boundaries =====
update systems
set display_order = 1
where id in (
  '00000000-0000-0000-0000-000000002401',
  '00000000-0000-0000-0000-000000002402'
);

select pg_temp.check_result(
  'equal order values have a deterministic name/id tie-break',
  (
    select (
      array_agg(
        id order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      )
    )[1:2]
    from systems
  ) = array[
    '00000000-0000-0000-0000-000000002401'::uuid,
    '00000000-0000-0000-0000-000000002402'::uuid
  ]
);

do $$
declare
  v_first_before uuid;
  v_first_after uuid;
  v_last_before uuid;
  v_last_after uuid;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000241');
  set local role authenticated;

  perform move_system('00000000-0000-0000-0000-000000002402', 'up');
  select id into v_first_after
  from systems
  order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
  limit 1;
  perform pg_temp.check_result(
    'move up normalizes ties and swaps the adjacent system',
    v_first_after = '00000000-0000-0000-0000-000000002402',
    v_first_after::text
  );

  select id into v_first_before
  from systems
  order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
  limit 1;
  perform move_system(v_first_before, 'up');
  select id into v_first_after
  from systems
  order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
  limit 1;
  perform pg_temp.check_result('moving the first system up is a safe no-op', v_first_after = v_first_before);

  perform move_system('00000000-0000-0000-0000-000000002402', 'down');
  perform pg_temp.check_result(
    'move down swaps the adjacent system',
    (select display_order from systems where id = '00000000-0000-0000-0000-000000002402')
      >
    (select display_order from systems where id = '00000000-0000-0000-0000-000000002401')
  );

  select id into v_last_before
  from locations
  order by display_order desc,
    lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) desc,
    id desc
  limit 1;
  perform move_location(v_last_before, 'down');
  select id into v_last_after
  from locations
  order by display_order desc,
    lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) desc,
    id desc
  limit 1;
  perform pg_temp.check_result('moving the last location down is a safe no-op', v_last_after = v_last_before);

  begin
    perform move_location(v_last_before, 'sideways');
    perform pg_temp.check_result('invalid move direction is controlled validation', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('invalid move direction is controlled validation', sqlerrm like 'validation:%', sqlerrm);
  end;
  begin
    perform move_system('00000000-0000-0000-0000-000000009999', 'up');
    perform pg_temp.check_result('move missing row is controlled not-found', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('move missing row is controlled not-found', sqlerrm like 'not_found:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.check_result(
    'successful ordering mutation is audited',
    exists (
      select 1 from audit_logs
      where action = 'system_moved'
        and entity_id = '00000000-0000-0000-0000-000000002402'
    )
  );
end;
$$;

-- ===== Stale selectors, reactivation, safe deletion, and history =====
do $$
declare
  v_result text;
  v_unused_system systems;
  v_unused_location locations;
  v_input jsonb;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000241');
  set local role authenticated;

  perform set_system_active('00000000-0000-0000-0000-000000002401', false);
  v_input := jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-000000002401',
    'locationId', '00000000-0000-0000-0000-000000002411',
    'description', 'Stale system selection',
    'severity', 'medium',
    'status', 'new',
    'operationalImpact', 'Impact',
    'actionsTaken', 'Checked',
    'ownerUserId', '00000000-0000-0000-0000-000000000243',
    'ownerExternalName', null,
    'discoveredAt', now(),
    'nextUpdateDue', now() + interval '4 hours',
    'noDeadlineReason', null,
    'reportedToOps', 'no',
    'reportedToComms', false,
    'reportedToCommsRecipient', null,
    'wisdomReported', false,
    'wisdomIncidentNumber', null
  );
  begin
    perform create_incident(v_input);
    perform pg_temp.check_result('stale inactive system selection is rejected cleanly', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'stale inactive system selection is rejected cleanly',
      sqlerrm = 'validation: יש לבחור מערכת / עמדה פעילה',
      sqlerrm
    );
  end;

  perform set_system_active('00000000-0000-0000-0000-000000002401', true);
  perform set_location_active('00000000-0000-0000-0000-000000002411', false);
  begin
    perform create_incident(v_input);
    perform pg_temp.check_result('stale inactive location selection is rejected cleanly', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'stale inactive location selection is rejected cleanly',
      sqlerrm = 'validation: יש לבחור מיקום פעיל',
      sqlerrm
    );
  end;
  perform set_location_active('00000000-0000-0000-0000-000000002411', true);

  select * into v_unused_system from create_system('Disposable', 'other');
  v_result := delete_system(v_unused_system.id);
  perform pg_temp.check_result(
    'never-used system is physically deleted',
    v_result = 'deleted'
      and not exists (select 1 from systems where id = v_unused_system.id)
      and not exists (
        select 1
        from (
          select
            display_order,
            (row_number() over (order by display_order, lower(name), id))::integer as expected_order
          from systems
        ) ordered_systems
        where display_order <> expected_order
      ),
    v_result
  );
  perform create_system(' disposable ', 'other');
  perform pg_temp.check_result(
    'physical deletion releases the normalized system name',
    exists (
      select 1 from systems
      where lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = 'disposable'
    ),
    ''
  );

  select * into v_unused_location from create_location('Disposable location', 'other');
  v_result := delete_location(v_unused_location.id);
  perform pg_temp.check_result(
    'never-used location is physically deleted',
    v_result = 'deleted'
      and not exists (select 1 from locations where id = v_unused_location.id)
      and not exists (
        select 1
        from (
          select
            display_order,
            (row_number() over (order by display_order, lower(name), id))::integer as expected_order
          from locations
        ) ordered_locations
        where display_order <> expected_order
    ),
    v_result
  );
  perform create_location(' disposable location ', 'other');
  perform pg_temp.check_result(
    'physical deletion releases the normalized location name',
    exists (
      select 1 from locations
      where lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = 'disposable location'
    ),
    ''
  );

  v_result := delete_system('00000000-0000-0000-0000-000000002401');
  perform pg_temp.check_result(
    'referenced system deletion archives instead of deleting',
    v_result = 'archived'
      and exists (
        select 1 from systems
        where id = '00000000-0000-0000-0000-000000002401' and archived
      ),
    v_result
  );
  v_result := delete_location('00000000-0000-0000-0000-000000002411');
  perform pg_temp.check_result(
    'referenced location deletion archives instead of deleting',
    v_result = 'archived'
      and exists (
        select 1 from locations
        where id = '00000000-0000-0000-0000-000000002411' and archived
      ),
    v_result
  );

  begin
    perform delete_system('00000000-0000-0000-0000-000000009999');
    perform pg_temp.check_result('delete missing row is controlled not-found', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('delete missing row is controlled not-found', sqlerrm like 'not_found:%', sqlerrm);
  end;
  reset role;

  begin
    update incidents
    set
      system_id = system_id,
      location_id = location_id,
      description = description || ' (historical update)'
    where id = '00000000-0000-0000-0000-000000002421';
    perform pg_temp.check_result(
      'historical incidents remain updatable when inactive references are unchanged',
      exists (
        select 1 from incidents
        where id = '00000000-0000-0000-0000-000000002421'
          and description like '%(historical update)'
      )
    );
  exception when others then
    perform pg_temp.check_result(
      'historical incidents remain updatable when inactive references are unchanged',
      false,
      sqlerrm
    );
  end;

  perform pg_temp.check_result(
    'historical incident foreign keys remain valid after deletion requests',
    exists (
      select 1 from incidents
      where id = '00000000-0000-0000-0000-000000002421'
        and system_id = '00000000-0000-0000-0000-000000002401'
        and location_id = '00000000-0000-0000-0000-000000002411'
    )
  );
  perform pg_temp.check_result(
    'safe deletion outcomes are audited',
    exists (
      select 1 from audit_logs
      where action = 'system_delete_archived'
        and entity_id = '00000000-0000-0000-0000-000000002401'
    )
    and exists (
      select 1 from audit_logs
      where action = 'location_delete_archived'
        and entity_id = '00000000-0000-0000-0000-000000002411'
    )
    and exists (select 1 from audit_logs where action = 'system_deleted')
    and exists (select 1 from audit_logs where action = 'location_deleted')
  );
end;
$$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
