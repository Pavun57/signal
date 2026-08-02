import type { JobRow } from "@/lib/services/jobs";

export type JobExecutor = (
  payload: Record<string, unknown>,
  job: JobRow,
) => Promise<unknown>;

/** type → executor. Every job type the tick can claim must be registered. */
export const executors: Record<string, JobExecutor> = {};
