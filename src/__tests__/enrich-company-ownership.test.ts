import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may spend a company enrichment.
 *
 * `companyId` is a campaign_organizations link id, and that link is what ties
 * the request to a campaign and so to a caller. When the lookup missed, the
 * route retried the value as a bare organizations.id and enriched it anyway.
 * `organizations` is shared and carries no owner, so unless the optional
 * campaignId happened to be supplied, nothing had been checked: any id would
 * do, and the run wrote to the row and spent search credits doing it.
 *
 * Every caller in the app sends a link id, so the fallback is gone rather than
 * scoped.
 */

const ORG_LINK = "org-link-1";
const BARE_ORG = "org-1";

/**
 * enrichOrganization runs inside withAction. Stubbing it means the test never
 * reaches Exa or the scraper, and gives an exact assertion for "enrichment
 * started at all".
 */
const withAction = vi.fn(async () => Response.json({ stub: "enriched" }));
vi.mock("@/lib/services/cost-tracker", () => ({
  withAction: (...args: unknown[]) =>
    (withAction as unknown as (...a: unknown[]) => unknown)(...args),
}));

let rows: Record<string, unknown> = {};

const defaultRows = (): Record<string, unknown> => ({
  campaign_signals: null,
  "campaign_organizations:id": {
    organization_id: BARE_ORG,
    campaign_id: "c1",
    organization: { id: BARE_ORG, name: "Acme" },
    campaign: { user_id: "u1" },
  },
  "organizations:id": { id: BARE_ORG, name: "Acme", enrichment_data: {} },
  "campaigns:id": { user_id: "u1" },
});

const client = () => ({
  from: (table: string) => {
    let key = table;
    const c: Record<string, unknown> & PromiseLike<unknown> = {
      select: () => c,
      eq: (column: string) => {
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
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => client()),
  getSupabaseAndUser: vi.fn(async () => ({
    user: { id: "u1", email: "u1@example.com" },
    supabase: client(),
  })),
}));

import { POST } from "@/app/api/enrich-company/route";

const call = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/enrich-company", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  rows = defaultRows();
  withAction.mockClear();
});

describe("POST /api/enrich-company", () => {
  it("enriches through a campaign link the caller owns", async () => {
    const res = await call({ companyId: ORG_LINK });

    expect(res.status).toBe(200);
    expect(withAction).toHaveBeenCalled();
  });

  it("refuses a campaign link owned by somebody else", async () => {
    rows["campaign_organizations:id"] = {
      organization_id: BARE_ORG,
      campaign_id: "c1",
      organization: { id: BARE_ORG, name: "Acme" },
      campaign: { user_id: "u2" },
    };

    const res = await call({ companyId: ORG_LINK });

    expect(res.status).toBe(403);
    expect(withAction).not.toHaveBeenCalled();
  });

  it("refuses a bare organization id with no campaign link", async () => {
    // The organization row is readable -- it is shared on purpose -- so a
    // lookup on it can never be the ownership test. Without a link there is
    // nothing tying this id to the caller.
    rows["campaign_organizations:id"] = null;

    const res = await call({ companyId: BARE_ORG });

    expect(res.status).toBe(404);
    // No enrichment run, so no write to the row and no search spend.
    expect(withAction).not.toHaveBeenCalled();
  });

  it("refuses a bare organization id even when a campaign of the caller's is named", async () => {
    // The campaign check passing says the caller owns that campaign. It says
    // nothing about the company, which is the id actually being acted on.
    rows["campaign_organizations:id"] = null;

    const res = await call({ companyId: BARE_ORG, campaignId: "c1" });

    expect(res.status).toBe(404);
    expect(withAction).not.toHaveBeenCalled();
  });

  it("refuses a campaign the caller does not own", async () => {
    rows["campaigns:id"] = { user_id: "u2" };

    const res = await call({ companyId: ORG_LINK, campaignId: "c9" });

    expect(res.status).toBe(403);
    expect(withAction).not.toHaveBeenCalled();
  });
});
