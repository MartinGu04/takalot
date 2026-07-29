-- AVARIA — authoritative management of systems/positions and locations.
--
-- Names are reserved globally inside each entity type after trim + lowercase.
-- The preflight intentionally runs before any schema/data change: an existing
-- normalized duplicate aborts this migration and must be resolved manually.
-- No legacy row is silently merged, renamed, archived, or deleted.
--
-- The explicit transaction is required because the repository's psql -f
-- runner uses autocommit. It also makes a manual/Supabase application of
-- this file all-or-nothing: any failure before COMMIT rolls every 0024
-- schema, function, policy, privilege, and data-ordering change back.

begin;

do $migration_preflight$
declare
  v_system_duplicates text;
  v_location_duplicates text;
begin
  -- A DO statement runs in one transaction even under the project's
  -- autocommit psql test runner. Hold the lock through the preflight and
  -- index creation so a concurrent legacy direct write cannot race between
  -- the duplicate check and uniqueness enforcement.
  lock table public.systems, public.locations in access exclusive mode;

  select string_agg(
    format('%L => [%s]', normalized_name, row_details),
    '; ' order by normalized_name
  )
  into v_system_duplicates
  from (
    select
      lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) as normalized_name,
      string_agg(format('%s:%s', id, name), ', ' order by id) as row_details
    from public.systems
    group by lower(regexp_replace(name, '^\s+|\s+$', '', 'g'))
    having count(*) > 1
  ) duplicates;

  select string_agg(
    format('%L => [%s]', normalized_name, row_details),
    '; ' order by normalized_name
  )
  into v_location_duplicates
  from (
    select
      lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) as normalized_name,
      string_agg(format('%s:%s', id, name), ', ' order by id) as row_details
    from public.locations
    group by lower(regexp_replace(name, '^\s+|\s+$', '', 'g'))
    having count(*) > 1
  ) duplicates;

  if v_system_duplicates is not null or v_location_duplicates is not null then
    raise exception using
      errcode = 'P0001',
      message = format(
        'migration_preflight: normalized reference-data duplicates detected; systems={%s}; locations={%s}. Resolve explicitly, then rerun migration 0024.',
        coalesce(v_system_duplicates, 'none'),
        coalesce(v_location_duplicates, 'none')
      );
  end if;

  execute $ddl$
    create unique index systems_name_normalized_unique
      on public.systems ((lower(regexp_replace(name, '^\s+|\s+$', '', 'g'))))
  $ddl$;
  execute $ddl$
    create unique index locations_name_normalized_unique
      on public.locations ((lower(regexp_replace(name, '^\s+|\s+$', '', 'g'))))
  $ddl$;
end;
$migration_preflight$;

-- Existing rows receive a deterministic initial order. A stable secondary
-- name/id ordering remains in every reader even if privileged maintenance
-- later introduces equal display_order values.
alter table public.systems add column display_order integer;
with ordered as (
  select id, (row_number() over (
    order by lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
  ))::integer as position
  from public.systems
)
update public.systems target
set display_order = ordered.position
from ordered
where target.id = ordered.id;
alter table public.systems
  alter column display_order set not null,
  add constraint systems_display_order_positive check (display_order > 0);

alter table public.locations add column display_order integer;
with ordered as (
  select id, (row_number() over (
    order by lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
  ))::integer as position
  from public.locations
)
update public.locations target
set display_order = ordered.position
from ordered
where target.id = ordered.id;
alter table public.locations
  alter column display_order set not null,
  add constraint locations_display_order_positive check (display_order > 0);

-- Shared internal validation helpers. Client roles cannot invoke them.
create or replace function public.require_reference_data_admin() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and active
      and role = 'system_admin'
  ) then
    raise exception 'permission: אין הרשאה לנהל מערכות ומיקומים';
  end if;
end;
$$;

