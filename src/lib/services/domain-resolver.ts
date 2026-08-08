import { ExaService } from "@/lib/services/exa-service";
import { GooglePlacesService } from "@/lib/services/google-places-service";
import {
  isDirectoryDomain,
  isPlatformDomain,
} from "@/lib/services/directory-domains";
import { normalizeDomain } from "@/lib/services/knowledge-base";

/**
 * Find the website of a company we hold with no domain on record.
 *
 * A domain-less organization cannot hold contacts at all (`canHoldPeople`), and
 * nothing in the product could ever fill one in: `findOrCreateOrganization`
 * writes `domain` on INSERT only, and the agent's documented workaround went
 * through the same function and INSERTed a second company. Directory discovery
 * produces domain-less companies routinely (a care home listed on a directory
 * often has no website in the listing), so whole campaigns were structurally
 * unable to hold a lead.
 *
 * Reads only. The caller decides whether to write, because writing a domain can
 * collide with an existing organization and that is a merge, not an update.
 *
 * The bar is deliberately high, and null is always an acceptable answer. A
 * wrong website is much worse than none: contacts are searched against it,
 * people are filed under it, and pattern-guessed addresses are minted at it.
 */

export interface ResolvedDomain {
  /** Registrable apex, normalised the same way organizations.domain is. */
  domain: string;
  url: string;
  source: "google_places" | "exa";
  /** What convinced us, in the same voice as affiliation evidence. */
  evidence: string;
}

/** Per-call ceiling on Exa results inspected. One search, so one Exa charge. */
const EXA_RESULTS = 5;

/**
 * Words that carry no identity. Two care homes in one city share every one of
 * them, so a match built on these alone is a match on the industry.
 */
const NOISE = new Set([
  "the",
  "and",
  "ltd",
  "limited",
  "plc",
  "llp",
  "inc",
  "llc",
  "co",
  "company",
  "group",
  "uk",
  "care",
  "home",
  "homes",
  "nursing",
  "residential",
  "services",
  "centre",
  "center",
]);

/** Lowercase alphanumerics only, so punctuation and spacing stop mattering. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function significantTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !NOISE.has(t));
}

/**
 * Does `text` plausibly belong to this company?
 *
 * Every significant token has to appear. Requiring "some overlap" is what lets
 * "Cedar Lodge Nursing Home" match "Cedar House Care Home" two streets away,
 * and the two are different employers with different staff.
 */
function namesMatch(companyName: string, text: string): boolean {
  const tokens = significantTokens(companyName);
  if (tokens.length === 0) return false;
  const haystack = squash(text);
  return tokens.every((token) => haystack.includes(token));
}

/** Apex domain of a URL, or null when it is unusable or a directory. */
function usableDomain(rawUrl: string): string | null {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return null;
  }
  const domain = normalizeDomain(host);
  // A site-builder apex (business.site, wixsite.com, ...) is not one
  // company's own domain: the sub-label that identified the business is
  // already gone by the time normalizeDomain collapses it. Returning one
  // here dedupes every business hosted on that builder into a single org,
  // which is the merge disaster PLATFORM_DOMAINS exists to prevent, and
  // both resolver call paths bypass the manual-URL path's guard.
  if (!domain || isDirectoryDomain(domain) || isPlatformDomain(domain)) {
    return null;
  }
  return domain;
}

export async function resolveOrganizationDomain(org: {
  name: string;
  location?: string | null;
  industry?: string | null;
}): Promise<ResolvedDomain | null> {
  // ── Google Places ───────────────────────────────────────────────────────
  // Already paid for and already discarded: getGoogleReviews requests
  // places.websiteUri and stores everything except that. For a local business
  // (care homes, dental practices, estate agents: what directory discovery
  // finds) a name plus a place is exactly the query Places is built for.
  try {
    const places = new GooglePlacesService();
    const place = await places.getPlaceReviews(
      org.name,
      org.location ?? undefined,
    );
    if (place.found && place.websiteUri) {
      const domain = usableDomain(place.websiteUri);
      // Places matches on a text query, so a closed business or a neighbour can
      // come back for the same search. The name has to survive the round trip.
      const matched =
        place.displayName != null && namesMatch(org.name, place.displayName);
      if (domain && matched) {
        return {
          domain,
          url: `https://${domain}`,
          source: "google_places",
          evidence: `Google Places lists ${place.displayName}${
            org.location ? ` in ${org.location}` : ""
          } at ${domain}`,
        };
      }
    }
  } catch (err) {
    // GOOGLE_API_KEY is optional in a self-hosted install and the constructor
    // throws without it. An unresolved company is an ordinary state; an
    // exception out of a background resolve is not.
    console.warn(
      `[domain-resolver] Places lookup failed for "${org.name}":`,
      err instanceof Error ? err.message : err,
    );
  }

  // ── Exa fallback ────────────────────────────────────────────────────────
  try {
    const exa = new ExaService();
    const parts = [
      `"${org.name}"`,
      org.location,
      org.industry,
      "official website",
    ];
    const { results } = await exa.search(parts.filter(Boolean).join(" "), {
      numResults: EXA_RESULTS,
      category: "company",
    });

    for (const result of results) {
      const domain = usableDomain(result.url);
      if (!domain) continue;
      // The page has to name the company, or the domain has to spell it. Exa
      // always returns something, and for a small business the top result is
      // routinely a directory listing, a news article or an unrelated company:
      // taking it on trust is how a care home ends up filed under a stranger's
      // website.
      const named =
        namesMatch(org.name, result.title ?? "") ||
        namesMatch(org.name, domain);
      if (!named) continue;
      return {
        domain,
        url: `https://${domain}`,
        source: "exa",
        evidence: `a web search for ${org.name} returned ${domain}, whose page names the company ("${(result.title ?? "").slice(0, 120)}")`,
      };
    }
  } catch (err) {
    console.warn(
      `[domain-resolver] Exa lookup failed for "${org.name}":`,
      err instanceof Error ? err.message : err,
    );
  }

  return null;
}
