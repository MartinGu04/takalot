-- AVARIA — system-wide audit log completion.
--
-- The append-only audit_logs table, its immutability trigger, and the
-- write_audit() helper already exist (0001/0002) and are already called
-- from essentially every state-changing RPC. This migration:
--
--   1. Extends audit_logs with the fields the product's audit-log page
--      needs to render a useful entry without a live join to profiles/
--      incidents that could later be renamed, reassigned, or deleted:
--      an ACTOR SNAPSHOT (display name + email, captured at write time,
--      independent of the profile's current state), a human-readable
--      ENTITY LABEL, an optional free-text SUMMARY, and optional
--      structured METADATA. before_data/after_data are unchanged --
--      still field-level diffs, never full-row snapshots, per action.
--   2. Widens read access: professional_manager gains parity with
--      system_admin (both, and only both, may read the audit log through
--      the application-facing database interface -- previously
--      professional_manager was restricted to a subset of entity types,
--      which does not match the product requirement).
--   3. Adds list_audit_events(): the bounded, paginated, filtered read
--      RPC the audit-log page calls -- server-side LIMIT/OFFSET (hard-
--      capped, never client-trusted), date range / actor / entity type /
--      action filters, and an optional label/number/summary search, with
--      a windowed total_count for pagination. Its own role check is a
--      second, independent enforcement layer on top of the RLS policy in
--      section 2 (RLS is bypassed inside SECURITY DEFINER execution, so
--      the RPC's own check is the one actually gating this path).
--   4. Locks down write_audit() itself: an explicit PUBLIC/anon/
--      authenticated EXECUTE revoke, matching this repository's established
--      convention for internal-only helpers (require_reference_data_admin,
--      assert_active_profile_if_set, valid_system_category, ...). Every
--      existing RPC keeps calling it exactly as before -- SECURITY DEFINER
--      execution runs as the function owner, which never needs its own
--      grant -- so no caller-facing behavior changes, but a client can no
--      longer invoke it directly to forge an audit row (the actor column
--      was already un-spoofable, being auth.uid() itself, but the rest of
--      the row was not).
--   5. Fills specific, previously-missing audit coverage called for by the
--      product spec: a dedicated "structured status changed" event and a
--      dedicated "external responsibility changed" event on the incident
--      lifecycle RPCs (previously only visible generically inside
--      incident_updated / the incident_events Timeline, never as their own
--      audit action), and de-noises update_incident's generic
--      'incident_updated' event so a submission that changes no material
--      field (owner/severity/status/external handler already have their
--      own dedicated events; only operational_impact and next_update_due
--      remain "other material fields") no longer writes an audit row at
--      all. A no-op resubmission, or one that only adds treatment-update
--      content, correctly produces zero audit_logs rows from this
--      function, exactly as it always has for content-only submissions
--      that change nothing on the incidents row.
--   6. Adds entity_label (and, where a free-text reason already exists,
--      summary) to the personnel, reference-data, and incident RPCs this
--      product spec calls out by name, so the audit-log page never has to
--      show a bare UUID for "which user" / "which system" / "which
--      incident".
--
-- Every function below keeps its EXISTING signature (same parameter
-- types), so `create or replace function` replaces it in place -- no new
-- overload, no grant to re-establish. write_audit() is the one exception:
-- it gains three new trailing DEFAULT NULL parameters, which DOES change
-- its signature (parameter type list), so the old 6-parameter overload is
-- explicitly dropped first -- otherwise it would keep being preferred by
-- every existing 3-to-6-argument call site (exact arity match beats a
-- shorter-arity call against a longer signature with defaults), silently
-- keeping every caller on the old, snapshot-less version.
--
-- Explicit transaction, same reasoning as 0024/0035/0041: the repository's
-- psql -f runner uses autocommit, so this keeps a manual/Supabase
-- application all-or-nothing.

begin;

-- =====================================================================
-- 1. audit_logs: actor snapshot, entity label, summary, metadata.
--    All nullable: historical rows (written before this migration) keep
--    these columns null, which is correct -- there is no historical
--    snapshot to backfill. Field-level diffs (before_data/after_data)
--    are unaffected.
-- =====================================================================
alter table public.audit_logs
  add column actor_display_name text,
  add column actor_email text,
  add column entity_label text,
  add column summary text,
  add column metadata jsonb;

comment on column public.audit_logs.actor_display_name is
  'Snapshot of the acting profile''s full_name at write time -- independent of later renames.';
comment on column public.audit_logs.actor_email is
  'Snapshot of the acting auth user''s email at write time, where available.';
comment on column public.audit_logs.entity_label is
  'Human-readable label for entity_id (a name, a full name, an incident number, ...), where useful.';
comment on column public.audit_logs.summary is
  'Optional free-text summary for actions whose relevant detail is not just a field diff (e.g. a cancellation reason).';
comment on column public.audit_logs.metadata is
  'Optional structured context beyond before/after (e.g. a readiness level, a policy flag).';

-- Supported filters (entity type, action) and the read RPC's ORDER BY
-- (created_at desc, already indexed) all get their own index; actor_id and
-- incident_number were already indexed in 0001.
create index idx_audit_logs_entity_type on public.audit_logs (entity_type);
create index idx_audit_logs_action on public.audit_logs (action);

-- Belt-and-suspenders with RLS (which already default-denies insert/update/
-- delete, since there is a SELECT policy but none for the other commands):
-- an explicit table-privilege revoke, matching this repository's own
-- convention for systems/locations (0024). Without this, an UPDATE/DELETE
-- whose WHERE clause matches no RLS-visible row silently affects zero rows
-- instead of raising -- a REVOKE turns that into a hard, unambiguous
-- permission error regardless of which rows a statement targets.
revoke insert, update, delete on table public.audit_logs from public, anon, authenticated;

-- =====================================================================
-- 2. RLS: professional_manager reaches parity with system_admin. Only
--    these two roles may read the audit log through the application-
--    facing database interface -- every other role (including
--    shift_supervisor, which is operationally adjacent to
--    professional_manager everywhere else) is excluded, matching the
--    product's explicit role list. Insert/update/delete stay policy-free
--    (default-deny under RLS) and the reject_mutation trigger (0001)
--    remains the unconditional backstop for update/delete regardless.
-- =====================================================================
drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select using (
  public.my_role() in ('system_admin', 'professional_manager')
);

-- =====================================================================
-- 3. write_audit(): actor snapshot + entity label / summary / metadata.
--    Still a single INSERT ... VALUES (never INSERT ... SELECT ... WHERE),
--    so it always inserts exactly one row regardless of whether the actor
--    snapshot sub-selects find a match -- a missing profile/auth user
--    yields null snapshot columns, never a silently-dropped audit row. Any
--    genuine failure (e.g. a constraint violation) raises normally and
--    aborts the CALLING RPC's transaction along with it, so a failed audit
--    write can never leave a mutation's other effects committed.
-- =====================================================================
drop function if exists public.write_audit(text, text, text, text, jsonb, jsonb);

create function public.write_audit(
  p_action text, p_entity_type text, p_entity_id text,
  p_incident_number text default null,
  p_before jsonb default null, p_after jsonb default null,
  p_entity_label text default null,
  p_summary text default null,
  p_metadata jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (
    actor_id, actor_display_name, actor_email, action, entity_type, entity_id,
    incident_number, entity_label, summary, before_data, after_data, metadata, correlation_id
  ) values (
    auth.uid(),
    (select full_name from profiles where id = auth.uid()),
    (select email from auth.users where id = auth.uid()),
    p_action, p_entity_type, p_entity_id, p_incident_number,
    coalesce(p_entity_label, p_incident_number),
    p_summary, p_before, p_after, p_metadata,
    substring(gen_random_uuid()::text, 1, 8)
  );
end;
$$;

-- Internal helper only -- never callable directly by a client. Every
-- existing and new caller is another SECURITY DEFINER function's body,
-- which runs as the function OWNER (not the invoking client's role) and so
-- needs no EXECUTE grant of its own. This is what makes "authenticated
-- clients cannot insert audit events, or choose their own actor" true: the
-- ONLY path to an audit_logs row is this function, and this function is
-- unreachable from outside a trusted RPC body.
revoke execute on function public.write_audit(text, text, text, text, jsonb, jsonb, text, text, jsonb)
  from public, anon, authenticated;

-- =====================================================================
-- 4. list_audit_events(): the bounded, paginated, filtered read path.
--    p_limit is hard-clamped server-side (1..100) regardless of what a
--    client requests -- "server-side pagination, no unbounded history
--    fetches" is enforced here, not merely defaulted in the UI. Its own
--    role check is the real gate (SECURITY DEFINER execution runs as the
--    function owner and does not go through RLS), independent of, and in
--    addition to, the audit_select policy in section 2.
-- =====================================================================
create or replace function public.list_audit_events(
  p_limit int default 25,
  p_offset int default 0,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_actor_id uuid default null,
  p_entity_type text default null,
  p_action text default null,
  p_search text default null
) returns table (
  id uuid,
  created_at timestamptz,
  actor_id uuid,
  actor_display_name text,
  actor_email text,
  action text,
  entity_type text,
  entity_id text,
  entity_label text,
  incident_number text,
  summary text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb,
  total_count bigint
)
language plpgsql security definer set search_path = public as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if public.my_role() not in ('system_admin', 'professional_manager') then
    raise exception 'permission: אין הרשאה לצפות ביומן הביקורת';
  end if;

  return query
  select
    a.id, a.created_at, a.actor_id, a.actor_display_name, a.actor_email,
    a.action, a.entity_type, a.entity_id, a.entity_label, a.incident_number,
    a.summary, a.before_data, a.after_data, a.metadata,
    count(*) over ()::bigint as total_count
  from audit_logs a
  where (p_from is null or a.created_at >= p_from)
    and (p_to is null or a.created_at <= p_to)
    and (p_actor_id is null or a.actor_id = p_actor_id)
    and (p_entity_type is null or a.entity_type = p_entity_type)
    and (p_action is null or a.action = p_action)
    and (
      v_search is null
      or a.entity_label ilike '%' || v_search || '%'
      or a.incident_number ilike '%' || v_search || '%'
      or a.summary ilike '%' || v_search || '%'
    )
  order by a.created_at desc, a.id desc
  limit v_limit offset v_offset;
end;
$$;

revoke execute on function public.list_audit_events(int, int, timestamptz, timestamptz, uuid, text, text, text)
  from public, anon;
grant execute on function public.list_audit_events(int, int, timestamptz, timestamptz, uuid, text, text, text)
  to authenticated;

-- =====================================================================
-- 5. Personnel RPCs: entity_label (the target's full name) added to the
--    existing write_audit calls. No behavior, permission, or return-value
--    change -- signatures are identical, bodies otherwise byte-for-byte
--    the same as their current (0012/0017/0034/0002) definitions.
-- =====================================================================
create or replace function public.admin_set_user_role(p_user_id uuid, p_role public.app_role) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles;
  v_active_admins int;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן לשנות את התפקיד של עצמך';
  end if;

  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  if v_target.deleted_at is not null then
    raise exception 'validation: לא ניתן לשנות תפקיד למשתמש שנמחק';
  end if;

  if not public.role_ceiling_allows_manage(v_actor_role, v_target.role)
     or not public.role_ceiling_allows_manage(v_actor_role, p_role) then
    raise exception 'permission: אין הרשאה לנהל משתמש בתפקיד זה';
  end if;

  if v_target.role = 'system_admin' and v_target.active and p_role <> 'system_admin' then
    select count(*) into v_active_admins from public.profiles where role = 'system_admin' and active;
    if v_active_admins <= 1 then
      raise exception 'validation: לא ניתן להוריד בדרגה את מנהל המערכת הפעיל האחרון';
    end if;
  end if;

  update public.profiles set role = p_role where id = p_user_id;
  perform public.write_audit(
    p_action => 'user_role_changed', p_entity_type => 'profile', p_entity_id => p_user_id::text,
    p_before => jsonb_build_object('role', v_target.role), p_after => jsonb_build_object('role', p_role),
    p_entity_label => v_target.full_name
  );
end;
$$;

create or replace function public.admin_set_user_active(p_user_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles;
  v_active_admins int;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן לשנות את הסטטוס של עצמך';
  end if;

  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;

  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  if v_target.deleted_at is not null then
    raise exception 'validation: לא ניתן לשנות סטטוס למשתמש שנמחק';
  end if;

  if not public.role_ceiling_allows_manage(v_actor_role, v_target.role) then
    raise exception 'permission: אין הרשאה לנהל משתמש בתפקיד זה';
  end if;

  if not p_active and v_target.active and exists (
    select 1 from public.incidents where owner_user_id = p_user_id and public.is_incident_open(status)
  ) then
    raise exception 'validation: לא ניתן להשבית משתמש המשמש כגורם מטפל פנימי בתקלה פעילה — יש להעביר את הטיפול לגורם מטפל פנימי אחר לפני ההשבתה';
  end if;

  if not p_active and v_target.role = 'system_admin' and v_target.active then
    select count(*) into v_active_admins from public.profiles where role = 'system_admin' and active;
    if v_active_admins <= 1 then
      raise exception 'validation: לא ניתן להשבית את מנהל המערכת הפעיל האחרון';
    end if;
  end if;

  update public.profiles set active = p_active where id = p_user_id;
  perform public.write_audit(
    p_action => case when p_active then 'user_activated' else 'user_deactivated' end,
    p_entity_type => 'profile', p_entity_id => p_user_id::text,
    p_before => jsonb_build_object('active', v_target.active), p_after => jsonb_build_object('active', p_active),
    p_entity_label => v_target.full_name
  );
end;
$$;

create or replace function public.admin_delete_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles;
  v_active_admins int;
  v_open_incidents int;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'permission: לא ניתן למחוק את עצמך';
  end if;

  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לנהל אנשי צוות';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  if not public.role_ceiling_allows_manage(v_actor_role, v_target.role) then
    raise exception 'permission: אין הרשאה למחוק משתמש בתפקיד זה';
  end if;

  if v_target.deleted_at is not null then
    return;
  end if;

  if v_target.role = 'system_admin' and v_target.active then
    select count(*) into v_active_admins from public.profiles where role = 'system_admin' and active;
    if v_active_admins <= 1 then
      raise exception 'validation: לא ניתן למחוק את מנהל המערכת הפעיל האחרון';
    end if;
  end if;

  select count(*) into v_open_incidents
  from public.incidents where owner_user_id = p_user_id and public.is_incident_open(status);
  if v_open_incidents > 0 then
    raise exception 'validation: יש לשנות גורם מטפל בתקלות פתוחות לפני מחיקת המשתמש';
  end if;

  update public.profiles
    set active = false, deleted_at = now(), deleted_by = auth.uid()
    where id = p_user_id;

  perform public.write_audit(
    p_action => 'user_tombstoned', p_entity_type => 'profile', p_entity_id => p_user_id::text,
    p_before => jsonb_build_object('active', v_target.active),
    p_after => jsonb_build_object('active', false, 'deleted', true),
    p_entity_label => v_target.full_name
  );
end;
$$;

create or replace function public.admin_set_user_name(p_user_id uuid, p_full_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_actor_role public.app_role;
  v_target public.profiles;
  v_name text := trim(coalesce(p_full_name, ''));
  v_is_self boolean;
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה לשנות שם';
  end if;
  v_is_self := (p_user_id = auth.uid());

  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לשנות שם';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  if v_target.deleted_at is not null then
    raise exception 'validation: לא ניתן לשנות שם למשתמש שנמחק';
  end if;

  if v_is_self then
    if v_actor_role not in ('shift_supervisor', 'professional_manager', 'system_admin') then
      raise exception 'permission: אין הרשאה לשנות שם';
    end if;
  else
    if not public.role_ceiling_allows_manage(v_actor_role, v_target.role) then
      raise exception 'permission: אין הרשאה לנהל משתמש בתפקיד זה';
    end if;
  end if;

  if length(v_name) < 2 or length(v_name) > 60 then
    raise exception 'validation: השם חייב להכיל בין 2 ל-60 תווים';
  end if;
  if v_name ~ '[[:cntrl:]]' then
    raise exception 'validation: השם אינו יכול להכיל שורה חדשה או תווי בקרה';
  end if;

  update public.profiles set full_name = v_name where id = p_user_id;
  perform public.write_audit(
    p_action => 'user_renamed', p_entity_type => 'profile', p_entity_id => p_user_id::text,
    p_before => jsonb_build_object('fullName', v_target.full_name), p_after => jsonb_build_object('fullName', v_name),
    p_entity_label => v_name
  );
end;
$$;
revoke execute on function public.admin_set_user_name(uuid, text) from public, anon;
grant execute on function public.admin_set_user_name(uuid, text) to authenticated;

create or replace function public.admin_create_placeholder_profile(p_full_name text, p_role public.app_role)
returns public.placeholder_profiles
language plpgsql security definer set search_path = public as $$
declare
  v public.placeholder_profiles;
begin
  if my_role() is distinct from 'system_admin' then
    raise exception 'permission: רק מנהל מערכת רשאי להזמין משתמשים';
  end if;
  insert into placeholder_profiles (full_name, role) values (trim(p_full_name), p_role) returning * into v;
  perform write_audit(
    p_action => 'user_created', p_entity_type => 'profile', p_entity_id => v.id::text,
    p_after => jsonb_build_object('role', p_role), p_entity_label => v.full_name
  );
  return v;
end;
$$;

-- =====================================================================
-- 6. Systems / locations RPCs: entity_label (the record's name) added to
--    the existing write_audit calls. Signatures, validation, and every
--    other line of logic are otherwise identical to the current
--    (0041/0024) definitions.
-- =====================================================================
create or replace function public.create_system(p_name text, p_category text) returns public.systems
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_category public.system_category;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);
  v_category := public.valid_system_category(p_category);
  lock table public.systems in share row exclusive mode;

  if exists (
    select 1 from public.systems
    where lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  insert into public.systems (name, archived, category, display_order, created_by)
  values (
    v_name,
    false,
    v_category,
    coalesce((select max(display_order) from public.systems where category = v_category), 0) + 1,
    auth.uid()
  )
  returning * into v_system;

  perform public.write_audit(
    p_action => 'system_created', p_entity_type => 'system', p_entity_id => v_system.id::text,
    p_after => to_jsonb(v_system), p_entity_label => v_system.name
  );
  return v_system;
exception
  when unique_violation then
    raise exception 'conflict: כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
end;
$$;

create or replace function public.create_location(p_name text, p_category text) returns public.locations
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_category public.location_category;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);
  v_category := public.valid_location_category(p_category);
  lock table public.locations in share row exclusive mode;

  if exists (
    select 1 from public.locations
    where lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  insert into public.locations (name, archived, category, display_order, created_by)
  values (
    v_name,
    false,
    v_category,
    coalesce((select max(display_order) from public.locations where category = v_category), 0) + 1,
    auth.uid()
  )
  returning * into v_location;

  perform public.write_audit(
    p_action => 'location_created', p_entity_type => 'location', p_entity_id => v_location.id::text,
    p_after => to_jsonb(v_location), p_entity_label => v_location.name
  );
  return v_location;
exception
  when unique_violation then
    raise exception 'conflict: כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
end;
$$;

create or replace function public.rename_system(p_system_id uuid, p_name text) returns public.systems
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_before public.systems;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);

  select * into v_before
  from public.systems
  where id = p_system_id
  for update;
  if not found then
    raise exception 'not_found: המערכת / העמדה לא נמצאה';
  end if;

  if exists (
    select 1
    from public.systems
    where id <> p_system_id
      and lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  if v_before.name = v_name then
    return v_before;
  end if;

  update public.systems
  set name = v_name
  where id = p_system_id
  returning * into v_system;

  perform public.write_audit(
    p_action => 'system_renamed', p_entity_type => 'system', p_entity_id => v_system.id::text,
    p_before => jsonb_build_object('name', v_before.name), p_after => jsonb_build_object('name', v_system.name),
    p_entity_label => v_system.name
  );
  return v_system;
exception
  when unique_violation then
    raise exception 'conflict: כבר קיימת מערכת / עמדה בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
end;
$$;

create or replace function public.rename_location(
  p_location_id uuid,
  p_name text
) returns public.locations
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_before public.locations;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  v_name := public.valid_reference_data_name(p_name);

  select * into v_before
  from public.locations
  where id = p_location_id
  for update;
  if not found then
    raise exception 'not_found: המיקום לא נמצא';
  end if;

  if exists (
    select 1
    from public.locations
    where id <> p_location_id
      and lower(regexp_replace(name, '^\s+|\s+$', '', 'g')) = lower(v_name)
  ) then
    raise exception 'conflict: כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
  end if;

  if v_before.name = v_name then
    return v_before;
  end if;

  update public.locations
  set name = v_name
  where id = p_location_id
  returning * into v_location;

  perform public.write_audit(
    p_action => 'location_renamed', p_entity_type => 'location', p_entity_id => v_location.id::text,
    p_before => jsonb_build_object('name', v_before.name), p_after => jsonb_build_object('name', v_location.name),
    p_entity_label => v_location.name
  );
  return v_location;
exception
  when unique_violation then
    raise exception 'conflict: כבר קיים מיקום בשם זה. אם הפריט אינו פעיל, יש להפעיל מחדש את הפריט הקיים';
end;
$$;

create or replace function public.set_system_active(
  p_system_id uuid,
  p_active boolean
) returns public.systems
language plpgsql security definer set search_path = public as $$
declare
  v_before public.systems;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  if p_active is null then
    raise exception 'validation: יש לציין מצב פעיל או לא פעיל';
  end if;

  select * into v_before
  from public.systems
  where id = p_system_id
  for update;
  if not found then
    raise exception 'not_found: המערכת / העמדה לא נמצאה';
  end if;

  if p_active and exists (
    select 1
    from public.systems
    where id <> p_system_id
      and lower(regexp_replace(name, '^\s+|\s+$', '', 'g'))
        = lower(regexp_replace(v_before.name, '^\s+|\s+$', '', 'g'))
  ) then
    raise exception 'conflict: לא ניתן להפעיל מחדש: השם כבר שמור למערכת / עמדה אחרת';
  end if;

  if v_before.archived = (not p_active) then
    return v_before;
  end if;

  update public.systems
  set archived = (not p_active)
  where id = p_system_id
  returning * into v_system;

  perform public.write_audit(
    p_action => case when p_active then 'system_restored' else 'system_archived' end,
    p_entity_type => 'system', p_entity_id => v_system.id::text,
    p_before => jsonb_build_object('archived', v_before.archived),
    p_after => jsonb_build_object('archived', v_system.archived),
    p_entity_label => v_system.name
  );
  return v_system;
exception
  when unique_violation then
    raise exception 'conflict: לא ניתן להפעיל מחדש: השם כבר שמור למערכת / עמדה אחרת';
end;
$$;

create or replace function public.set_location_active(
  p_location_id uuid,
  p_active boolean
) returns public.locations
language plpgsql security definer set search_path = public as $$
declare
  v_before public.locations;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  if p_active is null then
    raise exception 'validation: יש לציין מצב פעיל או לא פעיל';
  end if;

  select * into v_before
  from public.locations
  where id = p_location_id
  for update;
  if not found then
    raise exception 'not_found: המיקום לא נמצא';
  end if;

  if p_active and exists (
    select 1
    from public.locations
    where id <> p_location_id
      and lower(regexp_replace(name, '^\s+|\s+$', '', 'g'))
        = lower(regexp_replace(v_before.name, '^\s+|\s+$', '', 'g'))
  ) then
    raise exception 'conflict: לא ניתן להפעיל מחדש: השם כבר שמור למיקום אחר';
  end if;

  if v_before.archived = (not p_active) then
    return v_before;
  end if;

  update public.locations
  set archived = (not p_active)
  where id = p_location_id
  returning * into v_location;

  perform public.write_audit(
    p_action => case when p_active then 'location_restored' else 'location_archived' end,
    p_entity_type => 'location', p_entity_id => v_location.id::text,
    p_before => jsonb_build_object('archived', v_before.archived),
    p_after => jsonb_build_object('archived', v_location.archived),
    p_entity_label => v_location.name
  );
  return v_location;
exception
  when unique_violation then
    raise exception 'conflict: לא ניתן להפעיל מחדש: השם כבר שמור למיקום אחר';
end;
$$;

create or replace function public.delete_system(p_system_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_before public.systems;
  v_system public.systems;
begin
  perform public.require_reference_data_admin();
  lock table public.systems in share row exclusive mode;
  select * into v_before
  from public.systems
  where id = p_system_id
  for update;
  if not found then
    raise exception 'not_found: המערכת / העמדה לא נמצאה';
  end if;

  if exists (select 1 from public.incidents where system_id = p_system_id) then
    update public.systems set archived = true
    where id = p_system_id
    returning * into v_system;
    perform public.write_audit(
      p_action => 'system_delete_archived', p_entity_type => 'system', p_entity_id => p_system_id::text,
      p_before => to_jsonb(v_before), p_after => to_jsonb(v_system), p_entity_label => v_before.name
    );
    return 'archived';
  end if;

  begin
    delete from public.systems where id = p_system_id;
  exception
    when foreign_key_violation then
      update public.systems set archived = true
      where id = p_system_id
      returning * into v_system;
      perform public.write_audit(
        p_action => 'system_delete_archived', p_entity_type => 'system', p_entity_id => p_system_id::text,
        p_before => to_jsonb(v_before), p_after => to_jsonb(v_system), p_entity_label => v_before.name
      );
      return 'archived';
  end;

  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.systems
    where category = v_before.category
  )
  update public.systems target
  set display_order = ranked.position
  from ranked
  where target.id = ranked.id
    and target.display_order <> ranked.position;

  perform public.write_audit(
    p_action => 'system_deleted', p_entity_type => 'system', p_entity_id => p_system_id::text,
    p_before => to_jsonb(v_before), p_entity_label => v_before.name
  );
  return 'deleted';
end;
$$;

create or replace function public.delete_location(p_location_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_before public.locations;
  v_location public.locations;
begin
  perform public.require_reference_data_admin();
  lock table public.locations in share row exclusive mode;
  select * into v_before
  from public.locations
  where id = p_location_id
  for update;
  if not found then
    raise exception 'not_found: המיקום לא נמצא';
  end if;

  if exists (select 1 from public.incidents where location_id = p_location_id) then
    update public.locations set archived = true
    where id = p_location_id
    returning * into v_location;
    perform public.write_audit(
      p_action => 'location_delete_archived', p_entity_type => 'location', p_entity_id => p_location_id::text,
      p_before => to_jsonb(v_before), p_after => to_jsonb(v_location), p_entity_label => v_before.name
    );
    return 'archived';
  end if;

  begin
    delete from public.locations where id = p_location_id;
  exception
    when foreign_key_violation then
      update public.locations set archived = true
      where id = p_location_id
      returning * into v_location;
      perform public.write_audit(
        p_action => 'location_delete_archived', p_entity_type => 'location', p_entity_id => p_location_id::text,
        p_before => to_jsonb(v_before), p_after => to_jsonb(v_location), p_entity_label => v_before.name
      );
      return 'archived';
  end;

  with ranked as (
    select
      id,
      (row_number() over (
        order by display_order, lower(regexp_replace(name, '^\s+|\s+$', '', 'g')), id
      ))::integer as position
    from public.locations
    where category = v_before.category
  )
  update public.locations target
  set display_order = ranked.position
  from ranked
  where target.id = ranked.id
    and target.display_order <> ranked.position;

  perform public.write_audit(
    p_action => 'location_deleted', p_entity_type => 'location', p_entity_id => p_location_id::text,
    p_before => to_jsonb(v_before), p_entity_label => v_before.name
  );
  return 'deleted';
end;
$$;

-- =====================================================================
-- 7. Incident RPCs.
--
--    New dedicated audit actions:
--      - incident_status_changed: structured status transitions, now
--        audited with their own before/after (previously only visible
--        generically folded into the unconditional incident_updated row,
--        or in the incident_events Timeline -- never as its own audit
--        action).
--      - incident_external_handler_changed: external responsibility
--        (external_handler_name/contact_person/contact_details) changes,
--        now audited wherever they can occur -- update_incident,
--        assign_incident, close_incident (both readiness branches), and
--        reopen_incident. Previously recorded only in incident_events.
--
--    De-noising: update_incident's generic 'incident_updated' event now
--    fires ONLY when operational_impact or next_update_due (the two
--    material fields with no dedicated action of their own) actually
--    change, carrying a before/after diff of exactly those changed
--    fields. Status/severity/owner/external-handler changes are fully
--    covered by their own dedicated events above, so a submission that
--    changes none of the six tracked fields (a pure treatment-update
--    content submission, or a resubmission of identical values) now
--    writes zero incident_updated rows -- previously it always wrote one,
--    unconditionally, with no before/after at all.
--
--    entity_label (the incident's number) is added throughout so the
--    audit-log page never has to resolve a bare incident UUID.
-- =====================================================================
create or replace function create_incident(p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v_incident incidents;
  v_operation_id uuid := gen_random_uuid();
  v_description text := nullif(trim(coalesce(p_input->>'description', '')), '');
  v_operational_impact text := nullif(trim(coalesce(p_input->>'operationalImpact', '')), '');
  v_actions_taken text := nullif(trim(coalesce(p_input->>'actionsTaken', '')), '');
  v_reported_ops reported_to_ops := (p_input->>'reportedToOps')::reported_to_ops;
  v_recipient text := case when (p_input->>'reportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'reportedToOpsRecipient', '')), '') else null end;
  v_owner_user_id_raw text := nullif(trim(coalesce(p_input->>'ownerUserId', '')), '');
  v_owner_external_name text := nullif(trim(coalesce(p_input->>'ownerExternalName', '')), '');
  v_owner_user_id uuid;
  v_reported_comms boolean := coalesce((p_input->>'reportedToComms') = 'true', false);
  v_comms_recipient text := case when coalesce((p_input->>'reportedToComms') = 'true', false)
    then nullif(trim(coalesce(p_input->>'reportedToCommsRecipient', '')), '') else null end;
  v_wisdom_reported boolean := coalesce((p_input->>'wisdomReported') = 'true', false);
  v_wisdom_number text := case when coalesce((p_input->>'wisdomReported') = 'true', false)
    then nullif(trim(coalesce(p_input->>'wisdomIncidentNumber', '')), '') else null end;
  v_new_ext_name text := nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '');
  v_new_ext_person text := nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '');
  v_new_ext_details text := nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '');
  v_user_note text := nullif(trim(coalesce(p_input->>'note', '')), '');
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if not coalesce(is_operational_role() or my_role() = 'technician', false) then
    raise exception 'permission: אין הרשאה לפתוח תקלה';
  end if;
  if v_owner_user_id_raw is null then
    raise exception 'validation: יש לבחור בעל אחריות פנימי';
  end if;
  if v_owner_external_name is not null then
    raise exception 'validation: לא ניתן לקבוע גורם חיצוני כבעל אחריות בעת פתיחת תקלה';
  end if;
  begin
    v_owner_user_id := v_owner_user_id_raw::uuid;
  exception
    when invalid_text_representation then
      raise exception 'validation: בעל האחריות הפנימי שנבחר אינו תקין';
  end;
  perform assert_owner_valid(v_owner_user_id);
  if (p_input->>'status')::incident_status not in (
    'new', 'acknowledged', 'in_progress', 'waiting_external', 'waiting_test',
    'monitoring', 'partial_readiness', 'resolved_pending_close'
  ) then
    raise exception 'invalid_transition: סטטוס פתיחה חייב להיות סטטוס פעיל נתמך';
  end if;
  if length(p_input->>'description') > 400 then
    raise exception 'validation: תיאור התקלה: עד 400 תווים';
  end if;
  if v_description is null then
    raise exception 'validation: תיאור התקלה: שדה חובה';
  end if;
  if length(p_input->>'operationalImpact') > 400 then
    raise exception 'validation: השפעה מבצעית: עד 400 תווים';
  end if;
  if v_operational_impact is null then
    raise exception 'validation: השפעה מבצעית: שדה חובה';
  end if;
  if length(p_input->>'actionsTaken') > 600 then
    raise exception 'validation: פעולות שבוצעו עד כה: עד 600 תווים';
  end if;
  if v_actions_taken is null then
    raise exception 'validation: פעולות שבוצעו עד כה: שדה חובה';
  end if;
  if v_reported_ops = 'yes' and v_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;
  if v_reported_comms and v_comms_recipient is null then
    raise exception 'validation: יש להזין למי דווח בתקשוב למבצעים';
  end if;
  if v_wisdom_reported and v_wisdom_number is null then
    raise exception 'validation: יש להזין מספר תקלה ב-WISDOM';
  end if;
  if length(p_input->>'note') > 600 then
    raise exception 'validation: הערה נוספת: עד 600 תווים';
  end if;
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;

  insert into incidents (
    number, system_id, location_id, description, severity, status, operational_impact,
    owner_user_id, owner_external_name, discovered_at, created_by, updated_by,
    next_update_due, no_deadline_reason, reported_to_ops, reported_to_ops_recipient,
    reported_to_comms, reported_to_comms_recipient, wisdom_reported, wisdom_incident_number,
    external_handler_name, external_handler_contact_person, external_handler_contact_details
  ) values (
    allocate_incident_number(),
    (p_input->>'systemId')::uuid,
    (p_input->>'locationId')::uuid,
    v_description,
    (p_input->>'severity')::incident_severity,
    (p_input->>'status')::incident_status,
    v_operational_impact,
    v_owner_user_id,
    v_owner_external_name,
    (p_input->>'discoveredAt')::timestamptz,
    auth.uid(), auth.uid(),
    (p_input->>'nextUpdateDue')::timestamptz,
    nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), ''),
    v_reported_ops, v_recipient,
    v_reported_comms, v_comms_recipient, v_wisdom_reported, v_wisdom_number,
    v_new_ext_name, v_new_ext_person, v_new_ext_details
  ) returning * into v_incident;

  insert into incident_events (incident_id, type, actor_id, event_time, note, user_note, operation_id)
  values (v_incident.id, 'created', auth.uid(), v_incident.discovered_at,
    'פעולות שבוצעו עד כה: ' || v_actions_taken ||
    E'\nתקשוב למבצעים: ' || (case when v_reported_comms then 'כן (דווח ל: ' || v_comms_recipient || ')' else 'לא' end) ||
    E'\nWISDOM: ' || (case when v_wisdom_reported then 'כן (מספר תקלה: ' || v_wisdom_number || ')' else 'לא' end),
    v_user_note,
    v_operation_id);
  if v_incident.status <> 'new' then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (v_incident.id, 'status_change', auth.uid(), 'status', 'new', v_incident.status::text,
            v_incident.discovered_at, v_operation_id);
  end if;
  if v_recipient is not null then
    insert into incident_events (incident_id, type, actor_id, field, new_value, note, event_time, operation_id)
    values (v_incident.id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient', v_recipient,
            'דווח למבצעים: ' || v_recipient, v_incident.discovered_at, v_operation_id);
  end if;

  perform write_audit(
    p_action => 'incident_created', p_entity_type => 'incident', p_entity_id => v_incident.id::text,
    p_incident_number => v_incident.number,
    p_after => jsonb_build_object('severity', v_incident.severity, 'status', v_incident.status),
    p_entity_label => v_incident.number
  );

  if v_incident.owner_user_id is not null and v_incident.owner_user_id <> auth.uid() then
    insert into notifications (user_id, type, incident_id, text, dedupe_key)
    values (v_incident.owner_user_id, 'incident_assigned', v_incident.id,
            'תקלה ' || v_incident.number || ' הוקצתה אליך.', 'assign-' || v_incident.id || '-create')
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  end if;
  return v_incident;
end;
$$;

create or replace function update_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_update_id uuid;
  v_operation_id uuid := gen_random_uuid();
  v_new_status incident_status := (p_input->>'status')::incident_status;
  v_new_severity incident_severity := (p_input->>'severity')::incident_severity;
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
  v_due_provided boolean := p_input ? 'nextUpdateDue';
  v_reason_provided boolean := p_input ? 'noDeadlineReason';
  v_impact_provided boolean := p_input ? 'operationalImpact';
  v_new_due timestamptz;
  v_new_reason text;
  v_new_impact text;
  v_old_owner_label text;
  v_new_owner_label text;
  v_old_ext_name text;
  v_old_ext_person text;
  v_old_ext_details text;
  v_ext_name_provided boolean := p_input ? 'externalHandlerName';
  v_ext_person_provided boolean := p_input ? 'externalHandlerContactPerson';
  v_ext_details_provided boolean := p_input ? 'externalHandlerContactDetails';
  v_new_ext_name text;
  v_new_ext_person text;
  v_new_ext_details text;
  v_update_reported_to_ops reported_to_ops := case when p_input ? 'updateReportedToOps'
    then nullif(p_input->>'updateReportedToOps', '')::reported_to_ops else null end;
  v_update_reported_to_ops_recipient text := case when (p_input->>'updateReportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'updateReportedToOpsRecipient', '')), '') else null end;
  v_update_reported_to_comms boolean := case when p_input ? 'updateReportedToComms'
    then (p_input->>'updateReportedToComms') = 'yes' else null end;
  v_update_reported_to_comms_recipient text := case when (p_input->>'updateReportedToComms') = 'yes'
    then nullif(trim(coalesce(p_input->>'updateReportedToCommsRecipient', '')), '') else null end;
  v_update_wisdom_reported boolean := case when p_input ? 'updateWisdomReported'
    then (p_input->>'updateWisdomReported') = 'yes' else null end;
  v_event_time_raw text := nullif(trim(coalesce(p_input->>'eventTime', '')), '');
  v_event_time timestamptz;
  v_user_note text := nullif(trim(coalesce(p_input->>'note', '')), '');
  v_impact_changed boolean := false;
  v_due_changed boolean := false;
  v_old_impact text;
  v_old_due timestamptz;
begin
  if not is_operational_role() then
    raise exception 'permission: אין הרשאה לעדכן תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  v_old_ext_name := v.external_handler_name;
  v_old_ext_person := v.external_handler_contact_person;
  v_old_ext_details := v.external_handler_contact_details;
  v_new_ext_name := case when v_ext_name_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '') else v_old_ext_name end;
  v_new_ext_person := case when v_ext_person_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '') else v_old_ext_person end;
  v_new_ext_details := case when v_ext_details_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '') else v_old_ext_details end;
  v_new_due := case when v_due_provided then (p_input->>'nextUpdateDue')::timestamptz else v.next_update_due end;
  v_new_reason := case when v_reason_provided then nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), '') else v.no_deadline_reason end;
  v_new_impact := case when v_impact_provided then trim(p_input->>'operationalImpact') else v.operational_impact end;
  if is_incident_terminal(v.status) then
    raise exception 'invalid_transition: תקלה סגורה או מבוטלת אינה ניתנת לעדכון';
  end if;
  if not is_valid_transition(v.status, v_new_status) then
    raise exception 'invalid_transition: מעבר הסטטוס אינו מותר';
  end if;
  if v_event_time_raw is null then
    raise exception 'validation: יש להזין מועד עדכון בפועל';
  end if;
  begin
    v_event_time := v_event_time_raw::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then
      raise exception 'validation: מועד העדכון בפועל אינו תקין';
  end;
  if v_event_time < v.discovered_at or v_event_time > now() + interval '5 minutes' then
    raise exception 'validation: מועד העדכון בפועל אינו תקין';
  end if;
  if v_new_owner is null then
    raise exception 'validation: יש לבחור בעל אחריות פנימי';
  end if;
  perform assert_owner_valid(v_new_owner);
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;
  if v_update_reported_to_ops = 'yes' and v_update_reported_to_ops_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;
  if v_update_reported_to_comms is true and v_update_reported_to_comms_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;
  if length(p_input->>'note') > 600 then
    raise exception 'validation: הערה נוספת: עד 600 תווים';
  end if;

  insert into incident_updates (
    incident_id, author_id, event_time, actions_taken, findings, next_steps, current_status_text,
    update_reported_to_ops, update_reported_to_ops_recipient,
    update_reported_to_comms, update_reported_to_comms_recipient,
    update_wisdom_reported, user_note
  )
  values (p_incident_id, auth.uid(), v_event_time,
          trim(p_input->>'actionsTaken'), coalesce(p_input->>'findings', ''), coalesce(p_input->>'nextSteps', ''),
          nullif(trim(coalesce(p_input->>'currentStatusText', '')), ''),
          v_update_reported_to_ops, v_update_reported_to_ops_recipient,
          v_update_reported_to_comms, v_update_reported_to_comms_recipient,
          v_update_wisdom_reported, v_user_note)
  returning id into v_update_id;
  insert into incident_events (incident_id, type, actor_id, event_time, ref_id, operation_id)
  values (p_incident_id, 'update', auth.uid(), v_event_time, v_update_id, v_operation_id);

  if v_impact_provided and v_new_impact is distinct from v.operational_impact then
    v_impact_changed := true;
    v_old_impact := v.operational_impact;
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'impact_change', auth.uid(), 'operational_impact',
            v.operational_impact, v_new_impact, v_event_time, v_operation_id);
  end if;
  if v_new_status <> v.status then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'status_change', auth.uid(), 'status', v.status::text, v_new_status::text,
            nullif(trim(coalesce(p_input->>'changeReason', '')), ''), v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_status_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('status', v.status), p_after => jsonb_build_object('status', v_new_status),
      p_entity_label => v.number
    );
  end if;
  if v_new_severity <> v.severity then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'severity_change', auth.uid(), 'severity', v.severity::text, v_new_severity::text,
            nullif(trim(coalesce(p_input->>'changeReason', '')), ''), v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_severity_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('severity', v.severity), p_after => jsonb_build_object('severity', v_new_severity),
      p_entity_label => v.number
    );
  end if;
  if v_new_owner::text <> coalesce(v.owner_user_id::text, '') then
    select coalesce((select full_name from profiles where id = v.owner_user_id), v.owner_external_name, 'ללא') into v_old_owner_label;
    select full_name into v_new_owner_label from profiles where id = v_new_owner;
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_owner_label, v_new_owner_label,
            v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_assigned', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('owner', v_old_owner_label), p_after => jsonb_build_object('owner', v_new_owner_label),
      p_entity_label => v.number
    );
    if v_new_owner <> auth.uid() then
      insert into notifications (user_id, type, incident_id, text)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.');
    end if;
  end if;
  if v_new_ext_name is distinct from v_old_ext_name
     or v_new_ext_person is distinct from v_old_ext_person
     or v_new_ext_details is distinct from v_old_ext_details then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
            format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
            format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
            v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_external_handler_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object(
        'externalHandlerName', v_old_ext_name, 'externalHandlerContactPerson', v_old_ext_person,
        'externalHandlerContactDetails', v_old_ext_details),
      p_after => jsonb_build_object(
        'externalHandlerName', v_new_ext_name, 'externalHandlerContactPerson', v_new_ext_person,
        'externalHandlerContactDetails', v_new_ext_details),
      p_entity_label => v.number
    );
  end if;
  if coalesce(v_new_due, 'epoch'::timestamptz) <> coalesce(v.next_update_due, 'epoch'::timestamptz) then
    v_due_changed := true;
    v_old_due := v.next_update_due;
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
    values (p_incident_id, 'deadline_change', auth.uid(), 'next_update_due',
            v.next_update_due::text, v_new_due::text,
            case when v_new_due is null then 'ללא צפי כרגע: ' || coalesce(v_new_reason, '') end,
            v_event_time, v_operation_id);
  end if;

  update incidents set
    status = v_new_status,
    severity = v_new_severity,
    operational_impact = v_new_impact,
    owner_user_id = v_new_owner,
    external_handler_name = v_new_ext_name,
    external_handler_contact_person = v_new_ext_person,
    external_handler_contact_details = v_new_ext_details,
    next_update_due = v_new_due,
    no_deadline_reason = v_new_reason,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;

  -- Only the two material fields with no dedicated action above
  -- (operational_impact, next_update_due) land here, and only when at
  -- least one of them actually changed -- a submission that changes
  -- neither (whether a pure content-only update, or a resubmission of
  -- identical values) writes no 'incident_updated' row at all.
  if v_impact_changed or v_due_changed then
    perform write_audit(
      p_action => 'incident_updated', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => (case when v_impact_changed then jsonb_build_object('operationalImpact', v_old_impact) else '{}'::jsonb end)
        || (case when v_due_changed then jsonb_build_object('nextUpdateDue', v_old_due) else '{}'::jsonb end),
      p_after => (case when v_impact_changed then jsonb_build_object('operationalImpact', v_new_impact) else '{}'::jsonb end)
        || (case when v_due_changed then jsonb_build_object('nextUpdateDue', v_new_due) else '{}'::jsonb end),
      p_entity_label => v.number
    );
  end if;
  return v;
