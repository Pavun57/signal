import { tool } from "ai";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  callerHoldsOrganization,
  callerHoldsPerson,
  notFound,
  toolSession,
} from "@/lib/tools/ownership";
import { saveOrganizationWebsite } from "@/lib/services/organization-website";
import { parseLinkedInTitle } from "@/lib/utils";
import { ExaService } from "@/lib/services/exa-service";
import { filterRelevantResults } from "@/lib/services/relevance-filter";
import { LinkedinService } from "@/lib/services/linkedin-service";
import { XService } from "@/lib/services/x-service";
import { WebExtractionService } from "@/lib/services/web-extraction-service";
import { GooglePlacesService } from "@/lib/services/google-places-service";
import {
  canHoldPeople,
  findOrCreateOrganization,
  findOrCreatePerson,
  linkPersonToCampaign,
  mergeEnrichmentData,
  isRecentlyEnriched,
  normalizeLinkedInUrl,
} from "@/lib/services/knowledge-base";
import {
  findContactsForOrganization,
  affiliationNotes,
  AFFILIATION_UNCHANGED,
  unchangedEvidence,
} from "@/lib/services/contact-discovery";
import {
  filterContactsByCompany,
  type VerifiedContact,
} from "@/lib/services/contact-filter";
import {
  recordAffiliation,
  AFFILIATION_SEND_THRESHOLD,
  type AffiliationSource,
} from "@/lib/services/affiliation";
import { runDataQualityAudit } from "@/lib/services/data-quality";
import { summarizePerson } from "@/lib/services/enrichment-summarizer";
import { extractClaims } from "@/lib/services/claim-extractor";
import { reconcileClaims } from "@/lib/services/claim-reconciler";
import {
  HIRING_SCRAPE_TIMEOUT_MS,
  tryScrapeHiringData,
} from "@/lib/services/hiring-scraper";
import type { CompanyClaim } from "@/lib/types/claims";
import { withTimeout } from "@/lib/utils/timeout";

/** Ceiling for one company's full enrichment chain. */
const PER_COMPANY_TIMEOUT_MS = 150_000;

/** Rough worst case for one contact-enrichment chunk (Exa + socials). */
const PER_CONTACT_CHUNK_ESTIMATE_MS = 120_000;

/**
 * The chat route puts its turn time budget on experimental_context so batch
 * tools never start a chunk they can't finish before the turn is stopped.
 * Absent outside chat (dedicated API routes, tests) — then no deadline.
 */
function deadlineFrom(experimental_context: unknown): number | null {
  const deadlineAt = (experimental_context as { deadlineAt?: number } | null)
    ?.deadlineAt;
  return typeof deadlineAt === "number" ? deadlineAt : null;
}

