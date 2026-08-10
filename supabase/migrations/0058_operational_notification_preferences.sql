-- AVARIA v1.6.0 -- per-user operational notification preferences.
--
-- Replaces the coarse, all-or-nothing system_admin opt-in
-- (profiles.operational_notifications_enabled, migration 0044) and the
-- narrow shift_supervisor/incident_opened-only special case (migration
-- 0057) with a single, uniform, per-event preference model for the three
-- operational roles (system_admin, professional_manager, shift_supervisor
-- -- exactly is_operational_role()'s role set).
--
-- ===== What this migration does NOT do (approved adjustments) =====
--   1. Does NOT drop profiles.operational_notifications_enabled or
--      set_my_operational_notifications_enabled(). Both are left fully
--      intact, physically -- only their EFFECT is removed:
--      notify_operational_recipients() below no longer reads the column at
--      all. The column/RPC become dead/legacy from this migration forward,
--      marked as such via `comment on`, left for a later cleanup migration
--      once this release has been verified in production. A profile that
--      still carries operational_notifications_enabled = true/false keeps
--      that value untouched (nothing here writes to it), it simply no
--      longer influences anything.
--   2. Does NOT backfill any override row from the legacy column. The
--      column's own default is false, so a stored false can never be
--      distinguished from "never configured" -- treating every existing
--      false as an explicit, preserved opt-out would misrepresent everyone
--      who simply never opened the old setting. Every existing operational
--      user (including every existing system_admin, regardless of their
--      stored operational_notifications_enabled value) starts on the new
--      v1.6 default matrix (section 2 below) with zero override rows,
--      exactly like a brand-new user -- unless/until they explicitly set a
--      per-event preference through the new RPCs.
--   3. operational_notification_defaults (section 2) is fixed product
--      policy / reference data, not administrative configuration -- no
--      admin-facing read or write RPC is added for it in this migration,
--      and none should be added later without a separate, deliberate
--      product decision.
--
-- ===== What actually changes recipient behavior =====
--   - shift_supervisor becomes a full eligible recipient for all FIVE
--     broadcast types (incident_opened/updated/closed/cancelled/reopened),
--     not just incident_opened (0057's own narrow scope is superseded) --
--     gated, like every other eligible role, by the new per-event in-app
--     preference (default: on, for all five, per the approved default
--     matrix in section 2).
--   - professional_manager keeps its current effective behavior exactly:
--     the new default matrix (in-app on for all five, Push on only for
--     incident_opened) reproduces what an unconditional PM recipient
--     already experienced today, byte for byte.
--   - system_admin's effective behavior is now driven by the SAME default
--     matrix as the other two roles (in-app on for all five, Push on only
--     for incident_opened) rather than the old single coarse boolean --
--     see adjustment 2 above for why no admin is forced into the OLD
--     opted-out state during this migration.
--
-- Explicit transaction, matching this schema's own convention for
-- multi-statement feature migrations (0016/0024/0035/0041/0042/0044/0048/
-- 0052).

begin;

-- =====================================================================
-- 1. notifications.push_eligible: resolved and stamped ONCE, at the exact
--    moment each 'update'-category row is inserted (see section 3) -- never
--    re-resolved later, and never read by anything except the dispatch
--    trigger's WHEN clause (section 4) and the Edge Function's defense-in-
--    depth re-check (application code, not this migration). Durable, like
--    every other column on this canonical table -- a later preference
--    change never rewrites an already-created row's push_eligible value,
--    exactly like category/type/text are never rewritten after the fact.
--    Always true for 'action_required' rows (mandatory, unconditional,
--    unchanged from today) -- the column is only ever meaningfully false
--    for an 'update' row whose recipient's resolved Push preference for
--    that event type was off at creation time.
-- =====================================================================
alter table public.notifications add column push_eligible boolean not null default false;

comment on column public.notifications.push_eligible is
  'Whether this specific row qualifies for Push dispatch, resolved once at INSERT time (never re-evaluated later). Always true for action_required (mandatory). For an update-category row, the recipient''s resolved per-event Push preference at the moment this row was created -- see resolve_operational_notification_prefs() and notify_operational_recipients(). Read by the dispatch trigger''s WHEN clause and the send-push-notification Edge Function''s defense-in-depth re-check; must mirror exactly, see migration 0054/0058 and dispatch.ts.';

-- Every notification that already existed before this column was added is
-- either 'action_required' (already correctly true by the column default's
-- own... no: default is false, so backfill explicitly) or a legacy
-- 'update' row whose original Push eligibility already happened (or was
-- correctly skipped) under the OLD hardcoded policy back when it was
-- created -- this column has no bearing on any row inserted before this
-- migration; it is not re-dispatched retroactively no matter its value.
-- Backfilled to true for existing 'action_required' rows purely so the
-- column's meaning ("true means Push-eligible") stays consistent for any
-- future historical read of an old row, never for a redispatch effect.
update public.notifications set push_eligible = true where category = 'action_required';

-- =====================================================================
-- 2. operational_notification_defaults: fixed, seeded-once product policy
--    -- the exact matrix from the v1.6 product spec. NOT administratively
--    configurable (approved adjustment 3): no client grant, no admin RPC.
--    Read only by resolve_operational_notification_prefs() below (a
--    SECURITY DEFINER function, which bypasses RLS as the table owner) --
--    RLS is enabled with zero policies purely for defense-in-depth
--    consistency with every other internal table in this schema, exactly
--    like push_subscriptions/push_deliveries (0053) and
--    user_analytics_preferences (0052).
-- =====================================================================
create table public.operational_notification_defaults (
  event_type public.notification_type primary key
    check (event_type in (
      'incident_opened', 'incident_updated', 'incident_closed',
      'incident_cancelled', 'incident_reopened'
    )),
  default_in_app_enabled boolean not null,
  default_push_enabled boolean not null,
  check (default_push_enabled = false or default_in_app_enabled = true)
);

comment on table public.operational_notification_defaults is
  'Fixed v1.6 product-policy default matrix for the five operational broadcast event types -- reference data, not administrator-editable configuration. The starting effective preference for every operational user (system_admin/professional_manager/shift_supervisor) who has not set an explicit override in operational_notification_preferences.';

insert into public.operational_notification_defaults
  (event_type, default_in_app_enabled, default_push_enabled) values
  ('incident_opened',    true, true),
  ('incident_updated',   true, false),
  ('incident_closed',    true, false),
  ('incident_cancelled', true, false),
  ('incident_reopened',  true, false);

alter table public.operational_notification_defaults enable row level security;
-- This harness's (and the real hosted platform's) default ACL grants ALL on
-- a new postgres-owned table to anon/authenticated/service_role
-- automatically (see supabase/tests/harness/prelude.sql) -- explicitly
-- revoke everything first, then grant back only the one narrow read
-- surface this table is meant to have, exactly like every other new table
-- in this schema (0052/0053).
revoke select, insert, update, delete on table public.operational_notification_defaults from public, anon, authenticated;
-- SELECT for `authenticated` is harmless (fixed, non-sensitive, product-
-- fixed matrix) and lets the frontend show "default" state inline if ever
-- useful, but is not required by anything in this migration -- granted for
-- read-only transparency, never write. anon gets nothing.
grant select on table public.operational_notification_defaults to authenticated;

-- =====================================================================
-- 3. operational_notification_preferences: sparse per-user override.
--    Absence of a row for (user, event_type) means "use the default row
--    above" -- exactly the same "no row = default" shape as
--    user_analytics_preferences (0052). Only ever written the moment a
--    user changes something away from their default via the RPCs below;
--    a brand-new profile, or an existing profile that has never touched
--    this feature, needs zero rows and zero migration/seeding work.
--
--    The "Push requires in-app" product rule (task spec: "receiving Push
--    for an operational event requires being subscribed to that
--    operational event") is a hard DB invariant here, not merely a UI
--    convention -- push_enabled = true with in_app_enabled = false is
--    structurally impossible to store.
-- =====================================================================
create table public.operational_notification_preferences (
  user_id uuid not null references public.profiles (id) on delete cascade,
  event_type public.notification_type not null
    references public.operational_notification_defaults (event_type),
  in_app_enabled boolean not null,
  push_enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, event_type),
  check (push_enabled = false or in_app_enabled = true)
);

comment on table public.operational_notification_preferences is
  'Sparse per-user override of operational_notification_defaults. One row per (user, event_type) the user has explicitly customized; absence of a row means "use the default". Written only by set_my_operational_notification_preference (self-only). No client SELECT/INSERT/UPDATE/DELETE policy exists -- RLS enabled with zero policies, exactly like push_subscriptions/push_deliveries (0053).';

create trigger trg_operational_notification_preferences_touch
  before update on public.operational_notification_preferences
  for each row execute function public.touch_updated_at();

alter table public.operational_notification_preferences enable row level security;
revoke select, insert, update, delete on table public.operational_notification_preferences from public, anon, authenticated;

-- =====================================================================
-- 4. resolve_operational_notification_prefs(p_user_id): the shared
--    resolver -- default row LEFT JOINed against any override, coalesced.
--    Used both by notify_operational_recipients() (server-side enforcement,
--    section 5) and get_my_operational_notification_preferences() (the
--    self-read RPC, section 6). Never client-callable directly with an
--    arbitrary p_user_id -- see the REVOKE below; the only client-facing
--    entry point is the self-only RPC in section 6, which always passes
--    auth.uid().
-- =====================================================================
create or replace function public.resolve_operational_notification_prefs(p_user_id uuid)
returns table (event_type public.notification_type, in_app_enabled boolean, push_enabled boolean)
language sql stable security definer set search_path = public as $$
  select d.event_type,
         coalesce(o.in_app_enabled, d.default_in_app_enabled),
         coalesce(o.push_enabled, d.default_push_enabled)
  from operational_notification_defaults d
  left join operational_notification_preferences o
    on o.user_id = p_user_id and o.event_type = d.event_type;
$$;

revoke execute on function public.resolve_operational_notification_prefs(uuid) from public, anon, authenticated;

-- =====================================================================
-- 5. notify_operational_recipients(): rewritten recipient policy.
--
--    OLD: three different, role-specific rules (professional_manager
--    unconditional; system_admin gated by one coarse boolean; shift_
--    supervisor gated to incident_opened only, migration 0057).
--
--    NEW: one uniform rule -- every active profile whose role is one of
--    the three operational roles (system_admin, professional_manager,
--    shift_supervisor -- exactly is_operational_role()'s set, inlined
--    here rather than called, since this function already needs a
--    per-row LATERAL join and a plain role-list check reads more directly
--    in that shape) is a CANDIDATE recipient for every event type; whether
--    a row actually gets written for a given (candidate, p_type) pair is
--    decided entirely by resolve_operational_notification_prefs()'s
--    in_app_enabled result. push_eligible is stamped from that SAME
--    resolved preference's push_enabled, in the same statement -- no
--    second lookup, no second event model, and (as documented on the
--    push_eligible column itself) durably frozen at this exact insert.
--
--    Everything else is preserved verbatim from the function's current
--    definition: actor (auth.uid()) excluded from its own broadcast,
--    dedupe_key-based ON CONFLICT DO NOTHING duplicate suppression,
--    inactive profiles excluded entirely, actor_id stamped on every row,
--    p_exclude_user_ids still honored (the existing "already got a
--    personal action_required notification for this exact operation"
--    exclusion -- untouched by this migration).
-- =====================================================================
create or replace function public.notify_operational_recipients(
  p_type public.notification_type,
  p_category public.notification_category,
  p_incident_id uuid,
  p_text text,
  p_operation_id uuid,
  p_exclude_user_ids uuid[] default '{}'::uuid[]
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, type, incident_id, text, category, dedupe_key, actor_id, push_eligible)
  select p.id, p_type, p_incident_id, p_text, p_category,
         'opn-' || p_operation_id::text || '-' || p.id::text,
         auth.uid(),
         eff.push_enabled
  from profiles p
  join lateral resolve_operational_notification_prefs(p.id) eff on eff.event_type = p_type
  where p.role in ('system_admin', 'professional_manager', 'shift_supervisor')
    and eff.in_app_enabled
    and p.active
    and p.id <> auth.uid()
    and not (p.id = any(p_exclude_user_ids))
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

revoke execute on function public.notify_operational_recipients(
  public.notification_type, public.notification_category, uuid, text, uuid, uuid[]
) from public, anon, authenticated;

-- =====================================================================
-- 6. Personal action_required notification inserts: stamped with
--    push_eligible = true, matching the mandatory/unconditional Push
--    policy for action_required that already existed before this
--    migration (see the push_eligible column's own comment, section 1) --
--    the column defaults to false, so every INSERT that does not go
--    through notify_operational_recipients (which already stamps it
--    itself, section 5) needs this explicit value or Push would silently
--    stop firing for these five personal notification types. Each
--    function below is otherwise byte-for-byte identical to its current
--    definition (create_incident_impl/update_incident/assign_incident/
--    reopen_incident: migration 0056; create_handover: migration 0044,
--    never touched by 0056) -- only the one INSERT's column list and
--    values change.
-- =====================================================================
create or replace function public.create_incident_impl(p_input jsonb, p_require_domain boolean) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v_incident incidents;
  v_operation_id uuid := gen_random_uuid();
  v_description text := nullif(trim(coalesce(p_input->>'description', '')), '');
  v_operational_impact text := nullif(trim(coalesce(p_input->>'operationalImpact', '')), '');
  v_actions_taken text := nullif(trim(coalesce(p_input->>'actionsTaken', '')), '');
  v_reported_ops reported_to_ops := (p_input->>'reportedToOps')::reported_to_ops;
  v_recipient text := case when (p_input->>'reportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'reportedToOpsRecipient', '')), '') else null end;
  v_owner_user_id_raw text := nullif(trim(coalesce(p_input->>'ownerUserId', '')), '');
  v_owner_external_name text := nullif(trim(coalesce(p_input->>'ownerExternalName', '')), '');
  v_owner_user_id uuid;
  v_reported_comms boolean := coalesce((p_input->>'reportedToComms') = 'true', false);
  v_comms_recipient text := case when coalesce((p_input->>'reportedToComms') = 'true', false)
    then nullif(trim(coalesce(p_input->>'reportedToCommsRecipient', '')), '') else null end;
  v_wisdom_reported boolean := coalesce((p_input->>'wisdomReported') = 'true', false);
  v_wisdom_number text := case when coalesce((p_input->>'wisdomReported') = 'true', false)
    then nullif(trim(coalesce(p_input->>'wisdomIncidentNumber', '')), '') else null end;
  v_new_ext_name text := nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '');
  v_new_ext_person text := nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '');
  v_new_ext_details text := nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '');
  v_user_note text := nullif(trim(coalesce(p_input->>'note', '')), '');
  v_system_name text;
  v_location_name text;
  -- Structured lifecycle classification additions.
  v_reported_domain_raw text := nullif(trim(coalesce(p_input->>'reportedDomain', '')), '');
  v_reported_domain incident_domain;
  v_initial_cause_raw text := nullif(trim(coalesce(p_input->>'initialSuspectedCause', '')), '');
  v_initial_cause incident_suspected_cause;
  v_initial_cause_other text := nullif(trim(coalesce(p_input->>'initialSuspectedCauseOtherDetail', '')), '');
  v_action_elem jsonb;
  v_action_type_raw text;
  v_action_type incident_treatment_action_type;
  v_action_other text;
  v_action_key text;
  v_seen_action_keys text[] := '{}';
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if not coalesce(is_operational_role() or my_role() = 'technician', false) then
    raise exception 'permission: אין הרשאה לפתוח תקלה';
  end if;
  if v_owner_user_id_raw is null then
    raise exception 'validation: יש לבחור בעל אחריות פנימי';
  end if;
  if v_owner_external_name is not null then
    raise exception 'validation: לא ניתן לקבוע גורם חיצוני כבעל אחריות בעת פתיחת תקלה';
  end if;
  begin
    v_owner_user_id := v_owner_user_id_raw::uuid;
  exception
    when invalid_text_representation then
      raise exception 'validation: בעל האחריות הפנימי שנבחר אינו תקין';
  end;
  perform assert_owner_valid(v_owner_user_id);
  if (p_input->>'status')::incident_status not in (
    'new', 'acknowledged', 'in_progress', 'waiting_external', 'waiting_test',
    'monitoring', 'partial_readiness', 'resolved_pending_close'
  ) then
    raise exception 'invalid_transition: סטטוס פתיחה חייב להיות סטטוס פעיל נתמך';
  end if;
  if length(p_input->>'description') > 400 then
    raise exception 'validation: תיאור התקלה: עד 400 תווים';
  end if;
  if v_description is null then
    raise exception 'validation: תיאור התקלה: שדה חובה';
  end if;
  if length(p_input->>'operationalImpact') > 400 then
    raise exception 'validation: השפעה מבצעית: עד 400 תווים';
  end if;
  if v_operational_impact is null then
    raise exception 'validation: השפעה מבצעית: שדה חובה';
  end if;
  if length(p_input->>'actionsTaken') > 600 then
    raise exception 'validation: פעולות שבוצעו עד כה: עד 600 תווים';
  end if;
  if v_actions_taken is null then
    raise exception 'validation: פעולות שבוצעו עד כה: שדה חובה';
  end if;
  if v_reported_ops = 'yes' and v_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;
  if v_reported_comms and v_comms_recipient is null then
    raise exception 'validation: יש להזין למי דווח בתקשוב למבצעים';
  end if;
  if v_wisdom_reported and v_wisdom_number is null then
    raise exception 'validation: יש להזין מספר תקלה ב-WISDOM';
  end if;
  if length(p_input->>'note') > 600 then
    raise exception 'validation: הערה נוספת: עד 600 תווים';
  end if;
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;

  -- תחום התקלה: required unconditionally when p_require_domain (the v2
  -- entry point); optional on the permissive legacy entry point, so a
  -- currently-deployed old client that never sends this key keeps working
  -- unchanged, forever.
  if v_reported_domain_raw is not null then
    begin
      v_reported_domain := v_reported_domain_raw::incident_domain;
    exception
      when invalid_text_representation then
        raise exception 'validation: תחום התקלה שנבחר אינו תקין';
    end;
  elsif p_require_domain then
    raise exception 'validation: יש לבחור תחום תקלה';
  end if;

  -- Optional initial suspected cause -- becomes the incident's first
  -- current assessment when supplied. incidents.current_suspected_cause
  -- stays NULL ("never assessed") when omitted -- never defaulted to the
  -- explicit 'unknown' enum value.
  if v_initial_cause_raw is not null then
    begin
      v_initial_cause := v_initial_cause_raw::incident_suspected_cause;
    exception
      when invalid_text_representation then
        raise exception 'validation: החשד הראשוני שנבחר אינו תקין';
    end;
    if v_initial_cause = 'other' and v_initial_cause_other is null then
      raise exception 'validation: יש לפרט את החשד הראשוני';
    end if;
    if v_initial_cause <> 'other' then
      v_initial_cause_other := null;
    end if;
  end if;

  insert into incidents (
    number, system_id, location_id, description, severity, status, operational_impact,
    owner_user_id, owner_external_name, discovered_at, created_by, updated_by,
    next_update_due, no_deadline_reason, reported_to_ops, reported_to_ops_recipient,
    reported_to_comms, reported_to_comms_recipient, wisdom_reported, wisdom_incident_number,
    external_handler_name, external_handler_contact_person, external_handler_contact_details,
    reported_domain, current_suspected_cause, current_suspected_cause_other_detail
  ) values (
    allocate_incident_number(),
    (p_input->>'systemId')::uuid,
    (p_input->>'locationId')::uuid,
    v_description,
    (p_input->>'severity')::incident_severity,
    (p_input->>'status')::incident_status,
    v_operational_impact,
    v_owner_user_id,
    v_owner_external_name,
    (p_input->>'discoveredAt')::timestamptz,
    auth.uid(), auth.uid(),
    (p_input->>'nextUpdateDue')::timestamptz,
    nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), ''),
    v_reported_ops, v_recipient,
    v_reported_comms, v_comms_recipient, v_wisdom_reported, v_wisdom_number,
    v_new_ext_name, v_new_ext_person, v_new_ext_details,
    v_reported_domain, v_initial_cause, v_initial_cause_other
  ) returning * into v_incident;

  insert into incident_events (incident_id, type, actor_id, event_time, note, user_note, operation_id)
  values (v_incident.id, 'created', auth.uid(), v_incident.discovered_at,
    'פעולות שבוצעו עד כה: ' || v_actions_taken ||
    E'\nתקשוב למבצעים: ' || (case when v_reported_comms then 'כן (דווח ל: ' || v_comms_recipient || ')' else 'לא' end) ||
    E'\nWISDOM: ' || (case when v_wisdom_reported then 'כן (מספר תקלה: ' || v_wisdom_number || ')' else 'לא' end),
    v_user_note,
    v_operation_id);
  if v_incident.status <> 'new' then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (v_incident.id, 'status_change', auth.uid(), 'status', 'new', v_incident.status::text,
            v_incident.discovered_at, v_operation_id);
  end if;
  if v_recipient is not null then
    insert into incident_events (incident_id, type, actor_id, field, new_value, note, event_time, operation_id)
    values (v_incident.id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient', v_recipient,
            'דווח למבצעים: ' || v_recipient, v_incident.discovered_at, v_operation_id);
  end if;

  -- Initial suspected-cause history row. No dedicated 'cause_assessment_
  -- changed' event is written for this one: that event type is reserved
  -- for changes made through an update, which always carry a real
  -- effective event_time -- the initial assessment has none (see the
  -- incident_cause_assessments.event_time column comment, 0046). The
  -- Timeline instead renders it inline on this 'created' card by joining
  -- on operation_id (see frontend Timeline.tsx).
  if v_initial_cause is not null then
    insert into incident_cause_assessments (incident_id, cause, other_detail, cycle_number, recorded_by, event_time, operation_id)
    values (v_incident.id, v_initial_cause, v_initial_cause_other, 0, auth.uid(), null, v_operation_id);
  end if;

  -- Optional initial treatment actions -- same NULL-event_time reasoning.
  -- Identical (actionType, otherDetail) entries within this ONE submitted
  -- array are de-duplicated (never inserted twice for one operation); the
  -- same action type recorded again in a later, separate update/closure
  -- is a normal, distinct row.
  for v_action_elem in select value from jsonb_array_elements(coalesce(p_input->'initialTreatmentActions', '[]'::jsonb))
  loop
    v_action_type_raw := nullif(trim(coalesce(v_action_elem->>'actionType', '')), '');
    if v_action_type_raw is null then
      raise exception 'validation: סוג הפעולה נדרש';
    end if;
    begin
      v_action_type := v_action_type_raw::incident_treatment_action_type;
    exception
      when invalid_text_representation then
        raise exception 'validation: סוג הפעולה שנבחר אינו תקין';
    end;
    v_action_other := nullif(trim(coalesce(v_action_elem->>'otherDetail', '')), '');
    if v_action_type = 'other' and v_action_other is null then
      raise exception 'validation: יש לפרט את הפעולה';
    end if;
    if v_action_type <> 'other' then
      v_action_other := null;
    end if;
    v_action_key := v_action_type::text || '|' || coalesce(v_action_other, '');
    if v_action_key = any(v_seen_action_keys) then
      continue;
    end if;
    v_seen_action_keys := array_append(v_seen_action_keys, v_action_key);
    insert into incident_treatment_actions (incident_id, action_type, other_detail, cycle_number, event_time, recorded_by, operation_id)
    values (v_incident.id, v_action_type, v_action_other, 0, null, auth.uid(), v_operation_id);
  end loop;

  perform write_audit(
    p_action => 'incident_created', p_entity_type => 'incident', p_entity_id => v_incident.id::text,
    p_incident_number => v_incident.number,
    p_after => jsonb_build_object('severity', v_incident.severity, 'status', v_incident.status),
    p_entity_label => v_incident.number
  );

  if v_incident.owner_user_id is not null and v_incident.owner_user_id <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text, category, dedupe_key, actor_id, push_eligible)
    values (v_incident.owner_user_id, 'incident_assigned', v_incident.id,
            'תקלה ' || v_incident.number || ' הוקצתה אליך.', 'action_required', 'assign-' || v_incident.id || '-create', auth.uid(), true)
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;

  select name into v_system_name from systems where id = v_incident.system_id;
  select name into v_location_name from locations where id = v_incident.location_id;
  perform notify_operational_recipients(
    'incident_opened', 'update', v_incident.id,
    'נפתחה תקלה ' || v_incident.number || ' · ' || coalesce(v_system_name, '') || ' · ' || coalesce(v_location_name, ''),
    v_operation_id,
    case when v_incident.owner_user_id is not null then array[v_incident.owner_user_id] else '{}'::uuid[] end
  );
  return v_incident;