end;
$$;

create or replace function assign_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
  v_old_label text;
  v_new_label text;
  v_old_ext_name text;
  v_old_ext_person text;
  v_old_ext_details text;
  v_ext_name_provided boolean := p_input ? 'externalHandlerName';
  v_ext_person_provided boolean := p_input ? 'externalHandlerContactPerson';
  v_ext_details_provided boolean := p_input ? 'externalHandlerContactDetails';
  v_new_ext_name text;
  v_new_ext_person text;
  v_new_ext_details text;
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if not coalesce(is_operational_role() or my_role() = 'technician', false) then
    raise exception 'permission: אין הרשאה לשנות גורם מטפל';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  v_old_ext_name := v.external_handler_name;
  v_old_ext_person := v.external_handler_contact_person;
  v_old_ext_details := v.external_handler_contact_details;
  v_new_ext_name := case when v_ext_name_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '') else v_old_ext_name end;
  v_new_ext_person := case when v_ext_person_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '') else v_old_ext_person end;
  v_new_ext_details := case when v_ext_details_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '') else v_old_ext_details end;
  if is_incident_terminal(v.status) then
    raise exception 'invalid_transition: לא ניתן לשנות גורם מטפל בתקלה סגורה או מבוטלת';
  end if;
  if v_new_owner is null then
    raise exception 'validation: יש לבחור בעל אחריות פנימי';
  end if;
  perform assert_owner_valid(v_new_owner);
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;

  if v_new_owner is distinct from v.owner_user_id then
    select coalesce((select full_name from profiles where id = v.owner_user_id), v.owner_external_name, 'ללא') into v_old_label;
    select full_name into v_new_label from profiles where id = v_new_owner;

    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'owner', v_old_label, v_new_label,
            nullif(trim(coalesce(p_input->>'note', '')), ''), v_operation_id);
    perform write_audit(
      p_action => 'incident_assigned', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('owner', v_old_label), p_after => jsonb_build_object('owner', v_new_label),
      p_entity_label => v.number
    );
    if v_new_owner <> auth.uid() then
      insert into notifications (user_id, type, incident_id, text)
      values (v_new_owner, 'incident_assigned', p_incident_id, 'תקלה ' || v.number || ' הוקצתה אליך.');
    end if;
  end if;
  if v_new_ext_name is distinct from v_old_ext_name
     or v_new_ext_person is distinct from v_old_ext_person
     or v_new_ext_details is distinct from v_old_ext_details then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
            format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
            format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
            v_operation_id);
    perform write_audit(
      p_action => 'incident_external_handler_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object(
        'externalHandlerName', v_old_ext_name, 'externalHandlerContactPerson', v_old_ext_person,
        'externalHandlerContactDetails', v_old_ext_details),
      p_after => jsonb_build_object(
        'externalHandlerName', v_new_ext_name, 'externalHandlerContactPerson', v_new_ext_person,
        'externalHandlerContactDetails', v_new_ext_details),
      p_entity_label => v.number
    );
  end if;

  update incidents set
    owner_user_id = v_new_owner,
    external_handler_name = v_new_ext_name,
    external_handler_contact_person = v_new_ext_person,
    external_handler_contact_details = v_new_ext_details,
    version = version + 1, updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v;
  return v;
