import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agent tools that take a uuid and hand back somebody's contact details.
 *
 * getContactDetail, getCompanyDetail and findEmail each accepted an id and
 * read the row, with no test of whether the caller had any relationship to
 * it. None of them uses the admin client, so the intent was clearly that the
 * database would scope the read -- but `people` and `organizations` are
 * shared pools with no owner column, so it does not. Between them they return
 * work and personal addresses, socials, the whole enrichment payload and the
 * joined company, and findEmail writes back to the row as well.
 *
 * They are reachable by saying a uuid to the agent in chat.
 *
 * The gate is the one /api/find-email already puts in front of the same
 * function: the contact is in one of the caller's campaigns, or the company
 * they are filed under is.
 */

const PERSON = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

/** A stored address is enough to make findEmail return without a provider. */
const personRow = () => ({
  id: PERSON,
  name: "Ann Attacked",
  title: "CEO",
  work_email: "ceo@victimcorp.com",
  personal_email: "private@gmail.com",
  linkedin_url: "https://linkedin.com/in/ann",
  twitter_url: null,
  organization_id: null,
  work_email_source: "user_entered",
  work_email_confidence: 1,
  work_email_verification: "deliverable",
  affiliation_confidence: 1,
  enrichment_status: "enriched",
  enrichment_data: { secret: "paid enrichment" },
  organization: { id: ORG, name: "VictimCorp" },
});

let rows: Record<string, unknown>;

const defaultRows = (): Record<string, unknown> => ({
  "campaign_people:person_id": { campaign: { user_id: "u1" } },
  "campaign_organizations:organization_id": { campaign: { user_id: "u1" } },
  "people:id": personRow(),
  "people:id:list": [{ id: PERSON, affiliation_confidence: 1 }],
  "organizations:id": {
    id: ORG,
    name: "VictimCorp",
    domain: "victimcorp.com",
    enrichment_data: { website_summary: "paid extract" },
    enrichment_status: "enriched",
  },
});

const client = () => ({
  from: (table: string) => {
    let key = table;
    let single = false;
    const c: Record<string, unknown> & PromiseLike<unknown> = {
      select: () => c,
      eq: (column: string) => {
        if (key === table) key = `${table}:${column}`;
        return c;
      },
      in: (column: string) => {
        if (key === table) key = `${table}:${column}`;
        return c;
      },
      limit: () => c,
      single: () => {
        single = true;
        return c;
      },
      maybeSingle: () => {
        single = true;
        return c;
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        const data = single ? (rows[key] ?? null) : (rows[`${key}:list`] ?? []);
        return Promise.resolve({
          data,
          error: single && !data ? { message: "no rows" } : null,
        }).then(onF, onR);
      },
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

vi.mock("@/lib/services/email-pattern", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/email-pattern")
  >("@/lib/services/email-pattern");
  return { ...actual, mxCheck: vi.fn(async () => true) };
});

vi.mock("@/lib/services/exa-service", () => ({
  ExaService: class {
    async search() {
      return { results: [] };
    }
  },
}));

vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  PRICING: { email_provider_find: 0, email_provider_verify: 0 },
  withAction: (_label: string, fn: () => Promise<unknown>) => fn(),
}));

/**
 * Stubbed because this file is about who may call the tool, not what the write
 * does. Being a mock is also what makes "the write never happened" assertable.
 */
const saveOrganizationWebsite = vi.fn(async () => ({
  ok: true as const,
  merged: false,
  domain: "victimcorp.com",
  url: "https://victimcorp.com",
  source: "user_entered",
  evidence: "entered by the user",
}));
vi.mock("@/lib/services/organization-website", () => ({
  saveOrganizationWebsite: (...args: unknown[]) =>
    (saveOrganizationWebsite as unknown as (...a: unknown[]) => unknown)(
      ...args,
    ),
}));

import {
  getContactDetail,
  setCompanyWebsite,
} from "@/lib/tools/enrichment-tools";
import { getCompanyDetail } from "@/lib/tools/search-tools";
import { findEmail, findEmails } from "@/lib/tools/email-tools";

