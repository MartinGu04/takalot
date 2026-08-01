-- AVARIA — batch reorder RPCs backing drag-and-drop ordering for
-- systems/positions and locations.
--
-- move_system/move_location (migration 0024) only ever swap one adjacent
-- pair per call, so persisting a fully rearranged list from a single
-- drag-and-drop drop would otherwise require many sequential adjacent-swap
-- round-trips — not atomic, and not safe against a concurrent submission
-- interleaving between them. These RPCs instead take the complete, final
-- ordered id list from one drop and apply it in a single transaction.
--
-- Same authorization/validation shape as every other reference-data RPC in
-- 0024: require_reference_data_admin() first, controlled 'validation:'
-- errors for anything malformed, EXECUTE granted to authenticated only.

begin;

create or replace function public.reorder_systems(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
  v_distinct_count integer;
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

  -- Serialize against concurrent create/move/delete/reorder exactly like
  -- every other reference-data mutation in 0024.
  lock table public.systems in share row exclusive mode;

  select count(*) into v_total_count from public.systems;
  select count(*) into v_matching_count
  from public.systems
  where id = any(p_ids);

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

  select count(*) into v_total_count from public.locations;
  select count(*) into v_matching_count
  from public.locations
  where id = any(p_ids);

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

revoke execute on function public.reorder_systems(uuid[]) from public, anon, authenticated;
revoke execute on function public.reorder_locations(uuid[]) from public, anon, authenticated;

grant execute on function public.reorder_systems(uuid[]) to authenticated;
grant execute on function public.reorder_locations(uuid[]) to authenticated;

commit;
