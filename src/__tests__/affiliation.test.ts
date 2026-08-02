import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AFFILIATION_WEIGHT,
  canDraftFor,
  canSendTo,
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
/**
 * What the update leg comes back with. The real column carries a CHECK
 * constraint, so a rejected write is an ordinary runtime outcome rather than an
 * exotic one, and it has to be visible to the caller.
 */
let updateError: { message: string } | null = null;

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
          if (updateError) {
            return Promise.resolve({ data: null, error: updateError }).then(
              onF,
              onR,
            );
          }
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

beforeEach(() => {
  seed();
  updateError = null;
});

// ─── recordAffiliation ────────────────────────────────────────────────────

describe("recordAffiliation reports what it did", () => {
  it("says it wrote when it wrote", async () => {
    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-a",
      source: "team_page",
      evidence: "listed on acme.com/team",
    });

    expect(result).toEqual({ written: true });
  });

  it("says it refused, and why, when the guard blocks the write", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "email_domain",
      affiliation_confidence: AFFILIATION_WEIGHT.email_domain,
    });

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-a",
      source: "llm_verified",
      evidence: "an LLM read the headline",
    });

    expect(result.written).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("says it refused a detach the stored evidence outranks", async () => {
    // The team-page case: 0.9 on file, a 0.8 former_employee verdict cannot
    // move it. The caller has to know, because it was about to report this
    // person as departed while they stay attached and sendable.
    seed({
      organization_id: "org-a",
      affiliation_source: "team_page",
      affiliation_confidence: AFFILIATION_WEIGHT.team_page,
    });

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "former_employee",
      evidence: "role ended Mar 2026",
    });

    expect(result.written).toBe(false);
    expect(people[0].organization_id).toBe("org-a");
  });

  it("surfaces a database failure instead of swallowing it", async () => {
    // Exactly how the CHECK constraint on affiliation_source went unnoticed for
    // a whole branch: the update error was never read.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    updateError = {
      message:
        'new row for relation "people" violates check constraint "people_affiliation_source_check"',
    };

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-a",
      source: "team_page",
      evidence: "listed on acme.com/team",
    });

    expect(result.written).toBe(false);
    expect(result.reason).toContain("check constraint");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("says it refused when the person does not exist", async () => {
    people = [];

    const result = await recordAffiliation(client(), {
      personId: "ghost",
      organizationId: "org-a",
      source: "user_entered",
      evidence: "assigned by the user",
    });

    expect(result).toEqual({ written: false, reason: "person_not_found" });
  });
});

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

  it("refuses an equal-weight move to a different company", async () => {
    // The legacy corpus is all organization_id-set + source-NULL, which scores
    // as search_stamp (0.2). A `rejected`/`uncertain` verdict is also 0.2, so
    // when cross-org moves only required >=, one Haiku call could reassign or
    // orphan any pre-existing contact — and `people` is shared across users on
    // an instance, so one person's search corrupted someone else's list.
    seed({ organization_id: "org-a" }); // legacy: no recorded source

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-b",
      source: "search_stamp",
      evidence: "showed up in a search for org-b",
    });

    expect(people[0].organization_id).toBe("org-a");
  });

  it("refuses to detach a legacy row on equal-weight evidence", async () => {
    seed({ organization_id: "org-a" });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "search_stamp",
      evidence: "rejected by the judge",
    });

    expect(people[0].organization_id).toBe("org-a");
  });

  it("does not ping-pong someone between two equally-confident verdicts", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "llm_verified",
      affiliation_confidence: AFFILIATION_WEIGHT.llm_verified,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-b",
      source: "llm_verified",
      evidence: "also looks like org-b",
    });

    expect(people[0].organization_id).toBe("org-a");
  });

  it("detaches someone when strictly stronger evidence points elsewhere", async () => {
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

// ─── Detaching sources ────────────────────────────────────────────────────

describe("detaching sources", () => {
  it("detaches someone whose profile names a different employer", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "search_stamp",
      affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "employer_mismatch",
      evidence: "profile shows Chronicle Labs, Jan 2024 to Present",
    });

    expect(people[0].organization_id).toBeNull();
    expect(people[0].affiliation_source).toBe("employer_mismatch");
  });

  it("detaches someone the evidence says has left", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "llm_verified",
      affiliation_confidence: AFFILIATION_WEIGHT.llm_verified,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "former_employee",
      evidence: "profile shows Browserbase, Oct 2024 to Mar 2026",
    });

    expect(people[0].organization_id).toBeNull();
    expect(people[0].affiliation_source).toBe("former_employee");
  });

  it("writes zero confidence for a detached person", async () => {
    // The column means "confidence they work at organization_id". With no org
    // there is nothing for it to be about, and any non-zero value would clear
    // AFFILIATION_SEND_THRESHOLD on a row nobody can vouch for.
    seed({
      organization_id: "org-a",
      affiliation_source: "search_stamp",
      affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "employer_mismatch",
      evidence: "profile names another employer",
    });

    expect(people[0].affiliation_confidence).toBe(0);
  });

  it("does not detach someone the company itself lists", async () => {
    // A stale snapshot must not overrule the company's own team page.
    seed({
      organization_id: "org-a",
      affiliation_source: "team_page",
      affiliation_confidence: AFFILIATION_WEIGHT.team_page,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "employer_mismatch",
      evidence: "profile names another employer",
    });

    expect(people[0].organization_id).toBe("org-a");
    expect(people[0].affiliation_source).toBe("team_page");
  });

  it("keeps a detached person from being re-filed by a weaker search", async () => {
    seed({
      organization_id: null,
      affiliation_source: "employer_mismatch",
      affiliation_confidence: 0,
    });

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-a",
      source: "llm_verified",
      evidence: "headline looks right",
    });

    expect(people[0].organization_id).toBeNull();
  });
});

// ─── Send gate ────────────────────────────────────────────────────────────

describe("send gate: employer required", () => {
  const sendable = {
    work_email: "a@acme.com",
    personal_email: null,
    work_email_source: "user_entered",
    work_email_verification: "deliverable",
    affiliation_confidence: 0.9,
    affiliation_source: "team_page",
    organization_id: "org-a",
  };

  it("blocks a contact with no employer on file", () => {
    // A detached row is a person we could not place anywhere. Confidence says
    // nothing about who they work for once organization_id is null, so the
    // numeric threshold alone is not a sufficient gate.
    const check = canSendTo({ ...sendable, organization_id: null });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(
      /not linked to a company/i,
    );
  });

  it("blocks drafting for a contact with no employer on file", () => {
    expect(canDraftFor({ ...sendable, organization_id: null }).ok).toBe(false);
  });

  it("still allows a contact who has an employer", () => {
    expect(canSendTo(sendable).ok).toBe(true);
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
