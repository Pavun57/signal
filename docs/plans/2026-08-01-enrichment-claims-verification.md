# Enrichment Claims + Verification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Company enrichment produces dated, sourced, reconciled claims; hiring facts come only from the live careers page; scores cite claims that survived reconciliation.

**Architecture:** A pure-function reconciler (`claim-reconciler.ts`) and a Haiku extraction service (`claim-extractor.ts`) slot into `enrichCompanyById` after the existing raw pulls. The Browserbase careers scraper (`scrapeHiringData`, already built) becomes a standard parallel pull. Claims live in `organizations.enrichment_data.claims` (jsonb, no migration), mirroring the contact affiliation-provenance pattern. Both enrichment paths (agent tool + `/api/enrich-company`) share the same core.

**Tech Stack:** Next.js App Router, AI SDK v6 (`generateObject`), Anthropic Haiku (`MODELS.LIGHT`), Stagehand/Browserbase, Supabase jsonb, Vitest.

**Design doc:** `/Users/jay/.claude/plans/2026-08-01-enrichment-claims-verification-design.md`

**Branch:** create `feat/enrichment-claims` off `origin/main` before Task 1. The user works on other branches concurrently; never commit unrelated working-tree files.

**House rules that will bite you:**

- No em dashes in any string/copy — eslint blocks them (`no-restricted-syntax`).
- All LLM calls follow the `src/lib/services/relevance-filter.ts` pattern exactly: `generateObject` + `llmTimeout()` abort signal + `trackUsage` + `UNTRUSTED_NOTICE`/`wrapUntrusted`/`stringify` from `@/lib/prompt-safety` + fail-open catch.
- Run `pnpm exec eslint <files>` and `pnpm typecheck` before every commit. (If typecheck fails on `.next/types` referencing deleted routes, `rm -rf .next/types` first — stale cache.)
- Test runner is Vitest: `pnpm vitest run <file>`.

---

### Task 1: Claim types + pure reconciler (TDD)

**Files:**

- Create: `src/lib/types/claims.ts`
- Create: `src/lib/services/claim-reconciler.ts`
- Test: `src/__tests__/claim-reconciler.test.ts`

**Step 1: Create the types file**

```ts
// src/lib/types/claims.ts
export const CLAIM_TYPES = [
  "funding_round",
  "headcount",
  "hiring_role",
  "exec_change",
  "product",
  "location",
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

export type ClaimStatus =
  | "verified"
  | "unverified"
  | "stale"
  | "contradicted"
  | "superseded";

export interface CompanyClaim {
  type: ClaimType;
  /** One factual sentence, e.g. "Raised a $30M Series B led by Madrona". */
  statement: string;
  sourceUrl: string;
  /** ISO date of the source when known; null when the source is undated. */
  publishedDate: string | null;
  /** 0-1, extractor's confidence the statement is about this company. */
  confidence: number;
  extractedAt: string;
  status: ClaimStatus;
}

export interface CareersScrape {
  careersUrl: string | null;
  jobs: Array<{ title: string; department?: string; location?: string }>;
  scrapedAt: string;
}
```

**Step 2: Write the failing tests.** The fixture is the real Fyxer failure.

```ts
// src/__tests__/claim-reconciler.test.ts
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
```

**Step 3: Run to verify failure.**
Run: `pnpm vitest run src/__tests__/claim-reconciler.test.ts`
Expected: FAIL, cannot resolve `@/lib/services/claim-reconciler`.

**Step 4: Implement the reconciler.**

