# Postgres Job Scheduler (QStash Replacement) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace QStash with a Postgres-backed job queue (a `jobs` table + a per-minute Vercel cron tick) so every schedule and async dispatch lives in the database — versioned, self-healing, multi-tenant-fair, with zero external scheduling vendors.

**Architecture:** A single `jobs` table holds recurring system jobs (reply tracking, draft cleanup, tracking dispatch, follow-up processing) and one-off work items (run this tracking config, process this signal fire). A thin `/api/jobs/tick` route — driven by Vercel Cron (per-minute, low volume for now) with pg_cron as the self-host alternative — claims due jobs via a `claim_jobs()` SQL function (`FOR UPDATE SKIP LOCKED`, per-user fairness, singleton serialization, lease reaping), then POSTs each job to `/api/jobs/run`, which 202s immediately and executes in `after()` so each job gets its own invocation and timeout. Later, when volume grows, a persistent worker can call the same `claim_jobs()` loop — the table is the contract, nothing else changes.

**Tech Stack:** Postgres (Supabase) + plpgsql, Next.js 16 App Router (`after()` from `next/server`), Vercel Cron, vitest, pnpm.

---

## Design

### Why not QStash

The QStash schedules were hand-created in the Upstash console — nothing in the repo creates them (confirmed: zero schedule-registration code exists), so they can silently not exist. `docs/plans/2026-07-29-gmail-send-transport.md:38` documents them 401-ing on empty bodies; reply tracking is plausibly dead in production. This plan moves scheduling into a migration: deploy + migrate and the system runs. It also removes the Upstash account + 3 env vars from self-host setup.

### Job lifecycle

```
            enqueueJob() / seeded recurring row
                          │
                          ▼
                 pending (run_at <= now?)
                          │
        tick (every min) calls claim_jobs(batch)
        SKIP LOCKED + per-user fairness cap
                          │
                          ▼
        running (locked_until = now + lease)
        tick POSTs {jobId} → /api/jobs/run
        runner 202s, executes in after()
              │                     │
          success                fail/crash
              │                     │
   recurring? rearm to      attempts < max? → pending
   pending @ now+interval        (run_at = now + backoff)
   else → completed         attempts >= max → dead
                            (lease expiry reaps crashed
                             jobs back to pending too)
```

### Serverless constraints (why no `while(true)` worker)

Vercel has no persistent processes. The tick is a dispatcher only (claims a batch, finishes in seconds); the runner gives each job its own invocation with `maxDuration = 300`. A runner that dies never reports back — the job's lease expires and `claim_jobs()` reaps it back to pending. That lease is the retry mechanism Vercel Cron itself lacks. Latency floor is ~1 minute (tick cadence); nothing in Signal needs sub-minute precision. **Migration path to a worker:** a persistent Node process running `claim_jobs() → execute → complete/fail` every second, calling the same executors — no schema, executor, or enqueue-site changes; both can run simultaneously during a transition because SKIP LOCKED prevents double-claims.

### Multi-tenancy and scale

- Every job row carries nullable `user_id`. `claim_jobs()` ranks pending jobs per user and claims at most `per_user_cap` per user per batch — one tenant's backlog can't starve others.
- `singleton_key` = at most one *running* job per key. Nothing sets it in v1; it exists for phase 2's `mailbox:<user_id>` send serialization.
- Volume today is tiny (4 recurring jobs + a trickle of tracking runs). Postgres-as-queue bloat concerns start at orders of magnitude more churn.

### Phase 2 (explicitly OUT of scope — do not build)

