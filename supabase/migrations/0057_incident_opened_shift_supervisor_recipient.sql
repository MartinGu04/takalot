-- AVARIA v1.5.0 -- incident_opened recipient policy: active shift_supervisor
-- users now receive the canonical incident_opened operational broadcast, the
-- same way active professional_manager users already do.
--
-- notify_operational_recipients() (migration 0044, actor_id added 0056) is
-- the single shared broadcast helper behind FIVE distinct notification
-- types: incident_opened, incident_updated, incident_closed,
-- incident_cancelled, incident_reopened -- all called with the SAME
-- six-argument signature, differing only in the p_type/p_text/p_category
-- values each call site passes in. Its recipient WHERE clause has no
-- p_type-based branching today, so a blanket "add shift_supervisor to the
-- role list" edit would silently widen the recipient set for all five
-- types, not just incident_opened -- out of this change's approved scope
-- ("no change to routine incident_updated / closed / cancelled ... policy").
--
-- Fix: key the new shift_supervisor inclusion off p_type = 'incident_opened'
-- -- a value the function already receives from every call site, requiring
-- no new parameter and therefore no signature change (CREATE OR REPLACE
-- keeps the same argument list, so the function's OID and existing
-- GRANT/REVOKE are preserved untouched, same as every other CREATE OR
-- REPLACE in this migration chain). The other four broadcast types
-- (incident_updated/closed/cancelled/reopened) keep their exact existing
-- recipient set -- professional_manager, plus system_admin gated by
-- operational_notifications_enabled -- completely unchanged.
--
-- Everything else this function already does is preserved verbatim:
--   - the actor (auth.uid()) is still excluded from their own broadcast
--   - the dedupe_key-based ON CONFLICT DO NOTHING duplicate suppression
--   - system_admin's existing operational_notifications_enabled gate
--   - inactive profiles are still excluded entirely (p.active)
--   - actor_id is still stamped on every inserted row (migration 0056)
--
-- Push delivery policy is untouched by this migration: qualifiesForPush()
-- (supabase/functions/send-push-notification/dispatch.ts) already sends
-- Push for every 'update'-category incident_opened row regardless of which
-- profile it targets, and still never sends for incident_updated/closed/
-- cancelled -- this is purely a canonical-recipient-set change at the data
-- layer, exactly as requested.
create or replace function public.notify_operational_recipients(p_type notification_type, p_category notification_category, p_incident_id uuid, p_text text, p_operation_id uuid, p_exclude_user_ids uuid[] default '{}'::uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, type, incident_id, text, category, dedupe_key, actor_id)
  select p.id, p_type, p_incident_id, p_text, p_category,
         'opn-' || p_operation_id::text || '-' || p.id::text, auth.uid()
  from profiles p
  where (
      p.role = 'professional_manager'
      or (p.role = 'system_admin' and p.operational_notifications_enabled)
      or (p.role = 'shift_supervisor' and p_type = 'incident_opened')
    )
    and p.active
    and p.id <> auth.uid()
    and not (p.id = any(p_exclude_user_ids))
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
end;
$$;
