-- מעקב תקלות — forward migration.
-- New per-update free-text field, "סטטוס נוכחי" -- the situation at the
-- moment of the update, distinct from the structured status/severity
-- fields. Rolled out in two stages: this file is stage 1, schema-only. The
-- column stays nullable forever -- historical incident_updates rows are
-- never rewritten, and no RPC in this migration enforces the value yet
-- (see 0029). A later, separate migration may add server-side rejection of
-- a missing value, gated on a hosted verification query showing every
-- post-cutover row already has one; that gate has not been evaluated here,
-- so this migration does not add it.

alter table incident_updates
  add column current_status_text text
    check (current_status_text is null
           or length(trim(current_status_text)) between 1 and 1000);
