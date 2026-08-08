import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake, type FakeRow } from "./helpers/supabase-fake";

/**
 * The scoring and status tools take campaign LINK ids, and agents routinely
 * pass entity ids instead (the file documents it). A 0-row UPDATE returns no
 * error from Supabase, so these tools reported scores and statuses as stored
 * while nothing was persisted and prioritization silently never happened.
 */

let campaignOrgs: FakeRow[] = [];
let campaignPeople: FakeRow[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () =>
    createSupabaseFake({
      tables: {
        campaign_organizations: () => campaignOrgs,
        campaign_people: () => campaignPeople,
        people: () => [],
      },
    }),
  ),
}));

import {
  scoreCompany,
  scoreContact,
  updateCompanyStatus,
  deleteCompanies,
} from "@/lib/tools/enrichment-tools";

const LINK_ORG = "11111111-1111-1111-1111-111111111111";
const LINK_PERSON = "22222222-2222-2222-2222-222222222222";
const WRONG_ID = "99999999-9999-9999-9999-999999999999";

beforeEach(() => {
  campaignOrgs = [
    {
      id: LINK_ORG,
      campaign_id: "c1",
      organization_id: "org-1",
      status: "discovered",
    },
  ];
  campaignPeople = [{ id: LINK_PERSON, campaign_id: "c1", person_id: "p1" }];
});

describe("scoreCompany", () => {
  it("stores the score against the link row", async () => {
    const result = await scoreCompany.execute!(
      { companyId: LINK_ORG, score: 8, reason: "strong ICP fit with timing" },
      {} as never,
    );

    expect(result).toMatchObject({ score: 8 });
    expect(campaignOrgs[0].relevance_score).toBe(8);
  });

  it("refuses an ID that matched nothing instead of claiming success", async () => {
    await expect(
      scoreCompany.execute!(
        { companyId: WRONG_ID, score: 8, reason: "strong ICP fit with timing" },
        {} as never,
      ),
    ).rejects.toThrow(/link ID/);
    expect(campaignOrgs[0].relevance_score).toBeUndefined();
  });
});

describe("scoreContact", () => {
  it("refuses a person ID passed as a link ID", async () => {
    await expect(
      scoreContact.execute!(
        { contactId: WRONG_ID, score: 7, reason: "recent posts align well" },
        {} as never,
      ),
    ).rejects.toThrow(/campaign-people link ID/);
  });
});

describe("updateCompanyStatus", () => {
  it("reports which IDs matched nothing", async () => {
    const result = (await updateCompanyStatus.execute!(
      { companyIds: [LINK_ORG, WRONG_ID], status: "qualified" },
      {} as never,
    )) as { updated: number; notFound?: string[] };

    expect(result.updated).toBe(1);
    expect(result.notFound).toEqual([WRONG_ID]);
    expect(campaignOrgs[0].status).toBe("qualified");
  });
});

describe("deleteCompanies", () => {
  it("unlinks people per campaign, not everything under the first link's campaign", async () => {
    // Two links from two campaigns the caller owns. The old code took
    // links[0].campaign_id for the whole batch, so campaign B's people were
    // unlinked from campaign A.
    campaignOrgs = [
      { id: LINK_ORG, campaign_id: "camp-a", organization_id: "org-a" },
      {
        id: "33333333-3333-3333-3333-333333333333",
        campaign_id: "camp-b",
        organization_id: "org-b",
      },
    ];
    const deletes: Array<{ filters: unknown }> = [];
    const fake = createSupabaseFake({
      tables: {
        campaign_organizations: () => campaignOrgs,
        campaign_people: () => campaignPeople,
        people: () => [
          { id: "pa", organization_id: "org-a" },
          { id: "pb", organization_id: "org-b" },
        ],
      },
      onQuery: (q) => {
        if (q.kind === "delete" && q.table === "campaign_people")
          deletes.push({ filters: q.filters });
      },
    });
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValueOnce(fake);

    const result = (await deleteCompanies.execute!(
      {
        companyIds: [LINK_ORG, "33333333-3333-3333-3333-333333333333"],
      },
      {} as never,
    )) as { deleted: number };

    expect(result.deleted).toBe(2);
    // One campaign_people delete per campaign, each scoped to its own.
    expect(deletes).toHaveLength(2);
    const campaignFilters = deletes.map(
      (d) =>
        (d.filters as Array<{ column: string; value?: unknown }>).find(
          (f) => f.column === "campaign_id",
        )?.value,
    );
    expect(campaignFilters.sort()).toEqual(["camp-a", "camp-b"]);
  });

  it("reports IDs that matched nothing rather than counting them deleted", async () => {
    const result = (await deleteCompanies.execute!(
      { companyIds: [LINK_ORG, WRONG_ID] },
      {} as never,
    )) as { deleted: number; notFound?: string[] };

    expect(result.deleted).toBe(1);
    expect(result.notFound).toEqual([WRONG_ID]);
  });
});
