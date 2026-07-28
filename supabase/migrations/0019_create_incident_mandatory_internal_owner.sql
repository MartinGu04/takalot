-- מעקב תקלות — create_incident: mandatory internal owner (בעל אחריות פנימי).
--
-- Chapter 2 requires every NEW incident to have an internal, active
-- Nexus-personnel owner -- the person accountable for the incident not
-- falling between the cracks, not necessarily who performs the technical
-- work. The frontend (feat/chapter2-incident-creation-vertical-slice)
-- already enforces this in its own Zod schema, but that is UX only: a
-- direct RPC caller could still create an incident with owner_user_id null
-- and only owner_external_name set, since create_incident's only owner
-- check was assert_owner_valid(ownerUserId), which is a no-op when its
-- argument is null (see assert_owner_valid, migration 0014) -- it was
-- designed to validate an owner WHEN PRESENT, for flows where an owner can
-- legitimately be absent or external (update_incident, assign_incident,
-- close_incident, create_handover). This migration closes that gap for
-- creation ONLY, without touching assert_owner_valid itself, which stays
-- exactly as-is for those four other, unrelated call sites.
--
-- Reproduced in full (CREATE OR REPLACE FUNCTION requires the complete
-- body) from the current active definition (0017), with exactly these
-- changes:
--   1. ownerUserId is read once into a normalized, trimmed text variable
--      BEFORE any cast, via nullif(trim(coalesce(...))), so a missing,
--      JSON-null, empty, or whitespace-only value never reaches a raw
--      ::uuid cast (which would otherwise surface a raw Postgres
--      "invalid input syntax for type uuid" error to the caller).
--   2. If that normalized value is null, creation is rejected with a
--      clean, translated validation error -- the internal owner is
--      mandatory now, where it was previously optional.
--   3. ownerExternalName is read once into the same kind of normalized
--      variable; if it is non-blank, creation is rejected outright --
--      explicit rejection, not a silent drop, and this applies whether or
--      not an internal owner was also supplied, so "both" is rejected by
--      the same branch as "external only" (mutually exclusive by design:
--      see the Owner type's own comment, "either an active internal user
--      or a named external handler").
--   4. assert_owner_valid is now called with the already-normalized,
--      already-cast owner uuid (previously computed twice: once for this
--      call, once again in the INSERT) -- same helper, same behavior
--      (active + exists check), unchanged.
-- Every other check (permission, status allowlist, reportedToOps
-- recipient), the INSERT itself, the created/status_change/
-- reported_to_ops_change timeline events, the audit entry, and the
-- assignment notification are byte-for-byte identical to the current
-- active body.
--
-- Not a table-level change: no ALTER TABLE, no new CHECK constraint, no
-- UPDATE of any existing row. A historical incident created before this
-- migration with owner_external_name only (e.g. the demo seed's inc-3-style
-- record) remains fully readable and completely unchanged -- this function
-- only evaluates its own logic at the moment of a NEW create_incident call
-- going forward. Reassigning an EXISTING incident to external ownership
-- later in its lifecycle (update_incident/assign_incident) is untouched.
--
-- No grant statement is needed: CREATE OR REPLACE FUNCTION preserves
-- existing grants when the signature is unchanged, and create_incident(jsonb)
-- already has authenticated EXECUTE (public/anon already revoked) since
-- migration 0005.
--
-- Not yet applied to any hosted database as of this commit.
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
  v_owner_user_id := v_owner_user_id_raw::uuid;
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

  insert into incidents (
    number, system_id, location_id, description, severity, status, operational_impact,
    owner_user_id, owner_external_name, discovered_at, created_by, updated_by,
    next_update_due, no_deadline_reason, reported_to_ops, reported_to_ops_recipient
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
    v_reported_ops, v_recipient
  ) returning * into v_incident;

  insert into incident_events (incident_id, type, actor_id, event_time, note)
  values (v_incident.id, 'created', auth.uid(), v_incident.discovered_at,
          'פעולות שבוצעו עד כה: ' || trim(coalesce(p_input->>'actionsTaken', '')));
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
