import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueJobMock } = vi.hoisted(() => ({
  enqueueJobMock: vi.fn().mockResolvedValue("job_1"),
}));

vi.mock("@/lib/services/jobs", () => ({
  enqueueJob: enqueueJobMock,
}));

let advanceError: { message: string } | null = null;
const order: string[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => {
        if (table === "tracking_configs" && order.at(-1) === "advance") {
          // terminal .eq of the update chain resolves via then below
        }
        return builder;
      };
      builder.lte = () =>
        Promise.resolve({
          data: [
            {
              id: "cfg_1",
              schedule: "daily",
              campaign: { user_id: "user_1" },
            },
          ],
          error: null,
        });
      builder.update = () => {
        order.push("advance");
        return builder;
      };
      builder.then = (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) =>
        Promise.resolve({ data: null, error: advanceError }).then(
          resolve,
          reject,
        );
      return builder;
    },
  }),
}));

import { dispatchDueTracking } from "@/lib/jobs/executors/tracking-dispatch";

beforeEach(() => {
  enqueueJobMock.mockClear();
  order.length = 0;
  advanceError = null;
});

describe("dispatchDueTracking ordering", () => {
  it("advances next_run_at before enqueueing, so a failed advance cannot loop", async () => {
    enqueueJobMock.mockImplementation(async () => {
      order.push("enqueue");
      return "job_1";
    });

    const result = await dispatchDueTracking();

    expect(result.dispatched).toBe(1);
    expect(order).toEqual(["advance", "enqueue"]);
    expect(enqueueJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ singletonKey: "tracking-run:cfg_1" }),
    );
  });

  it("skips the enqueue entirely when the advance fails", async () => {
    // Regression: a silently failed advance left next_run_at in the past,
    // so every 15-minute dispatch re-enqueued the same config forever:
    // duplicate executions, snapshots, LLM spend, and outreach enqueues.
    advanceError = { message: "connection reset" };

    const result = await dispatchDueTracking();

    expect(result.dispatched).toBe(0);
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});
