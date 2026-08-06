-- Reply intent classification + per-user suppression list
-- 2026-08-06
--
-- Raw "replied" counts OOO auto-replies the same as genuine interest, which
-- makes every reply-rate metric on the dashboard soft. A cheap LLM pass
-- (email.classify, seeded below) stamps each captured reply body with an
-- intent so the learning pipeline can score outcomes on real replies only.
--
-- Suppression is a NEW per-user table rather than a column on people:
-- people/organizations are a shared cross-tenant pool (see
-- 20260804000000_tenant_policy_hardening.sql), so one tenant's unsubscribe
-- must not block another tenant from contacting the same person.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table email_replies
  add column if not exists intent text check (
    intent in ('interested', 'question', 'not_interested', 'ooo', 'referral', 'unsubscribe', 'other')
  ),
  -- Classifier self-reported 0..1; suppression thresholds read it.
  add column if not exists intent_confidence real check (
    intent_confidence >= 0 and intent_confidence <= 1
  ),
  add column if not exists classified_at timestamptz;

-- The classify job's scan: unclassified real replies with a captured body,
-- oldest first. Partial so the index stays tiny once the backlog drains.
create index if not exists idx_email_replies_unclassified
  on email_replies (received_at)
  where intent is null and kind = 'reply' and body_text is not null;

create table outreach_suppressions (
  id uuid primary key default gen_random_uuid(),
  -- Clerk sub, same tenant key as sender_facts.
  user_id text not null,
  -- Kept for UI display; the address is the durable key because suppression
  -- must survive the person row being deleted or re-pooled.
  person_id uuid references people(id) on delete set null,
  email text not null check (email = lower(email)),
  reason text not null check (reason in ('unsubscribe', 'not_interested', 'user')),
  source text not null check (source in ('classifier', 'agent', 'user')),
  -- Evidence for the UI, e.g. the reply line that triggered the suppression.
  detail text check (char_length(detail) <= 1000),
  created_at timestamptz not null default now(),
  unique (user_id, email)
);

alter table outreach_suppressions enable row level security;

create policy "outreach_suppressions_select" on outreach_suppressions
  for select to authenticated using (user_id = requesting_user_id());
create policy "outreach_suppressions_insert" on outreach_suppressions
  for insert to authenticated with check (user_id = requesting_user_id());
-- The WITH CHECK repeats the user_id condition on purpose (sender_facts
-- precedent): an explicit WITH CHECK replaces the USING-as-check default.
create policy "outreach_suppressions_update" on outreach_suppressions
  for update to authenticated using (user_id = requesting_user_id())
  with check (user_id = requesting_user_id());
create policy "outreach_suppressions_delete" on outreach_suppressions
  for delete to authenticated using (user_id = requesting_user_id());

-- Recurring classify job. 900s, not email.track's 600s: replies arrive over
-- days, a quarter-hour lag on intent stamps costs nothing.
insert into jobs (type, payload, recurring_interval_seconds, max_attempts)
values ('email.classify', '{}'::jsonb, 900, 1)
on conflict (type) where recurring_interval_seconds is not null do nothing;

commit;
