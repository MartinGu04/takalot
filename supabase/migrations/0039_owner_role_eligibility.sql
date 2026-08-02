-- מעקב תקלות — forward migration.
-- assert_owner_valid gains a role check: an internal owner must be an
-- ACTIVE user in an eligible role -- system_admin, professional_manager,
-- shift_supervisor, or technician. viewer is now explicitly rejected, even
-- when active, closing the gap where a direct RPC call (create_incident,
-- update_incident, assign_incident, close_incident, reopen_incident,
-- create_handover -- every one of them already routes through this single
-- shared function) could set a viewer as an incident's internal owner.
--
-- Preserves everything else about this function unchanged since 0014:
-- same signature, same FOR SHARE row lock (still closes the TOCTOU race
-- against admin_set_user_active's FOR UPDATE lock), same "not found or not
-- active" rejection and its exact existing error text, same null-owner
-- no-op. Only a new role check is added, with its own distinct message so
-- callers can tell "inactive" and "ineligible role" apart. No RPC body
-- needs to change: every lifecycle RPC already calls this one shared
-- function rather than duplicating the check, so strengthening it here is
-- sufficient and `create or replace function` preserves all existing
-- EXECUTE grants.
create or replace function public.assert_owner_valid(p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_active boolean;
  v_role public.app_role;
begin
  if p_owner is not null then
    select active, role into v_active, v_role from public.profiles where id = p_owner for share;
    if not found or not v_active then
      raise exception 'validation: הגורם המטפל שנבחר אינו פעיל';
    end if;
    if v_role not in ('system_admin', 'professional_manager', 'shift_supervisor', 'technician') then
      raise exception 'validation: הגורם המטפל שנבחר אינו זכאי לשמש כבעל אחריות';
    end if;
  end if;
end;
$$;
