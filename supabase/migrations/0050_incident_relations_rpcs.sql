-- AVARIA -- Related-incident suggestion + explicit relation model, RPC half.
-- Depends on 0049 (strip_noise_words, incident_relations, the trigram index).
--
-- Four SECURITY DEFINER functions:
--   suggest_related_incidents    -- read-only, any active member (creation-time suggestions)
--   link_incident_on_creation    -- the creator of a JUST-created incident, time-boxed
--   manage_incident_relation     -- shift_supervisor and above, link/unlink, no time bound
--   search_incidents_for_relation -- shift_supervisor and above, bounded manual search
--
-- Every EXECUTE grant is explicit: revoked from public/anon, granted only to
-- authenticated -- authorization itself still happens inside each function
-- body (my_role()/is_operational_role()/creator+window checks), matching
-- every other RPC in this schema.
--
-- Explicit transaction: several CREATE FUNCTION + GRANT statements that
-- should land together, same convention as 0049.
begin;

-- ===========================================================================
-- suggest_related_incidents
-- ===========================================================================
-- Required parameters first, defaulted ones last (Postgres requires this
-- ordering). p_system_id/p_description are the two creation-form fields
-- that gate whether the frontend calls this at all (see the approved
-- product plan's creation-UX trigger conditions); p_location_id/
-- p_reported_domain are genuinely optional -- the trigger can fire before
-- either is filled in.
--
-- Candidate retrieval: the mandatory description-similarity gate is
-- evaluated FIRST, via the trigram '%' operator (index-accelerated through
-- idx_incidents_description_trgm, using a LOCAL similarity_threshold so the
-- index-accelerated filter and the explicit sim >= 0.30 check below can
-- never drift apart or depend on a session-level GUC left over from
-- somewhere else). System/location/domain eligibility and the final
-- ranking formula are then applied across that COMPLETE qualifying set --
-- never an arbitrary row-count LIMIT before ranking, which could silently
-- drop a candidate that ranks in the top 3 only once its structural
-- corroboration is added in. LIMIT 3 is applied last, after ranking.
create or replace function suggest_related_incidents(
  p_system_id uuid,
  p_description text,
  p_location_id uuid default null,
  p_reported_domain incident_domain default null
) returns table (
  incident_id uuid,
  number text,
  severity text,
  status text,
  system_id uuid,
  location_id uuid,
  description text,
  same_system boolean,
  same_location boolean,
  same_domain boolean,
  similarity_band text
) language plpgsql security definer set search_path = public as $$
declare
  v_norm_query text := strip_noise_words(p_description);
begin
  if not is_active_member() then raise exception 'permission: אין הרשאה'; end if;

  -- Transaction-scoped only (SET LOCAL): never leaks to any other query on
  -- this connection/pooled session.
  perform set_config('pg_trgm.similarity_threshold', '0.30', true);

  return query
    with qualifying as (
      select i.id, i.number, i.severity::text, i.status::text, i.system_id, i.location_id,
             i.description, i.reported_domain,
             similarity(strip_noise_words(i.description), v_norm_query) as sim,
             has_negation(i.description) as neg
      from incidents i
      where i.status not in ('closed', 'cancelled')
        and strip_noise_words(i.description) % v_norm_query
    )
    select
      q.id, q.number, q.severity, q.status, q.system_id, q.location_id, q.description,
      coalesce(q.system_id = p_system_id, false) as same_system,
      coalesce(q.location_id = p_location_id, false) as same_location,
      (q.reported_domain is not null and p_reported_domain is not null
         and q.reported_domain = p_reported_domain) as same_domain,
      case when q.sim >= 0.55 then 'high' else 'medium' end as similarity_band
    from qualifying q
    where q.sim >= 0.30
      -- Negation mismatch is a hard exclusion, not a numeric penalty: a
      -- fixed-amount subtraction was tried and verified (empirically, on
      -- long near-identical strings differing only by an inserted לא) to
      -- be nowhere near enough -- trigram similarity on two 60+ character
      -- descriptions that differ by one short word stays well above 0.9,
      -- so no defensible penalty magnitude reliably pulls it back under
      -- the gate for every description length. A hard exclusion has no
      -- such calibration problem and matches this feature's own stated
      -- priority: avoiding a noisy/wrong suggestion matters more than
      -- catching every possible match.
      and q.neg = has_negation(p_description)
      -- Cross-system eligibility: a DIFFERENT system is only ever
      -- considered when description similarity clears the HIGH band --
      -- otherwise this is exactly the "different system, generic
      -- wording" noise case the product design must reject. Same system
      -- has no such extra bar once the mandatory gate above is cleared.
      and (q.system_id = p_system_id or q.sim >= 0.55)
    order by
      q.sim * 100
      + (case when q.location_id = p_location_id then 10 else 0 end)
      + (case
           when q.reported_domain is null or p_reported_domain is null then 0
           when q.reported_domain = p_reported_domain then 5
           else -3
         end) desc
    limit 3;
end;
$$;
revoke execute on function suggest_related_incidents(uuid, text, uuid, incident_domain) from public, anon;
grant execute on function suggest_related_incidents(uuid, text, uuid, incident_domain) to authenticated;

-- ===========================================================================
-- link_incident_on_creation
-- ===========================================================================
-- Genuinely time-boxed, not merely UI-hidden: the caller must be the
-- creator of p_new_incident_id AND still within 10 minutes of that
-- incident's created_at. Past that window this raises 'permission:' exactly
-- like anyone else who isn't shift_supervisor+ -- there is no standing
-- "I created it once" permission. Post-creation relation management (add
-- OR remove, on any incident) is manage_incident_relation below, always
-- shift_supervisor+, never a creator exception.
create or replace function link_incident_on_creation(p_new_incident_id uuid, p_related_incident_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_incident incidents;
  v_related incidents;
  v_a uuid; v_b uuid;
  v_operation_id uuid := gen_random_uuid();
  v_relation_id uuid;
begin
  if not is_active_member() then raise exception 'permission: אין הרשאה'; end if;
  if p_new_incident_id = p_related_incident_id then
    raise exception 'validation: לא ניתן לקשר תקלה לעצמה';
  end if;

  select * into v_incident from incidents where id = p_new_incident_id;
  if not found then raise exception 'not_found: התקלה לא נמצאה'; end if;
  if v_incident.created_by <> auth.uid() then
    raise exception 'permission: ניתן לקשר רק תקלה שפתחת בעצמך, בסמוך לפתיחתה';
  end if;
  if now() - v_incident.created_at > interval '10 minutes' then
    raise exception 'permission: החלון לקישור אוטומטי בעת פתיחת התקלה הסתיים -- ניתן לבקש מאחמ״ש קישור ידני';
  end if;

  select * into v_related from incidents where id = p_related_incident_id;
  if not found then raise exception 'not_found: התקלה המקושרת לא נמצאה'; end if;
  -- Re-check the suggestion's own assumption at link time: the world may
  -- have moved between the suggestion being shown and this call (another
  -- user closed/cancelled it). The already-created incident is never
  -- affected either way -- only the relation is skipped.
  if not is_incident_open(v_related.status) then
    raise exception 'stale_target: התקלה המקושרת כבר אינה פעילה -- ניתן לבקש מאחמ״ש קישור ידני מאוחר יותר';
  end if;

  select least(p_new_incident_id, p_related_incident_id), greatest(p_new_incident_id, p_related_incident_id)
    into v_a, v_b;

  insert into incident_relations (incident_a_id, incident_b_id, created_by, operation_id)
    values (v_a, v_b, auth.uid(), v_operation_id)
    on conflict (incident_a_id, incident_b_id) do nothing
    returning id into v_relation_id;
  if not found then
    -- Already linked (e.g. a retried call): idempotent success, no
    -- duplicate audit row.
    return;
  end if;

  perform write_audit(p_action => 'incident_related', p_entity_type => 'incident',
    p_entity_id => p_new_incident_id::text, p_incident_number => v_incident.number,
    p_after => jsonb_build_object('relatedIncidentId', p_related_incident_id, 'relatedIncidentNumber', v_related.number),
    p_entity_label => v_incident.number, p_summary => 'קושרה לתקלה ' || v_related.number,
    -- write_audit's own signature is untouched (no new parameter): the
    -- shared v_operation_id travels in metadata instead, so these two rows
    -- are traceable as one relation operation without risking any
    -- ambiguous overload for write_audit's existing callers.
    p_metadata => jsonb_build_object('relationOperationId', v_operation_id));
  perform write_audit(p_action => 'incident_related', p_entity_type => 'incident',
    p_entity_id => p_related_incident_id::text, p_incident_number => v_related.number,
    p_after => jsonb_build_object('relatedIncidentId', p_new_incident_id, 'relatedIncidentNumber', v_incident.number),
    p_entity_label => v_related.number, p_summary => 'קושרה לתקלה ' || v_incident.number,
    p_metadata => jsonb_build_object('relationOperationId', v_operation_id));
end;
$$;
revoke execute on function link_incident_on_creation(uuid, uuid) from public, anon;
grant execute on function link_incident_on_creation(uuid, uuid) to authenticated;

-- ===========================================================================
-- manage_incident_relation
-- ===========================================================================
-- shift_supervisor and above only, no creator/time exception, ever -- both
-- adding AND removing a relation after creation. Intentionally does NOT
-- re-check either incident's current status: a supervisor deliberately
-- linking to (or unlinking from) a closed/cancelled incident is exactly
-- the manual-search use case the product design allows on purpose.
create or replace function manage_incident_relation(p_incident_id uuid, p_related_incident_id uuid, p_action text)
  returns void language plpgsql security definer set search_path = public as $$
declare
  v_incident incidents;
  v_related incidents;
  v_a uuid; v_b uuid;
  v_operation_id uuid := gen_random_uuid();
  v_relation_id uuid;
begin
  if not is_operational_role() then raise exception 'permission: אין הרשאה לנהל תקלות קשורות'; end if;
  if p_action not in ('link', 'unlink') then raise exception 'validation: פעולה לא תקינה'; end if;
  if p_incident_id = p_related_incident_id then
    raise exception 'validation: לא ניתן לקשר תקלה לעצמה';
  end if;

  select * into v_incident from incidents where id = p_incident_id;
  if not found then raise exception 'not_found: התקלה לא נמצאה'; end if;
  select * into v_related from incidents where id = p_related_incident_id;
  if not found then raise exception 'not_found: התקלה המקושרת לא נמצאה'; end if;

  select least(p_incident_id, p_related_incident_id), greatest(p_incident_id, p_related_incident_id)
    into v_a, v_b;

  if p_action = 'link' then
    insert into incident_relations (incident_a_id, incident_b_id, created_by, operation_id)
      values (v_a, v_b, auth.uid(), v_operation_id)
      on conflict (incident_a_id, incident_b_id) do nothing
      returning id into v_relation_id;
    if not found then return; end if; -- already linked: idempotent success

    perform write_audit(p_action => 'incident_related', p_entity_type => 'incident',
      p_entity_id => p_incident_id::text, p_incident_number => v_incident.number,
      p_after => jsonb_build_object('relatedIncidentId', p_related_incident_id, 'relatedIncidentNumber', v_related.number),
      p_entity_label => v_incident.number, p_summary => 'קושרה לתקלה ' || v_related.number,
      p_metadata => jsonb_build_object('relationOperationId', v_operation_id));
    perform write_audit(p_action => 'incident_related', p_entity_type => 'incident',
      p_entity_id => p_related_incident_id::text, p_incident_number => v_related.number,
      p_after => jsonb_build_object('relatedIncidentId', p_incident_id, 'relatedIncidentNumber', v_incident.number),
      p_entity_label => v_related.number, p_summary => 'קושרה לתקלה ' || v_incident.number,
      p_metadata => jsonb_build_object('relationOperationId', v_operation_id));
  else -- unlink
    delete from incident_relations where incident_a_id = v_a and incident_b_id = v_b returning id into v_relation_id;
    if not found then return; end if; -- nothing to remove: idempotent success

    perform write_audit(p_action => 'incident_unrelated', p_entity_type => 'incident',
      p_entity_id => p_incident_id::text, p_incident_number => v_incident.number,
      p_before => jsonb_build_object('relatedIncidentId', p_related_incident_id, 'relatedIncidentNumber', v_related.number),
      p_entity_label => v_incident.number, p_summary => 'הוסר קישור לתקלה ' || v_related.number,
      p_metadata => jsonb_build_object('relationOperationId', v_operation_id));
    perform write_audit(p_action => 'incident_unrelated', p_entity_type => 'incident',
      p_entity_id => p_related_incident_id::text, p_incident_number => v_related.number,
      p_before => jsonb_build_object('relatedIncidentId', p_incident_id, 'relatedIncidentNumber', v_incident.number),
      p_entity_label => v_related.number, p_summary => 'הוסר קישור לתקלה ' || v_incident.number,
      p_metadata => jsonb_build_object('relationOperationId', v_operation_id));
  end if;
end;
$$;
revoke execute on function manage_incident_relation(uuid, uuid, text) from public, anon;
grant execute on function manage_incident_relation(uuid, uuid, text) to authenticated;

-- ===========================================================================
-- search_incidents_for_relation
-- ===========================================================================
-- Bounded, permission-checked manual search for the "קישור תקלה קשורה"
-- picker -- shift_supervisor+ only, enforced HERE (not left to RLS on the
-- shared incidents table, which everyone with view_all_incidents already
-- reads from elsewhere and must stay untouched). Deliberately allows
-- closed/cancelled incidents (no status filter) -- manual linking is
-- allowed to intentionally reach them, unlike the suggestion RPC above.
create or replace function search_incidents_for_relation(p_query text, p_exclude_incident_id uuid)
  returns table (
    incident_id uuid, number text, severity text, status text,
    system_id uuid, location_id uuid, description text
  ) language sql security definer set search_path = public as $$
  select i.id, i.number, i.severity::text, i.status::text, i.system_id, i.location_id, i.description
  from incidents i
  where is_operational_role()
    and length(trim(coalesce(p_query, ''))) >= 2
    and i.id <> p_exclude_incident_id
    and (i.number ilike '%' || p_query || '%' or i.search_text ilike '%' || p_query || '%')
  order by i.created_at desc
  limit 10;
$$;
revoke execute on function search_incidents_for_relation(text, uuid) from public, anon;
grant execute on function search_incidents_for_relation(text, uuid) to authenticated;

-- ===========================================================================
-- get_incident_relations
-- ===========================================================================
-- Read path for the "תקלות קשורות" detail-page section -- any active
-- member (same bar as reading the incident itself). Resolves "the other
-- side" server-side: incident_relations is symmetric by construction
-- (one canonical row per pair, see 0049), and incident_a_id/incident_b_id
-- are two separate foreign keys to the same incidents table, which makes a
-- plain PostgREST embed ambiguous/fragile to rely on from the client --
-- a small dedicated RPC is the robust, explicit alternative already used
-- everywhere else in this schema for anything needing custom shaping.
create or replace function get_incident_relations(p_incident_id uuid)
  returns table (
    id uuid,
    related_incident_id uuid,
    related_number text,
    related_severity text,
    related_status text,
    related_system_id uuid,
    related_location_id uuid,
    related_description text,
    created_by uuid,
    created_at timestamptz
  ) language sql security definer set search_path = public as $$
  select
    r.id,
    case when r.incident_a_id = p_incident_id then r.incident_b_id else r.incident_a_id end,
    i.number, i.severity::text, i.status::text, i.system_id, i.location_id, i.description,
    r.created_by, r.created_at
  from incident_relations r
  join incidents i
    on i.id = case when r.incident_a_id = p_incident_id then r.incident_b_id else r.incident_a_id end
  where is_active_member()
    and (r.incident_a_id = p_incident_id or r.incident_b_id = p_incident_id)
  order by r.created_at desc;
$$;
revoke execute on function get_incident_relations(uuid) from public, anon;
grant execute on function get_incident_relations(uuid) to authenticated;

commit;
