import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyDetail } from "@/components/campaign/company-detail";
import type {
  CampaignCompany,
  CompanyEnrichmentData,
} from "@/lib/types/campaign";
import type { CompanyClaim } from "@/lib/types/claims";

function claim(partial: Partial<CompanyClaim>): CompanyClaim {
  return {
    type: "product",
    statement: "x",
    sourceUrl: "https://example.com/article",
    publishedDate: null,
    confidence: 0.8,
    extractedAt: "2026-08-01T00:00:00Z",
    status: "unverified",
    ...partial,
  };
}

function company(enrichment: CompanyEnrichmentData): CampaignCompany {
  return {
    id: "c1",
    organization_id: "o1",
    campaign_id: "cam1",
    name: "Fyxer",
    domain: "fyxer.com",
    url: null,
    industry: null,
    location: null,
    description: null,
    relevance_score: null,
    score_reason: null,
    status: "discovered",
    readiness_tag: null,
    enrichment_data: enrichment,
    source: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

describe("<CompanyDetail> claims section", () => {
  afterEach(cleanup);

  it("renders claims with status badges, dates, and source hosts", () => {
    render(
      <CompanyDetail
        company={company({
          enrichedAt: "2026-08-01T00:00:00Z",
          claims: [
            claim({
              type: "funding_round",
              statement: "Raised a $30M Series B led by Madrona",
              sourceUrl: "https://www.news.example.com/fyxer-series-b",
              publishedDate: "2026-02-11",
              status: "verified",
            }),
            claim({
              type: "funding_round",
              statement: "Raised a $10M Series A",
              publishedDate: "2024-11-01",
              status: "superseded",
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("Claims (2)")).toBeInTheDocument();
    expect(
      screen.getByText("Raised a $30M Series B led by Madrona"),
    ).toBeInTheDocument();
    expect(screen.getByText("verified")).toBeInTheDocument();
    expect(screen.getByText("Feb 2026")).toBeInTheDocument();
    expect(screen.getByText("news.example.com")).toBeInTheDocument();

    // Superseded claims stay visible but struck through.
    expect(screen.getByText("Raised a $10M Series A")).toHaveClass(
      "line-through",
    );
    expect(screen.getByText("superseded")).toBeInTheDocument();
  });

  it("omits the claims section when there are no claims", () => {
    render(
      <CompanyDetail
        company={company({ enrichedAt: "2026-08-01T00:00:00Z" })}
      />,
    );
    expect(screen.queryByText(/^Claims \(/)).not.toBeInTheDocument();
  });

  it("shows a compact published date on search results", () => {
    render(
      <CompanyDetail
        company={company({
          enrichedAt: "2026-08-01T00:00:00Z",
          searches: [
            {
              category: "funding",
              query: "Fyxer funding",
              results: [
                {
                  title: "Fyxer raises $30M Series B",
                  url: "https://news.example.com/fyxer-series-b",
                  publishedDate: "2026-02-11",
                  text: "Fyxer AI closed a $30 million Series B.",
                },
              ],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Fyxer raises $30M Series B")).toBeInTheDocument();
    expect(screen.getByText("Feb 2026")).toBeInTheDocument();
  });
});
