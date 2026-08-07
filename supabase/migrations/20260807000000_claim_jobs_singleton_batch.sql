-- Same-batch singleton dedupe for claim_jobs.
-- 2026-08-07
--
-- The singleton guard only excluded keys with a RUNNING row, so two PENDING
-- jobs sharing a singleton_key could be claimed in the same batch and run
-- concurrently: exactly what the key exists to prevent (mailbox:<user_id>
-- serializes one inbox's sends; tracking-run:<config> serializes a config's
-- runs). key_rank picks one pending job per key per batch; the loser stays
-- pending and is claimable next tick once the winner finishes.
--
-- Signature unchanged, so either version of the app code tolerates either
-- version of this function (deploy order is still code first, per repo rule).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function claim_jobs(
    batch_size int default 25,
    lease_seconds int default 330,
    per_user_cap int default 5
) returns setof jobs
language plpgsql
as $$
begin
    -- Reap expired leases. Recurring jobs always re-arm; one-offs go dead
    -- once attempts are exhausted (attempts was already incremented when
    -- the job was claimed).
    update jobs
    set status = case
            when recurring_interval_seconds is null and attempts >= max_attempts
                then 'dead'
            else 'pending'
        end,
        run_at = case
            when recurring_interval_seconds is not null
                then now() + make_interval(secs => recurring_interval_seconds)
            else now()
        end,
        locked_until = null,
        last_error = coalesce(last_error, 'lease expired (runner crashed or timed out)')
    where status = 'running' and locked_until < now();

    return query
    with ranked as (
        select j.id, j.priority, j.run_at,
               row_number() over (
                   partition by coalesce(j.user_id, '<system>')
                   order by j.priority asc, j.run_at asc
               ) as user_rank,
               -- At most one pending job per singleton key per batch. The
               -- running-row check below covers cross-batch serialization;
               -- this covers two pending rows sharing a key in ONE batch.
               -- Null keys partition by their own id, so key_rank is 1.
               row_number() over (
                   partition by coalesce(j.singleton_key, j.id::text)
                   order by j.priority asc, j.run_at asc
               ) as key_rank
        from jobs j
        where j.status = 'pending'
          and j.run_at <= now()
          and (j.singleton_key is null or not exists (
              select 1 from jobs r
              where r.status = 'running'
                and r.singleton_key = j.singleton_key
          ))
    ),
    picked as (
        select id from ranked
        where user_rank <= per_user_cap
          and key_rank = 1
        order by priority asc, run_at asc
        limit batch_size
    )
    update jobs
    set status = 'running',
        attempts = attempts + 1,
        locked_until = now() + make_interval(secs => lease_seconds)
    where id in (
        -- SKIP LOCKED here is what makes overlapping ticks (or a future
        -- persistent worker running alongside the cron) safe: a second
        -- claimer just skips rows the first one is mid-claim on.
        select jobs.id from jobs
        where jobs.id in (select picked.id from picked)
        for update skip locked
    )
    returning *;
end;
$$;

commit;
