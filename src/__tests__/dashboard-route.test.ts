import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/dashboard. Two failure classes: query errors rendered as an
 * empty-but-healthy dashboard (K22), and the time-series cap truncating the
 * WRONG end (ascending + limit keeps the oldest rows, so the most recent
 * days silently vanish from the chart on busy installs).
 */

interface QueryLog {
  table: string;
  order?: { column: string; ascending: boolean };
  inArgs?: { column: string; values: unknown[] };
}

const queries: QueryLog[] = [];
let events: Array<{ status: string; created_at: string }> = [];
let failCounts = false;

function chain(table: string) {
  const log: QueryLog = { table };
  queries.push(log);
  const c: Record<string, unknown> & PromiseLike<unknown> = {
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.count) {
        return {
          in: (column: string, values: unknown[]) => {
            log.inArgs = { column, values };
            return countResult();
          },
          eq: () => countResult(),
          then: countResult().then,
        };
      }
      return c;
    },
    eq: () => c,
    gte: () => c,
    order: (column: string, opts: { ascending: boolean }) => {
      log.order = { column, ascending: opts.ascending };
      return c;
    },
    limit: () => c,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({
        data: table === "outreach_events" ? events : [],
        error: null,
      }).then(onF, onR),
  } as unknown as Record<string, unknown> & PromiseLike<unknown>;
  return c;
}

function countResult() {
  const p: PromiseLike<unknown> & Record<string, unknown> = {
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(
        failCounts
          ? { count: null, error: { message: "connection reset" } }
          : { count: 3, error: null },
      ).then(onF, onR),
  } as unknown as PromiseLike<unknown> & Record<string, unknown>;
  return p;
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: vi.fn(async () => ({
    supabase: { from: (table: string) => chain(table) },
    user: { id: "user-1" },
  })),
}));

import { GET } from "@/app/api/dashboard/route";

const get = (range = "30d") =>
  GET(new Request(`http://test/api/dashboard?range=${range}`));

beforeEach(() => {
  queries.length = 0;
  events = [];
  failCounts = false;
});

describe("GET /api/dashboard", () => {
  it("fetches the time-series newest-first so the cap truncates old days, not recent ones", async () => {
    events = [
      { status: "sent", created_at: "2026-08-05T10:00:00Z" },
      { status: "replied", created_at: "2026-08-01T10:00:00Z" },
    ];

    const res = await get();
    const body = (await res.json()) as {
      timeSeries: Array<{ date: string }>;
    };

    const tsQuery = queries.find(
      (q) => q.table === "outreach_events" && q.order,
    );
    expect(tsQuery?.order?.ascending).toBe(false);
    // and the output is still presented oldest-first for the chart
    expect(body.timeSeries.map((d) => d.date)).toEqual([
      "2026-08-01",
      "2026-08-05",
    ]);
  });

  it("counts bounced and complained sends as contacted", async () => {
    await get();

    const sentQuery = queries.find((q) => q.inArgs);
    expect(sentQuery?.inArgs?.values).toEqual(
      expect.arrayContaining(["bounced", "complained", "sent", "replied"]),
    );
  });

  it("returns 500 on a failed query instead of an empty healthy dashboard", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    failCounts = true;

    const res = await get();

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("connection reset");
    quiet.mockRestore();
  });
});
