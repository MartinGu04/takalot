-- Focused verification for migration 0035_reference_data_drag_ordering.sql.
-- Runs only against the local scratch database created by tests/run.sh.
\pset pager off
begin;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000003541', 'drag-admin@test', now()),
  ('00000000-0000-0000-0000-000000003542', 'drag-inactive-admin@test', now()),
  ('00000000-0000-0000-0000-000000003543', 'drag-supervisor@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-000000003541', 'Drag Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-000000003542', 'Inactive Drag Admin', 'system_admin', false),
  ('00000000-0000-0000-0000-000000003543', 'Drag Supervisor', 'shift_supervisor', true);

insert into systems (id, name, display_order) values
  ('00000000-0000-0000-0000-000000354001', 'Drag Sys A', 1),
  ('00000000-0000-0000-0000-000000354002', 'Drag Sys B', 2),
  ('00000000-0000-0000-0000-000000354003', 'Drag Sys C', 3);
insert into locations (id, name, display_order) values
  ('00000000-0000-0000-0000-000000354101', 'Drag Loc A', 1),
  ('00000000-0000-0000-0000-000000354102', 'Drag Loc B', 2),
  ('00000000-0000-0000-0000-000000354103', 'Drag Loc C', 3);

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

-- ===== Grants: authenticated only, matching the 0024 pattern =====
select pg_temp.check_result(
  'authenticated can execute both reorder RPCs',
  has_function_privilege('authenticated', 'public.reorder_systems(uuid[])', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.reorder_locations(uuid[])', 'EXECUTE')
);

select pg_temp.check_result(
  'anon cannot execute either reorder RPC',
  not has_function_privilege('anon', 'public.reorder_systems(uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.reorder_locations(uuid[])', 'EXECUTE')
);

select pg_temp.check_result(
  'PUBLIC has no reorder RPC execute grants',
  not exists (
    select 1
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace,
         aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
    where namespace.nspname = 'public'
      and procedure.proname in ('reorder_systems', 'reorder_locations')
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  )
);

-- ===== Authorization =====
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000003543');
  set local role authenticated;
  begin
    perform public.reorder_systems(array[
      '00000000-0000-0000-0000-000000354001',
      '00000000-0000-0000-0000-000000354002',
      '00000000-0000-0000-0000-000000354003'
    ]::uuid[]);
    perform pg_temp.check_result('non-admin reorder_systems is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('non-admin reorder_systems is rejected', sqlerrm like 'permission:%', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-000000003542');
  set local role authenticated;
  begin
    perform public.reorder_locations(array[
      '00000000-0000-0000-0000-000000354101',
      '00000000-0000-0000-0000-000000354102',
      '00000000-0000-0000-0000-000000354103'
    ]::uuid[]);
    perform pg_temp.check_result('inactive administrator reorder is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'inactive administrator reorder is rejected', sqlerrm like 'permission:%', sqlerrm
    );
  end;
  reset role;
end;
$$;

-- ===== Validation: malformed / missing / duplicated / extra ids =====
do $$
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000003541');
  set local role authenticated;

  begin
    perform public.reorder_systems(array[]::uuid[]);
    perform pg_temp.check_result('empty id list is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('empty id list is rejected', sqlerrm like 'validation:%', sqlerrm);
  end;

  begin
    perform public.reorder_systems(null);
    perform pg_temp.check_result('null id list is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('null id list is rejected', sqlerrm like 'validation:%', sqlerrm);
  end;

  begin
    perform public.reorder_systems(array[
      '00000000-0000-0000-0000-000000354001',
      '00000000-0000-0000-0000-000000354001',
      '00000000-0000-0000-0000-000000354002'
    ]::uuid[]);
    perform pg_temp.check_result('duplicated id in the list is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('duplicated id in the list is rejected', sqlerrm like 'validation:%', sqlerrm);
  end;

  begin
    -- missing one existing system from the submitted list
    perform public.reorder_systems(array[
      '00000000-0000-0000-0000-000000354001',
      '00000000-0000-0000-0000-000000354002'
    ]::uuid[]);
    perform pg_temp.check_result('incomplete id list (missing a row) is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result(
      'incomplete id list (missing a row) is rejected', sqlerrm like 'validation:%', sqlerrm
    );
  end;

  begin
    -- an id that does not belong to any system at all
    perform public.reorder_systems(array[
      '00000000-0000-0000-0000-000000354001',
      '00000000-0000-0000-0000-000000354002',
      '00000000-0000-0000-0000-000000359999'
    ]::uuid[]);
    perform pg_temp.check_result('unknown id in the list is rejected', false, 'succeeded');
  exception when others then
    perform pg_temp.check_result('unknown id in the list is rejected', sqlerrm like 'validation:%', sqlerrm);
  end;

  -- No partial write happened during any of the rejected attempts above.
  perform pg_temp.check_result(
    'rejected reorder attempts left display_order untouched',
    (
      select array_agg(id order by display_order)
      from systems
      where id in (
        '00000000-0000-0000-0000-000000354001',
        '00000000-0000-0000-0000-000000354002',
        '00000000-0000-0000-0000-000000354003'
      )
    ) = array[
      '00000000-0000-0000-0000-000000354001'::uuid,
      '00000000-0000-0000-0000-000000354002'::uuid,
      '00000000-0000-0000-0000-000000354003'::uuid
    ]
  );

  reset role;
end;
$$;

-- ===== Successful reorder: atomic update + audit =====
do $$
declare
  v_order uuid[];
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-000000003541');
  set local role authenticated;

  perform public.reorder_systems(array[
    '00000000-0000-0000-0000-000000354003',
    '00000000-0000-0000-0000-000000354001',
    '00000000-0000-0000-0000-000000354002'
  ]::uuid[]);

  select array_agg(id order by display_order) into v_order
  from systems
  where id in (
    '00000000-0000-0000-0000-000000354001',
    '00000000-0000-0000-0000-000000354002',
    '00000000-0000-0000-0000-000000354003'
  );
  perform pg_temp.check_result(
    'reorder_systems applies the exact submitted order',
    v_order = array[
      '00000000-0000-0000-0000-000000354003'::uuid,
      '00000000-0000-0000-0000-000000354001'::uuid,
      '00000000-0000-0000-0000-000000354002'::uuid
    ],
    v_order::text
  );
  perform pg_temp.check_result(
    'reorder_systems produces contiguous 1..N display_order values',
    (
      select bool_and(display_order = expected)
      from (
        select display_order, row_number() over (order by display_order) as expected
        from systems
        where id in (
          '00000000-0000-0000-0000-000000354001',
          '00000000-0000-0000-0000-000000354002',
          '00000000-0000-0000-0000-000000354003'
        )
      ) checked
    )
  );

  perform public.reorder_locations(array[
    '00000000-0000-0000-0000-000000354103',
    '00000000-0000-0000-0000-000000354102',
    '00000000-0000-0000-0000-000000354101'
  ]::uuid[]);
  select array_agg(id order by display_order) into v_order
  from locations
  where id in (
    '00000000-0000-0000-0000-000000354101',
    '00000000-0000-0000-0000-000000354102',
    '00000000-0000-0000-0000-000000354103'
  );
  perform pg_temp.check_result(
    'reorder_locations applies the exact submitted order',
    v_order = array[
      '00000000-0000-0000-0000-000000354103'::uuid,
      '00000000-0000-0000-0000-000000354102'::uuid,
      '00000000-0000-0000-0000-000000354101'::uuid
    ],
    v_order::text
  );

  reset role;

  perform pg_temp.check_result(
    'successful reorder is audited for both entity types',
    exists (select 1 from audit_logs where action = 'systems_reordered')
    and exists (select 1 from audit_logs where action = 'locations_reordered')
  );
end;
$$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
