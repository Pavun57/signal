-- Per-campaign email voice
-- 2026-07-30
--
-- A voice profile was global to the user, but the interview grounds its sample
-- emails in a campaign — so it learned that campaign's angle (which signal to
-- open on, which credibility framing) and saved it as the user's only voice.
-- Applied to a different campaign those rules are wrong, not just generic.
--
-- campaign_id splits the two scopes into one table: NULL is the user-level
-- default, a value is that campaign's voice. The composer prefers the campaign
-- row and falls back to the default, so skipping a campaign's interview
-- degrades to a real voice rather than to nothing.
--
-- Transaction-wrapped for the same reasons as
-- 20260729000000_email_voice_profiles.sql: a failed step rolls back and stays
-- re-runnable, and SET LOCAL only applies inside a transaction block (outside
-- one it warns 25P01 and silently does nothing).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table email_voice_profiles
  add column campaign_id uuid references campaigns(id) on delete cascade;

alter table email_voice_profiles
  drop constraint email_voice_profiles_user_id_key;

-- "One row per user per scope" cannot be a plain `unique (user_id, campaign_id)`
-- because Postgres treats NULLs as distinct, which would allow any number of
-- user-level rows. The obvious alternative — two partial unique indexes — is
-- what this migration originally did, and it breaks the write path: ON CONFLICT
-- only matches a partial index when the statement repeats the index predicate,
-- which PostgREST's upsert cannot express. The interview then fails with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- So collapse NULL onto a sentinel in a generated column and make the
-- constraint a normal one. campaign_id keeps its real NULL and its foreign key;
-- campaign_key is only ever used as the conflict target.
alter table email_voice_profiles
  add column campaign_key uuid generated always as (
    coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored;

alter table email_voice_profiles
  add constraint email_voice_profiles_user_scope_key unique (user_id, campaign_key);

-- Resolution reads both candidate rows for a user in one query, so it filters
-- on user_id and campaign_id together.
create index if not exists idx_email_voice_profiles_user_campaign
  on email_voice_profiles (user_id, campaign_id);

commit;
