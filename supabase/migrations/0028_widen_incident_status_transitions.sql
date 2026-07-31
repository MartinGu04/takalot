-- מעקב תקלות — forward migration.
-- Widens is_valid_transition (0017) to permit 'waiting_information' and
-- 'waiting_validation' as update targets. Both enum values already exist
-- (0015) and are fully supported for reading/rendering/filtering, but the
-- function's catch-all `else` branch never allowed transitioning INTO
-- either of them -- the frontend has been hiding them from the update
-- dropdown for exactly this reason (see UpdateDialog.tsx's
-- NOT_YET_SELECTABLE_UPDATE_TARGETS comment). This is that backend cutover.
--
-- 'waiting_equipment' is deliberately NOT added here: it is not one of the
-- three "בהמתנה" reasons this PR's update UI offers, so it stays valid to
-- store/display but not reachable through the update dropdown.
--
-- Pure `create or replace function`, same signature, same
-- `language sql immutable set search_path = public` -- only the final
-- `else` branch's target list changes.

create or replace function is_valid_transition(p_from incident_status, p_to incident_status) returns boolean
language sql immutable set search_path = public as $$
  select case
    when p_from in ('closed', 'cancelled') then false
    when p_to in ('closed', 'reopened', 'cancelled') then false
    when p_from = p_to then true
    when p_from = 'new' then p_to in ('acknowledged', 'in_progress')
    when p_from = 'resolved_pending_close' then p_to in ('in_progress', 'monitoring', 'waiting_test')
    else p_to in ('in_progress', 'waiting_external', 'waiting_information', 'waiting_validation',
                   'waiting_test', 'monitoring', 'partial_readiness', 'resolved_pending_close')
  end;
$$;