create or replace function public.valid_reference_data_name(p_name text) returns text
language plpgsql immutable set search_path = public as $$
declare
  v_name text := regexp_replace(coalesce(p_name, ''), '^\s+|\s+$', '', 'g');
begin
  if v_name = '' then
    raise exception 'validation: יש להזין שם';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'validation: שם ארוך מדי (עד 120 תווים)';
  end if;
  return v_name;
end;
$$;

-- A stale incident draft must fail with a controlled message when its chosen
-- system/location was archived or removed before submission. Lock every new
-- or changed reference FOR SHARE, always system first and location second.
-- Deactivation/deletion take FOR UPDATE on the same rows, so whichever
-- transaction obtains the row lock first determines the controlled outcome.
-- Updates that do not change these foreign keys take no reference-data locks,
-- keeping historical inactive references valid.
create or replace function public.assert_incident_reference_data_active() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_check_system boolean;
  v_check_location boolean;
begin
  if tg_op = 'INSERT' then
    v_check_system := true;
    v_check_location := true;
  else
    v_check_system := new.system_id is distinct from old.system_id;
    v_check_location := new.location_id is distinct from old.location_id;
  end if;

  if v_check_system then
    perform 1
    from public.systems
    where id = new.system_id and not archived
    for share;
    if not found then
      raise exception 'validation: יש לבחור מערכת / עמדה פעילה';
    end if;
  end if;

  if v_check_location then
    perform 1
    from public.locations
    where id = new.location_id and not archived
    for share;
    if not found then
      raise exception 'validation: יש לבחור מיקום פעיל';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_incidents_active_reference_data
before insert or update of system_id, location_id on public.incidents
for each row execute function public.assert_incident_reference_data_active();

-- ===== Systems / positions =====