end;
$$;

create or replace function close_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
  v_readiness readiness_level := (p_input->>'readiness')::readiness_level;
  v_follow_up text := nullif(trim(coalesce(p_input->>'followUpNotes', '')), '');
  v_full_ready boolean := v_readiness = 'full';
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
  v_reported_ops reported_to_ops := (p_input->>'reportedToOps')::reported_to_ops;
  v_recipient text := case when (p_input->>'reportedToOps') = 'yes'
    then nullif(trim(coalesce(p_input->>'reportedToOpsRecipient', '')), '') else null end;
  v_old_status incident_status;
  v_owner_label text;
  v_old_reported_ops reported_to_ops;
  v_old_recipient text;
  v_old_ext_name text;
  v_old_ext_person text;
  v_old_ext_details text;
  v_ext_name_provided boolean := p_input ? 'externalHandlerName';
  v_ext_person_provided boolean := p_input ? 'externalHandlerContactPerson';
  v_ext_details_provided boolean := p_input ? 'externalHandlerContactDetails';
  v_new_ext_name text;
  v_new_ext_person text;
  v_new_ext_details text;
  v_event_time_raw text := nullif(trim(coalesce(p_input->>'eventTime', '')), '');
  v_event_time timestamptz;
  v_user_note text := nullif(trim(coalesce(p_input->>'note', '')), '');
