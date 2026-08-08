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

describe("reconcileClaims and the shape of the scrape", () => {
  it("does not contradict when the scrape never found a careers page", () => {
    // tryScrapeHiringData returns { careersUrl: null, jobs: [] } when no
    // careers link exists. That is an absence of evidence: treating it as
    // ground truth marked every true hiring claim contradicted for any
    // company without a discoverable careers page, and the UI then said
    // "The live careers page says otherwise" about a page never read.
    const out = reconcileClaims(
      [claim({ type: "hiring_role", statement: "Hiring a Growth Director" })],
      {
        now: NOW,
        careers: { careersUrl: null, jobs: [], scrapedAt: NOW.toISOString() },
      },
    );
    expect(out[0].status).toBe("unverified");
  });

  it("does not contradict when a real page yielded zero jobs", () => {
    // Stagehand can extract nothing from a JS-heavy page. Zero scraped jobs
    // cannot distinguish "not hiring" from "could not read the page", so it
    // must not overrule dated news claims.
    const out = reconcileClaims(
      [claim({ type: "hiring_role", statement: "Hiring a Growth Director" })],
      {
        now: NOW,
        careers: {
          careersUrl: "https://fyxer.com/careers",
          jobs: [],
          scrapedAt: NOW.toISOString(),
        },
      },
    );
    expect(out[0].status).toBe("unverified");
  });

  it("matches a decorated job title", () => {
    // The docstring's own example used to fail: neither string contains the
    // other once both carry extra text.
    const out = reconcileClaims(
      [claim({ type: "hiring_role", statement: "Hiring: Growth Director" })],
      {
        now: NOW,
        careers: {
          careersUrl: "https://fyxer.com/careers",
          jobs: [{ title: "Growth Director (Remote)" }],
          scrapedAt: NOW.toISOString(),
        },
      },
    );
    expect(out[0].status).toBe("verified");
  });

  it("matches a sentence-form claim against a decorated title", () => {
    const out = reconcileClaims(
      [
        claim({
          type: "hiring_role",
          statement: "Fyxer is hiring a Head of Growth",
        }),
      ],
      {
        now: NOW,
        careers: {
          careersUrl: "https://fyxer.com/careers",
          jobs: [{ title: "Head of Growth (Remote)" }],
          scrapedAt: NOW.toISOString(),
        },
      },
    );
    expect(out[0].status).toBe("verified");
  });
});