create or replace function public.create_system(p_name text) returns public.systems
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);
  lock table public.systems in share row exclusive mode;

  if exists (
    select 1 from public.systems
    where lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  insert into public.systems (name, archived, display_order, created_by)
  values (
    v_name,
    false,
    coalesce((select max(display_order) from public.systems), 0) + 1,
    auth.uid()
  )
  returning * into v_system;

  perform public.write_audit(
    'system_created', 'system', v_system.id::text, null, null, to_jsonb(v_system)
  );
  return v_system;
exception
  when unique_violation then
    raise exception 'conflict: כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
end;
$$;

create or replace function public.rename_system(p_system_id uuid, p_name text) returns public.systems
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_before public.systems;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);

  select * into v_before
  from public.systems
  where id = p_system_id
  for update;
  if not found then
    raise exception 'not_found: המערכת / העמדה לא נמצאה';
  end if;

  if exists (
    select 1
    from public.systems
    where id <> p_system_id
      and lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  if v_before.name = v_name then
    return v_before;
  end if;

  update public.systems
  set name = v_name
  where id = p_system_id
  returning * into v_system;

  perform public.write_audit(
    'system_renamed', 'system', v_system.id::text, null,
    jsonb_build_object('name', v_before.name),
    jsonb_build_object('name', v_system.name)
  );
  return v_system;
exception
  when unique_violation then
    raise exception 'conflict: כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
end;
$$;

create or replace function public.set_system_active(
  p_system_id uuid,
  p_active boolean
) returns public.systems
language plpgsql security definer set search_path = public as $$
declare
  v_before public.systems;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  if p_active is null then
    raise exception 'validation: יש לציין מצב פעיל או לא פעיל';
  end if;

  select * into v_before
  from public.systems
  where id = p_system_id
  for update;
  if not found then
    raise exception 'not_found: המערכת / העמדה לא נמצאה';
  end if;

  if p_active and exists (
    select 1
    from public.systems
    where id <> p_system_id
      and lower(regexp_replace(name, '^\s+|\s+$', '', 'g'))
        = lower(regexp_replace(v_before.name, '^\s+|\s+$', '', 'g'))
  ) then
    raise exception 'conflict: לא ניתן להפעיל מחדש: השם כבר שמור למערכת / עמדה אחרת';
  end if;

  if v_before.archived = (not p_active) then
    return v_before;
  end if;

  update public.systems
  set archived = (not p_active)
  where id = p_system_id
  returning * into v_system;

  perform public.write_audit(
    case when p_active then 'system_restored' else 'system_archived' end,
    'system', v_system.id::text, null,
    jsonb_build_object('archived', v_before.archived),
    jsonb_build_object('archived', v_system.archived)
  );
  return v_system;
exception
  when unique_violation then
    raise exception 'conflict: לא ניתן להפעיל מחדש: השם כבר שמור למערכת / עמדה אחרת';
end;
$$;

create or replace function public.move_system(
  p_system_id uuid,
  p_direction text
) returns public.systems
language plpgsql security definer set search_path = public as $$
declare
  v_system public.systems;
  v_neighbor public.systems;
  v_before_order integer;
begin
  perform public.require_reference_data_admin();
  if p_direction not in ('up', 'down') then
    raise exception 'validation: כיוון ההזזה אינו תקין';
  end if;

  lock table public.systems in share row exclusive mode;
  if not exists (select 1 from public.systems where id = p_system_id) then
    raise exception 'not_found: המערכת / העמדה לא נמצאה';
  end if;

  -- Canonicalize gaps/equal values under the same lock, then swap one
  -- adjacent pair. Concurrent create/move/delete operations serialize here.
  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.systems
  )
  update public.systems target
  set display_order = ranked.position
  from ranked
  where target.id = ranked.id
    and target.display_order <> ranked.position;

  select * into v_system from public.systems where id = p_system_id;
  if p_direction = 'up' then
    select * into v_neighbor
    from public.systems
    where display_order < v_system.display_order
    order by display_order desc,
      lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) desc,
      id desc
    limit 1;
  else
    select * into v_neighbor
    from public.systems
    where display_order > v_system.display_order
    order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
    limit 1;
  end if;

  if not found then
    return v_system;
  end if;

  v_before_order := v_system.display_order;
  update public.systems
  set display_order = case
    when id = v_system.id then v_neighbor.display_order
    else v_before_order
  end
  where id in (v_system.id, v_neighbor.id);

  select * into v_system from public.systems where id = p_system_id;
  perform public.write_audit(
    'system_moved', 'system', v_system.id::text, null,
    jsonb_build_object('display_order', v_before_order),
    jsonb_build_object('display_order', v_system.display_order)
  );
  return v_system;
end;
$$;

create or replace function public.delete_system(p_system_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_before public.systems;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  lock table public.systems in share row exclusive mode;
  select * into v_before
  from public.systems
  where id = p_system_id
  for update;
  if not found then
    raise exception 'not_found: המערכת / העמדה לא נמצאה';
  end if;

  if exists (select 1 from public.incidents where system_id = p_system_id) then
    update public.systems set archived = true
    where id = p_system_id
    returning * into v_system;
    perform public.write_audit(
      'system_delete_archived', 'system', p_system_id::text, null,
      to_jsonb(v_before), to_jsonb(v_system)
    );
    return 'archived';
  end if;

  begin
    delete from public.systems where id = p_system_id;
  exception
    when foreign_key_violation then
      update public.systems set archived = true
      where id = p_system_id
      returning * into v_system;
      perform public.write_audit(
        'system_delete_archived', 'system', p_system_id::text, null,
        to_jsonb(v_before), to_jsonb(v_system)
      );
      return 'archived';
  end;

  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.systems
  )
  update public.systems target
  set display_order = ranked.position
  from ranked
  where target.id = ranked.id
    and target.display_order <> ranked.position;

  perform public.write_audit(
    'system_deleted', 'system', p_system_id::text, null, to_jsonb(v_before), null
  );
  return 'deleted';
end;
$$;

-- ===== Locations =====

