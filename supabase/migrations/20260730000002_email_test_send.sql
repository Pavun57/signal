-- Diagnostic state for the Settings > Email "send test" button. Deliberately
-- columns on user_settings rather than a table: only one test is ever in
-- flight, and nothing reads test history. test_sent_at doubles as the
-- throttle clock; test_replied_at settles a test so it stops re-scanning
-- IMAP on every page load.
--
-- A test intentionally writes no sent_emails row, which keeps it invisible to
-- warmup cap counting, campaign stats and the reply-tracking cron.

alter table user_settings
  add column if not exists test_message_id text,
  add column if not exists test_to_email text,
  add column if not exists test_sent_at timestamptz,
  add column if not exists test_replied_at timestamptz;
