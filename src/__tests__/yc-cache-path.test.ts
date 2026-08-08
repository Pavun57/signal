import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * searchYCCompanies' cache short-circuit. The cache stores only batch and
 * industry, so it can only answer requests shaped that way: the old path
 * matched every cached batch row regardless of region/teamSize/isHiring/query,
 * auto-linked the non-matching companies to the campaign, and a single cached
 * row suppressed the scrape for a 30-company request.
 */

let cachedRows: Array<Record<string, unknown>> = [];

function chain(table: string) {
  const c: Record<string, unknown> & PromiseLike<unknown> = {
    select: () => c,
    eq: () => c,
    ilike: () => c,
    limit: () => c,
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({
        data: table === "organizations" ? cachedRows : [],
        error: null,
      }).then(onF, onR),
  } as unknown as Record<string, unknown> & PromiseLike<unknown>;
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: (t: string) => chain(t) })),
}));

const scrapeYCCompanies = vi.fn();
vi.mock("@/lib/services/yc-scraper", () => ({
  scrapeYCCompanies: (...args: unknown[]) =>
    (scrapeYCCompanies as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { searchYCCompanies } from "@/lib/tools/search-tools";

const org = (id: string): Record<string, unknown> => ({
  id,
  name: `Co ${id}`,
  domain: `${id}.com`,
  url: `https://${id}.com`,
  industry: "fintech",
  location: "SF",
  description: null,
  source: "yc_directory",
  enrichment_data: { yc: { batch: "W25" } },
});

const run = (input: Record<string, unknown>) =>
  (
    searchYCCompanies as unknown as {
      execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }
  ).execute({ maxResults: 2, ...input });

beforeEach(() => {
  cachedRows = [];
  scrapeYCCompanies.mockReset().mockResolvedValue({
    companies: [],
    totalFound: 0,
  });
});

describe("searchYCCompanies cache", () => {
  it("scrapes when the request carries filters the cache cannot answer", async () => {
    cachedRows = [org("a"), org("b")];

    await run({ batch: "W25", region: "Europe" });

    expect(scrapeYCCompanies).toHaveBeenCalledTimes(1);
  });

  it("scrapes when the cache holds fewer rows than requested", async () => {
    // One cached row used to suppress the scrape entirely: a request for 30
    // companies returned 1 with no indication more exist.
    cachedRows = [org("a")];

    await run({ batch: "W25" });

    expect(scrapeYCCompanies).toHaveBeenCalledTimes(1);
  });

  it("serves a full cacheable request from cache without scraping", async () => {
    cachedRows = [org("a"), org("b")];

    const result = await run({ batch: "W25" });

    expect(scrapeYCCompanies).not.toHaveBeenCalled();
    expect(result.source).toBe("cache");
  });
});
