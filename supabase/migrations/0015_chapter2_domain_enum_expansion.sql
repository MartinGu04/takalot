-- מעקב תקלות — forward migration.
-- Chapter 2, PR2 (file 1 of 2): enum and type expansion ONLY.
--
-- Every `alter type ... add value` below is permanent: PostgreSQL provides
-- no way to remove or rename an enum value without recreating the entire
-- type (dropping every column/function/constraint that depends on it
-- first). Nothing here is ever renamed, removed, or destructively
-- recreated -- this file only ever adds.
--
-- This file references NONE of the values it adds via `add value` -- no
-- function, table, constraint, or insert anywhere in this file uses any of
-- them. PostgreSQL requires a value added by `alter type ... add value` to
-- be committed before it can be used in a later statement; keeping every
-- usage in a separate, later-applied file (0016) sidesteps that rule
-- entirely rather than relying on any particular tool's transaction
-- behavior. The two `create type` statements at the end are NOT subject to
-- that restriction (a freshly created type has no such delay), but they are
-- still not referenced by anything in this file either.
--
-- ===== Rollout contract =====
-- This file (0015) must be applied and its successful commit verified
-- BEFORE migration 0016 is applied. The two must never be pasted together
-- into one manually wrapped transaction (e.g. one SQL Editor paste covering
-- both files) -- only sequential, separately confirmed application,
-- regardless of which tool applies them. Not yet applied to any hosted
-- database as of this commit.

-- ===== 1. incident_status: four new values =====
-- Target ACTIVE (current-workflow) statuses:
alter type incident_status add value 'waiting_equipment';
alter type incident_status add value 'waiting_information';
alter type incident_status add value 'waiting_validation';
-- Target TERMINAL status, alongside the existing 'closed':
alter type incident_status add value 'cancelled';

-- ===== 2. incident_event_type: five new values =====
alter type incident_event_type add value 'cancelled';
alter type incident_event_type add value 'severity_assessed';
alter type incident_event_type add value 'status_check_changed';
alter type incident_event_type add value 'reported_to_ops_room';
alter type incident_event_type add value 'reported_to_ops_communications';

-- ===== 3. Two new standalone enum types =====
-- CREATE TYPE, not ALTER TYPE ADD VALUE -- no same-transaction usage
-- restriction applies to these; kept unused in this file regardless, for
-- symmetry and review clarity with the rest of the file.
create type incident_report_channel as enum ('ops_room', 'ops_communications');
create type incident_status_check_kind as enum ('scheduled', 'rescheduled', 'completed', 'removed');
