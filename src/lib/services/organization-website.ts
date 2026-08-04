import type { SupabaseClient } from "@supabase/supabase-js";

import { isDirectoryDomain } from "@/lib/services/directory-domains";
import { resolveOrganizationDomain } from "@/lib/services/domain-resolver";
import { normalizeDomain } from "@/lib/services/knowledge-base";

/**
 * Give a company the website it never had.
 *
 * A company with no domain cannot hold contacts at all (`canHoldPeople`), and
 * nothing could fill one in: `findOrCreateOrganization` writes `domain` on
 * INSERT only, no route updated `organizations`, and the agent's documented
 * workaround INSERTed a second company instead. A campaign of directory-sourced
 * companies was permanently unable to hold a lead.
 *
 * Shared by the route and the agent tool on purpose. The merge below is the
 * dangerous part of this feature, and two copies of it is how one gets fixed
 * and the other does not.
 */

/** Tables that point at an organization, and so have to move before a delete. */
const REFERRING_TABLES = [
  "campaign_organizations",
  "people",
  "signal_results",
  "tracking_configs",
] as const;

export interface WebsiteRefused {
  ok: false;
  /** What an HTTP caller should return. 200 means "no answer", not "failure". */
  status: 200 | 400 | 404 | 500;
  error: string;
}

export interface WebsiteSaved {
  ok: true;
  domain: string;
  url: string;
  source: string;
  evidence: string;
  merged: boolean;
  /** The organization that now holds this company, when a merge happened. */
  into?: string;
  deletedOld?: boolean;
  remaining?: number;
  message?: string;
}

export type WebsiteResult = WebsiteRefused | WebsiteSaved;

/**
 * Fold `fromId` into `toId`, then delete it only if nothing points at it.
 *
 * Order matters. Deleting first would cascade: campaign_organizations,
 * signal_results and tracking_configs are `on delete cascade` and
 * people.organization_id is `on delete set null`, so delete-then-move silently
 * detaches a contact list instead of moving it.
 */
async function mergeOrganizations(
  supabase: SupabaseClient,
  fromId: string,
  toId: string,
): Promise<{ into: string; deletedOld: boolean; remaining: number }> {
  // campaign_organizations carries unique(campaign_id, organization_id), so a
  // link cannot move into a campaign the target is already in. Dropping the
  // duplicate is the only move available, and failing the whole merge over it
  // would strand the company with no website for good.
  const { data: theirs } = await supabase
    .from("campaign_organizations")
    .select("campaign_id")
    .eq("organization_id", toId);
  const taken = new Set(
    (theirs ?? []).map((row) => (row as { campaign_id: string }).campaign_id),
  );

  const { data: ours } = await supabase
    .from("campaign_organizations")
    .select("id, campaign_id")
    .eq("organization_id", fromId);

  for (const row of ours ?? []) {
    const link = row as { id: string; campaign_id: string };
    if (taken.has(link.campaign_id)) {
      await supabase.from("campaign_organizations").delete().eq("id", link.id);
      continue;
    }
    await supabase
      .from("campaign_organizations")
      .update({ organization_id: toId })
      .eq("id", link.id);
    taken.add(link.campaign_id);
  }

  for (const table of ["people", "signal_results", "tracking_configs"]) {
    await supabase
      .from(table)
      .update({ organization_id: toId })
      .eq("organization_id", fromId);
  }

  // Count what is left rather than assume the writes landed. Every one of these
  // tables loses rows, or a contact loses their employer, if the delete runs
  // while something still points here.
  let remaining = 0;
  for (const table of REFERRING_TABLES) {
    const { data } = await supabase
      .from(table)
      .select("id")
      .eq("organization_id", fromId);
    remaining += data?.length ?? 0;
  }

  if (remaining === 0) {
    await supabase.from("organizations").delete().eq("id", fromId);
  }

  return { into: toId, deletedOld: remaining === 0, remaining };
}

export async function saveOrganizationWebsite(
  supabase: SupabaseClient,
  args: { organizationId: string; url?: string | null; resolve?: boolean },
): Promise<WebsiteResult> {
  const { organizationId } = args;

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, domain, url, location, industry")
    .eq("id", organizationId)
    .maybeSingle();

  if (!org) {
    return { ok: false, status: 404, error: "Company not found" };
  }

  // Contacts are already filed under an existing domain, and email patterns and
  // affiliation evidence are built on it. Replacing it is a heavier operation
  // than filling in a blank, and this only fills in blanks.
  if (org.domain) {
    return {
      ok: false,
      status: 400,
      error: `"${org.name}" already has ${org.domain} on record. This only fills in a missing website.`,
    };
  }

  let domain: string;
  let source = "user_entered";
  let evidence = "entered by the user";

  const typed = typeof args.url === "string" ? args.url.trim() : "";
  if (typed) {
    const withScheme = /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
    let host: string;
    try {
      host = new URL(withScheme).hostname;
    } catch {
      return {
        ok: false,
        status: 400,
        error: `"${typed}" is not a valid web address.`,
      };
    }
    const normalized = normalizeDomain(host);
    if (!normalized) {
      return {
        ok: false,
        status: 400,
        error: `"${typed}" is not a valid web address.`,
      };
    }
    // A directory lists other businesses. Filed as this company's website,
    // every contact search would run against the directory and every person
    // found would be stored as its employee.
    if (isDirectoryDomain(normalized)) {
      return {
        ok: false,
        status: 400,
        error: `${normalized} is a directory, not a company website. Use the company's own address.`,
      };
    }
    domain = normalized;
  } else if (args.resolve) {
    const found = await resolveOrganizationDomain({
      name: org.name as string,
      location: org.location as string | null,
      industry: org.industry as string | null,
    });
    if (!found) {
      // Not a failure: having no website is a normal fact about a small
      // business, and a wrong one is worse than none.
      return {
        ok: false,
        status: 200,
        error: `Could not find a website for "${org.name}". Add the address manually if you know it.`,
      };
    }
    domain = found.domain;
    source = found.source;
    evidence = found.evidence;
  } else {
    return {
      ok: false,
      status: 400,
      error: "Provide a url, or set resolve to true.",
    };
  }

  const url = `https://${domain}`;

  // organizations.domain is unique, and another row holding it is not an edge
  // case here: the workaround this replaces (search for the site, then save it)
  // INSERTed a second company for exactly these companies, so the duplicate is
  // likely to be sitting there already.
  const { data: twin } = await supabase
    .from("organizations")
    .select("id")
    .eq("domain", domain)
    .maybeSingle();

  if (twin && (twin as { id: string }).id !== organizationId) {
    const merge = await mergeOrganizations(
      supabase,
      organizationId,
      (twin as { id: string }).id,
    );
    return {
      ok: true,
      merged: true,
      domain,
      url,
      source,
      evidence,
      ...merge,
      message: merge.deletedOld
        ? `Merged into the existing record for ${domain}.`
        : `Merged into the existing record for ${domain}. The old entry was kept: ${merge.remaining} row(s) still point at it.`,
    };
  }

  const { error } = await supabase
    .from("organizations")
    .update({ domain, url })
    .eq("id", organizationId);

  if (error) {
    return { ok: false, status: 500, error: error.message };
  }

  return { ok: true, merged: false, domain, url, source, evidence };
}
