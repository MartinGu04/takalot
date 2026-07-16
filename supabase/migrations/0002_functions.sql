-- מעקב תקלות — security-definer functions (RPCs) for protected lifecycle transitions.
-- All authorization checks run here, in the database, regardless of client behavior.

-- ===== Role helpers =====
create or replace function current_role_of(p_user uuid) returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = p_user and active;
$$;

create or replace function my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active;
$$;

create or replace function is_operational_role() returns boolean
language sql stable security definer set search_path = public as $$
  select my_role() in ('system_admin', 'professional_manager', 'shift_supervisor');
$$;

create or replace function can_export() returns boolean
language sql stable security definer set search_path = public as $$
  select is_operational_role()
    or exists (select 1 from profiles where id = auth.uid() and active and can_export_override);
$$;

-- ===== Audit helper =====
create or replace function write_audit(
  p_action text, p_entity_type text, p_entity_id text,
  p_incident_number text default null,
  p_before jsonb default null, p_after jsonb default null
) returns void
language sql security definer set search_path = public as $$
  insert into audit_logs (actor_id, action, entity_type, entity_id, incident_number, before_data, after_data, correlation_id)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_incident_number, p_before, p_after, substring(gen_random_uuid()::text, 1, 8));
$$;

-- ===== Atomic yearly numbering =====
create or replace function allocate_incident_number() returns text
language plpgsql security definer set search_path = public as $$
declare
  v_year int := extract(year from (now() at time zone 'Asia/Jerusalem'))::int;
  v_next int;
begin
  insert into incident_sequences (year, last_number)
  values (v_year, 1)
  on conflict (year) do update set last_number = incident_sequences.last_number + 1
  returning last_number into v_next;
  return v_year::text || '-' || lpad(v_next::text, 3, '0');
end;
$$;

-- ===== Status transition validation =====
create or replace function is_valid_transition(p_from incident_status, p_to incident_status) returns boolean
language sql immutable as $$
  select case
    when p_from = p_to then true
    when p_to in ('closed', 'reopened') then false -- only via dedicated flows
    when p_from = 'closed' then false
    when p_from = 'new' then p_to in ('acknowledged', 'in_progress')
    when p_from = 'resolved_pending_close' then p_to in ('in_progress', 'monitoring', 'waiting_test')
    else p_to in ('in_progress', 'waiting_external', 'waiting_test', 'monitoring', 'partial_readiness', 'resolved_pending_close')
  end;
$$;

create or replace function assert_owner_valid(p_owner uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_owner is not null and not exists (select 1 from profiles where id = p_owner and active) then
    raise exception 'validation: הגורם המטפל שנבחר אינו פעיל';
  end if;
end;
$$;

-- ===== create_incident =====
create or replace function create_incident(p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v_incident incidents;
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה לפתוח תקלה';
  end if;
  perform assert_owner_valid((p_input->>'ownerUserId')::uuid);
  if (p_input->>'status')::incident_status in ('closed', 'reopened') then
    raise exception 'invalid_transition: סטטוס פתיחה חייב להיות סטטוס פעיל';
  end if;

  insert into incidents (
    number, system_id, location_id, description, severity, status, operational_impact,
    owner_user_id, owner_external_name, discovered_at, created_by, updated_by,
    next_update_due, no_deadline_reason, reported_to_ops
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
    (p_input->>'reportedToOps')::reported_to_ops
  ) returning * into v_incident;

  insert into incident_events (incident_id, type, actor_id, event_time, note)
  values (v_incident.id, 'created', auth.uid(), v_incident.discovered_at,
          'פעולות שבוצעו עד כה: ' || trim(coalesce(p_input->>'actionsTaken', '')));
  if v_incident.status <> 'new' then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value)
    values (v_incident.id, 'status_change', auth.uid(), 'status', 'new', v_incident.status::text);
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

-- ===== version check helper =====
create or replace function lock_incident_checked(p_id uuid, p_expected_version int) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
begin
  select * into v from incidents where id = p_id for update;
  if not found then
    raise exception 'not_found: התקלה לא נמצאה';
  end if;
  if v.version <> p_expected_version then
    raise exception 'version_conflict: התקלה עודכנה על ידי משתמש אחר';
  end if;
  return v;
end;
$$;

-- ===== acknowledge_incident =====
create or replace function acknowledge_incident(p_incident_id uuid, p_expected_version int) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
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
  insert into incident_events (incident_id, type, actor_id) values (p_incident_id, 'acknowledged', auth.uid());
  perform write_audit('incident_acknowledged', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- ===== update_incident (operational roles; carries protected-field changes) =====
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
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה לעדכן תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  if v.status = 'closed' then
    raise exception 'invalid_transition: תקלה סגורה אינה ניתנת לעדכון';
  end if;
  if not is_valid_transition(v.status, v_new_status) then
    raise exception 'invalid_transition: מעבר הסטטוס אינו מותר';
  end if;
  perform assert_owner_valid(v_new_owner);

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

  update incidents set
    status = v_new_status,
    severity = v_new_severity,
    operational_impact = trim(p_input->>'operationalImpact'),
    owner_user_id = v_new_owner,
    owner_external_name = case when v_new_owner is null then v_new_owner_ext else null end,
    next_update_due = v_new_due,
    no_deadline_reason = case when v_new_due is null then nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), '') else null end,
    reported_to_ops = (p_input->>'reportedToOps')::reported_to_ops,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  perform write_audit('incident_updated', 'incident', p_incident_id::text, v.number);
  return v;
