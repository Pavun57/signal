import { getAdminClient } from "@/lib/supabase/admin";
import { enqueueJob } from "@/lib/services/jobs";
import { SCHEDULE_INTERVALS } from "@/lib/types/tracking";
import type { Schedule } from "@/lib/types/tracking";

/**
 * Finds due tracking configs and enqueues one tracking.run job per config
 * (recurring job, every 15 min). next_run_at advances at enqueue time, same
 * as the old dispatch route, so a config is never double-dispatched
 * even if the run itself later fails.
 */
export async function dispatchDueTracking(): Promise<{ dispatched: number }> {
  const { data: configs, error } = await getAdminClient()
    .from("tracking_configs")
    .select("id, schedule, campaign:campaigns(user_id)")
    .eq("status", "active")
    .lte("next_run_at", new Date().toISOString());
  if (error) {
    throw new Error(`Failed to query tracking configs: ${error.message}`);
  }

  let dispatched = 0;
  for (const config of configs ?? []) {
    // The untyped admin client may surface the joined campaign as an object
    // or a one-element array depending on client typings — handle both so
    // the owner's user_id always lands on the job's queue partition.
    const campaign = Array.isArray(config.campaign)
      ? (config.campaign[0] as { user_id?: string | null } | undefined)
      : (config.campaign as { user_id?: string | null } | null);
    await enqueueJob({
      type: "tracking.run",
      payload: { trackingConfigId: config.id },
      // Partition the queue by the campaign owner so one user's tracking
      // load can't starve everyone else via the shared '<system>' bucket.
      userId: campaign?.user_id ?? null,
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
