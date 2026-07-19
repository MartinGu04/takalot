-- מעקב תקלות — forward migration.
-- First-administrator bootstrap. In a fresh production database there are
-- zero public.profiles rows, so the pending-personnel flow (0008)
-- deadlocks: create_pending_personnel requires an already-authorized
-- manager, and claim_pending_personnel requires an existing pending entry.
-- No migration or seed ever inserts a profiles row -- this migration is
-- the single, one-time way the FIRST system administrator comes to exist.
--
-- Design:
--   * The project owner performs exactly ONE manual setup action, before
--     the first login, in the Supabase SQL editor (server-side only --
--     never in frontend code and never in a VITE_* variable):
--
--         insert into public.bootstrap_admin_config (email)
--         values ('owner.account@gmail.com');
--
--     No auth UUID is ever looked up or typed. The email may be inserted
--     in any case/whitespace; matching normalizes both sides.
--   * The owner then signs in through the NORMAL Google OAuth flow. The
--     auth gate, finding no profile and no claimable pending entry, calls
--     bootstrap_first_admin() -- zero arguments. The RPC verifies
--     SERVER-SIDE that the caller is a confirmed Google identity whose
--     verified email matches the configured address, that no active
--     system_admin exists, and that the one-shot has not been consumed --
--     then creates exactly one active system_admin profile.
--   * Knowing the bootstrap email grants nothing: the caller must BE the
--     verified Google account behind it. The configured email is
--     unreadable by clients (RLS with no policies + revoked table
--     privileges).
--   * Race-safe: the config row is locked FOR UPDATE, so concurrent
--     attempts serialize; the loser re-observes a consumed one-shot (or an
--     existing active admin) and fails closed. The profiles primary key is
--     the final backstop. One transaction end to end.
--   * Permanently one-shot: success stamps consumed_at/consumed_by. Once
--     an active system_admin exists -- or the one-shot is consumed --
--     bootstrap fails closed forever. This is NOT a general
--     self-registration path and cannot assign any role except
--     system_admin (no role input exists); every later user goes through
--     pending_personnel.
--   * Auditing without leakage: while the one-shot is open, rejected
--     attempts are recorded as admin_bootstrap_rejected with a reason
--     CODE only (never the configured email); success records
--     admin_bootstrap_completed. Rejections return null (not an
--     exception) precisely so the audit row survives -- an exception
--     would roll it back. After the one-shot closes, calls are silent
--     no-ops (returning null) so routine sign-ins by unprovisioned users
--     cannot flood the audit log.
--
-- Functions follow 0008's hardening: SECURITY DEFINER with an EMPTY fixed
-- search_path and fully qualified references.
--
-- 0001-0008 are untouched. This is an ADDITIVE migration.

-- ===== 1. Server-side configuration (single row, client-invisible) =====
create table public.bootstrap_admin_config (
  -- Single-row table: the primary key can only ever be TRUE.
  id boolean primary key default true check (id),
  email text not null check (length(trim(email)) between 3 and 320 and position('@' in trim(email)) > 1),
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_by uuid references auth.users (id)
);

-- Clients can never read (or write) the configured email: RLS enabled with
-- NO policies (default deny), and table privileges revoked outright --
-- including any hosted default-ACL grants stamped at creation.
alter table public.bootstrap_admin_config enable row level security;
revoke all on table public.bootstrap_admin_config from public, anon, authenticated;

-- ===== 2. Internal rejection audit =====
-- Rejected bootstrap attempts come from identities that have NO profiles
-- row, so the generic write_audit() -- which stamps actor_id = auth.uid()
-- under audit_logs' FK to profiles -- cannot record them. This internal
-- helper records them as SYSTEM entries (actor_id null), carrying only a
-- reason code and the attempting auth id; never any email address.
create or replace function public.record_bootstrap_rejection(p_uid uuid, p_reason text) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after_data, correlation_id)
  values (null, 'admin_bootstrap_rejected', 'profiles', p_uid::text,
          jsonb_build_object('reason', p_reason), substring(gen_random_uuid()::text, 1, 8));
