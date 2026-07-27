import { getPostHogClient } from "@/lib/posthog-server";
import { getSupabaseAndUser } from "@/lib/supabase/server";
import { MAX_ROWS_PER_REQUEST } from "@/lib/import-limits";
import {
  findOrCreateOrganization,
  linkOrganizationToCampaign,
  normalizeDomain,
} from "@/lib/services/knowledge-base";

export const maxDuration = 60;

const CHUNK_SIZE = 10;

export async function POST(request: Request) {
  const ctx = await getSupabaseAndUser();
  if (!ctx) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { supabase, user } = ctx;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { campaignId, companies } = body as {
    campaignId: string;
    companies: Array<{
      name: string;
      domain?: string | null;
      url?: string | null;
      industry?: string | null;
      location?: string | null;
      description?: string | null;
    }>;
  };

  if (!campaignId) {
    return Response.json({ error: "campaignId is required" }, { status: 400 });
  }
  if (!companies || !Array.isArray(companies) || companies.length === 0) {
    return Response.json(
      { error: "companies array is required and must not be empty" },
      { status: 400 },
    );
  }
  if (companies.length > MAX_ROWS_PER_REQUEST) {
    return Response.json(
      {
        error: `Too many rows (${companies.length}). Send at most ${MAX_ROWS_PER_REQUEST} per request and batch the rest.`,
      },
      { status: 413 },
    );
  }

  // Verify campaign exists and belongs to the signed-in user (defense in
  // depth on top of RLS).
  const { data: campaignRow, error: campaignError } = await supabase
    .from("campaigns")
    .select("id, user_id")
    .eq("id", campaignId)
    .single();

  if (campaignError || !campaignRow) {
    return Response.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (campaignRow.user_id !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch existing domains already linked to this campaign
  const { data: existingLinks } = await supabase
    .from("campaign_organizations")
    .select("organization:organizations(domain)")
    .eq("campaign_id", campaignId);

  const existingDomains = new Set(
    (existingLinks || [])
      .map(
        (l) =>
          (l.organization as unknown as { domain: string | null } | null)
            ?.domain,
      )
      .filter(Boolean) as string[],
  );

  // Pass 1 (sequential, cheap): normalize + dedup into a candidate list.
  const seenDomains = new Set<string>();
  const seenNames = new Set<string>();
  let skipped = 0;
  const candidates: Array<{
    name: string;
    domain: string | null;
    url: string | null;
    industry: string | null;
    location: string | null;
    description: string | null;
  }> = [];

  for (const company of companies) {
    if (!company.name?.trim()) {
      skipped++;
      continue;
    }

    let domain: string | null = company.domain?.trim() || null;

    // Extract domain from URL if no domain provided
    if (!domain && company.url) {
      try {
        domain = new URL(
          company.url.startsWith("http")
            ? company.url
            : `https://${company.url}`,
        ).hostname;
      } catch {
        // skip
      }
    }

    // Normalize domain
    if (domain) {
      domain = normalizeDomain(domain);
    }

    // Dedup by domain within campaign
    if (domain && (existingDomains.has(domain) || seenDomains.has(domain))) {
      skipped++;
      continue;
    }
    if (domain) seenDomains.add(domain);

    // Domain-less rows dedup by normalized name — findOrCreateOrganization's
    // name matching can't be trusted to serialize two identical rows racing
    // in the same parallel chunk.
    if (!domain) {
      const nameKey = company.name.trim().toLowerCase();
      if (seenNames.has(nameKey)) {
        skipped++;
        continue;
      }
      seenNames.add(nameKey);
    }

    candidates.push({
      name: company.name.trim(),
      domain,
      url: company.url?.trim() || (domain ? `https://${domain}` : null),
      industry: company.industry?.trim() || null,
      location: company.location?.trim() || null,
      description: company.description?.trim() || null,
    });
  }

  // Pass 2 (parallel chunks): create/link. Org creation recovers from 23505
  // races and the campaign link is an upsert, so chunk-internal parallelism
  // is safe. Sequential rows previously blew past the route duration on
  // large files.
  let imported = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    const results = await Promise.allSettled(
      chunk.map(async (c) => {
        const org = await findOrCreateOrganization({ ...c, source: "csv" });
        await linkOrganizationToCampaign(org.id, campaignId);
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") imported++;
      else {
        failed++;
        console.error("[import-csv] row failed:", r.reason);
      }
    }
  }

  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: user.id,
    event: "csv_import_completed",
    properties: {
      campaign_id: campaignId,
      imported,
      skipped,
      failed,
      total: companies.length,
    },
  });

  return Response.json({ imported, skipped, failed });
}
