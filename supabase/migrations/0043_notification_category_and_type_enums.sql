-- AVARIA — operational notifications center (file 1 of 2): enum expansion ONLY.
--
-- Adds the four new notification_type values the operational (role-based)
-- notifications need, plus a standalone notification_category type. Every
-- `alter type ... add value` below is permanent (PostgreSQL provides no way
-- to remove or rename an enum value without recreating the whole type), and
-- none of them is USED anywhere in this file -- no function, table,
-- constraint, or insert here references any of them. PostgreSQL requires a
-- value added by `alter type ... add value` to be committed before it can be
-- used in a later statement; keeping every usage in a separate, later-
-- applied file (0044) sidesteps that rule entirely, exactly like migration
-- 0015 did for incident_status/incident_event_type. The `create type`
-- statement at the end is NOT subject to that restriction (a freshly created
-- type has no such delay), but it is kept unused here too, for the same
-- review clarity 0015 calls out.
--
-- ===== Rollout contract =====
-- This file (0043) must be applied and its successful commit verified
-- BEFORE migration 0044 is applied. The two must never be pasted together
-- into one manually wrapped transaction -- only sequential, separately
-- confirmed application, regardless of which tool applies them.

-- ===== 1. notification_type: four new values =====
-- Incident lifecycle events that gain a dedicated, unambiguous type of their
-- own (see 0044 for where each is written). 'incident_assigned' and
-- 'incident_reopened' already exist (0001) and are reused, not duplicated
-- here -- the new notification_category column (0044) is what disambiguates
-- a personal "assigned to you" / "reopened and assigned to you" row from a
-- generic professional-manager broadcast of the same underlying event.
alter type notification_type add value 'incident_opened';
alter type notification_type add value 'incident_updated';
alter type notification_type add value 'incident_closed';
alter type notification_type add value 'incident_cancelled';

-- ===== 2. notification_category: new standalone enum =====
-- 'action_required': the notification is a personal call to action for its
-- recipient (an incident assigned to them, a handover awaiting their
-- approval). 'update': an informational, role-based broadcast (e.g. "an
-- incident was opened/updated/closed/cancelled") that does not require the
-- recipient to do anything.
create type notification_category as enum ('action_required', 'update');
