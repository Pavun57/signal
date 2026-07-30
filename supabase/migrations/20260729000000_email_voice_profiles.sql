-- Email voice profiles
-- 2026-07-29
--
-- Replaces the multi-skill email model with exactly one agent-generated voice
-- profile per user. The old model asked the user to hand-author rule packs and
-- attach them at user / profile / campaign scope; the profile is now produced
-- by the interview wizard on /email-skills and applied to every draft.
--
-- DESTRUCTIVE: dropping email_skills also drops the 5 seeded built-ins, and
-- any user-authored skills on a deployed instance. Both tables were verified
-- empty in local dev. This is a one-way door — see
-- ~/.claude/plans/2026-07-29-email-voice-skill-design.md for the rationale and
-- the trade-off that was weighed before choosing a clean break over a
-- migration path.

-- Wrapped in an explicit transaction for two reasons.
--
-- 1. Atomicity. The CLI otherwise applies each statement in its own implicit
--    transaction, so a drop that aborts on the lock_timeout below — the exact
--    case the timeout exists to create — would leave the new table created,
--    the old tables still present, and nothing recorded as applied. Re-running
--    would then fail on `create table` (and `create policy` has no
--    `if not exists` in Postgres), needing manual SQL on a live database.
--    Inside a transaction, a failed drop rolls the whole thing back and the
--    migration is simply re-runnable.
--
-- 2. It makes SET LOCAL correct. Outside a transaction block SET LOCAL is
--    silently a no-op (it warns 25P01 and the timeouts never apply) — verified
--    against this CLI. Inside one it works as intended and resets on commit,
--    so the timeouts can't leak into later migrations sharing the connection.
--    The same no-op mistake is live in 20260427000000_clerk_auth_migration.sql;
--    left alone there because that file is applied history.
begin;

-- Bound how long the drops below can hold ACCESS EXCLUSIVE locks on a hosted
-- DB, so a migration stuck behind a long read aborts instead of wedging it.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ────────────────────────────────────────────────────────────────────────────
-- 1. The new table. user_id is the Clerk sub (text, not uuid) and is unique —
--    "exactly one profile per user" is enforced by the schema, not app code,
--    so the interview's upsert can rely on it as a conflict target.
-- ────────────────────────────────────────────────────────────────────────────
create table email_voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  instructions text not null,
  summary text,
  -- The interview transcript, so "make it blunter" can replay the interview
  -- instead of restarting it.
  source_transcript jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger email_voice_profiles_updated_at before update on email_voice_profiles
  for each row execute function update_updated_at_column();

alter table email_voice_profiles enable row level security;

create policy "email_voice_profiles_select" on email_voice_profiles
  for select to authenticated using (user_id = requesting_user_id());
create policy "email_voice_profiles_insert" on email_voice_profiles
  for insert to authenticated with check (user_id = requesting_user_id());
create policy "email_voice_profiles_update" on email_voice_profiles
  for update to authenticated using (user_id = requesting_user_id());
create policy "email_voice_profiles_delete" on email_voice_profiles
  for delete to authenticated using (user_id = requesting_user_id());

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Drop the old model. cascade takes the policies, indexes and triggers
--    with the tables; attachments go first because they FK into email_skills.
-- ────────────────────────────────────────────────────────────────────────────
drop table if exists email_skill_attachments cascade;
drop table if exists email_skills cascade;

commit;