end;
$$;

-- ===== technician_update_incident (content only, assigned incidents only) =====
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
  if v.owner_user_id is distinct from auth.uid() or v.status = 'closed' then
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

-- ===== assign_incident =====
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
  if v.status = 'closed' then
    raise exception 'invalid_transition: לא ניתן לשנות גורם מטפל בתקלה סגורה';
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

-- ===== close_incident (dedicated closure flow only) =====
create or replace function close_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_readiness readiness_level := (p_input->>'readiness')::readiness_level;
  v_follow_up text := nullif(trim(coalesce(p_input->>'followUpNotes', '')), '');
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה לסגור תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  if v.status = 'closed' then
    raise exception 'invalid_transition: התקלה כבר סגורה';
  end if;
  if length(trim(coalesce(p_input->>'rootCause', ''))) = 0 or length(trim(coalesce(p_input->>'resolution', ''))) = 0 then
    raise exception 'validation: סיבת התקלה והפתרון שבוצע הם שדות חובה';
  end if;
  if v_readiness <> 'full' and v_follow_up is null then
    raise exception 'validation: בסגירה עם כשירות חלקית יש לפרט פעולות המשך';
  end if;

  update incidents set
    status = 'closed', closed_at = now(), closed_by = auth.uid(),
    root_cause = trim(p_input->>'rootCause'), resolution = trim(p_input->>'resolution'),
    readiness_at_close = v_readiness, follow_up_notes = v_follow_up,
    follow_up_required = (v_readiness <> 'full'),
    reported_to_ops = (p_input->>'reportedToOps')::reported_to_ops,
    next_update_due = null, no_deadline_reason = 'התקלה נסגרה',
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  insert into incident_events (incident_id, type, actor_id, new_value, note)
  values (p_incident_id, 'closed', auth.uid(), v_readiness::text,
          'סיבת התקלה: ' || v.root_cause || E'\nהפתרון שבוצע: ' || v.resolution ||
          coalesce(E'\nפעולות המשך: ' || v.follow_up_notes, ''));
  perform write_audit('incident_closed', 'incident', p_incident_id::text, v.number,
    null, jsonb_build_object('readiness', v_readiness));
  return v;
end;
$$;

-- ===== reopen_incident (dedicated flow; supervisor allowed only by policy) =====
create table if not exists app_policy (
  key text primary key,
  value jsonb not null
);
insert into app_policy (key, value) values ('allow_supervisor_reopen', 'false') on conflict do nothing;

create or replace function reopen_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
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

  insert into incident_events (incident_id, type, actor_id, old_value, new_value, note)
  values (p_incident_id, 'reopened', auth.uid(), 'closed', 'reopened', trim(p_input->>'reason'));
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

