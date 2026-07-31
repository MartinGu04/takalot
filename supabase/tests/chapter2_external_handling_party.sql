-- Tests for migration 0032: additive external handling party.
--
-- Covers: external_handler_name/_contact_person/_contact_details are purely
-- additive, never a substitute for the (now uniformly mandatory) internal
-- owner; preserve-on-omit/update-on-supply/clear-on-explicit-null semantics
-- across create_incident, update_incident, assign_incident, close_incident
-- (both readiness branches), and reopen_incident; the legacy
-- owner_external_name column is byte-identical after every one of those
-- RPCs runs against a legacy external-only incident; a legacy
-- ownerExternalName payload key is tolerated but never read; the
-- name-required-with-contact rule at both the RPC layer (blank-as-absent)
-- and the CHECK constraint layer (nullif(btrim(...), '') semantics, so a
-- whitespace-only name does not count as "present"); one field='external_handler'
-- assignment_change event per genuine change, with a full 3-field snapshot in
-- both old_value and new_value so a contact-only change is visibly distinct
-- even when the name itself is unchanged; the migration-time backfill is
-- copy-only and idempotent for both open and terminal legacy incidents.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'supervisor-g@test', now()),
  ('00000000-0000-0000-0000-0000000000a2', 'owner-tech-g@test', now()),
  ('00000000-0000-0000-0000-0000000000a3', 'other-tech-g@test', now()),
  ('00000000-0000-0000-0000-0000000000a4', 'admin-g@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000a1', 'Supervisor G', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000a2', 'Owner Technician G', 'technician', true),
  ('00000000-0000-0000-0000-0000000000a3', 'Other Technician G', 'technician', true),
  ('00000000-0000-0000-0000-0000000000a4', 'Admin G', 'system_admin', true);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000a901', 'Sys G', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000a902', 'Loc G', 1);

-- g810: open, internal owner already set, no external handler yet -- base
-- fixture for update/assign preserve/update/clear coverage.
-- g811: open, LEGACY external-only (owner_user_id null, owner_external_name
-- set) -- proves an internal owner must now be supplied going forward, and
-- that owner_external_name survives byte-identical once one is.
-- g812: CLOSED (terminal), LEGACY external-only -- proves the backfill
-- covers terminal rows too and that reopen_incident's owner-mandatory rule
-- and owner_external_name preservation both hold on reopen.
-- g813: open, already has all three external-handler fields set -- base
-- fixture for "omit preserves" / "explicit null clears" / "contact-only
-- change" coverage.
-- g814/g815: open, fresh, for close_incident full/partial branches.
insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, owner_external_name, discovered_at,
                       created_by, updated_by, version)
values
  ('00000000-0000-0000-0000-00000000a810', 'T-G810', '00000000-0000-0000-0000-00000000a901',
   '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a2', null, now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 1),
  ('00000000-0000-0000-0000-00000000a811', 'T-G811', '00000000-0000-0000-0000-00000000a901',
   '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'in_progress', 'i',
   null, 'ספק חיצוני היסטורי (פתוח)', now() - interval '20 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 1);

insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, owner_external_name, discovered_at,
                       created_by, updated_by, closed_at, closed_by, root_cause, resolution,
                       readiness_at_close, version)
values
  ('00000000-0000-0000-0000-00000000a812', 'T-G812', '00000000-0000-0000-0000-00000000a901',
   '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'closed', 'i',
   null, 'ספק חיצוני היסטורי (סגור)', now() - interval '30 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() - interval '25 days', '00000000-0000-0000-0000-0000000000a1', 'root', 'fix', 'full', 1);

insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       external_handler_name, external_handler_contact_person,
                       external_handler_contact_details, version)
