import type { CareersScrape, CompanyClaim } from "@/lib/types/claims";

const FUNDING_STALE_MS = 365 * 24 * 60 * 60 * 1000;
const HIRING_STALE_MS = 90 * 24 * 60 * 60 * 1000;

function ageMs(claim: CompanyClaim, now: Date): number | null {
  if (!claim.publishedDate) return null;
  const t = Date.parse(claim.publishedDate);
  return Number.isNaN(t) ? null : now.getTime() - t;
}

/**
 * Words that appear in claim sentences and job-posting decoration but carry no
 * role identity. Without them stripped, "Hiring: Growth Director" and "Growth
 * Director (Remote)" can never match: neither string contains the other once
 * both carry extra text, and every live role read as contradicted.
 */
const ROLE_NOISE = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "for",
  "hiring",
  "hybrid",
  "is",
  "job",
  "jr",
  "junior",
  "of",
  "onsite",
  "position",
  "remote",
  "role",
  "senior",
  "sr",
  "the",
  "to",
  "we",
]);

function roleTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !ROLE_NOISE.has(t));
}

/**
 * Does the claim name a job on the live page? Token subset rather than string
 * containment: extractor statements are full sentences ("Acme is hiring a Head
 * of Growth") and scraped titles carry decoration ("Head of Growth (Remote)"),
 * so the scraped title's identity tokens all appearing in the statement is the
 * signal, and neither string containing the other is routine for real matches.
 */
function matchesScrapedJob(statement: string, careers: CareersScrape): boolean {
  const claimed = new Set(roleTokens(statement));
  return careers.jobs.some((j) => {
    const title = roleTokens(j.title);
    return title.length > 0 && title.every((t) => claimed.has(t));
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

  // Ground truth requires a page that was actually read and actually lists
  // jobs. careersUrl:null means no careers page was ever found, and zero
  // scraped jobs cannot distinguish "not hiring" from "could not read the
  // page" (Stagehand extracts nothing from some JS-heavy pages): both used to
  // mark every true hiring claim contradicted, and the UI then asserted "The
  // live careers page says otherwise" about a page never read.
  const careersIsGroundTruth =
    opts.careers !== null &&
    opts.careers.careersUrl !== null &&
    opts.careers.jobs.length > 0;

  for (const c of out) {
    if (c.type !== "hiring_role") continue;
    if (careersIsGroundTruth && opts.careers) {
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
