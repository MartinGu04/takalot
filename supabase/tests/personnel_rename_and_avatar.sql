-- Tests for migration 0034 (personnel renaming + avatar persistence):
--  1. admin_set_user_name: happy path on an active linked profile, audited
--     as 'user_renamed'.
--  2. admin_set_user_name: happy path on an INACTIVE linked profile.
--  3. admin_set_user_name: self-rename is ALLOWED for the three personnel-
--     manager roles (shift_supervisor / professional_manager /
--     system_admin) but BLOCKED for technician and viewer, who may never
--     rename anyone including themselves.
--  4. admin_set_user_name: role-ceiling rejection (shift_supervisor cannot
--     rename a professional_manager) -- for managing SOMEONE ELSE only.
--  5. admin_set_user_name: a tombstoned (deleted) profile is rejected.
--  6. admin_set_user_name: validation -- blank, too short (1 char), too
--     long (61 chars), an embedded newline and an embedded control
--     character are all rejected; ordinary Unicode display names --
--     Hebrew with parentheses, and English with a hyphen and apostrophe --
--     are accepted (the old narrow character allowlist is gone).
--  7. rename_pending_personnel: happy path on a pending entry.
--  8. rename_pending_personnel: role-ceiling rejection.
--  9. rename_pending_personnel: only a status='pending' entry can be renamed
--     (a cancelled entry is rejected).
--  9b. rename_pending_personnel: the same validation rules as
--      admin_set_user_name -- blank and embedded-newline rejected, a
--      Hebrew name with parentheses accepted.
--  10. Pending-edited-name survives claim: renaming a pending entry, then
--      claiming it as that identity, produces a profile with the RENAMED
--      value -- not the original.
--  11. A manually admin-renamed profile is never reverted by a later
--      "login": re-calling claim_pending_personnel() for an identity that
--      already has a profile returns the EXISTING profile untouched (the
--      RPC never rewrites full_name once the profile exists).
--  12. set_own_avatar_url: a signed-in identity can set/clear only their
--      OWN avatar_url; a malformed value (not http(s)) is rejected; a
--      caller with no profile yet is a safe no-op (no row created).
--  13. list_personnel() surfaces avatar_url for linked profiles and always
--      null for pending entries.
--  14. Grant matrix: anon has no EXECUTE on any of the three new
--      functions; authenticated does.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000c1', 'admin@test', now()),
  ('00000000-0000-0000-0000-0000000000c2', 'manager@test', now()),
  ('00000000-0000-0000-0000-0000000000c3', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000c4', 'tech-active@test', now()),
  ('00000000-0000-0000-0000-0000000000c5', 'tech-inactive@test', now()),
  ('00000000-0000-0000-0000-0000000000c6', 'tech-deleted@test', now()),
  ('00000000-0000-0000-0000-0000000000c7', 'viewer@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000c1', 'Admin', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000c2', 'Manager', 'professional_manager', true),
  ('00000000-0000-0000-0000-0000000000c3', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000c4', 'Tech Active', 'technician', true),
  ('00000000-0000-0000-0000-0000000000c5', 'Tech Inactive', 'technician', false),
  ('00000000-0000-0000-0000-0000000000c6', 'Tech Deleted', 'technician', false),
  ('00000000-0000-0000-0000-0000000000c7', 'Viewer', 'viewer', true);

update profiles set deleted_at = now(), deleted_by = '00000000-0000-0000-0000-0000000000c1'
  where id = '00000000-0000-0000-0000-0000000000c6';

-- Pending entries for the rename-pending tests.
insert into pending_personnel (id, full_name, email, role, status, created_by) values
  ('00000000-0000-0000-0000-00000000d101', 'Old Pending Name', 'pending-tech@test', 'technician',
    'pending', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-00000000d102', 'Ceiling Test', 'pending-mgr@test', 'professional_manager',
    'pending', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-00000000d103', 'Cancelled Entry', 'pending-cancelled@test', 'technician',
    'pending', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-00000000d104', 'Claim Test Original', 'claimtest@test', 'technician',
    'pending', '00000000-0000-0000-0000-0000000000c1');
update pending_personnel
  set status = 'cancelled', cancelled_by = '00000000-0000-0000-0000-0000000000c1', cancelled_at = now()
  where id = '00000000-0000-0000-0000-00000000d103';

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;

do $$
declare
  v_name text;
  v_audit_count int;
  v_avatar text;
  v_full_name text;
  v_profile_id uuid;
  v_identity_id uuid := '00000000-0000-0000-0000-00000000e201';
begin
  -- ===== 1. admin_set_user_name: happy path (active) =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c3'); -- supervisor
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', 'Tech Renamed');
    insert into results (test, result, detail) values ('supervisor renames active technician: succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('supervisor renames active technician: succeeds', 'FAIL', sqlerrm);
  end;
  reset role;
  select full_name into v_name from profiles where id = '00000000-0000-0000-0000-0000000000c4';
  insert into results (test, result, detail) values
    ('active technician name updated', case when v_name = 'Tech Renamed' then 'PASS' else 'FAIL' end, coalesce(v_name, 'null'));
  select count(*) into v_audit_count from audit_logs where action = 'user_renamed' and entity_id = '00000000-0000-0000-0000-0000000000c4';
  insert into results (test, result, detail) values
    ('rename is audited as user_renamed', case when v_audit_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_audit_count);

  -- ===== 2. admin_set_user_name: happy path (inactive) =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1'); -- admin
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c5', 'Inactive Renamed');
    insert into results (test, result, detail) values ('admin renames inactive technician: succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('admin renames inactive technician: succeeds', 'FAIL', sqlerrm);
  end;
  reset role;
  select full_name into v_name from profiles where id = '00000000-0000-0000-0000-0000000000c5';
  insert into results (test, result, detail) values
    ('inactive technician name updated', case when v_name = 'Inactive Renamed' then 'PASS' else 'FAIL' end, coalesce(v_name, 'null'));

  -- ===== 3. self-rename: allowed for personnel-manager roles, blocked for
  -- technician/viewer =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1'); -- system_admin
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c1', 'Admin Self Renamed');
    insert into results (test, result, detail) values ('system_admin can rename themselves', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('system_admin can rename themselves', 'FAIL', sqlerrm);
  end;
  reset role;
  select full_name into v_name from profiles where id = '00000000-0000-0000-0000-0000000000c1';
  insert into results (test, result, detail) values
    ('system_admin self-rename persisted', case when v_name = 'Admin Self Renamed' then 'PASS' else 'FAIL' end, coalesce(v_name, 'null'));
  select count(*) into v_audit_count from audit_logs where action = 'user_renamed' and entity_id = '00000000-0000-0000-0000-0000000000c1';
  insert into results (test, result, detail) values
    ('system_admin self-rename is audited', case when v_audit_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_audit_count);

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c2'); -- professional_manager
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c2', 'Manager Self Renamed');
    insert into results (test, result, detail) values ('professional_manager can rename themselves', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('professional_manager can rename themselves', 'FAIL', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c3'); -- shift_supervisor
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c3', 'Supervisor Self Renamed');
    insert into results (test, result, detail) values ('shift_supervisor can rename themselves', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('shift_supervisor can rename themselves', 'FAIL', sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c4'); -- technician
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', 'Tech Self Renamed');
    insert into results (test, result, detail) values ('technician cannot rename themselves', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('technician cannot rename themselves',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c7'); -- viewer
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c7', 'Viewer Self Renamed');
    insert into results (test, result, detail) values ('viewer cannot rename themselves', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('viewer cannot rename themselves',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- Technician/viewer also still cannot rename anyone ELSE (unchanged
  -- behavior -- their ceiling was always empty).
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c4'); -- technician
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c7', 'Should Not Work');
    insert into results (test, result, detail) values ('technician cannot rename another user', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('technician cannot rename another user',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 4. role-ceiling rejection =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c3'); -- supervisor
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c2', 'Manager Renamed'); -- professional_manager, above ceiling
    insert into results (test, result, detail) values ('shift_supervisor cannot rename professional_manager', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('shift_supervisor cannot rename professional_manager',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 5. tombstoned profile rejected =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c6', 'Ghost Renamed');
    insert into results (test, result, detail) values ('cannot rename a deleted (tombstoned) profile', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('cannot rename a deleted (tombstoned) profile',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 6. validation =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', '   ');
    insert into results (test, result, detail) values ('blank name rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('blank name rejected',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', 'א');
    insert into results (test, result, detail) values ('1-character name rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('1-character name rejected',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', repeat('א', 61));
    insert into results (test, result, detail) values ('61-character name rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('61-character name rejected',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', E'Name\nWith Newline');
    insert into results (test, result, detail) values ('embedded newline rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('embedded newline rejected',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', E'Name\tWith Tab');
    insert into results (test, result, detail) values ('embedded control character (tab) rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('embedded control character (tab) rejected',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', 'משה כהן');
    insert into results (test, result, detail) values ('normal Hebrew name accepted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('normal Hebrew name accepted', 'FAIL', sqlerrm);
  end;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', 'עומר פרץ (דמו)');
    insert into results (test, result, detail) values ('Hebrew name with parentheses accepted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('Hebrew name with parentheses accepted', 'FAIL', sqlerrm);
  end;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', 'Martin Gusin');
    insert into results (test, result, detail) values ('plain English name accepted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('plain English name accepted', 'FAIL', sqlerrm);
  end;
  begin
    perform admin_set_user_name('00000000-0000-0000-0000-0000000000c4', 'Mary-Jane O''Neil');
    insert into results (test, result, detail) values ('hyphen + apostrophe name accepted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('hyphen + apostrophe name accepted', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 7. rename_pending_personnel: happy path =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c3'); -- supervisor, within ceiling for technician
  set local role authenticated;
  begin
    perform rename_pending_personnel('00000000-0000-0000-0000-00000000d101', 'New Pending Name');
    insert into results (test, result, detail) values ('supervisor renames pending technician entry: succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('supervisor renames pending technician entry: succeeds', 'FAIL', sqlerrm);
  end;
  reset role;
  select full_name into v_name from pending_personnel where id = '00000000-0000-0000-0000-00000000d101';
  insert into results (test, result, detail) values
    ('pending entry name updated', case when v_name = 'New Pending Name' then 'PASS' else 'FAIL' end, coalesce(v_name, 'null'));
  select count(*) into v_audit_count from audit_logs where action = 'personnel_pending_renamed' and entity_id = '00000000-0000-0000-0000-00000000d101';
  insert into results (test, result, detail) values
    ('pending rename is audited', case when v_audit_count = 1 then 'PASS' else 'FAIL' end, 'rows=' || v_audit_count);

  -- ===== 8. rename_pending_personnel: role-ceiling rejection =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c3'); -- supervisor cannot reach professional_manager entries
  set local role authenticated;
  begin
    perform rename_pending_personnel('00000000-0000-0000-0000-00000000d102', 'Should Not Work');
    insert into results (test, result, detail) values ('supervisor cannot rename a professional_manager pending entry', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('supervisor cannot rename a professional_manager pending entry',
      case when sqlerrm like 'permission%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 9. rename_pending_personnel: only pending status =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform rename_pending_personnel('00000000-0000-0000-0000-00000000d103', 'Should Not Work Either');
    insert into results (test, result, detail) values ('cancelled pending entry cannot be renamed', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('cancelled pending entry cannot be renamed',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- ===== 9b. rename_pending_personnel: validation mirrors admin_set_user_name =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  begin
    perform rename_pending_personnel('00000000-0000-0000-0000-00000000d101', '  ');
    insert into results (test, result, detail) values ('pending rename: blank name rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('pending rename: blank name rejected',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform rename_pending_personnel('00000000-0000-0000-0000-00000000d101', E'Broken\nName');
    insert into results (test, result, detail) values ('pending rename: embedded newline rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('pending rename: embedded newline rejected',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  begin
    perform rename_pending_personnel('00000000-0000-0000-0000-00000000d101', 'עומר פרץ (דמו)');
    insert into results (test, result, detail) values ('pending rename: Hebrew name with parentheses accepted', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('pending rename: Hebrew name with parentheses accepted', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 10. Pending-edited-name survives claim =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  perform rename_pending_personnel('00000000-0000-0000-0000-00000000d104', 'Claim Test Renamed');
  reset role;

  insert into auth.users (id, email, email_confirmed_at) values (v_identity_id, 'claimtest@test', now());
  insert into auth.identities (user_id, provider, identity_data)
  values (v_identity_id, 'google', jsonb_build_object('email', 'claimtest@test'));

  perform pg_temp.as_user(v_identity_id);
  set local role authenticated;
  begin
    select full_name into v_full_name from claim_pending_personnel();
    insert into results (test, result, detail) values
      ('claiming a renamed pending entry uses the RENAMED name',
        case when v_full_name = 'Claim Test Renamed' then 'PASS' else 'FAIL' end, coalesce(v_full_name, 'null'));
  exception when others then
    insert into results (test, result, detail) values ('claiming a renamed pending entry uses the RENAMED name', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 11. Manually renamed profile survives a later "login" (re-claim) =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  perform admin_set_user_name(v_identity_id, 'Manually Edited By Admin');
  reset role;

  perform pg_temp.as_user(v_identity_id);
  set local role authenticated;
  begin
    select full_name into v_full_name from claim_pending_personnel();
    insert into results (test, result, detail) values
      ('a later re-claim (login) never reverts a manually admin-edited name',
        case when v_full_name = 'Manually Edited By Admin' then 'PASS' else 'FAIL' end, coalesce(v_full_name, 'null'));
  exception when others then
    insert into results (test, result, detail) values ('a later re-claim (login) never reverts a manually admin-edited name', 'FAIL', sqlerrm);
  end;
  reset role;

  -- ===== 12. set_own_avatar_url =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c4');
  set local role authenticated;
  begin
    perform set_own_avatar_url('https://lh3.googleusercontent.com/pic.jpg');
    insert into results (test, result, detail) values ('caller sets own avatar_url: succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('caller sets own avatar_url: succeeds', 'FAIL', sqlerrm);
  end;
  reset role;
  select avatar_url into v_avatar from profiles where id = '00000000-0000-0000-0000-0000000000c4';
  insert into results (test, result, detail) values
    ('own avatar_url persisted', case when v_avatar = 'https://lh3.googleusercontent.com/pic.jpg' then 'PASS' else 'FAIL' end, coalesce(v_avatar, 'null'));
  select avatar_url into v_avatar from profiles where id = '00000000-0000-0000-0000-0000000000c5';
  insert into results (test, result, detail) values
    ('another profile''s avatar_url is untouched', case when v_avatar is null then 'PASS' else 'FAIL' end, coalesce(v_avatar, 'null'));

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c4');
  set local role authenticated;
  begin
    perform set_own_avatar_url('javascript:alert(1)');
    insert into results (test, result, detail) values ('non-http(s) avatar url rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('non-http(s) avatar url rejected',
      case when sqlerrm like 'validation%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  -- Clearing back to null is allowed.
  begin
    perform set_own_avatar_url(null);
    insert into results (test, result, detail) values ('clearing own avatar_url to null: succeeds', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('clearing own avatar_url to null: succeeds', 'FAIL', sqlerrm);
  end;
  reset role;

  -- A profile-less authenticated identity: safe no-op, no row created.
  perform pg_temp.as_user('00000000-0000-0000-0000-00000000e299');
  set local role authenticated;
  begin
    perform set_own_avatar_url('https://example.com/x.png');
    insert into results (test, result, detail) values ('profile-less caller: safe no-op', 'PASS', '');
  exception when others then
    insert into results (test, result, detail) values ('profile-less caller: safe no-op', 'FAIL', sqlerrm);
  end;
  reset role;
  select count(*) into v_audit_count from profiles where id = '00000000-0000-0000-0000-00000000e299';
  insert into results (test, result, detail) values
    ('profile-less caller creates no profile row', case when v_audit_count = 0 then 'PASS' else 'FAIL' end, 'rows=' || v_audit_count);

  -- ===== 13. list_personnel() exposes avatar_url =====
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  set local role authenticated;
  perform set_own_avatar_url('https://lh3.googleusercontent.com/admin-pic.jpg');
  reset role;

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000c3'); -- supervisor, authorized to list
  set local role authenticated;
  select avatar_url into v_avatar from list_personnel() where id = '00000000-0000-0000-0000-0000000000c1';
  insert into results (test, result, detail) values
    ('list_personnel exposes avatar_url for a linked profile',
      case when v_avatar = 'https://lh3.googleusercontent.com/admin-pic.jpg' then 'PASS' else 'FAIL' end, coalesce(v_avatar, 'null'));
  select avatar_url into v_avatar from list_personnel() where kind = 'pending' and id = '00000000-0000-0000-0000-00000000d101';
  insert into results (test, result, detail) values
    ('list_personnel always returns null avatar_url for a pending entry',
      case when v_avatar is null then 'PASS' else 'FAIL' end, coalesce(v_avatar, 'null'));
  reset role;
end $$;

-- ===== 14. Grant matrix =====
insert into results (test, result, detail)
select 'anon has no EXECUTE on admin_set_user_name',
  case when not has_function_privilege('anon', 'admin_set_user_name(uuid, text)', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
insert into results (test, result, detail)
select 'authenticated has EXECUTE on admin_set_user_name',
  case when has_function_privilege('authenticated', 'admin_set_user_name(uuid, text)', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
insert into results (test, result, detail)
select 'anon has no EXECUTE on rename_pending_personnel',
  case when not has_function_privilege('anon', 'rename_pending_personnel(uuid, text)', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
insert into results (test, result, detail)
select 'authenticated has EXECUTE on rename_pending_personnel',
  case when has_function_privilege('authenticated', 'rename_pending_personnel(uuid, text)', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
insert into results (test, result, detail)
select 'anon has no EXECUTE on set_own_avatar_url',
  case when not has_function_privilege('anon', 'set_own_avatar_url(text)', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
insert into results (test, result, detail)
select 'authenticated has EXECUTE on set_own_avatar_url',
  case when has_function_privilege('authenticated', 'set_own_avatar_url(text)', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
insert into results (test, result, detail)
select 'anon has no EXECUTE on list_personnel',
  case when not has_function_privilege('anon', 'list_personnel()', 'EXECUTE') then 'PASS' else 'FAIL' end, '';
insert into results (test, result, detail)
select 'authenticated has EXECUTE on list_personnel',
  case when has_function_privilege('authenticated', 'list_personnel()', 'EXECUTE') then 'PASS' else 'FAIL' end, '';

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
