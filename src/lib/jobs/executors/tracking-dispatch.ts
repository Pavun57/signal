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
