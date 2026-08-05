-- Person-level location for recipient-timezone send windows.
--
-- location: free-text ("San Francisco, CA", "Berlin, Germany"), written at
-- research time (contact discovery judge, enrichment, GitHub profiles) and
-- editable via the people PATCH route.
-- timezone: resolved IANA zone, cached by the send gate the first time it
-- resolves a location so each contact is resolved at most once.
--
-- people has ordinary table-level grants (only user_settings is
-- column-enumerated), so no grant statements are needed.

alter table people
  add column if not exists location text,
  add column if not exists timezone text;

-- Per-sequence override of the send-window scope. Null inherits the user's
-- global setting (user_settings.send_window_scope); set, it wins for every
-- draft sent through that sequence.
alter table sequences
  add column if not exists send_window_scope text
    check (send_window_scope in ('sender', 'recipient'));
