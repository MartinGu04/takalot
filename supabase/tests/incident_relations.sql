-- Tests for migrations 0049-0050 (AVARIA related-incident suggestion +
-- explicit relation model): the mandatory description-similarity gate
-- (never "same system alone"), the negation-mismatch exclusion, cross-
-- system eligibility, the creator-only time-boxed creation-time link, the
-- always-shift_supervisor+ post-creation management RPC (idempotent link/
-- unlink, no false audit events), the bounded manual search, symmetric
-- relation reads, the canonical-ordering/self-link/duplicate-pair schema
-- constraints, and the GRANT boundary (revoked from anon/public, not just
-- internally checked).
--
-- Runs in one transaction and rolls back; leaves the database unchanged.
\pset pager off
begin;

-- ===== Fixtures =====
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000f1', 'admin-f1@test', now()),
  ('00000000-0000-0000-0000-0000000000f2', 'sup-f2@test', now()),
  ('00000000-0000-0000-0000-0000000000f3', 'tech-f3@test', now()),
  ('00000000-0000-0000-0000-0000000000f4', 'viewer-f4@test', now());

insert into profiles (id, full_name, role, active) values
  ('00000000-0000-0000-0000-0000000000f1', 'Admin F1', 'system_admin', true),
  ('00000000-0000-0000-0000-0000000000f2', 'Sup F2', 'shift_supervisor', true),
  ('00000000-0000-0000-0000-0000000000f3', 'Tech F3', 'technician', true),
  ('00000000-0000-0000-0000-0000000000f4', 'Viewer F4', 'viewer', true);

insert into systems (id, name, display_order) values
  ('00000000-0000-0000-0000-00000000f401', 'Sys F Alpha', 1),
  ('00000000-0000-0000-0000-00000000f402', 'Sys F Beta', 2);
insert into locations (id, name, display_order) values ('00000000-0000-0000-0000-00000000f403', 'Loc F', 1);

create temp table results (id serial, test text, result text, detail text);
grant all on results to authenticated, anon;
grant usage, select on sequence results_id_seq to authenticated, anon;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

create or replace function pg_temp.mk(p_desc text, p_system uuid default '00000000-0000-0000-0000-00000000f401', p_domain text default 'equipment')
  returns incidents language plpgsql as $$
declare v incidents;
begin
  v := create_incident_v2(jsonb_build_object(
    'systemId', p_system, 'locationId', '00000000-0000-0000-0000-00000000f403',
    'description', p_desc, 'severity', 'medium', 'operationalImpact', 'i', 'actionsTaken', 'a',
    'status', 'in_progress', 'ownerUserId', current_setting('request.jwt.claim.sub')::uuid,
    'discoveredAt', now(), 'reportedToOps', 'not_required', 'reportedDomain', p_domain));
  return v;
end $$;
grant execute on function pg_temp.mk(text, uuid, text) to authenticated;

