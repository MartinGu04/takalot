-- מעקב תקלות — forward migration.
-- Timeline grouping foundation, part 2 of 2: every RPC that can insert more
-- than one incident_events row (or that inserts exactly one row that still
-- deserves the same id for a later grouped-by-operation query) now stamps
-- all of its own event rows with one shared operation_id -- a single
-- `v_operation_id uuid := gen_random_uuid();`, computed once per call and
-- passed to every incident_events insert that call makes. NOT stamped
-- retroactively: every row written before this migration keeps
-- operation_id = NULL forever (0025's header explains why), and this
-- migration writes NOTHING to any existing row -- it only changes what
-- future calls insert.
--
-- Each function below is reproduced in full, per this schema's own
-- established convention (0017, 0020, 0023, ...): `create or replace
-- function` requires the complete body, and every body here is re-verified
-- against the exact currently active definition before being touched, not
-- rewritten from a stale copy.
--
-- ===== Event-time propagation (the second, narrower change in this file) =====
-- update_incident and create_incident are the only two RPCs where a
-- validated, user-selected event time already exists (v_event_time /
-- discovered_at) but was NOT being carried onto every row the call inserts:
--   * update_incident's own 'update' row has always carried v_event_time,
--     but its six CONDITIONAL secondary rows (status_change, severity_change,
--     impact_change, assignment_change, deadline_change,
--     reported_to_ops_change) omitted event_time entirely and therefore
--     silently defaulted to now() -- so a technician documenting a change
--     three days late got a correctly backdated 'update' row sitting next to
--     six secondary rows stamped with today's date.
--   * create_incident's 'created' row has always used discovered_at; its two
--     conditional secondary rows (status_change, reported_to_ops_change)
--     had the same gap.
-- Every other function touched here either already propagates its own
-- validated event time to every row it writes (cancel_incident,
-- add_incident_report, set_incident_status_check -- 0017/0020's own prior
-- work), or has no event-time input at all (close_incident,
-- assign_incident, reopen_incident, acknowledge_incident, complete_follow_up,
-- add_incident_correction, create_handover, accept_handover) -- for those,
-- every row a single call inserts is written in the same transaction and
-- therefore already carries one identical `now()`-derived event_time, so
-- grouping by operation_id needs no further correction there. Inventing a
-- user-facing event-time field for close_incident is a separate, later
-- product change (retroactive closure time), explicitly out of scope here.
--
-- ===== What this migration explicitly does NOT do =====
-- No GRANT or REVOKE statement appears anywhere below. CREATE OR REPLACE
-- FUNCTION preserves a function's existing privileges, SECURITY DEFINER
-- setting, owner, and search_path exactly as they already are -- it cannot
-- change any of them -- so every function's existing ACL (including
-- add_incident_report's and set_incident_status_check's still-deliberately-
-- ABSENT `authenticated` grant, see 0017 §19 and 0018) is untouched by
-- construction, not merely by omission. This migration's own test suite
-- (chapter3_event_operation_id.sql) asserts exactly that: a before/after
-- snapshot diff of pg_proc's ACL, prosecdef, proowner, argument signature,
-- and proconfig (search_path) for every function this file replaces.
-- Grouping/severity of transition rules, lifecycle behaviour, validation
-- messages, and every non-incident_events write are byte-for-byte unchanged
-- below -- only `v_operation_id` declarations and `operation_id`/`event_time`
-- columns are added to existing insert statements.

