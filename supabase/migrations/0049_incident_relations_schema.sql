-- AVARIA -- Related-incident suggestion + explicit relation model, schema half.
--
-- Two independent capabilities land here:
--
-- 1. A description-similarity signal used ONLY as a mandatory gate for the
--    "suggested related incidents" feature on incident creation -- never a
--    standalone match on its own. pg_trgm gives Postgres a language-agnostic
--    fuzzy comparison that -- unlike this schema's existing
--    to_tsvector('simple', search_text) full-text index (0001) -- needs no
--    Hebrew stemmer/tokenizer to handle inflection and the glued (no-space)
--    prepositional prefixes (ב/ל/כ/מ/ו/ש/ה) Hebrew free text is full of.
--    strip_noise_words() removes a small, fixed set of generic operational
--    boilerplate words BEFORE similarity is computed, so two unrelated
--    incidents that merely share "תקלה"/"בעיה"/"מערכת" boilerplate don't
--    score as falsely similar. Negation words (לא/אין/בלי) are deliberately
--    NEVER stripped -- they can reverse a description's meaning entirely.
--
-- 2. incident_relations: one canonical row per explicit A<->B "related"
--    link between two incidents, surfaced identically from both sides. Only
--    ever written by the RPCs in 0050 (SECURITY DEFINER); this migration
--    only owns the schema, RLS, and index.
--
-- Both are purely additive: no existing table, column, RPC, or row is
-- touched. A stale cached frontend build simply never calls anything new
-- here. Wrapped in an explicit transaction (multiple DDL statements that
-- must land together), matching 0046/0047/0048's own stated convention.
begin;

create extension if not exists pg_trgm;

-- Small, fixed, literal stoplist -- deliberately NOT a lookup table (a
-- table read would make this function merely STABLE, not IMMUTABLE, which
-- a GiST expression index below requires for correctness, not just to
-- satisfy CREATE INDEX). Every term here is generic operational boilerplate
-- that carries no discriminative content about what an incident actually
-- is (see migration header + the approved product plan for the full
-- per-term justification). Negation words (לא/אין/בלי) are permanently
-- excluded: stripping them would let "התקשורת עובדת" ("communication is
-- working") and "התקשורת לא עובדת" ("communication is NOT working") --
-- opposite meanings -- collapse toward the same normalized text.
create or replace function strip_noise_words(p_text text) returns text
  language sql immutable as $$
  select trim(regexp_replace(
    regexp_replace(coalesce(p_text, ''), '[֑-ׇ]', '', 'g'), -- strip niqqud (defensive)
    '\y(תקלה|בעיה|מערכת|עובד|עובדת|בדיקה|נבדק|בוצע|בוצעה|כרגע)\y', '', 'g'
  ));
$$;

-- Not stripping לא/אין/בלי keeps them present in the compared text, but
-- verified empirically (see PR discussion) that trigram similarity alone is
-- nearly BLIND to a short inserted/removed negation word: "המערכת עובדת" and
-- "המערכת לא עובדת" still score ~0.9 similar, because the overwhelming
-- majority of character trigrams are shared regardless. Keeping the word
-- present is necessary but not sufficient -- this predicate is the other
-- half: an explicit, deterministic (not semantic/NLP) check for whether
-- ONE description asserts a negation the other doesn't, used by
-- suggest_related_incidents as a hard exclusion (see there for why a
-- numeric penalty was tried and rejected). Still a "lightweight
-- deterministic score" technique, never embeddings/NLP.
--
-- Covers both the bare negation particles (לא/אין/בלי) AND the standard
-- Hebrew "is not" copula forms (אינו/אינה/אינם/אינן) -- verified empirically
-- that a regex covering only לא/אין/בלי under-detects real report Hebrew:
-- this schema's OWN seed incident text (\"מערכת אלפא אינה מגיבה...\") uses
-- אינה, not לא, and missing that form caused a genuinely equivalent
-- affirmative/negated pair to be silently miscompared during verification.
create or replace function has_negation(p_text text) returns boolean
  language sql immutable as $$
  select coalesce(p_text, '') ~ '\y(לא|אין|אינו|אינה|אינם|אינן|בלי)\y';
$$;

-- Partial: only open incidents (status not in ('closed','cancelled')) are
-- ever similarity candidates (see 0050's suggest_related_incidents), so a
-- partial index keeps this small and cheap regardless of how large the
-- closed/cancelled archive grows over the years -- mirrors the existing
-- partial-index convention (idx_incidents_owner_open, 0016;
-- idx_incident_events_operation, 0025). Indexes the SAME normalized
-- expression suggest_related_incidents scores against, so index-accelerated
-- retrieval and final scoring can never disagree about what "the
-- description" means.
create index idx_incidents_description_trgm on incidents
  using gist (strip_noise_words(description) gist_trgm_ops)
  where status not in ('closed', 'cancelled');

create table incident_relations (
  id            uuid primary key default gen_random_uuid(),
  incident_a_id uuid not null references incidents (id),
  incident_b_id uuid not null references incidents (id),
  relation_type text not null default 'related' check (relation_type = 'related'),
  created_by    uuid not null references profiles (id),
  created_at    timestamptz not null default now(),
  -- NOT NULL: every row in this brand-new table is written by exactly one
  -- of 0050's two RPCs, each generating its own fresh operation id at the
  -- top of the function body -- there is no legacy data predating this
  -- table's existence to make nullable-forever necessary here, unlike e.g.
  -- incident_events.operation_id (retrofitted onto years of append-only
  -- history that genuinely cannot be backfilled).
  operation_id  uuid not null,
  constraint incident_relations_not_self check (incident_a_id <> incident_b_id),
  -- Canonical ordering: the RPCs always insert via
  -- (least(a,b), greatest(a,b)), so a reversed duplicate (B,A) is rejected
  -- by this CHECK + the unique constraint below at the database level, not
  -- merely by application-layer trust. One physical row per unordered pair.
  constraint incident_relations_canonical_order check (incident_a_id < incident_b_id),
  constraint incident_relations_unique_pair unique (incident_a_id, incident_b_id)
);
create index idx_incident_relations_a on incident_relations (incident_a_id);
create index idx_incident_relations_b on incident_relations (incident_b_id);

alter table incident_relations enable row level security;
-- Same pattern as every other append-only-style child table (incident_
-- events/updates, incident_closures, ...): everyone who can see incidents
-- can see relations; no insert/update/delete policy at all (writes only
-- through the SECURITY DEFINER RPCs in 0050, which bypass RLS). Unlike
-- those tables, deliberately NO reject_mutation() trigger -- a relation
-- must be genuinely removable (unlink), and there is no update path at
-- all (no policy, no grant), so only DELETE needs to stay reachable, and
-- only via the RPCs.
create policy incident_relations_select on incident_relations for select using (is_active_member());
revoke all on incident_relations from public, anon, authenticated;
grant select on incident_relations to authenticated;

commit;
