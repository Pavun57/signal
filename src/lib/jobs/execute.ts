import { getAdminClient } from "@/lib/supabase/admin";
import { completeJob, failJob, type JobRow } from "@/lib/services/jobs";
import { executors } from "@/lib/jobs/executors";
import { getPostHogClient } from "@/lib/posthog-server";

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
  } finally {
    // Serverless: anything not awaited before the function returns may be
    // dropped when Vercel freezes the instance, and executors capture
    // events (sends, fires) that must not vanish.
    await getPostHogClient()
      .flush()
      .catch((err) => console.error("[jobs] posthog flush failed:", err));
  }
}
