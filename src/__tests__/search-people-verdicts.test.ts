import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The affiliation half of `searchPeople`, the second judge-and-store path.
 *
 * This is the path that actually produced the Browserbase noise: six people who
 * had never worked there (Chronicle Labs, Okta, Box, Hashgraph, Amazon, Stash)
 * were stored as staff because the Exa page text was captured and then dropped
 * before the judge ever saw it. `contact-discovery.ts` has the same shape and
 * the same tests; the two must not drift, because a fix landing in only one of
 * them is how this bug survived twice already.
 */

const judged = vi.fn();
vi.mock("@/lib/services/contact-filter", () => ({
  filterContactsByCompany: (...args: unknown[]) => judged(...args),
  findPeopleOnDomain: vi.fn().mockResolvedValue([]),
}));

const exaResults = {
  results: [] as Array<{
    url: string;
    title: string;
    text?: string | null;
    publishedDate?: string | null;
  }>,
  resultCount: 0,
};
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
    findOrCreateOrganization: vi.fn(async () => ({ id: "org-1" })),
    findOrCreatePerson: vi.fn(async (data: Record<string, unknown>) => {
      created.push(data);
      return {
        id: `p${created.length}`,
        name: data.name,
        title: data.title ?? null,
        linkedin_url: data.linkedin_url ?? null,
        enrichment_status: "enriched",
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

/** The one org row every query in this path resolves to. */
const org = {
  name: "Browserbase",
  domain: "browserbase.com",
  industry: "developer tools",
  location: "SF",
  description: null,
};

function chain(table: string) {
  const c: Record<string, unknown> & PromiseLike<unknown> = {
    select: () => c,
    eq: () => c,
    update: () => c,
    single: () => c,
    maybeSingle: () => c,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({
        data: table === "organizations" ? org : null,
        error: null,
      }).then(onF, onR),
  } as unknown as Record<string, unknown> & PromiseLike<unknown>;
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (table: string) => chain(table),
  })),
}));

import { searchPeople } from "@/lib/tools/enrichment-tools";

beforeEach(() => {
  created.length = 0;
  affiliations.length = 0;
  exaResults.results = [];
  exaResults.resultCount = 0;
  judged.mockReset().mockResolvedValue([]);
});

/**
 * The AI SDK types `execute` as returning either a value or an async iterable
 * of streamed parts. This tool returns a plain object, so narrow to that half
 * once here rather than asserting on `unknown` in every test.
 */
type SearchPeopleResult = Extract<
  Awaited<ReturnType<NonNullable<typeof searchPeople.execute>>>,
  { contacts: unknown }
>;

const run = async (): Promise<SearchPeopleResult> =>
  (await searchPeople.execute!(
    {
      query: "engineers at Browserbase",
      numResults: 5,
      companyName: "Browserbase",
    },
    {} as never,
  )) as SearchPeopleResult;

/** One LinkedIn profile hit, the shape the storage loop is built around. */
const oneCandidate = () => {
  exaResults.results = [
    { url: "https://www.linkedin.com/in/a", title: "Ann A - Engineer" },
  ];
  exaResults.resultCount = 1;
};

describe("evidence handed to the judge", () => {
  it("passes the page text and date Exa returned", async () => {
    // includeText is already set on the search, so this text is paid for
    // whether or not we read it. Capturing it at the candidate build and then
    // dropping it before the judge call is the exact bug being fixed.
    exaResults.results = [
      {
        url: "https://www.linkedin.com/in/a",
        title: "Ann A - Engineer",
        text: "Experience: Software Engineer, Browserbase, May 2025 - Present",
        publishedDate: "2026-07-23",
      },
    ];
    exaResults.resultCount = 1;

    await run();

    const candidates = judged.mock.calls[0][1] as Array<{
      pageText: string | null;
      pageDate: string | null;
    }>;
    expect(candidates[0].pageText).toContain("May 2025 - Present");
    expect(candidates[0].pageDate).toBe("2026-07-23");
  });
});

describe("acting on the verdicts", () => {
  it("attaches verified people and records why", async () => {
    oneCandidate();
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "verified",
        evidence: "profile shows Browserbase, May 2025 - Present",
      },
    ]);

    const result = await run();

    expect(affiliations[0]).toMatchObject({
      organizationId: "org-1",
      source: "llm_verified",
    });
    expect(result.contacts).toHaveLength(1);
  });

  it("detaches someone the evidence says has left", async () => {
    oneCandidate();
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "former_employee",
        employerSeen: "Browserbase",
        datesSeen: "Oct 2024 - Mar 2026",
        evidence: "role ended Mar 2026",
      },
    ]);

    const result = await run();

    const last = affiliations[affiliations.length - 1];
    expect(last.source).toBe("former_employee");
    expect(last.organizationId).toBeNull();
    expect(created[0].organization_id).toBeNull();
    expect(result.departedCount).toBe(1);
    // Reporting them as a contact at this company one line after detaching
    // them is how a caller ends up drafting for someone who left.
    expect(result.contacts).toHaveLength(0);
  });

  it("detaches someone the evidence places elsewhere", async () => {
    oneCandidate();
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "rejected",
        employerSeen: "Chronicle Labs",
        datesSeen: "May 2024 - Present",
        evidence: "profile names Chronicle Labs",
      },
    ]);

    const result = await run();

    const last = affiliations[affiliations.length - 1];
    expect(last.source).toBe("employer_mismatch");
    expect(last.organizationId).toBeNull();
    // Without the employer folded in, the row reads "profile names a different
    // employer" and the user has to go and look up which one.
    expect(last.evidence).toContain("Chronicle Labs");
    expect(result.rejectedAsWrongCompany).toBe(1);
    expect(result.contacts).toHaveLength(0);
  });

  it("counts a departed candidate it cannot identify without storing them", async () => {
    // findOrCreatePerson dedups by LinkedIn URL or by name within an
    // organization. A detached candidate has no organization, so one with no
    // profile URL matches neither path and would be INSERTED fresh on every
    // run, adding an orphan each time.
    exaResults.results = [
      { url: "https://example.com/team", title: "Ann A - Engineer" },
    ];
    exaResults.resultCount = 1;
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "former_employee",
        evidence: "role ended Mar 2026",
      },
    ]);

    const result = await run();

    expect(created).toHaveLength(0);
    expect(affiliations).toHaveLength(0);
    expect(result.departedCount).toBe(1);
  });

  it("still keeps uncertain people attached and flagged", async () => {
    // The whole point of `uncertain` is that we keep them. This must not
    // regress into the old hard filter that deleted real employees.
    oneCandidate();
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "uncertain",
        evidence: "page text unavailable",
      },
    ]);

    const result = await run();

    expect(result.contacts).toHaveLength(1);
    expect(result.uncertainCount).toBe(1);
    expect(affiliations[affiliations.length - 1].source).toBe("search_stamp");
    expect(affiliations[affiliations.length - 1].organizationId).toBe("org-1");
  });

  it("tells the agent about departures in the note", async () => {
    oneCandidate();
    judged.mockResolvedValue([
      {
        index: 0,
        name: "Ann A",
        title: "Engineer",
        verdict: "former_employee",
        employerSeen: "Browserbase",
        datesSeen: "Oct 2024 - Mar 2026",
        evidence: "role ended Mar 2026",
      },
    ]);

    const result = await run();

    expect(result.note).toMatch(/left|no longer|departed/i);
  });
});