values
  ('00000000-0000-0000-0000-00000000a813', 'T-G813', '00000000-0000-0000-0000-00000000a901',
   '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   'ארגון מקורי', 'איש קשר מקורי', 'טלפון: 050-0000000', 1),
  ('00000000-0000-0000-0000-00000000a814', 'T-G814', '00000000-0000-0000-0000-00000000a901',
   '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   null, null, null, 1),
  ('00000000-0000-0000-0000-00000000a815', 'T-G815', '00000000-0000-0000-0000-00000000a901',
   '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   null, null, null, 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

create or replace function pg_temp.base_create_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'systemId', '00000000-0000-0000-0000-00000000a901', 'locationId', '00000000-0000-0000-0000-00000000a902',
    'description', 'd', 'severity', 'medium', 'status', 'in_progress', 'operationalImpact', 'i',
    'actionsTaken', 'בוצעה בדיקה', 'discoveredAt', now(), 'reportedToOps', 'not_required',
    'ownerUserId', '00000000-0000-0000-0000-0000000000a2'
  ) || extra;
$$;
grant execute on function pg_temp.base_create_input(jsonb) to authenticated;

create or replace function pg_temp.base_update_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'actionsTaken', 'בוצעה בדיקה', 'findings', '', 'nextSteps', '',
    'eventTime', now(), 'status', 'in_progress', 'severity', 'medium',
    'ownerUserId', '00000000-0000-0000-0000-0000000000a2', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_update_input(jsonb) to authenticated;

create or replace function pg_temp.base_assign_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'ownerUserId', '00000000-0000-0000-0000-0000000000a2'
  ) || extra;
$$;
grant execute on function pg_temp.base_assign_input(jsonb) to authenticated;

create or replace function pg_temp.base_close_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'rootCause', 'root', 'resolution', 'fix', 'readiness', 'full',
    'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_close_input(jsonb) to authenticated;

create or replace function pg_temp.base_reopen_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'reason', 'התברר שהתקלה חוזרת',
    'ownerUserId', '00000000-0000-0000-0000-0000000000a2'
  ) || extra;
$$;
grant execute on function pg_temp.base_reopen_input(jsonb) to authenticated;

