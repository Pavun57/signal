import type { SupabaseClient } from "@supabase/supabase-js";

import { parseLinkedInTitle } from "@/lib/utils";
import { ExaService } from "@/lib/services/exa-service";
import {
  findPeopleOnDomain,
  filterContactsByCompany,
  type CandidateContact,
  type CompanyContext,
} from "@/lib/services/contact-filter";
import {
  canHoldPeople,
  findOrCreatePerson,
  linkPersonToCampaign,
  normalizeLinkedInUrl,
} from "@/lib/services/knowledge-base";
import { recordVerifiedEmail } from "@/lib/services/email-pattern";
import {
  recordAffiliation,
  type AffiliationSource,
} from "@/lib/services/affiliation";

/**
 * The one path contacts are discovered through.
 *
 * This logic previously existed as three near-identical copies — the
 * findContacts tool, /api/find-contacts, and /api/enrich-company — which meant
 * a fix to any of them left the same bug live in the other two. Consolidated
 * here so affiliation is recorded identically wherever contacts come from.
 */

export interface DiscoveredContact {
  id: string;
  name: string;
  title: string | null;
  work_email: string | null;
  personal_email: string | null;
  linkedinUrl: string | null;
  source: string;
  /** Why we believe they work here, and how strongly. */
  affiliation: AffiliationSource;
  affiliationEvidence: string;
}

export interface ContactDiscoveryResult {
  organizationId: string;
  companyName: string;
  contacts: DiscoveredContact[];
  searchesRun: Array<{
    title: string;
    query: string;
    resultsFound: number;
    error?: string;
  }>;
  totalFound: number;
  duplicatesSkipped: number;
  /** Judged as genuine employees. */
  verifiedCount: number;
  /** Kept but unproven — surfaced to the user, blocked from outreach. */
  uncertainCount: number;
  /** Positively placed at a different company; stored unattached. */
  rejectedAsWrongCompany: number;
  error?: string;
}

