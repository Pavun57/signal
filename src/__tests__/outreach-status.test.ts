import { describe, expect, it } from "vitest";
import {
  OUTREACH_STATUS,
  type OutreachStatus,
  resolveDbEnrollmentStatus,
} from "@/lib/outreach/status";

describe("outreach status registry", () => {
  it("exposes a single canonical status for every lifecycle stage", () => {
    const keys = Object.keys(OUTREACH_STATUS) as OutreachStatus[];
    // Exact on purpose. A new status is a product decision, so adding one
    // should require saying so here rather than sliding in unnoticed.
    expect(keys).toEqual([
      // review lifecycle
      "needs_review",
      "ready",
      "waiting",
      "sent",
      "replied",
      "blocked",
      "rejected",
      // states the activity feed adds
      "bounced",
      "queued",
      "scheduled",
      "deferred",
      "failed",
    ]);
  });

  it("keeps deferred visually distinct from the real failures", () => {
    // Hitting the daily cap is routine and resolves itself tomorrow. Showing
    // it in the same red as a bounce or an SMTP error would train users to
    // ignore the states that actually need them.
    expect(OUTREACH_STATUS.deferred.tone).toBe("muted");
    expect(OUTREACH_STATUS.failed.tone).toBe("danger");
    expect(OUTREACH_STATUS.bounced.tone).toBe("danger");
  });

  it("maps DB enrollment status to canonical status", () => {
    expect(resolveDbEnrollmentStatus("waiting")).toBe("waiting");
    expect(resolveDbEnrollmentStatus("queued")).toBe("waiting");
    expect(resolveDbEnrollmentStatus("active")).toBe("sent");
    expect(resolveDbEnrollmentStatus("replied")).toBe("replied");
  });

  it("each status defines label, description and tone", () => {
    for (const def of Object.values(OUTREACH_STATUS)) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect([
        "primary",
        "warn",
        "muted",
        "success",
        "neutral",
        "danger",
      ]).toContain(def.tone);
    }
  });
});
