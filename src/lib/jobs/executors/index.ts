import type { JobRow } from "@/lib/services/jobs";
import { cleanupEmails } from "@/lib/jobs/executors/email-cleanup";
import { classifyReplies } from "@/lib/jobs/executors/email-classify";
import { trackEmailReplies } from "@/lib/jobs/executors/email-track";
import {
  processOutreach,
  type Payload,
} from "@/lib/jobs/executors/outreach-process";
import {
  runOutreachLearning,
  type LearnPayload,
} from "@/lib/jobs/executors/outreach-learn";
import { backfillReplyBodies } from "@/lib/jobs/executors/reply-backfill";
import { dispatchDueTracking } from "@/lib/jobs/executors/tracking-dispatch";
import { runTrackingConfig } from "@/lib/jobs/executors/tracking-run";

export type JobExecutor = (
  payload: Record<string, unknown>,
  job: JobRow,
) => Promise<unknown>;

/** type → executor. Every job type the tick can claim must be registered. */
export const executors: Record<string, JobExecutor> = {
  "email.track": () => trackEmailReplies(),
  "email.classify": () => classifyReplies(),
  "email.cleanup": () => cleanupEmails(),
  // One-shot, not recurring. Re-enqueues itself while work remains, capped.
  "email.backfill-replies": (payload) => backfillReplyBodies(payload),
  "tracking.dispatch": () => dispatchDueTracking(),
  "outreach.process": (payload) =>
    processOutreach(payload as unknown as Payload),
  "outreach.learn": (payload) =>
    runOutreachLearning(payload as unknown as LearnPayload),
  "tracking.run": (payload) => {
    const id = payload.trackingConfigId;
    if (typeof id !== "string") throw new Error("trackingConfigId required");
    return runTrackingConfig(id);
  },
};
