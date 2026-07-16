-- מעקב תקלות — schema
-- All timestamps are stored in UTC (timestamptz). Display timezone is Asia/Jerusalem (client-side).

create extension if not exists pgcrypto;

-- ===== Enums (fixed in the MVP, not editable from settings) =====
create type app_role as enum ('system_admin', 'professional_manager', 'shift_supervisor', 'technician', 'viewer');
create type incident_severity as enum ('critical', 'high', 'medium', 'low');
create type incident_status as enum (
  'new', 'acknowledged', 'in_progress', 'waiting_external', 'waiting_test',
  'monitoring', 'partial_readiness', 'resolved_pending_close', 'closed', 'reopened'
);
create type readiness_level as enum ('full', 'partial', 'none');
create type reported_to_ops as enum ('yes', 'no', 'not_required');
create type incident_event_type as enum (
  'created', 'acknowledged', 'update', 'status_change', 'severity_change', 'impact_change',
  'assignment_change', 'deadline_change', 'correction', 'handover_included', 'handover_accepted',
  'closed', 'follow_up_completed', 'reopened'
);
create type handover_status as enum ('pending', 'accepted');
create type notification_type as enum ('incident_assigned', 'update_overdue', 'incident_reopened', 'handover_pending');

-- ===== Profiles (invite-only; rows are created for auth.users by admin flow) =====
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  role app_role not null default 'viewer',
  active boolean not null default true,
  -- explicit backend capability grant for viewer export (never a frontend switch)
  can_export_override boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Placeholder profiles for users invited but not yet registered use a generated uuid
-- via admin_create_placeholder_profile (see functions migration); the FK is deferred
-- by keeping placeholders in a separate table to avoid violating the auth.users FK.
create table placeholder_profiles (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  role app_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ===== Configuration =====
create table systems (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id)
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id)
);

-- ===== Atomic yearly numbering =====
create table incident_sequences (
  year int primary key,
  last_number int not null default 0
);

-- ===== Incidents =====
create table incidents (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  version int not null default 1,
  system_id uuid not null references systems (id),
  location_id uuid not null references locations (id),
  description text not null check (length(trim(description)) between 1 and 4000),
  severity incident_severity not null,
  status incident_status not null default 'new',
  operational_impact text not null check (length(trim(operational_impact)) between 1 and 1000),
  owner_user_id uuid references profiles (id),
  owner_external_name text check (owner_external_name is null or length(owner_external_name) <= 120),
  discovered_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references profiles (id),
  last_update_at timestamptz not null default now(),
  next_update_due timestamptz,
  no_deadline_reason text check (no_deadline_reason is null or length(no_deadline_reason) <= 500),
  reported_to_ops reported_to_ops not null default 'no',
  closed_at timestamptz,
  closed_by uuid references profiles (id),
  root_cause text check (root_cause is null or length(root_cause) <= 2000),
  resolution text check (resolution is null or length(resolution) <= 4000),
  readiness_at_close readiness_level,
  follow_up_notes text check (follow_up_notes is null or length(follow_up_notes) <= 2000),
  follow_up_required boolean not null default false,
  follow_up_completed_at timestamptz,
  follow_up_completed_by uuid references profiles (id),
  reopen_count int not null default 0,
  -- denormalized search helper maintained by trigger
  search_text text not null default '',

  -- Critical invariants
  constraint incident_owner_present check (
    status = 'closed' or owner_user_id is not null or owner_external_name is not null
  ),
  constraint incident_deadline_or_reason check (
    status = 'closed' or next_update_due is not null or no_deadline_reason is not null
  ),
  constraint incident_closure_complete check (
    status <> 'closed' or (
      closed_at is not null and closed_by is not null and
      root_cause is not null and resolution is not null and readiness_at_close is not null
    )
  ),
  constraint incident_partial_readiness_follow_up check (
    readiness_at_close is null or readiness_at_close = 'full' or follow_up_notes is not null
  )
);

create index idx_incidents_status on incidents (status);
create index idx_incidents_severity on incidents (severity);
create index idx_incidents_owner on incidents (owner_user_id);
create index idx_incidents_next_update on incidents (next_update_due) where status <> 'closed';
create index idx_incidents_created_at on incidents (created_at desc);
create index idx_incidents_closed_at on incidents (closed_at desc) where closed_at is not null;
create index idx_incidents_system on incidents (system_id);
create index idx_incidents_location on incidents (location_id);
create index idx_incidents_number on incidents (number);
create index idx_incidents_search on incidents using gin (to_tsvector('simple', search_text));

