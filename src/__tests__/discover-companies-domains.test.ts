import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where the domain-less companies come from in the first place.
 *
 * `discoverCompanies` extracts businesses from directory pages, and a directory
 * listing routinely carries no website for the business (a care home listed on
 * carehome.co.uk is the case that started this). It stored them with
 * `domain: null` anyway, and a company with no domain cannot hold contacts at
 * all, so a whole campaign of them was structurally incapable of holding a
 * lead. Resolving here is what stops the dead end being created.
 *
 * A company that cannot be resolved is still created. It is a real lead, and
 * the campaign page can now fix it by hand.
 */

const generateObject = vi.fn();
vi.mock("ai", async (importOriginal) => ({
  // apiSafeSchema needs the real asSchema/jsonSchema helpers.
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObject(...args),
  // search-tools wraps every export in tool(); the identity keeps `execute`
  // reachable from the test.
  tool: (definition: unknown) => definition,
}));
vi.mock("@/lib/ai/models", () => ({
  getLLM: () => "model",
  AI_MODEL: "test-model",
  AI_BASE_URL: "https://api.anthropic.com/v1",
  AI_INPUT_PRICE_PER_MTOK: 3.0,
  AI_OUTPUT_PRICE_PER_MTOK: 15.0,
}));

/** One directory page to scrape, which is what the extraction step reads. */
const exaSearch = vi.fn(async () => ({
  results: [
    {
      url: "https://directory.example/birmingham-nursing-homes",
      title: "Nursing homes in Birmingham",
      text: "a".repeat(600),
    },
  ],
}));
vi.mock("@/lib/services/exa-service", () => ({
  ExaService: class {
    search = (...args: unknown[]) =>
      (exaSearch as unknown as (...a: unknown[]) => unknown)(...args);
  },
}));

vi.mock("@/lib/services/web-extraction-service", () => ({
  WebExtractionService: class {
    extract = async () => ({
      success: true,
      data: { content: "x".repeat(1200) },
    });
  },
}));

vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  estimateLlmCostFromUsage: () => 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: async () => ({ data: [] }) }) }),
  }),
}));

const findOrCreateOrganization = vi.fn(async (data: { name: string }) => ({
  id: `org-${data.name}`,
  ...data,
}));
vi.mock("@/lib/services/knowledge-base", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    findOrCreateOrganization: (...args: unknown[]) =>
      (findOrCreateOrganization as unknown as (...a: unknown[]) => unknown)(
        ...args,
      ),
    linkOrganizationToCampaign: vi.fn(async () => ({ id: "link" })),
  };
});

const resolveOrganizationDomain = vi.fn();
vi.mock("@/lib/services/domain-resolver", () => ({
  resolveOrganizationDomain: (...args: unknown[]) =>
    (resolveOrganizationDomain as unknown as (...a: unknown[]) => unknown)(
      ...args,
    ),
}));

import { discoverCompanies } from "@/lib/tools/search-tools";

/** The scraped directory page every case below is extracted from. */
function extractedCompanies(companies: Array<Record<string, unknown>>): {
  object: { companies: unknown[] };
  usage: Record<string, number>;
} {
  return { object: { companies }, usage: { inputTokens: 1, outputTokens: 1 } };
}

const run = () =>
  (
    discoverCompanies as unknown as {
      execute: (input: Record<string, unknown>) => Promise<{
        companies: Array<{ name: string; domain: string | null }>;
        domainsResolved?: number;
        domainsStillMissing?: number;
      }>;
    }
  ).execute({ industry: "nursing homes", location: "Birmingham" });

/** The domain each company was actually stored with. */
function storedDomain(name: string): unknown {
  const call = findOrCreateOrganization.mock.calls.find(
    (c) => (c[0] as { name: string }).name === name,
  );
  return (call?.[0] as { domain?: unknown } | undefined)?.domain;
}

beforeEach(() => {
  generateObject.mockReset();
  findOrCreateOrganization.mockClear();
  resolveOrganizationDomain.mockReset().mockResolvedValue(null);
  exaSearch.mockClear();
});

describe("discoverCompanies: domains", () => {
  it("resolves a website for a company the directory listed without one", async () => {
    generateObject.mockResolvedValue(
      extractedCompanies([
        {
          name: "Cedar Lodge Nursing Home",
          domain: null,
          url: null,
          location: "Birmingham",
          industry: "Nursing Home",
          description: null,
        },
      ]),
    );
    resolveOrganizationDomain.mockResolvedValue({
      domain: "cedarlodge.co.uk",
      url: "https://cedarlodge.co.uk",
      source: "google_places",
      evidence: "Google Places",
    });

    const result = await run();

    expect(storedDomain("Cedar Lodge Nursing Home")).toBe("cedarlodge.co.uk");
    expect(result.domainsResolved).toBe(1);
    expect(result.companies[0].domain).toBe("cedarlodge.co.uk");
  });

  it("still creates a company whose website cannot be found", async () => {
    generateObject.mockResolvedValue(
      extractedCompanies([
        {
          name: "The Orchards",
          domain: null,
          url: null,
          location: "Birmingham",
          industry: "Nursing Home",
          description: null,
        },
      ]),
    );

    const result = await run();

    // An unresolved company is still a lead, and the campaign page can now fix
    // it by hand. Dropping it would silently shrink the user's list.
    expect(findOrCreateOrganization).toHaveBeenCalledTimes(1);
    expect(storedDomain("The Orchards")).toBeNull();
    // Reported rather than silent: "12 companies" reads as 12 usable companies
    // when none of them can hold a contact.
    expect(result.domainsStillMissing).toBe(1);
  });

  it("does not pay for a lookup when the directory already gave a domain", async () => {
    generateObject.mockResolvedValue(
      extractedCompanies([
        {
          name: "Aran Court Care Home",
          domain: "arancourt.co.uk",
          url: "https://arancourt.co.uk",
          location: "Birmingham",
          industry: "Nursing Home",
          description: null,
        },
      ]),
    );

    await run();

    expect(resolveOrganizationDomain).not.toHaveBeenCalled();
    expect(storedDomain("Aran Court Care Home")).toBe("arancourt.co.uk");
  });
});
