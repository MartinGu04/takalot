-- AVARIA — structured incident lifecycle classification (file 2 of 3): schema.
--
-- Additive only: three new NULLABLE incidents columns (no default, no
-- backfill -- NULL means "never classified", a deliberately different
-- state from an explicit 'unknown'/'undetermined' enum selection, never
-- conflated anywhere in this feature), plus four new append-only tables
-- following the exact "no insert/update/delete RLS policy, SELECT-only via
-- is_active_member(), reject_mutation() trigger" pattern migration 0016
-- already established for incident_severity_assessments/incident_report_
-- events/incident_status_checks. No existing table, RPC, or row is
-- rewritten; every new column/table is safe against every row that exists
-- today.
--
-- Explicit transaction, matching 0016's own convention.

begin;

-- =====================================================================
-- 1. incidents -- three new nullable columns, no default, no backfill.
--    A currently-deployed old frontend never references these columns at
--    all, so this is fully invisible to it (see 0047 for the RPC side of
--    that compatibility guarantee).
-- =====================================================================
alter table incidents
  add column reported_domain incident_domain,
  add column current_suspected_cause incident_suspected_cause,
  add column current_suspected_cause_other_detail text
    check (current_suspected_cause_other_detail is null
      or length(trim(current_suspected_cause_other_detail)) between 1 and 500);

-- Bidirectional: 'other' requires detail; every other value (including
-- NULL, "never assessed") requires the detail to be absent.
alter table incidents
  add constraint incident_current_suspected_cause_other_detail_bidirectional
    check (
      (current_suspected_cause is distinct from 'other' and current_suspected_cause_other_detail is null)
      or
      (current_suspected_cause = 'other'
        and current_suspected_cause_other_detail is not null
        and length(trim(current_suspected_cause_other_detail)) > 0)
    );

comment on column incidents.reported_domain is
  'תחום התקלה -- where the problem is currently observed, set once at creation. NULL means never classified (legacy incident), never conflated with the explicit ''unknown'' enum member.';
comment on column incidents.current_suspected_cause is
  'The current suspected cause -- mutable, denormalized mirror of the latest incident_cause_assessments row. NULL means never assessed; the explicit ''unknown'' value means assessed and concluded not-yet-known. Reset to NULL on reopen -- see reopen_incident (0047).';

-- =====================================================================
-- 2. incident_cause_assessments -- append-only history of every
--    current-suspected-cause value the incident has ever had.
-- =====================================================================
create table incident_cause_assessments (
  id                uuid primary key default gen_random_uuid(),
  incident_id       uuid not null references incidents (id),
  cause             incident_suspected_cause not null,
  other_detail      text check (other_detail is null or length(trim(other_detail)) between 1 and 500),
  -- incidents.reopen_count at write time -- 0 for the original incident,
  -- 1 after the first reopen, etc. Partitions history by open/closed
  -- cycle with no separate "treatment cycle" table.
  cycle_number      int not null default 0 check (cycle_number >= 0),
  recorded_by       uuid not null references profiles (id),
  -- Nullable: NULL for the initial assessment recorded at incident
  -- creation, which has no known effective time (no time field is
  -- collected for it -- see create_incident_impl, 0047). Every
  -- assessment recorded through an update carries the update's own real
  -- effective event_time.
  event_time        timestamptz,
  recorded_at       timestamptz not null default now(),
  operation_id      uuid,
  created_at        timestamptz not null default now(),

  constraint incident_cause_assessment_other_detail_bidirectional
    check (
      (cause is distinct from 'other' and other_detail is null)
      or
      (cause = 'other' and other_detail is not null and length(trim(other_detail)) > 0)
    )
);

create index idx_incident_cause_assessments_incident on incident_cause_assessments (incident_id, event_time);
create index idx_incident_cause_assessments_cycle on incident_cause_assessments (incident_id, cycle_number);

alter table incident_cause_assessments enable row level security;
create policy incident_cause_assessments_select on incident_cause_assessments for select using (is_active_member());
-- No insert/update/delete policy: writes are RPC-only (SECURITY DEFINER
-- bypasses RLS internally), matching every other table in this schema.

create trigger trg_incident_cause_assessments_immutable
  before update or delete on incident_cause_assessments
  for each row execute function reject_mutation();