end;
$$;

create or replace function public.update_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_update_id uuid;
  v_operation_id uuid := gen_random_uuid();
  v_new_status incident_status := (p_input->>'status')::incident_status;
  v_new_severity incident_severity := (p_input->>'severity')::incident_severity;
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
  v_due_provided boolean := p_input ? 'nextUpdateDue';
  v_reason_provided boolean := p_input ? 'noDeadlineReason';
  v_impact_provided boolean := p_input ? 'operationalImpact';
  v_new_due timestamptz;
  v_new_reason text;
  v_new_impact text;
  v_old_owner_label text;
  v_new_owner_label text;
  v_old_ext_name text;
  v_old_ext_person text;
  v_old_ext_details text;
  v_ext_name_provided boolean := p_input ? 'externalHandlerName';
  v_ext_person_provided boolean := p_input ? 'externalHandlerContactPerson';
  v_ext_details_provided boolean := p_input ? 'externalHandlerContactDetails';
  v_new_ext_name text;
  v_new_ext_person text;
  v_new_ext_details text;
  v_update_reported_to_ops reported_to_ops := case when p_input ? 'updateReportedToOps'
    then nullif(p_input->>'updateReportedToOps', '')::reported_to_ops else null end;
  v_update_reported_to_ops_recipient text := case when (p_input->>'updateReportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'updateReportedToOpsRecipient', '')), '') else null end;
  v_update_reported_to_comms boolean := case when p_input ? 'updateReportedToComms'
    then (p_input->>'updateReportedToComms') = 'yes' else null end;
  v_update_reported_to_comms_recipient text := case when (p_input->>'updateReportedToComms') = 'yes'
    then nullif(trim(coalesce(p_input->>'updateReportedToCommsRecipient', '')), '') else null end;
  v_update_wisdom_reported boolean := case when p_input ? 'updateWisdomReported'
    then (p_input->>'updateWisdomReported') = 'yes' else null end;
  v_event_time_raw text := nullif(trim(coalesce(p_input->>'eventTime', '')), '');
  v_event_time timestamptz;
  v_user_note text := nullif(trim(coalesce(p_input->>'note', '')), '');
  v_impact_changed boolean := false;
  v_due_changed boolean := false;
  v_old_impact text;
  v_old_due timestamptz;
  v_owner_changed boolean := false;
  v_actor_name text;
  -- Structured lifecycle classification additions.
  v_suspected_cause_provided boolean := p_input ? 'suspectedCause';
  v_new_suspected_cause_raw text := nullif(trim(coalesce(p_input->>'suspectedCause', '')), '');
  v_new_suspected_cause incident_suspected_cause;
  v_new_suspected_cause_other text := nullif(trim(coalesce(p_input->>'suspectedCauseOtherDetail', '')), '');
  v_cause_changed boolean := false;
  v_action_elem jsonb;
  v_action_type_raw text;
  v_action_type incident_treatment_action_type;
  v_action_other text;
  v_action_key text;
  v_seen_action_keys text[] := '{}';
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה לעדכן תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  v_old_ext_name := v.external_handler_name;
  v_old_ext_person := v.external_handler_contact_person;
  v_old_ext_details := v.external_handler_contact_details;
  v_new_ext_name := case when v_ext_name_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '') else v_old_ext_name end;
  v_new_ext_person := case when v_ext_person_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '') else v_old_ext_person end;
  v_new_ext_details := case when v_ext_details_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '') else v_old_ext_details end;
  v_new_due := case when v_due_provided then (p_input->>'nextUpdateDue')::timestamptz else v.next_update_due end;
  v_new_reason := case when v_reason_provided then nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), '') else v.no_deadline_reason end;
  v_new_impact := case when v_impact_provided then trim(p_input->>'operationalImpact') else v.operational_impact end;
  if is_incident_terminal(v.status) then
    raise exception 'invalid_transition: תקלה סגורה או מבוטלת אינה ניתנת לעדכון';
  end if;
  if not is_valid_transition(v.status, v_new_status) then
    raise exception 'invalid_transition: מעבר הסטטוס אינו מותר';
  end if;
  if v_event_time_raw is null then
    raise exception 'validation: יש להזין מועד עדכון בפועל';
  end if;
  begin
    v_event_time := v_event_time_raw::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then
      raise exception 'validation: מועד העדכון בפועל אינו תקין';
  end;
  if v_event_time < v.discovered_at or v_event_time > now() + interval '5 minutes' then
    raise exception 'validation: מועד העדכון בפועל אינו תקין';
  end if;
  if v_new_owner is null then
    raise exception 'validation: יש לבחור בעל אחריות פנימי';
  end if;
  perform assert_owner_valid(v_new_owner);
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;
  if v_update_reported_to_ops = 'yes' and v_update_reported_to_ops_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;
  if v_update_reported_to_comms is true and v_update_reported_to_comms_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;
  if length(p_input->>'note') > 600 then
    raise exception 'validation: הערה נוספת: עד 600 תווים';
  end if;

  -- Optional current-suspected-cause change -- omitted key means
  -- "untouched" (no reconfirmation demanded on every update); a
  -- resubmission of the SAME value writes no history row and no event.
  if v_suspected_cause_provided then
    if v_new_suspected_cause_raw is null then
      raise exception 'validation: יש לבחור חשד נוכחי';
    end if;
    begin
      v_new_suspected_cause := v_new_suspected_cause_raw::incident_suspected_cause;
    exception
      when invalid_text_representation then
        raise exception 'validation: החשד הנוכחי שנבחר אינו תקין';
    end;
    if v_new_suspected_cause = 'other' and v_new_suspected_cause_other is null then
      raise exception 'validation: יש לפרט את החשד הנוכחי';
    end if;
    if v_new_suspected_cause <> 'other' then
      v_new_suspected_cause_other := null;
    end if;
    v_cause_changed := v_new_suspected_cause is distinct from v.current_suspected_cause
      or v_new_suspected_cause_other is distinct from v.current_suspected_cause_other_detail;
  end if;

  insert into incident_updates (
    incident_id, author_id, event_time, actions_taken, findings, next_steps, current_status_text,
    update_reported_to_ops, update_reported_to_ops_recipient,
    update_reported_to_comms, update_reported_to_comms_recipient,
    update_wisdom_reported, user_note
  )
  values (p_incident_id, auth.uid(), v_event_time,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''),
          nullif(trim(coalesce(p_input->>'currentStatusText', '')), ''),
          v_update_reported_to_ops, v_update_reported_to_ops_recipient,
          v_update_reported_to_comms, v_update_reported_to_comms_recipient,
          v_update_wisdom_reported, v_user_note)
  returning id into v_update_id;
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id, operation_id)
  values (p_incident_id, 'update', auth.uid(), v_event_time, v_update_id, v_operation_id);

  -- Cause-assessment history + timeline event, only on a genuine change.
  if v_cause_changed then
    insert into incident_cause_assessments (incident_id, cause, other_detail, cycle_number, recorded_by, event_time, operation_id)
    values (p_incident_id, v_new_suspected_cause, v_new_suspected_cause_other, v.reopen_count, auth.uid(), v_event_time, v_operation_id);
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'cause_assessment_changed', auth.uid(), 'current_suspected_cause',
            coalesce(v.current_suspected_cause::text, ''), v_new_suspected_cause::text, v_event_time, v_operation_id);
  end if;

  -- Cumulative structured treatment actions performed in this update --
  -- never replaces the required free-text actionsTaken above. Identical
  -- (actionType, otherDetail) entries within this ONE submitted array are
  -- de-duplicated; the same action type recorded again in a later,
  -- separate update remains a normal, distinct row.
  for v_action_elem in select value from jsonb_array_elements(coalesce(p_input->'treatmentActions', '[]'::jsonb))
  loop
    v_action_type_raw := nullif(trim(coalesce(v_action_elem->>'actionType', '')), '');
    if v_action_type_raw is null then
      raise exception 'validation: סוג הפעולה נדרש';
    end if;
    begin
      v_action_type := v_action_type_raw::incident_treatment_action_type;
    exception
      when invalid_text_representation then
        raise exception 'validation: סוג הפעולה שנבחר אינו תקין';
    end;
    v_action_other := nullif(trim(coalesce(v_action_elem->>'otherDetail', '')), '');
    if v_action_type = 'other' and v_action_other is null then
      raise exception 'validation: יש לפרט את הפעולה';
    end if;
    if v_action_type <> 'other' then
      v_action_other := null;
    end if;
    v_action_key := v_action_type::text || '|' || coalesce(v_action_other, '');
    if v_action_key = any(v_seen_action_keys) then
      continue;
    end if;
    v_seen_action_keys := array_append(v_seen_action_keys, v_action_key);
    insert into incident_treatment_actions (incident_id, action_type, other_detail, cycle_number, event_time, recorded_by, operation_id)
    values (p_incident_id, v_action_type, v_action_other, v.reopen_count, v_event_time, auth.uid(), v_operation_id);
  end loop;

  if v_impact_provided and v_new_impact is distinct from v.operational_impact then
    v_impact_changed := true;
    v_old_impact := v.operational_impact;
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'impact_change', auth.uid(), 'operational_impact',
            v.operational_impact, v_new_impact, v_event_time, v_operation_id);
  end if;
  if v_new_status <> v.status then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'status_change', auth.uid(), 'status', v.status::text, v_new_status::text,
            nullif(trim(coalesce(p_input->>'changeReason', '')), ''), v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_status_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('status', v.status), p_after => jsonb_build_object('status', v_new_status),
      p_entity_label => v.number
    );
  end if;
  if v_new_severity <> v.severity then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'severity_change', auth.uid(), 'severity', v.severity::text, v_new_severity::text,
            nullif(trim(coalesce(p_input->>'changeReason', '')), ''), v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_severity_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('severity', v.severity), p_after => jsonb_build_object('severity', v_new_severity),
      p_entity_label => v.number
    );
  end if;
  if v_new_owner::text <> coalesce(v.owner_user_id::text, '') then
    v_owner_changed := true;
    select coalesce((select full_name from profiles where id = v.owner_user_id), v.owner_external_name, 'ללא') into v_old_owner_label;
    select full_name into v_new_owner_label from profiles where id = v_new_owner;
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_owner_label, v_new_owner_label,
            v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_assigned', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('owner', v_old_owner_label), p_after => jsonb_build_object('owner', v_new_owner_label),
      p_entity_label => v.number
    );
    if v_new_owner <> auth.uid() then
      insert into notifications (user_id, type, incident_id, text, category, actor_id, push_eligible)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.', 'action_required', auth.uid(), true);
    end if;
  end if;
  if v_new_ext_name is distinct from v_old_ext_name
     or v_new_ext_person is distinct from v_old_ext_person
     or v_new_ext_details is distinct from v_old_ext_details then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
            format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
            format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
            v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_external_handler_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object(
        'externalHandlerName', v_old_ext_name, 'externalHandlerContactPerson', v_old_ext_person,
        'externalHandlerContactDetails', v_old_ext_details),
      p_after => jsonb_build_object(
        'externalHandlerName', v_new_ext_name, 'externalHandlerContactPerson', v_new_ext_person,
        'externalHandlerContactDetails', v_new_ext_details),
      p_entity_label => v.number
    );
  end if;
  if coalesce(v_new_due, 'epoch'::timestamptz) <> coalesce(v.next_update_due, 'epoch'::timestamptz) then
    v_due_changed := true;
    v_old_due := v.next_update_due;
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'deadline_change', auth.uid(), 'next_update_due',
            v.next_update_due::text, v_new_due::text,
            case when v_new_due is null then 'ללא צפי כרגע: ' || coalesce(v_new_reason, '') end,
            v_event_time, v_operation_id);
  end if;

  update incidents set
    status = v_new_status,
    severity = v_new_severity,
    operational_impact = v_new_impact,
    owner_user_id = v_new_owner,
    external_handler_name = v_new_ext_name,
    external_handler_contact_person = v_new_ext_person,
    external_handler_contact_details = v_new_ext_details,
    next_update_due = v_new_due,
    no_deadline_reason = v_new_reason,
    current_suspected_cause = case when v_suspected_cause_provided then v_new_suspected_cause else v.current_suspected_cause end,
    current_suspected_cause_other_detail = case when v_suspected_cause_provided then v_new_suspected_cause_other else v.current_suspected_cause_other_detail end,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  if v_impact_changed or v_due_changed then
    perform write_audit(
      p_action => 'incident_updated', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => (case when v_impact_changed then jsonb_build_object('operationalImpact', v_old_impact) else '{}'::jsonb end)
        || (case when v_due_changed then jsonb_build_object('nextUpdateDue', v_old_due) else '{}'::jsonb end),
      p_after => (case when v_impact_changed then jsonb_build_object('operationalImpact', v_new_impact) else '{}'::jsonb end)
        || (case when v_due_changed then jsonb_build_object('nextUpdateDue', v_new_due) else '{}'::jsonb end),
      p_entity_label => v.number
    );
  end if;

  select full_name into v_actor_name from profiles where id = auth.uid();
  perform notify_operational_recipients(
    'incident_updated', 'update', p_incident_id,
    'נוסף עדכון לתקלה ' || v.number || ' על ידי ' || coalesce(v_actor_name, 'משתמש'),
    v_operation_id,
    case when v_owner_changed then array[v_new_owner] else '{}'::uuid[] end
  );
  return v;
