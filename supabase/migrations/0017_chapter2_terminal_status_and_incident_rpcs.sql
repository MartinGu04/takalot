-- מעקב תקלות — forward migration.
-- Chapter 2, PR3: terminal-status compatibility for the 'cancelled' status
-- introduced (as an enum value only, unused until now) by 0015, plus three
-- new opt-in incident-lifecycle RPCs: cancel_incident, add_incident_report,
-- set_incident_status_check.
--
-- ===== Terminal-status compatibility =====
-- Every existing function that treated `status = 'closed'` /
-- `status <> 'closed'` as "the only terminal status" or "the definition of
-- open" is corrected here to also account for 'cancelled'. Each function
-- below is reproduced in full (`create or replace function` requires the
-- complete body) with EXACTLY ONE guard condition changed relative to its
-- current active definition -- re-verified against the actual currently
-- active bodies immediately before writing this file, since `create_incident`,
-- `update_incident`, and `close_incident` were superseded by 0004
-- (readiness/recipient), not 0002, and `admin_set_user_active` was superseded
-- by 0014 (deactivation guard), not 0002. No other behavior in any of these
-- functions is changed.
--
-- ===== New RPCs =====
-- cancel_incident, add_incident_report, and set_incident_status_check are
-- created here but are NOT yet reachable by any client: this migration
-- explicitly revokes EXECUTE from authenticated (and anon, and PUBLIC) on all
-- three, on top of never granting it. A later, separate migration -- applied
-- only once frontend compatibility (IncidentStatus type, isOpen, labels,
-- badges, transitions, schemas, filters, timeline rendering for the new event
-- types) has shipped -- will grant `authenticated` EXECUTE on these three.
-- Until then they exist, are fully tested at the database layer, and are
-- reachable only as the owning role (e.g. by a future migration or an
-- explicit superuser call), never by an authenticated or anonymous client.
--
-- admin_publish_severity_ruleset and any change to severity_rulesets are
-- explicitly OUT of scope for this migration -- deferred intact to the later
-- severity-engine/severity-management PR, where a real frontend and consumer
-- will exist. Nothing in this file touches severity_rulesets.
--
-- Not yet applied to any hosted database as of this commit.

-- =====================================================================
-- 1. is_valid_transition -- terminal-aware on BOTH sides
-- =====================================================================
-- Original (0002) body: `when p_from = p_to then true` was checked before
-- any terminal check, and no branch blocked p_to = 'cancelled' or
-- p_from = 'cancelled' at all. Two distinct bugs this closes:
--   (a) is_valid_transition('cancelled','cancelled') returned true -- a
--       same-status "update" of an already-cancelled incident was wrongly
--       considered valid;
--   (b) is_valid_transition('cancelled', <any active status>) fell through
--       to the final `else` branch's active-status whitelist and ALSO
--       returned true -- a cancelled incident could "transition" back to an
--       active status.
-- Fix: check both p_from and p_to for terminal status FIRST, before the
-- self-transition shortcut. 'cancelled' joins 'closed'/'reopened' as a
-- forbidden p_to (reachable only through the dedicated cancel_incident flow,
-- exactly as closed/reopened are reachable only through their own dedicated
-- flows). Also adds `set search_path = public`, previously absent.
create or replace function is_valid_transition(p_from incident_status, p_to incident_status) returns boolean
language sql immutable set search_path = public as $$
  select case
    when p_from in ('closed', 'cancelled') then false
    when p_to in ('closed', 'reopened', 'cancelled') then false
    when p_from = p_to then true
    when p_from = 'new' then p_to in ('acknowledged', 'in_progress')
    when p_from = 'resolved_pending_close' then p_to in ('in_progress', 'monitoring', 'waiting_test')
    else p_to in ('in_progress', 'waiting_external', 'waiting_test', 'monitoring', 'partial_readiness', 'resolved_pending_close')
  end;
$$;

