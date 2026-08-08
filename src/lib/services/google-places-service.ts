import { PRICING, trackUsage } from "@/lib/services/cost-tracker";
import { withTimeout } from "@/lib/utils/timeout";

export interface GoogleReview {
  authorName: string;
  rating: number;
  text: string;
  relativePublishTime: string;
}

export interface GoogleReviewsResult {
  found: boolean;
  placeId: string | null;
  displayName: string | null;
  rating: number | null;
  userRatingCount: number;
  formattedAddress: string | null;
  googleMapsUri: string | null;
  websiteUri: string | null;
  reviews: GoogleReview[];
  error?: string;
}

const TIMEOUT_MS = 30_000;
const API_BASE = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.rating",
  "places.userRatingCount",
  "places.reviews",
  "places.formattedAddress",
  "places.websiteUri",
  "places.googleMapsUri",
].join(",");

export class GooglePlacesService {
  private apiKey: string;

  constructor() {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GOOGLE_API_KEY environment variable is required. Get your API key at https://console.cloud.google.com/apis/credentials",
      );
    }
    this.apiKey = apiKey;
  }

  async getPlaceReviews(
    companyName: string,
    location?: string,
    domain?: string,
  ): Promise<GoogleReviewsResult> {
    const textQuery = location ? `${companyName} ${location}` : companyName;

    try {
      console.log(`[GooglePlaces] Searching: "${textQuery}"`);

      const res = await withTimeout(
        fetch(API_BASE, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": this.apiKey,
            "X-Goog-FieldMask": FIELD_MASK,
          },
          body: JSON.stringify({
            textQuery,
            maxResultCount: 1,
          }),
        }),
        TIMEOUT_MS,
        `Google Places search for "${textQuery}"`,
      );

      // Google bills Text Search per request, whatever comes back. Tracking
      // only the found-with-results path made the cost dashboard understate
      // Places spend by the entire miss rate.
      if (!res.ok) {
        const body = await res.text();
        console.error(`[GooglePlaces] API error ${res.status}: ${body}`);
        trackUsage({
          service: "google",
          operation: "places-search",
          estimated_cost_usd: PRICING.google_places_search,
          metadata: { textQuery, httpStatus: res.status },
        });
        return {
          found: false,
          placeId: null,
          displayName: null,
          rating: null,
          userRatingCount: 0,
          formattedAddress: null,
          googleMapsUri: null,
          websiteUri: null,
          reviews: [],
          error: `Google Places API error: ${res.status}`,
        };
      }

      const data = await res.json();
      const places = data.places as Array<Record<string, unknown>> | undefined;

      if (!places || places.length === 0) {
        console.log(`[GooglePlaces] No results for "${textQuery}"`);
        trackUsage({
          service: "google",
          operation: "places-search",
          estimated_cost_usd: PRICING.google_places_search,
          metadata: { textQuery, found: false },
        });
        return {
          found: false,
          placeId: null,
          displayName: null,
          rating: null,
          userRatingCount: 0,
          formattedAddress: null,
          googleMapsUri: null,
          websiteUri: null,
          reviews: [],
        };
      }

      const place = places[0];
      const displayName =
        (place.displayName as { text?: string })?.text ?? null;
      const websiteUri = (place.websiteUri as string) ?? null;

      // Optional domain cross-check
      if (domain && websiteUri) {
        try {
          const placeHost = new URL(websiteUri).hostname.replace(/^www\./, "");
          const targetHost = domain.replace(/^www\./, "");
          if (placeHost !== targetHost) {
            // A mismatch means the matched Place is a different business (an
            // "Apex Gym" for "Apex"). Proceeding anyway stored the wrong
            // company's rating and reviews under the target org, and drafting
            // then cited a namesake's customers as outreach hooks. The caller
            // asked for cross-verification by passing the domain; honor it.
            console.log(
              `[GooglePlaces] Domain mismatch: place=${placeHost}, target=${targetHost}. Discarding the match.`,
            );
            trackUsage({
              service: "google",
              operation: "places-search",
              estimated_cost_usd: PRICING.google_places_search,
              metadata: { textQuery, domainMismatch: true, placeHost },
            });
            return {
              found: false,
              placeId: null,
              displayName: null,
              rating: null,
              userRatingCount: 0,
              formattedAddress: null,
              googleMapsUri: null,
              websiteUri: null,
              reviews: [],
              error: `Google Places matched a different business (${placeHost}), not ${targetHost}.`,
            };
          }
        } catch {
          // URL parsing failed, skip check
        }
      }

      const rawReviews =
        (place.reviews as Array<Record<string, unknown>>) ?? [];
      const reviews: GoogleReview[] = rawReviews.slice(0, 5).map((r) => ({
        authorName:
          (r.authorAttribution as { displayName?: string })?.displayName ??
          "Anonymous",
        rating: (r.rating as number) ?? 0,
        text: ((r.text as { text?: string })?.text ?? "").slice(0, 500),
        relativePublishTime: (r.relativePublishTimeDescription as string) ?? "",
      }));

      console.log(
        `[GooglePlaces] Found "${displayName}" with rating ${place.rating ?? "N/A"} (${place.userRatingCount ?? 0} reviews)`,
      );

      trackUsage({
        service: "google",
        operation: "places-search",
        estimated_cost_usd: PRICING.google_places_search,
        metadata: { textQuery, displayName, rating: place.rating },
      });

      return {
        found: true,
        placeId: (place.id as string) ?? null,
        displayName,
        rating: (place.rating as number) ?? null,
        userRatingCount: (place.userRatingCount as number) ?? 0,
        formattedAddress: (place.formattedAddress as string) ?? null,
        googleMapsUri: (place.googleMapsUri as string) ?? null,
        websiteUri,
        reviews,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[GooglePlaces] Failed for "${textQuery}": ${errorMessage}`,
      );
      return {
        found: false,
        placeId: null,
        displayName: null,
        rating: null,
        userRatingCount: 0,
        formattedAddress: null,
        googleMapsUri: null,
        websiteUri: null,
        reviews: [],
        error: errorMessage,
      };
    }
  }
}
