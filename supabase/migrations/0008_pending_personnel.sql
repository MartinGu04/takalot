-- מעקב תקלות — forward migration.
-- Pre-provisioned personnel access: an authorized creator (shift
-- supervisor, NCO/professional manager, or system administrator) registers
-- a person by name + Google email + intended role BEFORE that person ever
-- signs in. On the person's first authenticated session, claim_
-- pending_personnel() -- taking NO arguments -- derives auth.uid() itself,
-- reads the VERIFIED email server-side from auth.users, verifies the
-- identity is a CONFIRMED Google identity carrying that same email, and
-- atomically claims the matching pending entry: links the auth identity,
-- creates the real public.profiles row with the preassigned role, marks
-- the entry claimed, and returns the profile. No invitation link, no
-- manual UUID handling, no Supabase-dashboard step. Anything that does not
-- match exactly (no entry, cancelled, expired, already claimed, different
-- account, unconfirmed email, non-Google identity, or an existing profile
-- that has been DEACTIVATED) fails closed and the user stays unauthorized.
--
-- Nothing the frontend sends can influence the claim: the RPC has no
-- parameters at all, and role/name come only from the pending row that an
-- authorized creator wrote under the role ceilings below.
--
-- Every function here is created with an EMPTY fixed search_path and fully
-- qualified object references, so no role -- whatever it can create in
-- whatever schema -- can shadow an object these SECURITY DEFINER bodies
-- resolve.
--
-- Expiry lifecycle: expires_at is optional. A pending entry past its
-- expires_at is not claimable (the claim predicate excludes it) and is
-- lazily retired to status 'expired' -- atomically, in the same
-- transaction -- when a replacement entry is created for the same email,
-- so an expired entry never permanently blocks re-registration (the
-- claimable-uniqueness index only covers status 'pending'). An
-- expired-but-not-yet-retired row may still be explicitly cancelled, or
-- edited by an editor within ceiling (which may extend expires_at -- a
-- deliberate re-invite path).
--
-- 0001-0007 are untouched (0007 is amended in place only because it has
-- never been applied anywhere). This is an ADDITIVE migration.

-- ===== 1. Schema =====
create type public.pending_personnel_status as enum ('pending', 'claimed', 'cancelled', 'expired');

create table public.pending_personnel (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  -- Stored ONLY normalized (trim + lowercase); enforced, not assumed.
  email text not null check (
    email = lower(trim(email)) and length(email) between 3 and 320 and position('@' in email) > 1
  ),
  role public.app_role not null,
  status public.pending_personnel_status not null default 'pending',
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Optional expiry: a pending entry past this instant is not claimable
  -- and is lazily retired to status 'expired' (see header).
  expires_at timestamptz,
  -- The claiming auth identity (references auth.users, not profiles: the
  -- profile row is created inside the same claiming transaction).
  claimed_by uuid references auth.users (id),
  claimed_at timestamptz,
  cancelled_by uuid references public.profiles (id),
  cancelled_at timestamptz,
  constraint pending_claimed_complete check (
    status <> 'claimed' or (claimed_by is not null and claimed_at is not null)
  ),
  constraint pending_cancelled_complete check (
    status <> 'cancelled' or (cancelled_by is not null and cancelled_at is not null)
  ),
  constraint pending_terminal_fields_only_when_reached check (
    (status = 'claimed' or (claimed_by is null and claimed_at is null))
    and (status = 'cancelled' or (cancelled_by is null and cancelled_at is null))
  ),
  -- A row can only be retired to 'expired' if it actually had an expiry
  -- that has passed -- 'expired' is a fact, never an arbitrary state.
  constraint pending_expired_requires_expiry check (
    status <> 'expired' or expires_at is not null
  )
);

-- Uniqueness among CLAIMABLE entries only: one live pending entry per
-- email. Claimed/cancelled/expired rows are history and do not block
-- re-inviting.
create unique index idx_pending_personnel_email_claimable
  on public.pending_personnel (email) where status = 'pending';
