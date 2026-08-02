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
--
-- ===== Fail-closed preflight =====
-- Before the stricter check below takes effect, this migration refuses to
-- apply at all if any EXISTING non-terminal incident is already assigned to
-- an internal owner whose role would now be rejected. Mirrors 0014's own
-- preflight for the inactive/tombstoned-owner invariant -- same shape, same
-- "count and raise" idiom, same guarantee: read-only, no UPDATE/INSERT/
-- DELETE anywhere in this block, so it never reassigns or rewrites anything
-- itself. Uses is_incident_terminal (0016) rather than a literal status
-- list -- "non-terminal" is not just "status <> 'closed'" (partial_
-- readiness, resolved_pending_close, reopened, and every in-progress/
-- waiting_* status are all non-terminal too), and the terminal set itself
-- (closed, cancelled) is exactly what this helper already encodes. A
-- terminal incident's owner_user_id is a historical fact, not a live
-- assignment -- it is deliberately excluded from this check and must never
-- block this migration. On a fresh/empty database (this migration's own
-- first-ever application during local test runs, and the intended hosted
-- rollout) this is a guaranteed no-op.
do $$
declare
  v_bad_count int;
begin
  select count(*) into v_bad_count
  from incidents i
  join profiles p on p.id = i.owner_user_id
  where not is_incident_terminal(i.status)
    and p.role not in ('system_admin', 'professional_manager', 'shift_supervisor', 'technician');

  if v_bad_count > 0 then
    raise exception
      'preflight: % active incident(s) are currently assigned to an internal owner whose role is not eligible to be an internal owner (system_admin, professional_manager, shift_supervisor, or technician). '
      'Reassign each one via assign_incident (to an active, eligible internal owner) before this migration can be applied. '
      'This preflight does not and will not reassign or rewrite any historical data itself.',
      v_bad_count;
  end if;
end $$;

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
