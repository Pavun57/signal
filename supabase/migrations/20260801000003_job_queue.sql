-- Postgres-backed job queue replacing QStash. One table holds recurring
-- system jobs (seeded below) and one-off work items. Claiming happens in
-- claim_jobs() so SKIP LOCKED, fairness, and lease reaping live in one
-- transaction the app can't get wrong.

create table jobs (
    id uuid primary key default gen_random_uuid(),
    type text not null,
    status text not null default 'pending'
        check (status in ('pending', 'running', 'completed', 'dead')),
    run_at timestamptz not null default now(),
    payload jsonb not null default '{}'::jsonb,
    -- Clerk user id; null for system-wide jobs. Drives per-tenant fairness.
    user_id text,
    -- At most one *running* job per key (e.g. mailbox:<user_id> so one inbox
    -- never sends two emails concurrently). Null = no serialization.
    singleton_key text,
    priority int not null default 100,
    attempts int not null default 0,
    max_attempts int not null default 5,
    -- Lease: a running job whose lock expired is presumed crashed and gets
    -- reaped back to pending by the next claim_jobs() call.
    locked_until timestamptz,
    last_error text,
    -- Non-null marks a recurring job: on completion (or failure) it re-arms
    -- to pending at now() + this interval instead of terminating.
    recurring_interval_seconds int,
    created_at timestamptz not null default now(),
    completed_at timestamptz
);

create index idx_jobs_due on jobs (run_at) where status = 'pending';
create index idx_jobs_running_singleton on jobs (singleton_key)
    where status = 'running' and singleton_key is not null;

-- Service-role only: RLS on with no policies denies anon/authenticated.
-- (Matches the pattern of other system tables; the service-role grant from
-- the initial schema covers the admin client.)
alter table jobs enable row level security;

-- One recurring row per type, so re-running the seed insert is a no-op and
-- the system self-heals if someone deletes a row.
create unique index idx_jobs_one_recurring_per_type on jobs (type)
    where recurring_interval_seconds is not null;

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
               ) as user_rank
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

-- Seed the recurring system jobs. run_at = now() means the first tick after
-- deploy runs everything once immediately. max_attempts is 1 because a
-- recurring job that fails simply re-arms for its next interval — per-run
-- retries on top of that would double-poll mailboxes.
insert into jobs (type, payload, recurring_interval_seconds, max_attempts)
values
    ('email.track',       '{}'::jsonb,                     600,   1),
    ('email.cleanup',     '{}'::jsonb,                     86400, 1),
    ('tracking.dispatch', '{}'::jsonb,                     900,   1),
    ('outreach.process',  '{"type": "followups"}'::jsonb,  900,   1)
on conflict (type) where recurring_interval_seconds is not null do nothing;
