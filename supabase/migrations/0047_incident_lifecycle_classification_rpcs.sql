-- AVARIA — structured incident lifecycle classification (file 3 of 3): RPCs.
--
-- Versioned-RPC rollout, safe for a PWA where an old cached client can
-- linger indefinitely:
--   * create_incident / close_incident keep their CURRENT, PERMISSIVE
--     behavior forever (in this task) -- a still-cached old frontend
--     build never breaks, no matter how long it lingers. Their eventual
--     retirement is separate future cleanup, out of scope here.
--   * create_incident_v2 / close_incident_v2 are NEW, additive entry
--     points that unconditionally require the new fields (reportedDomain;
--     the full closure classification) from the moment they exist -- the
--     new frontend calls ONLY these two for creation/closure. No adoption
--     threshold, no later "enforcement" migration.
--   * Both pairs share one internal implementation each
--     (create_incident_impl/close_incident_impl) so the permissive and
--     enforcing entry points can never drift out of sync. The _impl
--     functions are internal-only (revoked from public/anon/authenticated),
--     matching write_audit/notify_operational_recipients/
--     lock_incident_checked.
--   * update_incident, technician_update_incident, reopen_incident are
--     updated IN PLACE (create or replace function, same signature, same
--     existing grants) -- none of their additions are newly required, so
--     no compatibility branching or versioning is needed for them:
--       - suspectedCause/treatmentActions are optional in every case (an
--         old client simply never sends the keys).
--       - reopen_incident's current_suspected_cause reset touches a
--         column the old frontend has never read or written -- invisible
--         to it.
--
-- Every function body below that already existed is copied forward from
-- its most recent definition (migration 0044) with ONLY the additions
-- described in the header comments spliced in -- no unrelated behavior
-- change.
--
-- Not wrapped in one big explicit transaction: this file only contains
-- `create or replace function`/`create function`/`grant`/`revoke`
-- statements, every one of which is individually safe and idempotent: if
-- the migration runner stops partway through, re-running the whole file
-- from the top is harmless (every statement either creates-or-replaces or
-- grants/revokes the same, final, intended state).

-- =====================================================================
-- 1. create_incident_impl -- internal, shared by create_incident (p_
--    require_domain = false) and create_incident_v2 (= true).
-- =====================================================================
create or replace function create_incident_impl(p_input jsonb, p_require_domain boolean) returns incidents
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

revoke execute on function create_incident_impl(jsonb, boolean) from public, anon, authenticated;

-- =====================================================================
-- 2. create_incident (permissive, unchanged signature/grants) and
--    create_incident_v2 (new, always-enforcing).
-- =====================================================================
create or replace function create_incident(p_input jsonb) returns incidents
language sql security definer set search_path = public as $$
  select create_incident_impl(p_input, false);
$$;

create or replace function create_incident_v2(p_input jsonb) returns incidents
language sql security definer set search_path = public as $$
  select create_incident_impl(p_input, true);
$$;

revoke execute on function create_incident_v2(jsonb) from public, anon;
grant execute on function create_incident_v2(jsonb) to authenticated;