begin
  if not is_active_member() then
    raise exception 'permission: אין הרשאה';
  end if;
  if not coalesce(is_operational_role() or my_role() = 'technician', false) then
    raise exception 'permission: אין הרשאה לסגור תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  if is_incident_terminal(v.status) then
    raise exception 'invalid_transition: התקלה כבר סגורה או מבוטלת';
  end if;
  if v_event_time_raw is null then
    raise exception 'validation: יש להזין מועד סגירת התקלה בפועל';
  end if;
  begin
    v_event_time := v_event_time_raw::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then
      raise exception 'validation: מועד סגירת התקלה אינו תקין';
  end;
  if v_event_time < v.discovered_at or v_event_time > now() + interval '5 minutes' then
    raise exception 'validation: מועד סגירת התקלה אינו תקין';
  end if;
  v_old_reported_ops := v.reported_to_ops;
  v_old_recipient := v.reported_to_ops_recipient;
  v_old_ext_name := v.external_handler_name;
  v_old_ext_person := v.external_handler_contact_person;
  v_old_ext_details := v.external_handler_contact_details;
  v_new_ext_name := case when v_ext_name_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '') else v_old_ext_name end;
  v_new_ext_person := case when v_ext_person_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '') else v_old_ext_person end;
  v_new_ext_details := case when v_ext_details_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '') else v_old_ext_details end;
  if length(trim(coalesce(p_input->>'rootCause', ''))) = 0 or length(trim(coalesce(p_input->>'resolution', ''))) = 0 then
    raise exception 'validation: סיבת התקלה והפתרון שבוצע הם שדות חובה';
  end if;
  if not v_full_ready then
    if v_follow_up is null then
      raise exception 'validation: בסגירה עם כשירות חלקית יש לפרט פעולות המשך';
    end if;
    if v_new_owner is null then
      raise exception 'validation: כאשר הכשירות אינה מלאה יש לקבוע גורם מטפל אחראי המשך';
    end if;
  end if;
  if v_reported_ops = 'yes' and v_recipient is null then
    raise exception 'validation: יש להזין למי דווח';
  end if;
  if length(p_input->>'note') > 600 then
    raise exception 'validation: הערה נוספת: עד 600 תווים';
  end if;
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;
  perform assert_owner_valid(v_new_owner);

  v_old_status := v.status;

  if v_full_ready then
    update incidents set
      status = 'closed', closed_at = v_event_time, closed_by = auth.uid(),
      root_cause = trim(p_input->>'rootCause'), resolution = trim(p_input->>'resolution'),
      readiness_at_close = v_readiness, follow_up_notes = v_follow_up,
      follow_up_required = false,
      reported_to_ops = v_reported_ops, reported_to_ops_recipient = v_recipient,
      external_handler_name = v_new_ext_name,
      external_handler_contact_person = v_new_ext_person,
      external_handler_contact_details = v_new_ext_details,
      next_update_due = null, no_deadline_reason = 'התקלה נסגרה',
      version = version + 1, updated_by = auth.uid(), last_update_at = now()
    where id = p_incident_id returning * into v;

    insert into incident_events (incident_id, type, actor_id, new_value, note, user_note, event_time, operation_id)
    values (p_incident_id, 'closed', auth.uid(), v_readiness::text,
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון שבוצע: ' || v.resolution, v_user_note, v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_closed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('status', v_old_status),
      p_after => jsonb_build_object('status', v.status, 'readiness', v_readiness),
      p_entity_label => v.number
    );
    if v_reported_ops <> v_old_reported_ops or v_recipient is distinct from v_old_recipient then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
      values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
              v_old_recipient, v_recipient,
              'דווח למבצעים: ' || v_reported_ops::text || coalesce(' (' || v_recipient || ')', ''), v_event_time, v_operation_id);
    end if;
    if v_new_ext_name is distinct from v_old_ext_name
       or v_new_ext_person is distinct from v_old_ext_person
       or v_new_ext_details is distinct from v_old_ext_details then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
      values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
              format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
              format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
              v_event_time, v_operation_id);
      perform write_audit(
        p_action => 'incident_external_handler_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
        p_incident_number => v.number,
        p_before => jsonb_build_object(
          'externalHandlerName', v_old_ext_name, 'externalHandlerContactPerson', v_old_ext_person,
          'externalHandlerContactDetails', v_old_ext_details),
        p_after => jsonb_build_object(
          'externalHandlerName', v_new_ext_name, 'externalHandlerContactPerson', v_new_ext_person,
          'externalHandlerContactDetails', v_new_ext_details),
        p_entity_label => v.number
      );
    end if;
  else
    select full_name into v_owner_label from profiles where id = v_new_owner;

    update incidents set
      status = 'partial_readiness',
      owner_user_id = v_new_owner,
      external_handler_name = v_new_ext_name,
      external_handler_contact_person = v_new_ext_person,
      external_handler_contact_details = v_new_ext_details,
      root_cause = trim(p_input->>'rootCause'), resolution = trim(p_input->>'resolution'),
      follow_up_notes = v_follow_up, follow_up_required = true,
      reported_to_ops = v_reported_ops, reported_to_ops_recipient = v_recipient,
      no_deadline_reason = case when v.next_update_due is null
        then 'התקלה נותרה פעילה עם כשירות לא מלאה, ממתינה להשלמת פעולות המשך' else v.no_deadline_reason end,
      version = version + 1, updated_by = auth.uid(), last_update_at = now()
    where id = p_incident_id returning * into v;

    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, user_note, event_time, operation_id)
    values (p_incident_id, 'status_change', auth.uid(), 'status', v_old_status::text, 'partial_readiness',
            'סיבת התקלה: ' || v.root_cause || E'\nהפתרון החלקי שבוצע: ' || v.resolution ||
            E'\nפעולות המשך: ' || v.follow_up_notes || E'\nגורם מטפל אחראי המשך: ' || v_owner_label,
            v_user_note, v_event_time, v_operation_id);
    perform write_audit(
      p_action => 'incident_partial_readiness', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object('status', v_old_status),
      p_after => jsonb_build_object('status', v.status, 'readiness', v_readiness),
      p_entity_label => v.number
    );
    if v_reported_ops <> v_old_reported_ops or v_recipient is distinct from v_old_recipient then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, note, event_time, operation_id)
      values (p_incident_id, 'reported_to_ops_change', auth.uid(), 'reported_to_ops_recipient',
              v_old_recipient, v_recipient,
              'דווח למבצעים: ' || v_reported_ops::text || coalesce(' (' || v_recipient || ')', ''), v_event_time, v_operation_id);
    end if;
    if v_new_ext_name is distinct from v_old_ext_name
       or v_new_ext_person is distinct from v_old_ext_person
       or v_new_ext_details is distinct from v_old_ext_details then
      insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, event_time, operation_id)
      values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
              format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
              format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
              v_event_time, v_operation_id);
      perform write_audit(
        p_action => 'incident_external_handler_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
        p_incident_number => v.number,
        p_before => jsonb_build_object(
          'externalHandlerName', v_old_ext_name, 'externalHandlerContactPerson', v_old_ext_person,
          'externalHandlerContactDetails', v_old_ext_details),
        p_after => jsonb_build_object(
          'externalHandlerName', v_new_ext_name, 'externalHandlerContactPerson', v_new_ext_person,
          'externalHandlerContactDetails', v_new_ext_details),
        p_entity_label => v.number
      );
    end if;
  end if;
  return v;
