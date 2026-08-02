import { afterEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake } from "./helpers/supabase-fake";

/**
 * The batch email paths must not mint an address for someone we cannot place at
 * the company.
 *
 * A firstname@company.com address is the single most convincing thing on a
 * contact row, so guessing one for an unproven person manufactures exactly the
 * confirmation the user is looking for. `enrichContactById` is already gated;
 * these two are the other ways in, and a batch fan-out is nobody's explicit
 * decision to spend on a named person.
 */

const CONFIRMED = "11111111-1111-1111-1111-111111111111";
const UNCONFIRMED = "22222222-2222-2222-2222-222222222222";
/** Confirmed, but at a company nobody asked about. */
const AT_ANOTHER_ORG = "44444444-4444-4444-4444-444444444444";
/** Confirmed and at this company, but enrolled in a different campaign. */
const IN_ANOTHER_CAMPAIGN = "55555555-5555-5555-5555-555555555555";

const CAMPAIGN = "33333333-3333-3333-3333-333333333333";
const OTHER_CAMPAIGN = "66666666-6666-6666-6666-666666666666";
const ORG = "org-1";

interface PersonRow extends Record<string, unknown> {
  id: string;
  name: string;
  work_email: string | null;
  organization_id: string | null;
  affiliation_confidence: number | null;
}

const state = vi.hoisted(() => ({
  /** The contacts enrolled in the campaign under test. */
  people: [] as Array<Record<string, unknown>>,
  /** Person IDs the real findEmailForPerson actually looked up. */
  lookups: [] as string[],
  findEmailForPerson: vi.fn(async (personId: string) => ({
    email: null as string | null,
    reason: "Person not found.",
    personId,
  })),
}));

const findEmailForPerson = state.findEmailForPerson;

function person(over: Partial<PersonRow> & { id: string }): PersonRow {
  return {
    name: "Ann A",
    work_email: null,
    organization_id: ORG,
    affiliation_confidence: 0.9,
    ...over,
  };
}

/**
 * Two people the query is not about.
 *
 * The route scopes its read twice, by `.eq("campaign_id", ...)` and by comparing
 * `organization_id`, and both were previously deletable with the suite still
 * green: every fixture was a member of the one campaign at the one company, so
 * an unscoped query returned the same rows. These two are confirmed at 0.9, so
 * if either scope disappears they are minted an address immediately. Dropping
 * the campaign predicate would fan out across every campaign on the instance.
 */
const strangers: PersonRow[] = [
  person({ id: AT_ANOTHER_ORG, organization_id: "org-2" }),
  person({ id: IN_ANOTHER_CAMPAIGN }),
];

/** campaign_people links: the roster under test, plus the two strangers. */
const links = () => [
  ...state.people.map((p) => ({
    id: `cp-${p.id}`,
    campaign_id: CAMPAIGN,
    person_id: p.id,
  })),
  // In the campaign, at the wrong company: only the org comparison excludes it.
  { id: "cp-other-org", campaign_id: CAMPAIGN, person_id: AT_ANOTHER_ORG },
  // At the right company, in the wrong campaign: only the predicate excludes it.
  {
    id: "cp-other-campaign",
    campaign_id: OTHER_CAMPAIGN,
    person_id: IN_ANOTHER_CAMPAIGN,
  },
];

vi.mock("@/lib/supabase/server", () => {
  const supabase = () =>
    createSupabaseFake({
      tables: {
        campaigns: () => [
          { id: CAMPAIGN, user_id: "user-1" },
          { id: OTHER_CAMPAIGN, user_id: "user-2" },
        ],
        campaign_people: links,
        people: () => [...state.people, ...strangers],
        // No domain, so findEmailForPerson has nothing to derive an address
        // from and returns without spending anything.
        organizations: () => [
          { id: ORG, name: "Acme", domain: null, is_catch_all: null },
          { id: "org-2", name: "Chronicle", domain: null, is_catch_all: null },
        ],
      },
      relations: { campaign_people: { person: { localKey: "person_id" } } },
      // Only findEmailForPerson reads a single person row by id, so this is how
      // the tool test sees which contacts it was allowed to spend on.
      onQuery: (q) => {
        if (q.table !== "people" || q.kind !== "select") return;
        const byId = q.filters.find(
          (f) => f.op === "eq" && f.column === "id",
        ) as { value: unknown } | undefined;
        if (byId) state.lookups.push(String(byId.value));
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

vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  PRICING: {},
}));

vi.mock("@/lib/services/exa-service", () => ({
  ExaService: class {
    async search() {
      return { results: [], resultCount: 0 };
    }
  },
}));

// The route imports findEmailForPerson, so the spy covers it. `findEmails`
// calls the module-local function, which the spy cannot intercept, so that
// test watches the person lookups instead.
vi.mock("@/lib/tools/email-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tools/email-tools")>();
  return { ...actual, findEmailForPerson: state.findEmailForPerson };
});

