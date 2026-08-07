import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: vi.fn(),
}));

import { cleanupEmails } from "@/lib/jobs/executors/email-cleanup";
import { getAdminClient } from "@/lib/supabase/admin";

const adminMock = vi.mocked(getAdminClient);

interface RecordedCall {
  table: string;
  ops: Array<{ name: string; args: unknown[] }>;
}

function fakeSupabase(
  responses: Array<{ data?: unknown; error?: unknown; count?: number }>,
) {
  let i = 0;
  const calls: RecordedCall[] = [];
  const from = (table: string) => {
    const call: RecordedCall = { table, ops: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const name of [
      "select",
      "eq",
      "in",
      "not",
      "is",
      "or",
      "lt",
      "update",
      "delete",
      "single",
      "maybeSingle",
    ]) {
      builder[name] = (...args: unknown[]) => {
        call.ops.push({ name, args });
        return builder;
      };
    }
    builder.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) =>
      Promise.resolve(responses[i++] ?? { data: null, error: null }).then(
        resolve,
        reject,
      );
    return builder;
  };
  return { calls, client: { from } as never };
}

const stuckDraft = {
  id: "d1",
  enrollment_id: "enr_1",
  campaign_people_id: "cp_1",
  sequence_step_id: "s1",
};

describe("cleanupEmails stranded-queued recovery", () => {
  it("marks a delivered draft sent AND finishes the enrollment bookkeeping", async () => {
    // K5: marking the draft "sent" while leaving the enrollment pinned to
    // that step made every followups run fail "No approved draft ready for
    // this step" forever. Recovery now advances the enrollment (here: to
    // completed, no next step) and syncs campaign_people, monotonically.
    const { client, calls } = fakeSupabase([
      { data: [stuckDraft] }, // stuck scan
      { data: [{ draft_id: "d1" }] }, // sent_emails lookup: it was delivered
      {}, // drafts -> sent
      { data: { sequence_id: "seq_1", current_step: 1 } }, // step check: enrollment
      { data: { id: "s1" } }, // step check: current step row
      { data: { id: "enr_1", sequence_id: "seq_1", current_step: 1 } }, // advance: enrollment
      { data: null }, // advance: no next step
      {}, // enrollment -> completed
      {}, // campaign_people -> sent (guarded)
      { count: 0 }, // discarded delete
      { count: 0 }, // stale delete
    ]);
    adminMock.mockReturnValue(client as never);

    const result = await cleanupEmails();

    expect(result.recovered).toEqual({ markedSent: 1, returnedToDraft: 0 });
    const enrollmentWrite = calls.find(
      (c) =>
        c.table === "sequence_enrollments" &&
        c.ops.some((op) => op.name === "update"),
    );
    expect(enrollmentWrite?.ops).toContainEqual({
      name: "update",
      args: [expect.objectContaining({ status: "completed" })],
    });
    const cpWrite = calls.find(
      (c) =>
        c.table === "campaign_people" &&
        c.ops.some((op) => op.name === "update"),
    );
    expect(cpWrite?.ops).toContainEqual({
      name: "not",
      args: [
        "outreach_status",
        "in",
        '("replied","bounced","complained","unsubscribed")',
      ],
    });
  });

  it("fails the run when the sent_emails lookup fails, touching nothing", async () => {
    // Regression: a failed lookup used to read as "no sent rows", so every
    // stuck draft was classified never-sent and reset to "draft": the next
    // cron re-sent emails that had already been delivered.
    const { client, calls } = fakeSupabase([
      { data: [stuckDraft] }, // stuck scan
      { data: null, error: { message: "connection reset" } }, // lookup fails
    ]);
    adminMock.mockReturnValue(client as never);

    await expect(cleanupEmails()).rejects.toThrow(/sent_emails lookup/);
    expect(
      calls.some(
        (c) =>
          c.table === "email_drafts" &&
          c.ops.some(
            (op) =>
              op.name === "update" &&
              (op.args[0] as { status?: string }).status === "draft",
          ),
      ),
    ).toBe(false);
  });

  it("still releases genuinely never-sent drafts back to draft", async () => {
    const { client, calls } = fakeSupabase([
      { data: [stuckDraft] }, // stuck scan
      { data: [] }, // no sent_emails row: the send never happened
      {}, // drafts -> draft
      { count: 0 },
      { count: 0 },
    ]);
    adminMock.mockReturnValue(client as never);

    const result = await cleanupEmails();

    expect(result.recovered).toEqual({ markedSent: 0, returnedToDraft: 1 });
    // No enrollment/campaign_people writes on this path.
    expect(calls.some((c) => c.table === "sequence_enrollments")).toBe(false);
    expect(calls.some((c) => c.table === "campaign_people")).toBe(false);
  });
});
