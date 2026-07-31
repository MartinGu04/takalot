-- מעקב תקלות — forward migration.
-- Retroactive closure time (PR D, focused scope): close_incident gains a
-- required, validated eventTime -- the actual moment the closure happened,
-- distinct from server_time (when Nexus recorded it). Mirrors the exact
-- guarded-cast + bounds-check shape update_incident already uses (migration
-- 0020/0031), not cancel_incident's older unguarded cast.
--
-- What changes, precisely:
--   - closed_at (full-readiness branch only) is set to the validated
--     eventTime instead of now().
--   - Every incident_events row this call inserts -- 'closed',
--     'reported_to_ops_change', 'assignment_change' (external handler), and
--     (partial-readiness branch) 'status_change' -- carries this same
--     eventTime as its event_time, exactly as they already share one
--     operation_id. server_time keeps its own now() column default
--     unchanged, so it remains the authoritative "when this was recorded"
--     value the Timeline already knows how to render distinctly whenever it
--     differs from event_time by more than 60 seconds.
--   - Applies identically to both the full- and partial-readiness branches:
--     the bound describes "when did this closure action happen," not
--     "when did the incident actually close" -- closed_at itself is still
--     only ever written in the full-readiness branch, unchanged.
--
-- Deliberately NOT in scope (per instructions): reporting fields/recipients/
-- storage, exports, readiness behavior, ownership behavior, any other UI.
-- Everything else in this function's body is byte-for-byte identical to the
-- currently active definition (migration 0032), reproduced in full below
-- per this schema's own "complete body every time" convention.
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
begin
  if not is_operational_role() then
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

    insert into incident_events (incident_id, type, actor_id, new_value, note, event_time, operation_id)
    values (p_incident_id, 'closed', auth.uid(), v_readiness::text,
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון שבוצע: ' || v.resolution, v_event_time, v_operation_id);
    perform write_audit('incident_closed', 'incident', p_incident_id::text, v.number,
      null, jsonb_build_object('readiness', v_readiness));
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
    end if;
  else
    -- Incomplete readiness: the incident stays active as "כשירות חלקית" --
    -- it is never marked closed while follow-up is still outstanding.
    -- readiness_at_close is left untouched: it only ever describes readiness
    -- AT AN ACTUAL CLOSE, and this incident has not closed (also enforced by
    -- incident_closed_requires_full_readiness). closed_at is likewise left
    -- untouched here -- the validated eventTime still stamps this branch's
    -- own events below (this is "when the closure action was attempted,"
    -- not an actual close), but it is never written to closed_at.
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

    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'status_change', auth.uid(), 'status', v_old_status::text, 'partial_readiness',
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון החלקי שבוצע: ' || v.resolution ||
            E'\nפעולות המשך: ' || v.follow_up_notes || E'\nגורם מטפל אחראי המשך: ' || v_owner_label,
            v_event_time, v_operation_id);
    perform write_audit('incident_partial_readiness', 'incident', p_incident_id::text, v.number,
      null, jsonb_build_object('readiness', v_readiness));
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
    end if;
  end if;
  return v;
end;
$$;
