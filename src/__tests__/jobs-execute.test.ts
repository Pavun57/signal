import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAdminClientMock, completeJobMock, failJobMock, executorsMock } =
  vi.hoisted(() => ({
    getAdminClientMock: vi.fn(),
    completeJobMock: vi.fn(),
    failJobMock: vi.fn(),
    executorsMock: {} as Record<string, ReturnType<typeof vi.fn>>,
  }));

vi.mock("@/lib/supabase/admin", () => ({ getAdminClient: getAdminClientMock }));
vi.mock("@/lib/services/jobs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  completeJob: completeJobMock,
  failJob: failJobMock,
}));
vi.mock("@/lib/jobs/executors", () => ({ executors: executorsMock }));

import { executeClaimedJob } from "@/lib/jobs/execute";

function adminReturning(row: unknown) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: row, error: null }),
          }),
        }),
      }),
    }),
  } as never;
}

const runningJob = {
  id: "j1",
  type: "email.track",
  status: "running",
  payload: { a: 1 },
  attempts: 1,
  max_attempts: 5,
  recurring_interval_seconds: null,
};

describe("executeClaimedJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(executorsMock)) delete executorsMock[k];
  });

  it("runs the executor and completes the job", async () => {
    executorsMock["email.track"] = vi.fn().mockResolvedValue(undefined);
    getAdminClientMock.mockReturnValue(adminReturning(runningJob));
    await executeClaimedJob("j1");
    expect(executorsMock["email.track"]).toHaveBeenCalledWith(
      { a: 1 },
      expect.objectContaining({ id: "j1" }),
    );
    expect(completeJobMock).toHaveBeenCalled();
    expect(failJobMock).not.toHaveBeenCalled();
  });

  it("fails the job when the executor throws", async () => {
    executorsMock["email.track"] = vi.fn().mockRejectedValue(new Error("x"));
    getAdminClientMock.mockReturnValue(adminReturning(runningJob));
    await executeClaimedJob("j1");
    expect(failJobMock).toHaveBeenCalled();
    expect(completeJobMock).not.toHaveBeenCalled();
  });

  it("dead-letters unknown job types instead of retrying them forever", async () => {
    getAdminClientMock.mockReturnValue(
      adminReturning({ ...runningJob, type: "no.such.type" }),
    );
    await executeClaimedJob("j1");
    expect(failJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 5 }), // forced to max → dead
      expect.any(Error),
    );
  });

  it("no-ops when the job is not running (reaped lease or stale id)", async () => {
    getAdminClientMock.mockReturnValue(adminReturning(null));
    await executeClaimedJob("j1");
    expect(completeJobMock).not.toHaveBeenCalled();
    expect(failJobMock).not.toHaveBeenCalled();
  });
});
