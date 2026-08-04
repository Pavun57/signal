import type { SupabaseClient } from "@supabase/supabase-js";

import { isIP } from "node:net";
import { addressIsPublic } from "@/lib/safe-fetch";
import {
  isDirectoryDomain,
  isPlatformDomain,
  looksLikeDomain,
} from "@/lib/services/directory-domains";
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

/** Longest URL worth entertaining; the field had no bound at all. */
const MAX_URL_LENGTH = 2048;

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

  // Only the caller's own contacts move.
  //
  // `people` is a shared pool with USING (true) on UPDATE, so
  // `.update().eq("organization_id", fromId)` rewrote *every* tenant's rows at
  // that company. Reproduced with two users: one tenant setting a website
  // silently re-filed another tenant's contact under a different employer and
  // left their campaign showing a company with no contacts. The database
  // cannot scope this until people carries an owner, so the scoping is here.
  //
  // campaign_people is RLS-scoped through campaigns, so it names exactly the
  // people this caller holds. Anyone else's stay put -- which also means
  // `remaining` below stays non-zero and the old row is correctly kept.
  const { data: atOrg } = await supabase
    .from("people")
    .select("id")
    .eq("organization_id", fromId);
  const orgPersonIds = (atOrg ?? []).map((r) => (r as { id: string }).id);

  if (orgPersonIds.length > 0) {
    const { data: heldLinks } = await supabase
      .from("campaign_people")
      .select("person_id")
      .in("person_id", orgPersonIds);
    const held = [
      ...new Set(
        (heldLinks ?? []).map((r) => (r as { person_id: string }).person_id),
      ),
    ];
    if (held.length > 0) {
      await supabase
        .from("people")
        .update({ organization_id: toId })
        .in("id", held);
    }
  }

  for (const table of ["signal_results", "tracking_configs"]) {
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

  // Verify the delete rather than infer it. organizations had no DELETE policy
  // until 20260804000000, so this matched zero rows and returned no error
  // while the caller reported `deletedOld: true` and a completed merge -- the
  // old row was still there, still holding the name, on every install.
  let deletedOld = false;
  if (remaining === 0) {
    const { data: deleted } = await supabase
      .from("organizations")
      .delete()
      .eq("id", fromId)
      .select("id");
    deletedOld = (deleted?.length ?? 0) > 0;
  }

  return { into: toId, deletedOld, remaining };
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
    if (typed.length > MAX_URL_LENGTH) {
      return {
        ok: false,
        status: 400,
        error: "That web address is too long to be real.",
      };
    }

    // Only a bare host or an http(s) URL. Prepending https:// to *anything*
    // produced a parseable-but-wrong URL: "file:///etc/passwd" became the host
    // "file" and was stored as this company's domain.
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed);
    if (hasScheme && !/^https?:\/\//i.test(typed)) {
      return {
        ok: false,
        status: 400,
        error: `"${typed}" is not an http or https address.`,
      };
    }
    const withScheme = hasScheme ? typed : `https://${typed}`;
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

    // A company website is on the public internet. Without this an operator
    // could store 169.254.169.254 or 127.0.0.1 as a company's domain, and
    // every later enrichment run fetches whatever is on record.
    if (isIP(host) && !addressIsPublic(host)) {
      return {
        ok: false,
        status: 400,
        error: `${host} is not a public web address.`,
      };
    }

    const normalized = normalizeDomain(host);
    // normalizeDomain hands back its input when the public-suffix lookup
    // fails, so a falsy check never fires: "localhost" and a 5,000-character
    // string both arrived here as "domains".
    if (!looksLikeDomain(normalized)) {
      return {
        ok: false,
        status: 400,
        error: `"${typed}" is not a valid web address.`,
      };
    }
    // The sub-label that identified this business is gone by now -- two
    // companies on the same site builder both reduce to the platform apex and
    // would collide on organizations.domain, which this function treats as a
    // duplicate and merges.
    if (isPlatformDomain(normalized)) {
      return {
        ok: false,
        status: 400,
        error: `${normalized} is a website builder's own domain, not this company's. Use the full address, including the part that identifies the business.`,
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
