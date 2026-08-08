import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * findEmails' batch pre-checks. The affiliation-confidence query is what
 * stands between "an error happened" and a fabricated data-quality verdict:
 * with an empty confidence map every id falls below the send threshold and
 * the tool reports "N skipped: not confirmed to work at this company", which
 * the agent relays to the user as fact.
 */

let selectError: { message: string } | null = null;

const fakeSupabase = {
  from: () => {
    const c: Record<string, unknown> & PromiseLike<unknown> = {
      select: () => c,
      in: () => c,
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(
          selectError
            ? { data: null, error: selectError }
            : { data: [], error: null },
        ).then(onF, onR),
    } as unknown as Record<string, unknown> & PromiseLike<unknown>;
    return c;
  },
};

vi.mock("@/lib/tools/ownership", () => ({
  toolSession: async () => ({ supabase: fakeSupabase, userId: "u1" }),
  callerHoldsPerson: async () => true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeSupabase,
}));

import { findEmails } from "@/lib/tools/email-tools";

type FindEmailsResult = {
  found: unknown[];
  notFound: string[];
  skipped: string[];
  summary: string;
};

const run = (personIds: string[]) =>
  (
    findEmails as unknown as {
      execute: (input: { personIds: string[] }) => Promise<FindEmailsResult>;
    }
  ).execute({ personIds });

beforeEach(() => {
  selectError = null;
});

describe("findEmails when the affiliation check fails", () => {
  it("reports the failure instead of fabricating a skip explanation", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    selectError = { message: "connection reset by peer" };

    const result = await run(["11111111-1111-1111-1111-111111111111"]);

    expect(result.summary).toContain("connection reset");
    expect(result.summary).toMatch(/retry/i);
    expect(result.summary).not.toMatch(/not confirmed to work/);
    expect(result.found).toEqual([]);
    expect(result.notFound).toEqual([]);
    expect(result.skipped).toEqual([]);
    quiet.mockRestore();
  });

  it("still skips genuinely unconfirmed contacts when the query works", async () => {
    // data: [] means the ids resolved to no rows: unconfirmed, the safe way
    // round, and honestly described.
    const result = await run(["11111111-1111-1111-1111-111111111111"]);

    expect(result.skipped).toHaveLength(1);
    expect(result.summary).toMatch(/not confirmed to work/);
  });
});
