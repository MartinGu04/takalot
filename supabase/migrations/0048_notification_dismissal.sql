-- AVARIA — clear notifications ("נקה הכל"): per-user, persistent dismissal.
--
-- notifications rows are already strictly per-recipient (0001: one row per
-- user_id, never shared between users -- see notifications_select_own /
-- notifications_mark_read, both scoped to `user_id = auth.uid()`). That
-- rules out a "global hide" flag on the row (which would incorrectly hide a
-- shared row for every recipient) and makes a plain nullable column on the
-- row itself the correct, minimal model: no new join table is needed, the
-- same way `read` already works.
--
-- Semantics: dismissed_at IS NULL means "active" (the current, default state
-- for every existing row -- a new nullable column with no default backfills
-- every row to NULL automatically, so no existing notification is altered
-- or invalidated by this migration). A non-null dismissed_at means the user
-- cleared it; it is preserved (never deleted) but excluded from the default
-- list query going forward, in every repository. This is a distinct concept
-- from `read`: a user can read a notification without clearing it, and
-- clearing implicitly moves it out of every filter tab (הכול / דורש פעולה /
-- עדכונים) at once, since all three read from the same underlying list.
--
-- Explicit transaction, same reasoning as 0024/0035/0041/0042/0044: the
-- repository's psql -f runner uses autocommit, so this keeps a manual/
-- Supabase application all-or-nothing.

begin;

-- =====================================================================
-- 1. notifications.dismissed_at: nullable, no default -- see above. No
--    backfill statement is needed; a freshly added nullable column is NULL
--    on every existing row already.
-- =====================================================================
alter table public.notifications add column dismissed_at timestamptz;

comment on column public.notifications.dismissed_at is
  'Set once the recipient clears it via clear_my_notifications() (נקה הכל). NULL = active (default, every pre-existing row). Independent of `read` -- a notification can be read without being cleared. Rows are never deleted, only excluded from the default list query once set.';

-- Supports the default list query's common shape efficiently: WHERE
-- user_id = ? AND dismissed_at IS NULL ORDER BY created_at DESC. Partial
-- (only active rows) so the index stays small as cleared history
-- accumulates, and additive -- the existing idx_notifications_user index
-- (user_id, read, created_at desc) is untouched, still serving the
-- unread-badge/read-state lookups it always has.
create index idx_notifications_user_active on public.notifications (user_id, created_at desc)
  where dismissed_at is null;

-- =====================================================================
-- 2. clear_my_notifications(): self-only bulk dismissal RPC. Takes no
--    parameters -- the target is always auth.uid(), exactly like
--    set_my_operational_notifications_enabled() (0044) -- so there is no
--    argument a client could pass to dismiss another user's notifications.
--    A plain UPDATE ... WHERE user_id = auth.uid() (rather than relying on
--    the existing notifications_mark_read RLS policy the way the client
--    already does for `read`) makes the scoping unconditional inside the
--    function body itself, not dependent on a client-supplied .eq() filter
--    the RLS policy merely backstops.
-- =====================================================================
create or replace function public.clear_my_notifications() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'permission: אין הרשאה';
  end if;
  update notifications set dismissed_at = now()
    where user_id = auth.uid() and dismissed_at is null;
end;
$$;

revoke execute on function public.clear_my_notifications() from public, anon;
grant execute on function public.clear_my_notifications() to authenticated;

commit;