-- =====================================================================
-- 2. create_incident -- active definition is 0004's, not 0002's.
--    Explicit ALLOWLIST for the initial status, not a growing blocklist.
-- =====================================================================
-- Reproduced in full from 0004 with exactly one change: the
-- `in ('closed', 'reopened')` blocklist becomes an explicit allowlist of the
-- 8 statuses the currently deployed frontend/domain layer (src/domain/
-- types.ts's IncidentStatus, statusLabels, allowedTransitions) actually
-- supports. This single change blocks 'cancelled' AND the three new
-- 'waiting_equipment'/'waiting_information'/'waiting_validation' values as an
-- initial status, pre-frontend-cutover, without relying on an
-- ever-growing blocklist that silently admits any future enum addition.
create or replace function create_incident(p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v_incident incidents;
  v_reported_ops reported_to_ops := (p_input->>'reportedToOps')::reported_to_ops;
  v_recipient text := case when (p_input->>'reportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'reportedToOpsRecipient', '')), '') else null end;
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה לפתוח תקלה';
  end if;
  perform assert_owner_valid((p_input->>'ownerUserId')::uuid);
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
    (p_input->>'ownerUserId')::uuid,
    nullif(trim(coalesce(p_input->>'ownerExternalName', '')), ''),
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

-- =====================================================================
-- 3. update_incident -- active definition is 0004's, not 0002's.
-- =====================================================================
-- Reproduced in full from 0004 with exactly one change: the terminal guard
-- widens from `v.status = 'closed'` to `is_incident_terminal(v.status)`, so a
-- cancelled incident can no longer be "updated" (including the
-- self-transition case: v_new_status = 'cancelled' when v.status is already
-- 'cancelled', which is_valid_transition alone would now also reject, but
-- this explicit guard is the same layered, defense-in-depth style already
-- used throughout this schema).
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
  perform assert_owner_valid(v_new_owner);
  if v_new_reported_ops = 'yes' and v_new_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;

  insert into incident_updates (incident_id, author_id, event_time, actions_taken, findings, next_steps)
  values (p_incident_id, auth.uid(), (p_input->>'eventTime')::timestamptz,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''))
  returning id into v_update_id;
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id)
  values (p_incident_id, 'update', auth.uid(), (p_input->>'eventTime')::timestamptz, v_update_id);

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
-- 4. technician_update_incident -- active definition is 0002's.
-- =====================================================================
create or replace function technician_update_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_update_id uuid;
begin
  if my_role() is distinct from 'technician' then
    raise exception 'permission: פעולה זו מיועדת לטכנאים';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  if v.owner_user_id is distinct from auth.uid() or is_incident_terminal(v.status) then
    raise exception 'permission: ניתן לעדכן רק תקלה פתוחה המוקצית אליך';
  end if;

  insert into incident_updates (incident_id, author_id, event_time, actions_taken, findings, next_steps)
  values (p_incident_id, auth.uid(), (p_input->>'eventTime')::timestamptz,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''))
  returning id into v_update_id;
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id)
  values (p_incident_id, 'update', auth.uid(), (p_input->>'eventTime')::timestamptz, v_update_id);

  update incidents set version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;
  perform write_audit('incident_technical_update', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- =====================================================================
-- 5. assign_incident -- active definition is 0002's.
-- =====================================================================
create or replace function assign_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
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

  insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note)
  values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_label, v_new_label,
          nullif(trim(coalesce(p_input->>'note', '')), ''));
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
-- 6. close_incident -- active definition is 0004's, not 0002's.
--    One widened guard protects BOTH readiness branches.
-- =====================================================================
create or replace function close_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
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

    insert into incident_events (incident_id, type, actor_id, new_value, note)
    values (p_incident_id, 'closed', auth.uid(), v_readiness::text,
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון שבוצע: ' || v.resolution);
    perform write_audit('incident_closed', 'incident', p_incident_id::text, v.number,
      null, jsonb_build_object('readiness', v_readiness));
    if v_reported_ops <> v_old_reported_ops or v_recipient is distinct from v_old_recipient then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note)
      values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
              v_old_recipient, v_recipient,
              'דווח למבצעים: ' || v_reported_ops::text || coalesce(' (' || v_recipient || ')', ''));
    end if;
  else
    -- Incomplete readiness: the incident stays active as "כשירות חלקית" --
    -- it is never marked closed while follow-up is still outstanding.
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

    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note)
    values (p_incident_id, 'status_change', auth.uid(), 'status', v_old_status::text, 'partial_readiness',
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון החלקי שבוצע: ' || v.resolution ||
            E'\nפעולות המשך: ' || v.follow_up_notes || E'\nגורם מטפל אחראי המשך: ' || v_owner_label);
    perform write_audit('incident_partial_readiness', 'incident', p_incident_id::text, v.number,
      null, jsonb_build_object('readiness', v_readiness));
    if v_reported_ops <> v_old_reported_ops or v_recipient is distinct from v_old_recipient then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note)
      values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
              v_old_recipient, v_recipient,
              'דווח למבצעים: ' || v_reported_ops::text || coalesce(' (' || v_recipient || ')', ''));
    end if;
  end if;
  return v;