create index idx_pending_personnel_status on public.pending_personnel (status, created_at desc);

-- RLS: listing/reading is management, restricted to the roles that may
-- manage entries (technician and viewer see nothing). All writes go
-- through the SECURITY DEFINER RPCs below -- no direct write policies.
alter table public.pending_personnel enable row level security;
create policy pending_personnel_select on public.pending_personnel for select
  using (public.my_role() in ('shift_supervisor', 'professional_manager', 'system_admin'));

-- ===== 2. Role ceilings (internal helper) =====
-- Who may create/manage an entry for which target role. Enforced HERE, in
-- the database, not only in frontend code:
--   shift_supervisor      -> technician, shift_supervisor
--   professional_manager  -> technician, shift_supervisor, professional_manager
--   system_admin          -> every role, including system_admin
--   technician / viewer   -> nothing
create or replace function public.role_ceiling_allows(p_creator public.app_role, p_target public.app_role) returns boolean
language sql immutable set search_path = '' as $$
  select case p_creator
    when 'system_admin' then true
    when 'professional_manager' then p_target in ('technician', 'shift_supervisor', 'professional_manager')
    when 'shift_supervisor' then p_target in ('technician', 'shift_supervisor')
    else false
  end;
$$;

-- ===== 3. Management RPCs =====

create or replace function public.create_pending_personnel(p_input jsonb) returns public.pending_personnel
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.app_role := public.my_role();
  v_target public.app_role := (p_input->>'role')::public.app_role;
  v_email text := lower(trim(coalesce(p_input->>'email', '')));
  v_name text := trim(coalesce(p_input->>'fullName', ''));
  v_expires timestamptz;
  v_expired_id uuid;
  v_row public.pending_personnel;
begin
  if v_role is null or not public.role_ceiling_allows(v_role, v_target) then
    raise exception 'permission: אין הרשאה להוסיף רישום כוח אדם בתפקיד המבוקש';
  end if;
  if length(v_name) < 1 or length(v_name) > 120 then
    raise exception 'validation: יש להזין שם מלא (עד 120 תווים)';
  end if;
  if length(v_email) < 3 or length(v_email) > 320 or position('@' in v_email) <= 1 then
    raise exception 'validation: כתובת הדוא״ל אינה תקינה';
  end if;
  begin
    v_expires := nullif(trim(coalesce(p_input->>'expiresAt', '')), '')::timestamptz;
  exception when others then
    raise exception 'validation: מועד התפוגה אינו תקין';
  end;
  if v_expires is not null and v_expires <= now() then
    raise exception 'validation: מועד התפוגה חייב להיות עתידי';
  end if;
  -- An email already linked to an existing account -- ACTIVE OR INACTIVE
  -- -- must not get a second pending identity: a new pending entry must
  -- never silently reactivate or replace a deactivated profile.
  if exists (
    select 1 from auth.users u join public.profiles p on p.id = u.id
    where lower(trim(u.email)) = v_email
  ) then
    raise exception 'validation: לכתובת דוא״ל זו כבר קיים משתמש מקושר במערכת';
  end if;

  -- Lazy retirement: an EXPIRED pending row for this email is dead weight
  -- occupying the claimable-uniqueness slot. Retire it atomically (same
  -- transaction as the insert) so it never permanently blocks a
  -- replacement. At most one row can match (partial unique index).
  update public.pending_personnel
    set status = 'expired', updated_at = now()
    where email = v_email and status = 'pending'
      and expires_at is not null and expires_at <= now()
    returning id into v_expired_id;
  if v_expired_id is not null then
    perform public.write_audit('personnel_pending_expired', 'pending_personnel', v_expired_id::text, null,
      jsonb_build_object('email', v_email), null);
  end if;

  begin
    insert into public.pending_personnel (full_name, email, role, created_by, expires_at)
    values (v_name, v_email, v_target, auth.uid(), v_expires)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'validation: כבר קיים רישום ממתין לכתובת דוא״ל זו';
  end;

  perform public.write_audit('personnel_pending_created', 'pending_personnel', v_row.id::text, null,
    null, jsonb_build_object('email', v_row.email, 'role', v_row.role, 'fullName', v_row.full_name));
  return v_row;