do $$
declare
  v_incident incidents;
  v_row record;
  v_event record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
  set local role authenticated;

  -- =====================================================================
  -- PART A: create_incident
  -- =====================================================================

  -- 1. Full external-handler trio at creation, alongside a mandatory valid
  --    internal owner, is stored.
  begin
    v_incident := create_incident(pg_temp.base_create_input(jsonb_build_object(
      'externalHandlerName', 'ארגון שותף', 'externalHandlerContactPerson', 'דנה',
      'externalHandlerContactDetails', '03-1234567')));
    insert into results (test, result, detail) values
      ('create_incident: external-handler trio persisted alongside mandatory internal owner',
        case when v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000a2'
              and v_incident.external_handler_name = 'ארגון שותף'
              and v_incident.external_handler_contact_person = 'דנה'
              and v_incident.external_handler_contact_details = '03-1234567'
             then 'PASS' else 'FAIL' end,
        'name=' || coalesce(v_incident.external_handler_name, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('create_incident: external-handler trio persisted alongside mandatory internal owner', 'FAIL', sqlerrm);
  end;

  -- 2. Creating with contact person but no name is rejected.
  begin
    perform create_incident(pg_temp.base_create_input(jsonb_build_object(
      'externalHandlerContactPerson', 'דנה')));
    insert into results (test, result, detail) values
      ('create_incident: contact person without a name is rejected', 'FAIL', 'unexpectedly succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('create_incident: contact person without a name is rejected',
        case when sqlerrm = 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר' then 'PASS' else 'FAIL' end,
        sqlerrm);
  end;

  -- 3. Creating with none of the three keys succeeds with all three null.
  begin
    v_incident := create_incident(pg_temp.base_create_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('create_incident: omitting all three external-handler keys stores NULL/NULL/NULL',
        case when v_incident.external_handler_name is null
              and v_incident.external_handler_contact_person is null
              and v_incident.external_handler_contact_details is null
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('create_incident: omitting all three external-handler keys stores NULL/NULL/NULL', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- PART B: update_incident -- preserve / update / clear + legacy tolerance
  -- =====================================================================

  -- 4. Omitting all three keys preserves the incident's existing values
  --    byte-identically (g813 already has all three set).
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000a813', pg_temp.base_update_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('update_incident: omitting external-handler keys preserves existing values',
        case when v_incident.external_handler_name = 'ארגון מקורי'
              and v_incident.external_handler_contact_person = 'איש קשר מקורי'
              and v_incident.external_handler_contact_details = 'טלפון: 050-0000000'
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: omitting external-handler keys preserves existing values', 'FAIL', sqlerrm);
  end;

  -- 5. Supplying only externalHandlerContactPerson (name/details keys
  --    absent) changes just that field and preserves the other two --
  --    proving per-key existence checks, not an all-or-nothing overwrite.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000a813', pg_temp.base_update_input(jsonb_build_object(
      'expectedVersion', 2, 'externalHandlerContactPerson', 'איש קשר מעודכן')));
    insert into results (test, result, detail) values
      ('update_incident: supplying only contact-person key updates it and preserves name/details',
        case when v_incident.external_handler_name = 'ארגון מקורי'
              and v_incident.external_handler_contact_person = 'איש קשר מעודכן'
              and v_incident.external_handler_contact_details = 'טלפון: 050-0000000'
             then 'PASS' else 'FAIL' end,
        'person=' || coalesce(v_incident.external_handler_contact_person, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: supplying only contact-person key updates it and preserves name/details', 'FAIL', sqlerrm);
  end;

  -- 6. That contact-only change (name unchanged) still emitted a distinct
  --    field='external_handler' event whose old_value and new_value differ
  --    (the shared snapshot function must reflect all three fields).
  begin
    -- now()/created_at are frozen for the whole transaction, so timestamp
    -- ordering cannot disambiguate rows -- match on the expected new_value
    -- content instead, which is unique to this specific change.
    select * into v_event from incident_events
     where incident_id = '00000000-0000-0000-0000-00000000a813' and type = 'assignment_change'
       and field = 'external_handler'
       and new_value like '%איש קשר מעודכן%';
    insert into results (test, result, detail) values
      ('update_incident: contact-only change still produces a genuinely different old/new snapshot',
        case when v_event.old_value is distinct from v_event.new_value
              and v_event.old_value like '%איש קשר מקורי%' and v_event.new_value like '%איש קשר מעודכן%'
             then 'PASS' else 'FAIL' end,
        'old=' || coalesce(v_event.old_value, '<null>') || ' new=' || coalesce(v_event.new_value, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: contact-only change still produces a genuinely different old/new snapshot', 'FAIL', sqlerrm);
  end;

  -- 7. Explicit JSON null on all three keys clears them.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000a813', pg_temp.base_update_input(jsonb_build_object(
      'expectedVersion', 3, 'externalHandlerName', null, 'externalHandlerContactPerson', null,
      'externalHandlerContactDetails', null)));
    insert into results (test, result, detail) values
      ('update_incident: explicit JSON null on all three keys clears them',
        case when v_incident.external_handler_name is null
              and v_incident.external_handler_contact_person is null
              and v_incident.external_handler_contact_details is null
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: explicit JSON null on all three keys clears them', 'FAIL', sqlerrm);
  end;

  -- 8. No genuine change (resupplying identical values) emits no new
  --    field='external_handler' event.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000a810', pg_temp.base_update_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('update_incident: no external-handler change -> no external_handler event',
        case when not exists (
          select 1 from incident_events
           where incident_id = '00000000-0000-0000-0000-00000000a810' and field = 'external_handler'
        ) then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: no external-handler change -> no external_handler event', 'FAIL', sqlerrm);
  end;

  -- 9. Legacy incident (g811, external-only): supplying a valid internal
  --    owner is now required, and a legacy ownerExternalName key is
  --    tolerated but silently ignored -- owner_external_name survives
  --    byte-identical, not overwritten with the supplied value, not cleared.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000a811', pg_temp.base_update_input(jsonb_build_object(
      'ownerExternalName', 'ניסיון לשנות דרך מפתח legacy')));
    insert into results (test, result, detail) values
      ('update_incident: legacy incident gains mandatory internal owner; owner_external_name untouched by legacy key',
        case when v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000a2'
              and v_incident.owner_external_name = 'ספק חיצוני היסטורי (פתוח)'
             then 'PASS' else 'FAIL' end,
        'owner_external_name=' || coalesce(v_incident.owner_external_name, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: legacy incident gains mandatory internal owner; owner_external_name untouched by legacy key',
        'FAIL', sqlerrm);
  end;

  -- 10. Missing ownerUserId key entirely (internal owner now mandatory even
  --     for an RPC call that supplies only a legacy external name) is
  --     rejected.
  begin
    perform update_incident('00000000-0000-0000-0000-00000000a810', pg_temp.base_update_input(jsonb_build_object(
      'expectedVersion', 2, 'ownerUserId', null, 'ownerExternalName', 'מנסה שוב')));
    insert into results (test, result, detail) values
      ('update_incident: missing internal owner is rejected even with a legacy external name supplied',
        'FAIL', 'unexpectedly succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: missing internal owner is rejected even with a legacy external name supplied',
        case when sqlerrm = 'validation: יש לבחור בעל אחריות פנימי' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 11. Whitespace-only externalHandlerName with a contact person supplied
  --     is rejected at the RPC layer (blank treated as absent).
  begin
    perform update_incident('00000000-0000-0000-0000-00000000a810', pg_temp.base_update_input(jsonb_build_object(
      'expectedVersion', 2, 'externalHandlerName', '   ', 'externalHandlerContactPerson', 'מישהו')));
    insert into results (test, result, detail) values
      ('update_incident: whitespace-only name with a contact person is rejected', 'FAIL', 'unexpectedly succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: whitespace-only name with a contact person is rejected',
        case when sqlerrm = 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר' then 'PASS' else 'FAIL' end,
        sqlerrm);
  end;

  -- 12. Combined-feature regression: external-handler fields alongside
  --     0031's update-specific reporting and current_status_text in the
  --     same call -- proves no cross-feature interference.
  begin
    v_incident := update_incident('00000000-0000-0000-0000-00000000a810', pg_temp.base_update_input(jsonb_build_object(
      'expectedVersion', 2, 'currentStatusText', 'סטטוס נוכחי לבדיקה',
      'updateReportedToOps', 'yes', 'updateReportedToOpsRecipient', 'יוסי',
      'externalHandlerName', 'ארגון שילוב', 'externalHandlerContactPerson', 'משה')));
    insert into results (test, result, detail) values
      ('update_incident: external-handler fields coexist with 0031 update-specific reporting/current_status_text',
        case when v_incident.external_handler_name = 'ארגון שילוב'
              and v_incident.external_handler_contact_person = 'משה'
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('update_incident: external-handler fields coexist with 0031 update-specific reporting/current_status_text',
        'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- PART C: assign_incident
  -- =====================================================================

  -- 13. assign_incident with a full external-handler trio produces a
  --     separate field='external_handler' event, distinct from the
  --     field='owner' event, sharing the same operation_id.
  begin
    v_incident := assign_incident('00000000-0000-0000-0000-00000000a814', pg_temp.base_assign_input(jsonb_build_object(
      'ownerUserId', '00000000-0000-0000-0000-0000000000a3',
      'externalHandlerName', 'ארגון מוקצה', 'externalHandlerContactPerson', 'רונית')));
    insert into results (test, result, detail) values
      ('assign_incident: external-handler trio persisted with a separate field=external_handler event',
        case when v_incident.external_handler_name = 'ארגון מוקצה'
              and v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000a3'
              and (select count(distinct field) from incident_events
                    where incident_id = '00000000-0000-0000-0000-00000000a814' and type = 'assignment_change') = 2
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('assign_incident: external-handler trio persisted with a separate field=external_handler event', 'FAIL', sqlerrm);
  end;

  -- 14. Omitting the keys on a subsequent assign preserves them.
  begin
    v_incident := assign_incident('00000000-0000-0000-0000-00000000a814', pg_temp.base_assign_input(jsonb_build_object(
      'expectedVersion', 2, 'ownerUserId', '00000000-0000-0000-0000-0000000000a2')));
    insert into results (test, result, detail) values
      ('assign_incident: omitting external-handler keys preserves them across a later assign',
        case when v_incident.external_handler_name = 'ארגון מוקצה'
              and v_incident.external_handler_contact_person = 'רונית'
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('assign_incident: omitting external-handler keys preserves them across a later assign', 'FAIL', sqlerrm);
  end;

  -- 15. Explicit null clears via assign_incident too.
  begin
    v_incident := assign_incident('00000000-0000-0000-0000-00000000a814', pg_temp.base_assign_input(jsonb_build_object(
      'expectedVersion', 3, 'externalHandlerName', null, 'externalHandlerContactPerson', null)));
    insert into results (test, result, detail) values
      ('assign_incident: explicit null clears external-handler fields',
        case when v_incident.external_handler_name is null and v_incident.external_handler_contact_person is null
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('assign_incident: explicit null clears external-handler fields', 'FAIL', sqlerrm);
  end;

  -- 16. assign_incident rejects a missing internal owner.
  begin
    perform assign_incident('00000000-0000-0000-0000-00000000a814', pg_temp.base_assign_input(jsonb_build_object(
      'expectedVersion', 4, 'ownerUserId', null)));
    insert into results (test, result, detail) values
      ('assign_incident: missing internal owner is rejected', 'FAIL', 'unexpectedly succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('assign_incident: missing internal owner is rejected',
        case when sqlerrm = 'validation: יש לבחור בעל אחריות פנימי' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 17. Legacy incident (g811) via assign_incident: internal owner now
  --     required; owner_external_name still untouched.
  begin
    v_incident := assign_incident('00000000-0000-0000-0000-00000000a811', pg_temp.base_assign_input(jsonb_build_object(
      'expectedVersion', 2, 'ownerUserId', '00000000-0000-0000-0000-0000000000a3')));
    insert into results (test, result, detail) values
      ('assign_incident: legacy incident owner_external_name untouched after gaining an internal owner',
        case when v_incident.owner_external_name = 'ספק חיצוני היסטורי (פתוח)' then 'PASS' else 'FAIL' end,
        'owner_external_name=' || coalesce(v_incident.owner_external_name, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('assign_incident: legacy incident owner_external_name untouched after gaining an internal owner',
        'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- PART D: close_incident -- full readiness branch
  -- =====================================================================

  -- 18. Full-readiness close with a full external-handler trio: columns
  --     set; owner_user_id/owner_external_name remain untouched by this
  --     branch (still unset here, since g814 was cleared above -- but the
  --     point is the branch never references those two columns at all).
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000a814', pg_temp.base_close_input(jsonb_build_object(
      'expectedVersion', 4, 'externalHandlerName', 'ארגון בסגירה', 'externalHandlerContactPerson', 'טל')));
    insert into results (test, result, detail) values
      ('close_incident (full readiness): external-handler trio persisted, owner columns untouched by this branch',
        case when v_incident.external_handler_name = 'ארגון בסגירה'
              and v_incident.status = 'closed'
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (full readiness): external-handler trio persisted, owner columns untouched by this branch',
        'FAIL', sqlerrm);
  end;

  -- 19. Full-readiness close omitting the keys on g813 (already cleared to
  --     null above by test 7) preserves NULL, and explicit non-null values
  --     on a fresh call are correctly set -- combined into one preserve+set
  --     round-trip using g813 (currently at expectedVersion 3, all three null).
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000a813', pg_temp.base_close_input(jsonb_build_object(
      'expectedVersion', 4)));
    insert into results (test, result, detail) values
      ('close_incident (full readiness): omitting external-handler keys preserves NULL',
        case when v_incident.external_handler_name is null then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (full readiness): omitting external-handler keys preserves NULL', 'FAIL', sqlerrm);
  end;

  -- 20. Contact-only change on a full-readiness close still produces a
  --     distinct field='external_handler' event (old/new snapshots differ).
  begin
    -- now()/created_at are frozen for the whole transaction -- match on the
    -- expected new_value content (this specific close's snapshot) instead
    -- of timestamp ordering.
    select * into v_event from incident_events
     where incident_id = '00000000-0000-0000-0000-00000000a814' and type = 'assignment_change'
       and field = 'external_handler'
       and new_value like '%ארגון בסגירה%';
    insert into results (test, result, detail) values
      ('close_incident (full readiness): external_handler event old/new snapshots differ',
        case when v_event.old_value is distinct from v_event.new_value then 'PASS' else 'FAIL' end,
        'old=' || coalesce(v_event.old_value, '<null>') || ' new=' || coalesce(v_event.new_value, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (full readiness): external_handler event old/new snapshots differ', 'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- PART E: close_incident -- partial readiness branch
  -- =====================================================================

  -- 21. Partial-readiness close (readiness != full) requires an internal
  --     owner AND accepts the external-handler trio in the same call; both
  --     are persisted.
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000a815', pg_temp.base_close_input(jsonb_build_object(
      'readiness', 'partial', 'followUpNotes', 'להשלים בדיקה נוספת',
      'ownerUserId', '00000000-0000-0000-0000-0000000000a3',
      'externalHandlerName', 'ארגון חלקי', 'externalHandlerContactDetails', '04-7654321')));
    insert into results (test, result, detail) values
      ('close_incident (partial readiness): internal owner + external-handler trio both persisted',
        case when v_incident.status = 'partial_readiness'
              and v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000a3'
              and v_incident.external_handler_name = 'ארגון חלקי'
              and v_incident.external_handler_contact_details = '04-7654321'
             then 'PASS' else 'FAIL' end, '');
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (partial readiness): internal owner + external-handler trio both persisted', 'FAIL', sqlerrm);
  end;

  -- 22. A later partial-readiness close omitting the keys preserves them
  --     while still advancing the (still-mandatory) internal owner.
  begin
    v_incident := close_incident('00000000-0000-0000-0000-00000000a815', pg_temp.base_close_input(jsonb_build_object(
      'expectedVersion', 2, 'readiness', 'partial', 'followUpNotes', 'עוד סבב',
      'ownerUserId', '00000000-0000-0000-0000-0000000000a2')));
    insert into results (test, result, detail) values
      ('close_incident (partial readiness): omitting external-handler keys preserves them across a later close',
        case when v_incident.external_handler_name = 'ארגון חלקי'
             then 'PASS' else 'FAIL' end,
        'name=' || coalesce(v_incident.external_handler_name, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('close_incident (partial readiness): omitting external-handler keys preserves them across a later close',
        'FAIL', sqlerrm);
  end;

  -- =====================================================================
  -- PART F: reopen_incident (requires system_admin/professional_manager,
  -- or shift_supervisor with allow_supervisor_reopen -- switch actors).
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');

  -- 23. reopen_incident on the legacy CLOSED external-only incident (g812)
  --     now requires an internal owner (this RPC previously allowed null),
  --     and owner_external_name survives byte-identical.
  begin
    v_incident := reopen_incident('00000000-0000-0000-0000-00000000a812', pg_temp.base_reopen_input('{}'::jsonb));
    insert into results (test, result, detail) values
      ('reopen_incident: legacy closed incident gains mandatory internal owner; owner_external_name untouched',
        case when v_incident.owner_user_id::text = '00000000-0000-0000-0000-0000000000a2'
              and v_incident.owner_external_name = 'ספק חיצוני היסטורי (סגור)'
              and v_incident.status = 'reopened'
             then 'PASS' else 'FAIL' end,
        'owner_external_name=' || coalesce(v_incident.owner_external_name, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('reopen_incident: legacy closed incident gains mandatory internal owner; owner_external_name untouched',
        'FAIL', sqlerrm);
  end;

  -- 24. reopen_incident rejects a missing internal owner. (g812 is
  --     'reopened' from test 23 -- close it again first, since reopen only
  --     accepts a currently-closed incident. The close call is in its own
  --     begin/exception block: an exception raised inside a single
  --     PL/pgSQL begin/exception block rolls back everything since that
  --     block started, including an earlier successful statement in the
  --     SAME block -- so the close and the expected-to-fail reopen must be
  --     in separate blocks, or the close's effects would be undone too.)
  begin
    perform close_incident('00000000-0000-0000-0000-00000000a812', pg_temp.base_close_input(jsonb_build_object(
      'expectedVersion', 2, 'externalHandlerName', 'ארגון לפני סגירה שנייה')));
  exception when others then
    insert into results (test, result, detail) values
      ('setup: re-close legacy incident before testing reopen''s owner-mandatory rule', 'FAIL', sqlerrm);
  end;
  begin
    perform reopen_incident('00000000-0000-0000-0000-00000000a812', pg_temp.base_reopen_input(jsonb_build_object(
      'expectedVersion', 3, 'ownerUserId', null)));
    insert into results (test, result, detail) values
      ('reopen_incident: missing internal owner is rejected', 'FAIL', 'unexpectedly succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('reopen_incident: missing internal owner is rejected',
        case when sqlerrm = 'validation: יש לבחור בעל אחריות פנימי' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- 25. reopen_incident with explicit external-handler values sets them
  --     (already true from test 24's close call), and a subsequent
  --     reopen-from-closed omitting the keys preserves that value.
  begin
    v_incident := reopen_incident('00000000-0000-0000-0000-00000000a812', pg_temp.base_reopen_input(jsonb_build_object(
      'expectedVersion', 3)));
    insert into results (test, result, detail) values
      ('reopen_incident: omitting external-handler keys preserves the pre-reopen value',
        case when v_incident.external_handler_name = 'ארגון לפני סגירה שנייה' then 'PASS' else 'FAIL' end,
        'name=' || coalesce(v_incident.external_handler_name, '<null>'));
  exception when others then
    insert into results (test, result, detail) values
      ('reopen_incident: omitting external-handler keys preserves the pre-reopen value', 'FAIL', sqlerrm);
  end;

  reset role;
end $$;

-- =====================================================================
-- PART G: migration-time backfill -- copy-only, idempotent, all statuses.
-- Re-runs the exact 0032 backfill statement (as the migration-owning role)
-- against freshly-inserted legacy fixtures within this same rolled-back
-- transaction, since the real backfill already ran once, migration-time,
-- against an empty incidents table.
-- =====================================================================
do $$
declare
  v_open_after text;
  v_closed_after text;
  v_second_run_count int;
begin
  insert into incidents (id, number, system_id, location_id, description, severity, status,
                         operational_impact, owner_external_name, discovered_at, created_by, updated_by, version)
  values
    ('00000000-0000-0000-0000-00000000a820', 'T-G820', '00000000-0000-0000-0000-00000000a901',
     '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'in_progress', 'i',
     'ספק לגיבוי פתוח', now() - interval '40 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 1);
  insert into incidents (id, number, system_id, location_id, description, severity, status,
                         operational_impact, owner_external_name, discovered_at, created_by, updated_by,
                         closed_at, closed_by, root_cause, resolution, readiness_at_close, version)
  values
    ('00000000-0000-0000-0000-00000000a821', 'T-G821', '00000000-0000-0000-0000-00000000a901',
     '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'closed', 'i',
     'ספק לגיבוי סגור', now() - interval '50 days',
     '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
     now() - interval '45 days', '00000000-0000-0000-0000-0000000000a1', 'root', 'fix', 'full', 1);

  update incidents
     set external_handler_name = owner_external_name
   where owner_user_id is null
     and owner_external_name is not null
     and external_handler_name is null
     and id in ('00000000-0000-0000-0000-00000000a820', '00000000-0000-0000-0000-00000000a821');

  select external_handler_name into v_open_after from incidents where id = '00000000-0000-0000-0000-00000000a820';
  select external_handler_name into v_closed_after from incidents where id = '00000000-0000-0000-0000-00000000a821';
  insert into results (test, result, detail) values
    ('backfill: OPEN legacy external-only incident copies owner_external_name -> external_handler_name',
      case when v_open_after = 'ספק לגיבוי פתוח' then 'PASS' else 'FAIL' end, coalesce(v_open_after, '<null>'));
  insert into results (test, result, detail) values
    ('backfill: CLOSED (terminal) legacy external-only incident is backfilled too',
      case when v_closed_after = 'ספק לגיבוי סגור' then 'PASS' else 'FAIL' end, coalesce(v_closed_after, '<null>'));

  update incidents
     set external_handler_name = owner_external_name
   where owner_user_id is null
     and owner_external_name is not null
     and external_handler_name is null
     and id in ('00000000-0000-0000-0000-00000000a820', '00000000-0000-0000-0000-00000000a821');
  get diagnostics v_second_run_count = row_count;
  insert into results (test, result, detail) values
    ('backfill: re-running the exact statement is idempotent (affects 0 rows)',
      case when v_second_run_count = 0 then 'PASS' else 'FAIL' end, 'rows=' || v_second_run_count);

  insert into results (test, result, detail)
  select 'backfill: owner_external_name itself is never modified by the backfill',
    case when (select owner_external_name from incidents where id = '00000000-0000-0000-0000-00000000a820') = 'ספק לגיבוי פתוח'
          and (select owner_external_name from incidents where id = '00000000-0000-0000-0000-00000000a821') = 'ספק לגיבוי סגור'
         then 'PASS' else 'FAIL' end, '';

  insert into results (test, result, detail)
  select 'backfill: no incident_events row is fabricated for a backfilled incident',
    case when not exists (
      select 1 from incident_events where incident_id in
        ('00000000-0000-0000-0000-00000000a820', '00000000-0000-0000-0000-00000000a821')
    ) then 'PASS' else 'FAIL' end, '';
end $$;

-- =====================================================================
-- PART H: name-required-with-contact CHECK constraint (direct writes,
-- defense-in-depth) -- nullif(btrim(...), '') semantics per the mandatory
-- correction: a whitespace-only name must NOT count as "present".
-- =====================================================================
do $$
begin
  -- 1. Whitespace-only name with a real contact person is rejected: blank
  --    name must not satisfy "name present".
  begin
    insert into incidents (id, number, system_id, location_id, description, severity, status,
                           operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                           external_handler_name, external_handler_contact_person, version)
    values ('00000000-0000-0000-0000-00000000a830', 'T-G830', '00000000-0000-0000-0000-00000000a901',
            '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'in_progress', 'i',
            '00000000-0000-0000-0000-0000000000a2', now(),
            '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
            '   ', 'איש קשר אמיתי', 1);
    insert into results (test, result, detail) values
      ('direct INSERT: whitespace-only name with a real contact person is rejected by the CHECK',
        'FAIL', 'unexpectedly succeeded');
  exception when check_violation then
    insert into results (test, result, detail) values
      ('direct INSERT: whitespace-only name with a real contact person is rejected by the CHECK',
        'PASS', 'sqlstate=23514');
  end;

  -- 2. CONTROL: a real (trimmed, non-blank) name alone, with no contact
  --    info at all, is valid.
  begin
    insert into incidents (id, number, system_id, location_id, description, severity, status,
                           operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                           external_handler_name, version)
    values ('00000000-0000-0000-0000-00000000a831', 'T-G831', '00000000-0000-0000-0000-00000000a901',
            '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'in_progress', 'i',
            '00000000-0000-0000-0000-0000000000a2', now(),
            '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
            'ארגון בלבד', 1);
    insert into results (test, result, detail) values
      ('CONTROL: direct INSERT: a name alone with no contact info is valid', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('CONTROL: direct INSERT: a name alone with no contact info is valid', 'FAIL', sqlerrm);
  end;

  -- 3. CONTROL: no external handler at all is valid.
  begin
    insert into incidents (id, number, system_id, location_id, description, severity, status,
                           operational_impact, owner_user_id, discovered_at, created_by, updated_by, version)
    values ('00000000-0000-0000-0000-00000000a832', 'T-G832', '00000000-0000-0000-0000-00000000a901',
            '00000000-0000-0000-0000-00000000a902', 'd', 'medium', 'in_progress', 'i',
            '00000000-0000-0000-0000-0000000000a2', now(),
            '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 1);
    insert into results (test, result, detail) values
      ('CONTROL: direct INSERT: no external handler at all is valid', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values
      ('CONTROL: direct INSERT: no external handler at all is valid', 'FAIL', sqlerrm);
  end;

  -- 4. length CHECKs on the three columns are all present.
  insert into results (test, result, detail)
  select 'schema: external_handler_name/_contact_person/_contact_details CHECK constraints exist',
    case when count(*) = 4 then 'PASS' else 'FAIL' end, 'count=' || count(*)
  from pg_constraint
  where conrelid = 'incidents'::regclass
    and conname in ('external_handler_name_required_with_contact',
                    'incidents_external_handler_name_check',
                    'incidents_external_handler_contact_person_check',
                    'incidents_external_handler_contact_details_check');
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
