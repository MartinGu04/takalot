-- מעקב תקלות — forward migration.
-- Wires 0027's new column into the two RPCs that accept update content, and
-- removes operational-impact editing from the update flow. Each function
-- below is reproduced in full per this schema's own convention (0017,
-- 0020, 0023, 0026), re-verified against the exact currently active
-- definition (0026) before being touched.
--
-- 1. update_incident / technician_update_incident -- both now accept and
--    persist current_status_text (0027's new column) on the
--    incident_updates row they insert. Stage 1 of a two-stage rollout: a
--    missing or blank value is stored as NULL and never rejected here. A
--    later, separate migration may add rejection once a hosted
--    verification query confirms every post-cutover row already has one;
--    that gate has not been evaluated and nothing here anticipates it.
--
-- 2. update_incident -- the new frontend no longer offers operational-impact
--    editing (the value set at incident creation stands as the permanent
--    opening fact), but the RPC itself stays backward-compatible rather
--    than silently discarding a legacy client's explicit edit: a
--    `p_input ? 'operationalImpact'` existence check (the same pattern
--    0030 uses for nextUpdateDue/noDeadlineReason) means a browser tab
--    still running the previous frontend bundle -- which always sent this
--    key -- continues to have its edit persisted and its 'impact_change'
--    event emitted exactly as before, for as long as the value it submits
--    genuinely differs. The new frontend omits the key entirely, in which
--    case the existing value is carried forward untouched and no event
--    fires. Historical operational_impact values and historical
--    impact_change events are untouched either way.
--
-- create_incident is NOT touched here -- it never had an operational_impact
-- editing concern (it's the RPC that WRITES the opening fact) and this
-- migration adds no no-ETA validation to it (that concept was evaluated and
-- explicitly cancelled; see 0030 for the unrelated ETA-field removal work).
--
-- Grouping/severity of transition rules, lifecycle behaviour, and every
-- other validation message are byte-for-byte unchanged below. Every
-- v_operation_id / event_time propagation pattern from 0026 is preserved
-- as-is -- this file adds no new incident_events row and removes exactly
-- one (impact_change).

-- =====================================================================
-- 1. update_incident (unchanged since 0026 except for the additions below)
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
  v_new_owner_ext text := nullif(trim(coalesce(p_input->>'ownerExternalName', '')), '');
  v_new_due timestamptz := (p_input->>'nextUpdateDue')::timestamptz;
  v_impact_provided boolean := p_input ? 'operationalImpact';
  v_new_impact text;
  v_old_owner_label text;
  v_new_owner_label text;
  v_new_reported_ops reported_to_ops := (p_input->>'reportedToOps')::reported_to_ops;
  v_new_recipient text := case when (p_input->>'reportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'reportedToOpsRecipient', '')), '') else null end;
  v_event_time_raw text := nullif(trim(coalesce(p_input->>'eventTime', '')), '');
  v_event_time timestamptz;
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה לעדכן תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
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
  perform assert_owner_valid(v_new_owner);
  if v_new_reported_ops = 'yes' and v_new_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;

  insert into incident_updates (incident_id, author_id, event_time, actions_taken, findings, next_steps, current_status_text)
  values (p_incident_id, auth.uid(), v_event_time,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''),
          nullif(trim(coalesce(p_input->>'currentStatusText', '')), ''))
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
  if coalesce(v_new_owner::text, coalesce(v_new_owner_ext, '')) <> coalesce(v.owner_user_id::text, coalesce(v.owner_external_name, '')) then
    select coalesce((select full_name from profiles where id = v.owner_user_id), v.owner_external_name, 'ללא') into v_old_owner_label;
    select coalesce((select full_name from profiles where id = v_new_owner), v_new_owner_ext, 'ללא') into v_new_owner_label;
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_owner_label, v_new_owner_label,
            v_event_time, v_operation_id);
    perform write_audit('incident_assigned', 'incident', p_incident_id::text, v.number,
      jsonb_build_object('owner', v_old_owner_label), jsonb_build_object('owner', v_new_owner_label));
    if v_new_owner is not null and v_new_owner <> auth.uid() then
      insert into notifications (user_id, type, incident_id, text)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.');
    end if;
  end if;
  if coalesce(v_new_due, 'epoch'::timestamptz) <> coalesce(v.next_update_due, 'epoch'::timestamptz) then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'deadline_change', auth.uid(), 'next_update_due',
            v.next_update_due::text, v_new_due::text,
            case when v_new_due is null then 'ללא צפי כרגע: ' || coalesce(p_input->>'noDeadlineReason', '') end,
            v_event_time, v_operation_id);
  end if;
  if v_new_reported_ops <> v.reported_to_ops or v_new_recipient is distinct from v.reported_to_ops_recipient then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
            v.reported_to_ops_recipient, v_new_recipient,
            'דווח למבצעים: ' || v_new_reported_ops::text || coalesce(' (' || v_new_recipient || ')', ''),
            v_event_time, v_operation_id);
  end if;

  update incidents set
    status = v_new_status,
    severity = v_new_severity,
    operational_impact = v_new_impact,
    owner_user_id = v_new_owner,
    owner_external_name = case when v_new_owner is null then v_new_owner_ext else null end,
    next_update_due = v_new_due,
    no_deadline_reason = case when v_new_due is null then nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), '') else null end,
    reported_to_ops = v_new_reported_ops,
    reported_to_ops_recipient = v_new_recipient,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  perform write_audit('incident_updated', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- =====================================================================
-- 2. technician_update_incident (unchanged since 0026 except the addition below)
-- =====================================================================
create or replace function technician_update_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_update_id uuid;
  v_operation_id uuid := gen_random_uuid();
  v_event_time_raw text := nullif(trim(coalesce(p_input->>'eventTime', '')), '');
  v_event_time timestamptz;
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

  insert into incident_updates (incident_id, author_id, event_time, actions_taken, findings, next_steps, current_status_text)
  values (p_incident_id, auth.uid(), v_event_time,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''),
          nullif(trim(coalesce(p_input->>'currentStatusText', '')), ''))
  returning id into v_update_id;
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id, operation_id)
  values (p_incident_id, 'update', auth.uid(), v_event_time, v_update_id, v_operation_id);

  update incidents set version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;
  perform write_audit('incident_technical_update', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;
