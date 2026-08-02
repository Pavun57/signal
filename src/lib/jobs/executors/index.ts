import type { JobRow } from "@/lib/services/jobs";
import { trackEmailReplies } from "@/lib/jobs/executors/email-track";

export type JobExecutor = (
  payload: Record<string, unknown>,
  job: JobRow,
) => Promise<unknown>;

/** type → executor. Every job type the tick can claim must be registered. */
export const executors: Record<string, JobExecutor> = {
  "email.track": () => trackEmailReplies(),
};