end;
$$;

create or replace function public.update_pending_personnel(p_id uuid, p_input jsonb) returns public.pending_personnel
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.app_role := public.my_role();
  v_target public.app_role := (p_input->>'role')::public.app_role;
  v_email text := lower(trim(coalesce(p_input->>'email', '')));
  v_name text := trim(coalesce(p_input->>'fullName', ''));
  v_expires timestamptz;
  v_expired_id uuid;
  v_old public.pending_personnel;
  v_row public.pending_personnel;
begin
  select * into v_old from public.pending_personnel where id = p_id for update;
  if not found then
    raise exception 'not_found: הרישום לא נמצא';
  end if;
  if v_old.status <> 'pending' then
    raise exception 'validation: ניתן לערוך רק רישום ממתין';
  end if;
  -- The editor's ceiling must cover BOTH the entry's current role and the
  -- new one -- otherwise a lower role could take over entries above it.
  if v_role is null
     or not public.role_ceiling_allows(v_role, v_old.role)
     or not public.role_ceiling_allows(v_role, v_target) then
    raise exception 'permission: אין הרשאה לערוך רישום זה';
  end if;
  if length(v_name) < 1 or length(v_name) > 120 then
    raise exception 'validation: יש להזין שם מלא (עד 120 תווים)';
  end if;
  if length(v_email) < 3 or length(v_email) > 320 or position('@' in v_email) <= 1 then
    raise exception 'validation: כתובת הדוא״ל אינה תקינה';
  end if;
  begin
    v_expires := nullif(trim(coalesce(p_input->>'expiresAt', '')), '')::timestamptz;
  exception when others then
    raise exception 'validation: מועד התפוגה אינו תקין';
  end;
  if v_expires is not null and v_expires <= now() then
    raise exception 'validation: מועד התפוגה חייב להיות עתידי';
  end if;
  if v_email <> v_old.email and exists (
    select 1 from auth.users u join public.profiles p on p.id = u.id
    where lower(trim(u.email)) = v_email
  ) then
    raise exception 'validation: לכתובת דוא״ל זו כבר קיים משתמש מקושר במערכת';
  end if;

  -- Same lazy retirement as create: moving this entry onto an email whose
  -- previous pending entry has expired must not be blocked by that corpse.
  update public.pending_personnel
    set status = 'expired', updated_at = now()
    where email = v_email and id <> p_id and status = 'pending'
      and expires_at is not null and expires_at <= now()
    returning id into v_expired_id;
  if v_expired_id is not null then
    perform public.write_audit('personnel_pending_expired', 'pending_personnel', v_expired_id::text, null,
      jsonb_build_object('email', v_email), null);
  end if;

  begin
    update public.pending_personnel
      set full_name = v_name, email = v_email, role = v_target, expires_at = v_expires, updated_at = now()
      where id = p_id
      returning * into v_row;
  exception when unique_violation then
    raise exception 'validation: כבר קיים רישום ממתין לכתובת דוא״ל זו';
  end;

  perform public.write_audit('personnel_pending_updated', 'pending_personnel', p_id::text, null,
    jsonb_build_object('email', v_old.email, 'role', v_old.role, 'fullName', v_old.full_name),
    jsonb_build_object('email', v_row.email, 'role', v_row.role, 'fullName', v_row.full_name));
  return v_row;
end;
$$;

