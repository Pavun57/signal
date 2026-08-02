import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeClaimedJobMock } = vi.hoisted(() => ({
  executeClaimedJobMock: vi.fn(),
}));

vi.mock("@/lib/jobs/execute", () => ({
  executeClaimedJob: executeClaimedJobMock,
}));
// after() needs a real Next request scope; in tests, run the callback inline.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: (fn: () => unknown) => void fn(),
}));

import { POST } from "@/app/api/jobs/run/route";

function runRequest(body: unknown, auth?: string): Request {
  return new Request("http://localhost:3000/api/jobs/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/jobs/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "s3cret");
    executeClaimedJobMock.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("401s without the bearer secret", async () => {
    const res = await POST(runRequest({ jobId: "j1" }));
    expect(res.status).toBe(401);
    expect(executeClaimedJobMock).not.toHaveBeenCalled();
  });

  it("400s on a missing jobId", async () => {
    const res = await POST(runRequest({}, "Bearer s3cret"));
    expect(res.status).toBe(400);
  });

  it("202s and executes the job", async () => {
    const res = await POST(runRequest({ jobId: "j1" }, "Bearer s3cret"));
    expect(res.status).toBe(202);
    expect(executeClaimedJobMock).toHaveBeenCalledWith("j1");
  });
});
