-- מעקב תקלות — forward migration.
-- Timeline grouping foundation, part 1 of 2 (schema only). A single user
-- operation (e.g. one "עדכון תקלה" submission) can insert several
-- incident_events rows -- one per changed protected field, plus the
-- operation's own primary row -- and today nothing links those rows back
-- together: `ref_id` points OUTWARD at a detail row (an incident_updates id,
-- a handover id, a status-check id, ...) and is proven to differ between the
-- rows of one call (see chapter2_pr3_incident_rpcs.sql's "two mutually
-- DISTINCT mirrored events" assertion for set_incident_status_check), and
-- audit_logs.correlation_id is regenerated per write_audit() call with no
-- link to incident_events at all. A future timeline redesign (out of scope
-- here) needs a real grouping key to collapse those rows into one card.
--
-- This file adds ONLY the column and its supporting index. The follow-up
-- migration (0026) is the one that changes any function body to populate it.
-- Splitting the two keeps this file trivially safe to review on its own:
-- nullable column, no default, no CHECK, no trigger, no function touched --
-- every existing row and every existing RPC behaves identically after this
-- file alone.
--
-- ===== Why the column can never be backfilled for historical rows =====
-- incident_events carries trg_incident_events_immutable (0001), a blanket
-- reject_mutation() BEFORE UPDATE OR DELETE trigger -- by design, this
-- table has no append-only exception for administrative backfills. A
-- historical row's operation_id is therefore permanently NULL, and every
-- consumer (the eventual timeline grouping, this migration's own tests, and
-- 0026's RPC bodies) must treat NULL as its own valid, permanent state --
-- "this row predates operation grouping" -- not as a defect to be fixed
-- later. Nothing in this migration or its tests attempts to backfill it.

alter table incident_events
  add column operation_id uuid;

-- Partial: NULL is the norm for every row written before 0026 and stays the
-- norm forever for this table (see above), so indexing NULL would only add
-- dead weight. The predicate also means this index costs nothing until 0026
-- actually starts populating the column.
create index idx_incident_events_operation
  on incident_events (incident_id, operation_id)
  where operation_id is not null;