do $$
declare
  v_a incidents; v_b incidents; v_c incidents; v_d incidents; v_e incidents;
  v_count int; v_row record; v_corr1 text; v_corr2 text;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f3'); -- technician

  -- =====================================================================
  -- 1-5. suggest_related_incidents: the 5 required worked examples.
  -- =====================================================================
  v_a := pg_temp.mk('מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout בחיבור לשרת');
  v_b := pg_temp.mk('מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout מול השרת'); -- same system+location+domain, high similarity
  v_c := pg_temp.mk('המסך של עמדת הקופה נותק ואין תמונה כלל על הצג הראשי'); -- same system+location, completely different description
  v_d := pg_temp.mk('מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout מול השרת', '00000000-0000-0000-0000-00000000f401', 'software'); -- same system, different domain, similar description
  v_e := pg_temp.mk('יש תקלה, בעיה במערכת, בוצעה בדיקה', '00000000-0000-0000-0000-00000000f402'); -- different system, generic wording

  v_count := 0;
  for v_row in select * from suggest_related_incidents(
    '00000000-0000-0000-0000-00000000f401'::uuid,
    'מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout בחיבור לשרת',
    '00000000-0000-0000-0000-00000000f403'::uuid, 'equipment'::incident_domain)
  loop
    v_count := v_count + 1;
    if v_row.incident_id = v_b.id then
      insert into results (test, result, detail) values
        ('1. same system+location+high similarity is suggested (high band, both facets)',
         case when v_row.same_system and v_row.same_location and v_row.similarity_band = 'high' then 'PASS' else 'FAIL' end,
         format('same_system=%s same_location=%s band=%s', v_row.same_system, v_row.same_location, v_row.similarity_band));
    end if;
  end loop;

  insert into results (test, result, detail) values
    ('3. same system+location+completely different description is REJECTED',
     case when not exists (select 1 from suggest_related_incidents('00000000-0000-0000-0000-00000000f401'::uuid,
       'מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout בחיבור לשרת',
       '00000000-0000-0000-0000-00000000f403'::uuid, 'equipment'::incident_domain) s where s.incident_id = v_c.id)
     then 'PASS' else 'FAIL' end, 'proves structural signals alone never suggest');

  insert into results (test, result, detail) values
    ('4. same system+different domain+similar description is suggested (domain mismatch never disqualifies)',
     case when exists (select 1 from suggest_related_incidents('00000000-0000-0000-0000-00000000f401'::uuid,
       'מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout בחיבור לשרת',
       '00000000-0000-0000-0000-00000000f403'::uuid, 'equipment'::incident_domain) s where s.incident_id = v_d.id and not s.same_domain)
     then 'PASS' else 'FAIL' end, '');

  insert into results (test, result, detail) values
    ('5. different system + nearly identical GENERIC wording is REJECTED (stoplist neutralizes boilerplate)',
     -- Query is from f401's perspective; v_e was created on f402 -- a
     -- genuinely different system, unlike examples 1-4 above.
     case when not exists (select 1 from suggest_related_incidents('00000000-0000-0000-0000-00000000f401'::uuid,
       'קיימת תקלה, יש בעיה במערכת אחרת, גם כאן בוצעה בדיקה',
       '00000000-0000-0000-0000-00000000f403'::uuid, null) s where s.incident_id = v_e.id)
     then 'PASS' else 'FAIL' end, '');

  -- =====================================================================
  -- 6. Negation mismatch is a hard exclusion.
  -- =====================================================================
  declare
    v_neg1 incidents; v_neg2 incidents;
  begin
    v_neg1 := pg_temp.mk('התקשורת בין מערכת בטא לעמדת הבקרה עובדת בצורה תקינה ויציבה לחלוטין', '00000000-0000-0000-0000-00000000f401', 'communications');
    insert into results (test, result, detail) values
      ('6. near-identical text with flipped negation is excluded from suggestions',
       case when not exists (select 1 from suggest_related_incidents('00000000-0000-0000-0000-00000000f401'::uuid,
         'התקשורת בין מערכת בטא לעמדת הבקרה לא עובדת בצורה תקינה ויציבה לחלוטין',
         '00000000-0000-0000-0000-00000000f403'::uuid, null) s where s.incident_id = v_neg1.id)
       then 'PASS' else 'FAIL' end, '');
  end;

  -- =====================================================================
  -- 7. Candidate limit: never more than 3 rows.
  -- =====================================================================
  select count(*) into v_count from suggest_related_incidents(
    '00000000-0000-0000-0000-00000000f401'::uuid,
    'מערכת אלפא אינה מגיבה לפקודות הפעלה, מתקבלת שגיאת timeout בחיבור לשרת',
    '00000000-0000-0000-0000-00000000f403'::uuid, 'equipment'::incident_domain);
  insert into results (test, result, detail) values
    ('7. suggest_related_incidents never returns more than 3 rows', case when v_count <= 3 then 'PASS' else 'FAIL' end, 'count=' || v_count);

  -- =====================================================================
  -- 8-10. link_incident_on_creation: creator-only, time-boxed, idempotent,
  -- self-link rejected, stale target.
  -- =====================================================================
  perform link_incident_on_creation(v_a.id, v_b.id); -- technician links their own just-created incident
  select count(*) into v_count from incident_relations;
  insert into results (test, result, detail) values
    ('8. creator can link their own just-created incident to a suggestion', case when v_count = 1 then 'PASS' else 'FAIL' end, 'count=' || v_count);

  perform link_incident_on_creation(v_a.id, v_b.id); -- retry
  select count(*) into v_count from incident_relations;
  insert into results (test, result, detail) values
    ('9. duplicate link_incident_on_creation call is idempotent (no duplicate row)', case when v_count = 1 then 'PASS' else 'FAIL' end, 'count=' || v_count);

  begin
    perform link_incident_on_creation(v_a.id, v_a.id);
    insert into results (test, result, detail) values ('10. self-link rejected', 'FAIL', 'no exception raised');
  exception when others then
    insert into results (test, result, detail) values
      ('10. self-link rejected', case when sqlerrm like 'validation:%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- A different actor (admin, not the creator) cannot use the creation-time link.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  begin
    perform link_incident_on_creation(v_a.id, v_c.id);
    insert into results (test, result, detail) values ('11. non-creator rejected by link_incident_on_creation', 'FAIL', 'no exception raised');
  exception when others then
    insert into results (test, result, detail) values
      ('11. non-creator rejected by link_incident_on_creation', case when sqlerrm like 'permission:%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- Stale target: close v_b (bypassing the normal close flow's readiness
  -- fields is fine here -- direct UPDATE as postgres-equivalent test
  -- fixture setup, not exercising close_incident itself), then a fresh
  -- incident's creator-link attempt against it must be rejected AND the
  -- fresh incident must remain created.
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f3');
  -- Raw UPDATE as fixture setup, not exercising close_incident itself.
  -- incidents has no client-facing UPDATE policy at all (every mutation
  -- goes through a SECURITY DEFINER RPC) -- role=authenticated would have
  -- this silently matched/updated ZERO rows under RLS, so the fixture
  -- mutation itself runs back under the superuser role, matching how the
  -- schema-constraint tests below already do direct-table fixture setup.
  reset role;
  update incidents set status = 'closed', closed_at = now(), closed_by = '00000000-0000-0000-0000-0000000000f3',
    root_cause = 'x', resolution = 'x', readiness_at_close = 'full' where id = v_b.id;
  set local role authenticated;
  declare v_f incidents;
  begin
    v_f := pg_temp.mk('תקלה נוספת לבדיקת יעד לא פעיל');
    begin
      perform link_incident_on_creation(v_f.id, v_b.id);
      insert into results (test, result, detail) values ('12. stale (closed) target rejected', 'FAIL', 'no exception raised');
    exception when others then
      insert into results (test, result, detail) values
        ('12. stale (closed) target rejected', case when sqlerrm like 'stale_target:%' then 'PASS' else 'FAIL' end, sqlerrm);
    end;
    insert into results (test, result, detail) values
      ('13. the new incident itself is NOT rolled back by a stale-target rejection',
       case when exists (select 1 from incidents where id = v_f.id) then 'PASS' else 'FAIL' end, '');
  end;

  -- =====================================================================
  -- 14-18. manage_incident_relation: shift_supervisor+ only, idempotent,
  -- symmetric audit correlated via metadata.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f2'); -- shift_supervisor
  perform manage_incident_relation(v_a.id, v_c.id, 'link');
  select count(*) into v_count from incident_relations;
  insert into results (test, result, detail) values
    ('14. shift_supervisor can link an arbitrary pair post-creation', case when v_count = 2 then 'PASS' else 'FAIL' end, 'count=' || v_count);

  -- audit_logs has its OWN, stricter SELECT policy (system_admin/
  -- professional_manager only, not shift_supervisor) -- verification reads
  -- run as postgres (bypassing RLS) precisely so this test measures the
  -- RPC's actual write behavior, not this role's own read visibility.
  reset role;
  -- Precise on relatedIncidentId (stored in after_data, not metadata --
  -- metadata only ever carries relationOperationId), not just entity_id:
  -- v_a already has an EARLIER incident_related row from linking to v_b
  -- (test 8), which also matches entity_id = v_a.id but is a different
  -- relationship entirely.
  select count(*) into v_count from audit_logs
    where action = 'incident_related'
      and ((entity_id = v_a.id::text and after_data->>'relatedIncidentId' = v_c.id::text)
        or (entity_id = v_c.id::text and after_data->>'relatedIncidentId' = v_a.id::text));
  insert into results (test, result, detail) values
    ('15. link writes TWO symmetric audit rows (one per incident)', case when v_count = 2 then 'PASS' else 'FAIL' end, 'count=' || v_count);

  select metadata->>'relationOperationId' into v_corr1 from audit_logs where action = 'incident_related' and entity_id = v_a.id::text and after_data->>'relatedIncidentId' = v_c.id::text;
  select metadata->>'relationOperationId' into v_corr2 from audit_logs where action = 'incident_related' and entity_id = v_c.id::text and after_data->>'relatedIncidentId' = v_a.id::text;
  insert into results (test, result, detail) values
    ('16. the two symmetric audit rows share the same relationOperationId', case when v_corr1 = v_corr2 and v_corr1 is not null then 'PASS' else 'FAIL' end, coalesce(v_corr1,'null') || ' vs ' || coalesce(v_corr2,'null'));
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f2');

  perform manage_incident_relation(v_a.id, v_c.id, 'unlink');
  reset role;
  select count(*) into v_count from audit_logs where action = 'incident_unrelated';
  insert into results (test, result, detail) values
    ('17. unlink writes TWO symmetric incident_unrelated audit rows', case when v_count = 2 then 'PASS' else 'FAIL' end, 'count=' || v_count);
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f2');

  perform manage_incident_relation(v_a.id, v_c.id, 'unlink'); -- retry: nothing to remove
  reset role;
  select count(*) into v_count from audit_logs where action = 'incident_unrelated';
  insert into results (test, result, detail) values
    ('18. duplicate unlink is idempotent -- no phantom audit row', case when v_count = 2 then 'PASS' else 'FAIL' end, 'count=' || v_count);
  set local role authenticated;

  -- technician (not is_operational_role()) rejected from manage_incident_relation
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f3');
  begin
    perform manage_incident_relation(v_a.id, v_c.id, 'link');
    insert into results (test, result, detail) values ('19. technician rejected from manage_incident_relation', 'FAIL', 'no exception raised');
  exception when others then
    insert into results (test, result, detail) values
      ('19. technician rejected from manage_incident_relation', case when sqlerrm like 'permission:%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- viewer rejected too
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f4');
  begin
    perform manage_incident_relation(v_a.id, v_c.id, 'link');
    insert into results (test, result, detail) values ('20. viewer rejected from manage_incident_relation', 'FAIL', 'no exception raised');
  exception when others then
    insert into results (test, result, detail) values
      ('20. viewer rejected from manage_incident_relation', case when sqlerrm like 'permission:%' then 'PASS' else 'FAIL' end, sqlerrm);
  end;

  -- =====================================================================
  -- 21-24. search_incidents_for_relation: bounded, role-gated, short query.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f2'); -- shift_supervisor
  select count(*) into v_count from search_incidents_for_relation('אלפא', v_a.id);
  insert into results (test, result, detail) values
    ('21. shift_supervisor search returns matching incidents, excluding the current one', case when v_count >= 1 then 'PASS' else 'FAIL' end, 'count=' || v_count);
  insert into results (test, result, detail) values
    ('22. search excludes the current incident id from its own results',
     case when not exists (select 1 from search_incidents_for_relation('אלפא', v_a.id) s where s.incident_id = v_a.id) then 'PASS' else 'FAIL' end, '');

  select count(*) into v_count from search_incidents_for_relation('a', v_a.id);
  insert into results (test, result, detail) values
    ('23. a 1-character query returns zero rows (meaningful-query requirement)', case when v_count = 0 then 'PASS' else 'FAIL' end, 'count=' || v_count);

  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f3'); -- technician
  select count(*) into v_count from search_incidents_for_relation('אלפא', v_a.id);
  insert into results (test, result, detail) values
    ('24. technician gets zero rows from search_incidents_for_relation (role-gated, not an exception)', case when v_count = 0 then 'PASS' else 'FAIL' end, 'count=' || v_count);

  -- =====================================================================
  -- 25-26. get_incident_relations: symmetric resolution.
  -- =====================================================================
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  select count(*) into v_count from get_incident_relations(v_a.id);
  insert into results (test, result, detail) values
    ('25. get_incident_relations(A) shows B', case when v_count = 1 then 'PASS' else 'FAIL' end, 'count=' || v_count);
  select related_incident_id into v_row from get_incident_relations(v_a.id);
  select count(*) into v_count from get_incident_relations(v_b.id) g where g.related_incident_id = v_a.id;
  insert into results (test, result, detail) values
    ('26. get_incident_relations(B) shows A -- symmetric', case when v_count = 1 then 'PASS' else 'FAIL' end, '');

  reset role;
end $$;

-- =====================================================================
-- 27-30. Schema constraints, tested directly (not just via RPC conflict-
-- avoidance) -- as the definer role, bypassing RLS, to isolate the raw
-- CHECK/UNIQUE constraints themselves.
-- =====================================================================
do $$
declare v_x incidents; v_y incidents;
begin
  perform pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
  v_x := pg_temp.mk('בדיקת אילוצים X');
  v_y := pg_temp.mk('בדיקת אילוצים Y');

  begin
    insert into incident_relations (incident_a_id, incident_b_id, created_by, operation_id)
      values (v_x.id, v_x.id, auth.uid(), gen_random_uuid());
    insert into results (test, result, detail) values ('27. DB rejects a self-referential relation row (CHECK)', 'FAIL', 'no exception');
  exception when others then
    insert into results (test, result, detail) values ('27. DB rejects a self-referential relation row (CHECK)', 'PASS', sqlerrm);
  end;

  begin
    -- Deliberately reversed order (b, a) -- the canonical-order CHECK
    -- (incident_a_id < incident_b_id) must reject whichever of x/y sorts
    -- higher being placed first.
    insert into incident_relations (incident_a_id, incident_b_id, created_by, operation_id)
      values (greatest(v_x.id, v_y.id), least(v_x.id, v_y.id), auth.uid(), gen_random_uuid());
    insert into results (test, result, detail) values ('28. DB rejects a reversed (non-canonical) pair (CHECK)', 'FAIL', 'no exception');
  exception when others then
    insert into results (test, result, detail) values ('28. DB rejects a reversed (non-canonical) pair (CHECK)', 'PASS', sqlerrm);
  end;

  insert into incident_relations (incident_a_id, incident_b_id, created_by, operation_id)
    values (least(v_x.id, v_y.id), greatest(v_x.id, v_y.id), auth.uid(), gen_random_uuid());
  begin
    insert into incident_relations (incident_a_id, incident_b_id, created_by, operation_id)
      values (least(v_x.id, v_y.id), greatest(v_x.id, v_y.id), auth.uid(), gen_random_uuid());
    insert into results (test, result, detail) values ('29. DB rejects a duplicate canonical pair (UNIQUE)', 'FAIL', 'no exception');
  exception when others then
    insert into results (test, result, detail) values ('29. DB rejects a duplicate canonical pair (UNIQUE)', 'PASS', sqlerrm);
  end;

  insert into results (test, result, detail) values
    ('30. operation_id is NOT NULL', case when not exists (select 1 from information_schema.columns
       where table_name = 'incident_relations' and column_name = 'operation_id' and is_nullable = 'YES')
     then 'PASS' else 'FAIL' end, '');
end $$;

-- =====================================================================
-- 31-34. GRANT boundary: revoked from anon/public at the Postgres role
-- level, not merely an internal check -- must fail even before any
-- internal permission logic runs.
-- =====================================================================
do $$
begin
  set local role anon;
  begin
    perform suggest_related_incidents('00000000-0000-0000-0000-00000000f401'::uuid, 'x');
    insert into results (test, result, detail) values ('31. anon role cannot execute suggest_related_incidents (GRANT)', 'FAIL', 'no exception');
  exception when insufficient_privilege then
    insert into results (test, result, detail) values ('31. anon role cannot execute suggest_related_incidents (GRANT)', 'PASS', sqlerrm);
  end;
  begin
    perform link_incident_on_creation('00000000-0000-0000-0000-00000000f401'::uuid, '00000000-0000-0000-0000-00000000f401'::uuid);
    insert into results (test, result, detail) values ('32. anon role cannot execute link_incident_on_creation (GRANT)', 'FAIL', 'no exception');
  exception when insufficient_privilege then
    insert into results (test, result, detail) values ('32. anon role cannot execute link_incident_on_creation (GRANT)', 'PASS', sqlerrm);
  end;
  begin
    perform manage_incident_relation('00000000-0000-0000-0000-00000000f401'::uuid, '00000000-0000-0000-0000-00000000f401'::uuid, 'link');
    insert into results (test, result, detail) values ('33. anon role cannot execute manage_incident_relation (GRANT)', 'FAIL', 'no exception');
  exception when insufficient_privilege then
    insert into results (test, result, detail) values ('33. anon role cannot execute manage_incident_relation (GRANT)', 'PASS', sqlerrm);
  end;
  begin
    perform search_incidents_for_relation('xx', '00000000-0000-0000-0000-00000000f401'::uuid);
    insert into results (test, result, detail) values ('34. anon role cannot execute search_incidents_for_relation (GRANT)', 'FAIL', 'no exception');
  exception when insufficient_privilege then
    insert into results (test, result, detail) values ('34. anon role cannot execute search_incidents_for_relation (GRANT)', 'PASS', sqlerrm);
  end;
  reset role;
end $$;

select * from results order by id;
select case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL ' || count(*) || ' CHECKS PASS'
  else count(*) filter (where result <> 'PASS') || ' FAILURES OF ' || count(*) end as summary
from results;
rollback;