end;
$$;

create or replace function public.assign_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
  v_old_label text;
  v_new_label text;
  v_old_ext_name text;
  v_old_ext_person text;
  v_old_ext_details text;
  v_ext_name_provided boolean := p_input ? 'externalHandlerName';
  v_ext_person_provided boolean := p_input ? 'externalHandlerContactPerson';
  v_ext_details_provided boolean := p_input ? 'externalHandlerContactDetails';
  v_new_ext_name text;
  v_new_ext_person text;
  v_new_ext_details text;
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if not coalesce(is_operational_role() or my_role() = 'technician', false) then
    raise exception 'permission: אין הרשאה לשנות גורם מטפל';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  v_old_ext_name := v.external_handler_name;
  v_old_ext_person := v.external_handler_contact_person;
  v_old_ext_details := v.external_handler_contact_details;
  v_new_ext_name := case when v_ext_name_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '') else v_old_ext_name end;
  v_new_ext_person := case when v_ext_person_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '') else v_old_ext_person end;
  v_new_ext_details := case when v_ext_details_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '') else v_old_ext_details end;
  if is_incident_terminal(v.status) then
    raise exception 'invalid_transition: לא ניתן לשנות גורם מטפל בתקלה סגורה או מבוטלת';
  end if;
  if v_new_owner is null then
    raise exception 'validation: יש לבחור בעל אחריות פנימי';
  end if;
  perform assert_owner_valid(v_new_owner);
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;

  if v_new_owner is distinct from v.owner_user_id then
    select coalesce((select full_name from profiles where id = v.owner_user_id), v.owner_external_name, 'ללא') into v_old_label;
    select full_name into v_new_label from profiles where id = v_new_owner;

    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_label, v_new_label,
            nullif(trim(coalesce(p_input->>'note', '')), ''), v_operation_id);
    perform write_audit(
      p_action => 'incident_assigned', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('owner', v_old_label), p_after => jsonb_build_object('owner', v_new_label),
      p_entity_label => v.number
    );
    if v_new_owner <> auth.uid() then
      insert into notifications (user_id, type, incident_id, text, category, actor_id, push_eligible)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.', 'action_required', auth.uid(), true);
    end if;
  end if;
  if v_new_ext_name is distinct from v_old_ext_name
     or v_new_ext_person is distinct from v_old_ext_person
     or v_new_ext_details is distinct from v_old_ext_details then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
            format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
            format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
            v_operation_id);
    perform write_audit(
      p_action => 'incident_external_handler_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object(
        'externalHandlerName', v_old_ext_name, 'externalHandlerContactPerson', v_old_ext_person,
        'externalHandlerContactDetails', v_old_ext_details),
      p_after => jsonb_build_object(
        'externalHandlerName', v_new_ext_name, 'externalHandlerContactPerson', v_new_ext_person,
        'externalHandlerContactDetails', v_new_ext_details),
      p_entity_label => v.number
    );
  end if;

  update incidents set
    owner_user_id = v_new_owner,
    external_handler_name = v_new_ext_name,
    external_handler_contact_person = v_new_ext_person,
    external_handler_contact_details = v_new_ext_details,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;
  return v;
