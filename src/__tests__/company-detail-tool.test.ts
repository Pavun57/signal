import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake } from "./helpers/supabase-fake";

const ORG = "o1";
const CAMPAIGN = "c1";

const state = vi.hoisted(() => ({
  campaignOrganizations: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/server", () => {
  const supabase = () =>
    createSupabaseFake({
      tables: {
        organizations: () => [
          {
            id: ORG,
            name: "Acme",
            domain: "acme.com",
            url: null,
            industry: "SaaS",
            location: null,
            description: null,
            enrichment_data: {
              website_summary: "long...",
              exa_results: [1, 2, 3],
            },
            enrichment_status: "enriched",
          },
        ],
        campaign_organizations: () => state.campaignOrganizations,
        campaigns: () => [{ id: CAMPAIGN, user_id: "u1" }],
      },
      relations: {
        campaign_organizations: { campaign: { localKey: "campaign_id" } },
      },
    });

  return {
    createClient: vi.fn(async () => supabase()),
    getSupabaseAndUser: vi.fn(async () => ({
      supabase: supabase(),
      user: { id: "u1", email: "u@example.com" },
    })),
  };
});

import { getCompanyDetail } from "@/lib/tools/search-tools";

const call = (organizationId: string) =>
  getCompanyDetail.execute!({ organizationId }, {} as never);

beforeEach(() => {
  state.campaignOrganizations = [
    { id: "co1", campaign_id: CAMPAIGN, organization_id: ORG },
  ];
});

describe("getCompanyDetail", () => {
  it("returns one company with full enrichment_data", async () => {
    const result = await call(ORG);

    expect(result).toMatchObject({
      id: ORG,
      name: "Acme",
      enrichment_data: { website_summary: "long...", exa_results: [1, 2, 3] },
    });
  });

  it("returns error when company not found", async () => {
    const result = await call("x");

    expect(result).toEqual({ error: expect.stringContaining("not found") });
  });

  it("returns the same error for a company the caller does not hold", async () => {
    state.campaignOrganizations = [];

    const result = await call(ORG);

    expect(result).toEqual({ error: expect.stringContaining("not found") });
    expect(JSON.stringify(result)).not.toMatch(/long\.\.\./);
  });
});