```ts
// src/lib/services/claim-reconciler.ts
import type { CareersScrape, CompanyClaim } from "@/lib/types/claims";

const FUNDING_STALE_MS = 365 * 24 * 60 * 60 * 1000;
const HIRING_STALE_MS = 90 * 24 * 60 * 60 * 1000;

function ageMs(claim: CompanyClaim, now: Date): number | null {
  if (!claim.publishedDate) return null;
  const t = Date.parse(claim.publishedDate);
  return Number.isNaN(t) ? null : now.getTime() - t;
}

/** Case-insensitive containment either way, so "Hiring: Growth Director" matches "Growth Director (Remote)". */
function matchesScrapedJob(statement: string, careers: CareersScrape): boolean {
  const s = statement.toLowerCase();
  return careers.jobs.some((j) => {
    const t = j.title.toLowerCase();
    return s.includes(t) || t.includes(s);
  });
}

/**
 * Deterministic verification pass over extracted claims. Pure function so
 * the rules are unit-testable; no LLM, no IO. Rules, in order:
 *
 * 1. hiring_role with a careers scrape available: verified when a scraped
 *    job title matches, contradicted when none does. The live careers page
 *    is ground truth; news and aggregator text never outranks it.
 * 2. Same-type conflicts (funding_round, headcount): the newest dated claim
 *    wins (verified); every other claim of that type is superseded.
 * 3. Staleness: a surviving dated claim past its shelf life (12 months for
 *    funding, 90 days for hiring) is marked stale rather than asserted.
 */
export function reconcileClaims(
  claims: CompanyClaim[],
  opts: { now: Date; careers: CareersScrape | null },
): CompanyClaim[] {
  const out = claims.map((c) => ({ ...c }));

  for (const c of out) {
    if (c.type !== "hiring_role") continue;
    if (opts.careers) {
      c.status = matchesScrapedJob(c.statement, opts.careers)
        ? "verified"
        : "contradicted";
    } else {
      const age = ageMs(c, opts.now);
      if (age !== null && age > HIRING_STALE_MS) c.status = "stale";
    }
  }

  for (const type of ["funding_round", "headcount"] as const) {
    const group = out.filter((c) => c.type === type);
    if (group.length > 1) {
      const dated = group
        .filter((c) => ageMs(c, opts.now) !== null)
        .sort((a, b) => ageMs(a, opts.now)! - ageMs(b, opts.now)!);
      if (dated.length > 0) {
        const winner = dated[0];
        for (const c of group) {
          c.status = c === winner ? "verified" : "superseded";
        }
      }
    }
    for (const c of group) {
      if (c.status === "superseded" || c.status === "contradicted") continue;
      const age = ageMs(c, opts.now);
      if (type === "funding_round" && age !== null && age > FUNDING_STALE_MS) {
        c.status = "stale";
      }
    }
  }

  return out;
}
```

**Step 5: Run to verify pass.**
Run: `pnpm vitest run src/__tests__/claim-reconciler.test.ts`
Expected: 6 passed.

**Step 6: Lint, typecheck, commit.**

```bash
pnpm exec eslint src/lib/types/claims.ts src/lib/services/claim-reconciler.ts src/__tests__/claim-reconciler.test.ts
pnpm typecheck
git add src/lib/types/claims.ts src/lib/services/claim-reconciler.ts src/__tests__/claim-reconciler.test.ts
git commit -m "feat(claims): typed company claims and deterministic reconciler"
```

Note: the design mentions a Haiku judge for date-less conflicting claims. Deliberately NOT built now (YAGNI): rule 2 already handles the observed failure, and the judge only matters if the eval harness later shows date-less conflicts are common.

---

### Task 2: Claim extractor service (TDD, mocked LLM)

**Files:**

- Create: `src/lib/services/claim-extractor.ts`
- Test: `src/__tests__/claim-extractor.test.ts`

Mirror `src/lib/services/relevance-filter.ts` exactly (imports, timeout, trackUsage, prompt-safety wrappers, fail-open catch). Read that file first.

**Step 1: Write the failing test.**

```ts
// src/__tests__/claim-extractor.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));
vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  estimateClaudeCostFromUsage: () => 0,
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
  beforeEach(() => generateObjectMock.mockReset());

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
```

**Step 2: Run to verify failure.** `pnpm vitest run src/__tests__/claim-extractor.test.ts` → FAIL (module missing).

