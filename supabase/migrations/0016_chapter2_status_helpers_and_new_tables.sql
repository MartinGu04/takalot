-- מעקב תקלות — forward migration.
-- Chapter 2, PR2 (file 2 of 2): schema only. Helper functions, four new
-- tables, new nullable columns on incidents/incident_updates, constraints
-- (including two composite foreign keys), append-only triggers, RLS
-- policies, and indexes.
--
-- This migration adds NO enum values (those are 0015, already committed
-- before this file runs) and changes NO existing RPC body -- every
-- function created or replaced below is new; nothing pre-existing in
-- 0001-0014 is touched. Every new incidents/incident_updates column is
-- nullable with no default requiring a value, so no historical row is
-- rewritten. Every new CHECK constraint is satisfied vacuously by every
-- row that exists today, either because it lives on a brand-new, empty
-- table, or because it lives on a brand-new nullable column whose value is
-- NULL on every current row (which every constraint below explicitly
-- accepts via an `is null` branch). No hosted database has been touched by
-- this migration as of this commit.

-- =====================================================================
-- 0. Status-taxonomy and severity helper functions
-- =====================================================================
-- Deliberately NOT called by any existing RPC in this migration -- the
-- Chapter 2 audit found `is_incident_status_active` framed too narrowly
-- (it would have wrongly excluded legacy-open statuses from "open" for
-- authorization purposes). Four separate, precisely-scoped concepts:
--   is_incident_terminal        -- {closed, cancelled}
--   is_incident_open            -- every non-terminal status, INCLUDING
--                                   every legacy-open value (new,
--                                   acknowledged, waiting_test, monitoring,
--                                   partial_readiness, resolved_pending_close,
--                                   reopened) -- the one to use for every
--                                   ownership/lifecycle/deactivation guard
--   is_current_workflow_status  -- only the 5 target active statuses --
--                                   for "is this a valid NEW-work target",
--                                   never for authorization
--   is_incident_legacy_status   -- pure classification/labeling
-- These are intentionally left broadly executable (no revoke from
-- anon/authenticated): each is a pure, side-effect-free predicate over an
-- already-public enum value, with no table access and no auth context --
-- unlike the lifecycle RPCs 0005-0007 lock down, calling one of these
-- directly leaks nothing and grants no capability beyond what the enum
-- values themselves already are.
create or replace function is_incident_terminal(p_status incident_status) returns boolean
language sql immutable as $$
  select p_status in ('closed', 'cancelled');
$$;

create or replace function is_incident_open(p_status incident_status) returns boolean
language sql immutable as $$
  select not is_incident_terminal(p_status);
$$;

create or replace function is_current_workflow_status(p_status incident_status) returns boolean
language sql immutable as $$
  select p_status in ('in_progress', 'waiting_external', 'waiting_equipment', 'waiting_information', 'waiting_validation');
$$;

create or replace function is_incident_legacy_status(p_status incident_status) returns boolean
language sql immutable as $$
  select p_status in ('new', 'acknowledged', 'waiting_test', 'monitoring', 'partial_readiness', 'resolved_pending_close', 'reopened');
$$;

-- Ordinal ranking for the severity override-distance rule (0 = most
-- severe). Pure, total function over a 4-value enum -- no default case
-- needed since incident_severity has exactly these four values.
create or replace function severity_rank(p_severity incident_severity) returns int
language sql immutable as $$
  select case p_severity
    when 'critical' then 0
    when 'high' then 1
    when 'medium' then 2
    when 'low' then 3
  end;
$$;

create or replace function severity_level_distance(p_a incident_severity, p_b incident_severity) returns int
language sql immutable as $$
  select abs(severity_rank(p_a) - severity_rank(p_b));
$$;

