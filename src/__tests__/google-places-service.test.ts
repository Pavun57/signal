import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The domain cross-check. A Places text search matches on the name, so "Apex"
 * routinely returns "Apex Gym": the caller passes the org's domain precisely
 * so a namesake's rating and reviews cannot be filed under the target company
 * and cited in outreach as its own customers.
 */

vi.mock("@/lib/services/cost-tracker", () => ({
  trackUsage: vi.fn(),
  PRICING: { google_places_search: 0.032 },
}));

import { GooglePlacesService } from "@/lib/services/google-places-service";
import { trackUsage } from "@/lib/services/cost-tracker";

const fetchMock = vi.fn();

function placesResponse(places: unknown[]) {
  return {
    ok: true,
    json: async () => ({ places }),
  };
}

const gymPlace = {
  id: "place-1",
  displayName: { text: "Apex Gym" },
  websiteUri: "https://www.apexgym.com",
  rating: 4.8,
  userRatingCount: 120,
  formattedAddress: "1 High St",
  googleMapsUri: "https://maps.google.com/x",
  reviews: [],
};

beforeEach(() => {
  vi.stubEnv("GOOGLE_API_KEY", "test-key");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(trackUsage).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getPlaceReviews domain cross-check", () => {
  it("discards a match whose website is a different company", async () => {
    fetchMock.mockResolvedValue(placesResponse([gymPlace]));

    const result = await new GooglePlacesService().getPlaceReviews(
      "Apex",
      undefined,
      "apex.io",
    );

    expect(result.found).toBe(false);
    expect(result.rating).toBeNull();
    expect(result.reviews).toEqual([]);
    expect(result.error).toMatch(/different business/);
  });

  it("keeps a match whose website agrees", async () => {
    fetchMock.mockResolvedValue(placesResponse([gymPlace]));

    const result = await new GooglePlacesService().getPlaceReviews(
      "Apex Gym",
      undefined,
      "apexgym.com",
    );

    expect(result.found).toBe(true);
    expect(result.rating).toBe(4.8);
  });
});

describe("getPlaceReviews cost tracking", () => {
  it("tracks a zero-result search: Google bills it anyway", async () => {
    fetchMock.mockResolvedValue(placesResponse([]));

    await new GooglePlacesService().getPlaceReviews("Nowhere Ltd");

    expect(trackUsage).toHaveBeenCalledTimes(1);
  });

  it("tracks a non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "quota",
    });

    await new GooglePlacesService().getPlaceReviews("Anyone");

    expect(trackUsage).toHaveBeenCalledTimes(1);
  });

  it("tracks a mismatched match", async () => {
    fetchMock.mockResolvedValue(placesResponse([gymPlace]));

    await new GooglePlacesService().getPlaceReviews(
      "Apex",
      undefined,
      "apex.io",
    );

    expect(trackUsage).toHaveBeenCalledTimes(1);
  });
});
