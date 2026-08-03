-- Kick off the one-shot reply backfill
-- 2026-08-03
--
-- Replies matched before 20260803000000 have a status and no words. This
-- enqueues a single job to walk back over them once and fill in what can still
-- be found. It is deliberately modest about that: the historical tracker only
-- ever looked at a 14-day window, 100 rows per run, and only in INBOX, so a
-- meaningful share of old replies are unrecoverable and will keep showing
-- "content not captured" forever. That is the honest outcome, not a failure.
--
-- recurring_interval_seconds is NULL on purpose. This is not a schedule: the
-- executor re-enqueues itself while work remains and stops at MAX_PASSES.
-- Note the partial unique index idx_jobs_one_recurring_per_type only covers
-- recurring rows, which is exactly what lets a one-shot re-enqueue itself, and
-- also exactly why the cap in the executor is the only thing bounding it.
--
-- run_at is 15 minutes out. execute.ts forces a job whose type has no
-- registered executor straight to 'dead' with no retry, and migrations are
-- pushed on merge while the code deploys separately, so a migration landing
-- first would kill this job on the very next tick.
insert into jobs (type, payload, recurring_interval_seconds, max_attempts, run_at)
values (
  'email.backfill-replies',
  '{"pass": 1}'::jsonb,
  null,
  1,
  now() + interval '15 minutes'
);
