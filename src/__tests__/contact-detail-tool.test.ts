import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake } from "./helpers/supabase-fake";

const PERSON = "p1";
const ORG = "o1";
const CAMPAIGN = "c1";

const state = vi.hoisted(() => ({
  people: [] as Array<Record<string, unknown>>,
  campaignPeople: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/server", () => {
  const supabase = () =>
    createSupabaseFake({
      tables: {
        people: () => state.people,
        campaign_people: () => state.campaignPeople,
        campaigns: () => [{ id: CAMPAIGN, user_id: "u1" }],
        campaign_organizations: () => [],
        organizations: () => [
          {
            id: ORG,
            name: "Acme",
            domain: "acme.com",
            industry: "SaaS",
            location: null,
            description: null,
            enrichment_data: { website_summary: "..." },
            enrichment_status: "enriched",
          },
        ],
      },
      relations: {
        people: { organization: { localKey: "organization_id" } },
        campaign_people: { campaign: { localKey: "campaign_id" } },
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

import { getContactDetail } from "@/lib/tools/enrichment-tools";

const call = (personId: string) =>
  getContactDetail.execute!({ personId }, {} as never);

beforeEach(() => {
  state.people = [
    {
      id: PERSON,
      name: "Alice",
      title: "CTO",
      work_email: "alice@acme.com",
      personal_email: null,
      linkedin_url: "https://linkedin.com/in/alice",
      twitter_url: null,
      organization_id: ORG,
      enrichment_status: "enriched",
      enrichment_data: { bio: "Long LinkedIn bio..." },
    },
  ];
  state.campaignPeople = [
    { id: "cp1", campaign_id: CAMPAIGN, person_id: PERSON },
  ];
});

describe("getContactDetail", () => {
  it("returns one contact with full enrichment_data and company enrichment", async () => {
    const result = await call(PERSON);

    expect(result).toMatchObject({
      id: PERSON,
      name: "Alice",
      enrichment_data: { bio: "Long LinkedIn bio..." },
      company: { name: "Acme", enrichment_data: { website_summary: "..." } },
    });
  });

  it("returns error when contact not found", async () => {
    const result = await call("missing");

    expect(result).toEqual({ error: expect.stringContaining("not found") });
  });

  it("returns the same error for a contact the caller does not hold", async () => {
    // Indistinguishable from a missing row on purpose: a different answer for
    // a real uuid would confirm which guesses are contacts.
    state.campaignPeople = [];

    const result = await call(PERSON);

    expect(result).toEqual({ error: expect.stringContaining("not found") });
    expect(JSON.stringify(result)).not.toMatch(/alice@acme|LinkedIn bio/i);
  });
});
