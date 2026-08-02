-- AVARIA — get_incident_analytics: read-only aggregate RPC backing the
-- ניתוחים (analytics) page's first vertical slice.
--
-- No SQL view or aggregate RPC existed anywhere before this migration --
-- every existing RPC returns a typed table row (`returns incidents`,
-- `returns handovers`, etc.). This function deliberately returns `jsonb`
-- instead: its payload is inherently a handful of scalars plus two arrays
-- of differently-shaped rows (chart buckets, top systems), and there is no
-- natural single row/table type for that shape. Flagged explicitly here so
-- it doesn't read as an inconsistency with the rest of this schema later.
--
-- What it computes, for a given period (7/30/90 days) and optional
-- system/location/severity filter:
--   opened_in_period    -- count of incidents whose discovered_at (the
--                           operational discovery/opening time, distinct
--                           from created_at) falls in the period.
--   closed_in_period    -- count of incidents whose closed_at falls in the
--                           period. closed_at is only ever non-null when
--                           status = 'closed' (see incident_
--                           not_closed_and_cancelled, migration 0016, and
--                           reopen_incident nulling it on reopen), so
--                           cancelled/open/reopened incidents are excluded
--                           automatically -- no extra status predicate
--                           needed.
--   avg_close_minutes   -- average (closed_at - discovered_at) over the
--                           exact same set as closed_in_period. null (not
--                           0) when that set is empty.
--   currently_open       -- count where is_incident_open(status). NOT
--                           period-bound -- always the true current set.
--   avg_open_minutes    -- average (now() - discovered_at) over the exact
--                           same set as currently_open, NOT period-bound.
--                           Each row is clamped with greatest(0, ...)
--                           before averaging. This is deliberately a
--                           general guard, not just a small clock-skew
--                           tolerance: unlike closed_at/update event times
--                           (which close_incident/update_incident validate
--                           against an explicit now() + 5 minutes upper
--                           bound), create_incident places no upper-bound
--                           validation on discovered_at at all, so a
--                           future-dated discovery timestamp -- whether a
--                           few minutes of clock skew or a genuine
--                           data-entry error placing it further out -- can
--                           reach this query. The clamp keeps either case
--                           from ever surfacing as a negative duration on
--                           the page; it does not detect or exclude the
--                           anomalous row itself, which is a data-entry
--                           concern outside this RPC's scope. null only
--                           when the open set itself is empty.
--   reopened_in_period  -- count of DISTINCT incidents with an
--                           incident_events row of type 'reopened' whose
--                           event_time falls in the period (an incident
--                           reopened more than once in the period is still
--                           counted once).
--   buckets              -- zero-filled opened/closed counts per bucket,
--                           daily for a 7/30-day period, weekly (ISO week)
--                           for the 90-day period, computed in
--                           Asia/Jerusalem calendar time (storage is UTC).
--                           Source rows are filtered to the exact period
--                           window BEFORE being grouped by date_trunc --
--                           relying only on the date_trunc grouping plus
--                           the generated bucket scaffold's join would
--                           silently miscount for the weekly case, where
--                           date_trunc('week', period_start) can fall
--                           before period_start itself (the period doesn't
--                           usually start on a Monday), letting an event
--                           from just before the period leak into the
--                           first partial bucket.
--   top_systems           -- up to 5 systems, ranked by opened-in-period
--                           desc, currently-open desc (tiebreak), system
--                           name asc (final tiebreak). A system with zero
--                           incidents opened in the selected period is
--                           excluded entirely, even if it has currently-
--                           open incidents opened before the period --
--                           this section answers "which systems had the
--                           most incidents THIS period," not "which
--                           systems have any current backlog." Returns an
--                           empty array (not an error) when no system
--                           qualifies.
--
-- Security: security definer (this schema's convention for RPCs), with an
-- explicit is_active_member() guard as the first statement in the body --
-- never relying on "RLS would have allowed it anyway" for a definer
-- function, matching every other definer RPC in this schema. p_period_days
-- is strictly validated to exactly 7, 30, or 90 -- a controlled validation
-- error (this schema's existing raise-exception convention), never a
-- silent clamp to a nearest valid value and never left to fail as a raw,
-- uncontrolled Postgres error further down. set search_path = public
-- guards against search-path hijacking, matching every other security
-- definer function in this schema.
--
-- Grants: since migration 0006, the schema-scoped default ACL for
-- functions created by postgres in schema public already resolves to
-- PUBLIC=false, anon=false, authenticated=true -- so this brand-new
-- function would already be reachable only by authenticated callers with
-- no further action. The explicit revoke/grant pair below restates that
-- final state directly on the function anyway (redundant with the current
-- default, but harmless and self-documenting), exactly as 0018 did for
-- cancel_incident, rather than relying silently on a default-privilege
-- rule three migrations away.
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
  -- Inclusive Asia/Jerusalem calendar-day boundary: "today" minus
  -- (p_period_days - 1) full days, at Jerusalem midnight, expressed back
  -- as a timestamptz (storage/comparison type for discovered_at/closed_at/
  -- event_time). Never a naive UTC-day truncation.
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
  -- Source rows bounded to the exact period window BEFORE grouping -- see
  -- the migration header comment for why this matters for the first/last
  -- (possibly partial) weekly bucket.
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
  )
  select jsonb_build_object(
    'openedInPeriod', scalars.opened_in_period,
    'closedInPeriod', scalars.closed_in_period,
    'avgCloseMinutes', scalars.avg_close_minutes,
    'currentlyOpen', scalars.currently_open,
    'avgOpenMinutes', scalars.avg_open_minutes,
    'reopenedInPeriod', scalars.reopened_in_period,
    'buckets', buckets_agg.buckets,
    'topSystems', top_systems_agg.top_systems
  )
  into v_result
  from scalars, buckets_agg, top_systems_agg;

  return v_result;
end;
$$;

revoke execute on function public.get_incident_analytics(int, uuid, uuid, incident_severity) from public, anon;
grant execute on function public.get_incident_analytics(int, uuid, uuid, incident_severity) to authenticated;
