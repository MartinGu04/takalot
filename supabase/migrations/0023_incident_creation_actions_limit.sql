-- מעקב תקלות — incident creation: 600-character limit and required-ness on
-- פעולות שבוצעו עד כה (actionsTaken).
--
-- Migrations 0021 and 0022 are already applied to hosted Supabase and must
-- not be edited (per instructions) -- this is a separate, additive
-- migration that only touches create_incident again, preserving every
-- behavior from 0022 unchanged and adding only controlled validation for
-- actionsTaken.
--
-- Scope: CREATION only. update_incident's and technician_update_incident's
-- own actionsTaken (a running per-update log entry, not the one-time
-- opening note) keep their existing, unrelated, unchanged 4000-character
-- limit -- no other RPC is touched.
--
-- Unlike description/operational_impact, actionsTaken has never had ANY
-- table-level backstop at all: it is never inserted into a column of
-- `incidents` -- it only feeds `incident_events.note` (a nullable, unbound
-- text column with no NOT NULL and no CHECK constraint), so a missing/
-- null/blank value previously did not raise ANY error, controlled or raw --
-- it silently succeeded with a note reading "פעולות שבוצעו עד כה: " and
-- nothing after. This migration closes that gap the same way 0022 closed
-- the description/operational_impact one: v_actions_taken is trimmed-and-
-- nulled exactly like v_description/v_operational_impact, and a null value
-- now raises the same clean 'validation: <label>: שדה חובה' exception,
-- with the length cap raised the same way, before the note is ever built.
--
-- Deliberately NOT a CHECK constraint anywhere: there is no
-- `incident_events.note` column to safely constrain (it holds free-form
-- text spanning every event type, most of which this migration has nothing
-- to do with), and even if there were, it would face the exact same
-- historical-row risk 0022 already reasoned through for description/
-- operational_impact. Authoritative validation inside create_incident,
-- constraining only rows created from this point forward, is the correct
-- and smallest shape here too.
--
-- Length is checked on the RAW (untrimmed) extracted text, matching the
-- frontend exactly (Zod's `nonBlank(600, ...)` and the textarea's own
-- maxLength={600} both operate on the raw, not the trimmed, string) -- the
-- same reasoning as 0022's description/operationalImpact checks.
create or replace function create_incident(p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v_incident incidents;
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
  -- New in migration 0023: authoritative required-ness + 600-character cap
  -- on actionsTaken, mirroring description/operationalImpact's checks
  -- exactly (migration 0022).
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

  -- v_actions_taken (already trimmed and guaranteed non-null by the checks
  -- above) replaces the old inline trim(coalesce(p_input->>'actionsTaken',
  -- '')) -- same value, computed once.
  insert into incident_events (incident_id, type, actor_id, event_time, note)
  values (v_incident.id, 'created', auth.uid(), v_incident.discovered_at,
    'פעולות שבוצעו עד כה: ' || v_actions_taken ||
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
