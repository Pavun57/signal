import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { llmTimeout } from "@/lib/utils/timeout";
import { z } from "zod";
import { MODELS } from "@/lib/ai/models";
import { WebExtractionService } from "@/lib/services/web-extraction-service";
import {
  estimateClaudeCostFromUsage,
  trackUsage,
} from "@/lib/services/cost-tracker";
import {
  UNTRUSTED_NOTICE,
  stringify,
  wrapUntrusted,
} from "@/lib/prompt-safety";

// ── Types ────────────────────────────────────────────────────────────────

export interface CompanyContext {
  name: string;
  domain: string | null;
  industry: string | null;
  location: string | null;
  description: string | null;
}

export interface CandidateContact {
  name: string;
  title: string | null;
  linkedinUrl: string | null;
  rawHeadline: string | null;
}

/**
 * Three outcomes, not two.
 *
 * The binary version forced every candidate into "employee" or "not", and the
 * honest answer for a large share of them is "the evidence does not say". On
 * the dev database, 19 of 41 contacts at one company had a headline that never
 * mentions their employer — common at small startups — so a filter that must
 * choose either keeps provably-wrong people or deletes real ones. `uncertain`
 * is what lets us keep them, visibly unproven, and resolve them later.
 */
export type ContactVerdict = "verified" | "uncertain" | "rejected";

export interface VerifiedContact {
  index: number;
  name: string;
  title: string | null;
  verdict: ContactVerdict;
  /** One line explaining the call, stored as affiliation_evidence. */
  evidence: string;
}

export interface DomainPerson {
  name: string;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
}

// ── Team page paths to try ───────────────────────────────────────────────

const TEAM_KEYWORDS = [
  "team",
  "our-team",
  "meet-the-team",
  "about",
  "about-us",
  "staff",
  "people",
  "leadership",
  "management",
  "who-we-are",
  "contact",
  "contact-us",
];

/**
 * Fetch sitemap.xml and return the list of URLs.
 * Returns empty array on failure (no sitemap = fall back to guessing).
 */
async function fetchSitemapUrls(domain: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`https://${domain}/sitemap.xml`, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timeoutId);

    if (!response.ok) return [];
    const xml = await response.text();
    const urls: string[] = [];
    const locRegex = /<loc>(.*?)<\/loc>/g;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      urls.push(match[1]);
    }
    return urls;
  } catch {
    return [];
  }
}

// ── Domain-based people finding ──────────────────────────────────────────

/**
 * Scrape a company's website for team/about/staff pages and extract people.
 * Fetches the sitemap first to find real URLs instead of guessing paths.
 * Falls back to a short guess list if no sitemap exists.
 */