end;
$$;

create or replace function public.reopen_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
  v_role app_role := my_role();
  v_allow_supervisor boolean := coalesce((select value::text = 'true' from app_policy where key = 'allow_supervisor_reopen'), false);
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
  v_due_provided boolean := p_input ? 'nextUpdateDue';
  v_reason_provided boolean := p_input ? 'noDeadlineReason';
  v_new_due timestamptz;
  v_new_reason text;
  v_old_ext_name text;
  v_old_ext_person text;
  v_old_ext_details text;
  v_ext_name_provided boolean := p_input ? 'externalHandlerName';
  v_ext_person_provided boolean := p_input ? 'externalHandlerContactPerson';
  v_ext_details_provided boolean := p_input ? 'externalHandlerContactDetails';
  v_new_ext_name text;
  v_new_ext_person text;
  v_new_ext_details text;
begin
  if not (v_role in ('system_admin', 'professional_manager') or (v_role = 'shift_supervisor' and v_allow_supervisor)) then
    raise exception 'permission: אין הרשאה לפתוח מחדש תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  v_old_ext_name := v.external_handler_name;
  v_old_ext_person := v.external_handler_contact_person;
  v_old_ext_details := v.external_handler_contact_details;
  v_new_ext_name := case when v_ext_name_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '') else v_old_ext_name end;
  v_new_ext_person := case when v_ext_person_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '') else v_old_ext_person end;
  v_new_ext_details := case when v_ext_details_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '') else v_old_ext_details end;
  v_new_due := case when v_due_provided then (p_input->>'nextUpdateDue')::timestamptz else v.next_update_due end;
  v_new_reason := case when v_reason_provided then nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), '') else v.no_deadline_reason end;
  if v.status <> 'closed' then
    raise exception 'invalid_transition: ניתן לפתוח מחדש רק תקלה סגורה';
  end if;
  if length(trim(coalesce(p_input->>'reason', ''))) = 0 then
    raise exception 'validation: יש להזין סיבה לפתיחה מחדש';
  end if;
  if v_new_owner is null then
    raise exception 'validation: יש לבחור בעל אחריות פנימי';
  end if;
  perform assert_owner_valid(v_new_owner);
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;

  insert into incident_events (incident_id, type, actor_id, old_value, new_value, note, operation_id)
  values (p_incident_id, 'reopened', auth.uid(), 'closed', 'reopened', trim(p_input->>'reason'), v_operation_id);
  perform write_audit(
    p_action => 'incident_reopened', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
    p_incident_number => v.number,
    p_before => jsonb_build_object('status', 'closed'), p_after => jsonb_build_object('status', 'reopened'),
    p_entity_label => v.number, p_summary => trim(p_input->>'reason')
  );
  if v_new_ext_name is distinct from v_old_ext_name
     or v_new_ext_person is distinct from v_old_ext_person
     or v_new_ext_details is distinct from v_old_ext_details then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
            format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
            format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
            v_operation_id);
    perform write_audit(
      p_action => 'incident_external_handler_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object(
        'externalHandlerName', v_old_ext_name, 'externalHandlerContactPerson', v_old_ext_person,
        'externalHandlerContactDetails', v_old_ext_details),
      p_after => jsonb_build_object(
        'externalHandlerName', v_new_ext_name, 'externalHandlerContactPerson', v_new_ext_person,
        'externalHandlerContactDetails', v_new_ext_details),
      p_entity_label => v.number
    );
  end if;

  update incidents set
    status = 'reopened',
    owner_user_id = v_new_owner,
    external_handler_name = v_new_ext_name,
    external_handler_contact_person = v_new_ext_person,
    external_handler_contact_details = v_new_ext_details,
    next_update_due = v_new_due,
    no_deadline_reason = v_new_reason,
    closed_at = null, closed_by = null,
    follow_up_required = false, follow_up_completed_at = null, follow_up_completed_by = null,
    current_suspected_cause = null, current_suspected_cause_other_detail = null,
    reopen_count = reopen_count + 1,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  if v.owner_user_id is not null and v.owner_user_id <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text, category, actor_id, push_eligible)
    values (v.owner_user_id, 'incident_reopened', p_incident_id,
            'תקלה ' || v.number || ' נפתחה מחדש והוקצתה אליך.', 'action_required', auth.uid(), true);
  end if;

  perform notify_operational_recipients(
    'incident_reopened', 'update', p_incident_id,
    'תקלה ' || v.number || ' נפתחה מחדש',
    v_operation_id,
    case when v.owner_user_id is not null then array[v.owner_user_id] else '{}'::uuid[] end
  );
  return v;
