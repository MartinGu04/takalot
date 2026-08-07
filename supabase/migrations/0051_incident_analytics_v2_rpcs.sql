-- AVARIA — ניתוחים v1.4.0: three new analytics RPCs.
--
-- Deployment-safety note (why these are NEW functions, not `create or replace`
-- on get_incident_analytics): PostgreSQL identifies a function for
-- `CREATE OR REPLACE` purposes by name AND full declared parameter-type list.
-- Appending new typed parameters to get_incident_analytics(int, uuid, uuid,
-- incident_severity) would not replace it -- it would silently create a SECOND,
-- overloaded function of the same name, and PostgREST cannot always disambiguate
-- between two same-named overloads when a call only supplies the parameters
-- common to both (PGRST203: "Could not choose the best candidate function").
-- So get_incident_analytics is left completely untouched here (still callable,
-- still tested by supabase/tests/incident_analytics_rpc.sql, serving as the
-- compatibility path for any client still calling it by its original name/
-- signature during a rollout window), and this migration adds three genuinely
-- new, unambiguous function names instead:
--
--   get_incident_analytics_v2   -- KPI scalars (incl. median, new to this
--                                  schema), opened/closed trend buckets, and
--                                  top-5 systems/locations (now ranked by
--                                  median close time). Conceptually "the
--                                  original RPC's logic, extended" -- same
--                                  period-bound filtered-incidents CTE shape,
--                                  just under a safe new name with a richer,
--                                  additive filter surface (severity/domain/
--                                  confirmed-cause/treatment-outcome arrays).
--   get_incident_open_backlog   -- open-incident age distribution. Genuinely
--                                  NOT period-bound (matches the existing
--                                  avgOpenMinutes semantics in
--                                  get_incident_analytics/_v2) -- deliberately
--                                  has no p_period_days parameter, since
--                                  bolting a period filter onto a query about
--                                  "how old is the CURRENT backlog" would be
--                                  incoherent.
--   get_incident_closure_insights -- confirmed-cause / treatment-outcome
--                                  breakdown and external-involvement counts,
--                                  all sourced from incident_closures (a table
--                                  the other two functions never touch). The
--                                  one query shape genuinely heavier than a
--                                  plain incidents scan (join + two-way GROUP
--                                  BY), which is also why it's the one module
--                                  fetch the frontend can skip entirely when
--                                  both of its personalizable modules are
--                                  hidden -- see src/data/hooks.ts.
--
-- Shared filter surface across all three (period aside): p_system_id,
-- p_location_id, p_severities (incident_severity[]), p_domains
-- (incident_domain[]), p_include_unclassified_domain (matches
-- reported_domain IS NULL -- "never classified", a distinct state from any
-- explicit enum value), p_confirmed_causes (incident_confirmed_cause[]),
-- p_treatment_outcomes (incident_treatment_outcome[]). The confirmed-cause/
-- treatment-outcome filters are page-wide by design: they narrow the base
-- incident set via `exists (select 1 from incident_closures ...)`, matched
-- against ANY closure cycle the incident has ever had (unbounded by period --
-- there is no coherent way to bound this inside get_incident_open_backlog,
-- which has no period parameter at all, so the same unbounded rule is used
-- consistently in all three functions rather than diverging by RPC). In
-- practice this means: an incident that is CURRENTLY open essentially never
-- matches one of these filters, because it has no incident_closures row from
-- its current (still-open) cycle -- the one narrow exception is an incident
-- reopened after an earlier full-readiness closure, which legitimately still
-- carries that earlier cycle's closure record. That is accurate, not a bug:
-- "this incident was once closed with a confirmed equipment cause, and is
-- currently open again" is meaningful information, not noise.
--
-- Security: all three follow this schema's universal RPC convention --
-- `language plpgsql stable security definer set search_path = public`, an
-- explicit `is_active_member()` guard as the first statement (never relying on
-- "RLS would have allowed it anyway" for a definer function), and an explicit
-- revoke/grant pair restricting execution to `authenticated` only (each new
-- function gets its own ACL from scratch -- grants never carry over from a
-- different function, even one of a similar name).
--
-- Median: `percentile_cont(0.5) within group (order by ...)` -- an ordered-set
-- aggregate, new to this schema (no prior use of percentile_cont anywhere).
-- Postgres supports `FILTER` on it exactly like a normal aggregate, so it
-- drops into the existing `avg(...) filter (...)` CTE shape unchanged.
--
-- No index statements in this migration -- see the plan's index-evaluation
-- section: incident_closures.confirmed_cause/treatment_outcome and
-- incidents.reported_domain are all low-cardinality enum columns where an
-- index would not measurably help a GROUP BY/broad-filter scan, and the
-- closure-insights join is already served by idx_incident_closures_incident
-- (incident_id, event_time), created by migration 0046. Indexing is deferred
-- until real EXPLAIN ANALYZE evidence justifies it, not added speculatively.

