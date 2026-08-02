import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The org chart is the default view and fetches on mount. The review queue
// lives in the flat list, so stub the chart out rather than pulling its whole
// data path into a rendering test.
vi.mock("@/components/company/embedded-org-chart", () => ({
  EmbeddedOrgChart: () => null,
}));

// Only reached by the inline email editor, which this test never opens.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({ update: () => ({ eq: () => ({}) }) }),
  }),
}));

vi.mock("@/lib/api-fetch", () => ({ apiFetch: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { apiFetch } from "@/lib/api-fetch";
import { CompaniesList } from "@/components/campaign/companies-list";
import type { CampaignCompany, CampaignContact } from "@/lib/types/campaign";

const company: CampaignCompany = {
  id: "cc1",
  organization_id: "11111111-1111-1111-1111-111111111111",
  campaign_id: "cam1",
  name: "Browserbase",
  domain: "browserbase.com",
  url: null,
  industry: null,
  location: null,
  description: null,
  relevance_score: null,
  score_reason: null,
  status: "discovered",
  readiness_tag: null,
  enrichment_data: { enrichedAt: "2026-08-01T00:00:00Z" },
  source: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

function contact(partial: Partial<CampaignContact>): CampaignContact {
  return {
    id: "p1",
    person_id: "p1",
    campaign_id: "cam1",
    organization_id: company.organization_id,
    name: "Paul Klein",
    title: "CEO",
    department: null,
    seniority: null,
    role_summary: null,
    bio_summary: null,
    work_email: "paul@browserbase.com",
    personal_email: null,
    work_email_verified_at: null,
    personal_email_verified_at: null,
    work_email_source: null,
    work_email_verification: null,
    work_email_confidence: null,
    affiliation_source: "llm_verified",
    affiliation_confidence: 0.6,
    affiliation_evidence: null,
    linkedin_url: null,
    twitter_url: null,
    enrichment_status: "enriched",
    enrichment_data: {},
    outreach_status: "not_contacted",
    priority_score: null,
    score_reason: null,
    readiness_tag: null,
    source: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    company: null,
    ...partial,
  };
}

function renderList(contacts: CampaignContact[]) {
  return render(
    <CompaniesList
      campaignId="22222222-2222-2222-2222-222222222222"
      companies={[company]}
      contacts={contacts}
      onContactEnriched={vi.fn()}
      onCompanyEnriched={vi.fn()}
      onDataChanged={vi.fn()}
    />,
  );
}

/** Expand the company and switch it from the org chart to the flat list. */
function openList(contacts: CampaignContact[]) {
  renderList(contacts);
  fireEvent.click(screen.getByLabelText("Expand Browserbase"));
  fireEvent.click(screen.getByText("List"));
}

/** Row text in document order, so group membership is actually observable. */
function rowText() {
  return Array.from(document.querySelectorAll("tbody tr")).map(
    (tr) => tr.textContent ?? "",
  );
}

describe("<CompaniesList> review queue", () => {
  afterEach(cleanup);

  it("splits contacts into confirmed and needs review", () => {
    openList([
      contact({ id: "p1", person_id: "p1", name: "Paul Klein" }),
      contact({
        id: "p2",
        person_id: "p2",
        name: "Lindsay Gilson",
        affiliation_source: "team_page",
        affiliation_confidence: 0.9,
      }),
      contact({
        id: "p3",
        person_id: "p3",
        name: "Chris Sev",
        affiliation_source: "search_stamp",
        affiliation_confidence: 0.2,
        affiliation_evidence: "profile names Okta (saw: Okta, Jan 2024)",
      }),
    ]);

    expect(screen.getByText("Confirmed (2)")).toBeInTheDocument();
    expect(screen.getByText("Needs review (1)")).toBeInTheDocument();

    const rows = rowText();
    const confirmedAt = rows.findIndex((t) => t.includes("Confirmed (2)"));
    const reviewAt = rows.findIndex((t) => t.includes("Needs review (1)"));

    const paulAt = rows.findIndex((t) => t.includes("Paul Klein"));
    const lindsayAt = rows.findIndex((t) => t.includes("Lindsay Gilson"));
    const chrisAt = rows.findIndex((t) => t.includes("Chris Sev"));

    expect(paulAt).toBeGreaterThan(confirmedAt);
    expect(paulAt).toBeLessThan(reviewAt);
    expect(lindsayAt).toBeGreaterThan(confirmedAt);
    expect(lindsayAt).toBeLessThan(reviewAt);
    expect(chrisAt).toBeGreaterThan(reviewAt);
  });

  it("renders no header for an empty group", () => {
    openList([contact({}), contact({ id: "p2", person_id: "p2" })]);

    expect(screen.getByText("Confirmed (2)")).toBeInTheDocument();
    expect(screen.queryByText(/Needs review/)).not.toBeInTheDocument();
  });

  it("renders no confirmed header when everyone needs review", () => {
    openList([
      contact({
        affiliation_source: "search_stamp",
        affiliation_confidence: 0.2,
      }),
    ]);

    expect(screen.getByText("Needs review (1)")).toBeInTheDocument();
    expect(screen.queryByText(/Confirmed \(/)).not.toBeInTheDocument();
  });

  it("treats a missing confidence as needing review", () => {
    openList([
      contact({ affiliation_source: null, affiliation_confidence: null }),
    ]);

    expect(screen.getByText("Needs review (1)")).toBeInTheDocument();
  });

  it("badges only the unconfirmed contact and carries its evidence", () => {
    openList([
      contact({}),
      contact({
        id: "p3",
        person_id: "p3",
        name: "Chris Sev",
        affiliation_source: "search_stamp",
        affiliation_confidence: 0.2,
        affiliation_evidence: "profile names Okta (saw: Okta, Jan 2024)",
      }),
    ]);

    const badges = screen.getAllByText("unconfirmed employer");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAttribute(
      "title",
      expect.stringContaining("profile names Okta (saw: Okta, Jan 2024)"),
    );
  });

  it("offers confirm and remove only on needs-review rows", () => {
    openList([
      contact({}),
      contact({
        id: "p3",
        person_id: "p3",
        name: "Chris Sev",
        affiliation_source: "search_stamp",
        affiliation_confidence: 0.2,
      }),
    ]);

    expect(screen.getAllByText("Confirm employer")).toHaveLength(1);
    expect(screen.getAllByText("Not here")).toHaveLength(1);
    // The permanence of user_entered has to be legible before the click, not
    // after it: nothing outranks 1.0, so a mis-click is not recoverable.
    expect(screen.getByText("Confirm employer")).toHaveAttribute(
      "title",
      expect.stringContaining("cannot be undone"),
    );
  });
});

describe("<CompaniesList> bulk find emails", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("reports the contacts the route skipped as unconfirmed", async () => {
    // /api/find-email/bulk refuses to mint an address for anyone below the
    // affiliation threshold, so the count it returns is lower than the count on
    // the button. Without this line the user just sees the shortfall.
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ found: [{ personId: "p1" }], skipped: 3 }),
    } as unknown as Response);

    renderList([
      contact({ work_email: null }),
      contact({
        id: "p3",
        person_id: "p3",
        work_email: null,
        affiliation_confidence: 0.2,
      }),
    ]);

    fireEvent.click(screen.getByTitle(/Find emails for/));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Found 1 email. 3 skipped, not confirmed at this company.",
      ),
    );
  });

  it("leaves the skipped clause off when nothing was skipped", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ found: [], skipped: 0 }),
    } as unknown as Response);

    renderList([contact({ work_email: null })]);

    fireEvent.click(screen.getByTitle(/Find emails for/));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Found 0 emails."),
    );
  });
});

describe("<CompaniesList> review actions", () => {
  const unproven = () =>
    contact({
      id: "p3",
      person_id: "p3",
      name: "Chris Sev",
      affiliation_source: "search_stamp",
      affiliation_confidence: 0.2,
    });

  afterEach(() => {
    cleanup();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("confirms a contact and moves the row without waiting for a refetch", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);

    openList([unproven()]);
    fireEvent.click(screen.getByText("Confirm employer"));

    await waitFor(() =>
      expect(screen.getByText("Confirmed (1)")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Needs review/)).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/people/p3/to-company",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("drops a contact the user says is not here", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);

    openList([unproven()]);
    fireEvent.click(screen.getByText("Not here"));

    await waitFor(() =>
      expect(screen.queryByText("Chris Sev")).not.toBeInTheDocument(),
    );
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/people/p3/from-company?campaignId="),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("puts the row back when the request fails", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "database is on fire" }),
    } as unknown as Response);

    openList([unproven()]);
    fireEvent.click(screen.getByText("Not here"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("database is on fire"),
    );
    expect(screen.getByText("Chris Sev")).toBeInTheDocument();
  });
});