**Step 3: Implement.**

```ts
// src/lib/services/claim-extractor.ts
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { llmTimeout } from "@/lib/utils/timeout";
import { MODELS } from "@/lib/ai/models";
import {
  estimateClaudeCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import {
  UNTRUSTED_NOTICE,
  stringify,
  wrapUntrusted,
} from "@/lib/prompt-safety";
import { CLAIM_TYPES, type CompanyClaim } from "@/lib/types/claims";

interface EnrichmentSearch {
  category: string;
  query: string;
  results: Array<{
    title: string;
    url: string;
    publishedDate: string | null;
    text: string | null;
  }>;
}

interface ExtractInput {
  companyName: string;
  companyDomain: string | null;
  websiteContent: string | null;
  searches: EnrichmentSearch[];
}

/**
 * One Haiku pass over the raw enrichment pulls that emits typed, sourced
 * claims. The model references sources by index; the code resolves the
 * index back to the URL so a claim can never cite a URL the pull did not
 * contain. Fails open to [] so enrichment still stores raw data when the
 * extractor is down.
 */
export async function extractClaims(
  input: ExtractInput,
): Promise<CompanyClaim[]> {
  const sources: Array<{ url: string; publishedDate: string | null }> = [];
  const sourceBlocks: string[] = [];

  if (input.websiteContent && input.companyDomain) {
    sources.push({
      url: `https://${input.companyDomain}`,
      publishedDate: null,
    });
    sourceBlocks.push(
      `[0] Company website (${input.companyDomain}):\n${input.websiteContent.slice(0, 1500)}`,
    );
  }
  for (const search of input.searches) {
    for (const r of search.results) {
      const i = sources.length;
      sources.push({ url: r.url, publishedDate: r.publishedDate });
      sourceBlocks.push(
        `[${i}] (${search.category}) "${r.title}" ${r.url}${r.publishedDate ? ` published ${r.publishedDate}` : " (undated)"}\n${r.text?.slice(0, 1200) ?? ""}`,
      );
    }
  }
  if (sources.length === 0) return [];

  try {
    const { object, usage } = await generateObject({
      abortSignal: llmTimeout(),
      model: anthropic(MODELS.LIGHT),
      schema: z.object({
        claims: z.array(
          z.object({
            type: z.enum(CLAIM_TYPES),
            statement: z
              .string()
              .describe("One factual sentence about the company"),
            sourceIndex: z
              .number()
              .int()
              .describe("Index of the source block the claim comes from"),
            publishedDate: z
              .string()
              .nullable()
              .describe("Date of the underlying fact if the source states one"),
            confidence: z.number().min(0).max(1),
          }),
        ),
      }),
      prompt: `You extract factual claims about a company from research sources.

${UNTRUSTED_NOTICE}

Target company: ${stringify(input.companyName)}${input.companyDomain ? ` (${stringify(input.companyDomain)})` : ""}

Extract every distinct factual claim about THIS company from the sources below. Claims must be things a salesperson would act on: funding rounds, headcount, roles being hired, executive changes, product facts, locations. Rules:
- One claim per fact. Do not merge facts from different sources into one claim.
- If two sources disagree (e.g. Series A vs Series B), emit BOTH claims, each citing its own source. Reconciliation happens downstream.
- Never invent a date. Use the source's published date only when the source states when the fact happened.
- Skip claims about other companies, even similarly named ones.

Sources:
${wrapUntrusted(sourceBlocks.join("\n\n"))}`,
    });

    trackUsage({
      service: "claude",
      operation: "claim-extractor",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateClaudeCostFromUsage("haiku", usage),
      metadata: {
        model: "claude-haiku-4-5",
        companyName: input.companyName,
        sourceCount: sources.length,
        claimCount: object.claims.length,
      },
    });

    const extractedAt = new Date().toISOString();
    return object.claims
      .filter((c) => c.sourceIndex >= 0 && c.sourceIndex < sources.length)
      .map((c) => ({
        type: c.type,
        statement: c.statement,
        sourceUrl: sources[c.sourceIndex].url,
        publishedDate: c.publishedDate ?? sources[c.sourceIndex].publishedDate,
        confidence: c.confidence,
        extractedAt,
        status: "unverified" as const,
      }));
  } catch (err) {
    console.error("[claim-extractor] failed, storing raw data only:", err);
    return [];
  }
}
```

**Step 4: Run to verify pass.** `pnpm vitest run src/__tests__/claim-extractor.test.ts` → 3 passed.

**Step 5: Lint, typecheck, commit.**

```bash
pnpm exec eslint src/lib/services/claim-extractor.ts src/__tests__/claim-extractor.test.ts && pnpm typecheck
git add src/lib/services/claim-extractor.ts src/__tests__/claim-extractor.test.ts
git commit -m "feat(claims): Haiku claim extractor with source-index provenance"
```

---

### Task 3: Careers scrape + claims inside `enrichCompanyById`

**Files:**

- Modify: `src/lib/tools/enrichment-tools.ts` (function `enrichCompanyById`, currently ~line 1100; Promise.allSettled at ~1172; search storage loop at ~1234)
- Modify: `src/lib/services/hiring-scraper.ts` (export a non-throwing wrapper)

Read both files first; line numbers drift.

**Step 1: Add a fail-open wrapper to `hiring-scraper.ts`** (the raw `scrapeHiringData` throws on missing env vars; enrichment must not).

```ts
/**
 * Fail-open variant for use inside enrichment: a scrape failure returns
 * null (raw enrichment proceeds without hiring data) instead of failing
 * the whole company. The raw scrapeHiringData stays throwing for the
 * agent tools, which surface errors to the model.
 */