create or replace function public.create_location(p_name text) returns public.locations
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);
  lock table public.locations in share row exclusive mode;

  if exists (
    select 1 from public.locations
    where lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  insert into public.locations (name, archived, display_order, created_by)
  values (
    v_name,
    false,
    coalesce((select max(display_order) from public.locations), 0) + 1,
    auth.uid()
  )
  returning * into v_location;

  perform public.write_audit(
    'location_created', 'location', v_location.id::text, null, null, to_jsonb(v_location)
  );
  return v_location;
exception
  when unique_violation then
    raise exception 'conflict: כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
end;
$$;

create or replace function public.rename_location(
  p_location_id uuid,
  p_name text
) returns public.locations
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_before public.locations;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);

  select * into v_before
  from public.locations
  where id = p_location_id
  for update;
  if not found then
    raise exception 'not_found: המיקום לא נמצא';
  end if;

  if exists (
    select 1
    from public.locations
    where id <> p_location_id
      and lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  if v_before.name = v_name then
    return v_before;
  end if;

  update public.locations
  set name = v_name
  where id = p_location_id
  returning * into v_location;

  perform public.write_audit(
    'location_renamed', 'location', v_location.id::text, null,
    jsonb_build_object('name', v_before.name),
    jsonb_build_object('name', v_location.name)
  );
  return v_location;
exception
  when unique_violation then
    raise exception 'conflict: כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
end;
$$;

create or replace function public.set_location_active(
  p_location_id uuid,
  p_active boolean
) returns public.locations
language plpgsql security definer set search_path = public as $$
declare
  v_before public.locations;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  if p_active is null then
    raise exception 'validation: יש לציין מצב פעיל או לא פעיל';
  end if;

  select * into v_before
  from public.locations
  where id = p_location_id
  for update;
  if not found then
    raise exception 'not_found: המיקום לא נמצא';
  end if;

  if p_active and exists (
    select 1
    from public.locations
    where id <> p_location_id
      and lower(regexp_replace(name, '^\s+|\s+$', '', 'g'))
        = lower(regexp_replace(v_before.name, '^\s+|\s+$', '', 'g'))
  ) then
    raise exception 'conflict: לא ניתן להפעיל מחדש: השם כבר שמור למיקום אחר';
  end if;

  if v_before.archived = (not p_active) then
    return v_before;
  end if;

  update public.locations
  set archived = (not p_active)
  where id = p_location_id
  returning * into v_location;

  perform public.write_audit(
    case when p_active then 'location_restored' else 'location_archived' end,
    'location', v_location.id::text, null,
    jsonb_build_object('archived', v_before.archived),
    jsonb_build_object('archived', v_location.archived)
  );
  return v_location;
exception
  when unique_violation then
    raise exception 'conflict: לא ניתן להפעיל מחדש: השם כבר שמור למיקום אחר';
end;
$$;

create or replace function public.move_location(
  p_location_id uuid,
  p_direction text
) returns public.locations
language plpgsql security definer set search_path = public as $$
declare
  v_location public.locations;
  v_neighbor public.locations;
  v_before_order integer;
begin
  perform public.require_reference_data_admin();
  if p_direction not in ('up', 'down') then
    raise exception 'validation: כיוון ההזזה אינו תקין';
  end if;

  lock table public.locations in share row exclusive mode;
  if not exists (select 1 from public.locations where id = p_location_id) then
    raise exception 'not_found: המיקום לא נמצא';
  end if;

  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.locations
  )
  update public.locations target
  set display_order = ranked.position
  from ranked
  where target.id = ranked.id
    and target.display_order <> ranked.position;

  select * into v_location from public.locations where id = p_location_id;
  if p_direction = 'up' then
    select * into v_neighbor
    from public.locations
    where display_order < v_location.display_order
    order by display_order desc,
      lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) desc,
      id desc
    limit 1;
  else
    select * into v_neighbor
    from public.locations
    where display_order > v_location.display_order
    order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
    limit 1;
  end if;

  if not found then
    return v_location;
  end if;

  v_before_order := v_location.display_order;
  update public.locations
  set display_order = case
    when id = v_location.id then v_neighbor.display_order
    else v_before_order
  end
  where id in (v_location.id, v_neighbor.id);

  select * into v_location from public.locations where id = p_location_id;
  perform public.write_audit(
    'location_moved', 'location', v_location.id::text, null,
    jsonb_build_object('display_order', v_before_order),
    jsonb_build_object('display_order', v_location.display_order)
  );
  return v_location;