-- =====================================================================
-- 1. create_incident (unchanged since 0023 except for the additions below)
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

  insert into incidents (
    number, system_id, location_id, description, severity, status, operational_impact,
    owner_user_id, owner_external_name, discovered_at, created_by, updated_by,
    next_update_due, no_deadline_reason, reported_to_ops, reported_to_ops_recipient,
    reported_to_comms, reported_to_comms_recipient, wisdom_reported, wisdom_incident_number
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
    v_reported_comms, v_comms_recipient, v_wisdom_reported, v_wisdom_number
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
-- 2. update_incident (unchanged since 0020 except for the additions below)
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

  insert into incident_updates (incident_id, author_id, event_time, actions_taken, findings, next_steps)
  values (p_incident_id, auth.uid(), v_event_time,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''))
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
  if trim(p_input->>'operationalImpact') <> v.operational_impact then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'impact_change', auth.uid(), 'operational_impact',
            v.operational_impact, trim(p_input->>'operationalImpact'), v_event_time, v_operation_id);
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
    operational_impact = trim(p_input->>'operationalImpact'),
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
-- 3. technician_update_incident (unchanged since 0020 except the addition below)
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

  insert into incident_updates (incident_id, author_id, event_time, actions_taken, findings, next_steps)
  values (p_incident_id, auth.uid(), v_event_time,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''))
  returning id into v_update_id;
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id, operation_id)
  values (p_incident_id, 'update', auth.uid(), v_event_time, v_update_id, v_operation_id);

  update incidents set version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;
  perform write_audit('incident_technical_update', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- =====================================================================
-- 4. close_incident (unchanged since 0017 except the additions below).
--    No eventTime input exists on this RPC yet (retroactive closure time is
--    a separate, later product change) -- every row a single call inserts
--    still falls back to now(), which is one identical value within this
--    call's transaction, so operation_id alone is sufficient to group them.
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
  v_new_owner_ext text := nullif(trim(coalesce(p_input->>'ownerExternalName', '')), '');
  v_reported_ops reported_to_ops := (p_input->>'reportedToOps')::reported_to_ops;
  v_recipient text := case when (p_input->>'reportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'reportedToOpsRecipient', '')), '') else null end;
  v_old_status incident_status;
  v_owner_label text;
  v_old_reported_ops reported_to_ops;
  v_old_recipient text;
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
  if length(trim(coalesce(p_input->>'rootCause', ''))) = 0 or length(trim(coalesce(p_input->>'resolution', ''))) = 0 then
    raise exception 'validation: סיבת התקלה והפתרון שבוצע הם שדות חובה';
  end if;
  if not v_full_ready then
    if v_follow_up is null then
      raise exception 'validation: בסגירה עם כשירות חלקית יש לפרט פעולות המשך';
    end if;
    if v_new_owner is null and v_new_owner_ext is null then
      raise exception 'validation: כאשר הכשירות אינה מלאה יש לקבוע גורם מטפל אחראי המשך';
    end if;
  end if;
  if v_reported_ops = 'yes' and v_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;
  perform assert_owner_valid(v_new_owner);

  v_old_status := v.status;

  if v_full_ready then
    -- Full readiness: the incident actually closes.
    update incidents set
      status = 'closed', closed_at = now(), closed_by = auth.uid(),
      root_cause = trim(p_input->>'rootCause'), resolution = trim(p_input->>'resolution'),
      readiness_at_close = v_readiness, follow_up_notes = v_follow_up,
      follow_up_required = false,
      reported_to_ops = v_reported_ops, reported_to_ops_recipient = v_recipient,
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
  else
    -- Incomplete readiness: the incident stays active as "כשירות חלקית" --
    -- it is never marked closed while follow-up is still outstanding.
    -- readiness_at_close is left untouched: it only ever describes readiness
    -- AT AN ACTUAL CLOSE, and this incident has not closed (also enforced by
    -- incident_closed_requires_full_readiness).
    select coalesce((select full_name from profiles where id = v_new_owner), v_new_owner_ext, 'ללא') into v_owner_label;

    update incidents set
      status = 'partial_readiness',
      owner_user_id = v_new_owner,
      owner_external_name = case when v_new_owner is null then v_new_owner_ext else null end,
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
  end if;
  return v;
end;
$$;

-- =====================================================================
-- 5. cancel_incident (unchanged since 0017 except the additions below).
--    Every insert already carries the validated v_event_time -- only
--    operation_id is new here.
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

  perform public.write_audit('incident_cancelled', 'incident', p_incident_id::text, v_before.number,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', v_after.status, 'cancellationReason', v_after.cancellation_reason));
  return v_after;
end;
$$;

-- =====================================================================
-- 6. assign_incident (unchanged since 0017 except the addition below).
--    No eventTime input; the single row keeps its default now().
-- =====================================================================
create or replace function assign_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
  v_new_owner_ext text := nullif(trim(coalesce(p_input->>'ownerExternalName', '')), '');
  v_old_label text;
  v_new_label text;
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה לשנות גורם מטפל';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  if is_incident_terminal(v.status) then
    raise exception 'invalid_transition: לא ניתן לשנות גורם מטפל בתקלה סגורה או מבוטלת';
  end if;
  perform assert_owner_valid(v_new_owner);

  select coalesce((select full_name from profiles where id = v.owner_user_id), v.owner_external_name, 'ללא') into v_old_label;
  select coalesce((select full_name from profiles where id = v_new_owner), v_new_owner_ext, 'ללא') into v_new_label;

  insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, operation_id)
  values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_label, v_new_label,
          nullif(trim(coalesce(p_input->>'note', '')), ''), v_operation_id);
  perform write_audit('incident_assigned', 'incident', p_incident_id::text, v.number,
    jsonb_build_object('owner', v_old_label), jsonb_build_object('owner', v_new_label));
  if v_new_owner is not null and v_new_owner <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text)
    values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.');
  end if;

  update incidents set
    owner_user_id = v_new_owner,
    owner_external_name = case when v_new_owner is null then v_new_owner_ext else null end,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;
  return v;
