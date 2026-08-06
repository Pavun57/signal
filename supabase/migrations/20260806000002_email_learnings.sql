-- Email learnings + timing stats
-- 2026-08-06
--
-- The outcome feedback loop's durable store. outreach.learn (seeded below,
-- weekly) aggregates sent_emails x email_replies, has an LLM interpret the
-- numbers, and maintains one row per learning here. Rows are individually
-- auditable and editable: the user can revise a statement, retire it, or
-- dismiss it so the analysis never re-proposes it. Active copy/targeting
-- rows render into the compose system prompt (email-learnings.ts).
--
-- Keyed on user_id, NOT profile_id like sender_facts: a learning is about
-- the outcomes of this user's sends, not about a persona.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table email_learnings (
  id uuid primary key default gen_random_uuid(),
  -- Clerk sub.
  user_id text not null,
  -- Null scopes the learning to all campaigns.
  campaign_id uuid references campaigns(id) on delete cascade,
  category text not null check (category in ('copy', 'timing', 'targeting')),
  -- One imperative sentence. Bounded so a runaway analysis can't stuff the
  -- compose prompt (same rationale as sender_facts.fact).
  statement text not null check (char_length(statement) <= 500),
  -- {metric, sends, replies, positive, sample_sent_email_ids, window, note}
  evidence jsonb not null default '{}'::jsonb,
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  -- user_dismissed is stronger than retired: the analysis may resurrect a
  -- retired learning when new data re-supports it, but never a dismissed one.
  status text not null default 'active' check (status in ('active', 'retired', 'user_dismissed')),
  source text not null check (source in ('analysis', 'user', 'agent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Bumped on every analysis run that re-confirmed the learning.
  last_evaluated_at timestamptz
);

create index idx_email_learnings_user_status on email_learnings (user_id, status);

create trigger email_learnings_updated_at before update on email_learnings
  for each row execute function update_updated_at_column();

alter table email_learnings enable row level security;

create policy "email_learnings_select" on email_learnings
  for select to authenticated using (user_id = requesting_user_id());
create policy "email_learnings_insert" on email_learnings
  for insert to authenticated with check (user_id = requesting_user_id());
create policy "email_learnings_update" on email_learnings
  for update to authenticated using (user_id = requesting_user_id())
  with check (user_id = requesting_user_id());
create policy "email_learnings_delete" on email_learnings
  for delete to authenticated using (user_id = requesting_user_id());

-- Per-user send-time performance, one row per (weekday, day-part) bucket.
-- Rewritten wholesale by outreach.learn on every run so it is visible data
-- even before any learning exists. Written only by the admin-client job:
-- no insert/update policies for authenticated on purpose.
create table outreach_timing_stats (
  user_id text not null,
  -- 0 = Sunday, matching Intl weekday order in localSendClock.
  weekday smallint not null check (weekday between 0 and 6),
  day_part text not null check (
    day_part in ('early', 'morning', 'midday', 'afternoon', 'evening', 'night')
  ),
  sends int not null default 0,
  -- Classified genuine human replies (bounces and OOO excluded).
  replies int not null default 0,
  -- interested / question / referral replies.
  positive int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, weekday, day_part)
);

alter table outreach_timing_stats enable row level security;

create policy "outreach_timing_stats_select" on outreach_timing_stats
  for select to authenticated using (user_id = requesting_user_id());

-- Weekly learning run. At a 30/day send cap, learnings shift on the scale
-- of weeks; anything faster would just re-read the same numbers.
insert into jobs (type, payload, recurring_interval_seconds, max_attempts)
values ('outreach.learn', '{}'::jsonb, 604800, 1)
on conflict (type) where recurring_interval_seconds is not null do nothing;

commit;