export async function findPeopleOnDomain(
  domain: string,
  orgName: string,
): Promise<DomainPerson[]> {
  const extractor = new WebExtractionService();
  const scrapedContent: Array<{ url: string; content: string }> = [];

  // Step 1: Try sitemap to find team/about pages
  const sitemapUrls = await fetchSitemapUrls(domain);
  let urlsToTry: string[];

  if (sitemapUrls.length > 0) {
    // Filter sitemap URLs to only those matching team-related keywords
    const lowerKeywords = TEAM_KEYWORDS;
    urlsToTry = sitemapUrls.filter((url) => {
      const path = url.toLowerCase();
      return lowerKeywords.some((kw) => path.includes(`/${kw}`));
    });
    console.log(
      `[contact-filter] Sitemap found ${sitemapUrls.length} URLs, ${urlsToTry.length} match team keywords`,
    );
  } else {
    // No sitemap -- fall back to top 4 most common paths only
    urlsToTry = ["/team", "/about", "/about-us", "/people"].map(
      (p) => `https://${domain}${p}`,
    );
    console.log(
      `[contact-filter] No sitemap for ${domain}, trying ${urlsToTry.length} common paths`,
    );
  }

  // Step 2: Fetch matching URLs (cap at 4 to avoid spraying requests)
  const toFetch = urlsToTry.slice(0, 4);
  const results = await Promise.allSettled(
    toFetch.map(async (url) => {
      const result = await extractor.extract(url, {
        includeLinks: false,
        timeout: 8000,
      });
      if (
        result.success &&
        result.data.content.length > 200 &&
        !result.url.includes("/404")
      ) {
        return { url: result.url, content: result.data.content };
      }
      return null;
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      scrapedContent.push(r.value);
    }
  }

  if (scrapedContent.length === 0) return [];

  // Use Haiku to extract people from the scraped content
  const combinedContent = scrapedContent
    .map((s) => `--- ${s.url} ---\n${s.content.slice(0, 4000)}`)
    .join("\n\n");

  try {
    const { object, usage } = await generateObject({
      abortSignal: llmTimeout(),
      model: anthropic(MODELS.LIGHT),
      schema: z.object({
        people: z.array(
          z.object({
            name: z.string().describe("Full name of the person"),
            title: z
              .string()
              .nullable()
              .describe("Job title or role at the company"),
            email: z
              .string()
              .nullable()
              .describe("Work email if found on the page"),
            linkedinUrl: z
              .string()
              .nullable()
              .describe("LinkedIn profile URL if found"),
          }),
        ),
      }),
      prompt: `Extract all staff members / team members from scraped website pages for a specific company.

${UNTRUSTED_NOTICE}

Target company name: ${stringify(orgName)}
Target domain: ${stringify(domain)}

Rules:
- Only extract REAL people who work at this company (not testimonials, clients, or partners)
- Each person should have a real human name (skip generic entries like "The Team" or company names)
- Clean up names: remove credentials/suffixes unless they're part of how the person is known
- Extract their job title/role at this company
- Extract their work email if listed
- Extract their LinkedIn URL if linked
- Skip duplicate people (same name appearing on multiple pages)

Scraped page content:
${wrapUntrusted(combinedContent.slice(0, 12000))}`,
    });

    trackUsage({
      service: "claude",
      operation: "domain-people-extract",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateClaudeCostFromUsage("haiku", usage),
      metadata: {
        model: "claude-haiku-4-5",
        domain,
        pagesScraped: scrapedContent.length,
        peopleFound: object.people.length,
      },
    });

    return object.people;
  } catch (err) {
    console.error("[contact-filter] Domain people extraction failed:", err);
    return [];
  }
}

// ── Company name matching ────────────────────────────────────────────────

/**
 * Normalize a company name for comparison: lowercase, strip common suffixes
 * (Ltd, Inc, LLC, etc.), and collapse whitespace/punctuation.
 */
function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(ltd|limited|inc|incorporated|llc|plc|corp|corporation|co|company|group|holdings)\b\.?/g,
      "",
    )
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check whether a LinkedIn headline references the target company name.
 * Uses normalized substring matching — the headline must contain the core
 * company name (minus legal suffixes) to pass.
 */
function headlineMentionsCompany(
  headline: string | null,
  companyName: string,
): boolean {
  if (!headline) return false;
  const normHeadline = normalizeCompanyName(headline);
  const normCompany = normalizeCompanyName(companyName);
  if (!normCompany) return false;
  return normHeadline.includes(normCompany);
}

// ── LLM-based LinkedIn result filtering ──────────────────────────────────

/**
 * Judge which search results genuinely work at the target company.
 *
 * The headline check used to be a hard pre-filter, and anything that failed it
 * was dropped before the LLM ever saw it — returning `[]` outright when nothing
 * matched. That is why searchPeople stopped calling this at all: at small
 * companies most people's LinkedIn headline never names their employer, so the
 * filter deleted real employees in bulk. Measured on the dev database, it would
 * have discarded 22 of 41 genuine contacts.
 *
 * So the headline match is now a *hint passed to the LLM*, not a gate. Every
 * candidate is judged, and the ones the evidence cannot settle come back
 * `uncertain` rather than being silently dropped or silently trusted.
 */