end;
$$;

create or replace function reopen_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = public as $$
declare
  v incidents;
  v_operation_id uuid := gen_random_uuid();
  v_role app_role := my_role();
  v_allow_supervisor boolean := coalesce((select value::text = 'true' from app_policy where key = 'allow_supervisor_reopen'), false);
  v_new_owner uuid := (p_input->>'ownerUserId')::uuid;
  v_due_provided boolean := p_input ? 'nextUpdateDue';
  v_reason_provided boolean := p_input ? 'noDeadlineReason';
  v_new_due timestamptz;
  v_new_reason text;
  v_old_ext_name text;
  v_old_ext_person text;
  v_old_ext_details text;
  v_ext_name_provided boolean := p_input ? 'externalHandlerName';
  v_ext_person_provided boolean := p_input ? 'externalHandlerContactPerson';
  v_ext_details_provided boolean := p_input ? 'externalHandlerContactDetails';
  v_new_ext_name text;
  v_new_ext_person text;
  v_new_ext_details text;
begin
  if not (v_role in ('system_admin', 'professional_manager') or (v_role = 'shift_supervisor' and v_allow_supervisor)) then
    raise exception 'permission: אין הרשאה לפתוח מחדש תקלה';
  end if;
  v := lock_incident_checked(p_incident_id, (p_input->>'expectedVersion')::int);
  v_old_ext_name := v.external_handler_name;
  v_old_ext_person := v.external_handler_contact_person;
  v_old_ext_details := v.external_handler_contact_details;
  v_new_ext_name := case when v_ext_name_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerName', '')), '') else v_old_ext_name end;
  v_new_ext_person := case when v_ext_person_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactPerson', '')), '') else v_old_ext_person end;
  v_new_ext_details := case when v_ext_details_provided
    then nullif(trim(coalesce(p_input->>'externalHandlerContactDetails', '')), '') else v_old_ext_details end;
  v_new_due := case when v_due_provided then (p_input->>'nextUpdateDue')::timestamptz else v.next_update_due end;
  v_new_reason := case when v_reason_provided then nullif(trim(coalesce(p_input->>'noDeadlineReason', '')), '') else v.no_deadline_reason end;
  if v.status <> 'closed' then
    raise exception 'invalid_transition: ניתן לפתוח מחדש רק תקלה סגורה';
  end if;
  if length(trim(coalesce(p_input->>'reason', ''))) = 0 then
    raise exception 'validation: יש להזין סיבה לפתיחה מחדש';
  end if;
  if v_new_owner is null then
    raise exception 'validation: יש לבחור בעל אחריות פנימי';
  end if;
  perform assert_owner_valid(v_new_owner);
  if v_new_ext_name is null and (v_new_ext_person is not null or v_new_ext_details is not null) then
    raise exception 'validation: יש להזין שם גורם מטפל חיצוני כאשר מצוין איש קשר או פרטי קשר';
  end if;

  insert into incident_events (incident_id, type, actor_id, old_value, new_value, note, operation_id)
  values (p_incident_id, 'reopened', auth.uid(), 'closed', 'reopened', trim(p_input->>'reason'), v_operation_id);
  perform write_audit(
    p_action => 'incident_reopened', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
    p_incident_number => v.number,
    p_before => jsonb_build_object('status', 'closed'), p_after => jsonb_build_object('status', 'reopened'),
    p_entity_label => v.number, p_summary => trim(p_input->>'reason')
  );
  if v_new_ext_name is distinct from v_old_ext_name
     or v_new_ext_person is distinct from v_old_ext_person
     or v_new_ext_details is distinct from v_old_ext_details then
    insert into incident_events (incident_id, type, actor_id, field, old_value, new_value, operation_id)
    values (p_incident_id, 'assignment_change', auth.uid(), 'external_handler',
            format_external_handler_snapshot(v_old_ext_name, v_old_ext_person, v_old_ext_details),
            format_external_handler_snapshot(v_new_ext_name, v_new_ext_person, v_new_ext_details),
            v_operation_id);
    perform write_audit(
      p_action => 'incident_external_handler_changed', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
      p_incident_number => v.number,
      p_before => jsonb_build_object(
        'externalHandlerName', v_old_ext_name, 'externalHandlerContactPerson', v_old_ext_person,
        'externalHandlerContactDetails', v_old_ext_details),
      p_after => jsonb_build_object(
        'externalHandlerName', v_new_ext_name, 'externalHandlerContactPerson', v_new_ext_person,
        'externalHandlerContactDetails', v_new_ext_details),
      p_entity_label => v.number
    );
  end if;

  update incidents set
    status = 'reopened',
    owner_user_id = v_new_owner,
    external_handler_name = v_new_ext_name,
    external_handler_contact_person = v_new_ext_person,
    external_handler_contact_details = v_new_ext_details,
    next_update_due = v_new_due,
    no_deadline_reason = v_new_reason,
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

