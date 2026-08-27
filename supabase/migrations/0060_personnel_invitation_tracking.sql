-- AVARIA -- invitation-email tracking for pre-provisioned personnel.
--
-- Purely additive: three new columns on public.pending_personnel plus two
-- new SECURITY DEFINER RPCs that let an authorized Edge Function (a) read
-- the recipient details it needs to send an invitation email, under the
-- exact same role-ceiling check create_pending_personnel already enforces,
-- and (b) record the outcome of that attempt afterward. Nothing here
-- changes create_pending_personnel/update_pending_personnel/
-- cancel_pending_personnel/claim_pending_personnel: registering, editing,
-- cancelling, and claiming a pending entry all behave exactly as before.
-- Every existing row gets invitation_status = 'not_sent' by the column
-- default -- no existing pending entry is treated as already invited, and
-- no existing profile/claimed/cancelled/expired row is touched at all.
--
-- Deliberately NOT a database trigger + pg_net dispatch (contrast
-- send-push-notification, 0054): sending an invitation is a rare,
-- admin-initiated action with a human waiting on the result (the
-- personnel page needs to tell the admin, in the same request/response
-- round trip, whether the email actually went out) -- not a high-volume
-- background broadcast. The Edge Function is invoked directly by the
-- client (functions.invoke), exactly like delete-user (0013): it forwards
-- the caller's own JWT so every check below runs as the real caller, and
-- only the outbound email-provider call is genuinely server-only.

-- ===== 1. Schema =====
create type public.pending_personnel_invitation_status as enum ('not_sent', 'sent', 'failed');

alter table public.pending_personnel
  add column invitation_status public.pending_personnel_invitation_status not null default 'not_sent',
  add column invitation_sent_at timestamptz,
  add column invitation_last_error text;

comment on column public.pending_personnel.invitation_status is
  'Outcome of the most recent invitation-email attempt for this entry: not_sent (never attempted, or a resend is in flight), sent (last attempt succeeded), failed (last attempt failed -- see invitation_last_error). Written only by record_pending_personnel_invitation_result. Purely informational -- never affects claim_pending_personnel, which authorizes access solely from the pending row''s email/role, regardless of invitation_status.';
comment on column public.pending_personnel.invitation_sent_at is
  'When the most recent SUCCESSFUL invitation-email attempt completed. Null if never successfully sent. Not cleared by a later failed resend attempt -- it always reflects the last known-good send.';
comment on column public.pending_personnel.invitation_last_error is
  'Safe, human-readable (Hebrew) explanation of the most recent FAILED attempt, shown to admins on the personnel page. Never raw provider/HTTP error text (see send-invitation-email Edge Function). Cleared on the next successful send.';

-- ===== 2. Read step: who to email, and is this caller allowed to =====
-- Read-only (no row lock, no state change) -- the actual email send is an
-- external HTTP call the database must never hold a lock across. Enforces
-- the SAME role-ceiling rule as creating the entry in the first place
-- (role_ceiling_allows_assign, 0008): whoever may register a person in a
-- given role is exactly who may (re)send that person's invitation --
-- never a client-supplied role or id, only the caller's own resolved
-- my_role() against the target row's actual, stored role. Only a live,
-- still-pending entry is a valid invitation target -- an already-claimed
-- person needs no invitation, and a cancelled/expired one must not get one.
create or replace function public.get_pending_personnel_invitation_target(p_id uuid) returns public.pending_personnel
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.app_role := public.my_role();
  v_row public.pending_personnel;
begin
  select * into v_row from public.pending_personnel where id = p_id;
  if not found then
    raise exception 'not_found: הרישום לא נמצא';
  end if;
  if v_role is null or not public.role_ceiling_allows_assign(v_role, v_row.role) then
    raise exception 'permission: אין הרשאה לשלוח הזמנה לרישום זה';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'validation: ניתן לשלוח הזמנה רק לרישום הממתין להתחברות';
  end if;
  return v_row;
end;
$$;

