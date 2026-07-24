-- מעקב תקלות — forward migration.
-- Active-profile enforcement hardening: closes the three verified gaps
-- through which a DEACTIVATED (or never-provisioned) authenticated
-- identity could still read or write protected data. Deactivation
-- (profiles.active = false) is authorization revocation and must block
-- EVERY read and EVERY write on the very next statement -- these were the
-- only paths that did not re-check it:
--
--   1. accept_handover (0002) authorized by target identity alone
--      (to_user_id = auth.uid()) with no active-profile check, so a
--      deactivated incoming supervisor could still accept a pending
--      handover -- a state mutation plus event/audit writes.
--   2. add_incident_correction (0002) allowed `is_operational_role() OR
--      author-of-the-referenced-record`. The author branch never checked
--      activeness, so a deactivated past author could still append
--      correction events to incident timelines.
--   3. notifications RLS (0003) used `user_id = auth.uid()` alone for both
--      SELECT and UPDATE. A deactivated user could still read their
--      notifications -- whose text carries incident numbers and assignment
--      information -- and write read-state changes.
--
-- Every other read policy already requires is_active_member(), and every
-- other RPC's first check goes through my_role()/is_operational_role(),
-- which return NULL/false for inactive profiles. This migration brings
-- the last three paths in line; it changes NOTHING for active users.
--
-- The two function bodies below are the 0002 definitions verbatim except
-- for the added activeness checks (same names, signatures, grants --
-- CREATE OR REPLACE preserves existing grants; same search_path = public
-- style as every other 0002 function so the diff stays reviewable).
--
-- 0001-0010 are untouched. This is an ADDITIVE migration.

-- ===== 1. accept_handover: the target must still be an active member =====
create or replace function accept_handover(p_handover_id uuid) returns handovers
language plpgsql security definer set search_path = public as $$
declare
  v handovers;
  r record;
begin
  -- Deactivation revokes authorization: being the addressed target is not
  -- enough -- the caller must still hold an ACTIVE profile right now.
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
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

-- ===== 2. add_incident_correction: authorship no longer bypasses activeness =====
create or replace function add_incident_correction(p_incident_id uuid, p_input jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_number text;
  v_ref uuid := (p_input->>'refId')::uuid;
  v_is_author boolean;
begin
  -- An inactive profile may not write anything, however it qualified
  -- before deactivation. Checked FIRST, before any authorship lookup.
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
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

-- ===== 3. notifications RLS: reads and writes require an active profile =====
-- Ownership alone no longer suffices; a deactivated user can neither read
-- notification content (which names incidents and assignments) nor flip
-- read-state. Rows are retained untouched -- reactivation restores access
-- to the same notifications.
drop policy notifications_select_own on notifications;
create policy notifications_select_own on notifications for select
  using (user_id = auth.uid() and is_active_member());

drop policy notifications_mark_read on notifications;
create policy notifications_mark_read on notifications for update
  using (user_id = auth.uid() and is_active_member())
  with check (user_id = auth.uid() and is_active_member());
