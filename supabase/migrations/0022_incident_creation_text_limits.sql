-- מעקב תקלות — incident creation: 400-character limits on תיאור התקלה
-- (description) and השפעה מבצעית (operational_impact).
--
-- Migration 0021 is already applied to hosted Supabase and must not be
-- edited (per instructions) -- this is a separate, additive migration that
-- only touches create_incident again.
--
-- Scope: CREATION only. update_incident's own operational_impact keeps its
-- existing (unrelated, unchanged) 1000-character limit -- description does
-- not exist at all past creation, so there is nothing to change there. No
-- other RPC is touched.
--
-- Deliberately NOT a tightened CHECK constraint on incidents.description/
-- operational_impact: migration 0001 already put a table CHECK on both
-- columns (`length(trim(description)) between 1 and 4000` and
-- `length(trim(operational_impact)) between 1 and 1000`), and dropping/
-- re-adding either at a tighter 400-character bound is validated against
-- EVERY existing row at ALTER TABLE time -- it would fail outright against
-- any historical row already longer than 400 characters (which the old,
-- much looser 4000/1000 limits explicitly allowed), which is not "safe and
-- appropriate for historical rows." Authoritative validation inside
-- create_incident is the smallest correct shape: it only ever constrains
-- rows created from this point forward, exactly matching the instruction to
-- never modify or constrain historical incident text. The existing 0001
-- constraints are untouched and keep acting as the outer (4000/1000)
-- backstop they always were.
--
-- Length is checked on the RAW (untrimmed) extracted text, matching the
-- frontend exactly (Zod's `nonBlank(400, ...)` and the textarea's own
-- maxLength={400} both operate on the raw, not the trimmed, string) -- not
-- because trailing whitespace is meaningful, but so the RPC's boundary
-- agrees byte-for-byte with what the UI already prevents a well-behaved
-- caller from ever sending.
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
  -- New in migration 0022: authoritative 400-character caps, mirroring the
  -- frontend exactly. length() on a jsonb->>'key' extraction of a missing
  -- key is length(NULL) = NULL, and `NULL > 400` is NULL (not true), so a
  -- missing key never raises here -- it still fails the pre-existing
  -- not-null "יש להזין תיאור"/"יש להזין השפעה מבצעית" checks below exactly
  -- as before this migration.
  if length(p_input->>'description') > 400 then
    raise exception 'validation: תיאור התקלה: עד 400 תווים';
  end if;
  if length(p_input->>'operationalImpact') > 400 then
    raise exception 'validation: השפעה מבצעית: עד 400 תווים';
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
-- when the signature is unchanged.
--
-- Not a change to any other RPC or table: update_incident, close_incident,
-- and every other existing function/table/constraint/grant is untouched.
--
-- Not yet applied to any hosted database as of this commit.
