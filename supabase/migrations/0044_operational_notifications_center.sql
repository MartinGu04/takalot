-- AVARIA — operational notifications center (file 2 of 2): usage.
--
-- Builds on 0043's already-committed enum expansion (notification_type's
-- four new values, and the new notification_category type) to add
-- role-based operational notifications, alongside the existing personal
-- ("action required") notifications, without changing any existing RPC's
-- public signature.
--
-- This file was amended, in place (not via a follow-up migration), to add
-- the system_admin opt-in described below -- this feature is still entirely
-- unreleased (only ever applied to the local/CI scratch database created by
-- tests/run.sh, never to a hosted database), so folding the addition into
-- 0044 directly keeps the migration history clean instead of adding a
-- 0045 that would immediately be edited again by a later PR review comment.
--
--   1. notifications.category: durable, NOT NULL classification --
--      'action_required' (a personal call to action: assigned to you,
--      reopened and assigned to you, a handover awaiting your approval) vs
--      'update' (a role-based informational broadcast). Existing rows are
--      backfilled to 'action_required' -- every notification type that
--      existed before this migration was already a personal one. Legacy
--      'update_overdue' rows (the retired next-update-ETA feature -- see
--      0001/localRepository/supabaseRepository comments) are deleted
--      outright: they are already excluded from every active read path, and
--      the product spec calls for removing them here rather than leaving
--      dead rows to carry a category value that means nothing for them.
--   2. profiles.operational_notifications_enabled: a personal, self-managed
--      boolean opt-in -- NOT NULL, default false. Meaningful only for
--      system_admin: a professional_manager is an operational recipient
--      unconditionally regardless of this field's value, and every other
--      role is never a recipient even if this field were somehow true (see
--      notify_operational_recipients' WHERE clause below, which is the
--      actual enforcement point, not merely a UI convention). Changing a
--      profile's role never requires clearing this field -- it simply goes
--      back to being inert until/unless the profile is (or becomes again) a
--      system_admin.
--   3. notify_operational_recipients(): the single, internal (never client-
--      callable) helper every lifecycle RPC below calls to broadcast an
--      'update'-category notification to every eligible active recipient --
--      every active professional_manager, PLUS every active system_admin
--      who has opted in -- except the acting user and any explicitly
--      excluded recipient (used to avoid double-notifying someone who
--      already got a personal 'action_required' notification for the very
--      same operation -- e.g. the professional_manager who becomes the
--      incident's owner during create/reopen). The acting user is derived
--      from auth.uid() and recipients from active public.profiles rows --
--      never from client input, so a client can never forge a recipient,
--      actor, role, category, or text for these. Deduplication is a stable
--      key built from the SAME operation_id the calling RPC already stamps
--      onto its incident_events rows for this exact operation (never a
--      timestamp), combined with the recipient -- a retried/duplicate call
--      reuses nothing (each RPC invocation mints its own operation_id via
--      gen_random_uuid(), and a genuine retry of an already-applied,
--      version-checked mutation fails at lock_incident_checked's version
--      check before this helper is ever reached, leaving the transaction,
--      and therefore every notification insert in it, rolled back), and the
--      existing partial-unique index on notifications.dedupe_key (0001) is
--      the actual belt-and-suspenders guarantee against a double insert.
--   4. set_my_operational_notifications_enabled(): a narrowly scoped
--      SECURITY DEFINER RPC that lets an active, authenticated system_admin
--      change ONLY their own operational_notifications_enabled field. Takes
--      no user id -- the target is always auth.uid() -- so there is no path
--      (through this RPC) for an admin to change the preference for anyone
--      else. Rejects a non-system_admin, an inactive profile, or an
--      unauthenticated caller with a controlled error. Returns the caller's
--      own updated profile row so the frontend can refresh the signed-in
--      session's copy without a reload. profiles has no client-facing
--      UPDATE policy (0003: "managed via admin RPCs and auth triggers
--      only"), so this RPC -- not a direct table write -- is the only
--      supported path, exactly like every other profile mutation in this
--      schema.
--   5. create_incident / update_incident / technician_update_incident /
--      close_incident (full-readiness branch only) / reopen_incident /
--      cancel_incident: each gains exactly one notify_operational_recipients
--      call after its mutation has successfully committed to this same
--      transaction -- so a rolled-back operation (any exception raised
--      above that point) can never leave a notification behind. assign_incident
--      is UNCHANGED beyond adding the new category column to its existing
--      personal-notification insert: reassignment alone is not one of the
--      five product-defined broadcast events (incident opened / treatment
--      update / closed / reopened / cancelled).
--   6. Every existing notification insert (incident_assigned,
--      incident_reopened's personal branch, handover_pending) gains the new
--      category column, set to 'action_required' -- no behavioral change,
--      just satisfying the new NOT NULL column.
--
-- Explicit transaction, same reasoning as 0024/0035/0041/0042: the
-- repository's psql -f runner uses autocommit, so this keeps a manual/
-- Supabase application all-or-nothing. No `alter type ... add value`
-- appears anywhere in this file (that already happened, and was already
-- committed, in 0043) -- every enum value used below is safe to reference
-- immediately.

begin;

-- =====================================================================
-- 1. notifications.category
-- =====================================================================
alter table public.notifications add column category public.notification_category;

-- Legacy rows: no longer an active feature, already excluded from every
-- active read path (LocalDemoRepository.listNotifications / Supabase
-- repository's `.neq('type', 'update_overdue')`) -- deleted outright rather
-- than backfilled, so they can never resurface in the bell or unread count
-- through any future code path that forgets that exclusion filter.
delete from public.notifications where type = 'update_overdue';

-- Every notification type that existed before this migration
-- (incident_assigned, incident_reopened's personal branch, handover_pending)
-- was already a personal, action-required notification.
update public.notifications set category = 'action_required' where category is null;

alter table public.notifications alter column category set not null;

comment on column public.notifications.category is
  'action_required: a personal call to action for the recipient. update: a role-based informational broadcast. Durable and server-set only -- never accepted from the client.';

-- Defense-in-depth, matching this repository's own convention (0042, for
-- audit_logs): RLS already default-denies insert/delete on notifications
-- (there is a SELECT policy and an UPDATE policy scoped to the recipient's
-- own rows, but no INSERT/DELETE policy at all), so this changes no actual
-- behavior for the anon/authenticated client roles -- it turns a silent
-- zero-row no-op into an explicit, unambiguous permission error regardless
-- of which row(s) a stray direct write would otherwise have targeted.
revoke insert, delete on table public.notifications from public, anon, authenticated;

-- =====================================================================
-- 2. profiles.operational_notifications_enabled: personal system_admin
--    opt-in. NOT NULL with a hard default of false, so both existing rows
--    and every future insert (admin_create_placeholder_profile, the pending-
--    personnel claim flow, bootstrap_first_admin) start opted out with no
--    extra work required at any of those call sites. profiles already has
--    no client-facing UPDATE policy at all (0003) -- this column is exactly
--    as unwritable by a direct client request as every other profiles
--    column, until set_my_operational_notifications_enabled (below) opens
--    one narrow, self-only path to it.
-- =====================================================================
alter table public.profiles
  add column operational_notifications_enabled boolean not null default false;

comment on column public.profiles.operational_notifications_enabled is
  'Personal system_admin opt-in to role-based operational notifications (see notify_operational_recipients). Inert for every other role, including a professional_manager (who receives them unconditionally) -- never a substitute for the role check itself.';

-- =====================================================================
-- 3. notify_operational_recipients(): the shared internal broadcast helper.
--    Never granted to anon/authenticated -- reachable only from inside
--    another SECURITY DEFINER function's body (which runs as the function
--    OWNER, not the invoking client's role, so it needs no EXECUTE grant of
--    its own). This is what makes "a client cannot forge an operational
--    broadcast" true at the database layer, not just by application-layer
--    convention. Eligible recipients are exactly: every active
--    professional_manager (unconditionally), plus every active system_admin
--    with operational_notifications_enabled = true -- every other role is
--    excluded outright, regardless of what this column happens to contain
--    for it (a technician/shift_supervisor/viewer row can never satisfy
--    either branch of the OR below, so a stray true value there is inert).
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
  insert into notifications (user_id, type, incident_id, text, category, dedupe_key)
  select p.id, p_type, p_incident_id, p_text, p_category,
         'opn-' || p_operation_id::text || '-' || p.id::text
  from profiles p
  where (
      p.role = 'professional_manager'
      or (p.role = 'system_admin' and p.operational_notifications_enabled)
    )
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
-- 4. set_my_operational_notifications_enabled(): the self-only preference
--    RPC. auth.uid() is the sole source of the target row -- p_user_id is
--    deliberately not a parameter, so there is no argument an admin
--    (however privileged) could pass to change anyone else's preference
--    through this function. Rejects: no session (auth.uid() is null), no
--    matching active profile, or a role other than system_admin -- each
--    with a distinct, controlled 'permission:'-prefixed message, exactly
--    like every other authorization failure in this schema. Returns the
--    updated profiles row so the frontend can refresh the signed-in user's
--    own cached copy without a reload or a second round trip.
-- =====================================================================
create or replace function public.set_my_operational_notifications_enabled(p_enabled boolean)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v_profile profiles;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה';
  end if;
  select * into v_profile from profiles where id = auth.uid() and active for update;
  if not found then
    raise exception 'permission: אין הרשאה';
  end if;
  if v_profile.role <> 'system_admin' then
    raise exception 'permission: ההעדפה זמינה למנהלי מערכת בלבד';
  end if;
  update profiles set operational_notifications_enabled = p_enabled
    where id = auth.uid()
    returning * into v_profile;
  return v_profile;
end;
$$;

revoke execute on function public.set_my_operational_notifications_enabled(boolean)
  from public, anon;
grant execute on function public.set_my_operational_notifications_enabled(boolean)
  to authenticated;

-- =====================================================================
-- 5. create_incident: operational broadcast on successful creation.
--    Identical to 0042's definition except for the trailing addition below
--    the existing personal incident_assigned notification (now carrying
--    category), which is excluded from the broadcast when it fires (the
--    owner already got a personal, action_required notification for this
--    exact operation).
-- =====================================================================
create or replace function create_incident(p_input jsonb) returns incidents
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

  insert into incidents (
    number, system_id, location_id, description, severity, status, operational_impact,
    owner_user_id, owner_external_name, discovered_at, created_by, updated_by,
    next_update_due, no_deadline_reason, reported_to_ops, reported_to_ops_recipient,
    reported_to_comms, reported_to_comms_recipient, wisdom_reported, wisdom_incident_number,
    external_handler_name, external_handler_contact_person, external_handler_contact_details
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
    v_new_ext_name, v_new_ext_person, v_new_ext_details
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

  perform write_audit(
    p_action => 'incident_created', p_entity_type => 'incident', p_entity_id => v_incident.id::text,
    p_incident_number => v_incident.number,
    p_after => jsonb_build_object('severity', v_incident.severity, 'status', v_incident.status),
    p_entity_label => v_incident.number
  );

  if v_incident.owner_user_id is not null and v_incident.owner_user_id <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text, category, dedupe_key)
    values (v_incident.owner_user_id, 'incident_assigned', v_incident.id,
            'תקלה ' || v_incident.number || ' הוקצתה אליך.', 'action_required', 'assign-' || v_incident.id || '-create')
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

-- =====================================================================
-- 6. update_incident: operational broadcast on every successful call --
--    this RPC always inserts a fresh incident_updates row (actionsTaken is
--    mandatory on every submission), so "a treatment update was added
--    through the operational update flow" is unconditionally true whenever
--    this function returns successfully. The professional_manager who
--    becomes the new owner in the SAME call (if any) is excluded -- they
--    already got the personal, action_required incident_assigned
--    notification a few lines above.
-- =====================================================================
create or replace function update_incident(p_incident_id uuid, p_input jsonb) returns incidents
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
      insert into notifications (user_id, type, incident_id, text, category)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.', 'action_required');
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
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  -- Only the two material fields with no dedicated action above
  -- (operational_impact, next_update_due) land here, and only when at
  -- least one of them actually changed -- a submission that changes
  -- neither (whether a pure content-only update, or a resubmission of
  -- identical values) writes no 'incident_updated' AUDIT row at all. The
  -- notifications.incident_updated NOTIFICATION below is deliberately
  -- unconditional (see the function-level comment above) -- the two are
  -- independent signals with different truth conditions.
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

-- =====================================================================
-- 7. technician_update_incident: same unconditional operational broadcast
--    as update_incident -- every successful call inserts a fresh
--    incident_updates row. Never touches owner, so no exclusion beyond the
--    acting technician themselves (already handled by
--    notify_operational_recipients itself).
-- =====================================================================
create or replace function technician_update_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_update_id uuid;
  v_operation_id uuid := gen_random_uuid();
  v_event_time_raw text := nullif(trim(coalesce(p_input->>'eventTime', '')), '');
  v_event_time timestamptz;
  v_user_note text := nullif(trim(coalesce(p_input->>'note', '')), '');
  v_actor_name text;
begin
  if my_role() is distinct from 'technician' then
    raise exception 'permission: פעולה זו מיועדת לטכנאים';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  if v.owner_user_id is distinct from auth.uid() or is_incident_terminal(v.status) then
    raise exception 'permission: ניתן לעדכן רק תקלה פתוחה המוקצית אליך';
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
  if length(p_input->>'note') > 600 then
    raise exception 'validation: הערה נוספת: עד 600 תווים';
  end if;

  insert into incident_updates (incident_id, author_id, event_time, actions_taken, findings, next_steps, current_status_text, user_note)
  values (p_incident_id, auth.uid(), v_event_time,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''),
          nullif(trim(coalesce(p_input->>'currentStatusText', '')), ''), v_user_note)
  returning id into v_update_id;
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id, operation_id)
  values (p_incident_id, 'update', auth.uid(), v_event_time, v_update_id, v_operation_id);

  update incidents set version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;
  perform write_audit('incident_technical_update', 'incident', p_incident_id::text, v.number);

  select full_name into v_actor_name from profiles where id = auth.uid();
  perform notify_operational_recipients(
    'incident_updated', 'update', p_incident_id,
    'נוסף עדכון לתקלה ' || v.number || ' על ידי ' || coalesce(v_actor_name, 'משתמש'),
    v_operation_id
  );
  return v;
end;
$$;

-- =====================================================================
-- 8. assign_incident: UNCHANGED apart from the new category column on its
--    existing personal notification insert -- dedicated reassignment is not
--    one of the five product-defined broadcast events.
-- =====================================================================
create or replace function assign_incident(p_incident_id uuid, p_input jsonb) returns incidents
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
      insert into notifications (user_id, type, incident_id, text, category)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.', 'action_required');
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

-- =====================================================================
-- 9. close_incident: operational broadcast ONLY on an actual closure (the
--    full-readiness branch, status -> 'closed'). The incomplete-readiness
--    branch leaves the incident open as 'partial_readiness' -- not one of
--    the five product-defined broadcast events -- and is otherwise
--    untouched.
-- =====================================================================
create or replace function close_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
  v_readiness readiness_level := (p_input->>'readiness')::readiness_level;
  v_follow_up text := nullif(trim(coalesce(p_input->>'followUpNotes', '')), '');
  v_full_ready boolean := v_readiness = 'full';
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
  v_reported_ops reported_to_ops := (p_input->>'reportedToOps')::reported_to_ops;
  v_recipient text := case when (p_input->>'reportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'reportedToOpsRecipient', '')), '') else null end;
  v_old_status incident_status;
  v_owner_label text;
  v_old_reported_ops reported_to_ops;
  v_old_recipient text;
  v_old_ext_name text;
  v_old_ext_person text;
  v_old_ext_details text;
  v_ext_name_provided boolean := p_input ? 'externalHandlerName';
  v_ext_person_provided boolean := p_input ? 'externalHandlerContactPerson';
  v_ext_details_provided boolean := p_input ? 'externalHandlerContactDetails';
  v_new_ext_name text;
  v_new_ext_person text;
  v_new_ext_details text;
  v_event_time_raw text := nullif(trim(coalesce(p_input->>'eventTime', '')), '');
  v_event_time timestamptz;
  v_user_note text := nullif(trim(coalesce(p_input->>'note', '')), '');
  v_actor_name text;
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if not coalesce(is_operational_role() or my_role() = 'technician', false) then
    raise exception 'permission: אין הרשאה לסגור תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  if is_incident_terminal(v.status) then
    raise exception 'invalid_transition: התקלה כבר סגורה או מבוטלת';
  end if;
  if v_event_time_raw is null then
    raise exception 'validation: יש להזין מועד סגירת התקלה בפועל';
  end if;
  begin
    v_event_time := v_event_time_raw::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then
      raise exception 'validation: מועד סגירת התקלה אינו תקין';
  end;
  if v_event_time < v.discovered_at or v_event_time > now() + interval '5 minutes' then
    raise exception 'validation: מועד סגירת התקלה אינו תקין';
  end if;
  v_old_reported_ops := v.reported_to_ops;
  v_old_recipient := v.reported_to_ops_recipient;
  v_old_ext_name := v.external_handler_name;
  v_old_ext_person := v.external_handler_contact_person;
  v_old_ext_details := v.external_handler_contact_details;
  v_new_ext_name := case when v_ext_name_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '') else v_old_ext_name end;
  v_new_ext_person := case when v_ext_person_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '') else v_old_ext_person end;
  v_new_ext_details := case when v_ext_details_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '') else v_old_ext_details end;
  if length(trim(coalesce(p_input->>'rootCause', ''))) = 0 or length(trim(coalesce(p_input->>'resolution', ''))) = 0 then
    raise exception 'validation: סיבת התקלה והפתרון שבוצע הם שדות חובה';
  end if;
  if not v_full_ready then
    if v_follow_up is null then
      raise exception 'validation: בסגירה עם כשירות חלקית יש לפרט פעולות המשך';
    end if;
    if v_new_owner is null then
      raise exception 'validation: כאשר הכשירות אינה מלאה יש לקבוע גורם מטפל אחראי המשך';
    end if;
  end if;
  if v_reported_ops = 'yes' and v_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;
  if length(p_input->>'note') > 600 then
    raise exception 'validation: הערה נוספת: עד 600 תווים';
  end if;
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;
  perform assert_owner_valid(v_new_owner);

  v_old_status := v.status;

  if v_full_ready then
    update incidents set
      status = 'closed', closed_at = v_event_time, closed_by = auth.uid(),
      root_cause = trim(p_input->>'rootCause'), resolution = trim(p_input->>'resolution'),
      readiness_at_close = v_readiness, follow_up_notes = v_follow_up,
      follow_up_required = false,
      reported_to_ops = v_reported_ops, reported_to_ops_recipient = v_recipient,
      external_handler_name = v_new_ext_name,
      external_handler_contact_person = v_new_ext_person,
      external_handler_contact_details = v_new_ext_details,
      next_update_due = null, no_deadline_reason = 'התקלה נסגרה',
      version = version + 1, updated_by = auth.uid(), last_update_at = now()
    where id = p_incident_id returning * into v;

    insert into incident_events (incident_id, type, actor_id, new_value, note, user_note, event_time, operation_id)
    values (p_incident_id, 'closed', auth.uid(), v_readiness::text,
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון שבוצע: ' || v.resolution, v_user_note, v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_closed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('status', v_old_status),
      p_after => jsonb_build_object('status', v.status, 'readiness', v_readiness),
      p_entity_label => v.number
    );
    if v_reported_ops <> v_old_reported_ops or v_recipient is distinct from v_old_recipient then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
      values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
              v_old_recipient, v_recipient,
              'דווח למבצעים: ' || v_reported_ops::text || coalesce(' (' || v_recipient || ')', ''), v_event_time, v_operation_id);
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

    select full_name into v_actor_name from profiles where id = auth.uid();
    perform notify_operational_recipients(
      'incident_closed', 'update', p_incident_id,
      'תקלה ' || v.number || ' נסגרה על ידי ' || coalesce(v_actor_name, 'משתמש'),
      v_operation_id
    );
  else
    select full_name into v_owner_label from profiles where id = v_new_owner;

    update incidents set
      status = 'partial_readiness',
      owner_user_id = v_new_owner,
      external_handler_name = v_new_ext_name,
      external_handler_contact_person = v_new_ext_person,
      external_handler_contact_details = v_new_ext_details,
      root_cause = trim(p_input->>'rootCause'), resolution = trim(p_input->>'resolution'),
      follow_up_notes = v_follow_up, follow_up_required = true,
      reported_to_ops = v_reported_ops, reported_to_ops_recipient = v_recipient,
      no_deadline_reason = case when v.next_update_due is null
        then 'התקלה נותרה פעילה עם כשירות לא מלאה, ממתינה להשלמת פעולות המשך' else v.no_deadline_reason end,
      version = version + 1, updated_by = auth.uid(), last_update_at = now()
    where id = p_incident_id returning * into v;

    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, user_note, event_time, operation_id)
    values (p_incident_id, 'status_change', auth.uid(), 'status', v_old_status::text, 'partial_readiness',
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון החלקי שבוצע: ' || v.resolution ||
            E'\nפעולות המשך: ' || v.follow_up_notes || E'\nגורם מטפל אחראי המשך: ' || v_owner_label,
            v_user_note, v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_partial_readiness', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('status', v_old_status),
      p_after => jsonb_build_object('status', v.status, 'readiness', v_readiness),
      p_entity_label => v.number
    );
    if v_reported_ops <> v_old_reported_ops or v_recipient is distinct from v_old_recipient then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
      values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
              v_old_recipient, v_recipient,
              'דווח למבצעים: ' || v_reported_ops::text || coalesce(' (' || v_recipient || ')', ''), v_event_time, v_operation_id);
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
  end if;
  return v;
