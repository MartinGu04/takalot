-- AVARIA v1.7.0 -- permanent incident deletion (system_admin only).
--
-- A deliberately destructive, exceptional admin-only capability: a
-- system_admin may permanently purge an archived (closed or cancelled)
-- incident and its entire live operational footprint from the database.
-- This is NOT a lifecycle action (compare cancel_incident, which merely
-- changes status) and NOT the personnel tombstone pattern (compare
-- admin_delete_user, 0013, which deliberately keeps the profile row and
-- its history forever) -- this is a genuine, irreversible DELETE across
-- the incident's full dependency graph, gated behind a single narrow RPC.
--
-- ===== What survives =====
--   - incident_sequences: never read, updated, or referenced anywhere in
--     this file. The deleted incident's number is never reused -- no
--     rewind, no "next number" adjustment. Sequence correction remains a
--     separate, manual, exceptional maintenance action outside this RPC's
--     scope entirely.
--   - audit_logs: every historical row already written during the
--     incident's lifecycle (incident_created, incident_status_changed,
--     incident_closed, ...) is left completely untouched -- audit_logs
--     has no FK to incidents at all (entity_id/incident_number are plain
--     text, deliberately, so they already survive entity deletion -- see
--     delete_system, 0024, which already writes an audit row referencing
--     a system id it just hard-deleted). trg_audit_logs_immutable is
--     never bypassed by this migration; it remains the one absolute,
--     no-exceptions guarantee in this schema. Exactly one NEW row is
--     added, after the purge succeeds: a minimal tombstone (actor,
--     incident id/number, timestamp, action type only -- see section 4).
--   - handovers: only this incident's own handover_items rows are
--     removed; a handover legitimately spans multiple incidents and must
--     survive with its other items intact.
--
-- ===== The bypass mechanism (section 1) =====
-- reject_mutation() (0001) unconditionally blocks UPDATE/DELETE on 11
-- tables this purge must delete from. Rather than ALTER TABLE ... DISABLE
-- TRIGGER (schema/catalog-level DDL, takes an ACCESS EXCLUSIVE lock for
-- the transaction's duration, and -- if the enable/disable pairing has
-- any bug -- can leave a trigger permanently disabled after commit,
-- silently weakening protection for every future row, not just this
-- one), this uses a transaction-local GUC flag,
-- avaria.incident_purge_in_progress, checked inside reject_mutation()
-- itself.
--
-- The bypass is explicitly turned back 'off' by admin_purge_incident
-- itself, immediately after the last guarded delete succeeds and before
-- write_audit() runs (section 2) -- this is the NORMAL way the bypass
-- ends on the successful path, so the flag is never left 'on' for any
-- later statement in the same transaction (including a later call in the
-- same transaction, or a subsequent RPC sharing it), regardless of
-- whether the caller's transport happens to give this RPC its own
-- transaction.
--
-- Transaction-end clearing remains in place as a fallback safety net, not
-- the primary mechanism: set_config(..., true) (is_local = true) is
-- automatically and unconditionally cleared by Postgres at
-- end-of-transaction -- commit or rollback -- with no code path that can
-- forget to reset it, no DDL, no table-wide lock. This still covers the
-- one path the explicit reset cannot: an exception raised between setting
-- the flag 'on' and reaching the explicit reset (e.g. a delete failing
-- partway through the dependency graph), where the whole transaction
-- rolls back and the flag reverts with it.
--
-- current_setting(name, missing_ok := true) returns NULL (never raises)
-- when the flag was never set, so every existing caller, everywhere else
-- in the system, sees NULL <> 'on' and hits the exact same raise
-- exception as today -- zero behavior change for anyone but
-- admin_purge_incident. The browser can never reach set_config()/
-- current_setting() directly: PostgREST's /rpc/ surface only exposes
-- functions explicitly GRANTed EXECUTE, and these are plain pg_catalog
-- builtins, never whitelisted -- the only way to set this flag is from
-- inside admin_purge_incident's own body.
--
-- ===== Dependency graph (derived from the current schema, section 2) =====
-- Every table with incident_id (or, for the junction table, a path back to
-- incident_id via incident_closures/incident_treatment_actions) referencing
-- incidents(id), in FK-safe delete order:
--   incident_closure_resolution_actions (junction: closure_id ->
--     incident_closures.id, treatment_action_id ->
--     incident_treatment_actions.id -- 0046)
--   incident_closures (0046)
--   incident_treatment_actions (0046)
--   incident_cause_assessments (0046)
--   incident_status_checks (0016)
--   incident_report_events (0016 -- currently dormant in production, no
--     migration has ever written a row, but the schema allows one and the
--     FK would block the final delete if it ever did)
--   incident_severity_assessments (0016 -- also currently dormant; see
--     the reverse FK note below)
--   handover_items (0001, scoped to incident_id only -- handovers itself
--     is never touched)
--   incident_relations (0049, both incident_a_id and incident_b_id --
--     deliberately has NO reject_mutation trigger, already RPC-only via
--     RLS/grant, so no bypass is needed for this one table)
--   notifications (0001, incident_id is nullable -- only rows actually
--     scoped to this incident) -- push_deliveries (0053) has notification_id
--     references notifications(id) ON DELETE CASCADE already, so it is
--     never touched directly; it disappears automatically the instant its
--     parent notification row is deleted, with no explicit statement here.
--   incident_events (0001)
--   incident_updates (0001)
--   incidents (0001, last)
--
-- Reverse FK: incidents.current_severity_assessment_id is a composite FK
-- (0016) pointing INTO incident_severity_assessments -- the opposite
-- direction from every other dependency above. It must be nulled out
-- (along with its three bidirectionally-paired mirror columns) BEFORE
-- incident_severity_assessments rows for this incident are deleted, or
-- that delete would fail with a foreign_key_violation even under the
-- purge-in-progress bypass (the bypass only concerns reject_mutation()'s
-- own trigger, never real referential-integrity constraints). This is a
-- plain UPDATE, not blocked by any trigger (incidents only has
-- trg_incidents_no_delete, which blocks DELETE, not UPDATE), so it needs
-- no bypass of its own.
--
-- Explicit transaction, matching this schema's convention for
-- multi-statement feature migrations.