Per-email `email.send` jobs with `singleton_key = mailbox:<user_id>`, enqueue-time jitter, and send windows. Relevant current facts for whoever does this later: the send chokepoint is `claimAndSendDraft` (`src/lib/services/outreach-sender.ts:56`) with a CAS claim on `email_drafts.status` (:173-183) as the only concurrency guard; the daily cap is `user_settings.daily_send_limit` (default 30, DB check 1..500) counted against `sent_emails` since UTC midnight (:190-215) with a hardcoded warmup ramp in `gmail-service.ts:310-322`; delays are computed in exactly one place (`outreach-sender.ts:391-395`); **no jitter or send-window logic exists anywhere in src/**.

### Job types (v1)

| type | payload | recurring | replaces |
|---|---|---|---|
| `email.track` | `{}` | every 10 min | QStash schedule → `/api/email/track` |
| `email.cleanup` | `{}` | daily | QStash schedule → `/api/email/cleanup` |
| `tracking.dispatch` | `{}` | every 15 min | QStash schedule → `/api/tracking/dispatch` |
| `tracking.run` | `{ trackingConfigId }` | no | QStash publish from dispatch route + agent tools |
| `outreach.process` | `{ type: "followups" }` or `SignalPayload` | followups row every 15 min | QStash schedule + publish from tracking/run |

`SignalPayload` (from `src/app/api/outreach/process/route.ts:31-38`) is the exact payload contract: `{ type: "signal", signalId, campaignId, organizationId?, reason?, confidence? }`.

### Auth

One shared secret, `CRON_SECRET`. Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when the env var exists; the tick sends the same header self-invoking `/api/jobs/run`; pg_cron sends it explicitly. Unset secret ⇒ routes refuse everything (queue off, never open). This preserves the load-bearing invariant from `outreach/process/route.ts:47-51`: these routes are public and send real email through the admin client, so the secret check is the only thing between the internet and the user's outbox.

### Complete blast radius (from full-codebase sweep)

Beyond the five API routes and `src/lib/services/qstash.ts`:

| File | What | Task |
|---|---|---|
| `src/proxy.ts:6-9` | Clerk public-route allowlist for the four cron routes; `/api/jobs/*` needs its own entry or Clerk 307-redirects the scheduler | 4, 12 |
| `src/lib/tools/tracking-tools.ts` | `dispatchImmediateRun` + **three** publish/interval call sites (~:92, ~:155, ~:348) | 11 |
| `src/__tests__/qstash-verify.test.ts` | Tests only `verifyQStashSignature` — delete wholesale | 12 |
| `src/__tests__/outreach-process-followups.test.ts:10-12,37,81` | Mocks qstash, imports route `POST` — repoint at executor | 10 |
| `e2e/auth.flow.test.ts:45-58` | POSTs `/api/outreach/process`, expects status ∈ [200,400,401,422]; deleting the route yields 404 → test fails (auth project only; CI doesn't run e2e, so catch it locally) | 12 |
| `scripts/setup.mjs:362-369` | QStash prompt group in optional integrations; auto-gen pattern for secrets exists at :392-397 | 13 |
| `src/lib/integrations.ts:150-168` (+ `:19`, `:258`) | qstash integration card in Settings; category `scheduling` | 13 |
| `.env.example:87-94, :158` | QSTASH block + VERCEL_URL comment | 13 |
| `package.json:46` | `@upstash/qstash` dep | 14 |
| `README.md:71`, `docs/setup.md:119`, `docs/architecture.md:20,41,95,104` | QStash references + two stale tracking-pixel claims | 15 |
| `src/app/api/tracking/collect-test/start/route.ts` | Flagged in `docs/plans/2026-04-19-open-source-hardening.md:22` as a zero-auth QStash enqueue with no callers — verify and delete if still present | 12 |
| Comment-only mentions (`admin.ts:8`, `outreach-sender.ts:52`, `email-tracking.ts:10`, etc.) | Update wording opportunistically when touching those files; not otherwise in scope | — |

Facts that shape the code below: `getAdminClient()` (`src/lib/supabase/admin.ts:13`) is a memoized **untyped** `SupabaseClient` — there are no generated Database types in this repo, so `rpc("claim_jobs", ...)` returns `any`-shaped data and the existing `as` casts in moved code are load-bearing; keep them. `withAction` (`src/lib/services/cost-tracker.ts:62`) is an AsyncLocalStorage wrapper that returns its callback's value verbatim.

### Cutover

Hard cutover in one branch — no dual-running. Work on a clean branch off `main` (`ui-fixes` has unrelated uncommitted changes). Production cutover after merge is a human checklist (Task 16, Step 5).

---

### Task 1: Migration — `jobs` table, `claim_jobs()`, seeded recurring jobs

**Files:**
- Create: `supabase/migrations/20260801000003_job_queue.sql`

**Step 1: Write the migration**

```sql
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
```

**Step 2: Apply locally**

Run: `supabase migration up`
Expected: applies cleanly. (Do NOT use `supabase db reset` — it wipes locally seeded data; see the built-in-signals note.)

**Step 3: Smoke-test `claim_jobs()` in psql**

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres <<'SQL'
select count(*) from claim_jobs(25, 330, 5);              -- expect 4
select type, status, attempts, locked_until is not null as leased
from jobs order by type;                                   -- all running/leased/1
select count(*) from claim_jobs(25, 330, 5);              -- expect 0
update jobs set status='pending', attempts=0, locked_until=null;  -- reset
SQL
```
Expected: 4, then all `running / t / 1`, then 0.

**Step 4: Commit**

```bash
git add supabase/migrations/20260801000003_job_queue.sql
git commit -m "feat(jobs): add Postgres job queue table, claim_jobs(), seeded recurring jobs"
```

---

### Task 2: Jobs service — enqueue, complete, fail, backoff, auth, base URL

**Files:**
- Create: `src/lib/services/jobs.ts`
- Test: `src/__tests__/jobs-service.test.ts`

**Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAdminClientMock } = vi.hoisted(() => ({
  getAdminClientMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: getAdminClientMock,
}));

import {
  backoffSeconds,
  completeJob,
  enqueueJob,
  failJob,
  isJobRequestAuthorized,
  type JobRow,
} from "@/lib/services/jobs";

/** Records .from().update().eq() and .from().insert().select().single(). */
function fakeAdmin() {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: "job-1" }, error: null }),
          }),
        };
      },
    }),
  };
  return { client: client as never, updates, inserts };
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    type: "email.track",
    status: "running",
    run_at: new Date().toISOString(),
    payload: {},
    user_id: null,
    singleton_key: null,
    priority: 100,
    attempts: 1,
    max_attempts: 5,
    locked_until: null,
    last_error: null,
    recurring_interval_seconds: null,
    ...overrides,
  };
}

describe("backoffSeconds", () => {
  it("escalates 1m, 5m, 15m, 1h, 6h and caps there", () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(300);
    expect(backoffSeconds(3)).toBe(900);
    expect(backoffSeconds(4)).toBe(3600);
    expect(backoffSeconds(5)).toBe(21600);
    expect(backoffSeconds(99)).toBe(21600);
  });
});

describe("completeJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks one-off jobs completed", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await completeJob(job());
    expect(updates[0].values.status).toBe("completed");
    expect(updates[0].values.completed_at).toBeTruthy();
  });

  it("re-arms recurring jobs to pending at now + interval, attempts reset", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await completeJob(job({ recurring_interval_seconds: 600 }));
    expect(updates[0].values.status).toBe("pending");
    expect(updates[0].values.attempts).toBe(0);
    const runAt = new Date(updates[0].values.run_at as string).getTime();
    expect(runAt).toBeGreaterThan(Date.now() + 500_000);
  });
});

describe("failJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries a one-off with backoff while attempts remain", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await failJob(job({ attempts: 2, max_attempts: 5 }), new Error("boom"));
    expect(updates[0].values.status).toBe("pending");
    expect(updates[0].values.last_error).toContain("boom");
    const runAt = new Date(updates[0].values.run_at as string).getTime();
    expect(runAt).toBeGreaterThan(Date.now() + 200_000); // attempt 2 → 5 min
  });

  it("marks a one-off dead once attempts are exhausted", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await failJob(job({ attempts: 5, max_attempts: 5 }), new Error("boom"));
    expect(updates[0].values.status).toBe("dead");
  });

  it("always re-arms recurring jobs, even at max attempts", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await failJob(
      job({ attempts: 1, max_attempts: 1, recurring_interval_seconds: 600 }),
      new Error("imap down"),
    );
    expect(updates[0].values.status).toBe("pending");
    expect(updates[0].values.last_error).toContain("imap down");
  });
});

describe("enqueueJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a pending job and returns its id", async () => {
    const { client, inserts } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    const id = await enqueueJob({
      type: "tracking.run",
      payload: { trackingConfigId: "abc" },
    });
    expect(id).toBe("job-1");
    expect(inserts[0].values.type).toBe("tracking.run");
    expect(inserts[0].values.status).toBe("pending");
  });
});