end;
$$;

create or replace function public.create_handover(p_input jsonb) returns handovers
language plpgsql security definer set search_path = public as $$
declare
  v handovers;
  v_operation_id uuid := gen_random_uuid();
  v_to uuid := (p_input->>'toUserId')::uuid;
  r record;
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה ליצור העברת משמרת';
  end if;
  if v_to = auth.uid() then
    raise exception 'validation: לא ניתן להעביר משמרת לעצמך';
  end if;
  perform assert_owner_valid(v_to);

  insert into handovers (created_by, to_user_id, general_note)
  values (auth.uid(), v_to, trim(coalesce(p_input->>'generalNote', '')))
  returning * into v;

  for r in
    select i.*, s.name as system_name, l.name as location_name,
      coalesce(p.full_name, i.owner_external_name, 'ללא') as owner_label,
      lu.actions_taken as last_action, lu.next_steps as last_next_steps
    from incidents i
    join systems s on s.id = i.system_id
    join locations l on l.id = i.location_id
    left join profiles p on p.id = i.owner_user_id
    left join lateral (
      select actions_taken, next_steps from incident_updates u
      where u.incident_id = i.id order by u.event_time desc limit 1
    ) lu on true
    where is_incident_open(i.status) or (i.follow_up_required and i.follow_up_completed_at is null)
  loop
    insert into handover_items (
      handover_id, incident_id, note, snapshot_number, snapshot_status, snapshot_severity,
      snapshot_owner_label, snapshot_system_name, snapshot_location_name, snapshot_impact,
      snapshot_last_action, snapshot_next_steps, snapshot_next_update_due
    ) values (
      v.id, r.id, coalesce(p_input->'itemNotes'->>(r.id::text), ''), r.number, r.status, r.severity,
      r.owner_label, r.system_name, r.location_name, r.operational_impact,
      coalesce(r.last_action, ''), coalesce(r.last_next_steps, ''), r.next_update_due
    );
    insert into incident_events (incident_id, type, actor_id, ref_id, operation_id)
    values (r.id, 'handover_included', auth.uid(), v.id, v_operation_id);
  end loop;

  insert into notifications (user_id, type, handover_id, text, category, dedupe_key, push_eligible)
  values (v_to, 'handover_pending', v.id,
          'העברת משמרת ממתינה לאישורך.', 'action_required', 'handover-' || v.id, true)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  perform write_audit('handover_created', 'handover', v.id::text);
  return v;
