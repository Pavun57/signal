import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AFFILIATION_WEIGHT,
  normalizeCompanyName,
  parseLinkedInEmployer,
  recordAffiliation,
} from "@/lib/services/affiliation";
import { normalizeLinkedInUrl } from "@/lib/services/knowledge-base";

// ─── Fake supabase ────────────────────────────────────────────────────────

interface PersonRow extends Record<string, unknown> {
  id: string;
  organization_id: string | null;
  affiliation_source: string | null;
  affiliation_confidence: number | null;
}

let people: PersonRow[] = [];

function client(): SupabaseClient {
  const chain = () => {
    let mode: "select" | "update" = "select";
    let updates: Record<string, unknown> = {};
    const preds: Array<(r: Record<string, unknown>) => boolean> = [];
    const c: Record<string, unknown> & PromiseLike<unknown> = {
      select: () => c,
      update: (v: Record<string, unknown>) => {
        mode = "update";
        updates = v;
        return c;
      },
      eq: (col: string, val: unknown) => {
        preds.push((r) => r[col] === val);
        return c;
      },
      maybeSingle: () => c,
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        const matches = people.filter((r) => preds.every((p) => p(r)));
        if (mode === "update") {
          for (const r of matches) Object.assign(r, updates);
          return Promise.resolve({ data: null, error: null }).then(onF, onR);
        }
        return Promise.resolve({ data: matches[0] ?? null, error: null }).then(
          onF,
          onR,
        );
      },
    } as unknown as Record<string, unknown> & PromiseLike<unknown>;
    return c;
  };
  return { from: () => chain() } as unknown as SupabaseClient;
}

function seed(over: Partial<PersonRow> = {}) {
  people = [
    {
      id: "p1",
      organization_id: null,
      affiliation_source: null,
      affiliation_confidence: null,
      ...over,
    },
  ];
}

beforeEach(() => seed());

// ─── recordAffiliation ────────────────────────────────────────────────────

describe("recordAffiliation", () => {
  it("records the source, confidence and evidence", async () => {
    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-a",
      source: "team_page",
      evidence: "listed on acme.com/team",
    });

    expect(people[0].organization_id).toBe("org-a");
    expect(people[0].affiliation_source).toBe("team_page");
    expect(people[0].affiliation_confidence).toBe(AFFILIATION_WEIGHT.team_page);
    expect(people[0].affiliation_evidence).toBe("listed on acme.com/team");
  });

  it("does not let a weaker signal overwrite a stronger one", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "email_domain",
      affiliation_confidence: AFFILIATION_WEIGHT.email_domain,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-a",
      source: "search_stamp",
      evidence: "appeared in a search",
    });

    expect(people[0].affiliation_source).toBe("email_domain");
  });

  it("lets stronger evidence move someone to a different employer", async () => {
    // The job-change / bad-stamp correction case. Before this, organization_id
    // was only ever written when null, so a wrong link was permanent.
    seed({
      organization_id: "org-a",
      affiliation_source: "search_stamp",
      affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-b",
      source: "linkedin_profile",
      evidence: "profile reads 'Wafer'",
    });

    expect(people[0].organization_id).toBe("org-b");
    expect(people[0].affiliation_source).toBe("linkedin_profile");
  });

  it("treats a legacy link with no recorded source as a bare search stamp", async () => {
    // Pre-migration rows: organization_id set, affiliation_source NULL. We know
    // nothing about how they got there, so they must not outrank real evidence.
    seed({ organization_id: "org-a" });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-b",
      source: "llm_verified",
      evidence: "headline names org-b",
    });

    expect(people[0].organization_id).toBe("org-b");
  });

  it("can detach someone when the evidence points nowhere", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "search_stamp",
      affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "linkedin_profile",
      evidence: "profile names a different employer",
    });

    expect(people[0].organization_id).toBeNull();
  });
});

// ─── LinkedIn parsing ─────────────────────────────────────────────────────

describe("parseLinkedInEmployer", () => {
  it("reads the employer out of the page title", () => {
    // The exact shape returned by a real fetch of these profiles.
    expect(
      parseLinkedInEmployer("Paul Klein IV - Browserbase | LinkedIn"),
    ).toBe("Browserbase");
    expect(parseLinkedInEmployer("Garrett Graves - Wafer | LinkedIn")).toBe(
      "Wafer",
    );
  });

  it("falls back to the og:description experience line", () => {
    expect(
      parseLinkedInEmployer(
        "Some Person | LinkedIn",
        "Full stack engineer… · Experience: Wafer · Location: San Francisco",
      ),
    ).toBe("Wafer");
  });

  it("returns null for the logged-out shell with no employer", () => {
    expect(parseLinkedInEmployer("LinkedIn")).toBeNull();
    expect(parseLinkedInEmployer(null)).toBeNull();
    expect(parseLinkedInEmployer("")).toBeNull();
  });
});

describe("normalizeCompanyName", () => {
  it("ignores legal suffixes and punctuation", () => {
    expect(normalizeCompanyName("Browserbase, Inc.")).toBe(
      normalizeCompanyName("Browserbase"),
    );
    expect(normalizeCompanyName("Acme Ltd")).toBe(normalizeCompanyName("Acme"));
  });

  it("keeps genuinely different names apart", () => {
    expect(normalizeCompanyName("Browserbase")).not.toBe(
      normalizeCompanyName("Wafer"),
    );
  });
});

// ─── URL canonicalisation ─────────────────────────────────────────────────

describe("normalizeLinkedInUrl", () => {
  it("collapses every host and trailing-slash variant to one string", () => {
    const canonical = "https://www.linkedin.com/in/adam-mcquilkin";
    for (const variant of [
      "https://linkedin.com/in/adam-mcquilkin",
      "https://www.linkedin.com/in/adam-mcquilkin",
      "http://linkedin.com/in/adam-mcquilkin",
      "https://www.linkedin.com/in/adam-mcquilkin/",
      "https://linkedin.com/in/adam-mcquilkin?utm_source=x",
    ]) {
      expect(normalizeLinkedInUrl(variant)).toBe(canonical);
    }
  });

  it("uses the www host, which is the only form that actually fetches", () => {
    // Measured: the apex form returns an empty body because the scrapers do not
    // follow linkedin.com's redirect to www.
    expect(normalizeLinkedInUrl("https://linkedin.com/in/x")).toContain(
      "www.linkedin.com",
    );
  });

  it("leaves non-LinkedIn hosts alone", () => {
    expect(normalizeLinkedInUrl("https://github.com/foo")).toBe(
      "https://github.com/foo",
    );
  });
});