-- ===== corrections =====
create or replace function add_incident_correction(p_incident_id uuid, p_input jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_number text;
  v_ref uuid := (p_input->>'refId')::uuid;
  v_is_author boolean;
begin
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
  insert into incident_events (incident_id, type, actor_id, ref_id, note)
  values (p_incident_id, 'correction', auth.uid(), v_ref, trim(p_input->>'text'));
  perform write_audit('incident_correction', 'incident', p_incident_id::text, v_number);
end;
$$;

-- ===== follow-up completion =====
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

-- ===== handovers =====
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
    where i.status <> 'closed' or (i.follow_up_required and i.follow_up_completed_at is null)
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

create or replace function accept_handover(p_handover_id uuid) returns handovers
language plpgsql security definer set search_path = public as $$
declare
  v handovers;
  r record;
begin
  select * into v from handovers where id = p_handover_id for update;
  if v.id is null then raise exception 'not_found: העברת המשמרת לא נמצאה'; end if;
  if v.status = 'accepted' then raise exception 'validation: ההעברה כבר אושרה'; end if;
  if v.to_user_id <> auth.uid() then
    raise exception 'permission: רק האחמ״ש הנכנס יכול לאשר את ההעברה';
  end if;
  update handovers set status = 'accepted', accepted_at = now(), accepted_by = auth.uid()
  where id = p_handover_id returning * into v;
  for r in select incident_id from handover_items where handover_id = p_handover_id loop
    insert into incident_events (incident_id, type, actor_id, ref_id)
    values (r.incident_id, 'handover_accepted', auth.uid(), p_handover_id);
  end loop;
  perform write_audit('handover_accepted', 'handover', p_handover_id::text);
  return v;
end;
$$;

create or replace function add_handover_addendum(p_handover_id uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v handovers;
begin
  select * into v from handovers where id = p_handover_id;
  if v.id is null then raise exception 'not_found: העברת המשמרת לא נמצאה'; end if;
  if v.status <> 'accepted' then
    raise exception 'validation: תוספת ניתן להוסיף רק להעברה שאושרה';
  end if;
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה';
  end if;
  insert into handover_addenda (handover_id, author_id, text) values (p_handover_id, auth.uid(), trim(p_text));
  perform write_audit('handover_addendum', 'handover', p_handover_id::text);
end;
$$;

-- ===== exports =====
create or replace function record_export(p_export_type text, p_filters text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_export() then
    raise exception 'permission: אין הרשאה לייצא נתונים';
  end if;
  perform write_audit('export_generated', 'export', p_export_type, null, null,
    jsonb_build_object('type', p_export_type, 'filters', p_filters));
end;
$$;

-- ===== admin user management =====
create or replace function admin_set_user_role(p_user_id uuid, p_role app_role) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_before app_role;
begin
  if my_role() is distinct from 'system_admin' then
    raise exception 'permission: רק מנהל מערכת רשאי לשנות תפקידים';
  end if;
  select role into v_before from profiles where id = p_user_id;
  if v_before = 'system_admin' and p_user_id <> auth.uid() then
    raise exception 'permission: לא ניתן לשנות תפקיד של מנהל מערכת אחר';
  end if;
  update profiles set role = p_role where id = p_user_id;
  perform write_audit('user_role_changed', 'profile', p_user_id::text, null,
    jsonb_build_object('role', v_before), jsonb_build_object('role', p_role));
end;
$$;

create or replace function admin_set_user_active(p_user_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() is distinct from 'system_admin' then
    raise exception 'permission: רק מנהל מערכת רשאי לנהל משתמשים';
  end if;
  if not p_active and p_user_id <> auth.uid()
     and (select role from profiles where id = p_user_id) = 'system_admin' then
    raise exception 'permission: לא ניתן להשבית מנהל מערכת אחר';
  end if;
  update profiles set active = p_active where id = p_user_id;
  perform write_audit(case when p_active then 'user_activated' else 'user_deactivated' end,
    'profile', p_user_id::text);
end;
$$;

create or replace function admin_create_placeholder_profile(p_full_name text, p_role app_role)
returns placeholder_profiles
language plpgsql security definer set search_path = public as $$
declare
  v placeholder_profiles;
begin
  if my_role() is distinct from 'system_admin' then
    raise exception 'permission: רק מנהל מערכת רשאי להזמין משתמשים';
  end if;
  insert into placeholder_profiles (full_name, role) values (trim(p_full_name), p_role) returning * into v;
  perform write_audit('user_created', 'profile', v.id::text, null, null, jsonb_build_object('role', p_role));
  return v;
end;
$$;
