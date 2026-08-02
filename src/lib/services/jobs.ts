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
