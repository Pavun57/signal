import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getOutreachPerformance's failure honesty. A failed replies fetch used to
 * default to [], every send got intent=null, and the tool reported a 0%
 * reply rate: the agent then told the user "nothing is converting" as a
 * confident conclusion drawn from a swallowed outage.
 */

let repliesError: { message: string } | null = null;

function chain(table: string) {
  const c: Record<string, unknown> & PromiseLike<unknown> = {
    select: () => c,
    eq: () => c,
    gte: () => c,
    limit: () => c,
    in: () => c,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
      if (table === "sent_emails") {
        return Promise.resolve({
          data: [
            {
              id: "s1",
              sent_local_hour: 9,
              sent_weekday: 2,
              step_number: 1,
              sequence_id: null,
              campaign_id: null,
              features: {},
            },
          ],
          error: null,
        }).then(onF, onR);
      }
      if (table === "email_replies") {
        return Promise.resolve(
          repliesError
            ? { data: null, error: repliesError }
            : { data: [], error: null },
        ).then(onF, onR);
      }
      return Promise.resolve({ data: [], error: null }).then(onF, onR);
    },
  } as unknown as Record<string, unknown> & PromiseLike<unknown>;
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: (t: string) => chain(t) })),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user-1" })),
}));

import { getOutreachPerformance } from "@/lib/tools/learning-tools";

beforeEach(() => {
  repliesError = null;
});

describe("getOutreachPerformance", () => {
  it("refuses to fabricate a 0% reply rate from a failed replies fetch", async () => {
    repliesError = { message: "connection reset by peer" };

    const result = (await getOutreachPerformance.execute!({}, {} as never)) as {
      error?: string;
    };

    expect(result.error).toContain("connection reset");
    expect(result.error).toMatch(/retry/i);
  });

  it("still computes when the replies fetch succeeds", async () => {
    const result = (await getOutreachPerformance.execute!({}, {} as never)) as {
      error?: string;
      sends?: number;
    };

    expect(result.error).toBeUndefined();
  });
});
