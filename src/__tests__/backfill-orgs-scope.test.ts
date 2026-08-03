import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The orphan backfill takes no input at all: no body, no ids, just POST.
 *
 * It read every organization and up to 500 people with no organization_id,
 * matched them by name and wrote an affiliation for each hit. Neither select
 * was scoped, and both tables are shared pools with no owner column, so one
 * request re-parented other people's contacts to other people's companies.
 * Any signed-in user could send it, repeatedly.
 *
 * Both selects now go through the caller's own campaigns, which is what the
 * orphan picker at /api/people/orphans already does for the same rows.
 */

const recordAffiliation = vi.fn(async () => ({ written: true }));
vi.mock("@/lib/services/affiliation", () => ({
  recordAffiliation: (...args: unknown[]) =>
    (recordAffiliation as unknown as (...a: unknown[]) => unknown)(...args),
}));

/**
 * Two tenants' rows in the shared pools. campaign_organizations and
 * campaign_people are scoped through campaigns, so those come back holding
 * only the caller's -- which is exactly why they are the only usable handle
 * on who owns what.
 */
const dataset = () => ({
  organizations: [
    { id: "org-mine", name: "Acme Corp" },
    { id: "org-theirs", name: "Zenith Industries" },
  ],
  people: [
    {
      id: "p-mine",
      organization_id: null,
      enrichment_data: { rawTitle: "Ann A - Head of Ops at Acme Corp" },
    },
    {
      id: "p-theirs",
      organization_id: null,
      enrichment_data: { rawTitle: "Bob B - CTO at Zenith Industries" },
    },
  ],
  campaign_organizations: [{ organization_id: "org-mine" }],
  campaign_people: [{ person_id: "p-mine" }],
});

let rows: ReturnType<typeof dataset>;

type Row = Record<string, unknown>;

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: vi.fn(async () => ({
    user: { id: "u1", email: "u1@example.com" },
    supabase: {
      from: (table: keyof ReturnType<typeof dataset>) => {
        // Filters the route applies. The shared pools honour them; the
        // campaign join tables model an already-scoped read.
        const inFilters: Array<[string, unknown[]]> = [];
        const isFilters: Array<[string, unknown]> = [];

        const c: Record<string, unknown> & PromiseLike<unknown> = {
          select: () => c,
          eq: () => c,
          limit: () => c,
          in: (column: string, values: unknown[]) => {
            inFilters.push([column, values]);
            return c;
          },
          is: (column: string, value: unknown) => {
            isFilters.push([column, value]);
            return c;
          },
          then: (
            onF: (v: unknown) => unknown,
            onR?: (e: unknown) => unknown,
          ) => {
            let data = (rows[table] ?? []) as Row[];
            for (const [column, values] of inFilters) {
              data = data.filter((r) => values.includes(r[column]));
            }
            for (const [column, value] of isFilters) {
              data = data.filter((r) => r[column] === value);
            }
            return Promise.resolve({ data, error: null }).then(onF, onR);
          },
        } as unknown as Record<string, unknown> & PromiseLike<unknown>;
        return c;
      },
    },
  })),
}));

import { POST } from "@/app/api/companies/backfill-orgs/route";

beforeEach(() => {
  rows = dataset();
  recordAffiliation.mockClear();
});

describe("POST /api/companies/backfill-orgs", () => {
  it("only touches orphans in the caller's own campaigns", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scanned: 1, linked: 1 });
    expect(recordAffiliation).toHaveBeenCalledTimes(1);
    expect(recordAffiliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        personId: "p-mine",
        organizationId: "org-mine",
      }),
    );
  });

  it("only matches against companies in the caller's own campaigns", async () => {
    // The caller holds this person, but the only company whose name appears in
    // their profile text belongs to somebody else. Matching against the whole
    // organizations table would file them under it.
    rows.people = [
      {
        id: "p-mine",
        organization_id: null,
        enrichment_data: {
          rawTitle: "Ann A - Head of Ops at Zenith Industries",
        },
      },
    ];

    const res = await POST();

    expect(await res.json()).toMatchObject({ scanned: 1, unmatched: 1 });
    expect(recordAffiliation).not.toHaveBeenCalled();
  });

  it("does nothing at all for a caller with no campaigns", async () => {
    rows.campaign_organizations = [];
    rows.campaign_people = [];

    const res = await POST();

    expect(await res.json()).toMatchObject({ scanned: 0, linked: 0 });
    expect(recordAffiliation).not.toHaveBeenCalled();
  });
});
