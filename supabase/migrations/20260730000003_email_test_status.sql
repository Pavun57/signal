-- test_replied_at alone records THAT a test settled, not HOW. A bounced test
-- would therefore report as "replied" on any check after the first (page
-- reload, re-check), which is the most misleading output available: the user
-- is told reply tracking works when the message never reached anyone.
--
-- Stores the classifier's verdict verbatim so the settled short-circuit can
-- return the real outcome.

alter table user_settings
  add column if not exists test_status text
    check (test_status is null or test_status in ('replied', 'bounced'));