export const searchPeople = tool({
  description:
    "Search for people at companies using Exa semantic search with LinkedIn-focused queries. Stores results in the shared knowledge base. When campaignId is provided, links results to the campaign and deduplicates against existing campaign contacts. When the search targets a known company, ALWAYS pass companyName (and companyDomain if known) so results are linked to that organization for the org chart and per-company views.",
  inputSchema: z.object({
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Campaign to associate results with. Omit for ad-hoc search."),
    companyId: z
      .string()
      .uuid()
      .optional()
      .describe("Campaign-organization link ID to associate contacts with"),
    companyName: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Name of the company being searched (e.g. 'Browserbase'). When provided, every stored person is linked to this organization in the knowledge base. Required when searching at a specific company and companyId is not available.",
      ),
    companyDomain: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Company domain like 'browserbase.com'. Used with companyName for accurate organization dedup.",
      ),
    query: z
      .string()
      .min(1)
      .describe(
        'Search query for finding people, e.g. "CTO at Acme Corp site:linkedin.com"',
      ),
    numResults: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Number of results to return"),
  }),
  execute: async (input) => {
    const exa = new ExaService();
    const supabase = await createClient();

    const searchResponse = await exa.search(input.query, {
      numResults: input.numResults,
      category: "people",
      includeText: true,
    });

    // Resolve organization_id. Order of preference:
    //   1. companyId (campaign_organizations link) -- already-scoped campaign work.
    //   2. companyName (+optional companyDomain) -- ad-hoc agent searches like
    //      "find people at Browserbase". findOrCreateOrganization dedups by
    //      domain only; it no longer merges on name, because two different
    //      companies sharing one is exactly how contact lists get pooled.
    let organizationId: string | null = null;
    let orgContext: {
      name: string;
      domain: string | null;
      industry: string | null;
      location: string | null;
      description: string | null;
    } | null = null;

    if (input.companyId) {
      const { data: link } = await supabase
        .from("campaign_organizations")
        .select("organization_id")
        .eq("id", input.companyId)
        .single();
      organizationId = link?.organization_id || null;
    } else if (input.companyName) {
      const org = await findOrCreateOrganization({
        name: input.companyName,
        domain: input.companyDomain ?? null,
        source: "searchPeople",
      });
      organizationId = org.id;
    }

    if (organizationId) {
      const { data: org } = await supabase
        .from("organizations")
        .select("name, domain, industry, location, description")
        .eq("id", organizationId)
        .single();
      orgContext = org ?? null;

      // Same rule as findContacts: a company with no domain cannot be told
      // apart from any other of the same name, so people must not be attached
      // to it. Search still runs — the results are just left unattached.
      if (org && !canHoldPeople(org)) {
        console.warn(
          `[searchPeople] "${org.name}" has no domain; storing results unattached.`,
        );
        organizationId = null;
      }
    }

    // Fetch existing linkedin_urls already linked to this campaign for dedup
    const existingUrls = new Set<string>();
    if (input.campaignId) {
      const { data: existingLinks } = await supabase
        .from("campaign_people")
        .select("person:people(linkedin_url)")
        .eq("campaign_id", input.campaignId);
      for (const l of existingLinks || []) {
        const url = (
          l.person as unknown as { linkedin_url: string | null } | null
        )?.linkedin_url;
        if (url) existingUrls.add(url);
      }
    }

    // Stage 1: parse + dedup Exa results into candidate list (no DB writes yet).
    interface SearchCandidate {
      name: string;
      title: string | null;
      linkedin_url: string | null;
      rawTitle: string;
      text: string | null;
      /** When the scraped page was published. Null when the source is undated. */
      publishedDate: string | null;
    }
    const candidates: SearchCandidate[] = [];
    const seenUrls = new Set<string>();
    let duplicatesSkipped = 0;

    for (const result of searchResponse.results) {
      // Same guards as contact-discovery — the two judge-and-store paths must
      // not disagree on what counts as a person. A linkedin.com URL that is not
      // an /in/ profile (/company/, /school/, /posts/) parses into a "person"
      // named after the page, whose headline then names the target company, so
      // the judge verifies it and a non-person clears the affiliation gate.
      const isLinkedIn = /linkedin\.com/i.test(result.url);
      const isProfile = /linkedin\.com\/in\//i.test(result.url);
      if (isLinkedIn && !isProfile) continue;

      const { name, title } = parseLinkedInTitle(result.title);
      if (!name || name === "Unknown") continue;

      const linkedinUrl = isProfile ? normalizeLinkedInUrl(result.url) : null;

      if (linkedinUrl) {
        if (existingUrls.has(linkedinUrl) || seenUrls.has(linkedinUrl)) {
          duplicatesSkipped++;
          continue;
        }
        seenUrls.add(linkedinUrl);
      }

      candidates.push({
        name,
        title,
        linkedin_url: linkedinUrl,
        rawTitle: result.title,
        text: result.text ?? null,
        publishedDate: result.publishedDate ?? null,
      });
    }

    // Stage 2: judge company membership, then store.
    //
    // This step used to be absent entirely — every search result was stamped
    // with the target organization_id and the tool reported
    // `rejectedAsWrongCompany: 0`, so the agent was told filtering had run and
    // found nothing wrong. It had not run at all. The earlier attempt was
    // removed because it hard-required the company name in the headline, which
    // deletes real employees at small companies; the three-way verdict exists
    // precisely so we no longer have to choose between those two failures.
    const judged: VerifiedContact[] = organizationId
      ? await filterContactsByCompany(
          {
            name: orgContext?.name ?? input.companyName ?? "",
            domain: orgContext?.domain ?? input.companyDomain ?? null,
            industry: orgContext?.industry ?? null,
            location: orgContext?.location ?? null,
            description: orgContext?.description ?? null,
          },
          candidates.map((c) => ({
            name: c.name,
            title: c.title,
            linkedinUrl: c.linkedin_url,
            rawHeadline: c.rawTitle,
            // The search already pays for this text (includeText above) and it
            // usually carries a dated experience section. Capturing it and then
            // dropping it before the judge is why people who had never worked
            // at the target company were stored as staff: a headline that names
            // no employer is the weakest evidence available.
            pageText: c.text,
            pageDate: c.publishedDate,
          })),
        )
      : candidates.map((_, index) => ({
          index,
          name: candidates[index].name,
          title: candidates[index].title,
          verdict: "uncertain" as const,
          evidence: "no company specified for this search",
        }));

    const storedContacts: Array<{
      id: string;
      name: string;
      title: string | null;
      linkedin_url: string | null;
      verdict: string;
      /** Why they are labelled that, so `unchanged` is explicable. */
      evidence: string;
    }> = [];
    let rejectedAsWrongCompany = 0;
    let uncertainCount = 0;
    let departedCount = 0;
    let affiliationUnchanged = 0;

    for (const v of judged) {
      const c = candidates[v.index];
      if (!c) continue;

      const detaching =
        v.verdict === "rejected" || v.verdict === "former_employee";

      // A detached candidate is a real person who works somewhere else, or
      // used to work here. Keep them, unattached, rather than filing them under
      // this company, but only when we can identify them. findOrCreatePerson
      // dedups by LinkedIn URL or by name-within-org; a detached candidate has
      // no org, so one without a profile URL matches neither path and would be
      // INSERTED fresh on every run. Same rule as contact-discovery.
      if (detaching && !c.linkedin_url) {
        if (v.verdict === "rejected") rejectedAsWrongCompany++;
        else departedCount++;
        continue;
      }

      const attachTo = detaching ? null : organizationId;
      const source: AffiliationSource =
        v.verdict === "verified"
          ? "llm_verified"
          : v.verdict === "former_employee"
            ? "former_employee"
            : v.verdict === "rejected"
              ? "employer_mismatch"
              : "search_stamp";

      // Fold what the judge saw into the stored evidence. Without it the row
      // says "profile names a different employer" and the user has to go and
      // look up which one.
      const evidence = v.employerSeen
        ? `${v.evidence} (saw: ${v.employerSeen}${v.datesSeen ? `, ${v.datesSeen}` : ""})`
        : v.evidence;

      const person = await findOrCreatePerson({
        name: v.name,
        title: v.title,
        linkedin_url: c.linkedin_url,
        organization_id: attachTo,
        source: "exa",
      });

      // With no organization there is nothing to affiliate anyone to, so no
      // write is attempted and there is nothing to refuse.
      let refused = false;
      let refusedReason: string | undefined;
      let notAtJudgedOrg = false;
      if (organizationId) {
        const write = await recordAffiliation(supabase, {
          personId: person.id,
          organizationId: attachTo,
          source,
          evidence,
          // The judge was asked about THIS company and answered about it.
          // Without saying so, a detaching write means "detach from wherever
          // you are", so correctly rejecting someone here unlinks them from the
          // unrelated company they actually work at. Same rule as
          // contact-discovery, deliberately.
          detachedFrom: detaching ? organizationId : null,
        });
        refused = !write.written;
        refusedReason = write.reason;
        notAtJudgedOrg = write.notAtJudgedOrg === true;
      }

      if (person.enrichment_status === "pending") {
        await supabase
          .from("people")
          .update({
            enrichment_data: {
              searchQuery: input.query,
              rawTitle: c.rawTitle,
              text: c.text?.slice(0, 1000),
            },
          })
          .eq("id", person.id);
      }

      // The verdict is what the judge concluded; the write is what actually
      // happened to the row. They diverge whenever the stored evidence outranks
      // this search, and counting the verdict regardless produced two opposite
      // lies: a refused attach reported as a verified contact (organization_id
      // still null, blocked at the send gate), and a refused detach reported as
      // departed and dropped from the list while the person stayed attached and
      // fully sendable. Same rule as contact-discovery, deliberately.
      //
      // The one refusal that does NOT mean "leave them in the list": the person
      // is filed under a different company, so nothing here was ever about
      // them. They are not a contact at this company, and reporting them as an
      // unchanged one is the same lie in a quieter voice.
      if (notAtJudgedOrg) {
        if (v.verdict === "rejected") rejectedAsWrongCompany++;
        else departedCount++;
        continue;
      }

      if (refused) {
        affiliationUnchanged++;
      } else if (v.verdict === "rejected") {
        rejectedAsWrongCompany++;
        continue;
      } else if (v.verdict === "former_employee") {
        departedCount++;
        continue;
      } else if (v.verdict === "uncertain") {
        uncertainCount++;
      }

      // Only ever link someone this search meant to keep. A refused detach
      // still belongs in the contact list (they are attached, and hiding that
      // is the bug), but adding them to the campaign would act on the
      // judgement the write just refused.
      if (input.campaignId && !detaching) {
        await linkPersonToCampaign(person.id, input.campaignId);
      }

      storedContacts.push({
        id: person.id,
        name: person.name,
        title: person.title,
        linkedin_url: person.linkedin_url,
        verdict: refused ? AFFILIATION_UNCHANGED : v.verdict,
        evidence: refused
          ? unchangedEvidence(refusedReason, evidence)
          : evidence,
      });
    }

    // These counts describe people the agent will not find in `contacts`, so
    // saying nothing about them reads as "the search found fewer people" rather
    // than "some of what it found was not staff here".
    const note = affiliationNotes({
      uncertainCount,
      departedCount,
      affiliationUnchanged,
    });

    return {
      contacts: storedContacts.map((c) => ({
        id: c.id,
        name: c.name,
        title: c.title,
        linkedinUrl: c.linkedin_url,
        affiliation: c.verdict,
        affiliationEvidence: c.evidence,
      })),
      organizationId,
      totalFound: searchResponse.resultCount,
      newContacts: storedContacts.length,
      duplicatesSkipped,
      uncertainCount,
      rejectedAsWrongCompany,
      departedCount,
      affiliationUnchanged,
      query: input.query,
      note,
    };
  },
});

export function summarizeContactEnrichment(
  data: Record<string, unknown>,
): Record<string, number | boolean> {
  const s: Record<string, number | boolean> = {};
  if (data.linkedin) s.hasLinkedin = true;
  if (data.twitter) s.hasTwitter = true;
  if (Array.isArray(data.news)) s.news = data.news.length;
  if (Array.isArray(data.articles)) s.articles = data.articles.length;
  if (Array.isArray(data.background)) s.background = data.background.length;
  if (data.discoveredEmail) s.discoveredEmail = true;
  return s;
}

/**
 * A scraped search result as the person summarizer needs it. The date is the
 * load-bearing field: it is what lets the summarizer tell a live page from a
 * year-old archive that still says "Present".
 */
type SummarySource = {
  title: string;
  url: string;
  publishedDate: string | null;
  text: string | null;
};