end;
$$;

-- =====================================================================
-- 7. complete_follow_up -- active definition is 0002's.
-- =====================================================================
-- New finding, not merely a literal-comparison gap: close_incident's
-- full-readiness branch always clears follow_up_required, so under the
-- pre-PR3 system a 'closed' incident could never have follow_up_required =
-- true -- this function's existing guard was safe BY ACCIDENT, not by an
-- explicit terminal check. cancel_incident (below) now also clears
-- follow_up_required defensively, but this explicit guard is added as an
-- independent second layer, matching this schema's established
-- defense-in-depth convention (e.g. PR1's trigger backstop + RPC check).
create or replace function complete_follow_up(p_incident_id uuid, p_note text) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
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
  insert into incident_events (incident_id, type, actor_id, note)
  values (p_incident_id, 'follow_up_completed', auth.uid(), trim(p_note));
  perform write_audit('incident_follow_up_completed', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- =====================================================================
-- 8. create_handover -- active definition is 0002's.
--    Compatibility fix, not new handover product work: without this,
--    every cancelled incident satisfies `status <> 'closed'` PERMANENTLY,
--    so it would be included in every future handover's item list forever,
--    with no path to ever drop out (unlike closure). Historical
--    handovers/handover_items already created are untouched.
-- =====================================================================
create or replace function create_handover(p_input jsonb) returns handovers
language plpgsql security definer set search_path = public as $$
declare
  v handovers;
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
    insert into incident_events (incident_id, type, actor_id, ref_id)
    values (r.id, 'handover_included', auth.uid(), v.id);
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
-- 9. is_incident_open -- active definition is 0016's, corrected here.
-- =====================================================================
-- 0016's original body (`select not is_incident_terminal(p_status);`) has no
-- explicit `set search_path`, so it inherits whatever search_path is ambient
-- AT CALL TIME rather than freezing one at creation, and its internal call
-- to `is_incident_terminal` is UNQUALIFIED. Called from a `search_path = ''`
-- function, that inherited empty search_path makes the internal call fail
-- to resolve ("function is_incident_terminal(...) does not exist") --
-- discovered by actually running this migration's test suite, not by
-- inspection alone. Fixed here with the identical logic, pinned to
-- `search_path = public`, matching the same minimal, non-logic-changing
-- pattern already used for `refresh_incident_search_text` and
-- `severity_rank`/`severity_level_distance` below. admin_delete_user,
-- prevent_deactivation_with_open_incidents, and admin_set_user_active now
-- call this canonical helper directly instead of the temporary
-- `not public.is_incident_terminal(status)` equivalent.
create or replace function public.is_incident_open(p_status incident_status) returns boolean
language sql immutable set search_path = public as $$
  select not is_incident_terminal(p_status);
$$;

-- =====================================================================
-- 10. admin_delete_user -- active definition is 0013's.
-- =====================================================================
create or replace function public.admin_delete_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles;
  v_active_admins int;
  v_open_incidents int;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן למחוק את עצמך';
  end if;

  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  if not public.role_ceiling_allows_manage(v_actor_role, v_target.role) then
    raise exception 'permission: אין הרשאה למחוק משתמש בתפקיד זה';
  end if;

  if v_target.deleted_at is not null then
    return;
  end if;

  if v_target.role = 'system_admin' and v_target.active then
    select count(*) into v_active_admins from public.profiles where role = 'system_admin' and active;
    if v_active_admins <= 1 then
      raise exception 'validation: לא ניתן למחוק את מנהל המערכת הפעיל האחרון';
    end if;
  end if;

  select count(*) into v_open_incidents
  from public.incidents where owner_user_id = p_user_id and public.is_incident_open(status);
  if v_open_incidents > 0 then
    raise exception 'validation: יש לשנות גורם מטפל בתקלות פתוחות לפני מחיקת המשתמש';
  end if;

  update public.profiles
    set active = false, deleted_at = now(), deleted_by = auth.uid()
    where id = p_user_id;

  perform public.write_audit('user_tombstoned', 'profile', p_user_id::text);
end;
$$;

-- =====================================================================
-- 11. prevent_deactivation_with_open_incidents -- active definition is 0014's.
-- =====================================================================
create or replace function public.prevent_deactivation_with_open_incidents() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.active and not new.active and exists (
    select 1 from public.incidents where owner_user_id = old.id and public.is_incident_open(status)
  ) then
    raise exception 'validation: לא ניתן להשבית משתמש המשמש כגורם מטפל פנימי בתקלה פעילה — יש להעביר את הטיפול לגורם מטפל פנימי אחר לפני ההשבתה';
  end if;
  return new;
end;
$$;

-- =====================================================================
-- 12. admin_set_user_active -- active definition is 0014's.
-- =====================================================================
create or replace function public.admin_set_user_active(p_user_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles;
  v_active_admins int;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן לשנות את הסטטוס של עצמך';
  end if;

  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;

  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  if v_target.deleted_at is not null then
    raise exception 'validation: לא ניתן לשנות סטטוס למשתמש שנמחק';
  end if;

  if not public.role_ceiling_allows_manage(v_actor_role, v_target.role) then
    raise exception 'permission: אין הרשאה לנהל משתמש בתפקיד זה';
  end if;

  if not p_active and v_target.active and exists (
    select 1 from public.incidents where owner_user_id = p_user_id and public.is_incident_open(status)
  ) then
    raise exception 'validation: לא ניתן להשבית משתמש המשמש כגורם מטפל פנימי בתקלה פעילה — יש להעביר את הטיפול לגורם מטפל פנימי אחר לפני ההשבתה';
  end if;

  if not p_active and v_target.role = 'system_admin' and v_target.active then
    select count(*) into v_active_admins from public.profiles where role = 'system_admin' and active;
    if v_active_admins <= 1 then
      raise exception 'validation: לא ניתן להשבית את מנהל המערכת הפעיל האחרון';
    end if;
  end if;

  update public.profiles set active = p_active where id = p_user_id;
  perform public.write_audit(case when p_active then 'user_activated' else 'user_deactivated' end,
    'profile', p_user_id::text);
end;
$$;

-- =====================================================================
-- 13. assert_active_profile_if_set -- new internal helper.
--     Never granted to authenticated/anon (section 19 below): callable only
--     from inside another SECURITY DEFINER function's body, which executes
--     under the OWNING role's privileges regardless of the invoking client's
--     own grants.
-- =====================================================================
create or replace function public.assert_active_profile_if_set(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_active boolean;
  v_deleted_at timestamptz;
begin
  if p_user_id is not null then
    select active, deleted_at into v_active, v_deleted_at
    from public.profiles where id = p_user_id for share;
    if not found or not v_active or v_deleted_at is not null then
      raise exception 'validation: המשתמש שצוין אינו פעיל';
    end if;
  end if;
end;
$$;

-- =====================================================================
-- 14. cancel_incident -- new
-- =====================================================================
create or replace function public.cancel_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.incidents;
  v_after public.incidents;
  v_expected_version int;
  v_event_time timestamptz;
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

  insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time)
  values (p_incident_id, 'cancelled', auth.uid(), 'status', v_before.status::text, 'cancelled', v_reason, null, v_event_time);

  if v_before.status_check_due is not null then
    insert into public.incident_status_checks (incident_id, kind, previous_due_at, recorded_by, event_time, note)
    values (p_incident_id, 'removed', v_before.status_check_due, auth.uid(), v_event_time, v_removal_note)
    returning id into v_removed_check_id;

    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due',
            v_before.status_check_due::text, null, v_removal_note, v_removed_check_id, v_event_time);
  end if;

  perform public.write_audit('incident_cancelled', 'incident', p_incident_id::text, v_before.number,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', v_after.status, 'cancellationReason', v_after.cancellation_reason));
  return v_after;
end;
$$;

-- =====================================================================
-- 15. add_incident_report -- new
-- =====================================================================
create or replace function public.add_incident_report(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.incidents;
  v_after public.incidents;
  v_expected_version int;
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
  insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time)
  values (p_incident_id, v_event_type, auth.uid(), 'status', null, v_status::text, v_note, v_report_id, v_event_time);

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
-- 16. set_incident_status_check -- new
-- =====================================================================
create or replace function public.set_incident_status_check(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.incidents;
  v_after public.incidents;
  v_expected_version int;
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
    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', null, v_due_at::text, v_note, v_check_id, v_event_time);
    v_after_due := v_due_at;

  elsif v_kind = 'rescheduled' then
    insert into public.incident_status_checks
      (incident_id, kind, due_at, previous_due_at, performed_by_user_id, performed_by_external_name, recorded_by, event_time, note)
    values (p_incident_id, 'rescheduled', v_due_at, v_before_due, v_performed_by, v_performed_ext, auth.uid(), v_event_time, v_note)
    returning id into v_check_id;
    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', v_before_due::text, v_due_at::text, v_note, v_check_id, v_event_time);
    v_after_due := v_due_at;

  elsif v_kind = 'removed' then
    insert into public.incident_status_checks
      (incident_id, kind, previous_due_at, performed_by_user_id, performed_by_external_name, recorded_by, event_time, note)
    values (p_incident_id, 'removed', v_before_due, v_performed_by, v_performed_ext, auth.uid(), v_event_time, v_note)
    returning id into v_check_id;
    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', v_before_due::text, null, v_note, v_check_id, v_event_time);
    v_after_due := null;

  elsif v_kind = 'completed' then
    insert into public.incident_status_checks
      (incident_id, kind, previous_due_at, performed_by_user_id, performed_by_external_name, recorded_by, event_time, note)
    values (p_incident_id, 'completed', v_before_due, v_performed_by, v_performed_ext, auth.uid(), v_event_time, v_note)
    returning id into v_check_id;
    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', v_before_due::text, null, v_note, v_check_id, v_event_time);
    v_after_due := null;

    if v_next_due_at is not null then
      insert into public.incident_status_checks (incident_id, kind, due_at, recorded_by, event_time, note)
      values (p_incident_id, 'scheduled', v_next_due_at, auth.uid(), v_event_time, v_note)
      returning id into v_next_check_id;
      insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time)
      values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due', null, v_next_due_at::text, v_note, v_next_check_id, v_event_time);
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
-- 17. refresh_incident_search_text -- active definition is 0001's.
-- =====================================================================
-- Same class of latent bug as is_incident_open above, discovered the same
-- way: no `search_path` was ever set on this pre-existing trigger function,
-- so it inherits whatever search_path is ambient AT THE TIME it fires
-- rather than one frozen at creation. It fires on every UPDATE of
-- `incidents` -- including from cancel_incident/add_incident_report/
-- set_incident_status_check (this migration), which are the FIRST functions
-- in this schema to run `update incidents` under `search_path = ''`. Every
-- pre-existing incident-mutating RPC runs under `search_path = public`, so
-- this unqualified `systems`/`locations`/`profiles` lookup always resolved
-- fine before now and the bug was never reachable. No logic changes --
-- only `set search_path = public` is added, so it behaves identically to
-- before under every EXISTING caller and now also works under the three new
-- ones.
create or replace function refresh_incident_search_text() returns trigger
language plpgsql set search_path = public as $$
declare
  v_system text;
  v_location text;
  v_owner text;
begin
  select name into v_system from systems where id = new.system_id;
  select name into v_location from locations where id = new.location_id;
  select full_name into v_owner from profiles where id = new.owner_user_id;
  new.search_text := concat_ws(' ',
    new.number, v_system, v_location, new.description,
    coalesce(v_owner, new.owner_external_name, ''),
    coalesce(new.root_cause, ''), coalesce(new.resolution, ''));
  return new;
end;
$$;

-- =====================================================================
-- 18. severity_rank / severity_level_distance -- active definitions are
--     0016's.
-- =====================================================================
-- Same class of latent bug again, this time surfaced by `incidents`'
-- `incident_severity_override_reason_required` CHECK constraint (0016),
-- which calls severity_level_distance and is re-evaluated by PostgreSQL on
-- EVERY UPDATE of an incidents row regardless of which columns actually
-- changed. severity_level_distance's body calls severity_rank UNQUALIFIED
-- with no search_path set; as a simple SQL function it gets inlined by the
-- planner, resolving that unqualified call in the ambient search_path of
-- whatever statement triggered the constraint check -- empty, for
-- cancel_incident/add_incident_report/set_incident_status_check's `update
-- incidents`. No logic changes to either function -- only `set search_path
-- = public` is added to both (severity_rank for consistency, even though it
-- has no internal unqualified calls of its own today).
create or replace function severity_rank(p_severity incident_severity) returns int
language sql immutable set search_path = public as $$
  select case p_severity
    when 'critical' then 0
    when 'high' then 1
    when 'medium' then 2
    when 'low' then 3
  end;
$$;

create or replace function severity_level_distance(p_a incident_severity, p_b incident_severity) returns int
language sql immutable set search_path = public as $$
  select abs(severity_rank(p_a) - severity_rank(p_b));
$$;

-- =====================================================================
-- 19. Privileges
-- =====================================================================
-- Explicit revoke on all four new/changed functions is REQUIRED, not
-- optional: PostgreSQL grants EXECUTE to PUBLIC by default on any newly
-- created function, and this schema's own hosted-platform simulation
-- (supabase/tests/harness/prelude.sql) additionally grants EXECUTE to
-- anon/authenticated/service_role by default on function creation, mirroring
-- the real Supabase platform default. A bare `create or replace function`
-- with no explicit revoke would leave all three gated RPCs (and the internal
-- helper) immediately callable by everyone.
--
-- cancel_incident, add_incident_report, and set_incident_status_check get NO
-- grant to authenticated here -- not yet reachable by any client. A later,
-- separate migration (applied only after frontend compatibility ships) will
-- add exactly:
--   grant execute on function public.cancel_incident(uuid, jsonb) to authenticated;
--   grant execute on function public.add_incident_report(uuid, jsonb) to authenticated;
--   grant execute on function public.set_incident_status_check(uuid, jsonb) to authenticated;
revoke execute on function public.cancel_incident(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.add_incident_report(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.set_incident_status_check(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.assert_active_profile_if_set(uuid) from public, anon, authenticated;
