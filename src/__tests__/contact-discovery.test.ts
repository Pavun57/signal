import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The affiliation half of contact discovery: who gets attached to a company,
 * who gets kept but flagged, and who gets detached.
 *
 * The two failure modes this guards against are opposites, and the codebase has
 * shipped both. A hard headline filter deletes real employees (measured: it
 * would have discarded 22 of 41 genuine contacts at one company). No filter at
 * all files strangers under the company — which is how a Wafer employee ended
 * up stored as working at Browserbase.
 */

const judged = vi.fn();
vi.mock("@/lib/services/contact-filter", () => ({
  filterContactsByCompany: (...args: unknown[]) => judged(...args),
  findPeopleOnDomain: vi.fn().mockResolvedValue([]),
}));

const exaResults = { results: [] as Array<{ url: string; title: string }> };
vi.mock("@/lib/services/exa-service", () => ({
  ExaService: class {
    async search() {
      return exaResults;
    }
  },
}));

const created: Array<Record<string, unknown>> = [];
vi.mock("@/lib/services/knowledge-base", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/knowledge-base")>();
  return {
    ...actual,
    findOrCreatePerson: vi.fn(async (data: Record<string, unknown>) => {
      created.push(data);
      return {
        id: `p${created.length}`,
        name: data.name,
        title: data.title ?? null,
        work_email: null,
        personal_email: null,
        linkedin_url: data.linkedin_url ?? null,
      };
    }),
    linkPersonToCampaign: vi.fn().mockResolvedValue({ id: "cp1" }),
  };
});

const affiliations: Array<Record<string, unknown>> = [];
vi.mock("@/lib/services/affiliation", () => ({
  recordAffiliation: vi.fn(async (_c: unknown, a: Record<string, unknown>) => {
    affiliations.push(a);
  }),
}));

vi.mock("@/lib/services/email-pattern", () => ({
  recordVerifiedEmail: vi.fn().mockResolvedValue(undefined),
}));

import {
  findContactsForOrganization,
  MAX_ALREADY_LINKED,
} from "@/lib/services/contact-discovery";

let org: Record<string, unknown> = {};
/** Rows the people-list queries resolve to (org dedup / campaign links). */
let orgPeople: Array<Record<string, unknown>> = [];

function client(): SupabaseClient {
  const chain = () => {
    // The people queries (org dedup, campaign links) select a list; everything
    // else in these tests resolves the single org row. Keyed on the presence of
    // linkedin_url rather than an exact column string — matching the whole
    // string meant widening the select silently handed back a non-iterable org
    // row instead of a list.
    let wantsList = false;
    const c: Record<string, unknown> & PromiseLike<unknown> = {
      select: (cols?: string) => {
        if (cols?.includes("linkedin_url")) wantsList = true;
        return c;
      },
      eq: () => c,
      not: () => c,
      single: () => c,
      maybeSingle: () => c,
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({
          data: wantsList ? orgPeople : org,
          error: null,
        }).then(onF, onR),
    } as unknown as Record<string, unknown> & PromiseLike<unknown>;
    return c;
  };
  return { from: () => chain() } as unknown as SupabaseClient;
}

beforeEach(() => {
  created.length = 0;
  affiliations.length = 0;
  exaResults.results = [];
  orgPeople = [];
  judged.mockReset().mockResolvedValue([]);
  org = {
    id: "org-1",
    name: "Browserbase",
    domain: "browserbase.com",
    industry: "developer tools",
    location: "SF",
    description: null,
  };
});

const run = () =>
  findContactsForOrganization(client(), {
    organizationId: "org-1",
    campaignId: null,
    titles: ["engineer"],
    numResults: 3,
  });