create or replace function public.cancel_pending_personnel(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.app_role := public.my_role();
  v_old public.pending_personnel;
begin
  select * into v_old from public.pending_personnel where id = p_id for update;
  if not found then
    raise exception 'not_found: הרישום לא נמצא';
  end if;
  if v_old.status <> 'pending' then
    raise exception 'validation: ניתן לבטל רק רישום ממתין';
  end if;
  if v_role is null or not public.role_ceiling_allows(v_role, v_old.role) then
    raise exception 'permission: אין הרשאה לבטל רישום זה';
  end if;

  update public.pending_personnel
    set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), updated_at = now()
    where id = p_id;
  perform public.write_audit('personnel_pending_cancelled', 'pending_personnel', p_id::text, null,
    jsonb_build_object('email', v_old.email, 'role', v_old.role), null);
end;
$$;

-- ===== 4. The claim RPC =====
-- Takes NO arguments. Everything is derived server-side: the identity from
-- auth.uid(), the email + confirmation state from auth.users, the Google
-- provider binding from auth.identities. Race-safe: the pending->claimed
-- transition is a single conditional UPDATE (concurrent claimers serialize
-- on the row lock; exactly one sees status='pending'), and the whole
-- function is one transaction -- a failure after the claim rolls the claim
-- back too. Privilege-safe: the created profile's role comes only from the
-- pending row, which itself could only be written under the role ceilings
-- above. An existing profile that is INACTIVE is never returned as
-- authorization and can never be reactivated or replaced through this
-- path.
create or replace function public.claim_pending_personnel() returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed boolean;
  v_entry public.pending_personnel;
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'permission: אין זהות מאומתת';
  end if;

  -- Already provisioned (including a concurrent claim that just finished):
  -- return the existing profile ONLY if it is active; never claim twice
  -- for one identity, and never let a deactivated profile back in through
  -- the claim path -- deactivation is authorization revocation.
  select * into v_profile from public.profiles where id = v_uid;
  if found then
    if v_profile.active then
      return v_profile;
    end if;
    raise exception 'not_found: החשבון הקיים לזהות זו הושבת';
  end if;

  -- The VERIFIED identity, read server-side. Client input plays no part.
  -- Three server-side facts are required, not just an email string:
  --   1. auth.users has this identity with a non-empty email;
  --   2. that email is CONFIRMED (email_confirmed_at set by Supabase Auth);
  --   3. the identity carries a Google provider record whose own verified
  --      email matches the same normalized address.
  select lower(trim(u.email)), u.email_confirmed_at is not null
    into v_email, v_confirmed
    from auth.users u where u.id = v_uid;
  if v_email is null or v_email = '' then
    raise exception 'not_found: לזהות המאומתת אין כתובת דוא״ל';
  end if;
  if not v_confirmed then
    raise exception 'not_found: כתובת הדוא״ל של זהות זו לא אושרה';
  end if;
  if not exists (
    select 1 from auth.identities i
    where i.user_id = v_uid
      and i.provider = 'google'
      and lower(trim(coalesce(i.identity_data->>'email', ''))) = v_email
  ) then
    raise exception 'not_found: הזהות אינה חשבון Google מאומת התואם לכתובת';
  end if;

  -- Atomic claim: only a live, unexpired, still-pending entry matches.
  -- (An expired row is excluded here and retired lazily by the create
  -- path -- raising below must not be preceded by writes, since the
  -- exception would roll them back.)
  update public.pending_personnel
    set status = 'claimed', claimed_by = v_uid, claimed_at = now(), updated_at = now()
    where email = v_email
      and status = 'pending'
      and (expires_at is null or expires_at > now())
    returning * into v_entry;

  if not found then
    -- Concurrent-claim tiebreak for the SAME identity: if another session
    -- of this user just claimed and created the profile, return it -- but
    -- again only while it is active.
    select * into v_profile from public.profiles where id = v_uid;
    if found and v_profile.active then
      return v_profile;
    end if;
    raise exception 'not_found: אין רישום כוח אדם ממתין התואם לחשבון זה';
  end if;

  insert into public.profiles (id, full_name, role, active)
  values (v_uid, v_entry.full_name, v_entry.role, true)
  returning * into v_profile;

  perform public.write_audit('personnel_pending_claimed', 'pending_personnel', v_entry.id::text, null,
    jsonb_build_object('email', v_entry.email, 'role', v_entry.role),
    jsonb_build_object('profileId', v_uid));
  return v_profile;
