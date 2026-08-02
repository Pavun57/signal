import type { JobRow } from "@/lib/services/jobs";
import { cleanupEmails } from "@/lib/jobs/executors/email-cleanup";
import { trackEmailReplies } from "@/lib/jobs/executors/email-track";
import { dispatchDueTracking } from "@/lib/jobs/executors/tracking-dispatch";

export type JobExecutor = (
  payload: Record<string, unknown>,
  job: JobRow,
) => Promise<unknown>;

/** type → executor. Every job type the tick can claim must be registered. */
export const executors: Record<string, JobExecutor> = {
  "email.track": () => trackEmailReplies(),
  "email.cleanup": () => cleanupEmails(),
  "tracking.dispatch": () => dispatchDueTracking(),
};