begin;

-- =====================================================================
-- 1. reject_mutation(): redefined to allow an explicit, narrow,
--    transaction-scoped bypass. See header for the full safety reasoning.
--    CREATE OR REPLACE keeps the function's OID stable, so every trigger
--    already attached to it (0001/0016/0046) stays attached automatically
--    -- no trigger needs to be recreated.
-- =====================================================================
create or replace function public.reject_mutation() returns trigger
language plpgsql as $$
begin
  if current_setting('avaria.incident_purge_in_progress', true) = 'on' then
    return coalesce(new, old);
  end if;
  raise exception 'append_only: % rows cannot be modified or deleted', tg_table_name;
end;
$$;

comment on function public.reject_mutation() is
  'Unconditionally blocks UPDATE/DELETE on every append-only/no-delete table in this schema, EXCEPT for the single escape hatch avaria.incident_purge_in_progress -- set ONLY inside admin_purge_incident (0059). On the successful path, admin_purge_incident explicitly turns this back off itself as soon as the guarded deletes are done; transaction-scoped clearing (set_config(..., true) reverting at commit/rollback) is the fallback safety net for the exception/rollback path, not the primary mechanism, and never leaks into any other transaction or session either way. Every other caller, everywhere, sees identical behavior to before this migration.';

-- =====================================================================
-- 2. admin_purge_incident(): the RPC itself.
--
--    Authorization (section 5 of the approved design): auth.uid() must be
--    non-null; the caller's profiles row must exist and be active; role
--    must be EXACTLY 'system_admin' -- no ceiling/hierarchy logic (unlike
--    admin_delete_user's role_ceiling_allows_manage, which does not apply
--    here). This check runs BEFORE the incident is even looked up, so
--    probing a real vs. fake incident id leaks nothing to an unauthorized
--    caller -- the exact same 'permission:' error either way.
--
--    search_path = '' with every reference fully schema-qualified,
--    matching admin_delete_user's own convention for this exact class of
--    RPC (a destructive, system_admin-gated operation) -- immune to any
--    search_path manipulation, not merely defaulting to public.
--
--    No expectedVersion/optimistic-concurrency parameter: unlike every
--    lifecycle RPC (update_incident, close_incident, ...), a purge is not
--    an edit a concurrent editor could meaningfully conflict with -- the
--    only race that matters is "does the row still exist", which the
--    `for update` lock + `not found` check already resolve correctly: a
--    concurrent lifecycle call blocks on the row lock until this
--    transaction commits or rolls back, and if it commits, that other
--    call simply finds the incident gone.
-- =====================================================================
create or replace function public.admin_purge_incident(p_incident_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_incident public.incidents;
  v_actor public.profiles;
begin
  -- ----- Authorization: independent of, and before, any incident lookup -----
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה';
  end if;
  select * into v_actor from public.profiles where id = auth.uid() and active;
  if not found or v_actor.role <> 'system_admin' then
    raise exception 'permission: מחיקה לצמיתות זמינה למנהלי מערכת בלבד';
  end if;

  -- ----- Existence + lock -----
  select * into v_incident from public.incidents where id = p_incident_id for update;
  if not found then
    raise exception 'not_found: התקלה לא נמצאה';
  end if;

  -- ----- Terminal/archived state only, matching the Archive's own
  --       definition (is_incident_terminal: closed or cancelled) -----
  if not public.is_incident_terminal(v_incident.status) then
    raise exception 'invalid_transition: ניתן למחוק לצמיתות רק תקלה סגורה או מבוטלת (בארכיון)';
  end if;

  -- ----- Break the reverse FK (incidents -> incident_severity_assessments)
  --       before that table's rows for this incident are deleted below.
  --       Bidirectional pairing (0016): all four columns null together. -----
  update public.incidents set
    current_severity_assessment_id = null,
    severity_ruleset_version = null,
    severity_recommended = null,
    severity_override_reason = null
  where id = p_incident_id;

  -- ----- Narrow bypass -- see section 1 and the file header. Turned back
  --       'off' explicitly below the moment the guarded deletes finish
  --       (the normal successful-path close); end-of-transaction clearing
  --       is only the fallback for the exception/rollback path. Never set
  --       anywhere else in this schema. -----
  perform set_config('avaria.incident_purge_in_progress', 'on', true);

  -- ----- Full dependency graph, in FK-safe order (see header) -----
  delete from public.incident_closure_resolution_actions
    where closure_id in (select id from public.incident_closures where incident_id = p_incident_id)
       or treatment_action_id in (select id from public.incident_treatment_actions where incident_id = p_incident_id);
  delete from public.incident_closures where incident_id = p_incident_id;
  delete from public.incident_treatment_actions where incident_id = p_incident_id;
  delete from public.incident_cause_assessments where incident_id = p_incident_id;
  delete from public.incident_status_checks where incident_id = p_incident_id;
  delete from public.incident_report_events where incident_id = p_incident_id;
  delete from public.incident_severity_assessments where incident_id = p_incident_id;
  delete from public.handover_items where incident_id = p_incident_id;
  delete from public.incident_relations where incident_a_id = p_incident_id or incident_b_id = p_incident_id;
  -- push_deliveries disappears automatically via its own
  -- notification_id -> notifications(id) ON DELETE CASCADE (0053) -- no
  -- explicit statement needed or wanted here.
  delete from public.notifications where incident_id = p_incident_id;
  delete from public.incident_events where incident_id = p_incident_id;
  delete from public.incident_updates where incident_id = p_incident_id;
  delete from public.incidents where id = p_incident_id;

  -- ----- Close the bypass explicitly, on the successful path, the moment
  --       it is no longer needed -- i.e. immediately after the last
  --       guarded delete (incidents) has succeeded, and BEFORE
  --       write_audit() below. This is the NORMAL way the bypass ends;
  --       end-of-transaction clearing (see section 1) is a fallback safety
  --       net for the exception/rollback path only, not the primary
  --       mechanism -- the flag is not meant to still be 'on' for any
  --       statement this function issues after the guarded section. -----
  perform set_config('avaria.incident_purge_in_progress', 'off', true);

  -- ----- Minimal audit tombstone -- written ONLY after every delete
  --       above has succeeded (a failure anywhere aborts the whole
  --       transaction, including this call, per the atomicity guarantee).
  --       Deliberately no before_data/after_data/summary/metadata and no
  --       deletion reason -- actor (captured automatically by write_audit
  --       from auth.uid()), incident id/number, timestamp (created_at
  --       default), and action type only. Every PRE-EXISTING audit_logs
  --       row for this incident (written during its normal lifecycle) is
  --       untouched -- see the file header. -----
  perform public.write_audit(
    p_action => 'incident_permanently_deleted',
    p_entity_type => 'incident',
    p_entity_id => v_incident.id::text,
    p_incident_number => v_incident.number,
    p_entity_label => v_incident.number
  );
end;
$$;

comment on function public.admin_purge_incident(uuid) is
  'Permanently deletes an archived (closed/cancelled) incident and its entire live operational footprint -- system_admin only, fails closed for every other role/state. incident_sequences is never read or written: the deleted number is never reused. audit_logs history is preserved; exactly one minimal tombstone row is added on success. The reject_mutation() bypass it uses is explicitly turned back off on the successful path, before write_audit() runs -- end-of-transaction clearing is only a fallback for the exception/rollback path. See migration 0059 for the full design rationale.';

-- Direct table deletion stays unavailable regardless of this RPC: RLS on
-- every table above still has no INSERT/UPDATE/DELETE policy at all (only
-- SELECT), so this migration adds no new client-reachable delete surface
-- beyond the one narrow RPC below. The RPC itself, not a client role
-- grant, remains the authoritative boundary -- EXECUTE is granted broadly
-- to `authenticated` (exactly like every other role-gated RPC in this
-- schema, e.g. admin_delete_user, set_my_operational_notification_preference),
-- because the function body's own role check is what actually enforces
-- system_admin-only, not the grant.
revoke execute on function public.admin_purge_incident(uuid) from public, anon;
grant execute on function public.admin_purge_incident(uuid) to authenticated;

commit;
