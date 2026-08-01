-- Voice-swipe runs
-- 2026-08-02
--
-- One row per in-progress run. It exists because the agent's tools execute
-- server-side and cannot touch React state: the tool writes drafts here, the
-- deck reads them, and the deck writes verdicts back for the next tool call to
-- read. Without a shared row the agent would have to learn each swipe from a
-- narrated chat message, which pollutes the conversation it is trying to hold.
--
-- Only one run per (user, campaign) is live at a time. A second would leave the
-- agent's tools ambiguous about which deck they are writing into — `startRun`
-- and `recordVerdict` would each have to guess — so the unique index below
-- makes that unrepresentable rather than a race.
--
-- Transaction-wrapped for the same reasons as
-- 20260729000000_email_voice_profiles.sql: the CLI otherwise runs each
-- statement in its own implicit transaction, so a step that aborts on the
-- lock_timeout below leaves the table created, the policies missing and nothing
-- recorded as applied — and `create policy` has no `if not exists`, so the
-- re-run needs hand-written SQL. Inside a transaction the failure rolls back
-- and the migration is simply re-runnable, which is also why there is no
-- defensive `if not exists` on the create table: it would only guard the one
-- statement that can already be guarded, and hide a genuine name collision.
--
-- The explicit transaction is also what makes SET LOCAL do anything. Outside a
-- transaction block it warns 25P01 and silently no-ops, so the timeouts would
-- not apply at all.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ────────────────────────────────────────────────────────────────────────────
-- 1. The run
--
-- user_id is the Clerk sub, so text rather than uuid — the same choice every
-- other user-scoped table in this schema makes. campaign_id is nullable: NULL
-- is the user-level default voice, a value scopes the run to one campaign,
-- mirroring email_voice_profiles.campaign_id.
--
-- The four jsonb columns are append-only logs rather than child tables on
-- purpose. Every consumer reads all of them together to rebuild the prompt
-- transcript, none of them is ever queried across users, and realtime delivers
-- a whole row per change — so a child table would buy nothing and cost the deck
-- four subscriptions instead of one.
-- ────────────────────────────────────────────────────────────────────────────
create table public.voice_swipe_runs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  campaign_id uuid references public.campaigns(id) on delete cascade,
  -- Drafts currently queued, newest batch appended. Same shape the batch prompt
  -- returns: { subject, body, axes }.
  drafts jsonb not null default '[]'::jsonb,
  -- Judged drafts with their verdicts and any phrase comments.
  judged jsonb not null default '[]'::jsonb,
  -- Everything the user typed, in order.
  instructions jsonb not null default '[]'::jsonb,
  -- Emails they pasted as samples of their own writing (Phase 2).
  samples jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'complete', 'abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Without this, updated_at is a column that records only the insert and then
-- lies for the rest of the run — every swipe is an update. The deck's realtime
-- subscription and any "resume where you left off" logic both key off recency,
-- so a stale timestamp is wrong data, not a missing nicety.
create trigger voice_swipe_runs_updated_at before update on public.voice_swipe_runs
  for each row execute function update_updated_at_column();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. At most one active run per scope
--
-- Three things this has to get right, each of which a naive version gets wrong:
--
--   * NULL campaign_id. `unique (user_id, campaign_id)` does not constrain the
--     default-voice scope at all, because Postgres treats every NULL as
--     distinct — a user could accumulate unlimited active user-level runs and
--     the constraint would never fire once. Collapsing NULL onto a sentinel
--     uuid is what actually closes it, the same trick
--     email_voice_profiles.campaign_key uses.
--
--   * Finished runs. The constraint has to be partial (`where status =
--     'active'`), or completing a run and starting another would collide with
--     the history. "One row per scope" is the wrong invariant here; "one *live*
--     row per scope" is the one the tools depend on.
--
--   * The write path. Being a partial index this cannot be an ON CONFLICT
--     target through PostgREST — upsert cannot emit the index predicate, and
--     fails with "no unique or exclusion constraint matching the ON CONFLICT
--     specification". That is a live bug already documented in
--     20260730000000_campaign_email_voice.sql, which solved it with a generated
--     column and a plain constraint. That solution is unavailable here because
--     the predicate depends on status, which changes over a row's life and so
--     cannot be folded into a generated key. So startRun must explicitly
--     abandon (or complete) any existing active run first and let a 23505 be a
--     real error, not paper over it with an upsert.
--
-- The sentinel is a well-known all-zero uuid; gen_random_uuid() will not
-- produce it, so it cannot collide with a real campaign.
-- ────────────────────────────────────────────────────────────────────────────
create unique index voice_swipe_runs_one_active
  on public.voice_swipe_runs (
    user_id,
    coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'active';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RLS
--
-- requesting_user_id() reads the Clerk sub out of the JWT; it is defined by
-- 20260427000000_clerk_auth_migration.sql and is what every policy in this
-- schema uses. Four verb-scoped policies rather than one `for all`, matching
-- email_voice_profiles exactly — `for all` collapses USING and WITH CHECK into
-- a single rule and makes it easy to lose the insert-side check, which is the
-- half that stops a user writing a run under someone else's id.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.voice_swipe_runs enable row level security;

create policy "voice_swipe_runs_select" on public.voice_swipe_runs
  for select to authenticated using (user_id = requesting_user_id());
create policy "voice_swipe_runs_insert" on public.voice_swipe_runs
  for insert to authenticated with check (user_id = requesting_user_id());
create policy "voice_swipe_runs_update" on public.voice_swipe_runs
  for update to authenticated using (user_id = requesting_user_id());
create policy "voice_swipe_runs_delete" on public.voice_swipe_runs
  for delete to authenticated using (user_id = requesting_user_id());

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Realtime
--
-- The deck subscribes to its own row so the agent's writes appear without
-- polling. postgres_changes still evaluates the select policy above per
-- subscriber, so this publishes the table without publishing it to everyone.
--
-- Default replica identity (the primary key) is deliberate: the deck only ever
-- reads the new row. `replica identity full` would be needed to receive the
-- previous values in the payload, at the cost of writing every column to WAL on
-- every swipe.
-- ────────────────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table public.voice_swipe_runs;

commit;
