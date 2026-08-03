import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may spend an enrichment on a contact.
 *
 * `contactId` is accepted in two shapes, and only one of them used to be
 * checked. A campaign_people link id was resolved through its parent campaign
 * and compared to the caller. Anything else fell through to a branch that
 * treated the value as a bare people.id and enriched it, on the stated
 * assumption that the row would be scoped underneath. `people` is a shared
 * pool with no owner column, so it is not, and the route returned the stored
 * dossier for whatever id it was handed.
 *
 * The bare shape cannot simply be rejected: the standalone company page sends
 * it, and "Find more people" on that page stores contacts with no campaign
 * link at all. So the claim is established the same way that page's other
 * actions establish it -- the contact is in one of the caller's campaigns, or
 * the company they are filed under is.
 */

const LINK_OWNED = "link-owned";
const LINK_FOREIGN = "link-foreign";
const PERSON = "person-1";

const enrichPerson = vi.fn(async () => ({
  status: "enriched" as const,
  enrichmentData: { linkedin: "..." },
  errors: undefined,
}));

vi.mock("@/lib/services/person-enrichment", () => ({
  PERSON_ENRICH_COLUMNS: "name, title",
  enrichPerson: (...args: unknown[]) =>
    (enrichPerson as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("@/lib/services/knowledge-base", () => ({
  isRecentlyEnriched: vi.fn(async () => false),
}));

/**
 * Rows keyed by `table:filterColumn`, because the route reads the same table
 * through different columns and the answers have to differ.
 */
let rows: Record<string, unknown> = {};

const defaultRows = (): Record<string, unknown> => ({
  // The link id shape, owned by the caller.
  "campaign_people:id": { person_id: PERSON, campaign: { user_id: "u1" } },
  // The person is in one of the caller's campaigns.
  "campaign_people:person_id": { campaign: { user_id: "u1" } },
  "people:id": {
    id: PERSON,
    name: "Ann A",
    title: "CTO",
    organization_id: "org-1",
    enrichment_data: { secret: "paid enrichment" },
  },
  "campaign_organizations:organization_id": { campaign: { user_id: "u1" } },
});

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAndUser: vi.fn(async () => ({
    user: { id: "u1", email: "u1@example.com" },
    supabase: {
      from: (table: string) => {
        let key = table;
        const c: Record<string, unknown> & PromiseLike<unknown> = {
          select: () => c,
          eq: (column: string) => {
            // First filter column decides which row this read is after.
            if (key === table) key = `${table}:${column}`;
            return c;
          },
          limit: () => c,
          single: () => c,
          maybeSingle: () => c,
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve({
              data: rows[key] ?? null,
              error: rows[key] ? null : { message: "no rows" },
            }).then(onF, onR),
        } as unknown as Record<string, unknown> & PromiseLike<unknown>;
        return c;
      },
    },
  })),
}));

import { POST } from "@/app/api/enrich/route";

const call = (contactId: string) =>
  POST(
    new Request("http://localhost/api/enrich", {
      method: "POST",
      body: JSON.stringify({ contactId }),
    }),
  );

beforeEach(() => {
  rows = defaultRows();
  enrichPerson.mockClear();
});

describe("POST /api/enrich", () => {
  it("enriches through a campaign link the caller owns", async () => {
    const res = await call(LINK_OWNED);

    expect(res.status).toBe(200);
    expect(enrichPerson).toHaveBeenCalled();
  });

  it("refuses a campaign link owned by somebody else", async () => {
    rows["campaign_people:id"] = {
      person_id: PERSON,
      campaign: { user_id: "u2" },
    };

    const res = await call(LINK_FOREIGN);

    expect(res.status).toBe(403);
    expect(enrichPerson).not.toHaveBeenCalled();
  });

  it("refuses a bare person id the caller has no claim on", async () => {
    // Not a link id, so the lookup by id misses. The person sits in no
    // campaign of the caller's, and neither does the company they are filed
    // under: nothing connects this uuid to the caller at all.
    rows["campaign_people:id"] = null;
    rows["campaign_people:person_id"] = null;
    rows["campaign_organizations:organization_id"] = null;

    const res = await call(PERSON);

    expect(res.status).toBe(403);
    // No scrape, no write, and above all no dossier in the response body.
    expect(enrichPerson).not.toHaveBeenCalled();
    expect(await res.json()).not.toHaveProperty("enrichmentData");
  });

  it("enriches a bare person id when the contact is in one of the caller's campaigns", async () => {
    rows["campaign_people:id"] = null;

    const res = await call(PERSON);

    expect(res.status).toBe(200);
    expect(enrichPerson).toHaveBeenCalled();
  });

  it("enriches a bare person id when the caller holds the company", async () => {
    // The standalone company page. "Find more people" there stores contacts
    // with no campaign link, so the company is the only claim there is, and
    // it is the same one that route checks before it runs.
    rows["campaign_people:id"] = null;
    rows["campaign_people:person_id"] = null;

    const res = await call(PERSON);

    expect(res.status).toBe(200);
    expect(enrichPerson).toHaveBeenCalled();
  });

  it("refuses a bare person id at a company the caller does not hold", async () => {
    rows["campaign_people:id"] = null;
    rows["campaign_people:person_id"] = null;
    rows["campaign_organizations:organization_id"] = {
      campaign: { user_id: "u2" },
    };

    const res = await call(PERSON);

    expect(res.status).toBe(403);
    expect(enrichPerson).not.toHaveBeenCalled();
  });
});
