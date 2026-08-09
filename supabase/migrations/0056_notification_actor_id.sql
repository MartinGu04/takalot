-- AVARIA v1.5.0 -- Push notification actor name polish (data layer).
--
-- public.notifications has never carried a stable reference to WHO caused
-- it -- only WHO it is for (user_id). Reusing incidents.updated_by (already
-- present, migration 0001) was considered and rejected: that column is
-- overwritten by every subsequent update to the same incident, and Push
-- dispatch is asynchronous (up to 15s, per migration 0055) -- a second,
-- unrelated edit to the same incident landing before the Edge Function
-- reads updated_by would misattribute the notification to the wrong
-- person. incidents.created_by (set once, never touched again) IS safe,
-- but only covers incident_opened, not incident_assigned/incident_reopened.
--
-- This migration adds one minimal, nullable, immutable column instead:
-- notifications.actor_id, populated by auth.uid() at the exact moment each
-- notification is inserted -- the same established created_by/actor_id
-- pattern already used throughout this schema (incidents.created_by,
-- incident_events.actor_id, handovers.created_by). Nullable and never
-- backfilled for existing rows: an unresolvable/legacy actor is an
-- expected, normal state, not an error -- the Push dispatch path (a
-- separate, unrelated change) is responsible for falling back to the
-- existing no-actor-suffix copy when actor_id is null, never failing or
-- delaying delivery because of it.
--
-- Five existing notification-producing call sites are updated to carry the
-- actor going forward -- every current CREATE OR REPLACE below is
-- otherwise byte-for-byte identical to the function currently live on
-- origin/main (verified against the actual applied migration chain, not
-- just this file's own history: create_incident's own logic lives in
-- create_incident_impl since migration 0047, update_incident/
-- assign_incident/reopen_incident have each been redefined several times
-- since 0044 for unrelated reasons -- this migration only ever adds
-- `actor_id`/`auth.uid()` to an existing notification INSERT, nothing else
-- changes):
--   - create_incident_impl: the personal incident_assigned notification
--   - update_incident: the personal incident_assigned notification (owner
--     reassigned during an update)
--   - assign_incident: the personal incident_assigned notification
--     (dedicated reassignment)
--   - reopen_incident: the personal incident_reopened notification
--   - notify_operational_recipients: the shared 'update'-category
--     broadcast helper (covers incident_opened, the only 'update'-category
--     type Push actually sends -- also stamps actor_id on the other
--     broadcast types it inserts for the same reason free-riding grants
--     are already free elsewhere in this schema: harmless, consistent,
--     avoids parameterizing one caller differently from the rest of a
--     shared function)
--
-- create_handover's handover_pending personal notification is
-- DELIBERATELY NOT touched -- it is not one of the three approved Push
-- copy variants gaining an actor suffix, and touching it is out of this
-- change's scope.
--
-- No trigger/dispatch/Edge Function/RLS/grant change belongs in this
-- migration -- purely the data-layer half of "Push actor name polish".

alter table public.notifications add column actor_id uuid references public.profiles (id);

comment on column public.notifications.actor_id is
  'The profile that caused this notification (auth.uid() at insert time), when known. Null for legacy rows and any future notification-producing path that has not been updated to set it -- always treated as "actor unresolved", never an error. Never backfilled.';

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
    insert into notifications (user_id, type, incident_id, text, category, dedupe_key, actor_id)
    values (v_incident.owner_user_id, 'incident_assigned', v_incident.id,
            'תקלה ' || v_incident.number || ' הוקצתה אליך.', 'action_required', 'assign-' || v_incident.id || '-create', auth.uid())
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
      insert into notifications (user_id, type, incident_id, text, category, actor_id)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.', 'action_required', auth.uid());
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
      insert into notifications (user_id, type, incident_id, text, category, actor_id)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.', 'action_required', auth.uid());
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
    insert into notifications (user_id, type, incident_id, text, category, actor_id)
    values (v.owner_user_id, 'incident_reopened', p_incident_id,
            'תקלה ' || v.number || ' נפתחה מחדש והוקצתה אליך.', 'action_required', auth.uid());
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


create or replace function public.notify_operational_recipients(p_type notification_type, p_category notification_category, p_incident_id uuid, p_text text, p_operation_id uuid, p_exclude_user_ids uuid[] default '{}'::uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, type, incident_id, text, category, dedupe_key, actor_id)
  select p.id, p_type, p_incident_id, p_text, p_category,
         'opn-' || p_operation_id::text || '-' || p.id::text, auth.uid()
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