end;
$$;

-- =====================================================================
-- 10. reopen_incident: broadcast excludes the incident's (new) owner when
--    one is set -- they either already got the personal, action_required
--    incident_reopened notification just above, or they are the acting
--    user themselves (already excluded by notify_operational_recipients).
-- =====================================================================
create or replace function reopen_incident(p_incident_id uuid, p_input jsonb) returns incidents
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
    reopen_count = reopen_count + 1,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  if v.owner_user_id is not null and v.owner_user_id <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text, category)
    values (v.owner_user_id, 'incident_reopened', p_incident_id,
            'תקלה ' || v.number || ' נפתחה מחדש והוקצתה אליך.', 'action_required');
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

-- =====================================================================
-- 11. cancel_incident: broadcast on every successful cancellation. Uses
--    search_path = '' and fully qualified names, matching this function's
--    own existing convention (0017/0026/0042) -- unlike the rest of this
--    file, which follows the majority search_path = public convention.
-- =====================================================================
create or replace function public.cancel_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.incidents;
  v_after public.incidents;
  v_expected_version int;
  v_event_time timestamptz;
  v_operation_id uuid := gen_random_uuid();
  v_reason text := trim(coalesce(p_input->>'cancellationReason', ''));
  v_removed_check_id uuid;
  v_removal_note text := 'בדיקת הסטטוס הוסרה באופן אוטומטי עקב ביטול התקלה';
