import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Giving a company the website it never had.
 *
 * A company with no domain cannot hold contacts at all (`canHoldPeople`), and
 * until now nothing in the product could fill one in: `findOrCreateOrganization`
 * writes `domain` on INSERT only, no route updated `organizations`, and the
 * agent's documented workaround (search for the website, save it) went through
 * `findOrCreateOrganization` and INSERTed a second company instead. A campaign
 * of directory-sourced companies was therefore permanently unable to hold a
 * single lead.
 *
 * The bar for a resolved domain is high on purpose. A wrong website is worse
 * than none: contacts get searched against it, people get filed under it, and
 * pattern-guessed addresses get minted at it. Returning null is always safe.
 */

const getPlaceReviews = vi.fn();
vi.mock("@/lib/services/google-places-service", () => ({
  GooglePlacesService: class {
    getPlaceReviews = (...args: unknown[]) =>
      (getPlaceReviews as unknown as (...a: unknown[]) => unknown)(...args);
  },
}));

const search = vi.fn();
vi.mock("@/lib/services/exa-service", () => ({
  ExaService: class {
    search = (...args: unknown[]) =>
      (search as unknown as (...a: unknown[]) => unknown)(...args);
  },
}));

import { resolveOrganizationDomain } from "@/lib/services/domain-resolver";

/** Places found nothing, so every case below falls through to Exa unless set. */
const placesMiss = { found: false, displayName: null, websiteUri: null };

function placesHit(displayName: string, websiteUri: string | null) {
  return { found: true, displayName, websiteUri };
}

function exaResults(results: Array<{ url: string; title: string }>) {
  return { results };
}

const CARE_HOME = {
  name: "Cedar Lodge Nursing Home",
  location: "Birmingham",
  industry: "Nursing Home",
};

beforeEach(() => {
  getPlaceReviews.mockReset().mockResolvedValue(placesMiss);
  search.mockReset().mockResolvedValue(exaResults([]));
});

afterEach(() => vi.clearAllMocks());

describe("resolveOrganizationDomain", () => {
  it("takes the website Google Places already knows about", async () => {
    getPlaceReviews.mockResolvedValue(
      placesHit(
        "Cedar Lodge Nursing Home",
        "https://www.cedarlodgenursinghome.co.uk/about",
      ),
    );

    const found = await resolveOrganizationDomain(CARE_HOME);

    expect(found?.domain).toBe("cedarlodgenursinghome.co.uk");
    expect(found?.url).toBe("https://cedarlodgenursinghome.co.uk");
    expect(found?.source).toBe("google_places");
    // Places is asked by name and place, which is what makes it trustworthy
    // for a local business, so the query has to carry the location.
    expect(getPlaceReviews).toHaveBeenCalledWith(
      "Cedar Lodge Nursing Home",
      "Birmingham",
    );
    // Exa is a paid fallback. A Places hit must not also pay for it.
    expect(search).not.toHaveBeenCalled();
  });

  it("refuses a directory that Places returned as the website", async () => {
    getPlaceReviews.mockResolvedValue(
      placesHit("Cedar Lodge Nursing Home", "https://www.carehome.co.uk/12345"),
    );

    expect(await resolveOrganizationDomain(CARE_HOME)).toBeNull();
  });

  it("refuses a Places hit for a business with a different name", async () => {
    // Places matches on a text query, so a home that has closed or a
    // neighbouring business can come back for the same search. The name has to
    // survive the round trip or the answer is somebody else's website.
    getPlaceReviews.mockResolvedValue(
      placesHit(
        "Willow Bank Dental Practice",
        "https://willowbankdental.co.uk",
      ),
    );

    expect(await resolveOrganizationDomain(CARE_HOME)).toBeNull();
  });

  it("falls back to Exa when Places has no website for the place", async () => {
    getPlaceReviews.mockResolvedValue(
      placesHit("Cedar Lodge Nursing Home", null),
    );
    search.mockResolvedValue(
      exaResults([
        {
          url: "https://www.cedarlodgenursinghome.co.uk/",
          title: "Cedar Lodge Nursing Home, Birmingham",
        },
      ]),
    );

    const found = await resolveOrganizationDomain(CARE_HOME);

    expect(found?.domain).toBe("cedarlodgenursinghome.co.uk");
    expect(found?.source).toBe("exa");
  });

  it("refuses an Exa result whose page never names the company", async () => {
    // The one that matters. Exa always returns something, and the top result
    // for a small company is routinely a directory listing, a news article or
    // an unrelated business. Without this the resolver would confidently file
    // a care home under a stranger's website.
    search.mockResolvedValue(
      exaResults([
        {
          url: "https://www.birminghamcarehomes.co.uk/listings",
          title: "Care homes in Birmingham, compare 240 providers",
        },
      ]),
    );

    expect(await resolveOrganizationDomain(CARE_HOME)).toBeNull();
  });

  it("skips a directory result and keeps looking at the rest", async () => {
    search.mockResolvedValue(
      exaResults([
        {
          url: "https://www.carehome.co.uk/care_search_details.cfm/id/1",
          title: "Cedar Lodge Nursing Home, Birmingham, carehome.co.uk",
        },
        {
          url: "https://cedarlodgenursinghome.co.uk",
          title: "Cedar Lodge Nursing Home",
        },
      ]),
    );

    const found = await resolveOrganizationDomain(CARE_HOME);

    expect(found?.domain).toBe("cedarlodgenursinghome.co.uk");
  });

  it("returns null rather than throwing when a provider is unavailable", async () => {
    // GOOGLE_API_KEY is optional in a self-hosted install: the constructor
    // throws without it. An unresolved company is a normal state, an exception
    // out of a background resolve is not.
    getPlaceReviews.mockRejectedValue(new Error("GOOGLE_API_KEY missing"));
    search.mockRejectedValue(new Error("Exa down"));

    expect(await resolveOrganizationDomain(CARE_HOME)).toBeNull();
  });
});