-- =====================================================================
-- 1. severity_rulesets -- versioned rule storage
-- =====================================================================
-- A reference/configuration table (like systems/locations), NOT an
-- append-only event log: a future admin RPC must be able to flip which
-- version is `active`. Everything else about a published version is
-- permanent history and must never change once created -- enforced below
-- by a selective trigger (allow-active-only), the same pattern this
-- schema already uses for handovers (protect_accepted_handover, 0001),
-- rather than the blanket reject_mutation() used for pure event logs.
create table severity_rulesets (
  id                uuid primary key default gen_random_uuid(),
  version           int not null unique,
  name              text not null check (length(trim(name)) between 1 and 200),
  guiding_questions jsonb not null,
  scoring_config    jsonb not null default '{}'::jsonb,
  active            boolean not null default false,
  published_by      uuid not null references profiles (id),
  published_at      timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

-- At most one active ruleset at a time, DB-enforced.
create unique index idx_severity_rulesets_single_active on severity_rulesets (active) where active;

create or replace function protect_severity_ruleset_definition() returns trigger
language plpgsql as $$
begin
  if new.version is distinct from old.version
     or new.name is distinct from old.name
     or new.guiding_questions is distinct from old.guiding_questions
     or new.scoring_config is distinct from old.scoring_config
     or new.published_by is distinct from old.published_by
     or new.published_at is distinct from old.published_at
     or new.created_at is distinct from old.created_at
  then
    raise exception 'append_only: severity_rulesets definition fields are immutable once created -- only "active" may change';
  end if;
  return new;
end;
$$;

create trigger trg_severity_rulesets_protect_definition
  before update on severity_rulesets
  for each row execute function protect_severity_ruleset_definition();

create trigger trg_severity_rulesets_no_delete
  before delete on severity_rulesets
  for each row execute function reject_mutation();

alter table severity_rulesets enable row level security;
create policy severity_rulesets_select on severity_rulesets for select using (is_active_member());
-- No insert/update/delete policy: writes are RPC-only, and no such RPC
-- exists yet -- this table is empty and inert until a later PR adds one.

-- =====================================================================
-- 2. incident_severity_assessments -- append-only, immutable evidence
-- =====================================================================
create table incident_severity_assessments (
  id                     uuid primary key default gen_random_uuid(),
  incident_id            uuid not null references incidents (id),
  ruleset_version        int not null references severity_rulesets (version),
  answers                jsonb not null,
  recommended_severity   incident_severity not null,
  recommendation_reasons jsonb not null,
  chosen_severity        incident_severity not null,
  override_reason        text check (override_reason is null or length(trim(override_reason)) between 1 and 1000),
  assessed_by            uuid not null references profiles (id),
  recorded_by            uuid not null references profiles (id),
  assessed_at            timestamptz not null default now(),
  recorded_at            timestamptz not null default now(),
  created_at             timestamptz not null default now(),

  -- Explanation required only once chosen and recommended differ by two
  -- or more severity levels; an adjacent (one-level) override, or no
  -- override at all, never requires one (an explanation MAY still be
  -- stored for an adjacent override -- this only ever requires, never
  -- forbids, one).
  constraint severity_override_requires_reason_over_threshold
    check (severity_level_distance(chosen_severity, recommended_severity) < 2
           or (override_reason is not null and length(trim(override_reason)) > 0)),

  -- Referenced-side half of the composite FK from incidents (section 5) --
  -- id is already unique via the primary key; this wider tuple lets
  -- incidents point at ONE exact assessment while the database itself
  -- verifies incident/ruleset/recommendation/chosen-severity all mirror
  -- that exact row, not merely "some assessment exists".
  constraint incident_severity_assessments_current_mirror_unique
    unique (id, incident_id, ruleset_version, recommended_severity, chosen_severity)
);

create index idx_severity_assessments_incident on incident_severity_assessments (incident_id, assessed_at);

alter table incident_severity_assessments enable row level security;
create policy incident_severity_assessments_select on incident_severity_assessments for select using (is_active_member());

create trigger trg_severity_assessments_immutable
  before update or delete on incident_severity_assessments
  for each row execute function reject_mutation();

-- =====================================================================
-- 3. incident_report_events -- structured, repeatable, dual-channel
--    Operations reporting: ops room and ops communications, fully
--    independent processes, both represented by this one table
--    distinguished by `channel`.
-- =====================================================================
create table incident_report_events (
  id                        uuid primary key default gen_random_uuid(),
  incident_id               uuid not null references incidents (id),
  channel                   incident_report_channel not null,
  status                    reported_to_ops not null,  -- yes | no | not_required (enum reused from 0001)
  reported_by_user_id       uuid references profiles (id),
  reported_by_external_name text check (reported_by_external_name is null or length(trim(reported_by_external_name)) between 1 and 120),
  recorded_by               uuid not null references profiles (id),
  event_time                timestamptz not null default now(),  -- when the reporting decision/event occurred; required for every row
  reported_at               timestamptz,                          -- when an actual report was performed; required iff status='yes'
  recorded_at               timestamptz not null default now(),   -- when Nexus recorded this row; always required
  recipient                 text check (recipient is null or length(trim(recipient)) between 1 and 200),
  note                      text check (note is null or length(note) <= 1000),
  created_at                timestamptz not null default now(),

  constraint report_event_performer_exclusive
    check (reported_by_user_id is null or reported_by_external_name is null),

  -- Fully bidirectional on status: 'yes' requires a performer, a
  -- recipient, and an actual reported_at; every other status requires
  -- all three of those to be null (nothing was performed, so nothing to
  -- attribute or time).
  constraint report_event_status_yes_bidirectional
    check (
      (status = 'yes'
        and (reported_by_user_id is not null or reported_by_external_name is not null)
        and recipient is not null and length(trim(recipient)) > 0
        and reported_at is not null)
      or
      (status <> 'yes'
        and reported_by_user_id is null and reported_by_external_name is null
        and recipient is null and reported_at is null)
    )
);

create index idx_incident_report_events_incident on incident_report_events (incident_id, event_time);
create index idx_incident_report_events_channel on incident_report_events (incident_id, channel, event_time);

alter table incident_report_events enable row level security;
create policy incident_report_events_select on incident_report_events for select using (is_active_member());

create trigger trg_incident_report_events_immutable
  before update or delete on incident_report_events
  for each row execute function reject_mutation();

-- =====================================================================
-- 4. incident_status_checks -- append-only status-check lifecycle
--    (scheduled / rescheduled / completed / removed)
-- =====================================================================
create table incident_status_checks (
  id                          uuid primary key default gen_random_uuid(),
  incident_id                 uuid not null references incidents (id),
  kind                         incident_status_check_kind not null,
  due_at                       timestamptz,
  previous_due_at              timestamptz,
  note                         text check (note is null or length(note) <= 1000),
  performed_by_user_id         uuid references profiles (id),
  performed_by_external_name   text check (performed_by_external_name is null or length(trim(performed_by_external_name)) between 1 and 120),
  recorded_by                  uuid not null references profiles (id),
  event_time                   timestamptz not null default now(),
  recorded_at                  timestamptz not null default now(),
  created_at                   timestamptz not null default now(),

  -- Fully bidirectional per kind:
  --   scheduled:   due_at required,     previous_due_at must be null
  --   rescheduled: due_at required,     previous_due_at required
  --   completed:   due_at must be null, previous_due_at required
  --   removed:     due_at must be null, previous_due_at required
  constraint status_check_metadata_bidirectional
    check (
      (kind = 'scheduled'   and due_at is not null and previous_due_at is null)
      or
      (kind = 'rescheduled' and due_at is not null and previous_due_at is not null)
      or
      (kind = 'completed'   and due_at is null     and previous_due_at is not null)
      or
      (kind = 'removed'     and due_at is null     and previous_due_at is not null)
    ),

  constraint status_check_performer_exclusive
    check (performed_by_user_id is null or performed_by_external_name is null),

  -- Documented AND enforced convention: for scheduled/rescheduled/removed
  -- (administrative scheduling decisions), both performer fields may be
  -- null -- meaning the authenticated recorder (recorded_by) IS the
  -- performer of that decision, the same convention incident_updates uses
  -- (section 6). A 'completed' row represents a real review that was
  -- CARRIED OUT and must always name who did it explicitly; the null/null
  -- convention is disallowed for that one kind only.
  constraint status_check_completed_requires_explicit_performer
    check (kind <> 'completed' or performed_by_user_id is not null or performed_by_external_name is not null)
);

create index idx_incident_status_checks_incident on incident_status_checks (incident_id, event_time);

alter table incident_status_checks enable row level security;
create policy incident_status_checks_select on incident_status_checks for select using (is_active_member());

create trigger trg_incident_status_checks_immutable
  before update or delete on incident_status_checks
  for each row execute function reject_mutation();

-- =====================================================================
-- 5. incidents -- new nullable columns + constraints + composite FK
-- =====================================================================
alter table incidents
  add column cancelled_at              timestamptz,
  add column cancelled_by              uuid references profiles (id),
  add column cancellation_reason       text check (cancellation_reason is null or length(trim(cancellation_reason)) between 1 and 2000),
  add column current_severity_assessment_id uuid,
  add column severity_ruleset_version  int references severity_rulesets (version),
  add column severity_recommended      incident_severity,
  add column severity_override_reason  text check (severity_override_reason is null or length(trim(severity_override_reason)) between 1 and 1000),
  add column status_check_due          timestamptz,
  add column workaround_description    text check (workaround_description is null or length(trim(workaround_description)) between 1 and 2000),
  add column closure_justification     text check (closure_justification is null or length(trim(closure_justification)) between 1 and 2000);

-- Cancellation metadata is fully bidirectional: complete iff cancelled,
-- entirely absent otherwise. No partial population in either direction.
alter table incidents
  add constraint incident_cancelled_metadata_bidirectional
    check (
      (status = 'cancelled'
        and cancelled_at is not null
        and cancelled_by is not null
        and cancellation_reason is not null and length(trim(cancellation_reason)) > 0)
      or
      (status <> 'cancelled'
        and cancelled_at is null
        and cancelled_by is null
        and cancellation_reason is null)
    );

-- Provably redundant given the constraint above plus the existing
-- incident_closed_at_only_when_closed (0004) -- status is a single value
-- and can never satisfy both branches at once -- but kept as an explicit,
-- cheap, defense-in-depth check, consistent with how 0004 already layers
-- multiple overlapping guarantees around closure.
alter table incidents
  add constraint incident_not_closed_and_cancelled
    check (not (closed_at is not null and cancelled_at is not null));

-- Current-severity metadata: all-or-none. This is NOT redundant with the
-- composite FK below -- PostgreSQL's default MATCH SIMPLE skips FK
-- validation entirely whenever ANY column in the referencing tuple is
-- null, and current_severity_assessment_id/severity_ruleset_version/
-- severity_recommended are the only nullable columns in that tuple (id and
-- severity are both NOT NULL already) -- so a stray state such as
-- current_severity_assessment_id being null while severity_ruleset_version
-- is populated would NOT be caught by the FK at all. This CHECK is what
-- closes that specific gap.
alter table incidents
  add constraint incident_current_severity_metadata_bidirectional
    check (
      (current_severity_assessment_id is null
        and severity_ruleset_version is null
        and severity_recommended is null
        and severity_override_reason is null)
      or
      (current_severity_assessment_id is not null
        and severity_ruleset_version is not null
        and severity_recommended is not null)
    );

-- Same two-or-more-levels threshold as incident_severity_assessments,
-- applied to the denormalized current-state mirror on incidents itself.
alter table incidents
  add constraint incident_severity_override_reason_required
    check (severity_recommended is null
           or severity_level_distance(severity, severity_recommended) < 2
           or (severity_override_reason is not null and length(trim(severity_override_reason)) > 0));

-- Composite FK: whenever current_severity_assessment_id is set, an
-- assessment row must exist whose id, incident_id, ruleset_version,
-- recommended_severity, and chosen_severity ALL match this incident's own
-- id/severity_ruleset_version/severity_recommended/severity respectively --
-- i.e. the incident's current-severity pointer and its denormalized
-- mirror columns can never drift from the exact assessment record they
-- claim to summarize. Requires no DEFERRABLE and no disabled referential
-- integrity: every existing row has current_severity_assessment_id = NULL
-- (a nullable column just added above with no default), and MATCH SIMPLE
-- skips FK validation for any row with a null in the referencing tuple --
-- so this ADD CONSTRAINT validates cleanly against 100% of current data
-- with zero backfill. For future writes, the required order is: (1)
-- INSERT the assessment row (its own incident_id FK is already satisfied,
-- since the incident already exists); (2) in the same transaction, UPDATE
-- incidents to point current_severity_assessment_id at that new row and
-- set severity_ruleset_version/severity_recommended/severity to the exact
-- same values just written into the assessment -- by construction already
-- matching, so the FK is satisfied immediately, no deferral ever needed.
alter table incidents
  add constraint incidents_current_severity_assessment_fk
    foreign key (current_severity_assessment_id, id, severity_ruleset_version, severity_recommended, severity)
    references incident_severity_assessments (id, incident_id, ruleset_version, recommended_severity, chosen_severity);

-- =====================================================================
-- 6. incident_updates -- performer vs. recorder
-- =====================================================================
-- author_id (existing, NOT NULL, unchanged) keeps its exact current
-- meaning and becomes "recorder". Both new columns nullable; null/null
-- means "performer = recorder = author_id", the correct, zero-backfill
-- interpretation for all existing rows -- exactly the convention
-- incident_status_checks documents and reuses above for its own
-- non-completed kinds.
alter table incident_updates
  add column performed_by_user_id uuid references profiles (id),
  add column performed_by_external_name text check (performed_by_external_name is null or length(trim(performed_by_external_name)) between 1 and 120),
  add constraint incident_update_performer_exclusive
    check (performed_by_user_id is null or performed_by_external_name is null);

-- =====================================================================
-- 7. Supporting indexes
-- =====================================================================
-- Supports a future guard querying "does this profile own any open
-- incident" at scale (open = every non-terminal status, legacy included --
-- written with the literal list, not is_incident_open(), to match this
-- migration's own composite-FK style and the existing literal-predicate
-- convention already used by idx_incidents_next_update/idx_incidents_closed_at
-- in 0001).
create index idx_incidents_owner_open on incidents (owner_user_id)
  where owner_user_id is not null and status not in ('closed', 'cancelled');

-- Supports dashboard/filter queries over open incidents with a status
-- check due. Deliberately scoped to EVERY non-terminal status (including
-- every legacy-open value such as monitoring, partial_readiness, etc.),
-- never narrowed to is_current_workflow_status() -- "open" and "current
-- workflow" are different concepts (see section 0), and this index must
-- serve the former.
create index idx_incidents_open_status_check_due on incidents (status_check_due)
  where status_check_due is not null and status not in ('closed', 'cancelled');
