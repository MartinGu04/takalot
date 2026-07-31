-- מעקב תקלות — forward migration.
-- Removes the "next update ETA" concept as an active, required feature of
-- incident creation, full update, and reopening -- it is no longer offered
-- as a question the frontend asks the user. The next_update_due and
-- no_deadline_reason COLUMNS are not dropped, no historical value is
-- rewritten, and every historical deadline_change timeline event keeps
-- rendering exactly as before -- this migration only stops requiring and
-- actively driving the concept going forward.
--
-- ===== The constraint =====
-- incident_deadline_or_reason (0001) required, for any non-closed incident,
-- that at least one of next_update_due/no_deadline_reason be non-null. That
-- pairing requirement no longer reflects the product: a new incident may
-- legally leave both NULL. Dropped outright (not replaced with a weaker
-- version) -- there is no new invariant to enforce in its place.
--
-- ===== The RPCs =====
-- create_incident needs NO change: `(p_input->>'nextUpdateDue')::timestamptz`
-- already evaluates to NULL when the key is absent from p_input (a jsonb
-- `->>` on a missing key returns SQL NULL, and casting NULL is NULL), and a
-- brand-new row has no prior value to preserve. With the constraint above
-- gone, the new frontend omitting both keys now succeeds with NULL/NULL,
-- exactly as intended -- nothing in create_incident's body needed to
-- change for that to be true.
--
-- update_incident and reopen_incident are different: both previously
-- re-derived next_update_due/no_deadline_reason from p_input on EVERY
-- call, unconditionally. If the new frontend simply omitted the keys, that
-- same unconditional re-derivation would silently NULL OUT an existing
-- legacy incident's stored value on its very next update or reopen --
-- exactly what this change must not do. Both functions below gain a
-- `p_input ? 'key'` existence check (jsonb's key-presence operator, true
-- only when the key is actually present in the payload, independent of
-- whether its value is JSON null): when the key is present, the supplied
-- value is used (so a legacy client, still sending both keys during the
-- compatibility window between this migration landing and the new
-- frontend deploying, continues to have its values honored exactly as
-- before); when the key is absent (the new frontend's contract), the
-- incident's own current value is carried forward unchanged.
--
-- reopen_incident's own frontend/schema never had a noDeadlineReason key at
-- all (only a required nextUpdateDue) -- the existence check is added for
-- it anyway, for symmetry and to protect a direct API caller, but in
-- practice v_reason_provided is always false for this RPC either way,
-- meaning a reopen's no_deadline_reason simply carries forward whatever
-- close_incident last left it as. Nothing renders that value live anywhere
-- in the product after this PR, so this is inert.
--
-- No no-ETA "meaningfulness" validation is added anywhere -- that idea was
-- evaluated and explicitly cancelled, not merely deferred.

alter table incidents
  drop constraint incident_deadline_or_reason;

-- =====================================================================
-- 1. update_incident (unchanged since 0029 except for the additions below)
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
  v_due_provided boolean := p_input ? 'nextUpdateDue';
  v_reason_provided boolean := p_input ? 'noDeadlineReason';
  v_new_due timestamptz;
  v_new_reason text;
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
  v_new_due := case when v_due_provided then (p_input->>'nextUpdateDue')::timestamptz else v.next_update_due end;
  v_new_reason := case when v_reason_provided then nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), '') else v.no_deadline_reason end;
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
            case when v_new_due is null then 'ללא צפי כרגע: ' || coalesce(v_new_reason, '') end,
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
    owner_user_id = v_new_owner,
    owner_external_name = case when v_new_owner is null then v_new_owner_ext else null end,
    next_update_due = v_new_due,
    no_deadline_reason = v_new_reason,
    reported_to_ops = v_new_reported_ops,
    reported_to_ops_recipient = v_new_recipient,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  perform write_audit('incident_updated', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- =====================================================================
-- 2. reopen_incident (unchanged since 0026 except for the additions below)
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
begin
  if not (v_role in ('system_admin', 'professional_manager') or (v_role = 'shift_supervisor' and v_allow_supervisor)) then
    raise exception 'permission: אין הרשאה לפתוח מחדש תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  v_new_due := case when v_due_provided then (p_input->>'nextUpdateDue')::timestamptz else v.next_update_due end;
  v_new_reason := case when v_reason_provided then nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), '') else v.no_deadline_reason end;
  if v.status <> 'closed' then
    raise exception 'invalid_transition: ניתן לפתוח מחדש רק תקלה סגורה';
  end if;
  if length(trim(coalesce(p_input->>'reason', ''))) = 0 then
    raise exception 'validation: יש להזין סיבה לפתיחה מחדש';
  end if;
  perform assert_owner_valid(v_new_owner);

  insert into incident_events (incident_id, type, actor_id, old_value, new_value, note, operation_id)
  values (p_incident_id, 'reopened', auth.uid(), 'closed', 'reopened', trim(p_input->>'reason'), v_operation_id);
  perform write_audit('incident_reopened', 'incident', p_incident_id::text, v.number,
    null, jsonb_build_object('reason', trim(p_input->>'reason')));

  update incidents set
    status = 'reopened',
    owner_user_id = v_new_owner,
    owner_external_name = case when v_new_owner is null then nullif(trim(coalesce(p_input->>'ownerExternalName', '')), '') else null end,
    next_update_due = v_new_due,
    no_deadline_reason = v_new_reason,
    closed_at = null, closed_by = null,
    follow_up_required = false, follow_up_completed_at = null, follow_up_completed_by = null,
    reopen_count = reopen_count + 1,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  if v.owner_user_id is not null and v.owner_user_id <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text)
    values (v.owner_user_id, 'incident_reopened', p_incident_id,
            'תקלה ' || v.number || ' נפתחה מחדש והוקצתה אליך.');
  end if;
  return v;
end;
$$;