async function enrichContactById(
  personId: string,
  linkedinUrl?: string,
  twitterUrl?: string,
): Promise<{
  contactId: string;
  status: string;
  summary: Record<string, number | boolean>;
  skipped?: boolean;
  errors?: string[];
}> {
  const supabase = await createClient();

  // Check recency -- skip if recently enriched
  const recent = await isRecentlyEnriched("people", personId);
  if (recent) {
    const { data: person } = await supabase
      .from("people")
      .select("enrichment_data")
      .eq("id", personId)
      .single();
    return {
      contactId: personId,
      status: "enriched",
      summary: summarizeContactEnrichment(
        (person?.enrichment_data as Record<string, unknown>) || {},
      ),
      skipped: true,
    };
  }

  const { data: person } = await supabase
    .from("people")
    .select(
      "name, title, linkedin_url, twitter_url, organization:organizations(name)",
    )
    .eq("id", personId)
    .single();

  const contactName = person?.name || "Unknown";
  const companyName =
    (person?.organization as unknown as { name?: string } | null)?.name || null;
  const linkedinFinal = linkedinUrl || person?.linkedin_url || undefined;
  const twitterFinal = twitterUrl || person?.twitter_url || undefined;

  await supabase
    .from("people")
    .update({ enrichment_status: "in_progress" })
    .eq("id", personId);

  const enrichmentData: Record<string, unknown> = {};
  const errors: string[] = [];
  const promises: Promise<void>[] = [];

  if (linkedinFinal) {
    promises.push(
      (async () => {
        try {
          const linkedin = new LinkedinService();
          const scrapeResult = await linkedin.scrapeProfile(linkedinFinal);
          enrichmentData.linkedin = {
            profileInfo: scrapeResult.profile || null,
            posts: scrapeResult.posts.slice(0, 10),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          console.error(`[enrichContact] LinkedIn scrape failed: ${msg}`);
          errors.push(`LinkedIn: ${msg}`);
        }
      })(),
    );
  }

  if (twitterFinal) {
    promises.push(
      (async () => {
        try {
          const x = new XService();
          const result = await x.enrichTwitterProfile(twitterFinal);
          enrichmentData.twitter = {
            user: result.user,
            tweets: result.tweets.slice(0, 10),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          console.error(`[enrichContact] Twitter enrich failed: ${msg}`);
          errors.push(`Twitter: ${msg}`);
        }
      })(),
    );
  }

  if (contactName !== "Unknown") {
    const exa = new ExaService();
    const contactTitle = person?.title || null;
    const queryParts = [`"${contactName}"`];
    if (companyName) queryParts.push(`"${companyName}"`);
    if (contactTitle) queryParts.push(contactTitle);
    const specificQuery = queryParts.join(" ");

    // Collect URLs already in the company's enrichment data so we don't
    // show the same links on both the company and contact cards.
    const companyUrls = new Set<string>();
    if (person?.organization) {
      const orgName = (person.organization as unknown as { name?: string })
        ?.name;
      if (orgName) {
        const { data: orgRow } = await supabase
          .from("organizations")
          .select("enrichment_data")
          .eq("name", orgName)
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
    }

    const dedup = (results: SummarySource[]) =>
      results.filter((r) => !companyUrls.has(r.url));

    promises.push(
      (async () => {
        try {
          const result = await exa.search(
            `${specificQuery} news announcement`,
            { numResults: 3, includeText: true, category: "news" },
          );
          enrichmentData.news = dedup(
            result.results.map((r) => ({
              title: r.title,
              url: r.url,
              publishedDate: r.publishedDate,
              text: r.text || null,
            })),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          errors.push(`News: ${msg}`);
        }
      })(),
    );

    promises.push(
      (async () => {
        try {
          const result = await exa.search(
            `${specificQuery} article talk interview podcast`,
            { numResults: 3, includeText: true },
          );
          enrichmentData.articles = dedup(
            result.results.map((r) => ({
              title: r.title,
              url: r.url,
              publishedDate: r.publishedDate,
              text: r.text || null,
            })),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          errors.push(`Articles: ${msg}`);
        }
      })(),
    );

    promises.push(
      (async () => {
        try {
          const result = await exa.search(
            `${specificQuery} background bio profile`,
            { numResults: 3, includeText: true },
          );
          enrichmentData.background = dedup(
            result.results.map((r) => ({
              title: r.title,
              url: r.url,
              publishedDate: r.publishedDate,
              text: r.text || null,
            })),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          errors.push(`Background: ${msg}`);
        }
      })(),
    );
  }

  await Promise.all(promises);

  const status = Object.keys(enrichmentData).length > 0 ? "enriched" : "failed";

  await mergeEnrichmentData(
    "people",
    personId,
    enrichmentData,
    status as "enriched" | "failed",
  );

  // ── Bio summary ──────────────────────────────────────────────────────
  // Generate a short blurb from whatever we just collected so the user
  // gets a quick read at the top of the person drawer. Best-effort: a
  // failure here doesn't fail enrichment.
  if (status === "enriched") {
    try {
      const linkedin = enrichmentData.linkedin as
        | {
            profileInfo?: { headline?: string } | null;
            posts?: Array<{ text: string }>;
          }
        | undefined;
      const twitter = enrichmentData.twitter as
        | {
            user?: { description?: string };
            tweets?: Array<{ text: string }>;
          }
        | undefined;
      const summarized = await summarizePerson({
        name: contactName,
        title: person?.title ?? null,
        companyName,
        linkedinHeadline: linkedin?.profileInfo?.headline ?? null,
        twitterBio: twitter?.user?.description ?? null,
        linkedinPosts: linkedin?.posts,
        tweets: twitter?.tweets,
        // publishedDate rides along: the summarizer orders the sources by it,
        // and casting it away here is what left it with undated blobs.
        news: enrichmentData.news as SummarySource[] | undefined,
        articles: enrichmentData.articles as SummarySource[] | undefined,
        background: enrichmentData.background as SummarySource[] | undefined,
      });
      // Write the title back, not just the prose. Enrichment reads the real
      // title off the profile and used to spend it entirely on `bio_summary`,
      // so a person discovered with a wrong title kept it forever: the drawer
      // said "Head of GTM / Revenue Ops" while the org chart, the scoring and
      // any draft email all still read "Head of Growth" off `people.title`.
      // Enrichment is the correcting step, so let it correct.
      //
      // The one exception is a conflict: when the freshest source names a
      // different employer than an older one, `currentTitle` is a guess
      // between two stories, and the guess it used to make was the wrong one
      // (an archived snapshot saying "Present" beat a live headline). Keep the
      // prose, which now says the sources disagree, and leave the stored title
      // alone rather than trading a stale title for a different stale title.
      const update: { bio_summary?: string; title?: string } = {};
      if (summarized?.summary) update.bio_summary = summarized.summary;
      if (summarized?.currentTitle && !summarized.sourcesConflict)
        update.title = summarized.currentTitle;

      if (Object.keys(update).length > 0) {
        await supabase.from("people").update(update).eq("id", personId);
      }
    } catch (err) {
      console.error("[enrichContact] bio summary failed:", err);
    }
  }

  // ── Email discovery ──────────────────────────────────────────────────
  // If the contact has no email after enrichment, try to find one.
  const { data: personAfter } = await supabase
    .from("people")
    .select("work_email, personal_email, affiliation_confidence")
    .eq("id", personId)
    .single();

  // Email discovery costs a provider credit and, more importantly, mints a
  // company-domain address that the user reads as proof of employment. Six
  // people who never worked at Browserbase each acquired a plausible
  // firstname@browserbase.com this way. Neither cost is justified below the
  // send threshold: those contacts are blocked from outreach anyway, so the
  // address could not be used even if it happened to be right. A null reads as
  // unconfirmed, which is the safe way round.
  const confirmed =
    (personAfter?.affiliation_confidence ?? 0) >= AFFILIATION_SEND_THRESHOLD;

  if (confirmed && !personAfter?.work_email && !personAfter?.personal_email) {
    try {
      const { findEmailForPerson } = await import("@/lib/tools/email-tools");
      const emailResult = await findEmailForPerson(personId);
      if (emailResult.email) {
        enrichmentData.discoveredEmail = emailResult.email;
      }
    } catch {
      // Email discovery is best-effort -- don't fail enrichment
    }
  }

  return {
    contactId: personId,
    status,
    summary: summarizeContactEnrichment(enrichmentData),
    errors: errors.length > 0 ? errors : undefined,
  };
}

export const enrichContact = tool({
  description:
    "Enrich a single contact and write results to the DB. Returns a THIN summary (counts of news/articles, has-linkedin flags) -- NOT the full enrichment payload. If you need to read the enriched content (e.g. to personalize an email), call getContactDetail(personId). For multiple contacts, use enrichContacts (parallel). Skips if recently enriched (<7 days).",
  inputSchema: z.object({
    contactId: z.string().uuid().describe("Person ID to enrich"),
    linkedinUrl: z
      .string()
      .optional()
      .describe(
        "LinkedIn profile URL (if omitted, uses the one stored on the person)",
      ),
    twitterUrl: z
      .string()
      .optional()
      .describe(
        "Twitter/X profile URL (if omitted, uses the one stored on the person)",
      ),
  }),
  execute: async (input) =>
    enrichContactById(input.contactId, input.linkedinUrl, input.twitterUrl),
});

export const enrichContacts = tool({
  description:
    "Enrich multiple contacts IN PARALLEL. Much faster than calling enrichContact one by one. Skips any person recently enriched (within 7 days).",
  inputSchema: z.object({
    contactIds: z
      .array(z.string().uuid())
      .min(1)
      .max(10)
      .describe("Array of person IDs to enrich (max 10)"),
  }),
  execute: async (input, { experimental_context }) => {
    const deadlineAt = deadlineFrom(experimental_context);
    const succeeded: Array<{
      contactId: string;
      status: string;
      skipped?: boolean;
    }> = [];
    const failed: Array<{ contactId: string; error: string }> = [];
    let deferred: string[] = [];

    // Process in chunks of 3 to stay under Exa's 10 QPS limit
    // (each contact makes 3-4 Exa searches)
    const CHUNK_SIZE = 3;
    for (let i = 0; i < input.contactIds.length; i += CHUNK_SIZE) {
      // Same turn-budget guard as enrichCompanies (see deadlineFrom).
      if (
        deadlineAt &&
        deadlineAt - Date.now() < PER_CONTACT_CHUNK_ESTIMATE_MS
      ) {
        deferred = input.contactIds.slice(i);
        break;
      }
      const chunk = input.contactIds.slice(i, i + CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map((id) => enrichContactById(id)),
      );

      results.forEach((result, j) => {
        if (result.status === "fulfilled") {
          succeeded.push({
            contactId: result.value.contactId,
            status: result.value.status,
            skipped: result.value.skipped,
          });
        } else {
          failed.push({
            contactId: chunk[j],
            error:
              result.reason instanceof Error
                ? result.reason.message
                : "Unknown error",
          });
        }
      });
    }

    return {
      total: input.contactIds.length,
      succeeded: succeeded.length,
      failed: failed.length,
      results: succeeded,
      errors: failed.length > 0 ? failed : undefined,
      deferred: deferred.length > 0 ? deferred : undefined,
      note:
        deferred.length > 0
          ? "Turn time budget ran out before these contacts were enriched. They were NOT processed. Call enrichContacts again with the `deferred` IDs to finish."
          : undefined,
    };
  },
});

export const fetchSitemap = tool({
  description:
    "Fetch and parse a website's sitemap to discover available pages. Returns a list of URLs with last-modified dates. Use this to understand what content a company has on their site, then selectively fetch the most relevant pages with extractWebContent.",
  inputSchema: z.object({
    domain: z
      .string()
      .describe(
        "Domain to fetch sitemap from (e.g. 'acme.com'). Will try /sitemap.xml and /sitemap_index.xml.",
      ),
  }),
  execute: async (input) => {
    const domain = input.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const urls: Array<{ url: string; lastmod?: string; priority?: string }> =
      [];
    const errors: string[] = [];

    const sitemapUrls = [
      `https://${domain}/sitemap.xml`,
      `https://${domain}/sitemap_index.xml`,
    ];

    for (const sitemapUrl of sitemapUrls) {
      try {
        const response = await fetch(sitemapUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; FridayBot/1.0)",
            Accept: "application/xml, text/xml, */*",
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) continue;

        const text = await response.text();
        if (!text.includes("<urlset") && !text.includes("<sitemapindex"))
          continue;

        const cheerio = await import("cheerio");
        const $ = cheerio.load(text, { xmlMode: true });

        // Handle sitemap index -- collect child sitemap URLs
        const childSitemaps: string[] = [];
        $("sitemapindex > sitemap > loc").each((_, el) => {
          childSitemaps.push($(el).text().trim());
        });

        if (childSitemaps.length > 0) {
          // Fetch up to 3 child sitemaps
          const childResults = await Promise.allSettled(
            childSitemaps.slice(0, 3).map(async (childUrl) => {
              const res = await fetch(childUrl, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (compatible; FridayBot/1.0)",
                },
                signal: AbortSignal.timeout(10000),
              });
              if (!res.ok) return;
              const childText = await res.text();
              const child$ = cheerio.load(childText, { xmlMode: true });
              child$("url").each((_, el) => {
                urls.push({
                  url: child$(el).find("loc").text().trim(),
                  lastmod:
                    child$(el).find("lastmod").text().trim() || undefined,
                  priority:
                    child$(el).find("priority").text().trim() || undefined,
                });
              });
            }),
          );
          for (const r of childResults) {
            if (r.status === "rejected") {
              errors.push(r.reason?.message || "Child sitemap failed");
            }
          }
        }

        // Handle regular sitemap
        $("urlset > url").each((_, el) => {
          urls.push({
            url: $(el).find("loc").text().trim(),
            lastmod: $(el).find("lastmod").text().trim() || undefined,
            priority: $(el).find("priority").text().trim() || undefined,
          });
        });

        if (urls.length > 0) break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        errors.push(`${sitemapUrl}: ${msg}`);
      }
    }

    // If no sitemap found, fall back to fetching homepage links
    if (urls.length === 0) {
      try {
        const extractor = new WebExtractionService();
        const result = await extractor.extract(`https://${domain}`, {
          includeLinks: true,
        });
        if (result.success && result.data.links) {
          const sameDomainLinks = result.data.links.filter((link) => {
            try {
              return new URL(link).hostname.endsWith(domain);
            } catch {
              return false;
            }
          });
          return {
            domain,
            source: "homepage_links",
            urls: sameDomainLinks.slice(0, 50).map((url) => ({ url })),
            total: sameDomainLinks.length,
            errors: errors.length > 0 ? errors : undefined,
          };
        }
      } catch {
        // ignore
      }
    }

    return {
      domain,
      source: urls.length > 0 ? "sitemap" : "none",
      urls: urls.slice(0, 100),
      total: urls.length,
      errors: errors.length > 0 ? errors : undefined,
    };
  },
});

export const extractWebContent = tool({
  description:
    "Extract content from a web page. Three-tier fallback: (1) direct HTTP fetch, (2) Browserbase Fetch with proxies, (3) full browser session. Returns TRUNCATED content (first 3000 chars) and up to 20 links to keep context small. `truncated` flags indicate if more exists; if you need more, refine the URL or call a different page. Use for About/Team/Leadership pages when finding contacts.",
  inputSchema: z.object({
    url: z.string().url().describe("URL to extract content from"),
    includeLinks: z
      .boolean()
      .default(false)
      .describe("Include all links found on the page"),
  }),
  execute: async (input, { toolCallId, experimental_context }) => {
    const ctx = experimental_context as
      | { writer?: { write: (chunk: unknown) => void } }
      | undefined;
    const writer = ctx?.writer;

    const extractor = new WebExtractionService();
    const raw = await extractor.extract(input.url, {
      includeLinks: input.includeLinks,
      onLiveView: writer
        ? (liveViewUrl) =>
            writer.write({
              type: "data-browserbaseLiveView",
              id: toolCallId,
              data: { url: liveViewUrl },
              transient: true,
            })
        : undefined,
    });

    if (!raw.success) return raw;

    const MAX_CONTENT = 3000;
    const MAX_LINKS = 20;
    const fullContent = raw.data.content ?? "";
    const fullLinks = raw.data.links ?? [];
    const truncated = {
      content: fullContent.length > MAX_CONTENT,
      links: fullLinks.length > MAX_LINKS,
    };

    return {
      ...raw,
      data: {
        ...raw.data,
        content: fullContent.slice(0, MAX_CONTENT),
        links: input.includeLinks ? fullLinks.slice(0, MAX_LINKS) : undefined,
      },
      truncated,
    };
  },
});

export const scrapeJobListings = tool({
  description:
    "Research a single company's hiring activity by navigating their website with a real browser. For multiple companies, use scrapeJobListingsBatch instead -- it runs them in parallel.",
  inputSchema: z.object({
    organizationId: z
      .string()
      .uuid()
      .describe("Organization ID to attach hiring data to"),
    domain: z
      .string()
      .describe(
        "Company domain (e.g. 'stripe.com'). The browser will navigate to the site and find the careers page.",
      ),
    maxJobs: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Maximum number of jobs to extract"),
  }),
  execute: async (input) => {
    const { scrapeHiringData } = await import("@/lib/services/hiring-scraper");
    const result = await scrapeHiringData(
      input.organizationId,
      input.domain,
      input.maxJobs,
    );
    return {
      organizationId: input.organizationId,
      domain: input.domain,
      careersUrl: result.careersUrl,
      totalJobs: result.totalJobs,
      jobs: result.jobs,
      ...(!result.careersUrl
        ? { message: "No careers page found on this website." }
        : {}),
    };
  },
});

export const scrapeJobListingsBatch = tool({
  description:
    "Research hiring activity for multiple companies IN PARALLEL. Much faster than calling scrapeJobListings one by one. Each company gets its own browser session running concurrently.",
  inputSchema: z.object({
    companies: z
      .array(
        z.object({
          organizationId: z.string().uuid().describe("Organization ID"),
          domain: z.string().describe("Company domain (e.g. 'stripe.com')"),
        }),
      )
      .min(1)
      .max(10)
      .describe("Array of companies to scrape (max 10)"),
    maxJobs: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Maximum number of jobs to extract per company"),
  }),
  execute: async (input) => {
    const { scrapeHiringData } = await import("@/lib/services/hiring-scraper");

    const results = await Promise.allSettled(
      input.companies.map(async (company) => {
        const result = await scrapeHiringData(
          company.organizationId,
          company.domain,
          input.maxJobs,
        );
        return {
          organizationId: company.organizationId,
          domain: company.domain,
          careersUrl: result.careersUrl,
          totalJobs: result.totalJobs,
          jobs: result.jobs,
        };
      }),
    );

    const succeeded: Array<{
      organizationId: string;
      domain: string;
      totalJobs: number;
      careersUrl: string | null;
    }> = [];
    const failed: Array<{
      organizationId: string;
      domain: string;
      error: string;
    }> = [];

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        succeeded.push({
          organizationId: result.value.organizationId,
          domain: result.value.domain,
          totalJobs: result.value.totalJobs,
          careersUrl: result.value.careersUrl,
        });
      } else {
        failed.push({
          organizationId: input.companies[i].organizationId,
          domain: input.companies[i].domain,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown error",
        });
      }
    });

    return {
      total: input.companies.length,
      succeeded: succeeded.length,
      failed: failed.length,
      results: succeeded,
      errors: failed.length > 0 ? failed : undefined,
    };
  },
});