export async function filterContactsByCompany(
  company: CompanyContext,
  candidates: CandidateContact[],
): Promise<VerifiedContact[]> {
  if (candidates.length === 0) return [];

  const indexed = candidates.map((c, originalIndex) => ({
    ...c,
    originalIndex,
  }));
  const hintedCount = indexed.filter((c) =>
    headlineMentionsCompany(c.rawHeadline, company.name),
  ).length;

  console.log(
    `[contact-filter] Judging ${candidates.length} candidates for "${company.name}" (${hintedCount} name-matched headlines)`,
  );

  const summaries = indexed
    .map(
      (c, i) =>
        `[${i}] ${c.rawHeadline || c.name}${c.title ? ` (parsed: ${c.title})` : ""}` +
        ` — headline names the target company: ${
          headlineMentionsCompany(c.rawHeadline, company.name) ? "yes" : "no"
        }`,
    )
    .join("\n");

  try {
    const { object, usage } = await generateObject({
      abortSignal: llmTimeout(),
      model: anthropic(MODELS.LIGHT),
      schema: z.object({
        judged: z.array(
          z.object({
            index: z
              .number()
              .int()
              .describe("Index of the candidate from the input list"),
            name: z.string().describe("Cleaned full name"),
            title: z
              .string()
              .nullable()
              .describe("Cleaned job title without company name"),
            verdict: z
              .enum(["verified", "uncertain", "rejected"])
              .describe(
                "verified = evidence says they work at the target company; rejected = evidence says they work somewhere else; uncertain = the evidence does not settle it",
              ),
            evidence: z
              .string()
              .describe(
                "One short sentence citing what decided it, e.g. \"headline reads 'Wafer'\" or 'headline names no employer'",
              ),
          }),
        ),
      }),
      prompt: `You are judging whether each LinkedIn search result actually works at a specific company.

${UNTRUSTED_NOTICE}

Target company:
- Name: ${stringify(company.name)}
- Domain: ${stringify(company.domain || "unknown")}
- Industry: ${stringify(company.industry || "unknown")}
- Location: ${stringify(company.location || "unknown")}

Candidates (scraped from LinkedIn results):
${wrapUntrusted(summaries)}

Return a verdict for EVERY candidate. Use exactly three verdicts:

- "verified" — the evidence positively places them at the target company, e.g. the headline names it.
- "rejected" — the evidence positively places them somewhere ELSE. Similarly-named but different companies belong here ("Dixons Carphone" is NOT "Dixons Estate Agents"; "Miller Rose" is NOT "Miller & Carter"). Use the domain and industry to disambiguate — if the target is an estate agent, a retail-electronics employee with a similar company name is rejected.
- "uncertain" — the evidence does not settle it either way. A headline that names no employer at all is UNCERTAIN, not rejected: at small companies most people never mention their employer in their headline. Reserve "rejected" for a positive signal pointing elsewhere.

Do not guess in order to avoid "uncertain". An honest "uncertain" is more useful than a confident mistake in either direction — uncertain contacts are kept and flagged for review, while rejected ones are detached from the company.

Also clean up the display fields:
- names: remove LinkedIn suffixes, emoji, excessive credentials
- titles: extract just the role ("Branch Manager", not "Branch Manager at Dixons")`,
    });

    trackUsage({
      service: "claude",
      operation: "contact-filter",
      tokens_input: usage.inputTokens ?? 0,
      tokens_output: usage.outputTokens ?? 0,
      estimated_cost_usd: estimateClaudeCostFromUsage("haiku", usage),
      metadata: {
        model: "claude-haiku-4-5",
        companyName: company.name,
        candidateCount: indexed.length,
        verifiedCount: object.judged.filter((v) => v.verdict === "verified")
          .length,
        uncertainCount: object.judged.filter((v) => v.verdict === "uncertain")
          .length,
        rejectedCount: object.judged.filter((v) => v.verdict === "rejected")
          .length,
      },
    });

    // Drop hallucinated indices, then map back to the caller's numbering.
    const seen = new Set<number>();
    const judged: VerifiedContact[] = [];
    for (const v of object.judged) {
      const original = indexed[v.index];
      if (!original || seen.has(v.index)) continue;
      seen.add(v.index);
      judged.push({
        index: original.originalIndex,
        name: v.name,
        title: v.title,
        verdict: v.verdict,
        evidence: v.evidence,
      });
    }

    // Anything the model failed to return a verdict for is unknown, not bad.
    for (const c of indexed) {
      if (seen.has(indexed.indexOf(c))) continue;
      if (judged.some((j) => j.index === c.originalIndex)) continue;
      judged.push({
        index: c.originalIndex,
        name: c.name,
        title: c.title,
        verdict: "uncertain",
        evidence: "no verdict returned for this candidate",
      });
    }

    return judged;
  } catch (err) {
    console.error(
      "[contact-filter] LLM judge failed; returning all candidates as uncertain:",
      err,
    );
    // The old fallback discarded every candidate on an LLM error, which turns a
    // transient outage into silent data loss. Uncertain keeps them, visibly
    // unproven, and the send gate still refuses them until something confirms.
    return candidates.map((c, index) => ({
      index,
      name: c.name,
      title: c.title,
      verdict: "uncertain" as const,
      evidence: "affiliation check unavailable",
    }));
  }
}