-- =====================================================================
-- 1. get_incident_analytics_v2
-- =====================================================================
create or replace function get_incident_analytics_v2(
  p_period_days int,
  p_system_id uuid default null,
  p_location_id uuid default null,
  p_severities incident_severity[] default null,
  p_domains incident_domain[] default null,
  p_include_unclassified_domain boolean default false,
  p_confirmed_causes incident_confirmed_cause[] default null,
  p_treatment_outcomes incident_treatment_outcome[] default null
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
    from incidents i
    where (p_system_id is null or i.system_id = p_system_id)
      and (p_location_id is null or i.location_id = p_location_id)
      and (p_severities is null or i.severity = any(p_severities))
      and (
        (p_domains is null and not p_include_unclassified_domain)
        or (p_domains is not null and i.reported_domain = any(p_domains))
        or (p_include_unclassified_domain and i.reported_domain is null)
      )
      and (
        (p_confirmed_causes is null and p_treatment_outcomes is null)
        or exists (
          select 1 from incident_closures ic
          where ic.incident_id = i.id
            and (p_confirmed_causes is null or ic.confirmed_cause = any(p_confirmed_causes))
            and (p_treatment_outcomes is null or ic.treatment_outcome = any(p_treatment_outcomes))
        )
      )
  ),
  scalars as (
    select
      (select count(*) from f
        where discovered_at >= v_period_start and discovered_at <= v_period_end) as opened_in_period,
      (select count(*) from f
        where closed_at is not null and closed_at >= v_period_start and closed_at <= v_period_end) as closed_in_period,
      (select percentile_cont(0.5) within group (order by extract(epoch from (closed_at - discovered_at)) / 60.0) from f
        where closed_at is not null and closed_at >= v_period_start and closed_at <= v_period_end) as median_close_minutes,
      (select avg(extract(epoch from (closed_at - discovered_at)) / 60.0) from f
        where closed_at is not null and closed_at >= v_period_start and closed_at <= v_period_end) as avg_close_minutes,
      (select count(*) from f where is_incident_open(status)) as currently_open,
      (select avg(greatest(0, extract(epoch from (now() - discovered_at)) / 60.0)) from f
        where is_incident_open(status)) as avg_open_minutes,
      (select count(distinct e.incident_id) from incident_events e join f on f.id = e.incident_id
        where e.type = 'reopened' and e.event_time >= v_period_start and e.event_time <= v_period_end) as reopened_in_period,
      -- Current-state signal (NOT period-bound, matching currently_open/
      -- avg_open_minutes above): how many currently-open incidents in the
      -- filtered set already have an external handling party recorded. This
      -- is deliberately a DIFFERENT concept from confirmed_cause = 'external'
      -- (that's a settled, period-scoped CAUSE fact from incident_closures,
      -- surfaced by get_incident_closure_insights) -- this one is "is
      -- external help currently pending on our active backlog," which
      -- external_handler_name (a plain, mutable, no-history column) can
      -- honestly answer only as a current-state question, never a historical
      -- period-scoped one.
      (select count(*) from f
        where is_incident_open(status) and external_handler_name is not null) as externally_handled_open_count
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
      percentile_cont(0.5) within group (order by extract(epoch from (f.closed_at - f.discovered_at)) / 60.0) filter (
        where f.closed_at is not null and f.closed_at >= v_period_start and f.closed_at <= v_period_end
      ) as median_close_minutes
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
        'medianCloseMinutes', median_close_minutes
      ) order by opened_in_period desc, currently_open desc, system_name asc
    ), '[]'::jsonb) as top_systems
    from top_systems_ranked
  ),
  loc_period as (
    select
      l.id as location_id,
      l.name as location_name,
      count(*) filter (
        where f.discovered_at >= v_period_start and f.discovered_at <= v_period_end
      ) as opened_in_period,
      count(*) filter (where is_incident_open(f.status)) as currently_open,
      percentile_cont(0.5) within group (order by extract(epoch from (f.closed_at - f.discovered_at)) / 60.0) filter (
        where f.closed_at is not null and f.closed_at >= v_period_start and f.closed_at <= v_period_end
      ) as median_close_minutes
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
        'medianCloseMinutes', median_close_minutes
      ) order by opened_in_period desc, currently_open desc, location_name asc
    ), '[]'::jsonb) as top_locations
    from top_locations_ranked
  )
  select jsonb_build_object(
    'openedInPeriod', scalars.opened_in_period,
    'closedInPeriod', scalars.closed_in_period,
    'medianCloseMinutes', scalars.median_close_minutes,
    'avgCloseMinutes', scalars.avg_close_minutes,
    'currentlyOpen', scalars.currently_open,
    'avgOpenMinutes', scalars.avg_open_minutes,
    'reopenedInPeriod', scalars.reopened_in_period,
    'externallyHandledOpenCount', scalars.externally_handled_open_count,
    'buckets', buckets_agg.buckets,
    'topSystems', top_systems_agg.top_systems,
    'topLocations', top_locations_agg.top_locations
  )
  into v_result
  from scalars, buckets_agg, top_systems_agg, top_locations_agg;

  return v_result;