describe("isJobRequestAuthorized", () => {
  it("accepts only the exact bearer secret, and nothing when unset", () => {
    const req = (auth?: string) =>
      new Request("http://x/api/jobs/tick", {
        headers: auth ? { authorization: auth } : {},
      });
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isJobRequestAuthorized(req("Bearer s3cret"))).toBe(true);
    expect(isJobRequestAuthorized(req("Bearer wrong"))).toBe(false);
    expect(isJobRequestAuthorized(req())).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(isJobRequestAuthorized(req("Bearer s3cret"))).toBe(false);
    vi.unstubAllEnvs();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/jobs-service.test.ts`
Expected: FAIL — cannot resolve `@/lib/services/jobs`

**Step 3: Write the implementation**

```typescript
import { getAdminClient } from "@/lib/supabase/admin";

// No generated Database types exist in this repo (admin client is an untyped
// SupabaseClient), so JobRow is the hand-written contract for the jobs table.
export type JobRow = {
  id: string;
  type: string;
  status: "pending" | "running" | "completed" | "dead";
  run_at: string;
  payload: Record<string, unknown>;
  user_id: string | null;
  singleton_key: string | null;
  priority: number;
  attempts: number;
  max_attempts: number;
  locked_until: string | null;
  last_error: string | null;
  recurring_interval_seconds: number | null;
};

/** Escalating retry delays; index is attempts already made (1-based). */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 21600];

export function backoffSeconds(attempts: number): number {
  return BACKOFF_SECONDS[
    Math.min(Math.max(attempts, 1), BACKOFF_SECONDS.length) - 1
  ];
}

/**
 * /api/jobs/tick and /api/jobs/run are public URLs that reach the admin
 * client and, transitively, the user's outbox — this shared secret is the
 * only thing standing between the internet and real email sends (the same
 * invariant the QStash signature used to carry). Vercel Cron sends the
 * header automatically when CRON_SECRET is set; pg_cron and the tick's
 * self-invocation send it explicitly. An unset secret authorizes nothing —
 * the queue stays off rather than open.
 */
export function isJobRequestAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Base URL for the tick's self-invocation of /api/jobs/run.
 * NEXT_PUBLIC_APP_URL wins over VERCEL_URL: deployment-protected previews
 * reject unauthenticated fetches to their *.vercel.app URL.
 */
export function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export async function enqueueJob(input: {
  type: string;
  payload?: Record<string, unknown>;
  userId?: string | null;
  runAt?: Date;
  singletonKey?: string | null;
  priority?: number;
  maxAttempts?: number;
}): Promise<string> {
  const { data, error } = await getAdminClient()
    .from("jobs")
    .insert({
      type: input.type,
      status: "pending",
      payload: input.payload ?? {},
      user_id: input.userId ?? null,
      run_at: (input.runAt ?? new Date()).toISOString(),
      singleton_key: input.singletonKey ?? null,
      priority: input.priority ?? 100,
      max_attempts: input.maxAttempts ?? 5,
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(`Failed to enqueue ${input.type}: ${error.message}`);
  }
  return (data as { id: string }).id;
}

export async function completeJob(job: JobRow): Promise<void> {
  const values = job.recurring_interval_seconds
    ? {
        status: "pending",
        run_at: new Date(
          Date.now() + job.recurring_interval_seconds * 1000,
        ).toISOString(),
        attempts: 0,
        locked_until: null,
        last_error: null,
      }
    : {
        status: "completed",
        completed_at: new Date().toISOString(),
        locked_until: null,
      };
  await getAdminClient().from("jobs").update(values).eq("id", job.id);
}

export async function failJob(job: JobRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  let values: Record<string, unknown>;
  if (job.recurring_interval_seconds) {
    // A recurring job must never die — it just tries again next interval.
    values = {
      status: "pending",
      run_at: new Date(
        Date.now() + job.recurring_interval_seconds * 1000,
      ).toISOString(),
      locked_until: null,
      last_error: message,
    };
  } else if (job.attempts >= job.max_attempts) {
    values = { status: "dead", locked_until: null, last_error: message };
  } else {
    values = {
      status: "pending",
      run_at: new Date(
        Date.now() + backoffSeconds(job.attempts) * 1000,
      ).toISOString(),
      locked_until: null,
      last_error: message,
    };
  }
  await getAdminClient().from("jobs").update(values).eq("id", job.id);
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/jobs-service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/services/jobs.ts src/__tests__/jobs-service.test.ts
git commit -m "feat(jobs): job service - enqueue, complete/fail with backoff, shared-secret auth"
```

---

### Task 3: Executor registry + `executeClaimedJob`

**Files:**
- Create: `src/lib/jobs/executors/index.ts`
- Create: `src/lib/jobs/execute.ts`
- Test: `src/__tests__/jobs-execute.test.ts`

**Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAdminClientMock, completeJobMock, failJobMock, executorsMock } =
  vi.hoisted(() => ({
    getAdminClientMock: vi.fn(),
    completeJobMock: vi.fn(),
    failJobMock: vi.fn(),
    executorsMock: {} as Record<string, ReturnType<typeof vi.fn>>,
  }));

vi.mock("@/lib/supabase/admin", () => ({ getAdminClient: getAdminClientMock }));
vi.mock("@/lib/services/jobs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  completeJob: completeJobMock,
  failJob: failJobMock,
}));
vi.mock("@/lib/jobs/executors", () => ({ executors: executorsMock }));

import { executeClaimedJob } from "@/lib/jobs/execute";

function adminReturning(row: unknown) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: row, error: null }),
          }),
        }),
      }),
    }),
  } as never;
}

const runningJob = {
  id: "j1",
  type: "email.track",
  status: "running",
  payload: { a: 1 },
  attempts: 1,
  max_attempts: 5,
  recurring_interval_seconds: null,
};

describe("executeClaimedJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(executorsMock)) delete executorsMock[k];
  });

  it("runs the executor and completes the job", async () => {
    executorsMock["email.track"] = vi.fn().mockResolvedValue(undefined);
    getAdminClientMock.mockReturnValue(adminReturning(runningJob));
    await executeClaimedJob("j1");
    expect(executorsMock["email.track"]).toHaveBeenCalledWith(
      { a: 1 },
      expect.objectContaining({ id: "j1" }),
    );
    expect(completeJobMock).toHaveBeenCalled();
    expect(failJobMock).not.toHaveBeenCalled();
  });

  it("fails the job when the executor throws", async () => {
    executorsMock["email.track"] = vi.fn().mockRejectedValue(new Error("x"));
    getAdminClientMock.mockReturnValue(adminReturning(runningJob));
    await executeClaimedJob("j1");
    expect(failJobMock).toHaveBeenCalled();
    expect(completeJobMock).not.toHaveBeenCalled();
  });

  it("dead-letters unknown job types instead of retrying them forever", async () => {
    getAdminClientMock.mockReturnValue(
      adminReturning({ ...runningJob, type: "no.such.type" }),
    );
    await executeClaimedJob("j1");
    expect(failJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 5 }), // forced to max → dead
      expect.any(Error),
    );
  });

  it("no-ops when the job is not running (reaped lease or stale id)", async () => {
    getAdminClientMock.mockReturnValue(adminReturning(null));
    await executeClaimedJob("j1");
    expect(completeJobMock).not.toHaveBeenCalled();
    expect(failJobMock).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/jobs-execute.test.ts`
Expected: FAIL — cannot resolve `@/lib/jobs/execute`

**Step 3: Write the implementation**

`src/lib/jobs/executors/index.ts` (registry starts empty; Tasks 6–10 fill it):

```typescript
import type { JobRow } from "@/lib/services/jobs";

export type JobExecutor = (
  payload: Record<string, unknown>,
  job: JobRow,
) => Promise<unknown>;

/** type → executor. Every job type the tick can claim must be registered. */
export const executors: Record<string, JobExecutor> = {};
```

`src/lib/jobs/execute.ts`:

```typescript
import { getAdminClient } from "@/lib/supabase/admin";
import { completeJob, failJob, type JobRow } from "@/lib/services/jobs";
import { executors } from "@/lib/jobs/executors";

/**
 * Runs one claimed job to completion. Only ever called by /api/jobs/run
 * after the tick has moved the row to running — a row in any other state
 * means the lease was reaped or the id is stale, and touching it would race
 * whoever owns it now.
 */
export async function executeClaimedJob(jobId: string): Promise<void> {
  const { data: job } = await getAdminClient()
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .eq("status", "running")
    .single();
  if (!job) return;

  const row = job as JobRow;
  const executor = executors[row.type];
  if (!executor) {
    // Retrying an unregistered type can never succeed; force it dead.
    await failJob(
      { ...row, attempts: row.max_attempts },
      new Error(`Unknown job type: ${row.type}`),
    );
    return;
  }

  try {
    await executor(row.payload, row);
    await completeJob(row);
  } catch (err) {
    console.error(`[jobs] ${row.type} (${row.id}) failed:`, err);
    await failJob(row, err);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/jobs-execute.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/jobs/ src/__tests__/jobs-execute.test.ts
git commit -m "feat(jobs): executor registry and executeClaimedJob lifecycle"
```

---

### Task 4: `/api/jobs/tick` — the dispatcher (+ Clerk middleware entry)

**Files:**
- Create: `src/app/api/jobs/tick/route.ts`
- Modify: `src/proxy.ts:6-9` (public-route allowlist)
- Test: `src/__tests__/jobs-tick-route.test.ts`

**Step 1: Write the failing test**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAdminClientMock } = vi.hoisted(() => ({
  getAdminClientMock: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ getAdminClient: getAdminClientMock }));

import { GET } from "@/app/api/jobs/tick/route";

function tickRequest(auth?: string): Request {
  return new Request("http://localhost:3000/api/jobs/tick", {
    headers: auth ? { authorization: auth } : {},
  });
}

describe("GET /api/jobs/tick", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("401s without the bearer secret", async () => {
    const res = await GET(tickRequest());
    expect(res.status).toBe(401);
  });

  it("claims jobs via rpc and POSTs each to /api/jobs/run", async () => {
    getAdminClientMock.mockReturnValue({
      rpc: vi
        .fn()
        .mockResolvedValue({ data: [{ id: "j1" }, { id: "j2" }], error: null }),
    });
    const res = await GET(tickRequest("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 2, dispatched: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/jobs/run");
    expect(init.headers.authorization).toBe("Bearer s3cret");
    expect(JSON.parse(init.body)).toEqual({ jobId: "j1" });
  });

  it("reports a failed dispatch without failing the tick", async () => {
    getAdminClientMock.mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: [{ id: "j1" }], error: null }),
    });
    fetchMock.mockRejectedValue(new Error("network"));
    const res = await GET(tickRequest("Bearer s3cret"));
    expect(await res.json()).toEqual({ claimed: 1, dispatched: 0 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/jobs-tick-route.test.ts`
Expected: FAIL — cannot resolve the route module

**Step 3: Write the route**

```typescript
import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { getBaseUrl, isJobRequestAuthorized } from "@/lib/services/jobs";

// Dispatcher only: claims a batch and hands each job to its own /api/jobs/run
// invocation. Never does job work itself, so it finishes in seconds.
export const maxDuration = 60;

async function tick(request: Request): Promise<NextResponse> {
  if (!isJobRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: jobs, error } = await getAdminClient().rpc("claim_jobs", {
    batch_size: 25,
    lease_seconds: 330, // runner maxDuration (300s) + headroom
    per_user_cap: 5,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const claimed = (jobs ?? []) as Array<{ id: string }>;
  const results = await Promise.allSettled(
    claimed.map((job) =>
      fetch(`${getBaseUrl()}/api/jobs/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({ jobId: job.id }),
      }),
    ),
  );

  // The runner 202s before doing the work, so "dispatched" means delivered,
  // not succeeded. A job whose dispatch failed just sits on its lease until
  // claim_jobs() reaps it — no special handling needed here.
  const dispatched = results.filter(
    (r) => r.status === "fulfilled" && r.value.ok,
  ).length;

  return NextResponse.json({ claimed: claimed.length, dispatched });
}

// Vercel Cron sends GET; pg_cron and manual curls may POST.
export async function GET(request: Request) {
  return tick(request);
}
export async function POST(request: Request) {
  return tick(request);
}
```

**Step 4: Add the Clerk public-route entry**

In `src/proxy.ts`, the public-route matcher list (lines 6–9) currently allowlists the four QStash routes. Add one entry now (the old four are removed in Task 12 when their routes die):

```typescript
"/api/jobs(.*)",
```

Without this, Clerk 307-redirects the scheduler and no job ever runs — the exact failure mode the middleware comment warns about for the existing routes.

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/jobs-tick-route.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/app/api/jobs/tick/route.ts src/proxy.ts src/__tests__/jobs-tick-route.test.ts
git commit -m "feat(jobs): tick route - claim due jobs and dispatch to per-job runners"
```

---

### Task 5: `/api/jobs/run` — the runner

**Files:**
- Create: `src/app/api/jobs/run/route.ts`
- Test: `src/__tests__/jobs-run-route.test.ts`

**Step 1: Write the failing test**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeClaimedJobMock } = vi.hoisted(() => ({
  executeClaimedJobMock: vi.fn(),
}));

vi.mock("@/lib/jobs/execute", () => ({
  executeClaimedJob: executeClaimedJobMock,
}));
// after() needs a real Next request scope; in tests, run the callback inline.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: (fn: () => unknown) => void fn(),
}));

import { POST } from "@/app/api/jobs/run/route";

function runRequest(body: unknown, auth?: string): Request {
  return new Request("http://localhost:3000/api/jobs/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/jobs/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "s3cret");
    executeClaimedJobMock.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("401s without the bearer secret", async () => {
    const res = await POST(runRequest({ jobId: "j1" }));
    expect(res.status).toBe(401);
    expect(executeClaimedJobMock).not.toHaveBeenCalled();
  });

  it("400s on a missing jobId", async () => {
    const res = await POST(runRequest({}, "Bearer s3cret"));
    expect(res.status).toBe(400);
  });

  it("202s and executes the job", async () => {
    const res = await POST(runRequest({ jobId: "j1" }, "Bearer s3cret"));
    expect(res.status).toBe(202);
    expect(executeClaimedJobMock).toHaveBeenCalledWith("j1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/jobs-run-route.test.ts`
Expected: FAIL — cannot resolve the route module

**Step 3: Write the route**

```typescript
import { after, NextResponse } from "next/server";
import { isJobRequestAuthorized } from "@/lib/services/jobs";
import { executeClaimedJob } from "@/lib/jobs/execute";

// One invocation per job. 202 goes back to the tick immediately; the actual
// work runs in after() with this route's full duration budget. A runner that
// dies mid-job never reports back — the job's lease expires and claim_jobs()
// reaps it back to pending, which is the retry path.
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!isJobRequestAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    jobId?: unknown;
  } | null;
  if (!body || typeof body.jobId !== "string") {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }
  const jobId = body.jobId;

  after(async () => {
    await executeClaimedJob(jobId);
  });

  return NextResponse.json({ accepted: jobId }, { status: 202 });
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/jobs-run-route.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/app/api/jobs/run/route.ts src/__tests__/jobs-run-route.test.ts
git commit -m "feat(jobs): runner route - 202 then execute one job in after()"
```

---

### Task 6: Executor — `email.track` (replaces `/api/email/track`)

**Files:**
- Create: `src/lib/jobs/executors/email-track.ts`
- Modify: `src/lib/jobs/executors/index.ts`
- Delete: `src/app/api/email/track/route.ts`

**Step 1: Move the route body into an executor**

The route (`src/app/api/email/track/route.ts`, 127 lines) is: signature check (L33-39, drop), then pure logic (L41-126). Create the executor by moving lines 41-126 verbatim into:

```typescript
import { getAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/crypto";
import {
  classifyInboundMessage,
  fetchInboundSince,
} from "@/lib/services/gmail-service";
import {
  applyInboundStatus,
  type TrackedEmail,
} from "@/lib/services/email-tracking";

/**
 * Reply/bounce tracking (recurring job, every 10 min). Polls each user's
 * Gmail INBOX over IMAP and matches inbound In-Reply-To/References headers
 * against the RFC Message-IDs of pending sends.
 *
 * Gmail rows only ever move sent → replied | bounced: there is no
 * delivered/opened/clicked signal because Signal deliberately sends no
 * tracking pixel (pixels hurt cold-email deliverability and the data is
 * mostly fiction post-Apple-MPP).
 *
 * Naturally idempotent: re-running re-matches already-applied statuses,
 * which applyInboundStatus's monotonic status ladder ignores.
 */
export async function trackEmailReplies(): Promise<{
  checked: number;
  updated: number;
}> {
  // lines 41-126 of the old route, with exactly two mechanical changes:
  //  - `return NextResponse.json({ checked: 0, updated: 0 })` → `return { checked: 0, updated: 0 }`
  //  - `return NextResponse.json({ checked: emails.length, updated })` → `return { checked: emails.length, updated }`
  // Everything else — the 14-day window, the Message-ID "<" filter, the
  // credsByUser decrypt-or-skip, the per-user try/catch — stays byte-identical.
}
```

Register in `src/lib/jobs/executors/index.ts`:

```typescript
import { trackEmailReplies } from "@/lib/jobs/executors/email-track";

export const executors: Record<string, JobExecutor> = {
  "email.track": () => trackEmailReplies(),
};
```

**Step 2: Delete the route**

```bash
git rm src/app/api/email/track/route.ts
```

**Step 3: Verify and test**

Run: `grep -rn "api/email/track" src/ --include='*.ts' --include='*.tsx'; pnpm typecheck && pnpm test`
Expected: no src hits (the `settings/email/test/route.ts:147` comment mentions the *cron*, not the path — leave it); typecheck and full suite pass.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(jobs): move reply/bounce tracking from QStash route to email.track executor"
```

---

### Task 7: Executor — `email.cleanup` (replaces `/api/email/cleanup`)

**Files:**
- Create: `src/lib/jobs/executors/email-cleanup.ts`
- Modify: `src/lib/jobs/executors/index.ts`
- Delete: `src/app/api/email/cleanup/route.ts`

**Step 1: Move the route body**

The route (101 lines) is signature check (L13-18, drop) then pure logic (L20-100). Move into `export async function cleanupEmails()`, converting the single success `NextResponse.json({...})` (L91-100) to a plain return of the same object shape: `{ cleaned: { discarded, stale }, recovered: { markedSent, returnedToDraft } }`.

Two invariants in the moved code that MUST survive verbatim:
1. The queued-draft recovery comment block (L29-36) and its logic: drafts stuck in `queued` >24h are resolved by checking `sent_emails` — a matching row means the send happened (finish bookkeeping as `sent`), no row means release back to `draft`. The deliberate risk tradeoff documented there stays documented.
2. The `.eq("status", "queued")` compare-and-swap guard on BOTH recovery updates (L64, L72) — it prevents racing a concurrent send.

Register as `"email.cleanup": () => cleanupEmails()`.

**Step 2: Delete, verify, test**

Run: `git rm src/app/api/email/cleanup/route.ts && grep -rn "api/email/cleanup" src/ --include='*.ts'; pnpm typecheck && pnpm test`
Expected: clean.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat(jobs): move draft cleanup from QStash route to email.cleanup executor"
```

---

### Task 8: Executor — `tracking.dispatch` (replaces `/api/tracking/dispatch`)

**Files:**
- Create: `src/lib/jobs/executors/tracking-dispatch.ts`
- Modify: `src/lib/jobs/executors/index.ts`
- Delete: `src/app/api/tracking/dispatch/route.ts`

**Step 1: Rewrite dispatch as an executor that enqueues jobs**

A rewrite, not a move — QStash `publishJSON` batching becomes row inserts:

```typescript
import { getAdminClient } from "@/lib/supabase/admin";
import { enqueueJob } from "@/lib/services/jobs";
import { SCHEDULE_INTERVALS } from "@/lib/types/tracking";
import type { Schedule } from "@/lib/types/tracking";

/**
 * Finds due tracking configs and enqueues one tracking.run job per config
 * (recurring job, every 15 min). next_run_at advances at enqueue time, same
 * as the old QStash dispatch route, so a config is never double-dispatched
 * even if the run itself later fails.
 */
export async function dispatchDueTracking(): Promise<{ dispatched: number }> {
  const { data: configs, error } = await getAdminClient()
    .from("tracking_configs")
    .select("id, schedule")
    .eq("status", "active")
    .lte("next_run_at", new Date().toISOString());
  if (error) {
    throw new Error(`Failed to query tracking configs: ${error.message}`);
  }

  let dispatched = 0;
  for (const config of configs ?? []) {
    await enqueueJob({
      type: "tracking.run",
      payload: { trackingConfigId: config.id },
      // Signal executions hit Exa/LLMs; two shots is plenty before giving
      // up until the next scheduled cadence.
      maxAttempts: 2,
    });
    const interval =
      SCHEDULE_INTERVALS[config.schedule as Schedule] ??
      SCHEDULE_INTERVALS.weekly;
    await getAdminClient()
      .from("tracking_configs")
      .update({ next_run_at: new Date(Date.now() + interval).toISOString() })
      .eq("id", config.id);
    dispatched++;
  }
  return { dispatched };
}
```

Register as `"tracking.dispatch": () => dispatchDueTracking()`.

**Step 2: Delete, verify, test**

Run: `git rm src/app/api/tracking/dispatch/route.ts && grep -rn '"/api/tracking/dispatch"\|api/tracking/dispatch' src/ --include='*.ts'; pnpm typecheck && pnpm test`
Expected: clean (docs hits fixed in Task 15).

**Step 3: Commit**

```bash
git add -A
git commit -m "feat(jobs): tracking.dispatch executor enqueues tracking.run jobs"
```

---

### Task 9: Executor — `tracking.run` (replaces `/api/tracking/run`)

**Files:**
- Create: `src/lib/jobs/executors/tracking-run.ts`
- Modify: `src/lib/jobs/executors/index.ts`
- Delete: `src/app/api/tracking/run/route.ts`

**Step 1: Move the route body**

The route (307 lines) is: signature/payload parse (L28-39, drop), config load (L42-68), then everything wrapped in `withAction(\`Tracking run: ${orgName}\`, ...)` (L71-306) whose callback return value was the HTTP response. Structure the executor the same way — `withAction` returns its callback's value verbatim (it's an AsyncLocalStorage cost-tracking wrapper from `src/lib/services/cost-tracker.ts:62`), so keep it wrapping the moved body:

```typescript
export async function runTrackingConfig(trackingConfigId: string) {
  // L42-55 config load, unchanged except:
  //   `return Response.json({ error: ... }, { status: 404 })`
  //   → `throw new Error(\`Tracking config not found: ${configErr?.message}\`)`
  // L57-68 typedConfig cast + orgName/orgDomain, unchanged (the `as` casts
  //   are load-bearing — the admin client is untyped).

  return withAction(`Tracking run: ${orgName}`, async () => {
    // L73-305 moved with these mechanical conversions:
    //  - signal-execution failure (L93-96): `return Response.json({...error...}, {status:500})`
    //    → `throw new Error(\`Signal execution failed: ${msg}\`)` so failJob
    //    records it and the job retries (attempt 2 of maxAttempts 2).
    //  - the three 200 returns (L146-152 no-change, L161-166 baseline,
    //    L293-305 changed) → return the same plain objects without Response.json.
    //  - the QStash publish (L275-290) → enqueueJob, byte-identical body:
    //      void enqueueJob({
    //        type: "outreach.process",
    //        payload: {
    //          type: "signal",
    //          signalId: config.signal_id,
    //          campaignId: config.campaign_id,
    //          organizationId: config.organization_id ?? undefined,
    //          reason: verdict.reason,
    //          confidence: verdict.confidence,
    //        },
    //      }).catch((err) => {
    //        console.error("[tracking] Failed to enqueue outreach:", err);
    //      });
    //    and update the L272-274 comment: the enqueue replaces the signed
    //    QStash publish; /api/jobs/* auth now guards the outbox path.
    // Everything else — always-insert snapshot (L122 comment), signal_results
    // insert, last_run_at update, diff/classify/describe, threshold_crossed
    // change row, readiness_tag update with the dynamic table pick (L258-270)
    // — stays byte-identical, including all `as` casts.
  });
}
```

Retry-safety note (add as a comment): a retry after partial failure re-executes the signal and inserts a second snapshot with the same hash, which the differ then reports as "no change" — harmless duplicate timeline row, no duplicate outreach (the enqueue only fires on a fresh diff verdict).

Register as:

```typescript
"tracking.run": (payload) => {
  const id = payload.trackingConfigId;
  if (typeof id !== "string") throw new Error("trackingConfigId required");
  return runTrackingConfig(id);
},
```

**Step 2: Delete, verify, test**

Run: `git rm src/app/api/tracking/run/route.ts && grep -rn "api/tracking/run" src/ --include='*.ts'; pnpm typecheck && pnpm test`
Expected: remaining hits only in `src/lib/tools/tracking-tools.ts` (URL strings inside publish calls — converted in Task 11). Typecheck passes (that file imports the qstash module, not the route).

**Step 3: Commit**

```bash
git add -A
git commit -m "feat(jobs): move signal tracking runs to tracking.run executor"
```

---

### Task 10: Executor — `outreach.process` (replaces `/api/outreach/process`)

**Files:**
- Create: `src/lib/jobs/executors/outreach-process.ts`
- Modify: `src/lib/jobs/executors/index.ts`
- Modify: `src/__tests__/outreach-process-followups.test.ts`
- Delete: `src/app/api/outreach/process/route.ts`

**Step 1: Move the route body**

The route (601 lines) has payload types at L31-44 (`SignalPayload`, `FollowupPayload`, `Payload`), a thin `POST` (L46-74), and module-private helpers `handleSignalTrigger` (L78-162), `pickAndDraft` (L166-449), `summarizeEnrichment` (L451-460), `handleFollowups` (L464-584), `checkCondition` (L588-601).

Move the ENTIRE file except the `POST` function and the `verifyQStashSignature` import into the new executor file. The helpers move byte-identical — every comment (especially L47-51 outbox invariant → rewrite to reference CRON_SECRET, L96-110 legacy-path notes, L203-204 no-re-email invariant, L224-230 draftable-vs-sendable gate note, L475-477 waiting-pickup rationale, L569-570 failure-reason note with "QStash logs" → "job logs") comes along. Add the public entry point replacing `POST`:

```typescript
export type { Payload, SignalPayload, FollowupPayload };

export async function processOutreach(payload: Payload) {
  const supabase = getAdminClient();
  if (payload.type === "signal") {
    return handleSignalTrigger(supabase, payload);
  }
  if (payload.type === "followups") {
    return handleFollowups(supabase);
  }
  throw new Error(`Unknown outreach payload type: ${(payload as { type?: string }).type}`);
}
```

Inside the moved helpers, every `NextResponse.json(x)` becomes `return x` (all were 200s — the shapes at L91, L124-128, L139, L156-161, L504, L578-583 are the executor's return values now). Drop the `NextResponse` import.

Register as:

```typescript
"outreach.process": (payload) => processOutreach(payload as Payload),
```

(The recurring seed row's `{"type":"followups"}` payload and tracking.run's signal enqueue both satisfy `Payload`.)

**Step 2: Repoint the followups test**

`src/__tests__/outreach-process-followups.test.ts`:
- Delete the `vi.mock("@/lib/services/qstash", ...)` block (L10-14) and `verifySignatureMock` from the hoisted block (L3-8).
- Replace `import { POST } from "@/app/api/outreach/process/route"` (L37) with `import { processOutreach } from "@/lib/jobs/executors/outreach-process"`.
- Replace the `followupsRequest()` helper (L80+) and every `POST(followupsRequest())` with `processOutreach({ type: "followups" })`; replace `res.json()` assertions with direct assertions on the returned object (same shapes: `{ sent, skipped, total, failures }` / `{ sent: 0 }`).
- The `fakeSupabase` builder and all behavioral assertions stay unchanged — only the entry point moves.

**Step 3: Delete, verify, test**

Run: `git rm src/app/api/outreach/process/route.ts && grep -rn "api/outreach/process" src/ --include='*.ts'; pnpm typecheck && pnpm test`
Expected: no src hits; full suite passes including the repointed followups tests. (`e2e/auth.flow.test.ts` still references the route — fixed in Task 12; e2e doesn't run in `pnpm test`.)

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(jobs): move outreach processing to outreach.process executor"
```

---

### Task 11: Convert agent tracking tools to enqueue jobs

**Files:**
- Modify: `src/lib/tools/tracking-tools.ts`

**Step 1: Replace the QStash publishes**

There are THREE dispatch sites (grep `dispatchImmediateRun` and `publishJSON` — ~L92 in `createTracking`, ~L155 and ~L348 in the bulk/other tools). Replace the helper once:

```typescript
import { enqueueJob } from "@/lib/services/jobs";

/** Enqueue an immediate tracking.run job for a config's baseline snapshot. */
async function dispatchImmediateRun(trackingConfigId: string): Promise<void> {
  try {
    await enqueueJob({
      type: "tracking.run",
      payload: { trackingConfigId },
      maxAttempts: 2,
    });
  } catch (err) {
    // Non-fatal, same contract as the old QStash publish: the config exists
    // and will run on its schedule even if the baseline enqueue fails.
    console.error("[tracking] Failed to enqueue baseline run:", err);
  }
}
```

Remove the `getQStashClient, getBaseUrl` import from `@/lib/services/qstash` (L4). Convert any inline `publishJSON` call sites to `dispatchImmediateRun(config.id)`. `SCHEDULE_INTERVALS` usage (L5, L56-57, L155-156, L348-349) is untouched. The user-facing message "Tracking created with baseline run dispatched" (L97) stays accurate — the run starts within ~1 minute.

**Step 2: Verify and test**

Run: `grep -n "qstash\|publishJSON" src/lib/tools/tracking-tools.ts; pnpm typecheck && pnpm test`
Expected: zero hits; clean.

**Step 3: Commit**

```bash
git add src/lib/tools/tracking-tools.ts
git commit -m "feat(jobs): agent tracking tools enqueue jobs instead of publishing to QStash"
```

---

### Task 12: Middleware cleanup, test cleanup, dead route removal

**Files:**
- Modify: `src/proxy.ts:6-9`
- Delete: `src/__tests__/qstash-verify.test.ts`
- Modify: `e2e/auth.flow.test.ts:45-58`
- Delete (if present): `src/app/api/tracking/collect-test/start/route.ts`

**Step 1: Remove dead public-route entries**

In `src/proxy.ts`, delete the four now-dead matchers (`"/api/outreach/process(.*)"`, `"/api/email/track(.*)"`, `"/api/email/cleanup(.*)"`, `"/api/tracking/(.*)"`), keeping the `"/api/jobs(.*)"` entry added in Task 4 and any unrelated entries.

**Step 2: Delete the QStash signature test**

```bash
git rm src/__tests__/qstash-verify.test.ts
```

Its subject (`verifyQStashSignature`) dies in Task 14; the replacement auth is covered by `jobs-service.test.ts`.

**Step 3: Repoint the e2e public-route test**

`e2e/auth.flow.test.ts:45-58` ("public webhook routes do NOT require auth") POSTs `/api/outreach/process` and asserts `status !== 307` and `status ∈ [200,400,401,422]` — it will get 404 after Task 10. Repoint it at the new scheduler surface with the same intent (publicly reachable, secret-gated, not Clerk-redirected):

```typescript
// The job routes must be publicly reachable (Vercel Cron / pg_cron can't
// send Clerk cookies) but refuse work without the CRON_SECRET bearer.
const res = await request.post("http://localhost:3000/api/jobs/tick", {
  data: {},
});
expect(res.status()).not.toBe(307);
expect(res.status()).toBe(401);
```

Note: CI (`.github/workflows/ci.yaml`) does not run e2e, so verify this locally: `pnpm test:e2e -- --project=auth` (requires the dev server; playwright config starts one).

**Step 4: Remove the dead collect-test route if it still exists**

`docs/plans/2026-04-19-open-source-hardening.md:22` flags `src/app/api/tracking/collect-test/start/route.ts` as a zero-auth QStash enqueue with no remaining callers. Check and remove:

Run: `ls src/app/api/tracking/collect-test/start/route.ts 2>/dev/null && grep -rn "collect-test" src/ --include='*.ts' --include='*.tsx' | grep -v "collect-test/start/route.ts"`
If the file exists and the grep shows no callers: `git rm -r src/app/api/tracking/collect-test`. If callers exist, stop and surface it instead of deleting.

**Step 5: Verify, test, commit**

Run: `pnpm typecheck && pnpm test`
Expected: clean.

```bash
git add -A
git commit -m "chore(jobs): clean up middleware allowlist, QStash tests, dead collect-test route"
```

---

### Task 13: Wire up the schedulers — `vercel.json`, env, setup script, integrations card

**Files:**
- Create: `vercel.json`
- Modify: `.env.example:87-94, :158`
- Modify: `scripts/setup.mjs:362-369` (+ auto-gen special-case ~:392-397)
- Modify: `src/lib/integrations.ts:150-168`

**Step 1: Create `vercel.json`** (repo has none today)

```json
{
  "crons": [
    {
      "path": "/api/jobs/tick",
      "schedule": "* * * * *"
    }
  ]
}
```

Per-minute cadence requires Vercel Pro; Hobby/self-host uses the pg_cron alternative (Task 15 docs). Extra or missing ticks are harmless — the tick endpoint is idempotent by construction.

**Step 2: Update `.env.example`**

Replace the QStash block (lines 87-94) with:

```bash
# ----------------------------------------------------------------------------
# OPTIONAL: Job scheduler (scheduled signal runs, reply tracking, follow-ups)
# ----------------------------------------------------------------------------
# Shared secret for /api/jobs/tick and /api/jobs/run. Vercel Cron sends it
# automatically once set. Generate with: openssl rand -hex 32
# Without it, recurring jobs never run: no scheduled signals, no reply
# detection, no sequence follow-ups.
CRON_SECRET=
```

Update the `VERCEL_URL` comment at :158 ("fallback base URL for QStash webhook callbacks" → "fallback base URL for the job scheduler's self-invocations").

**Step 3: Update `scripts/setup.mjs`**

Replace the QStash group (L362-369) in the optional-integrations `groups` array with:

```javascript
{
  name: "Job scheduler (scheduled signal runs, reply tracking, follow-ups)",
  prompts: [["CRON_SECRET", "Cron secret (leave blank to auto-generate)"]],
},
```

Extend the auto-generation special-case (the `EMAIL_CREDENTIALS_KEY` pattern at ~L392-397) so a blank `CRON_SECRET` answer generates one (`crypto.randomBytes(32).toString("hex")`), mirroring how that key is produced. Follow the file's existing style exactly.

**Step 4: Update the integrations card**

In `src/lib/integrations.ts`, replace the qstash entry (L150-168) in place — the whole chain (status route → hook → settings panel) is data-driven, so only this object changes:

```typescript
{
  id: "cron",
  name: "Job scheduler",
  category: "scheduling",
  severity: "optional",
  feature: "Scheduled signal runs, reply tracking, follow-ups, background jobs",
  consequence:
    "Recurring jobs never run: signals only run when triggered manually, replies and bounces go undetected, and sequence follow-ups never send.",
  envVars: ["CRON_SECRET"],
  signupUrl: "https://vercel.com/docs/cron-jobs",
  keysUrl: "https://vercel.com/docs/cron-jobs",
  fixHint: "Set CRON_SECRET (openssl rand -hex 32) locally and in Vercel",
},
```

Keep the `scheduling` category member (:19) and `CATEGORY_LABELS` entry (:258) — the category is still populated. `missing-key-banner-stack.tsx` only surfaces `required` severity, so no banner changes.

**Step 5: Verify, test, commit**

Run: `grep -rn "QSTASH" src/ scripts/ .env.example; pnpm typecheck && pnpm test`
Expected: hits only in `src/lib/services/qstash.ts` (removed next task).

```bash
git add vercel.json .env.example scripts/setup.mjs src/lib/integrations.ts
git commit -m "feat(jobs): Vercel cron + CRON_SECRET replace QStash across env, setup, integrations"
```

---

### Task 14: Remove QStash entirely

**Files:**
- Delete: `src/lib/services/qstash.ts`
- Modify: `package.json` (remove `@upstash/qstash`)

**Step 1: Delete and remove the dependency**

```bash
git rm src/lib/services/qstash.ts
pnpm remove @upstash/qstash
```

**Step 2: Full verification**

Run: `grep -rni "qstash\|upstash" src/ scripts/ package.json e2e/ | grep -v node_modules; pnpm typecheck && pnpm test && pnpm lint`
Expected: zero hits (comment-only mentions in services were reworded when those files were touched; any stragglers like `admin.ts:8`'s docblock get reworded now — "QStash webhook handlers" → "job runner"). All checks pass.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat(jobs): remove QStash dependency and service"
```

---

### Task 15: Documentation

**Files:**
- Modify: `README.md:71`
- Modify: `docs/architecture.md:20,41,95,104`
- Modify: `docs/setup.md:110-119`

**Step 1: `README.md`**

Line 71 tech-stack list: `- **Jobs** — QStash (Upstash) for scheduled signal runs` → `- **Jobs** — Postgres job queue (in-repo) driven by Vercel Cron or pg_cron`.

**Step 2: `docs/architecture.md`**

- L20 diagram: `├──▶ QStash (scheduled jobs)` → `├──▶ jobs table (Postgres queue, Vercel Cron tick)`.
- L41: drop `qstash` from the services list, add `jobs`.
- L95 ("Signal run" flow) and L104 ("Outreach send" flow): rewrite the QStash-webhook steps to the new flow: tick claims → runner executes `tracking.run` / `email.track` / `outreach.process` executors.
- Add a short "Job queue" section: the `jobs` table, `claim_jobs()` semantics (SKIP LOCKED, per-user fairness, singleton keys, lease reaping), tick/run routes, the five job types table from this plan, and the worker migration path.
- Fix the two stale pixel-tracking lines while in the file: ~L36 (`tracking/ # email open/click tracking endpoints`) and ~L68 (`tracking_* | Open / click pixel tracking`) — `tracking_*` is company-signal monitoring; Signal deliberately sends no pixel, and `opened`/`clicked` statuses are never written.

**Step 3: `docs/setup.md`**

Replace the QStash row (L119) in the optional-services table with a "Job scheduler" row, and add a subsection:
- `CRON_SECRET` generation; Vercel Cron picks it up automatically; `vercel.json` ships the per-minute schedule (Pro needed for per-minute cadence).
- Self-host / Hobby alternative via Supabase SQL editor:
  ```sql
  select cron.schedule(
    'signal-jobs-tick',
    '* * * * *',
    $$
    select net.http_post(
      url := 'https://YOUR-APP-DOMAIN/api/jobs/tick',
      headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET')
    )
    $$
  );
  ```
- Note that the seeded recurring jobs self-heal: re-running the migration's `insert ... on conflict do nothing` restores a deleted row.

**Step 4: Commit**

```bash
git add README.md docs/architecture.md docs/setup.md
git commit -m "docs: job queue architecture + setup; fix stale tracking-pixel claims"
```

---

### Task 16: End-to-end local verification

**Step 1: Set the secret and start**

Add `CRON_SECRET=localdev-secret` to `.env.local` (it currently has QSTASH_* keys set — leave them; they're inert once the code is gone). Ensure `supabase start` is running, then `pnpm dev`.

**Step 2: Fire the tick and watch a full lifecycle**

```bash
curl -s -H "Authorization: Bearer localdev-secret" http://localhost:3000/api/jobs/tick
```
Expected: `{"claimed":4,"dispatched":4}` first call (all four seeded jobs due).

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  -c "select type, status, attempts, last_error, run_at > now() as rearmed from jobs order by type;"
```
Expected within ~a minute: recurring jobs back to `pending`, `rearmed = t`. A `last_error` on `email.track` locally (no Gmail creds) still proves the lifecycle: claim → run → fail → re-arm.

**Step 3: Verify a one-off flows through the retry ladder**

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  -c "insert into jobs (type, payload, max_attempts) values ('tracking.run', '{\"trackingConfigId\":\"00000000-0000-0000-0000-000000000000\"}', 2);"
curl -s -H "Authorization: Bearer localdev-secret" http://localhost:3000/api/jobs/tick
```
Expected: claimed; fails on the fake id; back to `pending` with `run_at` ~1 min out; after another tick past that time, `dead` at `attempts = 2` with `last_error` containing "Tracking config not found".

**Step 4: Auth checks + full suites**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/jobs/tick          # expect 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/jobs/run   # expect 401
pnpm typecheck && pnpm test && pnpm lint
pnpm test:e2e -- --project=auth
```
Expected: 401s, all suites green.

**Step 5: Production cutover checklist (human, post-merge)**

1. Set `CRON_SECRET` in Vercel env (production).
2. Apply the migration to remote Supabase (deploy pipeline / `supabase db push`).
3. Deploy; confirm the cron appears under Vercel → Project → Cron Jobs and the first tick returns `{"claimed":4,...}` in logs.
4. Delete the old QStash schedules in the Upstash console; remove `QSTASH_*` env vars from Vercel and `.env.local`.
5. Watch the `jobs` table for a day: recurring rows re-arming, `last_error` mostly null, nothing stuck in `running` past its lease.