describe("domain gate", () => {
  it("refuses to attach people to a company with no domain", async () => {
    // Two different companies called "Acme" are indistinguishable without one,
    // so attaching contacts is how their people get pooled.
    org = { ...org, domain: null };

    const result = await run();

    expect(result.error).toContain("no domain");
    expect(result.contacts).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("says what would unblock it rather than failing silently", async () => {
    org = { ...org, domain: null };

    const result = await run();

    expect(result.error).toMatch(/resolve the company's website/i);
  });
});

describe("titles", () => {
  it("leaves the title blank when the headline does not name one", async () => {
    // The title we searched for is not evidence about the person we found.
    // Falling back to it stamped the ICP target title onto anyone whose
    // headline didn't parse, which is how a 15-person startup ended up
    // showing three Heads of Growth and four Revenue Operations.
    exaResults.results = [
      { url: "https://www.linkedin.com/in/c", title: "Cal C" },
    ];

    await run();

    const candidates = judged.mock.calls[0][1] as Array<{
      name: string;
      title: string | null;
      searchTitle: string;
    }>;
    expect(candidates[0].name).toBe("Cal C");
    expect(candidates[0].title).toBeNull();
    // Still available as query context — just never mistaken for their role.
    expect(candidates[0].searchTitle).toBe("engineer");
  });

  it("keeps a title it actually read off the headline", async () => {
    exaResults.results = [
      {
        url: "https://www.linkedin.com/in/a",
        title: "Ann A - Staff Engineer at Browserbase",
      },
    ];

    await run();

    const candidates = judged.mock.calls[0][1] as Array<{
      title: string | null;
    }>;
    expect(candidates[0].title).toBe("Staff Engineer at Browserbase");
  });
});

describe("alreadyLinked", () => {
  const person = (i: number) => ({
    id: `ex${i}`,
    name: `Existing ${i}`,
    title: "Engineer",
    work_email: null,
    personal_email: null,
    linkedin_url: `https://www.linkedin.com/in/ex${i}`,
  });

  it("returns people already attached to the org", async () => {
    orgPeople = [person(1), person(2)];

    const result = await run();

    expect(result.alreadyLinkedTotal).toBe(2);
    expect(result.alreadyLinked.map((p) => p.name)).toEqual([
      "Existing 1",
      "Existing 2",
    ]);
  });

  it("caps the roster but still reports the true total", async () => {
    // A truncated list that reports its own length reads as complete, which is
    // how "that's everyone at this company" becomes a silent lie.
    orgPeople = Array.from({ length: MAX_ALREADY_LINKED + 20 }, (_, i) =>
      person(i),
    );

    const result = await run();

    expect(result.alreadyLinked).toHaveLength(MAX_ALREADY_LINKED);
    expect(result.alreadyLinkedTotal).toBe(MAX_ALREADY_LINKED + 20);
  });

  it("dedups against every known person, not just the capped ones", async () => {
    // Capping dedup would re-fetch and re-bill people we already hold.
    orgPeople = Array.from({ length: MAX_ALREADY_LINKED + 1 }, (_, i) =>
      person(i),
    );
    // The last person is past the display cap; a search hit for them must
    // still be recognised as a duplicate.
    exaResults.results = [
      {
        url: `https://www.linkedin.com/in/ex${MAX_ALREADY_LINKED}`,
        title: "Existing 50 - Browserbase",
      },
    ];

    const result = await run();

    expect(result.duplicatesSkipped).toBe(1);
    expect(judged).not.toHaveBeenCalled();
  });
});

describe("verdict handling", () => {
  beforeEach(() => {
    exaResults.results = [
      { url: "https://www.linkedin.com/in/a", title: "Ann A - Browserbase" },
      { url: "https://www.linkedin.com/in/b", title: "Bob B - Wafer" },
      { url: "https://www.linkedin.com/in/c", title: "Cal C" },
    ];
  });

  it("attaches verified people and records why", async () => {
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "verified",
        evidence: "headline names Browserbase",
      },
    ]);

    const result = await run();

    expect(result.verifiedCount).toBe(1);
    expect(created[0].organization_id).toBe("org-1");
    expect(affiliations[0]).toMatchObject({
      organizationId: "org-1",
      source: "llm_verified",
      evidence: "headline names Browserbase",
    });
  });

  it("detaches someone the evidence places at another company", async () => {
    // The Garrett Graves case: returned by a search for "Browserbase", but the
    // profile says Wafer. Kept as a person, not filed under this company.
    judged.mockResolvedValue([
      {
        index: 1,
        name: "Bob B",
        title: "Engineer",
        verdict: "rejected",
        evidence: "headline reads 'Wafer'",
      },
    ]);

    const result = await run();

    expect(result.rejectedAsWrongCompany).toBe(1);
    expect(result.contacts).toHaveLength(0);
    expect(created[0].organization_id).toBeNull();
    expect(affiliations[0].organizationId).toBeNull();
  });

  it("keeps unproven people, attached but weakly", async () => {
    // The 19-of-41 case: no employer in the headline is not evidence of
    // anything. Dropping them is what made the old hard filter unusable.
    judged.mockResolvedValue([
      {
        index: 2,
        name: "Cal C",
        title: "Engineer",
        verdict: "uncertain",
        evidence: "headline names no employer",
      },
    ]);

    const result = await run();

    expect(result.uncertainCount).toBe(1);
    expect(result.contacts).toHaveLength(1);
    expect(created[0].organization_id).toBe("org-1");
    // Weakest source, so the send gate refuses them until something confirms.
    expect(affiliations[0].source).toBe("search_stamp");
  });

  it("reports the real counts, not a hardcoded zero", async () => {
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: null,
        verdict: "verified",
        evidence: "x",
      },
      {
        index: 1,
        name: "Bob B",
        title: null,
        verdict: "rejected",
        evidence: "y",
      },
      {
        index: 2,
        name: "Cal C",
        title: null,
        verdict: "uncertain",
        evidence: "z",
      },
    ]);

    const result = await run();

    expect(result).toMatchObject({
      verifiedCount: 1,
      rejectedAsWrongCompany: 1,
      uncertainCount: 1,
    });
  });
});