export async function tryScrapeHiringData(
  organizationId: string,
  domain: string,
): Promise<HiringScrapeResult | null> {
  try {
    return await scrapeHiringData(organizationId, domain);
  } catch (err) {
    console.error(`[hiring-scraper] scrape failed for ${domain}:`, err);
    return null;
  }
}
```

**Step 2: In `enrichCompanyById`, extend the parallel pulls.** The existing destructure is:

```ts
const [websiteResult, productResult, fundingResult, teamResult] =
  await Promise.allSettled([...]);
```

Add a fifth entry. Also hoist the three query strings into consts (`productQuery`, `fundingQuery`, `teamQuery`) so Step 3 can store the real ones:

```ts
const [websiteResult, productResult, fundingResult, teamResult, hiringResult] =
  await Promise.allSettled([
    /* existing four unchanged, but using the hoisted query consts */
    org.domain
      ? tryScrapeHiringData(organizationId, org.domain as string)
      : Promise.resolve(null),
  ]);
```

(`scrapeHiringData` already writes `enrichment_data.hiring` itself via `mergeEnrichmentData`; the returned value here is only for claim building.)

**Step 3: Store the real executed query.** In the search storage loop, the entries become `["product", productResult, productQuery]` etc., and `query: `${org.name} ${label}``becomes`query` from the tuple.

**Step 4: Extract + reconcile claims after the loop**, before `enrichmentData.searches = searches`:

```ts
// Typed claims: extract from raw pulls, then reconcile against the careers
// scrape (ground truth for hiring) and recency rules. Fail-open at every
// stage; a claims failure never blocks storing the raw enrichment.
const careers =
  hiringResult.status === "fulfilled" && hiringResult.value
    ? {
        careersUrl: hiringResult.value.careersUrl,
        jobs: hiringResult.value.jobs,
        scrapedAt: new Date().toISOString(),
      }
    : null;

const extracted = await extractClaims({
  companyName: org.name as string,
  companyDomain,
  websiteContent:
    websiteResult.status === "fulfilled" && websiteResult.value?.success
      ? websiteResult.value.data.content
      : null,
  searches,
});

