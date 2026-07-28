-- מעקב תקלות — incident opening completion: תקשוב למבצעים + WISDOM.
--
-- Two operational reporting questions, asked ONLY at incident OPENING (no
-- update path exists for them -- they describe what was true the moment the
-- incident was opened, not an ongoing status that later flows can revise):
--   1. "האם דווח לתקשוב למבצעים?" (was Communications-for-Operations
--      notified?) -- if yes, "למי דווח?" (a free-text recipient) is required.
--   2. "האם נפתחה תקלה ב-WISDOM?" -- if yes, "מספר תקלה ב-WISDOM" (a
--      free-text incident number -- no established numeric format exists
--      anywhere in this repository, so it stays a plain string) is required.
--
-- Deliberately NOT built on top of the existing add_incident_report /
-- incident_report_events / reported_to_ops_communications machinery
-- (migrations 0015/0017): that is a general-purpose, still-unwired,
-- post-creation ad-hoc reporting log (arbitrary channel, internal/external
-- reporter, note, repeatable over an incident's lifetime) -- a fundamentally
-- different shape from "a fixed yes/no fact recorded once, at open, and
-- never revised." Reusing it here would pull in reporter tracking, channel
-- enums, and repeat-call semantics that this feature does not need, which is
-- exactly the kind of "generalized external-reporting engine" the approved
-- scope says not to introduce. Two plain nullable-dependent column pairs on
-- `incidents`, mirroring the existing reported_to_ops/reported_to_ops_recipient
-- pattern (migration 0004) exactly, are the smallest compatible shape.
--
-- ===== 1. New columns =====
-- Booleans (not the existing three-state reported_to_ops enum): both new
-- questions are strictly לא/כן, with no third "not_required" state, so a
-- new enum type would be pure duplication. `not null default false` gives
-- every historical row a correct, safe "לא" reading with zero backfill.
alter table incidents
  add column reported_to_comms boolean not null default false,
  add column reported_to_comms_recipient text
    check (reported_to_comms_recipient is null or length(reported_to_comms_recipient) <= 200),
  add column wisdom_reported boolean not null default false,
  add column wisdom_incident_number text
    check (wisdom_incident_number is null or length(wisdom_incident_number) <= 100);

-- Bidirectional guarantees, mirroring incident_recipient_only_when_reported /
-- incident_recipient_required_when_reported (0004) exactly: "לא" can never
-- retain a dependent value, and "כן" can never be saved without one. Enforced
-- at the database layer regardless of what any client or future RPC bug
-- sends -- RLS already blocks direct table writes bypassing the RPCs, but
-- this closes the loop even against that.
alter table incidents
  add constraint incident_comms_recipient_only_when_reported
    check (reported_to_comms or reported_to_comms_recipient is null);
alter table incidents
  add constraint incident_comms_recipient_required_when_reported
    check (not reported_to_comms or (
      reported_to_comms_recipient is not null and length(trim(reported_to_comms_recipient)) > 0
    ));
alter table incidents
  add constraint incident_wisdom_number_only_when_reported
    check (wisdom_reported or wisdom_incident_number is null);
alter table incidents
  add constraint incident_wisdom_number_required_when_reported
    check (not wisdom_reported or (
      wisdom_incident_number is not null and length(trim(wisdom_incident_number)) > 0
    ));

-- ===== 2. create_incident: accept, validate, persist, and show the two
--          answers -- everything else byte-for-byte identical to the
--          current active body (migration 0019) =====
-- Booleans are read via plain text equality (`= 'true'`), not a `::boolean`
-- cast: jsonb's `->>` extraction always yields the literal text "true" for a
-- genuine JSON boolean true, so this is exactly as correct, and unlike a
-- cast it can NEVER raise on a missing key, JSON null, or any malformed
-- value -- every one of those simply (and correctly) reads as "not
-- reported", with no exception-handling block required at all. This is the
-- smallest safe shape, not merely a shortcut: it sidesteps entirely the
-- class of raw-cast-error exposure that timestamp/UUID fields elsewhere in
-- this schema needed dedicated exception handling to close (migrations 0019
-- and 0020) -- because it is a database boundary, it is authoritative even
-- against a direct RPC caller that never went through createIncidentSchema.
-- The `coalesce(..., false)` wrapped around each comparison is required, not
-- decorative: with a missing/JSON-null key, `->>'key'` is SQL NULL, and
-- `NULL = 'true'` itself evaluates to NULL under three-valued logic, not
-- false -- verified empirically, since assuming otherwise would have tried
-- to insert NULL into the not-null reported_to_comms/wisdom_reported
-- columns and failed outright.
create or replace function create_incident(p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v_incident incidents;
  v_reported_ops reported_to_ops := (p_input->>'reportedToOps')::reported_to_ops;
  v_recipient text := case when (p_input->>'reportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'reportedToOpsRecipient', '')), '') else null end;
  v_owner_user_id_raw text := nullif(trim(coalesce(p_input->>'ownerUserId', '')), '');
  v_owner_external_name text := nullif(trim(coalesce(p_input->>'ownerExternalName', '')), '');
  v_owner_user_id uuid;
  -- coalesce(..., false) is required, not decorative: with a missing key,
  -- p_input->>'reportedToComms' is SQL NULL, and `NULL = 'true'` itself
  -- evaluates to NULL (three-valued logic), not false -- which would try to
  -- insert NULL into the not-null reported_to_comms column and fail outright.
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
    trim(p_input->>'description'),
    (p_input->>'severity')::incident_severity,
    (p_input->>'status')::incident_status,
    trim(p_input->>'operationalImpact'),
    v_owner_user_id,
    v_owner_external_name,
    (p_input->>'discoveredAt')::timestamptz,
    auth.uid(), auth.uid(),
    (p_input->>'nextUpdateDue')::timestamptz,
    nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), ''),
    v_reported_ops, v_recipient,
    v_reported_comms, v_comms_recipient, v_wisdom_reported, v_wisdom_number
  ) returning * into v_incident;

  -- The two new answers are folded into the SAME 'created' event's note
  -- (never a separate event type): they are set exactly once, at open, and
  -- never revised by any later flow in this PR, so a dedicated
  -- "...comms_change"/"...wisdom_change" event -- unlike reported_to_ops_change,
  -- which genuinely IS revisited by update_incident/close_incident -- would
  -- only ever fire this one time and would just duplicate what the 'created'
  -- event already says. This is the "opening history", shown by the
  -- existing incident-created timeline representation, exactly as scoped.
  insert into incident_events (incident_id, type, actor_id, event_time, note)
  values (v_incident.id, 'created', auth.uid(), v_incident.discovered_at,
    'פעולות שבוצעו עד כה: ' || trim(coalesce(p_input->>'actionsTaken', '')) ||
    E'\nתקשוב למבצעים: ' || (case when v_reported_comms then 'כן (דווח ל: ' || v_comms_recipient || ')' else 'לא' end) ||
    E'\nWISDOM: ' || (case when v_wisdom_reported then 'כן (מספר תקלה: ' || v_wisdom_number || ')' else 'לא' end));
  if v_incident.status <> 'new' then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value)
    values (v_incident.id, 'status_change', auth.uid(), 'status', 'new', v_incident.status::text);
  end if;
  if v_recipient is not null then
    insert into incident_events (incident_id, type, actor_id, field, new_value, note)
    values (v_incident.id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient', v_recipient,
            'דווח למבצעים: ' || v_recipient);
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

-- No grant statements: CREATE OR REPLACE FUNCTION preserves existing grants
-- when the signature is unchanged, and create_incident(jsonb) already has
-- authenticated EXECUTE (public/anon already revoked) since migration 0005.
--
-- Not a change to any other RPC: update_incident, technician_update_incident,
-- assign_incident, close_incident, cancel_incident, reopen_incident, and
-- create_handover are untouched -- there is no update path for these two
-- opening-time-only fields in this PR.
--
-- Not yet applied to any hosted database as of this commit.