async function resolveOrganizationId(idOrLinkId: string): Promise<string> {
  const supabase = await createClient();

  // Try as organization ID first
  const { data: directOrg } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", idOrLinkId)
    .maybeSingle();

  if (directOrg) return directOrg.id;

  // Try as campaign_organizations link ID
  const { data: link } = await supabase
    .from("campaign_organizations")
    .select("organization_id")
    .eq("id", idOrLinkId)
    .maybeSingle();

  if (link) return link.organization_id;

  throw new Error(`Organization not found for ID: ${idOrLinkId}`);
}

export function summarizeCompanyEnrichment(
  data: Record<string, unknown>,
): Record<string, number | boolean> {
  const s: Record<string, number | boolean> = {};
  const site = data.website as Record<string, unknown> | undefined;
  if (site) {
    s.hasWebsite = true;
    const contact = site.emails as string[] | undefined;
    if (Array.isArray(contact)) s.websiteEmails = contact.length;
  }
  const searches = data.searches as
    | Array<{ category?: string; results: unknown[] }>
    | undefined;
  if (Array.isArray(searches)) {
    for (const sr of searches) {
      const cat = sr.category;
      const n = Array.isArray(sr.results) ? sr.results.length : 0;
      if (cat) s[`${cat}Results`] = n;
    }
  }
  s.claims = (data.claims as unknown[] | undefined)?.length ?? 0;
  s.hiringScraped = Boolean(data.hiring);
  return s;
}

