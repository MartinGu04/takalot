-- AVARIA — fixed product-defined categories for systems/positions and
-- locations. Categories are NOT administratively configurable: the allowed
-- values are fixed lists validated inside this migration's functions, never
-- a table a user can edit.
--
-- Data transition: every existing system/location is backfilled to 'other'.
-- No category is inferred from existing data. Ordering (display_order),
-- active/inactive state, ids, and every incident's system_id/location_id
-- reference are all left completely untouched by this migration.
--
-- Ordering model change: display_order now means "position within this
-- record's category," not "position within the whole table." Two records in
-- different categories may legitimately share the same display_order value.
-- Every RPC that reads or rewrites display_order (move_*, delete_*,
-- reorder_*, and the new set_*_category) is updated below to scope its
-- neighbor lookup, gap-normalization, and validation to a single category so
-- that reordering or removing a record in one category never touches the
-- stored display_order values of another category.
--
-- Explicit transaction for the same reason as 0024/0035: the repository's
-- psql -f runner uses autocommit, so this keeps a manual/Supabase
-- application all-or-nothing.

begin;

-- ===== 1. Fixed category enums =====
-- Declaration order is also the required fixed UI display order: ordering a
-- query by this column sorts by declared enum order, not alphabetically.
create type public.system_category as enum (
  'platforms',         -- פלטפורמות
  'station_systems',   -- מערכות תחנה
  'computing',         -- מחשוב
  'infrastructure',    -- תשתיות
  'other'              -- אחר
);

create type public.location_category as enum (
  'unit_internal',     -- פנים יחידתי
  'field_side',        -- צד שטח
  'external_bases',    -- בסיסים חיצוניים
  'external_sites',    -- אתרים חיצוניים
  'other'              -- אחר
);

-- ===== 2. Add + backfill + constrain =====
-- A default of 'other' at the column level is a safety net for direct
-- (non-RPC) inserts -- e.g. this repository's own SQL test fixtures that
-- create a system/location purely as an incident foreign-key anchor and
-- have no reason to care about categories. The actual product entry points
-- (create_system/create_location below) never rely on this default: they
-- require an explicit, validated p_category argument and raise a
-- controlled error on a missing or invalid one, exactly as the product
-- spec requires. This default does not weaken that: it only affects
-- writes that bypass the RPC layer entirely.
alter table public.systems
  add column category public.system_category not null default 'other';
alter table public.locations
  add column category public.location_category not null default 'other';

