import { describe, expect, it } from "vitest";
import { reconcileClaims } from "@/lib/services/claim-reconciler";
import type { CompanyClaim, CareersScrape } from "@/lib/types/claims";

const NOW = new Date("2026-08-01T12:00:00Z");

function claim(partial: Partial<CompanyClaim>): CompanyClaim {
  return {
    type: "product",
    statement: "x",
    sourceUrl: "https://example.com",
    publishedDate: null,
    confidence: 0.8,
    extractedAt: NOW.toISOString(),
    status: "unverified",
    ...partial,
  };
}

const fyxerCareers: CareersScrape = {
  careersUrl: "https://fyxer.com/careers",
  jobs: [{ title: "Senior Customer Support Specialist", location: "Austin" }],
  scrapedAt: NOW.toISOString(),
};

describe("reconcileClaims", () => {
  it("supersedes older funding claims with the newest dated one", () => {
    const out = reconcileClaims(
      [
        claim({
          type: "funding_round",
          statement: "Raised a $10M Series A",
          publishedDate: "2024-11-01",
        }),
        claim({
          type: "funding_round",
          statement: "Raised a $30M Series B led by Madrona",
          publishedDate: "2026-02-11",
        }),
        claim({
          type: "funding_round",
          statement: "Raised $500K",
          publishedDate: null,
        }),
      ],
      { now: NOW, careers: null },
    );
    expect(out.find((c) => c.statement.includes("Series B"))?.status).toBe(
      "verified",
    );
    expect(out.find((c) => c.statement.includes("Series A"))?.status).toBe(
      "superseded",
    );
    expect(out.find((c) => c.statement.includes("$500K"))?.status).toBe(
      "superseded",
    );
  });

  it("contradicts hiring claims not backed by the careers scrape", () => {
    const out = reconcileClaims(
      [
        claim({
          type: "hiring_role",
          statement: "Hiring a Growth Director",
          sourceUrl: "https://news-aggregator.example.com/fyxer",
        }),
      ],
      { now: NOW, careers: fyxerCareers },
    );
    expect(out[0].status).toBe("contradicted");
  });

  it("verifies hiring claims that match a scraped job title", () => {
    const out = reconcileClaims(
      [
        claim({
          type: "hiring_role",
          statement: "Hiring: Senior Customer Support Specialist",
        }),
      ],
      { now: NOW, careers: fyxerCareers },
    );
    expect(out[0].status).toBe("verified");
  });

  it("marks hiring claims stale without a scrape when older than 90 days", () => {
    const out = reconcileClaims(
      [
        claim({
          type: "hiring_role",
          statement: "Hiring a Growth Director",
          publishedDate: "2026-01-01",
        }),
      ],
      { now: NOW, careers: null },
    );
    expect(out[0].status).toBe("stale");
  });

  it("marks lone funding claims older than 12 months stale, not superseded", () => {
    const out = reconcileClaims(
      [
        claim({
          type: "funding_round",
          statement: "Raised a $10M Series A",
          publishedDate: "2024-11-01",
        }),
      ],
      { now: NOW, careers: null },
    );
    expect(out[0].status).toBe("stale");
  });

  it("leaves fresh, unconflicted claims unverified and untouched", () => {
    const out = reconcileClaims(
      [claim({ type: "product", statement: "AI email assistant" })],
      { now: NOW, careers: null },
    );
    expect(out[0].status).toBe("unverified");
  });
});