// Scraped jobs become verified hiring claims directly; no LLM needed.
const hiringClaims: CompanyClaim[] = careers?.careersUrl
  ? careers.jobs.map((j) => ({
      type: "hiring_role" as const,
      statement: `Hiring: ${j.title}${j.location ? ` (${j.location})` : ""}`,
      sourceUrl: careers.careersUrl as string,
      publishedDate: careers.scrapedAt,
      confidence: 1,
      extractedAt: careers.scrapedAt,
      status: "verified" as const,
    }))
  : [];

enrichmentData.claims = [
  ...reconcileClaims(extracted, { now: new Date(), careers }),
  ...hiringClaims,
];
```

Imports to add at the top of `enrichment-tools.ts`: `extractClaims` from `@/lib/services/claim-extractor`, `reconcileClaims` from `@/lib/services/claim-reconciler`, `tryScrapeHiringData` from `@/lib/services/hiring-scraper`, and `type CompanyClaim` from `@/lib/types/claims`.

**Step 5: Update `summarizeCompanyEnrichment`** (~line 1077) to include `claims: (data.claims as unknown[])?.length ?? 0` and `hiringScraped: Boolean(data.hiring)` so the thin tool summary tells the model what it got.

**Step 6: Verify.**
Run: `pnpm exec eslint src/lib/tools/enrichment-tools.ts src/lib/services/hiring-scraper.ts && pnpm typecheck && pnpm vitest run`
Expected: clean, full suite passes (3 pre-existing failures in `companies-list-default-view.test.tsx` are known if that file exists on this branch).

**Step 7: Commit.**

```bash
git add src/lib/tools/enrichment-tools.ts src/lib/services/hiring-scraper.ts
git commit -m "feat(enrich): careers scrape and reconciled claims in company enrichment"
```

---

### Task 4: Unify `/api/enrich-company` onto the same claims path

**Files:**

- Modify: `src/app/api/enrich-company/route.ts` (~lines 199-430)

Full extraction of a shared `enrichCompanyCore` was considered and cut (YAGNI for now): the route has signal-gated searches, Google Reviews, and summarization the tool path deliberately lacks, and merging those is a refactor with its own risk. Instead, give the route the same claims tail:

**Step 1: Read the route.** Locate where it assembles its `enrichmentData` (searches array with optional `.summary` fields, `website`, `googleReviews`) and where it calls `mergeEnrichmentData`.

**Step 2: Before its `mergeEnrichmentData` call**, insert the same block as Task 3 Step 4 (extract → hiring claims → reconcile → `enrichmentData.claims`). The route does not currently scrape careers: add the same `tryScrapeHiringData` parallel pull, gated on the org having a domain, alongside its existing `Promise.allSettled` batch. Map its `executive` category results into the `searches` argument for `extractClaims` unchanged (the extractor treats categories as labels only).

**Step 3: Verify + commit.**

```bash
pnpm exec eslint src/app/api/enrich-company/route.ts && pnpm typecheck && pnpm vitest run
git add src/app/api/enrich-company/route.ts
git commit -m "feat(enrich): claims and careers scrape on the UI enrichment path"
```

---

### Task 5: System prompt: hiring hard rule + claims-based scoring

**Files:**

- Modify: `src/lib/system-prompt.ts` (~lines 88, 97-104, 205-215, 226)

**Step 1:** In the Full Pipeline list (~line 88), delete step 2 ("Scrape hiring data with `scrapeJobListingsBatch`...") and renumber: the scrape now runs inside `enrichCompany`. Keep `scrapeJobListings` mentioned as a refresh tool only.

**Step 2:** In Company Enrichment Details (~line 97), replace the "Hiring research" bullet with:

```
- **Hiring facts come only from the live careers page.** \`enrichCompany\` scrapes it automatically (Browserbase) and stores the result in \`enrichment_data.hiring\` plus verified \`hiring_role\` claims. An Exa result or news article saying a company "is hiring X" is a lead, never a fact: if the careers scrape contradicts it, the scrape wins. If there is no scrape (no domain, scrape failed), say hiring is unknown rather than guessing. Use \`scrapeJobListings\` to refresh a stale scrape.
```