end;
$$;

revoke execute on function public.get_incident_analytics_v2(
  int, uuid, uuid, incident_severity[], incident_domain[], boolean,
  incident_confirmed_cause[], incident_treatment_outcome[]
) from public, anon;
grant execute on function public.get_incident_analytics_v2(
  int, uuid, uuid, incident_severity[], incident_domain[], boolean,
  incident_confirmed_cause[], incident_treatment_outcome[]
) to authenticated;

-- =====================================================================
-- 2. get_incident_open_backlog -- open-incident age distribution. No
--    p_period_days: age of the CURRENT backlog is inherently not
--    period-bound, matching avgOpenMinutes' existing semantics.
-- =====================================================================
create or replace function get_incident_open_backlog(
  p_system_id uuid default null,
  p_location_id uuid default null,
  p_severities incident_severity[] default null,
  p_domains incident_domain[] default null,
  p_include_unclassified_domain boolean default false,
  p_confirmed_causes incident_confirmed_cause[] default null,
  p_treatment_outcomes incident_treatment_outcome[] default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_now timestamptz := now();
  v_result jsonb;
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;

  with f as (
    select *
    from incidents i
    where is_incident_open(i.status)
      and (p_system_id is null or i.system_id = p_system_id)
      and (p_location_id is null or i.location_id = p_location_id)
      and (p_severities is null or i.severity = any(p_severities))
      and (
        (p_domains is null and not p_include_unclassified_domain)
        or (p_domains is not null and i.reported_domain = any(p_domains))
        or (p_include_unclassified_domain and i.reported_domain is null)
      )
      and (
        (p_confirmed_causes is null and p_treatment_outcomes is null)
        or exists (
          select 1 from incident_closures ic
          where ic.incident_id = i.id
            and (p_confirmed_causes is null or ic.confirmed_cause = any(p_confirmed_causes))
            and (p_treatment_outcomes is null or ic.treatment_outcome = any(p_treatment_outcomes))
        )
      )
  ),
  ages as (
    select greatest(0, extract(epoch from (v_now - discovered_at)) / 86400.0) as age_days
    from f
  ),
  banded as (
    select
      count(*) filter (where age_days < 1) as lt_1d,
      count(*) filter (where age_days >= 1 and age_days < 3) as d1_3d,
      count(*) filter (where age_days >= 3 and age_days < 7) as d3_7d,
      count(*) filter (where age_days >= 7 and age_days < 14) as d7_14d,
      count(*) filter (where age_days >= 14) as gt_14d
    from ages
  )
  select jsonb_build_object(
    'currentlyOpen', (select count(*) from f),
    'bands', jsonb_build_array(
      jsonb_build_object('band', 'lt_1d', 'count', banded.lt_1d),
      jsonb_build_object('band', '1_3d', 'count', banded.d1_3d),
      jsonb_build_object('band', '3_7d', 'count', banded.d3_7d),
      jsonb_build_object('band', '7_14d', 'count', banded.d7_14d),
      jsonb_build_object('band', 'gt_14d', 'count', banded.gt_14d)
    )
  )
  into v_result
  from banded;

  return v_result;
end;
$$;

revoke execute on function public.get_incident_open_backlog(
  uuid, uuid, incident_severity[], incident_domain[], boolean,
  incident_confirmed_cause[], incident_treatment_outcome[]
) from public, anon;
grant execute on function public.get_incident_open_backlog(
  uuid, uuid, incident_severity[], incident_domain[], boolean,
  incident_confirmed_cause[], incident_treatment_outcome[]
) to authenticated;

-- =====================================================================
-- 3. get_incident_closure_insights -- confirmed-cause / treatment-outcome
--    breakdown, coverage figures, and closure-scoped external-involvement
--    counts. All sourced from incident_closures joined to incident_events,
--    scoped to the selected period by event_time -- never by
--    incidents.closed_at, which is never set at all for a partial-readiness
--    closure (verified directly against close_incident_impl, migration
--    0047: the partial-readiness branch updates status only, and never
--    touches closed_at).
-- =====================================================================
create or replace function get_incident_closure_insights(
  p_period_days int,
  p_system_id uuid default null,
  p_location_id uuid default null,
  p_severities incident_severity[] default null,
  p_domains incident_domain[] default null,
  p_include_unclassified_domain boolean default false,
  p_confirmed_causes incident_confirmed_cause[] default null,
  p_treatment_outcomes incident_treatment_outcome[] default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_period_start timestamptz;
  v_period_end timestamptz := now();
  v_result jsonb;
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if p_period_days is null or p_period_days not in (7, 30, 90) then
    raise exception 'validation: תקופה לא תקינה';
  end if;

  v_period_start := (
    ((now() at time zone 'Asia/Jerusalem')::date - (p_period_days - 1))::timestamp
  ) at time zone 'Asia/Jerusalem';

  with f as (
    select *
    from incidents i
    where (p_system_id is null or i.system_id = p_system_id)
      and (p_location_id is null or i.location_id = p_location_id)
      and (p_severities is null or i.severity = any(p_severities))
      and (
        (p_domains is null and not p_include_unclassified_domain)
        or (p_domains is not null and i.reported_domain = any(p_domains))
        or (p_include_unclassified_domain and i.reported_domain is null)
      )
      and (
        (p_confirmed_causes is null and p_treatment_outcomes is null)
        or exists (
          select 1 from incident_closures ic
          where ic.incident_id = i.id
            and (p_confirmed_causes is null or ic.confirmed_cause = any(p_confirmed_causes))
            and (p_treatment_outcomes is null or ic.treatment_outcome = any(p_treatment_outcomes))
        )
      )
  ),
  -- X: structured closures in period -- distinct incidents with an
  -- incident_closures row (full-readiness only, by construction of that
  -- table) whose event_time falls in the period.
  closures_in_period as (
    select ic.*
    from incident_closures ic
    join f on f.id = ic.incident_id
    where ic.event_time >= v_period_start and ic.event_time <= v_period_end
  ),
  -- Y: EVERY genuine closure action in period, full or partial-readiness,
  -- sourced from the immutable incident_events log rather than
  -- incidents.closed_at (which partial-readiness closures never set) --
  -- see the migration header and the plan's §C6 correction. Distinct
  -- incidents, not row count.
  closure_events_in_period as (
    select e.incident_id
    from incident_events e
    join f on f.id = e.incident_id
    where e.event_time >= v_period_start and e.event_time <= v_period_end
      and (
        e.type = 'closed'
        or (e.type = 'status_change' and e.field = 'status' and e.new_value = 'partial_readiness')
      )
  ),
  cause_counts as (
    select confirmed_cause, count(distinct incident_id) as n
    from closures_in_period
    group by confirmed_cause
  ),
  outcome_counts as (
    select treatment_outcome, count(distinct incident_id) as n
    from closures_in_period
    group by treatment_outcome
  )
  select jsonb_build_object(
    'structuredClosuresInPeriod', (select count(distinct incident_id) from closures_in_period),
    'totalClosureEventsInPeriod', (select count(distinct incident_id) from closure_events_in_period),
    'confirmedCauseCounts', coalesce((
      select jsonb_agg(jsonb_build_object('value', confirmed_cause, 'count', n) order by n desc, confirmed_cause asc)
      from cause_counts
    ), '[]'::jsonb),
    'treatmentOutcomeCounts', coalesce((
      select jsonb_agg(jsonb_build_object('value', treatment_outcome, 'count', n) order by n desc, treatment_outcome asc)
      from outcome_counts
    ), '[]'::jsonb),
    -- Both external-involvement counts here are closure-scoped (period-bound,
    -- from incident_closures) -- the third, current-state external count
    -- (externallyHandledOpenCount) lives in get_incident_analytics_v2
    -- instead, since it does not touch incident_closures at all. Kept as
    -- three genuinely separate concepts throughout, never merged.
    'causeExternalClosedCount', (
      select count(distinct incident_id) from closures_in_period where confirmed_cause = 'external'
    ),
    'resolutionAttributionExternalCount', (
      select count(distinct incident_id) from closures_in_period where resolution_attribution = 'external_party_no_details'
    )
  )
  into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_incident_closure_insights(
  int, uuid, uuid, incident_severity[], incident_domain[], boolean,
  incident_confirmed_cause[], incident_treatment_outcome[]
) from public, anon;
grant execute on function public.get_incident_closure_insights(
  int, uuid, uuid, incident_severity[], incident_domain[], boolean,
  incident_confirmed_cause[], incident_treatment_outcome[]
) to authenticated;