-- =====================================================================
-- 3. incident_treatment_actions -- append-only, cumulative structured
--    actions. Supplements, never replaces, the existing free-text
--    actionsTaken/currentStatusText fields.
-- =====================================================================
create table incident_treatment_actions (
  id                uuid primary key default gen_random_uuid(),
  incident_id       uuid not null references incidents (id),
  action_type       incident_treatment_action_type not null,
  other_detail      text check (other_detail is null or length(trim(other_detail)) between 1 and 500),
  cycle_number      int not null default 0 check (cycle_number >= 0),
  -- Nullable for the same reason as incident_cause_assessments.event_time
  -- above: actions entered during creation ("already performed before the
  -- incident was opened") have no known effective time and are recorded
  -- with event_time = NULL, never a fabricated one.
  event_time        timestamptz,
  recorded_by       uuid not null references profiles (id),
  recorded_at       timestamptz not null default now(),
  operation_id      uuid,
  created_at        timestamptz not null default now(),

  constraint incident_treatment_action_other_detail_bidirectional
    check (
      (action_type is distinct from 'other' and other_detail is null)
      or
      (action_type = 'other' and other_detail is not null and length(trim(other_detail)) > 0)
    )
);

create index idx_incident_treatment_actions_incident on incident_treatment_actions (incident_id, event_time);
create index idx_incident_treatment_actions_cycle on incident_treatment_actions (incident_id, cycle_number);

alter table incident_treatment_actions enable row level security;
create policy incident_treatment_actions_select on incident_treatment_actions for select using (is_active_member());

create trigger trg_incident_treatment_actions_immutable
  before update or delete on incident_treatment_actions
  for each row execute function reject_mutation();

-- =====================================================================
-- 4. incident_closures -- append-only, one row per GENUINE closure (the
--    full-readiness branch of close_incident only -- partial_readiness
--    never writes here). Tied to a specific closure cycle so reopening
--    and repeated closures never lose or overwrite history.
-- =====================================================================
create table incident_closures (
  id                              uuid primary key default gen_random_uuid(),
  incident_id                     uuid not null references incidents (id),
  cycle_number                    int not null check (cycle_number >= 0),
  -- Shared with the 'closed' incident_events row and any inline action
  -- recorded during the same closure call -- a correlation label, not a
  -- unique identity, matching how incident_events.operation_id is used
  -- everywhere else in this schema.
  operation_id                    uuid,
  confirmed_cause                 incident_confirmed_cause not null,
  confirmed_cause_other_detail    text check (confirmed_cause_other_detail is null or length(trim(confirmed_cause_other_detail)) between 1 and 500),
  treatment_outcome               incident_treatment_outcome not null,
  treatment_outcome_other_detail  text check (treatment_outcome_other_detail is null or length(trim(treatment_outcome_other_detail)) between 1 and 500),
  resolution_attribution          incident_resolution_attribution not null,
  resolution_attribution_other_detail text check (resolution_attribution_other_detail is null or length(trim(resolution_attribution_other_detail)) between 1 and 500),
  recorded_by                     uuid not null references profiles (id),
  event_time                      timestamptz not null,
  recorded_at                     timestamptz not null default now(),
  created_at                      timestamptz not null default now(),

  constraint incident_closure_confirmed_cause_other_detail_bidirectional
    check (
      (confirmed_cause is distinct from 'other' and confirmed_cause_other_detail is null)
      or
      (confirmed_cause = 'other' and confirmed_cause_other_detail is not null and length(trim(confirmed_cause_other_detail)) > 0)
    ),
  constraint incident_closure_treatment_outcome_other_detail_bidirectional
    check (
      (treatment_outcome is distinct from 'other' and treatment_outcome_other_detail is null)
      or
      (treatment_outcome = 'other' and treatment_outcome_other_detail is not null and length(trim(treatment_outcome_other_detail)) > 0)
    ),
  constraint incident_closure_resolution_attribution_other_detail_bidirectional
    check (
      (resolution_attribution is distinct from 'other' and resolution_attribution_other_detail is null)
      or
      (resolution_attribution = 'other' and resolution_attribution_other_detail is not null and length(trim(resolution_attribution_other_detail)) > 0)
    ),
  -- Same-table consistency rule: "the fault disappeared with no action"
  -- can never be paired with any resolution-attribution value other than
  -- "no action was taken" -- the CloseDialog never offers a UI path to
  -- the rejected combination (see IncidentDetailPage/CloseDialog plan),
  -- but this is enforced here regardless of caller.
  constraint incident_closure_resolved_without_action_requires_no_action
    check (treatment_outcome <> 'resolved_without_action' or resolution_attribution = 'no_action_taken'),

  -- One classification per closure cycle -- a row only ever exists when a
  -- full classification was actually supplied (see close_incident_impl,
  -- 0047); "no row for this cycle" is the single, unambiguous
  -- representation of "no classification recorded", covering both true
  -- legacy incidents and any closure made through the permissive legacy
  -- close_incident entry point with classification omitted entirely.
  constraint incident_closures_incident_cycle_unique unique (incident_id, cycle_number)
);

create index idx_incident_closures_incident on incident_closures (incident_id, event_time);
create index idx_incident_closures_operation on incident_closures (operation_id);

alter table incident_closures enable row level security;
create policy incident_closures_select on incident_closures for select using (is_active_member());

create trigger trg_incident_closures_immutable
  before update or delete on incident_closures
  for each row execute function reject_mutation();

-- =====================================================================
-- 5. incident_closure_resolution_actions -- junction linking a closure to
--    the treatment action(s) its resolution_attribution is based on.
--    Composite primary key dedupes identical links automatically.
-- =====================================================================
create table incident_closure_resolution_actions (
  closure_id          uuid not null references incident_closures (id),
  treatment_action_id uuid not null references incident_treatment_actions (id),
  created_at          timestamptz not null default now(),
  primary key (closure_id, treatment_action_id)
);

alter table incident_closure_resolution_actions enable row level security;
create policy incident_closure_resolution_actions_select on incident_closure_resolution_actions for select using (is_active_member());

create trigger trg_incident_closure_resolution_actions_immutable
  before update or delete on incident_closure_resolution_actions
  for each row execute function reject_mutation();

commit;
