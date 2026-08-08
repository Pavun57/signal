import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake, type FakeRow } from "./helpers/supabase-fake";

/**
 * POST /api/find-contacts takes a campaign_organizations link id AND a
 * campaignId, and each passes its own ownership check. The pair still has to
 * agree: for a caller who owns both campaigns, a link from campaign A with
 * campaignId B would write campaign_people rows into a campaign that has no
 * campaign_organizations row for the org, contacts invisible in its UI.
 */

const findContactsForOrganization = vi.fn();
vi.mock("@/lib/services/contact-discovery", () => ({
  findContactsForOrganization: (...args: unknown[]) =>
    (findContactsForOrganization as unknown as (...a: unknown[]) => unknown)(
      ...args,
    ),
}));

vi.mock("@/lib/services/cost-tracker", () => ({
  withAction: (_label: string, fn: () => Promise<unknown>) => fn(),
}));

const CAMPAIGN_A = "campaign-a";
const CAMPAIGN_B = "campaign-b";
const LINK_A = "link-a";

let campaigns: FakeRow[] = [];
let links: FakeRow[] = [];

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: vi.fn(async () => ({
    supabase: createSupabaseFake({
      tables: {
        campaigns: () => campaigns,
        campaign_organizations: () => links,
        organizations: () => [
          {
            id: "org-1",
            name: "Acme",
            domain: "acme.com",
            industry: null,
            location: null,
            description: null,
          },
        ],
      },
      relations: {
        campaign_organizations: {
          organization: { localKey: "organization_id" },
        },
      },
    }),
    user: { id: "user-1", email: "u@example.com" },
  })),
}));

import { POST } from "@/app/api/find-contacts/route";

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://test/api/find-contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  findContactsForOrganization.mockReset().mockResolvedValue({
    organizationId: "org-1",
    companyName: "Acme",
    contacts: [],
    alreadyLinked: [],
    alreadyLinkedTotal: 0,
    searchesRun: [],
    totalFound: 0,
    duplicatesSkipped: 0,
    verifiedCount: 0,
    uncertainCount: 0,
    rejectedAsWrongCompany: 0,
    departedCount: 0,
    affiliationUnchanged: 0,
  });
  campaigns = [
    { id: CAMPAIGN_A, user_id: "user-1", icp: null },
    { id: CAMPAIGN_B, user_id: "user-1", icp: null },
  ];
  links = [{ id: LINK_A, campaign_id: CAMPAIGN_A, organization_id: "org-1" }];
});

describe("POST /api/find-contacts", () => {
  it("runs discovery for a link that belongs to the named campaign", async () => {
    const res = await post({ companyId: LINK_A, campaignId: CAMPAIGN_A });

    expect(res.status).toBe(200);
    expect(findContactsForOrganization).toHaveBeenCalledTimes(1);
  });

  it("refuses a link from a different campaign, even one the caller owns", async () => {
    const res = await post({ companyId: LINK_A, campaignId: CAMPAIGN_B });

    expect(res.status).toBe(404);
    expect(findContactsForOrganization).not.toHaveBeenCalled();
  });
});
