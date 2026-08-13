import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  estimateLlmCostFromUsage: () => 0,
}));

import { extractClaims } from "@/lib/services/claim-extractor";

const searches = [
  {
    category: "funding",
    query: '"Fyxer" fyxer.com funding news announcement',
    results: [
      {
        title: "Fyxer raises $30M Series B",
        url: "https://news.example.com/fyxer-series-b",
        publishedDate: "2026-02-11",
        text: "Fyxer AI closed a $30 million Series B led by Madrona...",
      },
    ],
  },
];

describe("extractClaims", () => {
  // Braces matter: mockReset() returns the mock (a function), and a function
  // returned from beforeEach is treated by Vitest as a teardown callback. That
  // teardown call would re-invoke the rejecting mock and leak an unhandled
  // rejection into the fail-open test.
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it("returns typed claims from the LLM with provenance attached", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        claims: [
          {
            type: "funding_round",
            statement: "Raised a $30M Series B led by Madrona",
            sourceIndex: 0,
            publishedDate: "2026-02-11",
            confidence: 0.9,
          },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const out = await extractClaims({
      companyName: "Fyxer",
      companyDomain: "fyxer.com",
      websiteContent: null,
      searches,
    });

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("funding_round");
    expect(out[0].sourceUrl).toBe("https://news.example.com/fyxer-series-b");
    expect(out[0].status).toBe("unverified");
    expect(out[0].extractedAt).toBeTruthy();
  });

  it("fails open to an empty list when the LLM call throws", async () => {
    generateObjectMock.mockRejectedValue(new Error("overloaded"));
    const out = await extractClaims({
      companyName: "Fyxer",
      companyDomain: "fyxer.com",
      websiteContent: null,
      searches,
    });
    expect(out).toEqual([]);
  });

  it("drops claims whose sourceIndex is out of range", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        claims: [
          {
            type: "product",
            statement: "hallucinated",
            sourceIndex: 99,
            publishedDate: null,
            confidence: 0.9,
          },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const out = await extractClaims({
      companyName: "Fyxer",
      companyDomain: "fyxer.com",
      websiteContent: null,
      searches,
    });
    expect(out).toEqual([]);
  });
});
