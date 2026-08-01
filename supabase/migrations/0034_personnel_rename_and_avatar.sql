-- מעקב תקלות — forward migration.
-- Two additive personnel-management capabilities for the "כוח אדם" page:
--
--   1. Renaming: an authorized manager (shift_supervisor / professional_manager /
--      system_admin, within the SAME role ceilings already enforced for every
--      other personnel action) may correct a person's display name -- for a
--      pending entry (before first login) or an already-linked profile
--      (active or inactive). Two new RPCs, deliberately narrow (name only,
--      nothing else):
--        - rename_pending_personnel(p_id, p_full_name) -- mirrors
--          update_pending_personnel's role-ceiling check (role_ceiling_
--          allows_assign, 0008) but touches only full_name. Because
--          claim_pending_personnel() (0008) reads full_name straight from
--          the live pending_personnel row at claim time, a rename here is
--          automatically what gets used on first Google login -- no change
--          to the claim function itself is needed.
--        - admin_set_user_name(p_user_id, p_full_name) -- mirrors
--          admin_set_user_role/admin_set_user_active (0010, revised 0012):
--          same advisory lock key (so it serializes with concurrent
--          role/activation/rename writes on the same target), same
--          role_ceiling_allows_manage check for managing SOMEONE ELSE, same
--          tombstoned-profile guard. UNLIKE admin_set_user_role/
--          admin_set_user_active, self-service is allowed here: a caller
--          whose OWN role is shift_supervisor, professional_manager or
--          system_admin -- the same three personnel-manager roles that may
--          manage OTHER people's records -- may rename THEMSELVES; a
--          technician or viewer may never rename anyone, including
--          themselves. This is a deliberate carve-out, independent of
--          role_ceiling_allows_manage (which governs the hierarchy over
--          OTHER people, not one's own record -- a professional_manager's
--          ceiling excludes a peer professional_manager, which would
--          otherwise wrongly block a professional_manager from renaming
--          themselves). No other RPC ever writes profiles.full_name from
--          Google/session data after the one-time claim insert, so a name
--          set here (self or otherwise) is never silently overwritten by a
--          later login.
--      Both apply the same new name rules: required, trimmed (leading/
--      trailing plain spaces only -- see below), 2-60 characters, and
--      rejecting any embedded line break or control character. Otherwise
--      any Unicode display-name text is allowed -- Hebrew, English,
--      parentheses, punctuation, hyphens, apostrophes and so on -- never
--      restricted to a narrow character allowlist or to ASCII. This is a
--      NEW, narrower length/shape rule than the existing 1-120-character,
--      no-charset-restriction full_name check used by create/
--      update_pending_personnel's fuller edit form (unchanged); trim()'s
--      default behavior only strips plain space characters (not tab/
--      newline), so a value with an embedded or edge tab/newline/control
--      character is rejected outright rather than silently normalized.
--
--   2. Avatar persistence: profiles.avatar_url is new. Previously an
--      avatar was only ever available ephemerally, for the CURRENTLY
--      signed-in person's own session (AuthContext's extractAvatarUrl,
--      reading already-authenticated OAuth session metadata) -- never
--      stored, so the personnel list could never show anyone else's
--      picture. set_own_avatar_url(p_avatar_url) lets a signed-in identity
--      persist ONLY their own avatar_url, from data their own browser
--      session already holds -- it never reads or exposes auth.users, and
--      the client is never granted any access to auth.users either. Called
--      best-effort after every successful profile resolution (see
--      AuthContext.tsx), so the value keeps refreshing without weakening
--      any existing auth flow.
--
-- Every function here is created with an EMPTY fixed search_path and fully
-- qualified references, matching every other SECURITY DEFINER function in
-- this schema.
--
-- 0001-0033 are untouched. This migration has never been applied to any
-- hosted database, so it is revised IN PLACE (self-rename + the broadened
-- character rule) rather than superseded by a new migration.

-- =====================================================================
-- 1. profiles.avatar_url
-- =====================================================================
alter table public.profiles add column avatar_url text;
-- Defensive shape check even though the only writer (set_own_avatar_url,
-- below) already validates this -- a direct future writer can never store
-- something an <img src> shouldn't see.
alter table public.profiles
  add constraint profiles_avatar_url_shape check (
    avatar_url is null or (length(avatar_url) <= 2048 and avatar_url ~ '^https?://')
  );