async function enrichCompanyById(
  companyIdOrLinkId: string,
  campaignId?: string,
): Promise<{
  companyId: string;
  companyName: string;
  domain: string | null;
  summary: Record<string, number | boolean>;
  skipped?: boolean;
  icp?: Record<string, unknown>;
  errors?: string[];
}> {
  const supabase = await createClient();
  const organizationId = await resolveOrganizationId(companyIdOrLinkId);

  // Check recency -- skip if recently enriched
  const recent = await isRecentlyEnriched("organizations", organizationId);
  if (recent) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name, domain, enrichment_data")
      .eq("id", organizationId)
      .single();
    return {
      companyId: organizationId,
      companyName: org?.name || "Unknown",
      domain: org?.domain || null,
      summary: summarizeCompanyEnrichment(
        (org?.enrichment_data as Record<string, unknown>) || {},
      ),
      skipped: true,
    };
  }

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", organizationId)
    .single();

  if (orgError || !org) {
    throw new Error(
      `Organization not found: ${orgError?.message || "Unknown"}`,
    );
  }

  let icp: Record<string, unknown> | null = null;
  if (campaignId) {
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("icp")
      .eq("id", campaignId)
      .single();
    icp = (campaign?.icp as Record<string, unknown>) || null;
  }

  const exa = new ExaService();
  const extractor = new WebExtractionService();
  const errors: string[] = [];

  const companyUrl = org.url || (org.domain ? `https://${org.domain}` : null);

  const contextParts: string[] = [];
  if (org.industry) contextParts.push(org.industry as string);
  if (org.location) contextParts.push(org.location as string);
  const context = contextParts.length > 0 ? ` ${contextParts.join(" ")}` : "";
  const domainHint = org.domain ? ` ${org.domain}` : "";
  const specificName = `"${org.name}"${domainHint}${context}`;

  const companyDomain =
    org.domain || (companyUrl ? new URL(companyUrl).hostname : null);

  const productQuery = companyDomain
    ? `${org.name} products services`
    : `${specificName} product services offering`;
  const fundingQuery = `${specificName} funding news announcement`;
  const teamQuery = `${specificName} team employees company size`;

  const [
    websiteResult,
    productResult,
    fundingResult,
    teamResult,
    hiringResult,
  ] = await Promise.allSettled([
    companyUrl
      ? extractor.extract(companyUrl, { includeLinks: false })
      : Promise.resolve(null),
    exa.search(productQuery, {
      numResults: 5,
      includeText: true,
      ...(companyDomain ? { includeDomains: [companyDomain] } : {}),
    }),
    exa.search(fundingQuery, {
      numResults: 5,
      includeText: true,
      category: "news",
    }),
    exa.search(teamQuery, {
      numResults: 5,
      includeText: true,
    }),
    // Bounded: Stagehand's observe/act/extract steps have no timeouts of
    // their own, and an unbounded scrape would pierce PER_COMPANY_TIMEOUT_MS
    // and fail the whole company. On timeout allSettled records a rejection,
    // careers stays null, and hiring is reported unknown, which is the
    // designed fail-open behavior.
    org.domain
      ? withTimeout(
          tryScrapeHiringData(organizationId, org.domain as string),
          HIRING_SCRAPE_TIMEOUT_MS,
          `Careers scrape ${org.domain}`,
        )
      : Promise.resolve(null),
  ]);

  const enrichmentData: Record<string, unknown> = {
    enrichedAt: new Date().toISOString(),
  };

  if (websiteResult.status === "fulfilled" && websiteResult.value?.success) {
    const wd = websiteResult.value.data;
    enrichmentData.website = {
      title: wd.title,
      description: wd.description,
      content: wd.content.slice(0, 3000),
      openGraph: wd.openGraph,
      emails: wd.contactInfo?.emails,
      phones: wd.contactInfo?.phones,
      address: wd.contactInfo?.address,
    };
  } else if (websiteResult.status === "rejected") {
    errors.push(`Website: ${websiteResult.reason?.message || "Failed"}`);
  }

  const searches: Array<{
    category: string;
    query: string;
    results: Array<{
      title: string;
      url: string;
      publishedDate: string | null;
      text: string | null;
    }>;
  }> = [];

  const searchEntries = [
    ["product", productResult, productQuery],
    ["funding", fundingResult, fundingQuery],
    ["team", teamResult, teamQuery],
  ] as const;

  for (const [label, result, query] of searchEntries) {
    if (result.status === "fulfilled") {
      const mapped = result.value.results.map(
        (r: {
          title: string;
          url: string;
          publishedDate: string | null;
          text: string | null;
        }) => ({
          title: r.title,
          url: r.url,
          publishedDate: r.publishedDate,
          text: r.text?.slice(0, 2000) || null,
        }),
      );
      const filtered = await filterRelevantResults(
        org.name as string,
        companyDomain,
        mapped,
      );
      searches.push({
        category: label,
        query,
        results: filtered.slice(0, 3),
      });
    } else {
      errors.push(`Search (${label}): ${result.reason?.message || "Failed"}`);
    }
  }

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

  enrichmentData.searches = searches;
  if (errors.length > 0) enrichmentData.errors = errors;

  await mergeEnrichmentData("organizations", organizationId, enrichmentData);

  return {
    companyId: organizationId,
    companyName: org.name as string,
    domain: org.domain as string | null,
    // The scraper persists enrichment_data.hiring itself, so overlay the
    // scrape result here so the thin summary reflects what this run got.
    summary: summarizeCompanyEnrichment(
      careers ? { ...enrichmentData, hiring: careers } : enrichmentData,
    ),
    icp: icp || undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export const enrichCompany = tool({
  description:
    "Deeply research a single company and write results to the DB. Returns a THIN summary (counts of searches by category, has-website flag) -- NOT the raw enrichment payload. To read the actual enrichment (website content, Exa results), call getCompanyDetail(organizationId). For multiple companies use enrichCompanies. Skips if recently enriched (<7 days).",
  inputSchema: z.object({
    companyId: z
      .string()
      .uuid()
      .describe("Organization ID or campaign-organization link ID to enrich"),
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Campaign ID to load ICP context for scoring."),
  }),
  execute: async (input) =>
    enrichCompanyById(input.companyId, input.campaignId),
});

export const enrichCompanies = tool({
  description:
    "Deeply research multiple companies IN PARALLEL. Much faster than calling enrichCompany one by one. Skips any organization recently enriched (within 7 days).",
  inputSchema: z.object({
    companyIds: z
      .array(z.string().uuid())
      .min(1)
      .max(10)
      .describe(
        "Array of organization IDs or campaign-organization link IDs to enrich (max 10)",
      ),
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Campaign ID to load ICP context for scoring."),
  }),
  execute: async (input, { experimental_context }) => {
    const deadlineAt = deadlineFrom(experimental_context);
    const succeeded: Array<{
      companyId: string;
      companyName: string;
      domain: string | null;
      skipped?: boolean;
    }> = [];
    const failed: Array<{ companyId: string; error: string }> = [];
    let deferred: string[] = [];

    // Process in chunks of 3 to stay under Exa's 10 QPS limit
    // (each company makes 3-4 Exa searches)
    const CHUNK_SIZE = 3;
    for (let i = 0; i < input.companyIds.length; i += CHUNK_SIZE) {
      // Don't start a chunk the turn budget can't absorb: a full batch can
      // legally run CHUNKS × 150s, longer than the whole chat turn.
      if (deadlineAt && deadlineAt - Date.now() < PER_COMPANY_TIMEOUT_MS) {
        deferred = input.companyIds.slice(i);
        break;
      }
      const chunk = input.companyIds.slice(i, i + CHUNK_SIZE);
      // Bound each company. Every downstream call has its own timeout, but
      // one company chains enough of them (fetch → Browserbase fetch →
      // browser session → several Exa searches → summarization) that a slow
      // site could still hold the whole batch — and the batch holds the
      // agent's turn, which just looks frozen.
      const results = await Promise.allSettled(
        chunk.map((id) =>
          withTimeout(
            enrichCompanyById(id, input.campaignId),
            PER_COMPANY_TIMEOUT_MS,
            `Enrich company ${id}`,
          ),
        ),
      );

      results.forEach((result, j) => {
        if (result.status === "fulfilled") {
          succeeded.push({
            companyId: result.value.companyId,
            companyName: result.value.companyName,
            domain: result.value.domain,
            skipped: result.value.skipped,
          });
        } else {
          failed.push({
            companyId: chunk[j],
            error:
              result.reason instanceof Error
                ? result.reason.message
                : "Unknown error",
          });
        }
      });
    }

    return {
      total: input.companyIds.length,
      succeeded: succeeded.length,
      failed: failed.length,
      results: succeeded,
      errors: failed.length > 0 ? failed : undefined,
      deferred: deferred.length > 0 ? deferred : undefined,
      note:
        deferred.length > 0
          ? "Turn time budget ran out before these companies were enriched. They were NOT processed. Call enrichCompanies again with the `deferred` IDs to finish."
          : undefined,
    };
  },
});

export const setCompanyWebsite = tool({
  description:
    "Save the website of a company that has none on record, so contacts can be attached to it. Pass url when you know the address; pass resolve: true to look it up (Google Places, then a web search). Use this instead of re-running searchCompanies with a domain, which creates a SECOND company row and leaves the original unusable. If another company already holds that domain, the two are merged and the response says so.",
  inputSchema: z.object({
    organizationId: z
      .string()
      .uuid()
      .describe("organizations.id (not campaign_organizations.id)."),
    url: z
      .string()
      .optional()
      .describe(
        "The company's own web address. Omit to have it looked up instead.",
      ),
    resolve: z
      .boolean()
      .optional()
      .describe("Look the website up. Ignored when url is given."),
  }),
  execute: async (input) => {
    // `organizations` is a shared pool with no owner column, so reading or
    // writing the row says nothing about whether the caller may have it. The
    // campaign link is the only thing that does.
    const session = await toolSession();
    if (!session) {
      return {
        error:
          "No authenticated session available in tool context. Ask the user to sign in.",
      };
    }
    const { supabase, userId } = session;

    if (
      !(await callerHoldsOrganization(supabase, userId, input.organizationId))
    ) {
      return notFound("Company");
    }

    const result = await saveOrganizationWebsite(supabase, {
      organizationId: input.organizationId,
      url: input.url ?? null,
      resolve: input.resolve ?? !input.url,
    });

    if (!result.ok) return { error: result.error };
    return result;
  },
});

export const findContacts = tool({
  description:
    "Find contacts at a specific company by searching for target titles on LinkedIn. When campaignId is provided, uses the campaign's ICP target titles and links contacts to the campaign. When used without a campaign, requires explicit titles. Pass either companyId (campaign-organization link) or organizationId (direct).",
  inputSchema: z.object({
    companyId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Campaign-organization link ID. Use when working within a campaign.",
      ),
    organizationId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Organization ID from the shared knowledge base. Use for ad-hoc search without a campaign.",
      ),
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Campaign ID to get ICP target titles and associate contacts with. Omit for ad-hoc search.",
      ),
    titles: z
      .array(z.string())
      .optional()
      .describe(
        "Target titles to search for. Required when no campaignId is provided. If omitted, uses campaign ICP targetTitles.",
      ),
    numResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("Number of results per title search"),
  }),
  execute: async (input) => {
    if (!input.companyId && !input.organizationId) {
      throw new Error(
        "Either companyId (campaign-organization link ID) or organizationId (organization ID) is required.",
      );
    }

    const supabase = await createClient();

    // Resolve target titles from campaign ICP or explicit input
    let targetTitles: string[] = input.titles || [];
    if (targetTitles.length === 0 && input.campaignId) {
      const { data: campaign } = await supabase
        .from("campaigns")
        .select("icp")
        .eq("id", input.campaignId)
        .single();
      const campaignIcp = campaign?.icp as Record<string, unknown> | null;
      targetTitles = (campaignIcp?.targetTitles as string[] | undefined) || [];
    }

    if (targetTitles.length === 0) {
      return {
        contacts: [],
        error:
          "No target titles provided. Pass titles explicitly or use a campaign with ICP targetTitles set.",
      };
    }

    // Resolve the organization — either via the campaign link or directly.
    let orgId: string;
    if (input.companyId) {
      const { data: link, error: linkError } = await supabase
        .from("campaign_organizations")
        .select("organization_id")
        .eq("id", input.companyId)
        .single();
      if (linkError || !link) {
        throw new Error(
          `Company not found: ${linkError?.message || "Unknown"}`,
        );
      }
      orgId = link.organization_id;
    } else {
      orgId = input.organizationId!;
    }

    const result = await findContactsForOrganization(supabase, {
      organizationId: orgId,
      campaignId: input.campaignId ?? null,
      titles: targetTitles,
      numResults: input.numResults,
    });

    return {
      companyId: input.companyId,
      companyName: result.companyName,
      targetTitles,
      contacts: result.contacts,
      alreadyLinked: result.alreadyLinked,
      alreadyLinkedTotal: result.alreadyLinkedTotal,
      searchesRun: result.searchesRun,
      totalFound: result.totalFound,
      duplicatesSkipped: result.duplicatesSkipped,
      // Real counts. These used to report `rejectedAsWrongCompany: 0`
      // unconditionally while no filtering ran at all, which told the agent
      // filtering had happened and found nothing wrong.
      verifiedCount: result.verifiedCount,
      uncertainCount: result.uncertainCount,
      rejectedAsWrongCompany: result.rejectedAsWrongCompany,
      departedCount: result.departedCount,
      // People this search did not change. They are in `contacts` marked
      // "unchanged", and describing them as verified or departed would be
      // describing a write that was refused.
      affiliationUnchanged: result.affiliationUnchanged,
      // The same prose searchPeople returns. Without it this path handed the
      // agent bare numbers and left it to guess what "affiliationUnchanged: 2"
      // meant, which it got wrong in exactly the direction that flatters the
      // result.
      note: affiliationNotes({
        uncertainCount: result.uncertainCount,
        departedCount: result.departedCount,
        affiliationUnchanged: result.affiliationUnchanged,
      }),
      error: result.error,
    };
  },
});