end;
$$;

-- =====================================================================
-- 7. Self-service preference RPCs -- the ONLY client-facing entry points
--    to this feature. Same defense-in-depth authorization shape already
--    used throughout this schema (0037/0038/0042/0044/0047/0052):
--    is_active_member() checked FIRST (never returns NULL), narrower role
--    check wrapped in coalesce(..., false) second, since my_role()/
--    is_operational_role() return NULL (not false) for an inactive or
--    profile-less identity and `if not (NULL)` in plpgsql silently fails
--    OPEN otherwise (the exact footgun 0037 already documented).
-- =====================================================================

-- 6a. Read: the caller's own FULL effective set (all five event types,
--     always five rows -- defaults merged with any override), never
--     another user's. Available to any active operational-role user, not
--     system_admin-only like the legacy RPC -- this is the whole point of
--     widening the feature to all three roles.
create or replace function public.get_my_operational_notification_preferences()
returns table (event_type public.notification_type, in_app_enabled boolean, push_enabled boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if not coalesce(is_operational_role(), false) then
    raise exception 'permission: ההעדפה זמינה לתפקידים תפעוליים בלבד';
  end if;
  return query select * from resolve_operational_notification_prefs(auth.uid());
end;
$$;

revoke execute on function public.get_my_operational_notification_preferences() from public, anon;
grant execute on function public.get_my_operational_notification_preferences() to authenticated;

-- 6b. Write: upserts exactly one (auth.uid(), p_event_type) override row.
--     p_event_type is validated against the fixed five operational types
--     (the FK to operational_notification_defaults already enforces this
--     at the storage layer; the explicit check here raises the same
--     'validation:'-prefixed controlled error this schema uses elsewhere,
--     instead of surfacing a raw FK-violation message to the client).
--     p_push_enabled is silently normalized to false whenever
--     p_in_app_enabled is false, mirroring the UI's own behavior (turning
--     an event off also turns its Push off) rather than raising -- the
--     CHECK constraint on the table is the actual, unbypassable
--     enforcement; this normalization just avoids a needless round-trip
--     error for the one client-shaped input the UI itself never sends.
--     Returns the caller's full, freshly-resolved five-row set so the
--     frontend can refresh its cache from a single round trip, exactly
--     like set_my_operational_notifications_enabled already returns the
--     caller's updated profile row.
create or replace function public.set_my_operational_notification_preference(
  p_event_type public.notification_type,
  p_in_app_enabled boolean,
  p_push_enabled boolean
) returns table (event_type public.notification_type, in_app_enabled boolean, push_enabled boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_push_enabled boolean := p_in_app_enabled and p_push_enabled;
begin
  -- The RETURNS TABLE clause above implicitly declares OUT variables named
  -- event_type/in_app_enabled/push_enabled, which otherwise collide with
  -- operational_notification_preferences' own identically-named columns
  -- inside this function's INSERT ... ON CONFLICT (a conflict target list
  -- accepts only bare, unqualified column names, so it cannot be
  -- disambiguated by table-qualifying the reference) -- `#variable_conflict
  -- use_column` resolves every such ambiguity in favor of the table column
  -- throughout this function's body, which is what every SQL statement
  -- below actually intends.
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if not coalesce(is_operational_role(), false) then
    raise exception 'permission: ההעדפה זמינה לתפקידים תפעוליים בלבד';
  end if;
  if p_event_type not in (
    'incident_opened', 'incident_updated', 'incident_closed', 'incident_cancelled', 'incident_reopened'
  ) then
    raise exception 'validation: סוג האירוע אינו נתמך להעדפה תפעולית';
  end if;

  insert into operational_notification_preferences (user_id, event_type, in_app_enabled, push_enabled)
  values (auth.uid(), p_event_type, p_in_app_enabled, v_push_enabled)
  on conflict (user_id, event_type) do update
    set in_app_enabled = excluded.in_app_enabled,
        push_enabled = excluded.push_enabled,
        updated_at = now();

  return query select * from resolve_operational_notification_prefs(auth.uid());