create or replace function public.set_own_avatar_url(p_avatar_url text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'permission: אין זהות מאומתת';
  end if;
  if p_avatar_url is not null and (length(p_avatar_url) > 2048 or p_avatar_url !~ '^https?://') then
    raise exception 'validation: כתובת תמונת הפרופיל אינה תקינה';
  end if;
  -- Scoped to the caller's OWN row only, and to avatar_url alone -- never
  -- full_name or any other field. A no-op (zero rows) if the caller has no
  -- profile yet, which is fine: this is called best-effort, after profile
  -- resolution, never as an authorization step itself. Not audited: this
  -- fires on every successful login as routine session bookkeeping, not a
  -- security-relevant administrative action.
  update public.profiles set avatar_url = p_avatar_url where id = auth.uid();
end;
$$;
revoke execute on function public.set_own_avatar_url(text) from public, anon;
grant execute on function public.set_own_avatar_url(text) to authenticated;

-- =====================================================================
-- 2. Renaming
-- =====================================================================

create or replace function public.rename_pending_personnel(p_id uuid, p_full_name text) returns public.pending_personnel
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.app_role := public.my_role();
  v_name text := trim(coalesce(p_full_name, ''));
  v_old public.pending_personnel;
  v_row public.pending_personnel;
begin
  select * into v_old from public.pending_personnel where id = p_id for update;
  if not found then
    raise exception 'not_found: הרישום לא נמצא';
  end if;
  if v_old.status <> 'pending' then
    raise exception 'validation: ניתן לשנות שם רק לרישום ממתין';
  end if;
  if v_role is null or not public.role_ceiling_allows_assign(v_role, v_old.role) then
    raise exception 'permission: אין הרשאה לשנות את שמו של רישום זה';
  end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    raise exception 'validation: השם חייב להכיל בין 2 ל-60 תווים';
  end if;
  if v_name ~ '[[:cntrl:]]' then
    raise exception 'validation: השם אינו יכול להכיל שורה חדשה או תווי בקרה';
  end if;

  update public.pending_personnel
    set full_name = v_name, updated_at = now()
    where id = p_id
    returning * into v_row;

  perform public.write_audit('personnel_pending_renamed', 'pending_personnel', p_id::text, null,
    jsonb_build_object('fullName', v_old.full_name), jsonb_build_object('fullName', v_row.full_name));
  return v_row;
end;
$$;
revoke execute on function public.rename_pending_personnel(uuid, text) from public, anon;
grant execute on function public.rename_pending_personnel(uuid, text) to authenticated;

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

  -- Same lock, same key as admin_set_user_role/admin_set_user_active --
  -- serializes against concurrent role/activation/rename writes on the
  -- same or related targets. See 0010's header for why this closes the
  -- TOCTOU and cannot deadlock.
  perform pg_advisory_xact_lock(hashtext('personnel_management_write')::bigint);

  v_actor_role := public.my_role();
  if v_actor_role is null then
    raise exception 'permission: אין הרשאה לשנות שם';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'not_found: המשתמש לא נמצא';
  end if;

  -- A tombstoned profile's name is permanent historical record, not an
  -- editable field -- same protection as role/active (0012). Applies to
  -- self too (a tombstoned identity has no session to call this from in
  -- practice, but the guard stays unconditional regardless).
  if v_target.deleted_at is not null then
    raise exception 'validation: לא ניתן לשנות שם למשתמש שנמחק';
  end if;

  if v_is_self then
    -- Self-service rename: allowed only for the three personnel-manager
    -- roles -- the same roles that may manage OTHER people's records.
    -- Deliberately NOT role_ceiling_allows_manage(v_actor_role,
    -- v_actor_role): that matrix governs the hierarchy over OTHER people
    -- and excludes a caller's own peer rank (e.g. a professional_manager
    -- may not manage another professional_manager), which would wrongly
    -- block a professional_manager or shift_supervisor from renaming
    -- themselves. A technician or viewer may never rename anyone,
    -- including themselves.
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
  perform public.write_audit('user_renamed', 'profile', p_user_id::text, null,
    jsonb_build_object('fullName', v_target.full_name), jsonb_build_object('fullName', v_name));
end;
$$;
revoke execute on function public.admin_set_user_name(uuid, text) from public, anon;
grant execute on function public.admin_set_user_name(uuid, text) to authenticated;

-- =====================================================================
-- 3. list_personnel(): add avatar_url
-- =====================================================================
-- The OUT columns change, so CREATE OR REPLACE is not enough -- Postgres
-- requires DROP + CREATE for a changed return signature. This drops the
-- prior grants, so section 4 below re-grants exactly as 0008 did.
drop function public.list_personnel();

create function public.list_personnel() returns table (
  kind text,               -- 'pending' | 'linked'
  id uuid,                 -- pending entry id / profile id (management target, not for display)
  full_name text,
  email text,              -- normalized; null for a linked profile with no auth identity
  role public.app_role,
  state text,              -- pending: 'pending'; linked: 'active' | 'inactive'
  created_at timestamptz,
  avatar_url text          -- linked profiles only; always null for a pending entry
)
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() is null
     or public.my_role() not in ('shift_supervisor', 'professional_manager', 'system_admin') then
    raise exception 'permission: אין הרשאה לצפות ברשימת כוח האדם';
  end if;
  return query
    select 'pending'::text, pp.id, pp.full_name, pp.email, pp.role, 'pending'::text, pp.created_at,
      null::text
    from public.pending_personnel pp
    where pp.status = 'pending' and (pp.expires_at is null or pp.expires_at > now())
    union all
    select 'linked'::text, p.id, p.full_name, lower(trim(u.email)), p.role,
      case when p.active then 'active' else 'inactive' end, p.created_at,
      p.avatar_url
    from public.profiles p
    left join auth.users u on u.id = p.id
    order by 1, 7 desc;
end;
$$;

-- =====================================================================
-- 4. Grants
-- =====================================================================
revoke execute on function public.list_personnel() from public, anon;
grant execute on function public.list_personnel() to authenticated;