-- =====================================================================
-- 3. close_incident_impl -- internal, shared by close_incident (p_
--    require_classification = false) and close_incident_v2 (= true).
--    Classification is only ever relevant on the full-readiness branch
--    (a genuine close); the partial-readiness branch is untouched by
--    p_require_classification entirely -- it never writes classification
--    regardless of which entry point called it.
-- =====================================================================
create or replace function close_incident_impl(p_incident_id uuid, p_input jsonb, p_require_classification boolean) returns incidents
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
  -- Structured closure classification additions. Presence is checked via
  -- the `?` jsonb key-existence operator (the same "only-if-explicitly-
  -- provided" idiom update_incident already uses for operationalImpact/
  -- nextUpdateDue), not a null-value check -- an explicitly-sent null
  -- would still count as "present" here, matching how every other
  -- optional-but-present field in this schema is detected.
  v_confirmed_cause_provided boolean := p_input ? 'confirmedCause';
  v_treatment_outcome_provided boolean := p_input ? 'treatmentOutcome';
  v_resolution_attribution_provided boolean := p_input ? 'resolutionAttribution';
  v_class_cluster_present boolean;
  v_core_three_present boolean;
  v_write_classification boolean := false;
  v_confirmed_cause_raw text := nullif(trim(coalesce(p_input->>'confirmedCause', '')), '');
  v_confirmed_cause incident_confirmed_cause;
  v_confirmed_cause_other text := nullif(trim(coalesce(p_input->>'confirmedCauseOtherDetail', '')), '');
  v_treatment_outcome_raw text := nullif(trim(coalesce(p_input->>'treatmentOutcome', '')), '');
  v_treatment_outcome incident_treatment_outcome;
  v_treatment_outcome_other text := nullif(trim(coalesce(p_input->>'treatmentOutcomeOtherDetail', '')), '');
  v_resolution_attribution_raw text := nullif(trim(coalesce(p_input->>'resolutionAttribution', '')), '');
  v_resolution_attribution incident_resolution_attribution;
  v_resolution_attribution_other text := nullif(trim(coalesce(p_input->>'resolutionAttributionOtherDetail', '')), '');
  v_closure_id uuid;
  v_action_elem jsonb;
  v_action_type_raw text;
  v_action_type incident_treatment_action_type;
  v_action_other text;
  v_action_key text;
  v_seen_action_keys text[] := '{}';
  v_new_action_id uuid;
  v_new_action_ids uuid[] := '{}';
  v_selected_ids uuid[] := '{}';
  v_action_id_elem text;
  v_action_id uuid;
  v_all_linked_ids uuid[];
  v_linked_count int;
  v_exists boolean;
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

  -- Structured closure classification -- relevant only on the genuine
  -- (full-readiness) close; partial_readiness never writes it, regardless
  -- of p_require_classification.
  if v_full_ready then
    v_class_cluster_present := v_confirmed_cause_provided or v_treatment_outcome_provided or v_resolution_attribution_provided
      or (p_input ? 'confirmedCauseOtherDetail') or (p_input ? 'treatmentOutcomeOtherDetail')
      or (p_input ? 'resolutionAttributionOtherDetail') or (p_input ? 'resolutionActionIds') or (p_input ? 'newTreatmentActions');
    v_core_three_present := v_confirmed_cause_provided and v_treatment_outcome_provided and v_resolution_attribution_provided;

    if p_require_classification then
      if not v_core_three_present then
        raise exception 'validation: יש לספק סיווג סגירה מלא (הגורם שאומת, תוצאת הטיפול ומה שהוביל לפתרון)';
      end if;
      v_write_classification := true;
    else
      if v_core_three_present then
        v_write_classification := true;
      elsif v_class_cluster_present then
        -- Some, but not all, of the classification cluster was supplied
        -- to the permissive legacy entry point -- never silently discard
        -- a partially-supplied classification; the whole call fails
        -- atomically and nothing is written.
        raise exception 'validation: יש לספק סיווג סגירה מלא או להשמיטו לחלוטין';
      else
        v_write_classification := false;
      end if;
    end if;

    if v_write_classification then
      if v_confirmed_cause_raw is null then
        raise exception 'validation: יש לבחור את הגורם שאומת';
      end if;
      begin
        v_confirmed_cause := v_confirmed_cause_raw::incident_confirmed_cause;
      exception
        when invalid_text_representation then
          raise exception 'validation: הגורם שאומת שנבחר אינו תקין';
      end;
      if v_confirmed_cause = 'other' and v_confirmed_cause_other is null then
        raise exception 'validation: יש לפרט את הגורם שאומת';
      end if;
      if v_confirmed_cause <> 'other' then
        v_confirmed_cause_other := null;
      end if;

      if v_treatment_outcome_raw is null then
        raise exception 'validation: יש לבחור את תוצאת הטיפול';
      end if;
      begin
        v_treatment_outcome := v_treatment_outcome_raw::incident_treatment_outcome;
      exception
        when invalid_text_representation then
          raise exception 'validation: תוצאת הטיפול שנבחרה אינה תקינה';
      end;
      if v_treatment_outcome = 'other' and v_treatment_outcome_other is null then
        raise exception 'validation: יש לפרט את תוצאת הטיפול';
      end if;
      if v_treatment_outcome <> 'other' then
        v_treatment_outcome_other := null;
      end if;

      if v_resolution_attribution_raw is null then
        raise exception 'validation: יש לבחור מה ידוע על מה שהוביל לפתרון';
      end if;
      begin
        v_resolution_attribution := v_resolution_attribution_raw::incident_resolution_attribution;
      exception
        when invalid_text_representation then
          raise exception 'validation: הבחירה לגבי מה שהוביל לפתרון אינה תקינה';
      end;
      if v_resolution_attribution = 'other' and v_resolution_attribution_other is null then
        raise exception 'validation: יש לפרט מה ידוע על מה שהוביל לפתרון';
      end if;
      if v_resolution_attribution <> 'other' then
        v_resolution_attribution_other := null;
      end if;

      -- Outcome/attribution consistency -- also enforced by a same-table
      -- CHECK on incident_closures (0046); checked here too for a clean
      -- Hebrew error message instead of a raw constraint-violation error.
      if v_treatment_outcome = 'resolved_without_action' and v_resolution_attribution <> 'no_action_taken' then
        raise exception 'validation: כאשר התקלה נעלמה ללא פעולה, מה שהוביל לפתרון חייב להיות ''לא בוצעה פעולה''';
      end if;

      -- Optional new treatment actions recorded inline during closure --
      -- an ARRAY, since combination_of_actions may need two brand-new
      -- actions even when none were recorded earlier. Identical
      -- (actionType, otherDetail) entries within this ONE submitted array
      -- are de-duplicated -- never inserted twice for one closure -- while
      -- the same action type recorded again in a later, separate
      -- operation remains a normal, distinct row.
      for v_action_elem in select value from jsonb_array_elements(coalesce(p_input->'newTreatmentActions', '[]'::jsonb))
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
        values (p_incident_id, v_action_type, v_action_other, v.reopen_count, v_event_time, auth.uid(), v_operation_id)
        returning id into v_new_action_id;
        v_new_action_ids := array_append(v_new_action_ids, v_new_action_id);
      end loop;

      -- Previously-recorded actions selected for this closure's
      -- resolution attribution -- de-duplicated and re-validated against
      -- this incident and its CURRENT cycle before linking (rejects a
      -- stale/foreign id).
      for v_action_id_elem in select value from jsonb_array_elements_text(coalesce(p_input->'resolutionActionIds', '[]'::jsonb))
      loop
        begin
          v_action_id := v_action_id_elem::uuid;
        exception
          when invalid_text_representation then
            raise exception 'validation: מזהה פעולה אינו תקין';
        end;
        if v_action_id = any(v_selected_ids) then
          continue;
        end if;
        select exists(
          select 1 from incident_treatment_actions
          where id = v_action_id and incident_id = p_incident_id and cycle_number = v.reopen_count
        ) into v_exists;
        if not v_exists then
          raise exception 'validation: פעולה שנבחרה אינה שייכת לתקלה זו במחזור הנוכחי';
        end if;
        v_selected_ids := array_append(v_selected_ids, v_action_id);
      end loop;

      select array_agg(distinct x) into v_all_linked_ids
      from unnest(v_new_action_ids || v_selected_ids) as x;
      v_linked_count := coalesce(array_length(v_all_linked_ids, 1), 0);

      if v_resolution_attribution = 'specific_action' and v_linked_count <> 1 then
        raise exception 'validation: יש לבחור פעולה מסוימת אחת בדיוק עבור ''פעולה מסוימת שתועדה''';
      end if;
      if v_resolution_attribution = 'combination_of_actions' and v_linked_count < 2 then
        raise exception 'validation: יש לבחור לפחות שתי פעולות שונות עבור ''שילוב של מספר פעולות''';
      end if;
      if v_resolution_attribution in ('undetermined', 'no_action_taken', 'external_party_no_details') and v_linked_count <> 0 then
        raise exception 'validation: לא ניתן לקשר פעולות כאשר לא נבחרה פעולה מסוימת או שילוב פעולות';
      end if;
    end if;
  end if;

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

    if v_write_classification then
      insert into incident_closures (
        incident_id, cycle_number, operation_id, confirmed_cause, confirmed_cause_other_detail,
        treatment_outcome, treatment_outcome_other_detail, resolution_attribution, resolution_attribution_other_detail,
        recorded_by, event_time
      ) values (
        p_incident_id, v.reopen_count, v_operation_id, v_confirmed_cause, v_confirmed_cause_other,
        v_treatment_outcome, v_treatment_outcome_other, v_resolution_attribution, v_resolution_attribution_other,
        auth.uid(), v_event_time
      ) returning id into v_closure_id;

      if v_all_linked_ids is not null then
        insert into incident_closure_resolution_actions (closure_id, treatment_action_id)
        select v_closure_id, x from unnest(v_all_linked_ids) as x
        on conflict do nothing;
      end if;
    end if;

    insert into incident_events (incident_id, type, actor_id, new_value, note, user_note, ref_id, event_time, operation_id)
    values (p_incident_id, 'closed', auth.uid(), v_readiness::text,
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון שבוצע: ' || v.resolution, v_user_note, v_closure_id, v_event_time, v_operation_id);
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

revoke execute on function close_incident_impl(uuid, jsonb, boolean) from public, anon, authenticated;

-- =====================================================================
-- 4. close_incident (permissive, unchanged signature/grants) and
--    close_incident_v2 (new, always-enforcing on the full-readiness
--    branch; the partial-readiness branch is identical either way).
-- =====================================================================
create or replace function close_incident(p_incident_id uuid, p_input jsonb) returns incidents
language sql security definer set search_path = public as $$
  select close_incident_impl(p_incident_id, p_input, false);
$$;

create or replace function close_incident_v2(p_incident_id uuid, p_input jsonb) returns incidents
language sql security definer set search_path = public as $$
  select close_incident_impl(p_incident_id, p_input, true);
$$;

revoke execute on function close_incident_v2(uuid, jsonb) from public, anon;
grant execute on function close_incident_v2(uuid, jsonb) to authenticated;

-- =====================================================================
-- 5. update_incident -- updated IN PLACE (same signature/grants): a
--    currently-deployed old client never sends suspectedCause/
--    treatmentActions, so this addition is fully invisible to it.
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

-- =====================================================================
-- 6. technician_update_incident -- updated IN PLACE, same additions as
--    update_incident above (technicians are explicitly permitted to
--    record cause/action classification on their own updates, per spec:
--    "anyone currently allowed to post the relevant incident update may
--    set optional cause/action details in that update").
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

  insert into incident_updates (incident_id, author_id, event_time, actions_taken, findings, next_steps, current_status_text, user_note)
  values (p_incident_id, auth.uid(), v_event_time,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''),
          nullif(trim(coalesce(p_input->>'currentStatusText', '')), ''), v_user_note)
  returning id into v_update_id;
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id, operation_id)
  values (p_incident_id, 'update', auth.uid(), v_event_time, v_update_id, v_operation_id);

  if v_cause_changed then
    insert into incident_cause_assessments (incident_id, cause, other_detail, cycle_number, recorded_by, event_time, operation_id)
    values (p_incident_id, v_new_suspected_cause, v_new_suspected_cause_other, v.reopen_count, auth.uid(), v_event_time, v_operation_id);
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'cause_assessment_changed', auth.uid(), 'current_suspected_cause',
            coalesce(v.current_suspected_cause::text, ''), v_new_suspected_cause::text, v_event_time, v_operation_id);
  end if;

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

  update incidents set
    version = version + 1, updated_by = auth.uid(), last_update_at = now(),
    current_suspected_cause = case when v_suspected_cause_provided then v_new_suspected_cause else v.current_suspected_cause end,
    current_suspected_cause_other_detail = case when v_suspected_cause_provided then v_new_suspected_cause_other else v.current_suspected_cause_other_detail end
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
-- 7. reopen_incident -- updated IN PLACE: gains exactly two more
--    assignments in its existing UPDATE statement, resetting the
--    denormalized current-suspected-cause mirror to NULL. Never carries
--    the previous cycle's suspected cause -- let alone the just-
--    superseded confirmed cause from the prior incident_closures row --
--    forward as if freshly reconfirmed. Every prior incident_cause_
--    assessments row and the prior incident_closures row are untouched
--    (append-only) and remain fully visible as history; the reopened
--    cycle simply begins with no current assessment ("לא הוזנה הערכת
--    גורם"), exactly like an incident that has never been assessed.
--    This column is one a currently-deployed old frontend has never read
--    or written, so the change is fully invisible to it.
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
    current_suspected_cause = null, current_suspected_cause_other_detail = null,
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
