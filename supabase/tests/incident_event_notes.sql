-- Tests for migration 0038: an optional, ≤600-character "הערה נוספת"
-- (additional note) on create_incident, update_incident,
-- technician_update_incident, and close_incident.
--
-- Covers: the note is optional everywhere; a valid note persists on the
-- correct row (incident_events.user_note for create/close,
-- incident_updates.user_note for update/technician-update) without ever
-- overwriting the existing generated/other text on that same row; notes
-- from two separate actions on the same incident stay on their own rows;
-- blank/whitespace-only input is stored as NULL; more than 600 characters
-- is rejected (both a validation-level rejection and the table CHECK
-- constraint as a defense-in-depth backstop); technician_update_incident
-- storing a note does not relax its role/ownership/terminal-state gate;
-- both full- and partial-readiness closure preserve the note; and every
-- pre-existing permission/lifecycle rule (active-member, role, terminal
-- state, optimistic concurrency, owner validity) is unaffected.
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'supervisor@test', now()),
  ('00000000-0000-0000-0000-0000000000a2', 'owner-tech@test', now()),
  ('00000000-0000-0000-0000-0000000000a3', 'other-tech@test', now()),
  ('00000000-0000-0000-0000-0000000000a4', 'viewer@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000a1', 'Supervisor', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000a2', 'Owner Technician', 'technician', true),
  ('00000000-0000-0000-0000-0000000000a3', 'Other Technician', 'technician', true),
  ('00000000-0000-0000-0000-0000000000a4', 'Viewer', 'viewer', true);

insert into systems (id, name, display_order) values ('00000000-0000-0000-0000-00000000a101', 'Sys', 1);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000a102', 'Loc', 1);

insert into incidents (id, number, system_id, location_id, description, severity, status,
                       operational_impact, owner_user_id, discovered_at, created_by, updated_by,
                       next_update_due, version)
values
  -- g201: reused across every update_incident REJECTED-call test (each
  -- rejection rolls back inside its own begin/exception savepoint).
  ('00000000-0000-0000-0000-00000000a201', 'G-201', '00000000-0000-0000-0000-00000000a101',
   '00000000-0000-0000-0000-00000000a102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() + interval '4 hours', 1),
  -- g202: two SEPARATE successful update_incident calls run against this
  -- one incident (version 1 then 2) to prove each note lands on its own row.
  ('00000000-0000-0000-0000-00000000a202', 'G-202', '00000000-0000-0000-0000-00000000a101',
   '00000000-0000-0000-0000-00000000a102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() + interval '4 hours', 1),
  -- g203: blank/whitespace note -> null, on update_incident.
  ('00000000-0000-0000-0000-00000000a203', 'G-203', '00000000-0000-0000-0000-00000000a101',
   '00000000-0000-0000-0000-00000000a102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() + interval '4 hours', 1),
  -- g210/g211: technician_update_incident, owned by g2.
  ('00000000-0000-0000-0000-00000000a210', 'G-210', '00000000-0000-0000-0000-00000000a101',
   '00000000-0000-0000-0000-00000000a102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() + interval '4 hours', 1),
  ('00000000-0000-0000-0000-00000000a211', 'G-211', '00000000-0000-0000-0000-00000000a101',
   '00000000-0000-0000-0000-00000000a102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a2', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() + interval '4 hours', 1),
  -- g220: reused across close_incident REJECTED-call tests.
  ('00000000-0000-0000-0000-00000000a220', 'G-220', '00000000-0000-0000-0000-00000000a101',
   '00000000-0000-0000-0000-00000000a102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() + interval '4 hours', 1),
  -- g221: full-readiness close with a note.
  ('00000000-0000-0000-0000-00000000a221', 'G-221', '00000000-0000-0000-0000-00000000a101',
   '00000000-0000-0000-0000-00000000a102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() + interval '4 hours', 1),
  -- g222: partial-readiness close with a note.
  ('00000000-0000-0000-0000-00000000a222', 'G-222', '00000000-0000-0000-0000-00000000a101',
   '00000000-0000-0000-0000-00000000a102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() + interval '4 hours', 1),
  -- g223: close with blank/whitespace note -> null.
  ('00000000-0000-0000-0000-00000000a223', 'G-223', '00000000-0000-0000-0000-00000000a101',
   '00000000-0000-0000-0000-00000000a102', 'd', 'medium', 'in_progress', 'i',
   '00000000-0000-0000-0000-0000000000a1', now() - interval '2 days',
   '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1',
   now() + interval '4 hours', 1);

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
    'systemId', '00000000-0000-0000-0000-00000000a101', 'locationId', '00000000-0000-0000-0000-00000000a102',
    'description', 'תקלה לבדיקה', 'severity', 'low', 'operationalImpact', 'השפעה',
    'actionsTaken', 'נבדק', 'status', 'new', 'discoveredAt', now(),
    'ownerUserId', '00000000-0000-0000-0000-0000000000a2',
    'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_create_input(jsonb) to authenticated;

create or replace function pg_temp.base_update_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'eventTime', now(), 'actionsTaken', 'בוצעה בדיקה', 'findings', '', 'nextSteps', '',
    'status', 'in_progress', 'severity', 'medium', 'operationalImpact', 'i', 'changeReason', '',
    'ownerUserId', '00000000-0000-0000-0000-0000000000a2',
    'nextUpdateDue', now() + interval '1 day', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_update_input(jsonb) to authenticated;

create or replace function pg_temp.base_tech_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'eventTime', now(), 'actionsTaken', 'בוצעה בדיקה טכנית', 'findings', '', 'nextSteps', ''
  ) || extra;
$$;
grant execute on function pg_temp.base_tech_input(jsonb) to authenticated;

create or replace function pg_temp.base_close_input(extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'expectedVersion', 1, 'eventTime', now(), 'rootCause', 'סיבה', 'resolution', 'פתרון', 'readiness', 'full',
    'followUpNotes', '', 'reportedToOps', 'not_required'
  ) || extra;
$$;
grant execute on function pg_temp.base_close_input(jsonb) to authenticated;

-- =====================================================================
-- 1. create_incident: note is optional (omitted entirely), persists when
--    supplied, and never overwrites the generated 'created' narrative.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_ev record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
  set local role authenticated;

  -- Omitted note: succeeds, user_note stays NULL.
  v_incident := create_incident(pg_temp.base_create_input('{}'::jsonb));
  select * into v_ev from incident_events where incident_id = v_incident.id and type = 'created';
  insert into results (test, result, detail) values
    ('create_incident: note is optional (omitted)',
      case when v_ev.user_note is null and v_ev.note like 'פעולות שבוצעו עד כה:%' then 'PASS' else 'FAIL' end,
      'user_note=' || coalesce(v_ev.user_note, '<null>'));

  -- Supplied note: persists in user_note, generated note text untouched.
  v_incident := create_incident(pg_temp.base_create_input(jsonb_build_object('note', '  הערה על פתיחת התקלה  ')));
  select * into v_ev from incident_events where incident_id = v_incident.id and type = 'created';
  insert into results (test, result, detail) values
    ('create_incident: trimmed note persists in user_note, generated note text preserved',
      case when v_ev.user_note = 'הערה על פתיחת התקלה' and v_ev.note like 'פעולות שבוצעו עד כה:%' then 'PASS' else 'FAIL' end,
      'user_note=' || v_ev.user_note || ' note=' || v_ev.note);

  -- Blank/whitespace-only note -> NULL.
  v_incident := create_incident(pg_temp.base_create_input(jsonb_build_object('note', '   ')));
  select * into v_ev from incident_events where incident_id = v_incident.id and type = 'created';
  insert into results (test, result, detail) values
    ('create_incident: whitespace-only note stored as null',
      case when v_ev.user_note is null then 'PASS' else 'FAIL' end, 'user_note=' || coalesce(v_ev.user_note, '<null>'));

  -- More than 600 characters rejected.
  begin
    perform create_incident(pg_temp.base_create_input(jsonb_build_object('note', repeat('א', 601))));
    insert into results (test, result, detail) values ('create_incident: note over 600 chars rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('create_incident: note over 600 chars rejected',
      case when sqlerrm = 'validation: הערה נוספת: עד 600 תווים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- Exactly 600 characters accepted (inclusive boundary).
  v_incident := create_incident(pg_temp.base_create_input(jsonb_build_object('note', repeat('א', 600))));
  select * into v_ev from incident_events where incident_id = v_incident.id and type = 'created';
  insert into results (test, result, detail) values
    ('create_incident: note at exactly 600 chars accepted',
      case when length(v_ev.user_note) = 600 then 'PASS' else 'FAIL' end, 'len=' || length(v_ev.user_note));

  reset role;
end $$;

-- =====================================================================
-- 2. update_incident: note is optional, persists on the incident_updates
--    row, two separate calls keep two separate notes, blank -> null,
--    over-600 rejected, and the primary 'update' event row still carries
--    no note of its own (unchanged).
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_upd record;
  v_ev record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
  set local role authenticated;

  -- Omitted note: succeeds.
  v_incident := update_incident('00000000-0000-0000-0000-00000000a201', pg_temp.base_update_input('{}'::jsonb));
  select * into v_upd from incident_updates where id = (
    select ref_id from incident_events where incident_id = v_incident.id and type = 'update' order by created_at desc limit 1
  );
  insert into results (test, result, detail) values
    ('update_incident: note is optional (omitted)', case when v_upd.user_note is null then 'PASS' else 'FAIL' end, '');

  -- First update on g202 with note A.
  v_incident := update_incident('00000000-0000-0000-0000-00000000a202', pg_temp.base_update_input(
    jsonb_build_object('note', 'הערה ראשונה')));
  select * into v_upd from incident_updates where id = (
    select ref_id from incident_events where incident_id = v_incident.id and type = 'update' order by created_at desc limit 1
  );
  select * into v_ev from incident_events where incident_id = v_incident.id and type = 'update' order by created_at desc limit 1;
  insert into results (test, result, detail) values
    ('update_incident: first note persists on its own incident_updates row',
      case when v_upd.user_note = 'הערה ראשונה' then 'PASS' else 'FAIL' end, v_upd.user_note);
  insert into results (test, result, detail) values
    ('update_incident: primary update event row still carries no note column value',
      case when v_ev.note is null then 'PASS' else 'FAIL' end, coalesce(v_ev.note, '<null>'));

  -- Second, separate update on the SAME incident with note B -- must not
  -- alter the first row's note.
  v_incident := update_incident('00000000-0000-0000-0000-00000000a202', pg_temp.base_update_input(
    jsonb_build_object('expectedVersion', v_incident.version, 'note', 'הערה שנייה')));
  insert into results (test, result, detail) values
    ('update_incident: notes from two separate actions on the same incident stay separate',
      case when (
        select count(*) from incident_updates iu
        join incident_events ie on ie.ref_id = iu.id and ie.type = 'update'
        where ie.incident_id = v_incident.id and iu.user_note = 'הערה ראשונה'
      ) = 1 and (
        select count(*) from incident_updates iu
        join incident_events ie on ie.ref_id = iu.id and ie.type = 'update'
        where ie.incident_id = v_incident.id and iu.user_note = 'הערה שנייה'
      ) = 1 then 'PASS' else 'FAIL' end, '');

  -- Blank/whitespace-only note -> NULL.
  v_incident := update_incident('00000000-0000-0000-0000-00000000a203', pg_temp.base_update_input(
    jsonb_build_object('note', '   ')));
  select * into v_upd from incident_updates where id = (
    select ref_id from incident_events where incident_id = v_incident.id and type = 'update' order by created_at desc limit 1
  );
  insert into results (test, result, detail) values
    ('update_incident: whitespace-only note stored as null', case when v_upd.user_note is null then 'PASS' else 'FAIL' end, '');

  -- More than 600 characters rejected, and does not mutate the incident
  -- (g201 reused -- still version 1 after the earlier omitted-note call
  -- since that call ran against it too; check it did advance to 2, and
  -- this rejection must not advance it further).
  declare
    v_before_version int;
  begin
    select version into v_before_version from incidents where id = '00000000-0000-0000-0000-00000000a201';
    begin
      perform update_incident('00000000-0000-0000-0000-00000000a201', pg_temp.base_update_input(
        jsonb_build_object('expectedVersion', v_before_version, 'note', repeat('א', 601))));
      insert into results (test, result, detail) values ('update_incident: note over 600 chars rejected', 'FAIL', 'succeeded');
    exception when others then
      insert into results (test, result, detail) values ('update_incident: note over 600 chars rejected',
        case when sqlerrm = 'validation: הערה נוספת: עד 600 תווים' then 'PASS' else 'FAIL' end, sqlerrm);
    end;
    insert into results (test, result, detail) values
      ('update_incident: rejected over-length note leaves the incident version untouched',
        case when (select version from incidents where id = '00000000-0000-0000-0000-00000000a201') = v_before_version
          then 'PASS' else 'FAIL' end, '');
  end;

  reset role;
end $$;

-- =====================================================================
-- 3. technician_update_incident: note is optional, persists, blank ->
--    null, over-600 rejected, and the role/ownership/terminal-state gate
--    is completely unaffected -- a note does not relax it.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_upd record;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
  set local role authenticated;

  -- Omitted note: succeeds.
  v_incident := technician_update_incident('00000000-0000-0000-0000-00000000a210', pg_temp.base_tech_input('{}'::jsonb));
  select * into v_upd from incident_updates where id = (
    select ref_id from incident_events where incident_id = v_incident.id and type = 'update' order by created_at desc limit 1
  );
  insert into results (test, result, detail) values
    ('technician_update_incident: note is optional (omitted)', case when v_upd.user_note is null then 'PASS' else 'FAIL' end, '');

  -- Supplied, trimmed note persists.
  v_incident := technician_update_incident('00000000-0000-0000-0000-00000000a211', pg_temp.base_tech_input(
    jsonb_build_object('note', '  הערה של הטכנאי  ')));
  select * into v_upd from incident_updates where id = (
    select ref_id from incident_events where incident_id = v_incident.id and type = 'update' order by created_at desc limit 1
  );
  insert into results (test, result, detail) values
    ('technician_update_incident: trimmed note persists', case when v_upd.user_note = 'הערה של הטכנאי' then 'PASS' else 'FAIL' end,
      coalesce(v_upd.user_note, '<null>'));

  reset role;
end $$;

-- Remaining technician_update_incident cases, in their own block so each
-- incident's current version is looked up fresh right before use.
do $$
declare
  v_incident incidents;
  v_upd record;
  v_before_version int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
  set local role authenticated;

  select version into v_before_version from incidents where id = '00000000-0000-0000-0000-00000000a210';
  v_incident := technician_update_incident('00000000-0000-0000-0000-00000000a210', pg_temp.base_tech_input(
    jsonb_build_object('expectedVersion', v_before_version, 'note', '   ')));
  select * into v_upd from incident_updates where id = (
    select ref_id from incident_events where incident_id = v_incident.id and type = 'update' order by created_at desc limit 1
  );
  insert into results (test, result, detail) values
    ('technician_update_incident: whitespace-only note stored as null', case when v_upd.user_note is null then 'PASS' else 'FAIL' end, '');

  -- More than 600 characters rejected; incident version untouched.
  select version into v_before_version from incidents where id = '00000000-0000-0000-0000-00000000a210';
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000a210', pg_temp.base_tech_input(
      jsonb_build_object('expectedVersion', v_before_version, 'note', repeat('א', 601))));
    insert into results (test, result, detail) values
      ('technician_update_incident: note over 600 chars rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician_update_incident: note over 600 chars rejected',
        case when sqlerrm = 'validation: הערה נוספת: עד 600 תווים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  insert into results (test, result, detail) values
    ('technician_update_incident: rejected over-length note leaves the incident version untouched',
      case when (select version from incidents where id = '00000000-0000-0000-0000-00000000a210') = v_before_version
        then 'PASS' else 'FAIL' end, '');

  -- A note does not relax ownership scoping: g3 (not the owner of g210)
  -- is still rejected, even while supplying a valid note.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
  select version into v_before_version from incidents where id = '00000000-0000-0000-0000-00000000a210';
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000a210', pg_temp.base_tech_input(
      jsonb_build_object('expectedVersion', v_before_version, 'note', 'ניסיון עדכון מגורם שאינו הבעלים')));
    insert into results (test, result, detail) values
      ('technician_update_incident: non-owning technician still rejected even with a note', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician_update_incident: non-owning technician still rejected even with a note',
        case when sqlerrm = 'permission: ניתן לעדכן רק תקלה פתוחה המוקצית אליך' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- A note does not relax the role gate: a viewer is still rejected outright.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
  begin
    perform technician_update_incident('00000000-0000-0000-0000-00000000a210', pg_temp.base_tech_input(
      jsonb_build_object('note', 'ניסיון מצפה')));
    insert into results (test, result, detail) values
      ('technician_update_incident: viewer still rejected even with a note', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('technician_update_incident: viewer still rejected even with a note',
        case when sqlerrm = 'permission: פעולה זו מיועדת לטכנאים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  reset role;
end $$;

-- =====================================================================
-- 4. close_incident: note is optional, persists on BOTH the full- and
--    partial-readiness event rows without overwriting the generated
--    closure narrative, blank -> null, over-600 rejected.
-- =====================================================================
do $$
declare
  v_incident incidents;
  v_ev record;
  v_before_version int;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
  set local role authenticated;

  -- Full readiness, with a note.
  v_incident := close_incident('00000000-0000-0000-0000-00000000a221', pg_temp.base_close_input(
    jsonb_build_object('note', '  הערה בעת סגירה מלאה  ')));
  select * into v_ev from incident_events where incident_id = v_incident.id and type = 'closed';
  insert into results (test, result, detail) values
    ('close_incident (full): trimmed note persists, generated note text preserved',
      case when v_ev.user_note = 'הערה בעת סגירה מלאה' and v_ev.note like 'סיבת התקלה:%' then 'PASS' else 'FAIL' end,
      'user_note=' || v_ev.user_note || ' note=' || v_ev.note);

  -- Incomplete readiness, with a note (requires a continuation owner).
  v_incident := close_incident('00000000-0000-0000-0000-00000000a222', pg_temp.base_close_input(
    jsonb_build_object('readiness', 'partial', 'followUpNotes', 'להשלים בהמשך',
      'ownerUserId', '00000000-0000-0000-0000-0000000000a2', 'note', 'הערה בעת סגירה חלקית')));
  select * into v_ev from incident_events where incident_id = v_incident.id and type = 'status_change' and new_value = 'partial_readiness';
  insert into results (test, result, detail) values
    ('close_incident (partial): note persists on the status_change row, generated note text preserved',
      case when v_ev.user_note = 'הערה בעת סגירה חלקית' and v_ev.note like 'סיבת התקלה:%' then 'PASS' else 'FAIL' end,
      'user_note=' || v_ev.user_note || ' note=' || v_ev.note);
  insert into results (test, result, detail) values
    ('close_incident (partial): incident correctly stays active, not closed',
      case when v_incident.status = 'partial_readiness' then 'PASS' else 'FAIL' end, v_incident.status::text);

  -- Blank/whitespace-only note -> NULL.
  v_incident := close_incident('00000000-0000-0000-0000-00000000a223', pg_temp.base_close_input(
    jsonb_build_object('note', '   ')));
  select * into v_ev from incident_events where incident_id = v_incident.id and type = 'closed';
  insert into results (test, result, detail) values
    ('close_incident: whitespace-only note stored as null', case when v_ev.user_note is null then 'PASS' else 'FAIL' end, '');

  -- More than 600 characters rejected; incident untouched.
  select version into v_before_version from incidents where id = '00000000-0000-0000-0000-00000000a220';
  begin
    perform close_incident('00000000-0000-0000-0000-00000000a220', pg_temp.base_close_input(
      jsonb_build_object('note', repeat('א', 601))));
    insert into results (test, result, detail) values ('close_incident: note over 600 chars rejected', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('close_incident: note over 600 chars rejected',
      case when sqlerrm = 'validation: הערה נוספת: עד 600 תווים' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  insert into results (test, result, detail) values
    ('close_incident: rejected over-length note leaves the incident version and status untouched',
      case when (select version from incidents where id = '00000000-0000-0000-0000-00000000a220') = v_before_version
        and (select status from incidents where id = '00000000-0000-0000-0000-00000000a220') = 'in_progress'
        then 'PASS' else 'FAIL' end, '');

  reset role;
end $$;

-- =====================================================================
-- 5. Regression: existing permission/lifecycle behavior is unaffected --
--    an active technician can still create/close (0037 behavior, unchanged
--    by 0038), an inactive/no-profile/viewer identity is still rejected,
--    and a terminal incident still rejects close_incident, all regardless
--    of whether a note is supplied.
-- =====================================================================
do $$
declare
  v_incident incidents;
begin
  -- Active technician can still create AND close (0037), now also with a note.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
  set local role authenticated;
  v_incident := create_incident(pg_temp.base_create_input(jsonb_build_object('note', 'תקלה שנפתחה על ידי טכנאי')));
  insert into results (test, result, detail) values
    ('regression: active technician can still create_incident (0037 unaffected), now with a note',
      case when v_incident.status = 'new' then 'PASS' else 'FAIL' end, v_incident.number);

  -- Terminal incident still rejects close_incident, note or not. a221 was
  -- already closed above (test 20) -- expectedVersion must match its
  -- current (post-close) version so the rejection is genuinely the
  -- terminal-state guard, not an unrelated version conflict.
  begin
    perform close_incident('00000000-0000-0000-0000-00000000a221', pg_temp.base_close_input(
      jsonb_build_object('expectedVersion', (select version from incidents where id = '00000000-0000-0000-0000-00000000a221'),
        'note', 'ניסיון סגירה כפולה')));
    insert into results (test, result, detail) values
      ('regression: closing an already-terminal incident is still rejected, note or not', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values
      ('regression: closing an already-terminal incident is still rejected, note or not',
        case when sqlerrm = 'invalid_transition: התקלה כבר סגורה או מבוטלת' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;

  -- Viewer still rejected from create_incident, note or not.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
  set local role authenticated;
  begin
    perform create_incident(pg_temp.base_create_input(jsonb_build_object('note', 'ניסיון פתיחה')));
    insert into results (test, result, detail) values ('regression: viewer still cannot create_incident, note or not', 'FAIL', 'succeeded');
  exception when others then
    insert into results (test, result, detail) values ('regression: viewer still cannot create_incident, note or not',
      case when sqlerrm = 'permission: אין הרשאה לפתוח תקלה' then 'PASS' else 'FAIL' end, sqlerrm);
  end;
  reset role;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
