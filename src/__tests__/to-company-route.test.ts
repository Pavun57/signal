import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Manually assigning a contact to a company.
 *
 * The endpoint returned 200 whatever recordAffiliation did with the write, so a
 * write the database rejected read to the user as a successful assignment. The
 * `user_entered` source is a human override and never trips the monotonic
 * guard, which means a refusal here is always something the user needs told.
 */

const writeResult: { current: { written: boolean; reason?: string } } = {
  current: { written: true },
};
vi.mock("@/lib/services/affiliation", () => ({
  recordAffiliation: vi.fn(async () => writeResult.current),
}));

vi.mock("@/lib/services/knowledge-base", () => ({
  linkPersonToCampaign: vi.fn().mockResolvedValue({ id: "cp1" }),
}));

/** Rows each table resolves to. Ownership all points at the calling user. */
const rows: Record<string, unknown> = {
  campaign_organizations: { campaign: { user_id: "u1" } },
  campaign_people: { campaign: { user_id: "u1" } },
  campaigns: { user_id: "u1" },
  organizations: { id: "org-1" },
  people: { id: "p1", name: "Ann A", organization_id: "org-1" },
};

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: vi.fn(async () => ({
    user: { id: "u1" },
    supabase: {
      from: (table: string) => {
        const c: Record<string, unknown> & PromiseLike<unknown> = {
          select: () => c,
          eq: () => c,
          limit: () => c,
          single: () => c,
          maybeSingle: () => c,
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve({ data: rows[table] ?? null, error: null }).then(
              onF,
              onR,
            ),
        } as unknown as Record<string, unknown> & PromiseLike<unknown>;
        return c;
      },
    },
  })),
}));

import { POST } from "@/app/api/people/[id]/to-company/route";

const call = () =>
  POST(
    new Request("http://localhost/api/people/p1/to-company", {
      method: "POST",
      body: JSON.stringify({
        organizationId: "11111111-1111-4111-8111-111111111111",
      }),
    }),
    { params: Promise.resolve({ id: "p1" }) },
  );

beforeEach(() => {
  writeResult.current = { written: true };
});

describe("POST /api/people/[id]/to-company", () => {
  it("assigns the person when the write lands", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ organization_id: "org-1" });
  });

  it("does not report success when the write did not happen", async () => {
    writeResult.current = {
      written: false,
      reason: 'violates check constraint "people_affiliation_source_check"',
    };

    const res = await call();

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("check constraint");
  });

  it("404s when the person is gone", async () => {
    writeResult.current = { written: false, reason: "person_not_found" };

    const res = await call();

    expect(res.status).toBe(404);
  });
});
