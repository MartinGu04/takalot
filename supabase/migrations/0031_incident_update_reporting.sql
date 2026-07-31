-- מעקב תקלות — forward migration.
-- Update-specific reporting: three fresh questions asked at the moment of a
-- FULL update ("דווח למבצעים?" / "האם דווח לתקשוב למבצעים?" / "האם עודכן
-- ב-WISDOM?"), answered per update and stored on that update's own
-- incident_updates row -- never inherited from, and never written back
-- onto, the incident's own opening-time reporting facts
-- (incidents.reported_to_ops/.reported_to_ops_recipient/.reported_to_comms/
-- .reported_to_comms_recipient/.wisdom_reported/.wisdom_incident_number,
-- all set once at create_incident and otherwise frozen).
--
-- ===== Why this is not the same thing as incidents.reported_to_ops =====
-- update_incident (0020 onward) used to re-derive incidents.reported_to_ops/
-- reported_to_ops_recipient from every update payload and emit a
-- 'reported_to_ops_change' event on a diff -- but that reused the SAME
-- mutable pair the update flow shares with creation and closure, so it was
-- really "what is the CURRENT standing answer" (last write wins across
-- creation/update/closure), not "was this reported as part of THIS
-- specific update." A supervisor answering "כן" on one update and the next
-- supervisor never touching the question again would leave the incident
-- silently reading "כן" forever, with no way to tell which update (if any)
-- actually reported it. This migration removes that mutation and event
-- entirely (see the update_incident replacement below) and replaces it with
-- a properly per-update, append-only fact: five new nullable columns on
-- incident_updates, one row per update, exactly like actions_taken/
-- findings/next_steps/current_status_text already are.
--
-- ===== 1. New columns on incident_updates =====
-- All five stay nullable forever -- unlike creation's reported_to_comms/
-- wisdom_reported (0021, not null default false), "not yet answered" is a
-- real, permanent state here for every historical row (predating this
-- migration) and for any legacy-client update that omits the new payload
-- keys during the compatibility window (see update_incident below). NULL
-- means "no answer was recorded for this update," not "the answer was לא."
alter table incident_updates
  add column update_reported_to_ops reported_to_ops,
  add column update_reported_to_ops_recipient text
    check (update_reported_to_ops_recipient is null or length(update_reported_to_ops_recipient) <= 200),
  add column update_reported_to_comms boolean,
  add column update_reported_to_comms_recipient text
    check (update_reported_to_comms_recipient is null or length(update_reported_to_comms_recipient) <= 200),
  add column update_wisdom_reported boolean;

-- Bidirectional guarantees, mirroring incident_comms_recipient_only_when_reported
-- / incident_comms_recipient_required_when_reported (0021) in spirit, adapted
-- for a genuinely nullable "not yet answered" state (0021's own columns are
-- `not null default false`, so no NULL case exists there):
--   - update_reported_to_ops: NULL is treated as "not yes" for the purposes
--     of these checks (coalesce(..., 'no') = 'yes'), so a recipient can
--     never be stored unless the answer is exactly 'yes'.
--   - update_reported_to_comms: boolean already makes `is true`/`is not true`
--     NULL-safe on their own (Postgres's three-valued-logic-safe boolean
--     predicates never themselves evaluate to NULL), no coalesce needed.
alter table incident_updates
  add constraint update_ops_recipient_only_when_yes
    check (update_reported_to_ops_recipient is null or coalesce(update_reported_to_ops::text, 'no') = 'yes');
alter table incident_updates
  add constraint update_ops_recipient_required_when_yes
    check (coalesce(update_reported_to_ops::text, 'no') <> 'yes' or (
      update_reported_to_ops_recipient is not null and length(trim(update_reported_to_ops_recipient)) > 0
    ));
alter table incident_updates
  add constraint update_comms_recipient_only_when_yes
    check (update_reported_to_comms_recipient is null or update_reported_to_comms is true);
alter table incident_updates
  add constraint update_comms_recipient_required_when_yes
    check (update_reported_to_comms is not true or (
      update_reported_to_comms_recipient is not null and length(trim(update_reported_to_comms_recipient)) > 0
    ));

-- ===== 2. update_incident: accept, validate, persist the three new answers;
--          stop mutating incidents.reported_to_ops/_recipient entirely =====
-- Everything else in this function's body is byte-for-byte identical to the
-- currently active definition (migration 0030) -- current_status_text,
-- operationalImpact legacy compatibility, and next_update_due/
-- no_deadline_reason preserve-on-omit/honor-on-provide are all reproduced
-- unchanged below, per this schema's own "complete body every time"
-- convention for create-or-replace functions.
--
-- What changes:
--   - v_new_reported_ops / v_new_recipient (the incident-LEVEL pair) are
--     removed entirely -- update_incident no longer reads the legacy
--     reportedToOps/reportedToOpsRecipient payload keys for any mutation
--     purpose. An old client bundle that still sends them (reading them off
--     the incident record, per its own now-superseded behavior) has those
--     keys silently ignored: not an error, not a mutation, not a new
--     update-reporting record -- exactly the "tolerated but inert"
--     treatment the new product model requires.
--   - The `reported_to_ops = ..., reported_to_ops_recipient = ...` pair is
--     dropped from the final `update incidents set` clause -- the opening
--     facts these columns hold are frozen after creation, from this
--     migration forward, as far as update_incident is concerned.
--   - The `reported_to_ops_change` event block is removed outright -- it
--     described a mutation this function no longer performs, so emitting it
--     would be actively misleading.
--   - Five new p_input keys (updateReportedToOps, updateReportedToOpsRecipient,
--     updateReportedToComms, updateReportedToCommsRecipient,
--     updateWisdomReported) are read via the same `p_input ? 'key'`
--     existence-check pattern already used here for nextUpdateDue/
--     noDeadlineReason/operationalImpact: present -> use the supplied value
--     (validating the ops/comms recipient-required-when-yes rule with a
--     controlled error, matching the CHECK constraints above so a caller
--     never hits a raw SQLSTATE); absent (any older client that predates
--     this migration) -> store NULL, exactly what a first stage-1 rollout
--     window requires.
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
  v_impact_provided boolean := p_input ? 'operationalImpact';
  v_new_due timestamptz;
  v_new_reason text;
  v_new_impact text;
  v_old_owner_label text;
  v_new_owner_label text;
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
  perform assert_owner_valid(v_new_owner);
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

  update incidents set
    status = v_new_status,
    severity = v_new_severity,
    operational_impact = v_new_impact,
    owner_user_id = v_new_owner,
    owner_external_name = case when v_new_owner is null then v_new_owner_ext else null end,
    next_update_due = v_new_due,
    no_deadline_reason = v_new_reason,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  perform write_audit('incident_updated', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;
