import { describe, expect, it, vi, beforeEach } from "vitest";

const { flushMock, completeJobMock, failJobMock, testExecutor } = vi.hoisted(
  () => ({
    flushMock: vi.fn().mockResolvedValue(undefined),
    completeJobMock: vi.fn(),
    failJobMock: vi.fn(),
    testExecutor: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: "job_1",
                type: "test.job",
                status: "running",
                payload: {},
                attempts: 1,
                max_attempts: 1,
                recurring_interval_seconds: null,
              },
            }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/services/jobs", () => ({
  completeJob: completeJobMock,
  failJob: failJobMock,
}));
vi.mock("@/lib/jobs/executors", () => ({
  executors: { "test.job": testExecutor },
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: () => ({ flush: flushMock }),
}));

import { executeClaimedJob } from "@/lib/jobs/execute";

beforeEach(() => {
  flushMock.mockClear();
  completeJobMock.mockClear();
  failJobMock.mockClear();
  testExecutor.mockReset();
});

// Serverless: anything not awaited before the function returns may be
// dropped when Vercel freezes the instance. The flush is what guarantees
// executor-captured events (sends, fires) actually leave the process.
describe("executeClaimedJob posthog flush", () => {
  it("flushes after a successful run", async () => {
    testExecutor.mockResolvedValue(undefined);

    await executeClaimedJob("job_1");

    expect(completeJobMock).toHaveBeenCalledTimes(1);
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("flushes even when the executor fails", async () => {
    testExecutor.mockRejectedValue(new Error("boom"));

    await executeClaimedJob("job_1");

    expect(failJobMock).toHaveBeenCalledTimes(1);
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("a failing flush never fails the job run", async () => {
    testExecutor.mockResolvedValue(undefined);
    flushMock.mockRejectedValueOnce(new Error("network"));

    await expect(executeClaimedJob("job_1")).resolves.toBeUndefined();
  });
});
