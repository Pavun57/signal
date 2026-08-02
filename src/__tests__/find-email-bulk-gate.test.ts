import { afterEach, describe, expect, it, vi } from "vitest";

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

const state = vi.hoisted(() => ({
  /** Rows the people / campaign_people selects resolve to. */
  people: [] as Array<{
    id: string;
    work_email: string | null;
    organization_id: string | null;
    affiliation_confidence: number | null;
  }>,
  /** Person IDs the real findEmailForPerson actually looked up. */
  lookups: [] as string[],
  findEmailForPerson: vi.fn(async (personId: string) => ({
    email: null as string | null,
    reason: "Person not found.",
    personId,
  })),
}));

const findEmailForPerson = state.findEmailForPerson;

vi.mock("@/lib/supabase/server", () => {
  function peopleChain() {
    let inIds: string[] | null = null;
    let eqId: string | null = null;
    const c: Record<string, unknown> = {
      select: () => c,
      in: (_col: string, ids: string[]) => {
        inIds = ids;
        return c;
      },
      eq: (_col: string, value: string) => {
        eqId = value;
        return c;
      },
      // Only findEmailForPerson reads a single person row, so recording here
      // is how the tool test sees which contacts it was allowed to spend on.
      single: async () => {
        if (eqId) state.lookups.push(eqId);
        return { data: null, error: { message: "Person not found." } };
      },
      then: (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) =>
        Promise.resolve({
          data: state.people.filter((p) => !inIds || inIds.includes(p.id)),
          error: null,
        }).then(resolve, reject),
    };
    return c;
  }

  function campaignChain() {
    const c: Record<string, unknown> = {
      select: () => c,
      eq: () => c,
      maybeSingle: async () => ({
        data: { user_id: "user-1" },
        error: null,
      }),
    };
    return c;
  }

  function campaignPeopleChain() {
    const c: Record<string, unknown> = {
      select: () => c,
      eq: () => c,
      then: (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) =>
        Promise.resolve({
          data: state.people.map((person) => ({ person })),
          error: null,
        }).then(resolve, reject),
    };
    return c;
  }

  const supabase = {
    from: (table: string) => {
      if (table === "campaigns") return campaignChain();
      if (table === "campaign_people") return campaignPeopleChain();
      if (table === "people") return peopleChain();
      throw new Error(`unexpected table: ${table}`);
    },
  };

  return {
    createClient: vi.fn(async () => supabase),
    getSupabaseAndUser: vi.fn(async () => ({
      supabase,
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

function attached(confidence: number | null, id: string) {
  return {
    id,
    work_email: null,
    organization_id: "org-1",
    affiliation_confidence: confidence,
  };
}

afterEach(() => {
  state.people = [];
  state.lookups = [];
  findEmailForPerson.mockClear();
});

describe("POST /api/find-email/bulk", () => {
  function request() {
    return new Request("http://test/api/find-email/bulk", {
      method: "POST",
      body: JSON.stringify({
        campaignId: "33333333-3333-3333-3333-333333333333",
        organizationId: "org-1",
      }),
    });
  }

  it("finds emails only for contacts confirmed at the company", async () => {
    state.people = [attached(0.9, CONFIRMED), attached(0.2, UNCONFIRMED)];

    await POST(request());

    expect(findEmailForPerson).toHaveBeenCalledWith(CONFIRMED);
    expect(findEmailForPerson).not.toHaveBeenCalledWith(UNCONFIRMED);
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