end;
$$;

-- =====================================================================
-- 7. complete_follow_up (unchanged since 0017 except the addition below).
--    No eventTime input; the single row keeps its default now().
-- =====================================================================
create or replace function complete_follow_up(p_incident_id uuid, p_note text) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה';
  end if;
  select * into v from incidents where id = p_incident_id for update;
  if v.id is null then raise exception 'not_found: התקלה לא נמצאה'; end if;
  if is_incident_terminal(v.status) then
    raise exception 'invalid_transition: לא ניתן להשלים פעולות המשך לתקלה סגורה או מבוטלת';
  end if;
  if not v.follow_up_required or v.follow_up_completed_at is not null then
    raise exception 'validation: לתקלה זו אין פעולות המשך פתוחות';
  end if;
  if length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'validation: יש לפרט מה בוצע';
  end if;
  update incidents set follow_up_completed_at = now(), follow_up_completed_by = auth.uid(),
    version = version + 1, updated_by = auth.uid()
  where id = p_incident_id returning * into v;
  insert into incident_events (incident_id, type, actor_id, note, operation_id)
  values (p_incident_id, 'follow_up_completed', auth.uid(), trim(p_note), v_operation_id);
  perform write_audit('incident_follow_up_completed', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- =====================================================================
-- 8. add_incident_report (unchanged since 0017 except the addition below).
--    The single row already carries the validated v_event_time.
-- =====================================================================
create or replace function public.add_incident_report(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.incidents;
  v_after public.incidents;
  v_expected_version int;
  v_operation_id uuid := gen_random_uuid();
  v_channel public.incident_report_channel;
  v_status public.reported_to_ops;
  v_event_time timestamptz;
  v_reported_at timestamptz;
  v_reported_by uuid := (p_input->>'reportedByUserId')::uuid;
  v_reported_ext text := nullif(trim(coalesce(p_input->>'reportedByExternalName', '')), '');
  v_recipient text := nullif(trim(coalesce(p_input->>'recipient', '')), '');
  v_note text := nullif(trim(coalesce(p_input->>'note', '')), '');
  v_report_id uuid;
  v_event_type public.incident_event_type;
begin
  if not public.is_operational_role() then
    raise exception 'permission: אין הרשאה לדווח למבצעים';
  end if;

  if p_input->>'expectedVersion' is null then
    raise exception 'validation: expectedVersion is required';
  end if;
  v_expected_version := (p_input->>'expectedVersion')::int;

  if p_input->>'eventTime' is null then
    raise exception 'validation: eventTime is required';
  end if;
  v_event_time := (p_input->>'eventTime')::timestamptz;

  if p_input->>'channel' is null or p_input->>'channel' not in ('ops_room', 'ops_communications') then
    raise exception 'validation: channel is required and must be ops_room or ops_communications';
  end if;
  v_channel := (p_input->>'channel')::public.incident_report_channel;

  if p_input->>'status' is null or p_input->>'status' not in ('yes', 'no', 'not_required') then
    raise exception 'validation: status is required and must be yes, no, or not_required';
  end if;
  v_status := (p_input->>'status')::public.reported_to_ops;

  if v_reported_by is not null and v_reported_ext is not null then
    raise exception 'validation: reportedByUserId and reportedByExternalName are mutually exclusive';
  end if;

  v_before := public.lock_incident_checked(p_incident_id, v_expected_version);
  if public.is_incident_terminal(v_before.status) then
    raise exception 'invalid_transition: לא ניתן לדווח על תקלה סגורה או מבוטלת';
  end if;
  if v_event_time < v_before.discovered_at or v_event_time > now() + interval '5 minutes' then
    raise exception 'validation: מועד ההחלטה אינו תקין';
  end if;

  if v_status = 'yes' then
    if p_input->>'reportedAt' is null then
      raise exception 'validation: reportedAt is required when status is yes';
    end if;
    v_reported_at := (p_input->>'reportedAt')::timestamptz;
    if v_reported_at < v_before.discovered_at or v_reported_at > now() + interval '5 minutes' or v_reported_at < v_event_time then
      raise exception 'validation: מועד הדיווח בפועל אינו תקין';
    end if;
    if v_recipient is null then
      raise exception 'validation: יש להזין למי דווח';
    end if;
    if v_reported_by is null and v_reported_ext is null then
      raise exception 'validation: יש לציין מי דיווח';
    end if;
  else
    if p_input->>'reportedAt' is not null or p_input->'recipient' is not null
       or v_reported_by is not null or v_reported_ext is not null then
      raise exception 'validation: reportedAt/recipient/performer are not applicable unless status is yes';
    end if;
  end if;

  perform public.assert_active_profile_if_set(v_reported_by);

  insert into public.incident_report_events (
    incident_id, channel, status, reported_by_user_id, reported_by_external_name,
    recorded_by, event_time, reported_at, recipient, note
  ) values (
    p_incident_id, v_channel, v_status, v_reported_by, v_reported_ext,
    auth.uid(), v_event_time, v_reported_at, v_recipient, v_note
  ) returning id into v_report_id;

  v_event_type := case v_channel
    when 'ops_room' then 'reported_to_ops_room'
    when 'ops_communications' then 'reported_to_ops_communications'
  end;
  insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
  values (p_incident_id, v_event_type, auth.uid(), 'status', null, v_status::text, v_note, v_report_id, v_event_time, v_operation_id);

  update public.incidents set
    version = version + 1, updated_at = now(), updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v_after;

  perform public.write_audit('incident_report_recorded', 'incident', p_incident_id::text, v_before.number,
    jsonb_build_object('channel', v_channel),
    jsonb_build_object('channel', v_channel, 'status', v_status, 'reportEventId', v_report_id));

  return v_after;
end;
$$;

-- =====================================================================
-- 9. set_incident_status_check (unchanged since 0017 except the additions
--    below). Every row already carries the validated v_event_time.
-- =====================================================================
create or replace function public.set_incident_status_check(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.incidents;
  v_after public.incidents;
  v_expected_version int;
  v_operation_id uuid := gen_random_uuid();
  v_kind public.incident_status_check_kind;
  v_event_time timestamptz;
  v_due_at timestamptz;
  v_next_due_at timestamptz;
  v_performed_by uuid := (p_input->>'performedByUserId')::uuid;
  v_performed_ext text := nullif(trim(coalesce(p_input->>'performedByExternalName', '')), '');
  v_note text := nullif(trim(coalesce(p_input->>'note', '')), '');
  v_check_id uuid;
  v_next_check_id uuid;
  v_before_due timestamptz;
  v_after_due timestamptz;
begin
  if not public.is_operational_role() then
    raise exception 'permission: אין הרשאה לעדכן בדיקת סטטוס';
  end if;

  if p_input->>'expectedVersion' is null then
    raise exception 'validation: expectedVersion is required';
  end if;
  v_expected_version := (p_input->>'expectedVersion')::int;

  if p_input->>'kind' is null or p_input->>'kind' not in ('scheduled', 'rescheduled', 'completed', 'removed') then
    raise exception 'validation: kind is required and must be scheduled, rescheduled, completed, or removed';
  end if;
  v_kind := (p_input->>'kind')::public.incident_status_check_kind;

  if p_input->>'eventTime' is null then
    raise exception 'validation: eventTime is required';
  end if;
  v_event_time := (p_input->>'eventTime')::timestamptz;

  if v_performed_by is not null and v_performed_ext is not null then
    raise exception 'validation: performedByUserId and performedByExternalName are mutually exclusive';
  end if;

  v_before := public.lock_incident_checked(p_incident_id, v_expected_version);
  if public.is_incident_terminal(v_before.status) then
    raise exception 'invalid_transition: לא ניתן לעדכן בדיקת סטטוס לתקלה סגורה או מבוטלת';
  end if;
  if v_event_time < v_before.discovered_at or v_event_time > now() + interval '5 minutes' then
    raise exception 'validation: מועד האירוע אינו תקין';
  end if;
  perform public.assert_active_profile_if_set(v_performed_by);
  v_before_due := v_before.status_check_due;

  if v_kind in ('scheduled', 'rescheduled') then
    if p_input->'nextDueAt' is not null then
      raise exception 'validation: nextDueAt is not applicable for %', v_kind;
    end if;
    if p_input->>'dueAt' is null then
      raise exception 'validation: dueAt is required for %', v_kind;
    end if;
    v_due_at := (p_input->>'dueAt')::timestamptz;
    if v_due_at < v_event_time then
      raise exception 'validation: מועד היעד אינו יכול להיות לפני מועד האירוע';
    end if;
  elsif v_kind = 'completed' then
    if p_input->'dueAt' is not null then
      raise exception 'validation: dueAt is not applicable for completed';
    end if;
    if p_input->>'nextDueAt' is not null then
      v_next_due_at := (p_input->>'nextDueAt')::timestamptz;
      if v_next_due_at < v_event_time then
        raise exception 'validation: מועד היעד הבא אינו יכול להיות לפני מועד האירוע';
      end if;
    end if;
    if v_performed_by is null and v_performed_ext is null then
      raise exception 'validation: יש לציין מי ביצע את הבדיקה';
    end if;
  elsif v_kind = 'removed' then
    if p_input->'dueAt' is not null or p_input->'nextDueAt' is not null then
      raise exception 'validation: dueAt/nextDueAt are not applicable for removed';
    end if;
  else
    raise exception 'validation: kind not supported: %', v_kind;
  end if;

  if v_kind = 'scheduled' and v_before_due is not null then
    raise exception 'validation: קיימת כבר בדיקת סטטוס מתוזמנת';
  end if;
  if v_kind in ('rescheduled', 'removed', 'completed') and v_before_due is null then
    raise exception 'validation: אין בדיקת סטטוס מתוזמנת';
  end if;

  if v_kind = 'scheduled' then
    insert into public.incident_status_checks
      (incident_id, kind, due_at, performed_by_user_id, performed_by_external_name, recorded_by, event_time, note)
    values (p_incident_id, 'scheduled', v_due_at, v_performed_by, v_performed_ext, auth.uid(), v_event_time, v_note)
    returning id into v_check_id;
    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', null, v_due_at::text, v_note, v_check_id, v_event_time, v_operation_id);
    v_after_due := v_due_at;

  elsif v_kind = 'rescheduled' then
    insert into public.incident_status_checks
      (incident_id, kind, due_at, previous_due_at, performed_by_user_id, performed_by_external_name, recorded_by, event_time, note)
    values (p_incident_id, 'rescheduled', v_due_at, v_before_due, v_performed_by, v_performed_ext, auth.uid(), v_event_time, v_note)
    returning id into v_check_id;
    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', v_before_due::text, v_due_at::text, v_note, v_check_id, v_event_time, v_operation_id);
    v_after_due := v_due_at;

  elsif v_kind = 'removed' then
    insert into public.incident_status_checks
      (incident_id, kind, previous_due_at, performed_by_user_id, performed_by_external_name, recorded_by, event_time, note)
    values (p_incident_id, 'removed', v_before_due, v_performed_by, v_performed_ext, auth.uid(), v_event_time, v_note)
    returning id into v_check_id;
    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', v_before_due::text, null, v_note, v_check_id, v_event_time, v_operation_id);
    v_after_due := null;

  elsif v_kind = 'completed' then
    insert into public.incident_status_checks
      (incident_id, kind, previous_due_at, performed_by_user_id, performed_by_external_name, recorded_by, event_time, note)
    values (p_incident_id, 'completed', v_before_due, v_performed_by, v_performed_ext, auth.uid(), v_event_time, v_note)
    returning id into v_check_id;
    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', v_before_due::text, null, v_note, v_check_id, v_event_time, v_operation_id);
    v_after_due := null;

    if v_next_due_at is not null then
      insert into public.incident_status_checks (incident_id, kind, due_at, recorded_by, event_time, note)
      values (p_incident_id, 'scheduled', v_next_due_at, auth.uid(), v_event_time, v_note)
      returning id into v_next_check_id;
      insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
      values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', null, v_next_due_at::text, v_note, v_next_check_id, v_event_time, v_operation_id);
      v_after_due := v_next_due_at;
    end if;
  end if;

  update public.incidents set status_check_due = v_after_due,
    version = version + 1, updated_at = now(), updated_by = auth.uid(), last_update_at = now()
    where id = p_incident_id returning * into v_after;

  perform public.write_audit('incident_status_check_recorded', 'incident', p_incident_id::text, v_before.number,
    jsonb_build_object('statusCheckDue', v_before_due),
    jsonb_build_object('statusCheckDue', v_after_due, 'kind', v_kind));

  return v_after;
end;
$$;

-- =====================================================================
-- 10. create_handover (unchanged since 0017 except the addition below).
--     One operation id is allocated ONCE, outside the per-incident loop --
--     one user action, across N incidents' timelines, not N separate
--     operations. No eventTime input; each row keeps its default now().
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

  insert into notifications (user_id, type, handover_id, text, dedupe_key)
  values (v_to, 'handover_pending', v.id,
          'העברת משמרת ממתינה לאישורך.', 'handover-' || v.id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  perform write_audit('handover_created', 'handover', v.id::text);
  return v;
end;
$$;

-- =====================================================================
-- 11. reopen_incident (unchanged since 0002 except the addition below).
--     No eventTime input; the single row keeps its default now().
-- =====================================================================
create or replace function reopen_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
  v_role app_role := my_role();
  v_allow_supervisor boolean := coalesce((select value::text = 'true' from app_policy where key = 'allow_supervisor_reopen'), false);
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
begin
  if not (v_role in ('system_admin', 'professional_manager') or (v_role = 'shift_supervisor' and v_allow_supervisor)) then
    raise exception 'permission: אין הרשאה לפתוח מחדש תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
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
    next_update_due = (p_input->>'nextUpdateDue')::timestamptz,
    no_deadline_reason = null,
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

-- =====================================================================
-- 12. acknowledge_incident (unchanged since 0002 except the addition
--     below). No eventTime input; the single row keeps its default now().
-- =====================================================================
create or replace function acknowledge_incident(p_incident_id uuid, p_expected_version int) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה';
  end if;
  v := lock_incident_checked(p_incident_id, p_expected_version);
  if v.status <> 'new' then
    raise exception 'invalid_transition: ניתן לאשר קבלה רק לתקלה חדשה';
  end if;
  update incidents set status = 'acknowledged', version = version + 1,
    updated_by = auth.uid(), last_update_at = now()
    where id = p_incident_id returning * into v;
  insert into incident_events (incident_id, type, actor_id, operation_id)
  values (p_incident_id, 'acknowledged', auth.uid(), v_operation_id);
  perform write_audit('incident_acknowledged', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- =====================================================================
-- 13. add_incident_correction (unchanged since 0011 except the addition
--     below). No eventTime input; the single row keeps its default now().
-- =====================================================================
create or replace function add_incident_correction(p_incident_id uuid, p_input jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_number text;
  v_operation_id uuid := gen_random_uuid();
  v_ref uuid := (p_input->>'refId')::uuid;
  v_is_author boolean;
begin
  -- An inactive profile may not write anything, however it qualified
  -- before deactivation. Checked FIRST, before any authorship lookup.
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  select number into v_number from incidents where id = p_incident_id;
  if v_number is null then
    raise exception 'not_found: התקלה לא נמצאה';
  end if;
  select exists (
    select 1 from incident_updates where id = v_ref and incident_id = p_incident_id and author_id = auth.uid()
    union all
    select 1 from incident_events where id = v_ref and incident_id = p_incident_id and actor_id = auth.uid()
  ) into v_is_author;
  if not (is_operational_role() or v_is_author) then
    raise exception 'permission: ניתן לתקן רק רישום שנכתב על ידך';
  end if;
  insert into incident_events (incident_id, type, actor_id, ref_id, note, operation_id)
  values (p_incident_id, 'correction', auth.uid(), v_ref, trim(p_input->>'text'), v_operation_id);
  perform write_audit('incident_correction', 'incident', p_incident_id::text, v_number);
end;
$$;

-- =====================================================================
-- 14. accept_handover (unchanged since 0011 except the addition below).
--     One operation id is allocated ONCE, outside the per-incident loop --
--     one acceptance action, across N incidents' timelines. No eventTime
--     input; each row keeps its default now().
-- =====================================================================
create or replace function accept_handover(p_handover_id uuid) returns handovers
language plpgsql security definer set search_path = public as $$
declare
  v handovers;
  v_operation_id uuid := gen_random_uuid();
  r record;
begin
  -- Deactivation revokes authorization: being the addressed target is not
  -- enough -- the caller must still hold an ACTIVE profile right now.
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  select * into v from handovers where id = p_handover_id for update;
  if v.id is null then raise exception 'not_found: העברת המשמרת לא נמצאה'; end if;
  if v.status = 'accepted' then raise exception 'validation: ההעברה כבר אושרה'; end if;
  if v.to_user_id <> auth.uid() then
    raise exception 'permission: רק האחמ״ש הנכנס יכול לאשר את ההעברה';
  end if;
  update handovers set status = 'accepted', accepted_at = now(), accepted_by = auth.uid()
  where id = p_handover_id returning * into v;
  for r in select incident_id from handover_items where handover_id = p_handover_id loop
    insert into incident_events (incident_id, type, actor_id, ref_id, operation_id)
    values (r.incident_id, 'handover_accepted', auth.uid(), p_handover_id, v_operation_id);
  end loop;
  perform write_audit('handover_accepted', 'handover', p_handover_id::text);
  return v;
end;
$$;

-- No grant/revoke statements below this line: every function above already
-- existed before this migration, and CREATE OR REPLACE FUNCTION preserves
-- every existing privilege, SECURITY DEFINER flag, owner, and search_path
-- setting exactly as-is. See chapter3_event_operation_id.sql for the
-- before/after ACL snapshot diff that verifies this for all 14 functions.
