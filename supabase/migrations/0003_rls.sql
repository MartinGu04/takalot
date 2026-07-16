-- מעקב תקלות — Row Level Security
-- Every user-accessible table has RLS enabled. Mutations flow exclusively through
-- SECURITY DEFINER RPCs (0002_functions.sql); direct table writes are denied except
-- for narrowly scoped cases (own notifications read-state, admin config edits).
-- There is no public signup: profiles rows are created only for invited auth users.

alter table profiles enable row level security;
alter table placeholder_profiles enable row level security;
alter table systems enable row level security;
alter table locations enable row level security;
alter table incident_sequences enable row level security;
alter table incidents enable row level security;
alter table incident_updates enable row level security;
alter table incident_events enable row level security;
alter table handovers enable row level security;
alter table handover_items enable row level security;
alter table handover_addenda enable row level security;
alter table notifications enable row level security;
alter table audit_logs enable row level security;
alter table app_policy enable row level security;

-- helper: current user is an active authenticated member
create or replace function is_active_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

-- ===== profiles =====
create policy profiles_select on profiles for select
  using (is_active_member());
-- No insert/update/delete policies: managed via admin RPCs and auth triggers only.
-- Role changes CANNOT be performed by editing a profile row directly.

create policy placeholder_profiles_select on placeholder_profiles for select
  using (my_role() = 'system_admin');

-- ===== configuration =====
create policy systems_select on systems for select using (is_active_member());
create policy systems_admin_insert on systems for insert with check (my_role() = 'system_admin');
create policy systems_admin_update on systems for update using (my_role() = 'system_admin');
-- no delete policy: archived, never hard-deleted

create policy locations_select on locations for select using (is_active_member());
create policy locations_admin_insert on locations for insert with check (my_role() = 'system_admin');
create policy locations_admin_update on locations for update using (my_role() = 'system_admin');

-- ===== incident_sequences: no direct access (RPC only) =====
-- (RLS enabled with no policies = deny all to non-service roles)

-- ===== incidents =====
-- All active members can view incidents (viewer is read-only; technician sees
-- department incidents — in this MVP the whole department shares visibility).
create policy incidents_select on incidents for select using (is_active_member());
-- No direct insert/update/delete: lifecycle flows only via RPCs.

create policy incident_updates_select on incident_updates for select using (is_active_member());
create policy incident_events_select on incident_events for select using (is_active_member());

-- ===== handovers =====
create policy handovers_select on handovers for select using (is_active_member());
create policy handover_items_select on handover_items for select using (is_active_member());
create policy handover_addenda_select on handover_addenda for select using (is_active_member());
-- Mutations via RPCs only.

-- ===== notifications =====
create policy notifications_select_own on notifications for select
  using (user_id = auth.uid());
create policy notifications_mark_read on notifications for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
-- Inserts happen inside RPCs; no direct insert/delete.

-- ===== audit_logs =====
-- system_admin sees everything; professional_manager sees incident-related activity.
create policy audit_select on audit_logs for select using (
  my_role() = 'system_admin'
  or (my_role() = 'professional_manager' and entity_type in ('incident', 'handover', 'export'))
);
-- Append-only: inserts via write_audit (security definer); update/delete blocked by
-- both the absence of policies and the reject_mutation trigger.

-- ===== app_policy =====
create policy app_policy_select on app_policy for select using (is_active_member());
create policy app_policy_admin_update on app_policy for update using (my_role() = 'system_admin');

-- ===== function grants =====
-- Restrict RPC execution to authenticated users only.
revoke execute on all functions in schema public from anon;
grant execute on function
  create_incident(jsonb),
  acknowledge_incident(uuid, int),
  update_incident(uuid, jsonb),
  technician_update_incident(uuid, jsonb),
  assign_incident(uuid, jsonb),
  close_incident(uuid, jsonb),
  reopen_incident(uuid, jsonb),
  add_incident_correction(uuid, jsonb),
  complete_follow_up(uuid, text),
  create_handover(jsonb),
  accept_handover(uuid),
  add_handover_addendum(uuid, text),
  record_export(text, text),
  can_export(),
  my_role(),
  admin_set_user_role(uuid, app_role),
  admin_set_user_active(uuid, boolean),
  admin_create_placeholder_profile(text, app_role)
to authenticated;
