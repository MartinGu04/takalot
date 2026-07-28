-- מעקב תקלות — update_incident / technician_update_incident: event-time integrity.
--
-- The Chapter 2 incident-update UI lets a user document work after the fact
-- ("מועד העדכון בפועל"), exactly like cancel_incident already does for
-- cancellations (migration 0017). Unlike cancel_incident, neither
-- update_incident nor technician_update_incident validated eventTime at
-- all: a missing/null value reached a bare `(p_input->>'eventTime')::
-- timestamptz` cast (NULL, not an error) and then a NOT NULL column
-- (incident_updates.event_time), which would have surfaced a raw
-- not_null_violation to the caller had the frontend's own required-field
-- check not silently covered for it; a malformed non-empty value (e.g.
-- "not-a-timestamp") would reach the same cast and raise a raw
-- invalid_datetime_format/datetime_field_overflow/invalid_time_zone_
-- displacement_value error directly; and there was no lower/upper bound at
-- all, so a caller could log an update dated before the incident was ever
-- discovered, or arbitrarily far in the future. This migration closes that
-- gap for exactly these two RPCs, mirroring cancel_incident's own
-- already-approved pattern (require eventTime; reject it before
-- discovered_at or beyond now() + 5 minutes) exactly, including the same
-- 5-minute clock-skew tolerance and inclusive boundaries.
--
-- All three malformed-cast SQLSTATEs were verified empirically (not
-- assumed) against a live Postgres 16 instance before writing this
-- migration:
--   - unparseable text (e.g. "not-a-timestamp", "abc123", a bare integer)
--     raises invalid_datetime_format (22007).
--   - a syntactically-shaped but out-of-range date/time component (e.g.
--     month 13, hour 25) raises datetime_field_overflow (22008).
--   - a syntactically-shaped but out-of-range UTC offset (e.g. "+25:00")
--     raises invalid_time_zone_displacement_value (22009).
-- All three are caught and re-raised in the project's normal controlled
-- 'validation: ...' format; no other exception condition is caught.
--
-- Reproduced in full (CREATE OR REPLACE FUNCTION requires the complete
-- body) from the current active definitions (0017), with exactly these
-- changes to each function:
--   1. Two new declared variables: eventTime read once into a normalized,
--      trimmed text variable via nullif(trim(coalesce(...))) (so a missing,
--      JSON-null, empty, or whitespace-only value never reaches a raw cast),
--      and a `v_event_time timestamptz` to hold the parsed result.
--   2. If the normalized raw value is null, the call is rejected with a
--      clean, translated validation error -- eventTime is now mandatory
--      (it was previously silently optional).
--   3. The now-guaranteed-non-blank raw string is cast to timestamptz inside
--      its own nested begin/exception block, catching exactly
--      invalid_datetime_format, datetime_field_overflow, and
--      invalid_time_zone_displacement_value, and re-raising as the
--      project's normal controlled validation error -- never a raw
--      Postgres cast error.
--   4. The successfully-parsed v_event_time is then checked against the
--      already-locked incident row's own discovered_at (no second query --
--      reuses the row lock_incident_checked already returned) and
--      now() + interval '5 minutes', rejecting anything outside that
--      range with the same controlled validation error. Both boundaries
--      are inclusive (< / >, not <= / >=), matching cancel_incident exactly.
--   5. Every remaining occurrence of `(p_input->>'eventTime')::timestamptz`
--      is replaced by the already-validated v_event_time (same value,
--      computed once instead of twice).
-- Every other check (permission, expectedVersion/terminal/transition guards
-- for update_incident; role/ownership/terminal guard for
-- technician_update_incident), the INSERT/UPDATE statements, the
-- incident_events rows, the audit entry, and the notification block are
-- byte-for-byte identical to the current active bodies. No signature,
-- return type, SECURITY DEFINER/search_path clause, authorization rule,
-- optimistic-locking behavior, transition rule, owner-validation call, or
-- EXECUTE grant is touched. No other RPC is touched.
--
-- Not a table-level change: no ALTER TABLE, no new CHECK constraint, no
-- UPDATE of any existing row. Historical incident_updates/incident_events
-- rows are unaffected -- this only changes what a NEW call accepts.
--
-- No grant statements: CREATE OR REPLACE FUNCTION preserves existing grants
-- when the signature is unchanged.
--
-- Not yet applied to any hosted database as of this commit.

-- =====================================================================
-- 1. update_incident
-- =====================================================================
create or replace function update_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_update_id uuid;
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
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id)
  values (p_incident_id, 'update', auth.uid(), v_event_time, v_update_id);

  if v_new_status <> v.status then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note)
    values (p_incident_id, 'status_change', auth.uid(), 'status', v.status::text, v_new_status::text,
            nullif(trim(coalesce(p_input->>'changeReason', '')), ''));
  end if;
  if v_new_severity <> v.severity then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note)
    values (p_incident_id, 'severity_change', auth.uid(), 'severity', v.severity::text, v_new_severity::text,
            nullif(trim(coalesce(p_input->>'changeReason', '')), ''));
    perform write_audit('incident_severity_changed', 'incident', p_incident_id::text, v.number,
      jsonb_build_object('severity', v.severity), jsonb_build_object('severity', v_new_severity));
  end if;
  if trim(p_input->>'operationalImpact') <> v.operational_impact then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value)
    values (p_incident_id, 'impact_change', auth.uid(), 'operational_impact',
            v.operational_impact, trim(p_input->>'operationalImpact'));
  end if;
  if coalesce(v_new_owner::text, coalesce(v_new_owner_ext, '')) <> coalesce(v.owner_user_id::text, coalesce(v.owner_external_name, '')) then
    select coalesce((select full_name from profiles where id = v.owner_user_id), v.owner_external_name, 'ללא') into v_old_owner_label;
    select coalesce((select full_name from profiles where id = v_new_owner), v_new_owner_ext, 'ללא') into v_new_owner_label;
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value)
    values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_owner_label, v_new_owner_label);
    perform write_audit('incident_assigned', 'incident', p_incident_id::text, v.number,
      jsonb_build_object('owner', v_old_owner_label), jsonb_build_object('owner', v_new_owner_label));
    if v_new_owner is not null and v_new_owner <> auth.uid() then
      insert into notifications (user_id, type, incident_id, text)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.');
    end if;
  end if;
  if coalesce(v_new_due, 'epoch'::timestamptz) <> coalesce(v.next_update_due, 'epoch'::timestamptz) then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note)
    values (p_incident_id, 'deadline_change', auth.uid(), 'next_update_due',
            v.next_update_due::text, v_new_due::text,
            case when v_new_due is null then 'ללא צפי כרגע: ' || coalesce(p_input->>'noDeadlineReason', '') end);
  end if;
  if v_new_reported_ops <> v.reported_to_ops or v_new_recipient is distinct from v.reported_to_ops_recipient then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note)
    values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
            v.reported_to_ops_recipient, v_new_recipient,
            'דווח למבצעים: ' || v_new_reported_ops::text || coalesce(' (' || v_new_recipient || ')', ''));
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
-- 2. technician_update_incident
-- =====================================================================
create or replace function technician_update_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_update_id uuid;
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
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id)
  values (p_incident_id, 'update', auth.uid(), v_event_time, v_update_id);

  update incidents set version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;
  perform write_audit('incident_technical_update', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;