end;
$$;

-- ===== 5. Unified management listing =====
-- The single safe way for the future personnel page to show Google emails
-- for BOTH pending entries and already-linked profiles. The client never
-- queries auth.users; this SECURITY DEFINER function exposes exactly four
-- management-safe facts per person -- full name, normalized email, role,
-- state -- plus the row id needed to target management RPCs. No other
-- auth.users fields leave the database. Callable only by the managing
-- roles; everyone else (technician, viewer, an authenticated identity with
-- no profile) is rejected in the body, and anon at the privilege boundary.
create or replace function public.list_personnel() returns table (
  kind text,               -- 'pending' | 'linked'
  id uuid,                 -- pending entry id / profile id (management target, not for display)
  full_name text,
  email text,              -- normalized; null for a linked profile with no auth identity
  role public.app_role,
  state text,              -- pending: 'pending'; linked: 'active' | 'inactive'
  created_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() is null
     or public.my_role() not in ('shift_supervisor', 'professional_manager', 'system_admin') then
    raise exception 'permission: אין הרשאה לצפות ברשימת כוח האדם';
  end if;
  return query
    select 'pending'::text, pp.id, pp.full_name, pp.email, pp.role, 'pending'::text, pp.created_at
    from public.pending_personnel pp
    where pp.status = 'pending' and (pp.expires_at is null or pp.expires_at > now())
    union all
    select 'linked'::text, p.id, p.full_name, lower(trim(u.email)), p.role,
      case when p.active then 'active' else 'inactive' end, p.created_at
    from public.profiles p
    left join auth.users u on u.id = p.id
    order by 1, 7 desc;
end;
$$;

-- ===== 6. Grants =====
-- Every new function: nothing for PUBLIC/anon. Management RPCs, the claim
-- RPC and the listing are callable by authenticated (their bodies enforce
-- the real authorization); the ceiling helper is internal only.
revoke execute on function public.role_ceiling_allows(public.app_role, public.app_role) from public, anon, authenticated;
revoke execute on function public.create_pending_personnel(jsonb) from public, anon;
revoke execute on function public.update_pending_personnel(uuid, jsonb) from public, anon;
revoke execute on function public.cancel_pending_personnel(uuid) from public, anon;
revoke execute on function public.claim_pending_personnel() from public, anon;
revoke execute on function public.list_personnel() from public, anon;
grant execute on function public.create_pending_personnel(jsonb) to authenticated;
grant execute on function public.update_pending_personnel(uuid, jsonb) to authenticated;
grant execute on function public.cancel_pending_personnel(uuid) to authenticated;
grant execute on function public.list_personnel() to authenticated;
-- claim is deliberately callable by ANY authenticated identity, profile or
-- not -- that is its entire purpose; it fails closed on no match.
grant execute on function public.claim_pending_personnel() to authenticated;

-- ===== 7. Retire the placeholder flow =====
-- placeholder_profiles rows were never linked to authentication and could
-- not authorize anyone; pending_personnel supersedes them. The table and
-- its historical rows are RETAINED (nothing is deleted), but the RPC that
-- wrote them is no longer callable by clients.
revoke execute on function public.admin_create_placeholder_profile(text, public.app_role) from public, anon, authenticated;
comment on table public.placeholder_profiles is
  'DEPRECATED (0008): superseded by pending_personnel. Historical rows retained; no longer written.';
comment on function public.admin_create_placeholder_profile(text, public.app_role) is
  'DEPRECATED (0008): superseded by create_pending_personnel. Execute revoked from clients.';