-- ===== Incident updates (append-only) =====
create table incident_updates (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents (id),
  author_id uuid not null references profiles (id),
  event_time timestamptz not null,
  server_time timestamptz not null default now(),
  actions_taken text not null check (length(trim(actions_taken)) between 1 and 4000),
  findings text not null default '' check (length(findings) <= 4000),
  next_steps text not null default '' check (length(next_steps) <= 2000),
  created_at timestamptz not null default now()
);
create index idx_incident_updates_incident on incident_updates (incident_id, event_time);

-- ===== Incident events (append-only unified timeline) =====
create table incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents (id),
  type incident_event_type not null,
  actor_id uuid references profiles (id),
  actor_label text,
  event_time timestamptz not null default now(),
  server_time timestamptz not null default now(),
  field text,
  old_value text,
  new_value text,
  note text,
  ref_id uuid,
  created_at timestamptz not null default now()
);
create index idx_incident_events_incident on incident_events (incident_id, event_time);

-- ===== Handovers =====
create table handovers (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  to_user_id uuid not null references profiles (id),
  general_note text not null default '' check (length(general_note) <= 2000),
  status handover_status not null default 'pending',
  accepted_at timestamptz,
  accepted_by uuid references profiles (id),
  constraint handover_not_to_self check (created_by <> to_user_id),
  constraint handover_accept_complete check (
    status <> 'accepted' or (accepted_at is not null and accepted_by is not null)
  )
);
create index idx_handovers_created on handovers (created_at desc);
create index idx_handovers_to_user on handovers (to_user_id, status);

create table handover_items (
  id uuid primary key default gen_random_uuid(),
  handover_id uuid not null references handovers (id),
  incident_id uuid not null references incidents (id),
  note text not null default '' check (length(note) <= 1000),
  snapshot_number text not null,
  snapshot_status incident_status not null,
  snapshot_severity incident_severity not null,
  snapshot_owner_label text not null default '',
  snapshot_system_name text not null default '',
  snapshot_location_name text not null default '',
  snapshot_impact text not null default '',
  snapshot_last_action text not null default '',
  snapshot_next_steps text not null default '',
  snapshot_next_update_due timestamptz
);
create index idx_handover_items_handover on handover_items (handover_id);

create table handover_addenda (
  id uuid primary key default gen_random_uuid(),
  handover_id uuid not null references handovers (id),
  author_id uuid not null references profiles (id),
  text text not null check (length(trim(text)) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- ===== Notifications (in-app only) =====
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id),
  type notification_type not null,
  incident_id uuid references incidents (id),
  handover_id uuid references handovers (id),
  text text not null,
  read boolean not null default false,
  dedupe_key text,
  created_at timestamptz not null default now()
);
create unique index idx_notifications_dedupe on notifications (dedupe_key) where dedupe_key is not null;
create index idx_notifications_user on notifications (user_id, read, created_at desc);

-- ===== Append-only audit log =====
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles (id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  incident_number text,
  before_data jsonb,
  after_data jsonb,
  correlation_id text,
  created_at timestamptz not null default now()
);
create index idx_audit_logs_created on audit_logs (created_at desc);
create index idx_audit_logs_actor on audit_logs (actor_id);
create index idx_audit_logs_incident on audit_logs (incident_number);

-- ===== Immutability & housekeeping triggers =====

create or replace function reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'append_only: % rows cannot be modified or deleted', tg_table_name;
end;
$$;

create trigger trg_audit_logs_immutable
  before update or delete on audit_logs
  for each row execute function reject_mutation();

create trigger trg_incident_events_immutable
  before update or delete on incident_events
  for each row execute function reject_mutation();

create trigger trg_incident_updates_immutable
  before update or delete on incident_updates
  for each row execute function reject_mutation();

create trigger trg_incidents_no_delete
  before delete on incidents
  for each row execute function reject_mutation();

create trigger trg_handovers_no_delete
  before delete on handovers
  for each row execute function reject_mutation();

-- Accepted handovers are immutable (only addenda may be added afterwards).
create or replace function protect_accepted_handover() returns trigger
language plpgsql as $$
begin
  if old.status = 'accepted' then
    raise exception 'append_only: accepted handovers are immutable';
  end if;
  return new;
end;
$$;

create trigger trg_handover_immutable_after_accept
  before update on handovers
  for each row execute function protect_accepted_handover();

create trigger trg_handover_items_immutable
  before update or delete on handover_items
  for each row execute function reject_mutation();

-- updated_at maintenance
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_profiles_touch before update on profiles
  for each row execute function touch_updated_at();

-- Maintain denormalized incident search text
create or replace function refresh_incident_search_text() returns trigger
language plpgsql as $$
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

create trigger trg_incidents_search before insert or update on incidents
  for each row execute function refresh_incident_search_text();
