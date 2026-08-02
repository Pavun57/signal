import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * "Not here": a human saying this person does not work at this company.
 *
 * The endpoint used to null organization_id AND all four provenance columns,
 * which scores the row BELOW a bare search stamp (recordAffiliation reads a row
 * with no org and no source as -1). So the next discovery run at that company
 * pulled the same person back out of Exa, the judge returned `uncertain` again
 * (which is why they were in the review queue in the first place), and
 * search_stamp at 0.2 re-attached them. They reappeared under "Needs review",
 * and the loop had no end. The human's rejection was recorded as nothing at
 * all, so the machine outranked it.
 */

const writeResult: {
  current: { written: boolean; reason?: string; notAtJudgedOrg?: boolean };
} = { current: { written: true } };

const recordAffiliation = vi.fn(async () => writeResult.current);
vi.mock("@/lib/services/affiliation", () => ({
  recordAffiliation: (...args: unknown[]) =>
    (recordAffiliation as unknown as (...a: unknown[]) => unknown)(...args),
}));

const ORG_SHOWN = "11111111-1111-4111-8111-111111111111";
const ORG_ON_ROW = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN = "33333333-3333-4333-8333-333333333333";

/** What the person row currently says. Diverges from ORG_SHOWN on purpose. */
const personRow: { current: Record<string, unknown> | null } = {
  current: { id: "p1", organization_id: ORG_ON_ROW },
};

/** Every table operation the route performed, in order. */
type Op = { table: string; op: string; updates?: Record<string, unknown> };
let ops: Op[] = [];

const rows = (): Record<string, unknown> => ({
  campaign_people: { campaign: { user_id: "u1" } },
  campaigns: { user_id: "u1" },
  people: personRow.current,
});

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: vi.fn(async () => ({
    user: { id: "u1" },
    supabase: {
      from: (table: string) => {
        let op = "select";
        let updates: Record<string, unknown> | undefined;
        const c: Record<string, unknown> & PromiseLike<unknown> = {
          select: () => c,
          update: (v: Record<string, unknown>) => {
            op = "update";
            updates = v;
            return c;
          },
          delete: () => {
            op = "delete";
            return c;
          },
          eq: () => c,
          limit: () => c,
          single: () => c,
          maybeSingle: () => c,
          then: (
            onF: (v: unknown) => unknown,
            onR?: (e: unknown) => unknown,
          ) => {
            ops.push({ table, op, updates });
            const data = op === "select" ? (rows()[table] ?? null) : null;
            return Promise.resolve({ data, error: null }).then(onF, onR);
          },
        } as unknown as Record<string, unknown> & PromiseLike<unknown>;
        return c;
      },
    },
  })),
}));

import { DELETE } from "@/app/api/people/[id]/from-company/route";

const call = (query = `?campaignId=${CAMPAIGN}&organizationId=${ORG_SHOWN}`) =>
  DELETE(
    new Request(`http://localhost/api/people/p1/from-company${query}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: "p1" }) },
  );

beforeEach(() => {
  writeResult.current = { written: true };
  personRow.current = { id: "p1", organization_id: ORG_ON_ROW };
  ops = [];
  recordAffiliation.mockClear();
});

describe("DELETE /api/people/[id]/from-company", () => {
  it("records the rejection instead of erasing the row's history", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(recordAffiliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        personId: "p1",
        organizationId: null,
        source: "user_rejected",
      }),
    );
    // The old blanket update is gone. Nulling affiliation_source is exactly
    // what made the rejection unrememberable.
    expect(
      ops.filter((o) => o.table === "people" && o.op === "update"),
    ).toEqual([]);
  });

  it("rejects the company the user was looking at, not the one on the row", async () => {
    // Task 12 refuses a detach unless the person is filed under the company
    // that was judged. Deriving that company from the row itself would make the
    // check tautological and could never catch a stale click, so the caller
    // names it and the mismatch is the point.
    await call();

    expect(recordAffiliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ detachedFrom: ORG_SHOWN }),
    );
  });

  it("falls back to the row's own company when the caller names none", async () => {
    // The org chart and the standalone company page also call this endpoint.
    // A detach that names no company is refused outright by recordAffiliation,
    // so the fallback is what keeps those callers working.
    await call(`?campaignId=${CAMPAIGN}`);

    expect(recordAffiliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ detachedFrom: ORG_ON_ROW }),
    );
  });

  it("still drops them from the campaign", async () => {
    const res = await call();

    expect(
      ops.some((o) => o.table === "campaign_people" && o.op === "delete"),
    ).toBe(true);
    expect(await res.json()).toMatchObject({ unlinked_from_campaign: true });
  });

  it("does not report success when the person is not at that company", async () => {
    // A stale tab, or another user detached them first. Reporting 200 here
    // tells the user their judgement was recorded when nothing was written.
    writeResult.current = {
      written: false,
      reason: "not_attached_to_the_company_that_was_judged",
      notAtJudgedOrg: true,
    };

    const res = await call();

    expect(res.status).toBe(409);
    // And the campaign link survives: they are somebody's contact somewhere
    // else, and this click was about a company they are not filed under.
    expect(
      ops.some((o) => o.table === "campaign_people" && o.op === "delete"),
    ).toBe(false);
  });

  it("does not report success when the write fails outright", async () => {
    writeResult.current = {
      written: false,
      reason: 'violates check constraint "people_affiliation_source_check"',
    };

    const res = await call();

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("check constraint");
  });

  it("409s when the person is attached to nobody and no company is named", async () => {
    personRow.current = { id: "p1", organization_id: null };

    const res = await call(`?campaignId=${CAMPAIGN}`);

    expect(res.status).toBe(409);
    expect(recordAffiliation).not.toHaveBeenCalled();
  });

  it("404s when the person is gone", async () => {
    writeResult.current = { written: false, reason: "person_not_found" };

    const res = await call();

    expect(res.status).toBe(404);
  });
});