$$;
revoke execute on function public.record_bootstrap_rejection(uuid, text) from public, anon, authenticated;

-- ===== 3. The bootstrap RPC =====
create or replace function public.bootstrap_first_admin() returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed boolean;
  v_cfg public.bootstrap_admin_config;
  v_name text;
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'permission: אין זהות מאומתת';
  end if;

  -- Lock the one-shot FIRST: every concurrent attempt serializes here, and
  -- the checks below therefore observe a settled state. No row, or an
  -- already-consumed row => the bootstrap window is closed: fail closed
  -- silently (no audit -- this is the steady state every routine
  -- unprovisioned sign-in hits after go-live).
  select * into v_cfg from public.bootstrap_admin_config where id for update;
  if not found or v_cfg.consumed_at is not null then
    return null;
  end if;

  -- One first administrator, ever: an existing ACTIVE system_admin closes
  -- the window even if the one-shot was somehow not stamped.
  if exists (select 1 from public.profiles p where p.role = 'system_admin' and p.active) then
    return null;
  end if;

  -- An identity that already has ANY profile row (active or not) is not a
  -- "first administrator" -- deactivation stays revoked, and active users
  -- have nothing to bootstrap.
  if exists (select 1 from public.profiles p where p.id = v_uid) then
    perform public.record_bootstrap_rejection(v_uid, 'existing_profile');
    return null;
  end if;

  -- Server-side identity verification, identical in kind to the claim RPC:
  -- confirmed email on auth.users AND a google provider identity whose own
  -- email matches the same normalized address. Client input plays no part.
  select lower(trim(u.email)), u.email_confirmed_at is not null
    into v_email, v_confirmed
    from auth.users u where u.id = v_uid;
  if v_email is null or v_email = '' or not v_confirmed then
    perform public.record_bootstrap_rejection(v_uid, 'unconfirmed_identity');
    return null;
  end if;
  if not exists (
    select 1 from auth.identities i
    where i.user_id = v_uid
      and i.provider = 'google'
      and lower(trim(coalesce(i.identity_data->>'email', ''))) = v_email
  ) then
    perform public.record_bootstrap_rejection(v_uid, 'not_google_identity');
    return null;
  end if;

  -- The verified email must match the configured address. The reason code
  -- deliberately does not echo either address.
  if lower(trim(v_cfg.email)) <> v_email then
    perform public.record_bootstrap_rejection(v_uid, 'email_mismatch');
    return null;
  end if;

  -- Display name from the verified Google identity (never client input),
  -- falling back to the email's local part.
  select left(coalesce(
           nullif(trim(i.identity_data->>'full_name'), ''),
           nullif(trim(i.identity_data->>'name'), ''),
           split_part(v_email, '@', 1)
         ), 120)
    into v_name
    from auth.identities i
    where i.user_id = v_uid and i.provider = 'google'
    limit 1;

  -- Exactly one active system_admin profile. The role is a literal: there
  -- is no input through which any other role could be assigned.
  insert into public.profiles (id, full_name, role, active)
  values (v_uid, v_name, 'system_admin', true)
  returning * into v_profile;

  -- Stamp the one-shot inside the same transaction: from this commit on,
  -- bootstrap permanently fails closed.
  update public.bootstrap_admin_config
    set consumed_at = now(), consumed_by = v_uid
    where id;

  perform public.write_audit('admin_bootstrap_completed', 'profiles', v_uid::text, null,
    null, jsonb_build_object('email', v_email, 'profileId', v_uid));
  return v_profile;
end;
$$;

-- ===== 4. Grants =====
-- Callable by any authenticated identity (that is its purpose -- the very
-- first sign-in has no profile); everything else is rejected in the body.
-- anon is rejected at the privilege boundary.
revoke execute on function public.bootstrap_first_admin() from public, anon;
grant execute on function public.bootstrap_first_admin() to authenticated;
