import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeoutMock = vi.fn();
// The page fetches moved to safeFetch (scheme/address vetting, revalidated
// redirects, capped body); the ATS JSON call still uses fetchWithTimeout.
// Both route through the same mock so routeFetches keeps describing the whole
// transport surface.
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => fetchWithTimeoutMock(...args),
  readBodyCapped: (r: { text: () => Promise<string> }) => r.text(),
}));
vi.mock("@/lib/fetch-with-timeout", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

const mergeEnrichmentDataMock = vi.fn();
vi.mock("@/lib/services/knowledge-base", () => ({
  mergeEnrichmentData: (...args: unknown[]) => mergeEnrichmentDataMock(...args),
}));

const webExtractMock = vi.fn();
vi.mock("@/lib/services/web-extraction-service", () => ({
  WebExtractionService: class {
    extract = (...args: unknown[]) => webExtractMock(...args);
  },
}));

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  estimateLlmCostFromUsage: () => 0,
}));

// Stagehand stub: the last-resort browser tier. Tests assert on these mocks
// to prove (or disprove) that a scrape fell all the way through.
const stagehandInitMock = vi.fn();
const stagehandObserveMock = vi.fn();
const stagehandActMock = vi.fn();
const stagehandExtractMock = vi.fn();
const stagehandPage = {
  goto: vi.fn(async () => ({ ok: () => true })),
  waitForTimeout: vi.fn(async () => {}),
  url: () => "https://acme.com/careers",
};
vi.mock("@browserbasehq/stagehand", () => ({
  Stagehand: class {
    init = stagehandInitMock;
    context = { pages: () => [stagehandPage] };
    observe = stagehandObserveMock;
    act = stagehandActMock;
    extract = stagehandExtractMock;
    close = vi.fn(async () => {});
  },
}));

import { scrapeHiringData } from "@/lib/services/hiring-scraper";

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  url?: string;
}

