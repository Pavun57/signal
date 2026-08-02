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
  /** Which company a detach was about. Null means no detach on record. */
  affiliation_detached_from: string | null;
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
      affiliation_detached_from: null,
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
      detachedFrom: "org-a",
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
      detachedFrom: "org-a",
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
      detachedFrom: "org-a",
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
      detachedFrom: "org-a",
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
      detachedFrom: "org-a",
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
      detachedFrom: "org-a",
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
      detachedFrom: "org-a",
      evidence: "profile names another employer",
    });

    expect(people[0].organization_id).toBe("org-a");
    expect(people[0].affiliation_source).toBe("team_page");
  });

  it("keeps a detached person from being re-filed by a weaker search", async () => {
    // Re-filing them under the company that just rejected them is the case the
    // stickiness was designed for, so the detach has to name that company:
    // without affiliation_detached_from this rule had no way to tell it apart
    // from attaching them to a company nobody has judged them against.
    seed({
      organization_id: null,
      affiliation_source: "employer_mismatch",
      affiliation_confidence: 0,
      affiliation_detached_from: "org-a",
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

// ─── Detaches are scoped to the company that was judged ───────────────────

describe("a detach is about one company", () => {
  it("does not detach someone filed under a company nobody judged", async () => {
    // The Carter Rabasa case, measured on the live pipeline. He genuinely works
    // at Box and is correctly stored there. A "find more people" run on
    // Browserbase pulls him back out of Exa's semantic search, the judge
    // correctly says rejected, and the write said "detach from wherever you
    // are", so being RIGHT about Browserbase deleted him from Box, for every
    // user on the instance, with no review queue to find him in.
    seed({
      organization_id: "org-box",
      affiliation_source: "llm_verified",
      affiliation_confidence: AFFILIATION_WEIGHT.llm_verified,
    });

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "employer_mismatch",
      detachedFrom: "org-browserbase",
      evidence: "profile names Box, not Browserbase",
    });

    expect(result.written).toBe(false);
    expect(result.notAtJudgedOrg).toBe(true);
    expect(people[0].organization_id).toBe("org-box");
    expect(people[0].affiliation_source).toBe("llm_verified");
  });

  it("detaches when the company judged is the one they are filed under", async () => {
    seed({
      organization_id: "org-a",
      affiliation_source: "search_stamp",
      affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
    });

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "employer_mismatch",
      detachedFrom: "org-a",
      evidence: "profile names Chronicle Labs",
    });

    expect(result.written).toBe(true);
    expect(people[0].organization_id).toBeNull();
    expect(people[0].affiliation_detached_from).toBe("org-a");
  });

  it("refuses a detach that does not say which company it is about", async () => {
    // "Detach from wherever you are" is not expressible. It is the bug.
    seed({
      organization_id: "org-a",
      affiliation_source: "search_stamp",
      affiliation_confidence: AFFILIATION_WEIGHT.search_stamp,
    });

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "employer_mismatch",
      evidence: "profile names Chronicle Labs",
    });

    expect(result.written).toBe(false);
    expect(people[0].organization_id).toBe("org-a");
  });

  it("does not touch a detached row when another company judges them", async () => {
    // Already detached from org-a, now rejected at org-b. There is nothing at
    // org-b to detach, and overwriting the row would replace the record of the
    // org they were actually rejected from.
    seed({
      organization_id: null,
      affiliation_source: "employer_mismatch",
      affiliation_confidence: 0,
      affiliation_detached_from: "org-a",
    });

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: null,
      source: "employer_mismatch",
      detachedFrom: "org-b",
      evidence: "profile names Chronicle Labs",
    });

    expect(result.written).toBe(false);
    expect(people[0].affiliation_detached_from).toBe("org-a");
  });
});

describe("a detached person can still be placed somewhere", () => {
  const detached = () =>
    seed({
      organization_id: null,
      affiliation_source: "employer_mismatch",
      affiliation_confidence: 0,
      affiliation_detached_from: "org-a",
    });

  it("attaches them to a different company on ordinary evidence", async () => {
    // A row at organization_id = null is attached nowhere, so putting them
    // somewhere is not a cross-org move and must not be measured against the
    // detaching weight. Before this, employer_mismatch (0.8) outranked
    // llm_verified (0.6) forever and email_domain (0.95) could not rescue them
    // either, because that source is only ever recorded for a person who
    // already has an organization. One correct rejection removed them from
    // every user's reach, permanently and invisibly.
    detached();

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-b",
      source: "llm_verified",
      evidence: "profile shows Chronicle Labs, Present",
    });

    expect(result.written).toBe(true);
    expect(people[0].organization_id).toBe("org-b");
    expect(people[0].affiliation_source).toBe("llm_verified");
  });

  it("clears the detach record once they are attached somewhere", async () => {
    // A stale value here would later apply the stickiness rule to a company
    // this person was never rejected from, and leave the row claiming a detach
    // that no longer describes it.
    detached();

    await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-b",
      source: "llm_verified",
      evidence: "profile shows Chronicle Labs, Present",
    });

    expect(people[0].affiliation_detached_from).toBeNull();
  });

  it("still refuses to re-file them under the company that rejected them", async () => {
    // The stickiness the original design wanted: they cannot be re-filed under
    // the same wrong company by evidence no stronger than what rejected them.
    detached();

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-a",
      source: "llm_verified",
      evidence: "headline looks right",
    });

    expect(result.written).toBe(false);
    expect(people[0].organization_id).toBeNull();
  });

  it("lets stronger evidence overrule the company that rejected them", async () => {
    // team_page (0.9) beats employer_mismatch (0.8): if the company itself
    // lists them, a scraped profile snapshot does not get to argue.
    detached();

    const result = await recordAffiliation(client(), {
      personId: "p1",
      organizationId: "org-a",
      source: "team_page",
      evidence: "listed on acme.com/team",
    });

    expect(result.written).toBe(true);
    expect(people[0].organization_id).toBe("org-a");
    expect(people[0].affiliation_detached_from).toBeNull();
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
