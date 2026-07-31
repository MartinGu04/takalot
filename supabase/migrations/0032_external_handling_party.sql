-- מעקב תקלות — forward migration.
-- Additive external handling party: an external organization/handler is now
-- a first-class, always-optional fact alongside the incident's internal
-- owner -- never a replacement for it. Every new and actively managed
-- incident still requires a valid internal owner (owner_user_id); the
-- external-handler trio below is purely additive.
--
-- ===== Why owner_external_name is not reused =====
-- owner_external_name (0001) means "external party INSTEAD OF an internal
-- owner" -- the legacy model this migration retires as an active writer
-- target. Repurposing it would conflate two different facts (who used to be
-- the sole owner, historically, vs. who is additionally handling this
-- externally, going forward). owner_external_name is therefore:
--   - never renamed, dropped, or rewritten;
--   - copied (once, idempotently) into the new external_handler_name below
--     for any legacy row that has one, so nothing is silently lost;
--   - left as a permanent historical record, read-only after this migration
--     ships (no RPC below writes or clears it again).
--
-- ===== New columns =====
-- All three nullable, no defaults -- "no external handler recorded" is the
-- correct default for every existing row and most future ones.
alter table incidents
  add column external_handler_name text
    check (external_handler_name is null or length(external_handler_name) <= 120),
  add column external_handler_contact_person text
    check (external_handler_contact_person is null or length(external_handler_contact_person) <= 120),
  add column external_handler_contact_details text
    check (external_handler_contact_details is null or length(external_handler_contact_details) <= 500);

-- Contact person / contact details are only meaningful once an external
-- handler has actually been named -- one-directional only (a name alone,
-- with no contact info, is perfectly valid). Blank/whitespace-only values
-- must be treated as absent here, the same way every RPC below normalizes
-- its own inputs with nullif(trim(...), '') before writing -- this closes
-- the same gap for any row a direct table write could otherwise reach
-- (RLS already blocks that in practice, but this is the established
-- belt-and-suspenders house style for every bidirectional CHECK in this
-- schema).
alter table incidents
  add constraint external_handler_name_required_with_contact
    check (
      (nullif(btrim(external_handler_contact_person), '') is null
       and nullif(btrim(external_handler_contact_details), '') is null)
      or nullif(btrim(external_handler_name), '') is not null
    );

-- ===== Backfill (copy-only, idempotent, all statuses) =====
-- Every legacy incident whose only historical owner fact is
-- owner_external_name (owner_user_id is null) gets that value copied into
-- external_handler_name, open and closed/cancelled alike. owner_external_name
-- itself is read here, never written. The `external_handler_name is null`
-- guard makes this statement safely re-runnable: a second execution in any
-- environment affects exactly 0 rows. No incident_events or audit_logs row
-- is fabricated for this -- a backfill is not a user action.
update incidents
   set external_handler_name = owner_external_name
 where owner_user_id is null
   and owner_external_name is not null
   and external_handler_name is null;

-- ===== Shared rendering helper =====
-- A single human-readable snapshot of all three external-handler fields,
-- used identically by every RPC below when recording a
-- field='external_handler' timeline event. Capturing all three facts in
-- BOTH old_value and new_value (rather than only the name) is what makes a
-- contact-person- or contact-details-only change visibly distinct even when
-- the organization name itself does not change.
create or replace function format_external_handler_snapshot(
  p_name text, p_contact_person text, p_contact_details text
) returns text
language sql immutable as $$
  select case
    when p_name is null and p_contact_person is null and p_contact_details is null
      then 'ללא גורם מטפל חיצוני'
    else concat_ws(' · ',
      coalesce(p_name, 'ללא שם גורם'),
      case when p_contact_person is not null then 'איש קשר: ' || p_contact_person end,
      case when p_contact_details is not null then 'פרטי קשר: ' || p_contact_details end
    )
  end;
$$;

-- =====================================================================
-- 1. create_incident (unchanged since 0026 except the additions below):
--    accepts the optional external-handler trio at opening time. Internal
--    owner remains mandatory and an explicit ownerExternalName is still
--    rejected outright -- both unchanged, pre-existing (0019) rules, not
--    something this migration touches. A brand-new row has nothing to
--    preserve, so the three new fields are read directly (no existence-check
--    needed here, mirroring how nextUpdateDue already works in this
--    function) -- unlike update_incident/assign_incident/close_incident/
--    reopen_incident below, which all must distinguish "key omitted" from
--    "key explicitly cleared."
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
begin
  if not is_operational_role() then
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

  insert into incident_events (incident_id, type, actor_id, event_time, note, operation_id)
  values (v_incident.id, 'created', auth.uid(), v_incident.discovered_at,
    'פעולות שבוצעו עד כה: ' || v_actions_taken ||
    E'\nתקשוב למבצעים: ' || (case when v_reported_comms then 'כן (דווח ל: ' || v_comms_recipient || ')' else 'לא' end) ||
    E'\nWISDOM: ' || (case when v_wisdom_reported then 'כן (מספר תקלה: ' || v_wisdom_number || ')' else 'לא' end),
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

  perform write_audit('incident_created', 'incident', v_incident.id::text, v_incident.number,
    null, jsonb_build_object('severity', v_incident.severity, 'status', v_incident.status));

  if v_incident.owner_user_id is not null and v_incident.owner_user_id <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text, dedupe_key)
    values (v_incident.owner_user_id, 'incident_assigned', v_incident.id,
            'תקלה ' || v_incident.number || ' הוקצתה אליך.', 'assign-' || v_incident.id || '-create')
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;
  return v_incident;