**Step 3:** In the Priority Scoring Framework (~line 205), after the Company Priority bullet list, add:

```
**Score from reconciled claims, not raw search text.** \`getCompanyDetail\` returns \`enrichment_data.claims\`, each with a status. Build the score and reason only from \`verified\` and \`unverified\` claims, and state the claim's date in the reason ("$30M Series B, Feb 2026"). Never cite a \`contradicted\`, \`superseded\`, or \`stale\` claim as a timing signal; if the only signals available are stale, say so and score accordingly.
```

**Step 4:** Add a grounding rule. Motivating failure: the agent described Browserbase as "a YC-backed startup" when no data said so and the contact's own enrichment listed Notable Capital, CRV, and Kleiner Perkins as the backers. This is not a data-quality bug; it is the model asserting an association it never read, so it must be blocked at the prompt level. Add to the Company Enrichment Details section (near the hiring rule from Step 2):

```
- **Never assert a company fact you did not read.** Investors, accelerator membership (YC etc.), funding stage, headcount, customers, and similar facts may only be stated when they appear in enrichment data, claims, or something the user said. If you are inferring or pattern-matching ("startups like this are usually..."), say it is a guess in the same sentence. When enrichment contradicts something you were about to say, the enrichment wins.
```

**Step 5:** Add a voice rule: domain language, not implementation language. Motivating exchange: asked how an email was verified, the agent answered "the findEmail tool with revalidate: true runs a two-step process... that flips the status from unchecked to deliverable". Owner decision: transparency about method and evidence stays (it builds trust and catches errors), but the register must be the domain, never the code. Find the system prompt's communication/voice section (or add one near the top-level behavior rules) and add:

```
- **Explain in domain language, never implementation language.** Always be willing to explain how you reached a conclusion, but describe evidence and actions, not machinery: say "I asked the company's mail server whether that mailbox exists" rather than naming tools, parameters, flags, or status values (findEmail, revalidate, unchecked, deliverable). Never mention internal step lists, credits, or which steps are paid unless the user asks about cost directly. Keep process narration to one short line; prefer doing the work over describing that you are about to do it.
```

**Step 6:** Check `getCompanyDetail` (in `src/lib/tools/enrichment-tools.ts` or `search-tools.ts`) returns the full `enrichment_data` including `claims`. It returns the stored blob today, so claims flow through automatically; verify, don't assume.

**Step 7: Verify + commit.** Watch the em-dash rule; the blocks above use colons deliberately.

```bash
pnpm exec eslint src/lib/system-prompt.ts && pnpm typecheck
git add src/lib/system-prompt.ts
git commit -m "feat(prompt): hiring hard rule, claims-based scoring, grounding and voice rules"
```

---

### Task 6: UI: claims with status badges, dates on search results

**Files:**

- Modify: `src/components/campaign/company-detail.tsx` (sections at ~lines 95-260, `SearchSection` at ~295)
- Modify or create the enrichment types it casts to (`CompanyEnrichmentData`, wherever defined; likely `src/lib/types/enrichment.ts`) to add `claims?: CompanyClaim[]`

**Step 1: Read `company-detail.tsx` fully.** Match its existing section/card idiom exactly; do not invent new styling primitives.

**Step 2: Add a Claims section** rendered above the search sections when `enrichment_data.claims` is non-empty. Per claim: statement, a small status badge, `publishedDate` when present, and the source hostname as an external link. Badge treatment: `verified` green, `unverified` neutral, `stale` amber, `contradicted`/`superseded` red-struck or muted, following whatever badge component `provenance-badge.tsx` uses so the visual language matches the contact provenance work.

**Step 3: Render `publishedDate` in `SearchSection`.** The prop already exists in its type and is unused; display it next to the result title (e.g. `Feb 2026`) when non-null.

