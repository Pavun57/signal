export type OutreachTone =
  | "primary"
  | "warn"
  | "muted"
  | "success"
  | "neutral"
  | "danger";

export interface OutreachStatusDef {
  label: string;
  description: string;
  tone: OutreachTone;
}

export const OUTREACH_STATUS = {
  needs_review: {
    label: "Needs review",
    description: "Waiting for you to approve or reject",
    tone: "warn",
  },
  ready: {
    label: "Ready to send",
    description: "Approved and past the scheduled delay",
    tone: "primary",
  },
  waiting: {
    label: "Waiting",
    description: "Approved, scheduled to send later",
    tone: "muted",
  },
  sent: {
    label: "Sent",
    description: "Delivered, awaiting reply",
    tone: "neutral",
  },
  replied: {
    label: "Replied",
    description: "The contact responded",
    tone: "success",
  },
  blocked: {
    label: "Blocked",
    description: "Ready to send but something needs fixing",
    tone: "warn",
  },
  rejected: {
    label: "Rejected",
    description: "Won't send; here for reference",
    tone: "neutral",
  },
  // ── states the activity feed adds ────────────────────────────────────────
  // These describe a piece of mail rather than a review decision, which is why
  // they live here beside the others rather than in status-styles.ts: that map
  // renders the campaign_people.outreach_status enum, and these are not values
  // of it.
  bounced: {
    label: "Bounced",
    description: "The address rejected it; verification was cleared",
    tone: "danger",
  },
  queued: {
    label: "Queued",
    description: "Claimed and about to go out",
    tone: "muted",
  },
  scheduled: {
    label: "Scheduled",
    description: "Approved, waiting for its send time",
    tone: "muted",
  },
  // Deliberately muted, not danger. Deferrals (daily cap reached, sending
  // paused, outside the send window) are routine and resolve on their own;
  // each draft's specific reason is in its last_error.
  deferred: {
    label: "Deferred",
    description: "Will retry automatically; see each draft for the reason",
    tone: "muted",
  },
  failed: {
    label: "Failed",
    description: "The send errored and can be retried",
    tone: "danger",
  },
} as const satisfies Record<string, OutreachStatusDef>;

export type OutreachStatus = keyof typeof OUTREACH_STATUS;

export function resolveDbEnrollmentStatus(
  dbStatus: string,
  nextSendAt?: string | null,
): OutreachStatus | null {
  switch (dbStatus) {
    case "waiting":
    case "queued":
      return "waiting";
    case "active":
      // An active enrollment past its scheduled delay is "Ready to send":
      // the cron will pick it up this tick. Without the timestamp the
      // "ready" column could never contain a card; every mapping collapsed
      // to "sent".
      return nextSendAt && new Date(nextSendAt).getTime() <= Date.now()
        ? "ready"
        : "sent";
    case "replied":
      return "replied";
    default:
      return null;
  }
}
