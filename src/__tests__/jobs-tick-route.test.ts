import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAdminClientMock } = vi.hoisted(() => ({
  getAdminClientMock: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ getAdminClient: getAdminClientMock }));

import { GET } from "@/app/api/jobs/tick/route";

function tickRequest(auth?: string): Request {
  return new Request("http://localhost:3000/api/jobs/tick", {
    headers: auth ? { authorization: auth } : {},
  });
}

describe("GET /api/jobs/tick", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("401s without the bearer secret", async () => {
    const res = await GET(tickRequest());
    expect(res.status).toBe(401);
  });

  it("claims jobs via rpc and POSTs each to /api/jobs/run", async () => {
    getAdminClientMock.mockReturnValue({
      rpc: vi
        .fn()
        .mockResolvedValue({ data: [{ id: "j1" }, { id: "j2" }], error: null }),
    });
    const res = await GET(tickRequest("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 2, dispatched: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/jobs/run");
    expect(init.headers.authorization).toBe("Bearer s3cret");
    expect(JSON.parse(init.body)).toEqual({ jobId: "j1" });
  });

  it("reports a failed dispatch without failing the tick", async () => {
    getAdminClientMock.mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: [{ id: "j1" }], error: null }),
    });
    fetchMock.mockRejectedValue(new Error("network"));
    const res = await GET(tickRequest("Bearer s3cret"));
    expect(await res.json()).toEqual({ claimed: 1, dispatched: 0 });
  });
});