import { POST } from "@/app/api/find-email/bulk/route";
import { findEmails } from "@/lib/tools/email-tools";

const attached = (confidence: number | null, id: string) =>
  person({ id, affiliation_confidence: confidence });

afterEach(() => {
  state.people = [];
  state.lookups = [];
  findEmailForPerson.mockClear();
});

describe("POST /api/find-email/bulk", () => {
  function request() {
    return new Request("http://test/api/find-email/bulk", {
      method: "POST",
      body: JSON.stringify({ campaignId: CAMPAIGN, organizationId: ORG }),
    });
  }

  it("finds emails only for contacts confirmed at the company", async () => {
    state.people = [attached(0.9, CONFIRMED), attached(0.2, UNCONFIRMED)];

    await POST(request());

    expect(findEmailForPerson).toHaveBeenCalledWith(CONFIRMED);
    expect(findEmailForPerson).not.toHaveBeenCalledWith(UNCONFIRMED);
  });

  it("stays inside the campaign and the company it was asked about", async () => {
    // Both are confirmed at 0.9, so nothing but the two scopes keeps them out.
    // Losing the campaign predicate mints addresses for every campaign on the
    // instance; losing the organization comparison does it for every company in
    // this one, which is the fanout the endpoint's "one company per request"
    // contract exists to prevent.
    state.people = [attached(0.9, CONFIRMED)];

    await POST(request());

    expect(findEmailForPerson).toHaveBeenCalledTimes(1);
    expect(findEmailForPerson).toHaveBeenCalledWith(CONFIRMED);
    expect(findEmailForPerson).not.toHaveBeenCalledWith(AT_ANOTHER_ORG);
    expect(findEmailForPerson).not.toHaveBeenCalledWith(IN_ANOTHER_CAMPAIGN);
  });

  it("refuses a campaign the caller does not own", async () => {
    // The ownership check is a lookup by id. Without the predicate it reads
    // whichever campaign sorted first and hands one user another's roster.
    state.people = [attached(0.9, CONFIRMED)];

    const res = await POST(
      new Request("http://test/api/find-email/bulk", {
        method: "POST",
        body: JSON.stringify({
          campaignId: OTHER_CAMPAIGN,
          organizationId: ORG,
        }),
      }),
    );

    expect(res.status).toBe(403);
    expect(findEmailForPerson).not.toHaveBeenCalled();
  });

  it("reports the skipped contacts instead of dropping them", async () => {
    // Silently removing them from the totals makes the button look like it
    // found nothing, with no way for the user to learn why.
    state.people = [attached(0.9, CONFIRMED), attached(0.2, UNCONFIRMED)];

    const res = await POST(request());
    const body = (await res.json()) as {
      pendingTotal: number;
      skipped: number;
      summary: string;
    };

    expect(body.pendingTotal).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.summary).toMatch(/skipped/i);
  });

  it("treats a null confidence as unconfirmed", async () => {
    state.people = [attached(null, UNCONFIRMED)];

    const res = await POST(request());
    const body = (await res.json()) as { skipped: number };

    expect(findEmailForPerson).not.toHaveBeenCalled();
    expect(body.skipped).toBe(1);
  });
});

describe("findEmails (batch tool)", () => {
  it("skips contacts below the send threshold and says so", async () => {
    state.people = [attached(0.9, CONFIRMED), attached(0.2, UNCONFIRMED)];

    const out = (await findEmails.execute!(
      { personIds: [CONFIRMED, UNCONFIRMED] },
      {} as never,
    )) as { skipped: string[]; summary: string };

    expect(state.lookups).toEqual([CONFIRMED]);
    expect(out.skipped).toEqual([UNCONFIRMED]);
    expect(out.summary).toMatch(/not confirmed/i);
  });
});