-- ===== 3. Write step: record what actually happened =====
-- Re-validates the SAME ceiling independently (never trusts that the read
-- step above ran moments earlier in the same request) -- a genuinely
-- separate privileged write, exactly like every other pair of read/write
-- RPCs in this schema. Deliberately does NOT require status = 'pending'
-- here: recording the outcome of an attempt that was authorized and
-- already made must never itself fail just because the entry's status
-- moved on (e.g. claimed) in the moments the email was in flight -- this
-- is bookkeeping about the attempt, not a new grant of anything.
create or replace function public.record_pending_personnel_invitation_result(
  p_id uuid, p_status public.pending_personnel_invitation_status, p_error text
) returns public.pending_personnel
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.app_role := public.my_role();
  v_row public.pending_personnel;
  v_safe_error text := nullif(trim(coalesce(p_error, '')), '');
begin
  if p_status = 'not_sent' then
    raise exception 'validation: לא ניתן לרשום תוצאה כ"לא נשלחה"';
  end if;
  select * into v_row from public.pending_personnel where id = p_id for update;
  if not found then
    raise exception 'not_found: הרישום לא נמצא';
  end if;
  if v_role is null or not public.role_ceiling_allows_assign(v_role, v_row.role) then
    raise exception 'permission: אין הרשאה לעדכן סטטוס הזמנה לרישום זה';
  end if;

  update public.pending_personnel set
    invitation_status = p_status,
    invitation_sent_at = case when p_status = 'sent' then now() else invitation_sent_at end,
    invitation_last_error = case when p_status = 'sent' then null else left(coalesce(v_safe_error, 'שגיאה לא ידועה'), 500) end,
    updated_at = now()
    where id = p_id
    returning * into v_row;

  perform public.write_audit(
    case when p_status = 'sent' then 'personnel_invitation_sent' else 'personnel_invitation_failed' end,
    'pending_personnel', p_id::text, null, null,
    jsonb_build_object('email', v_row.email, 'status', p_status)
  );
  return v_row;
end;
$$;

revoke execute on function public.get_pending_personnel_invitation_target(uuid) from public, anon;
revoke execute on function public.record_pending_personnel_invitation_result(uuid, public.pending_personnel_invitation_status, text) from public, anon;
grant execute on function public.get_pending_personnel_invitation_target(uuid) to authenticated;
grant execute on function public.record_pending_personnel_invitation_result(uuid, public.pending_personnel_invitation_status, text) to authenticated;

-- ===== 4. Surface invitation_status on the unified personnel listing =====
-- list_personnel()'s column set changes (a new trailing column), which
-- Postgres does not allow via a plain CREATE OR REPLACE on a function
-- returning TABLE (...) -- the old signature is dropped and the function
-- recreated with the additional column. Body is otherwise byte-for-byte
-- identical to 0034's definition (which added avatar_url) with one more
-- trailing column. 'linked' rows always report null (a claimed/active/
-- inactive profile has no invitation concept -- it is a real account
-- already).
drop function public.list_personnel();

create function public.list_personnel() returns table (
  kind text,
  id uuid,
  full_name text,
  email text,
  role public.app_role,
  state text,
  created_at timestamptz,
  avatar_url text,
  invitation_status public.pending_personnel_invitation_status
)
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() is null
     or public.my_role() not in ('shift_supervisor', 'professional_manager', 'system_admin') then
    raise exception 'permission: אין הרשאה לצפות ברשימת כוח האדם';
  end if;
  return query
    select 'pending'::text, pp.id, pp.full_name, pp.email, pp.role, 'pending'::text, pp.created_at,
      null::text, pp.invitation_status
    from public.pending_personnel pp
    where pp.status = 'pending' and (pp.expires_at is null or pp.expires_at > now())
    union all
    select 'linked'::text, p.id, p.full_name, lower(trim(u.email)), p.role,
      case when p.active then 'active' else 'inactive' end, p.created_at,
      p.avatar_url, null::public.pending_personnel_invitation_status
    from public.profiles p
    left join auth.users u on u.id = p.id
    order by 1, 7 desc;
end;
$$;

revoke execute on function public.list_personnel() from public, anon;
grant execute on function public.list_personnel() to authenticated;
