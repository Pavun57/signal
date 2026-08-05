-- Tracking pipeline fixes: auto-send opt-in, per-fire contact count,
-- send-window settings; drop the vestigial threshold_rules column
-- (superseded by the free-text intent column + LLM verdict; no reader
-- anywhere in the codebase).

alter table tracking_configs
  add column if not exists auto_send boolean not null default false,
  add column if not exists max_contacts_per_fire smallint not null default 1
    check (max_contacts_per_fire between 1 and 5);

alter table tracking_configs
  drop column if exists threshold_rules;

-- Send window: null start/end = no window (send any time). Hours are 0-23
-- in send_timezone. A window may wrap midnight (start > end).
alter table user_settings
  add column if not exists send_window_start smallint
    check (send_window_start between 0 and 23),
  add column if not exists send_window_end smallint
    check (send_window_end between 0 and 23),
  add column if not exists send_timezone text;

-- 20260804000000_tenant_policy_hardening.sql replaced the table-level SELECT
-- grant on user_settings with an explicit column list (fail-safe: new columns
-- are invisible to the browser until granted). The settings UI needs to read
-- the send window, so grant the three new columns to authenticated.
grant select (send_window_start, send_window_end, send_timezone)
  on user_settings to authenticated;
