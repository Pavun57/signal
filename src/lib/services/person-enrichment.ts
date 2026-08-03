import type { SupabaseClient } from "@supabase/supabase-js";

import { withAction } from "@/lib/services/cost-tracker";
import { ExaService } from "@/lib/services/exa-service";
import { LinkedinService } from "@/lib/services/linkedin-service";
import { XService } from "@/lib/services/x-service";
import { mergeEnrichmentData } from "@/lib/services/knowledge-base";

/**
 * Enriching one person: LinkedIn profile, X profile, and three Exa searches.
 *
 * Lifted out of POST /api/enrich unchanged so the bulk route can reuse it
 * rather than carry a second copy of two hundred lines that would drift. The
 * route keeps what is route-shaped -- auth, resolving a campaign_people id to
 * a person, the recency short-circuit, HTTP status codes -- and this owns the
 * work.
 *
 * Returns a plain object rather than a Response for the same reason.
 */

export interface PersonEnrichmentResult {
  status: "enriched" | "failed";
  enrichmentData: Record<string, unknown>;
  errors?: string[];
}

/** The columns enrichment reads. Exported so callers can select exactly these. */
export const PERSON_ENRICH_COLUMNS =
  "name, title, linkedin_url, twitter_url, organization:organizations(name)";

export interface PersonForEnrichment {
  name: string;
  title: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  organization: { name?: string } | null;
}

export async function enrichPerson(
  supabase: SupabaseClient,
  personId: string,
  person: PersonForEnrichment,
): Promise<PersonEnrichmentResult> {
  const contactName = person.name || "Unknown";
  const companyName = person.organization?.name || null;
  const actionLabel = companyName
    ? `Enrich person: ${contactName} (${companyName})`
    : `Enrich person: ${contactName}`;

  return withAction(actionLabel, async () => {
    await supabase
      .from("people")
      .update({ enrichment_status: "in_progress" })
      .eq("id", personId);

    const enrichmentData: Record<string, unknown> = {};
    const errors: string[] = [];
    const promises: Promise<void>[] = [];

    if (person.linkedin_url) {
      promises.push(
        (async () => {
          try {
            const linkedin = new LinkedinService();
            const scrapeResult = await linkedin.scrapeProfile(
              person.linkedin_url!,
            );
            enrichmentData.linkedin = {
              profileInfo: scrapeResult.profile || null,
              posts: scrapeResult.posts.slice(0, 10),
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            console.error(`[enrich] LinkedIn scrape failed: ${msg}`);
            errors.push(`LinkedIn: ${msg}`);
          }
        })(),
      );
    }

    if (person.twitter_url) {
      promises.push(
        (async () => {
          try {
            const x = new XService();
            const result = await x.enrichTwitterProfile(person.twitter_url!);
            enrichmentData.twitter = {
              user: result.user,
              tweets: result.tweets.slice(0, 10),
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            console.error(`[enrich] Twitter enrich failed: ${msg}`);
            errors.push(`Twitter: ${msg}`);
          }
        })(),
      );
    }

    if (contactName !== "Unknown") {
      const exa = new ExaService();

      const contactTitle = person.title || null;
      const queryParts = [`"${contactName}"`];
      if (companyName) queryParts.push(`"${companyName}"`);
      if (contactTitle) queryParts.push(contactTitle);
      const specificQuery = queryParts.join(" ");

      // URLs already on the company's card, so the same link doesn't appear
      // on both the company and the contact.
      const companyUrls = new Set<string>();
      if (person.organization) {
        const { data: orgRow } = await supabase
          .from("organizations")
          .select("enrichment_data")
          .eq("name", person.organization.name ?? "")
          .maybeSingle();

        const orgEnrichment = orgRow?.enrichment_data as Record<
          string,
          unknown
        > | null;
        if (orgEnrichment) {
          const searches = orgEnrichment.searches as
            | Array<{ results: Array<{ url: string }> }>
            | undefined;
          if (searches) {
            for (const s of searches) {
              for (const r of s.results) {
                if (r.url) companyUrls.add(r.url);
              }
            }
          }
        }
      }

      const dedup = (
        results: Array<{
          title: string;
          url: string;
          publishedDate: string | null;
          text: string | null;
        }>,
      ) => results.filter((r) => !companyUrls.has(r.url));

      const search = (
        key: "news" | "articles" | "background",
        query: string,
        label: string,
        category?: "news",
      ) =>
        promises.push(
          (async () => {
            try {
              const result = await exa.search(query, {
                numResults: 3,
                includeText: true,
                ...(category ? { category } : {}),
              });
              enrichmentData[key] = dedup(
                result.results.map((r) => ({
                  title: r.title,
                  url: r.url,
                  publishedDate: r.publishedDate,
                  text: r.text || null,
                })),
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Unknown error";
              errors.push(`${label}: ${msg}`);
            }
          })(),
        );

      search("news", `${specificQuery} news announcement`, "News", "news");
      search(
        "articles",
        `${specificQuery} article talk interview podcast`,
        "Articles",
      );
      search(
        "background",
        `${specificQuery} background bio profile`,
        "Background",
      );
    }

    // Nobody to ask: no LinkedIn, no X, and no usable name for a web search.
    if (promises.length === 0) {
      await supabase
        .from("people")
        .update({ enrichment_status: "failed" })
        .eq("id", personId);
      return {
        status: "failed" as const,
        enrichmentData: {},
        errors: ["No enrichment sources available"],
      };
    }

    await Promise.all(promises);

    const status =
      Object.keys(enrichmentData).length > 0 ? "enriched" : "failed";

    await mergeEnrichmentData("people", personId, enrichmentData, status);

    return {
      status,
      enrichmentData,
      errors: errors.length > 0 ? errors : undefined,
    };
  });
}
