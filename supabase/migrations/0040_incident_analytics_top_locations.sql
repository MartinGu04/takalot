-- AVARIA — get_incident_analytics: add topLocations to the analytics
-- payload, mirroring topSystems (migration 0036) exactly.
--
-- A new migration rather than an edit to 0036: migrations are immutable
-- once merged, matching every other "redefine an existing RPC" migration in
-- this schema (e.g. 0020/0026/0029/0030/0031/0032/0033/0037/0038 each
-- `create or replace` update_incident/close_incident in place rather than
-- rewriting an earlier migration file).
--
-- top_locations — up to 5 locations, ranked by opened-in-period desc,
--                 currently-open desc (tiebreak), location name asc (final
--                 tiebreak). A location with zero incidents opened in the
--                 selected period is excluded entirely, even if it has
--                 currently-open incidents opened before the period -- the
--                 exact same rule as top_systems, applied to location_id
--                 instead of system_id. avg_close_minutes is computed only
--                 from incidents at that location whose closed_at falls in
--                 the selected period (same rule as top_systems' own
--                 avg_close_minutes). currently_open is NOT period-bound --
--                 the true current open count at that location, after the
--                 same system/location/severity filters as everything else
--                 in this RPC. Returns an empty array (not an error) when
--                 no location qualifies.
--
-- Same filters (p_system_id/p_location_id/p_severity), same
-- is_active_member() guard, same security definer + explicit search_path,
-- same signature -- this is purely an additive payload change, so grants
-- are not restated here (they already apply to this function from 0036 and
-- persist across create or replace with an unchanged signature).
create or replace function get_incident_analytics(
  p_period_days int,
  p_system_id uuid default null,
  p_location_id uuid default null,
  p_severity incident_severity default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_period_start timestamptz;
  v_period_end timestamptz := now();
  v_bucket_unit text;
  v_result jsonb;
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if p_period_days is null or p_period_days not in (7, 30, 90) then
    raise exception 'validation: תקופה לא תקינה';
  end if;

  v_bucket_unit := case when p_period_days = 90 then 'week' else 'day' end;
  v_period_start := (
    ((now() at time zone 'Asia/Jerusalem')::date - (p_period_days - 1))::timestamp
  ) at time zone 'Asia/Jerusalem';

  with f as (
    select *
    from incidents
    where (p_system_id is null or system_id = p_system_id)
      and (p_location_id is null or location_id = p_location_id)
      and (p_severity is null or severity = p_severity)
  ),
  scalars as (
    select
      (select count(*) from f
        where discovered_at >= v_period_start and discovered_at <= v_period_end) as opened_in_period,
      (select count(*) from f
        where closed_at is not null and closed_at >= v_period_start and closed_at <= v_period_end) as closed_in_period,
      (select avg(extract(epoch from (closed_at - discovered_at)) / 60.0) from f
        where closed_at is not null and closed_at >= v_period_start and closed_at <= v_period_end) as avg_close_minutes,
      (select count(*) from f where is_incident_open(status)) as currently_open,
      (select avg(greatest(0, extract(epoch from (now() - discovered_at)) / 60.0)) from f
        where is_incident_open(status)) as avg_open_minutes,
      (select count(distinct e.incident_id) from incident_events e join f on f.id = e.incident_id
        where e.type = 'reopened' and e.event_time >= v_period_start and e.event_time <= v_period_end) as reopened_in_period
  ),
  bucket_scaffold as (
    select generate_series(
      date_trunc(v_bucket_unit, v_period_start at time zone 'Asia/Jerusalem'),
      date_trunc(v_bucket_unit, v_period_end at time zone 'Asia/Jerusalem'),
      case v_bucket_unit when 'week' then interval '1 week' else interval '1 day' end
    ) as bucket_start
  ),
  opened_by_bucket as (
    select date_trunc(v_bucket_unit, discovered_at at time zone 'Asia/Jerusalem') as bucket_start, count(*) as n
    from f
    where discovered_at >= v_period_start and discovered_at <= v_period_end
    group by 1
  ),
  closed_by_bucket as (
    select date_trunc(v_bucket_unit, closed_at at time zone 'Asia/Jerusalem') as bucket_start, count(*) as n
    from f
    where closed_at is not null and closed_at >= v_period_start and closed_at <= v_period_end
    group by 1
  ),
  buckets_agg as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'bucketStart', to_char(bs.bucket_start, 'YYYY-MM-DD'),
        'opened', coalesce(ob.n, 0),
        'closed', coalesce(cb.n, 0)
      ) order by bs.bucket_start
    ), '[]'::jsonb) as buckets
    from bucket_scaffold bs
    left join opened_by_bucket ob on ob.bucket_start = bs.bucket_start
    left join closed_by_bucket cb on cb.bucket_start = bs.bucket_start
  ),
  sys_period as (
    select
      s.id as system_id,
      s.name as system_name,
      count(*) filter (
        where f.discovered_at >= v_period_start and f.discovered_at <= v_period_end
      ) as opened_in_period,
      count(*) filter (where is_incident_open(f.status)) as currently_open,
      avg(extract(epoch from (f.closed_at - f.discovered_at)) / 60.0) filter (
        where f.closed_at is not null and f.closed_at >= v_period_start and f.closed_at <= v_period_end
      ) as avg_close_minutes
    from f
    join systems s on s.id = f.system_id
    group by s.id, s.name
    having count(*) filter (
      where f.discovered_at >= v_period_start and f.discovered_at <= v_period_end
    ) > 0
  ),
  top_systems_ranked as (
    select * from sys_period
    order by opened_in_period desc, currently_open desc, system_name asc
    limit 5
  ),
  top_systems_agg as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'systemId', system_id,
        'systemName', system_name,
        'openedInPeriod', opened_in_period,
        'currentlyOpen', currently_open,
        'avgCloseMinutes', avg_close_minutes
      ) order by opened_in_period desc, currently_open desc, system_name asc
    ), '[]'::jsonb) as top_systems
    from top_systems_ranked
  ),
  -- Mirrors sys_period/top_systems_ranked/top_systems_agg above exactly,
  -- keyed on location_id instead of system_id.
  loc_period as (
    select
      l.id as location_id,
      l.name as location_name,
      count(*) filter (
        where f.discovered_at >= v_period_start and f.discovered_at <= v_period_end
      ) as opened_in_period,
      count(*) filter (where is_incident_open(f.status)) as currently_open,
      avg(extract(epoch from (f.closed_at - f.discovered_at)) / 60.0) filter (
        where f.closed_at is not null and f.closed_at >= v_period_start and f.closed_at <= v_period_end
      ) as avg_close_minutes
    from f
    join locations l on l.id = f.location_id
    group by l.id, l.name
    having count(*) filter (
      where f.discovered_at >= v_period_start and f.discovered_at <= v_period_end
    ) > 0
  ),
  top_locations_ranked as (
    select * from loc_period
    order by opened_in_period desc, currently_open desc, location_name asc
    limit 5
  ),
  top_locations_agg as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'locationId', location_id,
        'locationName', location_name,
        'openedInPeriod', opened_in_period,
        'currentlyOpen', currently_open,
        'avgCloseMinutes', avg_close_minutes
      ) order by opened_in_period desc, currently_open desc, location_name asc
    ), '[]'::jsonb) as top_locations
    from top_locations_ranked
  )
  select jsonb_build_object(
    'openedInPeriod', scalars.opened_in_period,
    'closedInPeriod', scalars.closed_in_period,
    'avgCloseMinutes', scalars.avg_close_minutes,
    'currentlyOpen', scalars.currently_open,
    'avgOpenMinutes', scalars.avg_open_minutes,
    'reopenedInPeriod', scalars.reopened_in_period,
    'buckets', buckets_agg.buckets,
    'topSystems', top_systems_agg.top_systems,
    'topLocations', top_locations_agg.top_locations
  )
  into v_result
  from scalars, buckets_agg, top_systems_agg, top_locations_agg;

  return v_result;
end;
$$;
