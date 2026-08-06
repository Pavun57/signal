-- Opt-in send-window auto-adjust
-- 2026-08-06
--
-- When enabled, the weekly outreach.learn job may shift an EXISTING send
-- window toward the hours that actually earn replies, under hard guardrails
-- (see planWindowAdjustment in outreach-learning.ts). Every adjustment is
-- recorded as a timing row in email_learnings: that row is the audit trail.
-- Default off, matching the auto_send opt-in pattern on tracking_configs.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table user_settings
  add column if not exists auto_adjust_send_window boolean not null default false;

-- 20260804000000_tenant_policy_hardening.sql replaced the table-level SELECT
-- grant with an explicit column list, so every new user_settings column must
-- be granted or the browser never sees it.
grant select (auto_adjust_send_window) on user_settings to authenticated;

commit;