function res(body: string | object, init: FakeResponseInit = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? (init.ok === false ? 404 : 200),
    statusText: "",
    url: init.url ?? "",
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

const notFound = () => res("", { ok: false, status: 404 });

/** Routes fetchWithTimeout calls by exact URL; everything else 404s. */
function routeFetches(routes: Record<string, ReturnType<typeof res>>) {
  fetchWithTimeoutMock.mockImplementation(async (url: unknown) => {
    const u = String(url);
    return routes[u] ?? notFound();
  });
}

function calledUrls(): string[] {
  return fetchWithTimeoutMock.mock.calls.map((c) => String(c[0]));
}

describe("scrapeHiringData cheap-first tiers", () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
    mergeEnrichmentDataMock.mockReset();
    mergeEnrichmentDataMock.mockResolvedValue(undefined);
    webExtractMock.mockReset();
    generateObjectMock.mockReset();
    stagehandInitMock.mockReset();
    stagehandInitMock.mockResolvedValue(undefined);
    stagehandObserveMock.mockReset();
    stagehandActMock.mockReset();
    stagehandExtractMock.mockReset();
    vi.stubEnv("BROWSERBASE_API_KEY", "bb-key");
    vi.stubEnv("BROWSERBASE_PROJECT_ID", "bb-project");
    vi.stubEnv("ANTHROPIC_API_KEY", "ant-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("ATS shortcut (tier 2, zero LLM)", () => {
    it("detects a Greenhouse board on the careers page and maps its jobs", async () => {
      routeFetches({
        "https://acme.com/careers": res(
          '<html><a href="https://boards.greenhouse.io/acme">See openings</a></html>',
          { url: "https://acme.com/careers" },
        ),
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true":
          res({
            jobs: [
              {
                title: "Platform Engineer",
                absolute_url: "https://boards.greenhouse.io/acme/jobs/123",
                location: { name: "Remote" },
                departments: [{ name: "Engineering" }],
              },
            ],
          }),
      });

      const out = await scrapeHiringData("org-1", "acme.com");

      expect(out.careersUrl).toBe("https://acme.com/careers");
      expect(out.totalJobs).toBe(1);
      expect(out.jobs).toEqual([
        {
          title: "Platform Engineer",
          department: "Engineering",
          location: "Remote",
          url: "https://boards.greenhouse.io/acme/jobs/123",
        },
      ]);
      expect(mergeEnrichmentDataMock).toHaveBeenCalledWith(
        "organizations",
        "org-1",
        expect.objectContaining({
          hiring: expect.objectContaining({
            careersUrl: "https://acme.com/careers",
            jobs: out.jobs,
          }),
        }),
        "enriched",
        // No client threaded on the agent-tool path; the cron passes admin.
        undefined,
      );
      // ATS hit must never reach the heavier tiers.
      expect(webExtractMock).not.toHaveBeenCalled();
      expect(generateObjectMock).not.toHaveBeenCalled();
      expect(stagehandInitMock).not.toHaveBeenCalled();
    });

    it("extracts the Greenhouse slug from an embed job_board URL", async () => {
      routeFetches({
        "https://acme.com/careers": res(
          '<script src="https://boards.greenhouse.io/embed/job_board?for=acme"></script>',
          { url: "https://acme.com/careers" },
        ),
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true":
          res({ jobs: [{ title: "SDR", absolute_url: "https://x.example" }] }),
      });

      const out = await scrapeHiringData("org-1", "acme.com");
      expect(out.jobs.map((j) => j.title)).toEqual(["SDR"]);
    });

    it("detects a Lever board and maps text/categories into the jobs shape", async () => {
      routeFetches({
        "https://acme.com/careers": res(
          '<a href="https://jobs.lever.co/acme">Jobs</a>',
          { url: "https://acme.com/careers" },
        ),
        "https://api.lever.co/v0/postings/acme?mode=json": res([
          {
            text: "Sales Lead",
            categories: { team: "Sales", location: "New York" },
            hostedUrl: "https://jobs.lever.co/acme/abc",
          },
        ]),
      });

      const out = await scrapeHiringData("org-1", "acme.com");
      expect(out.jobs).toEqual([
        {
          title: "Sales Lead",
          department: "Sales",
          location: "New York",
          url: "https://jobs.lever.co/acme/abc",
        },
      ]);
      expect(webExtractMock).not.toHaveBeenCalled();
    });

    it("detects an Ashby board and skips unlisted postings", async () => {
      routeFetches({
        "https://acme.com/careers": res(
          '<a href="https://jobs.ashbyhq.com/acme">Open roles</a>',
          { url: "https://acme.com/careers" },
        ),
        "https://api.ashbyhq.com/posting-api/job-board/acme": res({
          jobs: [
            {
              title: "Product Designer",
              department: "Design",
              location: "San Francisco",
              jobUrl: "https://jobs.ashbyhq.com/acme/xyz",
              isListed: true,
            },
            {
              title: "Ghost Role",
              department: "Design",
              location: "SF",
              jobUrl: "https://jobs.ashbyhq.com/acme/ghost",
              isListed: false,
            },
          ],
        }),
      });

      const out = await scrapeHiringData("org-1", "acme.com");
      expect(out.jobs).toEqual([
        {
          title: "Product Designer",
          department: "Design",
          location: "San Francisco",
          url: "https://jobs.ashbyhq.com/acme/xyz",
        },
      ]);
    });

    it("detects a Workable board and joins city and country into location", async () => {
      routeFetches({
        "https://acme.com/careers": res(
          '<a href="https://apply.workable.com/acme/">Apply</a>',
          { url: "https://acme.com/careers" },
        ),
        "https://apply.workable.com/api/v1/widget/accounts/acme": res({
          name: "Acme",
          jobs: [
            {
              title: "Support Rep",
              department: "CX",
              city: "Athens",
              country: "Greece",
              url: "https://apply.workable.com/j/ABC123",
            },
          ],
        }),
      });

      const out = await scrapeHiringData("org-1", "acme.com");
      expect(out.jobs).toEqual([
        {
          title: "Support Rep",
          department: "CX",
          location: "Athens, Greece",
          url: "https://apply.workable.com/j/ABC123",
        },
      ]);
    });

    it("caps jobs at maxJobs while reporting the full totalJobs", async () => {
      routeFetches({
        "https://acme.com/careers": res(
          '<a href="https://jobs.lever.co/acme">Jobs</a>',
          { url: "https://acme.com/careers" },
        ),
        "https://api.lever.co/v0/postings/acme?mode=json": res([
          { text: "Role A", hostedUrl: "https://x.example/a" },
          { text: "Role B", hostedUrl: "https://x.example/b" },
          { text: "Role C", hostedUrl: "https://x.example/c" },
        ]),
      });

      const out = await scrapeHiringData("org-1", "acme.com", 2);
      expect(out.jobs).toHaveLength(2);
      expect(out.totalJobs).toBe(3);
    });

    it("finds the careers link on the homepage when no common path responds", async () => {
      routeFetches({
        "https://acme.com": res('<nav><a href="/join-us">Join us</a></nav>', {
          url: "https://acme.com",
        }),
        "https://acme.com/join-us": res(
          '<a href="https://jobs.ashbyhq.com/acme">Roles</a>',
          { url: "https://acme.com/join-us" },
        ),
        "https://api.ashbyhq.com/posting-api/job-board/acme": res({
          jobs: [
            {
              title: "Founding Engineer",
              location: "Remote",
              jobUrl: "https://jobs.ashbyhq.com/acme/1",
            },
          ],
        }),
      });

      const out = await scrapeHiringData("org-1", "acme.com");
      expect(out.careersUrl).toBe("https://acme.com/join-us");
      expect(out.jobs.map((j) => j.title)).toEqual(["Founding Engineer"]);
    });
  });

  describe("fetched-HTML extraction (tier 3)", () => {
    it("runs WebExtraction plus one Haiku pass when no ATS board is linked", async () => {
      routeFetches({
        "https://acme.com/careers": res(
          "<html><h1>Careers</h1><p>We hire in-house, no job board here.</p></html>",
          { url: "https://acme.com/careers" },
        ),
      });
      webExtractMock.mockResolvedValue({
        success: true,
        url: "https://acme.com/careers",
        source: "fetch",
        data: {
          title: "Careers",
          description: "",
          content:
            "Open positions at Acme. Operations Manager, Berlin, full time. " +
            "Head of Sales, London. Apply by emailing jobs@acme.com. " +
            "We are a growing team looking for people who love logistics " +
            "and want to build the future of freight with us in Europe.",
        },
        extractionTime: 5,
      });
      generateObjectMock.mockResolvedValue({
        object: {
          jobs: [
            { title: "Operations Manager", location: "Berlin" },
            { title: "Head of Sales", location: "London" },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const out = await scrapeHiringData("org-1", "acme.com");

      expect(webExtractMock).toHaveBeenCalledWith(
        "https://acme.com/careers",
        expect.anything(),
      );
      expect(out.careersUrl).toBe("https://acme.com/careers");
      expect(out.jobs).toEqual([
        { title: "Operations Manager", location: "Berlin" },
        { title: "Head of Sales", location: "London" },
      ]);
      expect(out.totalJobs).toBe(2);
      expect(stagehandInitMock).not.toHaveBeenCalled();
      // No ATS API was ever called.
      expect(
        calledUrls().filter(
          (u) =>
            u.includes("greenhouse.io") ||
            u.includes("lever.co") ||
            u.includes("ashbyhq.com") ||
            u.includes("workable.com"),
        ),
      ).toEqual([]);
    });
  });

  describe("Stagehand last resort (tier 4)", () => {
    it("falls through to the browser when extracted content is thin", async () => {
      routeFetches({
        "https://acme.com/careers": res("<html>Loading...</html>", {
          url: "https://acme.com/careers",
        }),
      });
      webExtractMock.mockResolvedValue({
        success: true,
        url: "https://acme.com/careers",
        source: "fetch",
        data: { title: "", description: "", content: "Loading..." },
        extractionTime: 5,
      });
      stagehandObserveMock.mockResolvedValue([{ selector: "a" }]);
      stagehandExtractMock.mockResolvedValue([
        { title: "Browser-Only Role", location: "Remote" },
      ]);

      const out = await scrapeHiringData("org-1", "acme.com");

      expect(stagehandInitMock).toHaveBeenCalled();
      expect(out.jobs.map((j) => j.title)).toEqual(["Browser-Only Role"]);
    });

    it("falls through to the browser when no careers URL is found at all", async () => {
      routeFetches({
        "https://acme.com": res('<html><a href="/pricing">Pricing</a></html>', {
          url: "https://acme.com",
        }),
      });
      stagehandObserveMock.mockResolvedValue([{ selector: "a" }]);
      stagehandExtractMock.mockResolvedValue([{ title: "Hidden Role" }]);

      const out = await scrapeHiringData("org-1", "acme.com");

      expect(stagehandInitMock).toHaveBeenCalled();
      expect(out.jobs.map((j) => j.title)).toEqual(["Hidden Role"]);
      expect(out.careersUrl).toBe("https://acme.com/careers");
    });
  });
});