export const getContacts = tool({
  description:
    "Fetch stored contacts for a campaign with optional filtering. Returns a THIN list (no enrichment_data) so context stays small. For deep detail on one contact (bio, Twitter, etc.), call getContactDetail(personId).",
  inputSchema: z.object({
    campaignId: z.string().uuid().describe("Campaign ID"),
    enrichmentStatus: z
      .enum(["pending", "in_progress", "enriched", "failed"])
      .optional()
      .describe("Filter by enrichment status"),
    companyId: z
      .string()
      .uuid()
      .optional()
      .describe("Filter by campaign-organization link ID"),
  }),
  execute: async (input) => {
    const supabase = await createClient();

    const query = supabase
      .from("campaign_people")
      .select(
        "id, person_id, campaign_id, outreach_status, priority_score, score_reason, created_at, updated_at, person:people(name, title, work_email, personal_email, linkedin_url, twitter_url, enrichment_status, source, organization_id, organization:organizations(name, domain, industry))",
      )
      .eq("campaign_id", input.campaignId)
      .order("priority_score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    const { data, error } = await query;

    if (error) throw new Error(`Failed to get contacts: ${error.message}`);

    let results = data || [];

    // Filter by enrichment status (lives on the person record)
    if (input.enrichmentStatus) {
      results = results.filter(
        (r) =>
          (r.person as unknown as { enrichment_status: string } | null)
            ?.enrichment_status === input.enrichmentStatus,
      );
    }

    // Filter by company (campaign_organizations link)
    if (input.companyId) {
      // Get the organization_id for this campaign_organizations link
      const { data: link } = await supabase
        .from("campaign_organizations")
        .select("organization_id")
        .eq("id", input.companyId)
        .single();

      if (link) {
        results = results.filter(
          (r) =>
            (r.person as unknown as { organization_id: string | null } | null)
              ?.organization_id === link.organization_id,
        );
      }
    }

    // Flatten for backwards compat
    const contacts = results.map((row) => {
      const person = row.person as unknown as Record<string, unknown>;
      return {
        id: row.id,
        person_id: row.person_id,
        campaign_id: row.campaign_id,
        name: person.name,
        title: person.title,
        work_email: person.work_email,
        personal_email: person.personal_email,
        linkedin_url: person.linkedin_url,
        twitter_url: person.twitter_url,
        enrichment_status: person.enrichment_status,
        outreach_status: row.outreach_status,
        priority_score: row.priority_score,
        score_reason: row.score_reason,
        source: person.source,
        company: person.organization || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    return { contacts };
  },
});

export const getContactDetail = tool({
  description:
    "Fetch full enrichment detail for ONE contact (LinkedIn, Twitter, email discovery, plus their company's enrichment). Use this per-draft when composing a personalized email. Do NOT call in a loop to 'preload' multiple contacts; call once per email you are writing, then discard. Keeps context small and prevents mixing details across contacts.",
  inputSchema: z.object({
    personId: z
      .string()
      .uuid()
      .describe("People table ID (person_id, not campaign_people.id)."),
  }),
  execute: async ({ personId }) => {
    // Returns both addresses, the socials, the whole enrichment payload and
    // the joined company, for whatever uuid it is handed. `people` is a shared
    // pool with no owner column, so the read itself can never establish that
    // the caller is entitled to any of it.
    const session = await toolSession();
    if (!session) {
      return {
        error:
          "No authenticated session available in tool context. Ask the user to sign in.",
      };
    }
    const { supabase, userId } = session;

    if (!(await callerHoldsPerson(supabase, userId, personId))) {
      return notFound("Contact");
    }

    const { data, error } = await supabase
      .from("people")
      .select(
        "id, name, title, work_email, personal_email, linkedin_url, twitter_url, enrichment_status, enrichment_data, organization:organizations(id, name, domain, industry, location, description, enrichment_data, enrichment_status)",
      )
      .eq("id", personId)
      .single();

    if (error || !data) {
      return { error: `Contact not found: ${error?.message ?? "no rows"}` };
    }

    return {
      id: data.id,
      name: data.name,
      title: data.title,
      work_email: data.work_email,
      personal_email: data.personal_email,
      linkedin_url: data.linkedin_url,
      twitter_url: data.twitter_url,
      enrichment_status: data.enrichment_status,
      enrichment_data: data.enrichment_data,
      company: data.organization ?? null,
    };
  },
});

export const deleteCompanies = tool({
  description:
    "Unlink one or more companies from a campaign. The shared organization data is preserved for other campaigns. Also unlinks contacts at those companies from this campaign.",
  inputSchema: z.object({
    companyIds: z
      .array(z.string().uuid())
      .min(1)
      .describe("Array of campaign-organization link IDs to remove"),
  }),
  execute: async (input) => {
    const supabase = await createClient();

    // Get organization_ids to unlink their people too
    const { data: links } = await supabase
      .from("campaign_organizations")
      .select("organization_id, campaign_id")
      .in("id", input.companyIds);

    if (links && links.length > 0) {
      const campaignId = links[0].campaign_id;
      const orgIds = links.map((l) => l.organization_id);

      // Get person_ids at these orgs
      const { data: people } = await supabase
        .from("people")
        .select("id")
        .in("organization_id", orgIds);

      if (people && people.length > 0) {
        const personIds = people.map((p) => p.id);
        await supabase
          .from("campaign_people")
          .delete()
          .eq("campaign_id", campaignId)
          .in("person_id", personIds);
      }
    }

    const { error } = await supabase
      .from("campaign_organizations")
      .delete()
      .in("id", input.companyIds);

    if (error) throw new Error(`Failed to unlink companies: ${error.message}`);

    return {
      deleted: input.companyIds.length,
      companyIds: input.companyIds,
    };
  },
});

export const deleteContacts = tool({
  description:
    "Unlink one or more contacts from a campaign. The shared person data is preserved for other campaigns.",
  inputSchema: z.object({
    contactIds: z
      .array(z.string().uuid())
      .min(1)
      .describe("Array of campaign-people link IDs to remove"),
  }),
  execute: async (input) => {
    const supabase = await createClient();

    const { error } = await supabase
      .from("campaign_people")
      .delete()
      .in("id", input.contactIds);

    if (error) throw new Error(`Failed to unlink contacts: ${error.message}`);

    return {
      deleted: input.contactIds.length,
      contactIds: input.contactIds,
    };
  },
});

export const scoreCompany = tool({
  description:
    "Store a priority score (1-10) and reasoning for a company in this campaign. Call this after enriching a company, after analyzing enrichment data against the ICP and user profile.",
  inputSchema: z.object({
    companyId: z
      .string()
      .uuid()
      .describe("Campaign-organization link ID to score"),
    score: z
      .number()
      .min(1)
      .max(10)
      .describe(
        "Priority score 1-10. 8-10: strong fit with active signals. 5-7: moderate fit. 1-4: weak fit.",
      ),
    reason: z
      .string()
      .min(10)
      .describe(
        "2-3 sentence explanation of WHY this score. Reference specific data points: ICP fit, timing signals, offering alignment, company stage.",
      ),
  }),
  execute: async (input) => {
    const supabase = await createClient();
    const { error } = await supabase
      .from("campaign_organizations")
      .update({
        relevance_score: input.score,
        score_reason: input.reason,
      })
      .eq("id", input.companyId);

    if (error) throw new Error(`Failed to score company: ${error.message}`);
    return {
      companyId: input.companyId,
      score: input.score,
      reason: input.reason,
    };
  },
});

export const scoreContact = tool({
  description:
    "Store a priority score (1-10) and reasoning for a contact in this campaign. Call this after enriching a contact, after analyzing their profile, activity, and connection to the user.",
  inputSchema: z.object({
    contactId: z.string().uuid().describe("Campaign-people link ID to score"),
    score: z
      .number()
      .min(1)
      .max(10)
      .describe(
        "Priority score 1-10. 8-10: strong personal connection + active timing signals. 5-7: good fit, some signals. 1-4: low priority.",
      ),
    reason: z
      .string()
      .min(10)
      .describe(
        "2-3 sentence explanation of WHY to reach out to this person first. Reference specific signals: recent posts, job changes, shared connections, topic alignment with user's offering.",
      ),
  }),
  execute: async (input) => {
    const supabase = await createClient();
    const { error } = await supabase
      .from("campaign_people")
      .update({
        priority_score: input.score,
        score_reason: input.reason,
      })
      .eq("id", input.contactId);

    if (error) throw new Error(`Failed to score contact: ${error.message}`);
    return {
      contactId: input.contactId,
      score: input.score,
      reason: input.reason,
    };
  },
});

export const updateCompanyStatus = tool({
  description:
    "Update the qualification status of one or more companies in this campaign. Use 'qualified' for good ICP fits, 'disqualified' for poor fits.",
  inputSchema: z.object({
    companyIds: z
      .array(z.string().uuid())
      .min(1)
      .describe("Array of campaign-organization link IDs to update"),
    status: z
      .enum(["discovered", "qualified", "disqualified"])
      .describe("New status to set"),
  }),
  execute: async (input) => {
    const supabase = await createClient();

    const { error } = await supabase
      .from("campaign_organizations")
      .update({ status: input.status })
      .in("id", input.companyIds);

    if (error) throw new Error(`Failed to update companies: ${error.message}`);

    return {
      updated: input.companyIds.length,
      status: input.status,
    };
  },
});

export const getGoogleReviews = tool({
  description:
    "Fetch Google Reviews for a company using the Google Places API. Returns rating, review count, and recent review text. Use this to gauge customer sentiment and find outreach hooks.",
  inputSchema: z.object({
    organizationId: z
      .string()
      .uuid()
      .describe("Organization ID to attach review data to"),
    companyName: z
      .string()
      .describe("Company name to search for on Google Places"),
    location: z
      .string()
      .optional()
      .describe("Optional location hint (city, state) to disambiguate"),
    domain: z
      .string()
      .optional()
      .describe("Company domain for cross-verification"),
    campaignId: z
      .string()
      .uuid()
      .optional()
      .describe("Campaign ID for signal result tracking"),
  }),
  execute: async (input) => {
    const service = new GooglePlacesService();
    const result = await service.getPlaceReviews(
      input.companyName,
      input.location,
      input.domain,
    );

    if (result.found) {
      await mergeEnrichmentData("organizations", input.organizationId, {
        googleReviews: {
          rating: result.rating,
          reviewCount: result.userRatingCount,
          googleMapsUrl: result.googleMapsUri,
          topReviews: result.reviews.slice(0, 5),
          fetchedAt: new Date().toISOString(),
        },
      });
    }

    if (input.campaignId) {
      const supabase = await createClient();
      const { data: signal } = await supabase
        .from("signals")
        .select("id")
        .eq("slug", "google-reviews")
        .maybeSingle();

      if (signal) {
        await supabase.from("signal_results").insert({
          signal_id: signal.id,
          campaign_id: input.campaignId,
          organization_id: input.organizationId,
          output: result,
          status: result.found ? "success" : "failed",
        });
      }
    }

    return result;
  },
});

export const getDataQualityReport = tool({
  description:
    "Audit the contact and company data for quality problems: duplicate companies, companies with no domain holding contacts, people whose email domain or job title contradicts the company they are filed under, duplicate people, and unverified pattern-guessed emails. READ-ONLY: it proposes fixes and applies none. Use it when the user asks about data quality, suspects contacts are attached to the wrong company, or before a large outreach push.",
  inputSchema: z.object({}),
  execute: async () => {
    const supabase = await createClient();
    const report = await runDataQualityAudit(supabase);
    return {
      ...report,
      note: "Read-only audit. Nothing has been changed. To act on a finding, confirm with the user first, then use the person/company reassignment endpoints.",
    };
  },
});
