import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAdminClientMock } = vi.hoisted(() => ({
  getAdminClientMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: getAdminClientMock,
}));

import {
  backoffSeconds,
  completeJob,
  enqueueJob,
  failJob,
  isJobRequestAuthorized,
  type JobRow,
} from "@/lib/services/jobs";

/** Records .from().update().eq() and .from().insert().select().single(). */
function fakeAdmin() {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { eq: () => Promise.resolve({ error: null }) };
      },
      insert: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: "job-1" }, error: null }),
          }),
        };
      },
    }),
  };
  return { client: client as never, updates, inserts };
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    type: "email.track",
    status: "running",
    run_at: new Date().toISOString(),
    payload: {},
    user_id: null,
    singleton_key: null,
    priority: 100,
    attempts: 1,
    max_attempts: 5,
    locked_until: null,
    last_error: null,
    recurring_interval_seconds: null,
    ...overrides,
  };
}

describe("backoffSeconds", () => {
  it("escalates 1m, 5m, 15m, 1h, 6h and caps there", () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(300);
    expect(backoffSeconds(3)).toBe(900);
    expect(backoffSeconds(4)).toBe(3600);
    expect(backoffSeconds(5)).toBe(21600);
    expect(backoffSeconds(99)).toBe(21600);
  });
});

describe("completeJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks one-off jobs completed", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await completeJob(job());
    expect(updates[0].values.status).toBe("completed");
    expect(updates[0].values.completed_at).toBeTruthy();
  });

  it("re-arms recurring jobs to pending at now + interval, attempts reset", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await completeJob(job({ recurring_interval_seconds: 600 }));
    expect(updates[0].values.status).toBe("pending");
    expect(updates[0].values.attempts).toBe(0);
    const runAt = new Date(updates[0].values.run_at as string).getTime();
    expect(runAt).toBeGreaterThan(Date.now() + 500_000);
  });
});

describe("failJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries a one-off with backoff while attempts remain", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await failJob(job({ attempts: 2, max_attempts: 5 }), new Error("boom"));
    expect(updates[0].values.status).toBe("pending");
    expect(updates[0].values.last_error).toContain("boom");
    const runAt = new Date(updates[0].values.run_at as string).getTime();
    expect(runAt).toBeGreaterThan(Date.now() + 200_000); // attempt 2 → 5 min
  });

  it("marks a one-off dead once attempts are exhausted", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await failJob(job({ attempts: 5, max_attempts: 5 }), new Error("boom"));
    expect(updates[0].values.status).toBe("dead");
  });

  it("always re-arms recurring jobs, even at max attempts", async () => {
    const { client, updates } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    await failJob(
      job({ attempts: 1, max_attempts: 1, recurring_interval_seconds: 600 }),
      new Error("imap down"),
    );
    expect(updates[0].values.status).toBe("pending");
    expect(updates[0].values.last_error).toContain("imap down");
  });
});

describe("enqueueJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a pending job and returns its id", async () => {
    const { client, inserts } = fakeAdmin();
    getAdminClientMock.mockReturnValue(client);
    const id = await enqueueJob({
      type: "tracking.run",
      payload: { trackingConfigId: "abc" },
    });
    expect(id).toBe("job-1");
    expect(inserts[0].values.type).toBe("tracking.run");
    expect(inserts[0].values.status).toBe("pending");
  });
});

describe("isJobRequestAuthorized", () => {
  it("accepts only the exact bearer secret, and nothing when unset", () => {
    const req = (auth?: string) =>
      new Request("http://x/api/jobs/tick", {
        headers: auth ? { authorization: auth } : {},
      });
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isJobRequestAuthorized(req("Bearer s3cret"))).toBe(true);
    expect(isJobRequestAuthorized(req("Bearer wrong"))).toBe(false);
    expect(isJobRequestAuthorized(req())).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(isJobRequestAuthorized(req("Bearer s3cret"))).toBe(false);
    vi.unstubAllEnvs();
  });
});
