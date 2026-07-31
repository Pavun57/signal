-- The test card could only show who replied and when while the tab that
-- detected it stayed open; a reload degraded to "Reply received at <time>"
-- because no reply detail was persisted. Storing the detail makes a settled
-- test fully legible after a refresh, and carries the reply's own words so
-- the user can confirm it is genuinely their message rather than trusting a
-- green tick.
--
-- One jsonb rather than three columns: this is a single opaque blob the UI
-- renders and nothing queries into. Shape: {from, subject, at, snippet}.

alter table user_settings
  add column if not exists test_reply jsonb;