export async function findContactsForOrganization(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    campaignId?: string | null;
    titles: string[];
    numResults?: number;
  },
): Promise<ContactDiscoveryResult> {
  const { organizationId, campaignId, titles, numResults = 5 } = args;

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, name, domain, industry, location, description")
    .eq("id", organizationId)
    .single();

  if (orgError || !org) {
    throw new Error(
      `Organization not found: ${orgError?.message ?? "unknown"}`,
    );
  }

  const empty = (error: string): ContactDiscoveryResult => ({
    organizationId,
    companyName: org.name,
    contacts: [],
    searchesRun: [],
    totalFound: 0,
    duplicatesSkipped: 0,
    verifiedCount: 0,
    uncertainCount: 0,
    rejectedAsWrongCompany: 0,
    error,
  });

  // Without a domain we cannot tell this company apart from any other with the
  // same name, so attaching people to it is how contact lists get pooled across
  // unrelated businesses. Refuse, and say what would fix it.
  if (!canHoldPeople(org)) {
    return empty(
      `"${org.name}" has no domain on record, so contacts cannot be attached to it — two different companies with this name would be indistinguishable. Resolve the company's website first, then retry.`,
    );
  }

  const company: CompanyContext = {
    name: org.name,
    domain: org.domain,
    industry: org.industry,
    location: org.location,
    description: org.description,
  };

  // Dedup against contacts already on the campaign, by LinkedIn URL.
  const existingUrls = new Set<string>();
  if (campaignId) {
    const { data: links } = await supabase
      .from("campaign_people")
      .select("person:people(linkedin_url)")
      .eq("campaign_id", campaignId);
    for (const l of links ?? []) {
      const url = (
        l.person as unknown as { linkedin_url: string | null } | null
      )?.linkedin_url;
      if (url) existingUrls.add(url);
    }
  }

  const contacts: DiscoveredContact[] = [];
  let duplicatesSkipped = 0;
  let verifiedCount = 0;
  let uncertainCount = 0;
  let rejectedAsWrongCompany = 0;

  // ── Phase 1: the company's own website ──────────────────────────────────
  // Strongest routine evidence there is: the company published these people as
  // its own staff.
  if (org.domain) {
    try {
      const domainPeople = await findPeopleOnDomain(org.domain, org.name);
      for (const dp of domainPeople) {
        const linkedinUrl = dp.linkedinUrl
          ? normalizeLinkedInUrl(dp.linkedinUrl)
          : null;
        if (linkedinUrl && existingUrls.has(linkedinUrl)) {
          duplicatesSkipped++;
          continue;
        }

        const person = await findOrCreatePerson({
          name: dp.name,
          title: dp.title,
          linkedin_url: linkedinUrl,
          work_email: dp.email,
          organization_id: organizationId,
          source: "website",
        });

        const evidence = `listed on ${org.domain}`;
        await recordAffiliation(supabase, {
          personId: person.id,
          organizationId,
          source: "team_page",
          evidence,
        });

        if (dp.email) {
          await recordVerifiedEmail(supabase, {
            personId: person.id,
            email: dp.email,
            source: "team_page",
          });
        }

        if (campaignId) await linkPersonToCampaign(person.id, campaignId);
        if (linkedinUrl) existingUrls.add(linkedinUrl);

        verifiedCount++;
        contacts.push({
          id: person.id,
          name: person.name,
          title: person.title,
          work_email: person.work_email,
          personal_email: person.personal_email,
          linkedinUrl: person.linkedin_url,
          source: "website",
          affiliation: "team_page",
          affiliationEvidence: evidence,
        });
      }
    } catch (err) {
      console.error("[contact-discovery] Domain scrape failed:", err);
    }
  }

  // ── Phase 2: LinkedIn search, judged ────────────────────────────────────
  const exa = new ExaService();
  const searchResults = await Promise.all(
    titles.map(async (title) => {
      const query = `"${org.name}" ${title} site:linkedin.com`;
      try {
        const result = await exa.search(query, {
          numResults,
          category: "people" as const,
          includeText: true,
        });
        return { title, query, results: result.results };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(
          `[contact-discovery] Search failed for "${query}": ${msg}`,
        );
        return { title, query, results: [], error: msg };
      }
    }),
  );

  const seenUrls = new Set<string>();
  const candidates: Array<
    CandidateContact & { searchTitle: string; linkedinUrl: string | null }
  > = [];

  for (const search of searchResults) {
    for (const result of search.results) {
      if (seenUrls.has(result.url)) {
        duplicatesSkipped++;
        continue;
      }
      seenUrls.add(result.url);

      const linkedinUrl = result.url.includes("linkedin.com")
        ? normalizeLinkedInUrl(result.url)
        : null;
      if (linkedinUrl && existingUrls.has(linkedinUrl)) {
        duplicatesSkipped++;
        continue;
      }

      const parsed = parseLinkedInTitle(result.title);
      candidates.push({
        name: parsed.name,
        title: parsed.title || search.title,
        linkedinUrl,
        rawHeadline: result.title,
        searchTitle: search.title,
      });
    }
  }

  if (candidates.length > 0) {
    for (const judged of await filterContactsByCompany(company, candidates)) {
      const candidate = candidates[judged.index];
      if (!candidate) continue;

      // Rejected means the evidence positively placed them somewhere else.
      // Still a real person worth keeping — just not this company's — so store
      // them unattached rather than pretending they are an employee.
      const attachTo = judged.verdict === "rejected" ? null : organizationId;
      const source: AffiliationSource =
        judged.verdict === "verified" ? "llm_verified" : "search_stamp";

      const person = await findOrCreatePerson({
        name: judged.name,
        title: judged.title,
        linkedin_url: candidate.linkedinUrl,
        organization_id: attachTo,
        source: "exa",
      });

      await recordAffiliation(supabase, {
        personId: person.id,
        organizationId: attachTo,
        source,
        evidence: judged.evidence,
      });

      if (judged.verdict === "rejected") {
        rejectedAsWrongCompany++;
        continue;
      }
      if (judged.verdict === "verified") verifiedCount++;
      else uncertainCount++;

      if (campaignId) await linkPersonToCampaign(person.id, campaignId);

      contacts.push({
        id: person.id,
        name: person.name,
        title: person.title,
        work_email: person.work_email,
        personal_email: person.personal_email,
        linkedinUrl: person.linkedin_url,
        source: "exa",
        affiliation: source,
        affiliationEvidence: judged.evidence,
      });
    }
  }

  return {
    organizationId,
    companyName: org.name,
    contacts,
    searchesRun: searchResults.map((s) => ({
      title: s.title,
      query: s.query,
      resultsFound: s.results.length,
      error: "error" in s ? (s as { error?: string }).error : undefined,
    })),
    totalFound: contacts.length,
    duplicatesSkipped,
    verifiedCount,
    uncertainCount,
    rejectedAsWrongCompany,
  };
}
