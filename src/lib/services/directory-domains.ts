/**
 * Domains and titles that belong to businesses that list OTHER businesses.
 *
 * Lived in `search-tools.ts` until the domain resolver needed it too. A service
 * importing a tool file would run the dependency backwards (tools are the outer
 * layer and import services), so the blocklist moved down here and the tools
 * import it from this module.
 *
 * The stakes are higher than "a slightly wrong company name": a care home whose
 * resolved website is carehome.co.uk would have every contact search on the
 * directory rather than the home, and every person found there filed under the
 * wrong employer.
 */

const DIRECTORY_DOMAINS = new Set([
  // Property
  "rightmove.co.uk",
  "zoopla.co.uk",
  "onthemarket.com",
  "primelocation.com",
  // Reviews / local
  "yell.com",
  "yelp.com",
  "yelp.co.uk",
  "tripadvisor.co.uk",
  "tripadvisor.com",
  "trustpilot.com",
  "google.com",
  "google.co.uk",
  "g.co",
  // Trades
  "checkatrade.com",
  "trustatrader.com",
  "mybuilder.com",
  "ratedpeople.com",
  "bark.com",
  // Healthcare
  "nhs.uk",
  "iwantgreatcare.org",
  // Social care. carehome.co.uk is the UK's largest care home directory, and a
  // home resolved to it would have every contact search run against the
  // directory rather than the home.
  "carehome.co.uk",
  "carehomes.co.uk",
  "autumna.co.uk",
  "lottie.org",
  "cqc.org.uk",
  "trustedcare.co.uk",
  // Legal
  "lawsociety.org.uk",
  "solicitors.guru",
  "chambers.com",
  "legal500.com",
  // Finance
  "unbiased.co.uk",
  "vouchedfor.co.uk",
  // B2B directories
  "clutch.co",
  "themanifest.com",
  "sortlist.co.uk",
  "goodfirms.co",
  "g2.com",
  "capterra.com",
  // General directories / aggregators
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "tiktok.com",
  "youtube.com",
  "pinterest.com",
  "wikipedia.org",
  "crunchbase.com",
  "bloomberg.com",
  "forbes.com",
  "companieshouse.gov.uk",
  "endole.co.uk",
  "dnb.com",
  // Booking / marketplace
  "booking.com",
  "opentable.co.uk",
  "treatwell.co.uk",
  "fresha.com",
  "hitched.co.uk",
  "bridebook.com",
  // Recruitment
  "indeed.com",
  "reed.co.uk",
  "glassdoor.com",
  "glassdoor.co.uk",
  // Auto
  "autotrader.co.uk",
  "motors.co.uk",
  // Misc aggregators
  "scoot.co.uk",
  "thomsonlocal.com",
  "192.com",
  "cylex-uk.co.uk",
  "hotfrog.co.uk",
  "freeindex.co.uk",
  "thenewsshopper.co.uk",

  // B2B contact aggregators. These are the ones an Exa search is most likely
  // to surface for a company name, and the worst to accept: their pages name
  // real people, so a contact search against one files strangers as employees.
  "zoominfo.com",
  "apollo.io",
  "rocketreach.co",
  "lusha.com",
  "signalhire.com",
  "leadiq.com",
  "cognism.com",
  "clearbit.com",
  "crunchbase.com",
  "pitchbook.com",
  "owler.com",
  "dnb.com",
  "bbb.org",
  "opencorporates.com",
  "endole.co.uk",
  "companiesintheuk.co.uk",
  // The live Companies House host; the older companieshouse.gov.uk has
  // redirected here for years.
  "company-information.service.gov.uk",
  "find-and-update.company-information.service.gov.uk",
  "yell.co.uk",
  "thomsonlocal.com",
  "cylex-uk.co.uk",
  "tuugo.co.uk",
]);

/**
 * Site builders and hosts where the apex belongs to the platform, not to any
 * one business.
 *
 * `normalizeDomain` reduces a host to its registrable apex, and these are not
 * on the public suffix list's private section, so `cedarlodge.business.site`
 * and `oakhouse.business.site` both come out as `business.site`. Two unrelated
 * companies then collide on the unique index over organizations.domain, which
 * setCompanyWebsite treats as a duplicate and *merges* -- repointing one
 * company's people onto the other. Small local businesses on hosted site
 * builders are the target ICP here, so this is the common case, not an edge.
 *
 * A contact search against `business.site` would also search the whole
 * platform, and pattern-guessed addresses would be minted `@business.site`.
 */
const PLATFORM_DOMAINS = new Set([
  "business.site",
  "wordpress.com",
  "squarespace.com",
  "weebly.com",
  "godaddysites.com",
  "wixsite.com",
  "wix.com",
  "myshopify.com",
  "webflow.io",
  "netlify.app",
  "vercel.app",
  "github.io",
  "gitlab.io",
  "pages.dev",
  "blogspot.com",
  "tumblr.com",
  "sitey.me",
  "strikingly.com",
  "jimdosite.com",
  "web.app",
  "firebaseapp.com",
  "glitch.me",
  "notion.site",
  "carrd.co",
  "bigcartel.com",
  "square.site",
]);

/**
 * Is this apex a hosting platform rather than one company's own domain?
 *
 * Callers should refuse to *store* one of these as a company's website; the
 * sub-label that identified the business is already gone by this point.
 */
export function isPlatformDomain(domain: string | null): boolean {
  if (!domain) return false;
  return PLATFORM_DOMAINS.has(domain.toLowerCase());
}

/**
 * Does this look like a registrable domain at all?
 *
 * `normalizeDomain` returns its input unchanged when the public-suffix lookup
 * fails, so it is a normaliser being used as a validator: "localhost", a bare
 * label, and a 5,000-character string all came back as "domains" and were
 * stored. Anything that reaches the database here later gets fetched.
 */
export function looksLikeDomain(domain: string | null): boolean {
  if (!domain) return false;
  if (domain.length > 253) return false;
  // label(.label)+ with a non-numeric TLD of at least two characters.
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(
    domain,
  );
}

/** Check if a domain belongs to a known directory/aggregator. */
export function isDirectoryDomain(domain: string | null): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  if (DIRECTORY_DOMAINS.has(d)) return true;
  // Check parent domain (e.g. "maps.google.com" → "google.com")
  const parts = d.split(".");
  if (parts.length > 2) {
    const parent = parts.slice(-2).join(".");
    if (DIRECTORY_DOMAINS.has(parent)) return true;
  }
  return false;
}

/** Derive a brand-ish label from an apex domain, e.g. `mintlify.com` → `Mintlify`. */
export function brandFromDomain(apex: string): string {
  const sld = apex.split(".")[0] ?? "";
  return sld ? sld.charAt(0).toUpperCase() + sld.slice(1) : "Unknown";
}

/** Check if a name looks like a directory listing, not a real business. */
export function isDirectoryTitle(name: string): boolean {
  const lower = name.toLowerCase();
  const patterns = [
    /^(best|top|find)\s+\d*/,
    /\b(directory|directories)\b/,
    /\b(best|top)\s+(local|rated|reviewed)\b/,
    /\b\d+\s+(best|top)\b/,
    /\bagents?\s+(in|near|around)\s+/,
    /\bnear\s+(me|you)\b/,
    /\breview(s|ed)?\b.*\b(in|near)\b/,
  ];
  return patterns.some((p) => p.test(lower));
}
