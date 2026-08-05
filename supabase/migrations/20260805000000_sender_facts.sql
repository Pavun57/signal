-- Sender fact bank
-- 2026-08-05
--
-- One row per fact about the *sender* (the signed-in user), categorized so the
-- compose prompt can render them grouped and the drafting model can pick the
-- one or two that connect to a given recipient. Populated by researchSenderProfile
-- (source='research'), appended to by the agent (source='agent') and the
-- profile page (source='user'). See docs/plans/2026-08-04-sender-fact-bank-swipe-personas.md.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table sender_facts (
  id uuid primary key default gen_random_uuid(),
  -- Clerk sub, same tenant key as email_voice_profiles.
  user_id text not null,
  profile_id uuid not null references user_profile(id) on delete cascade,
  -- Constrained in the schema, not just app code: a direct PostgREST insert
  -- with a bogus category would otherwise vanish from both the prompt (the
  -- renderer drops unknown categories) and the UI (grouped by known ones).
  category text not null check (
    category in ('background', 'proof_point', 'story', 'pov', 'credibility', 'personal')
  ),
  -- One plain sentence. Bounded so a runaway insert can't stuff the prompt.
  fact text not null check (char_length(fact) <= 500),
  -- Who wrote it, shown in the UI.
  source text not null check (source in ('research', 'user', 'agent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_sender_facts_profile on sender_facts(profile_id);

create trigger sender_facts_updated_at before update on sender_facts
  for each row execute function update_updated_at_column();

alter table sender_facts enable row level security;

-- profile_id ownership is checked on the writes, not just user_id: without it
-- a request could attach its facts to another tenant's profile row.
create policy "sender_facts_select" on sender_facts
  for select to authenticated using (user_id = requesting_user_id());
create policy "sender_facts_insert" on sender_facts
  for insert to authenticated with check (
    user_id = requesting_user_id()
    and profile_id in (select id from user_profile where user_id = requesting_user_id())
  );
-- The WITH CHECK repeats the user_id condition on purpose: an explicit WITH
-- CHECK *replaces* the USING-as-check default, so checking only profile_id
-- would let an update re-key a row's user_id to another tenant's Clerk sub.
create policy "sender_facts_update" on sender_facts
  for update to authenticated using (user_id = requesting_user_id())
  with check (
    user_id = requesting_user_id()
    and profile_id in (select id from user_profile where user_id = requesting_user_id())
  );
create policy "sender_facts_delete" on sender_facts
  for delete to authenticated using (user_id = requesting_user_id());

commit;
