import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * filterContactsByCompany is what decides whether a search result becomes an
 * employee, a flagged maybe, or someone filed elsewhere — and it had no tests.
 *
 * The three behaviours the "a verdict for every candidate" guarantee rests on
 * are all failure-path behaviours, which is exactly why they went unnoticed:
 * hallucinated indices from the model, candidates the model simply omits, and
 * the model being unavailable at all.
 */

const generateObjectMock = vi.fn();
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: () => "model" }));
// llmTimeout() returns AbortSignal.timeout(...), whose pending timer outlives a
// test that throws before the SDK consumes the signal — vitest then attributes
// the abort to the test and fails it. The timeout is not what is under test.
vi.mock("@/lib/utils/timeout", () => ({ llmTimeout: () => undefined }));
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  estimateClaudeCostFromUsage: () => 0,
}));
vi.mock("@/lib/services/web-extraction-service", () => ({
  WebExtractionService: class {},
}));

import {
  filterContactsByCompany,
  type CandidateContact,
  type CompanyContext,
} from "@/lib/services/contact-filter";

const company: CompanyContext = {
  name: "Browserbase",
  domain: "browserbase.com",
  industry: "developer tools",
  location: "SF",
  description: null,
};

const candidates: CandidateContact[] = [
  {
    name: "Ann A",
    title: "Engineer",
    linkedinUrl: "https://www.linkedin.com/in/a",
    rawHeadline: "Ann A - Browserbase",
  },
  {
    name: "Bob B",
    title: "Engineer",
    linkedinUrl: "https://www.linkedin.com/in/b",
    rawHeadline: "Bob B - Wafer",
  },
  {
    name: "Cal C",
    title: "Engineer",
    linkedinUrl: "https://www.linkedin.com/in/c",
    rawHeadline: "Cal C",
  },
];

function reply(judged: unknown[]) {
  generateObjectMock.mockResolvedValue({
    object: { judged },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

beforeEach(() => generateObjectMock.mockReset());

describe("filterContactsByCompany", () => {
  it("returns a verdict for every candidate", async () => {
    reply([
      {
        index: 0,
        name: "Ann A",
        title: "Eng",
        verdict: "verified",
        evidence: "names it",
      },
      {
        index: 1,
        name: "Bob B",
        title: "Eng",
        verdict: "rejected",
        evidence: "Wafer",
      },
      {
        index: 2,
        name: "Cal C",
        title: "Eng",
        verdict: "uncertain",
        evidence: "no employer",
      },
    ]);

    const out = await filterContactsByCompany(company, candidates);

    expect(out).toHaveLength(3);
    expect(out.map((v) => v.verdict).sort()).toEqual([
      "rejected",
      "uncertain",
      "verified",
    ]);
  });

  it("judges candidates whose headline never names the employer", async () => {
    // The old hard pre-filter dropped these before the model saw them, which
    // discarded 22 of 41 real contacts at one company on the dev database.
    reply([
      {
        index: 2,
        name: "Cal C",
        title: "Eng",
        verdict: "verified",
        evidence: "confirmed",
      },
    ]);

    await filterContactsByCompany(company, candidates);

    const prompt = generateObjectMock.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Cal C");
    // and the headline match is passed as a hint, not used as a gate
    expect(prompt).toMatch(/headline names the target company/i);
  });

  it("backfills a verdict for candidates the model omitted", async () => {
    reply([
      {
        index: 0,
        name: "Ann A",
        title: "Eng",
        verdict: "verified",
        evidence: "x",
      },
    ]);

    const out = await filterContactsByCompany(company, candidates);

    expect(out).toHaveLength(3);
    const missing = out.filter((v) => v.index !== 0);
    expect(missing.every((v) => v.verdict === "uncertain")).toBe(true);
  });

  it("drops hallucinated indices instead of throwing", async () => {
    reply([
      {
        index: 99,
        name: "Ghost",
        title: null,
        verdict: "verified",
        evidence: "x",
      },
      {
        index: 0,
        name: "Ann A",
        title: "Eng",
        verdict: "verified",
        evidence: "y",
      },
    ]);

    const out = await filterContactsByCompany(company, candidates);

    expect(out.some((v) => v.name === "Ghost")).toBe(false);
    expect(out).toHaveLength(3); // the other two backfilled as uncertain
  });

  it("ignores a repeated index rather than double-counting", async () => {
    reply([
      {
        index: 0,
        name: "Ann A",
        title: "Eng",
        verdict: "verified",
        evidence: "x",
      },
      {
        index: 0,
        name: "Ann Again",
        title: "Eng",
        verdict: "rejected",
        evidence: "y",
      },
    ]);

    const out = await filterContactsByCompany(company, candidates);

    expect(out.filter((v) => v.index === 0)).toHaveLength(1);
    expect(out.find((v) => v.index === 0)?.verdict).toBe("verified");
  });

  it("returns everything as uncertain when the model is unavailable", async () => {
    // The previous fallback discarded every candidate, turning a transient
    // outage into silent data loss.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    // A malformed response rather than a thrown mock: it exercises the same
    // catch, and vitest attributes an error thrown *by a mock* to the test
    // itself, failing the run even when the code under test handles it.
    generateObjectMock.mockResolvedValue({ object: null, usage: {} });

    const out = await filterContactsByCompany(company, candidates);

    expect(out).toHaveLength(3);
    expect(out.every((v) => v.verdict === "uncertain")).toBe(true);
    expect(out.map((v) => v.index).sort()).toEqual([0, 1, 2]);
    quiet.mockRestore();
  });

  it("short-circuits on an empty candidate list without calling the model", async () => {
    const out = await filterContactsByCompany(company, []);

    expect(out).toEqual([]);
    expect(generateObjectMock).not.toHaveBeenCalled();
  });
});
