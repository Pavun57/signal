import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake } from "./helpers/supabase-fake";

/**
 * Where the people this route finds actually end up.
 *
 * The route called discovery with a hardcoded `campaignId: null`, so every
 * person it found got `people.organization_id` and no `campaign_people` row.
 * The company page reads people by `organization_id`, so they showed up there
 * and the button reported "Added 3 new people", while the campaign page (which
 * reads `campaign_people`) kept showing the company under "Companies without
 * leads" with zero contacts. That is the whole reported bug: found people, no
 * campaign.
 *
 * Storing people with no campaign link is still legitimate when the company
 * page is not scoped to a campaign (see the note in `src/lib/tools/ownership.ts`
 * about "Find more people" doing exactly that on purpose), so the fix is not to
 * force a campaign. It is to use the one the page already has, and to say which
 * of the two happened.
 */

const ORG = "org-1";
const CAMPAIGN = "campaign-1";
const OTHER_USERS_CAMPAIGN = "campaign-2";
/** The caller's, but this company is not in it. */
const UNRELATED_CAMPAIGN = "campaign-3";

/** The options discovery was called with, captured for the assertions below. */
let lastOptions: { campaignId?: unknown } | null = null;

const findContactsForOrganization = vi.fn(
  async (_supabase: unknown, options: { campaignId?: unknown }) => {
    lastOptions = options;
    return {
      organizationId: ORG,
      companyName: "Cedar Lodge Nursing Home",
      contacts: [],
      alreadyLinked: [],
      alreadyLinkedTotal: 0,
      searchesRun: [],
      totalFound: 2,
      duplicatesSkipped: 0,
      verifiedCount: 2,
      uncertainCount: 0,
      rejectedAsWrongCompany: 0,
      departedCount: 0,
      affiliationUnchanged: 0,
    };
  },
);

vi.mock("@/lib/services/contact-discovery", () => ({
  findContactsForOrganization: (...args: unknown[]) =>
    (findContactsForOrganization as unknown as (...a: unknown[]) => unknown)(
      ...args,
    ),
}));

// The real one only wraps the callback in an AsyncLocalStorage context. Running
// the callback is the point: it is what calls discovery.
vi.mock("@/lib/services/cost-tracker", () => ({
  withAction: <T>(_label: string, fn: () => Promise<T>) => fn(),
}));

vi.mock("@/lib/supabase/server", () => {
  const supabase = () =>
    createSupabaseFake({
      tables: {
        campaigns: () => [
          { id: CAMPAIGN, user_id: "user-1" },
          { id: OTHER_USERS_CAMPAIGN, user_id: "user-2" },
          { id: UNRELATED_CAMPAIGN, user_id: "user-1" },
        ],
        campaign_organizations: () => [
          { id: "co-1", campaign_id: CAMPAIGN, organization_id: ORG },
          // The same company sitting in someone else's campaign. Without the
          // campaign_id predicate this row satisfies an ownership check that
          // only asks "is this org in any campaign".
          {
            id: "co-2",
            campaign_id: OTHER_USERS_CAMPAIGN,
            organization_id: ORG,
          },
          // The caller's other campaign, holding a different company. This is
          // what a campaign_id predicate with no organization_id predicate
          // would wrongly accept.
          {
            id: "co-3",
            campaign_id: UNRELATED_CAMPAIGN,
            organization_id: "org-2",
          },
        ],
        organizations: () => [
          { id: ORG, name: "Cedar Lodge Nursing Home", domain: "cedar.co.uk" },
          { id: "org-2", name: "Aran Court Care Home", domain: "aran.co.uk" },
        ],
      },
      relations: {
        campaign_organizations: {
          campaign: { localKey: "campaign_id" },
        },
      },
    });

  return {
    createClient: vi.fn(async () => supabase()),
    getSupabaseAndUser: vi.fn(async () => ({
      supabase: supabase(),
      user: { id: "user-1", email: "u@example.com" },
    })),
  };
});

import { POST } from "@/app/api/companies/[id]/find-more-people/route";

function post(body?: Record<string, unknown>) {
  const request = body
    ? new Request("http://test/api/companies/org-1/find-more-people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    : new Request("http://test/api/companies/org-1/find-more-people", {
        method: "POST",
      });
  return POST(request, { params: Promise.resolve({ id: ORG }) });
}

/** The campaignId discovery was actually called with. */
function calledWith(): unknown {
  return lastOptions?.campaignId;
}

beforeEach(() => {
  findContactsForOrganization.mockClear();
  lastOptions = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("find-more-people: campaign linkage", () => {
  it("links what it finds to the campaign the page is scoped to", async () => {
    const res = await post({ campaignId: CAMPAIGN });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(calledWith()).toBe(CAMPAIGN);
    // The button branches on this to tell the user which of the two happened.
    expect(body.campaignId).toBe(CAMPAIGN);
    expect(body.added).toBe(2);
  });

  it("still runs unscoped when the page has no campaign selected", async () => {
    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(calledWith()).toBeNull();
    expect(body.campaignId).toBeNull();
  });

  it("refuses a campaign the caller does not own", async () => {
    const res = await post({ campaignId: OTHER_USERS_CAMPAIGN });

    expect(res.status).toBe(403);
    expect(findContactsForOrganization).not.toHaveBeenCalled();
  });

  it("refuses a campaign this company is not in", async () => {
    // The caller owns this campaign and owns the company. Neither fact puts
    // the company in the campaign, and linking it here would file contacts
    // under a company that campaign never asked about.
    const res = await post({ campaignId: UNRELATED_CAMPAIGN });

    expect(res.status).toBe(403);
    expect(findContactsForOrganization).not.toHaveBeenCalled();
  });

  it("rejects a campaignId that is not a string", async () => {
    const res = await post({ campaignId: 42 });

    expect(res.status).toBe(400);
    expect(findContactsForOrganization).not.toHaveBeenCalled();
  });
});