end;
$$;

revoke execute on function public.set_my_operational_notification_preference(public.notification_type, boolean, boolean) from public, anon;
grant execute on function public.set_my_operational_notification_preference(public.notification_type, boolean, boolean) to authenticated;

-- =====================================================================
-- 8. Dispatch trigger WHEN clause: updated to match the new push_eligible
--    column instead of the old hardcoded "type = 'incident_opened'" test.
--    Postgres trigger WHEN clauses cannot contain a subquery (so it could
--    never join a preferences table live) -- resolving push_eligible once
--    at INSERT time (section 5) and stamping it directly on NEW is what
--    keeps this a plain, allowed column comparison. Every routine 'update'
--    row whose recipient's resolved Push preference was off at creation
--    time still never even enters dispatch_push_notification()'s body,
--    exactly like today's exclusion of incident_updated/closed/cancelled.
--    dispatch_push_notification() itself (migration 0054/0055) is
--    completely unchanged -- only the trigger definition's WHEN clause
--    moves. DROP + CREATE (not CREATE OR REPLACE TRIGGER) for maximum
--    compatibility with whatever Postgres version the target database
--    runs, matching this migration's general conservatism.
-- =====================================================================
drop trigger if exists trg_notifications_push_dispatch on public.notifications;

create trigger trg_notifications_push_dispatch
  after insert on public.notifications
  for each row
  when (
    new.category = 'action_required'
    or (new.category = 'update' and new.push_eligible)
  )
  execute function public.dispatch_push_notification();

-- =====================================================================
-- 9. Legacy operational_notifications_enabled column / RPC: left fully
--    intact (approved adjustment 1) -- no ALTER, no DROP, no REVOKE
--    change here. Marked as deprecated via comment only, so a future
--    cleanup migration (after this release is verified in production) has
--    a single, unambiguous place documenting why the column/RPC are still
--    present but inert.
-- =====================================================================
comment on column public.profiles.operational_notifications_enabled is
  'DEPRECATED as of v1.6.0 (migration 0058) -- superseded by operational_notification_preferences / operational_notification_defaults. No longer read by notify_operational_recipients() or anything else; kept only for a later cleanup migration after production verification. Do not use in new code.';

comment on function public.set_my_operational_notifications_enabled(boolean) is
  'DEPRECATED as of v1.6.0 (migration 0058) -- superseded by set_my_operational_notification_preference(). Still callable and still writes profiles.operational_notifications_enabled, but that column no longer affects notification generation. Kept only for a later cleanup migration after production verification. Do not call from new code.';

commit;