end;
$$;

-- =====================================================================
-- 2. update_incident (unchanged since 0031 except the additions below).
--    Internal owner becomes mandatory (previously the only requirement was
--    "internal OR external"); a legacy ownerExternalName payload key is now
--    tolerated but never read for any purpose -- not to validate, not to
--    reject, not to write, not to clear owner_external_name -- exactly the
--    same "tolerated but inert" treatment 0031 already gave the legacy
--    reportedToOps/reportedToOpsRecipient keys. owner_external_name is
--    therefore dropped from this function's UPDATE clause entirely.
--
--    v_old_ext_name/v_old_ext_person/v_old_ext_details are captured
--    immediately after v is loaded (before any UPDATE ... RETURNING * INTO v
--    can overwrite it) and used for every genuine-change comparison and for
--    the event's old-value snapshot -- v itself is never re-read for these
--    three fields after that point.
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

  insert into incident_updates (
    incident_id, author_id, event_time, actions_taken, findings, next_steps, current_status_text,
    update_reported_to_ops, update_reported_to_ops_recipient,
    update_reported_to_comms, update_reported_to_comms_recipient,
    update_wisdom_reported
  )
  values (p_incident_id, auth.uid(), v_event_time,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''),
          nullif(trim(coalesce(p_input->>'currentStatusText', '')), ''),
          v_update_reported_to_ops, v_update_reported_to_ops_recipient,
          v_update_reported_to_comms, v_update_reported_to_comms_recipient,
          v_update_wisdom_reported)
  returning id into v_update_id;
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id, operation_id)
  values (p_incident_id, 'update', auth.uid(), v_event_time, v_update_id, v_operation_id);

  if v_impact_provided and v_new_impact is distinct from v.operational_impact then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'impact_change', auth.uid(), 'operational_impact',
            v.operational_impact, v_new_impact, v_event_time, v_operation_id);
  end if;
  if v_new_status <> v.status then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'status_change', auth.uid(), 'status', v.status::text, v_new_status::text,
            nullif(trim(coalesce(p_input->>'changeReason', '')), ''), v_event_time, v_operation_id);
  end if;
  if v_new_severity <> v.severity then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'severity_change', auth.uid(), 'severity', v.severity::text, v_new_severity::text,
            nullif(trim(coalesce(p_input->>'changeReason', '')), ''), v_event_time, v_operation_id);
    perform write_audit('incident_severity_changed', 'incident', p_incident_id::text, v.number,
      jsonb_build_object('severity', v.severity), jsonb_build_object('severity', v_new_severity));
  end if;
  if v_new_owner::text <> coalesce(v.owner_user_id::text, '') then
    select coalesce((select full_name from profiles where id = v.owner_user_id), v.owner_external_name, 'ללא') into v_old_owner_label;
    select full_name into v_new_owner_label from profiles where id = v_new_owner;
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_owner_label, v_new_owner_label,
            v_event_time, v_operation_id);
    perform write_audit('incident_assigned', 'incident', p_incident_id::text, v.number,
      jsonb_build_object('owner', v_old_owner_label), jsonb_build_object('owner', v_new_owner_label));
    if v_new_owner <> auth.uid() then
      insert into notifications (user_id, type, incident_id, text)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.');
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
  end if;
  if coalesce(v_new_due, 'epoch'::timestamptz) <> coalesce(v.next_update_due, 'epoch'::timestamptz) then
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

  perform write_audit('incident_updated', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- =====================================================================
-- 3. assign_incident (unchanged since 0026 except the additions below).
--    Same internal-owner-mandatory + legacy-ownerExternalName-tolerated
--    treatment as update_incident above.
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
  if not is_operational_role() then
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

  select coalesce((select full_name from profiles where id = v.owner_user_id), v.owner_external_name, 'ללא') into v_old_label;
  select full_name into v_new_label from profiles where id = v_new_owner;

  insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, operation_id)
  values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_label, v_new_label,
          nullif(trim(coalesce(p_input->>'note', '')), ''), v_operation_id);
  perform write_audit('incident_assigned', 'incident', p_incident_id::text, v.number,
    jsonb_build_object('owner', v_old_label), jsonb_build_object('owner', v_new_label));
  if v_new_owner <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text)
    values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.');
  end if;
  if v_new_ext_name is distinct from v_old_ext_name
     or v_new_ext_person is distinct from v_old_ext_person
     or v_new_ext_details is distinct from v_old_ext_details then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
            format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
            format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
            v_operation_id);
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
-- 4. close_incident (unchanged since 0026 except the additions below).
--    External handling is independent of the internal continuation owner:
--    the external-handler trio is computed ONCE, before the full/partial
--    readiness split, and BOTH branches gain the three columns in their own
--    UPDATE clause. The full-readiness branch still never touches
--    owner_user_id/owner_external_name -- that is unchanged. Old external-
--    handler values are captured into v_old_ext_name/_person/_details
--    immediately after v is loaded, before either branch's own
--    UPDATE ... RETURNING * INTO v can overwrite v -- both branches'
--    event-old-value snapshots read those dedicated variables, never v
--    itself, once the branch's own update has run.
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
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה לסגור תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  if is_incident_terminal(v.status) then
    raise exception 'invalid_transition: התקלה כבר סגורה או מבוטלת';
  end if;
  v_old_reported_ops := v.reported_to_ops;
  v_old_recipient := v.reported_to_ops_recipient;
  -- Captured immediately, before either branch below runs its own
  -- UPDATE ... RETURNING * INTO v -- external handling is independent of
  -- readiness, so this is computed once regardless of which branch the
  -- incident ultimately takes.
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
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;
  perform assert_owner_valid(v_new_owner);

  v_old_status := v.status;

  if v_full_ready then
    -- Full readiness: the incident actually closes. Owner columns are
    -- untouched here -- unchanged from before this migration -- but the
    -- external-handler trio is independent of readiness and is written in
    -- both branches.
    update incidents set
      status = 'closed', closed_at = now(), closed_by = auth.uid(),
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

    insert into incident_events (incident_id, type, actor_id, new_value, note, operation_id)
    values (p_incident_id, 'closed', auth.uid(), v_readiness::text,
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון שבוצע: ' || v.resolution, v_operation_id);
    perform write_audit('incident_closed', 'incident', p_incident_id::text, v.number,
      null, jsonb_build_object('readiness', v_readiness));
    if v_reported_ops <> v_old_reported_ops or v_recipient is distinct from v_old_recipient then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, operation_id)
      values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
              v_old_recipient, v_recipient,
              'דווח למבצעים: ' || v_reported_ops::text || coalesce(' (' || v_recipient || ')', ''), v_operation_id);
    end if;
    if v_new_ext_name is distinct from v_old_ext_name
       or v_new_ext_person is distinct from v_old_ext_person
       or v_new_ext_details is distinct from v_old_ext_details then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, operation_id)
      values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
              format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
              format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
              v_operation_id);
    end if;
  else
    -- Incomplete readiness: the incident stays active as "כשירות חלקית" --
    -- it is never marked closed while follow-up is still outstanding.
    -- readiness_at_close is left untouched: it only ever describes readiness
    -- AT AN ACTUAL CLOSE, and this incident has not closed (also enforced by
    -- incident_closed_requires_full_readiness).
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

    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, operation_id)
    values (p_incident_id, 'status_change', auth.uid(), 'status', v_old_status::text, 'partial_readiness',
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון החלקי שבוצע: ' || v.resolution ||
            E'\nפעולות המשך: ' || v.follow_up_notes || E'\nגורם מטפל אחראי המשך: ' || v_owner_label,
            v_operation_id);
    perform write_audit('incident_partial_readiness', 'incident', p_incident_id::text, v.number,
      null, jsonb_build_object('readiness', v_readiness));
    if v_reported_ops <> v_old_reported_ops or v_recipient is distinct from v_old_recipient then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, operation_id)
      values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
              v_old_recipient, v_recipient,
              'דווח למבצעים: ' || v_reported_ops::text || coalesce(' (' || v_recipient || ')', ''), v_operation_id);
    end if;
    if v_new_ext_name is distinct from v_old_ext_name
       or v_new_ext_person is distinct from v_old_ext_person
       or v_new_ext_details is distinct from v_old_ext_details then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, operation_id)
      values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
              format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
              format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
              v_operation_id);
    end if;
  end if;
  return v;
end;
$$;

-- =====================================================================
-- 5. reopen_incident (unchanged since 0030 except the additions below).
--    Same internal-owner-mandatory + legacy-ownerExternalName-tolerated
--    treatment as update_incident/assign_incident above -- this RPC
--    previously allowed a null owner (assert_owner_valid is a no-op on
--    null); it now requires one, like every other actively-managed
--    lifecycle action.
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
  perform write_audit('incident_reopened', 'incident', p_incident_id::text, v.number,
    null, jsonb_build_object('reason', trim(p_input->>'reason')));
  if v_new_ext_name is distinct from v_old_ext_name
     or v_new_ext_person is distinct from v_old_ext_person
     or v_new_ext_details is distinct from v_old_ext_details then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
            format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
            format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
            v_operation_id);
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

  if v.owner_user_id <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text)
    values (v.owner_user_id, 'incident_reopened', p_incident_id,
            'תקלה ' || v.number || ' נפתחה מחדש והוקצתה אליך.');
  end if;
  return v;
end;
$$;