create or replace function public.cancel_incident(p_incident_id uuid, p_input jsonb) returns incidents
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.incidents;
  v_after public.incidents;
  v_expected_version int;
  v_event_time timestamptz;
  v_operation_id uuid := gen_random_uuid();
  v_reason text := trim(coalesce(p_input->>'cancellationReason', ''));
  v_removed_check_id uuid;
  v_removal_note text := 'בדיקת הסטטוס הוסרה באופן אוטומטי עקב ביטול התקלה';
begin
  if not public.is_operational_role() then
    raise exception 'permission: אין הרשאה לבטל תקלה';
  end if;

  if p_input->>'expectedVersion' is null then
    raise exception 'validation: expectedVersion is required';
  end if;
  v_expected_version := (p_input->>'expectedVersion')::int;

  if p_input->>'eventTime' is null then
    raise exception 'validation: eventTime is required';
  end if;
  v_event_time := (p_input->>'eventTime')::timestamptz;

  v_before := public.lock_incident_checked(p_incident_id, v_expected_version);
  if public.is_incident_terminal(v_before.status) then
    raise exception 'invalid_transition: לא ניתן לבטל תקלה שכבר סגורה או מבוטלת';
  end if;
  if length(v_reason) = 0 then
    raise exception 'validation: יש לפרט סיבת ביטול';
  end if;
  if v_event_time < v_before.discovered_at or v_event_time > now() + interval '5 minutes' then
    raise exception 'validation: מועד הביטול אינו תקין';
  end if;

  update public.incidents set
    status = 'cancelled', cancelled_at = v_event_time, cancelled_by = auth.uid(),
    cancellation_reason = v_reason, next_update_due = null, no_deadline_reason = 'התקלה בוטלה',
    status_check_due = null, follow_up_required = false,
    version = version + 1, updated_at = now(), updated_by = auth.uid(), last_update_at = now()
  where id = p_incident_id returning * into v_after;

  insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
  values (p_incident_id, 'cancelled', auth.uid(), 'status', v_before.status::text, 'cancelled', v_reason, null, v_event_time, v_operation_id);

  if v_before.status_check_due is not null then
    insert into public.incident_status_checks (incident_id, kind, previous_due_at, recorded_by, event_time, note)
    values (p_incident_id, 'removed', v_before.status_check_due, auth.uid(), v_event_time, v_removal_note)
    returning id into v_removed_check_id;

    insert into public.incident_events (incident_id, type, actor_id, field, old_value, new_value, note, ref_id, event_time, operation_id)
    values (p_incident_id, 'status_check_changed', auth.uid(), 'status_check_due',
            v_before.status_check_due::text, null, v_removal_note, v_removed_check_id, v_event_time, v_operation_id);
  end if;

  perform public.write_audit(
    p_action => 'incident_cancelled', p_entity_type => 'incident', p_entity_id => p_incident_id::text,
    p_incident_number => v_before.number,
    p_before => jsonb_build_object('status', v_before.status),
    p_after => jsonb_build_object('status', v_after.status, 'cancellationReason', v_after.cancellation_reason),
    p_entity_label => v_before.number, p_summary => v_reason
  );
  return v_after;
end;
$$;

commit;
