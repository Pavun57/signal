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