**Step 4: Verify in the running app** (`pnpm dev`), against a company with claims after re-enriching one, plus lint/typecheck.

**Step 5: Commit.**

```bash
git add src/components/campaign/company-detail.tsx <types file>
git commit -m "feat(ui): claim status badges and source dates on company detail"
```

---

### Task 7: Cheap-first careers scrape (owner request, added mid-execution)

**Files:**

- Modify: `src/lib/services/hiring-scraper.ts`
- Test: `src/__tests__/hiring-scraper-cheap.test.ts`

Today `scrapeHiringData` goes straight to the most expensive tier: a full Stagehand browser session (60s init plus un-timed LLM observe/act/extract) for every company. Rebuild its internals cheap-first; the exported signature, `HiringScrapeResult` shape, `tryScrapeHiringData`, `HIRING_SCRAPE_TIMEOUT_MS`, and the `mergeEnrichmentData` write must not change, so every caller (both enrichment paths, the agent tools, the tracking executor) is untouched.

**Tier order:**

1. **Find the careers URL without a browser.** Probe the existing common-paths list with `fetchWithTimeout` (see `src/lib/fetch-with-timeout.ts`) and accept the first 2xx. If none hit, fetch the homepage and look for careers/jobs links in the HTML. Optionally one Exa search scoped to the domain as the last resort.
2. **ATS shortcut, zero LLM.** If the careers page (or homepage) links to a hosted board, hit the board's public JSON API for structured listings: Greenhouse (`https://boards-api.greenhouse.io/v1/boards/{slug}/jobs`), Lever (`https://api.lever.co/v0/postings/{slug}?mode=json`), Ashby (`https://api.ashbyhq.com/posting-api/job-board/{slug}`), Workable (`https://apply.workable.com/api/v1/widget/accounts/{slug}`). Extract the slug from the link URL. Verify each URL pattern against the provider's current docs during implementation; do not trust this list blindly. Map into the existing `jobs` shape.
3. **Fetched-HTML extraction.** Otherwise run `WebExtractionService.extract(careersUrl)` (its internal tiers: free fetch, then Browserbase Fetch) and one Haiku `generateObject` pass (relevance-filter house pattern) to pull `{title, department?, location?, url?}` from the text.
4. **Stagehand only as last resort.** Keep the current implementation as a private fallback, invoked only when tiers 1-3 produce no careers URL or thin content (< ~200 chars of job-relevant text).

**TDD:** mock `fetch`/`fetchWithTimeout` and test: ATS link detection + slug extraction per provider, JSON mapping into `jobs`, tier fall-through order (ATS hit never calls WebExtraction; thin content falls through to the Stagehand fallback, which in tests is a stub). Follow the repo's existing mock style in `src/__tests__/`.

**Verify:** eslint, typecheck, full vitest run. Commit:

```bash
git commit -m "perf(hiring): cheap-first careers scrape with ATS shortcut, browser as last resort"
```

---

### Task 8: Full verification + PR

**Step 1:** `pnpm exec eslint . && pnpm typecheck && pnpm vitest run` — all clean (minus known pre-existing failures, list them in the PR if still present).

**Step 2:** Manual smoke: in the app, enrich one known company (Fyxer is the canonical case) and confirm: `hiring` populated from the careers page, `claims` present with the Series B claim `verified` and any aggregator hiring claim `contradicted`, score reason cites dated claims. Then ask the chat agent "who are this company's investors?" for a company whose enrichment does not mention investors; it should say the data does not say, not improvise (grounding rule from Task 5). The deferred eval harness should include hallucination probes like this as graded cases.

**Step 3:** Push branch, open PR to `main` titled `feat(enrich): dated, sourced, reconciled claims; careers-page-first hiring`. Body: link the Fyxer failure as motivation, note the +1 Haiku call and +1 Browserbase session per company enrichment cost, note the deferred eval harness as the follow-up that measures this.
