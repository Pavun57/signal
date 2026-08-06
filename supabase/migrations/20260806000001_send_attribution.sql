-- Send-time attribution snapshot
-- 2026-08-06
--
-- The learning job needs to know, for every send, when it left in the clock
-- that governed it and which sequence step it was. Real columns for what the
-- timing aggregation groups by; a features jsonb for the long tail (subject
-- length, body word count, voice profile, signal id) so adding a feature is
-- not a migration.
--
-- sent_local_hour/sent_weekday are in the GOVERNING clock: recipient-local
-- when the send window scope was 'recipient', sender-local otherwise. That
-- keeps bucket stats semantically aligned with the window they would later
-- adjust, under either scope.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table sent_emails
  add column if not exists sequence_id uuid references sequences(id) on delete set null,
  add column if not exists step_number smallint check (step_number >= 1),
  add column if not exists sent_local_hour smallint check (sent_local_hour between 0 and 23),
  add column if not exists sent_weekday smallint check (sent_weekday between 0 and 6),
  add column if not exists sent_tz text,
  add column if not exists features jsonb not null default '{}'::jsonb;

commit;