begin
  if not public.is_operational_role() then
    raise exception 'permission: אין הרשאה לבטל תקלה';
  end if;

  if p_input->>'expectedVersion' is null then
    raise exception 'validation: expectedVersion is required';
  end if;
  v_expected_version := (p_input->>'expectedVersion')::int;

  if p_input->>'eventTime' is null then
    raise exception 'validation: eventTime is required';
  end if;
  v_event_time := (p_input->>'eventTime')::timestamptz;

  v_before := public.lock_incident_checked(p_incident_id, v_expected_version);
  if public.is_incident_terminal(v_before.status) then
    raise exception 'invalid_transition: לא ניתן לבטל תקלה שכבר סגורה או מבוטלת';
  end if;
  if length(v_reason) = 0 then
    raise exception 'validation: יש לפרט סיבת ביטול';
  end if;
  if v_event_time < v_before.discovered_at or v_event_time > now() + interval '5 minutes' then
    raise exception 'validation: מועד הביטול אינו תקין';
  end if;

  update public.incidents set
    status = 'cancelled', cancelled_at = v_event_time, cancelled_by = auth.uid(),
    cancellation_reason = v_reason, next_update_due = null, no_deadline_reason = 'התקלה בוטלה',
    status_check_due = null, follow_up_required = false,
    version = version + 1, updated_at = now(), updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v_after;

  insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
  values (p_incident_id, 'cancelled', auth.uid(), 'status', v_before.status::text, 'cancelled', v_reason, null, v_event_time, v_operation_id);

  if v_before.status_check_due is not null then
    insert into public.incident_status_checks (incident_id, kind, previous_due_at, recorded_by, event_time, note)
    values (p_incident_id, 'removed', v_before.status_check_due, auth.uid(), v_event_time, v_removal_note)
    returning id into v_removed_check_id;

    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due',
            v_before.status_check_due::text, null, v_removal_note, v_removed_check_id, v_event_time, v_operation_id);
  end if;

  perform public.write_audit(
    p_action => 'incident_cancelled', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
    p_incident_number => v_before.number,
    p_before => jsonb_build_object('status', v_before.status),
    p_after => jsonb_build_object('status', v_after.status, 'cancellationReason', v_after.cancellation_reason),
    p_entity_label => v_before.number, p_summary => v_reason
  );

  perform public.notify_operational_recipients(
    'incident_cancelled', 'update', p_incident_id,
    'תקלה ' || v_before.number || ' בוטלה',
    v_operation_id
  );
  return v_after;
end;
$$;

-- =====================================================================
-- 12. create_handover: UNCHANGED apart from the new category column on its
--     existing personal handover_pending notification insert.
-- =====================================================================
create or replace function create_handover(p_input jsonb) returns handovers
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

  insert into notifications (user_id, type, handover_id, text, category, dedupe_key)
  values (v_to, 'handover_pending', v.id,
          'העברת משמרת ממתינה לאישורך.', 'action_required', 'handover-' || v.id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  perform write_audit('handover_created', 'handover', v.id::text);
  return v;
end;
$$;

commit;