/** No tool under test reads the execution context. */
const noCtx = {} as never;

beforeEach(() => {
  rows = defaultRows();
});

/** Nothing ties the caller to this contact or the company they are at. */
function disown() {
  rows["campaign_people:person_id"] = null;
  rows["campaign_organizations:organization_id"] = null;
}

describe("getContactDetail", () => {
  it("returns the contact when it is in one of the caller's campaigns", async () => {
    const result = await getContactDetail.execute!({ personId: PERSON }, noCtx);

    expect(result).toMatchObject({ id: PERSON, name: "Ann Attacked" });
  });

  it("returns the contact when the caller holds the company they are at", async () => {
    rows["campaign_people:person_id"] = null;
    rows["people:id"] = { ...personRow(), organization_id: ORG };

    const result = await getContactDetail.execute!({ personId: PERSON }, noCtx);

    expect(result).toMatchObject({ id: PERSON });
  });

  it("refuses a contact the caller has no claim on", async () => {
    disown();

    const result = await getContactDetail.execute!({ personId: PERSON }, noCtx);

    expect(result).toHaveProperty("error");
    // The addresses and the enrichment payload are the point of the tool, so
    // absence of them is the assertion that matters.
    expect(JSON.stringify(result)).not.toMatch(/victimcorp|private@|secret/i);
  });
});

describe("getCompanyDetail", () => {
  it("returns the company when it is in one of the caller's campaigns", async () => {
    const result = await getCompanyDetail.execute!(
      { organizationId: ORG },
      noCtx,
    );

    expect(result).toMatchObject({ id: ORG, name: "VictimCorp" });
  });

  it("refuses a company the caller has no claim on", async () => {
    rows["campaign_organizations:organization_id"] = null;

    const result = await getCompanyDetail.execute!(
      { organizationId: ORG },
      noCtx,
    );

    expect(result).toHaveProperty("error");
    expect(JSON.stringify(result)).not.toMatch(/paid extract/i);
  });
});

describe("findEmail", () => {
  it("returns the address for a contact in one of the caller's campaigns", async () => {
    const result = await findEmail.execute!({ personId: PERSON }, noCtx);

    expect(result).toMatchObject({ email: "ceo@victimcorp.com" });
  });

  it("refuses a contact the caller has no claim on", async () => {
    disown();

    const result = await findEmail.execute!({ personId: PERSON }, noCtx);

    expect(result).toMatchObject({ email: null });
    expect(JSON.stringify(result)).not.toMatch(/ceo@victimcorp/i);
  });
});

describe("setCompanyWebsite", () => {
  beforeEach(() => saveOrganizationWebsite.mockClear());

  it("saves the website of a company the caller holds", async () => {
    const result = await setCompanyWebsite.execute!(
      { organizationId: ORG, url: "victimcorp.com" },
      noCtx,
    );

    expect(saveOrganizationWebsite).toHaveBeenCalled();
    expect(result).toMatchObject({ domain: "victimcorp.com" });
  });

  it("refuses a company the caller has no claim on, without writing", async () => {
    // The only writing tool in this file, and the write is destructive in a way
    // the read tools are not: setting a domain that another row already holds
    // merges the two companies and deletes one of them. Ungated, that is a
    // stranger's contact list moved into a company they chose, by saying a uuid
    // to the agent.
    rows["campaign_organizations:organization_id"] = null;

    const result = await setCompanyWebsite.execute!(
      { organizationId: ORG, url: "attacker-controlled.com" },
      noCtx,
    );

    expect(result).toHaveProperty("error");
    expect(saveOrganizationWebsite).not.toHaveBeenCalled();
  });
});

describe("findEmails", () => {
  it("skips ids the caller has no claim on", async () => {
    disown();

    const result = (await findEmails.execute!(
      { personIds: [PERSON] },
      noCtx,
    )) as { found: unknown[]; skipped: string[] };

    expect(result.found).toEqual([]);
    expect(result.skipped).toContain(PERSON);
  });
});