end;
$$;

create or replace function public.delete_location(p_location_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_before public.locations;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  lock table public.locations in share row exclusive mode;
  select * into v_before
  from public.locations
  where id = p_location_id
  for update;
  if not found then
    raise exception 'not_found: המיקום לא נמצא';
  end if;

  if exists (select 1 from public.incidents where location_id = p_location_id) then
    update public.locations set archived = true
    where id = p_location_id
    returning * into v_location;
    perform public.write_audit(
      'location_delete_archived', 'location', p_location_id::text, null,
      to_jsonb(v_before), to_jsonb(v_location)
    );
    return 'archived';
  end if;

  begin
    delete from public.locations where id = p_location_id;
  exception
    when foreign_key_violation then
      update public.locations set archived = true
      where id = p_location_id
      returning * into v_location;
      perform public.write_audit(
        'location_delete_archived', 'location', p_location_id::text, null,
        to_jsonb(v_before), to_jsonb(v_location)
      );
      return 'archived';
  end;

  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.locations
  )
  update public.locations target
  set display_order = ranked.position
  from ranked
  where target.id = ranked.id
    and target.display_order <> ranked.position;

  perform public.write_audit(
    'location_deleted', 'location', p_location_id::text, null, to_jsonb(v_before), null
  );
  return 'deleted';
end;
$$;

-- All client mutations now flow through the audited RPCs above. Read access
-- keeps the existing active-member RLS policies. Service-role access is not
-- changed; authenticated/anon/public direct writes are removed.
drop policy if exists systems_admin_insert on public.systems;
drop policy if exists systems_admin_update on public.systems;
drop policy if exists locations_admin_insert on public.locations;
drop policy if exists locations_admin_update on public.locations;

revoke insert, update, delete on table public.systems from public, anon, authenticated;
revoke insert, update, delete on table public.locations from public, anon, authenticated;

revoke execute on function public.require_reference_data_admin() from public, anon, authenticated;
revoke execute on function public.valid_reference_data_name(text) from public, anon, authenticated;
revoke execute on function public.assert_incident_reference_data_active() from public, anon, authenticated;

revoke execute on function public.create_system(text) from public, anon, authenticated;
revoke execute on function public.rename_system(uuid, text) from public, anon, authenticated;
revoke execute on function public.set_system_active(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.move_system(uuid, text) from public, anon, authenticated;
revoke execute on function public.delete_system(uuid) from public, anon, authenticated;
revoke execute on function public.create_location(text) from public, anon, authenticated;
revoke execute on function public.rename_location(uuid, text) from public, anon, authenticated;
revoke execute on function public.set_location_active(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.move_location(uuid, text) from public, anon, authenticated;
revoke execute on function public.delete_location(uuid) from public, anon, authenticated;

grant execute on function public.create_system(text) to authenticated;
grant execute on function public.rename_system(uuid, text) to authenticated;
grant execute on function public.set_system_active(uuid, boolean) to authenticated;
grant execute on function public.move_system(uuid, text) to authenticated;
grant execute on function public.delete_system(uuid) to authenticated;
grant execute on function public.create_location(text) to authenticated;
grant execute on function public.rename_location(uuid, text) to authenticated;
grant execute on function public.set_location_active(uuid, boolean) to authenticated;
grant execute on function public.move_location(uuid, text) to authenticated;
grant execute on function public.delete_location(uuid) to authenticated;

commit;
