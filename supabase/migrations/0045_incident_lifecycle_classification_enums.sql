-- AVARIA — structured incident lifecycle classification (file 1 of 3): enums.
--
-- Adds the six new fixed-value classification enums the product spec
-- requires -- reported domain, current suspected cause, structured
-- treatment action type, confirmed closure cause, treatment outcome,
-- resolution attribution (six enums covering five distinct classification
-- concepts, since reported domain and current suspected cause are
-- deliberately separate types) -- plus one new incident_event_type value
-- ('cause_assessment_changed') for the timeline.
--
-- Split from 0046/0047 for the same reason 0015/0043 were split from their
-- usage migrations: `ALTER TYPE ... ADD VALUE` (used here for
-- incident_event_type) cannot be referenced by name in the SAME
-- transaction it was added in. The brand-new CREATE TYPEs below have no
-- such restriction, but are kept in this file for one coherent
-- "vocabulary" migration that 0046 (schema) and 0047 (RPCs) both build on.
--
-- No data is touched, no existing table/RPC is touched. Explicit
-- transaction, matching 0015/0043's own convention (the repository's
-- psql -f runner uses autocommit otherwise).

begin;

-- Where the problem is CURRENTLY observed/manifested -- set once at
-- incident creation, never a confirmed root cause. Deliberately a
-- different enum from incident_suspected_cause below (different option
-- set: no 'external', and 'unknown' here reads as "לא ידוע בשלב זה" i.e.
-- "not yet known at this stage", a distinct nuance from the suspected-
-- cause enum's own 'unknown' / "טרם ידוע"). NULL on incidents.reported_
-- domain means "never classified" -- a genuinely different state from
-- the explicit 'unknown' value (see 0046).
create type incident_domain as enum (
  'communications', 'equipment', 'software', 'infrastructure', 'operational', 'unknown', 'other'
);

-- The CURRENT suspected cause -- mutable over the life of the incident,
-- every change preserved via incident_cause_assessments (0046). NULL on
-- incidents.current_suspected_cause means "never assessed" (renders as
-- "לא הוזנה הערכת גורם"); the 'unknown' enum value itself means
-- "assessed, and the conclusion was 'not yet known'" (renders as "הגורם
-- טרם ידוע") -- a deliberately distinct state from NULL, never conflated.
create type incident_suspected_cause as enum (
  'equipment', 'software', 'communications', 'infrastructure', 'operational', 'external', 'unknown', 'other'
);

-- Structured, cumulative treatment actions (incident_treatment_actions,
-- 0046) -- supplements, never replaces, the existing free-text
-- actionsTaken/currentStatusText fields.
create type incident_treatment_action_type as enum (
  'diagnosis', 'reset_restart', 'equipment_replacement', 'config_change', 'software_fix',
  'communications_handling', 'infrastructure_handling', 'external_party_handling', 'other'
);

-- The cause CONFIRMED at closure -- a separate concept from the (mutable,
-- pre-closure) current suspected cause, recorded per-closure-cycle on
-- incident_closures (0046), never overwriting incidents.current_suspected_cause.
create type incident_confirmed_cause as enum (
  'equipment', 'software', 'communications', 'infrastructure', 'operational', 'external', 'undetermined', 'other'
);

create type incident_treatment_outcome as enum (
  'permanent_resolution', 'temporary_workaround', 'not_reproduced', 'resolved_without_action',
  'closed_without_technical_resolution', 'other'
);

-- What is known about what resolved the incident -- deliberately not
-- "the action that resolved it": that framing is not always knowable.
create type incident_resolution_attribution as enum (
  'specific_action', 'combination_of_actions', 'undetermined', 'no_action_taken',
  'external_party_no_details', 'other'
);

-- Timeline event for a genuine current-suspected-cause CHANGE made
-- through an update (created or technician-update flow), when the newly
-- selected value differs from the incident's current one. Never used for
-- the initial cause entered at creation (that has no known effective
-- event time and is rendered inline on the creation timeline card
-- instead -- see 0047), and never used for treatment actions or closure
-- classification, which attach to existing event rows via operation_id/
-- ref_id (see 0046/0047) rather than a dedicated event type.
alter type incident_event_type add value 'cause_assessment_changed';

commit;