-- ===== 3. Validation helpers =====
-- Kept as explicit text-parameter + manual whitelist checks (not "p_category
-- system_category" typed parameters) so an invalid value raises this
-- repository's own controlled 'validation:' Hebrew message instead of
-- Postgres's raw "invalid input value for enum" error.
create or replace function public.valid_system_category(p_category text) returns public.system_category
language plpgsql immutable set search_path = public as $$
begin
  if p_category is null or p_category not in (
    'platforms', 'station_systems', 'computing', 'infrastructure', 'other'
  ) then
    raise exception 'validation: סוג מערכת / עמדה אינו תקין';
  end if;
  return p_category::public.system_category;
end;
$$;

create or replace function public.valid_location_category(p_category text) returns public.location_category
language plpgsql immutable set search_path = public as $$
begin
  if p_category is null or p_category not in (
    'unit_internal', 'field_side', 'external_bases', 'external_sites', 'other'
  ) then
    raise exception 'validation: סוג מיקום אינו תקין';
  end if;
  return p_category::public.location_category;
end;
$$;

revoke execute on function public.valid_system_category(text) from public, anon, authenticated;
revoke execute on function public.valid_location_category(text) from public, anon, authenticated;

-- ===== 4. create_system / create_location now require a category =====
-- These gain a second parameter, which PostgreSQL treats as a distinct
-- function identity from the old single-argument overload -- `create or
-- replace` would leave that old, category-less overload (and its existing
-- EXECUTE grant to authenticated) callable side by side with the new one.
-- Drop it explicitly first so creating a system/location without a category
-- is impossible again, not just superseded.
drop function if exists public.create_system(text);
drop function if exists public.create_location(text);

create or replace function public.create_system(p_name text, p_category text) returns public.systems
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_category public.system_category;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);
  v_category := public.valid_system_category(p_category);
  lock table public.systems in share row exclusive mode;

  if exists (
    select 1 from public.systems
    where lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  insert into public.systems (name, archived, category, display_order, created_by)
  values (
    v_name,
    false,
    v_category,
    coalesce((select max(display_order) from public.systems where category = v_category), 0) + 1,
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

create or replace function public.create_location(p_name text, p_category text) returns public.locations
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_category public.location_category;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);
  v_category := public.valid_location_category(p_category);
  lock table public.locations in share row exclusive mode;

  if exists (
    select 1 from public.locations
    where lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  insert into public.locations (name, archived, category, display_order, created_by)
  values (
    v_name,
    false,
    v_category,
    coalesce((select max(display_order) from public.locations where category = v_category), 0) + 1,
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

-- ===== 5. move_system / move_location: neighbor + gap-normalization
--         scoped to the record's own category =====
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
  select * into v_system from public.systems where id = p_system_id;
  if not found then
    raise exception 'not_found: המערכת / העמדה לא נמצאה';
  end if;

  -- Canonicalize gaps/equal values within THIS category only, under the
  -- same lock, then swap one adjacent pair. Never touches another
  -- category's display_order values.
  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.systems
    where category = v_system.category
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
    where category = v_system.category and display_order < v_system.display_order
    order by display_order desc,
      lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) desc,
      id desc
    limit 1;
  else
    select * into v_neighbor
    from public.systems
    where category = v_system.category and display_order > v_system.display_order
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
  select * into v_location from public.locations where id = p_location_id;
  if not found then
    raise exception 'not_found: המיקום לא נמצא';
  end if;

  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.locations
    where category = v_location.category
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
    where category = v_location.category and display_order < v_location.display_order
    order by display_order desc,
      lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) desc,
      id desc
    limit 1;
  else
    select * into v_neighbor
    from public.locations
    where category = v_location.category and display_order > v_location.display_order
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

-- ===== 6. delete_system / delete_location: gap-normalization after
--         removal scoped to the deleted record's own category =====
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
    where category = v_before.category
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
    where category = v_before.category
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

-- ===== 7. reorder_systems / reorder_locations: the submitted id list must
--         be exactly one category's full, current id set. An id list
--         spanning more than one category fails validation the same way an
--         incomplete/extra list already did -- this is also what rejects
--         using a batch reorder call to smuggle a category change. =====
create or replace function public.reorder_systems(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
  v_distinct_count integer;
  v_category public.system_category;
  v_matching_count integer;
  v_total_count integer;
begin
  perform public.require_reference_data_admin();

  v_count := coalesce(array_length(p_ids, 1), 0);
  if v_count = 0 then
    raise exception 'validation: יש לספק רשימת מזהים לסידור';
  end if;

  select count(distinct id) into v_distinct_count from unnest(p_ids) as id;
  if v_distinct_count <> v_count then
    raise exception 'validation: רשימת הסידור מכילה מזהים כפולים';
  end if;

  lock table public.systems in share row exclusive mode;

  select category into v_category from public.systems where id = p_ids[1];
  if v_category is null then
    raise exception 'validation: רשימת הסידור אינה תואמת את המערכות / העמדות הקיימות';
  end if;

  select count(*) into v_total_count from public.systems where category = v_category;
  select count(*) into v_matching_count
  from public.systems
  where id = any(p_ids) and category = v_category;

  if v_matching_count <> v_count or v_total_count <> v_count then
    raise exception 'validation: רשימת הסידור אינה תואמת את המערכות / העמדות הקיימות';
  end if;

  update public.systems target
  set display_order = ordered.position
  from (
    select id, ordinality::integer as position
    from unnest(p_ids) with ordinality as u(id, ordinality)
  ) ordered
  where target.id = ordered.id;

  perform public.write_audit(
    'systems_reordered', 'system', 'bulk', null, null,
    jsonb_build_object('order', to_jsonb(p_ids))
  );
end;
$$;

create or replace function public.reorder_locations(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
  v_distinct_count integer;
  v_category public.location_category;
  v_matching_count integer;
  v_total_count integer;
begin
  perform public.require_reference_data_admin();

  v_count := coalesce(array_length(p_ids, 1), 0);
  if v_count = 0 then
    raise exception 'validation: יש לספק רשימת מזהים לסידור';
  end if;

  select count(distinct id) into v_distinct_count from unnest(p_ids) as id;
  if v_distinct_count <> v_count then
    raise exception 'validation: רשימת הסידור מכילה מזהים כפולים';
  end if;

  lock table public.locations in share row exclusive mode;

  select category into v_category from public.locations where id = p_ids[1];
  if v_category is null then
    raise exception 'validation: רשימת הסידור אינה תואמת את המיקומים הקיימים';
  end if;

  select count(*) into v_total_count from public.locations where category = v_category;
  select count(*) into v_matching_count
  from public.locations
  where id = any(p_ids) and category = v_category;

  if v_matching_count <> v_count or v_total_count <> v_count then
    raise exception 'validation: רשימת הסידור אינה תואמת את המיקומים הקיימים';
  end if;

  update public.locations target
  set display_order = ordered.position
  from (
    select id, ordinality::integer as position
    from unnest(p_ids) with ordinality as u(id, ordinality)
  ) ordered
  where target.id = ordered.id;

  perform public.write_audit(
    'locations_reordered', 'location', 'bulk', null, null,
    jsonb_build_object('order', to_jsonb(p_ids))
  );
end;
$$;

-- ===== 8. set_system_category / set_location_category: the only path that
--         moves a record between categories. Transactional (a single
--         SECURITY DEFINER function call): appends the record to the end of
--         the destination category, then normalizes gaps left behind in the
--         source category, in one atomic call. Never implemented via drag-
--         and-drop / reorder_* -- those reject any cross-category id
--         outright rather than moving it. =====
create or replace function public.set_system_category(
  p_system_id uuid,
  p_category text
) returns public.systems
language plpgsql security definer set search_path = public as $$
declare
  v_before public.systems;
  v_new_category public.system_category;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  v_new_category := public.valid_system_category(p_category);

  lock table public.systems in share row exclusive mode;
  select * into v_before
  from public.systems
  where id = p_system_id
  for update;
  if not found then
    raise exception 'not_found: המערכת / העמדה לא נמצאה';
  end if;

  if v_before.category = v_new_category then
    return v_before;
  end if;

  update public.systems
  set
    category = v_new_category,
    display_order = coalesce(
      (select max(display_order) from public.systems where category = v_new_category), 0
    ) + 1
  where id = p_system_id
  returning * into v_system;

  -- Close the gap left in the source category so its remaining records keep
  -- a valid, deterministic, contiguous order. Excludes the just-moved row
  -- (already re-categorized above), so this only ever touches source-
  -- category rows -- the destination category and every other category are
  -- untouched.
  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.systems
    where category = v_before.category
  )
  update public.systems target
  set display_order = ranked.position
  from ranked
  where target.id = ranked.id
    and target.display_order <> ranked.position;

  perform public.write_audit(
    'system_category_changed', 'system', v_system.id::text, null,
    jsonb_build_object('category', v_before.category),
    jsonb_build_object('category', v_system.category)
  );
  return v_system;
end;
$$;

create or replace function public.set_location_category(
  p_location_id uuid,
  p_category text
) returns public.locations
language plpgsql security definer set search_path = public as $$
declare
  v_before public.locations;
  v_new_category public.location_category;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  v_new_category := public.valid_location_category(p_category);

  lock table public.locations in share row exclusive mode;
  select * into v_before
  from public.locations
  where id = p_location_id
  for update;
  if not found then
    raise exception 'not_found: המיקום לא נמצא';
  end if;

  if v_before.category = v_new_category then
    return v_before;
  end if;

  update public.locations
  set
    category = v_new_category,
    display_order = coalesce(
      (select max(display_order) from public.locations where category = v_new_category), 0
    ) + 1
  where id = p_location_id
  returning * into v_location;

  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.locations
    where category = v_before.category
  )
  update public.locations target
  set display_order = ranked.position
  from ranked
  where target.id = ranked.id
    and target.display_order <> ranked.position;

  perform public.write_audit(
    'location_category_changed', 'location', v_location.id::text, null,
    jsonb_build_object('category', v_before.category),
    jsonb_build_object('category', v_location.category)
  );
  return v_location;
end;
$$;

-- ===== 9. Grants: same authenticated-only shape as every other
--         reference-data RPC (0024/0035) =====
revoke execute on function public.create_system(text, text) from public, anon, authenticated;
revoke execute on function public.create_location(text, text) from public, anon, authenticated;
revoke execute on function public.set_system_category(uuid, text) from public, anon, authenticated;
revoke execute on function public.set_location_category(uuid, text) from public, anon, authenticated;

grant execute on function public.create_system(text, text) to authenticated;
grant execute on function public.create_location(text, text) to authenticated;
grant execute on function public.set_system_category(uuid, text) to authenticated;
grant execute on function public.set_location_category(uuid, text) to authenticated;

-- The old single-argument create_system(text)/create_location(text)
-- overloads no longer exist after `create or replace` above changed their
-- signature (PostgreSQL treats a different argument list as a distinct
-- function) -- there is nothing to drop, but nothing else in this
-- migration re-grants them, so they simply stop being reachable.

commit;
